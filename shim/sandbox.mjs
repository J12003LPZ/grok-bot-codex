import path from "node:path";
import { fileURLToPath } from "node:url";
import protobuf from "protobufjs";
import { loadOrCreateToken, STATE_DIR } from "./secrets.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = protobuf.loadSync(path.join(ROOT, "shim", "sandbox.proto"));
const EnsureSandBoxResponse = root.lookupType("aiserver.v1.EnsureSandBoxResponse");
const GetSandBoxRunStateResponse = root.lookupType("aiserver.v1.GetSandBoxRunStateResponse");
const RUN_STATE = root.lookupEnum("aiserver.v1.SandBoxRunState").values;

// box.mjs state -> the app's SandBoxRunState. A stopped container is what the
// app calls hibernated: it shows "waking" and keeps polling.
const BOX_STATE = {
  absent: RUN_STATE.ABSENT,
  stopped: RUN_STATE.HIBERNATED,
  starting: RUN_STATE.STARTING,
  running: RUN_STATE.RUNNING,
};

function runStateOf(boxState) {
  const value = BOX_STATE[boxState];
  if (value === undefined) throw new Error(`unknown box state: ${boxState}`);
  return value;
}

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
function gatewayToken(env, stateDir) {
  const fromEnv = env.SHIM_BOX_GATEWAY_TOKEN;
  if (fromEnv === undefined) return loadOrCreateToken("gateway", stateDir);
  if (fromEnv.length < 32) throw new Error("SHIM_BOX_GATEWAY_TOKEN must be at least 32 characters");
  return fromEnv;
}

export function boxConfig(env = process.env, stateDir = STATE_DIR) {
  return {
    cluster: "local",
    tenantId: "local",
    podId: env.SHIM_BOX_POD_ID ?? "grokbot-computer",
    networkToken: env.SHIM_BOX_NETWORK_TOKEN ?? "shim-network-token",
    execDaemonUrl: loopbackUrl("SHIM_BOX_EXEC_URL", env.SHIM_BOX_EXEC_URL ?? "http://127.0.0.1:1337"),
    // The exec daemon's token is fixed by the box image's start script
    // (`--auth-token local`); the port is only published on 127.0.0.1.
    execDaemonAuthToken: env.SHIM_BOX_EXEC_TOKEN ?? "local",
    vncUrl: loopbackUrl("SHIM_BOX_VNC_URL", env.SHIM_BOX_VNC_URL ?? "http://127.0.0.1:6080/vnc.html"),
    gatewayUrl: loopbackUrl("SHIM_BOX_GATEWAY_URL", env.SHIM_BOX_GATEWAY_URL ?? "http://127.0.0.1:8550"),
    gatewayToken: gatewayToken(env, stateDir),
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

export function encodeEnsureSandBox(cfg = boxConfig(), boxState = "running") {
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
    runState: runStateOf(boxState),
  });
}

export function encodeRunState(boxState = "running") {
  return encode(GetSandBoxRunStateResponse, { state: runStateOf(boxState), imageUpdateAvailable: false });
}

export const decodeEnsureSandBox = (bytes) => decode(EnsureSandBoxResponse, bytes);
export const decodeRunState = (bytes) => decode(GetSandBoxRunStateResponse, bytes);
