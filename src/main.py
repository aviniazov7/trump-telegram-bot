#!/usr/bin/env python3
"""
Trump Truth Social → Hebrew Telegram Bot

Fetches Trump's latest posts from Truth Social (via trumpstruth.org RSS),
translates them to Hebrew, and broadcasts them to every subscriber
(private chats, groups, and channels that have added the bot).
The bot is broadcast-only: /start subscribes a private chat, being added
to a group/channel subscribes it, and all other messages are ignored.
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
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

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
SUBSCRIBERS_FILE = DATA_DIR / "subscribers.txt"

# Use Asia/Jerusalem so Israel DST (UTC+2 winter / UTC+3 summer) is correct.
ISRAEL_TZ = ZoneInfo("Asia/Jerusalem")

MAX_RETRIES = 2
RETRY_DELAY = 2  # seconds
FETCH_LIMIT = 10
HTTP_TIMEOUT = 15  # seconds per request

# Telegram caps text messages at 4096 chars; leave a small margin for safety.
TELEGRAM_MAX_MESSAGE_LEN = 4000

# Hard wall-clock budget for the whole run, so a slow upstream can't hold the
# job past the next cron tick. The workflow timeout is the outer safety net.
SCRIPT_BUDGET_SECONDS = 10 * 60

DEFAULT_USER_AGENT = "Mozilla/5.0 (compatible; trump-telegram-bot/1.0)"

_script_deadline: float | None = None


def _budget_exceeded() -> bool:
    return _script_deadline is not None and time.monotonic() > _script_deadline

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


def http_get(
    url: str,
    headers: dict[str, str] | None = None,
    retries: int = MAX_RETRIES,
) -> bytes:
    """GET request with bounded retries and a default User-Agent."""
    merged = {"User-Agent": DEFAULT_USER_AGENT}
    if headers:
        merged.update(headers)
    req = urllib.request.Request(url, headers=merged)
    for attempt in range(1, retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
                return resp.read()
        except (urllib.error.URLError, urllib.error.HTTPError, OSError) as exc:
            log.warning("GET %s attempt %d/%d failed: %s", url, attempt, retries, exc)
            if attempt < retries:
                time.sleep(RETRY_DELAY * attempt)
    raise RuntimeError(f"Failed to GET {url} after {retries} attempts")


def http_post(
    url: str,
    data: dict[str, Any],
    retries: int = MAX_RETRIES,
) -> dict[str, Any]:
    """POST JSON request with bounded retries."""
    body = json.dumps(data).encode()
    req = urllib.request.Request(
        url,
        data=body,
        headers={
            "Content-Type": "application/json",
            "User-Agent": DEFAULT_USER_AGENT,
        },
        method="POST",
    )
    for attempt in range(1, retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
                return json.loads(resp.read())
        except (urllib.error.URLError, urllib.error.HTTPError, OSError) as exc:
            log.warning("POST %s attempt %d/%d failed: %s", url, attempt, retries, exc)
            if attempt < retries:
                time.sleep(RETRY_DELAY * attempt)
    raise RuntimeError(f"Failed to POST {url} after {retries} attempts")

# ---------------------------------------------------------------------------
# Fetch posts — trumpstruth.org RSS (primary) + CNN JSON (fallback)
# ---------------------------------------------------------------------------


def strip_html(text: str) -> str:
    """Remove HTML tags and decode entities, clean up URLs."""
    text = re.sub(r"<br\s*/?>", "\n", text)
    # Add space before closing tags to prevent text merging
    text = re.sub(r"</a>", " ", text)
    text = re.sub(r"</p>", "\n", text)
    # Remove all remaining HTML tags
    text = re.sub(r"<[^>]+>", "", text)
    text = html.unescape(text)
    # Remove standalone URLs (RT: https://... patterns)
    text = re.sub(r"RT:\s*https?://\S+\s*", "", text)
    # Remove any remaining standalone URLs
    text = re.sub(r"https?://\S+", "", text)
    # Clean up extra whitespace
    text = re.sub(r"\n{3,}", "\n\n", text)
    text = re.sub(r"  +", " ", text)
    return text.strip()


def _xml_tag(text: str, tag: str) -> str:
    """Extract text content of an XML tag (supports namespaced tags)."""
    m = re.search(rf"<{tag}[^>]*>(.*?)</{tag}>", text, re.DOTALL)
    if m:
        content = m.group(1).strip()
        cdata = re.match(r"<!\[CDATA\[(.*?)\]\]>", content, re.DOTALL)
        return cdata.group(1) if cdata else content
    return ""


def _is_meaningful_text(text: str) -> bool:
    """Check if text has actual content (not just a URL or RT link)."""
    cleaned = text.strip()
    if not cleaned:
        return False
    # Skip posts that are only "RT: <url>" with no other content
    if re.match(r"^RT:\s*https?://\S+$", cleaned):
        return False
    # Skip "[No Title]" placeholder posts
    if cleaned.startswith("[No Title]"):
        return False
    return True


def fetch_posts_trumpstruth() -> list[dict[str, Any]]:
    """Fetch posts from trumpstruth.org RSS feed (primary source)."""
    log.info("Fetching posts from trumpstruth.org RSS feed")
    raw = http_get(TRUMPSTRUTH_RSS)
    xml_text = raw.decode("utf-8")

    posts: list[dict[str, Any]] = []
    items = re.findall(r"<item>(.*?)</item>", xml_text, re.DOTALL)
    for item in items:
        title = _xml_tag(item, "title")
        description = _xml_tag(item, "description")
        link = _xml_tag(item, "link") or _xml_tag(item, "guid")
        pub_date = _xml_tag(item, "pubDate")
        original_url = _xml_tag(item, "truth:originalUrl") or link
        original_id = _xml_tag(item, "truth:originalId")

        text = strip_html(description or title or "")

        # Skip empty, RT-only, or placeholder posts
        if not _is_meaningful_text(text):
            log.debug("Skipping non-meaningful post: %s", original_id)
            continue

        post_id = original_id or (link.rstrip("/").split("/")[-1] if link else "")

        posts.append({
            "id": post_id,
            "text": text,
            "created_at": pub_date or "",
            "url": original_url or link or "",
            "media_urls": [],
        })

        if len(posts) >= FETCH_LIMIT:
            break

    log.info("Fetched %d posts from trumpstruth.org", len(posts))
    return posts


def fetch_posts_cnn_archive() -> list[dict[str, Any]]:
    """Fallback: fetch posts from CNN's Truth Social archive JSON."""
    log.info("Fetching posts from CNN archive (fallback)")
    raw = http_get(CNN_ARCHIVE_JSON)
    data = json.loads(raw)

    posts: list[dict[str, Any]] = []
    for item in data:
        text = strip_html(item.get("content", "") or item.get("text", ""))
        if not _is_meaningful_text(text):
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

        if len(posts) >= FETCH_LIMIT:
            break

    log.info("Fetched %d posts from CNN archive", len(posts))
    return posts


