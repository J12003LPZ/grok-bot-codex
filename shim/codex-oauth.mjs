// ChatGPT plan provider: uses the documented Sign in with ChatGPT Responses API.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { frames } from "./inference.mjs";
import { structToJson, valueToJson } from "./struct.mjs";

const OAUTH_TOKEN_URL = "https://auth.openai.com/api/accounts/oauth/token";
const BASE_URL = "https://api.openai.com/v1";
const RESOURCE = "https://api.openai.com/v1";
const REQUEST_TIMEOUT_MS = Number(process.env.CODEX_TIMEOUT_MS ?? 600_000);
const REFRESH_SKEW_SEC = Number(process.env.CODEX_REFRESH_SKEW_SECONDS ?? 120);

// Sand's InferenceStreamErrorType.
const ERR = { unknown: 1, inputTokenLimit: 2, rateLimit: 4, auth: 5, permission: 6, overloaded: 7 };
const modelCatalogCache = new Map();
const refreshJobs = new Map();

function authFile() {
  const home = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  const cliAuth = path.join(path.resolve(home), "auth.json");
  const file = process.env.CODEX_AUTH_FILE
    ? path.resolve(process.env.CODEX_AUTH_FILE)
    : path.join(path.resolve(home), "grokbot-shim", "auth.json");
  const canonical = (candidate) => {
    try { candidate = fs.realpathSync(candidate); } catch { /* file may not exist yet */ }
    return process.platform === "win32" ? path.resolve(candidate).toLowerCase() : path.resolve(candidate);
  };
  if (canonical(file) === canonical(cliAuth)) throw new Error("CODEX_AUTH_FILE must not point to Codex CLI auth.json; use npm run auth to create the separate Grok Bot grant");
  return file;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

function writeJsonPrivate(file, payload) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(path.dirname(file), 0o700);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, file);
}

function jwtPayload(token) {
  if (typeof token !== "string") return undefined;
  const parts = token.split(".");
  if (parts.length < 2) return undefined;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
}

function tokenExpiry(token) {
  const exp = jwtPayload(token)?.exp;
  return typeof exp === "number" ? exp : undefined;
}

async function refreshAuthorizedTokens(refreshToken, clientId) {
  const resp = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      resource: RESOURCE,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await resp.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = {};
  }
  if (!resp.ok || typeof payload.access_token !== "string") {
    const code = payload?.error ?? `HTTP ${resp.status}`;
    throw new Error(`token refresh failed (${String(code).slice(0, 120)}); run npm run auth to reauthorize`);
  }
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token || refreshToken,
    idToken: payload.id_token,
  };
}

