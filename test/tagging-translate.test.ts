import { describe, expect, it } from "vitest";
import { analyzePost, keywordCategories, parseMarketTags } from "../src/tagging";
import { extractClients5Text, translateToHebrew } from "../src/translate";
import { CLIENTS5, GEMINI, GTX, MYMEMORY, geminiAnswer, json, testCtx } from "./helpers";

const ENGLISH = "I am raising Tariffs on China to 100%, effective November 1st!";
const HEBREW = "אני מעלה את המכסים על סין ל-100%, החל מ-1 בנובמבר!";
const gtxOk = () => json([[[HEBREW, ENGLISH]]]);
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

describe("analyzePost", () => {
  const answer = (data: unknown, finish?: string, thought?: string) => () => json(geminiAnswer(data, finish, thought));

  it("translates and tags with one Gemini call", async () => {
    const ctx = testCtx({ [GEMINI]: answer({ hebrew: HEBREW, categories: ["tariffs", "china"], impact: "high" }) });
    expect(await analyzePost(ctx, ENGLISH)).toEqual({
      hebrew: HEBREW,
      translated: true,
      categories: ["tariffs", "china"],
      impact: "high",
      provider: "gemini",
    });
    expect(ctx.hosts()).toEqual([GEMINI]);
  });

  it("sends a well-formed request with the key in a header", async () => {
    const ctx = testCtx({ [GEMINI]: answer({ hebrew: HEBREW, categories: [], impact: "low" }) }, { geminiThinkingLevel: "low" });
    await analyzePost(ctx, ENGLISH);
    const call = ctx.calls[0];
    expect(call?.url).toContain("/models/gemini-3.8-flash:generateContent");
    expect(call?.url).not.toContain("test-gemini-key");
    expect(call?.headers.get("x-goog-api-key")).toBe("test-gemini-key");
    const body = JSON.parse(call?.body ?? "{}");
    expect(body.systemInstruction.parts[0].text).toContain("Hebrew");
    expect(body.contents[0].parts[0].text).toBe(ENGLISH);
    expect(body.generationConfig).toMatchObject({
      responseMimeType: "application/json",
      thinkingConfig: { thinkingLevel: "low" },
    });
    expect(Object.keys(body.generationConfig.responseSchema.properties)).toEqual(["hebrew", "categories", "impact"]);
  });

  it("ignores thought parts", async () => {
    const ctx = testCtx({ [GEMINI]: answer({ hebrew: HEBREW, categories: ["oil"], impact: "low" }, "STOP", "thinking…") });
    expect((await analyzePost(ctx, ENGLISH)).hebrew).toBe(HEBREW);
  });

  it("uses keyword topics (and no impact) when Gemini's tags are invalid", async () => {
    const ctx = testCtx({ [GEMINI]: answer({ hebrew: HEBREW, categories: ["weather"], impact: "high" }) });
    expect(await analyzePost(ctx, ENGLISH)).toMatchObject({ categories: ["tariffs", "china"], impact: null });
  });

  it.each([
    ["an HTTP error", fail503],
    ["a truncated answer", answer({ hebrew: "המכסים" }, "MAX_TOKENS")],
    ["an English echo", answer({ hebrew: ENGLISH, categories: [], impact: "low" })],
    ["non-JSON text", answer("Sure! Here is the translation")],
    ["a blocked prompt", () => json({ promptFeedback: { blockReason: "SAFETY" } })],
  ])("falls back to the free chain after %s", async (_name, gemini) => {
    const ctx = testCtx({ [GEMINI]: gemini, [GTX]: gtxOk });
    expect(await analyzePost(ctx, ENGLISH)).toEqual({
      hebrew: HEBREW,
      translated: true,
      categories: ["tariffs", "china"],
      impact: null,
      provider: "free",
    });
    expect(ctx.hosts()).toEqual([GEMINI, GTX]);
  });

  it("waits out a short Gemini 429 once", async () => {
    const ctx = testCtx({
      [GEMINI]: (_c, n) =>
        n === 0
          ? new Response('{"error":{"details":[{"retryDelay":"4s"}]}}', { status: 429 })
          : json(geminiAnswer({ hebrew: HEBREW, categories: ["oil"], impact: "low" })),
    });
    expect((await analyzePost(ctx, ENGLISH)).provider).toBe("gemini");
    expect(ctx.sleeps).toEqual([5000]);
  });

  it("doesn't wait out a long Gemini 429", async () => {
    const ctx = testCtx({
      [GEMINI]: () => new Response('{"retryDelay":"3600s"}', { status: 429 }),
      [GTX]: gtxOk,
    });
    expect((await analyzePost(ctx, ENGLISH)).provider).toBe("free");
    expect(ctx.sleeps).toEqual([]);
  });

  it("skips Gemini without a key", async () => {
    const ctx = testCtx({ [GTX]: gtxOk }, { geminiApiKey: "" });
    expect((await analyzePost(ctx, ENGLISH)).provider).toBe("free");
    expect(ctx.hosts()).toEqual([GTX]);
  });

  it("reports when everything fails", async () => {
    const ctx = testCtx({});
    expect(await analyzePost(ctx, ENGLISH)).toMatchObject({ hebrew: ENGLISH, translated: false, provider: "" });
  });
});

