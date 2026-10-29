import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bearerOf, mintJwt, verifyJwt } from "../shim/jwt.mjs";
import { desktopLoginEmail } from "../shim/secrets.mjs";

const key = "k".repeat(64);

test("a token verifies only for its own audience", () => {
  const desk = mintJwt({ aud: "desktop", key });
  assert.equal(verifyJwt(desk, "desktop", { key }).aud, "desktop");
  assert.equal(verifyJwt(desk, "box", { key }), null);
  assert.equal(verifyJwt(mintJwt({ aud: "box", key }), "desktop", { key }), null);
  assert.equal(verifyJwt(mintJwt({ aud: "desktop-refresh", key }), "desktop", { key }), null);
});

test("forged, re-signed, tampered and expired tokens are refused", () => {
  const desk = mintJwt({ aud: "desktop", key });
  assert.equal(verifyJwt(desk, "desktop", { key: "other".repeat(13) }), null);
  const [h, , s] = desk.split(".");
  const forgedPayload = Buffer.from(JSON.stringify({ aud: "desktop", exp: 9e9 })).toString("base64url");
  assert.equal(verifyJwt(`${h}.${forgedPayload}.${s}`, "desktop", { key }), null);
  assert.equal(verifyJwt(`${h}.${forgedPayload}.`, "desktop", { key }), null);
  const old = mintJwt({ aud: "desktop", key, ttlSec: 10, now: 0 });
  assert.equal(verifyJwt(old, "desktop", { key, now: 11_000 }), null);
  for (const junk of [undefined, null, "", "a.b", "a.b.c.d", 5]) assert.equal(verifyJwt(junk, "desktop", { key }), null);
});

test("unknown audiences cannot be minted", () => {
  assert.throws(() => mintJwt({ aud: "admin", key }), /unknown token audience/);
  assert.throws(() => mintJwt({ key }), /unknown token audience/);
});

test("bearerOf reads the Authorization header", () => {
  assert.equal(bearerOf({ headers: { authorization: "Bearer abc.def.ghi" } }), "abc.def.ghi");
  assert.equal(bearerOf({ headers: { authorization: "Basic xyz" } }), null);
  assert.equal(bearerOf({ headers: {} }), null);
});

test("the desktop sign-in address is a stable per-install secret", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "em-"));
  const a = desktopLoginEmail(dir);
  assert.match(a, /^shim\+[0-9a-f]{32}@local$/);
  assert.equal(desktopLoginEmail(dir), a);
  assert.notEqual(desktopLoginEmail(fs.mkdtempSync(path.join(os.tmpdir(), "em-"))), a);
});
