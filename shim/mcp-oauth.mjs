import crypto from "node:crypto";
import dns from "node:dns/promises";
import net from "node:net";

// OAuth for remote MCP servers, as the MCP authorization spec lays it out:
// the server names its authorization server in protected-resource metadata,
// the client registers itself there (dynamic client registration) or uses a
// client the user configured, then runs an authorization-code flow with PKCE.

const TIMEOUT_MS = 15_000;

// Connector URLs come from third-party plugins and remote metadata, so they
// must use HTTPS ...
export function checkUrl(raw, what) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`${what} is not a URL`);
  }
  if (u.protocol !== "https:") throw new Error(`${what} must use https`);
  return u;
}

// ... and reach the public internet only: never this machine, the box gateway
// or the local network.
// Separate lists: one BlockList also matches IPv4 addresses against IPv6
// rules for IPv4-mapped space, which would block everything.
const PRIVATE_V4 = new net.BlockList();
for (const [addr, bits] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 3]]) {
  PRIVATE_V4.addSubnet(addr, bits, "ipv4");
}
const PRIVATE_V6 = new net.BlockList();
for (const [addr, bits] of [["::", 127], ["64:ff9b::", 96], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]]) {
  PRIVATE_V6.addSubnet(addr, bits, "ipv6");
}

export function isPublicAddress(address) {
  if (net.isIPv4(address)) return !PRIVATE_V4.check(address, "ipv4");
  if (!net.isIPv6(address)) return false;
  // IPv4-mapped (::ffff:a.b.c.d) would reach IPv4 space; DNS has no reason to return it.
  if (/^(0{0,4}:){0,5}:?ffff:/i.test(address)) return false;
  return !PRIVATE_V6.check(address, "ipv6");
}

export async function publicFetch(url, init) {
  const u = checkUrl(url, "connector URL");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true, verbatim: true });
  if (!addrs.length || !addrs.every((a) => isPublicAddress(a.address))) throw new Error(`${u.hostname} is not a public address`);
  return fetch(url, init);
}

