import { env, listDurableObjectIds, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { callbackToken } from "../src/index";
import { extractAnswerText, type RunRecord } from "../src/run";

const BASE = "https://bridge.test";
const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;

function call(path: string, init: RequestInit = {}) {
  return worker.fetch(new Request(BASE + path, init) as Request<unknown, IncomingRequestCfProperties>, env, ctx);
}

let rpcId = 0;
async function mcp(method: string, params: unknown, auth: Record<string, string> = { authorization: "Bearer test-key" }) {
  const res = await call("/mcp", {
    method: "POST",
    headers: {
      ...auth,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  return res;
}

async function tool(name: string, args: Record<string, unknown>) {
  const res = await mcp("tools/call", { name, arguments: args });
  expect(res.status).toBe(200);
  const text = await res.text();
  const json = text.startsWith("{") ? JSON.parse(text) : JSON.parse(text.split("\n").find((l) => l.startsWith("data:"))!.slice(5));
  return JSON.parse(json.result.content[0].text);
}

/** webhook を捕捉し、送られた body を返す */
function captureWebhook(status = 200) {
  const sent: any[] = [];
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input as RequestInfo, init);
    if (req.url === env.CURSOR_WEBHOOK_URL) {
      sent.push({ auth: req.headers.get("authorization"), body: await req.json(), signal: init?.signal });
      return new Response("{}", { status });
    }
    return realFetch(input as RequestInfo, init);
  });
  return sent;
}

function postCallback(url: string, body: unknown) {
  return call(new URL(url).pathname, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function runStub(runId: string) {
  return env.RUN.get(env.RUN.idFromName(runId));
}

function storedRun(runId: string) {
  return runInDurableObject(runStub(runId), (_obj, state) => state.storage.get<RunRecord>("run"));
}

async function newRun() {
  const sent = captureWebhook();
  await tool("ask_grokbot", { message: "hi", wait_seconds: 0 });
  vi.restoreAllMocks();
  return sent[0].body as { run_id: string; callback_url: string };
}

function budgetStub() {
  return env.BUDGET.get(env.BUDGET.idFromName("global"));
}

const originalEnv = { ...env };

beforeEach(async () => {
  await runInDurableObject(budgetStub(), (_obj, state) => state.storage.deleteAll());
  // 本物の limiter はテスト全体の呼び出し数で詰まるので、既定では常に通す
  env.MCP_RATE_LIMITER = { limit: async () => ({ success: true }) };
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  Object.assign(env, originalEnv);
});

describe("MCP auth", () => {
  it("rejects missing or wrong key", async () => {
    expect((await mcp("tools/list", {}, {})).status).toBe(401);
    expect((await mcp("tools/list", {}, { authorization: "Bearer nope" })).status).toBe(401);
    expect((await mcp("tools/list", {}, { "x-api-key": "nope" })).status).toBe(401);
  });

  it("accepts the key via x-api-key", async () => {
    expect((await mcp("tools/list", {}, { "x-api-key": "test-key" })).status).toBe(200);
  });

  it("429s when the MCP rate limit is exceeded", async () => {
    env.MCP_RATE_LIMITER = { limit: async () => ({ success: false }) };
    const res = await mcp("tools/list", {});
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "rate_limited" });
  });

  it("lists tools with the right key", async () => {
    const res = await mcp("tools/list", {});
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("ask_grokbot");
  });
});

describe("ask_grokbot", () => {
  it("posts webhook with run_id/callback_url and returns pending when no callback", async () => {
    const sent = captureWebhook();
    const out = await tool("ask_grokbot", { message: "hi", wait_seconds: 0 });

    expect(out.status).toBe("pending");
    expect(out).not.toHaveProperty("answer_status");
    expect(out).not.toHaveProperty("answer");
    expect(sent).toHaveLength(1);
    expect(sent[0].auth).toBe("Bearer crsr_test");
    const body = sent[0].body;
    expect(Object.keys(body).sort()).toEqual(["callback_url", "message", "run_id"]);
    expect(body.message).toBe("hi");
    expect(body.run_id).toBe(out.run_id);
    expect(body.callback_url).toBe(`${BASE}/callbacks/${out.run_id}/${await callbackToken(env, out.run_id)}`);
  });

  it("returns the answer when the callback arrives during the wait", async () => {
    const sent = captureWebhook();
    const pending = tool("ask_grokbot", { message: "hi", wait_seconds: 5 });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const { run_id, callback_url } = sent[0].body;

    const cb = await postCallback(callback_url, { ok: true, answer: "42", run_id });
    expect(cb.status).toBe(200);

    const out = await pending;
    expect(out).toMatchObject({ ok: true, run_id, status: "answered", answer_text: "42" });
  });

  it("reports webhook failure, cancels the run and keeps the budget spent on 5xx", async () => {
    env.ASK_DAILY_LIMIT = "1";
    captureWebhook(500);
    const out = await tool("ask_grokbot", { message: "hi", wait_seconds: 0 });
    expect(out).toMatchObject({ ok: false, error: "webhook_failed", webhook_status: 500 });
    expect((await storedRun(out.run_id))?.status).toBe("cancelled");
    expect(await tool("ask_grokbot", { message: "hi", wait_seconds: 0 })).toMatchObject({ error: "daily_limit_reached" });
  });

  it("refunds the budget when the webhook rejects with 4xx", async () => {
    env.ASK_DAILY_LIMIT = "1";
    captureWebhook(401);
    expect(await tool("ask_grokbot", { message: "hi", wait_seconds: 0 })).toMatchObject({ webhook_status: 401 });
    vi.restoreAllMocks();
    const sent = captureWebhook();
    expect(await tool("ask_grokbot", { message: "hi", wait_seconds: 0 })).toMatchObject({ ok: true });
    expect(sent).toHaveLength(1);
  });

  it("sends the webhook with a timeout signal", async () => {
    const sent = captureWebhook();
    await tool("ask_grokbot", { message: "hi", wait_seconds: 0 });
    expect(sent[0].signal).toBeInstanceOf(AbortSignal);
  });

  it("rejects oversized messages without calling the webhook", async () => {
    const sent = captureWebhook();
    const res = await mcp("tools/call", { name: "ask_grokbot", arguments: { message: "x".repeat(20_001) } });
    expect(await res.text()).toContain('"isError":true');
    expect(sent).toHaveLength(0);
  });

  it("reports answered_at only for answered runs", async () => {
    const { run_id } = await newRun();
    expect(await tool("cancel_run", { run_id })).toMatchObject({ status: "cancelled", answered_at: null });
  });
});

describe("callbacks", () => {
  it("accepts callbacks without run_id in the body (the URL identifies the run)", async () => {
    const { run_id, callback_url } = await newRun();
    expect((await postCallback(callback_url, { answer: "x" })).status).toBe(200);
    expect(await tool("get_grokbot_run", { run_id })).toMatchObject({ status: "answered", answer_text: "x" });
  });

  it("falls back to the raw body as answer_text when no answer field exists", async () => {
    const { run_id, callback_url } = await newRun();
    await postCallback(callback_url, { run_id, foo: 1 });
    expect(await tool("get_grokbot_run", { run_id })).toMatchObject({ answer_text: `{"run_id":"${run_id}","foo":1}` });
  });

  it("rejects token/run mismatch", async () => {
    const a = await newRun();
    const b = await newRun();
    const res = await postCallback(a.callback_url, { answer: "x", run_id: b.run_id });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "run_id_mismatch" });
  });

  it("404s unknown run with a validly signed token", async () => {
    const runId = crypto.randomUUID();
    const token = await callbackToken(env, runId);
    const res = await postCallback(`${BASE}/callbacks/${runId}/${token}`, { answer: "x", run_id: runId });
    expect(res.status).toBe(404);
  });

  it("rejects forged tokens without touching a Durable Object", async () => {
    const runId = crypto.randomUUID();
    const res = await postCallback(`${BASE}/callbacks/${runId}/${"a".repeat(64)}`, { answer: "x", run_id: runId });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "invalid_token" });
    const ids = await listDurableObjectIds(env.RUN);
    expect(ids.some((id) => id.equals(env.RUN.idFromName(runId)))).toBe(false);
  });

  it("rejects forged tokens before reading the body", async () => {
    const res = await postCallback(`${BASE}/callbacks/${crypto.randomUUID()}/${"a".repeat(64)}`, { answer: "x".repeat(300_000) });
    expect(res.status).toBe(403);
  });

  it("409s duplicate answers", async () => {
    const { run_id, callback_url } = await newRun();
    await postCallback(callback_url, { answer: "x", run_id });
    const res = await postCallback(callback_url, { answer: "y", run_id });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "already_answered" });
  });

  it("409s after cancel and cancel unblocks status", async () => {
    const { run_id, callback_url } = await newRun();
    expect(await tool("cancel_run", { run_id })).toMatchObject({ ok: true, status: "cancelled" });
    const res = await postCallback(callback_url, { answer: "x", run_id });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "already_cancelled" });
  });

  it("410s expired runs and reports expired status", async () => {
    const { run_id, callback_url } = await newRun();
    await runInDurableObject(runStub(run_id), async (_obj, state) => {
      const rec = (await state.storage.get<RunRecord>("run"))!;
      await state.storage.put("run", { ...rec, createdAt: rec.createdAt - 3601_000 });
    });
    expect((await postCallback(callback_url, { answer: "x", run_id })).status).toBe(410);
    expect(await tool("get_grokbot_run", { run_id })).toMatchObject({ status: "expired" });
  });

  it("413s oversized bodies", async () => {
    const { run_id, callback_url } = await newRun();
    const res = await postCallback(callback_url, { run_id, answer: "x".repeat(300_000) });
    expect(res.status).toBe(413);
  });

  it("413s oversized streamed bodies without content-length", async () => {
    const { callback_url } = await newRun();
    const chunk = new Uint8Array(64 * 1024);
    const body = new ReadableStream({
      start(c) {
        for (let i = 0; i < 5; i++) c.enqueue(chunk);
        c.close();
      },
    });
    const res = await call(new URL(callback_url).pathname, { method: "POST", body, duplex: "half" } as RequestInit);
    expect(res.status).toBe(413);
  });
});

