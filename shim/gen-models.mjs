import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const models = {
  "GPT-5.6-Sol (Codex)": { provider: "codex-oauth", model: "gpt-5.6-sol", reasoning_effort: "low" },
  "GPT-5.6-Terra (Codex)": { provider: "codex-oauth", model: "gpt-5.6-terra", reasoning_effort: "medium" },
  "GPT-5.6-Luna (Codex)": { provider: "codex-oauth", model: "gpt-5.6-luna", reasoning_effort: "max" },
};
const config = { default: "GPT-5.6-Luna (Codex)", models };
fs.writeFileSync(path.join(ROOT, "models.json"), `${JSON.stringify(config, null, 2)}\n`);
console.log(`models.json written with ${Object.keys(models).length} verified Codex models; per-account access is checked at inference time`);
