import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const ISSUER = "https://auth.openai.com";
const REDIRECT_URI = "http://127.0.0.1:1455/auth/callback";
const RESOURCE = "https://api.openai.com/v1";
const SCOPES = ["openid", "profile", "email", "offline_access", "resource.invoke", "chatgpt.tokens.use.direct"];

function credentialPath() {
  const home = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  const file = process.env.CODEX_AUTH_FILE
    ? path.resolve(process.env.CODEX_AUTH_FILE)
    : path.join(path.resolve(home), "grokbot-shim", "auth.json");
  const cliAuth = path.join(path.resolve(home), "auth.json");
  const canonical = (candidate) => {
    try { candidate = fs.realpathSync(candidate); } catch { /* file may not exist yet */ }
    return process.platform === "win32" ? path.resolve(candidate).toLowerCase() : path.resolve(candidate);
  };
  if (canonical(file) === canonical(cliAuth)) throw new Error("CODEX_AUTH_FILE must not point to the Codex CLI auth.json; use the separate grokbot-shim credential file");
  return file;
}

function stableHostId(file) {
  const hostIdFile = path.join(path.dirname(file), "host-id");
  if (fs.existsSync(hostIdFile)) return fs.readFileSync(hostIdFile, "utf8").trim();
  const hostId = `urn:uuid:${crypto.randomUUID()}`;
  fs.mkdirSync(path.dirname(hostIdFile), { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(path.dirname(hostIdFile), 0o700);
  fs.writeFileSync(hostIdFile, `${hostId}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  return hostId;
}

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

async function verifyIdToken(token, { clientId, nonce }) {
  const parts = String(token ?? "").split(".");
  if (parts.length !== 3) throw new Error("OpenAI returned a malformed ID token");
  const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
  const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  if (header.alg !== "RS256" || !header.kid) throw new Error("OpenAI returned an unsupported ID token signature");
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== ISSUER || !audience.includes(clientId) || (audience.length > 1 && claims.azp !== clientId)) {
    throw new Error("OpenAI ID token issuer or audience did not match the authorization");
  }
  if (typeof claims.exp !== "number" || claims.exp <= Date.now() / 1000 || (typeof claims.nbf === "number" && claims.nbf > Date.now() / 1000) || !safeEqual(claims.nonce, nonce)) {
    throw new Error("OpenAI ID token expired or did not match the authorization attempt");
  }
  const discovery = await fetch(`${ISSUER}/.well-known/openid-configuration`).then((r) => {
    if (!r.ok) throw new Error(`OpenID discovery failed (${r.status})`);
    return r.json();
  });
  const jwksResponse = await fetch(discovery.jwks_uri);
  if (!jwksResponse.ok) throw new Error(`OpenID key lookup failed (${jwksResponse.status})`);
  const jwks = await jwksResponse.json();
  const jwk = jwks.keys?.find((key) => key.kid === header.kid && key.alg === "RS256");
  if (!jwk) throw new Error("OpenAI ID token signing key was not found");
  const publicKey = crypto.createPublicKey({ key: jwk, format: "jwk" });
  if (!crypto.verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), publicKey, Buffer.from(parts[2], "base64url"))) {
    throw new Error("OpenAI ID token signature was invalid");
  }
  return claims;
}

async function openBrowser(url) {
  const platform = process.platform;
  const [command, args] = platform === "win32"
    ? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]]
    : platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  await execFileAsync(command, args, { windowsHide: true });
}

function writeCredentials(file, payload) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(path.dirname(file), 0o700);
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try {
    fs.renameSync(temp, file);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

export async function authorizeChatGPT({ open = openBrowser, port = 1455 } = {}) {
  if (port !== 1455) throw new Error("The supported ChatGPT callback port is 1455");
  const file = credentialPath();
  const previous = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  const returningClientId = previous.client_id;
  const state = crypto.randomBytes(32).toString("base64url");
  const nonce = crypto.randomBytes(32).toString("base64url");
  const verifier = crypto.randomBytes(32).toString("base64url");
  const hostId = stableHostId(file);
  const challenge = base64url(crypto.createHash("sha256").update(verifier).digest());
  const authUrl = new URL(`${ISSUER}/api/accounts/authorize`);
  const params = {
    client_id: returningClientId || "dynamic_agent_client",
    ...(!returningClientId ? { agent_name_hint: "Grok Bot" } : {}),
    ext_agent_host_id: hostId,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: SCOPES.join(" "),
    resource: RESOURCE,
    state,
    nonce,
    code_challenge_method: "S256",
    code_challenge: challenge,
  };
  for (const [key, value] of Object.entries(params)) authUrl.searchParams.set(key, value);

  const http = await import("node:http");
  const server = http.createServer();
  const callback = new Promise((resolve, reject) => {
    server.on("request", (req, res) => {
      const url = new URL(req.url ?? "/", REDIRECT_URI);
      if (url.pathname !== "/auth/callback") {
        res.writeHead(404).end("Not found");
        return;
      }
      if (!safeEqual(url.searchParams.get("state"), state)) {
        res.writeHead(400).end("Authorization state mismatch. You may close this window.");
        reject(new Error("ChatGPT authorization state mismatch"));
        return;
      }
      res.writeHead(url.searchParams.has("error") ? 400 : 200, { "content-type": "text/html; charset=utf-8", connection: "close" });
      res.end("<!doctype html><title>Grok Bot authorization</title><p>Authorization received. You can close this window and return to Grok Bot.</p>", () => {
        resolve(Object.fromEntries(url.searchParams.entries()));
      });
    });
    server.on("error", reject);
  });

  await new Promise((resolve, reject) => server.listen(port, "127.0.0.1", resolve).once("error", reject));
  try {
    await open(authUrl.toString());
    console.log("Complete the ChatGPT authorization in your browser. Credentials are stored locally by grokbot-shim.");
    const params = await Promise.race([
      callback,
      new Promise((_, reject) => setTimeout(() => reject(new Error("ChatGPT authorization timed out")), 5 * 60_000).unref()),
    ]);
    if (params.error) throw new Error(`ChatGPT authorization was not completed (${String(params.error).slice(0, 100)})`);
    const code = params.code;
    const clientId = params.client_id ?? returningClientId;
    if (!code || !clientId || clientId === "dynamic_agent_client") throw new Error("OpenAI did not return a registered client ID");
    if (returningClientId && clientId !== returningClientId) throw new Error("OpenAI returned a different client ID than the selected ChatGPT registration");

    const response = await fetch(`${ISSUER}/api/accounts/oauth/token`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        code,
        code_verifier: verifier,
        redirect_uri: REDIRECT_URI,
        resource: RESOURCE,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const tokenResponse = await response.json().catch(() => ({}));
    if (!response.ok || typeof tokenResponse.access_token !== "string") {
      throw new Error(`ChatGPT token exchange failed (${String(tokenResponse.error ?? `HTTP ${response.status}`).slice(0, 100)})`);
    }
    const scopes = String(tokenResponse.scope ?? "").split(/\s+/).filter(Boolean);
    if (!scopes.includes("chatgpt.tokens.use.direct")) throw new Error("ChatGPT plan-use permission was not granted; no credentials were saved");
    const idClaims = await verifyIdToken(tokenResponse.id_token, { clientId, nonce });
    if (!idClaims.sub) throw new Error("OpenAI ID token did not contain a subject");
    if (previous.subject && previous.subject !== idClaims.sub) throw new Error("This local grant belongs to another ChatGPT account; its credentials were kept unchanged");
    writeCredentials(file, {
      ...previous,
      client_id: clientId,
      subject: idClaims.sub,
      ...(typeof idClaims.email === "string" ? { email: idClaims.email } : {}),
      ext_agent_host_id: hostId,
      id_token: tokenResponse.id_token,
      access_token: tokenResponse.access_token,
      refresh_token: tokenResponse.refresh_token,
      token_type: tokenResponse.token_type,
      expires_in: tokenResponse.expires_in,
      scopes,
      saved_at: new Date().toISOString(),
    });
    console.log(`ChatGPT plan authorization saved to ${file}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  authorizeChatGPT().catch((error) => {
    console.error(`ChatGPT authorization failed: ${error.message}`);
    process.exitCode = 1;
  });
}
