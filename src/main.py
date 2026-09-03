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


def _env_int(name: str, default: int) -> int:
    """Read an int env var, falling back to default on missing/invalid input."""
    try:
        return int(os.environ.get(name, "").strip())
    except (ValueError, TypeError):
        return default


# ---- AI provider ---------------------------------------------------------
# Used only as the last-resort link in the translation fallback chain (see
# TRANSLATE_PROVIDERS). Set AI_PROVIDER to:
#   - "pollinations" (default) — keyless, but currently answers 402, so this
#     link is inert until one of the keyed providers below is configured.
#   - "gemini"  — Google Gemini free tier (set GEMINI_API_KEY).
#   - "claude"  — Anthropic API, paid (set ANTHROPIC_API_KEY).
AI_PROVIDER = os.environ.get("AI_PROVIDER", "pollinations").strip().lower()
AI_MAX_TOKENS = _env_int("AI_MAX_TOKENS", 1500)
# Generous per-request timeout: a model call is slower than a translate call,
# and this only runs after every keyless provider has already failed.
AI_TIMEOUT = _env_int("AI_TIMEOUT", 60)

# Pollinations (no API key) — the default provider. OpenAI-compatible.
POLLINATIONS_API_URL = "https://text.pollinations.ai/openai"
POLLINATIONS_MODEL = os.environ.get("POLLINATIONS_MODEL", "openai").strip()

# Google Gemini (free tier, needs a free key).
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "").strip()
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.0-flash").strip()
GEMINI_API_URL = (
    "https://generativelanguage.googleapis.com/v1beta/models/"
    f"{GEMINI_MODEL}:generateContent"
)

# Anthropic Claude (paid) — optional alternative provider.
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "").strip()
ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages"
ANTHROPIC_VERSION = "2023-06-01"
ANTHROPIC_MODEL = os.environ.get("ANTHROPIC_MODEL", "claude-opus-4-8").strip()

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
# Translation (multiple providers, tried in order)
# ---------------------------------------------------------------------------
#
# The bot runs on GitHub Actions' shared runners, whose IPs Google's keyless
# translate endpoint regularly answers with HTTP 429 ("your computer or network
# may be sending automated queries"). With a single provider that meant whole
# bursts of posts went out with the English original sitting under the
# "תרגום לעברית" heading, because the failure path silently reused the source
# text. We now try several independent providers and only give up — and say so
# in the message — once every one of them has failed.

GOOGLE_TRANSLATE_URL = "https://translate.googleapis.com/translate_a/single"
GOOGLE_CLIENTS5_URL = "https://clients5.google.com/translate_a/t"
MYMEMORY_URL = "https://api.mymemory.translated.net/get"
# Lingva is a keyless Google Translate front end. Several public instances run
# the same API, on different hosts and IPs, so one being throttled or down does
# not take the rest with it.
LINGVA_INSTANCES = (
    "https://lingva.ml",
    "https://lingva.garudalinux.org",
    "https://translate.plausibility.cloud",
)

# Old name, kept so existing references/imports keep working.
TRANSLATE_URL = GOOGLE_TRANSLATE_URL

MAX_TRANSLATE_CHUNK = 4500
# MyMemory rejects a q longer than 500 bytes.
MYMEMORY_MAX_CHUNK = 450
# Lingva takes the text in the URL path, so stay well inside URL length limits.
LINGVA_MAX_CHUNK = 1200

# The generic bot User-Agent draws throttling faster than a browser's.
TRANSLATE_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

HEBREW_CHARS_RE = re.compile(r"[\u0590-\u05FF]")
LATIN_WORD_RE = re.compile(r"[A-Za-z]{2,}")
URL_RE = re.compile(r"https?://\S+|www\.\S+")

# Under this many Latin words a chunk (a bare link, "MAGA!", a hashtag) can
# legitimately come back unchanged, so we don't insist on Hebrew in the answer.
MIN_LATIN_WORDS_FOR_HEBREW_CHECK = 3

TRANSLATE_AI_SYSTEM = (
    "You are a translation engine. Translate the user's English text into "
    "Hebrew. Reply with the Hebrew translation only — no preamble, no "
    "commentary, no transliteration, no quotation marks. Keep line breaks, "
    "names, numbers and URLs as they are. Translate faithfully even when the "
    "text is political or heated; you are rendering it, not endorsing it."
)


