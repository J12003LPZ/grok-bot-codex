import crypto from "node:crypto";
import { loadOrCreateToken } from "./secrets.mjs";

const b64url = (buf) =>
  Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// The shim is its own token issuer. Tokens are HS256-signed with a per-install
// key in state/jwt.token, which is never mounted into the box, and carry an
// audience saying who holds them:
//   "desktop"          the desktop app's access token,
//   "desktop-refresh"  the desktop app's refresh token,
//   "box"              the box host's token (state/box/host-token.json).
// The box can read only its own token, so it cannot pass as the desktop.
export const AUDIENCES = new Set(["desktop", "desktop-refresh", "box"]);

const signingKey = (key) => key ?? loadOrCreateToken("jwt");
const sign = (data, key) => b64url(crypto.createHmac("sha256", key).update(data).digest());

export function mintJwt({ aud, sub = "shim-local-user", email = "shim@local", ttlSec = 3600, key, now = Date.now() } = {}) {
  if (!AUDIENCES.has(aud)) throw new Error(`unknown token audience: ${aud}`);
  const iat = Math.floor(now / 1000);
  const h = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const p = b64url(JSON.stringify({ sub, email, aud, iat, exp: iat + ttlSec }));
  return `${h}.${p}.${sign(`${h}.${p}`, signingKey(key))}`;
}

// Returns the payload of a valid, unexpired token with the wanted audience,
// otherwise null.
export function verifyJwt(token, aud, { key, now = Date.now() } = {}) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const expected = Buffer.from(sign(`${parts[0]}.${parts[1]}`, signingKey(key)));
  const given = Buffer.from(parts[2]);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (payload.aud !== aud || typeof payload.exp !== "number" || payload.exp * 1000 <= now) return null;
  return payload;
}

export function bearerOf(req) {
  const m = /^Bearer\s+(\S+)$/i.exec(String(req.headers?.authorization ?? ""));
  return m ? m[1] : null;
}
