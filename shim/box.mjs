import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The app asks the backend for its box (EnsureSandBox) before it talks to it,
// and polls GetSandBoxRunState while it waits. That is where the hosted
// backend wakes a cloud box, so the shim starts the local container there:
// the box comes up when the app needs it, not at login.
//
// States: "absent" (no container), "stopped", "starting" (container up, host
// gateway not answering yet), "running".

function dockerState(name) {
  return new Promise((resolve) => {
    execFile("docker", ["inspect", "-f", "{{.State.Running}}", name], { timeout: 5000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve(/No such object|no such container/i.test(String(err.message)) ? "absent" : "unknown");
      resolve(stdout.trim() === "true" ? "up" : "stopped");
    });
  });
}

async function gatewayHealthy(url) {
  try {
    const res = await fetch(new URL("/health", url), { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

// computerctl.sh creates the container with the right ports, mounts and env.
// On Windows it needs Git Bash (WSL's bash.exe cannot drive Docker Desktop's
// Windows CLI with these paths).
export function findBash(env = process.env, exists = fs.existsSync) {
  if (env.SHIM_BASH) return env.SHIM_BASH;
  if (process.platform !== "win32") return "bash";
  const candidates = [env.ProgramFiles, env["ProgramFiles(x86)"]].filter(Boolean).map((p) => path.join(p, "Git", "bin", "bash.exe"));
  return candidates.find((c) => exists(c)) ?? null;
}

export function startDetached(bash, log, { script = path.join(ROOT, "computerctl.sh"), args = ["start"], onExit = () => {} } = {}) {
  // "w", not "a": Git Bash cannot write to an append-only handle, so the
  // script's first echo fails and it exits before starting anything.
  const out = fs.openSync(log, "w");
  const child = spawn(bash, [script, ...args], {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", out, out],
    windowsHide: true,
  });
  child.on("exit", onExit);
  child.unref();
  fs.closeSync(out);
  return child;
}

export function createBoxController({
  name = "grokbot-computer",
  gatewayUrl = "http://127.0.0.1:8550",
  inspect = dockerState,
  healthy = gatewayHealthy,
  start = () => {
    const bash = findBash();
    if (!bash) throw new Error("Git Bash not found; cannot start the box");
    const boxLog = path.join(ROOT, "state", "box.log");
    return startDetached(bash, boxLog, {
      onExit: (code) => code && console.log(`[box] computerctl.sh start exited ${code}; see ${boxLog}`),
    });
  },
  cacheMs = 2000,
  startCooldownMs = 120_000,
  now = Date.now,
  log = (msg) => console.log(`[box] ${msg}`),
} = {}) {
  let cached = null;
  let startedAt = -Infinity;

  async function state() {
    if (cached && now() - cached.at < cacheMs) return cached.value;
    const docker = await inspect(name);
    let value;
    if (docker === "up") value = (await healthy(gatewayUrl)) ? "running" : "starting";
    else if (docker === "unknown") value = "starting"; // docker itself not answering yet (Docker Desktop booting)
    else value = docker;
    // A start we kicked off recently is still in flight even if docker has not caught up.
    if ((value === "absent" || value === "stopped") && now() - startedAt < startCooldownMs) value = "starting";
    cached = { at: now(), value };
    return value;
  }

  async function ensure() {
    const current = await state();
    if (current !== "absent" && current !== "stopped") return current;
    try {
      start();
      startedAt = now();
      cached = null;
      log(`${current}: starting ${name}`);
      return "starting";
    } catch (err) {
      log(`cannot start ${name}: ${err?.message ?? err}`);
      return current;
    }
  }

  return { state, ensure };
}
