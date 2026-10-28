import path from "node:path";
import { fileURLToPath } from "node:url";
import protobuf from "protobufjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = protobuf.loadSync(path.join(ROOT, "shim", "sandbox.proto"));
const EnsureSandBoxResponse = root.lookupType("aiserver.v1.EnsureSandBoxResponse");
const GetSandBoxRunStateResponse = root.lookupType("aiserver.v1.GetSandBoxRunStateResponse");
const RUNNING = root.lookupEnum("aiserver.v1.SandBoxRunState").values.RUNNING;

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

function loopbackUrl(name, value) {
  const url = new URL(value);
  if (!LOOPBACK.has(url.hostname)) {
    throw new Error(`${name} must be a loopback URL, got ${url.hostname}`);
  }
  return value;
}

// The packaged app asks its backend for a cloud "box". Here the box is the
// local container started by computerctl.sh, so the response simply names its
// loopback endpoints.
export function boxConfig(env = process.env) {
  return {
    cluster: "local",
    tenantId: "local",
    podId: env.SHIM_BOX_POD_ID ?? "grokbot-computer",
    networkToken: env.SHIM_BOX_NETWORK_TOKEN ?? "shim-network-token",
    execDaemonUrl: loopbackUrl("SHIM_BOX_EXEC_URL", env.SHIM_BOX_EXEC_URL ?? "http://127.0.0.1:1337"),
    execDaemonAuthToken: env.SHIM_BOX_EXEC_TOKEN ?? "local",
    vncUrl: loopbackUrl("SHIM_BOX_VNC_URL", env.SHIM_BOX_VNC_URL ?? "http://127.0.0.1:6080/vnc.html"),
    gatewayUrl: loopbackUrl("SHIM_BOX_GATEWAY_URL", env.SHIM_BOX_GATEWAY_URL ?? "http://127.0.0.1:8550"),
    gatewayToken: env.SHIM_BOX_GATEWAY_TOKEN ?? "shim-gateway-token",
  };
}

function encode(type, payload) {
  const error = type.verify(payload);
  if (error) throw new Error(`invalid ${type.name}: ${error}`);
  return Buffer.from(type.encode(type.create(payload)).finish());
}

function decode(type, bytes) {
  return type.toObject(type.decode(bytes), { defaults: true, enums: String });
}

export function encodeEnsureSandBox(cfg = boxConfig()) {
  return encode(EnsureSandBoxResponse, {
    cluster: cfg.cluster,
    tenantId: cfg.tenantId,
    podId: cfg.podId,
    networkToken: cfg.networkToken,
    execDaemonAuthToken: cfg.execDaemonAuthToken,
    execDaemonUrl: cfg.execDaemonUrl,
    vncUrl: cfg.vncUrl,
    gatewayUrl: cfg.gatewayUrl,
    gatewayToken: cfg.gatewayToken,
    imageUpdateAvailable: false,
    runState: RUNNING,
  });
}

export function encodeRunState() {
  return encode(GetSandBoxRunStateResponse, { state: RUNNING, imageUpdateAvailable: false });
}

export const decodeEnsureSandBox = (bytes) => decode(EnsureSandBoxResponse, bytes);
export const decodeRunState = (bytes) => decode(GetSandBoxRunStateResponse, bytes);
