import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import protobuf from "protobufjs";
import { BotModels, COMMAND_CALL_PREFIX, botIdsOf, choiceFor, isCommandFollowUp, modelCommandOf, runModelCommand } from "./bot-models.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const root = protobuf.loadSync(path.join(ROOT, "shim", "inference.proto"));
const StreamRequest = root.lookupType("aiserver.v1.InferenceStreamRequest");
const StreamResponse = root.lookupType("aiserver.v1.InferenceStreamResponse");

export function decodeStreamRequest(buf) {
  return StreamRequest.decode(buf);
}

function frame(oneofField, payload) {
  return StreamResponse.encode(StreamResponse.create({ [oneofField]: payload })).finish();
}

export const frames = {
  text: (text, isFinal = false) => frame("textPart", { text, isFinal }),
  thinking: (text, isFinal = false) => frame("thinkingPart", { text, isFinal }),
  toolCall: (p) => frame("toolCallPart", p),
  usage: (promptTokens, completionTokens) =>
    frame("usage", { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens }),
  responseInfo: (model, id, { content = "", toolCalls = [], reasoningParts = [] } = {}) =>
    frame("responseInfo", {
      id: id ?? `shim-${Date.now()}`,
      model,
      createdAt: Date.now(),
      messages: [
        {
          id: `shim-msg-${Date.now()}`,
          role: 2,
          content,
          toolCalls: toolCalls.map((tc) => ({
            toolCallId: tc.id,
            toolName: tc.name,
            rawToolCallArgs: typeof tc.args === "string" ? tc.args : JSON.stringify(tc.args ?? {}),
          })),
          reasoningParts,
        },
      ],
    }),
  error: (message, errorType = 1) => frame("error", { message, errorType }),
};

function messageText(m) {
  if (m.content === "text") return m.text ?? "";
  if (m.content === "parts") {
    return (m.parts.parts ?? [])
      .map((p) => (p.part === "text" ? p.text?.text ?? "" : ""))
      .join("");
  }
  return "";
}

function lastUserText(req) {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    if (req.messages[i].role === 1) return messageText(req.messages[i]);
  }
  return "";
}

export function requestSummary(req) {
  const modelId = String(req.modelId || req.requestedModel?.modelId || "?").replace(/[\r\n\0]/g, "").slice(0, 80);
  const id = (s) => String(s || "-").replace(/[^A-Za-z0-9-]/g, "").slice(0, 48);
  return `model=${modelId} tools=${req.tools?.length ?? 0} msgs=${req.messages?.length ?? 0} conv=${id(req.conversationId)} group=${id(req.conversationGroupId)}`;
}

function loadModelsConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, "models.json"), "utf8"));
  } catch {
    return { default: "canned", models: { canned: { provider: "canned" } } };
  }
}

// A Bot's own choice (state/bot-models.json, set with "/model") wins.
// Otherwise: the desktop asks for its built-in model ids (e.g. "grok-4.5", or
// "claude-opus-4-8" for computer use) whatever the model list says, so
// models.json maps those through "aliases". New app versions bring new ids;
// "fallback", when set, names the configured model that any other id uses.
// Without it, ids that are neither a model nor an alias fail closed.
const fallbackLogged = new Set();
export function resolveModel(req, cfg = loadModelsConfig(), botModels = null) {
  const chosen = botModels ? choiceFor(req, botModels, cfg) : undefined;
  if (chosen !== undefined) return { wanted: chosen, entry: cfg.models[chosen] };
  const wanted = req.modelId || req.requestedModel?.modelId || cfg.default;
  let target = Object.hasOwn(cfg.models, wanted) ? wanted : cfg.aliases && Object.hasOwn(cfg.aliases, wanted) ? cfg.aliases[wanted] : undefined;
  if (target === undefined && typeof cfg.fallback === "string") {
    target = cfg.fallback;
    if (!fallbackLogged.has(wanted)) {
      fallbackLogged.add(wanted);
      console.log(`[models] no alias for ${String(wanted).slice(0, 80)}; using fallback ${target}`);
    }
  }
  const entry = target === undefined || !Object.hasOwn(cfg.models, target) ? undefined : cfg.models[target];
  if (!entry) throw new Error(`unsupported model: ${wanted}`);
  return { wanted, entry };
}

export function resolveEntry(id) {
  return loadModelsConfig().models[id];
}

async function* replyText(reply, model) {
  yield frames.text(reply);
  yield frames.text("", true);
  yield frames.usage(1, Math.max(1, Math.floor(reply.length / 4)));
  yield frames.responseInfo(model, undefined, { content: reply });
}

// Bot turns only deliver what goes through the SendMessage tool; plain text is
// dropped. Requests without that tool get plain text.
async function* commandReply(req, reply, model) {
  if (!req.tools?.some((t) => t.name === "SendMessage")) {
    yield* replyText(reply, model);
    return;
  }
  const id = `${COMMAND_CALL_PREFIX}${Date.now()}`;
  const args = JSON.stringify({ type: "text", content: reply });
  yield frames.toolCall({ toolCallId: id, toolName: "SendMessage", args, isComplete: true, toolIndex: 0 });
  yield frames.usage(1, Math.max(1, Math.floor(reply.length / 4)));
  yield frames.responseInfo(model, undefined, { toolCalls: [{ id, name: "SendMessage", args }] });
}

async function* cannedSession(req) {
  const user = lastUserText(req);
  const reply = `Hello from grokbot-shim! You said: "${user.slice(0, 200)}". Model routing is working — swap me out in models.json.`;
  const words = reply.split(" ");
  for (let i = 0; i < words.length; i++) {
    yield frames.text((i === 0 ? "" : " ") + words[i]);
    await new Promise((r) => setTimeout(r, 25));
  }
  yield frames.text("", true);
  yield frames.usage(Math.max(1, Math.floor(user.length / 4)), Math.max(1, Math.floor(reply.length / 4)));
  const { wanted } = resolveModel(req);
  yield frames.responseInfo(wanted, undefined, { content: reply });
}

export async function* runEntry(req, entry, options = {}) {
  if (entry.provider === "codex-oauth") {
    const { codexSession } = await import("./codex-oauth.mjs");
    yield* codexSession(req, entry, options);
  } else if (entry.provider === "canned") {
    yield* cannedSession(req);
  } else {
    yield frames.error(`shim: unsupported provider: ${entry.provider ?? "(unset)"}`, 1);
  }
}

const defaultBotModels = new BotModels();

export async function* runSession(req, options = {}) {
  try {
    const cfg = loadModelsConfig();
    const botModels = options.botModels ?? defaultBotModels;
    // "/model ..." in a Bot's chat is answered here and never reaches a model.
    const command = modelCommandOf(req, messageText);
    if (command !== null) {
      const [botId] = botIdsOf(req);
      const reply = runModelCommand(command, { botId, botModels, cfg });
      console.log(`[models] !model for bot ${String(botId ?? "?").slice(0, 36)}: ${choiceFor(req, botModels, cfg) ?? `default ${cfg.default}`}`);
      yield* commandReply(req, reply, choiceFor(req, botModels, cfg) ?? cfg.default);
      return;
    }
    if (isCommandFollowUp(req)) {
      yield* replyText("", cfg.default);
      return;
    }
    const { entry } = resolveModel(req, cfg, botModels);
    if (options.onModel) options.onModel(`${entry.model ?? entry.provider} effort=${entry.reasoning_effort ?? "-"}`);
    yield* runEntry(req, entry, options);
  } catch (err) {
    yield frames.error(`shim: ${err?.message ?? err}`, 1);
  }
}
