import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const ps1 = fs.readFileSync(new URL("../scripts/grokbot-windows.ps1", import.meta.url), "utf8");
const ctl = fs.readFileSync(new URL("../computerctl.sh", import.meta.url), "utf8");

test("launcher points the app at the local shim with dev sign-in", () => {
  assert.match(ps1, /SAND_BACKEND_URL = "http:\/\/localhost:\$Port"/);
  assert.match(ps1, /SAND_DEV_LOGIN = "Ultra"/);
  assert.match(ps1, /--user-data-dir=/);
});

test("the renderer sandbox stays on unless -NoSandbox is passed", () => {
  assert.match(ps1, /\[switch\]\$NoSandbox/);
  assert.match(ps1, /if \(\$NoSandbox\) \{[^}]*"--no-sandbox"/s);
  assert.equal(ps1.match(/--no-sandbox/g).length, 2); // the warning text and the guarded flag
});

test("launcher never disables TLS checks", () => {
  for (const flag of [/ignore-certificate-errors/i, /NODE_TLS_REJECT_UNAUTHORIZED/]) assert.doesNotMatch(ps1, flag);
});

test("the box keeps its baked host bundle", () => {
  assert.match(ctl, /-e SAND_BOX_AUTO_UPDATE=0 /);
});