describe("cost guardrails", () => {
  it("rejects asks over the per-minute limit before calling the webhook", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:10Z"));
    env.ASK_PER_MINUTE_LIMIT = "2";
    const sent = captureWebhook();
    await tool("ask_grokbot", { message: "1", wait_seconds: 0 });
    await tool("ask_grokbot", { message: "2", wait_seconds: 0 });
    const out = await tool("ask_grokbot", { message: "3", wait_seconds: 0 });
    expect(out).toMatchObject({ ok: false, error: "rate_limited" });
    expect(out.retry_after_seconds).toBeGreaterThan(0);
    expect(sent).toHaveLength(2);
  });

  it("rejects asks over the daily limit", async () => {
    env.ASK_DAILY_LIMIT = "1";
    const sent = captureWebhook();
    await tool("ask_grokbot", { message: "1", wait_seconds: 0 });
    const out = await tool("ask_grokbot", { message: "2", wait_seconds: 0 });
    expect(out).toMatchObject({ ok: false, error: "daily_limit_reached" });
    expect(sent).toHaveLength(1);
  });

  it("kill switch stops asks entirely", async () => {
    env.COST_KILL_SWITCH = "1";
    const sent = captureWebhook();
    const out = await tool("ask_grokbot", { message: "1", wait_seconds: 0 });
    expect(out).toMatchObject({ ok: false, error: "disabled" });
    expect(sent).toHaveLength(0);
  });

  it("fails closed when a limit is not a number", async () => {
    env.ASK_DAILY_LIMIT = "abc";
    const sent = captureWebhook();
    const res = await mcp("tools/call", { name: "ask_grokbot", arguments: { message: "1", wait_seconds: 0 } });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "misconfigured" });
    expect(sent).toHaveLength(0);
  });
});

