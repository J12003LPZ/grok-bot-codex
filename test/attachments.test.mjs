import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { UPLOAD_PATH_PREFIX, createAttachments, extensionOf } from "../shim/attachments.mjs";
import { createRpc, loadGenerated } from "../shim/rpc.mjs";

const BOT = "06ebd73b-f925-4d24-9080-64eecedc55cf";

function setup() {
  const copied = [];
  const a = createAttachments({
    uploadBase: "http://127.0.0.1:8444",
    dir: fs.mkdtempSync(path.join(os.tmpdir(), "att-")),
    writeToBox: async (file, boxPath) => copied.push({ boxPath, bytes: fs.readFileSync(file) }),
  });
  return { a, copied };
}

const tokenOf = (begin) => new URL(begin.put.url).pathname.slice(UPLOAD_PATH_PREFIX.length);

test("an upload goes to the shim, then into the Bot's attachments folder", async () => {
  const { a, copied } = setup();
  const data = Buffer.from("PK\u0003\u0004 resumes");
  const begin = a.handlers.BeginGrokBotAttachmentUpload({ agentId: BOT, fileName: "Resumes.ZIP", sizeBytes: data.length });
  assert.equal(begin.mode, "GrokBotAttachmentUploadMode_SINGLE_PUT");
  assert.match(begin.put.url, /^http:\/\/127\.0\.0\.1:8444\/attachment-upload\//);

  assert.equal(a.receive(data, tokenOf(begin)).status, 200);
  const done = await a.handlers.CompleteGrokBotAttachmentUpload({ uploadToken: begin.uploadToken });
  const sha = crypto.createHash("sha256").update(data).digest("hex");
  assert.equal(done.alias, `/home/box/sand-data/agents/${BOT}/attachments/${sha}.zip`);
  assert.equal(done.sizeBytes, data.length);
  assert.equal(done.contentType, "application/zip");
  assert.deepEqual(copied, [{ boxPath: done.alias, bytes: data }]);

  assert.equal(a.receive(data, tokenOf(begin)).status, 404, "an upload URL works once");
});

test("uploads that don't match what was announced are refused", async () => {
  const { a, copied } = setup();
  const begin = a.handlers.BeginGrokBotAttachmentUpload({ agentId: BOT, fileName: "a.txt", sizeBytes: 5 });
  assert.equal(a.receive(Buffer.from("too long"), tokenOf(begin)).status, 400);
  const late = await a.handlers.CompleteGrokBotAttachmentUpload({ uploadToken: begin.uploadToken });
  assert.equal(late.refusal, "GrokBotAttachmentUploadRefusal_EXPIRED");

  const b2 = a.handlers.BeginGrokBotAttachmentUpload({ agentId: BOT, fileName: "a.txt", sizeBytes: 5 });
  const early = await a.handlers.CompleteGrokBotAttachmentUpload({ uploadToken: b2.uploadToken });
  assert.equal(early.refusal, "GrokBotAttachmentUploadRefusal_INCOMPLETE");

  const b3 = a.handlers.BeginGrokBotAttachmentUpload({ agentId: BOT, fileName: "a.txt", sizeBytes: 5, sha256Hex: "00".repeat(32) });
  a.receive(Buffer.from("hello"), tokenOf(b3));
  const wrong = await a.handlers.CompleteGrokBotAttachmentUpload({ uploadToken: b3.uploadToken });
  assert.equal(wrong.refusal, "GrokBotAttachmentUploadRefusal_SIZE_MISMATCH");
  assert.equal(copied.length, 0);

  assert.equal(a.receive(Buffer.from("x"), "made-up-token").status, 404);
});

test("a Bot id that could escape the agents folder is refused", () => {
  const { a } = setup();
  const r = a.handlers.BeginGrokBotAttachmentUpload({ agentId: "../../etc", fileName: "x", sizeBytes: 1 });
  assert.equal(r.mode, "GrokBotAttachmentUploadMode_REFUSED");
  assert.equal(extensionOf("evil.$(rm)"), "");
  assert.equal(extensionOf("photo.JPG"), ".jpg");
});

test("a box that is off is woken, and the file waits for it", async () => {
  const states = ["stopped", "starting", "running"];
  const copied = [];
  const a = createAttachments({
    uploadBase: "http://127.0.0.1:8444",
    dir: fs.mkdtempSync(path.join(os.tmpdir(), "att-")),
    writeToBox: async (file, boxPath) => copied.push({ boxPath, bytes: fs.readFileSync(file) }),
    box: { ensure: async () => states.shift() },
    retryMs: 1,
  });
  const begin = a.handlers.BeginGrokBotAttachmentUpload({ agentId: BOT, fileName: "a.txt", sizeBytes: 2 });
  a.receive(Buffer.from("hi"), tokenOf(begin));
  const done = await a.handlers.CompleteGrokBotAttachmentUpload({ uploadToken: begin.uploadToken });
  assert.equal(states.length, 0);
  assert.deepEqual(copied, [{ boxPath: done.alias, bytes: Buffer.from("hi") }]);
});

test("a copy that fails is tried again", async () => {
  let tries = 0;
  const a = createAttachments({
    uploadBase: "http://127.0.0.1:8444",
    dir: fs.mkdtempSync(path.join(os.tmpdir(), "att-")),
    writeToBox: async () => {
      if (++tries < 3) throw new Error("box went away");
    },
    retryMs: 1,
  });
  const begin = a.handlers.BeginGrokBotAttachmentUpload({ agentId: BOT, fileName: "a.txt", sizeBytes: 2 });
  a.receive(Buffer.from("hi"), tokenOf(begin));
  await a.handlers.CompleteGrokBotAttachmentUpload({ uploadToken: begin.uploadToken });
  assert.equal(tries, 3);
});

test("a slow box does not fail the send: the app gets its answer and the copy finishes later", async () => {
  let up = false;
  const copied = [];
  const a = createAttachments({
    uploadBase: "http://127.0.0.1:8444",
    dir: fs.mkdtempSync(path.join(os.tmpdir(), "att-")),
    writeToBox: async (file, boxPath) => copied.push({ boxPath, bytes: fs.readFileSync(file) }),
    box: { ensure: async () => (up ? "running" : "starting") },
    waitMs: 5,
    retryMs: 1,
  });
  const begin = a.handlers.BeginGrokBotAttachmentUpload({ agentId: BOT, fileName: "a.txt", sizeBytes: 2 });
  a.receive(Buffer.from("hi"), tokenOf(begin));
  const first = await a.handlers.CompleteGrokBotAttachmentUpload({ uploadToken: begin.uploadToken });
  assert.match(first.alias, /attachments\/[0-9a-f]{64}\.txt$/);
  assert.equal(copied.length, 0);

  const again = await a.handlers.CompleteGrokBotAttachmentUpload({ uploadToken: begin.uploadToken });
  assert.deepEqual(again, first, "a retried call gets the same answer");

  up = true;
  for (let i = 0; i < 100 && copied.length === 0; i++) await new Promise((r) => setTimeout(r, 2));
  assert.deepEqual(copied, [{ boxPath: first.alias, bytes: Buffer.from("hi") }]);
});

const generated = loadGenerated();
test("replies encode with the app's schema", { skip: !generated && "no generated/app.proto" }, async () => {
  const { a } = setup();
  const rpc = createRpc({ ...generated, handlers: a.handlers });
  const call = async (method, input, obj) => {
    const In = generated.root.lookupType(`aiserver.v1.${input}`);
    return rpc.unary(`/aiserver.v1.GrokBotService/${method}`, Buffer.from(In.encode(In.fromObject(obj)).finish()));
  };
  const Begin = generated.root.lookupType("aiserver.v1.BeginGrokBotAttachmentUploadResponse");
  const begin = Begin.toObject(Begin.decode(await call("BeginGrokBotAttachmentUpload", "BeginGrokBotAttachmentUploadRequest", { agentId: BOT, fileName: "n.txt", sizeBytes: 2 })), { enums: String, longs: Number });
  a.receive(Buffer.from("hi"), tokenOf(begin));
  const Done = generated.root.lookupType("aiserver.v1.CompleteGrokBotAttachmentUploadResponse");
  const done = Done.decode(await call("CompleteGrokBotAttachmentUpload", "CompleteGrokBotAttachmentUploadRequest", { uploadToken: begin.uploadToken }));
  assert.match(done.alias, /attachments\/[0-9a-f]{64}\.txt$/);
});
