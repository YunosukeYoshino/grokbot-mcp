import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { AuthorizationError, insufficientScope, OAuthError, OAuthProvider, type OAuthResourceAuth } from "@cloudflare/workers-oauth-provider";
import { z } from "zod";
import { Budget } from "./budget";
import { readConfig, type Config } from "./config";
import { OAuthStateGuard } from "./oauth-state";
import { OAUTH_BODY_LIMIT, OAUTH_GLOBAL_LIMIT, OAUTH_PER_IP_LIMIT, OAuthAdmissionGuard, OAuthTokenGuard } from "./oauth-guard";
import { Run, type RunRecord } from "./run";

export { Budget, OAuthAdmissionGuard, OAuthStateGuard, OAuthTokenGuard, Run };

const MAX_CALLBACK_BYTES = 256 * 1024;
const MAX_MESSAGE_CHARS = 20_000;
const WEBHOOK_TIMEOUT_MS = 10_000;
const CALLBACK_PATH = /^\/callbacks\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/([0-9a-f]{64})$/;
const GITHUB_CALLBACK_PATH = "/oauth/github/callback";
const MCP_SCOPE = "grokbot:use";
const enc = new TextEncoder();

/** OAuth grant はオーナーの GitHub ID、MCP_API_KEY は GitHub 設定なしで使えるクイックスタート用 */
type OAuthProps = { githubUserId: string } | { apiKey: true };

interface OAuthExecutionContext extends ExecutionContext {
  props: OAuthProps;
  auth: OAuthResourceAuth;
}

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

async function hashHex(value: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(value))), (b) => b.toString(16).padStart(2, "0")).join("");
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
        const clientError = webhookStatus !== null && webhookStatus >= 400 && webhookStatus < 500;
        const serverError = webhookStatus !== null && webhookStatus >= 500;
        // 5xx は routine が既に始まっていることがある。再送せず pending のまま残し、遅れた callback を受ける。
        // 応答に status: "pending" と run_id を載せ、失敗を終端と読ませない。
        // 4xx は未受理なので取り消し、枠を戻す。タイムアウト・通信断（status なし）は従来どおり取り消す。枠は戻さない。応答に status は付けない。
        if (!serverError) await stub.cancel();
        if (clientError) await budget.refund();
        return result({
          ok: false,
          error: "webhook_failed",
          webhook_status: webhookStatus,
          run_id: runId,
          ...(serverError ? { status: "pending" } : {}),
          detail: String(err),
        });
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

function htmlEscape(value: string) {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function githubUserIdConfigured(env: Env): string | null {
  const value = env.GITHUB_OWNER_ID?.trim();
  return value && /^[1-9][0-9]{0,19}$/.test(value) ? value : null;
}

function isSafeOAuthRedirect(value: unknown) {
  if (typeof value !== "string") return false;
  try {
    const target = new URL(value);
    if (target.protocol === "https:") return !target.username && !target.password && !target.hash;
    return (
      target.protocol === "http:" &&
      !target.username &&
      !target.password &&
      !target.hash &&
      (target.hostname === "localhost" || /^127(?:\.\d{1,3}){3}$/.test(target.hostname) || target.hostname === "[::1]")
    );
  } catch {
    return false;
  }
}

function base64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function pkceChallenge(verifier: string) {
  return base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(verifier))));
}

