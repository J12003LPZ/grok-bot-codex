import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import protobuf from "protobufjs";
import test from "node:test";

import { codexSession, resolveCredential } from "../shim/codex-oauth.mjs";
import { CONNECT_END_FRAME, envelope, frameBytes, parseConnectFrames } from "../shim/connect.mjs";
import { authorizeChatGPT } from "../shim/auth.mjs";
import { resolveModel, requestSummary } from "../shim/inference.mjs";
import { jsonToValue } from "../shim/struct.mjs";

const protoRoot = protobuf.loadSync(fileURLToPath(new URL("../shim/inference.proto", import.meta.url)));
const StreamResponse = protoRoot.lookupType("aiserver.v1.InferenceStreamResponse");
const StreamRequest = protoRoot.lookupType("aiserver.v1.InferenceStreamRequest");
const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
let temp;
let authFile;

function token(exp = Math.floor(Date.now() / 1000) + 3600, scope = "chatgpt.tokens.use.direct") {
  const payload = Buffer.from(JSON.stringify({ exp, scope, sub: crypto.randomUUID() })).toString("base64url");
  return `header.${payload}.signature`;
}

function setupCredential(accessToken = token(), extra = {}) {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), "grokbot-shim-test-"));
  authFile = path.join(temp, "grokbot-shim", "auth.json");
  fs.mkdirSync(path.dirname(authFile), { recursive: true });
  fs.writeFileSync(authFile, JSON.stringify({
    access_token: accessToken,
    refresh_token: "fake-refresh",
    client_id: "oaiapp_test-client",
    scopes: ["openid", "offline_access", "resource.invoke", "chatgpt.tokens.use.direct"],
    ...extra,
  }));
  process.env.CODEX_AUTH_FILE = authFile;
  process.env.CODEX_HOME = path.join(temp, "codex-home");
  delete process.env.CODEX_ACCESS_TOKEN;
  return accessToken;
}

function eventsResponse(events, { split = false } = {}) {
  const bytes = new TextEncoder().encode(events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join(""));
  const chunks = split ? [bytes.slice(0, 17), bytes.slice(17, 38), bytes.slice(38)] : [bytes];
  const body = new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); } });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function decodeFrames(frames) {
  return frames.map((frame) => StreamResponse.toObject(StreamResponse.decode(frame), { defaults: true, arrays: true, objects: true, enums: String }));
}

function fixtureFetch(responses, captured = []) {
  return async (url, options = {}) => {
    captured.push({ url: String(url), options });
    if (String(url).endsWith("/models")) {
      return Response.json({ models: [{ slug: "gpt-5.6-luna", display_name: "GPT-5.6 Luna", visibility: "list" }] });
    }
    const next = responses.shift();
    if (!next) throw new Error("unexpected network request");
    return typeof next === "function" ? next() : next;
  };
}

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  if (temp) fs.rmSync(temp, { recursive: true, force: true });
  temp = undefined;
});

test("rejects a codex login token without direct plan authorization without sending it anywhere", async () => {
  setupCredential(token(Math.floor(Date.now() / 1000) + 3600, "openid profile"), { scopes: ["openid", "profile"] });
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("should not fetch"); };
  await assert.rejects(resolveCredential(), /missing chatgpt\.tokens\.use\.direct/);
  assert.equal(calls, 0);
});

test("refuses to treat or modify Codex CLI auth.json as the shim credential store", async () => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), "grokbot-cli-auth-test-"));
  process.env.CODEX_HOME = temp;
  const file = path.join(temp, "auth.json");
  const original = JSON.stringify({ auth_mode: "chatgpt", untouched: "private" });
  fs.writeFileSync(file, original);
  process.env.CODEX_AUTH_FILE = file;
  delete process.env.CODEX_ACCESS_TOKEN;
  await assert.rejects(resolveCredential(), /must not point to Codex CLI auth\.json/);
  assert.equal(fs.readFileSync(file, "utf8"), original);
});