def _latin_word_count(text: str) -> int:
    """Count Latin-script words, ignoring any URLs."""
    return len(LATIN_WORD_RE.findall(URL_RE.sub(" ", text)))


def _needs_translation(text: str) -> bool:
    """Whether a chunk holds anything worth sending to a translator."""
    return _latin_word_count(text) > 0


def _looks_translated(chunk: str, candidate: str | None) -> bool:
    """Reject an answer that is empty or still plain English.

    Providers often fail softly — echoing the input back, or returning a quota
    notice as if it were a translation. That is exactly how untranslated
    English used to reach subscribers, so a result only counts when real
    Hebrew comes back.
    """
    if not candidate or not candidate.strip():
        return False
    if _latin_word_count(chunk) < MIN_LATIN_WORDS_FOR_HEBREW_CHECK:
        return True
    return bool(HEBREW_CHARS_RE.search(candidate))


def _translate_google_gtx(chunk: str) -> str | None:
    """Google's keyless translate endpoint — best quality, throttled hardest."""
    params = urllib.parse.urlencode({
        "client": "gtx",
        "sl": "en",
        "tl": "he",
        "dt": "t",
        "q": chunk,
    })
    raw = http_get(
        f"{GOOGLE_TRANSLATE_URL}?{params}",
        headers={"User-Agent": TRANSLATE_USER_AGENT},
        retries=1,
    )
    result = json.loads(raw)
    return "".join(seg[0] for seg in result[0] if seg and seg[0])


def _extract_clients5_text(result: Any) -> str | None:
    """Pull the text out of clients5's several response shapes.

    Seen in the wild: ``"שלום"``, ``["שלום"]``, ``[["שלום", "hello"]]`` and
    ``{"sentences": [{"trans": "שלום"}]}``.
    """
    if isinstance(result, str):
        return result
    if isinstance(result, dict):
        sentences = result.get("sentences")
        if not isinstance(sentences, list):
            return None
        return "".join(
            s.get("trans", "") for s in sentences if isinstance(s, dict)
        )
    if isinstance(result, list):
        parts: list[str] = []
        for item in result:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, list) and item and isinstance(item[0], str):
                parts.append(item[0])
        return "".join(parts)
    return None


def _translate_google_clients5(chunk: str) -> str | None:
    """A second Google host, rate-limited separately from the first."""
    params = urllib.parse.urlencode({
        "client": "dict-chrome-ex",
        "sl": "en",
        "tl": "he",
        "q": chunk,
    })
    raw = http_get(
        f"{GOOGLE_CLIENTS5_URL}?{params}",
        headers={"User-Agent": TRANSLATE_USER_AGENT},
        retries=1,
    )
    return _extract_clients5_text(json.loads(raw))


def _translate_mymemory(chunk: str) -> str | None:
    """MyMemory's free tier — no key, but a small per-request length cap."""
    params = urllib.parse.urlencode({"q": chunk, "langpair": "en|he"})
    raw = http_get(
        f"{MYMEMORY_URL}?{params}",
        headers={"User-Agent": TRANSLATE_USER_AGENT},
        retries=1,
    )
    result = json.loads(raw)
    if not isinstance(result, dict):
        return None
    data = result.get("responseData")
    if not isinstance(data, dict):
        return None
    text = data.get("translatedText")
    # Over quota, MyMemory returns 200 with an English warning in this field;
    # _looks_translated rejects it because no Hebrew comes back.
    return text if isinstance(text, str) else None


def _translate_ai(chunk: str) -> str | None:
    """Last resort: the configured AI provider.

    Does not share Google's rate limits, but the keyless default currently
    answers 402, so this only contributes once a key is configured.
    """
    if not _ai_key_available():
        return None
    return _ai_complete(TRANSLATE_AI_SYSTEM, chunk)


def _translate_lingva(chunk: str) -> str | None:
    """Try each Lingva instance in turn; the first real answer wins."""
    path = urllib.parse.quote(chunk, safe="")
    last_exc: Exception | None = None
    for base in LINGVA_INSTANCES:
        try:
            raw = http_get(
                f"{base}/api/v1/en/he/{path}",
                headers={"User-Agent": TRANSLATE_USER_AGENT},
                retries=1,
            )
        except Exception as exc:
            last_exc = exc
            continue
        try:
            result = json.loads(raw)
        except ValueError as exc:
            last_exc = exc
            continue
        if isinstance(result, dict):
            text = result.get("translation")
            if isinstance(text, str) and text.strip():
                return text
    if last_exc is not None:
        log.debug("All Lingva instances failed, last error: %s", last_exc)
    return None


