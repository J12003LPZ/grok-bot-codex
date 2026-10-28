import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = [
  ...fs.readdirSync(path.join(root, "shim")).filter((name) => name.endsWith(".mjs")).map((name) => path.join(root, "shim", name)),
  ...fs.readdirSync(path.join(root, "scripts")).filter((name) => name.endsWith(".mjs")).map((name) => path.join(root, "scripts", name)),
  ...fs.readdirSync(path.join(root, "test")).filter((name) => name.endsWith(".mjs")).map((name) => path.join(root, "test", name)),
];

for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (process.platform !== "win32") {
  const scripts = ["run-all.sh", "run-host.sh", "run-recon.sh", "computerctl.sh", "shimctl.sh", "scripts/setup.sh", "scripts/doctor.sh", "scripts/load-env.sh"];
  const result = spawnSync("bash", ["-n", ...scripts.map((file) => path.join(root, file))], { cwd: root, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
} else {
  console.log("Skipped Bash syntax checks on Windows; run them inside WSL/Linux.");
}