function localError(message: string, status = 400) {
  return new Response(`<!doctype html><meta charset="utf-8"><title>Authorization failed</title><p>${htmlEscape(message)}</p>`, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}

function authorizationErrorResponse(error: unknown): Response {
  if (error instanceof AuthorizationError) {
    if (error.redirectUri) {
      const redirect = new URL(error.redirectUri);
      redirect.searchParams.set("error", error.code);
      redirect.searchParams.set("error_description", error.description);
      if (error.state) redirect.searchParams.set("state", error.state);
      if (error.issuer) redirect.searchParams.set("iss", error.issuer);
      return Response.redirect(redirect.href, 302);
    }
    return localError(error.description);
  }
  return localError("Authorization could not be completed.", 500);
}

function consentHtml(client: { clientId: string; clientName?: string }, request: { redirectUri: string; scope: string[] }, handle: string) {
  const clientName = htmlEscape(client.clientName || client.clientId);
  let clientPublisher = "This client has not published a verified identity.";
  if (client.clientId.startsWith("https://")) {
    try {
      clientPublisher = `Published by ${htmlEscape(new URL(client.clientId).hostname)}.`;
    } catch {
      // Invalid URLs are not treated as publisher identities.
    }
  }
  const redirectHost = htmlEscape(new URL(request.redirectUri).hostname);
  const isLocal = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i.test(redirectHost);
  const scopes = request.scope
    .map((scope) => `<label><input type="checkbox" name="scope" value="${htmlEscape(scope)}" checked> ${htmlEscape(scope)}</label><br>`)
    .join("");
  return `<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Authorize Grok Bot Bridge</title>
<h1>Allow ${clientName} to connect?</h1>
<p>${clientPublisher} Access will be sent to <strong>${redirectHost}</strong>.</p>
${isLocal ? "<p><strong>This sends access to an app on this computer.</strong> Continue only if you started sign-in from it.</p>" : ""}
<p>This grants access to your Grok Bot Bridge account.</p>
<form method="post" action="/authorize">
  <input type="hidden" name="handle" value="${htmlEscape(handle)}">
  ${scopes || "<p>No permissions were requested.</p>"}
  <p><button name="decision" value="approve">Continue with GitHub</button> <button name="decision" value="deny">Deny</button></p>
</form>`;
}

function githubAuthorizeUrl(input: { clientId: string; callbackUrl: string; state: string; challenge: string }) {
  const target = new URL("https://github.com/login/oauth/authorize");
  target.searchParams.set("client_id", input.clientId);
  target.searchParams.set("redirect_uri", input.callbackUrl);
  target.searchParams.set("scope", "read:user");
  target.searchParams.set("state", input.state);
  target.searchParams.set("code_challenge", input.challenge);
  target.searchParams.set("code_challenge_method", "S256");
  target.searchParams.set("allow_signup", "false");
  return target.href;
}

async function authorize(request: Request, env: Env, baseUrl: string) {
  if (!githubUserIdConfigured(env)) return localError("Owner access is not configured.", 503);
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) return localError("GitHub sign-in is not configured.", 503);

  const oauth = (env as Env & { OAUTH_PROVIDER: import("@cloudflare/workers-oauth-provider").OAuthHelpers }).OAUTH_PROVIDER;
  try {
    if (request.method === "GET") {
      const authRequest = await oauth.parseAuthRequest(request);
      if (!isSafeOAuthRedirect(authRequest.redirectUri)) return localError("OAuth client redirects must use HTTPS or localhost.");
      const client = await oauth.lookupClient(authRequest.clientId);
      if (!client) return localError("OAuth client was not found.");
      const consent = await oauth.beginConsent(authRequest);
      consent.headers.set("content-type", "text/html; charset=utf-8");
      consent.headers.set("cache-control", "no-store");
      return new Response(consentHtml(client, authRequest, consent.handle), { headers: consent.headers });
    }

    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    const form = await request.formData();
    const handle = String(form.get("handle") ?? "");
    if (!handle) return localError("The consent request has expired. Start again.");
    if (form.get("decision") !== "approve") {
      const denied = await oauth.denyConsent(request, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }

    const approved = await oauth.approveConsent(request, handle, { scope: form.getAll("scope").map(String) });
    const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
    const upstream = await oauth.beginUpstream(approved.request, { data: { verifier }, headers: approved.headers });
    const stateGuard = env.OAUTH_STATE_GUARD.get(env.OAUTH_STATE_GUARD.idFromName(upstream.state));
    if (!(await stateGuard.begin())) return localError("Could not start GitHub sign-in. Start again.", 503);
    const callbackUrl = `${baseUrl}${GITHUB_CALLBACK_PATH}`;
    upstream.headers.set(
      "location",
      githubAuthorizeUrl({
        clientId: env.GITHUB_CLIENT_ID,
        callbackUrl,
        state: upstream.state,
        challenge: await pkceChallenge(verifier),
      }),
    );
    return new Response(null, { status: 302, headers: upstream.headers });
  } catch (error) {
    if (error instanceof AuthorizationError) return authorizationErrorResponse(error);
    throw error;
  }
}

function safeOAuthErrorRedirect(redirectUri: string, state?: string, issuer?: string) {
  const redirect = new URL(redirectUri);
  redirect.searchParams.set("error", "access_denied");
  if (state) redirect.searchParams.set("state", state);
  if (issuer) redirect.searchParams.set("iss", issuer);
  return Response.redirect(redirect.href, 302);
}

async function githubCallback(request: Request, env: Env, baseUrl: string) {
  if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);
  if (!githubUserIdConfigured(env)) return localError("Owner access is not configured.", 503);
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) return localError("GitHub sign-in is not configured.", 503);

  const oauth = (env as Env & { OAUTH_PROVIDER: import("@cloudflare/workers-oauth-provider").OAuthHelpers }).OAUTH_PROVIDER;
  try {
    const { request: authRequest, data, headers } = await oauth.finishUpstream<{ verifier: string }>(request);
    const params = new URL(request.url).searchParams;
    const state = params.get("state");
    if (!state || !(await env.OAUTH_STATE_GUARD.get(env.OAUTH_STATE_GUARD.idFromName(state)).consume())) {
      return localError("This GitHub sign-in callback expired or was already used. Start again.", 400);
    }
    if (params.has("error")) return safeOAuthErrorRedirect(authRequest.redirectUri, authRequest.state, authRequest.issuer);
    const code = params.get("code");
    if (!code || !data?.verifier) return localError("GitHub sign-in did not return a valid code.");

    const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: env.GITHUB_CLIENT_ID,
        client_secret: env.GITHUB_CLIENT_SECRET,
        code,
        redirect_uri: `${baseUrl}${GITHUB_CALLBACK_PATH}`,
        code_verifier: data.verifier,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!tokenResponse.ok) return localError("GitHub could not complete sign-in.", 502);
    const tokenBody = (await tokenResponse.json()) as { access_token?: unknown; error?: unknown };
    if (typeof tokenBody.access_token !== "string" || !tokenBody.access_token) {
      return localError("GitHub could not complete sign-in.", 502);
    }

    const profileResponse = await fetch("https://api.github.com/user", {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${tokenBody.access_token}`,
        "user-agent": "grokbot-bridge",
        "x-github-api-version": "2022-11-28",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!profileResponse.ok) return localError("GitHub could not verify the signed-in account.", 502);
    const profile = (await profileResponse.json()) as { id?: unknown };
    const githubId = typeof profile.id === "number" && Number.isSafeInteger(profile.id) && profile.id > 0 ? String(profile.id) : null;
    const ownerId = githubUserIdConfigured(env);
    if (!githubId || !ownerId || githubId !== ownerId) return localError("This GitHub account is not authorized.", 403);

    const { redirectTo } = await oauth.completeAuthorization({
      request: authRequest,
      userId: githubId,
      metadata: { githubUserId: githubId },
      scope: authRequest.scope,
      props: { githubUserId: githubId } satisfies OAuthProps,
    });
    headers.set("location", redirectTo);
    return new Response(null, { status: 302, headers });
  } catch (error) {
    if (error instanceof AuthorizationError) return localError("The sign-in request expired or could not be verified. Start again.");
    throw error;
  }
}

function mcpRequestWithApiKeyHeader(request: Request, env: Env) {
  if (!env.MCP_API_KEY) return request;
  const apiKeyHeader = request.headers.get("x-api-key");
  if (apiKeyHeader === null) return request;
  const headers = new Headers(request.headers);
  headers.delete("x-api-key");
  headers.set("authorization", `Bearer ${apiKeyHeader}`);
  return new Request(request, { headers });
}

function createOAuthProvider(baseUrl: string) {
  const resource = `${baseUrl}/mcp`;
  return new OAuthProvider<Env>({
    apiRoute: "/mcp",
    apiHandler: {
      async fetch(request, env, context) {
        const authContext = context as OAuthExecutionContext;
        const props = authContext.props;
        if (!props) return json({ error: "forbidden" }, 403);
        if (!("apiKey" in props)) {
          const ownerId = githubUserIdConfigured(env);
          if (!ownerId) return json({ error: "owner_not_configured" }, 503);
          if (props.githubUserId !== ownerId || authContext.auth.userId !== ownerId) return json({ error: "forbidden" }, 403);
          if (!authContext.auth.scope.includes(MCP_SCOPE)) return insufficientScope(authContext.auth, [MCP_SCOPE]);
          const parts = authContext.auth.token.split(":");
          if (parts.length === 3 && await env.OAUTH_TOKEN_GUARD.get(env.OAUTH_TOKEN_GUARD.idFromName(`grant:${parts[0]}:${parts[1]}`)).isRevoked()) {
            return new Response(JSON.stringify({ error: "invalid_token" }), {
              status: 401,
              headers: { "content-type": "application/json", "www-authenticate": 'Bearer error="invalid_token"' },
            });
          }
        }
        if (!(await env.MCP_RATE_LIMITER.limit({ key: "mcp" })).success) return json({ error: "rate_limited" }, 429);
        const cfg = readConfig(env);
        if (!cfg) return json({ error: "misconfigured" }, 503);
        return createMcpHandler(() => createServer(env, cfg, env.PUBLIC_BASE_URL ?? baseUrl))(request, env, context);
      },
    },
    defaultHandler: {
      async fetch(request, env) {
        const url = new URL(request.url);
        if (url.pathname === "/authorize") return authorize(request, env, baseUrl);
        if (url.pathname === GITHUB_CALLBACK_PATH) return githubCallback(request, env, baseUrl);
        return json({ error: "not_found" }, 404);
      },
    },
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/oauth/register",
    clientRegistrationCallback: ({ clientMetadata }) => {
      const redirects = clientMetadata.redirect_uris;
      if (!Array.isArray(redirects) || redirects.some((redirect) => !isSafeOAuthRedirect(redirect))) {
        return { description: "OAuth client redirects must use HTTPS or localhost." };
      }
    },
    clientIdMetadataDocumentEnabled: true,
    allowPlainPKCE: false,
    scopesSupported: [MCP_SCOPE],
    resourceMetadata: {
      resource,
      authorization_servers: [baseUrl],
      scopes_supported: [MCP_SCOPE],
      resource_name: "Grok Bot Bridge",
    },
    resolveExternalToken: async ({ token, env }) => {
      if (!env.MCP_API_KEY || !(await safeEqual(token, env.MCP_API_KEY))) return null;
      return { audience: resource, props: { apiKey: true } satisfies OAuthProps };
    },
    tokenExchangeCallback: async ({ grantType, userId, grantId, env, isCurrentRefreshToken }) => {
      const guard = env.OAUTH_TOKEN_GUARD.get(env.OAUTH_TOKEN_GUARD.idFromName(`grant:${userId}:${grantId}`));
      if (grantType === "authorization_code") {
        const reservation = await guard.reserveAuthorizationCode();
        if (reservation === "accepted") return;
        if (reservation === "concurrent") {
          throw new OAuthError("temporarily_unavailable", {
            description: "Authorization is being completed. Retry shortly.",
            statusCode: 503,
            headers: { "Retry-After": "2" },
          });
        }
        await guard.revoke();
        throw new OAuthError("invalid_grant", { description: "Authorization code was already used." });
      }
      if (grantType === "refresh_token" && isCurrentRefreshToken !== true) {
        await guard.revoke();
        throw new OAuthError("invalid_grant", { description: "Refresh token reuse detected; this grant was revoked." });
      }
    },
    authorizationCodeReplayCallback: async ({ env, userId, grantId }) => {
      const guard = env.OAUTH_TOKEN_GUARD.get(env.OAUTH_TOKEN_GUARD.idFromName(`grant:${userId}:${grantId}`));
      const replay = await guard.reserveAuthorizationCode();
      if (replay === "concurrent") {
        throw new OAuthError("temporarily_unavailable", {
          description: "Authorization was just completed. Retry shortly.",
          statusCode: 503,
          headers: { "Retry-After": "2" },
        });
      }
      await guard.revoke();
    },
    authorizationCodePreCommitFailureCallback: async ({ env, userId, grantId }) => {
      await env.OAUTH_TOKEN_GUARD.get(env.OAUTH_TOKEN_GUARD.idFromName(`grant:${userId}:${grantId}`)).releaseAuthorizationCode();
    },
    refreshTokenPreCommitFailureCallback: async ({ env, userId, grantId }) => {
      await env.OAUTH_TOKEN_GUARD.get(env.OAUTH_TOKEN_GUARD.idFromName(`grant:${userId}:${grantId}`)).releaseRefreshBeforeCommit();
    },
    tokenRequestCallback: async ({ env, grantType, refreshToken }) => {
      if (grantType !== "refresh_token" || typeof refreshToken !== "string") return;
      const [userId, grantId, opaque] = refreshToken.split(":");
      if (!userId || !grantId || !opaque) return;
      const tokenHash = await hashHex(refreshToken);
      await env.OAUTH_TOKEN_GUARD.get(env.OAUTH_TOKEN_GUARD.idFromName(`grant:${userId}:${grantId}`)).markRefreshProviderStarted(tokenHash);
    },
    onGrantRevokedCallback: async ({ env, userId, grantId }) => {
      await env.OAUTH_TOKEN_GUARD.get(env.OAUTH_TOKEN_GUARD.idFromName(`grant:${userId}:${grantId}`)).revoke();
    },
    onError: (error) => {
      if (error.code === "invalid_token") return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: error.headers });
      if (error.code === "insufficient_scope") return new Response(JSON.stringify({ error: "insufficient_scope" }), { status: 403, headers: error.headers });
    },
  });
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

    const baseUrl = new URL(env.PUBLIC_BASE_URL ?? url.origin).origin;
    const provider = createOAuthProvider(baseUrl);
    const oauthRequest = ["/authorize", GITHUB_CALLBACK_PATH, "/oauth/register", "/oauth/token"].includes(url.pathname);
    if (oauthRequest) {
      const ip = request.headers.get("cf-connecting-ip");
      if (!ip) return new Response(JSON.stringify({ error: "temporarily_unavailable" }), { status: 503, headers: { "retry-after": "5" } });
      const ipHash = await hashHex(ip);
      const limit = await env.OAUTH_ADMISSION_GUARD.get(env.OAUTH_ADMISSION_GUARD.idFromName("global")).take(ipHash, OAUTH_PER_IP_LIMIT, OAUTH_GLOBAL_LIMIT);
      if (!limit.allowed) return new Response(JSON.stringify({ error: "rate_limited" }), { status: 429, headers: { "retry-after": String(limit.retryAfter) } });
    }

    let routedRequest = request;
    if (oauthRequest && request.method !== "GET" && request.method !== "HEAD" && request.method !== "OPTIONS") {
      const lengthHeader = request.headers.get("content-length");
      if (lengthHeader && /^\d+$/.test(lengthHeader) && Number(lengthHeader) > OAUTH_BODY_LIMIT) {
        await request.body?.cancel();
        return new Response(JSON.stringify({ error: "payload_too_large" }), { status: 413 });
      }
      if (request.body) {
        const reader = request.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > OAUTH_BODY_LIMIT) {
            await reader.cancel();
            return new Response(JSON.stringify({ error: "payload_too_large" }), { status: 413 });
          }
          chunks.push(value);
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        routedRequest = new Request(request, { body: bytes });
      }
    }

    if (
      url.pathname === "/oauth/token" &&
      request.method === "POST" &&
      routedRequest.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() === "application/x-www-form-urlencoded"
    ) {
      const bodyText = new TextDecoder().decode(await routedRequest.clone().arrayBuffer());
      const form = new URLSearchParams(bodyText);
      if (form.get("grant_type") === "authorization_code") {
        const code = form.get("code");
        const parts = code?.split(":") ?? [];
        if (parts.length === 3 && parts[0] && parts[1]) {
          const codeGuard = env.OAUTH_TOKEN_GUARD.get(env.OAUTH_TOKEN_GUARD.idFromName(`grant:${parts[0]}:${parts[1]}`));
          const response = await provider.fetch(routedRequest, env, ctx);
          if (response.ok) await codeGuard.completeAuthorizationCode();
          return response;
        }
      }
      const refreshToken = form.get("refresh_token");
      const singularParameters = ["grant_type", "refresh_token", "client_id", "client_secret", "client_assertion", "client_assertion_type", "scope"];
      const hasRepeatedParameter = singularParameters.some((name) => form.getAll(name).length > 1);
      if (!hasRepeatedParameter && form.get("grant_type") === "refresh_token" && refreshToken) {
        const parts = refreshToken.split(":");
        if (parts.length === 3 && /^[1-9][0-9]{0,19}$/.test(parts[0]) && /^[A-Za-z0-9_-]{1,128}$/.test(parts[1])) {
          const [userId, grantId] = parts;
          const tokenHash = await hashHex(refreshToken);
          const requestHash = await hashHex(JSON.stringify({
            clientId: form.get("client_id"),
            scope: form.get("scope"),
            resources: form.getAll("resource"),
            authorization: routedRequest.headers.get("authorization"),
            clientSecret: form.get("client_secret"),
            clientAssertion: form.get("client_assertion"),
            clientAssertionType: form.get("client_assertion_type"),
          }));
          const grant = await env.OAUTH_KV.get<{ refreshTokenId?: string; previousRefreshTokenId?: string }>(`grant:${userId}:${grantId}`, "json");
          const providerAccepts = grant?.refreshTokenId === tokenHash || grant?.previousRefreshTokenId === tokenHash;
          const tokenGuard = env.OAUTH_TOKEN_GUARD.get(env.OAUTH_TOKEN_GUARD.idFromName(`grant:${userId}:${grantId}`));
          const decision = await tokenGuard.checkRefresh(tokenHash, requestHash, providerAccepts);
          if (decision.result === "replay") return new Response(decision.response.body, { status: decision.response.status, headers: decision.response.headers });
          if (decision.result === "pending") return new Response(JSON.stringify({ error: "temporarily_unavailable" }), { status: 503, headers: { "content-type": "application/json", "retry-after": "1" } });
          if (["reuse", "revoked"].includes(decision.result)) {
            await revokeGrantRecords(env, userId, grantId);
            return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400, headers: { "content-type": "application/json", "cache-control": "no-store" } });
          }
          if (decision.result === "proceed") {
            // grant がまだ提示トークンを指していればローテーション未確定なので、in-flight を解放して再試行を通す
            const abortUnlessRotated = async () => {
              const current = await env.OAUTH_KV.get<{ refreshTokenId?: string }>(`grant:${userId}:${grantId}`, "json");
              await tokenGuard.abortRefresh(tokenHash, current?.refreshTokenId === tokenHash);
            };
            let response: Response;
            try {
              response = await provider.fetch(routedRequest, env, ctx);
            } catch (error) {
              await abortUnlessRotated();
              throw error;
            }
            if (!response.ok) {
              await abortUnlessRotated();
              return response;
            }
            let body: { refresh_token?: unknown };
            try { body = await response.clone().json() as { refresh_token?: unknown }; }
            catch { await tokenGuard.abortRefresh(tokenHash); return response; }
            if (typeof body.refresh_token !== "string") { await tokenGuard.abortRefresh(tokenHash); return response; }
            const nextHash = await hashHex(body.refresh_token);
            await tokenGuard.completeRefresh(tokenHash, requestHash, nextHash, {
              status: response.status,
              body: await response.clone().text(),
              headers: Array.from(response.headers.entries()),
            });
            return response;
          }
        }
      }
    }
    return provider.fetch(url.pathname === "/mcp" ? mcpRequestWithApiKeyHeader(routedRequest, env) : routedRequest, env, ctx);
  },
} satisfies ExportedHandler<Env>;

async function revokeGrantRecords(env: Env, userId: string, grantId: string) {
  await env.OAUTH_KV.delete(`grant:${userId}:${grantId}`);
  let cursor: string | undefined;
  do {
    const page = await env.OAUTH_KV.list({ prefix: `token:${userId}:${grantId}:`, cursor, limit: 1000 });
    await Promise.all(page.keys.map(({ name }) => env.OAUTH_KV.delete(name)));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
}
