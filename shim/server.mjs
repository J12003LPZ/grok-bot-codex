import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bearerOf, mintJwt, verifyJwt } from "./jwt.mjs";
import { desktopLoginEmail } from "./secrets.mjs";
import { CONNECT_END_FRAME, envelope, parseConnectFrames } from "./connect.mjs";
import { decodeStreamRequest, runSession, requestSummary } from "./inference.mjs";
import { encodeAvailableModels } from "./models.mjs";
import { boxConfig, encodeEnsureSandBox, encodeRunState } from "./sandbox.mjs";
import { checkLoopbackRequest } from "./guard.mjs";
import { AgentStore } from "./agents.mjs";
import { agentHandlers } from "./handlers.mjs";
import { RpcError, createRpc, loadGenerated } from "./rpc.mjs";
import { clientLogHandlers } from "./client-log.mjs";
import { createBoxController } from "./box.mjs";
import { createCatalog, createCatalogIndex } from "./catalog.mjs";
import { PluginStore, pluginHandlers } from "./plugins.mjs";

// Starts the box container on demand (EnsureSandBox). SHIM_BOX_AUTOSTART=0
// leaves it to computerctl.sh and reports it as always running.
const box =
  process.env.SHIM_BOX_AUTOSTART === "0"
    ? { state: async () => "running", ensure: async () => "running" }
    : createBoxController({ gatewayUrl: process.env.SHIM_BOX_GATEWAY_URL ?? "http://127.0.0.1:8550" });

// Typed RPCs need the schema generated from the installed app. Without it the
// server still runs; those calls fall back to empty replies.
const generated = loadGenerated();
// Public Marketplace catalog reads go upstream anonymously; SHIM_PUBLIC_CATALOG=0 keeps them local (empty).
const catalog = createCatalog({ enabled: process.env.SHIM_PUBLIC_CATALOG !== "0" });
const handlers = {
  ...agentHandlers(new AgentStore()),
  ...clientLogHandlers(process.env.SHIM_CLIENT_LOG),
  ...(generated ? pluginHandlers(new PluginStore(), createCatalogIndex(catalog, generated.root)) : {}),
};
const rpc = generated ? createRpc({ ...generated, handlers }) : null;
if (!generated) console.log("no generated/app.proto: run `npm run gen-proto -- <path to proto.cjs>` for agent RPCs");
import { statsigBootstrap } from "./statsig.mjs";

// Connect streaming requires the trailing frame (flag 0x02) to carry a JSON
// EndStreamResponse. A zero-length payload makes the client throw
// "failed to parse EndStreamResponse: invalid end stream".

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT ?? 8443);
const MODE = process.env.MODE ?? "stub"; // stub | forward
const UPSTREAM = process.env.UPSTREAM ?? "https://api2.cursor.sh";
const STATE_DIR = path.join(ROOT, "state");
fs.mkdirSync(STATE_DIR, { recursive: true });
// state/box/ is the only part of state/ mounted into the box container.
const BOX_STATE_DIR = path.join(STATE_DIR, "box");
fs.mkdirSync(BOX_STATE_DIR, { recursive: true });
const HOST_TOKEN_FILE = path.join(BOX_STATE_DIR, "host-token.json");
const DESKTOP_LOGIN_EMAIL = desktopLoginEmail();

function desktopTokens() {
  return {
    accessToken: mintJwt({ aud: "desktop" }),
    refreshToken: mintJwt({ aud: "desktop-refresh", ttlSec: 86400 * 30 }),
  };
}

// The desktop proves itself with a token the shim signed for it; anything
// else (the box host, or a request without a valid token) is treated as the box.
const callerOf = (req) => (verifyJwt(bearerOf(req), "desktop") ? "desktop" : "box");
const HOST_TOKEN_TTL_SEC = 3600;
const HOST_TOKEN_ROTATE_MS = 30 * 60 * 1000;

