"""Tests for fetching posts, picking the new ones and broadcasting them."""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

import main  # noqa: E402
from state import BotState, FileStateStore  # noqa: E402


def post(post_id: str, text: str = "Hello there friends") -> dict:
    return {"id": post_id, "text": text, "created_at": "", "url": ""}


def feed(*ids: str) -> list[dict]:
    return [post(i) for i in ids]


class FilterNewPostsTests(unittest.TestCase):
    def ids(self, posts):
        return [p["id"] for p in posts]

    def test_returns_posts_newer_than_last_seen_oldest_first(self):
        self.assertEqual(self.ids(main.filter_new_posts(feed("5", "4", "3", "2"), "3")), ["4", "5"])

    def test_nothing_new(self):
        self.assertEqual(main.filter_new_posts(feed("5", "4"), "5"), [])

    def test_first_run_takes_only_latest(self):
        self.assertEqual(self.ids(main.filter_new_posts(feed("5", "4"), "")), ["5"])

    def test_last_seen_outside_window_takes_only_latest(self):
        self.assertEqual(self.ids(main.filter_new_posts(feed("9", "8"), "1")), ["9"])

    def test_more_than_ten_new_posts_are_all_kept(self):
        # The old FETCH_LIMIT of 10 silently dropped the rest of a backlog.
        posts = feed(*[str(i) for i in range(40, 0, -1)])
        self.assertEqual(self.ids(main.filter_new_posts(posts, "15")), [str(i) for i in range(16, 41)])

    def test_empty_feed(self):
        self.assertEqual(main.filter_new_posts([], "1"), [])


RSS_ITEM = """<item>
  <title><![CDATA[{text}]]></title>
  <link>https://www.trumpstruth.org/statuses/{n}</link>
  <description><![CDATA[<p>{text}</p>]]></description>
  <pubDate>Sat, 10 Oct 2026 18:59:16 +0000</pubDate>
  <truth:originalId>{id}</truth:originalId>
  <truth:originalUrl>https://truthsocial.com/@realDonaldTrump/{id}</truth:originalUrl>
</item>"""


def rss(ids: list[str]) -> bytes:
    items = "".join(RSS_ITEM.format(id=i, n=n, text=f"Post number {i}") for n, i in enumerate(ids))
    return f"<rss><channel>{items}</channel></rss>".encode()


class FetchPostsTests(unittest.TestCase):
    def test_rss_parsing_reads_beyond_ten_items(self):
        ids = [str(1000 - i) for i in range(30)]
        with mock.patch.object(main, "http_get", return_value=rss(ids)):
            posts = main.fetch_posts_trumpstruth()
        self.assertEqual([p["id"] for p in posts], ids)
        self.assertEqual(posts[0]["url"], "https://truthsocial.com/@realDonaldTrump/1000")

    def test_rss_respects_limit(self):
        with mock.patch.object(main, "http_get", return_value=rss(["3", "2", "1"])):
            self.assertEqual(len(main.fetch_posts_trumpstruth(limit=2)), 2)

    def test_sorts_newest_first_by_numeric_id(self):
        with mock.patch.object(main, "fetch_posts_trumpstruth", return_value=feed("2", "10", "3")):
            self.assertEqual([p["id"] for p in main.fetch_posts()], ["10", "3", "2"])

    def test_uses_rss_when_it_contains_last_seen(self):
        with mock.patch.object(main, "fetch_posts_trumpstruth", return_value=feed("3", "2")), \
                mock.patch.object(main, "fetch_posts_cnn_archive") as cnn:
            self.assertEqual(len(main.fetch_posts("2")), 2)
        cnn.assert_not_called()

    def test_falls_back_to_archive_when_rss_window_misses_last_seen(self):
        with mock.patch.object(main, "fetch_posts_trumpstruth", return_value=feed("9", "8")), \
                mock.patch.object(main, "fetch_posts_cnn_archive", return_value=feed("9", "8", "7", "6")):
            self.assertEqual([p["id"] for p in main.fetch_posts("6")], ["9", "8", "7", "6"])

    def test_keeps_rss_when_archive_does_not_help(self):
        with mock.patch.object(main, "fetch_posts_trumpstruth", return_value=feed("9", "8")), \
                mock.patch.object(main, "fetch_posts_cnn_archive", side_effect=RuntimeError("down")):
            self.assertEqual([p["id"] for p in main.fetch_posts("1")], ["9", "8"])

    def test_archive_when_rss_fails(self):
        with mock.patch.object(main, "fetch_posts_trumpstruth", side_effect=RuntimeError("down")), \
                mock.patch.object(main, "fetch_posts_cnn_archive", return_value=feed("4")):
            self.assertEqual([p["id"] for p in main.fetch_posts("1")], ["4"])

    def test_all_sources_fail(self):
        with mock.patch.object(main, "fetch_posts_trumpstruth", side_effect=RuntimeError("x")), \
                mock.patch.object(main, "fetch_posts_cnn_archive", side_effect=RuntimeError("y")):
            self.assertEqual(main.fetch_posts("1"), [])


