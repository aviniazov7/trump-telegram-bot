"""Tests for the state storage layer (src/state.py).

Stdlib only: run with `python -m unittest discover -s tests` (pytest works too).
"""

from __future__ import annotations

import json
import sys
import tempfile
import threading
import unittest
import urllib.error
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

import state as st  # noqa: E402
from state import (  # noqa: E402
    BotState,
    FileStateStore,
    GitHubVariableStateStore,
    StateError,
    load_or_migrate,
    read_legacy_files,
    store_from_env,
)

REPO = "owner/bot"
API = "https://api.example.test"
ITEM_URL = f"{API}/repos/{REPO}/actions/variables/BOT_STATE"
COLLECTION_URL = f"{API}/repos/{REPO}/actions/variables"


def sample_state() -> BotState:
    return BotState(
        subscribers={"111": None, "-100222": "7"},
        last_seen="117348562110206457",
        last_update_id=870640108,
    )


class FakeGitHub:
    """In-memory stand-in for the GitHub Actions variables REST API."""

    def __init__(self) -> None:
        self.variables: dict[str, str] = {}
        self.calls: list[tuple[str, str, dict[str, str], bytes | None]] = []
        # Queue of (status, body) or exceptions returned before normal handling.
        self.injected: list[object] = []

    def __call__(self, method, url, headers, body):
        self.calls.append((method, url, headers, body))
        if self.injected:
            item = self.injected.pop(0)
            if isinstance(item, Exception):
                raise item
            return item
        payload = json.loads(body) if body else None
        if url.startswith(COLLECTION_URL + "/"):
            name = url.rsplit("/", 1)[1]
            if method == "GET":
                if name not in self.variables:
                    return 404, b'{"message":"Not Found"}'
                return 200, json.dumps({"name": name, "value": self.variables[name]}).encode()
            if method == "PATCH":
                if name not in self.variables:
                    return 404, b'{"message":"Not Found"}'
                self.variables[name] = payload["value"]
                return 204, b""
        if url == COLLECTION_URL and method == "POST":
            if payload["name"] in self.variables:
                return 409, b'{"message":"Already exists"}'
            self.variables[payload["name"]] = payload["value"]
            return 201, b"{}"
        return 400, b"unexpected request"


def github_store(fake: FakeGitHub, **kwargs) -> GitHubVariableStateStore:
    kwargs.setdefault("retry_delay", 0)
    return GitHubVariableStateStore(REPO, "tok", api_url=API, request=fake, **kwargs)


# ---------------------------------------------------------------------------
# BotState
# ---------------------------------------------------------------------------


class BotStateTests(unittest.TestCase):
    def test_json_round_trip(self):
        state = sample_state()
        self.assertEqual(BotState.from_json(state.to_json()), state)

    def test_json_is_versioned_and_sorted(self):
        data = json.loads(sample_state().to_json())
        self.assertEqual(data["version"], st.STATE_VERSION)
        self.assertEqual(list(data["subscribers"]), ["-100222", "111"])

    def test_rejects_invalid_json(self):
        with self.assertRaises(StateError):
            BotState.from_json("not json")

    def test_rejects_unknown_version(self):
        with self.assertRaises(StateError):
            BotState.from_json('{"version": 99, "subscribers": {}}')

    def test_rejects_non_object(self):
        with self.assertRaises(StateError):
            BotState.from_json("[1, 2]")

    def test_rejects_bad_types(self):
        with self.assertRaises(StateError):
            BotState.from_json('{"version": 1, "subscribers": ["111"]}')
        with self.assertRaises(StateError):
            BotState.from_json('{"version": 1, "last_update_id": "abc"}')

    def test_normalises_thread_ids(self):
        state = BotState.from_json(
            '{"version": 1, "subscribers": {"1": null, "2": "", "3": 5, " ": "x"}}'
        )
        self.assertEqual(state.subscribers, {"1": None, "2": None, "3": "5"})
        self.assertEqual(state.last_seen, "")
        self.assertEqual(state.last_update_id, 0)

    def test_copy_is_independent(self):
        state = sample_state()
        clone = state.copy()
        clone.subscribers["999"] = None
        self.assertNotIn("999", state.subscribers)


