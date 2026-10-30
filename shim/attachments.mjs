import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { STATE_DIR } from "./secrets.mjs";

// Chat attachments. The hosted backend gives the desktop a cloud upload URL
// and the agent later reads the file from cloud storage. Here the shim is the
// storage: the desktop PUTs the file to the shim, and on completion the shim
// copies it into the Bot's attachments folder in the box, the place the box
// host reads attachments from (its own uploads land there too, named by
// SHA-256). The returned alias is that path, so the host reads it as usual.
//
// (The other route, USE_BOX, makes the desktop call the host's
// uploadAttachmentChunk, which the pinned box host does not have.)

export const UPLOADS_DIR = path.join(STATE_DIR, "uploads");
export const UPLOAD_PATH_PREFIX = "/attachment-upload/";
export const LIMIT_BYTES = 512 * 1024 * 1024;
const SESSION_MS = 30 * 60 * 1000;
const BOX_AGENTS_DIR = "/home/box/sand-data/agents";

const SAFE_ID = /^[A-Za-z0-9-]{1,64}$/;
// The app gives CompleteGrokBotAttachmentUpload 20 seconds, so answer before
// that even when the box is still waking up.
const COMPLETE_WAIT_MS = 15_000;
const RETRY_MS = 2000;

// The extension the file keeps in the box: the uploaded name's, if plain.
export function extensionOf(fileName) {
  const ext = path.extname(String(fileName ?? "")).toLowerCase();
  return /^\.[a-z0-9]{1,10}$/.test(ext) ? ext : "";
}

const CONTENT_TYPES = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".pdf": "application/pdf", ".txt": "text/plain", ".md": "text/markdown", ".csv": "text/csv", ".json": "application/json", ".zip": "application/zip", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };

// Copies a local file into the box as `box` (the user the host runs as).
export function dockerWriteToBox(container = process.env.SHIM_BOX_CONTAINER ?? "grokbot-computer") {
  return (localFile, boxPath) =>
    new Promise((resolve, reject) => {
      const dir = path.posix.dirname(boxPath);
      const child = spawn(
        "docker",
        ["exec", "-i", "-u", "box", container, "sh", "-c", 'mkdir -p "$1" && cat > "$2.part" && mv "$2.part" "$2"', "sh", dir, boxPath],
        { windowsHide: true, stdio: ["pipe", "ignore", "pipe"] },
      );
      let err = "";
      child.stderr.on("data", (d) => (err += d));
      child.on("error", reject);
      child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`copying into the box failed (${code}): ${err.slice(0, 200)}`))));
      fs.createReadStream(localFile).on("error", reject).pipe(child.stdin);
    });
}

