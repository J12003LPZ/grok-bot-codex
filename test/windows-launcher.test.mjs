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

const install = fs.readFileSync(new URL("../scripts/install-windows.ps1", import.meta.url), "utf8");

test("the schema is rebuilt when the app version changes, not by file time", () => {
  assert.match(ps1, /VersionInfo\.ProductVersion/);
  assert.match(ps1, /\$builtFor -ne \$appVersion/);
  assert.doesNotMatch(ps1, /LastWriteTime/);
});

test("-ShimOnly stops before opening the app", () => {
  assert.ok(ps1.indexOf("if ($ShimOnly)") < ps1.indexOf("Start-Process $App"));
});

test("install sets the sign-in variables per user and a logon task, and can undo both", () => {
  for (const v of ["SAND_BACKEND_URL", "SAND_DEV_LOGIN", "SAND_DEV_LOGIN_EMAIL"]) assert.match(install, new RegExp(`"${v}"`));
  assert.match(install, /SetEnvironmentVariable\([^)]*"User"\)/);
  assert.doesNotMatch(install, /"Machine"/);
  assert.match(install, /New-ScheduledTaskTrigger -AtLogOn/);
  assert.match(install, /-RunLevel Limited/);
  assert.match(install, /-ShimOnly/);
  assert.match(install, /if \(\$Uninstall\) \{[\s\S]*SetEnvironmentVariable\(\$v, \$null, "User"\)[\s\S]*Unregister-ScheduledTask/);
  assert.doesNotMatch(install, /shim@local/);
});

test("the box keeps its baked host bundle", () => {
  assert.match(ctl, /-e SAND_BOX_AUTO_UPDATE=0 /);
});

test("the launcher signs in with the per-install address, not a fixed one", () => {
  assert.match(ps1, /secrets\.mjs"\) desktop-login-email/);
  assert.doesNotMatch(ps1, /SAND_DEV_LOGIN_EMAIL = "shim@local"/);
});

test("only state/box is mounted into the box", () => {
  assert.match(ctl, /STATE_MOUNT="\$ROOT\/state\/box"/);
  assert.doesNotMatch(ctl, /STATE_MOUNT="\$ROOT\/state"$/m);
});

test("containers without the current layout label are recreated", () => {
  assert.match(ctl, /--label "grokbot\.layout=\$LAYOUT"/);
  assert.match(ctl, /grokbot\.layout"\}\}' "\$CONTAINER" 2>\/dev\/null\)" != "\$LAYOUT" \]; then[\s\S]*?docker rm -f "\$CONTAINER"/);
});
