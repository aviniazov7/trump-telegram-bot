# Operations

Operational reference for the live Worker: scheduling, delivery rules,
translation fallback, monitoring, state, security, setup, cutover, and
rollback. The portfolio overview is the [README](../README.md). Secrets,
plain vars, and deploys from GitHub are in
[configuration.md](configuration.md).

The README badges point at
[tests.yml](../.github/workflows/tests.yml). The coverage badge reads
`coverage.json` on the orphan `badges` branch, which that workflow
force-updates after a push to `main`. The badge message is the floored line
percentage.

Fetches Donald Trump's Truth Social posts, translates them to Hebrew, tags
each one by its likely market impact, and broadcasts them to every Telegram
subscriber. It runs as a **Cloudflare Worker**: a Cron Trigger every 5 minutes
handles posts, and a webhook handles bot commands. The public bot is
[t.me/TrumpHebrewBot](https://t.me/TrumpHebrewBot).

> **Status: live on the Worker since 2026-10-12 22:39 (Israel time).** The
> 8 subscribers and the cursor were imported from `BOT_STATE`, `DRY_RUN` is
> `"false"`. The old GitHub Actions bot (`trump-check.yml`, `legacy/`) was
> removed on 2026-10-13. **The Telegram webhook is not set yet**, so `/start`,
> `/stop` and `/trumphere` aren't handled until it is (see [Cutover](#cutover), step 4).

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
                    │   1. lease ← Durable Object; heartbeat check → ⏰ if really stale │
                    │   2. posts ← trumpstruth RSS (cache-bypassed) ∪ CNN newest ~30    │
                    │   3. new posts after lastSeen      │ 10 failed runs → 📡 alert      │
                    │   4. analysis ← KV cache │ Gemini, then Workers AI if it fails │
                    │   5. order: in progress → 🔴 high → rest (each oldest first)        │
                    │   6. per post: claim chats in the Durable Object → send → record  │
                    │        outcomes (KV `sent:<post>` is a mirror; KV failure → STOP)│
                    │   7. KV meta only if it changed; DO heartbeat every run; ping HC  │
                    │                                                                    │
 Telegram ─────────▶│ fetch() POST /telegram/<path>  (secret header, constant-time)     │
  (webhook)         │   /start /trumphere → sub:<chat>   /stop → delete   welcome/bye   │
                    └───────┬───────────────────────────────┬────────────────────────────┘
                            ▼                               ▼
              Workers KV "STATE" + Durable Object "cron"    Telegram Bot API ── ADMIN_CHAT_ID alerts
       meta · sub:<chat> · sent:<post> · analysis:<post> · alert:<kind>
       lease · send claims · heartbeat copy  (Durable Object, strongly consistent)

GitHub Actions: CI only (tests, lint, secret scan) + optional deploy on push to main.
```

### One run

- **Budgets.** Each run counts its subrequests (the free plan allows 50 per
  invocation) and stops starting new work after `RUN_TIME_BUDGET_SECONDS`
  (90). Whatever is left continues in the next run. A Durable Object lease
  makes a second invocation (Cloudflare can dispatch the same cron twice)
  leave that tick alone.
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
- **Never twice.** Each post is claimed in the Durable Object before it is
  sent, one entry per chat (`sending`, then the outcome). KV `sent:<post>`
  mirrors that log.
  - A chat with any entry never gets that post again, including a chat
    another overlapping run already claimed.
  - If the claim can't be written, nothing is sent.
  - If the KV mirror can't be written, the claim still stands: at most once.
  - A wordless Truth Social re-post is not delivered. The original and the
    boost are two ids; the boost is the same video or quote. That includes an
    `RT:` line and, if that line is missing, a second id that points at a
    video file already in this window.
  - A video or image with no caption, title or quoted text is not sent as
    its own "video without text" message. One such post is skipped. Two or
    more that are ready in the same run go out as a single short digest of
    links, and that set is fixed before the send so a retry cannot deliver
    the same posts again.

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
schema-checked JSON. The prompt asks for natural, fluent Israeli Hebrew:
no word-for-word calques, Hebrew only, and proper names transliterated
into Hebrew. The English spelling may follow in parentheses. Names and
numbers stay accurate.

```
🔴 השפעה גבוהה על השווקים · #מכסים #סין      ← high
🟠 השפעה בינונית על השווקים · #ריבית_הפד     ← medium
⚪ השפעה נמוכה על השווקים · #כללי             ← low
🏷️ #נפט                                       ← Gemini unavailable: keyword topics, no impact
```

The oil hashtag in code is `#נפט_ואנרגיה` (`MARKET_CATEGORIES.oil` in
`src/tagging.ts`), not `#נפט`. Oil is also an impact-floor topic, so a
keyword-only oil post is at least 🟠, not unrated. The fourth sample above
is the shape of a keyword-only line when impact is unknown.

