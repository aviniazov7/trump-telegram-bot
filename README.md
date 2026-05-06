# Trump Truth Social → Telegram Bot

Fetches Donald Trump's latest posts from Truth Social, translates them to
Hebrew, and posts them to a Telegram chat. Runs on GitHub Actions every
15 minutes, uses the Python standard library only.

## Setup

1. **Create a Telegram bot** with [@BotFather](https://t.me/BotFather) and
   copy the bot token.
2. **Get your chat ID** — start a chat with the bot, then open
   `https://api.telegram.org/bot<TOKEN>/getUpdates` and look for
   `"chat":{"id": ...}`. Group IDs are negative.
3. **Add repository secrets** under *Settings → Secrets and variables →
   Actions*:
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_CHAT_ID`
4. **Enable GitHub Actions** for the repository. The workflow will run
   automatically every 15 minutes; you can also trigger it manually from
   *Actions → Trump Truth Social Check → Run workflow*.

## Layout

```
.github/workflows/trump-check.yml   GitHub Actions cron workflow
src/main.py                         Pipeline: fetch → translate → send
data/last_seen.txt                  Last processed post id (auto-updated)
BOT-CONTROLS.sh                     gh-cli helper (status / run / logs)
```

## Configuration

- **Schedule** — edit the `cron` expression in `trump-check.yml`.
- **Message format** — edit `build_message()` in `src/main.py`.
- **Owner-only commands** — only the user matching `TELEGRAM_CHAT_ID` may
  send `/start`, `/recent`, `/help`.

## Requirements

- Python 3.9+ (uses `zoneinfo` from stdlib)
- A Telegram bot token and target chat id
- GitHub Actions enabled on the repository
