// wrangler types はシークレットを出力しないので手で補う
interface BridgeSecrets {
  CURSOR_WEBHOOK_URL: string;
  CURSOR_WEBHOOK_API_KEY: string;
  MCP_API_KEY?: string;
  CALLBACK_SIGNING_SECRET: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  PUBLIC_BASE_URL?: string;
  GITHUB_OWNER_ID?: string;
}

interface Env extends BridgeSecrets {
  OAUTH_KV: KVNamespace;
  OAUTH_STATE_GUARD: DurableObjectNamespace<import("./oauth-state").OAuthStateGuard>;
  OAUTH_ADMISSION_GUARD: DurableObjectNamespace<import("./oauth-guard").OAuthAdmissionGuard>;
  OAUTH_TOKEN_GUARD: DurableObjectNamespace<import("./oauth-guard").OAuthTokenGuard>;
}

declare namespace Cloudflare {
  interface Env extends BridgeSecrets {
    OAUTH_KV: KVNamespace;
    OAUTH_STATE_GUARD: DurableObjectNamespace<import("./oauth-state").OAuthStateGuard>;
    OAUTH_ADMISSION_GUARD: DurableObjectNamespace<import("./oauth-guard").OAuthAdmissionGuard>;
    OAUTH_TOKEN_GUARD: DurableObjectNamespace<import("./oauth-guard").OAuthTokenGuard>;
  }
}
