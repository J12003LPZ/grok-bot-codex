import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PluginStore, pluginHandlers } from "../shim/plugins.mjs";
import { RpcError, createRpc, loadGenerated } from "../shim/rpc.mjs";

const PLUGIN = {
  id: 7,
  name: "demo",
  displayName: "Demo",
  status: "PluginStatus_APPROVED",
  gitUrl: "https://github.com/example/demo",
  gitRef: "abc123",
  gitPath: "plugins/demo",
  marketplaceId: 34,
  skills: [{ name: "s", description: "d" }],
};
const MARKETPLACE = { id: 34, name: "cursor-public", displayName: "Cursor Plugin Marketplace" };
const fakeCatalog = { plugin: async (id) => (Number(id) === 7 ? PLUGIN : undefined), marketplaces: async () => [MARKETPLACE] };
const store = () => new PluginStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pl-")), "plugins.json"));
const DESK = { caller: "desktop" };

test("the box may read installs but not change them", async () => {
  const s = store();
  const h = pluginHandlers(s, fakeCatalog);
  for (const ctx of [{ caller: "box" }, undefined]) {
    await assert.rejects(h.InstallUserPlugin({ pluginId: 7 }, ctx), (e) => e instanceof RpcError && e.code === "permission_denied");
    await assert.rejects(h.UpdateUserPluginInstall({ pluginId: 7, isEnabled: false }, ctx), (e) => e.code === "permission_denied");
    assert.throws(() => h.UninstallUserPlugin({ pluginId: 7 }, ctx), (e) => e.code === "permission_denied");
  }
  await h.InstallUserPlugin({ pluginId: 7 }, DESK);
  assert.equal((await h.GetEffectiveUserPlugins({}, { caller: "box" })).plugins.length, 1);
});

test("pinnedGitRef accepts SHAs and plain ref names only", async () => {
  const h = pluginHandlers(store(), fakeCatalog);
  for (const ref of ["abc1234", "main", "release/v1.2", "a".repeat(40)]) {
    assert.equal((await h.InstallUserPlugin({ pluginId: 7, pinnedGitRef: ref }, DESK)).install.pinnedGitRef, ref);
  }
  for (const ref of ["--upload-pack=x", "-x", "a..b", "a b", "a;b", "x.lock", "dir/", "$(id)"]) {
    await assert.rejects(h.InstallUserPlugin({ pluginId: 7, pinnedGitRef: ref }, DESK), (e) => e.code === "invalid_argument", ref);
    await assert.rejects(h.UpdateUserPluginInstall({ pluginId: 7, pinnedGitRef: ref }, DESK), (e) => e.code === "invalid_argument", ref);
  }
});

test("install, list as effective, disable, uninstall", async () => {
  const s = store();
  const h = pluginHandlers(s, fakeCatalog);
  const { install } = await h.InstallUserPlugin({ pluginId: 7 }, DESK);
  assert.equal(install.plugin.gitUrl, PLUGIN.gitUrl);
  assert.equal(install.isEnabled, true);

  let eff = await h.GetEffectiveUserPlugins({});
  assert.deepEqual(eff.marketplaces, [MARKETPLACE]);
  assert.equal(eff.plugins.length, 1);
  assert.equal(eff.plugins[0].plugin.gitPath, "plugins/demo");

  await h.UpdateUserPluginInstall({ pluginId: 7, isEnabled: false }, DESK);
  eff = await h.GetEffectiveUserPlugins({});
  assert.equal(eff.plugins[0].isEnabled, false);

  h.UninstallUserPlugin({ pluginId: 7 }, DESK);
  assert.deepEqual((await h.GetEffectiveUserPlugins({})).plugins, []);
});

test("installs survive a restart", async () => {
  const s = store();
  await pluginHandlers(s, fakeCatalog).InstallUserPlugin({ pluginId: 7 }, DESK);
  assert.equal(new PluginStore(s.file).get(7).pluginId, 7);
});

test("unknown plugins and updates of missing installs are refused", async () => {
  const h = pluginHandlers(store(), fakeCatalog);
  await assert.rejects(h.InstallUserPlugin({ pluginId: 99 }, DESK), (e) => e instanceof RpcError && e.code === "not_found");
  await assert.rejects(h.InstallUserPlugin({}, DESK), (e) => e instanceof RpcError && e.code === "invalid_argument");
  await assert.rejects(h.UpdateUserPluginInstall({ pluginId: 7, isEnabled: true }, DESK), (e) => e.code === "not_found");
});

test("variables are passed to the host unless excluded", async () => {
  const h = pluginHandlers(store(), fakeCatalog);
  const variables = { fields: { API_KEY: { stringValue: "x" } } };
  await h.InstallUserPlugin({ pluginId: 7, variables }, DESK);
  assert.deepEqual((await h.GetEffectiveUserPlugins({})).plugins[0].configuredVariables, variables);
  const excluded = (await h.GetEffectiveUserPlugins({ excludeConfiguredVariables: true })).plugins[0];
  assert.equal(excluded.configuredVariables, undefined);
  assert.deepEqual(excluded.configuredVariableKeys, ["API_KEY"]);
});

const generated = loadGenerated();
test("plugin replies encode against the app's real schema", { skip: generated === null }, async () => {
  const rpc = createRpc({ ...generated, handlers: pluginHandlers(store(), fakeCatalog) });
  const call = (name, req) => {
    const route = Object.keys(generated.rpcs).find((r) => r.endsWith(`/${name}`));
    const In = generated.root.lookupType(`aiserver.v1.${generated.rpcs[route].input}`);
    return rpc.unary(route, Buffer.from(In.encode(In.fromObject(req)).finish()), DESK);
  };
  await call("InstallUserPlugin", { pluginId: 7 });
  const bytes = await call("GetEffectiveUserPlugins", {});
  const Out = generated.root.lookupType("aiserver.v1.GetEffectiveUserPluginsResponse");
  const decoded = Out.toObject(Out.decode(bytes), { longs: Number });
  assert.equal(decoded.plugins[0].plugin.gitUrl, PLUGIN.gitUrl);
  assert.equal(decoded.marketplaces[0].name, "cursor-public");
});
