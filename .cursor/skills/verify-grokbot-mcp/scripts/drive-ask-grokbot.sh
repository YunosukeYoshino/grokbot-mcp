#!/usr/bin/env bash
# Verification scaffolding. Drives ask_grokbot over HTTP and writes evidence.
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"
require_local_webhook

evidence="$EVIDENCE/ask-grokbot.txt"
status=1
write_evidence() {
  cat > "$evidence" << EOF
feature: ask-grokbot
surface: POST http://127.0.0.1:${PORT}/mcp
message: verify-local-ping
wait_seconds: 0
doctor_hits: ${doctor_hits:-missing}
hits_before: ${hits_before:-missing}
hits_after: ${hits_after:-missing}
curl_exit: ${curl_ec:-missing}
http_status: ${http:-missing}
result: ${result_text:-missing}
webhook_hit: ${hit_text:-missing}
dry_run: tools/list during doctor.sh must leave the webhook hit log unchanged. A pass is doctor_hits with equal before and after counts, and exactly one new hit from this ask, whose host is 127.0.0.1 and whose body does not mention cursor.sh.
pass: ${pass:-no}
EOF
}
trap 'write_evidence' EXIT

if [[ ! -f "$RUNTIME/doctor.hits" ]]; then
  echo "run doctor.sh before drive-ask-grokbot.sh" >&2
  exit 1
fi
doctor_hits=$(tr '\n' ' ' < "$RUNTIME/doctor.hits" | sed 's/ $//')
read -r doctor_before doctor_after < "$RUNTIME/doctor.hits"
if [[ "$doctor_before" != "$doctor_after" ]]; then
  echo "dry-run failed: doctor changed webhook hits ($doctor_hits)" >&2
  exit 1
fi

hits_before=$(wc -l < "$HITS" | tr -d ' ')
set +e
http=$(curl -sS -m 20 -D "$RUNTIME/ask.headers" -o "$RUNTIME/ask.body" -w "%{http_code}" \
  "http://127.0.0.1:${PORT}/mcp" \
  -H "Authorization: Bearer ${MCP_API_KEY}" \
  -H "content-type: application/json" \
  -H "accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"ask_grokbot","arguments":{"message":"verify-local-ping","wait_seconds":0}}}')
curl_ec=$?
set -e
hits_after=$(wc -l < "$HITS" | tr -d ' ')

set +e
parsed=$(js - "$RUNTIME/ask.body" "$HITS" "$hits_before" "$hits_after" "$STUB_PORT" "$PORT" << 'EOF'
const fs = require("fs");
const raw = fs.readFileSync(process.argv[2], "utf8");
const hits = fs.readFileSync(process.argv[3], "utf8").split("\n").filter(Boolean);
const before = Number(process.argv[4]);
const after = Number(process.argv[5]);
const stubPort = process.argv[6];
const workerPort = process.argv[7];
const line = raw.split(/\r?\n/).map((l) => l.trim()).find((l) => l.startsWith("data:"));
if (!line) {
  console.error("ask response had no SSE data event");
  process.exit(2);
}
const msg = JSON.parse(line.slice(5).trim());
if (msg.result?.isError) {
  console.error("tool error: " + JSON.stringify(msg.result));
  process.exit(3);
}
const body = JSON.parse(msg.result.content[0].text);
if (!(body.ok === true && body.status === "pending" && body.answer_text === null && typeof body.run_id === "string")) {
  console.error("unexpected ask result: " + JSON.stringify(body));
  process.exit(4);
}
if (after !== before + 1) {
  console.error("expected exactly one new webhook hit, got " + (after - before));
  process.exit(5);
}
const hit = JSON.parse(hits[after - 1]);
const sent = JSON.parse(hit.body);
if (hit.host !== `127.0.0.1:${stubPort}` || hit.url !== "/webhook" || hit.method !== "POST") {
  console.error("webhook hit was not the loopback stub: " + JSON.stringify({ host: hit.host, url: hit.url, method: hit.method }));
  process.exit(6);
}
if (JSON.stringify(hit).includes("cursor.sh")) {
  console.error("webhook hit mentions cursor.sh");
  process.exit(7);
}
if (sent.message !== "verify-local-ping" || sent.run_id !== body.run_id) {
  console.error("webhook payload does not match the tool result");
  process.exit(8);
}
const callback = new URL(sent.callback_url);
if (callback.hostname !== "127.0.0.1" || callback.port !== String(workerPort) || !callback.pathname.startsWith(`/callbacks/${body.run_id}/`)) {
  console.error("callback_url is not the local worker: " + sent.callback_url);
  process.exit(9);
}
if (!hit.authorization_present) {
  console.error("webhook hit had no authorization header");
  process.exit(10);
}
const summary = {
  run_id: body.run_id,
  status: body.status,
  answer_text: body.answer_text,
  webhook_host: hit.host,
  webhook_url: hit.url,
  callback_host: callback.host,
};
process.stdout.write(JSON.stringify(body) + "\n" + JSON.stringify({ host: hit.host, url: hit.url, authorization_present: hit.authorization_present, body: sent }));
EOF
)
parse_ec=$?
set -e
if [[ "$parse_ec" -eq 0 ]]; then
  result_text=${parsed%%$'\n'*}
  hit_text=${parsed#*$'\n'}
  if [[ "$curl_ec" -eq 0 && "$http" == "200" ]]; then
    status=0
    pass=yes
  fi
else
  result_text="parse_exit=${parse_ec}"
  hit_text="see stderr"
fi

if [[ "$status" -ne 0 ]]; then
  echo "ask_grokbot drive failed: curl_exit=${curl_ec:-} http=${http:-} parse_exit=${parse_ec:-}" >&2
  exit 1
fi
echo "drive_ok evidence=$evidence http=$http curl_exit=$curl_ec"
exit 0
