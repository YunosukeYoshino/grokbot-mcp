import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import { Budget } from "./budget";
import { readConfig, type Config } from "./config";
import { Run, type RunRecord } from "./run";

export { Budget, Run };

const MAX_CALLBACK_BYTES = 256 * 1024;
const MAX_MESSAGE_CHARS = 20_000;
const WEBHOOK_TIMEOUT_MS = 10_000;
const CALLBACK_PATH = /^\/callbacks\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/([0-9a-f]{64})$/;
const enc = new TextEncoder();

function json(body: unknown, status = 200) {
  return Response.json(body, { status });
}

function runStub(env: Env, runId: string) {
  return env.RUN.get(env.RUN.idFromName(runId));
}

/** 長さも漏らさないよう、ハッシュしてから比較する */
async function safeEqual(a: string, b: string) {
  const [x, y] = await Promise.all([a, b].map((v) => crypto.subtle.digest("SHA-256", enc.encode(v))));
  return crypto.subtle.timingSafeEqual(x, y);
}

/** callback token = HMAC-SHA256(CALLBACK_SIGNING_SECRET, run_id)。偽の callback を DO に届く前に弾くため */
export async function callbackToken(env: Env, runId: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(env.CALLBACK_SIGNING_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(runId));
  return Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, "0")).join("");
}

function capWait(cfg: Config, seconds: number) {
  return Math.min(Math.max(seconds, 0), cfg.MAX_WAIT_SECONDS);
}

async function isAuthorized(request: Request, env: Env) {
  const auth = request.headers.get("authorization") ?? "";
  const presented = request.headers.get("x-api-key") ?? auth.replace(/^Bearer\s+/i, "");
  return safeEqual(presented, env.MCP_API_KEY);
}

function runView(rec: RunRecord) {
  return {
    ok: true,
    run_id: rec.runId,
    status: rec.status,
    answer_text: rec.status === "answered" ? rec.answerText : null,
    created_at: new Date(rec.createdAt).toISOString(),
    answered_at: rec.status === "answered" ? new Date(rec.finishedAt).toISOString() : null,
  };
}

function summarize(rec: RunRecord) {
  switch (rec.status) {
    case "answered":
      return `Grok Bot answered: ${rec.answerText.slice(0, 200)}`;
    case "pending":
      return `No answer yet. Call wait_for_grokbot_answer with run_id=${rec.runId}, or cancel_run to stop.`;
    case "cancelled":
      return "The run was cancelled. Start a new ask_grokbot if needed.";
    case "expired":
      return "The run expired. Start a new ask_grokbot.";
  }
}

function result(body: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body) }] };
}

function notFound(runId: string) {
  return result({ ok: false, error: "run_not_found", run_id: runId });
}

