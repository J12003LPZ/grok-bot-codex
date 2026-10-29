import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { STATE_DIR } from "./secrets.mjs";
import { RpcError } from "./rpc.mjs";
import { createMcpSession, McpHttpError } from "./mcp-client.mjs";
import { authorizationUrl, checkUrl, discover, exchangeCode, newPkce, publicFetch, refreshTokens, registerClient } from "./mcp-oauth.mjs";
import { jsonToStruct, jsonToValue, structToJson } from "./struct.mjs";

// Connectors: the remote MCP servers that installed Marketplace plugins declare
// (Gmail, Google Calendar, Notion, ...). The hosted backend signs the user in
// to each one and runs their tools for the box host. Here the shim does both:
// sign-in tokens stay in state/connectors.json (never mounted into the box),
// and the box host reaches the tools only through these RPCs.
export const CONNECTORS_FILE = path.join(STATE_DIR, "connectors.json");
export const DEFAULT_ACCOUNT = "default";
// "https://accounts.google.com/" and "https://accounts.google.com" are one issuer.
export const issuerKey = (issuer) => String(issuer).replace(/\/+$/, "");
const PENDING_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING = 50;
const MAX_SESSIONS = 50;
const META_TTL_MS = 60 * 60 * 1000;
const NO_AUTH_TTL_MS = 5 * 60 * 1000;
const TOOLS_TTL_MS = 5 * 60 * 1000;

// Read from disk on every access: `npm run connector-client` edits the file
// while the shim runs, and neither side may overwrite the other's change.
//   clients: issuer -> { clientId, clientSecret?, hosts: [...], source: "user" }
//            issuer#server host -> { clientId, clientSecret?, redirectUri, source: "registered" }
//   tokens:  server URL -> account key -> { accessToken, refreshToken?, expiresAt? }
export class ConnectorStore {
  constructor(file = CONNECTORS_FILE) {
    this.file = file;
  }

  #read() {
    let text;
    try {
      text = fs.readFileSync(this.file, "utf8");
    } catch (err) {
      if (err.code === "ENOENT") return { clients: {}, tokens: {} };
      throw err;
    }
    // A corrupt file is reported, never silently replaced by an empty one.
    const parsed = JSON.parse(text);
    return { clients: parsed?.clients ?? {}, tokens: parsed?.tokens ?? {} };
  }

  #update(fn) {
    const data = this.#read();
    fn(data);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  client(key) {
    return this.#read().clients[issuerKey(key)];
  }

  setClient(key, client) {
    this.#update((d) => {
      if (client === undefined) delete d.clients[issuerKey(key)];
      else d.clients[issuerKey(key)] = client;
    });
  }

  token(serverUrl, account = DEFAULT_ACCOUNT) {
    return this.#read().tokens[serverUrl]?.[account];
  }

  setToken(serverUrl, account, token) {
    this.#update((d) => {
      d.tokens[serverUrl] = { ...d.tokens[serverUrl], [account]: token };
    });
  }

  deleteToken(serverUrl, account) {
    this.#update((d) => {
      if (!d.tokens[serverUrl]) return;
      if (account === undefined) delete d.tokens[serverUrl];
      else delete d.tokens[serverUrl][account];
    });
  }
}

