#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTAINER="${GROKBOT_COMPUTER_CONTAINER:-grokbot-computer}"
# The agent host runs inside this container (the box supervisor starts it) and
# calls the shim over plain HTTP on the Docker host.
SHIM_HTTP_PORT="${HTTP_PORT:-8444}"
# Random per-install token under state/ (mode 0600); the shim reads the same file.
GATEWAY_TOKEN="${SAND_GATEWAY_TOKEN:-$(node "$ROOT/shim/secrets.mjs" gateway)}"
IMAGE="${GROKBOT_COMPUTER_IMAGE:-public.ecr.aws/k0i0n2g5/cursorenvironments/universal@sha256:dcac90cba36653f261988b1c88d11b7655493d455c4af0a18c5991ddaa5da020}"

require_docker() {
  command -v docker >/dev/null 2>&1 || {
    echo "Docker is required for the packaged Grok Bot desktop runtime." >&2
    exit 1
  }
  docker info >/dev/null 2>&1 || {
    echo "Docker is installed but its daemon is not available." >&2
    exit 1
  }
}

exists() {
  docker container inspect "$CONTAINER" >/dev/null 2>&1
}

is_running() {
  [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null || true)" = "true" ]
}

is_ready() {
  local api_status
  curl -fsS --max-time 2 http://127.0.0.1:6080/vnc.html >/dev/null 2>&1 || return 1
  api_status="$(curl -sS --max-time 2 -o /dev/null -w '%{http_code}' http://127.0.0.1:1337/health 2>/dev/null)" || return 1
  # The pinned exec daemon responds 404 to GET /health; accept that response
  # as proof the HTTP listener is reachable, while rejecting server errors.
  [[ "$api_status" == "404" || "$api_status" =~ ^2[0-9]{2}$ ]]
}

wait_ready() {
  for _ in $(seq 1 120); do
    if is_ready; then
      echo "computer ready: http://127.0.0.1:6080/vnc.html"
      return 0
    fi
    sleep 0.5
  done
  echo "computer did not become ready; inspect: $0 logs" >&2
  return 1
}

start() {
  require_docker
  if exists; then
    if is_running; then
      echo "computer container already running: $CONTAINER"
    else
      docker start "$CONTAINER" >/dev/null
      echo "computer container started: $CONTAINER"
    fi
  else
    if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
      echo "pulling Grok Bot computer image (first run is several GB)..."
      docker pull "$IMAGE"
    fi
    # Git Bash/MSYS rewrites any argument that looks like a POSIX path (it turned
    # /shim-state/... into C:/Program Files/Git/shim-state/...). Turn that off and
    # hand docker a mixed-style host path (C:/Users/...) for the bind mount.
    export MSYS2_ARG_CONV_EXCL='*'
    # SAND_BOX_AUTO_UPDATE=0 keeps the host bundle baked into the image. Without
    # it the supervisor swaps in the newest published host on boot, and hosts
    # from ce1748b on refuse every local ("box") turn, so nothing would run here.
    # Only state/box (the box host's own token) is mounted. The rest of state/
    # holds the shim's signing key and the desktop's sign-in secret.
    mkdir -p "$ROOT/state/box"
    STATE_MOUNT="$ROOT/state/box"
    if command -v cygpath >/dev/null 2>&1; then STATE_MOUNT="$(cygpath -m "$ROOT/state/box")"; fi
    docker run -d \
      --name "$CONTAINER" \
      --restart unless-stopped \
      --shm-size=1g \
      -p 127.0.0.1:1337:1337 \
      -p 127.0.0.1:1338:1338 \
      -p 127.0.0.1:1339:1339 \
      -p 127.0.0.1:6080:6080 \
      -p 127.0.0.1:6081:6081 \
      -p 127.0.0.1:8550:8550 \
      --add-host=host.docker.internal:host-gateway \
      -e SAND_SUPERVISOR_ENABLED=1 \
      -e SAND_BOX_AUTO_UPDATE=0 \
      -e SAND_BACKEND_URL="http://host.docker.internal:${SHIM_HTTP_PORT}" \
      -e SAND_HOST_PORT=8550 \
      -e SAND_GATEWAY_BIND_HOST=0.0.0.0 \
      -e SAND_GATEWAY_TOKEN="$GATEWAY_TOKEN" \
      -e SAND_DEV_INFERENCE_TOKEN_FILE=/shim-state/host-token.json \
      -v "$STATE_MOUNT:/shim-state:ro" \
      -v grokbot-computer-workspace:/workspace \
      -v grokbot-computer-chrome:/home/box/chrome-profile \
      -v grokbot-computer-data:/home/box/sand-data \
      "$IMAGE" >/dev/null
    echo "computer container created: $CONTAINER"
  fi
  wait_ready
}

status() {
  require_docker
  if ! exists; then
    echo "computer absent: $CONTAINER"
    return 1
  fi
  if ! is_running; then
    echo "computer stopped: $CONTAINER"
    return 1
  fi
  if is_ready; then
    echo "computer ready: $CONTAINER (http://127.0.0.1:6080/vnc.html)"
    return 0
  fi
  echo "computer running but not ready: $CONTAINER"
  return 1
}

case "${1:-status}" in
  start) start ;;
  stop)
    require_docker
    if exists && is_running; then
      docker stop "$CONTAINER" >/dev/null
      echo "computer stopped: $CONTAINER"
    else
      echo "computer already stopped: $CONTAINER"
    fi
    ;;
  restart)
    require_docker
    if exists && is_running; then docker stop "$CONTAINER" >/dev/null; fi
    start
    ;;
  status) status ;;
  logs)
    require_docker
    docker logs --tail 200 "$CONTAINER"
    ;;
  open)
    status >/dev/null
    xdg-open http://127.0.0.1:6080/vnc.html
    ;;
  *)
    echo "usage: $0 {start|stop|restart|status|logs|open}" >&2
    exit 2
    ;;
esac
