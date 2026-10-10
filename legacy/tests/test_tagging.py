"""Tests for market-impact tagging and high-impact-first sending."""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

import main  # noqa: E402
from state import BotState, FileStateStore  # noqa: E402
from test_translation import GEMINI_HOST, GTX_HOST, TranslationTestCase, gemini_answer, json_response  # noqa: E402

ENGLISH = "I am raising Tariffs on China to 100%, effective November 1st!"
HEBREW = "אני מעלה את המכסים על סין ל-100%, החל מ-1 בנובמבר!"


class ParseMarketTagsTests(unittest.TestCase):
    def test_valid_answer(self):
        self.assertEqual(
            main.parse_market_tags({"categories": ["china", "tariffs"], "impact": "high"}),
            (["tariffs", "china"], "high"),  # display order, not answer order
        )

    def test_normalises_case_aliases_and_duplicates(self):
        data = {"categories": [" Tariffs ", "tariff", "Fed", "interest rates", "Stock-Market"], "impact": " Medium "}
        self.assertEqual(main.parse_market_tags(data), (["tariffs", "fed_rates", "stocks"], "medium"))

    def test_drops_unknown_and_non_string_categories(self):
        self.assertEqual(main.parse_market_tags({"categories": ["weather", 5, None, "oil"]}), (["oil"], None))

    def test_other_is_dropped_next_to_a_real_topic(self):
        self.assertEqual(main.parse_market_tags({"categories": ["other", "crypto"]})[0], ["crypto"])
        self.assertEqual(main.parse_market_tags({"categories": ["other"]})[0], ["other"])

    def test_single_string_category(self):
        self.assertEqual(main.parse_market_tags({"categories": "oil", "impact": "low"}), (["oil"], "low"))

    def test_invalid_impact_is_none(self):
        for impact in ("extreme", "", 3, None, ["high"]):
            self.assertIsNone(main.parse_market_tags({"categories": ["oil"], "impact": impact})[1])

    def test_garbage(self):
        for data in (None, "high", [], {}, {"categories": {"a": 1}}):
            self.assertEqual(main.parse_market_tags(data), ([], None))


class KeywordCategoriesTests(unittest.TestCase):
    def test_topics(self):
        cases = {
            "New TARIFFS on all imports": ["tariffs"],
            "The Fed must cut Interest Rates NOW, Powell is too late": ["fed_rates"],
            "Drill baby drill, OPEC must lower oil prices": ["oil"],
            "America will be the crypto capital, Bitcoin": ["crypto"],
            "President Xi and I had a great call about China": ["china"],
            "The Stock Market hit an ALL TIME HIGH, Dow and Nasdaq up": ["stocks"],
            "Tariffs on China are making the Stock Market strong": ["tariffs", "china", "stocks"],
            "Happy Thanksgiving to all!": ["other"],
        }
        for text, expected in cases.items():
            with self.subTest(text=text):
                self.assertEqual(main.keyword_categories(text), expected)

    def test_no_substring_false_positives(self):
        # "foil", "toil", "machine", "drilled down" shouldn't pick up oil/china.
        self.assertEqual(main.keyword_categories("Sixty duty-free soil samples, a fine machine"), ["other"])


class AnalyzePostTests(TranslationTestCase):
    def test_one_gemini_call_translates_and_tags(self):
        answer = gemini_answer({"hebrew": HEBREW, "categories": ["tariffs", "china"], "impact": "high"})
        http = self.route_hosts({GEMINI_HOST: lambda r: json_response(answer)})
        result = main.analyze_post(ENGLISH)
        self.assertEqual(result, main.PostAnalysis(HEBREW, True, ["tariffs", "china"], "high", "gemini"))
        self.assertEqual(http.hosts(), [GEMINI_HOST])

    def test_gemini_without_valid_tags_uses_keywords(self):
        answer = gemini_answer({"hebrew": HEBREW, "categories": ["weather"], "impact": "high"})
        self.route_hosts({GEMINI_HOST: lambda r: json_response(answer)})
        result = main.analyze_post(ENGLISH)
        self.assertEqual((result.categories, result.impact), (["tariffs", "china"], None))
        self.assertTrue(result.translated)

    def test_gemini_failure_falls_back_to_free_chain_and_keywords(self):
        def fail(req):
            raise OSError("down")

        http = self.route_hosts({GEMINI_HOST: fail, GTX_HOST: lambda r: json_response([[[HEBREW, ENGLISH]]])})
        result = main.analyze_post(ENGLISH)
        self.assertEqual(result, main.PostAnalysis(HEBREW, True, ["tariffs", "china"], None, "free"))
        self.assertEqual(http.hosts(), [GEMINI_HOST, GTX_HOST])  # Gemini not asked twice

    def test_everything_fails(self):
        self.route_hosts({})
        result = main.analyze_post(ENGLISH)
        self.assertEqual((result.hebrew, result.translated, result.provider), (ENGLISH, False, ""))
        self.assertEqual(result.categories, ["tariffs", "china"])

    def test_no_key_never_calls_gemini(self):
        http = self.route_hosts({GTX_HOST: lambda r: json_response([[[HEBREW, ENGLISH]]])})
        with mock.patch.object(main, "GEMINI_API_KEY", ""):
            self.assertEqual(main.analyze_post(ENGLISH).provider, "free")
        self.assertEqual(http.hosts(), [GTX_HOST])


