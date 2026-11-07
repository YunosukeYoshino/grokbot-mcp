import { env, listDurableObjectIds, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { callbackToken } from "../src/index";
import { extractAnswerText, type RunRecord } from "../src/run";

let BASE = "https://bridge.test";
const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;

function call(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (!headers.has("cf-connecting-ip")) headers.set("cf-connecting-ip", "192.0.2.1");
  if (!headers.has("host")) headers.set("host", new URL(BASE).host);
  return worker.fetch(new Request(BASE + path, { ...init, headers }) as Request<unknown, IncomingRequestCfProperties>, env, ctx);
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

function collectCookies(headers: Headers, jar: Map<string, string>) {
  const extended = headers as Headers & { getSetCookie?: () => string[] };
  const setCookies = extended.getSetCookie?.() ?? (headers.get("set-cookie") ? [headers.get("set-cookie")!] : []);
  for (const cookie of setCookies) {
    const pair = cookie.split(";", 1)[0];
    const equals = pair.indexOf("=");
    if (equals < 1) continue;
    const name = pair.slice(0, equals);
    const value = pair.slice(equals + 1);
    if (/max-age=0/i.test(cookie) || !value) jar.delete(name);
    else jar.set(name, value);
  }
}

function cookieHeader(jar: Map<string, string>) {
  return Array.from(jar, ([name, value]) => `${name}=${value}`).join("; ");
}

function base64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function pkceChallenge(verifier: string) {
  return base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

async function registerOAuthClient(redirectUris = ["https://client.test/callback"], tokenEndpointAuthMethod = "none") {
  const response = await call("/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Bridge test client",
      redirect_uris: redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: tokenEndpointAuthMethod,
    }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as { client_id: string; client_secret?: string };
}

async function beginGitHubOAuth(options: {
  registeredRedirectUri?: string;
  redirectUri?: string;
  scope?: string;
  resource?: string;
  decision?: "approve" | "deny";
  tokenEndpointAuthMethod?: "none" | "client_secret_basic";
} = {}) {
  const resource = options.resource ?? `${BASE}/mcp`;
  const registeredRedirectUri = options.registeredRedirectUri ?? "https://client.test/callback";
  const redirectUri = options.redirectUri ?? registeredRedirectUri;
  const client = await registerOAuthClient([registeredRedirectUri], options.tokenEndpointAuthMethod);
  const cookies = new Map<string, string>();
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = await pkceChallenge(verifier);
  const requestedScope = options.scope ?? "grokbot:use";
  const authParams = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: redirectUri,
    response_type: "code",
    state: "mcp-state-test",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource,
  });
  if (requestedScope) authParams.set("scope", requestedScope);
  const consent = await call(`/authorize?${authParams}`, { method: "GET" });
  if (consent.status !== 200) return { client, consent, cookies, verifier, challenge, resource, redirectUri };
  const consentHtml = await consent.text();
  const handle = consentHtml.match(/name="handle" value="([^"]+)"/)?.[1];
  expect(handle).toBeTruthy();
  collectCookies(consent.headers, cookies);

  const form = new URLSearchParams({ handle: handle!, decision: options.decision ?? "approve" });
  if (requestedScope) form.set("scope", requestedScope);
  const githubRedirect = await call("/authorize", {
    method: "POST",
    headers: { cookie: cookieHeader(cookies), "content-type": "application/x-www-form-urlencoded" },
    body: form,
  });
  if (options.decision === "deny" || githubRedirect.status !== 302) {
    return { client, consent, cookies, verifier, challenge, resource, redirectUri, githubRedirect };
  }
  expect(githubRedirect.status).toBe(302);
  collectCookies(githubRedirect.headers, cookies);
  const githubUrl = new URL(githubRedirect.headers.get("location")!);
  expect(githubUrl.origin).toBe("https://github.com");
  expect(githubUrl.searchParams.get("code_challenge_method")).toBe("S256");
  expect(githubUrl.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);

  return { client, consent, cookies, verifier, challenge, resource, redirectUri, githubUrl, githubRedirect };
}

