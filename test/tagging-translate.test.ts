import { describe, expect, it } from "vitest";
import type { WorkersAiChatInput } from "../src/runtime";
import { analyzePost, keywordCategories, parseMarketTags } from "../src/tagging";
import {
  hasArabicScript,
  isArabicCodePoint,
  looksTranslated,
  needsTranslation,
  repairArabicScript,
  sanitizeArabicWords,
} from "../src/translate";
import { bindWorkersAi, extractWorkersAiText } from "../src/workers-ai";
import { type Call, GEMINI, GTX, geminiAnswer, json, testCtx } from "./helpers";

const ENGLISH = "I am raising Tariffs on China to 100%, effective November 1st!";
const HEBREW = "אני מעלה את המכסים על סין ל-100%, החל מ-1 בנובמבר!";
const fail503 = () => new Response("unavailable", { status: 503 });

describe("parseMarketTags", () => {
  it("validates and orders categories", () => {
    expect(parseMarketTags({ categories: ["china", "tariffs"], impact: "high" })).toEqual({
      categories: ["tariffs", "china"],
      impact: "high",
    });
  });

  it("normalises case, aliases and duplicates", () => {
    const data = {
      categories: [" Tariffs ", "tariff", "Fed", "interest rates", "Stock-Market"],
      impact: " Medium ",
    };
    expect(parseMarketTags(data)).toEqual({
      categories: ["tariffs", "fed_rates", "stocks"],
      impact: "medium",
    });
  });

  it("drops unknown and non-string categories, and 'other' next to a real topic", () => {
    expect(parseMarketTags({ categories: ["weather", 5, null, "oil"] }).categories).toEqual(["oil"]);
    expect(parseMarketTags({ categories: ["other", "crypto"] }).categories).toEqual(["crypto"]);
    expect(parseMarketTags({ categories: ["other"] }).categories).toEqual(["other"]);
    expect(parseMarketTags({ categories: "oil", impact: "low" })).toEqual({
      categories: ["oil"],
      impact: "low",
    });
  });

  it("rejects invalid impact values and garbage", () => {
    for (const impact of ["extreme", "", 3, null, ["high"]]) {
      expect(parseMarketTags({ categories: ["oil"], impact }).impact).toBeNull();
    }
    for (const data of [null, "high", [], {}, { categories: { a: 1 } }]) {
      expect(parseMarketTags(data)).toEqual({ categories: [], impact: null });
    }
  });
});

describe("keywordCategories", () => {
  it.each([
    ["New TARIFFS on all imports", ["tariffs"]],
    ["The Fed must cut Interest Rates NOW, Powell is too late", ["fed_rates"]],
    ["Drill baby drill, OPEC must lower oil prices", ["oil"]],
    ["America will be the crypto capital, Bitcoin", ["crypto"]],
    ["President Xi and I had a great call about China", ["china"]],
    ["The Stock Market hit an ALL TIME HIGH, Dow and Nasdaq up", ["stocks"]],
    ["Tariffs on China are making the Stock Market strong", ["tariffs", "china", "stocks"]],
    ["Happy Thanksgiving to all!", ["other"]],
    ["Sixty duty-free soil samples, a fine machine", ["other"]],
  ])("%s", (text, expected) => {
    expect(keywordCategories(text)).toEqual(expected);
  });
});

const PRIMARY = "gemini-3.8-flash";
const FALLBACK = "gemini-3.5-flash-lite";
/** Arabic letters mixed into a Hebrew word, as produced on 2026-10-20. */
const MIXED = "بالמפלגה הרפובליקנית";
const REPAIRED = "באלמפלגה הרפובליקנית";
const CLEAN_PARTY = "במפלגה הרפובליקנית";
const modelOf = (call: Call) => /models\/([^:]+):/.exec(call.url)?.[1];
const answer = (data: unknown, finish?: string, thought?: string) => () =>
  json(geminiAnswer(data, finish, thought));
const good = answer({ hebrew: HEBREW, categories: ["tariffs", "china"], impact: "high" });
/** Route Gemini calls per model. */
const byModel = (primary: () => Response, fallback: () => Response) => (call: Call) =>
  modelOf(call) === FALLBACK ? fallback() : primary();

const aiReply = (content: string, finish = "stop") => ({
  choices: [{ finish_reason: finish, message: { content, reasoning_content: "thinking in English" } }],
});

