import fs from "node:fs";
import path from "node:path";
import { STATE_DIR } from "./secrets.mjs";

// Which models.json entry each Bot uses, keyed by the Bot's conversation id
// (the host sends it with every inference request). Bots without a choice use
// the models.json default. Chosen from inside Grok Bot with "!model".
export const BOT_MODELS_FILE = path.join(STATE_DIR, "bot-models.json");

export class BotModels {
  constructor(file = BOT_MODELS_FILE) {
    this.file = file;
    this.choices = {};
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      if (parsed && typeof parsed.choices === "object") this.choices = parsed.choices;
    } catch {
      // Missing or corrupt: every Bot uses the default.
    }
  }

  get(botId) {
    return botId && Object.hasOwn(this.choices, botId) ? this.choices[botId] : undefined;
  }

  set(botId, modelName) {
    if (modelName === undefined) delete this.choices[botId];
    else this.choices[botId] = modelName;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ choices: this.choices }), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}

// The Bot a request belongs to. Subagents (e.g. the computer-use helper) run
// under their own conversation id inside the Bot's conversation group.
export function botIdsOf(req) {
  return [req.conversationId, req.conversationGroupId].filter((id) => typeof id === "string" && id.length > 0);
}

export function choiceFor(req, botModels, cfg) {
  for (const id of botIdsOf(req)) {
    const name = botModels.get(id);
    if (name !== undefined && Object.hasOwn(cfg.models, name)) return name;
  }
  return undefined;
}

// "!model" is the one to type: Grok Bot opens its own command palette for text
// that starts with "/", and Enter there runs a palette entry instead of sending.
const COMMAND = /^\s*[!/]model\b\s*(.*?)\s*$/is;
const norm = (s) => String(s).toLowerCase().replace(/\(codex\)/g, "").replace(/[^a-z0-9.]+/g, "");

// What the user typed, out of the envelope the host wraps it in:
// <timestamp>..</timestamp><user_query>\n[t15u]\ntext\n<system_reminder>..</system_reminder></user_query>
export function userQueryOf(text) {
  const m = /<user_query>([\s\S]*)<\/user_query>/.exec(text);
  if (!m) return text;
  return m[1]
    .replace(/<system_reminder>[\s\S]*?<\/system_reminder>/g, "")
    .replace(/^\s*\[t\d+u\]\s*\n/, "")
    .trim();
}

// The argument of the last message when it is the user's own "!model ..."
// message in a Bot turn (one that offers tools), otherwise null. Side requests
// the host makes (titles, memory) carry no tools and are never commands.
export function modelCommandOf(req, messageText) {
  if (!req.tools?.length || !req.messages?.length) return null;
  const last = req.messages[req.messages.length - 1];
  if (last.role !== 1) return null;
  const m = COMMAND.exec(userQueryOf(messageText(last)));
  return m ? m[1] : null;
}

// Replies to a command are SendMessage calls with this id prefix. The host runs
// the call and comes back with its result; that follow-up ends the turn.
export const COMMAND_CALL_PREFIX = "shim-model-";

export function isCommandFollowUp(req) {
  const last = req.messages?.[req.messages.length - 1];
  if (last?.role !== 3) return false;
  const parts = last.toolContent?.parts ?? [];
  return parts.length > 0 && parts.every((p) => String(p.toolCallId ?? "").startsWith(COMMAND_CALL_PREFIX));
}

// Runs "/model", "/model <name or number>" or "/model default" for one Bot and
// returns the reply text.
export function runModelCommand(arg, { botId, botModels, cfg }) {
  const names = Object.keys(cfg.models);
  const current = botModels.get(botId) && Object.hasOwn(cfg.models, botModels.get(botId)) ? botModels.get(botId) : undefined;
  const list = () =>
    names
      .map((n, i) => `${i + 1}. ${n}${n === (current ?? cfg.default) ? "  ← this Bot" : ""}${n === cfg.default ? " (default)" : ""}`)
      .join("\n");
  if (!botId) return "This conversation has no Bot id, so its model can't be set here.";
  if (arg === "") {
    return `Model for this Bot: ${current ?? cfg.default}${current ? "" : " (default)"}\n\n${list()}\n\nSwitch with !model <number or name>, or !model default.`;
  }
  if (/^default$/i.test(arg)) {
    botModels.set(botId, undefined);
    return `This Bot now uses the default model, ${cfg.default}.`;
  }
  let picked;
  if (/^\d+$/.test(arg)) picked = names[Number(arg) - 1];
  else {
    const want = norm(arg);
    picked = names.find((n) => norm(n) === want);
    if (!picked) {
      const partial = names.filter((n) => norm(n).includes(want));
      if (partial.length === 1) [picked] = partial;
      else if (partial.length > 1) return `"${arg}" matches several models:\n${partial.join("\n")}\n\nBe more specific, or use the number from !model.`;
    }
  }
  if (!picked) return `No model called "${arg}".\n\n${list()}`;
  botModels.set(botId, picked);
  return `This Bot now uses ${picked}.`;
}
