# Fetch a run

## Sub-features

- `get_grokbot_run` returns the stored record: `ok`, `run_id`, `status`, `answer_text`, `created_at`, `answered_at`.
- `answer_text` and `answered_at` are null unless `status` is `answered`.
- An unknown UUID returns `ok: false`, `error: "run_not_found"`.
- A non-UUID `run_id` is a tool validation error (`isError: true`) and does not create a run.

## How to get to it (user POV)

The caller has a `run_id` from an earlier `ask_grokbot` and wants the current state without waiting. They call `get_grokbot_run` on `http://127.0.0.1:8787/mcp`.

## Driving it with curl

Preconditions: launch exited `0`, and `ask_grokbot` with `wait_seconds: 0` against the loopback stub returned `pending` for `$RUN_ID`. Without that run, the fetch-a-known-run journey fails.

```sh
curl -sS -D - http://127.0.0.1:8787/mcp \
  -H "Authorization: Bearer $MCP_API_KEY" \
  -H "content-type: application/json" \
  -H "accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_grokbot_run","arguments":{"run_id":"'"$RUN_ID"'"}}}'
```

Pass for a run that has not been answered: HTTP `200`, curl exit `0`, SSE text `status: "pending"`, `answer_text: null`, `answered_at: null`, same `run_id`.

A known-missing id, which does not require a prior ask:

```sh
curl -sS -D - http://127.0.0.1:8787/mcp \
  -H "Authorization: Bearer $MCP_API_KEY" \
  -H "content-type: application/json" \
  -H "accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"get_grokbot_run","arguments":{"run_id":"00000000-0000-4000-8000-000000000000"}}}'
```

That pass is HTTP `200` and SSE text `{"ok":false,"error":"run_not_found","run_id":"00000000-0000-4000-8000-000000000000"}`. It does not prove that a real run was fetched.

## Gotchas

- If the preceding ask returned `webhook_failed`, there is no pending run to fetch. `get_grokbot_run` may still return the cancelled record, and the pending assertion fails.
- HTTP status stays `200` when the tool payload says `run_not_found`. The callback route's HTTP `404` is a different surface and needs a valid HMAC token. Do not require HTTP `404` from `get_grokbot_run`.
- `get_grokbot_run` does not call the webhook. A new stub hit during this curl means the journey is mixed with an ask.
- Two dev servers that share `--persist-to` return the same run. A pass on the wrong port can be the other process's state. Use the persist directory from the launch you intend to drive.
