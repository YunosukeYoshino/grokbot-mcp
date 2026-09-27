import { z } from "zod";

export const HARD_MAX_WAIT_SECONDS = 300;

const seconds = z.coerce.number().int().min(0);

const schema = z.object({
  MAX_WAIT_SECONDS: seconds.max(HARD_MAX_WAIT_SECONDS),
  CALLBACK_TTL_SECONDS: seconds.min(1),
  /** 0 = 削除しない */
  RUN_RETENTION_SECONDS: seconds,
  ASK_PER_MINUTE_LIMIT: z.coerce.number().int().min(0),
  ASK_DAILY_LIMIT: z.coerce.number().int().min(0),
  COST_KILL_SWITCH: z.enum(["0", "1"]).transform((v) => v === "1"),
});

export type Config = z.infer<typeof schema>;

/** vars が不正なら null。上限が NaN で素通りする fail-open を防ぐため、呼び出し側は拒否する */
export function readConfig(env: Env): Config | null {
  const parsed = schema.safeParse(env);
  return parsed.success ? parsed.data : null;
}
