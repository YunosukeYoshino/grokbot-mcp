import { DurableObject } from "cloudflare:workers";

const GUARD_RETENTION_MS = 15 * 60 * 1000;
const STATE_TTL_MS = 10 * 60 * 1000;

/** Serializes upstream OAuth callback consumption; KV get/delete alone is not atomic. */
export class OAuthStateGuard extends DurableObject<Env> {
  async begin(): Promise<boolean> {
    const startedAt = Date.now();
    const accepted = await this.ctx.storage.transaction(async (transaction) => {
      if (await transaction.get<number>("startedAt") !== undefined) return false;
      await transaction.put("startedAt", startedAt);
      return true;
    });
    if (accepted) await this.ctx.storage.setAlarm(startedAt + GUARD_RETENTION_MS);
    return accepted;
  }

  async consume(): Promise<boolean> {
    const accepted = await this.ctx.storage.transaction(async (transaction) => {
      const startedAt = await transaction.get<number>("startedAt");
      if (startedAt === undefined || Date.now() - startedAt >= STATE_TTL_MS || (await transaction.get<boolean>("consumed"))) {
        return false;
      }
      await transaction.put("consumed", true);
      return true;
    });
    if (accepted) await this.ctx.storage.setAlarm(Date.now() + GUARD_RETENTION_MS);
    return accepted;
  }

  async alarm() {
    await this.ctx.storage.deleteAll();
  }
}
