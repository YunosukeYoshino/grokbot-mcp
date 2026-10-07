import { DurableObject } from "cloudflare:workers";

const WINDOW_MS = 60_000;
const REFRESH_RETRY_MS = 10_000;
// grant は発行から最長 30 日（provider 既定の refreshTokenTTL、refresh しても延びない）なので、初回利用から固定で十分。
// refreshTokenTTL / refreshTokenIdleTTL を設定するならこれより短く保つこと
const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const REFRESH_IN_FLIGHT_MS = 30_000;
const MAX_REFRESH_ROTATIONS = 1_000;
const CODE_RESERVATION_MS = 30_000;
const CODE_REPLAY_RETRY_MS = 10_000;

type Counter = { window: number; count: number };
type IpCounters = Record<string, Counter>;
type CachedResponse = { status: number; body: string; headers: [string, string][] };
type EncryptedResponse = { status: number; iv: string; ciphertext: string; headers: [string, string][] };
type UsedRefresh = { at: number; replayUntil: number; requestHash: string; response?: EncryptedResponse };
type CodeState = { status: "pending" | "spent"; startedAt: number; completedAt?: number };

/** Exact per-IP and global admission counters for unauthenticated OAuth routes. */
export class OAuthAdmissionGuard extends DurableObject<Env> {
  async take(ipHash: string, perIpLimit: number, globalLimit: number): Promise<{ allowed: boolean; retryAfter: number; reason?: "ip" | "global" }> {
    const now = Date.now();
    const window = Math.floor(now / WINDOW_MS);
    const result = await this.ctx.storage.transaction(async (tx) => {
      const global = await tx.get<Counter>("counter");
      const globalCount = global?.window === window ? global.count : 0;
      const retryAfter = Math.max(1, Math.ceil(((window + 1) * WINDOW_MS - now) / 1000));
      if (globalCount >= globalLimit) return { allowed: false, retryAfter, reason: "global" as const };
      const ipMap = await tx.get<IpCounters>("ipCounters") ?? {};
      const ipCounter = ipMap[ipHash];
      const ipCount = ipCounter?.window === window ? ipCounter.count : 0;
      if (ipCount >= perIpLimit) return { allowed: false, retryAfter, reason: "ip" as const };
      for (const [key, value] of Object.entries(ipMap)) if (value.window !== window) delete ipMap[key];
      ipMap[ipHash] = { window, count: ipCount + 1 };
      await tx.put("ipCounters", ipMap);
      await tx.put("counter", { window, count: globalCount + 1 });
      return { allowed: true, retryAfter: 0 };
    });
    if (result.allowed) await this.ctx.storage.setAlarm((window + 1) * WINDOW_MS + 1000);
    return result;
  }

  async alarm() {
    const now = Date.now();
    const stored = await this.ctx.storage.get<Counter>("counter");
    const currentWindow = Math.floor(now / WINDOW_MS);
    if (!stored || stored.window < currentWindow) return this.ctx.storage.deleteAll();
    await this.ctx.storage.setAlarm((stored.window + 1) * WINDOW_MS + 1000);
  }
}

/** Serializes code redemption and refresh rotation/replay handling per OAuth grant. */
export class OAuthTokenGuard extends DurableObject<Env> {
  async reserveAuthorizationCode(): Promise<"accepted" | "concurrent" | "replay"> {
    const now = Date.now();
    const result = await this.ctx.storage.transaction(async (tx) => {
      const previous = await tx.get<CodeState>("authorizationCodeState");
      if (!previous) {
        await tx.put("authorizationCodeState", { status: "pending", startedAt: now } satisfies CodeState);
        await tx.put("retentionExpiresAt", now + RETENTION_MS);
        return "accepted" as const;
      }
      if (previous.status === "spent") {
        return previous.completedAt !== undefined && now - previous.completedAt < CODE_REPLAY_RETRY_MS ? "concurrent" as const : "replay" as const;
      }
      if (now - previous.startedAt < CODE_RESERVATION_MS) return "concurrent" as const;
      await tx.put("authorizationCodeState", { ...previous, status: "spent" });
      return "replay" as const;
    });
    if (result === "accepted") await this.scheduleAlarm();
    return result;
  }

