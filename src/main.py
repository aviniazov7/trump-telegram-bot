#!/usr/bin/env python3
"""
Trump Truth Social → Hebrew Telegram Bot

Fetches Trump's latest posts from Truth Social (via trumpstruth.org RSS),
translates them to Hebrew, and sends them to a Telegram chat with inline buttons.
Also handles Telegram bot commands (/start, /recent, /help).
"""

from __future__ import annotations

import html
import json
import logging
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone, timedelta
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Any

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

TRUTH_SOCIAL_PROFILE = "https://truthsocial.com/@realDonaldTrump"
TRUMPSTRUTH_RSS = "https://www.trumpstruth.org/feed"
CNN_ARCHIVE_JSON = "https://ix.cnn.io/data/truth-social/truth_archive.json"

TELEGRAM_BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_CHAT_ID = os.environ.get("TELEGRAM_CHAT_ID", "")
TELEGRAM_API = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}"

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
LAST_SEEN_FILE = DATA_DIR / "last_seen.txt"
LAST_UPDATE_ID_FILE = DATA_DIR / "last_update_id.txt"

ISRAEL_TZ = timezone(timedelta(hours=3))

MAX_RETRIES = 3
RETRY_DELAY = 5  # seconds
FETCH_LIMIT = 10

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# HTTP helpers
# ---------------------------------------------------------------------------


def http_get(url: str, headers: dict[str, str] | None = None) -> bytes:
    """GET request with retries."""
    req = urllib.request.Request(url, headers=headers or {})
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return resp.read()
        except (urllib.error.URLError, urllib.error.HTTPError, OSError) as exc:
            log.warning("GET %s attempt %d/%d failed: %s", url, attempt, MAX_RETRIES, exc)
            if attempt < MAX_RETRIES:
                time.sleep(RETRY_DELAY * attempt)
    raise RuntimeError(f"Failed to GET {url} after {MAX_RETRIES} attempts")


def http_post(url: str, data: dict[str, Any]) -> dict[str, Any]:
    """POST JSON request with retries."""
    body = json.dumps(data).encode()
    req = urllib.request.Request(
        url, data=body, headers={"Content-Type": "application/json"}, method="POST"
    )
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.loads(resp.read())
        except (urllib.error.URLError, urllib.error.HTTPError, OSError) as exc:
            log.warning("POST %s attempt %d/%d failed: %s", url, attempt, MAX_RETRIES, exc)
            if attempt < MAX_RETRIES:
                time.sleep(RETRY_DELAY * attempt)
    raise RuntimeError(f"Failed to POST {url} after {MAX_RETRIES} attempts")

# ---------------------------------------------------------------------------
# Fetch posts — trumpstruth.org RSS (primary) + CNN JSON (fallback)
# ---------------------------------------------------------------------------


def strip_html(text: str) -> str:
    """Remove HTML tags and decode entities."""
    text = re.sub(r"<br\s*/?>", "\n", text)
    text = re.sub(r"<[^>]+>", "", text)
    return html.unescape(text).strip()


def _xml_tag(text: str, tag: str) -> str:
    """Extract text content of an XML tag (supports namespaced tags)."""
    m = re.search(rf"<{tag}[^>]*>(.*?)</{tag}>", text, re.DOTALL)
    if m:
        content = m.group(1).strip()
        cdata = re.match(r"<!\[CDATA\[(.*?)\]\]>", content, re.DOTALL)
        return cdata.group(1) if cdata else content
    return ""


def fetch_posts_trumpstruth() -> list[dict[str, Any]]:
    """Fetch posts from trumpstruth.org RSS feed (primary source)."""
    log.info("Fetching posts from trumpstruth.org RSS feed")
    raw = http_get(TRUMPSTRUTH_RSS)
    xml_text = raw.decode("utf-8")

    posts: list[dict[str, Any]] = []
    items = re.findall(r"<item>(.*?)</item>", xml_text, re.DOTALL)
    for item in items[:FETCH_LIMIT]:
        title = _xml_tag(item, "title")
        description = _xml_tag(item, "description")
        link = _xml_tag(item, "link") or _xml_tag(item, "guid")
        pub_date = _xml_tag(item, "pubDate")
        original_url = _xml_tag(item, "truth:originalUrl") or link
        original_id = _xml_tag(item, "truth:originalId")

        text = strip_html(description or title or "")
        if not text:
            continue

        # Use original Truth Social ID if available, otherwise extract from link
        post_id = original_id or (link.rstrip("/").split("/")[-1] if link else "")

        posts.append({
            "id": post_id,
            "text": text,
            "created_at": pub_date or "",
            "url": original_url or link or "",
            "media_urls": [],
        })

    log.info("Fetched %d posts from trumpstruth.org", len(posts))
    return posts


