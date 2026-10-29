import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import protobuf from "protobufjs";
import { BotModels, COMMAND_CALL_PREFIX, choiceFor, isCommandFollowUp, modelCommandOf, runModelCommand, userQueryOf } from "../shim/bot-models.mjs";
import { resolveModel, runSession } from "../shim/inference.mjs";

const StreamResponse = protobuf
  .loadSync(fileURLToPath(new URL("../shim/inference.proto", import.meta.url)))
  .lookupType("aiserver.v1.InferenceStreamResponse");

const cfg = {
  default: "Luna High",
  fallback: "Luna High",
  models: {
    "Luna High": { provider: "codex-oauth", model: "gpt-6-luna", reasoning_effort: "high" },
    "GPT-6-Sol (Codex)": { provider: "codex-oauth", model: "gpt-6-sol", reasoning_effort: "medium" },
    "GPT-6.1-Sol (Codex)": { provider: "codex-oauth", model: "gpt-6.1-sol", reasoning_effort: "medium" },
  },
};
const store = () => new BotModels(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bm-")), "bot-models.json"));
const userMsg = (text) => ({ role: 1, content: "text", text });
const text = (m) => m.text ?? "";
const turn = (t, extra = {}) => ({ tools: [{}], messages: [userMsg(t)], conversationId: "bot-a", ...extra });

test("each Bot resolves to its own choice; others use the default", () => {
  const bm = store();
  bm.set("bot-a", "GPT-6-Sol (Codex)");
  assert.equal(resolveModel({ modelId: "grok-4.5", conversationId: "bot-a" }, cfg, bm).entry.model, "gpt-6-sol");
  assert.equal(resolveModel({ modelId: "grok-4.5", conversationId: "bot-b" }, cfg, bm).entry.model, "gpt-6-luna");
});

test("a subagent follows its Bot through the conversation group", () => {
  const bm = store();
  bm.set("bot-a", "GPT-6-Sol (Codex)");
  assert.equal(choiceFor({ conversationId: "sub-1", conversationGroupId: "bot-a" }, bm, cfg), "GPT-6-Sol (Codex)");
});

test("a choice that is no longer in models.json falls back to the default", () => {
  const bm = store();
  bm.set("bot-a", "Removed Model");
  assert.equal(resolveModel({ modelId: "grok-4.5", conversationId: "bot-a" }, cfg, bm).entry.model, "gpt-6-luna");
});

test("choices survive a restart", () => {
  const bm = store();
  bm.set("bot-a", "GPT-6-Sol (Codex)");
  assert.equal(new BotModels(bm.file).get("bot-a"), "GPT-6-Sol (Codex)");
});

test("/model is only a command as the last user message of a Bot turn", () => {
  assert.equal(modelCommandOf(turn("/model sol"), text), "sol");
  assert.equal(modelCommandOf(turn("!model sol"), text), "sol");
  assert.equal(modelCommandOf(turn("!models"), text), null);
  assert.equal(modelCommandOf(turn("  /MODEL  "), text), "");
  assert.equal(modelCommandOf(turn("please /model sol"), text), null);
  assert.equal(modelCommandOf(turn("/models"), text), null);
  assert.equal(modelCommandOf({ ...turn("/model sol"), tools: [] }, text), null); // host side request
  assert.equal(modelCommandOf({ ...turn("x"), messages: [userMsg("/model sol"), { role: 2, content: "text", text: "ok" }] }, text), null);
});

test("the command is found inside the host's message envelope", () => {
  const wrapped =
    "<timestamp>Wednesday, Oct 28, 2026, 8:40 PM (UTC-4)</timestamp>\n<user_query>\n[t15u]\n!model 2\n\n<system_reminder>\nReply with SendMessage.\n</system_reminder>\n</user_query>";
  assert.equal(userQueryOf(wrapped), "!model 2");
  assert.equal(modelCommandOf(turn(wrapped), text), "2");
  assert.equal(modelCommandOf(turn(wrapped.replace("!model 2", "what is !model")), text), null);
});

test("/model lists, picks by number or name, and resets", () => {
  const bm = store();
  const run = (arg) => runModelCommand(arg, { botId: "bot-a", botModels: bm, cfg });
  assert.match(run(""), /Model for this Bot: Luna High \(default\)/);
  assert.match(run(""), /1\. Luna High.*← this Bot/);
  assert.match(run("2"), /now uses GPT-6-Sol \(Codex\)/);
  assert.equal(bm.get("bot-a"), "GPT-6-Sol (Codex)");
  assert.match(run("gpt-6.1-sol"), /now uses GPT-6\.1-Sol \(Codex\)/);
  assert.match(run("sol"), /matches several models/);
  assert.equal(bm.get("bot-a"), "GPT-6.1-Sol (Codex)");
  assert.match(run("nope"), /No model called "nope"/);
  assert.match(run("9"), /No model called "9"/);
  assert.match(run("default"), /default model, Luna High/);
  assert.equal(bm.get("bot-a"), undefined);
  assert.match(runModelCommand("", { botId: undefined, botModels: bm, cfg }), /no Bot id/);
});

test("runSession answers /model itself without calling a model", async () => {
  const bm = store();
  let fetched = false;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetched = true;
    throw new Error("must not be called");
  };
  try {
    const frames = [];
    for await (const f of runSession(turn("/model GPT-6-Sol (Codex)"), { botModels: bm })) frames.push(f);
    assert.ok(frames.length >= 3);
    assert.equal(fetched, false);
    assert.equal(bm.get("bot-a"), "GPT-6-Sol (Codex)");
  } finally {
    globalThis.fetch = realFetch;
  }
});

const decode = (buf) => StreamResponse.toObject(StreamResponse.decode(buf));

test("in a Bot turn the reply goes out through SendMessage, and its result ends the turn", async () => {
  const bm = store();
  const req = { ...turn("!model"), tools: [{ name: "SendMessage" }] };
  const out = [];
  for await (const f of runSession(req, { botModels: bm })) out.push(decode(f));
  const call = out.find((f) => f.toolCallPart)?.toolCallPart;
  assert.equal(call.toolName, "SendMessage");
  assert.ok(call.toolCallId.startsWith(COMMAND_CALL_PREFIX));
  assert.match(JSON.parse(call.args).content, /Model for this Bot/);
  assert.equal(out.some((f) => f.textPart?.text), false);

  const followUp = {
    tools: req.tools,
    conversationId: "bot-a",
    messages: [...req.messages, { role: 3, toolContent: { parts: [{ toolCallId: call.toolCallId, toolName: "SendMessage" }] } }],
  };
  assert.equal(isCommandFollowUp(followUp), true);
  const end = [];
  for await (const f of runSession(followUp, { botModels: bm })) end.push(decode(f));
  assert.equal(end.some((f) => f.toolCallPart || f.error), false);
  assert.equal(isCommandFollowUp({ messages: [{ role: 3, toolContent: { parts: [{ toolCallId: "call_1" }] } }] }), false);
});