describe("free translation chain", () => {
  it("tries each provider in order until one returns Hebrew", async () => {
    const ctx = testCtx({
      [GTX]: fail503,
      [CLIENTS5]: () => json({ sentences: [{ trans: "Not Hebrew at all, sorry" }] }),
      [MYMEMORY]: () => json({ responseData: { translatedText: HEBREW } }),
    });
    expect(await translateToHebrew(ctx, ENGLISH)).toEqual({ text: HEBREW, translated: true, provider: "mymemory" });
    expect(ctx.hosts()[0]).toBe(GTX);
    expect(ctx.hosts()[1]).toBe(CLIENTS5);
    expect(ctx.hosts().at(-1)).toBe(MYMEMORY);
  });

  it("uses a Lingva instance", async () => {
    const ctx = testCtx({ "lingva.ml": () => json({ translation: HEBREW }) });
    expect((await translateToHebrew(ctx, ENGLISH)).provider).toBe("lingva");
  });

  it("rejects MyMemory's quota notice", async () => {
    const ctx = testCtx({
      [MYMEMORY]: () => json({ responseData: { translatedText: "MYMEMORY WARNING: YOU USED ALL AVAILABLE FREE TRANSLATIONS" } }),
    });
    expect((await translateToHebrew(ctx, ENGLISH)).translated).toBe(false);
  });

  it("rejects a provider that translates only some chunks", async () => {
    const text = `${"First sentence about the economy today. ".repeat(70)}\n`.repeat(2);
    const ctx = testCtx({
      [GTX]: (_c, n) => json(n === 0 ? [[[HEBREW, "x"]]] : [[["English again and again", "x"]]]),
    });
    expect(await translateToHebrew(ctx, text)).toEqual({ text, translated: false, provider: "" });
  });

  it("stops when the subrequest budget runs out", async () => {
    const ctx = testCtx({ [GTX]: fail503 }, { maxSubrequests: 1 });
    expect((await translateToHebrew(ctx, ENGLISH)).translated).toBe(false);
    expect(ctx.calls).toHaveLength(1);
  });

  it("needs no provider for text without words", async () => {
    const ctx = testCtx({});
    expect(await translateToHebrew(ctx, "   ")).toEqual({ text: "   ", translated: true, provider: "" });
    expect(ctx.calls).toHaveLength(0);
  });

  it("reads every clients5 response shape", () => {
    for (const shape of ["שלום", ["שלום"], [["שלום", "hello"]], { sentences: [{ trans: "שלום" }] }]) {
      expect(extractClients5Text(shape)).toBe("שלום");
    }
    expect(extractClients5Text({ other: 1 })).toBeNull();
    expect(extractClients5Text(5)).toBeNull();
  });
});
