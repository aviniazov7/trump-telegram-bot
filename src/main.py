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

import hashlib
import hmac
import html
import json
import logging
import os
import re
import socket
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from state import BotState, StateError, load_or_migrate, store_from_env

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

TRUTH_SOCIAL_PROFILE = "https://truthsocial.com/@realDonaldTrump"
TRUMPSTRUTH_RSS = "https://www.trumpstruth.org/feed"
CNN_ARCHIVE_JSON = "https://ix.cnn.io/data/truth-social/truth_archive.json"

TELEGRAM_BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_CHAT_ID = os.environ.get("TELEGRAM_CHAT_ID", "")
TELEGRAM_API = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}"

# Runtime state lives outside git (see src/state.py). DATA_DIR only holds the
# local-development state file and the legacy *.txt files the one-time
# migration reads; it is gitignored.
DATA_DIR = Path(__file__).resolve().parent.parent / "data"
LOCAL_STATE_FILE = DATA_DIR / "state.json"

# Use Asia/Jerusalem so Israel DST (UTC+2 winter / UTC+3 summer) is correct.
ISRAEL_TZ = ZoneInfo("Asia/Jerusalem")

MAX_RETRIES = 2
RETRY_DELAY = 2  # seconds
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


# How far back a run looks for last_seen. GitHub's scheduler regularly skips
# runs for hours, and Trump can post dozens of times in that gap, so this has to
# cover a long outage: the trumpstruth RSS feed holds the latest 100 posts
# (about a week). If last_seen is not within this many posts, the bot sends only
# the newest one instead of flooding subscribers (see filter_new_posts).
MAX_SCAN_POSTS = _env_int("MAX_SCAN_POSTS", 100)


# ---- Gemini (primary translator) ----------------------------------------
# Google Gemini translates every post when GEMINI_API_KEY is set (free tier
# key from https://aistudio.google.com/apikey). Without a key, or when Gemini
# fails, the keyless providers in FREE_TRANSLATE_PROVIDERS take over.
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "").strip()
# Empty values come from unset Actions variables, so fall back explicitly.
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "").strip() or "gemini-3.8-flash"
GEMINI_API_URL = (
    "https://generativelanguage.googleapis.com/v1beta/models/"
    f"{GEMINI_MODEL}:generateContent"
)
# Optional: "minimal" / "low" / "medium" / "high". Unset = the model's default.
# Thinking tokens count against GEMINI_MAX_TOKENS.
GEMINI_THINKING_LEVEL = os.environ.get("GEMINI_THINKING_LEVEL", "").strip().lower()
GEMINI_MAX_TOKENS = _env_int("GEMINI_MAX_TOKENS", 8192)
GEMINI_TIMEOUT = _env_int("GEMINI_TIMEOUT", 60)
# A 429 from the free tier says how long to wait; wait at most this long.
GEMINI_MAX_RETRY_DELAY = 30  # seconds
# A post is sent to Gemini in one piece; Truth Social posts are far shorter.
GEMINI_MAX_CHARS = 12000

_script_deadline: float | None = None


def _budget_exceeded() -> bool:
    return _script_deadline is not None and time.monotonic() > _script_deadline


def _seconds_left() -> float:
    if _script_deadline is None:
        return float("inf")
    return _script_deadline - time.monotonic()


def redact_chat(chat_id: str | int | None) -> str:
    """Log-safe stand-in for a chat ID.

    Actions logs of a public repo are public, and chat IDs identify people.
    A plain hash of a ~10-digit ID is trivially brute-forced, so key it with
    the bot token: stable across runs (you can still correlate log lines),
    but not reversible without the secret.
    """
    if not chat_id:
        return "chat#-"
    digest = hmac.new(TELEGRAM_BOT_TOKEN.encode(), str(chat_id).encode(), hashlib.sha256)
    return "chat#" + digest.hexdigest()[:10]

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


def fetch_posts_trumpstruth(limit: int = MAX_SCAN_POSTS) -> list[dict[str, Any]]:
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

        if len(posts) >= limit:
            break

    log.info("Fetched %d posts from trumpstruth.org", len(posts))
    return posts


def fetch_posts_cnn_archive(limit: int = MAX_SCAN_POSTS) -> list[dict[str, Any]]:
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

        if len(posts) >= limit:
            break

    log.info("Fetched %d posts from CNN archive", len(posts))
    return posts