def fetch_posts() -> list[dict[str, Any]]:
    """Fetch posts with fallback chain."""
    try:
        posts = fetch_posts_trumpstruth()
        if posts:
            return posts
    except Exception as exc:
        log.warning("trumpstruth.org RSS failed: %s", exc)

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
    """Return only posts newer than last_seen_id, oldest first.

    If last_seen_id isn't found in the fetched window we assume the bot was
    offline long enough that it scrolled out — treat it like a first run and
    only send the most recent post, instead of spamming everything we got.
    """
    if not last_seen_id:
        log.info("First run — taking only the latest post")
        return posts[:1]

    found = any(post["id"] == last_seen_id for post in posts)
    if not found:
        log.warning(
            "last_seen_id %s not in fetched window of %d posts — sending only the latest to avoid spam",
            last_seen_id,
            len(posts),
        )
        return posts[:1]

    new_posts: list[dict[str, Any]] = []
    for post in posts:
        if post["id"] == last_seen_id:
            break
        new_posts.append(post)

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
            # No retries on translation: if Google blocks/throttles we'd burn
            # the script budget waiting. Fall back to the original text instead.
            raw = http_get(url, retries=1)
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
# Telegram
# ---------------------------------------------------------------------------


def _parse_post_date(date_str: str) -> datetime | None:
    """Parse a date string from either RFC-2822 or ISO-8601, returning UTC-aware."""
    if not date_str:
        return None
    for parser in (parsedate_to_datetime, _parse_iso):
        try:
            dt = parser(date_str)
        except (ValueError, TypeError):
            continue
        if dt is None:
            continue
        # Treat tz-naive timestamps as UTC. Without this, astimezone() would
        # interpret them in the host's local timezone, which on GitHub Actions
        # happens to be UTC but is not guaranteed.
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    return None


