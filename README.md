# 🇺🇸➡️🇮🇱 Trump Truth Social → Telegram Bot

בוט שמביא את הפוסטים של דונלד טראמפ מ-Truth Social, מתרגם אותם לעברית, ושולח אותם לטלגרם — בחינם לגמרי.

## Architecture

```
GitHub Actions (cron every 15 min)
       │
       ▼
┌─────────────────────┐
│  Python Script       │
│                      │
│  1. Fetch Trump's    │──→ Truth Social Mastodon API
│     latest posts     │
│  2. Check duplicates │──→ data/last_seen.txt
│  3. Translate to HE  │──→ Google Translate (free)
│  4. Send to Telegram │──→ Telegram Bot API
│                      │
└─────────────────────┘
```

## Telegram Message Format

```
🇺🇸 טראמפ — פוסט חדש

📝 מקור (אנגלית):
{original text}

🇮🇱 תרגום:
{hebrew translation}

🕐 06/04/2026 14:30 (Israel)
🔗 לפוסט המקורי
```

## Project Structure

```
trump-telegram-bot/
├── .github/workflows/
│   └── trump-check.yml       # GitHub Actions cron workflow
├── src/
│   └── main.py               # Main pipeline script
├── data/
│   └── last_seen.txt         # Last seen post ID (auto-updated)
├── BOT-CONTROLS.sh           # Start/stop/manual run commands
├── requirements.txt          # No external deps (stdlib only)
├── .gitignore
└── README.md
```

## Setup — Step by Step

### 1. Fork or Clone the Repo

```bash
git clone https://github.com/YOUR_USERNAME/trump-telegram-bot.git
cd trump-telegram-bot
```

### 2. Create a Telegram Bot

1. Open Telegram and search for **@BotFather**
2. Send `/newbot`
3. Choose a name (e.g., "Trump Hebrew Bot")
4. Choose a username (e.g., `trump_hebrew_bot`)
5. Copy the **bot token** — you'll need it

### 3. Get Your Chat ID

**Option A — Personal chat:**
1. Start a chat with your bot (send `/start`)
2. Open: `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates`
3. Find `"chat":{"id": 123456789}` — that's your chat ID

**Option B — Group chat:**
1. Add the bot to your group
2. Send a message in the group
3. Open the same `getUpdates` URL
4. Find the group chat ID (it's negative, e.g., `-1001234567890`)

### 4. Add Secrets to GitHub

1. Go to your repo → **Settings** → **Secrets and variables** → **Actions**
2. Add these secrets:

| Secret Name | Value |
|---|---|
| `TELEGRAM_BOT_TOKEN` | `110201543:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw` (your token) |
| `TELEGRAM_CHAT_ID` | `123456789` (your chat ID) |

### 5. Enable GitHub Actions

1. Go to your repo → **Actions** tab
2. Click **"I understand my workflows, go ahead and enable them"**
3. The bot will now run every 15 minutes automatically

### 6. Manual Test Run

**From GitHub web UI:**
1. Go to **Actions** → **Trump Truth Social Check**
2. Click **Run workflow** → **Run workflow**

**From command line:**
```bash
./BOT-CONTROLS.sh run
```

## Bot Controls

```bash
./BOT-CONTROLS.sh status    # Show workflow status
./BOT-CONTROLS.sh run       # Trigger manual run
./BOT-CONTROLS.sh enable    # Enable scheduled runs
./BOT-CONTROLS.sh disable   # Disable scheduled runs
./BOT-CONTROLS.sh logs      # View last run logs
```

## Customization

### Change Frequency

Edit `.github/workflows/trump-check.yml`:

```yaml
schedule:
  - cron: '*/30 * * * *'   # Every 30 minutes
  - cron: '0 * * * *'      # Every hour
  - cron: '0 */6 * * *'    # Every 6 hours
```

### Change Message Format

Edit `build_message()` in `src/main.py`.

## Cost

| Service | Cost |
|---|---|
| GitHub Actions | Free (2,000 min/month) |
| Truth Social API | Free |
| Google Translate | Free (unofficial API) |
| Telegram Bot API | Free |
| **Total** | **$0/month** |

GitHub Actions usage: ~15 min cron × 4/hour × 24h × 30 days = **~43,200 runs/month**.
Each run takes ~10 seconds → **~7.2 hours/month** (well within the 2,000 min free tier).

## How It Works

1. **Fetch** — Uses Truth Social's Mastodon-compatible API to get Trump's latest posts. Falls back to RSS if the API is unavailable.
2. **Deduplicate** — Compares post IDs against `data/last_seen.txt` to only process new posts.
3. **Translate** — Uses Google Translate's free API to translate English → Hebrew.
4. **Send** — Formats the message (original + translation) and sends it via Telegram Bot API.
5. **Persist** — Commits the updated `last_seen.txt` back to the repo via GitHub Actions.

## Troubleshooting

- **No messages received?** Check that secrets are set correctly and the bot has been started (`/start`).
- **"API rate limit"?** Truth Social may throttle requests. The bot retries automatically.
- **Translation looks off?** Google Translate free API is best-effort. Consider it a rough translation.
- **Actions not running?** Make sure Actions are enabled in the repo settings.
