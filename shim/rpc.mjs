import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import protobuf from "protobufjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const GENERATED_DIR = path.join(ROOT, "generated");

const PACKAGE = "aiserver.v1";

// Connect error codes a handler may raise, with the HTTP status the Connect
// protocol pairs with each one for unary calls.
const HTTP_STATUS = {
  invalid_argument: 400,
  failed_precondition: 400,
  not_found: 404,
  already_exists: 409,
  permission_denied: 403,
  unimplemented: 501,
  internal: 500,
  unavailable: 503,
};

export class RpcError extends Error {
  constructor(code, message) {
    if (!(code in HTTP_STATUS)) throw new Error(`unknown Connect code: ${code}`);
    super(message);
    this.code = code;
    this.httpStatus = HTTP_STATUS[code];
  }

  body() {
    return JSON.stringify({ code: this.code, message: this.message });
  }
}

// The box host reaches the shim through Docker's host alias; the desktop app
// uses localhost. Some calls must answer the two differently.
export function callerOf(req) {
  const host = String(req.headers?.host ?? "").replace(/:\d+$/, "").toLowerCase();
  return host === "host.docker.internal" ? "box" : "desktop";
}

const STRING = new Set(["string"]);
const BOOL = new Set(["bool"]);
const NUMBER = new Set(["double", "float", "int32", "uint32", "sint32", "fixed32", "sfixed32", "int64", "uint64", "sint64", "fixed64", "sfixed64"]);

// protobufjs fromObject() converts leniently (the number 5 becomes "5"), which
// would hide handler bugs. Walk the reply and require the exact scalar kinds.
// Enums may be given by name or number.
function checkReply(Type, obj, where = Type.name) {
  if (obj === null || typeof obj !== "object") throw new Error(`${where}: object expected`);
  for (const [key, value] of Object.entries(obj)) {
    const field = Type.fields[key];
    if (!field) throw new Error(`${where}: unknown field "${key}"`);
    field.resolve();
    const here = `${where}.${key}`;
    const check = (v) => {
      if (field.map) return;
      if (field.resolvedType instanceof protobuf.Type) return checkReply(field.resolvedType, v, here);
      if (field.resolvedType instanceof protobuf.Enum) {
        if (typeof v !== "string" && typeof v !== "number") throw new Error(`${here}: enum name or number expected`);
        return;
      }
      if (STRING.has(field.type) && typeof v !== "string") throw new Error(`${here}: string expected`);
      if (BOOL.has(field.type) && typeof v !== "boolean") throw new Error(`${here}: boolean expected`);
      if (NUMBER.has(field.type) && typeof v !== "number") throw new Error(`${here}: number expected`);
    };
    if (field.repeated) {
      if (!Array.isArray(value)) throw new Error(`${here}: array expected`);
      value.forEach(check);
    } else if (value !== undefined && value !== null) {
      check(value);
    }
  }
}

// Typed unary RPCs on top of the schema generated from the installed app
// (scripts/gen-proto.mjs). A handler gets the decoded request and returns a
// plain object; this layer does the protobuf work. Methods without a handler
// are not claimed, so the server keeps its existing fallbacks for them.
export function createRpc({ root, rpcs, handlers }) {
  const byPath = new Map();
  for (const [route, info] of Object.entries(rpcs)) {
    const name = route.split("/").pop();
    if (typeof handlers[name] === "function" && info.kind === 0) byPath.set(route, { name, info });
  }
  const type = (name) => root.lookupType(`${PACKAGE}.${name}`);

  return {
    handles: (route) => byPath.has(route),

    async unary(route, body, ctx = {}) {
      const entry = byPath.get(route);
      if (!entry) throw new Error(`no handler for ${route}`);
      const { name, info } = entry;
      const In = type(info.input);
      const Out = type(info.output);
      let req;
      try {
        req = In.toObject(In.decode(body), { longs: Number, enums: String, defaults: false });
      } catch (err) {
        throw new Error(`${name}: bad request: ${err.message}`);
      }
      // RpcError passes through untouched so the server can send it as a Connect error.
      const reply = (await handlers[name](req, ctx)) ?? {};
      try {
        checkReply(Out, reply);
        const msg = Out.fromObject(reply);
        const err = Out.verify(msg);
        if (err) throw new Error(err);
        return Buffer.from(Out.encode(msg).finish());
      } catch (err) {
        throw new Error(`${name}: bad reply: ${err.message}`);
      }
    },
  };
}

export function loadGenerated(dir = GENERATED_DIR) {
  const protoFile = path.join(dir, "app.proto");
  const rpcFile = path.join(dir, "rpcs.json");
  if (!fs.existsSync(protoFile) || !fs.existsSync(rpcFile)) return null;
  return { root: protobuf.loadSync(protoFile), rpcs: JSON.parse(fs.readFileSync(rpcFile, "utf8")) };
}
