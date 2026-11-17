import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          // Tests never reach the internet: Telegram calls get a fake "ok".
          outboundService: (request: Request) =>
            new URL(request.url).hostname === "api.telegram.org"
              ? Response.json({ ok: true, result: { message_id: 1 } })
              : new Response("blocked in tests", { status: 599 }),
          bindings: {
          TEST_MIGRATIONS: migrations,
          // Test-only key; the real one is a Worker secret.
          MASTER_KEY: "dGVzdC1vbmx5LW1hc3Rlci1rZXktMzItYnl0ZXMhISE=",
          TELEGRAM_BOT_TOKEN: "test-token",
          TELEGRAM_WEBHOOK_SECRET: "test-webhook-secret",
          ADMIN_CHAT_ID: "999",
        } },
      }),
    ],
    test: { setupFiles: ["./test/apply-migrations.ts"] },
  };
});
