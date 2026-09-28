# Trump Truth Social → Telegram Bot

Fetches Donald Trump's latest posts from Truth Social, translates them to
Hebrew, and broadcasts them to every subscriber. Runs on GitHub Actions
every 10 minutes, uses the Python standard library only.

The bot is **broadcast-only**:
- Anyone can `/start` the bot in a private chat to subscribe.
- Anyone can add the bot to a group or channel to broadcast there.
- No slash-command menu is shown. All other messages are ignored silently —
  users can't trigger any action.

## Translation

Each post is translated to Hebrew by trying several providers in order, moving
on as soon as one returns real Hebrew:

1. Google's keyless translate endpoint (`translate.googleapis.com`)
2. A second Google host (`clients5.google.com`), rate-limited separately
3. Lingva — keyless Google Translate front ends, several public instances
4. MyMemory's free API (no key)
5. An AI model — only when an API key is configured (see below)

The fallback chain matters because GitHub Actions runs on shared IPs that
Google's free endpoint intermittently answers with HTTP 429, which previously
left posts untranslated whenever the throttle happened to hit. A provider that
echoes the English back or returns a quota notice is treated as a failure
rather than a translation. If every provider fails, the
post is still broadcast, but it is clearly marked as untranslated instead of
showing English under a "translated to Hebrew" heading.

## AI provider (optional)

The bot needs no API key: the first four translation providers above are all
keyless. The fifth is an AI model, used only when every keyless provider has
failed.

The default AI provider is **Pollinations**, which needs no key but currently
answers `HTTP 402 Payment Required` from GitHub Actions — so out of the box
that last link is inert. To make it a real fallback, set one of:

- **Google Gemini** (free tier): `AI_PROVIDER=gemini` + a free `GEMINI_API_KEY`
  from <https://aistudio.google.com/apikey> (no credit card).
- **Anthropic Claude** (paid): `AI_PROVIDER=claude` + `ANTHROPIC_API_KEY`.

Other optional env vars: `POLLINATIONS_MODEL` (default `openai`),
`GEMINI_MODEL` (default `gemini-2.0-flash`), `ANTHROPIC_MODEL` (default
`claude-opus-4-8`), `AI_MAX_TOKENS` (default `1500`), `AI_TIMEOUT` seconds
(default `60`).

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
       2. handle Telegram updates  (mutates state in memory)
       3. store.save() if changed  → PATCH actions/variables/BOT_STATE
       4. broadcast new posts
       5. store.save() if changed  → PATCH (new last_seen)
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
- **Welcome text** — edit `send_welcome()` in `src/main.py`.

## Requirements

- Python 3.9+ (uses `zoneinfo` from stdlib)
- A Telegram bot token and target chat id
- A `STATE_TOKEN` fine-grained token (see [State storage](#state-storage))
- GitHub Actions enabled on the repository
