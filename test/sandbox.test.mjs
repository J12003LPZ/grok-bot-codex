import test from "node:test";
import assert from "node:assert/strict";
import {
  boxConfig,
  decodeEnsureSandBox,
  decodeRunState,
  encodeEnsureSandBox,
  encodeRunState,
} from "../shim/sandbox.mjs";

test("boxConfig defaults point at the local container on loopback", () => {
  const cfg = boxConfig({});
  assert.equal(cfg.execDaemonUrl, "http://127.0.0.1:1337");
  assert.equal(cfg.vncUrl, "http://127.0.0.1:6080/vnc.html");
  assert.equal(cfg.gatewayUrl, "http://127.0.0.1:8550");
  assert.ok(cfg.gatewayToken.length > 0);
  assert.ok(cfg.execDaemonAuthToken.length > 0);
});

test("boxConfig honours env overrides", () => {
  const cfg = boxConfig({
    SHIM_BOX_GATEWAY_URL: "http://127.0.0.1:9000",
    SHIM_BOX_GATEWAY_TOKEN: "tok",
  });
  assert.equal(cfg.gatewayUrl, "http://127.0.0.1:9000");
  assert.equal(cfg.gatewayToken, "tok");
});

test("boxConfig refuses non-loopback box URLs", () => {
  assert.throws(() => boxConfig({ SHIM_BOX_GATEWAY_URL: "http://example.com:8550" }), /loopback/);
});

test("EnsureSandBoxResponse round-trips the fields the app reads", () => {
  const cfg = boxConfig({});
  const msg = decodeEnsureSandBox(encodeEnsureSandBox(cfg));
  assert.equal(msg.execDaemonUrl, cfg.execDaemonUrl);
  assert.equal(msg.execDaemonAuthToken, cfg.execDaemonAuthToken);
  assert.equal(msg.vncUrl, cfg.vncUrl);
  assert.equal(msg.gatewayUrl, cfg.gatewayUrl);
  assert.equal(msg.gatewayToken, cfg.gatewayToken);
  assert.equal(msg.runState, "RUNNING");
  assert.equal(msg.imageUpdateAvailable, false);
  assert.ok(msg.podId.length > 0);
});

test("EnsureSandBoxResponse uses wire field numbers from the app schema", () => {
  const bytes = encodeEnsureSandBox(boxConfig({}));
  // field 10 (gateway_url) and 13 (run_state) must be present on the wire.
  const tags = new Set();
  for (let i = 0; i < bytes.length; ) {
    const tag = bytes[i];
    tags.add(tag >> 3);
    const wire = tag & 7;
    i += 1;
    if (wire === 0) {
      while (bytes[i] & 0x80) i++;
      i++;
    } else if (wire === 2) {
      let len = 0;
      let shift = 0;
      while (bytes[i] & 0x80) {
        len |= (bytes[i] & 0x7f) << shift;
        shift += 7;
        i++;
      }
      len |= bytes[i] << shift;
      i += 1 + len;
    } else {
      throw new Error(`unexpected wire type ${wire}`);
    }
  }
  for (const n of [5, 6, 7, 10, 11, 13]) assert.ok(tags.has(n), `field ${n} missing`);
});

test("GetSandBoxRunStateResponse reports RUNNING", () => {
  const msg = decodeRunState(encodeRunState());
  assert.equal(msg.state, "RUNNING");
  assert.equal(msg.imageUpdateAvailable, false);
});