function fakeAi(reply: (text: string) => unknown) {
  const prompts: WorkersAiChatInput[] = [];
  return {
    prompts,
    ai: {
      async run(_model: string, input: WorkersAiChatInput) {
        prompts.push(input);
        const text = input.messages.find((message) => message.role === "user")?.content ?? "";
        return reply(text);
      },
    },
  };
}

describe("analyzePost", () => {
  it("translates and tags with one call to the primary model", async () => {
    const ctx = testCtx({ [GEMINI]: good });
    expect(await analyzePost(ctx, ENGLISH)).toEqual({
      hebrew: HEBREW,
      translated: true,
      categories: ["tariffs", "china"],
      impact: "high",
      provider: "gemini",
      model: PRIMARY,
    });
    expect(ctx.calls.map(modelOf)).toEqual([PRIMARY]);
  });

  it("sends a well-formed request: key in a header, thinking level on full (non-lite) models only", async () => {
    const ctx = testCtx({ [GEMINI]: byModel(fail503, good) }, { geminiThinkingLevel: "low" });
    await analyzePost(ctx, ENGLISH);
    const [primary, , fallback] = ctx.calls;
    expect(primary?.url).toContain(`/models/${PRIMARY}:generateContent`);
    expect(primary?.url).not.toContain("test-gemini-key");
    expect(primary?.headers.get("x-goog-api-key")).toBe("test-gemini-key");
    const body = JSON.parse(primary?.body ?? "{}");
    expect(body.systemInstruction.parts[0].text).toContain("Hebrew only");
    expect(body.systemInstruction.parts[0].text).toContain("Never use Arabic");
    expect(body.systemInstruction.parts[0].text).toContain("transliterate");
    expect(body.systemInstruction.parts[0].text).toContain("parentheses");
    expect(body.systemInstruction.parts[0].text).not.toContain("Do not transliterate");
    expect(body.systemInstruction.parts[0].text).toContain("אני שמח להודיע");
    expect(body.systemInstruction.parts[0].text).toContain("טוהר הבחירות");
    expect(body.systemInstruction.parts[0].text).not.toContain("previous translation was invalid");
    expect(body.generationConfig).toMatchObject({ responseMimeType: "application/json" });
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "low" });
    expect(Object.keys(body.generationConfig.responseSchema.properties)).toEqual([
      "hebrew",
      "categories",
      "impact",
    ]);
    const fallbackBody = JSON.parse(fallback?.body ?? "{}");
    expect(fallbackBody.generationConfig.thinkingConfig).toBeUndefined();
    expect(fallbackBody.systemInstruction.parts[0].text).not.toContain("previous translation was invalid");
  });

  it("ignores thought parts", async () => {
    const ctx = testCtx({
      [GEMINI]: answer({ hebrew: HEBREW, categories: ["oil"], impact: "low" }, "STOP", "thinking…"),
    });
    expect((await analyzePost(ctx, ENGLISH)).hebrew).toBe(HEBREW);
  });

  it("uses keyword topics when Gemini's tags are invalid (tariffs → at least 🟠)", async () => {
    const ctx = testCtx({ [GEMINI]: answer({ hebrew: HEBREW, categories: ["weather"], impact: "high" }) });
    expect(await analyzePost(ctx, ENGLISH)).toMatchObject({
      categories: ["tariffs", "china"],
      impact: "medium",
    });
  });

  it.each([
    ["an HTTP error", fail503, "HTTP 503"],
    ["a truncated answer", answer({ hebrew: "המכסים" }, "MAX_TOKENS"), "finishReason=MAX_TOKENS"],
    ["an English echo", answer({ hebrew: ENGLISH, categories: [], impact: "low" }), "untranslated text"],
    ["non-JSON text", answer("Sure! Here is the translation"), "answer is not JSON"],
    ["a blocked prompt", () => json({ promptFeedback: { blockReason: "SAFETY" } }), "blockReason=SAFETY"],
    [
      "a timeout",
      () => {
        throw new DOMException("The operation timed out.", "TimeoutError");
      },
      "timeout after 12s",
    ],
  ])("falls back to the second model after %s, and reports why", async (_name, primary, reason) => {
    const ctx = testCtx({ [GEMINI]: byModel(primary, good) });
    const result = await analyzePost(ctx, ENGLISH);
    expect(result).toMatchObject({ translated: true, provider: "gemini", model: FALLBACK, hebrew: HEBREW });
    expect(result.geminiError).toContain(`${PRIMARY}: `);
    expect(result.geminiError).toContain(reason);
  });

  it("returns untranslated, with both models' reasons, when both fail and Workers AI is not configured", async () => {
    const ctx = testCtx({ [GEMINI]: fail503, [GTX]: () => json([[[HEBREW, ENGLISH]]]) });
    const result = await analyzePost(ctx, ENGLISH);
    expect(result).toMatchObject({
      hebrew: ENGLISH,
      translated: false,
      provider: "",
      categories: ["tariffs", "china"],
      impact: "medium",
    });
    expect(result.geminiError).toMatch(new RegExp(`${PRIMARY}: HTTP 503.*\\| ${FALLBACK}: HTTP 503`));
    expect(result.deterministic).toBeUndefined();
    expect(ctx.hosts()).not.toContain(GTX);
    expect(ctx.ai).toBeUndefined();
  });

  it("does not call Workers AI when Gemini succeeds", async () => {
    const workers = fakeAi(() => aiReply(HEBREW));
    const ctx = testCtx({ [GEMINI]: good }, {}, { ai: workers.ai });
    expect(await analyzePost(ctx, ENGLISH)).toMatchObject({
      translated: true,
      provider: "gemini",
      model: PRIMARY,
    });
    expect(workers.prompts).toEqual([]);
  });

  it("uses Workers AI after an English echo, and does not ask the echoing model again", async () => {
    const echo = answer({ hebrew: ENGLISH, categories: [], impact: "low" });
    const workers = fakeAi(() => aiReply(HEBREW));
    const ctx = testCtx({ [GEMINI]: byModel(echo, echo) }, {}, { ai: workers.ai });
    const result = await analyzePost(ctx, ENGLISH);
    expect(result).toMatchObject({
      translated: true,
      provider: "workers-ai",
      model: "@cf/zai-org/glm-4.7-flash",
      hebrew: HEBREW,
    });
    expect(result.geminiError).toContain("untranslated text");
    expect(workers.prompts).toHaveLength(1);
    expect(workers.prompts[0]?.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(workers.prompts[0]?.max_completion_tokens).toBeLessThanOrEqual(2048);

    const again = testCtx({ [GEMINI]: byModel(echo, echo) }, {}, { ai: fakeAi(() => aiReply(HEBREW)).ai });
    const skipped = await analyzePost(again, ENGLISH, undefined, result.geminiError);
    expect(skipped.provider).toBe("workers-ai");
    expect(again.calls).toEqual([]);
  });

  it("uses Workers AI when every Gemini model is out of daily quota", async () => {
    const daily = () =>
      new Response(
        JSON.stringify({
          error: {
            code: 429,
            message: "Quota exceeded for metric: generate_content_free_tier_requests, limit: 20",
            details: [{ violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }] }],
          },
        }),
        { status: 429 },
      );
    const workers = fakeAi(() => aiReply(HEBREW));
    const ctx = testCtx({ [GEMINI]: daily }, {}, { ai: workers.ai });
    const result = await analyzePost(ctx, ENGLISH);
    expect(result).toMatchObject({ translated: true, provider: "workers-ai", hebrew: HEBREW });
    expect(result.quotaExhausted).toBeUndefined();
    expect(ctx.calls.map(modelOf)).toEqual([PRIMARY, FALLBACK]);
    expect(workers.prompts).toHaveLength(1);
  });

  it("stays untranslated, and says so once, when Gemini and Workers AI both echo", async () => {
    const echo = answer({ hebrew: ENGLISH, categories: [], impact: "low" });
    const workers = fakeAi(() => aiReply(ENGLISH));
    const ctx = testCtx({ [GEMINI]: byModel(echo, echo) }, {}, { ai: workers.ai });
    const result = await analyzePost(ctx, ENGLISH);
    expect(result).toMatchObject({ translated: false, provider: "", hebrew: ENGLISH, deterministic: true });
    expect(result.geminiError).toContain("workers-ai: untranslated text");
    const retry = testCtx({ [GEMINI]: byModel(echo, echo) }, {}, { ai: fakeAi(() => aiReply(HEBREW)).ai });
    const second = await analyzePost(retry, ENGLISH, undefined, result.geminiError);
    expect(second.deterministic).toBe(true);
    expect(retry.calls).toEqual([]);
    expect(second.geminiError).toContain("workers-ai: skipped — earlier untranslated text");
  });

  it("records a Workers AI transport failure without treating it as an echo", async () => {
    const workers = fakeAi(() => {
      throw new Error("inference failed");
    });
    const ctx = testCtx({ [GEMINI]: fail503 }, {}, { ai: workers.ai });
    const result = await analyzePost(ctx, ENGLISH);
    expect(result.translated).toBe(false);
    expect(result.deterministic).toBeUndefined();
    expect(result.geminiError).toContain("workers-ai: inference failed");
  });

  it("does not spend a call on boost labels", async () => {
    const workers = fakeAi(() => aiReply(HEBREW));
    const ctx = testCtx({ [GEMINI]: good }, {}, { ai: workers.ai });
    for (const text of ["RT @realDonaldTrump", "Reposted Donald J. Trump"]) {
      expect(await analyzePost(ctx, text)).toMatchObject({ provider: "none", translated: true });
    }
    expect(ctx.calls).toEqual([]);
    expect(workers.prompts).toEqual([]);
  });

  it("retries a 5xx once per model", async () => {
    const ctx = testCtx({ [GEMINI]: fail503 });
    await analyzePost(ctx, ENGLISH);
    expect(ctx.calls.map(modelOf)).toEqual([PRIMARY, PRIMARY, FALLBACK, FALLBACK]);
    expect(ctx.sleeps).toEqual([2000, 2000]);
  });

  it("retries without the thinking setting when a model rejects it", async () => {
    const ctx = testCtx(
      {
        [GEMINI]: (call) =>
          JSON.parse(call.body).generationConfig.thinkingConfig
            ? new Response('{"error":{"message":"thinking_level is not supported for this model"}}', {
                status: 400,
              })
            : good(),
      },
      { geminiThinkingLevel: "low", geminiModel: PRIMARY, geminiFallbackModel: "" },
    );
    expect(await analyzePost(ctx, ENGLISH)).toMatchObject({ translated: true, model: PRIMARY });
    expect(ctx.calls.map(modelOf)).toEqual([PRIMARY, PRIMARY]);
  });

  it("waits out a short 429 once", async () => {
    const ctx = testCtx({
      [GEMINI]: (_c, n) =>
        n === 0 ? new Response('{"error":{"details":[{"retryDelay":"4s"}]}}', { status: 429 }) : good(),
    });
    expect((await analyzePost(ctx, ENGLISH)).model).toBe(PRIMARY);
    expect(ctx.sleeps).toEqual([5000]);
  });

  it("caps each call at GEMINI_TIMEOUT_SECONDS and keeps time back for sending", async () => {
    let t = 0;
    const ctx = testCtx(
      { [GEMINI]: good },
      { geminiTimeoutMs: 12_000, runTimeBudgetMs: 90_000 },
      { now: () => t },
    );
    t = 75_000; // 15 s left: 15 - 8 s reserve = 7 s for this call
    const timeouts: number[] = [];
    const http = ctx.http.bind(ctx);
    ctx.http = (url, init) => {
      timeouts.push(init?.timeoutMs ?? 0);
      return http(url, init);
    };
    await analyzePost(ctx, ENGLISH);
    expect(timeouts).toEqual([7_000]);
  });

  it("reports 'out of time' (not a failure) when the run has no time left for a call", async () => {
    let t = 0;
    const ctx = testCtx({ [GEMINI]: good }, { runTimeBudgetMs: 90_000 }, { now: () => t });
    t = 85_000;
    expect(await analyzePost(ctx, ENGLISH)).toMatchObject({ translated: false, outOfTime: true });
    expect(ctx.calls).toEqual([]);
  });

  it("needs no Gemini for text without words, and fails cleanly without a key", async () => {
    const ctx = testCtx({ [GEMINI]: good });
    expect(await analyzePost(ctx, "🇺🇸🇺🇸 100%")).toMatchObject({ translated: true, provider: "none" });
    const noKey = testCtx({ [GEMINI]: good }, { geminiApiKey: "" });
    expect(await analyzePost(noKey, ENGLISH)).toMatchObject({
      translated: false,
      geminiError: "GEMINI_API_KEY not set",
    });
    expect([...ctx.calls, ...noKey.calls]).toEqual([]);
  });
});

