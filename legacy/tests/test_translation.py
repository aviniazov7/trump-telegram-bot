"""Tests for the translation chain: Gemini first, then the keyless providers.

HTTP is mocked at urlopen, so each provider's real request building and
response parsing runs.
"""

from __future__ import annotations

import io
import json
import sys
import unittest
import urllib.error
import urllib.parse
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

import main  # noqa: E402

ENGLISH = "The tariffs on China are working very well!"
HEBREW = "המכסים על סין עובדים טוב מאוד!"


class FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def json_response(data) -> FakeResponse:
    return FakeResponse(json.dumps(data).encode())


def http_error(url: str, code: int, body: str = "") -> urllib.error.HTTPError:
    return urllib.error.HTTPError(url, code, "error", {}, io.BytesIO(body.encode()))


def gemini_answer(data: dict | str, finish: str = "STOP", thought: str | None = None) -> dict:
    text = data if isinstance(data, str) else json.dumps(data, ensure_ascii=False)
    parts = [{"text": thought, "thought": True}] if thought else []
    parts.append({"text": text})
    return {"candidates": [{"content": {"parts": parts}, "finishReason": finish}]}


class FakeHttp:
    """Routes urlopen calls by host. A handler returns a response or raises."""

    def __init__(self, **handlers):
        self.handlers = handlers
        self.requests: list[urllib.request.Request] = []

    def __call__(self, req, timeout=None):
        self.requests.append(req)
        host = urllib.parse.urlsplit(req.full_url).hostname
        handler = self.handlers.get(host)
        if handler is None:
            raise urllib.error.URLError(f"no route to {host}")
        return handler(req)

    def hosts(self) -> list[str]:
        return [urllib.parse.urlsplit(r.full_url).hostname for r in self.requests]


GEMINI_HOST = "generativelanguage.googleapis.com"
GTX_HOST = "translate.googleapis.com"
CLIENTS5_HOST = "clients5.google.com"
MYMEMORY_HOST = "api.mymemory.translated.net"


def gtx_ok(req):
    return json_response([[[HEBREW, ENGLISH]]])


def fail_503(req):
    raise http_error(req.full_url, 503)


class TranslationTestCase(unittest.TestCase):
    def setUp(self):
        for p in (
            mock.patch.object(main, "GEMINI_API_KEY", "test-key"),
            mock.patch.object(main.time, "sleep"),
        ):
            p.start()
            self.addCleanup(p.stop)

    def route_hosts(self, mapping: dict) -> FakeHttp:
        fake = FakeHttp(**mapping)
        patcher = mock.patch.object(main.urllib.request, "urlopen", side_effect=fake)
        patcher.start()
        self.addCleanup(patcher.stop)
        return fake


class GeminiPrimaryTests(TranslationTestCase):
    def test_gemini_is_tried_first_and_wins(self):
        http = self.route_hosts({GEMINI_HOST: lambda r: json_response(gemini_answer({"hebrew": HEBREW})),
                                 GTX_HOST: gtx_ok})
        self.assertEqual(main.translate_to_hebrew(ENGLISH), (HEBREW, True))
        self.assertEqual(http.hosts(), [GEMINI_HOST])

    def test_request_shape(self):
        http = self.route_hosts({GEMINI_HOST: lambda r: json_response(gemini_answer({"hebrew": HEBREW}))})
        main.translate_to_hebrew(ENGLISH)
        req = http.requests[0]
        self.assertNotIn("test-key", req.full_url)  # key stays out of URLs/logs
        self.assertEqual(req.get_header("X-goog-api-key"), "test-key")
        self.assertIn(main.GEMINI_MODEL, req.full_url)
        body = json.loads(req.data)
        self.assertIn("Hebrew", body["systemInstruction"]["parts"][0]["text"])
        self.assertEqual(body["contents"][0]["parts"][0]["text"], ENGLISH)
        config = body["generationConfig"]
        self.assertEqual(config["responseMimeType"], "application/json")
        self.assertIn("hebrew", config["responseSchema"]["properties"])
        self.assertNotIn("thinkingConfig", config)

    def test_thinking_level_is_passed_when_configured(self):
        http = self.route_hosts({GEMINI_HOST: lambda r: json_response(gemini_answer({"hebrew": HEBREW}))})
        with mock.patch.object(main, "GEMINI_THINKING_LEVEL", "low"):
            main.translate_to_hebrew(ENGLISH)
        config = json.loads(http.requests[0].data)["generationConfig"]
        self.assertEqual(config["thinkingConfig"], {"thinkingLevel": "low"})

    def test_thought_parts_are_ignored(self):
        answer = gemini_answer({"hebrew": HEBREW}, thought="Let me think about tariffs...")
        self.route_hosts({GEMINI_HOST: lambda r: json_response(answer)})
        self.assertEqual(main.translate_to_hebrew(ENGLISH), (HEBREW, True))

    def test_no_key_skips_gemini(self):
        http = self.route_hosts({GEMINI_HOST: fail_503, GTX_HOST: gtx_ok})
        with mock.patch.object(main, "GEMINI_API_KEY", ""):
            self.assertEqual(main.translate_to_hebrew(ENGLISH), (HEBREW, True))
        self.assertEqual(http.hosts(), [GTX_HOST])

    def test_gemini_http_error_falls_back(self):
        http = self.route_hosts({GEMINI_HOST: fail_503, GTX_HOST: gtx_ok})
        self.assertEqual(main.translate_to_hebrew(ENGLISH), (HEBREW, True))
        self.assertEqual(http.hosts(), [GEMINI_HOST, GTX_HOST])

    def test_gemini_truncated_answer_falls_back(self):
        answer = gemini_answer({"hebrew": "המכסים"}, finish="MAX_TOKENS")
        self.route_hosts({GEMINI_HOST: lambda r: json_response(answer), GTX_HOST: gtx_ok})
        self.assertEqual(main.translate_to_hebrew(ENGLISH), (HEBREW, True))

    def test_gemini_english_echo_falls_back(self):
        answer = gemini_answer({"hebrew": ENGLISH})
        self.route_hosts({GEMINI_HOST: lambda r: json_response(answer), GTX_HOST: gtx_ok})
        self.assertEqual(main.translate_to_hebrew(ENGLISH), (HEBREW, True))

    def test_gemini_non_json_falls_back(self):
        answer = gemini_answer("Sure! Here is the translation: ...")
        self.route_hosts({GEMINI_HOST: lambda r: json_response(answer), GTX_HOST: gtx_ok})
        self.assertEqual(main.translate_to_hebrew(ENGLISH), (HEBREW, True))

    def test_gemini_blocked_prompt_falls_back(self):
        blocked = {"promptFeedback": {"blockReason": "SAFETY"}}
        self.route_hosts({GEMINI_HOST: lambda r: json_response(blocked), GTX_HOST: gtx_ok})
        self.assertEqual(main.translate_to_hebrew(ENGLISH), (HEBREW, True))

    def test_gemini_429_waits_retry_delay_once(self):
        calls = []

        def gemini(req):
            calls.append(req)
            if len(calls) == 1:
                raise http_error(req.full_url, 429, '{"error": {"details": [{"retryDelay": "12s"}]}}')
            return json_response(gemini_answer({"hebrew": HEBREW}))

        self.route_hosts({GEMINI_HOST: gemini})
        self.assertEqual(main.translate_to_hebrew(ENGLISH), (HEBREW, True))
        main.time.sleep.assert_called_once_with(13)

    def test_gemini_429_with_long_delay_falls_back_without_waiting(self):
        def gemini(req):
            raise http_error(req.full_url, 429, '{"retryDelay": "3600s"}')

        self.route_hosts({GEMINI_HOST: gemini, GTX_HOST: gtx_ok})
        self.assertEqual(main.translate_to_hebrew(ENGLISH), (HEBREW, True))
        main.time.sleep.assert_not_called()


