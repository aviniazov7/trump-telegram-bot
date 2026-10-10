# Trump Truth Social → Telegram Bot

Fetches Donald Trump's latest posts from Truth Social, translates them to
Hebrew, and broadcasts them to every subscriber. Runs on GitHub Actions
every 10 minutes, uses the Python standard library only.

The bot is **broadcast-only**:
- Anyone can `/start` the bot in a private chat to subscribe.
- Anyone can add the bot to a group or channel to broadcast there.
- No slash-command menu is shown. All other messages are ignored silently —
  users can't trigger any action.

The empty menu is applied to Telegram once, then remembered: state keeps a
fingerprint (`menu_config`) of `BOT_MENU_CONFIG` keyed with the bot token, and
the two menu API calls run again only when the config or the bot changes.

## Fetching and delivery

GitHub's scheduler often skips `*/10` cron runs, so the real gap between runs
can be hours. Each run therefore catches up on everything it missed:

- **Deep scan.** The run reads up to `MAX_SCAN_POSTS` (default 100) recent
  posts from the trumpstruth.org RSS feed, which covers about a week, and looks
  for `last_seen` in them. If the feed's window doesn't reach `last_seen`, the
  run checks the CNN archive, which holds the full history. Every post after
  `last_seen` is sent, oldest first.
- **Safe cap.** If `last_seen` can't be found at all (on the first run, or
  after an outage longer than the scan window), only the newest post is sent,
  so subscribers aren't flooded.
- **Checkpoint after every post.** `last_seen` is saved as soon as a post has
  gone to every subscriber. A run that crashes or runs out of time never
  re-sends posts it already finished.
- **Resumable broadcast.** If a run stops partway through one post's
  broadcast, the chats that already got it are saved as `in_flight`. The next
  run sends that post only to the chats still missing it.

### Talking to Telegram

All Bot API calls go through `telegram_call()` in `src/main.py`:

- **No blind retries of `sendMessage`.** A timeout or a dropped connection
  after the request went out may still have delivered the message, so it is
  not retried. Retrying could post it twice. A send is retried only when it
  provably never left (connection refused, DNS failure). Idempotent calls
  (`getUpdates`, `setMyCommands`) do retry.
- **429 rate limits.** The run waits the `retry_after` that Telegram asks for
  (up to 30 s, within the run budget) and then retries. Telegram guarantees
  that a 429 was not delivered.
- **Dead chats are unsubscribed.** On a 403 (blocked, kicked, account deleted)
  or `chat not found`, the chat is removed from the subscribers. The
  `TELEGRAM_CHAT_ID` owner chat is the exception: it is never removed.
- **Upgraded groups are followed.** When a group becomes a supergroup,
  Telegram returns its new ID. The bot re-sends the message there and moves
  the subscription, including its forum topic, to the new ID.
- Error logs contain only the method, the error code and Telegram's
  description, never the raw response, which can contain chat IDs.

## Translation

Each post is translated to Hebrew by trying providers in order, moving on as
soon as one returns real Hebrew:

1. **Google Gemini** (primary, needs `GEMINI_API_KEY`). It gets the whole post
   with a prompt that asks for an accurate, complete translation. Names follow
   Israeli-media spelling. Numbers, tickers, hashtags and URLs are kept as
   written. The tone stays neutral, with no commentary. The answer comes back
   as JSON against a schema.
2. Google's keyless translate endpoint (`translate.googleapis.com`)
3. A second Google host (`clients5.google.com`), rate-limited separately
4. Lingva — keyless Google Translate front ends, several public instances
5. MyMemory's free API (no key)

Providers 2–5 are the free chain. They need no key, so a deployment without
`GEMINI_API_KEY` runs on them alone, exactly as before. They are unofficial
endpoints: GitHub Actions' shared IPs regularly get HTTP 429 from Google, and
public Lingva instances come and go, which is why Gemini is now primary.

Any answer that is empty, still English, cut off (`MAX_TOKENS`) or not valid
JSON counts as a failure, not a translation. If every provider fails, the post
is still broadcast, but it is clearly marked as untranslated instead of
showing English under a "translated to Hebrew" heading.

## Market-impact tags

The same Gemini call that translates a post also classifies it:

- **Topics:** `tariffs`, `fed_rates`, `oil`, `crypto`, `china`, `stocks`, or
  `other`. A post can have several.
- **Impact:** `high` (a concrete new action, threat or deadline: new tariffs,
  a demand on the Fed, oil-supply moves, crypto policy, a deal or rupture with
  China, a named listed company), `medium` (market talk without a new action),
  or `low`.

The first line of every message shows the impact and the topics:

```
🔴 השפעה גבוהה על השווקים · #מכסים #סין      ← high
🟠 השפעה בינונית על השווקים · #ריבית_הפד     ← medium
⚪ השפעה נמוכה על השווקים · #כללי             ← low
🏷️ #נפט                                       ← Gemini unavailable: keyword topics, no impact
```