describe("translation checks", () => {
  it("rejects empty and still-English answers, accepts short slogans and kept names", () => {
    expect(looksTranslated(ENGLISH, "")).toBe(false);
    expect(looksTranslated(ENGLISH, ENGLISH)).toBe(false);
    expect(looksTranslated(ENGLISH, HEBREW)).toBe(true);
    expect(looksTranslated(ENGLISH, `${HEBREW} @realDonaldTrump Donald Trump`)).toBe(true);
    expect(looksTranslated("MAGA!", "MAGA!")).toBe(true);
    expect(looksTranslated("RT @realDonaldTrump", "RT @realDonaldTrump")).toBe(true);
    expect(looksTranslated("Reposted Donald J. Trump", "Reposted Donald J. Trump")).toBe(false);
    expect(needsTranslation("https://x.com 🇺🇸")).toBe(false);
    expect(needsTranslation("RT @realDonaldTrump")).toBe(false);
  });

  it("detects every Arabic block the validator is required to catch", () => {
    expect(hasArabicScript("בשל אמוני")).toBe(false);
    expect(hasArabicScript("ישני עונג להכריז ש")).toBe(false);
    expect(hasArabicScript("טוהר הבחירות")).toBe(false);
    expect(hasArabicScript("ויווק רמאסוואמי (Vivek Ramaswamy)")).toBe(false);
    expect(hasArabicScript(MIXED)).toBe(true);
    expect(hasArabicScript("רמאסוא\u0645\u064A")).toBe(true); // Ramaswamy, Hebrew then Arabic
    expect(hasArabicScript("ש\u0750")).toBe(true); // Arabic Supplement
    expect(hasArabicScript("\u08A0")).toBe(true); // Arabic Extended-A
    expect(hasArabicScript("\u08FF")).toBe(true);
    expect(hasArabicScript("\uFB50")).toBe(true); // Presentation Forms-A
    expect(hasArabicScript("\uFE8D")).toBe(true); // Presentation Forms-B
    expect(hasArabicScript("\uFEFF")).toBe(true);
    expect(isArabicCodePoint(0x05ff)).toBe(false);
    expect(isArabicCodePoint(0x0600)).toBe(true);
    expect(isArabicCodePoint(0x06ff)).toBe(true);
    expect(isArabicCodePoint(0x0750)).toBe(true);
    expect(isArabicCodePoint(0x077f)).toBe(true);
    expect(isArabicCodePoint(0x089f)).toBe(false);
    expect(isArabicCodePoint(0x08a0)).toBe(true);
    expect(isArabicCodePoint(0x08ff)).toBe(true);
    expect(isArabicCodePoint(0x0900)).toBe(false);
    expect(isArabicCodePoint(0xfb50)).toBe(true);
    expect(isArabicCodePoint(0xfdff)).toBe(true);
    expect(isArabicCodePoint(0xfe70)).toBe(true);
    expect(isArabicCodePoint(0xfeff)).toBe(true);
  });

  it("repairs Arabic letters used as Hebrew, keeps numbers, and strips the rest", () => {
    expect(repairArabicScript(MIXED)).toBe(REPAIRED);
    expect(repairArabicScript("בשל אמוני")).toBe("בשל אמוני");
    expect(repairArabicScript("Election Integrity 100%")).toBe("Election Integrity 100%");
    expect(repairArabicScript("\u0661\u0662\u0663")).toBe("123");
    expect(repairArabicScript("\u06F5")).toBe("5");
    expect(repairArabicScript("\uFE8D\u0644")).toBe("אל");
    expect(repairArabicScript("ש\u0750לום")).toBe("שלום");
    expect(repairArabicScript("ש\u08A0לום")).toBe("שלום");
    expect(hasArabicScript(repairArabicScript(`${MIXED}\u0750\u08A0\uFE70`))).toBe(false);
  });

  it("replaces Arabic letters inside a word and drops a word that is only Arabic", () => {
    expect(sanitizeArabicWords(MIXED)).toBe(REPAIRED);
    expect(sanitizeArabicWords("בשל אמוני")).toBe("בשל אמוני");
    expect(sanitizeArabicWords("ויווק רמאסוא\u0645\u064A נאם")).toBe("ויווק רמאסואמי נאם");
    expect(hasArabicScript(sanitizeArabicWords("ויווק רמאסוא\u0645\u064A נאם"))).toBe(false);
    expect(sanitizeArabicWords("שלום \u08A0\u08FF עולם")).toBe("שלום עולם");
    expect(sanitizeArabicWords("שלום\n\u08A0 עולם")).toBe("שלום\nעולם");
    expect(sanitizeArabicWords("\u08A0")).toBe("");
    expect(sanitizeArabicWords("Election Integrity 100%")).toBe("Election Integrity 100%");
  });
});

