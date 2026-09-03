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
3. **Enable GitHub Actions** for the repository. The workflow will run
   automatically every 10 minutes; you can also trigger it manually from
   *Actions → Trump Truth Social Check → Run workflow*.
4. **Subscribe** — open a chat with the bot and send `/start`, or add the
   bot to a group / channel (as admin, for channels).

## Layout

```
.github/workflows/trump-check.yml   GitHub Actions cron workflow
src/main.py                         Pipeline: fetch → translate → broadcast
data/last_seen.txt                  Last processed post id (auto-updated)
data/last_update_id.txt             Last processed Telegram update id
data/subscribers.txt                Chat IDs receiving the broadcast
BOT-CONTROLS.sh                     gh-cli helper (status / run / logs)
```

## Configuration

- **Schedule** — edit the `cron` expression in `trump-check.yml`.
- **Message format** — edit `build_message()` in `src/main.py`.
- **Welcome text** — edit `send_welcome()` in `src/main.py`.

## Requirements

- Python 3.9+ (uses `zoneinfo` from stdlib)
- A Telegram bot token and target chat id
- GitHub Actions enabled on the repository
