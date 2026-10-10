#!/usr/bin/env node
// Rollback helper: rebuild a legacy BOT_STATE value from the Worker's KV.
//
//   npx wrangler kv key get meta --binding STATE --remote > "$TMP/meta.json"
//   npx wrangler kv key list --prefix sub: --binding STATE --remote > "$TMP/subs.json"
//   node scripts/export-state.mjs "$TMP/meta.json" "$TMP/subs.json" | gh variable set BOT_STATE
//   rm "$TMP/meta.json" "$TMP/subs.json"
//
// Prints only the JSON (to pipe straight into gh); nothing is written to disk.
import { readFileSync } from "node:fs";

const [metaFile, subsFile] = process.argv.slice(2);
if (!metaFile || !subsFile) {
  console.error("usage: export-state.mjs <meta.json> <subs.json>");
  process.exit(1);
}
const meta = JSON.parse(readFileSync(metaFile, "utf8"));
const keys = JSON.parse(readFileSync(subsFile, "utf8"));

const subscribers = {};
for (const key of keys) {
  if (!key.name?.startsWith("sub:")) continue;
  subscribers[key.name.slice(4)] = key.metadata?.thread ?? null;
}

const state = {
  version: 1,
  last_seen: meta.lastSeen ?? "",
  // Telegram updates went to the webhook meanwhile; polling restarts at 0.
  last_update_id: 0,
  subscribers: Object.fromEntries(Object.entries(subscribers).sort(([a], [b]) => a.localeCompare(b))),
};
if (meta.sentAhead?.length) state.sent_ahead = meta.sentAhead;
process.stdout.write(JSON.stringify(state));
