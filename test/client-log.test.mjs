import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { clientLogHandlers } from "../shim/client-log.mjs";

test("SubmitLogs appends one JSON line per entry when a file is set", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cl-")), "client.jsonl");
  const { SubmitLogs } = clientLogHandlers(file);
  assert.deepEqual(SubmitLogs({ logs: [{ message: "a" }, { message: "b" }] }), {});
  assert.deepEqual(SubmitLogs({}), {});
  const lines = fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines, [{ message: "a" }, { message: "b" }]);
});

test("SubmitLogs writes nothing without a file", () => {
  assert.deepEqual(clientLogHandlers(undefined).SubmitLogs({ logs: [{ message: "a" }] }), {});
});
