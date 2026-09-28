"""Tests for how src/main.py uses the state store (no network)."""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

import main  # noqa: E402
from state import BotState, FileStateStore, StateError  # noqa: E402


def private_start(update_id: int, chat_id: int) -> dict:
    return {
        "update_id": update_id,
        "message": {"text": "/start", "chat": {"id": chat_id, "type": "private"}},
    }


def kicked(update_id: int, chat_id: int) -> dict:
    return {
        "update_id": update_id,
        "my_chat_member": {
            "chat": {"id": chat_id, "type": "group"},
            "new_chat_member": {"status": "kicked"},
        },
    }


class ProcessCommandsTests(unittest.TestCase):
    def test_updates_mutate_state_in_memory(self):
        state = BotState(subscribers={"-5": None}, last_update_id=10)
        updates = [private_start(11, 42), kicked(12, -5)]
        with mock.patch.object(main, "get_telegram_updates", return_value=updates) as get, \
                mock.patch.object(main, "send_welcome"):
            main.process_telegram_commands(state)
        get.assert_called_once_with(offset=11)
        self.assertEqual(state.subscribers, {"42": None})
        self.assertEqual(state.last_update_id, 12)

    def test_no_updates_leaves_state_untouched(self):
        state = BotState(subscribers={"1": None}, last_update_id=10)
        with mock.patch.object(main, "get_telegram_updates", return_value=[]):
            main.process_telegram_commands(state)
        self.assertEqual(state, BotState(subscribers={"1": None}, last_update_id=10))


class MainStateFlowTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.data = Path(self.tmp.name)
        self.store = FileStateStore(self.data / "state.json")
        patches = [
            mock.patch.object(main, "TELEGRAM_BOT_TOKEN", "t"),
            mock.patch.object(main, "TELEGRAM_CHAT_ID", ""),
            mock.patch.object(main, "DATA_DIR", self.data),
            mock.patch.object(main, "store_from_env", return_value=self.store),
            mock.patch.object(main, "clear_bot_menu"),
            mock.patch.object(main, "send_welcome"),
            mock.patch.object(main, "translate_to_hebrew", return_value=("שלום", True)),
            mock.patch.object(main.time, "sleep"),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        self.sent = mock.patch.object(main, "send_telegram_message", return_value=True).start()
        self.addCleanup(mock.patch.stopall)

    def tearDown(self):
        self.tmp.cleanup()

    def run_main(self, updates=(), posts=()):
        with mock.patch.object(main, "get_telegram_updates", return_value=list(updates)), \
                mock.patch.object(main, "fetch_posts", return_value=list(posts)):
            main.main()

    def test_load_failure_exits_before_touching_telegram(self):
        with mock.patch.object(main, "store_from_env", side_effect=StateError("down")), \
                mock.patch.object(main, "clear_bot_menu") as menu:
            with self.assertRaises(SystemExit) as ctx:
                main.main()
        self.assertEqual(ctx.exception.code, 1)
        menu.assert_not_called()

    def test_first_run_migrates_legacy_files(self):
        (self.data / "subscribers.txt").write_text("111\n")
        (self.data / "last_seen.txt").write_text("p1\n")
        self.run_main(posts=[{"id": "p1", "text": "old", "created_at": ""}])
        self.assertEqual(self.store.load(), BotState(subscribers={"111": None}, last_seen="p1"))
        self.sent.assert_not_called()  # p1 was already seen before migration

    def test_new_subscriber_and_new_post_are_persisted(self):
        self.store.save(BotState(subscribers={"111": None}, last_seen="p1", last_update_id=3))
        posts = [
            {"id": "p2", "text": "new", "created_at": "", "url": ""},
            {"id": "p1", "text": "old", "created_at": "", "url": ""},
        ]
        self.run_main(updates=[private_start(4, 222)], posts=posts)
        self.assertEqual(
            self.store.load(),
            BotState(subscribers={"111": None, "222": None}, last_seen="p2", last_update_id=4),
        )
        self.assertEqual({c.kwargs["chat_id"] for c in self.sent.call_args_list}, {"111", "222"})

    def test_idle_run_does_not_write(self):
        self.store.save(BotState(subscribers={"111": None}, last_seen="p1"))
        with mock.patch.object(self.store, "save") as save:
            self.run_main(posts=[{"id": "p1", "text": "old", "created_at": ""}])
        save.assert_not_called()

    def test_save_failure_exits_non_zero(self):
        self.store.save(BotState(subscribers={"111": None}, last_update_id=3))
        with mock.patch.object(self.store, "save", side_effect=StateError("403")):
            with self.assertRaises(SystemExit) as ctx:
                self.run_main(updates=[private_start(4, 222)])
        self.assertEqual(ctx.exception.code, 1)

    def test_owner_is_seeded(self):
        self.store.save(BotState())
        with mock.patch.object(main, "TELEGRAM_CHAT_ID", "999"):
            self.run_main()
        self.assertEqual(self.store.load().subscribers, {"999": None})


if __name__ == "__main__":
    unittest.main()