class BroadcastTests(unittest.TestCase):
    """main.main() with a real FileStateStore; network calls mocked."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.data = Path(tmp.name)
        self.store = FileStateStore(self.data / "state.json")
        for p in (
            mock.patch.object(main, "TELEGRAM_BOT_TOKEN", "t"),
            mock.patch.object(main, "TELEGRAM_CHAT_ID", ""),
            mock.patch.object(main, "DATA_DIR", self.data),
            mock.patch.object(main, "store_from_env", return_value=self.store),
            mock.patch.object(main, "clear_bot_menu"),
            mock.patch.object(main, "get_telegram_updates", return_value=[]),
            mock.patch.object(main, "translate_to_hebrew", return_value=("שלום", True)),
            mock.patch.object(main.time, "sleep"),
        ):
            p.start()
            self.addCleanup(p.stop)
        self.sends: list[tuple[str, str]] = []  # (chat_id, post marker)

    def fake_send(self, fail_chats=(), crash_on=None):
        def send(message, chat_id=None, thread_id=None, **_):
            if crash_on and crash_on in message and chat_id == "b":
                raise KeyboardInterrupt("runner killed")
            if chat_id in fail_chats:
                return False
            marker = next(w for w in message.split() if w.startswith("number-"))
            self.sends.append((chat_id, marker))
            return True
        return send

    def run_main(self, posts, **send_kwargs):
        with mock.patch.object(main, "fetch_posts", return_value=posts), \
                mock.patch.object(main, "send_telegram_message", side_effect=self.fake_send(**send_kwargs)):
            main.main()

    @staticmethod
    def posts(*ids):
        return [post(i, f"Post number-{i}") for i in ids]

    def test_backlog_sent_oldest_first_and_saved(self):
        self.store.save(BotState(subscribers={"a": None}, last_seen="1"))
        self.run_main(self.posts("4", "3", "2", "1"))
        self.assertEqual(self.sends, [("a", "number-2"), ("a", "number-3"), ("a", "number-4")])
        self.assertEqual(self.store.load().last_seen, "4")

    def test_state_saved_after_each_post(self):
        self.store.save(BotState(subscribers={"a": None, "b": None}, last_seen="1"))
        # The runner dies while sending post 3 to chat b.
        with self.assertRaises(KeyboardInterrupt):
            self.run_main(self.posts("3", "2", "1"), crash_on="number-3")
        saved = self.store.load()
        self.assertEqual(saved.last_seen, "2")
        self.assertEqual((saved.in_flight_post, saved.in_flight_chats), ("3", ["a"]))

        # Next run: post 2 is not re-sent, and post 3 goes only to chat b.
        self.sends.clear()
        self.run_main(self.posts("3", "2", "1"))
        self.assertEqual(self.sends, [("b", "number-3")])
        saved = self.store.load()
        self.assertEqual((saved.last_seen, saved.in_flight_post, saved.in_flight_chats), ("3", "", []))

    def test_budget_stop_mid_broadcast_resumes_next_run(self):
        self.store.save(BotState(subscribers={"a": None, "b": None}, last_seen="1"))
        # Budget checks: before post 2, before chat a, then exceeded before chat b.
        with mock.patch.object(main, "_budget_exceeded", side_effect=[False, False, False, True]):
            self.run_main(self.posts("2", "1"))
        self.assertEqual(self.sends, [("a", "number-2")])
        saved = self.store.load()
        self.assertEqual((saved.last_seen, saved.in_flight_post, saved.in_flight_chats), ("1", "2", ["a"]))

        self.sends.clear()
        self.run_main(self.posts("2", "1"))
        self.assertEqual(self.sends, [("b", "number-2")])
        self.assertEqual(self.store.load().last_seen, "2")

    def test_nobody_reachable_keeps_post_for_next_run(self):
        self.store.save(BotState(subscribers={"a": None}, last_seen="1"))
        self.run_main(self.posts("2", "1"), fail_chats=("a",))
        self.assertEqual(self.store.load().last_seen, "1")

    def test_one_failed_chat_does_not_block_the_rest(self):
        self.store.save(BotState(subscribers={"a": None, "b": None}, last_seen="1"))
        self.run_main(self.posts("2", "1"), fail_chats=("a",))
        self.assertEqual(self.sends, [("b", "number-2")])
        self.assertEqual(self.store.load().last_seen, "2")


if __name__ == "__main__":
    unittest.main()