**Impact floor.** Topics are also found by keywords and merged with Gemini's,
and a post about **tariffs, the Fed/rates, oil/energy or geopolitics is never
below 🟠**, whatever Gemini answered and even when Gemini is down. Only
Gemini can award 🔴. This came from the dry run, where "Effective
immediately, there is an ENERGY CEASEFIRE in the War between Russia and
Ukraine…" went out as `#כללי` with no impact: Gemini had failed for that post,
and the keyword fallback didn't know "ceasefire" or "energy".

### When Gemini fails

Gemini is the primary translator. The keyless services the old bot used are
blocked from Cloudflare's network: tested on 2026-10-12, Google answered 429,
Lingva 403/400 and MyMemory "quota used up", every time. On that day Gemini
failed for 4 of 9 text posts, and single calls took 30–40 s, using up whole
runs. So:

1. **Fast calls.** `GEMINI_THINKING_LEVEL=low`, and each call is capped at
   `GEMINI_TIMEOUT_SECONDS` (12), keeping 8 s of the run for sending. If a
   model rejects the thinking setting, the call is retried once without it.
   A 5xx is retried once.
2. **Fallback model.** The primary is `gemini-3.8-flash`. If it fails, the
   same run asks `GEMINI_FALLBACK_MODEL` (`gemini-3.5-flash-lite`). The thinking
   level applies only to full (non-lite) models. Flash-lite is not the primary
   translator: it was mixing Arabic letters into Hebrew and translating too
   literally.
3. **Daily free quota.** Each model has its own free daily quota, which
   resets at midnight Pacific time (10:00 in Israel in summer time, 09:00 in
   winter). On Oct 12, `gemini-3.8-flash` ran out (429, per-day, limit 20)
   while flash-lite's separate quota was untouched. Flash stays the primary
   for translation quality. When a 429 names a **per-day** quota, that model
   is marked in KV (`gemini-quota:<model>`) until the reset and isn't called
   again, so no calls or run time are wasted, and the post continues on
   flash-lite. That keeps the bot inside the free tier. If **every** Gemini
   model is out of quota and Workers AI is not configured, a post goes out in
   English at once, because waiting can't help, and you get one ⛽ alert.
   With Workers AI configured, the same run tries that instead. Per-minute
   429s are only waited out (`retryDelay`), never marked.
4. **Arabic script.** If a translation contains Arabic-script characters
   (U+0600–U+06FF, U+0750–U+077F, U+08A0–U+08FF, U+FB50–U+FDFF, U+FE70–U+FEFF),
   it is rejected. The same model is asked once more with stricter
   instructions. If Arabic script is still there, the next fallback model is
   asked. Words that still contain Arabic are replaced with Hebrew letters
   or removed, and that Hebrew is what gets sent.
5. **Workers AI, once.** If both Gemini models fail (daily 429, any other
   error, or an answer that is still English), the same run asks Workers AI
   through the `AI` binding. The model is `@cf/zai-org/glm-4.7-flash`
   (`WORKERS_AI_MODEL`), a multilingual instruct model that is still on the
   Workers Free plan. Reasoning is turned off and the completion is capped,
   so a fallback stays inside the 10,000 neurons/day included on that plan.
   Paid-only models are not used. Tags then come from keywords. The log line
   says `workers-ai` or `gemini` and the model id. `""` disables this step.
6. **Retry, then English.** A 429 or a 5xx is retried every run for
   `GEMINI_RETRY_MINUTES` (15). A model that already returned an English echo
   for that post is not called again. If Workers AI also echoes, the post is
   sent in English on that run — waiting cannot help. Newer posts don't wait.
   The English message carries a notice, and the keyword tags (🟠 floor
   included). You get a ⚠️ alert only when Gemini and Workers AI both failed.
7. **Every reason is kept.** Each failed attempt (time + reason per model) is
   saved in KV under `gemini-error:<post>` for 7 days. That includes the cases
   where the fallback model then succeeded and where the post went out in
   English. To read them:

   ```bash
   npm run gemini-errors                 # all posts with failures, last 7 days
   npm run gemini-errors -- <postId>     # one post
   # or raw:
   npx wrangler kv key list --binding STATE --remote --prefix gemini-error:
   npx wrangler kv key get gemini-error:<postId> --binding STATE --remote
   ```

