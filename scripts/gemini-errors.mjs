#!/usr/bin/env node
// Show why Gemini failed, per post.
// Reads from the Worker's /admin/gemini-errors endpoint (Durable Object state)
// when TELEGRAM_WEBHOOK_SECRET is available in env or .dev.vars, and falls back
// to legacy Workers KV (gemini-error:<postId>).
//
//   npm run gemini-errors              # every post with failures (last 7 days)
//   npm run gemini-errors -- <postId>  # just one post
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const loadDevVars = () => {
  if (!existsSync(".dev.vars")) return {};
  const out = {};
  for (const line of readFileSync(".dev.vars", "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq > 0) out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
};

const only = process.argv[2];
const devVars = loadDevVars();
const secret = process.env.TELEGRAM_WEBHOOK_SECRET || devVars.TELEGRAM_WEBHOOK_SECRET || "";
const botUrl = (process.env.TRUMP_BOT_URL || "https://trump-telegram-bot.aviniazov7.workers.dev").replace(
  /\/+$/,
  "",
);

let records = [];
if (secret) {
  const qs = only ? `?postId=${encodeURIComponent(only)}` : "";
  const res = await fetch(`${botUrl}/admin/gemini-errors${qs}`, {
    headers: { "X-Telegram-Bot-Api-Secret-Token": secret },
  });
  if (!res.ok) {
    console.error(`Failed to fetch /admin/gemini-errors: HTTP ${res.status}`);
    process.exit(1);
  }
  const body = await res.json();
  records = body.records ?? [];
} else {
  const wrangler = (...args) =>
    execFileSync("npx", ["wrangler", ...args, "--binding", "STATE", "--remote"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  const keys = only
    ? [`gemini-error:${only}`]
    : JSON.parse(wrangler("kv", "key", "list", "--prefix", "gemini-error:")).map((k) => k.name);
  for (const key of keys) {
    try {
      records.push(JSON.parse(wrangler("kv", "key", "get", key)));
    } catch {
      console.log(`${key}: not found`);
    }
  }
}

if (!records.length) {
  console.log("No Gemini failures recorded in the last 7 days.");
  process.exit(0);
}

const israel = (ms) =>
  new Date(ms).toLocaleString("en-GB", {
    timeZone: "Asia/Jerusalem",
    dateStyle: "short",
    timeStyle: "medium",
  });

for (const record of records) {
  const outcome = record.gaveUpAt
    ? `sent in English at ${israel(record.gaveUpAt)}`
    : "translated later, or still retrying";
  console.log(
    `\npost ${record.postId} — first failure ${israel(record.firstFailureAt)}, ${record.attempts.length} attempt(s), ${outcome}`,
  );
  for (const a of record.attempts) console.log(`  ${israel(a.at)}  ${a.error}`);
}