def fetch_posts_cnn_archive() -> list[dict[str, Any]]:
    """Fallback: fetch posts from CNN's Truth Social archive JSON."""
    log.info("Fetching posts from CNN archive (fallback)")
    raw = http_get(CNN_ARCHIVE_JSON)
    data = json.loads(raw)

    # CNN archive is a list of post objects, newest first
    posts: list[dict[str, Any]] = []
    for item in data[:FETCH_LIMIT]:
        text = strip_html(item.get("content", "") or item.get("text", ""))
        if not text:
            continue

        post_id = str(item.get("id", ""))
        created = item.get("created_at", "")
        post_url = f"{TRUTH_SOCIAL_PROFILE}/{post_id}" if post_id else ""

        media_urls: list[str] = []
        for att in item.get("media_attachments", []):
            url = att.get("url") or att.get("remote_url")
            if url:
                media_urls.append(url)

        posts.append({
            "id": post_id,
            "text": text,
            "created_at": created,
            "url": post_url,
            "media_urls": media_urls,
        })

    log.info("Fetched %d posts from CNN archive", len(posts))
    return posts


def fetch_posts() -> list[dict[str, Any]]:
    """Fetch posts with fallback chain."""
    # Primary: trumpstruth.org RSS
    try:
        posts = fetch_posts_trumpstruth()
        if posts:
            return posts
    except Exception as exc:
        log.warning("trumpstruth.org RSS failed: %s", exc)

    # Fallback: CNN archive JSON
    try:
        posts = fetch_posts_cnn_archive()
        if posts:
            return posts
    except Exception as exc:
        log.warning("CNN archive fallback failed: %s", exc)

    log.error("All fetch methods failed")
    return []

# ---------------------------------------------------------------------------
# Duplicate prevention
# ---------------------------------------------------------------------------


def load_last_seen() -> str:
    """Load the last seen post ID from file."""
    if LAST_SEEN_FILE.exists():
        content = LAST_SEEN_FILE.read_text().strip()
        if content:
            log.info("Last seen post ID: %s", content)
            return content
    log.info("No last seen post ID found — first run")
    return ""


def save_last_seen(post_id: str) -> None:
    """Save the last seen post ID to file."""
    LAST_SEEN_FILE.parent.mkdir(parents=True, exist_ok=True)
    LAST_SEEN_FILE.write_text(post_id + "\n")
    log.info("Saved last seen post ID: %s", post_id)


def filter_new_posts(posts: list[dict[str, Any]], last_seen_id: str) -> list[dict[str, Any]]:
    """Return only posts newer than last_seen_id, oldest first."""
    if not last_seen_id:
        # First run — return only the most recent post to avoid spamming
        log.info("First run — taking only the latest post")
        return posts[:1]

    new_posts: list[dict[str, Any]] = []
    for post in posts:
        if post["id"] == last_seen_id:
            break
        new_posts.append(post)

    # Return oldest first so messages arrive in chronological order
    new_posts.reverse()
    log.info("Found %d new posts", len(new_posts))
    return new_posts

# ---------------------------------------------------------------------------
# Translation (Google Translate free API)
# ---------------------------------------------------------------------------

TRANSLATE_URL = "https://translate.googleapis.com/translate_a/single"
MAX_TRANSLATE_CHUNK = 4500


def translate_to_hebrew(text: str) -> str:
    """Translate English text to Hebrew using free Google Translate API."""
    if not text.strip():
        return text

    chunks = _split_text(text, MAX_TRANSLATE_CHUNK)
    translated_parts: list[str] = []

    for chunk in chunks:
        params = urllib.parse.urlencode({
            "client": "gtx",
            "sl": "en",
            "tl": "he",
            "dt": "t",
            "q": chunk,
        })
        url = f"{TRANSLATE_URL}?{params}"

        try:
            raw = http_get(url)
            result = json.loads(raw)
            translated = "".join(seg[0] for seg in result[0] if seg[0])
            translated_parts.append(translated)
        except Exception as exc:
            log.warning("Translation failed for chunk: %s", exc)
            translated_parts.append(chunk)

    return "".join(translated_parts)


def _split_text(text: str, max_len: int) -> list[str]:
    """Split text into chunks, preferring line/sentence boundaries."""
    if len(text) <= max_len:
        return [text]

    chunks: list[str] = []
    while text:
        if len(text) <= max_len:
            chunks.append(text)
            break
        cut = text.rfind("\n", 0, max_len)
        if cut < max_len // 2:
            cut = text.rfind(". ", 0, max_len)
        if cut < max_len // 2:
            cut = max_len
        else:
            cut += 1
        chunks.append(text[:cut])
        text = text[cut:].lstrip()
    return chunks