describe("Arabic script in a translation", () => {
  const mixed = () => answer({ hebrew: MIXED, categories: ["other"], impact: "low" })();
  const clean = () => answer({ hebrew: CLEAN_PARTY, categories: ["other"], impact: "low" })();

  it("retries the same model once with a stricter prompt, and does not call the fallback", async () => {
    let n = 0;
    const ctx = testCtx({
      [GEMINI]: () => (++n === 1 ? mixed() : clean()),
    });
    const result = await analyzePost(ctx, ENGLISH);
    expect(result).toMatchObject({
      translated: true,
      provider: "gemini",
      model: PRIMARY,
      hebrew: CLEAN_PARTY,
    });
    expect(result.geminiError).toContain(`${PRIMARY}: arabic script in translation`);
    expect(ctx.calls.map(modelOf)).toEqual([PRIMARY, PRIMARY]);
    const first = JSON.parse(ctx.calls[0]?.body ?? "{}");
    const retry = JSON.parse(ctx.calls[1]?.body ?? "{}");
    expect(first.systemInstruction.parts[0].text).not.toContain("previous translation was invalid");
    expect(retry.systemInstruction.parts[0].text).toContain("previous translation was invalid");
    expect(retry.systemInstruction.parts[0].text).toContain("Hebrew only");
    expect(retry.systemInstruction.parts[0].text).toContain("Transliterate");
    expect(retry.systemInstruction.parts[0].text).not.toContain("Do not transliterate");
  });

  it("asks the fallback model after the strict retry still mixes scripts", async () => {
    const ctx = testCtx({ [GEMINI]: byModel(mixed, clean) });
    const result = await analyzePost(ctx, ENGLISH);
    expect(result).toMatchObject({
      translated: true,
      provider: "gemini",
      model: FALLBACK,
      hebrew: CLEAN_PARTY,
    });
    expect(result.geminiError).toContain(`${PRIMARY}: arabic script in translation`);
    expect(ctx.calls.map(modelOf)).toEqual([PRIMARY, PRIMARY, FALLBACK]);
    const retry = JSON.parse(ctx.calls[1]?.body ?? "{}");
    const fallback = JSON.parse(ctx.calls[2]?.body ?? "{}");
    expect(retry.systemInstruction.parts[0].text).toContain("previous translation was invalid");
    expect(fallback.systemInstruction.parts[0].text).toContain("previous translation was invalid");
    expect(fallback.systemInstruction.parts[0].text).toContain("Hebrew only");
  });

  it("replaces Arabic words when the strict retry and the fallback still mix scripts", async () => {
    const ctx = testCtx({ [GEMINI]: mixed });
    const result = await analyzePost(ctx, ENGLISH);
    expect(result).toMatchObject({ translated: true, provider: "gemini", model: FALLBACK, hebrew: REPAIRED });
    expect(hasArabicScript(result.hebrew)).toBe(false);
    expect(result.geminiError).toContain(`${FALLBACK}: arabic script repaired`);
    expect(ctx.calls.map(modelOf)).toEqual([PRIMARY, PRIMARY, FALLBACK]);
  });

  it("retries once when Arabic Extended-A slips into a name, then keeps the clean retry", async () => {
    const extended = () =>
      answer({ hebrew: "ויווק רמאסווא\u08A0י (Vivek Ramaswamy)", categories: ["other"], impact: "low" })();
    const cleanName = () =>
      answer({ hebrew: "ויווק רמאסוואמי (Vivek Ramaswamy)", categories: ["other"], impact: "low" })();
    let n = 0;
    const ctx = testCtx(
      { [GEMINI]: () => (++n === 1 ? extended() : cleanName()) },
      { geminiFallbackModel: "" },
    );
    const result = await analyzePost(ctx, ENGLISH);
    expect(result).toMatchObject({
      translated: true,
      model: PRIMARY,
      hebrew: "ויווק רמאסוואמי (Vivek Ramaswamy)",
    });
    expect(hasArabicScript(result.hebrew)).toBe(false);
    expect(ctx.calls.map(modelOf)).toEqual([PRIMARY, PRIMARY]);
  });

  it("asks the fallback again, strictly, when that model was the one that mixed scripts", async () => {
    const daily = () =>
      new Response(
        JSON.stringify({
          error: {
            details: [{ violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }] }],
          },
        }),
        { status: 429 },
      );
    let lite = 0;
    const ctx = testCtx({
      [GEMINI]: (call) => {
        if (modelOf(call) === PRIMARY) return daily();
        lite += 1;
        return lite === 1 ? mixed() : clean();
      },
    });
    const result = await analyzePost(ctx, ENGLISH);
    expect(result).toMatchObject({ translated: true, model: FALLBACK, hebrew: CLEAN_PARTY });
    expect(ctx.calls.map(modelOf)).toEqual([PRIMARY, FALLBACK, FALLBACK]);
    expect(JSON.parse(ctx.calls[1]?.body ?? "{}").systemInstruction.parts[0].text).not.toContain(
      "previous translation was invalid",
    );
    expect(JSON.parse(ctx.calls[2]?.body ?? "{}").systemInstruction.parts[0].text).toContain(
      "previous translation was invalid",
    );
  });

  it("retries the only configured model strictly, then repairs", async () => {
    const ctx = testCtx({ [GEMINI]: mixed }, { geminiFallbackModel: "" });
    const result = await analyzePost(ctx, ENGLISH);
    expect(result).toMatchObject({ translated: true, model: PRIMARY, hebrew: REPAIRED });
    expect(ctx.calls.map(modelOf)).toEqual([PRIMARY, PRIMARY]);
    expect(JSON.parse(ctx.calls[1]?.body ?? "{}").systemInstruction.parts[0].text).toContain(
      "previous translation was invalid",
    );
    expect(JSON.parse(ctx.calls[1]?.body ?? "{}").systemInstruction.parts[0].text).toContain("Transliterate");
  });

  it("repairs Arabic script from Workers AI without publishing it", async () => {
    const workers = fakeAi(() => aiReply(MIXED));
    const ctx = testCtx({ [GEMINI]: fail503 }, {}, { ai: workers.ai });
    const result = await analyzePost(ctx, ENGLISH);
    expect(result).toMatchObject({
      translated: true,
      provider: "workers-ai",
      model: "@cf/zai-org/glm-4.7-flash",
      hebrew: REPAIRED,
    });
    expect(hasArabicScript(result.hebrew)).toBe(false);
    expect(result.geminiError).toContain("workers-ai: arabic script repaired");
  });
});

