import { DurableObject } from "cloudflare:workers";
import { readConfig, type Config } from "./config";

type Outcome =
  | { status: "answered"; answerText: string }
  | { status: "cancelled" }
  | { status: "expired" };

type Base = { runId: string; createdAt: number };
type PendingRecord = Base & { status: "pending" };
type FinishedRecord<O extends Outcome = Outcome> = O extends Outcome ? Base & { finishedAt: number } & O : never;

export type RunRecord = PendingRecord | FinishedRecord;

export type CallbackResult = {
  status: 200 | 404 | 409 | 410;
  body: { error: "run_not_found" | "already_answered" | "already_cancelled" | "expired" } | { ok: true; run_id: string };
};

export type CancelResult =
  | { ok: true; run: RunRecord }
  | { ok: false; error: "run_not_found" | "already_answered" | "already_expired" };

const ANSWER_FIELDS = ["answer", "message", "content", "text", "output", "result"] as const;

/** answer → message → content → text → output → result の順で最初に存在するものを文字列化する */
export function extractAnswerText(body: Record<string, unknown>): string | null {
  for (const field of ANSWER_FIELDS) {
    const value = body[field];
    if (value === undefined || value === null) continue;
    if (typeof value === "string") return value;
    if (Array.isArray(value) && value.every(isTextPart)) return value.map((p) => p.text).join("\n");
    return JSON.stringify(value);
  }
  return null;
}

function isTextPart(v: unknown): v is { type: "text"; text: string } {
  return typeof v === "object" && v !== null && "type" in v && v.type === "text" && "text" in v && typeof v.text === "string";
}

/** run 1件 = Durable Object 1つ。callback 待ちの waiter はメモリ上に持つ */
export class Run extends DurableObject<Env> {
  #waiters = new Set<() => void>();

  get #config(): Config {
    const cfg = readConfig(this.env);
    if (!cfg) throw new Error("misconfigured vars"); // Worker 側で弾いているので通常は到達しない
    return cfg;
  }

  get #ttlMs() {
    return this.#config.CALLBACK_TTL_SECONDS * 1000;
  }

  get #retentionMs() {
    return this.#config.RUN_RETENTION_SECONDS * 1000;
  }

  async create(runId: string): Promise<RunRecord> {
    const rec: PendingRecord = { runId, status: "pending", createdAt: Date.now() };
    await this.ctx.storage.put("run", rec);
    await this.ctx.storage.setAlarm(rec.createdAt + this.#ttlMs);
    return rec;
  }

  async get(): Promise<RunRecord | null> {
    const rec = await this.ctx.storage.get<RunRecord>("run");
    if (!rec) return null;
    if (rec.status === "pending" && Date.now() >= rec.createdAt + this.#ttlMs) {
      return this.#finish(rec, { status: "expired" });
    }
    return rec;
  }

  async wait(timeoutMs: number): Promise<RunRecord | null> {
    const rec = await this.get();
    if (!rec || rec.status !== "pending" || timeoutMs <= 0) return rec;

    const untilExpiry = rec.createdAt + this.#ttlMs - Date.now();
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.#waiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, Math.min(timeoutMs, untilExpiry));
      this.#waiters.add(done);
    });
    return this.get();
  }

  /** token の検証は Worker 側で済ませてから呼ぶ */
  async resolve(body: Record<string, unknown>): Promise<CallbackResult> {
    const rec = await this.get();
    if (!rec) return { status: 404, body: { error: "run_not_found" } };
    if (rec.status === "answered") return { status: 409, body: { error: "already_answered" } };
    if (rec.status === "cancelled") return { status: 409, body: { error: "already_cancelled" } };
    if (rec.status === "expired") return { status: 410, body: { error: "expired" } };

    // 回答フィールドが見つからなければ body 全体を返し、生の body は保存しない
    await this.#finish(rec, { status: "answered", answerText: extractAnswerText(body) ?? JSON.stringify(body) });
    return { status: 200, body: { ok: true, run_id: rec.runId } };
  }

  async cancel(): Promise<CancelResult> {
    const rec = await this.get();
    if (!rec) return { ok: false, error: "run_not_found" };
    if (rec.status === "answered") return { ok: false, error: "already_answered" };
    if (rec.status === "expired") return { ok: false, error: "already_expired" };
    if (rec.status === "cancelled") return { ok: true, run: rec };
    return { ok: true, run: await this.#finish(rec, { status: "cancelled" }) };
  }

  async alarm() {
    const rec = await this.get();
    if (!rec) return;
    if (rec.status === "pending") {
      await this.ctx.storage.setAlarm(rec.createdAt + this.#ttlMs);
      return;
    }
    if (this.#retentionMs === 0) return;
    const deleteAt = rec.finishedAt + this.#retentionMs;
    // !(<) にしているのは finishedAt を持たない旧形式のレコード（NaN）も削除するため
    if (!(Date.now() < deleteAt)) await this.ctx.storage.deleteAll();
    else await this.ctx.storage.setAlarm(deleteAt);
  }

  async #finish(rec: PendingRecord, outcome: Outcome): Promise<RunRecord> {
    const next: RunRecord = { runId: rec.runId, createdAt: rec.createdAt, finishedAt: Date.now(), ...outcome };
    await this.ctx.storage.put("run", next);
    if (this.#retentionMs > 0) await this.ctx.storage.setAlarm(next.finishedAt + this.#retentionMs);
    else await this.ctx.storage.deleteAlarm();
    for (const wake of this.#waiters) wake();
    return next;
  }
}