// mcp.json links in the catalog are GitHub blob URLs at a fixed commit.
export function rawGithubUrl(sourceUrl) {
  const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/blob\/([0-9a-f]{7,40})\/([\w./-]+\.json)$/.exec(String(sourceUrl));
  if (!m || m[4].includes("..")) return undefined;
  return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}/${m[4]}`;
}

// Positive int32, stable for a plugin's server: the host keys connectors by it.
export function serverIdOf(pluginId, name) {
  return crypto.createHash("sha256").update(`${pluginId}:${name}`).digest().readUInt32BE(0) & 0x7fffffff || 1;
}

// The host splits account slots on "--", so identifiers never contain it.
export function serverIdentifierOf(pluginName, name) {
  const clean = (s) => String(s).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/-{2,}/g, "-").replace(/^-|-$/g, "");
  return pluginName === name ? clean(name) : `${clean(pluginName)}-${clean(name)}`;
}

// Which MCP servers a user's own OAuth client may get tokens for. Without
// this, any plugin's server naming Google as its sign-in would receive a
// Google token from the user's Google client.
// Default: the issuer's exact host (Google's MCP servers live on googleapis.com).
export function defaultClientHosts(issuer) {
  const host = new URL(issuer).hostname;
  return [host === "accounts.google.com" ? "googleapis.com" : host];
}

export function hostAllowed(serverUrl, hosts = []) {
  const host = new URL(serverUrl).hostname;
  return hosts.some((h) => host === h || host.endsWith(`.${h}`));
}

const pageEscape = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const page = (title, text) =>
  `<!doctype html><meta charset="utf-8"><title>${pageEscape(title)}</title><body style="font:16px system-ui;margin:3em">` +
  `<h2>${pageEscape(title)}</h2><p>${pageEscape(text)}</p></body>`;

// `plugins` lists installs ({ pluginId, isEnabled }); `catalog.plugin(id)` gives the record.
export function createConnectors({ store = new ConnectorStore(), plugins, catalog, redirectUri, fetchImpl = publicFetch, now = Date.now }) {
  const configCache = new Map(); // raw mcp.json URL -> parsed (commit-pinned, never changes)
  const metaCache = new Map(); // server URL -> { at, meta }
  const toolsCache = new Map(); // server URL + account -> { at, token, tools }
  const pending = new Map(); // state -> flow
  const refreshing = new Map(); // server URL + account -> in-flight refresh
  const sessions = new Map(); // server URL + token -> MCP session

  async function mcpConfig(sourceUrl) {
    const raw = rawGithubUrl(sourceUrl);
    if (!raw) return undefined;
    if (!configCache.has(raw)) {
      const res = await fetchImpl(raw, { redirect: "error", signal: AbortSignal.timeout(15_000) });
      if (!res.ok) return undefined;
      configCache.set(raw, await res.json());
    }
    return configCache.get(raw);
  }

  // Every remote (http/sse) MCP server of every enabled installed plugin.
  async function servers() {
    const out = [];
    for (const install of plugins.list()) {
      if (!install.isEnabled) continue;
      const plugin = await catalog.plugin(install.pluginId);
      for (const ref of plugin?.mcpServers ?? []) {
        let config;
        try {
          config = await mcpConfig(ref.sourceUrl);
        } catch {
          continue; // offline: skip this one for now
        }
        for (const [name, entry] of Object.entries(config?.mcpServers ?? {})) {
          if (entry?.command || typeof entry?.url !== "string" || entry.url.includes("${")) continue;
          try {
            checkUrl(entry.url, "MCP server URL");
          } catch {
            continue;
          }
          const single = (plugin.mcpServers.length === 1 && Object.keys(config.mcpServers).length === 1);
          out.push({
            id: serverIdOf(plugin.id, name),
            name: single ? plugin.displayName || plugin.name : `${plugin.displayName || plugin.name} (${name})`,
            identifier: serverIdentifierOf(plugin.name, name),
            url: entry.url,
            type: entry.type === "sse" ? "sse" : "http",
            plugin,
          });
        }
      }
    }
    return out;
  }

  // Failed discoveries are not cached; "no sign-in" is rechecked sooner.
  async function meta(serverUrl, { fresh = false, resourceMetadataUrl } = {}) {
    const hit = metaCache.get(serverUrl);
    if (!fresh && hit && now() - hit.at < (hit.meta ? META_TTL_MS : NO_AUTH_TTL_MS)) return hit.meta;
    const m = await discover(serverUrl, { fetchImpl, resourceMetadataUrl });
    metaCache.set(serverUrl, { at: now(), meta: m });
    return m;
  }

  const registeredKey = (m, serverUrl) => `${issuerKey(m.issuer)}#${new URL(serverUrl).host}`;

  // The client a server's tokens come from: the user's own client for that
  // issuer when it covers the server, else one registered for this server.
  function savedClient(m, serverUrl) {
    const own = store.client(m.issuer);
    if (own?.source === "user" && hostAllowed(serverUrl, own.hosts)) return own;
    const reg = store.client(registeredKey(m, serverUrl));
    return reg?.redirectUri === redirectUri ? reg : undefined;
  }

  async function clientFor(m, server) {
    const known = savedClient(m, server.url);
    if (known) return known;
    if (!m.registrationEndpoint) {
      const own = store.client(m.issuer);
      if (own?.source === "user") {
        throw new Error(
          `Your saved client for ${m.issuer} only covers ${(own.hosts ?? []).join(", ") || "no servers"}, not ${new URL(server.url).hostname}. ` +
            `Save it again with --hosts if you trust this server.`,
        );
      }
      throw new Error(
        `${server.name} signs in through ${m.issuer}, which does not let apps register themselves. ` +
          `Create an OAuth client there (redirect URI ${redirectUri}) and run: ` +
          `npm run connector-client -- ${m.issuer} <client id> <client secret>`,
      );
    }
    const client = { ...(await registerClient(m, redirectUri, { fetchImpl })), redirectUri, source: "registered" };
    store.setClient(registeredKey(m, server.url), client);
    return client;
  }

  // A usable access token, refreshed when about to expire; undefined if signed out.
  async function accessToken(serverUrl, account, m) {
    const tok = store.token(serverUrl, account);
    if (!tok) return undefined;
    if (!tok.expiresAt || tok.expiresAt - 60_000 > now()) return tok.accessToken;
    return refresh(serverUrl, account, m);
  }

  // One refresh at a time per account: providers that rotate refresh tokens
  // reject the second use of the old one. Only a rejected grant signs the
  // user out; a timeout or 5xx keeps the token for the next try.
  function refresh(serverUrl, account, m) {
    const key = `${serverUrl}\n${account}`;
    if (!refreshing.has(key)) {
      const run = (async () => {
        const tok = store.token(serverUrl, account);
        const client = savedClient(m, serverUrl);
        if (!tok?.refreshToken || !client) {
          store.deleteToken(serverUrl, account);
          return undefined;
        }
        try {
          const next = await refreshTokens(m, client, tok.refreshToken, { fetchImpl });
          store.setToken(serverUrl, account, { refreshToken: tok.refreshToken, ...next });
          return next.accessToken;
        } catch (err) {
          if (err.rejected) {
            store.deleteToken(serverUrl, account);
            return undefined;
          }
          throw err;
        }
      })().finally(() => refreshing.delete(key));
      refreshing.set(key, run);
    }
    return refreshing.get(key);
  }

  async function startSignIn(server, account) {
    const m = await meta(server.url);
    const client = await clientFor(m, server);
    const state = crypto.randomBytes(24).toString("base64url");
    const { verifier, challenge } = newPkce();
    for (const [key, flow] of pending) if (flow.expiresAt < now()) pending.delete(key);
    while (pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value);
    pending.set(state, { serverUrl: server.url, name: server.name, account, verifier, expiresAt: now() + PENDING_TTL_MS });
    return authorizationUrl(m, client, { redirectUri, state, challenge });
  }

  async function finishSignIn(state, code) {
    const flow = pending.get(state);
    pending.delete(state);
    if (!flow || flow.expiresAt < now()) throw new Error("this sign-in link expired; start it again from Grok Bot");
    const m = await meta(flow.serverUrl);
    const client = savedClient(m, flow.serverUrl);
    if (!client) throw new Error("the sign-in client changed; start the sign-in again from Grok Bot");
    const tokens = await exchangeCode(m, client, { code, verifier: flow.verifier, redirectUri }, { fetchImpl });
    store.setToken(flow.serverUrl, flow.account, tokens);
    toolsCache.delete(`${flow.serverUrl}\n${flow.account}`);
    return flow;
  }

  // One MCP session per server and token, reused across calls.
  async function onSession(url, token, fn) {
    const key = `${url}\n${token ?? ""}`;
    if (!sessions.has(key)) {
      if (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
      sessions.set(key, createMcpSession(url, { token, fetchImpl }));
    }
    try {
      return await fn(sessions.get(key));
    } catch (err) {
      sessions.delete(key);
      throw err;
    }
  }

  // Runs fn(session) against the server, retrying once after a refresh on 401.
  async function withSession(server, account, fn) {
    let m = await meta(server.url);
    let token = m ? await accessToken(server.url, account, m) : undefined;
    if (m && !token) return { needsAuth: true };
    try {
      return { value: await onSession(server.url, token, fn) };
    } catch (err) {
      if (!(err instanceof McpHttpError) || err.status !== 401) throw err;
      if (!m) {
        // Thought to need no sign-in: look again, following the server's hint.
        const hint = /resource_metadata="([^"]+)"/.exec(err.wwwAuthenticate ?? "")?.[1];
        m = await meta(server.url, { fresh: true, resourceMetadataUrl: hint });
        if (m) return { needsAuth: true };
        throw err;
      }
      token = await refresh(server.url, account, m);
      if (!token) return { needsAuth: true };
      try {
        return { value: await onSession(server.url, token, fn) };
      } catch (again) {
        if (again instanceof McpHttpError && again.status === 401) {
          store.deleteToken(server.url, account);
          return { needsAuth: true };
        }
        throw again;
      }
    }
  }

  async function tools(server, account) {
    const key = `${server.url}\n${account}`;
    const tok = store.token(server.url, account)?.accessToken;
    const hit = toolsCache.get(key);
    if (hit && hit.token === tok && now() - hit.at < TOOLS_TTL_MS) return { value: hit.tools };
    const res = await withSession(server, account, (s) => s.listTools());
    if (res.value) toolsCache.set(key, { at: now(), token: store.token(server.url, account)?.accessToken, tools: res.value });
    return res;
  }

  // Account slots: "<identifier>--<account>" for non-default accounts.
  async function resolve(identifier) {
    const [base, account = DEFAULT_ACCOUNT] = String(identifier).split("--");
    const server = (await servers()).find((s) => s.identifier === base);
    return server && { server, account };
  }

  async function hasToken(server, account = DEFAULT_ACCOUNT) {
    try {
      const m = await meta(server.url);
      return !m || (await accessToken(server.url, account, m)) !== undefined;
    } catch {
      return false;
    }
  }

  function contentItem(c) {
    if (c?.type === "text") return { text: { text: String(c.text ?? "") } };
    if (c?.type === "image" && typeof c.data === "string") return { image: { data: Buffer.from(c.data, "base64"), mimeType: String(c.mimeType ?? "image/png") } };
    return { text: { text: JSON.stringify(c) } };
  }

  const handlers = {
    GetAvailableMcpServers: async () => ({
      servers: await Promise.all(
        (await servers()).map(async (s) => ({
          id: s.id,
          name: s.name,
          enabled: true,
          type: s.type,
          url: s.url,
          pluginId: Number(s.plugin.id),
          userHasAccessToken: await hasToken(s),
          serverIdentifier: s.identifier,
          servedBy: "McpServedBy_CURSOR",
          singleAccount: true,
          pluginDisplayName: s.plugin.displayName || s.plugin.name,
          ...(s.plugin.logoUrl ? { logoUrl: s.plugin.logoUrl } : {}),
        })),
      ),
    }),

    CheckHttpMcpStatus: async (req) => {
      const all = await servers();
      const ids = new Set(req.serverIds ?? []);
      const idents = new Set(req.serverIdentifiers ?? []);
      const account = req.accountKey || DEFAULT_ACCOUNT;
      const statuses = [];
      for (const s of all.filter((x) => ids.has(x.id) || idents.has(x.identifier))) {
        const base = { id: s.id, serverIdentifier: s.identifier, servedBy: "McpServedBy_CURSOR", isAvailable: true };
        try {
          const m = await meta(s.url);
          if (!m) {
            statuses.push({ ...base, requiresAuth: false, hasValidToken: true, signedIn: true });
          } else if (!req.forceReauth && (await accessToken(s.url, account, m))) {
            statuses.push({ ...base, requiresAuth: false, hasValidToken: true, signedIn: true });
          } else if (req.statusOnly) {
            statuses.push({ ...base, requiresAuth: true, hasValidToken: false });
          } else {
            statuses.push({ ...base, requiresAuth: true, hasValidToken: false, authUrl: await startSignIn(s, account) });
          }
        } catch (err) {
          statuses.push({ ...base, requiresAuth: true, hasValidToken: false, error: String(err?.message ?? err).slice(0, 500) });
        }
      }
      return { statuses };
    },

    // Sign-in normally completes through the browser callback. The box may
    // start a sign-in (its host does) but not hand in a code of its choosing.
    CompleteMcpOAuth: async (req, ctx) => {
      if (ctx?.caller !== "desktop") throw new RpcError("permission_denied", "connector sign-in completes in the browser");
      const flow = await finishSignIn(req.stateId, req.authorizationCode);
      return { postAuthReturnUrl: "", accountKey: flow.account };
    },

    ValidateMcpOAuthTokens: async (req) => {
      const all = await servers();
      const targets = [
        ...(req.targets ?? []).map((t) => ({ serverUrl: t.serverUrl, accountKey: t.accountKey || DEFAULT_ACCOUNT })),
        ...(req.serverUrls ?? []).map((serverUrl) => ({ serverUrl, accountKey: DEFAULT_ACCOUNT })),
      ];
      // The desktop asks by connector identifier ("gmail", "gmail--work").
      for (const ident of req.serverIdentifiers ?? []) {
        const [base, account = DEFAULT_ACCOUNT] = String(ident).split("--");
        const s = all.find((x) => x.identifier === base);
        if (s) targets.push({ serverUrl: s.url, accountKey: account });
      }
      const results = [];
      for (const t of targets) {
        const s = all.find((x) => x.url === t.serverUrl);
        results.push({
          serverUrl: t.serverUrl,
          accountKey: t.accountKey,
          hasValidToken: s ? await hasToken(s, t.accountKey) : false,
          ...(s ? { serverIdentifier: s.identifier, servedBy: "McpServedBy_CURSOR" } : {}),
        });
      }
      return { results };
    },

    ListSandMcpTools: async (req) => {
      const out = [];
      for (const ident of req.serverIdentifiers ?? []) {
        const hit = await resolve(ident);
        if (!hit) continue;
        const row = { serverIdentifier: ident, accountLabel: hit.account, rowServerIdentifier: hit.server.identifier, servedBy: "McpServedBy_CURSOR" };
        try {
          const res = await tools(hit.server, hit.account);
          if (res.needsAuth) {
            out.push({ ...row, status: "needsAuth", tools: [] });
            continue;
          }
          out.push({
            ...row,
            status: "connected",
            tools: res.value.map((t) => ({
              name: String(t.name),
              providerIdentifier: ident,
              toolName: String(t.name),
              description: String(t.description ?? ""),
              inputSchema: jsonToValue(t.inputSchema ?? { type: "object" }),
              ...(t.annotations ? { annotationsJson: JSON.stringify(t.annotations) } : {}),
            })),
          });
        } catch (err) {
          out.push({ ...row, status: "error", tools: [], statusDetail: String(err?.message ?? err).slice(0, 300) });
        }
      }
      return { servers: out };
    },

    ExecuteSandMcpTool: async (req) => {
      const hit = await resolve(req.serverIdentifier);
      if (!hit) return { result: { serverNotFound: {} } };
      try {
        const res = await withSession(hit.server, hit.account, (s) => s.callTool(req.toolName, structToJson(req.args) ?? {}));
        if (res.needsAuth) {
          return { result: { error: { error: `Sign in to ${hit.server.name} first (Connect apps in Grok Bot).`, needsAuth: true } } };
        }
        const r = res.value ?? {};
        return {
          result: {
            success: {
              content: (r.content ?? []).map(contentItem),
              isError: r.isError === true,
              ...(r.structuredContent && typeof r.structuredContent === "object" ? { structuredContent: jsonToStruct(r.structuredContent) } : {}),
            },
          },
        };
      } catch (err) {
        return { result: { error: { error: `${hit.server.name}: ${String(err?.message ?? err).slice(0, 500)}` } } };
      }
    },

    DeleteMcpOAuthToken: async (req) => {
      let url = req.serverUrl;
      if (!url && req.serverIdentifier) url = (await resolve(req.serverIdentifier))?.server.url;
      if (url) store.deleteToken(url, req.accountKey || DEFAULT_ACCOUNT);
      return {};
    },

    DeleteMcpOAuthAccount: async (req) => {
      const url = req.serverUrl || (await servers()).find((s) => s.id === req.serverId)?.url;
      if (url) store.deleteToken(url, req.accountKey || DEFAULT_ACCOUNT);
      return {};
    },
  };

  // GET /mcp-oauth/callback in the user's browser after they approve access.
  async function callback(query) {
    const state = query.get("state") ?? "";
    if (query.get("error")) {
      pending.delete(state);
      return { status: 400, html: page("Sign-in cancelled", `The provider answered: ${query.get("error")}. You can close this tab.`) };
    }
    try {
      const flow = await finishSignIn(state, query.get("code") ?? "");
      return { status: 200, html: page(`${flow.name} is connected`, "You can close this tab and go back to Grok Bot.") };
    } catch (err) {
      return { status: 400, html: page("Sign-in failed", String(err?.message ?? err)) };
    }
  }

  return { handlers, callback, servers };
}

