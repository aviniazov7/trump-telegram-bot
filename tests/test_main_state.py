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

    def test_group_trumphere_in_topic_pins_thread(self):
        state = BotState()
        update = {"update_id": 5, "message": {
            "text": "/trumphere@TrumpBot", "is_topic_message": True, "message_thread_id": 77,
            "chat": {"id": -100555, "type": "supergroup"}}}
        with mock.patch.object(main, "get_telegram_updates", return_value=[update]), \
                mock.patch.object(main, "send_telegram_message") as send:
            main.process_telegram_commands(state)
        self.assertEqual(state.subscribers, {"-100555": "77"})
        self.assertEqual(send.call_args.kwargs["thread_id"], "77")
        self.assertIn("בנושא הזה", send.call_args.args[0])

    def test_reply_thread_is_not_a_topic(self):
        state = BotState()
        update = {"update_id": 5, "message": {
            "text": "/start", "message_thread_id": 9, "chat": {"id": -5, "type": "group"}}}
        with mock.patch.object(main, "get_telegram_updates", return_value=[update]), \
                mock.patch.object(main, "send_telegram_message"):
            main.process_telegram_commands(state)
        self.assertEqual(state.subscribers, {"-5": None})

    def test_other_messages_are_ignored(self):
        state = BotState()
        updates = [
            {"update_id": 1, "message": {"text": "hello", "chat": {"id": 1, "type": "private"}}},
            {"update_id": 2, "message": {"chat": {"id": 1, "type": "private"}}},
            {"update_id": 3, "message": {"text": "/stats", "chat": {"id": 1, "type": "private"}}},
        ]
        with mock.patch.object(main, "get_telegram_updates", return_value=updates), \
                mock.patch.object(main, "send_telegram_message") as send:
            main.process_telegram_commands(state)
        self.assertEqual((state.subscribers, state.last_update_id), ({}, 3))
        send.assert_not_called()

    def test_added_to_channel_subscribes_and_welcomes_private(self):
        state = BotState()
        added = {"update_id": 8, "my_chat_member": {
            "chat": {"id": 42, "type": "private"}, "new_chat_member": {"status": "member"}}}
        with mock.patch.object(main, "get_telegram_updates", return_value=[added]), \
                mock.patch.object(main, "send_telegram_message") as send:
            main.process_telegram_commands(state)
        self.assertEqual(state.subscribers, {"42": None})
        self.assertEqual(send.call_args.kwargs["reply_markup"], main.REMOVE_KEYBOARD)

    def test_no_updates_leaves_state_untouched(self):
        state = BotState(subscribers={"1": None}, last_update_id=10)
        with mock.patch.object(main, "get_telegram_updates", return_value=[]):
            main.process_telegram_commands(state)
        self.assertEqual(state, BotState(subscribers={"1": None}, last_update_id=10))