test("refreshes expired plan tokens using their saved client ID and rotates the token", async () => {
  setupCredential(token(Math.floor(Date.now() / 1000) - 10));
  const renewed = token();
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url: String(url), options };
    return Response.json({ access_token: renewed, refresh_token: "rotated-refresh", id_token: "new-id" });
  };
  const credential = await resolveCredential();
  assert.equal(credential.accessToken, renewed);
  assert.equal(request.url, "https://auth.openai.com/api/accounts/oauth/token");
  const form = new URLSearchParams(request.options.body);
  assert.equal(form.get("client_id"), "oaiapp_test-client");
  assert.equal(form.get("resource"), "https://api.openai.com/v1");
  const saved = JSON.parse(fs.readFileSync(authFile, "utf8"));
  assert.equal(saved.refresh_token, "rotated-refresh");
  assert.equal(saved.client_id, "oaiapp_test-client");
});

test("serializes concurrent refreshes of the same rotating refresh token", async () => {
  setupCredential(token(Math.floor(Date.now() / 1000) - 10));
  const renewed = token();
  let refreshCalls = 0;
  globalThis.fetch = async () => {
    refreshCalls++;
    await new Promise((resolve) => setTimeout(resolve, 25));
    return Response.json({ access_token: renewed, refresh_token: "rotated-once" });
  };
  const [first, second] = await Promise.all([resolveCredential(), resolveCredential()]);
  assert.equal(first.accessToken, renewed);
  assert.equal(second.accessToken, renewed);
  assert.equal(refreshCalls, 1);
});

test("continues Grok Bot tool history, reasoning and screenshot content on the documented endpoint", async () => {
  const accessToken = setupCredential();
  const captured = [];
  globalThis.fetch = fixtureFetch([eventsResponse([
    { type: "response.reasoning_summary_text.delta", delta: "Checking the page." },
    { type: "response.output_item.done", item: { type: "reasoning", id: "reason-1", encrypted_content: "sealed", summary: [{ type: "summary_text", text: "Checking the page." }] } },
    { type: "response.output_item.done", item: { type: "function_call", call_id: "call-read", name: "ReadFile", arguments: "{\"path\":\"result.txt\"}" } },
    { type: "response.output_item.done", item: { type: "function_call", call_id: "call-new", name: "SendMessage", arguments: "{\"message\":\"Done\"}" } },
    { type: "response.completed", response: { id: "resp-1", model: "gpt-5.6-luna", usage: { input_tokens: 21, output_tokens: 8 } } },
  ], { split: true })], captured);
  const req = {
    modelId: "GPT-5.6-Luna (Codex)",
    conversationId: "conversation-test",
    messages: [
      { role: 4, content: "text", text: "You are Grok Bot. Use tools and call SendMessage to reply." },
      { role: 1, content: "text", text: "Inspect this desktop." },
      { role: 2, content: "text", text: "I will inspect the desktop.", toolCalls: [{ toolCallId: "call-old", toolName: "Computer", rawToolCallArgs: "{\"action\":\"screenshot\"}" }], reasoningParts: [{ text: "I need a screenshot.", signature: JSON.stringify({ __codex: 1, id: "reason-old", encrypted_content: "prior-sealed" }) }] },
      { role: 3, toolContent: { parts: [{ toolCallId: "call-old", toolName: "Computer", result: jsonToValue("screenshot captured"), experimentalContent: [{ part: "image", image: { data: "c2NyZWVu", mimeType: "image/png" } }] }] } },
      { role: 1, content: "text", text: "What is visible?" },
    ],
    tools: [
      { name: "SendMessage", description: "Send a visible user response", parameters: { fields: { type: { stringValue: "object" } } } },
      { name: "ReadFile", description: "Read a local file", parameters: { fields: { type: { stringValue: "object" } } } },
    ],
  };
  const frames = [];
  for await (const frame of codexSession(req, { model: "gpt-5.6-luna", reasoning_effort: "max" })) frames.push(frame);
  const request = captured.find(({ url }) => url.endsWith("/responses"));
  assert.equal(request.url, "https://api.openai.com/v1/responses");
  assert.equal(request.options.headers.authorization, `Bearer ${accessToken}`);
  const body = JSON.parse(request.options.body);
  assert.equal(body.model, "gpt-5.6-luna");
  assert.equal(body.reasoning.effort, "max");
  assert.equal(body.store, false);
  assert.equal(body.parallel_tool_calls, true);
  assert.equal(body.tools, undefined);
  assert.ok(body.input[0].type === "additional_tools" && body.input[0].tools.length === 2);
  assert.ok(body.input.some((item) => item.type === "reasoning" && item.encrypted_content === "prior-sealed"));
  const output = body.input.find((item) => item.type === "function_call_output");
  assert.ok(output.output.some((part) => part.type === "input_image" && part.image_url.startsWith("data:image/png;base64,")));
  const decoded = decodeFrames(frames);
  assert.ok(decoded.some((frame) => frame.thinkingPart?.text === "Checking the page."));
  assert.equal(decoded.filter((frame) => frame.toolCallPart).length, 2);
  assert.ok(decoded.some((frame) => frame.toolCallPart?.toolCallId === "call-new"));
  const info = decoded.find((frame) => frame.responseInfo)?.responseInfo;
  assert.equal(info.messages[0].toolCalls[0].rawToolCallArgs, "{\"path\":\"result.txt\"}");
  assert.equal(info.messages[0].toolCalls[1].rawToolCallArgs, "{\"message\":\"Done\"}");
  assert.equal(info.messages[0].reasoningParts[0].text, "Checking the page.");
});

