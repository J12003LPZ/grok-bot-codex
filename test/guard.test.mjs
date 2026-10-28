import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkLoopbackRequest } from "../shim/guard.mjs";
import { loadOrCreateToken } from "../shim/secrets.mjs";
import { boxConfig } from "../shim/sandbox.mjs";

const req = (headers) => ({ headers });

test("accepts loopback Host values with and without port", () => {
  for (const host of ["localhost:8444", "127.0.0.1:8444", "[::1]:8444", "localhost", "host.docker.internal:8444"]) {
    assert.deepEqual(checkLoopbackRequest(req({ host })), { ok: true }, host);
  }
});

test("rejects a rebinding Host header", () => {
  for (const host of ["evil.example:8444", "localhost.evil.example", "127.0.0.1.evil.example:8444", "host.docker.internal.evil.example:8444", undefined]) {
    const r = checkLoopbackRequest(req({ host }));
    assert.equal(r.ok, false, String(host));
    assert.equal(r.status, 403);
  }
});

test("rejects any browser cross-origin request (Origin header present)", () => {
  const r = checkLoopbackRequest(req({ host: "localhost:8444", origin: "https://evil.example" }));
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
  // even a loopback origin: a page served from another local port is still a web page
  assert.equal(checkLoopbackRequest(req({ host: "localhost:8444", origin: "http://localhost:3000" })).ok, false);
});

test("loadOrCreateToken is random, stable, and private", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shim-secrets-"));
  const a = loadOrCreateToken("gateway", dir);
  const b = loadOrCreateToken("gateway", dir);
  const other = loadOrCreateToken("exec", dir);
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(a, b);
  assert.notEqual(a, other);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(path.join(dir, "gateway.token")).mode & 0o077, 0);
  }
});

test("boxConfig no longer ships a guessable default gateway token", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shim-secrets-"));
  const cfg = boxConfig({}, dir);
  assert.notEqual(cfg.gatewayToken, "shim-gateway-token");
  assert.match(cfg.gatewayToken, /^[0-9a-f]{64}$/);
  assert.equal(boxConfig({ SHIM_BOX_GATEWAY_TOKEN: "x".repeat(32) }, dir).gatewayToken, "x".repeat(32));
});

test("boxConfig refuses a short env-supplied gateway token", () => {
  assert.throws(() => boxConfig({ SHIM_BOX_GATEWAY_TOKEN: "short" }, os.tmpdir()), /at least 32/);
});
