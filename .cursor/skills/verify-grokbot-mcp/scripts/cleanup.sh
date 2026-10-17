#!/usr/bin/env bash
# Verification scaffolding. Kills the PIDs this skill started. Does not delete evidence.
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

collect() {
  local pid=$1
  [[ -n "$pid" ]] || return 0
  [[ "$pid" =~ ^[0-9]+$ ]] || return 0
  [[ "$pid" -gt 1 ]] || return 0
  kill -0 "$pid" 2>/dev/null || return 0
  echo "$pid"
  local child
  for child in $(ps -o pid= --ppid "$pid" 2>/dev/null); do
    collect "$child"
  done
}

stop_pidfile() {
  local file=$1
  [[ -f "$file" ]] || return 0
  local pid
  pid=$(tr -d '[:space:]' < "$file")
  local ids=()
  while IFS= read -r id; do
    [[ -n "$id" ]] && ids+=("$id")
  done < <(collect "$pid")
  [[ ${#ids[@]} -eq 0 ]] && return 0
  local i
  for ((i=${#ids[@]}-1; i>=0; i--)); do
    kill "${ids[$i]}" 2>/dev/null || true
  done
  sleep 1
  for id in "${ids[@]}"; do
    if kill -0 "$id" 2>/dev/null; then
      kill -9 "$id" 2>/dev/null || true
    fi
  done
  for id in "${ids[@]}"; do
    if kill -0 "$id" 2>/dev/null; then
      echo "cleanup failed: pid $id still running (from $file)" >&2
      exit 1
    fi
  done
}

before=$(find "$EVIDENCE" -type f 2>/dev/null | sort | wc -l | tr -d ' ')
stop_pidfile "$RUNTIME/worker.pid"
stop_pidfile "$RUNTIME/stub.pid"
after=$(find "$EVIDENCE" -type f 2>/dev/null | sort | wc -l | tr -d ' ')
if [[ "$before" != "$after" ]]; then
  echo "cleanup removed evidence files (before=$before after=$after)" >&2
  exit 1
fi
echo "cleanup_ok evidence_files=$after"