test("rate limits are returned to Grok Bot without any provider fallback", async () => {
  setupCredential();
  const captured = [];
  globalThis.fetch = fixtureFetch([Response.json({ error: { code: "subscription_sharing_usage_limit_exceeded", message: "limit reached" } }, { status: 429 })], captured);
  const frames = [];
  for await (const frame of codexSession({ modelId: "GPT-5.6-Luna (Codex)", messages: [], tools: [] }, { model: "gpt-5.6-luna" })) frames.push(frame);
  const decoded = decodeFrames(frames);
  assert.ok(decoded.some((frame) => frame.error?.errorType === "INFERENCE_STREAM_ERROR_TYPE_RATE_LIMIT"));
  assert.ok(captured.every(({ url }) => url.startsWith("https://api.openai.com/v1/")));
  assert.equal(captured.length, 2);
});

test("malformed tool arguments and incomplete/disconnected streams are errors", async (t) => {
  for (const [name, response, expected] of [
    ["malformed tool args", eventsResponse([{ type: "response.output_item.done", item: { type: "function_call", name: "Shell", call_id: "call-bad", arguments: "not-json" } }, { type: "response.completed", response: {} }]), /malformed arguments/],
    ["incomplete response", eventsResponse([{ type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" } } }]), /response incomplete/],
    ["disconnect", new Response(new ReadableStream({ start(c) { c.error(new Error("network down")); } }), { status: 200 }), /stream disconnected/],
  ]) {
    await t.test(name, async () => {
      setupCredential();
      globalThis.fetch = fixtureFetch([response]);
      const frames = [];
      for await (const frame of codexSession({ modelId: "GPT-5.6-Luna (Codex)", messages: [], tools: [] }, { model: "gpt-5.6-luna" })) frames.push(frame);
      const decoded = decodeFrames(frames);
      assert.ok(decoded.some((frame) => frame.error && expected.test(frame.error.message)));
    });
  }
});

test("preserves custom tools, file inputs, and cancellation", async (t) => {
  await t.test("custom tool output and file content", async () => {
    setupCredential();
    let requestBody;
    globalThis.fetch = async (url, options = {}) => {
      if (String(url).endsWith("/models")) return Response.json({ models: [{ slug: "gpt-5.6-luna", visibility: "list" }] });
      requestBody = JSON.parse(options.body);
      return eventsResponse([
        { type: "response.output_item.done", item: { type: "custom_tool_call", call_id: "custom-next", name: "ComputerScript", input: "click(10, 20)" } },
        { type: "response.completed", response: { model: "gpt-5.6-luna" } },
      ]);
    };
    const req = {
      modelId: "GPT-5.6-Luna (Codex)",
      tools: [{ name: "ComputerScript", description: "run a script", customToolFormat: { type: "grammar", syntax: "lark", definition: "start: \"click\"" } }],
      messages: [
        { role: 2, content: "text", text: "Run it", toolCalls: [{ toolCallId: "custom-old", toolName: "ComputerScript", rawToolCallArgs: "click(1, 2)" }] },
        { role: 3, toolContent: { parts: [{ toolCallId: "custom-old", toolName: "ComputerScript", result: jsonToValue("ok"), experimentalContent: [{ part: "file", file: { data: "ZmlsZQ==", mediaType: "text/plain", filename: "notes.txt" } }] }] } },
        { role: 1, content: "parts", parts: { parts: [{ part: "file", file: { data: "ZmlsZQ==", mediaType: "text/plain", filename: "prompt.txt" } }] } },
      ],
    };
    const frames = [];
    for await (const frame of codexSession(req, { model: "gpt-5.6-luna" })) frames.push(frame);
    const additional = requestBody.input.find((item) => item.type === "additional_tools");
    assert.equal(additional.tools[0].type, "custom");
    assert.equal(requestBody.input.find((item) => item.type === "custom_tool_call").input, "click(1, 2)");
    const toolOutput = requestBody.input.find((item) => item.type === "custom_tool_call_output");
    assert.ok(toolOutput.output.some((item) => item.type === "input_file" && item.filename === "notes.txt"));
    const user = requestBody.input.find((item) => item.role === "user");
    assert.ok(user.content.some((item) => item.type === "input_file" && item.filename === "prompt.txt"));
    const decoded = decodeFrames(frames);
    assert.equal(decoded.find((frame) => frame.toolCallPart)?.toolCallPart.args, "click(10, 20)");
  });

  await t.test("cancels a live upstream stream", async () => {
    setupCredential();
    const abortController = new AbortController();
    globalThis.fetch = async (url, options = {}) => {
      if (String(url).endsWith("/models")) return Response.json({ models: [{ slug: "gpt-5.6-luna", visibility: "list" }] });
      return new Response(new ReadableStream({ start(controller) {
        options.signal.addEventListener("abort", () => controller.error(new Error("aborted")), { once: true });
        setTimeout(() => abortController.abort(), 10);
      } }));
    };
    const frames = [];
    for await (const frame of codexSession({ modelId: "GPT-5.6-Luna (Codex)", messages: [], tools: [] }, { model: "gpt-5.6-luna" }, { signal: abortController.signal })) frames.push(frame);
    assert.equal(frames.length, 0);
  });
});

test("unsupported models fail closed and log summaries contain no prompt text", () => {
  const strict = { default: "m", models: { m: { provider: "codex-oauth", model: "gpt-5.6-luna" } }, aliases: { a: "m" } };
  assert.throws(() => resolveModel({ modelId: "not-a-configured-model" }, strict), /unsupported model/);
  assert.throws(() => resolveModel({ modelId: "toString" }, strict), /unsupported model/);
  assert.throws(() => resolveModel({ modelId: "x" }, { ...strict, aliases: { x: "missing" } }), /unsupported model/);
  assert.throws(() => resolveModel({ modelId: "x" }, { ...strict, fallback: "missing" }), /unsupported model/);
  assert.equal(resolveModel({ modelId: "grok-9" }, { ...strict, fallback: "m" }).entry.model, "gpt-5.6-luna");
  assert.doesNotMatch(requestSummary({ modelId: "model", tools: [], messages: [{ role: 1, text: "private prompt" }] }), /private prompt/);
});

test("the desktop's built-in model ids run on the default, GPT-6 Luna High", () => {
  // The app picks its own ids (grok-4.5 for chat, another for its computer-use
  // subagent, new ones in newer versions); all of them use the default unless
  // the Bot has its own choice.
  for (const id of ["grok-4.5", "grok-4.5-medium", "claude-opus-4-8", "grok-99"]) {
    const { entry } = resolveModel({ modelId: id });
    assert.equal(entry.model, "gpt-6-luna", id);
    assert.equal(entry.reasoning_effort, "high", id);
  }
  for (const id of ["claude-opus-4-8", "grok-99"]) {
    const { entry } = resolveModel({ modelId: id });
    assert.equal(entry.provider, "codex-oauth", id);
    assert.match(entry.model, /^gpt-/, id);
  }
});

test("models.json only configures Codex models", async () => {
  const cfg = JSON.parse((await import("node:fs")).readFileSync(new URL("../models.json", import.meta.url), "utf8"));
  for (const [name, entry] of Object.entries(cfg.models)) assert.equal(entry.provider, "codex-oauth", name);
  for (const target of [...Object.values(cfg.aliases ?? {}), cfg.fallback, cfg.default]) assert.ok(Object.hasOwn(cfg.models, target), target);
  assert.doesNotMatch(JSON.stringify(cfg), /claude|anthropic/i);
});

test("account model catalog and reasoning effort are validated before inference", async (t) => {
  await t.test("account does not have configured model", async () => {
    setupCredential();
    const urls = [];
    globalThis.fetch = async (url) => { urls.push(String(url)); return Response.json({ models: [] }); };
    const frames = [];
    for await (const frame of codexSession({ modelId: "GPT-5.6-Luna (Codex)", messages: [], tools: [] }, { model: "gpt-5.6-luna" })) frames.push(frame);
    assert.equal(urls.length, 1);
    assert.ok(decodeFrames(frames).some((frame) => frame.error?.message.includes("not available to this ChatGPT account")));
  });
  await t.test("unsupported effort fails before POST /responses", async () => {
    setupCredential();
    const urls = [];
    globalThis.fetch = async (url) => {
      urls.push(String(url));
      return Response.json({ models: [{ slug: "gpt-5.6-luna", visibility: "list" }] });
    };
    const frames = [];
    for await (const frame of codexSession({ modelId: "GPT-5.6-Luna (Codex)", messages: [], tools: [] }, { model: "gpt-5.6-luna", reasoning_effort: "extreme" })) frames.push(frame);
    assert.equal(urls.length, 1);
    assert.ok(decodeFrames(frames).some((frame) => frame.error?.message.includes("unsupported reasoning effort")));
  });
});

test("Connect protobuf envelopes preserve complete frames and ignore truncated tails", () => {
  const request = StreamRequest.encode({ modelId: "GPT-5.6-Luna (Codex)", messages: [{ role: 1, text: "hello" }] }).finish();
  const requestFrame = envelope(Buffer.from(request));
  const parsed = parseConnectFrames(Buffer.concat([requestFrame, CONNECT_END_FRAME, Buffer.from([0, 0, 0])]));
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].flags, 0);
  assert.equal(StreamRequest.decode(parsed[0].payload).modelId, "GPT-5.6-Luna (Codex)");
  assert.equal(parsed[1].flags, 2);
  assert.equal(parsed[1].payload.toString(), "{}");
  assert.equal(parseConnectFrames(frameBytes(0, Buffer.from("partial")).subarray(0, 6)).length, 0);
});

test("official ChatGPT authorization validates PKCE callback and ID-token signature before storing", async () => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), "grokbot-auth-test-"));
  delete process.env.CODEX_AUTH_FILE;
  process.env.CODEX_HOME = temp;
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "key-test", alg: "RS256" };
  const oldFetch = globalThis.fetch;
  let exchanged;
  let authCount = 0;
  const accessToken = token();
  globalThis.fetch = async (url, options = {}) => {
    const address = String(url);
    if (address.endsWith("/.well-known/openid-configuration")) return Response.json({ jwks_uri: "https://auth.openai.com/jwks" });
    if (address.endsWith("/jwks")) return Response.json({ keys: [jwk] });
    if (address.endsWith("/api/accounts/oauth/token")) {
      exchanged = new URLSearchParams(options.body);
      return Response.json({ access_token: accessToken, refresh_token: "refresh-secret", id_token: makeIdToken(exchanged.get("client_id"), nonceFromAuth, privateKey), scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct", expires_in: 3600 });
    }
    throw new Error(`unexpected URL ${address}`);
  };
  let nonceFromAuth;
  function makeIdToken(clientId, nonce, key) {
    const head = Buffer.from(JSON.stringify({ alg: "RS256", kid: "key-test" })).toString("base64url");
    const claims = { iss: "https://auth.openai.com", aud: clientId, exp: Math.floor(Date.now() / 1000) + 3600, nonce, sub: "subject-test", email: "user@example.com" };
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const data = `${head}.${payload}`;
    return `${data}.${crypto.sign("RSA-SHA256", Buffer.from(data), key).toString("base64url")}`;
  }
  async function visitCallback(url) {
    await new Promise((resolve, reject) => http.get(url, (response) => {
      response.resume();
      response.on("end", resolve);
      response.on("error", reject);
    }).on("error", reject));
  }
  const logged = [];
  const oldLog = console.log;
  console.log = (message) => logged.push(String(message));
  const open = async (authorizationUrl) => {
    const auth = new URL(authorizationUrl);
    assert.equal(auth.origin, "https://auth.openai.com");
    assert.equal(auth.searchParams.get("code_challenge_method"), "S256");
    assert.ok(auth.searchParams.get("scope").includes("chatgpt.tokens.use.direct"));
    nonceFromAuth = auth.searchParams.get("nonce");
    if (authCount++ === 0) {
      assert.equal(auth.searchParams.get("client_id"), "dynamic_agent_client");
      assert.equal(auth.searchParams.get("agent_name_hint"), "Grok Bot");
    } else {
      assert.equal(auth.searchParams.get("client_id"), "oaiapp-issued-client");
      assert.equal(auth.searchParams.has("id_token_hint"), false);
      assert.equal(auth.searchParams.has("agent_name_hint"), false);
    }
    const callback = new URL("http://127.0.0.1:1455/auth/callback");
    callback.searchParams.set("state", auth.searchParams.get("state"));
    callback.searchParams.set("code", "authorization-code-secret");
    if (authCount === 1) callback.searchParams.set("client_id", "oaiapp-issued-client");
    await visitCallback(callback);
  };
  try {
    await authorizeChatGPT({ open });
    const savedPath = path.join(temp, "grokbot-shim", "auth.json");
    const firstSaved = JSON.parse(fs.readFileSync(savedPath, "utf8"));
    assert.equal(exchanged.get("client_id"), "oaiapp-issued-client");
    assert.ok(exchanged.get("code_verifier"));
    assert.equal(exchanged.get("resource"), "https://api.openai.com/v1");
    assert.ok(firstSaved.scopes.includes("chatgpt.tokens.use.direct"));
    assert.equal(firstSaved.subject, "subject-test");
    assert.match(firstSaved.ext_agent_host_id, /^urn:uuid:/);
    await authorizeChatGPT({ open });
    const saved = JSON.parse(fs.readFileSync(savedPath, "utf8"));
    assert.equal(saved.client_id, firstSaved.client_id);
    assert.equal(saved.ext_agent_host_id, firstSaved.ext_agent_host_id);
    assert.equal(JSON.stringify(logged).includes(accessToken), false);
    assert.equal(JSON.stringify(logged).includes("refresh-secret"), false);
    assert.equal(JSON.stringify(logged).includes("authorization-code-secret"), false);
    assert.deepEqual(await resolveCredential().then(({ accessToken: value }) => value), accessToken);
  } finally {
    globalThis.fetch = oldFetch;
    console.log = oldLog;
  }
});
