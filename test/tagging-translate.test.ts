import { describe, expect, it } from "vitest";
import { analyzePost, keywordCategories, parseMarketTags } from "../src/tagging";
import { looksTranslated, needsTranslation } from "../src/translate";
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
    const data = { categories: [" Tariffs ", "tariff", "Fed", "interest rates", "Stock-Market"], impact: " Medium " };
    expect(parseMarketTags(data)).toEqual({ categories: ["tariffs", "fed_rates", "stocks"], impact: "medium" });
  });

  it("drops unknown and non-string categories, and 'other' next to a real topic", () => {
    expect(parseMarketTags({ categories: ["weather", 5, null, "oil"] }).categories).toEqual(["oil"]);
    expect(parseMarketTags({ categories: ["other", "crypto"] }).categories).toEqual(["crypto"]);
    expect(parseMarketTags({ categories: ["other"] }).categories).toEqual(["other"]);
    expect(parseMarketTags({ categories: "oil", impact: "low" })).toEqual({ categories: ["oil"], impact: "low" });
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
const modelOf = (call: Call) => /models\/([^:]+):/.exec(call.url)?.[1];
const answer = (data: unknown, finish?: string, thought?: string) => () => json(geminiAnswer(data, finish, thought));
const good = answer({ hebrew: HEBREW, categories: ["tariffs", "china"], impact: "high" });
/** Route Gemini calls per model. */
const byModel = (primary: () => Response, fallback: () => Response) => (call: Call) =>
  modelOf(call) === FALLBACK ? fallback() : primary();

describe("analyzePost (Gemini only)", () => {
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

  it("sends a well-formed request: key in a header, thinking level on the primary only, capped timeout", async () => {
    const ctx = testCtx({ [GEMINI]: byModel(fail503, good) }, { geminiThinkingLevel: "low" });
    await analyzePost(ctx, ENGLISH);
    const [primary, , fallback] = ctx.calls;
    expect(primary?.url).toContain(`/models/${PRIMARY}:generateContent`);
    expect(primary?.url).not.toContain("test-gemini-key");
    expect(primary?.headers.get("x-goog-api-key")).toBe("test-gemini-key");
    const body = JSON.parse(primary?.body ?? "{}");
    expect(body.systemInstruction.parts[0].text).toContain("Hebrew");
    expect(body.generationConfig).toMatchObject({ responseMimeType: "application/json", thinkingConfig: { thinkingLevel: "low" } });
    expect(Object.keys(body.generationConfig.responseSchema.properties)).toEqual(["hebrew", "categories", "impact"]);
    expect(JSON.parse(fallback?.body ?? "{}").generationConfig.thinkingConfig).toBeUndefined();
  });

  it("ignores thought parts", async () => {
    const ctx = testCtx({ [GEMINI]: answer({ hebrew: HEBREW, categories: ["oil"], impact: "low" }, "STOP", "thinking…") });
    expect((await analyzePost(ctx, ENGLISH)).hebrew).toBe(HEBREW);
  });

  it("uses keyword topics when Gemini's tags are invalid (tariffs → at least 🟠)", async () => {
    const ctx = testCtx({ [GEMINI]: answer({ hebrew: HEBREW, categories: ["weather"], impact: "high" }) });
    expect(await analyzePost(ctx, ENGLISH)).toMatchObject({ categories: ["tariffs", "china"], impact: "medium" });
  });

  it.each([
    ["an HTTP error", fail503, "HTTP 503"],
    ["a truncated answer", answer({ hebrew: "המכסים" }, "MAX_TOKENS"), "finishReason=MAX_TOKENS"],
    ["an English echo", answer({ hebrew: ENGLISH, categories: [], impact: "low" }), "untranslated text"],
    ["non-JSON text", answer("Sure! Here is the translation"), "answer is not JSON"],
    ["a blocked prompt", () => json({ promptFeedback: { blockReason: "SAFETY" } }), "blockReason=SAFETY"],
    ["a timeout", () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    }, "timeout after 12s"],
  ])("falls back to the second model after %s, and reports why", async (_name, primary, reason) => {
    const ctx = testCtx({ [GEMINI]: byModel(primary, good) });
    const result = await analyzePost(ctx, ENGLISH);
    expect(result).toMatchObject({ translated: true, provider: "gemini", model: FALLBACK, hebrew: HEBREW });
    expect(result.geminiError).toContain(`${PRIMARY}: `);
    expect(result.geminiError).toContain(reason);
  });

  it("returns untranslated, with both models' reasons, when both fail — no other translator is tried", async () => {
    const ctx = testCtx({ [GEMINI]: fail503, [GTX]: () => json([[[HEBREW, ENGLISH]]]) });
    const result = await analyzePost(ctx, ENGLISH);
    expect(result).toMatchObject({ hebrew: ENGLISH, translated: false, provider: "", categories: ["tariffs", "china"], impact: "medium" });
    expect(result.geminiError).toMatch(new RegExp(`${PRIMARY}: HTTP 503.*\\| ${FALLBACK}: HTTP 503`));
    expect(ctx.hosts()).not.toContain(GTX);
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
            ? new Response('{"error":{"message":"thinking_level is not supported for this model"}}', { status: 400 })
            : good(),
      },
      { geminiThinkingLevel: "low" },
    );
    expect(await analyzePost(ctx, ENGLISH)).toMatchObject({ translated: true, model: PRIMARY });
    expect(ctx.calls.map(modelOf)).toEqual([PRIMARY, PRIMARY]);
  });

  it("waits out a short 429 once", async () => {
    const ctx = testCtx({
      [GEMINI]: (_c, n) => (n === 0 ? new Response('{"error":{"details":[{"retryDelay":"4s"}]}}', { status: 429 }) : good()),
    });
    expect((await analyzePost(ctx, ENGLISH)).model).toBe(PRIMARY);
    expect(ctx.sleeps).toEqual([5000]);
  });

  it("caps each call at GEMINI_TIMEOUT_SECONDS and keeps time back for sending", async () => {
    let t = 0;
    const ctx = testCtx({ [GEMINI]: good }, { geminiTimeoutMs: 12_000, runTimeBudgetMs: 90_000 }, { now: () => t });
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
    expect(await analyzePost(noKey, ENGLISH)).toMatchObject({ translated: false, geminiError: "GEMINI_API_KEY not set" });
    expect([...ctx.calls, ...noKey.calls]).toEqual([]);
  });
});

describe("translation checks", () => {
  it("rejects empty and still-English answers, accepts short slogans", () => {
    expect(looksTranslated(ENGLISH, "")).toBe(false);
    expect(looksTranslated(ENGLISH, ENGLISH)).toBe(false);
    expect(looksTranslated(ENGLISH, HEBREW)).toBe(true);
    expect(looksTranslated("MAGA!", "MAGA!")).toBe(true);
    expect(needsTranslation("https://x.com 🇺🇸")).toBe(false);
  });
});
