/**
 * Cases reported from the dry run on 2026-10-11, using the real posts.
 */
import { describe, expect, it } from "vitest";
import { buildMessage } from "../src/message";
import { analyzePost, finalTags, keywordCategories } from "../src/tagging";
import { GEMINI, geminiAnswer, json, testCtx } from "./helpers";


const CEASEFIRE =
  "Effective immediately, there is an ENERGY CEASEFIRE in the War between Russia and Ukraine. Both parties have agreed. Do not break it! Thank you for your attention to this matter. President DONALD J. TRUMP";
const CEASEFIRE_HE = "בתוקף מיידי, יש הפסקת אש באנרגיה במלחמה בין רוסיה לאוקראינה. שני הצדדים הסכימו.";

describe("1. market-impact tagging: the ENERGY CEASEFIRE post", () => {
  it("keywords find energy and geopolitics", () => {
    expect(keywordCategories(CEASEFIRE)).toEqual(["oil", "geopolitics"]);
  });

  it("gets 🟠 even when Gemini fails (on Oct 11 it went out #כללי with no impact)", async () => {
    const ctx = testCtx({ [GEMINI]: () => new Response("overloaded", { status: 503 }) });
    const a = await analyzePost(ctx, CEASEFIRE);
    expect(a).toMatchObject({ translated: false, categories: ["oil", "geopolitics"], impact: "medium" });
    const msg = buildMessage({ id: "1", text: CEASEFIRE, createdAt: "", url: "" }, a);
    expect(msg.split("\n")[0]).toBe("🟠 השפעה בינונית על השווקים · #נפט_ואנרגיה #גאופוליטיקה");
  });

  it("gets 🟠 even if Gemini wrongly answers other/low", async () => {
    const ctx = testCtx({ [GEMINI]: () => json(geminiAnswer({ hebrew: CEASEFIRE_HE, categories: ["other"], impact: "low" })) });
    expect(await analyzePost(ctx, CEASEFIRE)).toMatchObject({ categories: ["oil", "geopolitics"], impact: "medium" });
  });

  it("keeps 🔴 when Gemini rates it high", async () => {
    const ctx = testCtx({
      [GEMINI]: () => json(geminiAnswer({ hebrew: CEASEFIRE_HE, categories: ["geopolitics", "oil"], impact: "high" })),
    });
    const a = await analyzePost(ctx, CEASEFIRE);
    expect(a.impact).toBe("high");
    expect(buildMessage({ id: "1", text: CEASEFIRE, createdAt: "", url: "" }, a).startsWith("🔴")).toBe(true);
  });

  it.each([
    ["Russia and Ukraine have agreed to a ceasefire", "geopolitics"],
    ["New sanctions on Iran, effective tomorrow", "geopolitics"],
    ["Peace deal signed with the Kremlin", "geopolitics"],
    ["Energy prices are coming DOWN, drill baby drill", "oil"],
    ["Tariffs on Canada go up to 35%", "tariffs"],
    ["The Fed must cut interest rates now", "fed_rates"],
  ])("never lets a market topic be ⚪ or unrated: %s", (text, topic) => {
    for (const geminiImpact of [null, "low"] as const) {
      const tags = finalTags([], geminiImpact, text);
      expect(tags.categories).toContain(topic);
      expect(tags.impact).toBe("medium");
    }
  });

  it("does not inflate ordinary posts", () => {
    const columbus =
      "HAPPY COLUMBUS DAY TO ALL, in particular our great Italian American Community which was forced to suffer";
    expect(finalTags(["other"], "low", columbus)).toEqual({ categories: ["other"], impact: "low" });
    // Trump's favourite non-market uses of these words.
    for (const text of ["Tremendous energy at the rally tonight!", "The Fake News is at war with the truth"]) {
      expect(finalTags([], null, text).categories).toEqual(["other"]);
    }
  });
});
