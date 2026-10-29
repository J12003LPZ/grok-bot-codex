import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { STATE_DIR } from "./secrets.mjs";

// The 0.75.8 backend stores the Bots themselves. This is the local stand-in:
// a small JSON file under state/ holding GrokBotAgent records.
export const AGENTS_FILE = path.join(STATE_DIR, "agents.json");

export function newAgent(fields = {}, now = Date.now()) {
  const id = fields.agentId || fields.id || crypto.randomUUID();
  return {
    id,
    legacyAgentId: fields.legacyAgentId ?? id,
    agentId: id,
    name: fields.name || "Grok Bot",
    description: fields.description ?? "",
    title: fields.title ?? "",
    avatarShape: fields.avatarShape ?? "",
    avatarColor: fields.avatarColor ?? "",
    createdAtMs: now,
    updatedAtMs: now,
    harness: "box",
    role: fields.role ?? "",
    visibility: "GrokBotAgentVisibility_OWNER",
    viewerIsOwner: true,
    viewerCanManage: true,
    viewerSessionId: crypto.randomUUID(),
    kind: "GrokBotAgentKind_AGENT",
    teamDefaultForViewer: false,
  };
}

export class AgentStore {
  constructor(file = AGENTS_FILE) {
    this.file = file;
    this.data = { agents: {}, deleted: [] };
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      if (parsed && typeof parsed.agents === "object" && Array.isArray(parsed.deleted)) this.data = parsed;
    } catch {
      // Missing or corrupt: start empty. The next write replaces the file.
    }
  }

  #save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  list() {
    return Object.values(this.data.agents);
  }

  get(id) {
    return this.data.agents[id];
  }

  // Idempotent per agentId: the app retries provisioning, and a retry must
  // return the Bot it already created instead of making a second one.
  create(fields = {}, now = Date.now()) {
    const wanted = fields.agentId || fields.id;
    if (wanted && this.data.agents[wanted]) return this.data.agents[wanted];
    const agent = newAgent(fields, now);
    this.data.agents[agent.id] = agent;
    this.#save();
    return agent;
  }

  update(id, patch, now = Date.now()) {
    const current = this.data.agents[id];
    if (!current) return undefined;
    const next = { ...current, ...patch, id: current.id, updatedAtMs: now };
    this.data.agents[id] = next;
    this.#save();
    return next;
  }

  remove(id) {
    if (!this.data.agents[id]) return false;
    delete this.data.agents[id];
    this.data.deleted.push(id);
    this.#save();
    return true;
  }

  deletedIds() {
    return [...this.data.deleted];
  }
}
