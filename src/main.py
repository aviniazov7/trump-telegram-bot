#!/usr/bin/env python3
"""
Trump Truth Social → Hebrew Telegram Bot

Fetches Trump's latest posts from Truth Social (Mastodon API),
translates them to Hebrew, and sends them to a Telegram chat.
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
from pathlib import Path
from typing import Any

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

TRUMP_ACCOUNT_ID = "107780257626128497"
TRUTH_SOCIAL_API = f"https://truthsocial.com/api/v1/accounts/{TRUMP_ACCOUNT_ID}/statuses"
TRUTH_SOCIAL_PROFILE = "https://truthsocial.com/@realDonaldTrump"

TELEGRAM_BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_CHAT_ID = os.environ.get("TELEGRAM_CHAT_ID", "")
TELEGRAM_API = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}"

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
LAST_SEEN_FILE = DATA_DIR / "last_seen.txt"

ISRAEL_TZ = timezone(timedelta(hours=3))

MAX_RETRIES = 3
RETRY_DELAY = 5  # seconds
FETCH_LIMIT = 5

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
# Truth Social — fetch posts
# ---------------------------------------------------------------------------


def strip_html(text: str) -> str:
    """Remove HTML tags and decode entities."""
    text = re.sub(r"<br\s*/?>", "\n", text)
    text = re.sub(r"<[^>]+>", "", text)
    return html.unescape(text).strip()


def fetch_posts_mastodon_api() -> list[dict[str, Any]]:
    """Fetch posts via Truth Social's Mastodon-compatible API."""
    url = f"{TRUTH_SOCIAL_API}?limit={FETCH_LIMIT}&exclude_replies=true&exclude_reblogs=false"
    log.info("Fetching posts from Mastodon API: %s", url)
    headers = {"Accept": "application/json", "User-Agent": "TrumpTelegramBot/1.0"}
    raw = http_get(url, headers=headers)
    statuses = json.loads(raw)

    posts: list[dict[str, Any]] = []
    for s in statuses:
        content = s.get("content", "")
        text = strip_html(content)

        # Handle reblogs (re-truths)
        reblog = s.get("reblog")
        if reblog:
            reblog_text = strip_html(reblog.get("content", ""))
            reblog_author = reblog.get("account", {}).get("display_name", "Unknown")
            text = f"🔁 Re-Truth from {reblog_author}:\n{reblog_text}"

        if not text:
            continue

        post_id = s["id"]
        created = s.get("created_at", "")
        post_url = s.get("url") or f"{TRUTH_SOCIAL_PROFILE}/{post_id}"

        media_urls: list[str] = []
        for att in s.get("media_attachments", []):
            media_url = att.get("url") or att.get("remote_url")
            if media_url:
                media_urls.append(media_url)

        posts.append({
            "id": post_id,
            "text": text,
            "created_at": created,
            "url": post_url,
            "media_urls": media_urls,
        })

    log.info("Fetched %d posts from Mastodon API", len(posts))
    return posts


def fetch_posts_rss() -> list[dict[str, Any]]:
    """Fallback: fetch posts via RSS (if available)."""
    rss_urls = [
        f"https://truthsocial.com/@realDonaldTrump.rss",
        f"https://rsshub.app/truthsocial/user/realDonaldTrump",
    ]
    for rss_url in rss_urls:
        try:
            log.info("Trying RSS feed: %s", rss_url)
            raw = http_get(rss_url)
            return parse_rss(raw.decode("utf-8"))
        except Exception as exc:
            log.warning("RSS feed %s failed: %s", rss_url, exc)
    return []


def parse_rss(xml_text: str) -> list[dict[str, Any]]:
    """Minimal RSS XML parser using stdlib."""
    posts: list[dict[str, Any]] = []
    items = re.findall(r"<item>(.*?)</item>", xml_text, re.DOTALL)
    for item in items[:FETCH_LIMIT]:
        title = _xml_tag(item, "title")
        description = _xml_tag(item, "description")
        link = _xml_tag(item, "link") or _xml_tag(item, "guid")
        pub_date = _xml_tag(item, "pubDate")

        text = strip_html(description or title or "")
        if not text:
            continue

        # Try to extract an ID from the link
        post_id = link.rstrip("/").split("/")[-1] if link else ""

        posts.append({
            "id": post_id,
            "text": text,
            "created_at": pub_date or "",
            "url": link or "",
            "media_urls": [],
        })

    log.info("Parsed %d posts from RSS", len(posts))
    return posts


def _xml_tag(text: str, tag: str) -> str:
    """Extract text content of an XML tag."""
    m = re.search(rf"<{tag}[^>]*>(.*?)</{tag}>", text, re.DOTALL)
    if m:
        content = m.group(1).strip()
        # Handle CDATA
        cdata = re.match(r"<!\[CDATA\[(.*?)\]\]>", content, re.DOTALL)
        return cdata.group(1) if cdata else content
    return ""


