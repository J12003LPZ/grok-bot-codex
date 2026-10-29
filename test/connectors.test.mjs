import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConnectorStore, createConnectors, defaultClientHosts, hostAllowed, rawGithubUrl, serverIdOf, serverIdentifierOf } from "../shim/connectors.mjs";
import { jsonToStruct } from "../shim/struct.mjs";
import { createRpc, loadGenerated } from "../shim/rpc.mjs";
import { isPublicAddress, publicFetch } from "../shim/mcp-oauth.mjs";

const REDIRECT = "http://127.0.0.1:8444/mcp-oauth/callback";
const MCP_URL = "https://mcp.example.com/mcp";
const SOURCE = "https://github.com/acme/plugins/blob/0123456789abcdef0123456789abcdef01234567/mail/mcp.json";

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

// A connector behind OAuth, its authorization server, and the GitHub file that declares it.
function fakeWorld({ registration = true, issuer = "https://auth.example.com" } = {}) {
  const world = { calls: [], issued: 0, registered: 0, validTokens: new Set(), refreshes: 0 };
  world.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const body = init.body ? String(init.body) : "";
    world.calls.push(`${init.method ?? "GET"} ${u.origin}${u.pathname}`);
    if (u.href === rawGithubUrl(SOURCE)) return json({ mcpServers: { mail: { type: "http", url: MCP_URL } } });
    if (u.href === "https://mcp.example.com/.well-known/oauth-protected-resource/mcp") {
      return json({ resource: MCP_URL, authorization_servers: [`${issuer}/`], scopes_supported: ["mail.read"] });
    }
    if (u.href === `${issuer}/.well-known/oauth-authorization-server`) {
      return json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        ...(registration ? { registration_endpoint: `${issuer}/register` } : {}),
      });
    }
    if (u.href === `${issuer}/register`) {
      world.registered++;
      assert.deepEqual(JSON.parse(body).redirect_uris, [REDIRECT]);
      return json({ client_id: "dyn-client" }, 201);
    }
    if (u.href === `${issuer}/token`) {
      const form = new URLSearchParams(body);
      if (form.get("grant_type") === "authorization_code") {
        if (form.get("code") !== "good-code" || !form.get("code_verifier")) return json({ error: "invalid_grant" }, 400);
      } else if (form.get("refresh_token") === "refresh-1") {
        world.refreshes++;
      } else {
        return json({ error: "invalid_grant" }, 400);
      }
      const token = `access-${++world.issued}`;
      world.validTokens.add(token);
      return json({ access_token: token, refresh_token: "refresh-1", expires_in: 3600 });
    }
    if (u.href === MCP_URL) {
      const auth = new Headers(init.headers).get("authorization") ?? "";
      if (!world.validTokens.has(auth.replace(/^Bearer /, ""))) return new Response("unauthorized", { status: 401 });
      const msg = JSON.parse(body);
      if (msg.id === undefined) return new Response(null, { status: 202 });
      const result =
        msg.method === "initialize"
          ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "mail" } }
          : msg.method === "tools/list"
            ? { tools: [{ name: "search_threads", description: "Search mail", inputSchema: { type: "object", properties: { q: { type: "string" } } } }] }
            : { content: [{ type: "text", text: `found mail for ${msg.params.arguments.q}` }] };
      // Answer tools/call as an event stream, the other form servers use.
      if (msg.method === "tools/call") {
        return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result })}\n\n`, {
          headers: { "content-type": "text/event-stream", "mcp-session-id": "s1" },
        });
      }
      return json({ jsonrpc: "2.0", id: msg.id, result }, 200, { "mcp-session-id": "s1" });
    }
    return new Response("not found", { status: 404 });
  };
  return world;
}

const plugin = { id: 77, name: "mail", displayName: "Mail", mcpServers: [{ name: "mail", sourceUrl: SOURCE }] };
const tmpStore = () => new ConnectorStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "conn-")), "connectors.json"));

function setup(opts) {
  const world = fakeWorld(opts);
  const store = tmpStore();
  const c = createConnectors({
    store,
    plugins: { list: () => [{ pluginId: 77, isEnabled: true }] },
    catalog: { plugin: async (id) => (id === 77 ? plugin : undefined) },
    redirectUri: REDIRECT,
    fetchImpl: (...args) => world.fetch(...args), // tests swap world.fetch mid-way
  });
  return { world, store, c, id: serverIdOf(77, "mail") };
}

async function signIn(c, id) {
  const { statuses } = await c.handlers.CheckHttpMcpStatus({ serverIds: [id], accountKey: "default" });
  const authUrl = new URL(statuses[0].authUrl);
  return c.callback(new URLSearchParams({ state: authUrl.searchParams.get("state"), code: "good-code" }));
}

test("catalog mcp.json links map to raw GitHub files only", () => {
  assert.equal(rawGithubUrl(SOURCE), "https://raw.githubusercontent.com/acme/plugins/0123456789abcdef0123456789abcdef01234567/mail/mcp.json");
  assert.equal(rawGithubUrl("https://evil.example/acme/plugins/blob/0123456/mcp.json"), undefined);
  assert.equal(rawGithubUrl("https://github.com/acme/plugins/blob/main/mcp.json"), undefined); // not commit-pinned
  assert.equal(rawGithubUrl("https://github.com/a/b/blob/0123456/../x.json"), undefined);
});

test("server ids are stable positive int32s and identifiers never contain --", () => {
  assert.equal(serverIdOf(77, "mail"), serverIdOf(77, "mail"));
  assert.ok(serverIdOf(77, "mail") > 0 && serverIdOf(77, "mail") <= 0x7fffffff);
  assert.equal(serverIdentifierOf("gmail", "gmail"), "gmail");
  assert.equal(serverIdentifierOf("google--x", "a b"), "google-x-a-b");
});

test("installed plugins' remote MCP servers are offered as connectors", async () => {
  const { c, id } = setup();
  const { servers } = await c.handlers.GetAvailableMcpServers({});
  assert.equal(servers.length, 1);
  assert.equal(servers[0].id, id);
  assert.equal(servers[0].name, "Mail");
  assert.equal(servers[0].url, MCP_URL);
  assert.equal(servers[0].serverIdentifier, "mail");
  assert.equal(servers[0].userHasAccessToken, false);
});

test("sign-in: registers a client, opens a PKCE link, and the browser callback stores the token", async () => {
  const { c, id, world, store } = setup();
  const { statuses } = await c.handlers.CheckHttpMcpStatus({ serverIds: [id] });
  assert.equal(statuses[0].requiresAuth, true);
  const authUrl = new URL(statuses[0].authUrl);
  assert.equal(authUrl.origin + authUrl.pathname, "https://auth.example.com/authorize");
  assert.equal(authUrl.searchParams.get("client_id"), "dyn-client");
  assert.equal(authUrl.searchParams.get("redirect_uri"), REDIRECT);
  assert.equal(authUrl.searchParams.get("code_challenge_method"), "S256");
  assert.equal(authUrl.searchParams.get("resource"), MCP_URL);
  assert.equal(world.registered, 1);

  const done = await c.callback(new URLSearchParams({ state: authUrl.searchParams.get("state"), code: "good-code" }));
  assert.equal(done.status, 200);
  assert.match(done.html, /Mail is connected/);
  assert.equal(store.token(MCP_URL).accessToken, "access-1");

  const again = await c.callback(new URLSearchParams({ state: authUrl.searchParams.get("state"), code: "good-code" }));
  assert.equal(again.status, 400, "a state works once");

  const { results } = await c.handlers.ValidateMcpOAuthTokens({ targets: [{ serverUrl: MCP_URL, accountKey: "default" }] });
  assert.equal(results[0].hasValidToken, true);
  const byIdent = await c.handlers.ValidateMcpOAuthTokens({ serverIdentifiers: ["mail"] });
  assert.deepEqual([byIdent.results[0].serverUrl, byIdent.results[0].hasValidToken], [MCP_URL, true]);
  const status = await c.handlers.CheckHttpMcpStatus({ serverIds: [id] });
  assert.equal(status.statuses[0].hasValidToken, true);
});

test("a forged or unknown state never stores a token", async () => {
  const { c, store } = setup();
  const res = await c.callback(new URLSearchParams({ state: "made-up", code: "good-code" }));
  assert.equal(res.status, 400);
  assert.equal(store.token(MCP_URL), undefined);
});

test("tools are listed and called on the user's account", async () => {
  const { c, id } = setup();
  let listed = await c.handlers.ListSandMcpTools({ serverIdentifiers: ["mail"] });
  assert.equal(listed.servers[0].status, "needsAuth");
  await signIn(c, id);
  listed = await c.handlers.ListSandMcpTools({ serverIdentifiers: ["mail"] });
  assert.equal(listed.servers[0].status, "connected");
  assert.equal(listed.servers[0].tools[0].name, "search_threads");
  assert.equal(listed.servers[0].tools[0].providerIdentifier, "mail");
  const out = await c.handlers.ExecuteSandMcpTool({ serverIdentifier: "mail", toolName: "search_threads", args: jsonToStruct({ q: "invoices" }) });
  assert.equal(out.result.success.content[0].text.text, "found mail for invoices");
});

test("a rejected token is refreshed once, then the call goes through", async () => {
  const { c, id, world } = setup();
  await signIn(c, id);
  world.validTokens.clear(); // provider revoked the access token early
  const out = await c.handlers.ExecuteSandMcpTool({ serverIdentifier: "mail", toolName: "search_threads", args: jsonToStruct({ q: "x" }) });
  assert.equal(world.refreshes, 1);
  assert.equal(out.result.success.content[0].text.text, "found mail for x");
});

test("signed out: tool calls say to sign in instead of failing silently", async () => {
  const { c } = setup();
  const out = await c.handlers.ExecuteSandMcpTool({ serverIdentifier: "mail", toolName: "search_threads", args: jsonToStruct({}) });
  assert.equal(out.result.error.needsAuth, true);
  assert.match(out.result.error.error, /Sign in to Mail/);
});

test("providers without self-registration need a client the user configured", async () => {
  const { c, id, store } = setup({ registration: false, issuer: "https://accounts.google.com" });
  let { statuses } = await c.handlers.CheckHttpMcpStatus({ serverIds: [id] });
  assert.equal(statuses[0].authUrl, undefined);
  assert.match(statuses[0].error, /npm run connector-client -- https:\/\/accounts\.google\.com/);

  // As `npm run connector-client` does, from another process while the shim runs.
  new ConnectorStore(store.file).setClient("https://accounts.google.com/", { clientId: "mine.apps.googleusercontent.com", clientSecret: "s", hosts: ["example.com"], source: "user" });
  ({ statuses } = await c.handlers.CheckHttpMcpStatus({ serverIds: [id] }));
  const authUrl = new URL(statuses[0].authUrl);
  assert.equal(authUrl.searchParams.get("client_id"), "mine.apps.googleusercontent.com");
  assert.equal(authUrl.searchParams.get("access_type"), "offline");
  const done = await c.callback(new URLSearchParams({ state: authUrl.searchParams.get("state"), code: "good-code" }));
  assert.equal(done.status, 200);
});

test("a server can't borrow a saved client by claiming another issuer", async () => {
  // The plugin's server names its own authorization server, whose metadata says it is Google.
  const { c, id, world, store } = setup({ registration: false, issuer: "https://auth.evil.example" });
  const realFetch = world.fetch;
  world.fetch = async (url, init) => {
    const res = await realFetch(url, init);
    if (String(url).endsWith("/.well-known/oauth-authorization-server")) {
      return json({ ...(await res.json()), issuer: "https://accounts.google.com" });
    }
    return res;
  };
  store.setClient("https://accounts.google.com", { clientId: "mine.apps.googleusercontent.com", clientSecret: "secret", hosts: ["example.com"], source: "user" });
  const { statuses } = await c.handlers.CheckHttpMcpStatus({ serverIds: [id] });
  assert.equal(statuses[0].authUrl, undefined);
  assert.match(statuses[0].error, /auth\.evil\.example/);
});

test("the user's own client only gets tokens for servers on its hosts", async () => {
  const { c, id, store } = setup({ registration: false, issuer: "https://accounts.google.com" });
  // As saved by default for Google: googleapis.com only, so mcp.example.com is refused.
  store.setClient("https://accounts.google.com", { clientId: "mine", clientSecret: "s", hosts: defaultClientHosts("https://accounts.google.com/"), source: "user" });
  const { statuses } = await c.handlers.CheckHttpMcpStatus({ serverIds: [id] });
  assert.equal(statuses[0].authUrl, undefined);
  assert.match(statuses[0].error, /only covers googleapis\.com, not mcp\.example\.com/);
  assert.equal(hostAllowed("https://gmailmcp.googleapis.com/mcp/v1", ["googleapis.com"]), true);
  assert.equal(hostAllowed("https://googleapis.com.evil.example/", ["googleapis.com"]), false);
});

test("metadata for another server is refused", async () => {
  const { c, id, world } = setup();
  const realFetch = world.fetch;
  world.fetch = async (url, init) => {
    if (String(url).includes("oauth-protected-resource")) {
      return json({ resource: "https://mcp.notion.example/mcp", authorization_servers: ["https://auth.example.com/"] });
    }
    return realFetch(url, init);
  };
  const { statuses } = await c.handlers.CheckHttpMcpStatus({ serverIds: [id] });
  assert.equal(statuses[0].authUrl, undefined);
  assert.match(statuses[0].error, /for another server/);
});

test("an unreadable metadata endpoint is an error, not 'needs no sign-in'", async () => {
  const { c, id, world } = setup();
  const realFetch = world.fetch;
  world.fetch = async (url, init) => (String(url).includes("oauth-protected-resource") ? new Response("busy", { status: 503 }) : realFetch(url, init));
  const { statuses } = await c.handlers.CheckHttpMcpStatus({ serverIds: [id] });
  assert.notEqual(statuses[0].hasValidToken, true);
  assert.match(statuses[0].error, /could not read the sign-in metadata/);
  world.fetch = realFetch; // recovered: not cached
  const again = await c.handlers.CheckHttpMcpStatus({ serverIds: [id], statusOnly: true });
  assert.equal(again.statuses[0].requiresAuth, true);
});

test("parallel calls share one refresh, and a failed refresh keeps the token", async () => {
  const { c, id, world, store } = setup();
  await signIn(c, id);
  store.setToken(MCP_URL, "default", { ...store.token(MCP_URL), expiresAt: Date.now() - 1 });
  const call = () => c.handlers.ExecuteSandMcpTool({ serverIdentifier: "mail", toolName: "search_threads", args: jsonToStruct({ q: "p" }) });
  const outs = await Promise.all([call(), call(), call()]);
  assert.equal(world.refreshes, 1);
  assert.ok(outs.every((o) => o.result.success));

  store.setToken(MCP_URL, "default", { ...store.token(MCP_URL), expiresAt: Date.now() - 1 });
  const realFetch = world.fetch;
  world.fetch = async (url, init) => (String(url).endsWith("/token") ? new Response("down", { status: 502 }) : realFetch(url, init));
  const out = await call();
  assert.ok(out.result.error, "the call fails for now");
  assert.ok(store.token(MCP_URL), "but the user stays signed in");
});

test("a corrupt store file is reported, not replaced", () => {
  const store = tmpStore();
  fs.writeFileSync(store.file, "{not json");
  assert.throws(() => store.setToken(MCP_URL, "default", { accessToken: "x" }));
  assert.equal(fs.readFileSync(store.file, "utf8"), "{not json");
});

test("connector traffic only goes to public HTTPS addresses", async () => {
  for (const a of ["127.0.0.1", "10.1.2.3", "192.168.1.5", "172.17.0.1", "169.254.169.254", "::1", "fd00::1", "::ffff:127.0.0.1", "0.0.0.0"]) {
    assert.equal(isPublicAddress(a), false, a);
  }
  assert.equal(isPublicAddress("142.250.80.10"), true);
  assert.equal(isPublicAddress("2607:f8b0:4004:c1b::64"), true);
  await assert.rejects(publicFetch("http://example.com/"), /https/);
  await assert.rejects(publicFetch("https://127.0.0.1:8550/"), /not a public address/);
  await assert.rejects(publicFetch("https://localhost:8444/"), /not a public address/);
});

test("only the desktop may hand in a sign-in code", async () => {
  const { c, id, store } = setup();
  const { statuses } = await c.handlers.CheckHttpMcpStatus({ serverIds: [id] });
  const stateId = new URL(statuses[0].authUrl).searchParams.get("state");
  await assert.rejects(c.handlers.CompleteMcpOAuth({ stateId, authorizationCode: "good-code" }, { caller: "box" }), /browser/);
  assert.equal(store.token(MCP_URL), undefined);
  await c.handlers.CompleteMcpOAuth({ stateId, authorizationCode: "good-code" }, { caller: "desktop" });
  assert.equal(store.token(MCP_URL).accessToken, "access-1");
});

test("a saved client defaults to its issuer's exact host", () => {
  assert.deepEqual(defaultClientHosts("https://accounts.google.com/"), ["googleapis.com"]);
  assert.deepEqual(defaultClientHosts("https://login.example.co.uk/oauth"), ["login.example.co.uk"]);
});

test("publicFetch checks the address it connects to", async () => {
  await assert.rejects(publicFetch("https://localhost.localdomain.invalid/"), /ENOTFOUND|EAI_AGAIN|not a public/);
  await assert.rejects(publicFetch("https://[::1]:8444/"), /not a public address/);
});

test("signing out deletes the stored token", async () => {
  const { c, id, store } = setup();
  await signIn(c, id);
  await c.handlers.DeleteMcpOAuthToken({ serverUrl: MCP_URL, accountKey: "default" });
  assert.equal(store.token(MCP_URL), undefined);
});

const generated = loadGenerated();
test("every reply encodes with the app's schema", { skip: !generated && "no generated/app.proto" }, async () => {
  const { c, id } = setup();
  const rpc = createRpc({ ...generated, handlers: c.handlers });
  const call = async (method, input, req) => {
    const In = generated.root.lookupType(`aiserver.v1.${input}`);
    const bytes = Buffer.from(In.encode(In.fromObject(req)).finish());
    const route = Object.keys(generated.rpcs).find((r) => r.endsWith(`/${method}`));
    return rpc.unary(route, bytes);
  };
  await call("GetAvailableMcpServers", "GetAvailableMcpServersRequest", {});
  await call("CheckHttpMcpStatus", "CheckHttpMcpStatusRequest", { serverIds: [id], statusOnly: true });
  await call("ListSandMcpTools", "ListSandMcpToolsRequest", { serverIdentifiers: ["mail"] });
  await signIn(c, id);
  await call("ValidateMcpOAuthTokens", "ValidateMcpOAuthTokensRequest", { targets: [{ serverUrl: MCP_URL, accountKey: "default" }] });
  await call("ListSandMcpTools", "ListSandMcpToolsRequest", { serverIdentifiers: ["mail"] });
  const out = await call("ExecuteSandMcpTool", "ExecuteSandMcpToolRequest", { serverIdentifier: "mail", toolName: "search_threads", args: jsonToStruct({ q: "a" }) });
  const Res = generated.root.lookupType("aiserver.v1.ExecuteSandMcpToolResponse");
  assert.equal(Res.decode(out).result.success.content[0].text.text, "found mail for a");
});

test("tokens are written with a private file mode", async () => {
  const { c, id, store } = setup();
  await signIn(c, id);
  const saved = JSON.parse(fs.readFileSync(store.file, "utf8"));
  assert.equal(saved.tokens[MCP_URL].default.accessToken, "access-1");
  if (process.platform !== "win32") assert.equal(fs.statSync(store.file).mode & 0o077, 0);
});