describe("Run alarms", () => {
  it("expires a pending run when the TTL alarm fires", async () => {
    const { run_id } = await newRun();
    await runInDurableObject(runStub(run_id), async (_obj, state) => {
      const rec = (await state.storage.get<RunRecord>("run"))!;
      await state.storage.put("run", { ...rec, createdAt: rec.createdAt - 3601_000 });
    });
    expect(await runDurableObjectAlarm(runStub(run_id))).toBe(true);
    expect((await storedRun(run_id))?.status).toBe("expired");
  });

  it("keeps a finished run until retention, then deletes it", async () => {
    const { run_id, callback_url } = await newRun();
    await postCallback(callback_url, { run_id, answer: "x" });

    expect(await runDurableObjectAlarm(runStub(run_id))).toBe(true);
    expect((await storedRun(run_id))?.status).toBe("answered");
    expect(await runInDurableObject(runStub(run_id), (_obj, state) => state.storage.getAlarm())).not.toBeNull();

    await runInDurableObject(runStub(run_id), async (_obj, state) => {
      const rec = (await state.storage.get<RunRecord>("run"))!;
      if (rec.status === "pending") throw new Error("expected finished run");
      await state.storage.put("run", { ...rec, finishedAt: rec.finishedAt - 604_801_000 });
    });
    expect(await runDurableObjectAlarm(runStub(run_id))).toBe(true);
    expect(await storedRun(run_id)).toBeUndefined();
  });
});

describe("wait_for_grokbot_answer / get_grokbot_run", () => {
  it("wait returns once answered", async () => {
    const { run_id, callback_url } = await newRun();

    const waiting = tool("wait_for_grokbot_answer", { run_id, timeout_seconds: 5 });
    await new Promise((r) => setTimeout(r, 50));
    await postCallback(callback_url, { run_id, content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] });

    expect(await waiting).toMatchObject({ status: "answered", answer_text: "a\nb" });
    const got = await tool("get_grokbot_run", { run_id });
    expect(got).toMatchObject({ status: "answered", answer_text: "a\nb" });
    expect(got.answered_at).toEqual(expect.any(String));
  });

  it("unknown run_id is an error", async () => {
    expect(await tool("get_grokbot_run", { run_id: crypto.randomUUID() })).toMatchObject({ ok: false, error: "run_not_found" });
  });
});

describe("extractAnswerText", () => {
  it("uses the first present field in order", () => {
    expect(extractAnswerText({ message: "m", text: "t" })).toBe("m");
    expect(extractAnswerText({ output: "o", result: "r" })).toBe("o");
    expect(extractAnswerText({ result: { a: 1 } })).toBe('{"a":1}');
    expect(extractAnswerText({})).toBeNull();
  });
});
