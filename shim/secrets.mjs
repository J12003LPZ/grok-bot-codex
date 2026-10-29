import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const STATE_DIR = path.join(ROOT, "state");

// Per-install secret kept under state/ (git-ignored), created once with a
// private mode and reused so the shim and the box container agree on it.
export function loadOrCreateToken(name, dir = STATE_DIR) {
  if (!/^[a-z-]+$/.test(name)) throw new Error(`bad token name: ${name}`);
  const file = path.join(dir, `${name}.token`);
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (/^[0-9a-f]{64}$/.test(existing)) return existing;
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  fs.mkdirSync(dir, { recursive: true });
  const token = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
  return token;
}

// The address the desktop signs in with (SAND_DEV_LOGIN_EMAIL). Dev sign-in has
// no password, so the shim only accepts this per-install address; the box
// cannot read it and so cannot sign in as the desktop.
export function desktopLoginEmail(dir = STATE_DIR) {
  return `shim+${loadOrCreateToken("desktop-login", dir).slice(0, 32)}@local`;
}

// `node shim/secrets.mjs gateway` prints the token for computerctl.sh;
// `node shim/secrets.mjs desktop-login-email` prints the sign-in address.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const name = process.argv[2] ?? "gateway";
  process.stdout.write(name === "desktop-login-email" ? desktopLoginEmail() : loadOrCreateToken(name));
}
