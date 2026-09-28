"""
Runtime state storage for the bot.

The bot's state — subscriber chat IDs, the last broadcast post, and the last
processed Telegram update — used to live in data/*.txt and was committed back
to the repo after every run. That published subscribers' chat IDs in a public
repo and produced hundreds of "Update bot state" commits. State now lives
outside git behind a small StateStore interface:

- GitHubVariableStateStore (production): one GitHub Actions repository
  variable holding the state as JSON, read and written through the REST API
  with a fine-grained token scoped to this repo's "Variables" permission.
- FileStateStore (local development / tests): a JSON file, gitignored.

Both backends store the same JSON document, so switching is a config change.
"""

from __future__ import annotations

import json
import logging
import os
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Protocol

log = logging.getLogger(__name__)

STATE_VERSION = 1

# GitHub caps a repository variable's value at 48 KB. We refuse to write
# anything bigger rather than let the API reject it after a broadcast.
GITHUB_VARIABLE_MAX_BYTES = 48 * 1024

DEFAULT_VARIABLE_NAME = "BOT_STATE"
DEFAULT_GITHUB_API = "https://api.github.com"


class StateError(RuntimeError):
    """State could not be read or written. The run must stop, not guess."""


# ---------------------------------------------------------------------------
# State model
# ---------------------------------------------------------------------------


@dataclass
class BotState:
    # {chat_id: forum_thread_id or None}
    subscribers: dict[str, str | None] = field(default_factory=dict)
    last_seen: str = ""
    last_update_id: int = 0

    def to_json(self) -> str:
        return json.dumps(
            {
                "version": STATE_VERSION,
                "last_seen": self.last_seen,
                "last_update_id": self.last_update_id,
                "subscribers": {k: self.subscribers[k] for k in sorted(self.subscribers)},
            },
            separators=(",", ":"),
            ensure_ascii=False,
        )

    @classmethod
    def from_json(cls, raw: str) -> "BotState":
        try:
            data = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise StateError(f"State is not valid JSON: {exc}") from exc
        if not isinstance(data, dict):
            raise StateError("State JSON must be an object")
        version = data.get("version")
        if version != STATE_VERSION:
            raise StateError(f"Unsupported state version: {version!r}")

        raw_subs = data.get("subscribers") or {}
        if not isinstance(raw_subs, dict):
            raise StateError("State 'subscribers' must be an object")
        subscribers = {
            str(chat_id): (str(thread) if thread not in (None, "") else None)
            for chat_id, thread in raw_subs.items()
            if str(chat_id).strip()
        }
        try:
            last_update_id = int(data.get("last_update_id") or 0)
        except (TypeError, ValueError) as exc:
            raise StateError("State 'last_update_id' must be an integer") from exc
        return cls(
            subscribers=subscribers,
            last_seen=str(data.get("last_seen") or ""),
            last_update_id=last_update_id,
        )

    def copy(self) -> "BotState":
        return BotState(dict(self.subscribers), self.last_seen, self.last_update_id)


# ---------------------------------------------------------------------------
# Backends
# ---------------------------------------------------------------------------


class StateStore(Protocol):
    def load(self) -> BotState | None:
        """Return the stored state, or None if nothing has been stored yet.

        Raises StateError if the store is unreachable or the data is corrupt —
        callers must never treat that as "empty", or they would overwrite the
        real subscriber list on the next save.
        """

    def save(self, state: BotState) -> None:
        """Persist state, creating it if needed. Raises StateError on failure."""

    def create(self, state: BotState) -> bool:
        """Store state only if nothing is stored yet.

        Returns False (and writes nothing) if state already exists, so a
        migration can never clobber live state.
        """


class FileStateStore:
    """JSON file on local disk — for development and tests only.

    On GitHub Actions the runner's disk is thrown away after every run, so
    this backend is useless there; that's what GitHubVariableStateStore is for.
    """

    def __init__(self, path: Path) -> None:
        self.path = Path(path)

    def load(self) -> BotState | None:
        if not self.path.exists():
            return None
        try:
            raw = self.path.read_text(encoding="utf-8")
        except OSError as exc:
            raise StateError(f"Cannot read {self.path}: {exc}") from exc
        return BotState.from_json(raw)

    def save(self, state: BotState) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(self.path.suffix + ".tmp")
        try:
            tmp.write_text(state.to_json() + "\n", encoding="utf-8")
            tmp.replace(self.path)  # atomic on POSIX: no half-written state
        except OSError as exc:
            raise StateError(f"Cannot write {self.path}: {exc}") from exc

    def create(self, state: BotState) -> bool:
        if self.path.exists():
            return False
        self.save(state)
        return True


