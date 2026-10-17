---
name: verify-grokbot-mcp
description: Verify the grokbot-mcp Cloudflare Worker over HTTP (POST /mcp and POST /callbacks/{run_id}/{token}). Use when launching the local worker, checking that the MCP endpoint is worth driving, or proving a tool call against the loopback webhook stub.
---

# Verify grokbot-mcp

grokbot-mcp is a Cloudflare Worker. Callers use Streamable HTTP, not stdio.

Surfaces:

- `POST /mcp` with `Authorization: Bearer $MCP_API_KEY` or `X-API-Key: $MCP_API_KEY`. Tools: `ask_grokbot`, `wait_for_grokbot_answer`, `get_grokbot_run`, `cancel_run`.
- `POST /callbacks/{run_id}/{token}` with a JSON object. The token is `HMAC-SHA256(CALLBACK_SIGNING_SECRET, run_id)`. No `Authorization` header.
- Any other path returns `404` `{"error":"not_found"}`. `GET /mcp` returns `405`.

`ask_grokbot` POSTs `{message, run_id, callback_url}` to `CURSOR_WEBHOOK_URL`. Verification must keep that URL on the loopback stub this skill starts. Do not deploy, do not pass `--remote`, and do not point the URL at a Grok Bot webhook.

`bun run test` (`vitest run` with `@cloudflare/vitest-pool-workers`) calls `worker.fetch` inside the test runtime and mocks `fetch`. That is the regression suite. It does not drive a running `bun run dev`. The checks below use curl against the dev server.

## Launch

From the repo root, with Bun on `PATH`:

```sh
bun install --frozen-lockfile
.cursor/skills/verify-grokbot-mcp/scripts/launch.sh
```

`launch.sh` does three things:

1. If `.dev.vars` is missing, it writes gitignored local dummy values whose `CURSOR_WEBHOOK_URL` is `http://127.0.0.1:8799/webhook`. If `.dev.vars` exists and that URL is anything else, the script exits non-zero and does not start the worker.
2. Starts `scripts/webhook-stub.mjs` on `127.0.0.1:8799`. The stub appends each request to `.cursor/skills/verify-grokbot-mcp/runtime/webhook-hits.jsonl` and returns `200` `{}` for `POST /webhook`. It does not forward.
3. Starts the documented dev server:

```sh
CI=true bun run dev -- --local --ip 127.0.0.1 --port 8787 --inspector-port 9229 --persist-to .cursor/skills/verify-grokbot-mcp/runtime/state --show-interactive-dev-session=false
```

Overrides, all required together for a second stack: `VERIFY_PORT`, `VERIFY_INSPECTOR_PORT`, `VERIFY_STUB_PORT`, `VERIFY_PERSIST`. `.dev.vars` in this checkout has one webhook URL, so a second stack needs a different `CURSOR_WEBHOOK_URL` that matches its stub port. The helper refuses to launch when its worker port, inspector port, or stub port is already open.

Ready means usable, not merely listening. Both of these are true:

- `runtime/worker.log` contains `Ready on http://127.0.0.1:8787`.
- An unauthenticated `POST /mcp` returns HTTP `401` and body `{"error":"unauthorized"}`. That body means `MCP_API_KEY` is set. A missing key is HTTP `503` `{"error":"mcp_api_key_not_configured"}` and is not ready.

`launch.sh` prints `ready http://127.0.0.1:8787/mcp unauthenticated_post=401` and exits `0` only after that check. Wrangler may print `Your types might be out of date`; that warning is not a failure.

Two Worker processes can run side by side only with different `--port`, `--inspector-port`, and `--persist-to`. The same port, or the same inspector port, fails at startup with `Address already in use`. The same `--persist-to` (including the default `.wrangler/state` used by a plain `bun run dev`) still reaches Ready, and both processes see the same Run and Budget Durable Object state. This helper's default persist directory is `runtime/state`, not `.wrangler/state`.

## Doctor

One read-only check. It does not create a run.

```sh
.cursor/skills/verify-grokbot-mcp/scripts/doctor.sh
```

`doctor.sh` POSTs `tools/list` to `http://127.0.0.1:8787/mcp` with the bearer token from `.dev.vars` and `accept: application/json, text/event-stream`. Exit `0` only when curl's exit code is `0`, the HTTP status is `200`, the SSE `data:` event lists exactly `ask_grokbot`, `wait_for_grokbot_answer`, `get_grokbot_run`, and `cancel_run`, and `runtime/webhook-hits.jsonl` did not grow. It prints `doctor_ok` plus those names.

