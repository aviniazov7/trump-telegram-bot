#!/usr/bin/env node
// Convert the legacy BOT_STATE (GitHub Actions variable) into a KV bulk file.
//
//   gh variable get BOT_STATE | node scripts/import-state.mjs "$TMP/kv-import.json"
//   npx wrangler kv bulk put --binding STATE --remote "$TMP/kv-import.json"
//   rm "$TMP/kv-import.json"
//
// The output contains subscribers' chat IDs, so it must be written OUTSIDE the
// repository (this script refuses otherwise) and deleted after the upload.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SENT_TTL_S = 30 * 24 * 60 * 60; // must match src/store.ts
const out = process.argv[2];
const fail = (m) => {
  console.error(`✗ ${m}`);
  process.exit(1);
};

if (!out) fail("usage: gh variable get BOT_STATE | node scripts/import-state.mjs <output.json outside the repo>");
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rel = relative(repo, resolve(out));
if (!rel.startsWith("..") && !rel.startsWith("/")) fail("refusing to write chat IDs inside the repository — use $TMPDIR");

let legacy;
try {
  legacy = JSON.parse(readFileSync(0, "utf8"));
} catch {
  fail("stdin is not valid JSON — pipe in `gh variable get BOT_STATE`");
}
if (legacy.version !== 1) fail(`unexpected BOT_STATE version ${legacy.version}`);

const now = Date.now();
const meta = {
  v: 1,
  lastSeen: String(legacy.last_seen ?? ""),
  sentAhead: (legacy.sent_ahead ?? []).map(String),
  pending: {},
  menu: "",
  lastSuccess: now,
  sourceFailures: 0,
};
const entries = [];

// A broadcast the legacy bot left half-done: carry its progress over so the
// Worker finishes it without re-sending to chats that already have it.
const inFlight = legacy.in_flight;
if (inFlight?.post) {
  meta.pending[String(inFlight.post)] = now;
  for (const chat of inFlight.chats ?? []) {
    entries.push({ key: `sent:${inFlight.post}:${chat}`, value: "ok", expiration_ttl: SENT_TTL_S });
  }
}

const subscribers = Object.entries(legacy.subscribers ?? {});
for (const [chatId, thread] of subscribers) {
  entries.push({ key: `sub:${chatId}`, value: "1", metadata: { thread: thread ? String(thread) : null } });
}
entries.push({ key: "meta", value: JSON.stringify(meta) });

writeFileSync(out, JSON.stringify(entries), { mode: 0o600 });
console.log(
  `✓ wrote ${entries.length} KV entries (${subscribers.length} subscriber(s), last_seen=${meta.lastSeen || "-"}, ` +
    `in-flight=${inFlight?.post ? "yes" : "no"}) to ${out}`,
);