# (method, url, headers, body) -> (status, response_body)
HttpRequest = Callable[[str, str, dict[str, str], bytes | None], tuple[int, bytes]]


def _urllib_request(
    method: str, url: str, headers: dict[str, str], body: bytes | None, timeout: float = 15
) -> tuple[int, bytes]:
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as exc:
        # Non-2xx is a normal answer here (404 = not created yet, 409 = exists).
        return exc.code, exc.read()


class GitHubVariableStateStore:
    """State as JSON in a GitHub Actions repository variable.

    Uses the REST API:
      GET    /repos/{repo}/actions/variables/{name}   read (404 = not created)
      PATCH  /repos/{repo}/actions/variables/{name}   update
      POST   /repos/{repo}/actions/variables          create (409 = exists)

    Needs a fine-grained personal access token limited to this repository
    with "Variables: Read and write". The built-in GITHUB_TOKEN can't write
    variables. Variables are visible only to repo collaborators, never to the
    public, even in a public repository.
    """

    # Retry transient failures (network errors, 5xx, secondary rate limits).
    RETRY_STATUSES = frozenset({429, 500, 502, 503, 504})

    def __init__(
        self,
        repo: str,
        token: str,
        name: str = DEFAULT_VARIABLE_NAME,
        api_url: str = DEFAULT_GITHUB_API,
        request: HttpRequest = _urllib_request,
        retries: int = 3,
        retry_delay: float = 2.0,
    ) -> None:
        if not repo or "/" not in repo:
            raise StateError(f"Invalid repository {repo!r}; expected 'owner/name'")
        if not token:
            raise StateError("STATE_TOKEN is not set — cannot reach GitHub variables")
        self.repo = repo
        self.name = name
        self.api_url = api_url.rstrip("/")
        self._token = token
        self._request = request
        self._retries = retries
        self._retry_delay = retry_delay

    @property
    def _collection_url(self) -> str:
        return f"{self.api_url}/repos/{self.repo}/actions/variables"

    @property
    def _item_url(self) -> str:
        return f"{self._collection_url}/{self.name}"

    def _call(self, method: str, url: str, payload: dict | None = None) -> tuple[int, bytes]:
        headers = {
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {self._token}",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "trump-telegram-bot-state",
        }
        body = None
        if payload is not None:
            body = json.dumps(payload).encode("utf-8")
            headers["Content-Type"] = "application/json"

        last_error = ""
        for attempt in range(1, self._retries + 1):
            try:
                status, data = self._request(method, url, headers, body)
            except (urllib.error.URLError, TimeoutError, OSError) as exc:
                last_error = f"{type(exc).__name__}: {exc}"
            else:
                if status not in self.RETRY_STATUSES:
                    return status, data
                last_error = f"HTTP {status}"
            if attempt < self._retries:
                log.warning(
                    "GitHub variables API %s failed (%s), retry %d/%d",
                    method, last_error, attempt, self._retries - 1,
                )
                time.sleep(self._retry_delay * attempt)
        raise StateError(f"GitHub variables API {method} {url} failed: {last_error}")

    def _check_size(self, value: str) -> None:
        size = len(value.encode("utf-8"))
        if size > GITHUB_VARIABLE_MAX_BYTES:
            raise StateError(
                f"State is {size} bytes, over GitHub's {GITHUB_VARIABLE_MAX_BYTES}-byte "
                "variable limit — move to a larger backend (see README)"
            )
        if size > GITHUB_VARIABLE_MAX_BYTES * 0.8:
            log.warning("State is %d bytes, nearing the %d-byte variable limit",
                        size, GITHUB_VARIABLE_MAX_BYTES)

    @staticmethod
    def _error(action: str, status: int, data: bytes) -> StateError:
        hint = ""
        if status in (401, 403):
            hint = " — check STATE_TOKEN is valid, unexpired, and has 'Variables: Read and write'"
        elif status == 404:
            hint = " — check the token has access to this repository"
        detail = data.decode("utf-8", "replace")[:200]
        return StateError(f"Failed to {action} state variable: HTTP {status}{hint}: {detail}")

    def load(self) -> BotState | None:
        status, data = self._call("GET", self._item_url)
        if status == 404:
            # 404 is also what a token without access to the repo gets. That's
            # indistinguishable here, so callers must only bootstrap via
            # create(), which fails loudly in that case instead of clobbering.
            return None
        if status != 200:
            raise self._error("read", status, data)
        try:
            value = json.loads(data)["value"]
        except (json.JSONDecodeError, KeyError, TypeError) as exc:
            raise StateError(f"Unexpected GitHub API response: {exc}") from exc
        return BotState.from_json(value)

    def save(self, state: BotState) -> None:
        value = state.to_json()
        self._check_size(value)
        status, data = self._call("PATCH", self._item_url, {"name": self.name, "value": value})
        if status == 204:
            return
        if status == 404:
            # Not created yet (e.g. a brand-new deployment): create it.
            if self.create(state):
                return
            raise StateError("State variable appeared concurrently; refusing to overwrite")
        raise self._error("write", status, data)

    def create(self, state: BotState) -> bool:
        value = state.to_json()
        self._check_size(value)
        status, data = self._call("POST", self._collection_url, {"name": self.name, "value": value})
        if status == 201:
            return True
        if status == 409:
            return False
        raise self._error("create", status, data)