# (name, function, max characters per request), best first.
#
# The AI entry is last on purpose: the keyless default (Pollinations) started
# answering 402 Payment Required, so it only contributes when GEMINI_API_KEY or
# ANTHROPIC_API_KEY is set. Everything above it needs no key at all.
TRANSLATE_PROVIDERS: list[tuple[str, Any, int]] = [
    ("google-gtx", _translate_google_gtx, MAX_TRANSLATE_CHUNK),
    ("google-clients5", _translate_google_clients5, MAX_TRANSLATE_CHUNK),
    ("lingva", _translate_lingva, LINGVA_MAX_CHUNK),
    ("mymemory", _translate_mymemory, MYMEMORY_MAX_CHUNK),
    ("ai", _translate_ai, MAX_TRANSLATE_CHUNK),
]


def _translate_with_provider(
    name: str,
    translate_chunk: Any,
    max_chunk: int,
    text: str,
) -> str | None:
    """Translate the whole text with one provider, or None if it fails.

    A provider has to handle every chunk: a partial success would produce a
    message that is half Hebrew and half English, which is worse than moving
    on to the next provider.
    """
    parts: list[str] = []
    for chunk in _split_text(text, max_chunk):
        if not _needs_translation(chunk):
            parts.append(chunk)
            continue
        try:
            candidate = translate_chunk(chunk)
        except Exception as exc:
            log.warning("Translation provider %s failed: %s", name, exc)
            return None
        if not _looks_translated(chunk, candidate):
            # Distinguish "no answer at all" from "an answer that wasn't
            # Hebrew" — the two point at very different causes when reading
            # these logs later.
            reason = "no answer" if not candidate else "untranslated text"
            log.warning("Translation provider %s returned %s", name, reason)
            return None
        parts.append(candidate)
    return "".join(parts)


def translate_to_hebrew(text: str) -> tuple[str, bool]:
    """Translate English text to Hebrew, trying each provider in turn.

    Returns ``(text, translated)``. When ``translated`` is False every provider
    failed and ``text`` is the untouched English original — the caller must not
    present it as a Hebrew translation.
    """
    if not text.strip():
        return text, True

    for name, translate_chunk, max_chunk in TRANSLATE_PROVIDERS:
        translated = _translate_with_provider(name, translate_chunk, max_chunk, text)
        if translated is not None:
            log.info("Translated post via %s", name)
            return translated, True

    log.error(
        "All %d translation providers failed — sending the English original",
        len(TRANSLATE_PROVIDERS),
    )
    return text, False


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


