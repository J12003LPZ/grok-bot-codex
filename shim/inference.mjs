import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import protobuf from "protobufjs";


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

function lastUserText(req) {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const m = req.messages[i];
    if (m.role !== 1) continue;
    if (m.content === "text") return m.text ?? "";
    if (m.content === "parts") {
      return (m.parts.parts ?? [])
        .map((p) => (p.part === "text" ? p.text?.text ?? "" : ""))
        .join("");
    }
  }
  return "";
}

export function requestSummary(req) {
  const modelId = String(req.modelId || req.requestedModel?.modelId || "?").replace(/[\r\n\0]/g, "").slice(0, 80);
  return `model=${modelId} tools=${req.tools?.length ?? 0} msgs=${req.messages?.length ?? 0}`;
}

function loadModelsConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, "models.json"), "utf8"));
  } catch {
    return { default: "canned", models: { canned: { provider: "canned" } } };
  }
}

// The desktop asks for its built-in model ids (e.g. "grok-4.5") whatever the
// model list says, so models.json maps those through "aliases". Ids that are
// neither a model nor an alias still fail closed.
export function resolveModel(req) {
  const cfg = loadModelsConfig();
  const wanted = req.modelId || req.requestedModel?.modelId || cfg.default;
  const target = Object.hasOwn(cfg.models, wanted) ? wanted : cfg.aliases?.[wanted];
  const entry = target === undefined || !Object.hasOwn(cfg.models, target) ? undefined : cfg.models[target];
  if (!entry) throw new Error(`unsupported model: ${wanted}`);
  return { wanted, entry };
}

export function resolveEntry(id) {
  return loadModelsConfig().models[id];
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

export async function* runSession(req, options = {}) {
  try {
    const { entry } = resolveModel(req);
    yield* runEntry(req, entry, options);
  } catch (err) {
    yield frames.error(`shim: ${err?.message ?? err}`, 1);
  }
}