  async completeAuthorizationCode(): Promise<void> {
    await this.ctx.storage.transaction(async (tx) => {
      const state = await tx.get<CodeState>("authorizationCodeState");
      if (state?.status === "pending") await tx.put("authorizationCodeState", { ...state, status: "spent", completedAt: Date.now() });
    });
  }

  async releaseAuthorizationCode(): Promise<void> {
    await this.ctx.storage.transaction(async (tx) => {
      const state = await tx.get<CodeState>("authorizationCodeState");
      if (state?.status === "pending") await tx.delete("authorizationCodeState");
    });
  }

  async checkRefresh(tokenHash: string, requestHash: string, providerAccepts: boolean): Promise<
    | { result: "proceed" }
    | { result: "pending" }
    | { result: "replay"; response: CachedResponse }
    | { result: "reuse" }
    | { result: "unknown" }
    | { result: "revoked" }
  > {
    const now = Date.now();
    const result = await this.ctx.storage.transaction(async (tx) => {
      if (await tx.get<boolean>("revoked")) return { result: "revoked" as const };
      const used = await tx.get<UsedRefresh>(`used:${tokenHash}`);
      if (used) {
        const latestUsed = await tx.get<string>("latestUsedHash");
        if (latestUsed === tokenHash && used.requestHash === requestHash && used.response && now < used.replayUntil) {
          return { result: "replay" as const, response: used.response };
        }
        await tx.put("revoked", true);
        return { result: "reuse" as const };
      }
      if ((await tx.get<number>("refreshRotationCount") ?? 0) >= MAX_REFRESH_ROTATIONS) {
        await tx.put("revoked", true);
        return { result: "reuse" as const };
      }
      const currentHash = await tx.get<string>("currentRefreshHash");
      if (!providerAccepts && currentHash !== tokenHash) return { result: "unknown" as const };
      const inFlight = await tx.get<{ tokenHash: string; expiresAt: number }>("inFlight");
      if (inFlight && now >= inFlight.expiresAt) {
        await tx.put("revoked", true);
        return { result: "reuse" as const };
      }
      if (inFlight) return { result: "pending" as const };
      if (currentHash && currentHash !== tokenHash) {
        await tx.put("revoked", true);
        return { result: "reuse" as const };
      }
      await tx.put("currentRefreshHash", tokenHash);
      await tx.put("inFlight", { tokenHash, expiresAt: now + REFRESH_IN_FLIGHT_MS, providerStarted: false });
      if (!(await tx.get<number>("retentionExpiresAt"))) await tx.put("retentionExpiresAt", now + RETENTION_MS);
      return { result: "proceed" as const };
    });
    if (result.result === "proceed") await this.scheduleAlarm();
    if (result.result === "replay") {
      try { return { ...result, response: await this.decryptResponse(result.response) }; }
      catch {
        await this.revoke();
        return { result: "revoked" as const };
      }
    }
    return result;
  }

  async completeRefresh(tokenHash: string, requestHash: string, nextTokenHash: string, response: CachedResponse): Promise<void> {
    const now = Date.now();
    const encryptedResponse = await this.encryptResponse(response);
    await this.ctx.storage.transaction(async (tx) => {
      if ((await tx.get<{ tokenHash: string }>("inFlight"))?.tokenHash !== tokenHash) return;
      const priorHash = await tx.get<string>("latestUsedHash");
      if (priorHash) {
        const prior = await tx.get<UsedRefresh>(`used:${priorHash}`);
        if (prior) {
          await tx.put(`used:${priorHash}`, { at: prior.at, replayUntil: now, requestHash: prior.requestHash });
        }
      }
      await tx.put(`used:${tokenHash}`, { at: now, replayUntil: now + REFRESH_RETRY_MS, requestHash, response: encryptedResponse } satisfies UsedRefresh);
      await tx.put("latestUsedHash", tokenHash);
      await tx.put("currentRefreshHash", nextTokenHash);
      await tx.put("refreshRotationCount", (await tx.get<number>("refreshRotationCount") ?? 0) + 1);
      await tx.delete("inFlight");
    });
    await this.scheduleAlarm();
  }

  async markRefreshProviderStarted(tokenHash: string): Promise<void> {
    await this.ctx.storage.transaction(async (tx) => {
      const flight = await tx.get<{ tokenHash: string; expiresAt: number; providerStarted: boolean }>("inFlight");
      if (flight?.tokenHash === tokenHash) await tx.put("inFlight", { ...flight, providerStarted: true });
    });
  }