## Drive

Drive the running server with curl. Tool results are `text/event-stream`: one `data:` line of JSON-RPC, then `result.content[0].text`, which is itself a JSON string. Callback responses are plain JSON.

| Route | Method | Auth | Observed result |
| --- | --- | --- | --- |
| `/mcp` | POST | bearer or `X-API-Key` | `200` SSE for a listed or called tool; `401` `{"error":"unauthorized"}` without the key; `429` `{"error":"rate_limited"}` past 60/min; `503` `{"error":"mcp_api_key_not_configured"}` when the key is empty; `503` `{"error":"misconfigured"}` when `readConfig` rejects the vars |
| `/callbacks/{run_id}/{token}` | POST | HMAC token in the path | `200` `{"ok":true,"run_id":...}` the first time a pending run is answered |
| anything else | GET or POST | none | `404` `{"error":"not_found"}`. `GET /mcp` is `405` |

Mapped features and the curl that drives each one are in `.cursor/skills/verify-grokbot-mcp/features/`. The ask journey's executable session is:

```sh
.cursor/skills/verify-grokbot-mcp/scripts/drive-ask-grokbot.sh
```

That script POSTs this body to `/mcp`:

```json
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"ask_grokbot","arguments":{"message":"verify-local-ping","wait_seconds":0}}}
```

Exit `0` only when the tool result is `ok: true`, `status: "pending"`, `answer_text: null`, and the stub log gained exactly one `POST /webhook` on `127.0.0.1:8799` whose `message` and `run_id` match and whose `callback_url` points at `127.0.0.1:8787`. `webhook_failed`, `disabled`, or a hit on any other host fails the journey.

## Evidence

Write `.cursor/skills/verify-grokbot-mcp/evidence/ask-grokbot.txt` for the ask drive. `drive-ask-grokbot.sh` writes that file. Do not commit it (it is gitignored) and do not put `MCP_API_KEY` or `CURSOR_WEBHOOK_API_KEY` in it.

Capture curl's exit code, the HTTP status, the parsed tool JSON, and the new stub hit (`host`, `url`, `authorization_present`, body). Also record the doctor hit counts.

Proof rules:

- Real caller path. The request goes to the dev server's `/mcp` or `/callbacks/...` with curl. `bun run test` and any in-process `worker.fetch` do not count.
- Action plus resulting state. For `ask_grokbot` with `wait_seconds: 0` and a stub that returns `200`, the state in the tool result is `pending`. A journey that expects `answered` is proved only after a callback POST, then `get_grokbot_run` or the wait tool returns `answer_text`.
- Side effects. The stub log is the side effect. One accepted ask adds one hit. Doctor's `tools/list` adds none.
- Mocks. The only stand-in is the loopback stub. Production already isolates Grok Bot behind `CURSOR_WEBHOOK_URL`. The stub must not forward the body anywhere.
- Dry-run. `tools/list` is the dry-run. It passes only when the stub log length is the same before and after. A dry-run that grows the log, or an ask whose hit host is not `127.0.0.1`, fails. Do not replace a failed ask with the kill switch and call that the ask journey.

## Cleanup

```sh
.cursor/skills/verify-grokbot-mcp/scripts/cleanup.sh
```

The script reads `runtime/worker.pid` and `runtime/stub.pid`, collects those processes and their children, and signals those PIDs. It does not search by process name. It does not delete `.cursor/skills/verify-grokbot-mcp/evidence/`. It exits `0` only when those PIDs are gone and the evidence file count is unchanged. Run it after a failed launch or drive as well. `launch.sh` runs it itself when startup fails.

## Helpers

All of these are executable. Run them from the repo root.

```sh
bun install --frozen-lockfile
.cursor/skills/verify-grokbot-mcp/scripts/launch.sh
.cursor/skills/verify-grokbot-mcp/scripts/doctor.sh
.cursor/skills/verify-grokbot-mcp/scripts/drive-ask-grokbot.sh
.cursor/skills/verify-grokbot-mcp/scripts/cleanup.sh
```

`launch.sh` execs `.cursor/skills/verify-grokbot-mcp/scripts/webhook-stub.mjs` with `bun`. Do not run the stub on a public address. `scripts/common.sh` is sourced by the shell helpers; it loads `.dev.vars` and refuses a non-loopback webhook URL.