async function completeGitHubOAuth(githubId: number, options: Parameters<typeof beginGitHubOAuth>[0] & {
  tokenVerifier?: string;
  tokenResource?: string;
  parallelCallbackReplay?: boolean;
  sequentialCallbackReplay?: boolean;
  deferTokenExchange?: boolean;
} = {}) {
  const started = await beginGitHubOAuth(options);
  const { client, cookies, verifier, resource, redirectUri, githubUrl } = started;
  if (!githubUrl) throw new Error(`OAuth did not start: ${started.consent.status}`);

  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push(url.href);
    if (url.hostname === "github.com" && url.pathname === "/login/oauth/access_token") {
      const body = new URLSearchParams(init?.body as string);
      expect(body.get("code_verifier")).toBeTruthy();
      return Response.json({ access_token: "github-token-test", token_type: "bearer", scope: "read:user" });
    }
    if (url.hostname === "api.github.com" && url.pathname === "/user") return Response.json({ id: githubId });
    return originalFetch(input as RequestInfo, init);
  });

  const callbackPath = `/oauth/github/callback?code=github-code-test&state=${encodeURIComponent(githubUrl.searchParams.get("state")!)}`;
  const callbackWithoutCookie = await call(callbackPath, { method: "GET" });
  expect(callbackWithoutCookie.status).toBe(400);
  const callbackInit = { method: "GET", headers: { cookie: cookieHeader(cookies) } };
  const callbackResponses = options.parallelCallbackReplay
    ? await Promise.all([call(callbackPath, callbackInit), call(callbackPath, callbackInit)])
    : [await call(callbackPath, callbackInit)];
  const githubCallback = callbackResponses.find((response) => response.status === 302) ?? callbackResponses[0];
  if (options.sequentialCallbackReplay) callbackResponses.push(await call(callbackPath, callbackInit));
  expect(githubCallback.status).toBe(githubId === Number(env.GITHUB_OWNER_ID) ? 302 : 403);
  vi.restoreAllMocks();
  if (options.parallelCallbackReplay) {
    expect(callbackResponses.filter((response) => response.status === 302)).toHaveLength(1);
    expect(callbackResponses.filter((response) => response.status !== 302)).toHaveLength(1);
  }
  if (options.sequentialCallbackReplay) expect(callbackResponses[1].status).toBe(400);
  if (githubId !== Number(env.GITHUB_OWNER_ID)) return { githubCallback, calls };

  const mcpRedirect = new URL(githubCallback.headers.get("location")!);
  expect(mcpRedirect.origin).toBe("https://client.test");
  expect(mcpRedirect.searchParams.get("state")).toBe("mcp-state-test");
  const tokenExchange = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: client.client_id,
    code: mcpRedirect.searchParams.get("code")!,
    redirect_uri: redirectUri,
    code_verifier: options.tokenVerifier ?? verifier,
    resource: options.tokenResource ?? resource,
  });
  if (options.deferTokenExchange) return { githubCallback, calls, tokenExchange, client, verifier, resource, redirectUri };
  const tokenHeaders: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  if (client.client_secret) {
    tokenExchange.delete("client_id");
    tokenHeaders.authorization = `Basic ${btoa(`${encodeURIComponent(client.client_id)}:${encodeURIComponent(client.client_secret)}`)}`;
  }
  const tokenResponse = await call("/oauth/token", { method: "POST", headers: tokenHeaders, body: tokenExchange });
  if (!tokenResponse.ok) return { githubCallback, calls, tokenResponse, tokenExchange };
  expect(tokenResponse.status).toBe(200);
  const token = (await tokenResponse.json()) as { access_token: string };
  const mcpResponse = await call("/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token.access_token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/list", params: {} }),
  });
  return { githubCallback, calls, mcpResponse, tokenResponse, token, tokenExchange, callbackResponses };
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
  await runInDurableObject(env.OAUTH_ADMISSION_GUARD.get(env.OAUTH_ADMISSION_GUARD.idFromName("global")), (_obj, state) => state.storage.deleteAll());
  for (const id of await listDurableObjectIds(env.OAUTH_TOKEN_GUARD)) {
    await runInDurableObject(env.OAUTH_TOKEN_GUARD.get(id), (_obj, state) => state.storage.deleteAll());
  }
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

  it("includes OAuth discovery in the unauthenticated challenge and metadata", async () => {
    const response = await mcp("tools/list", {}, {});
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain(
      `resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`,
    );

    const metadata = await call("/.well-known/oauth-protected-resource/mcp");
    expect(metadata.status).toBe(200);
    expect(await metadata.json()).toMatchObject({
      resource: `${BASE}/mcp`,
      authorization_servers: [BASE],
      scopes_supported: ["grokbot:use"],
    });
  });

  it("disables the shared key when MCP_API_KEY is unset", async () => {
    env.MCP_API_KEY = "";
    expect((await mcp("tools/list", {}, { authorization: "Bearer test-key" })).status).toBe(401);
    expect((await mcp("tools/list", {}, { authorization: "Bearer " })).status).toBe(401);

    env.MCP_API_KEY = undefined;
    expect((await mcp("tools/list", {}, { authorization: "Bearer undefined" })).status).toBe(401);
    expect((await mcp("tools/list", {}, { "x-api-key": "undefined" })).status).toBe(401);
  });

  it("keeps the shared key working without GitHub settings while OAuth fails closed", async () => {
    env.GITHUB_OWNER_ID = "";
    env.GITHUB_CLIENT_ID = "";
    env.GITHUB_CLIENT_SECRET = "";
    expect((await mcp("tools/list", {}, { authorization: "Bearer test-key" })).status).toBe(200);
    expect((await mcp("tools/list", {}, { "x-api-key": "test-key" })).status).toBe(200);
    expect((await call("/authorize")).status).toBe(503);
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

describe("GitHub OAuth", () => {
  it("authorizes the configured GitHub ID and lets its MCP token list tools", async () => {
    const { githubCallback, calls, mcpResponse } = await completeGitHubOAuth(Number(env.GITHUB_OWNER_ID));
    expect(githubCallback.status).toBe(302);
    expect(calls).toEqual(["https://github.com/login/oauth/access_token", "https://api.github.com/user"]);
    expect(mcpResponse?.status).toBe(200);
    expect(await mcpResponse?.text()).toContain("ask_grokbot");
  });

  it("lets a client_secret_basic client on a foreign browser Origin initialize and list tools on workers.dev", async () => {
    // workers.dev ホストでだけ agents の既定 Origin 検証が有効になるので、本番と同じホスト名で通す
    const saved = BASE;
    BASE = "https://grokbot-bridge.yunosuke.workers.dev";
    env.PUBLIC_BASE_URL = BASE;
    // OAuthProvider は最初の呼び出しで helper を env にキャッシュし、その時点の resource に縛られるため、ホスト切替の前後で捨てる
    const cachedEnv = env as typeof env & { OAUTH_PROVIDER?: unknown };
    delete cachedEnv.OAUTH_PROVIDER;
    try {
      const { tokenResponse, token } = await completeGitHubOAuth(Number(env.GITHUB_OWNER_ID), { tokenEndpointAuthMethod: "client_secret_basic" });
      expect(tokenResponse?.status).toBe(200);
      const auth = { authorization: `Bearer ${token!.access_token}`, origin: "https://client.test" };
      const initialize = await mcp("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "browser-test-client", version: "1.0.0" },
      }, auth);
      expect(initialize.status).toBe(200);
      const tools = await mcp("tools/list", {}, auth);
      expect(tools.status).toBe(200);
      expect(await tools.text()).toContain("ask_grokbot");

      expect((await mcp("tools/list", {}, { origin: "https://client.test" })).status).toBe(401);
      expect((await mcp("tools/list", {}, { authorization: "Bearer never-issued-token", origin: "https://client.test" })).status).toBe(401);
    } finally {
      BASE = saved;
      delete cachedEnv.OAUTH_PROVIDER;
    }
  });

  it("rejects another GitHub ID before issuing an MCP authorization code", async () => {
    const otherGithubId = Number(env.GITHUB_OWNER_ID) + 1;
    const { githubCallback } = await completeGitHubOAuth(otherGithubId);
    expect(githubCallback.status).toBe(403);
    expect(await githubCallback.text()).toContain("not authorized");
  });

  it("rejects replayed and expired GitHub state", async () => {
    const replay = await completeGitHubOAuth(Number(env.GITHUB_OWNER_ID), { sequentialCallbackReplay: true });
    expect(replay.callbackResponses?.map((response) => response.status)).toEqual([302, 400]);
    expect(replay.calls.filter((url) => url.endsWith("/login/oauth/access_token"))).toHaveLength(1);

    const expired = await beginGitHubOAuth();
    const expiredState = expired.githubUrl!.searchParams.get("state")!;
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 11 * 60 * 1000);
    const expiredCallback = await call(
      `/oauth/github/callback?code=github-code-test&state=${encodeURIComponent(expiredState)}`,
      { method: "GET", headers: { cookie: cookieHeader(expired.cookies) } },
    );
    expect(expiredCallback.status).toBe(400);
    expect(await expiredCallback.text()).toContain("expired or was already used");
  });

  it("issues only one downstream authorization code for concurrent callbacks", async () => {
    const guardState = "oauth-state-race-test-unique";
    const guard = env.OAUTH_STATE_GUARD.get(env.OAUTH_STATE_GUARD.idFromName(guardState));
    expect(await guard.begin()).toBe(true);
    const consumed = await Promise.all([guard.consume(), guard.consume()]);
    expect(consumed.filter(Boolean)).toHaveLength(1);

    const { githubCallback, calls } = await completeGitHubOAuth(Number(env.GITHUB_OWNER_ID), { parallelCallbackReplay: true });
    expect(githubCallback.status).toBe(302);
    expect(calls.filter((url) => url.endsWith("/login/oauth/access_token"))).toHaveLength(1);
  });

  it("returns access_denied when the user declines consent", async () => {
    const denied = await beginGitHubOAuth({ decision: "deny" });
    expect(denied.githubRedirect?.status).toBe(302);
    const location = new URL(denied.githubRedirect!.headers.get("location")!);
    expect(location.origin).toBe("https://client.test");
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("state")).toBe("mcp-state-test");
  });

  it("rejects insecure registrations, unregistered redirects, and unsupported scopes", async () => {
    const insecure = await call("/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Insecure test client",
        redirect_uris: ["http://attacker.test/callback"],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    });
    expect(insecure.status).toBe(400);
    expect(await insecure.text()).toContain("OAuth client redirects must use HTTPS or localhost");

    const mismatch = await beginGitHubOAuth({ redirectUri: "https://attacker.test/callback" });
    expect(mismatch.consent.status).not.toBe(200);
    expect(mismatch.consent.headers.get("location") ?? "").not.toContain("attacker.test");

    const unsupported = await beginGitHubOAuth({ scope: "grokbot:admin" });
    expect(unsupported.githubRedirect?.status).toBe(400);
    expect(await unsupported.githubRedirect?.text()).toContain("Approved scopes must be ones this server supports");
  });

  it("rejects a wrong resource before issuing a token", async () => {
    const wrong = await beginGitHubOAuth({ resource: "https://other.test/mcp" });
    expect(wrong.consent.status).not.toBe(200);
    expect(wrong.consent.headers.get("location") ?? "").not.toContain("github.com");
  });

  it("rejects insufficient scopes, wrong PKCE verifier, and a wrong token resource", async () => {
    const insufficient = await completeGitHubOAuth(Number(env.GITHUB_OWNER_ID), { scope: "" });
    expect(insufficient.mcpResponse?.status).toBe(403);
    expect(insufficient.mcpResponse?.headers.get("www-authenticate")).toContain("insufficient_scope");

    const wrongVerifier = await completeGitHubOAuth(Number(env.GITHUB_OWNER_ID), { tokenVerifier: "wrong-verifier" });
    expect(wrongVerifier.tokenResponse?.status).toBe(400);

    const wrongResource = await completeGitHubOAuth(Number(env.GITHUB_OWNER_ID), { tokenResource: "https://other.test/mcp" });
    expect(wrongResource.tokenResponse?.status).toBe(400);
  });

  it("rejects unknown and expired OAuth access tokens", async () => {
    const invalid = await mcp("tools/list", {}, { authorization: "Bearer never-issued-token" });
    expect(invalid.status).toBe(401);

    const { tokenResponse, token } = await completeGitHubOAuth(Number(env.GITHUB_OWNER_ID));
    expect(tokenResponse?.status).toBe(200);
    const accessToken = token!.access_token;
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 61 * 60 * 1000);
    const expired = await mcp("tools/list", {}, { authorization: `Bearer ${accessToken}` });
    expect(expired.status).toBe(401);
  });

  it("does not redeem a downstream authorization code twice", async () => {
    const { tokenExchange, token } = await completeGitHubOAuth(Number(env.GITHUB_OWNER_ID));
    const replay = await call("/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(tokenExchange!),
    });
    expect(replay.status).toBe(503);
    const [userId, grantId] = tokenExchange!.get("code")!.split(":");
    const guard = env.OAUTH_TOKEN_GUARD.get(env.OAUTH_TOKEN_GUARD.idFromName(`grant:${userId}:${grantId}`));
    expect(await guard.isRevoked()).toBe(false);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 11_000);
    const replayAfterGrace = await call("/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(tokenExchange!),
    });
    expect(replayAfterGrace.status).toBe(400);
    expect(await guard.isRevoked()).toBe(true);
    expect((await mcp("tools/list", {}, { authorization: `Bearer ${token!.access_token}` })).status).toBe(401);
  });

  it("atomically redeems authorization codes after PKCE validation", async () => {
    const started = await completeGitHubOAuth(Number(env.GITHUB_OWNER_ID), { deferTokenExchange: true });
    const form = new URLSearchParams(started.tokenExchange!);
    const invalidPkce = new URLSearchParams(form);
    invalidPkce.set("code_verifier", "incorrect-verifier");
    const rejected = await call("/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: invalidPkce,
    });
    expect(rejected.status).toBe(400);

    const responses = await Promise.all([
      call("/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form }),
      call("/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form }),
    ]);
    expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
    expect(responses.every((response) => response.status !== 200 || response.headers.get("cache-control")?.includes("no-store"))).toBe(true);
  });

  it("returns identical refresh responses during retry grace and revokes a later replay", async () => {
    const { token, tokenResponse, tokenExchange } = await completeGitHubOAuth(Number(env.GITHUB_OWNER_ID));
    expect(tokenResponse?.status).toBe(200);
    const initial = token as { access_token: string; refresh_token: string };
    expect(initial.refresh_token).toBeTruthy();

    const refresh = (refreshToken: string) => call("/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: tokenExchange!.get("client_id")!, refresh_token: refreshToken, resource: `${BASE}/mcp` }),
    });
    const first = await refresh(initial.refresh_token);
    expect(first.status).toBe(200);
    const firstBody = await first.text();
    const retry = await refresh(initial.refresh_token);
    expect(retry.status).toBe(200);
    expect(await retry.text()).toBe(firstBody);

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000);
    const replay = await refresh(initial.refresh_token);
    expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({ error: "invalid_grant" });
    const [userId, grantId] = initial.refresh_token.split(":");
    expect(await env.OAUTH_TOKEN_GUARD.get(env.OAUTH_TOKEN_GUARD.idFromName(`grant:${userId}:${grantId}`)).isRevoked()).toBe(true);
  });

  it("revokes the active token family if a replay changes the original request", async () => {
    const { token, tokenExchange } = await completeGitHubOAuth(Number(env.GITHUB_OWNER_ID));
    const initial = token as { access_token: string; refresh_token: string };
    const clientId = tokenExchange!.get("client_id")!;
    const refresh = (resource: string) => call("/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: clientId, refresh_token: initial.refresh_token, resource }),
    });
    expect((await refresh(`${BASE}/mcp`)).status).toBe(200);
    const alteredRetry = await refresh("https://other.test/mcp");
    expect(alteredRetry.status).toBe(400);
    expect(await alteredRetry.json()).toMatchObject({ error: "invalid_grant" });
    const oldAccessToken = await mcp("tools/list", {}, { authorization: `Bearer ${initial.access_token}` });
    expect(oldAccessToken.status).toBe(401);
  });

  it("keeps the grant usable after a refresh the provider rejected before rotating", async () => {
    const { token, tokenExchange } = await completeGitHubOAuth(Number(env.GITHUB_OWNER_ID));
    const initial = token as { access_token: string; refresh_token: string };
    const refresh = () => call("/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: tokenExchange!.get("client_id")!, refresh_token: initial.refresh_token, resource: `${BASE}/mcp` }),
    });
    const kv = env.OAUTH_KV;
    let failGrantWrite = true;
    env.OAUTH_KV = new Proxy(kv, {
      get(target, prop) {
        if (prop === "put") {
          return (key: string, ...rest: unknown[]) => {
            if (failGrantWrite && key.startsWith("grant:")) {
              failGrantWrite = false;
              throw new Error("KV write failed");
            }
            return (target.put as (...args: unknown[]) => unknown)(key, ...rest);
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const rejected = await refresh().catch(() => null);
    expect(rejected?.ok ?? false).toBe(false);
    expect((await refresh()).status).toBe(200);
  });

  it("keeps the refresh in flight when the provider failed after rotating the grant", async () => {
    const { token, tokenExchange } = await completeGitHubOAuth(Number(env.GITHUB_OWNER_ID));
    const initial = token as { access_token: string; refresh_token: string };
    const refresh = () => call("/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: tokenExchange!.get("client_id")!, refresh_token: initial.refresh_token, resource: `${BASE}/mcp` }),
    });
    const kv = env.OAUTH_KV;
    let failTokenWrite = true;
    env.OAUTH_KV = new Proxy(kv, {
      get(target, prop) {
        if (prop === "put") {
          // grant は保存された後、access token の保存で失敗させる（ローテーション確定後の障害）
          return (key: string, ...rest: unknown[]) => {
            if (failTokenWrite && key.startsWith("token:")) {
              failTokenWrite = false;
              throw new Error("KV write failed");
            }
            return (target.put as (...args: unknown[]) => unknown)(key, ...rest);
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const failed = await refresh().catch(() => null);
    expect(failed?.ok ?? false).toBe(false);
    const retry = await refresh();
    expect(retry.status).toBe(503);
    expect(retry.headers.get("retry-after")).toBeTruthy();
  });

  it("rejects an issued OAuth token after the owner GitHub ID changes", async () => {
    const { token } = await completeGitHubOAuth(Number(env.GITHUB_OWNER_ID));
    const { access_token } = token as { access_token: string };
    expect((await mcp("tools/list", {}, { authorization: `Bearer ${access_token}` })).status).toBe(200);
    env.GITHUB_OWNER_ID = "987654321";
    expect((await mcp("tools/list", {}, { authorization: `Bearer ${access_token}` })).status).toBe(403);
  });
});

describe("OAuth admission and body limits", () => {
  it("rate-limits OAuth endpoints per IP with Retry-After", async () => {
    const ip = "192.0.2.77";
    const responses = [];
    for (let i = 0; i < 21; i++) responses.push(await call("/authorize?response_type=invalid", { headers: { "cf-connecting-ip": ip } }));
    expect(responses[19].status).not.toBe(429);
    expect(responses[20].status).toBe(429);
    expect(Number(responses[20].headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("enforces the exact global OAuth admission limit", async () => {
    const global = env.OAUTH_ADMISSION_GUARD.get(env.OAUTH_ADMISSION_GUARD.idFromName("global"));
    const hashIp = async (ip: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ip))), (b) => b.toString(16).padStart(2, "0")).join("");
    for (let i = 0; i < 120; i++) expect((await global.take(await hashIp(`198.51.100.${i}`), 20, 120)).allowed).toBe(true);
    const deniedIp = await hashIp("198.51.100.200");
    const before = await runInDurableObject(global, (_obj, state) => state.storage.get<Record<string, { count: number }>>("ipCounters"));
    const denied = await global.take(deniedIp, 20, 120);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfter).toBeGreaterThan(0);
    const ipCounters = await runInDurableObject(global, (_obj, state) => state.storage.get<Record<string, { count: number }>>("ipCounters"));
    expect(ipCounters).toEqual(before);
    expect(ipCounters?.[deniedIp]).toBeUndefined();
    expect(await runInDurableObject(global, (_obj, state) => state.storage.getAlarm())).not.toBeNull();
  });

  it("does not spend global capacity when an IP is already denied", async () => {
    const global = env.OAUTH_ADMISSION_GUARD.get(env.OAUTH_ADMISSION_GUARD.idFromName("global"));
    const ipHash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("198.51.100.211"))), (b) => b.toString(16).padStart(2, "0")).join("");
    for (let i = 0; i < 20; i++) expect((await global.take(ipHash, 20, 120)).allowed).toBe(true);
    expect((await global.take(ipHash, 20, 120)).reason).toBe("ip");
    const state = await runInDurableObject(global, (_obj, storage) => storage.storage.get<{ count: number }>("counter"));
    expect(state?.count).toBe(20);
  });

  it("keeps the new window counters when a delayed older alarm runs", async () => {
    const global = env.OAUTH_ADMISSION_GUARD.get(env.OAUTH_ADMISSION_GUARD.idFromName("global"));
    const hashIp = async (ip: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ip))), (b) => b.toString(16).padStart(2, "0")).join("");
    const oldWindow = Math.floor(Date.now() / 60_000);
    expect((await global.take(await hashIp("198.51.100.220"), 20, 120)).allowed).toBe(true);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime((oldWindow + 1) * 60_000 + 100);
    expect((await global.take(await hashIp("198.51.100.221"), 20, 120)).allowed).toBe(true);
    expect(await runDurableObjectAlarm(global)).toBe(true);
    const counter = await runInDurableObject(global, (_obj, state) => state.storage.get<{ window: number; count: number }>("counter"));
    expect(counter).toMatchObject({ window: oldWindow + 1, count: 1 });
  });

  it("413s streamed OAuth bodies above the cap and cancels the stream", async () => {
    let produced = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { produced++; controller.enqueue(new Uint8Array(16 * 1024)); },
      cancel() { cancelled = true; },
    });
    const response = await call("/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "192.0.2.88" },
      body,
      duplex: "half",
    } as RequestInit);
    expect(response.status).toBe(413);
    expect(produced).toBeLessThan(10);
    expect(cancelled).toBe(true);
  });

  it("rejects oversized declared consent and DCR bodies before parsing", async () => {
    for (const path of ["/authorize", "/oauth/register"]) {
      const response = await call(path, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "content-length": String(64 * 1024 + 1), "cf-connecting-ip": `192.0.2.${path === "/authorize" ? "89" : "90"}` },
        body: "x",
      });
      expect(response.status).toBe(413);
    }
  });
});