def format_timestamp(date_str: str) -> str:
    """Convert date string to Israel time display string."""
    dt = _parse_post_date(date_str)
    if dt is None:
        return date_str or "—"
    return dt.astimezone(ISRAEL_TZ).strftime("%d/%m/%Y %H:%M")


def _parse_iso(date_str: str) -> datetime:
    return datetime.fromisoformat(date_str.replace("Z", "+00:00"))


def build_message(post: dict[str, Any], hebrew: str) -> str:
    """Build the Telegram message in HTML format — English text + Hebrew translation."""
    original = html.escape(post["text"])
    translated = html.escape(hebrew)
    timestamp = format_timestamp(post["created_at"])
    link = post.get("url", "")

    msg = (
        "🇺🇸 <b>טראמפ — פוסט חדש</b>\n"
        f"🕐 {timestamp}\n"
        "\n"
        f"{original}\n"
        "\n"
        "━━━━━━━━━━━━━━━\n"
        "\n"
        f"🇮🇱 <b>תרגום לעברית:</b>\n"
        f"{translated}\n"
    )
    if link:
        msg += f'\n🔗 <a href="{html.escape(link)}">לפוסט המקורי</a>'

    return msg


def _split_for_telegram(text: str, max_len: int = TELEGRAM_MAX_MESSAGE_LEN) -> list[str]:
    """Split a message at newline boundaries so each chunk fits Telegram's limit.

    Splits only at '\\n' (and falls back to spaces) to avoid breaking HTML tags
    or multi-byte characters. build_message keeps every <b>/<a> tag on a single
    line, so newline splits preserve well-formed HTML.
    """
    if len(text) <= max_len:
        return [text]

    chunks: list[str] = []
    remaining = text
    while len(remaining) > max_len:
        cut = remaining.rfind("\n", 0, max_len)
        if cut <= 0:
            cut = remaining.rfind(" ", 0, max_len)
        if cut <= 0:
            cut = max_len
        chunks.append(remaining[:cut].rstrip())
        remaining = remaining[cut:].lstrip()
    if remaining:
        chunks.append(remaining)
    return chunks


# Removing a possibly-stuck legacy reply keyboard requires sending an empty
# reply_markup with remove_keyboard=true. We attach this once on /start.
REMOVE_KEYBOARD: dict[str, Any] = {"remove_keyboard": True}


def send_telegram_message(
    text: str,
    chat_id: str | None = None,
    reply_markup: dict[str, Any] | None = None,
    thread_id: str | None = None,
) -> bool:
    """Send a message, splitting if it exceeds 4096 chars.

    ``thread_id`` pins the message to a specific forum topic in a group
    chat (Telegram's ``message_thread_id``). For private chats and groups
    without topics, leave it as None.
    """
    if not TELEGRAM_BOT_TOKEN:
        log.error("TELEGRAM_BOT_TOKEN not set")
        return False

    target = chat_id
    if not target:
        log.error("No chat_id provided")
        return False

    url = f"{TELEGRAM_API}/sendMessage"
    chunks = _split_for_telegram(text)

    for i, chunk in enumerate(chunks):
        payload: dict[str, Any] = {
            "chat_id": target,
            "text": chunk,
            "parse_mode": "HTML",
            "disable_web_page_preview": True,
        }
        if thread_id:
            payload["message_thread_id"] = thread_id
        # Attach reply_markup only to the final chunk so the keyboard
        # appears once per logical message.
        if reply_markup and i == len(chunks) - 1:
            payload["reply_markup"] = reply_markup

        try:
            result = http_post(url, payload)
        except Exception as exc:
            log.error("Failed to send Telegram message (chunk %d/%d): %s", i + 1, len(chunks), exc)
            return False

        if not result.get("ok"):
            log.error("Telegram API error (chunk %d/%d): %s", i + 1, len(chunks), result)
            return False

    log.info("Telegram message sent successfully to %s (%d chunk(s))", target, len(chunks))
    return True


