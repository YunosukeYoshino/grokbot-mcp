# Cancel a run

## Sub-features

- `cancel_run` on a pending run returns `ok: true`, `status: "cancelled"`, `answer_text: null`, `answered_at: null`.
- `get_grokbot_run` after that cancel returns the same cancelled record.
- A callback after cancel returns HTTP `409` `{"error":"already_cancelled"}`.
- Cancelling an already cancelled run returns `ok: true` with that record.
- An unknown UUID returns `ok: false`, `error: "run_not_found"`. An answered run returns `error: "already_answered"`.

## How to get to it (user POV)

The caller has a pending `run_id` and does not want to keep waiting. They call `cancel_run` on `http://127.0.0.1:8787/mcp`. The Worker marks the Durable Object cancelled. A later answer from the callback URL is rejected.

## Driving it with curl

Preconditions: launch exited `0`, the loopback stub returned 2xx, and `ask_grokbot` with `wait_seconds: 0` returned `pending` for `$RUN_ID`. If the ask did not return `pending`, the cancel journey fails. Do not cancel a different id and treat that as this run.

```sh
curl -sS -D - http://127.0.0.1:8787/mcp \
  -H "Authorization: Bearer $MCP_API_KEY" \
  -H "content-type: application/json" \
  -H "accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"cancel_run","arguments":{"run_id":"'"$RUN_ID"'"}}}'
```

Pass: HTTP `200`, curl exit `0`, SSE text `status: "cancelled"` and `answered_at: null` for that `run_id`.

Confirm with `get_grokbot_run` using the same `run_id`. The get result must also be `cancelled`. Then POST `{"answer":"too-late"}` to the stub's `callback_url`. That response must be HTTP `409` `{"error":"already_cancelled"}`.

## Gotchas

- No pending run: the journey fails. `run_not_found` does not count as a cancel.
- Cancelling an answered run returns `already_answered` and leaves `answer_text` in place. That is not a successful cancel of a pending run.
- `cancel_run` does not call `CURSOR_WEBHOOK_URL`. The stub log must not grow on the cancel POST.
- A second dev server using the same `--persist-to` can cancel this run. Check the port in the URL before treating the state change as this process's action.