function writeHostToken(jwt) {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split(".")[1], "base64").toString("utf8"));
    const nextPath = `${HOST_TOKEN_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(nextPath, JSON.stringify({ accessToken: jwt, expiresAtMs: (payload.exp ?? 0) * 1000 }), {
      mode: 0o600,
    });
    fs.renameSync(nextPath, HOST_TOKEN_FILE);
  } catch (err) {
    console.error("writeHostToken failed:", err?.message ?? err);
  }
}

function rotateHostToken() {
  writeHostToken(mintJwt({ aud: "box", ttlSec: HOST_TOKEN_TTL_SEC }));
}

// The packaged desktop normally refreshes this credential through its auth
// flow. The local host can run without the desktop, so keep its dev token file
// independently fresh instead of waiting for an incidental auth request.
rotateHostToken();
setInterval(rotateHostToken, HOST_TOKEN_ROTATE_MS).unref();

function summary(method, p, ct, len, out) {
  const safePath = (p.split("?")[0] || "/").slice(0, 160);
  console.log(`${method} ${safePath} (${ct ?? "?"}, ${len}B) -> ${String(out).slice(0, 160)}`);
}

function cors(res) {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("access-control-allow-headers", "*");
  res.setHeader("access-control-expose-headers", "*");
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const HOP_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "accept-encoding",
  "transfer-encoding",
  "keep-alive",
  "upgrade",
]);

async function forward(req, p, body, res) {
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!HOP_HEADERS.has(k.toLowerCase())) headers[k] = v;
  }
  const target = UPSTREAM.replace(/\/+$/, "") + p;
  const upstream = await fetch(target, {
    method: req.method,
    headers,
    body: body.length > 0 ? body : undefined,
    redirect: "manual",
  });
  const respBuf = Buffer.from(await upstream.arrayBuffer());
  const respHeaders = {};
  upstream.headers.forEach((v, k) => {
    if (!["content-encoding", "content-length", "transfer-encoding", "connection"].includes(k.toLowerCase())) {
      respHeaders[k] = v;
    }
  });
  cors(res);
  res.writeHead(upstream.status, respHeaders);
  res.end(respBuf);
  return `forward ${upstream.status} (${respBuf.length}B)`;
}

function stubResponse(req, p, res) {
  const ct = String(req.headers["content-type"] ?? "");
  cors(res);
  if (ct.includes("application/connect+")) {
    // Connect streaming: just the end-of-stream frame, no messages.
    res.writeHead(200, { "content-type": ct });
    res.end(CONNECT_END_FRAME);
    return "stub empty-stream";
  }
  if (ct.includes("application/proto")) {
    res.writeHead(200, { "content-type": "application/proto" });
    res.end(Buffer.alloc(0));
    return "stub empty-proto";
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end("{}");
  return "stub {}";
}

const handle = async (req, res) => {
    const p = req.url ?? "/";
    const pathname = p.split("?")[0];
    const body = await readBody(req);
    const ct = String(req.headers["content-type"] ?? "");

    if (req.method === "OPTIONS") {
      cors(res);
      res.writeHead(204);
      res.end();
      summary(req.method, p, ct, body.length, "cors 204");
      return;
    }

    let out;
    try {
      if (pathname === "/auth/cursor_dev_session_token") {
        // Dev sign-in has no password: only the per-install address the
        // launcher passes as SAND_DEV_LOGIN_EMAIL gets a desktop session.
        const email = new URL(p, "http://localhost").searchParams.get("email");
        cors(res);
        if (email !== DESKTOP_LOGIN_EMAIL) {
          res.writeHead(403, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "unknown sign-in address; start Grok Bot with the launcher" }));
          out = "dev-session-token refused";
        } else {
          const { accessToken, refreshToken } = desktopTokens();
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ accessToken, refreshToken, authId: "shim-local-user" }));
          out = "dev-session-token";
        }
      } else if (pathname === "/oauth/token") {
        let refresh = null;
        try {
          refresh = JSON.parse(body.toString("utf8")).refresh_token;
        } catch {
          // not JSON: refused below
        }
        cors(res);
        if (!verifyJwt(refresh, "desktop-refresh")) {
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "invalid_grant" }));
          out = "oauth-refresh refused";
        } else {
          const { accessToken, refreshToken } = desktopTokens();
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ access_token: accessToken, refresh_token: refreshToken }));
          out = "oauth-refresh";
        }
      } else if (pathname === "/health") {
        cors(res);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        out = "health";
      } else if (pathname === "/aiserver.v1.AnalyticsService/BootstrapStatsig") {
        const payload = statsigBootstrap();
        cors(res);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
        out = "statsig local bootstrap";
      } else if (pathname === "/aiserver.v1.AiService/AvailableModels") {
        const payload = encodeAvailableModels();
        cors(res);
        res.writeHead(200, { "content-type": "application/proto" });
        res.end(payload);
        out = `available-models ${payload.length}B`;
      } else if (pathname === "/aiserver.v1.GrokBotService/EnsureSandBox") {
        const state = await box.ensure();
        const payload = encodeEnsureSandBox(boxConfig(), state);
        cors(res);
        res.writeHead(200, { "content-type": "application/proto" });
        res.end(payload);
        out = `ensure-sandbox ${state}`;
      } else if (pathname === "/aiserver.v1.GrokBotService/GetSandBoxRunState") {
        const state = await box.state();
        const payload = encodeRunState(state);
        cors(res);
        res.writeHead(200, { "content-type": "application/proto" });
        res.end(payload);
        out = `sandbox-run-state ${state}`;
      } else if (pathname === "/aiserver.v1.InferenceService/Stream") {
        cors(res);
        const msgFrames = parseConnectFrames(body).filter((f) => f.flags === 0);
        if (msgFrames.length === 0) {
          res.writeHead(200, { "content-type": ct });
          res.end(CONNECT_END_FRAME);
          out = "inference: no request frame";
        } else {
          const reqMsg = decodeStreamRequest(msgFrames[0].payload);
          const summary = requestSummary(reqMsg);
          console.log(`[inference] ${summary}`);
          res.writeHead(200, { "content-type": ct, "cache-control": "no-store" });
          const abortController = new AbortController();
          res.on("close", () => {
            if (!res.writableEnded) abortController.abort(new Error("client disconnected"));
          });
          let n = 0;
          try {
            for await (const frameBytes of runSession(reqMsg, { signal: abortController.signal })) {
              res.write(envelope(frameBytes));
              n++;
            }
          } catch (err) {
            if (!abortController.signal.aborted) console.error(`[inference] ${err?.name ?? "Error"}`);
          }
          res.end(CONNECT_END_FRAME);
          out = `inference ${n} frames`;
        }
      } else if (catalog.handles(pathname) && ct.includes("application/proto")) {
        const bytes = await catalog.read(pathname, body);
        if (bytes === null) {
          out = `catalog unavailable; ${stubResponse(req, p, res)}`;
        } else {
          cors(res);
          res.writeHead(200, { "content-type": "application/proto" });
          res.end(bytes);
          out = `catalog ${pathname.split("/").pop()} ${bytes.length}B`;
        }
      } else if (rpc?.handles(pathname) && ct.includes("application/proto")) {
        const method = pathname.split("/").pop();
        const caller = callerOf(req);
        cors(res);
        try {
          const payload = await rpc.unary(pathname, body, { caller });
          res.writeHead(200, { "content-type": "application/proto" });
          res.end(payload);
          out = `rpc ${method} ${payload.length}B (${caller})`;
        } catch (err) {
          if (!(err instanceof RpcError)) throw err;
          res.writeHead(err.httpStatus, { "content-type": "application/json" });
          res.end(err.body());
          out = `rpc ${method} ${err.code} (${caller})`;
        }
      } else if (MODE === "forward") {
        out = await forward(req, p, body, res);
      } else {
        out = stubResponse(req, p, res);
      }
    } catch (err) {
      console.error(`[request] ${req.method} ${pathname}: ${err?.name ?? "Error"}`);
      if (!res.headersSent) {
        cors(res);
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: String(err?.message ?? err) }));
      } else {
        res.end();
      }
      out = "request error";
    }
    summary(req.method, p, ct, body.length, out);
};

// Both listeners refuse other Host names (DNS rebinding) and any request with
// an Origin header (web pages); the app and the box host send neither.
const guarded = (req, res) => {
  const verdict = checkLoopbackRequest(req);
  if (!verdict.ok) {
    console.error(`[guard] refused ${req.method} ${(req.url ?? "/").split("?")[0].slice(0, 80)}: ${verdict.reason} (host=${String(req.headers.host).slice(0, 60)})`);
    res.writeHead(verdict.status, { "content-type": "text/plain" });
    res.end(verdict.reason);
    return;
  }
  return handle(req, res);
};

// HTTPS for the Linux host launcher, which trusts certs/rootCA.pem.
const server = https.createServer(
  {
    key: fs.readFileSync(path.join(ROOT, "certs", "localhost.key")),
    cert: fs.readFileSync(path.join(ROOT, "certs", "localhost.pem")),
  },
  guarded,
);

server.listen(PORT, "127.0.0.1", () => {
  console.log(`grokbot-shim recon server: https://localhost:${PORT} (mode=${MODE})`);
  if (MODE === "forward") console.log(`upstream: ${UPSTREAM}`);
});

// Plain HTTP on loopback for the Windows app and the box host. The app accepts
// http://localhost as a dev backend, so no TLS verification has to be disabled.
// Windows resolves "localhost" to ::1 first, so listen on both stacks.
const HTTP_PORT = Number(process.env.HTTP_PORT ?? 8444);
for (const host of ["127.0.0.1", "::1"]) {
  const plain = http.createServer(guarded);
  plain.on("error", (err) => {
    if (err.code !== "EADDRNOTAVAIL") console.error(`http listen ${host}: ${err.code ?? err.message}`);
  });
  plain.listen(HTTP_PORT, host, () => console.log(`grokbot-shim http: http://[${host}]:${HTTP_PORT}`));
}