describe("OAuth recovery and revocation regressions", () => {
  function tokenPost(form: URLSearchParams) {
    return call("/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form });
  }
  function refreshForm(token: string, clientId: string) {
    return new URLSearchParams({ grant_type: "refresh_token", refresh_token: token, client_id: clientId, resource: `${BASE}/mcp` });
  }
  function overrideKv(overrides: Record<string, Function>) {
    const original = env.OAUTH_KV;
    env.OAUTH_KV = new Proxy(original, { get(target, key) {
      if (typeof key === "string" && overrides[key]) return overrides[key];
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    return original;
  }

  it("releases a code reservation only after a definitive pre-commit KV 429", async () => {
    const flow = await completeGitHubOAuth(Number(env.GITHUB_OWNER_ID), { deferTokenExchange: true });
    const original = env.OAUTH_KV;
    let failed = false;
    overrideKv({ put: async (key: string, value: string, options: any) => {
      if (key.startsWith("grant:") && !failed) { failed = true; throw new Error("KV PUT failed: 429 Too Many Requests"); }
      return original.put(key, value, options);
    } });
    const first = await tokenPost(new URLSearchParams(flow.tokenExchange!));
    expect(first.status).toBe(429);
    expect(first.headers.get("retry-after")).toBe("30");
    env.OAUTH_KV = original;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 30_000);
    expect((await tokenPost(new URLSearchParams(flow.tokenExchange!))).status).toBe(200);
  });

  it("releases a refresh reservation when client lookup fails before provider handling", async () => {
    const flow = await completeGitHubOAuth(Number(env.GITHUB_OWNER_ID));
    const initial = flow.token as unknown as { refresh_token: string };
    const clientId = flow.tokenExchange!.get("client_id")!;
    const original = env.OAUTH_KV;
    overrideKv({ get: async (key: string, options: unknown) => {
      if (key === `client:${clientId}`) throw new Error("simulated transient client KV read failure");
      return original.get(key, options as "json");
    } });
    await expect(tokenPost(refreshForm(initial.refresh_token, clientId))).rejects.toThrow("simulated transient client KV read failure");
    env.OAUTH_KV = original;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 31_000);
    expect((await tokenPost(refreshForm(initial.refresh_token, clientId))).status).toBe(200);
    const [userId, grantId] = initial.refresh_token.split(":");
    expect(await env.OAUTH_TOKEN_GUARD.get(env.OAUTH_TOKEN_GUARD.idFromName(`grant:${userId}:${grantId}`)).isRevoked()).toBe(false);
  });

  it("preserves the retry-cache cleanup alarm after a later refresh aborts", async () => {
    const flow = await completeGitHubOAuth(Number(env.GITHUB_OWNER_ID));
    const initial = flow.token as unknown as { refresh_token: string };
    const clientId = flow.tokenExchange!.get("client_id")!;
    const first = await tokenPost(refreshForm(initial.refresh_token, clientId));
    expect(first.status).toBe(200);
    const rotated = await first.json() as { refresh_token: string };
    const [userId, grantId] = initial.refresh_token.split(":");
    const guard = env.OAUTH_TOKEN_GUARD.get(env.OAUTH_TOKEN_GUARD.idFromName(`grant:${userId}:${grantId}`));

    const original = env.OAUTH_KV;
    overrideKv({ get: async (key: string, options: unknown) => {
      if (key === `client:${clientId}`) throw new Error("simulated transient client lookup failure");
      return original.get(key, options as "json");
    } });
    await expect(tokenPost(refreshForm(rotated.refresh_token, clientId))).rejects.toThrow("simulated transient client lookup failure");
    env.OAUTH_KV = original;

    const alarmAt = await runInDurableObject(guard, (_obj, state) => state.storage.getAlarm());
    expect(alarmAt).not.toBeNull();
    expect(alarmAt! - Date.now()).toBeLessThanOrEqual(11_000);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 11_000);
    expect(await runDurableObjectAlarm(guard)).toBe(true);
    const usedHash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(initial.refresh_token))), (b) => b.toString(16).padStart(2, "0")).join("");
    const used = await runInDurableObject(guard, (_obj, state) => state.storage.get<{ response?: unknown; replayUntil: number }>(`used:${usedHash}`));
    expect(used?.response).toBeUndefined();
    expect(used?.replayUntil).toBeLessThan(Date.now());
  });

  it("releases a refresh reservation after a definitive pre-commit KV 429", async () => {
    const flow = await completeGitHubOAuth(Number(env.GITHUB_OWNER_ID));
    const initial = flow.token as unknown as { refresh_token: string };
    const clientId = flow.tokenExchange!.get("client_id")!;
    const original = env.OAUTH_KV;
    let failed = false;
    overrideKv({ put: async (key: string, value: string, options: any) => {
      if (key.startsWith("grant:") && !failed) { failed = true; throw new Error("KV PUT failed: 429 Too Many Requests"); }
      return original.put(key, value, options);
    } });
    const first = await tokenPost(refreshForm(initial.refresh_token, clientId));
    expect(first.status).toBe(429);
    expect(first.headers.get("retry-after")).toBe("30");
    env.OAUTH_KV = original;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 30_000);
    expect((await tokenPost(refreshForm(initial.refresh_token, clientId))).status).toBe(200);
  });

  it("keeps an uncertain refresh reservation fail-closed after grant mutation", async () => {
    const flow = await completeGitHubOAuth(Number(env.GITHUB_OWNER_ID));
    const initial = flow.token as unknown as { refresh_token: string };
    const clientId = flow.tokenExchange!.get("client_id")!;
    const original = env.OAUTH_KV;
    overrideKv({ put: async (key: string, value: string, options: any) => {
      if (key.startsWith("token:")) throw new Error("KV PUT failed: 429 Too Many Requests");
      return original.put(key, value, options);
    } });
    const first = await tokenPost(refreshForm(initial.refresh_token, clientId));
    expect(first.status).toBe(429);
    env.OAUTH_KV = original;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 31_000);
    const retry = await tokenPost(refreshForm(initial.refresh_token, clientId));
    expect(retry.status).toBe(400);
    expect(await retry.json()).toMatchObject({ error: "invalid_grant" });
    const [userId, grantId] = initial.refresh_token.split(":");
    expect(await env.OAUTH_TOKEN_GUARD.get(env.OAUTH_TOKEN_GUARD.idFromName(`grant:${userId}:${grantId}`)).isRevoked()).toBe(true);
  });

  it("removes expired cached token bodies but retains refresh replay hashes", async () => {
    const flow = await completeGitHubOAuth(Number(env.GITHUB_OWNER_ID));
    const initial = flow.token as unknown as { refresh_token: string };
    const first = await tokenPost(refreshForm(initial.refresh_token, flow.tokenExchange!.get("client_id")!));
    const response = await first.text();
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(initial.refresh_token))), (b) => b.toString(16).padStart(2, "0")).join("");
    const [userId, grantId] = initial.refresh_token.split(":");
    const stub = env.OAUTH_TOKEN_GUARD.get(env.OAUTH_TOKEN_GUARD.idFromName(`grant:${userId}:${grantId}`));
    const encrypted = await runInDurableObject(stub, (_obj, state) => state.storage.get<{ response?: { iv: string; ciphertext: string; body?: string } }>(`used:${hash}`));
    expect(encrypted?.response?.ciphertext).toMatch(/^[0-9a-f]+$/);
    expect(encrypted?.response?.body).toBeUndefined();
    expect(encrypted?.response?.ciphertext).not.toContain(response);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 60_000);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const used = await runInDurableObject(stub, (_obj, state) => state.storage.get<{ response?: { ciphertext: string }; replayUntil: number }>(`used:${hash}`));
    expect(used?.response).toBeUndefined();
    expect(used?.replayUntil).toBeLessThan(Date.now());
    expect(used).toBeTruthy();
    expect(response).toContain("refresh_token");
  });

  it("fails closed when an encrypted retry response is tampered with", async () => {
    const flow = await completeGitHubOAuth(Number(env.GITHUB_OWNER_ID));
    const initial = flow.token as unknown as { refresh_token: string };
    const clientId = flow.tokenExchange!.get("client_id")!;
    expect((await tokenPost(refreshForm(initial.refresh_token, clientId))).status).toBe(200);
    const [userId, grantId] = initial.refresh_token.split(":");
    const guard = env.OAUTH_TOKEN_GUARD.get(env.OAUTH_TOKEN_GUARD.idFromName(`grant:${userId}:${grantId}`));
    const tokenHash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(initial.refresh_token))), (b) => b.toString(16).padStart(2, "0")).join("");
    await runInDurableObject(guard, async (_obj, state) => {
      const key = `used:${tokenHash}`;
      const record = await state.storage.get<any>(key);
      expect(record.response.iv).toMatch(/^[0-9a-f]{24}$/);
      record.response.ciphertext = `${record.response.ciphertext[0] === "0" ? "1" : "0"}${record.response.ciphertext.slice(1)}`;
      await state.storage.put(key, record);
    });
    const retry = await tokenPost(refreshForm(initial.refresh_token, clientId));
    expect(retry.status).toBe(400);
    expect(await retry.json()).toMatchObject({ error: "invalid_grant" });
    expect(await guard.isRevoked()).toBe(true);
  });

  it("synchronizes authenticated refresh grant revocation with the retry cache", async () => {
    const flow = await completeGitHubOAuth(Number(env.GITHUB_OWNER_ID));
    const initial = flow.token as unknown as { access_token: string; refresh_token: string };
    const clientId = flow.tokenExchange!.get("client_id")!;
    const form = refreshForm(initial.refresh_token, clientId);
    const refreshed = await tokenPost(form);
    expect(refreshed.status).toBe(200);
    const rotated = await refreshed.json() as { access_token: string; refresh_token: string };
    const revoke = await tokenPost(new URLSearchParams({ client_id: clientId, token: rotated.refresh_token, token_type_hint: "refresh_token" }));
    expect(revoke.status).toBe(200);
    const retry = await tokenPost(form);
    expect(retry.status).toBe(400);
    expect(await retry.json()).toMatchObject({ error: "invalid_grant" });
    expect((await mcp("tools/list", {}, { authorization: `Bearer ${rotated.access_token}` })).status).toBe(401);
  });

  it("allows a lost-response retry at the rotation cap", async () => {
    const flow = await completeGitHubOAuth(Number(env.GITHUB_OWNER_ID));
    const initial = flow.token as unknown as { refresh_token: string };
    const clientId = flow.tokenExchange!.get("client_id")!;
    const form = refreshForm(initial.refresh_token, clientId);
    const first = await tokenPost(form);
    expect(first.status).toBe(200);
    const originalBody = await first.text();
    const [userId, grantId] = initial.refresh_token.split(":");
    const stub = env.OAUTH_TOKEN_GUARD.get(env.OAUTH_TOKEN_GUARD.idFromName(`grant:${userId}:${grantId}`));
    await runInDurableObject(stub, (_obj, state) => state.storage.put("refreshRotationCount", 1_000));
    const retry = await tokenPost(form);
    expect(retry.status).toBe(200);
    expect(await retry.text()).toBe(originalBody);
  });

  it("returns 503 rather than issuing a second code token from stale KV state", async () => {
    const flow = await completeGitHubOAuth(Number(env.GITHUB_OWNER_ID), { deferTokenExchange: true });
    const [userId, grantId] = flow.tokenExchange!.get("code")!.split(":");
    const key = `grant:${userId}:${grantId}`;
    const staleGrant = await env.OAUTH_KV.get(key, "json");
    const first = await tokenPost(new URLSearchParams(flow.tokenExchange!));
    expect(first.status).toBe(200);
    const firstToken = await first.json() as { access_token: string };
    const original = env.OAUTH_KV;
    overrideKv({ get: async (requested: string, options: unknown) => requested === key ? staleGrant : original.get(requested, options as "json") });
    expect((await tokenPost(new URLSearchParams(flow.tokenExchange!))).status).toBe(503);
    expect((await mcp("tools/list", {}, { authorization: `Bearer ${firstToken.access_token}` })).status).toBe(200);
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

  it("reports webhook failure on 5xx, leaves the run pending for a late callback, and keeps the budget spent", async () => {
    env.ASK_DAILY_LIMIT = "1";
    const sent = captureWebhook(500);
    const out = await tool("ask_grokbot", { message: "hi", wait_seconds: 0 });
    expect(out).toMatchObject({
      ok: false,
      error: "webhook_failed",
      webhook_status: 500,
      status: "pending",
      run_id: expect.any(String),
    });
    expect(sent).toHaveLength(1);
    expect((await storedRun(out.run_id))?.status).toBe("pending");
    expect(await tool("ask_grokbot", { message: "again", wait_seconds: 0 })).toMatchObject({ error: "daily_limit_reached" });
    expect(sent).toHaveLength(1);

    vi.restoreAllMocks();
    const cb = await postCallback(sent[0].body.callback_url, { ok: true, answer: "late", run_id: out.run_id });
    expect(cb.status).toBe(200);
    expect(await tool("get_grokbot_run", { run_id: out.run_id })).toMatchObject({
      status: "answered",
      answer_text: "late",
    });
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
