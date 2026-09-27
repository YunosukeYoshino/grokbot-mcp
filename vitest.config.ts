import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          CURSOR_WEBHOOK_URL: "https://cursor.test/webhook",
          CURSOR_WEBHOOK_API_KEY: "crsr_test",
          MCP_API_KEY: "test-key",
          CALLBACK_SIGNING_SECRET: "test-signing-secret",
          PUBLIC_BASE_URL: "https://bridge.test",
        },
      },
    }),
  ],
});