def analysis(impact=None, categories=("other",)):
    return main.PostAnalysis("שלום", True, list(categories), impact)


class AdvanceCursorTests(unittest.TestCase):
    ids = ["2", "3", "4", "5"]

    def test_in_order_moves_cursor(self):
        state = BotState(last_seen="1")
        main.advance_cursor(state, self.ids, "2")
        self.assertEqual((state.last_seen, state.sent_ahead), ("2", []))

    def test_out_of_order_waits_in_sent_ahead(self):
        state = BotState(last_seen="1")
        main.advance_cursor(state, self.ids, "4")
        self.assertEqual((state.last_seen, state.sent_ahead), ("1", ["4"]))
        main.advance_cursor(state, self.ids, "2")
        self.assertEqual((state.last_seen, state.sent_ahead), ("2", ["4"]))
        main.advance_cursor(state, self.ids, "3")
        self.assertEqual((state.last_seen, state.sent_ahead), ("4", []))

    def test_catches_up_over_already_sent_posts(self):
        state = BotState(last_seen="1", sent_ahead=["2", "3"])
        main.advance_cursor(state, self.ids)
        self.assertEqual((state.last_seen, state.sent_ahead), ("3", []))

    def test_drops_stale_ids(self):
        state = BotState(last_seen="1", sent_ahead=["99"])
        main.advance_cursor(state, self.ids)
        self.assertEqual((state.last_seen, state.sent_ahead), ("1", []))

    def test_clears_in_flight_for_the_sent_post(self):
        state = BotState(last_seen="1", in_flight_post="2", in_flight_chats=["a"])
        main.advance_cursor(state, self.ids, "2")
        self.assertEqual((state.in_flight_post, state.in_flight_chats), ("", []))


class SendOrderTests(unittest.TestCase):
    def test_in_flight_then_high_then_rest_chronological(self):
        prepared = [
            ({"id": "1"}, "m1", analysis("low")),
            ({"id": "2"}, "m2", analysis("high")),
            ({"id": "3"}, "m3", analysis(None)),
            ({"id": "4"}, "m4", analysis("high")),
            ({"id": "5"}, "m5", analysis("medium")),
        ]
        order = [p["id"] for p, _, _ in main.send_order(prepared, in_flight="3")]
        self.assertEqual(order, ["3", "2", "4", "1", "5"])


class HighImpactFirstTests(unittest.TestCase):
    """End to end through main.main(), with analysis and sending mocked."""

    def setUp(self):
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
            mock.patch.object(main, "analyze_post", side_effect=self.fake_analyze),
            mock.patch.object(main.time, "sleep"),
        ):
            p.start()
            self.addCleanup(p.stop)
        self.sent: list[str] = []

    @staticmethod
    def fake_analyze(text):
        return analysis("high" if "URGENT" in text else "low")

    def run_main(self, posts, budget_after=None):
        def send(message, chat_id=None, thread_id=None, **_):
            self.sent.append(message)
            return main.SendResult(True)

        budget = (lambda: len(self.sent) >= budget_after) if budget_after else (lambda: False)
        with mock.patch.object(main, "fetch_posts", return_value=posts), \
                mock.patch.object(main, "send_telegram_message", side_effect=send), \
                mock.patch.object(main, "_budget_exceeded", side_effect=budget):
            main.main()

    @staticmethod
    def feed():
        texts = {"5": "news", "4": "URGENT tariffs", "3": "rally", "2": "hello", "1": "seen"}
        return [{"id": i, "text": t, "created_at": "", "url": ""} for i, t in texts.items()]

    def sent_texts(self):
        return [next(w for w in ("news", "URGENT", "rally", "hello") if w in m) for m in self.sent]

    def test_high_impact_post_goes_first_and_is_marked(self):
        self.store.save(BotState(subscribers={"a": None}, last_seen="1"))
        self.run_main(self.feed())
        self.assertEqual(self.sent_texts(), ["URGENT", "hello", "rally", "news"])
        self.assertTrue(self.sent[0].startswith("🔴"))
        self.assertTrue(self.sent[1].startswith("⚪"))
        saved = self.store.load()
        self.assertEqual((saved.last_seen, saved.sent_ahead), ("5", []))

    def test_interrupted_after_high_impact_post_resumes_without_duplicates(self):
        self.store.save(BotState(subscribers={"a": None}, last_seen="1"))
        self.run_main(self.feed(), budget_after=1)
        self.assertEqual(self.sent_texts(), ["URGENT"])
        saved = self.store.load()
        self.assertEqual((saved.last_seen, saved.sent_ahead), ("1", ["4"]))

        self.sent.clear()
        self.run_main(self.feed())
        self.assertEqual(self.sent_texts(), ["hello", "rally", "news"])
        saved = self.store.load()
        self.assertEqual((saved.last_seen, saved.sent_ahead), ("5", []))


if __name__ == "__main__":
    unittest.main()