### Media and quote posts

The archive marks attachments as "View image" / "View video" links and a
quoted post as "Quoted <author>" plus a `<blockquote>`. The parser separates
those from the post's own words:

| Post | Message |
|---|---|
| Text (with or without media) | Text + Hebrew translation, as usual |
| Video/image whose RSS title or `media:description` is a real caption | That caption + Hebrew translation. Placeholder titles (`Video post from …`) are not captions |
| One image or video and no words anywhere | Skipped. Nothing is sent |
| Several caption-less posts ready together | One digest: `🇺🇸 טראמפ — N סרטונים` and a link per post. No Gemini call |
| `RT @user` / `Reposted <name>` and nothing else | Skipped, or folded into the caption-less digest. No Gemini and no Workers AI call. If the quoted post has real words the original doesn't already carry, those words are what gets translated |
| Quote of a post that has text | The quoted text (`🔁 Quoting …`) + its translation, unless this status is a re-post of one already in the window |
| Quote of a media-only post already in the window | Skipped (same video again) |

## Monitoring

Alerts go to `ADMIN_CHAT_ID`. Each kind is sent at most once per
`ALERT_REPEAT_MINUTES` (60); the KV alert, once per 12 h. Alerts ignore the
run's time budget (only the subrequest cap applies). Before Oct 12, an alert
raised after a slow Gemini call had used up the run was dropped silently, which
is why no ⚠️ alert arrived for that day's failures.