function createServer(env: Env, cfg: Config, baseUrl: string) {
  const server = new McpServer({ name: "grokbot-mcp", version: "0.1.0" });

  server.registerTool(
    "ask_grokbot",
    {
      description:
        "Send a message to Grok Bot and wait for its answer. Returns status (pending/answered/cancelled/expired) and answer_text.",
      inputSchema: {
        message: z.string().min(1).max(MAX_MESSAGE_CHARS),
        wait_seconds: z.number().int().min(0).default(60),
      },
    },
    async ({ message, wait_seconds }) => {
      if (cfg.COST_KILL_SWITCH) return result({ ok: false, error: "disabled" });
      const budget = env.BUDGET.get(env.BUDGET.idFromName("global"));
      const taken = await budget.take(cfg.ASK_PER_MINUTE_LIMIT, cfg.ASK_DAILY_LIMIT);
      if (!taken.ok) return result(taken);

      const runId = crypto.randomUUID();
      const callbackUrl = `${baseUrl}/callbacks/${runId}/${await callbackToken(env, runId)}`;
      const stub = runStub(env, runId);
      await stub.create(runId);

      let webhookStatus: number | null = null;
      try {
        const res = await fetch(env.CURSOR_WEBHOOK_URL, {
          method: "POST",
          headers: { authorization: `Bearer ${env.CURSOR_WEBHOOK_API_KEY}`, "content-type": "application/json" },
          body: JSON.stringify({ message, run_id: runId, callback_url: callbackUrl }),
          signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
        });
        webhookStatus = res.status;
        await res.body?.cancel();
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      } catch (err) {
        await stub.cancel();
        // 4xx は受理されていないので枠を戻す。5xx・タイムアウト・通信断は相手側で走った可能性があるので戻さない
        if (webhookStatus !== null && webhookStatus >= 400 && webhookStatus < 500) await budget.refund();
        return result({ ok: false, error: "webhook_failed", webhook_status: webhookStatus, run_id: runId, detail: String(err) });
      }

      const rec = await stub.wait(capWait(cfg, wait_seconds) * 1000);
      return rec ? result({ ...runView(rec), summary: summarize(rec) }) : notFound(runId);
    },
  );

  server.registerTool(
    "wait_for_grokbot_answer",
    {
      description: "Wait for the answer of a pending run (capped by MAX_WAIT_SECONDS).",
      inputSchema: { run_id: z.string().uuid(), timeout_seconds: z.number().int().min(0).default(60) },
    },
    async ({ run_id, timeout_seconds }) => {
      const rec = await runStub(env, run_id).wait(capWait(cfg, timeout_seconds) * 1000);
      return rec ? result({ ...runView(rec), summary: summarize(rec) }) : notFound(run_id);
    },
  );

  server.registerTool(
    "get_grokbot_run",
    { description: "Fetch a run by run_id.", inputSchema: { run_id: z.string().uuid() } },
    async ({ run_id }) => {
      const rec = await runStub(env, run_id).get();
      return rec ? result(runView(rec)) : notFound(run_id);
    },
  );

  server.registerTool(
    "cancel_run",
    { description: "Cancel a pending run.", inputSchema: { run_id: z.string().uuid() } },
    async ({ run_id }) => {
      const res = await runStub(env, run_id).cancel();
      return res.ok ? result(runView(res.run)) : result({ ok: false, error: res.error, run_id });
    },
  );

  return server;
}

/** 上限を超えた時点で読むのをやめる（Content-Length なしのチャンク転送対策）。超えたら null */
async function readText(request: Request, limit: number): Promise<string | null> {
  if (!request.body) return "";
  const dec = new TextDecoder();
  let size = 0;
  let text = "";
  for await (const chunk of request.body) {
    size += chunk.byteLength;
    if (size > limit) return null;
    text += dec.decode(chunk, { stream: true });
  }
  return text + dec.decode();
}

async function handleCallback(request: Request, env: Env, runId: string, token: string) {
  // URL の token だけで認証する。偽物は body も読まず DO も起こさない
  if (!(await safeEqual(token, await callbackToken(env, runId)))) return json({ error: "invalid_token" }, 403);
  if (Number(request.headers.get("content-length") ?? 0) > MAX_CALLBACK_BYTES) return json({ error: "body_too_large" }, 413);
  const text = await readText(request, MAX_CALLBACK_BYTES);
  if (text === null) return json({ error: "body_too_large" }, 413);

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return json({ error: "body_must_be_object" }, 400);

  const obj = body as Record<string, unknown>;
  if (obj.run_id !== undefined && obj.run_id !== runId) return json({ error: "run_id_mismatch" }, 400);

  const res = await runStub(env, runId).resolve(obj);
  return json(res.body, res.status);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cfg = readConfig(env);

    const callback = url.pathname.match(CALLBACK_PATH);
    if (callback) {
      if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
      if (!env.CALLBACK_SIGNING_SECRET) return json({ error: "callback_secret_not_configured" }, 503);
      if (!cfg) return json({ error: "misconfigured" }, 503);
      return handleCallback(request, env, callback[1], callback[2]);
    }

    if (url.pathname === "/mcp") {
      if (!env.MCP_API_KEY) return json({ error: "mcp_api_key_not_configured" }, 503);
      if (!(await isAuthorized(request, env))) return json({ error: "unauthorized" }, 401);
      if (!(await env.MCP_RATE_LIMITER.limit({ key: "mcp" })).success) return json({ error: "rate_limited" }, 429);
      if (!cfg) return json({ error: "misconfigured" }, 503);
      const baseUrl = env.PUBLIC_BASE_URL ?? url.origin;
      return createMcpHandler(() => createServer(env, cfg, baseUrl))(request, env, ctx);
    }

    return json({ error: "not_found" }, 404);
  },
} satisfies ExportedHandler<Env>;
