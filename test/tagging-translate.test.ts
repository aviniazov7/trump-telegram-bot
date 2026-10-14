import { describe, expect, it } from "vitest";
import type { WorkersAiChatInput } from "../src/runtime";
import { analyzePost, keywordCategories, parseMarketTags } from "../src/tagging";
import { looksTranslated, needsTranslation } from "../src/translate";
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

const PRIMARY = "gemini-3.5-flash-lite";
const FALLBACK = "gemini-3.8-flash";
const modelOf = (call: Call) => /models\/([^:]+):/.exec(call.url)?.[1];
const answer = (data: unknown, finish?: string, thought?: string) => () => json(geminiAnswer(data, finish, thought));
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
    expect(body.systemInstruction.parts[0].text).toContain("Hebrew");
    expect(body.generationConfig).toMatchObject({ responseMimeType: "application/json" });
    expect(body.generationConfig.thinkingConfig).toBeUndefined(); // lite
    expect(Object.keys(body.generationConfig.responseSchema.properties)).toEqual(["hebrew", "categories", "impact"]);
    expect(JSON.parse(fallback?.body ?? "{}").generationConfig.thinkingConfig).toEqual({ thinkingLevel: "low" });
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

  it("returns untranslated, with both models' reasons, when both fail and Workers AI is not configured", async () => {
    const ctx = testCtx({ [GEMINI]: fail503, [GTX]: () => json([[[HEBREW, ENGLISH]]]) });
    const result = await analyzePost(ctx, ENGLISH);
    expect(result).toMatchObject({ hebrew: ENGLISH, translated: false, provider: "", categories: ["tariffs", "china"], impact: "medium" });
    expect(result.geminiError).toMatch(new RegExp(`${PRIMARY}: HTTP 503.*\\| ${FALLBACK}: HTTP 503`));
    expect(result.deterministic).toBeUndefined();
    expect(ctx.hosts()).not.toContain(GTX);
    expect(ctx.ai).toBeUndefined();
  });

  it("does not call Workers AI when Gemini succeeds", async () => {
    const workers = fakeAi(() => aiReply(HEBREW));
    const ctx = testCtx({ [GEMINI]: good }, {}, { ai: workers.ai });
    expect(await analyzePost(ctx, ENGLISH)).toMatchObject({ translated: true, provider: "gemini", model: PRIMARY });
    expect(workers.prompts).toEqual([]);
  });

  it("uses Workers AI after an English echo, and does not ask the echoing model again", async () => {
    const echo = answer({ hebrew: ENGLISH, categories: [], impact: "low" });
    const workers = fakeAi(() => aiReply(HEBREW));
    const ctx = testCtx({ [GEMINI]: byModel(echo, echo) }, {}, { ai: workers.ai });
    const result = await analyzePost(ctx, ENGLISH);
    expect(result).toMatchObject({ translated: true, provider: "workers-ai", model: "@cf/zai-org/glm-4.7-flash", hebrew: HEBREW });
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
            ? new Response('{"error":{"message":"thinking_level is not supported for this model"}}', { status: 400 })
            : good(),
      },
      { geminiThinkingLevel: "low", geminiModel: FALLBACK, geminiFallbackModel: "" },
    );
    expect(await analyzePost(ctx, ENGLISH)).toMatchObject({ translated: true, model: FALLBACK });
    expect(ctx.calls.map(modelOf)).toEqual([FALLBACK, FALLBACK]);
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
});

describe("Workers AI answers", () => {
  it("reads the chat content and ignores reasoning, fences, and truncation", () => {
    expect(extractWorkersAiText(aiReply(HEBREW)).text).toBe(HEBREW);
    expect(extractWorkersAiText({ response: `"${HEBREW}"` }).text).toBe(HEBREW);
    expect(extractWorkersAiText({ result: { response: `\`\`\`\n${HEBREW}\n\`\`\`` } }).text).toBe(HEBREW);
    expect(extractWorkersAiText({ choices: [{ finish_reason: "stop", message: { content: `{"hebrew":"${HEBREW}"}` } }] }).text).toBe(HEBREW);
    expect(extractWorkersAiText(aiReply(HEBREW, "length"))).toEqual({ text: HEBREW, truncated: true });
    expect(
      extractWorkersAiText({
        choices: [{ finish_reason: "stop", message: { content: [{ type: "reasoning", text: ENGLISH }, { type: "text", text: HEBREW }] } }],
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