# ---------------------------------------------------------------------------
# FileStateStore
# ---------------------------------------------------------------------------


class FileStateStoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "nested" / "state.json"
        self.store = FileStateStore(self.path)

    def tearDown(self):
        self.tmp.cleanup()

    def test_load_missing_returns_none(self):
        self.assertIsNone(self.store.load())

    def test_save_then_load(self):
        self.store.save(sample_state())
        self.assertEqual(self.store.load(), sample_state())
        self.assertEqual(list(self.path.parent.iterdir()), [self.path])  # no .tmp left

    def test_create_never_overwrites(self):
        self.assertTrue(self.store.create(sample_state()))
        self.assertFalse(self.store.create(BotState()))
        self.assertEqual(self.store.load(), sample_state())

    def test_corrupt_file_raises(self):
        self.path.parent.mkdir(parents=True)
        self.path.write_text("{broken")
        with self.assertRaises(StateError):
            self.store.load()


# ---------------------------------------------------------------------------
# GitHubVariableStateStore
# ---------------------------------------------------------------------------


class GitHubVariableStateStoreTests(unittest.TestCase):
    def setUp(self):
        self.fake = FakeGitHub()
        self.store = github_store(self.fake)

    def test_requires_repo_and_token(self):
        with self.assertRaises(StateError):
            GitHubVariableStateStore("", "tok")
        with self.assertRaises(StateError):
            GitHubVariableStateStore("no-slash", "tok")
        with self.assertRaises(StateError):
            GitHubVariableStateStore(REPO, "")

    def test_load_missing_returns_none(self):
        self.assertIsNone(self.store.load())

    def test_create_then_load(self):
        self.assertTrue(self.store.create(sample_state()))
        self.assertEqual(self.store.load(), sample_state())

    def test_create_existing_returns_false_and_keeps_value(self):
        self.store.create(sample_state())
        self.assertFalse(self.store.create(BotState()))
        self.assertEqual(self.store.load(), sample_state())

    def test_save_updates_existing(self):
        self.store.create(BotState())
        self.store.save(sample_state())
        self.assertEqual(self.store.load(), sample_state())
        self.assertEqual([c[0] for c in self.fake.calls], ["POST", "PATCH", "GET"])

    def test_save_creates_when_missing(self):
        self.store.save(sample_state())
        self.assertEqual(self.store.load(), sample_state())
        self.assertEqual([c[0] for c in self.fake.calls[:2]], ["PATCH", "POST"])

    def test_sends_auth_and_api_version_headers(self):
        self.store.load()
        method, url, headers, _ = self.fake.calls[0]
        self.assertEqual((method, url), ("GET", ITEM_URL))
        self.assertEqual(headers["Authorization"], "Bearer tok")
        self.assertEqual(headers["X-GitHub-Api-Version"], "2022-11-28")

    def test_custom_variable_name(self):
        store = github_store(self.fake, name="OTHER")
        store.save(sample_state())
        self.assertIn("OTHER", self.fake.variables)

    def test_unauthorised_raises_with_hint(self):
        self.fake.injected.append((401, b'{"message":"Bad credentials"}'))
        with self.assertRaises(StateError) as ctx:
            self.store.load()
        self.assertIn("STATE_TOKEN", str(ctx.exception))

    def test_forbidden_write_raises(self):
        self.store.create(BotState())
        self.fake.injected.append((403, b'{"message":"Resource not accessible"}'))
        with self.assertRaises(StateError):
            self.store.save(sample_state())

    def test_no_repo_access_on_create_raises(self):
        # A token without access to the repo gets 404 everywhere: load says
        # "missing", but create must then fail loudly, not report success.
        self.fake.injected.extend([(404, b""), (404, b"")])
        with self.assertRaises(StateError):
            self.store.save(sample_state())

    def test_retries_transient_errors(self):
        self.store.create(sample_state())
        self.fake.injected.extend([(502, b""), urllib.error.URLError("reset")])
        self.assertEqual(self.store.load(), sample_state())

    def test_gives_up_after_retries(self):
        self.fake.injected.extend([(503, b"")] * 3)
        with self.assertRaises(StateError):
            self.store.load()
        self.assertEqual(len(self.fake.calls), 3)

    def test_malformed_response_raises(self):
        self.fake.injected.append((200, b'{"no_value": 1}'))
        with self.assertRaises(StateError):
            self.store.load()

    def test_refuses_state_over_size_limit(self):
        big = BotState(subscribers={str(i): None for i in range(10_000)})
        with self.assertRaises(StateError):
            self.store.save(big)
        self.assertEqual(self.fake.calls, [])  # nothing sent


