import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createBoxController, findBash, startDetached } from "../shim/box.mjs";
import { decodeEnsureSandBox, decodeRunState, encodeEnsureSandBox, encodeRunState, boxConfig } from "../shim/sandbox.mjs";

function fake({ docker = "up", healthy = true } = {}) {
  let t = 0;
  const calls = { start: 0, inspect: 0 };
  const box = createBoxController({
    inspect: async () => (calls.inspect++, docker),
    healthy: async () => healthy,
    start: () => calls.start++,
    now: () => t,
    log: () => {},
  });
  return { box, calls, tick: (ms) => (t += ms) };
}

test("a running container with a healthy gateway is running and is not restarted", async () => {
  const { box, calls } = fake();
  assert.equal(await box.ensure(), "running");
  assert.equal(calls.start, 0);
});

test("a container that is up but whose gateway is not answering is starting", async () => {
  const { box } = fake({ healthy: false });
  assert.equal(await box.state(), "starting");
});

for (const docker of ["stopped", "absent"]) {
  test(`ensure starts a ${docker} box once and reports starting while it boots`, async () => {
    const { box, calls, tick } = fake({ docker });
    assert.equal(await box.state(), docker);
    assert.equal(await box.ensure(), "starting");
    tick(5000);
    assert.equal(await box.ensure(), "starting");
    assert.equal(calls.start, 1);
    tick(200_000); // cooldown over and docker still says not running: try again
    assert.equal(await box.ensure(), "starting");
    assert.equal(calls.start, 2);
  });
}

test("state is cached briefly so the app's polling does not spawn docker each time", async () => {
  const { box, calls, tick } = fake();
  await box.state();
  await box.state();
  assert.equal(calls.inspect, 1);
  tick(2500);
  await box.state();
  assert.equal(calls.inspect, 2);
});

test("a failing start leaves the reported state alone", async () => {
  const box = createBoxController({
    inspect: async () => "stopped",
    start: () => {
      throw new Error("no bash");
    },
    log: () => {},
  });
  assert.equal(await box.ensure(), "stopped");
});

test("box states map to the app's run states", () => {
  const cfg = boxConfig({ SHIM_BOX_GATEWAY_TOKEN: "x".repeat(32) });
  assert.equal(decodeEnsureSandBox(encodeEnsureSandBox(cfg, "stopped")).runState, "HIBERNATED");
  assert.equal(decodeRunState(encodeRunState("starting")).state, "STARTING");
  assert.equal(decodeRunState(encodeRunState("absent")).state, "ABSENT");
  assert.throws(() => encodeRunState("bogus"), /unknown box state/);
});

test("the start script can write to its log", { skip: !findBash() && "no bash" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "box-"));
  const script = path.join(dir, "s.sh");
  fs.writeFileSync(script, "set -e\necho hello\n");
  const log = path.join(dir, "box.log");
  const code = await new Promise((resolve) => startDetached(findBash(), log, { script, args: [], onExit: resolve }));
  assert.equal(code, 0);
  assert.equal(fs.readFileSync(log, "utf8").trim(), "hello");
});

test("findBash honours SHIM_BASH and finds Git Bash on Windows", () => {
  assert.equal(findBash({ SHIM_BASH: "/x/bash" }), "/x/bash");
  if (process.platform === "win32") {
    const env = { ProgramFiles: "C:\\PF" };
    assert.equal(findBash(env, (p) => p === "C:\\PF\\Git\\bin\\bash.exe"), "C:\\PF\\Git\\bin\\bash.exe");
    assert.equal(findBash(env, () => false), null);
  }
});