# ---------------------------------------------------------------------------
# One-time migration from the legacy data/*.txt files
# ---------------------------------------------------------------------------

LEGACY_LAST_SEEN = "last_seen.txt"
LEGACY_LAST_UPDATE_ID = "last_update_id.txt"
LEGACY_SUBSCRIBERS = "subscribers.txt"


def read_legacy_files(data_dir: Path) -> BotState | None:
    """Parse the old git-committed state files. None if none of them exist."""
    data_dir = Path(data_dir)
    paths = [data_dir / n for n in (LEGACY_LAST_SEEN, LEGACY_LAST_UPDATE_ID, LEGACY_SUBSCRIBERS)]
    if not any(p.exists() for p in paths):
        return None
    last_seen_path, update_id_path, subscribers_path = paths

    state = BotState()
    if last_seen_path.exists():
        state.last_seen = last_seen_path.read_text(encoding="utf-8").strip()
    if update_id_path.exists():
        content = update_id_path.read_text(encoding="utf-8").strip()
        if content.isdigit():
            state.last_update_id = int(content)
    if subscribers_path.exists():
        # One subscriber per line: "chat_id" or "chat_id<TAB>thread_id".
        for line in subscribers_path.read_text(encoding="utf-8").splitlines():
            parts = line.strip().split("\t", 1)
            chat_id = parts[0].strip()
            thread_id = parts[1].strip() if len(parts) == 2 and parts[1].strip() else None
            if chat_id:
                state.subscribers[chat_id] = thread_id
    return state


def load_or_migrate(store: StateStore, legacy_dir: Path | None) -> BotState:
    """Load state; on the very first run, seed it from the legacy files.

    The migration goes through store.create(), which never overwrites, so it
    is safe to leave enabled: once the state exists it is a no-op, and if two
    runs race only one seed wins.
    """
    state = store.load()
    if state is not None:
        return state

    legacy = read_legacy_files(legacy_dir) if legacy_dir else None
    seed = legacy or BotState()
    if legacy:
        log.warning(
            "No stored state yet — migrating legacy files from %s "
            "(%d subscriber(s), last_seen=%s, last_update_id=%d)",
            legacy_dir, len(legacy.subscribers), legacy.last_seen or "-", legacy.last_update_id,
        )
    else:
        log.warning("No stored state and no legacy files — starting with empty state")

    if store.create(seed):
        return seed
    # Someone created it between our load() and create() — use theirs.
    state = store.load()
    if state is None:
        raise StateError("State exists according to create() but load() finds nothing")
    return state


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------


def store_from_env(default_file: Path) -> StateStore:
    """Pick a backend from the environment.

    STATE_BACKEND=github  (the workflow sets this) — needs STATE_TOKEN and
        GITHUB_REPOSITORY (set automatically on Actions); STATE_VARIABLE
        overrides the variable name (default BOT_STATE).
    STATE_BACKEND=file    (default) — STATE_FILE overrides the path.
    """
    backend = os.environ.get("STATE_BACKEND", "file").strip().lower()
    if backend == "github":
        return GitHubVariableStateStore(
            repo=os.environ.get("GITHUB_REPOSITORY", "").strip(),
            token=os.environ.get("STATE_TOKEN", "").strip(),
            name=os.environ.get("STATE_VARIABLE", DEFAULT_VARIABLE_NAME).strip() or DEFAULT_VARIABLE_NAME,
            api_url=os.environ.get("GITHUB_API_URL", DEFAULT_GITHUB_API).strip() or DEFAULT_GITHUB_API,
        )
    if backend == "file":
        return FileStateStore(Path(os.environ.get("STATE_FILE", "").strip() or default_file))
    raise StateError(f"Unknown STATE_BACKEND {backend!r}; expected 'github' or 'file'")
