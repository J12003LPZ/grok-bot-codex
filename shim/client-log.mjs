import fs from "node:fs";

// The app ships its own log lines to the backend through SubmitLogs. Without a
// sink they are dropped, which hides why a flow failed. When SHIM_CLIENT_LOG
// names a file, append each entry there as one JSON line. Nothing leaves the
// machine.
export function clientLogHandlers(file) {
  return {
    SubmitLogs: (req) => {
      if (file) {
        const lines = (req.logs ?? []).map((entry) => `${JSON.stringify(entry)}\n`).join("");
        if (lines) fs.appendFileSync(file, lines, { mode: 0o600 });
      }
      return {};
    },
  };
}
