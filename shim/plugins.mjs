import fs from "node:fs";
import path from "node:path";
import { STATE_DIR } from "./secrets.mjs";
import { RpcError } from "./rpc.mjs";

// Installed Marketplace plugins. The hosted backend keeps these per account;
// here they live in state/plugins.json. The box host reads them through
// GetEffectiveUserPlugins and clones each plugin from its public gitUrl itself.
export const PLUGINS_FILE = path.join(STATE_DIR, "plugins.json");

export class PluginStore {
  constructor(file = PLUGINS_FILE) {
    this.file = file;
    this.installs = {};
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      if (parsed && typeof parsed.installs === "object") this.installs = parsed.installs;
    } catch {
      // Missing or corrupt: start empty.
    }
  }

  #save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ installs: this.installs }), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  list() {
    return Object.values(this.installs);
  }

  get(pluginId) {
    return this.installs[String(pluginId)];
  }

  install(pluginId, { pinnedGitRef = "", variables } = {}, now = Date.now()) {
    const key = String(pluginId);
    const prev = this.installs[key];
    this.installs[key] = {
      pluginId: Number(pluginId),
      isEnabled: true,
      pinnedGitRef,
      ...(variables === undefined ? {} : { variables }),
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
    };
    this.#save();
    return this.installs[key];
  }

  update(pluginId, patch, now = Date.now()) {
    const key = String(pluginId);
    if (!this.installs[key]) return undefined;
    this.installs[key] = { ...this.installs[key], ...patch, pluginId: Number(pluginId), updatedAt: now };
    this.#save();
    return this.installs[key];
  }

  remove(pluginId) {
    const key = String(pluginId);
    if (!this.installs[key]) return false;
    delete this.installs[key];
    this.#save();
    return true;
  }
}

// `catalog` answers plugin(id) -> Plugin object (or undefined) and
// marketplaces() -> Marketplace objects, both from the public catalog.
export function pluginHandlers(store, catalog) {
  const installReply = async (install) => {
    const plugin = await catalog.plugin(install.pluginId);
    return {
      install: {
        pluginId: install.pluginId,
        isEnabled: install.isEnabled,
        createdAt: install.createdAt,
        updatedAt: install.updatedAt,
        pinnedGitRef: install.pinnedGitRef,
        ...(plugin === undefined ? {} : { plugin }),
      },
    };
  };

  return {
    InstallUserPlugin: async (req) => {
      if (!req.pluginId) throw new RpcError("invalid_argument", "pluginId is required");
      if ((await catalog.plugin(req.pluginId)) === undefined) throw new RpcError("not_found", `plugin ${req.pluginId} is not in the public catalog`);
      return installReply(store.install(req.pluginId, { pinnedGitRef: req.pinnedGitRef ?? "", variables: req.variables }));
    },

    UpdateUserPluginInstall: async (req) => {
      const patch = {};
      if (req.isEnabled !== undefined) patch.isEnabled = req.isEnabled;
      if (req.pinnedGitRef !== undefined) patch.pinnedGitRef = req.pinnedGitRef;
      if (req.variables !== undefined) patch.variables = req.variables;
      const install = store.update(req.pluginId, patch);
      if (!install) throw new RpcError("not_found", `plugin ${req.pluginId} is not installed`);
      return installReply(install);
    },

    UninstallUserPlugin: (req) => {
      store.remove(req.pluginId);
      return {};
    },

    GetEffectiveUserPlugins: async (req) => {
      const plugins = [];
      for (const install of store.list()) {
        const plugin = await catalog.plugin(install.pluginId);
        if (plugin === undefined) continue; // withdrawn from the catalog
        plugins.push({
          plugin,
          isEnabled: install.isEnabled,
          pinnedGitRef: install.pinnedGitRef,
          ...(install.variables === undefined || req.excludeConfiguredVariables ? {} : { configuredVariables: install.variables }),
          configuredVariableKeys: Object.keys(install.variables?.fields ?? {}),
        });
      }
      return { plugins, marketplaces: await catalog.marketplaces() };
    },
  };
}