  async refreshProviderStarted(tokenHash: string): Promise<boolean> {
    const flight = await this.ctx.storage.get<{ tokenHash: string; providerStarted: boolean }>("inFlight");
    return flight?.tokenHash === tokenHash && flight.providerStarted;
  }

  async abortRefresh(tokenHash: string, knownPreCommitFailure = false): Promise<void> {
    await this.ctx.storage.transaction(async (tx) => {
      const flight = await tx.get<{ tokenHash: string; providerStarted?: boolean }>("inFlight");
      if (flight?.tokenHash === tokenHash && (!flight.providerStarted || knownPreCommitFailure)) await tx.delete("inFlight");
    });
    await this.scheduleAlarm();
  }

  async releaseRefreshBeforeCommit(): Promise<void> {
    await this.ctx.storage.transaction(async (tx) => {
      const flight = await tx.get<{ providerStarted?: boolean }>("inFlight");
      if (flight?.providerStarted) await tx.delete("inFlight");
    });
    await this.scheduleAlarm();
  }

  async isRevoked(): Promise<boolean> { return (await this.ctx.storage.get<boolean>("revoked")) === true; }

  async revoke(): Promise<void> {
    await this.ctx.storage.transaction(async (tx) => { await tx.put("revoked", true); });
    await this.clearRetryResponses();
    await this.scheduleAlarm();
  }

  private async clearRetryResponses() {
    const records = await this.ctx.storage.list<UsedRefresh>({ prefix: "used:" });
    for (const [key, value] of records) {
      if (value.response) await this.ctx.storage.put(key, { at: value.at, replayUntil: value.replayUntil, requestHash: value.requestHash });
    }
  }

  private async scheduleAlarm() {
    const now = Date.now();
    const retention = await this.ctx.storage.get<number>("retentionExpiresAt") ?? now + RETENTION_MS;
    const records = await this.ctx.storage.list<UsedRefresh>({ prefix: "used:" });
    let next = retention;
    for (const value of records.values()) {
      if (value.response) next = Math.min(next, value.replayUntil + 100);
    }
    await this.ctx.storage.setAlarm(Math.max(now + 1, next));
  }

  private async cacheKey(): Promise<CryptoKey> {
    const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(this.env.CALLBACK_SIGNING_SECRET), "HKDF", false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: new TextEncoder().encode("grokbot-bridge"), info: new TextEncoder().encode("oauth-refresh-retry-cache:v1") },
      material,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  }

  private async encryptResponse(response: CachedResponse): Promise<EncryptedResponse> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      await this.cacheKey(),
      new TextEncoder().encode(JSON.stringify(response)),
    ));
    const hex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return { status: response.status, headers: response.headers, iv: hex(iv), ciphertext: hex(ciphertext) };
  }

  private async decryptResponse(response: EncryptedResponse): Promise<CachedResponse> {
    const bytes = (hex: string) => Uint8Array.from(hex.match(/.{2}/g) ?? [], (pair) => Number.parseInt(pair, 16));
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes(response.iv) }, await this.cacheKey(), bytes(response.ciphertext));
    const decoded = JSON.parse(new TextDecoder().decode(plaintext)) as CachedResponse;
    return decoded;
  }

  async alarm() {
    const now = Date.now();
    const expiry = await this.ctx.storage.get<number>("retentionExpiresAt");
    if (expiry !== undefined && now >= expiry) return this.ctx.storage.deleteAll();
    const records = await this.ctx.storage.list<UsedRefresh>({ prefix: "used:" });
    let removedResponse = false;
    for (const [key, value] of records) {
      if (value.response && now >= value.replayUntil) {
        await this.ctx.storage.put(key, { at: value.at, replayUntil: value.replayUntil, requestHash: value.requestHash });
        removedResponse = true;
      }
    }
    if (removedResponse && expiry === undefined) await this.ctx.storage.put("retentionExpiresAt", now + RETENTION_MS);
    await this.scheduleAlarm();
  }
}

export const OAUTH_PER_IP_LIMIT = 20;
export const OAUTH_GLOBAL_LIMIT = 120;
export const OAUTH_BODY_LIMIT = 64 * 1024;
export const OAUTH_REFRESH_RETRY_MS_EXPORT = REFRESH_RETRY_MS;
