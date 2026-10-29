import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import protobuf from "protobufjs";
import { AgentStore, newAgent } from "../shim/agents.mjs";
import { RpcError, createRpc } from "../shim/rpc.mjs";

test("RpcError carries the Connect code, HTTP status and JSON body", () => {
  const err = new RpcError("unimplemented", "nope");
  assert.equal(err.httpStatus, 501);
  assert.deepEqual(JSON.parse(err.body()), { code: "unimplemented", message: "nope" });
  assert.throws(() => new RpcError("bogus", "x"), /unknown Connect code/);
});

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agents-")), "agents.json");

test("newAgent fills the fields the app needs for an owned box agent", () => {
  const a = newAgent({ agentId: "ag-1", name: "Ada" }, 1000);
  assert.equal(a.id, "ag-1");
  assert.equal(a.agentId, "ag-1");
  assert.equal(a.name, "Ada");
  assert.equal(a.createdAtMs, 1000);
  assert.equal(a.viewerIsOwner, true);
  assert.equal(a.viewerCanManage, true);
  assert.equal(a.kind, "GrokBotAgentKind_AGENT");
  assert.ok(a.viewerSessionId.length > 0);
});

test("newAgent generates an id and a default name when none is given", () => {
  const a = newAgent({}, 5);
  assert.match(a.id, /^[0-9a-f-]{36}$/);
  assert.equal(a.agentId, a.id);
  assert.equal(a.name, "Grok Bot");
});

test("AgentStore persists across instances", () => {
  const file = tmpFile();
  const s1 = new AgentStore(file);
  const a = s1.create({ name: "One" });
  const s2 = new AgentStore(file);
  assert.deepEqual(s2.list().map((x) => x.id), [a.id]);
  assert.equal(s2.get(a.id).name, "One");
});

test("AgentStore.create is idempotent for a given agentId (retries must not duplicate)", () => {
  const s = new AgentStore(tmpFile());
  const a = s.create({ agentId: "same", name: "A" });
  const b = s.create({ agentId: "same", name: "B" });
  assert.equal(s.list().length, 1);
  assert.equal(b.id, a.id);
  assert.equal(b.name, "A");
});

test("AgentStore update and remove; removed ids are reported as deleted", () => {
  const s = new AgentStore(tmpFile());
  const a = s.create({ name: "x" });
  const u = s.update(a.id, { name: "y" }, 99);
  assert.equal(u.name, "y");
  assert.equal(u.updatedAtMs, 99);
  assert.equal(s.remove(a.id), true);
  assert.equal(s.get(a.id), undefined);
  assert.deepEqual(s.deletedIds(), [a.id]);
  assert.equal(s.remove("missing"), false);
});

test("AgentStore survives a corrupt file by starting empty", () => {
  const file = tmpFile();
  fs.writeFileSync(file, "{not json");
  assert.deepEqual(new AgentStore(file).list(), []);
});

const PROTO = `
syntax = "proto3";
package aiserver.v1;
message PingRequest { string who = 1; int64 n = 2; }
message PingResponse { string greeting = 1; int64 n = 2; Kind kind = 3; }
enum Kind { Kind_UNSET = 0; Kind_LOUD = 1; }
`;
const RPCS = {
  "/aiserver.v1.TestService/Ping": { service: "TestService", method: "ping", input: "PingRequest", output: "PingResponse", kind: 0 },
  "/aiserver.v1.TestService/Silent": { service: "TestService", method: "silent", input: "PingRequest", output: "PingResponse", kind: 0 },
};

function rpc(handlers) {
  return createRpc({ root: protobuf.parse(PROTO).root, rpcs: RPCS, handlers });
}
const enc = (obj) => {
  const T = protobuf.parse(PROTO).root.lookupType("aiserver.v1.PingRequest");
  return Buffer.from(T.encode(T.fromObject(obj)).finish());
};
const dec = (bytes) => {
  const T = protobuf.parse(PROTO).root.lookupType("aiserver.v1.PingResponse");
  return T.toObject(T.decode(bytes), { longs: Number, enums: String, defaults: true });
};

test("rpc routes a registered handler with a decoded request and encodes the reply", async () => {
  const r = rpc({ Ping: (req) => ({ greeting: `hi ${req.who}`, n: req.n + 1, kind: "Kind_LOUD" }) });
  assert.equal(r.handles("/aiserver.v1.TestService/Ping"), true);
  const out = dec(await r.unary("/aiserver.v1.TestService/Ping", enc({ who: "bo", n: 41 })));
  assert.deepEqual(out, { greeting: "hi bo", n: 42, kind: "Kind_LOUD" });
});

test("rpc does not claim methods without a handler or paths it does not know", () => {
  const r = rpc({ Ping: () => ({}) });
  assert.equal(r.handles("/aiserver.v1.TestService/Silent"), false);
  assert.equal(r.handles("/aiserver.v1.Other/Thing"), false);
});

test("rpc rejects a handler reply that does not fit the schema", async () => {
  const r = rpc({ Ping: () => ({ greeting: 5 }) });
  await assert.rejects(() => r.unary("/aiserver.v1.TestService/Ping", enc({})), /Ping/);
});

test("rpc surfaces malformed request bytes as an error", async () => {
  const r = rpc({ Ping: () => ({}) });
  await assert.rejects(() => r.unary("/aiserver.v1.TestService/Ping", Buffer.from([0xff, 0xff, 0xff])), /Ping/);
});