async function serializedRefresh(file) {
  const absolutePath = path.resolve(file);
  const key = process.platform === "win32" ? absolutePath.toLowerCase() : absolutePath;
  if (refreshJobs.has(key)) return refreshJobs.get(key);
  const job = (async () => {
    const lockFile = `${file}.refresh.lock`;
    const deadline = Date.now() + 25_000;
    let lock;
    while (!lock) {
      try {
        lock = fs.openSync(lockFile, "wx", 0o600);
        fs.writeSync(lock, `${process.pid} ${Date.now()}\n`);
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        try {
          if (Date.now() - fs.statSync(lockFile).mtimeMs > 90_000) fs.unlinkSync(lockFile);
        } catch (statError) {
          if (statError?.code !== "ENOENT") throw statError;
        }
        if (Date.now() >= deadline) throw new Error("timed out waiting for another process to refresh the ChatGPT token");
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    try {
      const payload = readJson(file);
      const tokens = payload?.tokens ?? payload;
      const accessToken = tokens?.access_token;
      const scopes = new Set((Array.isArray(tokens?.scopes ?? payload?.scopes)
        ? (tokens?.scopes ?? payload?.scopes).join(" ")
        : (tokens?.scope ?? payload?.scope ?? jwtPayload(accessToken)?.scope ?? "")).split(/\s+/).filter(Boolean));
      if (!scopes.has("chatgpt.tokens.use.direct")) throw new Error("the ChatGPT plan authorization was changed; run npm run auth");
      if (tokenExpiry(accessToken) > Math.floor(Date.now() / 1000) + REFRESH_SKEW_SEC) return accessToken;
      const refreshToken = tokens?.refresh_token;
      const clientId = tokens?.client_id ?? payload?.client_id;
      if (!refreshToken || !clientId) throw new Error("the ChatGPT plan token cannot be refreshed; run npm run auth");
      const refreshed = await refreshAuthorizedTokens(refreshToken, clientId);
      writeJsonPrivate(file, {
        ...payload,
        ...(payload.tokens ? { tokens: {
          ...payload.tokens,
          access_token: refreshed.accessToken,
          refresh_token: refreshed.refreshToken,
          ...(refreshed.idToken ? { id_token: refreshed.idToken } : {}),
          last_refresh: new Date().toISOString(),
        } } : {
          access_token: refreshed.accessToken,
          refresh_token: refreshed.refreshToken,
          client_id: clientId,
          ...(refreshed.idToken ? { id_token: refreshed.idToken } : {}),
          last_refresh: new Date().toISOString(),
        }),
      });
      return refreshed.accessToken;
    } finally {
      try { fs.closeSync(lock); } catch { /* already closed */ }
      try { fs.unlinkSync(lockFile); } catch { /* another owner replaced a stale lock */ }
    }
  })();
  refreshJobs.set(key, job);
  try { return await job; }
  finally { if (refreshJobs.get(key) === job) refreshJobs.delete(key); }
}

// Reads the shim's separate SIWC credential store; never edits Codex CLI auth.json.
export async function resolveCredential() {
  const fromEnv = process.env.CODEX_ACCESS_TOKEN?.trim();
  if (fromEnv) {
    const claims = jwtPayload(fromEnv);
    const scopes = new Set(String(claims?.scope ?? "").split(/\s+/).filter(Boolean));
    if (!scopes.has("chatgpt.tokens.use.direct")) {
      throw new Error("CODEX_ACCESS_TOKEN is not authorized for direct ChatGPT plan use (missing chatgpt.tokens.use.direct)");
    }
    const exp = tokenExpiry(fromEnv);
    if (exp === undefined || exp <= Math.floor(Date.now() / 1000) + REFRESH_SKEW_SEC) {
      throw new Error("CODEX_ACCESS_TOKEN is expired or expiring; refresh the authorized ChatGPT plan token");
    }
    return { accessToken: fromEnv, source: "CODEX_ACCESS_TOKEN" };
  }

  const file = authFile();
  const payload = readJson(file);
  const tokens = payload?.tokens ?? payload;
  const accessToken = tokens?.access_token?.trim();
  const refreshToken = tokens?.refresh_token?.trim();
  if (!accessToken) {
    throw new Error(`no ChatGPT plan authorization in ${file} — run \`npm run auth\``);
  }
  const claims = jwtPayload(accessToken);
  const savedScopes = tokens?.scopes ?? payload?.scopes;
  const scopeValue = Array.isArray(savedScopes) ? savedScopes.join(" ") : (savedScopes ?? tokens?.scope ?? payload?.scope ?? claims?.scope ?? "");
  const scopes = new Set(String(scopeValue).split(/\s+/).filter(Boolean));
  if (!scopes.has("chatgpt.tokens.use.direct")) {
    throw new Error(
      "the saved token is not authorized for direct ChatGPT plan use (missing chatgpt.tokens.use.direct); a codex login token cannot be reused for this endpoint; run `npm run auth` to authorize grokbot-shim",
    );
  }
  const clientId = tokens?.client_id ?? payload?.client_id;
  const exp = tokenExpiry(accessToken);
  if (exp === undefined) throw new Error("the ChatGPT plan access token has no valid expiry; run `npm run auth` to reauthorize");
  if (exp > Math.floor(Date.now() / 1000) + REFRESH_SKEW_SEC) return { accessToken, source: file };
  if (!refreshToken || !clientId) {
    throw new Error("the ChatGPT plan token cannot be refreshed; run `npm run auth` to reauthorize");
  }

  return { accessToken: await serializedRefresh(file), source: `${file} (refreshed)` };
}

function textOf(message) {
  if (message.content === "text") return message.text ?? "";
  if (message.content === "parts") {
    return (message.parts?.parts ?? [])
      .map((p) => (p.part === "text" ? p.text?.text ?? "" : ""))
      .join("");
  }
  return "";
}

function userParts(message) {
  if (message.content === "text") {
    return message.text ? [{ type: "input_text", text: message.text }] : [];
  }
  const out = [];
  for (const part of message.parts?.parts ?? []) {
    if (part.part === "text" && part.text?.text) {
      out.push({ type: "input_text", text: part.text.text });
    } else if (part.part === "image" && part.image?.data) {
      const data = part.image.data;
      out.push({
        type: "input_image",
        image_url: /^(https?|data):/.test(data)
          ? data
          : `data:${part.image.mimeType || "image/png"};base64,${data}`,
      });
    } else if (part.part === "file" && part.file?.data) {
      out.push(fileContentItem(part.file));
    }
  }
  return out;
}

function imageContentItem(part) {
  if (part?.part !== "image" || !part.image?.data) return undefined;
  const data = part.image.data;
  return {
    type: "input_image",
    image_url: /^(https?|data):/.test(data)
      ? data
      : `data:${part.image.mimeType || "image/png"};base64,${data}`,
    detail: "high",
  };
}

function fileContentItem(file) {
  const data = file.data;
  return {
    type: "input_file",
    file_data: /^(https?|data):/.test(data)
      ? data
      : `data:${file.mediaType || "application/octet-stream"};base64,${data}`,
    ...(file.filename ? { filename: file.filename } : {}),
  };
}

function toolResultOutput(part) {
  const value = valueToJson(part.result);
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
  const outputText = part.isError ? `ERROR: ${text}` : text;
  const rich = [];
  if (outputText) rich.push({ type: "input_text", text: outputText });
  for (const contentPart of part.experimentalContent ?? []) {
    const image = imageContentItem(contentPart);
    if (image) rich.push(image);
    if (contentPart?.part === "file" && contentPart.file?.data) rich.push(fileContentItem(contentPart.file));
  }
  // Responses accepts either a plain string or multimodal content items for a
  // function_call_output. Computer screenshots arrive in experimentalContent;
  // keeping them attached to the tool result is what lets the model actually
  // see the desktop it just controlled.
  return rich.some((item) => item.type === "input_image" || item.type === "input_file") ? rich : outputText;
}

// Sand keeps reasoning in `reasoning_parts`; we stash the Codex item id +
// encrypted_content in `signature` so the model's own chain of thought survives
// the round trip (required when store=false).
function reasoningItemFrom(part) {
  if (!part?.signature) return undefined;
  try {
    const stashed = JSON.parse(part.signature);
    if (stashed?.__codex !== 1 || !stashed.encrypted_content) return undefined;
    return {
      type: "reasoning",
      id: stashed.id,
      encrypted_content: stashed.encrypted_content,
      summary: part.text ? [{ type: "summary_text", text: part.text }] : [],
    };
  } catch {
    return undefined;
  }
}

function buildRequestBody(req, entry, { withReasoningHistory }) {
  const instructions = [];
  const input = [];
  const customTools = new Set((req.tools ?? []).filter((tool) => tool.customToolFormat).map((tool) => tool.name));

  for (const m of req.messages ?? []) {
    if (m.role === 4 || m.role === 0) {
      const text = textOf(m);
      if (text) instructions.push(text);
      continue;
    }
    if (m.role === 3) {
      for (const part of m.toolContent?.parts ?? []) {
        if (!part.toolCallId) continue;
        input.push({
          type: customTools.has(part.toolName) ? "custom_tool_call_output" : "function_call_output",
          call_id: part.toolCallId,
          output: toolResultOutput(part),
        });
      }
      continue;
    }
    if (m.role === 2) {
      if (withReasoningHistory) {
        for (const part of m.reasoningParts ?? []) {
          const item = reasoningItemFrom(part);
          if (item) input.push(item);
        }
      }
      const text = textOf(m);
      if (text) input.push({ role: "assistant", content: [{ type: "output_text", text }] });
      for (const call of m.toolCalls ?? []) {
        if (!call.toolCallId || !call.toolName) continue;
        input.push(customTools.has(call.toolName) ? {
          type: "custom_tool_call",
          call_id: call.toolCallId,
          name: call.toolName,
          input: call.rawToolCallArgs || "",
        } : {
          type: "function_call",
          call_id: call.toolCallId,
          name: call.toolName,
          arguments: call.rawToolCallArgs || JSON.stringify(structToJson(call.args) ?? {}),
        });
      }
      continue;
    }
    const parts = userParts(m);
    if (parts.length) input.push({ role: "user", content: parts });
  }

  if (!input.length) input.push({ role: "user", content: [{ type: "input_text", text: "" }] });

  const tools = (req.tools ?? [])
    .filter((t) => t.name)
    .map((t) => t.customToolFormat ? ({
      type: "custom",
      name: t.name,
      description: t.description ?? "",
      format: t.customToolFormat.type === "grammar" ? {
        type: "grammar",
        syntax: t.customToolFormat.syntax || "lark",
        definition: t.customToolFormat.definition ?? "",
      } : { type: "text" },
    }) : ({
      type: "function",
      name: t.name,
      description: t.description ?? "",
      strict: false,
      parameters: structToJson(t.parameters) ?? { type: "object", properties: {} },
    }));
  const body = {
    model: entry.model,
    instructions: instructions.join("\n\n") || "You are a helpful assistant.",
    input,
    stream: true,
    store: false,
  };

  if (tools.length) {
    // ChatGPT plan usage currently accepts client-side function tools through
    // developer-role additional_tools items. Top-level tools can be rejected
    // by this route's capability gate.
    input.unshift({ type: "additional_tools", role: "developer", tools });
    body.tool_choice = "auto";
    body.parallel_tool_calls = true;
  }

  if (typeof body.model !== "string" || !body.model) throw new Error("Codex model configuration is missing its model ID");

  const configuredEffort = String(entry.reasoning_effort ?? process.env.CODEX_REASONING_EFFORT ?? "medium").trim().toLowerCase();
  const effort = configuredEffort === "minimal" ? "low" : configuredEffort;
  if (effort && effort !== "none") {
    if (!["low", "medium", "high", "xhigh", "max"].includes(effort)) {
      throw new Error(`unsupported reasoning effort: ${configuredEffort}`);
    }
    body.reasoning = { effort, summary: "auto" };
    body.include = ["reasoning.encrypted_content"];
  }

  return body;
}

async function* sseFrames(webStream) {
  const reader = webStream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n?/g, "\n");
      let idx;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const data = chunk.split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n").trim();
        if (!data || data === "[DONE]") continue;
        yield JSON.parse(data);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function errorTypeFor(status, message) {
  if (/subscription_sharing_usage_limit_exceeded|subscription_sharing_usage_unavailable/i.test(message)) return ERR.rateLimit;
  if (/subscription_sharing_user_not_eligible|subscription_sharing_route_not_supported|subscription_sharing_unsupported_capability/i.test(message)) return ERR.permission;
  if (status === 401) return ERR.auth;
  if (status === 403) return ERR.permission;
  if (status === 429) return ERR.rateLimit;
  if (status === 500 || status === 502 || status === 503) return ERR.overloaded;
  if (/context|too long|maximum.*tokens/i.test(message)) return ERR.inputTokenLimit;
  return ERR.unknown;
}

function upstreamMessage(status, text, headers) {
  let message;
  let payload;
  try {
    payload = JSON.parse(text);
    message = String(payload?.error?.message ?? payload?.error?.code ?? payload?.error?.type ?? payload?.detail ?? payload?.error ?? text);
  } catch {
    message = text || `HTTP ${status}`;
  }
  const code = payload?.error?.code;
  if (code && !message.includes(code)) message = `${code}: ${message}`;
  const requestId = headers?.get?.("x-request-id");
  if (requestId) message += ` (request ${requestId})`;
  return message.slice(0, 600);
}

async function ensureModelAvailable(model, accessToken, signal) {
  const cacheKey = crypto.createHash("sha256").update(accessToken).digest("hex");
  let cached = modelCatalogCache.get(cacheKey);
  if (!cached || cached.expiresAt <= Date.now()) {
    const response = await fetch(`${BASE_URL}/models`, {
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      throw new Error(`model catalog ${response.status}: ${upstreamMessage(response.status, await response.text().catch(() => ""), response.headers)}`);
    }
    const payload = await response.json();
    const rows = payload.models ?? payload.data ?? [];
    cached = new Set(rows.filter((row) => row.visibility === undefined || row.visibility === "list").map((row) => row.slug ?? row.id).filter(Boolean));
    for (const [key, value] of modelCatalogCache) if (value.expiresAt <= Date.now()) modelCatalogCache.delete(key);
    modelCatalogCache.set(cacheKey, { models: cached, expiresAt: Date.now() + 5 * 60_000 });
  } else {
    cached = cached.models;
  }
  if (!cached.has(model)) throw new Error(`model ${model} is not available to this ChatGPT account`);
}

async function postResponses(req, entry, accessToken, signal) {
  const attempt = async (withReasoningHistory) => {
    const body = buildRequestBody(req, entry, { withReasoningHistory });
    const resp = await fetch(`${BASE_URL}/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "text/event-stream",
        "content-type": "application/json",
        "user-agent": "grokbot-shim/1.0.0",
        "x-client-request-id": crypto.randomUUID(),
      },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return { resp, model: body.model };
  };

  let { resp, model } = await attempt(true);
  if (resp.status === 400) {
    const text = await resp.text();
    if (/reasoning/i.test(text)) {
      console.warn("[codex] backend rejected reasoning history; retrying this request without it");
      ({ resp, model } = await attempt(false));
    } else {
      return { resp, model, errorText: text };
    }
  }
  return { resp, model };
}

export async function* codexSession(req, entry, { signal } = {}) {
  let credential;
  try {
    credential = await resolveCredential();
    await ensureModelAvailable(entry.model, credential.accessToken, signal);
  } catch (err) {
    const message = String(err?.message ?? err);
    yield frames.error(`shim: ${message}`, /model catalog 401|model catalog 403|not available/.test(message) ? ERR.permission : ERR.auth);
    return;
  }

  let resp;
  let model;
  let errorText;
  try {
    ({ resp, model, errorText } = await postResponses(req, entry, credential.accessToken, signal));
  } catch (err) {
    yield frames.error(`shim: Codex request failed: ${err?.message ?? err}`, ERR.unknown);
    return;
  }

  if (!resp.ok || !resp.body) {
    const text = errorText ?? (await resp.text().catch(() => ""));
    const message = upstreamMessage(resp.status, text, resp.headers);
    yield frames.error(`shim: Codex ${resp.status}: ${message}`, errorTypeFor(resp.status, message));
    return;
  }

  let fullText = "";
  let usage;
  const toolCalls = [];
  const reasoningParts = [];
  const customToolNames = new Set((req.tools ?? []).filter((tool) => tool.customToolFormat).map((tool) => tool.name));
  let completed = false;
  let streamFailure;

  try {
    for await (const event of sseFrames(resp.body)) {
    const type = event.type;

    if (type === "response.output_text.delta") {
      if (typeof event.delta === "string" && event.delta) {
        fullText += event.delta;
        yield frames.text(event.delta);
      }
      continue;
    }

    if (type === "response.reasoning_summary_text.delta") {
      if (typeof event.delta === "string" && event.delta) yield frames.thinking(event.delta);
      continue;
    }

    if (type === "response.reasoning_summary_part.done" || type === "response.reasoning_summary_text.done") {
      yield frames.thinking("", true);
      continue;
    }

    if (type === "response.output_item.done") {
      const item = event.item;
      if ((item?.type === "function_call" || item?.type === "custom_tool_call") && item.name) {
        const id = item.call_id || item.id || `codex-tc-${toolCalls.length}`;
        const isCustom = item.type === "custom_tool_call" || customToolNames.has(item.name);
        const args = isCustom
          ? String(item.input ?? "")
          : typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {});
        if (!isCustom) {
          try {
            const parsed = JSON.parse(args || "{}");
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("expected object");
          } catch {
            yield frames.error(`shim: Codex returned malformed arguments for tool ${item.name}`, ERR.unknown);
            return;
          }
        }
        toolCalls.push({ id, name: item.name, args });
        yield frames.toolCall({
          toolCallId: id,
          toolName: item.name,
          args,
          isComplete: true,
          toolIndex: toolCalls.length - 1,
        });
      } else if (item?.type === "reasoning") {
        const summary = (item.summary ?? []).map((s) => s?.text ?? "").join("");
        reasoningParts.push({
          text: summary,
          signature: item.encrypted_content
            ? JSON.stringify({ __codex: 1, id: item.id, encrypted_content: item.encrypted_content })
            : "",
          modelName: model,
        });
      }
      continue;
    }

    if (type === "response.completed") {
      usage = event.response?.usage ?? usage;
      completed = true;
      break;
    }

    if (type === "response.incomplete") {
      const reason = event.response?.incomplete_details?.reason ?? "unknown reason";
      yield frames.error(`shim: Codex response incomplete (${reason})`, errorTypeFor(200, reason));
      return;
    }

    if (type === "response.failed" || type === "error") {
      const message = upstreamMessage(200, JSON.stringify(event.response?.error ?? event.error ?? event));
      yield frames.error(`shim: Codex stream failed: ${message}`, errorTypeFor(200, message));
      return;
    }
    }
  } catch (error) {
    streamFailure = error;
  }

  if (streamFailure) {
    if (signal?.aborted) return;
    yield frames.error(`shim: Codex stream disconnected: ${streamFailure?.name ?? "network error"}`, ERR.overloaded);
    return;
  }

  if (!completed) {
    yield frames.error("shim: Codex stream ended before response.completed", ERR.unknown);
    return;
  }

  yield frames.text("", true);
  yield frames.usage(
    Math.max(1, usage?.input_tokens ?? 0),
    Math.max(1, usage?.output_tokens ?? Math.ceil(fullText.length / 4)),
  );
  yield frames.responseInfo(model, undefined, { content: fullText, toolCalls, reasoningParts });
}
