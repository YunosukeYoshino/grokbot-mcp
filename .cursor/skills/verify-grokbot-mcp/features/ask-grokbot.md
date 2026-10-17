# Ask Grok Bot

## Sub-features

- `ask_grokbot` with `wait_seconds: 0` stores a pending run and returns `answer_text: null` when the webhook returns a 2xx.
- The webhook body is `{message, run_id, callback_url}` and `callback_url` is `http://127.0.0.1:8787/callbacks/{run_id}/{token}`.
- A later `POST` of `{"answer":"..."}` to that callback URL answers the run (`200` `{"ok":true,"run_id":...}`).
- A non-2xx webhook returns `ok: false`, `error: "webhook_failed"`, and cancels the run. That is not the pending journey.

## How to get to it (user POV)

The caller already connected to `/mcp` and calls the tool `ask_grokbot` with a message. Locally the Worker is `http://127.0.0.1:8787/mcp`. The Worker sends the message to the webhook URL in `.dev.vars` and waits up to `wait_seconds` (default 60, capped by `MAX_WAIT_SECONDS`, which is `180` in `wrangler.jsonc`) for a callback.

## Driving it with curl

Requires launch and a passing doctor. The webhook URL must be the loopback stub. This is the curl the helper runs:

```sh
curl -sS -D - http://127.0.0.1:8787/mcp \
  -H "Authorization: Bearer $MCP_API_KEY" \
  -H "content-type: application/json" \
  -H "accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"ask_grokbot","arguments":{"message":"verify-local-ping","wait_seconds":0}}}'
```

```sh
.cursor/skills/verify-grokbot-mcp/scripts/drive-ask-grokbot.sh
```

Pass means HTTP `200`, curl exit `0`, SSE tool text `{"ok":true,"status":"pending","answer_text":null,...}`, and exactly one new stub hit on `127.0.0.1:8799` `/webhook` for that `run_id`. Evidence is written to `.cursor/skills/verify-grokbot-mcp/evidence/ask-grokbot.txt`.

To observe the answered state, POST the stub's `callback_url` (no `Authorization` header):

```sh
curl -sS -D - -X POST "$CALLBACK_URL" \
  -H "content-type: application/json" \
  -d '{"ok":true,"run_id":"'"$RUN_ID"'","answer":"local-answer"}'
```

Then `get_grokbot_run` for that `run_id` must return `status: "answered"` and `answer_text: "local-answer"`. If `callback_url` was not in the stub log, this half of the journey fails.

## Gotchas

- If the stub is not running, or `CURSOR_WEBHOOK_URL` is not `http://127.0.0.1:8799/webhook`, do not start. A URL on `api2.cursor.sh` would call a real Grok Bot webhook. The helper exits before that.
- `webhook_failed` means the pending journey failed. A 4xx from the webhook refunds the ask budget; a 5xx, timeout, or connection drop does not. Do not retry until the stub returns 2xx and then claim the earlier call passed.
- `COST_KILL_SWITCH=1` returns `{"ok":false,"error":"disabled"}` and must not add a stub hit. That is a different outcome from a pending ask. Do not use it as a substitute when the pending journey fails.
- Default `wait_seconds` is 60, so omitting it holds the HTTP request open. The pending check uses `0`.
- `message` longer than 20000 characters returns a tool error (`isError: true`) and must not call the webhook.
- The first callback finalizes the answer. A second POST to the same URL returns HTTP `409` `{"error":"already_answered"}`.
- An empty `MCP_API_KEY` never reaches the tool. The response is HTTP `503` before the ask exists.
