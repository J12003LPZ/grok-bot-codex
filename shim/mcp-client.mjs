// Minimal MCP client over Streamable HTTP: JSON-RPC POSTs whose reply is either
// plain JSON or a text/event-stream carrying the JSON-RPC response.

import { publicFetch } from "./mcp-oauth.mjs";

const PROTOCOL_VERSION = "2025-06-18";
const TIMEOUT_MS = 60_000;

export class McpHttpError extends Error {
  constructor(status, message, wwwAuthenticate) {
    super(message);
    this.status = status;
    this.wwwAuthenticate = wwwAuthenticate;
  }
}

function sseMessages(text) {
  const out = [];
  for (const event of text.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (data) {
      try {
        out.push(JSON.parse(data));
      } catch {
        // keep-alive or partial event
      }
    }
  }
  return out;
}

export function createMcpSession(url, { token, fetchImpl = publicFetch } = {}) {
  let sessionId;
  let initializing; // shared by concurrent first calls
  let version = PROTOCOL_VERSION; // the one the server answers initialize with
  let nextId = 1;

  async function post(message) {
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": version,
    };
    if (token) headers.authorization = `Bearer ${token}`;
    if (sessionId) headers["mcp-session-id"] = sessionId;
    const res = await fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(message),
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const sid = res.headers.get("mcp-session-id");
    if (sid) sessionId = sid;
    const text = await res.text();
    if (!res.ok) {
      throw new McpHttpError(res.status, `MCP server answered HTTP ${res.status}: ${text.slice(0, 200)}`, res.headers.get("www-authenticate") ?? "");
    }
    if (message.id === undefined) return undefined;
    const ct = res.headers.get("content-type") ?? "";
    const replies = ct.includes("text/event-stream") ? sseMessages(text) : [JSON.parse(text)];
    const reply = replies.find((m) => m && m.id === message.id);
    if (!reply) throw new Error("MCP server sent no reply");
    if (reply.error) throw new Error(`MCP error ${reply.error.code}: ${reply.error.message}`);
    return reply.result;
  }

  function ensureInitialized() {
    initializing ??= (async () => {
      version = PROTOCOL_VERSION;
      const result = await post({
        jsonrpc: "2.0",
        id: nextId++,
        method: "initialize",
        params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "grokbot-shim", version: "1" } },
      });
      if (typeof result?.protocolVersion === "string") version = result.protocolVersion;
      await post({ jsonrpc: "2.0", method: "notifications/initialized" });
    })().catch((err) => {
      initializing = undefined;
      throw err;
    });
    return initializing;
  }

  async function request(method, params) {
    await ensureInitialized();
    try {
      return await post({ jsonrpc: "2.0", id: nextId++, method, params });
    } catch (err) {
      // An expired session answers 404; start a new one once.
      if (!(err instanceof McpHttpError) || err.status !== 404 || !sessionId) throw err;
      sessionId = undefined;
      initializing = undefined;
      await ensureInitialized();
      return post({ jsonrpc: "2.0", id: nextId++, method, params });
    }
  }

  return {
    async listTools() {
      const tools = [];
      const seen = new Set();
      let cursor;
      do {
        if (seen.size >= 100) throw new Error("MCP server kept paging tools/list");
        const page = await request("tools/list", cursor ? { cursor } : {});
        tools.push(...(page?.tools ?? []));
        cursor = page?.nextCursor;
        if (cursor && seen.has(cursor)) throw new Error("MCP server repeated a tools/list cursor");
        if (cursor) seen.add(cursor);
      } while (cursor);
      return tools;
    },
    callTool: (name, args) => request("tools/call", { name, arguments: args ?? {} }),
  };
}