describe("Workers AI answers", () => {
  it("reads the chat content and ignores reasoning, fences, and truncation", () => {
    expect(extractWorkersAiText(aiReply(HEBREW)).text).toBe(HEBREW);
    expect(extractWorkersAiText({ response: `"${HEBREW}"` }).text).toBe(HEBREW);
    expect(extractWorkersAiText({ result: { response: `\`\`\`\n${HEBREW}\n\`\`\`` } }).text).toBe(HEBREW);
    expect(
      extractWorkersAiText({
        choices: [{ finish_reason: "stop", message: { content: `{"hebrew":"${HEBREW}"}` } }],
      }).text,
    ).toBe(HEBREW);
    expect(extractWorkersAiText(aiReply(HEBREW, "length"))).toEqual({ text: HEBREW, truncated: true });
    expect(
      extractWorkersAiText({
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: [
                { type: "reasoning", text: ENGLISH },
                { type: "text", text: HEBREW },
              ],
            },
          },
        ],
      }).text,
    ).toBe(HEBREW);
    expect(extractWorkersAiText(null)).toEqual({ text: "", truncated: false });
  });

  it("forwards a chat request through the binding", async () => {
    const seen: { model: string; input: Record<string, unknown> }[] = [];
    const ai = {
      run: async (model: string, input: Record<string, unknown>) => {
        seen.push({ model, input });
        return aiReply(HEBREW);
      },
    } as unknown as Ai;
    const client = bindWorkersAi(ai);
    await client.run("@cf/zai-org/glm-4.7-flash", {
      messages: [{ role: "user", content: ENGLISH }],
      chat_template_kwargs: { enable_thinking: false },
    });
    expect(seen[0]?.model).toBe("@cf/zai-org/glm-4.7-flash");
    expect(seen[0]?.input.chat_template_kwargs).toEqual({ enable_thinking: false });
  });
});
