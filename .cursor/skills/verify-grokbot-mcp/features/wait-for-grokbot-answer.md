# Wait for an answer

## Sub-features

- `wait_for_grokbot_answer` on a pending `run_id` returns `status: "answered"` and the `answer_text` once a callback is posted.
- `timeout_seconds: 0` returns the current record without waiting. On a pending run that is `pending`, not `answered`.
- An unknown `run_id` returns `ok: false`, `error: "run_not_found"` inside an HTTP `200` SSE response.

## How to get to it (user POV)

The caller already has a `run_id` from `ask_grokbot` whose summary says there is no answer yet. They call `wait_for_grokbot_answer` on `http://127.0.0.1:8787/mcp` and the tool blocks until the callback arrives or the timeout elapses. The callback is performed by whoever received `callback_url` (locally, that is the webhook stub log).

## Driving it with curl

Preconditions, all required: launch exited `0`, doctor exited `0`, and an `ask_grokbot` with `wait_seconds: 0` has returned `pending` with a `run_id` whose `callback_url` is in `runtime/webhook-hits.jsonl`. If any of those is missing, stop. The answered journey has failed.

Start the wait, then POST the callback before it times out:

```sh
curl -sS -D - http://127.0.0.1:8787/mcp \
  -H "Authorization: Bearer $MCP_API_KEY" \
  -H "content-type: application/json" \
  -H "accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"wait_for_grokbot_answer","arguments":{"run_id":"'"$RUN_ID"'","timeout_seconds":10}}}'
```

In another shell, using the `callback_url` from the stub hit:

```sh
curl -sS -D - -X POST "$CALLBACK_URL" \
  -H "content-type: application/json" \
  -d '{"run_id":"'"$RUN_ID"'","answer":"waited-answer"}'
```

Pass: the callback HTTP status is `200` with `{"ok":true,"run_id":...}`, and the wait tool's SSE text has `status: "answered"` and `answer_text: "waited-answer"`. curl exit `0` on both.

## Gotchas

- No pending `run_id` from a 2xx ask: the wait returns `run_not_found`. Do not invent a `run_id`. The journey fails.
- If the callback POST does not happen before the wait returns, the tool result stays `pending`. That fails the answered journey. `timeout_seconds: 0` is the peek sub-feature, not a pass for "the answer arrived".
- `timeout_seconds` is capped by `MAX_WAIT_SECONDS` (`180` in `wrangler.jsonc`, hard max `300`). A request for longer than the cap still stops at the cap.
- The callback needs the token from the stub. A forged 64-hex token returns HTTP `403` `{"error":"invalid_token"}` and does not answer the run.
- This tool does not call `CURSOR_WEBHOOK_URL`. A new line in the stub log during the wait means something else called `ask_grokbot`.