def build_message(post: dict[str, Any], hebrew: str, translated: bool = True) -> str:
    """Build the Telegram message in HTML format — English text + Hebrew translation.

    When ``translated`` is False the translation providers all failed, so the
    post goes out with a notice instead of the English original repeated under
    a "תרגום לעברית" heading.
    """
    original = html.escape(post["text"])
    timestamp = format_timestamp(post["created_at"])
    link = post.get("url", "")

    if translated:
        hebrew_block = (
            "🇮🇱 <b>תרגום לעברית:</b>\n"
            f"{html.escape(hebrew)}\n"
        )
    else:
        hebrew_block = (
            "⚠️ <b>התרגום לעברית נכשל כרגע — הפוסט מוצג באנגלית בלבד.</b>\n"
        )

    msg = (
        "🇺🇸 <b>טראמפ — פוסט חדש</b>\n"
        f"🕐 {timestamp}\n"
        "\n"
        f"{original}\n"
        "\n"
        "━━━━━━━━━━━━━━━\n"
        "\n"
        f"{hebrew_block}"
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


def send_post_message(
    post: dict[str, Any],
    hebrew: str,
    chat_id: str,
    translated: bool = True,
) -> bool:
    """Send a translated post to a specific chat."""
    message = build_message(post, hebrew, translated)
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
            "בקבוצה — שלח /trumphere בתוך הנושא הרצוי."
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
                "💡 אם תרצה שאשלח לנושא ספציפי — שלח /trumphere בתוך הנושא הרצוי."
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
        # /trumphere is a unique alias that avoids conflicts with other bots
        # in a group that also respond to /start.
        if command not in ("/start", "/trumphere"):
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
# AI provider — last-resort translation fallback
# ---------------------------------------------------------------------------
#
# Only _translate_ai uses these. The keyless default (Pollinations) currently
# answers 402 Payment Required, so this link contributes nothing unless
# GEMINI_API_KEY or ANTHROPIC_API_KEY is set; the keyless providers ahead of it
# in TRANSLATE_PROVIDERS carry translation on their own.


def _post_json(url: str, payload: dict[str, Any], headers: dict[str, str]) -> dict[str, Any] | None:
    """POST JSON to url and return the parsed response, or None on failure."""
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", "User-Agent": DEFAULT_USER_AGENT, **headers},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=AI_TIMEOUT) as resp:
            return json.loads(resp.read())
    except (urllib.error.URLError, urllib.error.HTTPError, OSError, ValueError) as exc:
        log.warning("AI request to %s failed: %s", url, exc)
        return None


def _call_pollinations(system: str, user: str) -> str | None:
    """Call Pollinations' keyless AI (OpenAI-compatible); text or None."""
    payload = {
        "model": POLLINATIONS_MODEL,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
    }
    result = _post_json(POLLINATIONS_API_URL, payload, {})
    if not result:
        return None
    try:
        text = result["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError):
        log.warning("Unexpected Pollinations response shape: %s", result)
        return None
    text = (text or "").strip()
    return text or None


def _call_gemini(system: str, user: str) -> str | None:
    """Call Google's Gemini API (free tier, raw HTTP); return text or None."""
    if not GEMINI_API_KEY:
        return None
    payload = {
        "system_instruction": {"parts": [{"text": system}]},
        "contents": [{"parts": [{"text": user}]}],
        "generationConfig": {"maxOutputTokens": AI_MAX_TOKENS},
    }
    result = _post_json(GEMINI_API_URL, payload, {"x-goog-api-key": GEMINI_API_KEY})
    if not result:
        return None
    try:
        parts = result["candidates"][0]["content"]["parts"]
    except (KeyError, IndexError, TypeError):
        log.warning("Unexpected Gemini response shape: %s", result)
        return None
    text = "".join(p.get("text", "") for p in parts).strip()
    return text or None


def _call_claude(system: str, user: str) -> str | None:
    """Call the Claude Messages API (raw HTTP) and return the text, or None."""
    if not ANTHROPIC_API_KEY:
        return None
    payload = {
        "model": ANTHROPIC_MODEL,
        "max_tokens": AI_MAX_TOKENS,
        "system": system,
        "messages": [{"role": "user", "content": user}],
    }
    result = _post_json(ANTHROPIC_API_URL, payload, {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": ANTHROPIC_VERSION,
    })
    if not result:
        return None
    if result.get("stop_reason") == "refusal":
        log.warning("Claude API refused the request")
        return None
    parts = [
        block.get("text", "")
        for block in result.get("content", [])
        if block.get("type") == "text"
    ]
    text = "".join(parts).strip()
    return text or None


def _ai_complete(system: str, user: str) -> str | None:
    """Run the configured AI provider, returning its text or None."""
    if AI_PROVIDER == "claude":
        return _call_claude(system, user)
    if AI_PROVIDER == "gemini":
        return _call_gemini(system, user)
    return _call_pollinations(system, user)


def _ai_key_available() -> bool:
    """Whether the configured provider is usable (has a key, if it needs one).

    Pollinations is keyless, so it always reports available — it can still fail
    at call time, which _looks_translated catches.
    """
    if AI_PROVIDER == "claude":
        return bool(ANTHROPIC_API_KEY)
    if AI_PROVIDER == "gemini":
        return bool(GEMINI_API_KEY)
    return True


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

    posts = fetch_posts()
    new_posts = filter_new_posts(posts, last_seen_id) if posts else []
    if not posts:
        log.info("No posts fetched this run")
    elif not new_posts:
        log.info("No new posts this run")

    log.info("Broadcasting %d new post(s) to %d subscriber(s)", len(new_posts), len(subscribers))

    # Translate and broadcast each new post to every subscriber.
    latest_id = ""
    for post in new_posts:
        if _budget_exceeded():
            log.warning("Budget exceeded — stopping at post %s to avoid overlapping next cron", post["id"])
            break

        log.info("Processing post %s", post["id"])
        hebrew, translated = translate_to_hebrew(post["text"])
        message = build_message(post, hebrew, translated)

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