def fetch_posts() -> list[dict[str, Any]]:
    """Fetch posts with fallback chain."""
    # Try Mastodon API first
    try:
        posts = fetch_posts_mastodon_api()
        if posts:
            return posts
    except Exception as exc:
        log.warning("Mastodon API failed: %s", exc)

    # Fallback to RSS
    try:
        posts = fetch_posts_rss()
        if posts:
            return posts
    except Exception as exc:
        log.warning("RSS fallback failed: %s", exc)

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
MAX_TRANSLATE_CHUNK = 4500  # characters per request


def translate_to_hebrew(text: str) -> str:
    """Translate English text to Hebrew using free Google Translate API."""
    if not text.strip():
        return text

    # Split long text into chunks
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
            # result[0] is a list of [translated_segment, original_segment, ...]
            translated = "".join(seg[0] for seg in result[0] if seg[0])
            translated_parts.append(translated)
        except Exception as exc:
            log.warning("Translation failed for chunk: %s", exc)
            translated_parts.append(chunk)  # fallback to original

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
        # Try to split at a newline or period
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


def format_timestamp(iso_str: str) -> str:
    """Convert ISO timestamp to Israel time display string."""
    if not iso_str:
        return "—"
    try:
        # Truth Social uses ISO 8601 format
        dt = datetime.fromisoformat(iso_str.replace("Z", "+00:00"))
        israel = dt.astimezone(ISRAEL_TZ)
        return israel.strftime("%d/%m/%Y %H:%M (Israel)")
    except (ValueError, TypeError):
        return iso_str


def build_message(post: dict[str, Any], hebrew: str) -> str:
    """Build the Telegram message in HTML format."""
    original = html.escape(post["text"])
    translated = html.escape(hebrew)
    timestamp = format_timestamp(post["created_at"])
    link = post.get("url", "")

    msg = (
        "🇺🇸 <b>טראמפ — פוסט חדש</b>\n"
        "\n"
        "📝 <b>מקור (אנגלית):</b>\n"
        f"{original}\n"
        "\n"
        "🇮🇱 <b>תרגום:</b>\n"
        f"{translated}\n"
        "\n"
        f"🕐 {timestamp}\n"
    )
    if link:
        msg += f'🔗 <a href="{html.escape(link)}">לפוסט המקורי</a>\n'

    return msg


def send_telegram_message(text: str) -> bool:
    """Send a message to the Telegram chat. Returns True on success."""
    if not TELEGRAM_BOT_TOKEN or not TELEGRAM_CHAT_ID:
        log.error("TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set")
        return False

    url = f"{TELEGRAM_API}/sendMessage"
    payload = {
        "chat_id": TELEGRAM_CHAT_ID,
        "text": text,
        "parse_mode": "HTML",
        "disable_web_page_preview": False,
    }

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


def send_telegram_photo(photo_url: str, caption: str) -> bool:
    """Send a photo to the Telegram chat."""
    if not TELEGRAM_BOT_TOKEN or not TELEGRAM_CHAT_ID:
        return False

    url = f"{TELEGRAM_API}/sendPhoto"
    payload = {
        "chat_id": TELEGRAM_CHAT_ID,
        "photo": photo_url,
        "caption": caption[:1024],  # Telegram caption limit
        "parse_mode": "HTML",
    }

    try:
        result = http_post(url, payload)
        return bool(result.get("ok"))
    except Exception as exc:
        log.error("Failed to send Telegram photo: %s", exc)
        return False

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

    # Step 1: Load last seen
    last_seen_id = load_last_seen()

    # Step 2: Fetch posts
    posts = fetch_posts()
    if not posts:
        log.info("No posts fetched — exiting")
        return

    # Step 3: Filter new posts
    new_posts = filter_new_posts(posts, last_seen_id)
    if not new_posts:
        log.info("No new posts — exiting")
        return

    log.info("Processing %d new post(s)", len(new_posts))

    # Step 4: Translate and send each new post
    latest_id = ""
    for post in new_posts:
        log.info("Processing post %s", post["id"])

        # Translate
        hebrew = translate_to_hebrew(post["text"])

        # Build and send message
        message = build_message(post, hebrew)
        success = send_telegram_message(message)

        # Send media if present
        if success and post.get("media_urls"):
            for media_url in post["media_urls"]:
                send_telegram_photo(media_url, "📸 מדיה מצורפת")

        if success:
            latest_id = post["id"]
        else:
            log.warning("Failed to send post %s — stopping to avoid gaps", post["id"])
            break

        # Brief delay between messages
        if len(new_posts) > 1:
            time.sleep(1)

    # Step 5: Update last seen
    if latest_id:
        save_last_seen(latest_id)

    log.info("Done — processed up to post %s", latest_id or "(none)")


if __name__ == "__main__":
    main()
