"""Tests for admin alerts, the run heartbeat and the healthcheck ping."""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

import main  # noqa: E402
from state import BotState, FileStateStore  # noqa: E402

NOW = 1_800_000_000
HOUR = 3600


class MonitoringTestCase(unittest.TestCase):
    def setUp(self):
        self.send = mock.MagicMock(return_value=main.SendResult(True))
        for p in (
            mock.patch.object(main, "ADMIN_CHAT_ID", "admin"),
            mock.patch.object(main, "HEALTHCHECK_URL", ""),
            mock.patch.object(main, "send_telegram_message", self.send),
            mock.patch.object(main.time, "time", return_value=NOW),
            mock.patch.object(main.time, "sleep"),
        ):
            p.start()
            self.addCleanup(p.stop)

    def alert_texts(self):
        return [c.args[0] for c in self.send.call_args_list if c.kwargs.get("chat_id") == "admin"]


class AlertAdminTests(MonitoringTestCase):
    def test_sends_to_admin_and_records_time(self):
        state = BotState()
        self.assertTrue(main.alert_admin(state, "x", "boom"))
        self.send.assert_called_once()
        self.assertEqual(self.send.call_args.kwargs["chat_id"], "admin")
        self.assertIn("boom", self.send.call_args.args[0])
        self.assertEqual(state.alerts, {"x": NOW})

    def test_same_kind_not_repeated_within_the_hour(self):
        state = BotState(alerts={"x": NOW - 10 * 60})
        self.assertFalse(main.alert_admin(state, "x", "boom"))
        self.send.assert_not_called()
        self.assertTrue(main.alert_admin(state, "y", "other kind"))

    def test_repeated_after_the_hour(self):
        state = BotState(alerts={"x": NOW - HOUR - 1})
        self.assertTrue(main.alert_admin(state, "x", "boom"))

    def test_no_admin_configured(self):
        with mock.patch.object(main, "ADMIN_CHAT_ID", ""):
            self.assertFalse(main.alert_admin(BotState(), "x", "boom"))
        self.send.assert_not_called()

    def test_failed_send_is_retried_next_time(self):
        self.send.return_value = main.SendResult(False)
        state = BotState()
        self.assertFalse(main.alert_admin(state, "x", "boom"))
        self.assertEqual(state.alerts, {})


class HeartbeatTests(MonitoringTestCase):
    def test_no_alert_before_the_first_success(self):
        main.check_heartbeat(BotState())
        self.send.assert_not_called()

    def test_no_alert_when_recent(self):
        main.check_heartbeat(BotState(last_success=NOW - 59 * 60))
        self.send.assert_not_called()

    def test_alert_when_stale(self):
        state = BotState(last_success=NOW - (3 * HOUR + 25 * 60))
        main.check_heartbeat(state)
        (text,) = self.alert_texts()
        self.assertIn("3 שע׳ 25 דק׳", text)
        self.assertIn("stale", state.alerts)

    def test_threshold_is_configurable(self):
        with mock.patch.object(main, "STALE_ALERT_MINUTES", 240):
            main.check_heartbeat(BotState(last_success=NOW - 3 * HOUR))
        self.send.assert_not_called()

    def test_record_success_refreshes_heartbeat_at_most_every_5_minutes(self):
        state = BotState(last_success=NOW - 60)
        main.record_success(state)
        self.assertEqual(state.last_success, NOW - 60)
        state.last_success = NOW - 5 * 60
        main.record_success(state)
        self.assertEqual(state.last_success, NOW)

    def test_healthcheck_ping(self):
        with mock.patch.object(main, "HEALTHCHECK_URL", "https://hc-ping.com/uuid"), \
                mock.patch.object(main, "http_get") as get:
            main.record_success(BotState())
        get.assert_called_once_with("https://hc-ping.com/uuid", retries=2)

    def test_healthcheck_failure_is_not_fatal(self):
        with mock.patch.object(main, "HEALTHCHECK_URL", "https://hc-ping.com/uuid"), \
                mock.patch.object(main, "http_get", side_effect=RuntimeError("down")):
            main.record_success(BotState())


class MainMonitoringTests(MonitoringTestCase):
    """Alerts raised from a full main.main() run."""

    def setUp(self):
        super().setUp()
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.store = FileStateStore(Path(tmp.name) / "state.json")
        for p in (
            mock.patch.object(main, "TELEGRAM_BOT_TOKEN", "t"),
            mock.patch.object(main, "TELEGRAM_CHAT_ID", ""),
            mock.patch.object(main, "DATA_DIR", Path(tmp.name)),
            mock.patch.object(main, "store_from_env", return_value=self.store),
            mock.patch.object(main, "clear_bot_menu", return_value=True),
            mock.patch.object(main, "get_telegram_updates", return_value=[]),
        ):
            p.start()
            self.addCleanup(p.stop)

    def run_main(self, posts, analysis=None):
        analysis = analysis or main.PostAnalysis("שלום", True, ["other"], "low")
        with mock.patch.object(main, "fetch_posts", return_value=posts), \
                mock.patch.object(main, "analyze_post", return_value=analysis):
            main.main()

    @staticmethod
    def posts(*ids):
        return [{"id": i, "text": f"post {i}", "created_at": "", "url": ""} for i in ids]

    def test_all_translation_providers_failing_alerts_once_per_run(self):
        self.store.save(BotState(subscribers={"a": None}, last_seen="1", last_success=NOW))
        untranslated = main.PostAnalysis("post", False, ["other"], None)
        self.run_main(self.posts("3", "2", "1"), analysis=untranslated)
        alerts = self.alert_texts()
        self.assertEqual(len(alerts), 1)
        self.assertIn("2 פוסט(ים)", alerts[0])
        self.assertEqual(self.store.load().alerts, {"translation": NOW})

    def test_successful_translation_sends_no_alert(self):
        self.store.save(BotState(subscribers={"a": None}, last_seen="1", last_success=NOW))
        self.run_main(self.posts("2", "1"))
        self.assertEqual(self.alert_texts(), [])

    def test_stale_heartbeat_alerts_and_run_refreshes_it(self):
        self.store.save(BotState(subscribers={"a": None}, last_seen="1", last_success=NOW - 5 * HOUR))
        self.run_main(self.posts("1"))
        self.assertEqual(len(self.alert_texts()), 1)
        self.assertEqual(self.store.load().last_success, NOW)

    def test_fetch_failure_is_not_a_successful_run(self):
        self.store.save(BotState(subscribers={"a": None}, last_seen="1", last_success=NOW - HOUR))
        self.run_main([])
        self.assertEqual(self.store.load().last_success, NOW - HOUR)

    def test_lost_last_seen_alerts_about_possible_gap(self):
        self.store.save(BotState(subscribers={"a": None}, last_seen="1", last_success=NOW))
        self.run_main(self.posts("9", "8"))
        (alert,) = self.alert_texts()
        self.assertIn("ייתכן שפוסטים הוחמצו", alert)

    def test_run_without_subscribers_still_counts(self):
        self.store.save(BotState(last_success=NOW - HOUR))
        self.run_main([])
        self.assertEqual(self.store.load().last_success, NOW)


if __name__ == "__main__":
    unittest.main()
