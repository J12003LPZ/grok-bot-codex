# grokbot-shim

Run the Grok Bot desktop agent locally with its original host agent loop and a
ChatGPT plan model backend.

The project connects the installed Grok Bot UI to its own local host runtime,
translates the app's inference protocol to the ChatGPT plan backend, and runs
the Computer environment on the same machine. The user can watch or take over
the desktop through noVNC.

The repository does not include application binaries. Setup extracts the
required runtime files from the user's installed copy of Grok Bot.

## Status

Windows: the installed Grok Bot 0.75.8 completes onboarding and answers chat
through the ChatGPT plan, end to end. See [Windows](#windows).

The inference adapter is covered by offline tests and a live subscription
request. On Linux a compatible Grok Bot host runtime is still required to
launch the complete desktop agent.

Known compatibility blocker in this environment: the official Grok Bot Linux
0.77.0 package and the installed Windows builds do not contain the legacy
`dist/host/host-main.cjs` entrypoint this shim's `run-all.sh` host launcher
expects. Setup detects this and stops before extraction. The 0.77.0 desktop UI
can be opened in an isolated profile and its local dev sign-in can reach the
shim, but this does not verify the new internal coordinator or restore the
missing host gateway. No inference request from the desktop app has been
observed yet. The current Linux package is available from the [official
download page](https://cursor.com/download/bot); the new host integration must
be adapted and tested before the complete agent loop can be claimed.

When a compatible host runtime is installed, the intended integration supports:

- local Grok Bot login and agent lifecycle;
- streamed text, reasoning state, and tool calls;
- OpenAI Sign in with ChatGPT through the public Responses API;
- model selection in the app's Settings screen;
- a local Chrome/XFCE Computer desktop with screenshots, input, and noVNC
  takeover.

The Grok Bot host and Connect protobuf integration rely on undocumented
application protocol details and may require updates when the desktop app
changes. The model path uses the documented Sign in with ChatGPT OAuth grant
and public Responses API.

## Requirements

- Linux with the Grok Bot desktop application installed;
- Node.js 22.12 or newer;
- Docker with a running daemon;
- OpenSSL and curl;
- one-time authorization of Grok Bot with your ChatGPT account and permission
  to use your ChatGPT plan. No API key is used.

The current `codex login` credential is not automatically reused. OpenAI's
documented plan-usage flow requires a separate user-approved grant with the
`chatgpt.tokens.use.direct` scope. `npm run auth` opens that official sign-in
flow and stores a separate credential under `~/.codex/grokbot-shim/`; it never
reads or overwrites `~/.codex/auth.json`.

On Windows, the installed Grok Bot 0.75.8 runs against the shim with Docker
Desktop and Git for Windows. See [Windows](#windows).

The default paths expect the executable at `/opt/Grok Bot/grok-bot`. Override
`GROKBOT_APP` and `GROKBOT_RESOURCES` when the application is installed
elsewhere.

## Quick start

```bash
git clone <your-repository-url>
cd grokbot-shim
npm ci
npm run doctor
npm run setup
npm run auth               # opens the official ChatGPT plan authorization
./run-all.sh
```

`npm run setup` generates a local TLS certificate and extracts the required
host runtime from your installed copy of Grok Bot. Those generated files stay
outside Git.

The first Computer start downloads a pinned container image of several
gigabytes. Once running, the desktop takeover page is available only on the
local machine at <http://127.0.0.1:6080/vnc.html>.

Check prerequisites at any time:

```bash
npm run doctor
```

## What runs locally

```text
Grok Bot UI ──► host gateway (:8550) ──► backend shim (:8443) ──► model
     │                  │
     │                  └── agent loop, shell, files, and tools
     │
     └── Computer container (:6080 noVNC, :1337 exec/health)
```

- `run-recon.sh` starts the desktop UI with an isolated profile in `appdata/`.
- `run-host.sh` starts the host runtime extracted from the installed app.
- `shim/server.mjs` handles local authentication, model metadata, experiments,
  and Connect-protocol inference streaming.
- `computerctl.sh` manages the local Computer desktop container.

All published services bind to `127.0.0.1` by default. Do not expose them to
an untrusted network.

## Model configuration

Models shown by the app are declared in `models.json`. The default is GPT-5.6
Luna. The selected model is checked against the signed-in account's model
catalog before an inference request.

```json
{
  "default": "GPT-5.6-Luna (Codex)",
  "models": {
    "GPT-5.6-Luna (Codex)": {
      "provider": "codex-oauth",
      "model": "gpt-5.6-luna",
      "reasoning_effort": "max"
    }
  }
}
```

`aliases` maps model ids the app requests on its own (such as `grok-4.5`) to
an entry in `models`.

The model catalog contains only verified OpenAI model IDs. Inference errors,
authentication failures, and plan limits are returned to Grok Bot; there is no
paid-provider fallback.

Authorization credentials live outside the repository at
`~/.codex/grokbot-shim/auth.json` (or under `CODEX_HOME`). The shim refreshes
rotating OAuth tokens against OpenAI's documented token endpoint. Do not copy
the credential file into the repo or send it to anyone.

## Commands

```bash
./run-all.sh                 # start Computer, shim, host, and desktop app
./computerctl.sh status      # inspect the Computer container
./computerctl.sh open        # open the noVNC takeover page
./computerctl.sh logs        # show recent Computer logs
./shimctl.sh status          # inspect the backend shim
./shimctl.sh restart         # restart the backend shim
npm run auth                 # authorize or refresh the separate ChatGPT grant
npm run check                # syntax validation
npm test                     # unit tests
```

Press `Ctrl+C` in the `run-all.sh` terminal to close the UI and stop the host
gateway and services the launcher started. Stop a separately started
Computer container with `./computerctl.sh stop` and the shim with
`./shimctl.sh stop`.

For debugging, components can be started separately in different terminals:

```bash
./computerctl.sh start
./shimctl.sh restart
./run-host.sh
./run-recon.sh
```

## Repository layout

- `shim/` — protocol definitions, inference adapter, OAuth authorization, and server;
- `scripts/setup.sh` — local certificate generation and app-runtime extraction;
- `scripts/doctor.sh` — prerequisite and generated-file checks;
- `models.json` — credential-free model catalog;
- `computerctl.sh` — Computer container lifecycle;
- `run-*.sh` — stack launchers;
- `test/` — unit tests.

The following are intentionally not versioned: the extracted `host/` runtime,
TLS keys and certificates, `appdata/`, `state/`, `logs/`, `node_modules/`, and
`.env`.

## How inference translation works

The host sends `aiserver.v1.InferenceService/Stream` requests using the Connect
protocol and binary protobuf messages. The shim decodes messages and the
agent's tool schema, calls `POST https://api.openai.com/v1/responses` with
`store: false` and `stream: true`, then streams compatible protobuf response
frames back. Client-side Grok Bot functions are sent through supported
`additional_tools` items and executed only by the Grok Bot host. Prior tool
results, images/screenshots, and opaque reasoning continuation data are
preserved in later requests. OpenAI plan limits are shared with other apps
using the same ChatGPT plan.

Assistant text inside the host loop is private working text. To communicate
with the user, a model must call the `SendMessage` tool supplied in the request.
For that reason, the selected model needs reliable function calling, not only
text generation.

## CLIProxyAPI compatibility

The shim already serves as the local protocol adapter: it translates Grok
Bot's Connect/protobuf inference stream into the public Responses API and
returns model, reasoning, and tool-call events to the Grok Bot harness. It
uses the separate, officially authorized Sign in with ChatGPT credential
described above. It does not read the Codex CLI credential file or require
CLIProxyAPI.

Do not point it at a multi-provider CLIProxyAPI instance unless that instance
is configured with Codex as its sole inference credential and has no other
provider fallback. CLIProxyAPI's automatic auth failover can route requests to
another matching credential. A Codex-only proxy configuration is not shipped
or enabled by default; the direct SIWC-to-Responses path is the tested mode.

## Compatibility limits

- The shim sends one Responses request for each Grok Bot inference turn. It does
  not run Codex CLI's agent loop; Grok Bot remains responsible for planning,
  browser/computer/shell tools, execution, and persistent history.
- ChatGPT plan inference is in OpenAI's documented preview flow. Model
  availability and account limits are checked by OpenAI at runtime. API-hosted
  computer use, audio, and video are not used; Grok Bot's local computer tool
  runs client-side and sends screenshots as image inputs.
- The shim currently stores one ChatGPT plan registration. Use the same
  account to reauthorize it; a different account needs its own credential
  store.
- The installed Grok Bot host protocol is undocumented and version-specific.
  The 0.77.0 Linux package tested here no longer exposes the legacy local host
  runtime this shim extracts, so the full harness cannot currently launch
  against that build. Supporting it needs a host bridge adapted and tested
  against the current package.

## Windows

Verified with the installed Windows Grok Bot 0.75.8, Docker Desktop and Git for
Windows. Chat turns run in the local box and their inference goes to your
ChatGPT plan; no Grok Bot subscription is used.

```powershell
npm ci
npm run auth      # once: Sign in with ChatGPT
npm run windows   # shim + box + app
```

`npm run windows` runs `scripts/grokbot-windows.ps1`, which:

1. builds `generated/` (message schemas read from the installed app's
   `app.asar`; nothing from the app is committed);
2. starts the shim on `http://localhost:8444` (loopback only, log in
   `state/shim.log`);
3. starts the box container with `computerctl.sh`;
4. opens Grok Bot in its own profile (`%LOCALAPPDATA%\grokbot-shim\profile`)
   with a local dev sign-in.

How 0.75.8 is wired:

- The agent host runs inside the box image, not in the app. The container is
  started with `SAND_BOX_AUTO_UPDATE=0` so it keeps the host baked into the
  image (1b18a85). Without it the supervisor downloads the newest published
  host, and hosts from ce1748b on refuse every local turn because chat moved
  to the vendor's servers.
- The shim stands in for the backend calls the app needs: sandbox URLs, the
  Bot roster (`state/agents.json`) and the inference stream.
- The app first asks the backend for a server-run Bot. The shim answers
  Unimplemented, so the app creates the Bot on the local box host instead.
- The app requests its built-in model ids (`grok-4.5` and variants).
  `models.json` maps them to Codex models through `aliases`; unknown ids still
  fail closed.

Set `SHIM_CLIENT_LOG=<file>` before starting the shim to write the app's own
log lines (normally sent to the vendor through `SubmitLogs`) to a local file.

The Linux flow below is unchanged. `npm run doctor` reports platform
prerequisites without changing the installation.

## Troubleshooting

The Computer panel draws nothing (an empty frame under "<agent>'s screen") when
the desktop app is started without `--no-sandbox` on its command line. The
preview is an Electron `<webview>` on the box's noVNC page and the app marks that
guest sandboxed, while its own in-process `no-sandbox` switch is applied too late
to reach the guest. The half-sandboxed guest renderer cannot allocate shared
memory, aborts on `/dev/shm`, and crash-loops, so the panel stays blank even
though the box, VNC server, and noVNC endpoint are all healthy. `run-recon.sh`
passes the flag for this reason. The fingerprint in `logs/app.out` is:

```text
ERROR:base/memory/platform_shared_memory_region_posix.cc:213] Creating shared memory in /dev/shm/... failed: No such process (3)
FATAL:base/memory/platform_shared_memory_region_posix.cc:218] This is frequently caused by incorrect permissions on /dev/shm.
```

The desktop takeover page at <http://127.0.0.1:6080/vnc.html> is served straight
from the container, so it keeps working regardless of this flag and is the quick
way to tell a preview problem from a Computer problem.

## Privacy and security

- The isolated Grok Bot profile does not modify the default application
  profile.
- Agent prompts, tool schemas, tool results, and screenshots are sent to
  OpenAI's public Responses API using the ChatGPT plan grant.
- Shim logs omit request headers, prompts, tool arguments, and response bodies.
- The noVNC page provides control of the Computer desktop. Keep it bound to
  loopback.

See `SECURITY.md` for vulnerability reporting guidance. The plan-use
integration is a documented public OAuth preview; account eligibility, model
availability, and supported capabilities remain controlled by OpenAI.

## Contributing

Contributions are welcome. Read `CONTRIBUTING.md`, run `npm run check` and
`npm test`, and confirm that no credentials or extracted application files are
included in the change.

## License

The original code in this repository is available under the ISC License. Grok
Bot, the extracted host runtime, the Computer image, and third-party model
services remain subject to their respective owners' terms and licenses.
