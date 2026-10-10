# Trump Truth Social → Telegram Bot

[![Tests](https://github.com/aviniazov7/trump-telegram-bot/actions/workflows/tests.yml/badge.svg)](https://github.com/aviniazov7/trump-telegram-bot/actions/workflows/tests.yml)
[![Coverage](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/aviniazov7/trump-telegram-bot/badges/coverage.json)](https://github.com/aviniazov7/trump-telegram-bot/actions/workflows/tests.yml)

Fetches Donald Trump's Truth Social posts, translates them to Hebrew, tags
each one by its likely market impact, and broadcasts them to every Telegram
subscriber. It runs as a **Cloudflare Worker**: a Cron Trigger every 5 minutes
handles posts, and a webhook handles bot commands.

> **Migration status.** The Worker is new. Until it is verified, the original
> Python bot in [`legacy/`](legacy/) keeps serving subscribers from GitHub
> Actions, and the Worker runs in `DRY_RUN` mode, sending previews to the
> admin only. See [Cutover](#cutover).

## Why Cloudflare beats the Actions cron here

| | GitHub Actions cron | Cloudflare Cron Trigger |
|---|---|---|
| Scheduling | Best effort: `*/10` runs arrived **2.5–8 h** apart | Every 5 minutes, reliably |
| Latency to subscribers | Hours | ≤ 5 minutes |
| `/start` handling | Polled on the next run (hours) | Webhook: instant |
| State | One JSON variable through the REST API, 48 KB cap, needs a PAT | Workers KV, no PAT |
| Cost | Free | Free plan (limits below); $5/month Workers Paid for headroom |

Fast delivery is the point of 🔴 high-impact alerts. Hours of delay defeat
it.

## Architecture

```
                    ┌──────────────────────── Cloudflare Worker ────────────────────────┐
 Cron "*/5 * * * *" ▶│ scheduled() → runCron                                              │
                    │   1. meta ← KV            heartbeat check → ⏰ alert if > 15 min    │
                    │   2. posts ← trumpstruth RSS (100) │ CNN archive prefix (fallback) │
                    │   3. new posts after lastSeen      │ 10 failed runs → 📡 alert      │
                    │   4. analysis ← KV cache │ Gemini (translate + tags) │ free chain   │
                    │   5. order: in progress → 🔴 high → rest (each oldest first)        │
                    │   6. for each subscriber without sent:<post>:<chat>:               │
                    │        sendMessage → write sent:<post>:<chat> immediately          │
                    │   7. cursor/heartbeat → KV meta, ping HEALTHCHECK_URL              │
                    │                                                                    │
 Telegram ─────────▶│ fetch() POST /telegram/<path>  (secret header, constant-time)     │
  (webhook)         │   /start /trumphere → sub:<chat>   /stop → delete   welcome/bye   │
                    └───────┬───────────────────────────────┬────────────────────────────┘
                            ▼                               ▼
                     Workers KV "STATE"              Telegram Bot API ── ADMIN_CHAT_ID alerts
       meta · sub:<chat> · sent:<post>:<chat> · analysis:<post> · alert:<kind>

GitHub Actions: CI only (tests, lint, secret scan) + optional deploy on push to main.
```

### One run

- **Budgets.** Each run counts its subrequests (the free plan allows 50 per
  invocation) and stops starting new work after `RUN_TIME_BUDGET_SECONDS`
  (40). Whatever is left continues in the next run, 5 minutes later, so runs
  never overlap.
- **No missed posts.** The run scans up to 100 recent posts for `lastSeen`.
  If the RSS window doesn't reach it, it reads the first 512 KB of the 20 MB
  CNN archive. A full parse would exceed the Workers CPU limit. If `lastSeen`
  is nowhere to be found, only the newest post is sent, and you get an alert.
- **Never twice.** Every send is recorded in `sent:<post>:<chat>` right after
  it happens. A chat that has any record for a post never gets that post
  again. A run that stops anywhere resumes exactly where it left off. The
  analysis is cached in `analysis:<post>`, so a resumed post goes out with
  the same text.
- **Telegram errors:**

  | Telegram answer | Result for that chat |
  |---|---|
  | OK | Recorded `ok` |
  | 429 | Waits `retry_after` (≤ 10 s, within budget); otherwise retried next run. A 429 is never delivered |
  | Timeout / 5xx / long message cut short | Recorded `uncertain`: may have arrived, **never resent** |
  | 403, `chat not found` | Recorded `gone`, chat unsubscribed |
  | Group upgraded to a supergroup | Re-sent to the new ID; the subscription moves, topic included |
  | Network error before sending | Retried next run, for up to 60 min |

- **High impact first.** Posts are sent in this order: posts already in
  progress, then 🔴 posts, then the rest, each group oldest first.
  `sentAhead` keeps `lastSeen` correct when posts finish out of order.

### Commands (webhook)

| Command | Private chat | Group |
|---|---|---|
| `/start` | Subscribe + welcome | Subscribe the group + welcome |
| `/trumphere` | Same as `/start` | Inside a forum topic: send broadcasts **to that topic** |
| `/stop` | Unsubscribe | Unsubscribe the group (group admins only) |
| Bot added / removed | — | Subscribe / unsubscribe |

`/cmd@OtherBot` is ignored. Everything else is ignored too, because the bot is
broadcast-only and shows no command menu.

## Translation and market tags

One Gemini call per post (`GEMINI_API_KEY`, model `gemini-3.8-flash`)
returns the Hebrew translation, the **topics** (`tariffs`, `fed_rates`,
`oil`, `crypto`, `china`, `stocks`, `other`) and the **impact**
(`high`/`medium`/`low`) as schema-checked JSON. The prompt asks for an
accurate, complete and neutral translation. It keeps names in
Israeli-media spelling, and numbers, tickers and URLs as written.

```
🔴 השפעה גבוהה על השווקים · #מכסים #סין      ← high
🟠 השפעה בינונית על השווקים · #ריבית_הפד     ← medium
⚪ השפעה נמוכה על השווקים · #כללי             ← low
🏷️ #נפט                                       ← Gemini unavailable: keyword topics, no impact
```

If Gemini fails (errors, truncated or English answers), the keyless chain
takes over: Google ×2, Lingva, MyMemory. Every answer must contain real
Hebrew. If everything fails, the post is sent in English with a clear notice,
and you get an alert.

## Monitoring

Alerts go to `ADMIN_CHAT_ID`. Each kind is sent at most once per
`ALERT_REPEAT_MINUTES` (60):

| Alert | When |
|---|---|
| ⏰ No successful run | The previous successful run ended more than `STALE_ALERT_MINUTES` (15) ago |
| 📡 Source down | No post source could be reached for `SOURCE_FAILURE_ALERT_RUNS` (10) runs in a row (≈ 50 min at `*/5`) |
| ⚠️ Translation failed | Every provider failed for a post, so it went out in English |
| ⚠️ Possible missed posts | `lastSeen` wasn't in the scanned window |

The heartbeat is `meta.lastSuccess`, written at most every 10 minutes to stay
inside the KV free plan's 1,000 writes a day. A Worker that doesn't run at
all can't send alerts. For that case, set `HEALTHCHECK_URL` to a
[healthchecks.io](https://healthchecks.io) check (period 5 min, grace 10 min, Telegram
integration), which the Worker pings after every successful run. Logs are in
*Cloudflare dashboard → Workers → trump-telegram-bot → Logs*, or run
`npx wrangler tail`.

## State in KV

| Key | Holds |
|---|---|
| `meta` | `lastSeen`, `sentAhead`, posts in progress, heartbeat, source-failure count, menu fingerprint |
| `sub:<chatId>` | One key per subscriber; forum topic in metadata |
| `sent:<postId>:<chatId>` | Send log: `ok` / `uncertain` / `gone` / `failed`; 30-day TTL |
| `analysis:<postId>` | Cached translation + tags; 7-day TTL |
| `alert:<kind>` | Exists while that alert is muted |

**Consistency.** KV is eventually consistent: a write can take about 60 s to
appear in other Cloudflare locations. The design keeps that from causing
duplicates:

- each send has its own key, written immediately, with no read-modify-write;
- the webhook and the cron never write the same key;
- runs end within 40 s of a 5-minute interval.

The remaining risk is narrow. A chat whose send failed temporarily in one
location, then succeeded from another location, could see that post twice if
a third run lands back in the first location within 60 s. If that ever
matters, swapping `Store` for a Durable Object gives strong consistency; see
[docs/CLOUDFLARE_MIGRATION.md](docs/CLOUDFLARE_MIGRATION.md).

**Free-plan budget:** about 144 heartbeat writes a day, plus one write per
send, per analysed post and per finished post. That is roughly 600 writes a
day with ~10 subscribers, under the 1,000 limit. With many more
subscribers, or `MAX_SUBREQUESTS` above 45, move to Workers Paid.

## Security

The repository is public, so:

- **No secrets in code or `wrangler.toml`.** Secrets are set only with
  `wrangler secret put`. Locally they live in `.dev.vars`, which is
  gitignored. [`.dev.vars.example`](.dev.vars.example) lists placeholder names
  only.
- **Secret scan.** [`scripts/check-secrets.sh`](scripts/check-secrets.sh)
  blocks bot tokens, Google/GitHub keys, Cloudflare token assignments,
  private keys and group chat IDs. Optionally it also checks your real chat
  IDs, listed one per line in `~/.config/trump-bot/chat_ids.txt`, outside the
  repo. CI scans every file. Turn it on as a pre-commit hook with
  `git config core.hooksPath .githooks`.
- **Webhook authentication.** The route `/telegram/<path>` uses a path
  derived from the secret (a hash, not the secret itself), and the
  `X-Telegram-Bot-Api-Secret-Token` header is compared in constant time.
  Failures look like any unknown URL (404). Without a secret of 32+
  characters, the webhook is off.
- **Logs.** Logs never contain the token, keys or chat IDs. Chat IDs appear
  only as `chat#<keyed hash>`, and token- or key-shaped strings are scrubbed.
  The Gemini key travels in a header, not a URL. Tests enforce this.
- **CI has least privilege.** Read-only `GITHUB_TOKEN`. Deploying needs
  `CLOUDFLARE_API_TOKEN`, which is only ever a GitHub secret.

## Setup

Prerequisites: Node 22+, a Cloudflare account, the bot token from
[@BotFather](https://t.me/BotFather), and a Gemini key from
<https://aistudio.google.com/apikey>.

```bash
npm ci
npx wrangler login                               # opens the browser

# 1. KV namespace — copy the printed id into wrangler.toml ([[kv_namespaces]] id),
#    then commit it (a namespace id is not a secret).
npx wrangler kv namespace create STATE

# 2. First deploy (DRY_RUN = "true" in wrangler.toml: subscribers get nothing).
#    Prints the Worker URL: https://trump-telegram-bot.<your-subdomain>.workers.dev
npx wrangler deploy

# 3. Secrets — each command prompts for the value; nothing lands in shell history.
openssl rand -hex 32                             # webhook secret: save it in your password manager
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET  # paste the value from openssl
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put ADMIN_CHAT_ID            # your numeric chat id (@userinfobot)
npx wrangler secret put HEALTHCHECK_URL          # optional
```

### Verify the dry run (at least 24 h)

```bash
npx wrangler tail                                # a "Run start [DRY RUN]" line every 5 minutes
```

- Every 5 minutes the logs show `Run start [DRY RUN]` followed by `Run end`.
- When Trump posts, you get a **🧪 DRY RUN** preview with the tag line, within
  5 minutes. The legacy bot's message usually arrives hours later.
  Compare the two.
- There are no ⏰/📡 alerts, and no errors under *Workers → Logs*.

## Cutover

Do this only once the dry run looks right. Each step is reversible (see
[Rollback](#rollback)).

```bash
REPO=aviniazov7/trump-telegram-bot

# 1. Stop the legacy bot, so the two bots never both send. Wait until no run is in progress.
gh workflow disable trump-check.yml -R "$REPO"
gh run list --workflow trump-check.yml -R "$REPO" --limit 1   # status must be "completed"

# 2. Copy its state into KV. The file holds chat IDs: keep it in $TMPDIR and delete it afterwards.
gh variable get BOT_STATE -R "$REPO" | node scripts/import-state.mjs "$TMPDIR/kv-import.json"
npx wrangler kv bulk put "$TMPDIR/kv-import.json" --binding STATE --remote
rm "$TMPDIR/kv-import.json"
npx wrangler kv key list --binding STATE --prefix sub: --remote | grep -c '"name"'   # = subscriber count

# 3. Go live: set DRY_RUN = "false" in wrangler.toml, then deploy
#    (or merge the change and let the Deploy workflow do it).
npx wrangler deploy

# 4. Point Telegram at the Worker. The secrets are read from the environment, never typed as arguments.
read -rs TELEGRAM_BOT_TOKEN && export TELEGRAM_BOT_TOKEN            # paste, Enter
read -rs TELEGRAM_WEBHOOK_SECRET && export TELEGRAM_WEBHOOK_SECRET  # same value as the Worker secret
export WORKER_URL=https://trump-telegram-bot.<your-subdomain>.workers.dev
npm run webhook:set
```

### Verify it works

```bash
npm run webhook:info      # url …/telegram/<path>, pending_update_count 0, last_error null
npx wrangler tail         # keep open while testing
```

1. Send `/stop`, then `/start`, to the bot. You get the "stopped" message,
   then the welcome, within seconds. `tail` shows `Unsubscribed chat#…` and
   `Subscribed chat#…`.
2. A non-matching URL gives 404: `curl -s -o /dev/null -w '%{http_code}\n' "$WORKER_URL/"`.
3. Every 5 minutes `tail` shows `Run start` without `[DRY RUN]`. The next post
   reaches subscribers with the tag line, within 5 minutes of being
   published.
4. `npx wrangler kv key get meta --binding STATE --remote` shows `lastSeen`
   advancing.

### When to retire the Actions workflow

- **Disable it** (cutover step 1) only after the dry run has run cleanly for
  at least 24 h: previews arrived for every post with correct Hebrew and tags,
  and there were no errors or alerts.
- **Delete it** (remove `trump-check.yml`, `legacy/` and the `BOT_STATE`
  variable and `STATE_TOKEN` secret) once the live Worker has run for **48 h**
  with every post delivered exactly once, `webhook:info` clean, and no ⏰/📡
  alerts. Do that in a separate PR.

## Rollback

```bash
npm run webhook:delete                   # Telegram goes back to polling mode
# set DRY_RUN = "true" in wrangler.toml, then:
npx wrangler deploy
npx wrangler kv key get meta --binding STATE --remote > "$TMPDIR/meta.json"
npx wrangler kv key list --binding STATE --prefix sub: --remote > "$TMPDIR/subs.json"
node scripts/export-state.mjs "$TMPDIR/meta.json" "$TMPDIR/subs.json" | gh variable set BOT_STATE -R "$REPO"
rm "$TMPDIR/meta.json" "$TMPDIR/subs.json"
gh workflow enable trump-check.yml -R "$REPO"
```

## Configuration

Secrets are set with `npx wrangler secret put NAME`:

| Secret | Required | Meaning |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | yes | From @BotFather |
| `TELEGRAM_WEBHOOK_SECRET` | yes | 32+ chars of `A-Za-z0-9_-` (`openssl rand -hex 32`) |
| `GEMINI_API_KEY` | recommended | Primary translator + tags |
| `ADMIN_CHAT_ID` | recommended | Where alerts and dry-run previews go |
| `HEALTHCHECK_URL` | optional | Dead-man's switch ping |

Vars live in `wrangler.toml` under `[vars]`:

| Var | Default | Meaning |
|---|---|---|
| `DRY_RUN` | `"true"` | Previews to the admin only. Anything except `"false"` keeps it on |
| `GEMINI_MODEL` | `gemini-3.8-flash` | Check *AI Studio → Rate limits* for your free tier |
| `GEMINI_THINKING_LEVEL` | (model default) | `minimal`/`low`/`medium`/`high` |
| `STALE_ALERT_MINUTES` | `15` | ⏰ threshold |
| `SOURCE_FAILURE_ALERT_RUNS` | `10` | 📡 threshold |
| `ALERT_REPEAT_MINUTES` | `60` | Mute window per alert kind |
| `MAX_SCAN_POSTS` | `100` | How far back a run looks for `lastSeen` |
| `MAX_SUBREQUESTS` | `45` | Per run. Free plan: 50. Raise on Workers Paid |
| `RUN_TIME_BUDGET_SECONDS` | `40` | Stop starting new work after this |

### Optional: deploy from GitHub

Add the repository secrets `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID`. Create the token from the *Edit Cloudflare Workers*
template, scoped to your account. After that, every push to `main` that
touches the Worker runs the tests and deploys it
([`deploy.yml`](.github/workflows/deploy.yml)). Under *Settings →
Environments → production*, add yourself as a required reviewer to approve
each deploy. Without the token, the workflow does nothing.

## Development

```bash
npm test              # Vitest inside workerd (@cloudflare/vitest-plugin), local KV
npm run coverage
npm run lint          # Biome + tsc
npm run secrets:check
cp .dev.vars.example .dev.vars && npm run dev   # local Worker; trigger cron: curl "http://localhost:8787/__scheduled"
```

The tests never touch the network: every outbound call goes through an
injected `fetch`.

| Test file | Covers |
|---|---|
| `posts.test.ts` | New-post filtering, cursor, send order, RSS/CNN parsing, source fallback |
| `broadcast.test.ts` | Idempotent and resumable sending, Telegram error handling, high impact first, dry run, monitoring, menu |
| `telegram.test.ts` | Retry rules, 429, uncertain sends, gone chats, migration, no secrets in logs |
| `webhook.test.ts` | Webhook auth (path, header, method, fail-closed), commands, membership updates |
| `tagging-translate.test.ts` | Tag parser, keyword fallback, Gemini request/response handling, free chain fallback |
| `text-message.test.ts` | Message building, tag line, timestamps, tag-safe splitting |

## Layout

```
src/index.ts          Worker entry: scheduled() + fetch()
src/broadcast.ts      The cron run: fetch → analyze → idempotent delivery
src/webhook.ts        Telegram webhook (auth + commands)
src/sources.ts        trumpstruth RSS, CNN archive prefix
src/gemini.ts         Gemini prompt, schema, request
src/translate.ts      Keyless translation chain
src/tagging.ts        Tags, keyword fallback, analyzePost
src/message.ts        Message layout and tag line
src/telegram.ts       Bot API calls and send outcomes
src/store.ts          KV layout
src/monitor.ts        Alerts, heartbeat, healthcheck
src/posts.ts          New-post filter, cursor, ordering
src/runtime.ts        Subrequest/time budget, counted fetch
src/log.ts, text.ts   Redacting logger; HTML and splitting helpers
scripts/              Secret scan, webhook management, state import/export
test/                 Vitest suites
wrangler.toml         Worker config (no secrets)
legacy/               The Python bot (GitHub Actions) until cutover
docs/                 History cleanup guide, original migration proposal
```

## Legacy (Python on GitHub Actions)

[`legacy/`](legacy/) holds the previous runtime. The workflow
`trump-check.yml` runs it every 10 minutes, with state in the `BOT_STATE`
repository variable, until the cutover. Its tests run in CI
(`cd legacy && python -m unittest discover -s tests`).
[docs/HISTORY_CLEANUP.md](docs/HISTORY_CLEANUP.md) covers removing old state
files from git history.
