"""Tests for the Telegram API layer: retries, rate limits, unreachable chats."""

from __future__ import annotations

import io
import json
import socket
import sys
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

import main  # noqa: E402
from state import BotState  # noqa: E402


class FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def ok(result=None):
    return FakeResponse(json.dumps({"ok": True, "result": result or {}}).encode())


def http_error(code: int, description: str, **parameters) -> urllib.error.HTTPError:
    body = {"ok": False, "error_code": code, "description": description}
    if parameters:
        body["parameters"] = parameters
    return urllib.error.HTTPError("https://api.telegram.org/x", code, description, {},
                                  io.BytesIO(json.dumps(body).encode()))


class TelegramTestCase(unittest.TestCase):
    def setUp(self):
        for p in (
            mock.patch.object(main, "TELEGRAM_BOT_TOKEN", "t"),
            mock.patch.object(main, "TELEGRAM_CHAT_ID", "owner"),
            mock.patch.object(main.time, "sleep"),
        ):
            p.start()
            self.addCleanup(p.stop)
        self.sleep = main.time.sleep

    def urlopen(self, *responses):
        """Patch urlopen to return/raise the given items in order."""
        patcher = mock.patch.object(main.urllib.request, "urlopen", side_effect=list(responses))
        self.addCleanup(patcher.stop)
        return patcher.start()


class TelegramCallTests(TelegramTestCase):
    def test_success(self):
        self.urlopen(ok({"message_id": 1}))
        resp = main.telegram_call("sendMessage", {})
        self.assertTrue(resp.ok)
        self.assertEqual(resp.result, {"message_id": 1})

    def test_timeout_is_not_retried_for_send(self):
        # The request may have reached Telegram: retrying could double-send.
        opener = self.urlopen(TimeoutError("timed out"), ok())
        resp = main.telegram_call("sendMessage", {})
        self.assertFalse(resp.ok)
        self.assertTrue(resp.uncertain)
        self.assertEqual(opener.call_count, 1)

    def test_url_error_timeout_is_not_retried_for_send(self):
        opener = self.urlopen(urllib.error.URLError(TimeoutError("timed out")), ok())
        self.assertFalse(main.telegram_call("sendMessage", {}).ok)
        self.assertEqual(opener.call_count, 1)

    def test_5xx_is_not_retried_for_send(self):
        opener = self.urlopen(http_error(502, "Bad Gateway"), ok())
        self.assertFalse(main.telegram_call("sendMessage", {}).ok)
        self.assertEqual(opener.call_count, 1)

    def test_connection_refused_is_retried(self):
        # Nothing was sent, so a retry can't duplicate anything.
        opener = self.urlopen(urllib.error.URLError(ConnectionRefusedError()), ok())
        self.assertTrue(main.telegram_call("sendMessage", {}).ok)
        self.assertEqual(opener.call_count, 2)

    def test_dns_failure_is_retried(self):
        opener = self.urlopen(urllib.error.URLError(socket.gaierror("no dns")), ok())
        self.assertTrue(main.telegram_call("sendMessage", {}).ok)
        self.assertEqual(opener.call_count, 2)

    def test_idempotent_call_retries_timeouts(self):
        opener = self.urlopen(TimeoutError(), http_error(500, "oops"), ok())
        self.assertTrue(main.telegram_call("setMyCommands", {}, idempotent=True).ok)
        self.assertEqual(opener.call_count, 3)

    def test_429_waits_retry_after_then_retries(self):
        opener = self.urlopen(http_error(429, "Too Many Requests: retry after 7", retry_after=7), ok())
        self.assertTrue(main.telegram_call("sendMessage", {}).ok)
        self.assertEqual(opener.call_count, 2)
        self.sleep.assert_called_once_with(7)

    def test_429_with_long_wait_gives_up(self):
        opener = self.urlopen(http_error(429, "Too Many Requests", retry_after=600))
        resp = main.telegram_call("sendMessage", {})
        self.assertEqual((resp.ok, resp.error_code, resp.retry_after), (False, 429, 600))
        self.assertEqual(opener.call_count, 1)
        self.sleep.assert_not_called()

    def test_429_does_not_wait_past_the_run_budget(self):
        self.urlopen(http_error(429, "Too Many Requests", retry_after=20))
        with mock.patch.object(main, "_seconds_left", return_value=5):
            self.assertFalse(main.telegram_call("sendMessage", {}).ok)
        self.sleep.assert_not_called()

    def test_403_is_final_and_marks_chat_gone(self):
        opener = self.urlopen(http_error(403, "Forbidden: bot was blocked by the user"))
        resp = main.telegram_call("sendMessage", {})
        self.assertTrue(resp.chat_gone)
        self.assertEqual(opener.call_count, 1)

    def test_chat_not_found_marks_chat_gone(self):
        self.urlopen(http_error(400, "Bad Request: chat not found"))
        self.assertTrue(main.telegram_call("sendMessage", {}).chat_gone)

    def test_other_400_is_not_gone(self):
        self.urlopen(http_error(400, "Bad Request: can't parse entities"))
        self.assertFalse(main.telegram_call("sendMessage", {}).chat_gone)

    def test_error_logs_do_not_leak_chat_ids(self):
        self.urlopen(http_error(400, "Bad Request: group chat was upgraded",
                                migrate_to_chat_id=-1001234567890))
        with self.assertLogs(main.log, level="DEBUG") as logs:
            resp = main.telegram_call("sendMessage", {"chat_id": "5551234567"})
        self.assertEqual(resp.migrate_to, "-1001234567890")
        output = "\n".join(logs.output)
        self.assertNotIn("1234567890", output)
        self.assertNotIn("5551234567", output)


