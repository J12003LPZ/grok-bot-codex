import { RpcError } from "./rpc.mjs";

// Handlers for the GrokBotService calls that need real answers. Everything else
// still gets the server's empty-message fallback (a valid all-defaults reply).

export function agentHandlers(store) {
  const sessionFor = (agent) => ({
    agentId: agent.id,
    sessionId: agent.viewerSessionId,
    createdAtMs: agent.createdAtMs,
    updatedAtMs: agent.updatedAtMs,
  });

  return {
    // The desktop asks the backend for a server-run ("temporal") Bot first and
    // falls back to the box host on Unimplemented. Server-run Bots would do
    // their inference upstream, so only the box host gets an agent here.
    CreateGrokBotAgentFromTemplate: (req, ctx = {}) => {
      if (ctx.caller !== "box") throw new RpcError("unimplemented", "server-run Bots are not available; create on the box host");
      return {
        agent: store.create({ agentId: req.agentId }),
        setupHandledByServer: false,
        conversationalSetupEnabled: false,
        gettingStartedTrusted: true,
        updateStateSplit: false,
      };
    },

    CreateGrokBotAgent: (req) => ({
      agent: store.create({
        agentId: req.agentId,
        legacyAgentId: req.legacyAgentId,
        name: req.name,
        description: req.description,
        title: req.title,
        avatarShape: req.avatarShape,
        avatarColor: req.avatarColor,
      }),
      harness: "GrokBotAgentHarnessKind_BOX",
    }),

    ListGrokBotAgents: () => ({ agents: store.list() }),

    ListDeletedGrokBotAgentIds: () => ({ agentIds: store.deletedIds() }),

    ListGrokBotAgentStatuses: (req) => ({
      statuses: (req.agentIds ?? []).filter((id) => store.get(id)).map((agentId) => ({ agentId, isRunning: false })),
    }),

    ListGrokBotAgentSessions: (req) => {
      const agent = store.get(req.agentId);
      return { sessions: agent ? [sessionFor(agent)] : [] };
    },

    UpdateGrokBotAgent: (req) => {
      const patch = {};
      for (const key of ["name", "description", "title", "avatarShape", "avatarColor"]) {
        if (req[key] !== undefined) patch[key] = req[key];
      }
      const agent = store.update(req.id, patch);
      return agent ? { agent } : {};
    },

    DeleteGrokBotAgent: (req) => {
      store.remove(req.id);
      return {};
    },
  };
}
