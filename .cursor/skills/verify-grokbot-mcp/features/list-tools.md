# List tools

## Sub-features

- Reject a missing or wrong key with HTTP `401` and `{"error":"unauthorized"}`.
- Accept the key on `Authorization: Bearer` or `X-API-Key`.
- `tools/list` returns `ask_grokbot`, `wait_for_grokbot_answer`, `get_grokbot_run`, and `cancel_run`.

## How to get to it (user POV)

The caller is an MCP client configured for Streamable HTTP. The URL is `http://127.0.0.1:8787/mcp` locally, or `https://<worker>.workers.dev/mcp` when deployed. The client sends the API key and asks for the tool list. This repo's README uses the same POST as the check that the four names are present.

## Driving it with curl

Requires `launch.sh` to have exited `0`. `doctor.sh` is this journey and also asserts the webhook stub log did not grow.

Unauthenticated:

```sh
curl -sS -D - http://127.0.0.1:8787/mcp \
  -H "content-type: application/json" \
  -H "accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Bearer token (value is `MCP_API_KEY` from `.dev.vars`):

```sh
curl -sS -D - http://127.0.0.1:8787/mcp \
  -H "Authorization: Bearer $MCP_API_KEY" \
  -H "content-type: application/json" \
  -H "accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

The passing body is `text/event-stream` with a `data:` line whose `result.tools` names are the four tools above. HTTP status `200`. curl exits `0`.

## Gotchas

- Connection refused means launch did not become ready. The journey fails.
- HTTP `503` `{"error":"mcp_api_key_not_configured"}` means `.dev.vars` has no `MCP_API_KEY`. Do not treat `503` as a successful list.
- HTTP `503` `{"error":"misconfigured"}` means `readConfig` rejected the vars (`src/config.ts`). A limit is not an integer in range, or `COST_KILL_SWITCH` is not `0` or `1`. With a valid key, listing tools is blocked until the vars pass. A request with no key is `401` before that check.
- HTTP `429` `{"error":"rate_limited"}` means the location limiter (60 requests per minute on `/mcp`) tripped. That is not a successful list.
- `GET /mcp` returns `405`. The client POST is the journey.
- The response is SSE, not a bare JSON document. A check that only runs `jq` on the raw body fails for that reason.
- `tools/list` must not add a line to `runtime/webhook-hits.jsonl`. If it does, the dry-run failed.