class SendMessageTests(TelegramTestCase):
    def test_sent(self):
        self.urlopen(ok())
        self.assertTrue(main.send_telegram_message("hi", chat_id="1"))

    def test_blocked_chat_reported_gone(self):
        self.urlopen(http_error(403, "Forbidden: bot was blocked by the user"))
        result = main.send_telegram_message("hi", chat_id="1")
        self.assertFalse(result)
        self.assertTrue(result.gone)

    def test_migrated_group_is_resent_to_new_id(self):
        opener = self.urlopen(http_error(400, "Bad Request: group chat was upgraded to a supergroup chat",
                                         migrate_to_chat_id=-100777), ok())
        result = main.send_telegram_message("hi", chat_id="-5")
        self.assertTrue(result)
        self.assertEqual(result.migrated_to, "-100777")
        resent = json.loads(opener.call_args_list[1].args[0].data)
        self.assertEqual(resent["chat_id"], "-100777")

    def test_long_message_stops_at_failed_chunk(self):
        opener = self.urlopen(ok(), TimeoutError())
        result = main.send_telegram_message("a\n" * 5000, chat_id="1")
        self.assertFalse(result)
        self.assertEqual(opener.call_count, 2)


class BroadcastUnsubscribeTests(TelegramTestCase):
    post = {"id": "p1", "text": "x", "created_at": "", "url": ""}

    def broadcast(self, state, results):
        with mock.patch.object(main, "send_telegram_message", side_effect=results):
            return main.broadcast_post(state, self.post, "msg")

    def test_blocked_subscriber_is_removed(self):
        state = BotState(subscribers={"a": None, "b": None})
        done = self.broadcast(state, [main.SendResult(False, gone=True), main.SendResult(True)])
        self.assertTrue(done)
        self.assertEqual(state.subscribers, {"b": None})

    def test_transient_failure_keeps_subscriber(self):
        state = BotState(subscribers={"a": None, "b": None})
        self.broadcast(state, [main.SendResult(False), main.SendResult(True)])
        self.assertEqual(set(state.subscribers), {"a", "b"})

    def test_owner_is_never_removed(self):
        state = BotState(subscribers={"owner": None, "z": None})  # sends to owner, then z
        self.broadcast(state, [main.SendResult(True), main.SendResult(False, gone=True)])
        self.assertEqual(set(state.subscribers), {"owner"})
        state = BotState(subscribers={"owner": None})
        self.broadcast(state, [main.SendResult(False, gone=True)])
        self.assertEqual(set(state.subscribers), {"owner"})

    def test_migrated_group_keeps_its_topic_under_new_id(self):
        state = BotState(subscribers={"-5": "12"})
        self.broadcast(state, [main.SendResult(True, migrated_to="-100777")])
        self.assertEqual(state.subscribers, {"-100777": "12"})
        self.assertEqual(state.in_flight_chats, ["-100777"])


if __name__ == "__main__":
    unittest.main()
