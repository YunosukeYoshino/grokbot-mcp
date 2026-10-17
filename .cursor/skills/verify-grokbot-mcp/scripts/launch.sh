#!/usr/bin/env bash
# Verification scaffolding. Starts a loopback webhook stub and `bun run dev`.
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

failed=1
trap 'ec=$?; if [[ ${failed:-0} -eq 1 ]]; then "$SCRIPT_DIR/cleanup.sh" || true; fi; exit "$ec"' EXIT

ensure_bun
if [[ ! -x "$ROOT/node_modules/.bin/wrangler" ]]; then
  echo "wrangler is not installed. From $ROOT run: bun install --frozen-lockfile" >&2
  exit 1
fi

if [[ ! -f "$ROOT/.dev.vars" ]]; then
  cat > "$ROOT/.dev.vars" << EOF
CURSOR_WEBHOOK_URL=http://127.0.0.1:${STUB_PORT}/webhook
CURSOR_WEBHOOK_API_KEY=verify-local-webhook-key
MCP_API_KEY=verify-local-mcp-key
CALLBACK_SIGNING_SECRET=verify-local-callback-secret
EOF
  echo "wrote $ROOT/.dev.vars with local dummy values (gitignored)"
fi
require_local_webhook

if [[ -f "$RUNTIME/worker.pid" ]] && kill -0 "$(tr -d '[:space:]' < "$RUNTIME/worker.pid")" 2>/dev/null; then
  echo "worker pid $(cat "$RUNTIME/worker.pid") is already running. Run cleanup.sh before launching again." >&2
  exit 1
fi
if port_open "$PORT"; then
  echo "127.0.0.1:$PORT is already open. Pick another VERIFY_PORT or stop that process by its own pid." >&2
  exit 1
fi
if port_open "$STUB_PORT"; then
  echo "127.0.0.1:$STUB_PORT is already open. Pick another VERIFY_STUB_PORT." >&2
  exit 1
fi
if port_open "$INSPECTOR_PORT"; then
  echo "127.0.0.1:$INSPECTOR_PORT is already open. Pick another VERIFY_INSPECTOR_PORT." >&2
  exit 1
fi

mkdir -p "$PERSIST"
: > "$HITS"

(
  cd "$ROOT"
  export STUB_PORT HITS_PATH="$HITS"
  exec bun "$SCRIPT_DIR/webhook-stub.mjs"
) > "$RUNTIME/stub.log" 2>&1 &
echo $! > "$RUNTIME/stub.pid"

stub_ready=0
for _ in $(seq 1 50); do
  if grep -q "webhook stub ready" "$RUNTIME/stub.log" 2>/dev/null; then
    stub_ready=1
    break
  fi
  sleep 0.2
done
if [[ "$stub_ready" -ne 1 ]]; then
  echo "webhook stub did not become ready. See $RUNTIME/stub.log" >&2
  exit 1
fi

(
  cd "$ROOT"
  export CI=true
  exec bun run dev -- --local --ip 127.0.0.1 --port "$PORT" --inspector-port "$INSPECTOR_PORT" --persist-to "$PERSIST" --show-interactive-dev-session=false
) > "$RUNTIME/worker.log" 2>&1 &
echo $! > "$RUNTIME/worker.pid"

ready=0
for _ in $(seq 1 100); do
  if grep -q "Ready on http://127.0.0.1:${PORT}" "$RUNTIME/worker.log" 2>/dev/null; then
    set +e
    http=$(curl -sS -m 2 -o "$RUNTIME/ready.body" -w "%{http_code}" \
      "http://127.0.0.1:${PORT}/mcp" \
      -H "content-type: application/json" \
      -H "accept: application/json, text/event-stream" \
      -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')
    curl_ec=$?
    set -e
    if [[ "$curl_ec" -eq 0 && "$http" == "401" && "$(cat "$RUNTIME/ready.body")" == '{"error":"unauthorized"}' ]]; then
      ready=1
      break
    fi
  fi
  sleep 0.3
done

if [[ "$ready" -ne 1 ]]; then
  echo "worker is not usable on http://127.0.0.1:${PORT}/mcp. See $RUNTIME/worker.log" >&2
  exit 1
fi

echo "ready http://127.0.0.1:${PORT}/mcp unauthenticated_post=401"
failed=0
