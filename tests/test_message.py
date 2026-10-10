"""Tests for building and splitting Telegram messages."""

from __future__ import annotations

import re
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

import main  # noqa: E402

POST = {
    "id": "1",
    "text": 'Tariffs <now> & "forever"',
    "created_at": "Sat, 10 Oct 2026 18:59:16 +0000",
    "url": "https://truthsocial.com/@realDonaldTrump/1?a=1&b=2",
}


class BuildMessageTests(unittest.TestCase):
    def test_layout(self):
        msg = main.build_message(POST, "מכסים <עכשיו>")
        lines = msg.split("\n")
        self.assertEqual(lines[0], "🇺🇸 <b>טראמפ — פוסט חדש</b>")
        self.assertEqual(lines[1], "🕐 10/10/2026 21:59")  # Israel time (UTC+3 in October)
        self.assertIn("🇮🇱 <b>תרגום לעברית:</b>", msg)
        self.assertTrue(msg.endswith('<a href="https://truthsocial.com/@realDonaldTrump/1?a=1&amp;b=2">לפוסט המקורי</a>'))

    def test_escapes_post_and_translation(self):
        msg = main.build_message(POST, "מכסים <עכשיו>")
        self.assertIn("Tariffs &lt;now&gt; &amp; &quot;forever&quot;", msg)
        self.assertIn("מכסים &lt;עכשיו&gt;", msg)

    def test_untranslated_notice_instead_of_english_under_hebrew_heading(self):
        msg = main.build_message(POST, POST["text"], translated=False)
        self.assertNotIn("תרגום לעברית:", msg)
        self.assertIn("התרגום לעברית נכשל", msg)

    def test_no_link(self):
        msg = main.build_message({**POST, "url": ""}, "x")
        self.assertNotIn("<a ", msg)

    def test_unparseable_date_shown_as_is(self):
        self.assertIn("🕐 sometime", main.build_message({**POST, "created_at": "sometime"}, "x"))
        self.assertIn("🕐 —", main.build_message({**POST, "created_at": ""}, "x"))

    def test_iso_date(self):
        self.assertIn("🕐 10/10/2026 21:59", main.build_message({**POST, "created_at": "2026-10-10T18:59:16.056Z"}, "x"))

    def test_high_impact_tag_line_comes_first(self):
        msg = main.build_message(POST, "x", categories=["tariffs", "china"], impact="high")
        self.assertEqual(msg.split("\n")[0], "🔴 <b>השפעה גבוהה על השווקים</b> · #מכסים #סין")

    def test_no_tags_keeps_old_layout(self):
        self.assertEqual(main.build_message(POST, "x"), main.build_message(POST, "x", categories=[], impact=None))


class TagLineTests(unittest.TestCase):
    def test_levels(self):
        self.assertEqual(main.build_tag_line(["fed_rates"], "medium"), "🟠 השפעה בינונית על השווקים · #ריבית_הפד")
        self.assertEqual(main.build_tag_line(["other"], "low"), "⚪ השפעה נמוכה על השווקים · #כללי")

    def test_unknown_impact_shows_only_topics(self):
        self.assertEqual(main.build_tag_line(["oil", "crypto"], None), "🏷️ #נפט #קריפטו")

    def test_impact_without_topics(self):
        self.assertEqual(main.build_tag_line([], "high"), "🔴 <b>השפעה גבוהה על השווקים</b>")

    def test_nothing(self):
        self.assertEqual(main.build_tag_line(None, None), "")
        self.assertEqual(main.build_tag_line(["bogus"], "bogus"), "")


class SplitForTelegramTests(unittest.TestCase):
    def test_short_message_untouched(self):
        self.assertEqual(main._split_for_telegram("hello"), ["hello"])

    def test_splits_at_newlines_within_limit(self):
        text = "\n".join(f"line {i} " + "x" * 50 for i in range(200))
        chunks = main._split_for_telegram(text, max_len=1000)
        self.assertGreater(len(chunks), 1)
        self.assertTrue(all(len(c) <= 1000 for c in chunks))
        self.assertEqual("\n".join(chunks), text)

    def test_falls_back_to_spaces_then_hard_cut(self):
        spaced = " ".join(["word"] * 500)
        self.assertTrue(all(len(c) <= 100 for c in main._split_for_telegram(spaced, max_len=100)))
        solid = "x" * 250
        self.assertEqual(main._split_for_telegram(solid, max_len=100), ["x" * 100, "x" * 100, "x" * 50])

    def test_long_post_keeps_html_tags_intact(self):
        long_post = {**POST, "text": "\n".join(["A long paragraph of text. " * 10] * 40)}
        msg = main.build_message(long_post, "\n".join(["פסקה ארוכה מאוד. " * 10] * 40),
                                 categories=["stocks"], impact="high")
        chunks = main._split_for_telegram(msg)
        self.assertGreater(len(chunks), 1)
        for chunk in chunks:
            self.assertLessEqual(len(chunk), main.TELEGRAM_MAX_MESSAGE_LEN)
            for tag in ("b", "a"):
                self.assertEqual(len(re.findall(f"<{tag}[ >]", chunk)), chunk.count(f"</{tag}>"), chunk[:80])


class SplitTextTests(unittest.TestCase):
    def test_prefers_newlines_then_sentences(self):
        text = "a" * 60 + "\n" + "b" * 60
        self.assertEqual(main._split_text(text, 100), ["a" * 60 + "\n", "b" * 60])
        text = "a" * 60 + ". " + "b" * 60
        self.assertEqual(main._split_text(text, 100), ["a" * 60 + ".", "b" * 60])

    def test_hard_cut_without_boundaries(self):
        self.assertEqual(main._split_text("x" * 250, 100), ["x" * 100, "x" * 100, "x" * 50])


class StripHtmlTests(unittest.TestCase):
    def test_cleans_feed_html(self):
        raw = '<p>Hello&amp;bye<br/>RT: https://x.com/a <a href="u">link</a></p><p>Next</p>'
        self.assertEqual(main.strip_html(raw), "Hello&bye\nlink \nNext")

    def test_meaningful_text(self):
        self.assertFalse(main._is_meaningful_text("RT: https://truthsocial.com/x"))
        self.assertFalse(main._is_meaningful_text("[No Title] - Post from ..."))
        self.assertFalse(main._is_meaningful_text("   "))
        self.assertTrue(main._is_meaningful_text("MAKE AMERICA GREAT AGAIN!"))


if __name__ == "__main__":
    unittest.main()