**High-impact posts go first.** A run translates and classifies its whole
backlog before sending anything. Then it sends, in this order: a post whose
broadcast was interrupted, then every 🔴 post (oldest first), then the rest
(oldest first). Because posts can now go out of order, state keeps
`sent_ahead`, the posts already sent past `last_seen`. `last_seen` only moves
once everything older has been sent as well, so an interrupted run never skips
or repeats a post.

When Gemini is unavailable, topics come from a keyword list
(`_KEYWORD_CATEGORIES`). Keywords can't judge impact, so these posts never get
a 🔴 and are sent in plain chronological order.

### Gemini setup

1. Create a free key at <https://aistudio.google.com/apikey> (no credit card
   needed).
2. Add it as the repository secret **`GEMINI_API_KEY`**.
3. Optional: set repository variables (*Settings → Secrets and variables →
   Actions → Variables*) to override the defaults:

| Variable | Default | Meaning |
|---|---|---|
| `GEMINI_MODEL` | `gemini-3.8-flash` | Model ID. Check *AI Studio → Rate limits* for which models your free tier includes |
| `GEMINI_THINKING_LEVEL` | (model default) | `minimal` / `low` / `medium` / `high`; lower is faster |

Also available as env vars: `GEMINI_MAX_TOKENS` (default `8192`, includes
thinking tokens) and `GEMINI_TIMEOUT` seconds (default `60`). When the free
tier answers 429 with a short `retryDelay` (≤30 s), the bot waits and retries
once. Otherwise it falls back to the free chain.

The key travels in the `x-goog-api-key` header, never in a URL, so it can't
appear in logs.

## Setup