class UrllibTransportTests(unittest.TestCase):
    """Exercise the real urllib transport against a local HTTP server."""

    @classmethod
    def setUpClass(cls):
        variables: dict[str, str] = {}

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def _reply(self, status, body=b""):
                self.send_response(status)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def _body(self):
                return json.loads(self.rfile.read(int(self.headers["Content-Length"])))

            def do_GET(self):
                name = self.path.rsplit("/", 1)[1]
                if name not in variables:
                    return self._reply(404, b'{"message":"Not Found"}')
                self._reply(200, json.dumps({"value": variables[name]}).encode())

            def do_PATCH(self):
                name = self.path.rsplit("/", 1)[1]
                if name not in variables:
                    return self._reply(404)
                variables[name] = self._body()["value"]
                self._reply(204)

            def do_POST(self):
                data = self._body()
                if data["name"] in variables:
                    return self._reply(409)
                variables[data["name"]] = data["value"]
                self._reply(201, b"{}")

        cls.server = HTTPServer(("127.0.0.1", 0), Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def test_round_trip_over_http(self):
        api = f"http://127.0.0.1:{self.server.server_port}"
        # Bypass any proxy configured in the environment for localhost.
        with mock.patch.dict("os.environ", {"NO_PROXY": "127.0.0.1", "no_proxy": "127.0.0.1"}):
            store = GitHubVariableStateStore(REPO, "tok", api_url=api, retry_delay=0)
            self.assertIsNone(store.load())            # HTTPError 404 path
            store.save(sample_state())                 # PATCH 404 -> POST 201
            self.assertFalse(store.create(BotState()))  # HTTPError 409 path
            self.assertEqual(store.load(), sample_state())


# ---------------------------------------------------------------------------
# Legacy migration
# ---------------------------------------------------------------------------


class LegacyMigrationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.data = Path(self.tmp.name)
        self.store = FileStateStore(self.data / "state.json")

    def tearDown(self):
        self.tmp.cleanup()

    def write_legacy(self):
        (self.data / "last_seen.txt").write_text("117348562110206457\n")
        (self.data / "last_update_id.txt").write_text("870640108\n")
        (self.data / "subscribers.txt").write_text("111\n-100222\t7\n\n  \n")

    def test_read_legacy_files(self):
        self.write_legacy()
        self.assertEqual(read_legacy_files(self.data), sample_state())

    def test_read_legacy_files_none_present(self):
        self.assertIsNone(read_legacy_files(self.data))

    def test_read_legacy_partial(self):
        (self.data / "last_update_id.txt").write_text("garbage\n")
        (self.data / "subscribers.txt").write_text("5\n")
        self.assertEqual(read_legacy_files(self.data), BotState(subscribers={"5": None}))

    def test_migrates_when_store_empty(self):
        self.write_legacy()
        self.assertEqual(load_or_migrate(self.store, self.data), sample_state())
        self.assertEqual(self.store.load(), sample_state())

    def test_existing_state_wins_over_legacy_files(self):
        self.write_legacy()
        live = BotState(subscribers={"999": None}, last_seen="new", last_update_id=5)
        self.store.save(live)
        self.assertEqual(load_or_migrate(self.store, self.data), live)
        self.assertEqual(self.store.load(), live)

    def test_empty_state_without_legacy_files(self):
        self.assertEqual(load_or_migrate(self.store, self.data), BotState())
        self.assertEqual(self.store.load(), BotState())

    def test_no_legacy_dir(self):
        self.assertEqual(load_or_migrate(self.store, None), BotState())

    def test_concurrent_create_uses_winner(self):
        self.write_legacy()
        winner = BotState(subscribers={"42": None})
        fake = FakeGitHub()
        store = github_store(fake)
        # load() sees nothing, then another run creates it before our create().
        original_create = store.create

        def racing_create(state):
            fake.variables["BOT_STATE"] = winner.to_json()
            return original_create(state)

        store.create = racing_create
        self.assertEqual(load_or_migrate(store, self.data), winner)
        self.assertEqual(store.load(), winner)

    def test_load_failure_is_not_treated_as_empty(self):
        self.write_legacy()
        fake = FakeGitHub()
        fake.variables["BOT_STATE"] = sample_state().to_json()
        fake.injected.append((500, b""))
        store = github_store(fake, retries=1)
        with self.assertRaises(StateError):
            load_or_migrate(store, self.data)
        self.assertEqual(fake.variables["BOT_STATE"], sample_state().to_json())

    def test_migration_through_github_backend(self):
        self.write_legacy()
        fake = FakeGitHub()
        store = github_store(fake)
        self.assertEqual(load_or_migrate(store, self.data), sample_state())
        self.assertEqual(BotState.from_json(fake.variables["BOT_STATE"]), sample_state())
        # Second run: plain load, no further writes.
        fake.calls.clear()
        self.assertEqual(load_or_migrate(store, self.data), sample_state())
        self.assertEqual([c[0] for c in fake.calls], ["GET"])


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------


class StoreFromEnvTests(unittest.TestCase):
    def test_defaults_to_file(self):
        with mock.patch.dict("os.environ", {}, clear=True):
            store = store_from_env(Path("/tmp/x.json"))
        self.assertIsInstance(store, FileStateStore)
        self.assertEqual(store.path, Path("/tmp/x.json"))

    def test_file_path_override(self):
        with mock.patch.dict("os.environ", {"STATE_FILE": "/tmp/y.json"}, clear=True):
            self.assertEqual(store_from_env(Path("/tmp/x.json")).path, Path("/tmp/y.json"))

    def test_github_backend(self):
        env = {
            "STATE_BACKEND": "github",
            "STATE_TOKEN": "tok",
            "GITHUB_REPOSITORY": REPO,
            "STATE_VARIABLE": "CUSTOM",
        }
        with mock.patch.dict("os.environ", env, clear=True):
            store = store_from_env(Path("/tmp/x.json"))
        self.assertIsInstance(store, GitHubVariableStateStore)
        self.assertEqual((store.repo, store.name, store.api_url), (REPO, "CUSTOM", st.DEFAULT_GITHUB_API))

    def test_github_backend_without_token_fails(self):
        env = {"STATE_BACKEND": "github", "GITHUB_REPOSITORY": REPO}
        with mock.patch.dict("os.environ", env, clear=True):
            with self.assertRaises(StateError):
                store_from_env(Path("/tmp/x.json"))

    def test_unknown_backend_fails(self):
        with mock.patch.dict("os.environ", {"STATE_BACKEND": "redis"}, clear=True):
            with self.assertRaises(StateError):
                store_from_env(Path("/tmp/x.json"))


if __name__ == "__main__":
    unittest.main()