class FreeChainTests(TranslationTestCase):
    def setUp(self):
        super().setUp()
        p = mock.patch.object(main, "GEMINI_API_KEY", "")
        p.start()
        self.addCleanup(p.stop)

    def test_each_provider_is_tried_in_order_until_one_works(self):
        def mymemory(req):
            return json_response({"responseData": {"translatedText": HEBREW}})

        http = self.route_hosts({
            GTX_HOST: fail_503,
            CLIENTS5_HOST: lambda r: json_response({"sentences": [{"trans": "Not Hebrew at all, sorry"}]}),
            MYMEMORY_HOST: mymemory,
        })
        self.assertEqual(main.translate_to_hebrew(ENGLISH), (HEBREW, True))
        # Lingva instances have no route (connection errors) and are skipped.
        self.assertEqual(http.hosts()[0], GTX_HOST)
        self.assertEqual(http.hosts()[1], CLIENTS5_HOST)
        self.assertEqual(http.hosts()[-1], MYMEMORY_HOST)

    def test_lingva_answer_is_used(self):
        self.route_hosts({"lingva.ml": lambda r: json_response({"translation": HEBREW})})
        self.assertEqual(main.translate_to_hebrew(ENGLISH), (HEBREW, True))

    def test_mymemory_quota_notice_is_not_a_translation(self):
        notice = {"responseData": {"translatedText": "MYMEMORY WARNING: YOU USED ALL AVAILABLE FREE TRANSLATIONS"}}
        self.route_hosts({MYMEMORY_HOST: lambda r: json_response(notice)})
        self.assertEqual(main.translate_to_hebrew(ENGLISH), (ENGLISH, False))

    def test_all_providers_fail_returns_original_untranslated(self):
        self.route_hosts({})
        self.assertEqual(main.translate_to_hebrew(ENGLISH), (ENGLISH, False))

    def test_partial_success_is_rejected(self):
        # Two chunks: a provider that translates only the first must not win.
        text = ("First sentence about the economy today. " * 70 + "\n") * 2
        self.assertEqual(len(main._split_text(text, main.MAX_TRANSLATE_CHUNK)), 2)
        answers = iter([[[[HEBREW, "x"]]], [[["English again and again", "x"]]]])
        self.route_hosts({GTX_HOST: lambda r: json_response(next(answers))})
        translated, ok = main.translate_to_hebrew(text, providers=main.FREE_TRANSLATE_PROVIDERS[:1])
        self.assertFalse(ok)
        self.assertEqual(translated, text)

    def test_text_without_words_needs_no_provider(self):
        http = self.route_hosts({})
        self.assertEqual(main.translate_to_hebrew("   "), ("   ", True))
        self.assertEqual(http.requests, [])


class ExtractClients5Tests(unittest.TestCase):
    def test_known_shapes(self):
        for shape in ("שלום", ["שלום"], [["שלום", "hello"]], {"sentences": [{"trans": "שלום"}]}):
            self.assertEqual(main._extract_clients5_text(shape), "שלום")
        self.assertIsNone(main._extract_clients5_text({"other": 1}))
        self.assertIsNone(main._extract_clients5_text(5))


if __name__ == "__main__":
    unittest.main()