def send_post_message(post: dict[str, Any], hebrew: str, chat_id: str) -> bool:
    """Send a translated post to a specific chat."""
    message = build_message(post, hebrew)
    return send_telegram_message(message, chat_id=chat_id)


def clear_bot_menu() -> None:
    """Clear the bot's slash-command menu so no commands are exposed."""
    try:
        http_post(f"{TELEGRAM_API}/setMyCommands", {"commands": []})
        log.info("Cleared bot commands list")
    except Exception as exc:
        log.warning("Failed to clear bot commands: %s", exc)

    try:
        http_post(f"{TELEGRAM_API}/setChatMenuButton", {
            "menu_button": {"type": "default"},
        })
        log.info("Reset bot menu button to default")
    except Exception as exc:
        log.warning("Failed to reset menu button: %s", exc)

# ---------------------------------------------------------------------------
# Subscribers — anyone who /start's the bot or adds it to a group/channel
# ---------------------------------------------------------------------------


def load_subscribers() -> dict[str, str | None]:
    """Load subscribers as {chat_id: thread_id_or_None}.

    Each line in the file is either ``chat_id`` (post to General / private DM)
    or ``chat_id\\tthread_id`` (post to a specific forum topic in a group).
    """
    subscribers: dict[str, str | None] = {}
    if SUBSCRIBERS_FILE.exists():
        for line in SUBSCRIBERS_FILE.read_text().splitlines():
            line = line.strip()
            if not line:
                continue
            parts = line.split("\t", 1)
            chat_id = parts[0].strip()
            thread_id = parts[1].strip() if len(parts) == 2 and parts[1].strip() else None
            if chat_id:
                subscribers[chat_id] = thread_id
    # Seed with the configured owner so existing deployments keep receiving
    # posts even before they /start the bot from scratch.
    if TELEGRAM_CHAT_ID and TELEGRAM_CHAT_ID not in subscribers:
        subscribers[TELEGRAM_CHAT_ID] = None
    return subscribers


def save_subscribers(subscribers: dict[str, str | None]) -> None:
    SUBSCRIBERS_FILE.parent.mkdir(parents=True, exist_ok=True)
    lines = []
    for chat_id in sorted(subscribers):
        thread_id = subscribers[chat_id]
        lines.append(f"{chat_id}\t{thread_id}" if thread_id else chat_id)
    content = "\n".join(lines)
    if content:
        content += "\n"
    SUBSCRIBERS_FILE.write_text(content)


def add_subscriber(chat_id: str, thread_id: str | None = None) -> bool:
    """Subscribe a chat (optionally pinned to a forum topic).

    Returns True if this changed the stored subscription (either a new chat,
    or an existing chat whose target topic moved).
    """
    if not chat_id:
        return False
    subscribers = load_subscribers()
    if subscribers.get(chat_id) == thread_id and chat_id in subscribers:
        return False
    subscribers[chat_id] = thread_id
    save_subscribers(subscribers)
    log.info(
        "Subscriber set: chat=%s thread=%s (total: %d)",
        chat_id, thread_id, len(subscribers),
    )
    return True


def remove_subscriber(chat_id: str) -> None:
    if not chat_id:
        return
    subscribers = load_subscribers()
    if chat_id in subscribers:
        del subscribers[chat_id]
        save_subscribers(subscribers)
        log.info("Removed subscriber: %s (total: %d)", chat_id, len(subscribers))