1. **Create a Telegram bot** with [@BotFather](https://t.me/BotFather) and
   copy the bot token.
2. **Add repository secrets** under *Settings → Secrets and variables →
   Actions*:
   - `TELEGRAM_BOT_TOKEN` — required.
   - `TELEGRAM_CHAT_ID` — optional. If set, this chat is seeded as the
     initial subscriber so you start receiving posts before anyone else
     subscribes.
   - `STATE_TOKEN` — required. A fine-grained token the bot uses to read and
     write its state. See [State storage](#state-storage) for how to create it.
3. **Enable GitHub Actions** for the repository. The workflow will run
   automatically every 10 minutes; you can also trigger it manually from
   *Actions → Trump Truth Social Check → Run workflow*.
4. **Subscribe** — open a chat with the bot and send `/start`, or add the
   bot to a group / channel (as admin, for channels).

## State storage

The bot keeps a small amount of state between runs:

- **subscribers**: the chat IDs (and optional forum topic) that receive posts
- **last_seen**: the last post that was broadcast, so nothing is sent twice
- **last_update_id**: the Telegram `getUpdates` offset, so each `/start` is
  handled once
- **in_flight** (only while a broadcast is interrupted): the post being sent and
  the chats that already have it
- **menu_config**: fingerprint of the bot menu last applied to Telegram
- **sent_ahead**: posts newer than `last_seen` that were already sent out of
  order (high impact first)

### Why the state is not in git

The bot used to keep this state in `data/*.txt` and commit it back after every
run. That caused two problems:

1. **Privacy.** This repository is public, so the subscribers' Telegram chat
   IDs were published to everyone. A chat ID identifies a person and lets
   anyone with a bot token message them. That's third-party personal data we
   have no right to publish.
2. **Noise and fragility.** The workflow wrote 750+ "Update bot state" commits,
   needed `contents: write`, and had to rebase and retry its pushes whenever
   `main` moved.

State is runtime data, not source code, so it now lives outside the
repository. The workflow has read-only access to the code.

### Architecture

```
GitHub Actions (cron, every 10 min, concurrency group "trump-bot")
  └─ src/main.py
       1. store.load()             ← GitHub REST API: GET actions/variables/BOT_STATE
       2. reset bot menu           (only if menu_config fingerprint changed)
          handle Telegram updates  (mutates state in memory)
       3. store.save() if changed  → PATCH actions/variables/BOT_STATE
       4. fetch ≤100 posts         ← trumpstruth.org RSS (CNN archive if last_seen not found)
       5. translate + tag every new post   ← one Gemini call per post (free chain on failure)
       6. send: in_flight post → 🔴 high impact → rest, each oldest first
            send to every subscriber not in in_flight
            store.save()           → PATCH (last_seen / sent_ahead)
```

- `src/state.py` defines a `StateStore` interface with two backends that store
  the same JSON document:
  - `GitHubVariableStateStore` (production) keeps the state in the
    **`BOT_STATE` repository Actions variable**, using a fine-grained token
    scoped to this one repository with only the *Variables* permission.
  - `FileStateStore` (local development) uses `data/state.json`, which is
    gitignored.
- **Fail closed.** If the state can't be read, the run exits with an error
  before it contacts Telegram. The bot never assumes "no state" when the store
  is unreachable, because doing so would re-send old posts and then overwrite
  the real subscriber list. A failed write also turns the run red.
- **Minimal writes.** State is written only when it changed, so an idle run
  makes a single API read.
- **No races.** The workflow's concurrency group means only one run at a time
  reads and writes the variable.
- **Log redaction.** Actions logs of a public repo are public, so chat IDs are
  logged only as a keyed hash (`chat#3a1f76687d`).

### Why a repository variable (and not something else)

| Option | Private | Extra account | Limits / caveats |
|---|---|---|---|
| **Repo Actions variable** (chosen) | Collaborators only | No | 48 KB per value (~1,500 subscribers); needs a PAT, because `GITHUB_TOKEN` can't write variables |
| Secret Gist | No: anyone with the URL can read it | No | Token needs account-wide gist access; every revision is kept forever |
| Upstash Redis (free) | Yes | Yes | 500K commands/month; a third party holds the PII; atomic ops |
| Cloudflare KV (free) | Yes | Yes | 1K writes/day; eventually consistent (up to 60s), which risks stale reads |
| `actions/cache` / artifacts | Yes | No | Caches can be evicted and are immutable per key; not a durable store |

A repository variable keeps everything inside GitHub, costs nothing, and needs
the narrowest credential of all the options (one repository, one permission).
If the bot outgrows 48 KB, add another `StateStore` backend (for example
Redis) and switch `STATE_BACKEND`. No other code has to change.

### Setup: `STATE_TOKEN`

1. Go to *GitHub → Settings → Developer settings → Personal access tokens →
   Fine-grained tokens → Generate new token*.
   - **Repository access:** *Only select repositories* → `trump-telegram-bot`
   - **Permissions → Repository → Variables:** *Read and write* (*Metadata:
     Read* is added automatically)
   - **Expiration:** choose the longest you're comfortable with, and set a
     reminder. When the token expires the runs turn red, and no state is lost.
2. Add it as the repository secret **`STATE_TOKEN`** (*Settings → Secrets and
   variables → Actions → New repository secret*).

Don't create `BOT_STATE` by hand. The first run creates it.

### One-time migration from `data/*.txt`

The first run after this change finds no `BOT_STATE` variable. It then reads
the legacy `data/last_seen.txt`, `data/last_update_id.txt` and
`data/subscribers.txt` from the checkout and creates the variable from them.
The migration can only create the variable and never overwrites it, so every
later run just loads `BOT_STATE` and ignores the files. The files are then
removed from the tree and from history; see
[docs/HISTORY_CLEANUP.md](docs/HISTORY_CLEANUP.md).

### Configuration

| Env var | Default | Meaning |
|---|---|---|
| `STATE_BACKEND` | `file` | `github` on Actions (set in the workflow), `file` locally |
| `STATE_TOKEN` | — | Fine-grained PAT (github backend) |
| `STATE_VARIABLE` | `BOT_STATE` | Variable name (github backend) |
| `STATE_FILE` | `data/state.json` | Path (file backend) |
| `MAX_SCAN_POSTS` | `100` | How many recent posts a run scans for `last_seen` |

`GITHUB_REPOSITORY` and `GITHUB_API_URL` are set by Actions automatically.

## Tests

```bash
python -m unittest discover -s tests -v
```

The tests use only the standard library and run on every pull request
(`.github/workflows/tests.yml`).

## Layout

```
.github/workflows/trump-check.yml   GitHub Actions cron workflow (read-only)
.github/workflows/tests.yml         Unit tests on PRs / main
src/main.py                         Pipeline: fetch → translate → broadcast
src/state.py                        State model + storage backends + migration
tests/                              Unit tests (stdlib unittest)
docs/HISTORY_CLEANUP.md             Prepared git history rewrite for old state files
data/                               Local-only state (gitignored)
BOT-CONTROLS.sh                     gh-cli helper (status / run / logs)
```

## Configuration

- **Schedule** — edit the `cron` expression in `trump-check.yml`.
- **Message format** — edit `build_message()` in `src/main.py`.
- **Tags** — `MARKET_CATEGORIES` (topics and Hebrew labels), `IMPACT_MARKERS`
  and the classification rules in `GEMINI_SYSTEM_PROMPT`.
- **Welcome text** — edit `send_welcome()` in `src/main.py`.

## Requirements

- Python 3.9+ (uses `zoneinfo` from stdlib)
- A Telegram bot token and target chat id
- A `STATE_TOKEN` fine-grained token (see [State storage](#state-storage))
- GitHub Actions enabled on the repository