// `npm run connector-client -- <issuer> <client id> [client secret] [--hosts a.com,b.com]`
// saves an OAuth client for providers without self-registration (Google). It
// is only used for MCP servers on those hosts (default: the provider's own
// domain, googleapis.com for Google). `<issuer> --remove` deletes it.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--hosts");
  const hostsArg = at >= 0 ? args.splice(at, 2)[1] : undefined;
  const [issuer, clientId, clientSecret] = args;
  if (!issuer || !clientId) {
    console.error("usage: npm run connector-client -- <issuer, e.g. https://accounts.google.com/> <client id> [client secret] [--hosts a.com,b.com]");
    process.exit(2);
  }
  checkUrl(issuer, "issuer");
  const store = new ConnectorStore();
  if (clientId === "--remove") {
    store.setClient(issuer, undefined);
    console.log(`removed the client for ${issuer}`);
  } else {
    const hosts = hostsArg ? hostsArg.split(",").map((h) => h.trim().toLowerCase()).filter(Boolean) : defaultClientHosts(issuer);
    store.setClient(issuer, { clientId, ...(clientSecret ? { clientSecret } : {}), hosts, source: "user" });
    console.log(`saved the client for ${issuer}, for servers on ${hosts.join(", ")}; connect the app again in Grok Bot`);
  }
}
