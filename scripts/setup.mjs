import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (process.platform !== "linux") {
  console.error("Grok Bot setup requires Linux. On Windows, run this project inside WSL2 with a Linux Grok Bot build and Docker Linux engine.");
  process.exit(1);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const result = spawnSync("bash", [path.join(root, "scripts", "setup.sh")], { cwd: root, stdio: "inherit" });
if (result.error) {
  console.error(`setup could not start: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