# ---------------------------------------------------------------------------
# Telegram — incoming updates (only /start subscribes; everything else ignored)
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
    """Fetch new updates from Telegram Bot API (short poll).

    Explicitly requests `my_chat_member` updates so we learn when the bot is
    added to or removed from groups/channels — those updates aren't included
    in the default `getUpdates` set.
    """
    params: dict[str, Any] = {
        "timeout": 0,
        "limit": 50,
        "allowed_updates": json.dumps(["message", "my_chat_member"]),
    }
    if offset:
        params["offset"] = offset
    url = f"{TELEGRAM_API}/getUpdates?{urllib.parse.urlencode(params)}"
    try:
        raw = http_get(url)
        result = json.loads(raw)
        if result.get("ok"):
            return result.get("result", [])
        log.warning("Telegram getUpdates returned not-ok: %s", result)
    except Exception as exc:
        log.warning("Failed to get Telegram updates: %s", exc)
    return []


def send_welcome(chat_id: str, chat_type: str, thread_id: str | None = None) -> None:
    """Send a one-time welcome when a chat first subscribes.

    ``thread_id`` pins the welcome (and future broadcasts) to a forum topic
    in a group chat. Omit it for private chats and groups without topics.
    """
    if chat_type == "private":
        msg = (
            "🇺🇸🇮🇱 <b>ברוכים הבאים!</b>\n"
            "\n"
            "אני שולח את הפוסטים של דונלד טראמפ מ-Truth Social, מתורגמים לעברית.\n"
            "\n"
            "📬 כל פוסט חדש יישלח אליך אוטומטית.\n"
            "\n"
            "💡 אפשר גם להוסיף אותי לקבוצה או לערוץ. כדי שאשלח לנושא ספציפי\n"
            "בקבוצה — שלח /start בתוך הנושא הרצוי."
        )
        # Strip any legacy reply keyboard a returning user may still have stuck.
        send_telegram_message(msg, chat_id=chat_id, reply_markup=REMOVE_KEYBOARD)
        return
    if chat_type in ("group", "supergroup"):
        if thread_id:
            msg = (
                "🇺🇸🇮🇱 <b>שלום!</b>\n"
                "אני אשלח את הפוסטים של טראמפ <b>בנושא הזה</b>, מתורגמים לעברית."
            )
        else:
            msg = (
                "🇺🇸🇮🇱 <b>שלום!</b>\n"
                "אני אשלח לקבוצה הזאת את הפוסטים של טראמפ מתורגמים לעברית, אוטומטית.\n"
                "\n"
                "💡 אם תרצה שאשלח לנושא ספציפי — שלח /start בתוך הנושא הרצוי."
            )
        send_telegram_message(msg, chat_id=chat_id, thread_id=thread_id)


def process_telegram_commands() -> None:
    """Handle incoming updates — subscribe on /start or when added to a chat.

    Everything else is ignored silently: the bot is broadcast-only.
    """
    log.info("Checking for Telegram updates...")
    last_update_id = load_last_update_id()
    offset = last_update_id + 1 if last_update_id else 0

    updates = get_telegram_updates(offset=offset)
    if not updates:
        log.info("No new updates")
        return

    log.info("Processing %d Telegram update(s)", len(updates))
    max_update_id = last_update_id

    for update in updates:
        update_id = update.get("update_id", 0)
        max_update_id = max(max_update_id, update_id)

        # Bot was added to / removed from a chat (private, group, or channel).
        my_chat_member = update.get("my_chat_member")
        if my_chat_member:
            chat = my_chat_member.get("chat", {})
            chat_id = str(chat.get("id", ""))
            chat_type = chat.get("type", "")
            new_status = my_chat_member.get("new_chat_member", {}).get("status", "")
            if new_status in ("member", "administrator", "creator"):
                if add_subscriber(chat_id):
                    send_welcome(chat_id, chat_type)
            elif new_status in ("kicked", "left", "restricted"):
                remove_subscriber(chat_id)
            continue

        # Incoming message. /start in a private chat or group subscribes that
        # chat. In a forum group, /start sent inside a topic pins broadcasts
        # to that specific topic. Every other message is ignored silently.
        message = update.get("message", {})
        text = (message.get("text") or "").strip()
        chat = message.get("chat", {})
        chat_id = str(chat.get("id", ""))
        chat_type = chat.get("type", "")
        # ``is_topic_message`` is set by Telegram when a message belongs to a
        # forum topic (not the General channel). We only pin when this is true
        # — otherwise message_thread_id may still be present but refer to a
        # reply thread, which we don't want to treat as a forum topic.
        thread_id: str | None = None
        if message.get("is_topic_message"):
            raw_thread = message.get("message_thread_id")
            if raw_thread is not None:
                thread_id = str(raw_thread)

        if not chat_id or not text:
            continue

        command = text.split()[0].lower().split("@")[0]
        if command != "/start":
            continue

        if chat_type == "private":
            newly_added = add_subscriber(chat_id)
            send_welcome(chat_id, chat_type)
            if not newly_added:
                log.info("Existing subscriber re-/start'd: %s", chat_id)
        elif chat_type in ("group", "supergroup"):
            changed = add_subscriber(chat_id, thread_id)
            # Always confirm in the topic where /start was sent, even on a
            # no-op — so the admin sees that the bot heard them.
            send_welcome(chat_id, chat_type, thread_id=thread_id)
            if not changed:
                log.info("Group %s already subscribed to thread %s", chat_id, thread_id)

    if max_update_id > last_update_id:
        save_last_update_id(max_update_id)

