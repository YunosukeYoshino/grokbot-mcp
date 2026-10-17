#!/usr/bin/env bash
# Verification scaffolding. Read-only tools/list against the running Worker.
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"
require_local_webhook

if [[ ! -f "$HITS" ]]; then
  echo "webhook hit log missing. Run launch.sh first." >&2
  exit 1
fi

before=$(wc -l < "$HITS" | tr -d ' ')
set +e
http=$(curl -sS -m 10 -D "$RUNTIME/doctor.headers" -o "$RUNTIME/doctor.body" -w "%{http_code}" \
  "http://127.0.0.1:${PORT}/mcp" \
  -H "Authorization: Bearer ${MCP_API_KEY}" \
  -H "content-type: application/json" \
  -H "accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')
curl_ec=$?
set -e
after=$(wc -l < "$HITS" | tr -d ' ')
printf '%s %s\n' "$before" "$after" > "$RUNTIME/doctor.hits"
printf '%s\n' "$http" > "$RUNTIME/doctor.http"
printf '%s\n' "$curl_ec" > "$RUNTIME/doctor.curl_exit"

if [[ "$curl_ec" -ne 0 || "$http" != "200" ]]; then
  echo "doctor failed: curl_exit=$curl_ec http=$http" >&2
  exit 1
fi
if [[ "$before" != "$after" ]]; then
  echo "doctor called the webhook (hits $before -> $after). tools/list must not." >&2
  exit 1
fi

js - "$RUNTIME/doctor.body" << 'EOF'
const fs = require("fs");
const raw = fs.readFileSync(process.argv[2], "utf8");
const line = raw.split(/\r?\n/).map((l) => l.trim()).find((l) => l.startsWith("data:"));
if (!line) {
  console.error("doctor: response was not an SSE data event");
  process.exit(1);
}
const msg = JSON.parse(line.slice(5).trim());
const names = (msg.result?.tools ?? []).map((t) => t.name).sort();
const want = ["ask_grokbot", "cancel_run", "get_grokbot_run", "wait_for_grokbot_answer"];
if (names.join() !== want.join()) {
  console.error("doctor: tool names " + names.join(","));
  process.exit(1);
}
console.log(names.join(" "));
EOF
echo "doctor_ok http=200 curl_exit=$curl_ec webhook_hits=$before"
