#!/usr/bin/env bash
# Verification scaffolding for grokbot-mcp. Not part of the Worker.
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SKILL_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
ROOT=$(cd "$SKILL_DIR/../../.." && pwd)
RUNTIME="$SKILL_DIR/runtime"
EVIDENCE="$SKILL_DIR/evidence"
HITS="$RUNTIME/webhook-hits.jsonl"

PORT="${VERIFY_PORT:-8787}"
INSPECTOR_PORT="${VERIFY_INSPECTOR_PORT:-9229}"
STUB_PORT="${VERIFY_STUB_PORT:-8799}"
PERSIST="${VERIFY_PERSIST:-$RUNTIME/state}"

if [[ -x "$HOME/.bun/bin/bun" ]]; then
  export PATH="$HOME/.bun/bin:$PATH"
fi

mkdir -p "$RUNTIME" "$EVIDENCE"

ensure_bun() {
  if ! command -v bun >/dev/null 2>&1; then
    echo "bun is not on PATH. Install Bun, then run: bun install --frozen-lockfile" >&2
    exit 1
  fi
}

load_dev_vars() {
  local file="$ROOT/.dev.vars"
  if [[ ! -f "$file" ]]; then
    echo "missing $file" >&2
    return 1
  fi
  local line key val
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^[A-Z0-9_]+= ]] || continue
    key=${line%%=*}
    val=${line#*=}
    printf -v "$key" '%s' "$val"
    export "$key"
  done < "$file"
}

require_local_webhook() {
  load_dev_vars
  local expected_ip="http://127.0.0.1:${STUB_PORT}/webhook"
  local expected_local="http://localhost:${STUB_PORT}/webhook"
  case "${CURSOR_WEBHOOK_URL:-}" in
    "$expected_ip"|"$expected_local") ;;
    *)
      echo "Refusing to start or drive. CURSOR_WEBHOOK_URL must be ${expected_ip} so ask_grokbot hits the local stub and not a Grok Bot webhook." >&2
      echo "Current value is not that loopback URL. This script does not overwrite an existing .dev.vars." >&2
      exit 1
      ;;
  esac
  if [[ -z "${MCP_API_KEY:-}" || -z "${CALLBACK_SIGNING_SECRET:-}" || -z "${CURSOR_WEBHOOK_API_KEY:-}" ]]; then
    echo ".dev.vars is missing MCP_API_KEY, CALLBACK_SIGNING_SECRET, or CURSOR_WEBHOOK_API_KEY." >&2
    exit 1
  fi
}

port_open() {
  local port=$1
  curl -sS -m 1 -o /dev/null "http://127.0.0.1:${port}/" >/dev/null 2>&1
}

js() {
  if command -v node >/dev/null 2>&1; then
    node "$@"
  else
    bun "$@"
  fi
}
