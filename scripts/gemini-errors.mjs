#!/usr/bin/env node
// Show why Gemini failed, per post, from the Worker's KV (gemini-error:<postId>).
//
//   npm run gemini-errors              # every post with failures (last 7 days)
//   npm run gemini-errors -- <postId>  # just one post
//
// Uses your `wrangler login`; prints only post IDs, times and Gemini's error
// messages — never secrets.
import { execFileSync } from "node:child_process";

const wrangler = (...args) =>
  execFileSync("npx", ["wrangler", ...args, "--binding", "STATE", "--remote"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });

const only = process.argv[2];
const keys = only
  ? [`gemini-error:${only}`]
  : JSON.parse(wrangler("kv", "key", "list", "--prefix", "gemini-error:")).map((k) => k.name);

if (!keys.length) {
  console.log("No Gemini failures recorded in the last 7 days.");
  process.exit(0);
}

const israel = (ms) =>
  new Date(ms).toLocaleString("en-GB", { timeZone: "Asia/Jerusalem", dateStyle: "short", timeStyle: "medium" });

for (const key of keys) {
  let record;
  try {
    record = JSON.parse(wrangler("kv", "key", "get", key));
  } catch {
    console.log(`${key}: not found`);
    continue;
  }
  const outcome = record.gaveUpAt ? `sent in English at ${israel(record.gaveUpAt)}` : "translated later, or still retrying";
  console.log(`\npost ${record.postId} — first failure ${israel(record.firstFailureAt)}, ${record.attempts.length} attempt(s), ${outcome}`);
  for (const a of record.attempts) console.log(`  ${israel(a.at)}  ${a.error}`);
}