export function createAttachments({
  uploadBase,
  dir = UPLOADS_DIR,
  writeToBox = dockerWriteToBox(),
  box = { ensure: async () => "running" },
  now = Date.now,
  waitMs = COMPLETE_WAIT_MS,
  retryMs = RETRY_MS,
  log = (msg) => console.log(`[attachments] ${msg}`),
} = {}) {
  const sessions = new Map(); // upload token -> { agentId, fileName, sizeBytes, sha256Hex?, expiresAt, file, received, reply?, delivery? }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const removeFile = (s) => fs.rm(s.file, { force: true }, () => {});
  const drop = (token) => {
    const s = sessions.get(token);
    sessions.delete(token);
    if (s) removeFile(s);
  };
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // Wakes the box and copies the file in, retrying until it lands or the
  // session ends. The upload is kept on disk until then, so a box that is off
  // or restarting only delays the file.
  async function deliver(token, s, boxPath) {
    let lastError = "the box did not start";
    while (sessions.get(token) === s && now() < s.expiresAt) {
      try {
        if ((await box.ensure()) === "running") {
          await writeToBox(s.file, boxPath);
          removeFile(s);
          return;
        }
      } catch (err) {
        lastError = err?.message ?? String(err);
      }
      await pause(retryMs);
    }
    log(`gave up on ${boxPath}: ${lastError}`);
  }

  const handlers = {
    BeginGrokBotAttachmentUpload: (req) => {
      const sizeBytes = Number(req.sizeBytes ?? 0);
      if (!SAFE_ID.test(String(req.agentId ?? ""))) {
        return { mode: "GrokBotAttachmentUploadMode_REFUSED", refusal: "GrokBotAttachmentUploadRefusal_UNSUPPORTED_TYPE" };
      }
      if (sizeBytes > LIMIT_BYTES) {
        return { mode: "GrokBotAttachmentUploadMode_REFUSED", refusal: "GrokBotAttachmentUploadRefusal_TOO_LARGE", limitBytes: LIMIT_BYTES };
      }
      for (const [t, s] of sessions) if (s.expiresAt < now()) drop(t);
      const token = crypto.randomBytes(24).toString("base64url");
      const expiresAt = now() + SESSION_MS;
      sessions.set(token, {
        agentId: req.agentId,
        fileName: String(req.fileName ?? "file"),
        sizeBytes,
        sha256Hex: req.sha256Hex,
        expiresAt,
        file: path.join(dir, token),
        received: false,
      });
      return {
        mode: "GrokBotAttachmentUploadMode_SINGLE_PUT",
        uploadToken: token,
        limitBytes: LIMIT_BYTES,
        sessionExpiresAtMs: expiresAt,
        put: { url: `${uploadBase}${UPLOAD_PATH_PREFIX}${token}`, headers: {}, expiresAtMs: expiresAt },
      };
    },

    CompleteGrokBotAttachmentUpload: async (req) => {
      const s = sessions.get(req.uploadToken);
      if (!s || s.expiresAt < now()) {
        drop(req.uploadToken);
        return { refusal: "GrokBotAttachmentUploadRefusal_EXPIRED" };
      }
      if (!s.received) return { refusal: "GrokBotAttachmentUploadRefusal_INCOMPLETE" };
      if (s.reply) return s.reply; // the app retried a call it timed out on
      const bytes = fs.readFileSync(s.file);
      if (bytes.length !== s.sizeBytes) {
        drop(req.uploadToken);
        return { refusal: "GrokBotAttachmentUploadRefusal_SIZE_MISMATCH" };
      }
      const sha = crypto.createHash("sha256").update(bytes).digest("hex");
      if (s.sha256Hex && s.sha256Hex.toLowerCase() !== sha) {
        drop(req.uploadToken);
        return { refusal: "GrokBotAttachmentUploadRefusal_SIZE_MISMATCH" };
      }
      const ext = extensionOf(s.fileName);
      const boxPath = `${BOX_AGENTS_DIR}/${s.agentId}/attachments/${sha}${ext}`;
      s.reply = {
        alias: boxPath,
        fileName: s.fileName,
        sizeBytes: bytes.length,
        contentType: CONTENT_TYPES[ext] ?? "application/octet-stream",
      };
      // Normally done by the time this returns. If the box needs longer, the
      // copy carries on: the message that uses this file wakes the same box,
      // and a box that never starts fails that send with the app's own error.
      s.delivery = deliver(req.uploadToken, s, boxPath);
      let timer;
      await Promise.race([s.delivery, new Promise((resolve) => (timer = setTimeout(resolve, waitMs)))]);
      clearTimeout(timer);
      return s.reply;
    },

    AbortGrokBotAttachmentUpload: (req) => {
      drop(req.uploadToken);
      return {};
    },
  };

  // PUT /attachment-upload/<token> with the file as the body (already read by
  // the server). The token is the only credential: random, single-use, and
  // short-lived.
  function receive(body, token) {
    const s = sessions.get(token);
    if (!s || s.expiresAt < now() || s.received) return { status: 404, text: "unknown or used upload" };
    if (body.length !== s.sizeBytes) {
      drop(token);
      return { status: 400, text: "upload size differs from the announced size" };
    }
    fs.writeFileSync(s.file, body, { mode: 0o600 });
    s.received = true;
    return { status: 200, text: "" };
  }

  return { handlers, receive };
}
