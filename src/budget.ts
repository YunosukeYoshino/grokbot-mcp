import { DurableObject } from "cloudflare:workers";

export type TakeResult =
  | { ok: true }
  | { ok: false; error: "rate_limited" | "daily_limit_reached"; retry_after_seconds: number };

type Counters = { day: string; dayCount: number; minute: number; minuteCount: number };

/** ask_grokbot の全体上限。単一インスタンス "global" で正確に数える（KV だと結果整合なので使わない） */
export class Budget extends DurableObject<Env> {
  async take(perMinute: number, perDay: number): Promise<TakeResult> {
    const now = Date.now();
    const day = new Date(now).toISOString().slice(0, 10);
    const minute = Math.floor(now / 60_000);
    const prev = await this.ctx.storage.get<Counters>("counters");
    const dayCount = prev?.day === day ? prev.dayCount : 0;
    const minuteCount = prev?.minute === minute ? prev.minuteCount : 0;

    if (dayCount >= perDay) {
      const retry = Date.parse(day) + 86_400_000 - now;
      return { ok: false, error: "daily_limit_reached", retry_after_seconds: Math.ceil(retry / 1000) };
    }
    if (minuteCount >= perMinute) {
      const retry = (minute + 1) * 60_000 - now;
      return { ok: false, error: "rate_limited", retry_after_seconds: Math.ceil(retry / 1000) };
    }

    await this.ctx.storage.put("counters", { day, dayCount: dayCount + 1, minute, minuteCount: minuteCount + 1 });
    return { ok: true };
  }

  /** 相手が確実に処理していない失敗（webhook の 4xx）のときだけ枠を戻す */
  async refund(): Promise<void> {
    const c = await this.ctx.storage.get<Counters>("counters");
    if (!c) return;
    const now = Date.now();
    const sameDay = c.day === new Date(now).toISOString().slice(0, 10);
    const sameMinute = c.minute === Math.floor(now / 60_000);
    await this.ctx.storage.put("counters", {
      ...c,
      dayCount: sameDay ? Math.max(c.dayCount - 1, 0) : c.dayCount,
      minuteCount: sameMinute ? Math.max(c.minuteCount - 1, 0) : c.minuteCount,
    });
  }
}
