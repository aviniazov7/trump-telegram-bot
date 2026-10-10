#!/usr/bin/env node
// Manage the Telegram webhook for the Worker.
//
//   node scripts/telegram-webhook.mjs set      # point Telegram at the Worker
//   node scripts/telegram-webhook.mjs info     # show what Telegram has
//   node scripts/telegram-webhook.mjs delete   # back to no webhook (rollback)
//
// Reads TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET and WORKER_URL from the
// environment only — never from files, never as arguments (which would land
// in shell history). Prints neither the token nor the secret.
import { createHash } from "node:crypto";

const [command] = process.argv.slice(2);
const token = process.env.TELEGRAM_BOT_TOKEN ?? "";
const secret = process.env.TELEGRAM_WEBHOOK_SECRET ?? "";
const workerUrl = (process.env.WORKER_URL ?? "").replace(/\/+$/, "");

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

if (!["set", "info", "delete"].includes(command)) fail("usage: telegram-webhook.mjs set|info|delete");
if (!token) fail("TELEGRAM_BOT_TOKEN is not set in the environment");

// Must match src/webhook.ts → webhookPath().
const webhookPath = (s) =>
  `/telegram/${createHash("sha256").update(`telegram-webhook-path:${s}`).digest("hex").slice(0, 32)}`;
const mask = (url) => url.replace(/\/telegram\/[0-9a-f]{32}/, "/telegram/<path>");

async function call(method, payload = {}) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) fail(`${method} failed: ${data.error_code ?? res.status} ${data.description ?? ""}`);
  return data.result;
}

if (command === "set") {
  if (secret.length < 32 || !/^[A-Za-z0-9_-]+$/.test(secret)) {
    fail("TELEGRAM_WEBHOOK_SECRET must be >= 32 chars of A-Z a-z 0-9 _ - (use: openssl rand -hex 32)");
  }
  if (!/^https:\/\//.test(workerUrl)) fail("WORKER_URL must be the https:// URL of the deployed Worker");
  await call("setWebhook", {
    url: `${workerUrl}${webhookPath(secret)}`,
    secret_token: secret,
    allowed_updates: ["message", "my_chat_member"],
    max_connections: 10,
    // Keep /start messages sent while switching over.
    drop_pending_updates: false,
  });
  console.log(`✓ webhook set to ${workerUrl}/telegram/<path>`);
}

if (command === "info" || command === "set") {
  const info = await call("getWebhookInfo");
  console.log(
    JSON.stringify(
      {
        url: info.url ? mask(info.url) : "(none — the bot is in polling mode)",
        pending_update_count: info.pending_update_count,
        last_error: info.last_error_date
          ? `${new Date(info.last_error_date * 1000).toISOString()} ${info.last_error_message}`
          : null,
        allowed_updates: info.allowed_updates,
      },
      null,
      2,
    ),
  );
}

if (command === "delete") {
  await call("deleteWebhook", { drop_pending_updates: false });
  console.log("✓ webhook deleted — Telegram updates are available to getUpdates polling again");
}
