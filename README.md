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
3. MyMemory's free API (no key)
4. The same AI provider the daily summary uses (Pollinations by default, keyless)

The fallback chain matters because GitHub Actions runs on shared IPs that
Google's free endpoint often answers with HTTP 429, which previously left posts
untranslated. A provider that echoes the English back or returns a quota notice
is treated as a failure rather than a translation. If every provider fails, the
post is still broadcast, but it is clearly marked as untranslated instead of
showing English under a "translated to Hebrew" heading.

## Daily summary

Once a day the bot also sends a **Hebrew summary of all of Trump's posts from
that day**. Every broadcast post is recorded to `data/posts_log.txt`; the
digest for the day is sent that evening (default 22:00 Israel time) and
`data/last_summary_date.txt` ensures it's sent exactly once. If the bot is
down for a few days it catches up, sending one digest per missed day, and the
log is pruned to the last 7 days automatically.

### AI-written summary (free, no setup)

The digest is a **concise, topic-organized Hebrew recap written by AI** rather
than a raw list. The default provider is **Pollinations** — a free AI service
that needs **no API key and no setup at all**. It just works out of the box.

If the AI service is unavailable for a given day, the summary still goes out —
it falls back to a numbered list with each post's time, its translation, and a
link to the original.

Want a higher-quality or more reliable provider? Two optional alternatives:

- **Google Gemini** (free tier): `SUMMARY_AI_PROVIDER=gemini` + a free
  `GEMINI_API_KEY` from <https://aistudio.google.com/apikey> (no credit card).
- **Anthropic Claude** (paid): `SUMMARY_AI_PROVIDER=claude` + `ANTHROPIC_API_KEY`.

### Configuration

All optional, via Actions secrets / env vars:

- `DAILY_SUMMARY_ENABLED` — set to `false` to turn the digest off (default on).
- `DAILY_SUMMARY_HOUR` — hour (0–23, Israel time) to send the digest (default `22`).
- `SUMMARY_AI_ENABLED` — set to `false` to always use the plain list (default on).
- `SUMMARY_AI_PROVIDER` — `pollinations` (default, keyless), `gemini`, or `claude`.
- `POLLINATIONS_MODEL` — Pollinations model (default `openai`).
- `GEMINI_API_KEY` / `GEMINI_MODEL` — Gemini key and model (default `gemini-2.0-flash`).
- `ANTHROPIC_API_KEY` / `SUMMARY_MODEL` — Claude key and model (default `claude-opus-4-8`).
- `SUMMARY_LOG_RETENTION_DAYS` — days of post history to keep (default `7`).
- `SUMMARY_SNIPPET_LEN` — max characters per post in the list fallback (default `350`).

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
data/posts_log.txt                  Per-post log feeding the daily summary
data/last_summary_date.txt          Last date a daily summary was sent
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