# ---------------------------------------------------------------------------
# Telegram — messaging with inline buttons
# ---------------------------------------------------------------------------


def format_timestamp(date_str: str) -> str:
    """Convert date string to Israel time display string."""
    if not date_str:
        return "—"
    try:
        # Try RFC 2822 format (from RSS pubDate)
        dt = parsedate_to_datetime(date_str)
        israel = dt.astimezone(ISRAEL_TZ)
        return israel.strftime("%d/%m/%Y %H:%M (Israel)")
    except Exception:
        pass
    try:
        # Try ISO 8601 format
        dt = datetime.fromisoformat(date_str.replace("Z", "+00:00"))
        israel = dt.astimezone(ISRAEL_TZ)
        return israel.strftime("%d/%m/%Y %H:%M (Israel)")
    except (ValueError, TypeError):
        return date_str


def build_message(post: dict[str, Any], hebrew: str) -> str:
    """Build the Telegram message in HTML format."""
    original = html.escape(post["text"])
    translated = html.escape(hebrew)
    timestamp = format_timestamp(post["created_at"])

    return (
        "🇺🇸 <b>טראמפ — פוסט חדש</b>\n"
        "\n"
        f"📝 <b>מקור (אנגלית):</b>\n"
        f"{original}\n"
        "\n"
        f"🇮🇱 <b>תרגום:</b>\n"
        f"{translated}\n"
        "\n"
        f"🕐 {timestamp}\n"
    )


def build_inline_keyboard(post_url: str) -> list[list[dict[str, str]]]:
    """Build inline keyboard buttons for a post message."""
    buttons: list[list[dict[str, str]]] = []
    if post_url:
        buttons.append([
            {"text": "🔗 לפוסט המקורי", "url": post_url},
            {"text": "📢 שתף", "url": f"https://t.me/share/url?url={urllib.parse.quote(post_url)}"},
        ])
    return buttons


def send_telegram_message(
    text: str,
    chat_id: str | None = None,
    reply_markup: dict[str, Any] | None = None,
) -> bool:
    """Send a message to the Telegram chat. Returns True on success."""
    if not TELEGRAM_BOT_TOKEN:
        log.error("TELEGRAM_BOT_TOKEN not set")
        return False

    target = chat_id or TELEGRAM_CHAT_ID
    if not target:
        log.error("No chat_id provided")
        return False

    url = f"{TELEGRAM_API}/sendMessage"
    payload: dict[str, Any] = {
        "chat_id": target,
        "text": text,
        "parse_mode": "HTML",
        "disable_web_page_preview": False,
    }
    if reply_markup:
        payload["reply_markup"] = reply_markup

    try:
        result = http_post(url, payload)
        if result.get("ok"):
            log.info("Telegram message sent successfully")
            return True
        else:
            log.error("Telegram API error: %s", result)
            return False
    except Exception as exc:
        log.error("Failed to send Telegram message: %s", exc)
        return False


def send_post_message(post: dict[str, Any], hebrew: str, chat_id: str | None = None) -> bool:
    """Send a translated post with inline buttons."""
    message = build_message(post, hebrew)
    keyboard = build_inline_keyboard(post.get("url", ""))
    reply_markup = {"inline_keyboard": keyboard} if keyboard else None
    return send_telegram_message(message, chat_id=chat_id, reply_markup=reply_markup)

# ---------------------------------------------------------------------------
# Telegram — bot commands (/start, /recent, /help)
# ---------------------------------------------------------------------------


def load_last_update_id() -> int:
    """Load the last processed Telegram update ID."""
    if LAST_UPDATE_ID_FILE.exists():
        content = LAST_UPDATE_ID_FILE.read_text().strip()
        if content.isdigit():
            return int(content)
    return 0


def save_last_update_id(update_id: int) -> None:
    """Save the last processed Telegram update ID."""
    LAST_UPDATE_ID_FILE.parent.mkdir(parents=True, exist_ok=True)
    LAST_UPDATE_ID_FILE.write_text(str(update_id) + "\n")


def get_telegram_updates(offset: int = 0) -> list[dict[str, Any]]:
    """Fetch new updates from Telegram Bot API."""
    url = f"{TELEGRAM_API}/getUpdates"
    params: dict[str, Any] = {"timeout": 0, "limit": 20}
    if offset:
        params["offset"] = offset
    try:
        result = http_post(url, params)
        if result.get("ok"):
            return result.get("result", [])
    except Exception as exc:
        log.warning("Failed to get Telegram updates: %s", exc)
    return []


