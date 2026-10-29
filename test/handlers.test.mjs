import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentStore } from "../shim/agents.mjs";
import { agentHandlers } from "../shim/handlers.mjs";
import { RpcError, createRpc, loadGenerated } from "../shim/rpc.mjs";

const store = () => new AgentStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "h-")), "agents.json"));

const BOX = { caller: "box" };

test("template creation from the box host is idempotent and returns an owned box agent", () => {
  const s = store();
  const h = agentHandlers(s);
  const a = h.CreateGrokBotAgentFromTemplate({ agentId: "ag" }, BOX).agent;
  const b = h.CreateGrokBotAgentFromTemplate({ agentId: "ag" }, BOX).agent;
  assert.equal(a.id, b.id);
  assert.equal(s.list().length, 1);
  assert.equal(a.viewerIsOwner, true);
  assert.equal(a.harness, "box");
});

test("template creation from the desktop is Unimplemented so it falls back to the box host", () => {
  const s = store();
  const h = agentHandlers(s);
  assert.throws(
    () => h.CreateGrokBotAgentFromTemplate({ agentId: "ag" }, { caller: "desktop" }),
    (err) => err instanceof RpcError && err.code === "unimplemented" && err.httpStatus === 501,
  );
  assert.throws(() => h.CreateGrokBotAgentFromTemplate({ agentId: "ag" }), RpcError);
  assert.equal(s.list().length, 0);
});

test("list, update, delete walk the store", () => {
  const s = store();
  const h = agentHandlers(s);
  const { agent } = h.CreateGrokBotAgent({ name: "Zed" });
  assert.deepEqual(h.ListGrokBotAgents().agents.map((x) => x.name), ["Zed"]);
  assert.equal(h.UpdateGrokBotAgent({ id: agent.id, name: "Zee" }).agent.name, "Zee");
  assert.deepEqual(h.UpdateGrokBotAgent({ id: "nope", name: "x" }), {});
  h.DeleteGrokBotAgent({ id: agent.id });
  assert.deepEqual(h.ListGrokBotAgents().agents, []);
  assert.deepEqual(h.ListDeletedGrokBotAgentIds().agentIds, [agent.id]);
});

test("statuses and sessions only cover known agents", () => {
  const s = store();
  const h = agentHandlers(s);
  const { agent } = h.CreateGrokBotAgent({});
  assert.deepEqual(h.ListGrokBotAgentStatuses({ agentIds: [agent.id, "ghost"] }).statuses, [
    { agentId: agent.id, isRunning: false },
  ]);
  assert.equal(h.ListGrokBotAgentSessions({ agentId: agent.id }).sessions.length, 1);
  assert.deepEqual(h.ListGrokBotAgentSessions({ agentId: "ghost" }).sessions, []);
});

// Needs the schema generated from the installed app, so it only runs where
// `node scripts/gen-proto.mjs <proto.cjs>` has been run.
const generated = loadGenerated();
test("every handler reply encodes against the app's real schema", { skip: generated === null }, async () => {
  const s = store();
  const handlers = agentHandlers(s);
  const rpc = createRpc({ ...generated, handlers });
  const call = async (name, req) => {
    const route = Object.keys(generated.rpcs).find((r) => r.endsWith(`/${name}`));
    const In = generated.root.lookupType(`aiserver.v1.${generated.rpcs[route].input}`);
    return rpc.unary(route, Buffer.from(In.encode(In.fromObject(req)).finish()), BOX);
  };
  for (const [name, req] of Object.entries({
    CreateGrokBotAgentFromTemplate: { agentId: "ag" },
    CreateGrokBotAgent: { name: "n", harness: 1 },
    ListGrokBotAgents: {},
    ListDeletedGrokBotAgentIds: {},
    ListGrokBotAgentStatuses: { agentIds: ["ag"] },
    ListGrokBotAgentSessions: { agentId: "ag" },
    UpdateGrokBotAgent: { id: "ag", name: "m" },
    DeleteGrokBotAgent: { id: "ag" },
  })) {
    const bytes = await call(name, req);
    assert.ok(Buffer.isBuffer(bytes), name);
  }
});
