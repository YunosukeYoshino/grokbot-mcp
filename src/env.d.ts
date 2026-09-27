// wrangler types はシークレットを出力しないので手で補う
interface BridgeSecrets {
  CURSOR_WEBHOOK_URL: string;
  CURSOR_WEBHOOK_API_KEY: string;
  MCP_API_KEY: string;
  CALLBACK_SIGNING_SECRET: string;
  PUBLIC_BASE_URL?: string;
}

interface Env extends BridgeSecrets {}

declare namespace Cloudflare {
  interface Env extends BridgeSecrets {}
}
