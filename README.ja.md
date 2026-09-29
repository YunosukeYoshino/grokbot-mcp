<div align="center">

# grokbot-mcp

[English](README.md) | **日本語**

Grok Bot（Cursor automation の webhook）の非同期 callback を、MCP ツールの同期的な結果に変換する Cloudflare Worker。

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

## 構成（Structure）

run 1件 = Durable Object `Run` 1つ。待機中の waiter は DO のメモリ上、状態は DO storage。

| ファイル | 役割 |
|---|---|
| `src/index.ts` | Worker 入口。MCP ツール、callback の認証・受信、webhook 送信 |
| `src/run.ts` | `Run` DO。run の状態、待機、TTL / retention の alarm |
| `src/budget.ts` | `Budget` DO。`ask_grokbot` の分間・日次の上限カウント |
| `src/config.ts` | vars の検証（不正なら fail-closed） |
| `test/bridge.test.ts` | Workers ランタイム上の統合テスト（vitest-pool-workers） |

## MCP ツール（`POST /mcp`、`Authorization: Bearer $MCP_API_KEY` または `X-API-Key: $MCP_API_KEY`）

| Tool | 用途 |
|---|---|
| `ask_grokbot(message, wait_seconds=60)` | webhook に送信し callback を待つ。webhook 失敗時は `webhook_failed` |
| `wait_for_grokbot_answer(run_id, timeout_seconds=60)` | pending の続きを待つ |
| `get_grokbot_run(run_id)` | run を取得 |
| `cancel_run(run_id)` | pending を取り消す |

`status`: `pending` / `answered` / `cancelled` / `expired`。待機は `MAX_WAIT_SECONDS`（上限 300）で打ち切り。`/mcp` 全体は `MCP_RATE_LIMITER`（60 回/分、ロケーション単位）で 429。

## Callback（Grok Bot → Worker）

`callback_url` は `/callbacks/{run_id}/{token}`、token は `HMAC-SHA256(CALLBACK_SIGNING_SECRET, run_id)`。Worker が body を読む前・DO を起こす前に検証するので、偽の callback は 403 で弾かれ DO 課金にならない。
`callback_url` に `{"answer": "..."}` を POST。`run_id` を含める場合は URL と一致しなければ 400 `run_id_mismatch`。
答えは `answer → message → content → text → output → result` の順で抽出し、どれもなければ body 全体の JSON を `answer_text` にする。
403 `invalid_token`、400 `invalid_json` / `body_must_be_object` / `run_id_mismatch`、404 不明な run、405 POST 以外、409 `already_answered` / `already_cancelled`、410 期限切れ、413 256KB 超、503 `callback_secret_not_configured` / `misconfigured`。

## セットアップ

**ボタンで:** 上の Deploy to Cloudflare を押すと、リポジトリが自分の GitHub / GitLab に複製され、Durable Object 込みでデプロイされる。設定画面で 4 つの secret（下記）を入力する。

**CLI で:**

```sh
bun install
wrangler secret put CURSOR_WEBHOOK_URL
wrangler secret put CURSOR_WEBHOOK_API_KEY
wrangler secret put MCP_API_KEY        # openssl rand -hex 32
wrangler secret put CALLBACK_SIGNING_SECRET  # openssl rand -hex 32
bun run deploy
```

Grok Bot の routine（トリガー: Webhook）を作り、POST 先と Key を `CURSOR_WEBHOOK_URL` / `CURSOR_WEBHOOK_API_KEY` に入れる。Instructions の例:

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

- User-Agent を明示する。Python-urllib 既定の UA は Cloudflare に 1010（403）で弾かれ、Worker まで届かない。
- 最初に届いた callback で回答が確定する（2 回目以降は 409）。probe を送ると probe の内容が回答になる。

## MCP クライアントの接続

transport は Streamable HTTP（stdio ではない）。URL は `https://<worker>.workers.dev/mcp`、認証は `Authorization: Bearer <MCP_API_KEY>`（または `X-API-Key`）。

Claude Code:

```sh
claude mcp add --transport http grokbot https://<worker>.workers.dev/mcp \
  --header "Authorization: Bearer $MCP_API_KEY"
```

JSON 設定（Claude Code の `.mcp.json` は `${VAR}` を環境変数で展開する。展開しないクライアントでは値を直接書く）:

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

Cursor の `mcp.json` も同じ形（`type` は省略可）。キーをリポジトリに commit しないこと。

接続確認（4 つのツール名が返れば OK）:

```sh
curl -s https://<worker>.workers.dev/mcp \
  -H "Authorization: Bearer $MCP_API_KEY" -H "content-type: application/json" \
  -H "accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | grep -o '"name":"[a-z_]*"'
```

## ローカル開発

ローカル開発は `.dev.vars.example` を `.dev.vars` にコピーして値を埋め、`bun run dev`。テストは `bun run test`、型チェックは `bun run typecheck`。

## コストガードレール

| ガードレール | 上限の対象 | 設定 |
| --- | --- | --- |
| `ASK_PER_MINUTE_LIMIT`（既定 10） | `ask_grokbot` の全体の分間件数。超えると `rate_limited` + `retry_after_seconds` | `wrangler.jsonc` vars |
| `ASK_DAILY_LIMIT`（既定 200、UTC 日） | `ask_grokbot` の日次件数。超えると `daily_limit_reached` | 同上 |
| `COST_KILL_SWITCH="1"` | `ask_grokbot` を即停止（`disabled`） | 同上（変更後に deploy） |
| `MCP_RATE_LIMITER`（60 回/分） | `/mcp` 全体の呼び出し数（wait / get を含む）。超えると 429。ロケーション単位の近似 | `wrangler.jsonc` ratelimits |
| HMAC callback token | 偽 callback による body 読み込みと DO 起動 | `CALLBACK_SIGNING_SECRET` |
| `message` 20,000 文字 / webhook タイムアウト 10 秒 | 1 件あたりの入力サイズ、webhook の待ち時間 | `src/index.ts` 定数 |
| `MAX_WAIT_SECONDS` / `CALLBACK_TTL_SECONDS` / `RUN_RETENTION_SECONDS` | 1 回の待機時間、回答待ちの期限、終了後の保存期間（0 = 削除しない） | vars |

上限は単一 DO `Budget("global")` で正確にカウントする。拒否された ask は webhook も Run DO も作らない。
webhook が 4xx を返した ask は受理されていないので枠を戻す。5xx・タイムアウト（10 秒）・通信断は相手側で処理された可能性があるので戻さない。
vars が数値として不正なら `/mcp` と callback は 503 `misconfigured` を返す（上限が効かない状態で動かさない）。

残る最悪ケース（推定）: 日次上限を毎日最大待機で使い切っても、DO は約 800 リクエスト・約 4,500 GB-s / 日で、Free の日次枠・Paid の月間無料枠に収まる。Grok Bot / Cursor 側の利用量は `ASK_DAILY_LIMIT` 件/日が上限になる。
`/mcp` への未認証リクエストと不正 token の callback は Worker リクエスト課金（$0.30/M）のみ。

手動で設定しておくもの:
- Cloudflare ダッシュボード → Billing → Billable Usage → 予算アラート（通知のみで停止はしない）
- Cursor 側の利用上限（spend limit）

## License

[MIT](LICENSE)。脆弱性の報告は [SECURITY.md](SECURITY.md) を参照。