# ---------------------------------------------------------------------------
# Main pipeline
# ---------------------------------------------------------------------------


def main() -> None:
    global _script_deadline
    _script_deadline = time.monotonic() + SCRIPT_BUDGET_SECONDS

    log.info("=" * 60)
    log.info("Trump Truth Social → Telegram Bot starting")
    log.info("=" * 60)

    if not TELEGRAM_BOT_TOKEN:
        log.error("TELEGRAM_BOT_TOKEN environment variable is not set")
        sys.exit(1)

    # Keep the slash-command menu cleared — the bot is broadcast-only.
    clear_bot_menu()

    # Pick up new subscribers / kicks before broadcasting this round's posts.
    process_telegram_commands()

    if _budget_exceeded():
        log.warning("Budget exceeded after handling bot commands — exiting")
        return

    subscribers = load_subscribers()
    if not subscribers:
        log.info("No subscribers yet — nothing to broadcast")
        return

    # Load last seen post
    last_seen_id = load_last_seen()

    # Fetch posts
    posts = fetch_posts()
    if not posts:
        log.info("No posts fetched — exiting")
        return

    # Filter new posts
    new_posts = filter_new_posts(posts, last_seen_id)
    if not new_posts:
        log.info("No new posts — exiting")
        return

    log.info("Broadcasting %d new post(s) to %d subscriber(s)", len(new_posts), len(subscribers))

    # Translate and broadcast each new post to every subscriber.
    latest_id = ""
    for post in new_posts:
        if _budget_exceeded():
            log.warning("Budget exceeded — stopping at post %s to avoid overlapping next cron", post["id"])
            break

        log.info("Processing post %s", post["id"])
        hebrew = translate_to_hebrew(post["text"])
        message = build_message(post, hebrew)

        delivered = 0
        for sub_chat_id in sorted(subscribers):
            if _budget_exceeded():
                log.warning("Budget exceeded mid-broadcast — stopping")
                break
            sub_thread_id = subscribers[sub_chat_id]
            if send_telegram_message(message, chat_id=sub_chat_id, thread_id=sub_thread_id):
                delivered += 1
            # Telegram broadcast rate limit is ~30 msgs/sec; small gap keeps
            # us well under that even with many subscribers.
            time.sleep(0.05)

        if delivered > 0:
            latest_id = post["id"]
        else:
            log.warning("Failed to deliver post %s to any subscriber — stopping to retry next run", post["id"])
            break

        if len(new_posts) > 1:
            time.sleep(1)

    # Update last seen
    if latest_id:
        save_last_seen(latest_id)

    log.info("Done — processed up to post %s", latest_id or "(none)")


if __name__ == "__main__":
    main()