// { status, body }; body is undefined unless the reply was OK JSON. Network
// errors throw, so a caller can tell "not published" (404) from "unreachable".
async function getJson(url, fetchImpl) {
  const res = await fetchImpl(url, { headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) return { status: res.status };
  try {
    return { status: res.status, body: await res.json() };
  } catch {
    return { status: res.status };
  }
}

// The metadata's resource must be the server itself or a parent path of it,
// or a server could collect a token minted for some other server.
function checkResource(resource, serverUrl) {
  const r = checkUrl(resource, "protected resource");
  const s = new URL(serverUrl);
  const rp = r.pathname.replace(/\/$/, "");
  if (r.origin !== s.origin || !(s.pathname === rp || s.pathname.startsWith(`${rp}/`) || rp === "")) {
    throw new Error(`sign-in metadata of ${s.origin} is for another server (${r.href})`);
  }
}

// RFC 9728 well-known locations for a resource: path-suffixed first, then root.
function protectedResourceUrls(serverUrl) {
  const u = new URL(serverUrl);
  const p = u.pathname.replace(/\/$/, "");
  return [...(p ? [`${u.origin}/.well-known/oauth-protected-resource${p}`] : []), `${u.origin}/.well-known/oauth-protected-resource`];
}

// RFC 8414 / OIDC discovery locations for an issuer.
function authServerUrls(issuer) {
  const u = new URL(issuer);
  const p = u.pathname.replace(/\/$/, "");
  return [
    `${u.origin}/.well-known/oauth-authorization-server${p}`,
    `${u.origin}/.well-known/openid-configuration${p}`,
    ...(p ? [`${u.origin}${p}/.well-known/openid-configuration`] : []),
  ];
}

// Returns undefined when the server publishes no OAuth metadata (no sign-in),
// or { resource, issuer, scopes, authorizationEndpoint, tokenEndpoint, registrationEndpoint }.
// Throws when the metadata can't be read right now (5xx, timeout), so a
// passing outage is never mistaken for "needs no sign-in".
export async function discover(serverUrl, { fetchImpl = publicFetch, resourceMetadataUrl } = {}) {
  checkUrl(serverUrl, "MCP server URL");
  let prm;
  let unreadable = false;
  for (const url of resourceMetadataUrl ? [resourceMetadataUrl] : protectedResourceUrls(serverUrl)) {
    checkUrl(url, "resource metadata URL");
    const got = await getJson(url, fetchImpl);
    if (got.body?.authorization_servers?.length) {
      prm = got.body;
      break;
    }
    if (got.status !== 404 && !(got.status === 200 && got.body)) unreadable = true;
  }
  if (!prm) {
    if (unreadable) throw new Error(`could not read the sign-in metadata of ${new URL(serverUrl).origin}`);
    return undefined;
  }
  if (typeof prm.resource === "string") checkResource(prm.resource, serverUrl);
  const issuer = String(prm.authorization_servers[0]);
  checkUrl(issuer, "authorization server");
  let as;
  for (const url of authServerUrls(issuer)) {
    as = (await getJson(url, fetchImpl)).body;
    if (as?.authorization_endpoint && as?.token_endpoint) break;
  }
  if (!as?.authorization_endpoint || !as?.token_endpoint) throw new Error(`no OAuth metadata at ${issuer}`);
  checkUrl(as.authorization_endpoint, "authorization endpoint");
  checkUrl(as.token_endpoint, "token endpoint");
  if (as.registration_endpoint) checkUrl(as.registration_endpoint, "registration endpoint");
  return {
    resource: typeof prm.resource === "string" ? prm.resource : serverUrl,
    // The issuer the metadata was fetched from, not the one it claims to be:
    // saved clients (and their secrets) are looked up by this, so a server
    // that names its own authorization server can't pass as Google.
    issuer,
    scopes: Array.isArray(prm.scopes_supported) ? prm.scopes_supported.map(String) : [],
    authorizationEndpoint: as.authorization_endpoint,
    tokenEndpoint: as.token_endpoint,
    registrationEndpoint: as.registration_endpoint,
  };
}

// Dynamic client registration (RFC 7591) as a public client, one per server:
// the consent page then names the server that will receive the token.
export async function registerClient(meta, redirectUri, { fetchImpl = publicFetch } = {}) {
  const res = await fetchImpl(meta.registrationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_name: `Grok Bot (local) for ${new URL(meta.resource).host}`,
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
    redirect: "error",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.client_id) throw new Error(`client registration failed (HTTP ${res.status})`);
  return { clientId: String(body.client_id), ...(body.client_secret ? { clientSecret: String(body.client_secret) } : {}) };
}

const b64url = (buf) => buf.toString("base64url");

export function newPkce() {
  const verifier = b64url(crypto.randomBytes(32));
  return { verifier, challenge: b64url(crypto.createHash("sha256").update(verifier).digest()) };
}

const isGoogle = (issuer) => /^https:\/\/accounts\.google\.com\/?$/.test(issuer);

export function authorizationUrl(meta, client, { redirectUri, state, challenge }) {
  const u = new URL(meta.authorizationEndpoint);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", client.clientId);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("state", state);
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("code_challenge_method", "S256");
  if (meta.scopes.length) u.searchParams.set("scope", meta.scopes.join(" "));
  if (isGoogle(meta.issuer)) {
    // Google only returns a refresh token with these.
    u.searchParams.set("access_type", "offline");
    u.searchParams.set("prompt", "consent");
  } else {
    u.searchParams.set("resource", meta.resource);
  }
  return u.toString();
}

async function tokenRequest(meta, client, params, fetchImpl) {
  const body = new URLSearchParams({ ...params, client_id: client.clientId });
  if (client.clientSecret) body.set("client_secret", client.clientSecret);
  if (!isGoogle(meta.issuer)) body.set("resource", meta.resource);
  const res = await fetchImpl(meta.tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body,
    redirect: "error",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    const err = new Error(`token request failed (HTTP ${res.status}${json.error ? `: ${json.error}` : ""})`);
    // 400/401 (invalid_grant and the like) means the grant is gone; anything
    // else is worth retrying later.
    err.rejected = res.status === 400 || res.status === 401;
    throw err;
  }
  return {
    accessToken: String(json.access_token),
    ...(json.refresh_token ? { refreshToken: String(json.refresh_token) } : {}),
    ...(json.expires_in ? { expiresAt: Date.now() + Number(json.expires_in) * 1000 } : {}),
  };
}

export const exchangeCode = (meta, client, { code, verifier, redirectUri }, { fetchImpl = publicFetch } = {}) =>
  tokenRequest(meta, client, { grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirectUri }, fetchImpl);

export const refreshTokens = (meta, client, refreshToken, { fetchImpl = publicFetch } = {}) =>
  tokenRequest(meta, client, { grant_type: "refresh_token", refresh_token: refreshToken }, fetchImpl);
