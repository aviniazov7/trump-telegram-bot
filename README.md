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
| Scheduling | Best effort: `*/10` runs arrived **2.5–8 h** apart (Oct 11: 4 scheduled runs in 19 h, gaps up to 6 h 56 m, every one successful — GitHub simply didn't start the others) | Every 5 minutes, reliably |
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
                    │   2. posts ← trumpstruth RSS (cache-bypassed) ∪ CNN newest ~30    │
                    │   3. new posts after lastSeen      │ 10 failed runs → 📡 alert      │
                    │   4. analysis ← KV cache │ Gemini (translate + tags) │ free chain   │
                    │   5. order: in progress → 🔴 high → rest (each oldest first)        │
                    │   6. per post: reserve batch in sent:<post> ("sending") → send →   │
                    │        record outcomes in sent:<post>  (any KV write fails → STOP)│
                    │   7. cursor/heartbeat → KV meta, ping HEALTHCHECK_URL              │
                    │                                                                    │
 Telegram ─────────▶│ fetch() POST /telegram/<path>  (secret header, constant-time)     │
  (webhook)         │   /start /trumphere → sub:<chat>   /stop → delete   welcome/bye   │
                    └───────┬───────────────────────────────┬────────────────────────────┘
                            ▼                               ▼
                     Workers KV "STATE"              Telegram Bot API ── ADMIN_CHAT_ID alerts
       meta · sub:<chat> · sent:<post> · analysis:<post> · alert:<kind>

GitHub Actions: CI only (tests, lint, secret scan) + optional deploy on push to main.
```

### One run

- **Budgets.** Each run counts its subrequests (the free plan allows 50 per
  invocation) and stops starting new work after `RUN_TIME_BUDGET_SECONDS`
  (40). Whatever is left continues in the next run, 5 minutes later, so runs
  never overlap.
- **Two sources every run.** Each run reads, in parallel, the trumpstruth.org
  RSS feed (100 posts, about a week) and the newest ~30 posts of the CNN
  archive (its first 64 KB), and merges them by post ID. A post goes out as
  soon as **either** source has it.
- **The RSS is fetched with a cache-busting query string.** The feed sits
  behind a CDN that served copies up to **~110 minutes old**
  (`cf-cache-status: HIT`, `age: 6558`), which caused 80–100 minute delays
  in the dry run. The query string makes the CDN fetch a fresh copy from the
  origin (`DYNAMIC`, `age: 0`).
- **Why not Truth Social directly?** Its API
  (`/api/v1/accounts/…/statuses`) and its RSS answer **403** with a bot
  challenge, both from a laptop and from Cloudflare's network (tested
  2026-10-11), so they can't be polled reliably.
- **No missed posts.** If `lastSeen` isn't in the merged window, the run
  reads the first 512 KB of the 20 MB CNN archive; a full parse would exceed
  the Workers CPU limit. If `lastSeen` is nowhere to be found, only the newest
  post is sent, and you get an alert.
- **Never twice.** Each post has a send log, `sent:<post>`, mapping each chat
  to its outcome. Before sending, the run **reserves** the batch of chats
  it's about to send to as `sending`. After sending, it records the outcomes.
  - A chat with any entry never gets that post again.
  - If the reservation can't be written, nothing is sent.
  - If the outcomes can't be written, the reserved chats stay `sending` and
    count as delivered: at most once, never twice.

  A run that stops anywhere resumes exactly where it left off. The analysis
  is cached in `analysis:<post>`, so a resumed post goes out with the same
  text.
- **Any KV write failure stops the run.** Examples: the free plan's 1,000
  writes a day are used up, or there's a rate limit or an outage. The run
  stops every further send and every further write immediately, and alerts
  the admin (🛑). Later runs keep failing at the reservation step, so they
  send nothing until writes work again. Then they continue where the log
  says. Nothing is re-sent.
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
`oil` (incl. energy), `geopolitics` (war, ceasefire, sanctions), `crypto`,
`china`, `stocks`, `other`) and the **impact** (`high`/`medium`/`low`) as
schema-checked JSON. The prompt asks for an
accurate, complete and neutral translation. It keeps names in
Israeli-media spelling, and numbers, tickers and URLs as written.

```
🔴 השפעה גבוהה על השווקים · #מכסים #סין      ← high
🟠 השפעה בינונית על השווקים · #ריבית_הפד     ← medium
⚪ השפעה נמוכה על השווקים · #כללי             ← low
🏷️ #נפט                                       ← Gemini unavailable: keyword topics, no impact
```

**Impact floor.** Topics are also found by keywords and merged with Gemini's,
and a post about **tariffs, the Fed/rates, oil/energy or geopolitics is never
below 🟠**, whatever Gemini answered and even when Gemini is down. Only
Gemini can award 🔴. This came from the dry run, where "Effective
immediately, there is an ENERGY CEASEFIRE in the War between Russia and
Ukraine…" went out as `#כללי` with no impact: Gemini had failed for that post,
and the keyword fallback didn't know "ceasefire" or "energy".

If Gemini fails (5xx is retried once; errors, truncated or English answers),
the keyless chain takes over: Google ×2, Lingva, MyMemory. Every answer must
contain real Hebrew. The reason Gemini wasn't used is stored with the cached
analysis (`analysis:<post>` → `geminiError`). If everything fails, the post
is sent in English with a clear notice, and you get an alert.

### Media and quote posts

The archive marks attachments as "View image" / "View video" links and a
quoted post as "Quoted <author>" plus a `<blockquote>`. The parser separates
those from the post's own words:

| Post | Message |
|---|---|
| Text (with or without media) | Text + Hebrew translation, as usual |
| Only an image / a video | `🖼️ פוסט תמונה ללא טקסט` / `🎥 פוסט וידאו ללא טקסט` + link. No translation, no Gemini call |
| Quote of a post that has text | The quoted text (`🔁 Quoting …`) + its translation |
| Quote of a media-only post | e.g. `🔁 ציטוט של פוסט וידאו של Donald J. Trump` + link |

## Monitoring

Alerts go to `ADMIN_CHAT_ID`. Each kind is sent at most once per
`ALERT_REPEAT_MINUTES` (60); the KV alert, once per 12 h:

| Alert | When |
|---|---|
| 🛑 KV write failed | A KV write failed; all sends stopped (see [When to move to Workers Paid or D1](#when-to-move-to-workers-paid-or-d1)) |
| ⏰ No successful run | The previous successful run ended more than `STALE_ALERT_MINUTES` (35, never below 31) ago |
| 📡 Source down | No post source could be reached for `SOURCE_FAILURE_ALERT_RUNS` (10) runs in a row (≈ 50 min at `*/5`) |
| ⚠️ Translation failed | Every provider failed for a post, so it went out in English |
| ⚠️ Possible missed posts | `lastSeen` wasn't in the scanned window |

The heartbeat is `meta.lastSuccess`, written at most every **30 minutes**
(48 writes a day). So the in-band ⏰ alert can't fire sooner than 31 minutes
after the last success, or every healthy gap would look stale. The code
enforces that minimum. Mutes are kept in KV. When KV can't record a mute
(writes failing), the mute is kept in the running Worker's memory instead.
That's best effort: a fresh Worker instance can repeat an alert once.

A Worker that doesn't run at all can't send alerts. For that case, and for
detection faster than 31 minutes, set `HEALTHCHECK_URL` to a
[healthchecks.io](https://healthchecks.io) check (period 5 min, grace 10 min, Telegram
integration), which the Worker pings after every successful run. Logs are in
*Cloudflare dashboard → Workers → trump-telegram-bot → Logs*, or run
`npx wrangler tail`.

## State in KV

| Key | Holds |
|---|---|
| `meta` | `lastSeen`, `sentAhead`, posts in progress, heartbeat, source-failure count, menu fingerprint |
| `sub:<chatId>` | One key per subscriber; forum topic in metadata |
| `sent:<postId>` | Send log `{chatId: status}`: `sending` (reserved) / `ok` / `uncertain` / `gone` / `failed`; 30-day TTL |
| `analysis:<postId>` | Cached translation + tags; 7-day TTL |
| `alert:<kind>` | Exists while that alert is muted |

**Consistency.** KV is eventually consistent: a write can take about 60 s to
appear in other Cloudflare locations. The design keeps that from causing
duplicates:

- only the cron writes `meta` and `sent:<post>`, and runs are 5 minutes
  apart, far longer than KV's propagation delay, so a run reads what the
  previous run wrote;
- the webhook (adding subscribers) and the cron (removing dead chats) never
  write the same key;
- the reservation is written before any send.

**Write budget.** These are KV writes; the free plan allows 1,000 a day, shared
by every Worker on the account:

| What | Writes |
|---|---|
| Heartbeat | 48/day (every 30 min) |
| Each new post | 4: reservation + outcomes + analysis cache + cursor. That's per run, and independent of the number of subscribers |
| Subscribe / unsubscribe / dead chat | 1 each |
| Alerts | 1 each (mute) |

At ~30 posts a day that's about 170 writes, well under 1,000.

### When to move to Workers Paid or D1

**Workers Paid ($5/month)** includes 1 million KV writes a month (≈ 33,000 a
day), 30 s of CPU per cron run instead of 10 ms, and 10,000 subrequests per
run instead of 50. Move when any of these happens:

- 🛑 KV-write alerts. The 1,000 writes a day are shared with your other
  Workers, so they can run out even when this bot is quiet.
- `Exceeded CPU` errors in the Worker logs (10 ms is tight for parsing a
  100-post RSS feed).
- A run can't reach all subscribers. One post takes 1 subrequest per
  subscriber, and about 40 fit in a free run; the rest wait 5 minutes for
  the next run. Past ~40 subscribers, raise `MAX_SUBREQUESTS` (Paid only).

**D1 (SQLite)** is worth it if you need **zero** duplicate risk, or real
queries. D1's free tier allows 100,000 row writes a day versus KV's 1,000, and
its writes go to a single primary database, where `batch()` runs as a
transaction. That means a send log row and a cursor update can commit
together, instead of KV's eventual consistency. Only `src/store.ts` would
change; the rest of the Worker uses it through the `Store` class.

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
| `STALE_ALERT_MINUTES` | `35` | ⏰ threshold (minimum 31: heartbeat interval + 1) |
| `SOURCE_FAILURE_ALERT_RUNS` | `10` | 📡 threshold |
| `ALERT_REPEAT_MINUTES` | `60` | Mute window per alert kind |
| `MAX_SCAN_POSTS` | `100` | How far back a run looks for `lastSeen` |
| `MAX_SUBREQUESTS` | `45` | Per run. Free plan: 50. Raise on Workers Paid |
| `RUN_TIME_BUDGET_SECONDS` | `40` | Stop starting new work after this |

### Optional: deploy from GitHub

Add the repository secrets `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID`. Create the token from the *Edit Cloudflare Workers*
template, scoped to your account. Without the token, the workflow does
nothing.

With the token, every push to `main` that touches the Worker goes through
[`deploy.yml`](.github/workflows/deploy.yml):

1. **check** (no approval): runs the tests and refuses a placeholder KV id.
2. **deploy** waits in the **`production` environment** until a required
   reviewer clicks **Review deployments → Approve and deploy** on the run.
   That environment is set up with `aviniazov7` as required reviewer and
   accepts only the `main` branch (*Settings → Environments → production*).
   Nothing reaches Cloudflare without that click.

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
