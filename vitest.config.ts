import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Tests run inside the Workers runtime (workerd) with a local KV namespace.
// The bindings below are test-only placeholders, never real secrets.
export default defineConfig({
  plugins: [
    cloudflareTest({
      // Workers AI has no local simulator. Tests inject a fake client and
      // never call the binding, so the remote proxy (and its API token) is
      // not used. Production still has the [ai] binding in wrangler.toml.
      remoteBindings: false,
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        bindings: {
          TELEGRAM_BOT_TOKEN: "test-bot-token",
          TELEGRAM_WEBHOOK_SECRET: "test-webhook-secret-0123456789abcdef",
          GEMINI_API_KEY: "test-gemini-key",
          ADMIN_CHAT_ID: "999",
          DRY_RUN: "false",
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "istanbul",
      include: ["src/**/*.ts"],
      reporter: ["text", "json-summary"],
      thresholds: { lines: 85 },
    },
  },
});
