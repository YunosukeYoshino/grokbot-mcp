<div align="center">

# grokbot-mcp

**English** | [日本語](README.ja.md)

A Cloudflare Worker that turns Grok Bot's (Cursor automation webhook) async callback into a synchronous MCP tool result.

[![CI](https://github.com/YunosukeYoshino/grokbot-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/YunosukeYoshino/grokbot-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare_Workers-F38020?logo=cloudflare&logoColor=white)](https://developers.cloudflare.com/workers/)
[![Durable Objects](https://img.shields.io/badge/Durable_Objects-F38020?logo=cloudflare&logoColor=white)](https://developers.cloudflare.com/durable-objects/)
[![MCP](https://img.shields.io/badge/MCP-Streamable_HTTP-000000?logo=modelcontextprotocol&logoColor=white)](https://modelcontextprotocol.io/)
[![Zod](https://img.shields.io/badge/Zod-3E67B1?logo=zod&logoColor=white)](https://zod.dev/)
[![Vitest](https://img.shields.io/badge/Vitest-6E9F18?logo=vitest&logoColor=white)](https://vitest.dev/)
[![Bun](https://img.shields.io/badge/Bun-000000?logo=bun&logoColor=white)](https://bun.sh/)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/YunosukeYoshino/grokbot-mcp)

</div>

```
MCP client ─ask_grokbot→ Worker ─POST {message, run_id, callback_url}→ Grok Bot
MCP client ←answer_text─ Worker ←POST /callbacks/{run_id}/{token} {answer}─ Grok Bot
```

## Structure

One run = one `Run` Durable Object. Waiters live in DO memory; state lives in DO storage.

| File | Role |
|---|---|
| `src/index.ts` | Worker entry. MCP tools, callback auth and intake, webhook dispatch |
| `src/run.ts` | `Run` DO. Run state, waiting, TTL / retention alarms |
| `src/budget.ts` | `Budget` DO. Per-minute and daily counters for `ask_grokbot` |
| `src/config.ts` | Validation of vars (fail-closed when invalid) |
| `test/bridge.test.ts` | Integration tests on the Workers runtime (vitest-pool-workers) |

## MCP tools (`POST /mcp`, `Authorization: Bearer $MCP_API_KEY` or `X-API-Key: $MCP_API_KEY`)

| Tool | Purpose |
|---|---|
| `ask_grokbot(message, wait_seconds=60)` | Send to the webhook and wait for the callback. Returns `webhook_failed` if the webhook fails |
| `wait_for_grokbot_answer(run_id, timeout_seconds=60)` | Keep waiting on a pending run |
| `get_grokbot_run(run_id)` | Fetch a run |
| `cancel_run(run_id)` | Cancel a pending run |

`status`: `pending` / `answered` / `cancelled` / `expired`. Waits are capped by `MAX_WAIT_SECONDS` (max 300). All of `/mcp` is limited by `MCP_RATE_LIMITER` (60 req/min, per location) and returns 429 beyond that.

## Callback (Grok Bot → Worker)

`callback_url` is `/callbacks/{run_id}/{token}`, where token is `HMAC-SHA256(CALLBACK_SIGNING_SECRET, run_id)`. The Worker verifies it before reading the body or waking a DO, so forged callbacks are rejected with 403 and incur no DO charges.
POST `{"answer": "..."}` to `callback_url`. If `run_id` is included it must match the URL, otherwise 400 `run_id_mismatch`.
The answer is extracted in the order `answer → message → content → text → output → result`; if none is present, the whole body as JSON becomes `answer_text`.
Responses: 403 `invalid_token`, 400 `invalid_json` / `body_must_be_object` / `run_id_mismatch`, 404 unknown run, 405 non-POST, 409 `already_answered` / `already_cancelled`, 410 expired, 413 over 256KB, 503 `callback_secret_not_configured` / `misconfigured`.

## Setup

**With the button:** Click Deploy to Cloudflare above. The repository is cloned into your GitHub / GitLab and deployed with its Durable Objects. Enter the four secrets (below) on the setup page.

**With the CLI:**

```sh
bun install
wrangler secret put CURSOR_WEBHOOK_URL
wrangler secret put CURSOR_WEBHOOK_API_KEY
wrangler secret put MCP_API_KEY        # openssl rand -hex 32
wrangler secret put CALLBACK_SIGNING_SECRET  # openssl rand -hex 32
bun run deploy
```

Create a Grok Bot routine (trigger: Webhook) and put its POST URL and Key into `CURSOR_WEBHOOK_URL` / `CURSOR_WEBHOOK_API_KEY`. Example Instructions (kept in Japanese, as used with the routine; translate as you like):

```text
Webhook で起動したら、ペイロードを読む。test: true / 空ボディ / 依頼文が無いものは無視する。
message を依頼文として扱い、回答を作る。ペイロードの run_id をそのままエコーし、新しい ID を発行しない。
1. callback_url に JSON を POST する（Content-Type: application/json、User-Agent: grokbot-bridge-callback/1。
   Authorization ヘッダは付けず、着信 webhook のキーは転送しない）。
   ボディ: {"ok": true, "run_id": "<着信UUID>", "answer": "<回答全文>"}
2. callback_url には疎通確認・test の POST を送らない。最初の POST が必ず回答全文であること。
3. 再送は通信エラーまたは 5xx のときだけ 1 回。4xx は再送しない。
4. このチャットには「回答: <要約>」「run_id: …」「callback: HTTP <ステータス>」だけを投稿する。
```

In short, the routine must: echo the incoming `run_id`, POST the full answer to `callback_url` with no `Authorization` header, retry once only on network errors or 5xx, and never send probe/test POSTs.

- Set the User-Agent explicitly. Python-urllib's default UA is blocked by Cloudflare with 1010 (403) before reaching the Worker.
- The first callback to arrive finalizes the answer (later ones get 409). A probe POST would become the answer.

## Connecting MCP clients

The transport is Streamable HTTP (not stdio). URL: `https://<worker>.workers.dev/mcp`, auth: `Authorization: Bearer <MCP_API_KEY>` (or `X-API-Key`).

Claude Code:

```sh
claude mcp add --transport http grokbot https://<worker>.workers.dev/mcp \
  --header "Authorization: Bearer $MCP_API_KEY"
```

JSON config (Claude Code's `.mcp.json` expands `${VAR}` from the environment; for clients that don't, write the value directly):

```json
{
  "mcpServers": {
    "grokbot": {
      "type": "http",
      "url": "https://<worker>.workers.dev/mcp",
      "headers": { "Authorization": "Bearer ${MCP_API_KEY}" }
    }
  }
}
```

Cursor's `mcp.json` has the same shape (`type` may be omitted). Never commit the key to the repository.

Check the connection (you should see the four tool names):

```sh
curl -s https://<worker>.workers.dev/mcp \
  -H "Authorization: Bearer $MCP_API_KEY" -H "content-type: application/json" \
  -H "accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | grep -o '"name":"[a-z_]*"'
```

## Local development

Copy `.dev.vars.example` to `.dev.vars`, fill in the values, and run `bun run dev`. Tests: `bun run test`. Type check: `bun run typecheck`.

## Cost guardrails

| Guardrail | What it caps | Where |
| --- | --- | --- |
| `ASK_PER_MINUTE_LIMIT` (default 10) | Global per-minute `ask_grokbot` count. Beyond it: `rate_limited` + `retry_after_seconds` | `wrangler.jsonc` vars |
| `ASK_DAILY_LIMIT` (default 200, UTC day) | Daily `ask_grokbot` count. Beyond it: `daily_limit_reached` | same |
| `COST_KILL_SWITCH="1"` | Stops `ask_grokbot` immediately (`disabled`) | same (deploy after changing) |
| `MCP_RATE_LIMITER` (60/min) | All `/mcp` calls (including wait / get). Beyond it: 429. Approximate, per location | `wrangler.jsonc` ratelimits |
| HMAC callback token | Body reads and DO wake-ups from forged callbacks | `CALLBACK_SIGNING_SECRET` |
| `message` 20,000 chars / webhook timeout 10 s | Per-request input size and webhook wait | constants in `src/index.ts` |
| `MAX_WAIT_SECONDS` / `CALLBACK_TTL_SECONDS` / `RUN_RETENTION_SECONDS` | Single wait, deadline for the answer, retention after finish (0 = keep forever) | vars |

Limits are counted exactly in a single DO, `Budget("global")`. A rejected ask creates neither a webhook call nor a Run DO.
An ask whose webhook returned 4xx was not accepted, so its slot is refunded. 5xx, timeouts (10 s) and connection drops may have been processed on the other side, so they are not refunded.
If a var is not a valid number, `/mcp` and callbacks return 503 `misconfigured` (the service never runs with limits disabled).

Remaining worst case (estimate): even if the daily limit is used up every day at maximum wait, the DOs stay around 800 requests and 4,500 GB-s per day, within the Free daily allowance and the Paid monthly free allowance. Grok Bot / Cursor usage is capped at `ASK_DAILY_LIMIT` per day.
Unauthenticated `/mcp` requests and callbacks with a bad token cost only Worker request charges ($0.30/M).

Set these up manually:
- Cloudflare dashboard → Billing → Billable Usage → budget alert (notifies only; it does not stop usage)
- A spend limit on the Cursor side

## License

[MIT](LICENSE). See [SECURITY.md](SECURITY.md) for reporting vulnerabilities.
