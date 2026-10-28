import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failed = false;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "ok" : "missing"}  ${label}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed = true;
};
const hasCommand = (name, args = ["--version"]) => spawnSync(name, args, { stdio: "ignore" }).status === 0;

const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
check(`Node.js ${process.version}`, nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 12));
const npmInstalled = process.platform === "win32"
  ? hasCommand("where.exe", ["npm"])
  : hasCommand("npm");
check("npm", npmInstalled);
check("Linux host", process.platform === "linux", process.platform === "win32" ? "use WSL2 with a Linux Grok Bot build" : os.platform());

if (process.platform === "linux") {
  const app = process.env.GROKBOT_APP ?? "/opt/Grok Bot/grok-bot";
  const resources = process.env.GROKBOT_RESOURCES ?? "/opt/Grok Bot/resources";
  check("Grok Bot executable", fs.existsSync(app), app);
  check("Grok Bot resources", fs.existsSync(path.join(resources, "app.asar")), resources);
  check("Docker CLI", hasCommand("docker", ["--version"]));
  check("Docker daemon", hasCommand("docker", ["info"]));
  check("OpenSSL", hasCommand("openssl", ["version"]));
  check("curl", hasCommand("curl", ["--version"]));
  check("local TLS certificate", fs.existsSync(path.join(root, "certs", "localhost.pem")));
  check("local TLS private key", fs.existsSync(path.join(root, "certs", "localhost.key")));
  check("extracted host runtime", fs.existsSync(path.join(root, "host", "dist", "host", "host-main.cjs")));
} else if (process.platform === "win32") {
  const wsl = spawnSync("wsl.exe", ["--list", "--quiet"], { encoding: "utf16le" });
  const distros = String(wsl.stdout ?? "").split(/\r?\n/).map((name) => name.replace(/^\uFEFF/, "").trim()).filter((name) => name && !/^docker-desktop(?:-data)?$/i.test(name));
  check("WSL2 Linux distro", wsl.status === 0 && distros.length > 0, "install a Linux distro and run the complete stack there");
  check("Docker Linux engine", hasCommand("docker.exe", ["info"]), "Docker Desktop Linux engine must be running");
}

if (!failed) console.log("ready");
else {
  console.error("doctor found missing prerequisites; this checkout does not install or modify Grok Bot itself");
  process.exitCode = 1;
}
