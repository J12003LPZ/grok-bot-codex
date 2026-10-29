import test from "node:test";
import assert from "node:assert/strict";
import { attachmentHandlers } from "../shim/attachments.mjs";
import { createRpc, loadGenerated } from "../shim/rpc.mjs";

const generated = loadGenerated();

test("uploads go to the Bot's computer, since there is no cloud storage", { skip: !generated && "no generated/app.proto" }, async () => {
  const rpc = createRpc({ ...generated, handlers: attachmentHandlers() });
  const route = "/aiserver.v1.GrokBotService/BeginGrokBotAttachmentUpload";
  const In = generated.root.lookupType("aiserver.v1.BeginGrokBotAttachmentUploadRequest");
  const Out = generated.root.lookupType("aiserver.v1.BeginGrokBotAttachmentUploadResponse");
  const body = Buffer.from(In.encode(In.fromObject({ agentId: "bot-a", fileName: "resume.zip", sizeBytes: 213_000 })).finish());
  const reply = Out.toObject(Out.decode(await rpc.unary(route, body, { caller: "desktop" })), { enums: String });
  assert.equal(reply.mode, "GrokBotAttachmentUploadMode_USE_BOX");
});