def _newest_first(posts: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Order posts newest first.

    Both sources already list newest first, but filter_new_posts depends on it,
    so don't trust that blindly. Truth Social IDs are snowflakes that grow over
    time; if any ID isn't numeric, keep the source's order.
    """
    if all(str(p.get("id", "")).isdigit() for p in posts):
        return sorted(posts, key=lambda p: int(p["id"]), reverse=True)
    return posts


def _contains(posts: list[dict[str, Any]], post_id: str) -> bool:
    return any(p["id"] == post_id for p in posts)


def fetch_posts(last_seen_id: str = "") -> list[dict[str, Any]]:
    """Fetch up to MAX_SCAN_POSTS recent posts, newest first.

    trumpstruth.org is the primary source. The CNN archive is used when it
    fails, and also when its window doesn't reach back to last_seen_id: the
    archive holds the full history, so it can still find the gap's start if
    the RSS feed dropped or reordered items.
    """
    posts: list[dict[str, Any]] = []
    try:
        posts = _newest_first(fetch_posts_trumpstruth())
    except Exception as exc:
        log.warning("trumpstruth.org RSS failed: %s", exc)

    if posts and (not last_seen_id or _contains(posts, last_seen_id)):
        return posts
    if posts:
        log.warning("last_seen not in the RSS window of %d posts — checking the CNN archive", len(posts))

    try:
        archive = _newest_first(fetch_posts_cnn_archive())
    except Exception as exc:
        log.warning("CNN archive fallback failed: %s", exc)
        archive = []

    if archive and (not posts or _contains(archive, last_seen_id)):
        return archive
    if posts:
        return posts

    log.error("All fetch methods failed")
    return []

# ---------------------------------------------------------------------------
# Duplicate prevention
# ---------------------------------------------------------------------------


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


# ---------------------------------------------------------------------------
# Gemini — primary translator
# ---------------------------------------------------------------------------

GEMINI_SYSTEM_PROMPT = """\
You translate posts that Donald Trump published on Truth Social into Hebrew,
for an Israeli audience that follows the news and the markets.

Translation rules:
- Translate the whole post accurately and completely. Do not summarize, omit,
  add, explain, or soften anything, and do not intensify it either.
- Write natural, fluent modern Hebrew, the way Israeli news outlets quote him.
  Keep his register: short punchy sentences stay short, exclamation marks stay,
  and words he writes in ALL CAPS for emphasis keep that emphasis.
- Names of people, places, organizations, and media outlets: use the spelling
  Israeli media use (Donald Trump = דונלד טראמפ, Joe Biden = ג'ו ביידן,
  Federal Reserve = הפדרל ריזרב). Without an established Hebrew form,
  transliterate the name and add the English in parentheses once.
- Keep numbers, percentages, dollar amounts, dates, stock tickers, hashtags,
  @handles, and URLs exactly as written.
- Use precise economic and political terms: tariffs = מכסים,
  interest rates = ריבית, trade deal = הסכם סחר.
- Keep the original line breaks.
- Stay politically neutral. You render his words; you neither endorse nor
  criticize them. Add no commentary, disclaimers, or quotation marks.

Return JSON only, matching the response schema. "hebrew" is the translation.
"""

GEMINI_RESPONSE_SCHEMA: dict[str, Any] = {
    "type": "OBJECT",
    "properties": {
        "hebrew": {"type": "STRING", "description": "The full Hebrew translation"},
    },
    "required": ["hebrew"],
}


class GeminiError(RuntimeError):
    """Gemini gave no usable answer. Callers fall back to the free providers."""


def _gemini_request(payload: dict[str, Any]) -> dict[str, Any]:
    """POST to Gemini once, waiting out one short 429 if the run allows it."""
    body = json.dumps(payload).encode()
    headers = {
        "Content-Type": "application/json",
        "User-Agent": DEFAULT_USER_AGENT,
        # In a header, not the URL, so the key never shows up in error logs.
        "x-goog-api-key": GEMINI_API_KEY,
    }
    for attempt in (1, 2):
        req = urllib.request.Request(GEMINI_API_URL, data=body, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=GEMINI_TIMEOUT) as resp:
                return json.loads(resp.read())
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")
            delay = _gemini_retry_delay(detail)
            if exc.code == 429 and attempt == 1 and delay is not None \
                    and delay <= GEMINI_MAX_RETRY_DELAY and delay < _seconds_left():
                log.warning("Gemini rate-limited — waiting %ds as asked", delay)
                time.sleep(delay)
                continue
            raise GeminiError(f"HTTP {exc.code}: {detail[:300]}") from exc
        except (urllib.error.URLError, OSError, ValueError) as exc:
            raise GeminiError(f"{type(exc).__name__}: {exc}") from exc
    raise GeminiError("rate-limited")


def _gemini_retry_delay(error_body: str) -> int | None:
    """Seconds from a 429's RetryInfo detail ("retryDelay": "23s"), if any."""
    m = re.search(r'"retryDelay"\s*:\s*"(\d+)(?:\.\d+)?s"', error_body)
    return int(m.group(1)) + 1 if m else None


def _gemini_json(text: str) -> dict[str, Any]:
    """Ask Gemini about one post and return its parsed JSON answer."""
    if not GEMINI_API_KEY:
        raise GeminiError("GEMINI_API_KEY not set")
    generation_config: dict[str, Any] = {
        "temperature": 0.2,
        "maxOutputTokens": GEMINI_MAX_TOKENS,
        "responseMimeType": "application/json",
        "responseSchema": GEMINI_RESPONSE_SCHEMA,
    }
    if GEMINI_THINKING_LEVEL:
        generation_config["thinkingConfig"] = {"thinkingLevel": GEMINI_THINKING_LEVEL}
    result = _gemini_request({
        "systemInstruction": {"parts": [{"text": GEMINI_SYSTEM_PROMPT}]},
        "contents": [{"role": "user", "parts": [{"text": text}]}],
        "generationConfig": generation_config,
    })

    try:
        candidate = result["candidates"][0]
    except (KeyError, IndexError, TypeError):
        block = (result.get("promptFeedback") or {}).get("blockReason") if isinstance(result, dict) else None
        raise GeminiError(f"no candidates (blockReason={block})") from None
    finish = candidate.get("finishReason", "STOP")
    if finish != "STOP":
        # MAX_TOKENS would hand us a truncated translation; SAFETY etc. none.
        raise GeminiError(f"finishReason={finish}")
    parts = (candidate.get("content") or {}).get("parts") or []
    # Thinking models may return their reasoning as separate "thought" parts.
    raw = "".join(p.get("text", "") for p in parts if isinstance(p, dict) and not p.get("thought"))
    try:
        data = json.loads(raw)
    except ValueError as exc:
        raise GeminiError(f"answer is not JSON: {raw[:120]!r}") from exc
    if not isinstance(data, dict):
        raise GeminiError("answer is not a JSON object")
    return data


def _translate_gemini(chunk: str) -> str | None:
    """Gemini's translation of one post (no keyless rate limits, best quality)."""
    if not GEMINI_API_KEY:
        return None
    hebrew = _gemini_json(chunk).get("hebrew")
    return hebrew.strip() if isinstance(hebrew, str) else None


# (name, function, max characters per request), best first. None of the free
# providers needs a key; they are what a deployment without GEMINI_API_KEY
# runs on, and the fallback whenever Gemini fails.
FREE_TRANSLATE_PROVIDERS: list[tuple[str, Any, int]] = [
    ("google-gtx", _translate_google_gtx, MAX_TRANSLATE_CHUNK),
    ("google-clients5", _translate_google_clients5, MAX_TRANSLATE_CHUNK),
    ("lingva", _translate_lingva, LINGVA_MAX_CHUNK),
    ("mymemory", _translate_mymemory, MYMEMORY_MAX_CHUNK),
]
TRANSLATE_PROVIDERS: list[tuple[str, Any, int]] = [
    ("gemini", _translate_gemini, GEMINI_MAX_CHARS),
    *FREE_TRANSLATE_PROVIDERS,
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


def translate_to_hebrew(
    text: str,
    providers: list[tuple[str, Any, int]] | None = None,
) -> tuple[str, bool]:
    """Translate English text to Hebrew, trying each provider in turn.

    Returns ``(text, translated)``. When ``translated`` is False every provider
    failed and ``text`` is the untouched English original — the caller must not
    present it as a Hebrew translation.
    """
    if not text.strip():
        return text, True

    providers = TRANSLATE_PROVIDERS if providers is None else providers
    for name, translate_chunk, max_chunk in providers:
        if name == "gemini" and not GEMINI_API_KEY:
            continue
        translated = _translate_with_provider(name, translate_chunk, max_chunk, text)
        if translated is not None:
            log.info("Translated post via %s", name)
            return translated, True

    log.error(
        "All %d translation providers failed — sending the English original",
        len(providers),
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
# Telegram Bot API calls
# ---------------------------------------------------------------------------
#
# sendMessage is not idempotent: if a request times out after Telegram got it,
# sending it again delivers the post twice. So a failed send is retried only
# when we know it never reached Telegram (connection refused, DNS failure) or
# when Telegram itself said "not sent, retry after N seconds" (HTTP 429).
# Read-only and set-style methods (getUpdates, setMyCommands) are safe to
# retry and pass idempotent=True.

# Errors raised before a single byte of the request reached Telegram.
_NOT_SENT_ERRORS = (ConnectionRefusedError, socket.gaierror)

TELEGRAM_ATTEMPTS = 3
# Don't wait out a 429 longer than this; give up on that message instead.
TELEGRAM_MAX_RETRY_AFTER = 30  # seconds

# Telegram's answer when a chat can never receive messages from the bot again.
# Any 403 means that (blocked, kicked, user deleted, never started the bot).
_GONE_400_DESCRIPTIONS = ("chat not found", "group chat was deactivated", "peer_id_invalid")


@dataclass
class TelegramResponse:
    ok: bool
    result: Any = None
    error_code: int = 0           # 0 = no HTTP answer (network error)
    description: str = ""
    retry_after: int = 0          # set on 429
    migrate_to: str = ""          # set when a group was upgraded to a supergroup
    uncertain: bool = False       # the request may have reached Telegram

    @property
    def chat_gone(self) -> bool:
        if self.error_code == 403:
            return True
        return self.error_code == 400 and any(
            d in self.description.lower() for d in _GONE_400_DESCRIPTIONS
        )


def _telegram_request(method: str, payload: dict[str, Any]) -> TelegramResponse:
    """One HTTP round trip to the Bot API, never raising."""
    req = urllib.request.Request(
        f"{TELEGRAM_API}/{method}",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", "User-Agent": DEFAULT_USER_AGENT},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
            raw = resp.read()
    except urllib.error.HTTPError as exc:
        # 4xx/5xx still carry Telegram's JSON error body — that's where
        # retry_after and the "blocked by the user" reason live.
        raw = exc.read()
        if not raw:
            return TelegramResponse(ok=False, error_code=exc.code, description=str(exc.reason))
    except urllib.error.URLError as exc:
        return TelegramResponse(
            ok=False,
            description=str(exc.reason),
            uncertain=not isinstance(exc.reason, _NOT_SENT_ERRORS),
        )
    except (TimeoutError, OSError) as exc:
        # A read timeout or reset after the request went out: Telegram may
        # well have delivered the message.
        return TelegramResponse(ok=False, description=f"{type(exc).__name__}: {exc}", uncertain=True)

    try:
        data = json.loads(raw)
    except ValueError:
        return TelegramResponse(ok=False, description="non-JSON response", uncertain=True)
    if not isinstance(data, dict):
        return TelegramResponse(ok=False, description="unexpected response", uncertain=True)
    params = data.get("parameters") or {}
    return TelegramResponse(
        ok=bool(data.get("ok")),
        result=data.get("result"),
        error_code=int(data.get("error_code") or 0),
        description=str(data.get("description") or ""),
        retry_after=int(params.get("retry_after") or 0),
        migrate_to=str(params.get("migrate_to_chat_id") or ""),
    )


def telegram_call(
    method: str,
    payload: dict[str, Any],
    *,
    idempotent: bool = False,
) -> TelegramResponse:
    """Call a Bot API method, retrying only when it is safe to.

    Logs only the method, error code and description: the full response can
    contain chat IDs (migrate_to_chat_id), and Actions logs are public.
    """
    resp = TelegramResponse(ok=False)
    for attempt in range(1, TELEGRAM_ATTEMPTS + 1):
        resp = _telegram_request(method, payload)
        if resp.ok:
            return resp
        last = attempt == TELEGRAM_ATTEMPTS

        if resp.error_code == 429:
            wait = max(resp.retry_after, 1)
            if last or wait > TELEGRAM_MAX_RETRY_AFTER or wait >= _seconds_left():
                log.warning("Telegram %s rate-limited (retry_after=%ds) — giving up", method, wait)
                return resp
            log.warning("Telegram %s rate-limited — waiting %ds as asked", method, wait)
            time.sleep(wait)
            continue

        if resp.error_code == 0 or resp.error_code >= 500:
            safe = idempotent or (resp.error_code == 0 and not resp.uncertain)
            if safe and not last:
                log.warning("Telegram %s attempt %d failed (%s) — retrying",
                            method, attempt, resp.description or resp.error_code)
                time.sleep(RETRY_DELAY * attempt)
                continue
            if not safe:
                log.warning("Telegram %s failed and may have gone through (%s) — not retrying",
                            method, resp.description or resp.error_code)
                return resp

        break

    log.warning("Telegram %s failed: %s %s", method, resp.error_code or "network", resp.description)
    return resp

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


@dataclass
class SendResult:
    """Outcome of send_telegram_message. Truthy when the message went out."""

    ok: bool
    gone: bool = False       # the chat can never be reached again: unsubscribe it
    migrated_to: str = ""    # the group became a supergroup with this new ID

    def __bool__(self) -> bool:
        return self.ok


def send_telegram_message(
    text: str,
    chat_id: str | None = None,
    reply_markup: dict[str, Any] | None = None,
    thread_id: str | None = None,
) -> SendResult:
    """Send a message, splitting if it exceeds 4096 chars.

    ``thread_id`` pins the message to a specific forum topic in a group
    chat (Telegram's ``message_thread_id``). For private chats and groups
    without topics, leave it as None.

    A chunk that fails is not retried blindly (see telegram_call), so a long
    message can arrive partially; that beats arriving twice.
    """
    if not TELEGRAM_BOT_TOKEN:
        log.error("TELEGRAM_BOT_TOKEN not set")
        return SendResult(False)

    target = chat_id
    if not target:
        log.error("No chat_id provided")
        return SendResult(False)

    chunks = _split_for_telegram(text)
    migrated_to = ""

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

        resp = telegram_call("sendMessage", payload)
        if not resp.ok and resp.migrate_to and not migrated_to:
            # The group was upgraded to a supergroup. Telegram did not
            # deliver to the old ID, so resend there once.
            log.info("Chat %s migrated to %s", redact_chat(target), redact_chat(resp.migrate_to))
            target = migrated_to = resp.migrate_to
            payload["chat_id"] = target
            resp = telegram_call("sendMessage", payload)

        if not resp.ok:
            log.error(
                "Failed to send to %s (chunk %d/%d): %s %s",
                redact_chat(target), i + 1, len(chunks), resp.error_code or "network", resp.description,
            )
            return SendResult(False, gone=resp.chat_gone, migrated_to=migrated_to)

    log.info("Telegram message sent successfully to %s (%d chunk(s))", redact_chat(target), len(chunks))
    return SendResult(True, migrated_to=migrated_to)


def send_post_message(
    post: dict[str, Any],
    hebrew: str,
    chat_id: str,
    translated: bool = True,
) -> SendResult:
    """Send a translated post to a specific chat."""
    message = build_message(post, hebrew, translated)
    return send_telegram_message(message, chat_id=chat_id)


# The bot is broadcast-only, so it exposes no slash commands and the default
# menu button. Changing this triggers a one-time re-apply (see main()).
BOT_MENU_CONFIG: dict[str, dict[str, Any]] = {
    "setMyCommands": {"commands": []},
    "setChatMenuButton": {"menu_button": {"type": "default"}},
}


def menu_fingerprint() -> str:
    """Identify the menu config together with the bot it was applied to.

    Keyed with the bot token, so a new bot (new token) gets its menu set even
    though the config itself didn't change — without storing the token.
    """
    config = json.dumps(BOT_MENU_CONFIG, sort_keys=True).encode()
    return hmac.new(TELEGRAM_BOT_TOKEN.encode(), config, hashlib.sha256).hexdigest()[:16]


def clear_bot_menu() -> bool:
    """Clear the bot's slash-command menu so no commands are exposed.

    Returns True only if every call succeeded, so a failure is retried on the
    next run.
    """
    all_ok = True
    for method, payload in BOT_MENU_CONFIG.items():
        if telegram_call(method, payload, idempotent=True).ok:
            log.info("Applied %s", method)
        else:
            log.warning("Failed to apply %s", method)
            all_ok = False
    return all_ok

# ---------------------------------------------------------------------------
# Subscribers — anyone who /start's the bot or adds it to a group/channel
# ---------------------------------------------------------------------------


def seed_owner(state: BotState) -> None:
    """Make sure the configured owner chat is subscribed.

    Keeps existing deployments receiving posts even before the owner has
    /start'ed the bot.
    """
    if TELEGRAM_CHAT_ID and TELEGRAM_CHAT_ID not in state.subscribers:
        state.subscribers[TELEGRAM_CHAT_ID] = None


def add_subscriber(state: BotState, chat_id: str, thread_id: str | None = None) -> bool:
    """Subscribe a chat (optionally pinned to a forum topic).

    Returns True if this changed the stored subscription (either a new chat,
    or an existing chat whose target topic moved).
    """
    if not chat_id:
        return False
    if chat_id in state.subscribers and state.subscribers[chat_id] == thread_id:
        return False
    state.subscribers[chat_id] = thread_id
    log.info(
        "Subscriber set: %s thread=%s (total: %d)",
        redact_chat(chat_id), thread_id, len(state.subscribers),
    )
    return True


def remove_subscriber(state: BotState, chat_id: str) -> None:
    if chat_id and chat_id in state.subscribers:
        del state.subscribers[chat_id]
        log.info("Removed subscriber: %s (total: %d)", redact_chat(chat_id), len(state.subscribers))


def drop_unreachable(state: BotState, chat_id: str) -> None:
    """Unsubscribe a chat Telegram says we can never reach (403 / chat not found).

    The configured owner chat is kept: seed_owner would only re-add it next
    run, and a 403 there means the owner hasn't /start'ed the bot yet.
    """
    if chat_id == TELEGRAM_CHAT_ID:
        log.error("Owner chat is unreachable — /start the bot from TELEGRAM_CHAT_ID")
        return
    log.info("Chat %s blocked the bot or no longer exists", redact_chat(chat_id))
    remove_subscriber(state, chat_id)


def migrate_subscriber(state: BotState, old_id: str, new_id: str) -> None:
    """Follow a group that Telegram upgraded to a supergroup (new chat ID)."""
    if old_id in state.subscribers:
        state.subscribers.setdefault(new_id, state.subscribers.pop(old_id))

# ---------------------------------------------------------------------------
# Telegram — incoming updates (only /start subscribes; everything else ignored)
# ---------------------------------------------------------------------------


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


def process_telegram_commands(state: BotState) -> None:
    """Handle incoming updates — subscribe on /start or when added to a chat.

    Mutates ``state`` in memory; the caller persists it. Everything else is
    ignored silently: the bot is broadcast-only.
    """
    log.info("Checking for Telegram updates...")
    last_update_id = state.last_update_id
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
                if add_subscriber(state, chat_id):
                    send_welcome(chat_id, chat_type)
            elif new_status in ("kicked", "left", "restricted"):
                remove_subscriber(state, chat_id)
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
            newly_added = add_subscriber(state, chat_id)
            send_welcome(chat_id, chat_type)
            if not newly_added:
                log.info("Existing subscriber re-/start'd: %s", redact_chat(chat_id))
        elif chat_type in ("group", "supergroup"):
            changed = add_subscriber(state, chat_id, thread_id)
            # Always confirm in the topic where /start was sent, even on a
            # no-op — so the admin sees that the bot heard them.
            send_welcome(chat_id, chat_type, thread_id=thread_id)
            if not changed:
                log.info("Group %s already subscribed to thread %s", redact_chat(chat_id), thread_id)

    if max_update_id > last_update_id:
        state.last_update_id = max_update_id

# ---------------------------------------------------------------------------
# Broadcast — one post to every subscriber, resumable
# ---------------------------------------------------------------------------


def broadcast_post(state: BotState, post: dict[str, Any], message: str) -> bool:
    """Send one post to every subscriber who doesn't have it yet.

    Returns True when the post is finished: every subscriber was tried and at
    least one (in this run or an earlier, interrupted one) received it. The
    caller then advances last_seen.

    Returns False when the run budget ran out mid-broadcast, or when nobody at
    all could be reached (Telegram down) — the post must be retried next run.
    Progress is kept in state.in_flight_*, so on retry the chats that already
    got the post are skipped instead of receiving it twice.
    """
    if state.in_flight_post != post["id"]:
        state.in_flight_post = post["id"]
        state.in_flight_chats = []
    done = set(state.in_flight_chats)

    for chat_id in sorted(state.subscribers):
        if chat_id in done:
            continue
        if _budget_exceeded():
            log.warning(
                "Budget exceeded mid-broadcast of post %s — %d chat(s) done, resuming next run",
                post["id"], len(done),
            )
            return False
        result = send_telegram_message(message, chat_id=chat_id, thread_id=state.subscribers[chat_id])
        if result.migrated_to:
            migrate_subscriber(state, chat_id, result.migrated_to)
            chat_id = result.migrated_to
        if result:
            done.add(chat_id)
            state.in_flight_chats.append(chat_id)
        elif result.gone:
            drop_unreachable(state, chat_id)
        # Telegram broadcast rate limit is ~30 msgs/sec; small gap keeps
        # us well under that even with many subscribers.
        time.sleep(0.05)

    if not done:
        log.warning("Failed to deliver post %s to any subscriber — stopping to retry next run", post["id"])
        return False
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

    # Load state before touching Telegram. If the store is unreachable we stop
    # here: guessing "empty" would re-send old posts and, on save, wipe the
    # real subscriber list.
    try:
        store = store_from_env(LOCAL_STATE_FILE)
        state = load_or_migrate(store, DATA_DIR)
    except StateError as exc:
        log.error("Cannot load bot state: %s", exc)
        sys.exit(1)
    persisted = state.copy()
    seed_owner(state)
    log.info(
        "State: %d subscriber(s), last_seen=%s, last_update_id=%d",
        len(state.subscribers), state.last_seen or "(none)", state.last_update_id,
    )

    def persist() -> None:
        """Write state only if it changed, so idle runs make no API writes."""
        nonlocal persisted
        if state == persisted:
            return
        try:
            store.save(state)
        except StateError as exc:
            log.error("Cannot save bot state: %s", exc)
            sys.exit(1)
        persisted = state.copy()
        log.info("State saved")

    # Keep the slash-command menu cleared — the bot is broadcast-only. Telegram
    # remembers it, so this only runs when the config or the bot changes.
    fingerprint = menu_fingerprint()
    if state.menu_config != fingerprint and clear_bot_menu():
        state.menu_config = fingerprint

    # Pick up new subscribers / kicks before broadcasting this round's posts.
    # Persist right away so a crash mid-broadcast doesn't lose a /start.
    process_telegram_commands(state)
    persist()

    if _budget_exceeded():
        log.warning("Budget exceeded after handling bot commands — exiting")
        return

    subscribers = state.subscribers
    if not subscribers:
        log.info("No subscribers yet — nothing to broadcast")
        return

    last_seen_id = state.last_seen
    log.info("Last seen post ID: %s", last_seen_id or "(none) — first run")

    posts = fetch_posts(last_seen_id)
    new_posts = filter_new_posts(posts, last_seen_id) if posts else []
    if not posts:
        log.info("No posts fetched this run")
    elif not new_posts:
        log.info("No new posts this run")

    log.info("Broadcasting %d new post(s) to %d subscriber(s)", len(new_posts), len(subscribers))

    # Oldest first. State is saved after every post, so a run that dies or
    # runs out of time never re-sends what it already finished.
    latest_id = ""
    try:
        for post in new_posts:
            if _budget_exceeded():
                log.warning("Budget exceeded — stopping at post %s to avoid overlapping next cron", post["id"])
                break

            log.info("Processing post %s", post["id"])
            hebrew, translated = translate_to_hebrew(post["text"])
            message = build_message(post, hebrew, translated)

            if not broadcast_post(state, post, message):
                break
            state.last_seen = post["id"]
            state.in_flight_post, state.in_flight_chats = "", []
            persist()
            latest_id = post["id"]

            if len(new_posts) > 1:
                time.sleep(1)
    finally:
        # Also covers an interrupted broadcast: its in-flight progress is
        # saved so the next run skips the chats that already have the post.
        persist()

    log.info("Done — processed up to post %s", latest_id or "(none)")


if __name__ == "__main__":
    main()