def handle_start_command(chat_id: str) -> None:
    """Handle /start command — send welcome message."""
    msg = (
        "🇺🇸🇮🇱 <b>ברוכים הבאים!</b>\n"
        "\n"
        "אני בוט שמתרגם את הפוסטים של דונלד טראמפ מ-Truth Social לעברית.\n"
        "\n"
        "📬 פוסטים חדשים נשלחים אוטומטית כל 15 דקות.\n"
        "\n"
        "<b>פקודות זמינות:</b>\n"
        "/recent — 5 הפוסטים האחרונים\n"
        "/help — עזרה\n"
    )
    send_telegram_message(msg, chat_id=chat_id)


def handle_help_command(chat_id: str) -> None:
    """Handle /help command."""
    msg = (
        "📖 <b>עזרה</b>\n"
        "\n"
        "/start — הודעת פתיחה\n"
        "/recent — 5 הפוסטים האחרונים של טראמפ (מתורגמים)\n"
        "/help — ההודעה הזאת\n"
        "\n"
        "📬 פוסטים חדשים נשלחים אוטומטית.\n"
        "⏱ הבוט בודק פוסטים חדשים כל 15 דקות.\n"
    )
    send_telegram_message(msg, chat_id=chat_id)


def handle_recent_command(chat_id: str) -> None:
    """Handle /recent command — send last 5 posts translated."""
    send_telegram_message("⏳ <b>מביא את הפוסטים האחרונים...</b>", chat_id=chat_id)

    posts = fetch_posts()
    if not posts:
        send_telegram_message("❌ לא הצלחתי להביא פוסטים כרגע. נסה שוב מאוחר יותר.", chat_id=chat_id)
        return

    # Send up to 5 latest posts, oldest first
    recent = list(reversed(posts[:5]))
    for post in recent:
        hebrew = translate_to_hebrew(post["text"])
        send_post_message(post, hebrew, chat_id=chat_id)
        time.sleep(0.5)

    send_telegram_message(f"✅ <b>{len(recent)} פוסטים אחרונים נשלחו</b>", chat_id=chat_id)


def process_telegram_commands() -> None:
    """Check for and process pending Telegram bot commands."""
    log.info("Checking for Telegram bot commands...")
    last_update_id = load_last_update_id()
    offset = last_update_id + 1 if last_update_id else 0

    updates = get_telegram_updates(offset=offset)
    if not updates:
        log.info("No new commands")
        return

    log.info("Processing %d Telegram update(s)", len(updates))
    max_update_id = last_update_id

    for update in updates:
        update_id = update.get("update_id", 0)
        max_update_id = max(max_update_id, update_id)

        message = update.get("message", {})
        text = message.get("text", "").strip()
        chat_id = str(message.get("chat", {}).get("id", ""))

        if not text or not chat_id:
            continue

        command = text.split()[0].lower().split("@")[0]  # handle /start@botname

        if command == "/start":
            handle_start_command(chat_id)
        elif command == "/recent":
            handle_recent_command(chat_id)
        elif command == "/help":
            handle_help_command(chat_id)

    if max_update_id > last_update_id:
        save_last_update_id(max_update_id)

# ---------------------------------------------------------------------------
# Main pipeline
# ---------------------------------------------------------------------------


def main() -> None:
    log.info("=" * 60)
    log.info("Trump Truth Social → Telegram Bot starting")
    log.info("=" * 60)

    # Validate config
    if not TELEGRAM_BOT_TOKEN:
        log.error("TELEGRAM_BOT_TOKEN environment variable is not set")
        sys.exit(1)
    if not TELEGRAM_CHAT_ID:
        log.error("TELEGRAM_CHAT_ID environment variable is not set")
        sys.exit(1)

    # Step 1: Process any pending bot commands (/start, /recent, /help)
    process_telegram_commands()

    # Step 2: Load last seen post
    last_seen_id = load_last_seen()

    # Step 3: Fetch posts
    posts = fetch_posts()
    if not posts:
        log.info("No posts fetched — exiting")
        return

    # Step 4: Filter new posts
    new_posts = filter_new_posts(posts, last_seen_id)
    if not new_posts:
        log.info("No new posts — exiting")
        return

    log.info("Processing %d new post(s)", len(new_posts))

    # Step 5: Translate and send each new post with inline buttons
    latest_id = ""
    for post in new_posts:
        log.info("Processing post %s", post["id"])

        hebrew = translate_to_hebrew(post["text"])
        success = send_post_message(post, hebrew)

        if success:
            latest_id = post["id"]
        else:
            log.warning("Failed to send post %s — stopping to avoid gaps", post["id"])
            break

        if len(new_posts) > 1:
            time.sleep(1)

    # Step 6: Update last seen
    if latest_id:
        save_last_seen(latest_id)

    log.info("Done — processed up to post %s", latest_id or "(none)")


if __name__ == "__main__":
    main()
