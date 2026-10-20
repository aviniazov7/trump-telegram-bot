/**
 * Daily free-tier quota (Oct 12): gemini-3.8-flash answered 429 "per day"
 * while flash-lite still worked. Flash is the primary translator. A model
 * out of daily quota is skipped until the reset and flash-lite takes over,
 * so the bot stays inside the free tier. When all are out, posts go out
 * without a pointless wait.
 */
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { runCron } from "../src/broadcast";
import { msUntilQuotaReset, parseQuotaInfo } from "../src/gemini";
import { resetMemoryMutes } from "../src/monitor";
import { emptyMeta, openStore } from "../src/store";
import { analyzePost } from "../src/tagging";
import { type Call, GEMINI, geminiAnswer, json, RSS_HOST, rssFeed, TELEGRAM, testCtx } from "./helpers";

const LITE = "gemini-3.5-flash-lite";
const FLASH = "gemini-3.8-flash";
const ENGLISH = "I am raising Tariffs on China to 100%, effective November 1st!";
const HEBREW = "אני מעלה את המכסים על סין ל-100%!";
const modelOf = (call: Call) => /models\/([^:]+):/.exec(call.url)?.[1];

// Shape of Google's 429 body for a per-day free-tier quota.
const DAILY_429 = JSON.stringify({
  error: {
    code: 429,
    message:
      "You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits. To monitor your current usage, head to: https://ai.dev/rate-limit. \n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 20, model: gemini-3.8-flash",
    status: "RESOURCE_EXHAUSTED",
    details: [
      {
        "@type": "type.googleapis.com/google.rpc.QuotaFailure",
        violations: [
          {
            quotaMetric: "generativelanguage.googleapis.com/generate_content_free_tier_requests",
            quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier",
            quotaDimensions: { location: "global", model: "gemini-3.8-flash" },
            quotaValue: "20",
          },
        ],
      },
    ],
  },
});
const MINUTE_429 = JSON.stringify({
  error: {
    code: 429,
    details: [
      { quotaId: "GenerateRequestsPerMinutePerProjectPerModel-FreeTier" },
      { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "40s" },
    ],
  },
});
const ok = () => json(geminiAnswer({ hebrew: HEBREW, categories: ["tariffs"], impact: "high" }));
const daily = () => new Response(DAILY_429, { status: 429 });

const store = openStore(env);
beforeEach(async () => {
  for (const { name } of (await env.STATE.list()).keys) await env.STATE.delete(name);
  await env.COORDINATOR.getByName("cron").reset();
  resetMemoryMutes();
});
const tracker = {
  exhausted: (m: string) => store.geminiQuotaExhausted(m),
  markExhausted: (m: string, r: string, s: number) => store.markGeminiQuotaExhausted(m, r, s),
};

describe("parseQuotaInfo", () => {
  it("tells a per-day quota from a per-minute one", () => {
    expect(parseQuotaInfo(DAILY_429)).toEqual({
      scope: "day",
      quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier",
    });
    expect(parseQuotaInfo(MINUTE_429)).toEqual({
      scope: "minute",
      quotaId: "GenerateRequestsPerMinutePerProjectPerModel-FreeTier",
    });
    expect(parseQuotaInfo('{"error":{"code":429}}').scope).toBe("unknown");
  });
});

describe("msUntilQuotaReset", () => {
  it("counts to midnight Pacific (10:00 in Israel in October)", () => {
    // 2026-10-12 19:05 UTC = 12:05 PDT → 11 h 55 min to midnight.
    expect(msUntilQuotaReset(Date.UTC(2026, 9, 12, 19, 5))).toBe((11 * 60 + 55) * 60_000);
    // Winter: 2026-12-01 08:30 UTC = 00:30 PST → 23 h 30 min.
    expect(msUntilQuotaReset(Date.UTC(2026, 11, 1, 8, 30))).toBe((23 * 60 + 30) * 60_000);
  });
});

describe("daily quota tracking", () => {
  it("uses full flash as the primary model and flash-lite only as the fallback", async () => {
    const ctx = testCtx({ [GEMINI]: ok });
    expect(await analyzePost(ctx, ENGLISH, tracker)).toMatchObject({ translated: true, model: FLASH });
    expect(ctx.calls.map(modelOf)).toEqual([FLASH]);
  });

  it("marks a model out of daily quota until the reset and stops calling it", async () => {
    const at = Date.UTC(2026, 9, 12, 19, 5);
    const first = testCtx(
      { [GEMINI]: (c) => (modelOf(c) === FLASH ? daily() : ok()) },
      {},
      { now: () => at },
    );
    const a = await analyzePost(first, ENGLISH, tracker);
    expect(a).toMatchObject({ translated: true, model: LITE });
    expect(a.geminiError).toContain(
      "daily quota exhausted (GenerateRequestsPerDayPerProjectPerModel-FreeTier)",
    );
    expect(await store.geminiQuotaExhausted(FLASH)).toContain("daily quota");
    // KV sets the expiry from the real clock: the TTL must be the time to the reset.
    const key = (await env.STATE.list({ prefix: "gemini-quota:" })).keys[0];
    const ttl = (key?.expiration ?? 0) - Date.now() / 1000;
    expect(Math.abs(ttl - msUntilQuotaReset(at) / 1000)).toBeLessThan(5);

    const second = testCtx({ [GEMINI]: ok }, {}, { now: () => at + 60_000 });
    await analyzePost(second, ENGLISH, tracker);
    expect(second.calls.map(modelOf)).toEqual([LITE]); // flash skipped, no wasted call
  });

  it("does not mark a per-minute 429 as daily", async () => {
    const ctx = testCtx({ [GEMINI]: () => new Response(MINUTE_429, { status: 429 }) });
    const a = await analyzePost(ctx, ENGLISH, tracker);
    expect(a.quotaExhausted).toBeUndefined();
    expect(await store.geminiQuotaExhausted(FLASH)).toBeNull();
    expect(await store.geminiQuotaExhausted(LITE)).toBeNull();
    expect(a.geminiError).toContain("minute quota GenerateRequestsPerMinutePerProjectPerModel-FreeTier");
  });

  it("when every model is out of daily quota: sends in English right away, with one ⛽ alert", async () => {
    const NOW = Date.UTC(2026, 9, 12, 19, 5);
    await store.putMeta({ ...emptyMeta(), lastSeen: "1", lastSuccess: NOW, menu: "x" });
    await store.putSubscriber("a", null);
    const sent: { chat: string; text: string }[] = [];
    const ctx = testCtx(
      {
        [RSS_HOST]: () => new Response(rssFeed(["2", "1"], (id) => `${ENGLISH} number-${id}`)),
        [TELEGRAM]: (call) => {
          const body = JSON.parse(call.body || "{}");
          if (body.text) sent.push({ chat: String(body.chat_id), text: body.text });
          return json({ ok: true, result: {} });
        },
        [GEMINI]: daily,
      },
      { maxSubrequests: 200 },
      { now: () => NOW },
    );
    await runCron(ctx, store);
    const toA = sent.filter((s) => s.chat === "a");
    expect(toA).toHaveLength(1); // no 15-minute wait
    expect(toA[0]?.text).toContain("התרגום לעברית נכשל");
    expect(toA[0]?.text.split("\n")[0]).toContain("🟠"); // tariffs → impact floor
    const alerts = sent.filter((s) => s.chat === "999" && s.text.includes("המכסה היומית"));
    expect(alerts).toHaveLength(1);
    expect(ctx.calls.filter((c) => c.host === GEMINI).map(modelOf)).toEqual([FLASH, LITE]);
  });
});