| Alert | When |
|---|---|
| 🛑 KV write failed | A KV write failed; all sends stopped (see [When to move to Workers Paid or D1](#when-to-move-to-workers-paid-or-d1)) |
| ⏰ No successful run | The previous successful run ended more than `STALE_ALERT_MINUTES` (35) ago |
| 📡 Source down | No post source could be reached for `SOURCE_FAILURE_ALERT_RUNS` (10) runs in a row (≈ 50 min at `*/5`) |
| ⚠️ Translation failed | Gemini and Workers AI both failed, so a post went out in English. Includes the last reason. An echo does not wait out `GEMINI_RETRY_MINUTES`; a 429 or a 5xx does |
| ⛽ Gemini quota | Every Gemini model's free daily quota is used up and Workers AI is not configured; posts go out in English until the reset (once per 12 h) |
| ⚠️ Possible missed posts | `lastSeen` wasn't in the scanned window |

The heartbeat is the end of the last successful run. Every success writes it
to the Durable Object. `meta.lastSuccess` is the KV copy, refreshed only when
that timestamp is more than an hour old, so an idle cron does not spend a KV
write. The stale check uses whichever copy is newer, so
`STALE_ALERT_MINUTES` (35) still measures a real gap while runs succeed: the
object is minutes old, and a stale KV read can't page. A cron that merely
lands past the hourly KV refresh is not an outage. Mutes are kept in KV.
When KV can't record a mute (writes failing), the mute is kept in the running
Worker's memory instead. That's best effort: a fresh Worker instance can
repeat an alert once.

A Worker that doesn't run at all can't send alerts. For that case, and for
detection faster than 35 minutes, set `HEALTHCHECK_URL` to a
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
| `analysis:<postId>` | Cached translation + tags (and which model); 7-day TTL |
| `gemini-error:<postId>` | Every failed Gemini attempt for that post (time, reason per model), first failure, when it gave up; 7-day TTL |
| `gemini-quota:<model>` | Exists while that model's free daily quota is used up; expires at the reset (midnight Pacific) |
| `alert:<kind>` | Exists while that alert is muted |

**Consistency.** KV is eventually consistent: a write can take about 60 s to
appear in other Cloudflare locations, and a cron can run twice. Send claims
and the single-flight lease live in one Durable Object, which applies them
one at a time. KV `sent:<post>` is a mirror of that claim. The webhook
(adding subscribers) and the cron (removing dead chats) never write the same
subscriber key.

**Write budget.** These are KV writes; the free plan allows 1,000 a day, shared
by every Worker on the account:

| What | Writes |
|---|---|
| `meta.lastSuccess` | ≤24/day. Written only when the stored timestamp is more than an hour old. Idle runs do not write `meta` |
| Each new post | 2 KV writes (analysis cache + send-log mirror) plus one `meta` write when the cursor or another field changed. The send claim and the per-run heartbeat are Durable Object writes, not KV. Independent of the subscriber count |
| Each failed Gemini attempt | 1 (`gemini-error:<post>`), at most ~4 per post (one per run during the 15 min retry window) |
| Subscribe / unsubscribe / dead chat | 1 each |
| Alerts | 1 each (mute) |

Idle crons used to rewrite `meta` every 5 minutes (~288 writes/day) just to
bump the heartbeat. That KV copy is now at most hourly. At ~30 posts a day
the remaining writes are the post cache and send-log mirror, cursor updates,
and the hourly refresh — under 1,000. Durable Object writes (one lease, one
heartbeat, and a claim per post) are not part of that KV quota.

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

**D1 (SQLite)** is worth it for real queries over history. Duplicate delivery
is already handled by the Durable Object: claims are applied one at a time,
and a second cron invocation takes the lease or finds the chat already
claimed. D1's free tier allows 100,000 row writes a day versus KV's 1,000.

## Security

The repository is public, so:

- **No secrets in code or `wrangler.toml`.** Secrets are set only with
  `wrangler secret put`. Locally they live in `.dev.vars`, which is
  gitignored. [`.dev.vars.example`](../.dev.vars.example) lists placeholder names
  only.
- **Secret scan.** [`scripts/check-secrets.sh`](../scripts/check-secrets.sh)
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
  5 minutes.
- There are no ⏰/📡 alerts, and no errors under *Workers → Logs*.

## Cutover

Already done on 2026-10-12. The commands are the record of how state moved
across. `trump-check.yml` has since been deleted, so step 1 is not something
to run again. Rollback is [below](#rollback): previews only, no second bot.

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

The GitHub Actions workflow and `legacy/` were removed on 2026-10-13. You can
still delete the unused `BOT_STATE` variable and `STATE_TOKEN` secret in the
repository settings; nothing reads them anymore.

## Rollback

There is no second bot to turn back on. To stop subscriber delivery:

```bash
npm run webhook:delete                   # Telegram stops calling the Worker
# set DRY_RUN = "true" in wrangler.toml, then:
npx wrangler deploy                      # cron keeps running, but only the admin gets previews
```

## Configuration

Secrets, `[vars]`, the Workers AI binding, and deploys from GitHub are in
[configuration.md](configuration.md).

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
| `tagging-translate.test.ts` | Tag parser, keyword fallback, Gemini request/response handling, Arabic-script repair, Workers AI fallback |
| `text-message.test.ts` | Message building, tag line, timestamps, tag-safe splitting |
| `gemini-quota.test.ts` | Per-day versus per-minute 429s, skipping a model until midnight Pacific |
| `trial-tagging.test.ts` | Impact floor, including the energy-ceasefire post |
| `trial-media.test.ts` | Media-only and quote markup |

`test/helpers.ts` is shared fixtures, not a suite. `npm test` on 2026-10-14
reported **201** tests. `npm run coverage` reported **95.39%** lines
(statements 92.51%, functions 95.40%, branches 83.37%). The coverage config
fails the run under 85% lines. The CI badge floors the line percentage.

## Layout

```
src/index.ts          Worker entry: scheduled() + fetch()
src/broadcast.ts      The cron run: fetch → analyze → idempotent delivery
src/webhook.ts        Telegram webhook (auth + commands)
src/sources.ts        trumpstruth RSS, CNN archive prefix
src/gemini.ts         Gemini prompt, schema, request
src/workers-ai.ts     Workers AI fallback (free-plan model, reasoning off)
src/translate.ts      Hebrew checks (handles and RT labels don't force a failure)
src/tagging.ts        Tags, keyword fallback, analyzePost
src/message.ts        Message layout and tag line
src/telegram.ts       Bot API calls and send outcomes
src/coordinator.ts    Durable Object: run lease, send claims, heartbeat copy
src/store.ts          KV layout and the claim mirror
src/monitor.ts        Alerts, heartbeat, healthcheck
src/posts.ts          New-post filter, cursor, ordering
src/runtime.ts        Subrequest/time budget, counted fetch, Workers AI client
src/config.ts         Parsed config and defaults, including the Workers AI model
src/env.ts            Bindings: KV, Durable Object, secrets, vars, AI
src/log.ts, text.ts   Redacting logger; HTML and splitting helpers
scripts/              Secret scan, webhook, state import/export, Gemini error reader
test/                 Vitest suites
wrangler.toml         Worker config (no secrets)
docs/                 This guide, configuration, history cleanup, migration proposal
```

[HISTORY_CLEANUP.md](HISTORY_CLEANUP.md) covers removing old state
files from git history. The Python bot that used to live in `legacy/` is gone.