class MainTestCase(unittest.TestCase):
    """Runs main.main() against a FileStateStore with Telegram and feeds mocked."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.data = Path(self.tmp.name)
        self.store = FileStateStore(self.data / "state.json")
        patches = [
            mock.patch.object(main, "TELEGRAM_BOT_TOKEN", "t"),
            mock.patch.object(main, "TELEGRAM_CHAT_ID", ""),
            mock.patch.object(main, "DATA_DIR", self.data),
            mock.patch.object(main, "GEMINI_API_KEY", ""),
            mock.patch.object(main, "store_from_env", return_value=self.store),
            mock.patch.object(main, "clear_bot_menu"),
            mock.patch.object(main, "send_welcome"),
            mock.patch.object(main, "translate_to_hebrew", return_value=("שלום", True)),
            mock.patch.object(main.time, "sleep"),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        self.send_patch = mock.patch.object(main, "send_telegram_message", return_value=main.SendResult(True))
        self.sent = self.send_patch.start()
        self.addCleanup(mock.patch.stopall)

    def tearDown(self):
        self.tmp.cleanup()

    def run_main(self, updates=(), posts=()):
        with mock.patch.object(main, "get_telegram_updates", return_value=list(updates)), \
                mock.patch.object(main, "fetch_posts", return_value=list(posts)):
            main.main()


class MainStateFlowTests(MainTestCase):
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
        self.assertEqual(self.store.load(), BotState(subscribers={"111": None}, last_seen="p1",
                                                     menu_config=main.menu_fingerprint()))
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
            BotState(subscribers={"111": None, "222": None}, last_seen="p2", last_update_id=4,
                     menu_config=main.menu_fingerprint()),
        )
        self.assertEqual({c.kwargs["chat_id"] for c in self.sent.call_args_list}, {"111", "222"})

    def test_idle_run_does_not_write(self):
        self.store.save(BotState(subscribers={"111": None}, last_seen="p1",
                                 menu_config=main.menu_fingerprint()))
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


class BotMenuTests(MainTestCase):
    def test_menu_applied_once_then_skipped(self):
        self.store.save(BotState(subscribers={"111": None}, last_seen="p1"))
        self.run_main()
        main.clear_bot_menu.assert_called_once()
        self.assertEqual(self.store.load().menu_config, main.menu_fingerprint())

        main.clear_bot_menu.reset_mock()
        self.run_main()
        main.clear_bot_menu.assert_not_called()

    def test_failed_menu_reset_is_retried_next_run(self):
        self.store.save(BotState(subscribers={"111": None}))
        main.clear_bot_menu.return_value = False
        self.run_main()
        self.assertEqual(self.store.load().menu_config, "")

    def test_menu_reapplied_when_config_changes(self):
        self.store.save(BotState(menu_config=main.menu_fingerprint()))
        changed = {"setMyCommands": {"commands": [{"command": "x", "description": "y"}]}}
        with mock.patch.object(main, "BOT_MENU_CONFIG", changed):
            self.run_main()
        main.clear_bot_menu.assert_called_once()

    def test_menu_reapplied_for_a_new_bot_token(self):
        self.store.save(BotState(menu_config=main.menu_fingerprint()))
        with mock.patch.object(main, "TELEGRAM_BOT_TOKEN", "another-bot"):
            self.run_main()
        main.clear_bot_menu.assert_called_once()


class ClearBotMenuTests(unittest.TestCase):
    def test_reports_partial_failure(self):
        responses = [main.TelegramResponse(ok=True), main.TelegramResponse(ok=False)]
        with mock.patch.object(main, "telegram_call", side_effect=responses) as call:
            self.assertFalse(main.clear_bot_menu())
        self.assertEqual([c.args[0] for c in call.call_args_list], ["setMyCommands", "setChatMenuButton"])


class LogRedactionTests(MainTestCase):
    """Actions logs are public: raw chat IDs must never be logged."""

    def test_redact_chat_is_stable_and_hides_id(self):
        self.assertEqual(main.redact_chat("123456789"), main.redact_chat("123456789"))
        self.assertNotIn("123456789", main.redact_chat("123456789"))
        self.assertNotEqual(main.redact_chat("1"), main.redact_chat("2"))
        self.assertEqual(main.redact_chat(""), "chat#-")

    def test_full_run_logs_no_chat_ids(self):
        self.send_patch.stop()  # use the real sender, with a fake HTTP layer
        self.store.save(BotState(subscribers={"-1009876543210": "7", "5551234567": None}, last_seen="p1"))
        posts = [
            {"id": "p2", "text": "new", "created_at": "", "url": ""},
            {"id": "p1", "text": "old", "created_at": "", "url": ""},
        ]
        updates = [private_start(1, 4441234567), kicked(2, -1009876543210)]
        with mock.patch.object(main, "_telegram_request", return_value=main.TelegramResponse(ok=True)), \
                self.assertLogs(main.log, level="DEBUG") as logs:
            self.run_main(updates=updates, posts=posts)
        output = "\n".join(logs.output)
        self.assertIn("Telegram message sent successfully", output)
        for chat_id in ("9876543210", "5551234567", "4441234567"):
            self.assertNotIn(chat_id, output)


if __name__ == "__main__":
    unittest.main()
