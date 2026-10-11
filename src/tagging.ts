/** Market-impact tagging, and the per-post analysis that combines it with translation. */
import { CATEGORY_KEYS, GEMINI_MAX_CHARS, GeminiError, IMPACT_LEVELS, geminiJson } from "./gemini";
import type { Ctx } from "./runtime";
import { looksTranslated, needsTranslation, translateToHebrew } from "./translate";

/** Machine keys → Hebrew hashtag labels, in display order. */
export const MARKET_CATEGORIES: Record<string, string> = {
  tariffs: "מכסים",
  fed_rates: "ריבית_הפד",
  oil: "נפט_ואנרגיה",
  geopolitics: "גאופוליטיקה",
  crypto: "קריפטו",
  china: "סין",
  stocks: "מניות",
  other: "כללי",
};

export const IMPACT_MARKERS: Record<string, string> = {
  high: "🔴 <b>השפעה גבוהה על השווקים</b>",
  medium: "🟠 השפעה בינונית על השווקים",
  low: "⚪ השפעה נמוכה על השווקים",
};

export type Impact = (typeof IMPACT_LEVELS)[number];

const CATEGORY_ALIASES: Record<string, string> = {
  tariff: "tariffs",
  trade: "tariffs",
  fed: "fed_rates",
  rates: "fed_rates",
  interest_rates: "fed_rates",
  "fed/rates": "fed_rates",
  energy: "oil",
  war: "geopolitics",
  ceasefire: "geopolitics",
  sanctions: "geopolitics",
  stock: "stocks",
  stock_market: "stocks",
};

/**
 * Topics found by keywords. Always merged with Gemini's answer (so a topic
 * Gemini misses still counts) and the only source when Gemini fails. Keywords
 * can't judge impact, so on their own they never earn a 🔴 — but see
 * IMPACT_FLOOR_TOPICS.
 */
const KEYWORD_CATEGORIES: [string, RegExp][] = [
  ["tariffs", /\btariffs?\b|\bduties\b|trade (?:deal|war|deficit)|reciprocal/i],
  ["fed_rates", /\bthe fed\b|federal reserve|\bpowell\b|interest rates?|rate cuts?/i],
  [
    "oil",
    /\boil\b|\bopec\b|\bcrude\b|gasoline|drill(?:ing)?\b|\bnatural gas\b|\blng\b|pipelines?\b|\benergy (?:ceasefire|prices?|supply|supplies|infrastructure|exports?|imports?|sector|emergency|dominance|independence|facilities|plants?|grid)\b|power (?:plants?|grid)/i,
  ],
  [
    "geopolitics",
    /cease-?fire|\btruce\b|\bsanction(?:s|ed|ing)?\b|\bembargo\b|peace (?:deal|agreement|talks|plan|treaty)|\bwar (?:between\b|(?:with|in|against|on) (?:russia|ukraine|iran|israel|china|gaza|lebanon|the middle east)\b)|\b(?:russia|ukraine|putin|zelensky[iy]?|iran|hamas|hezbollah|gaza|nato|kremlin)\b|military (?:strikes?|action|operation)|\b(?:air ?strikes?|missiles?|invasion)\b/i,
  ],
  ["crypto", /crypto|bitcoin|\bbtc\b|stablecoin|digital assets?|blockchain/i],
  ["china", /\bchina\b|\bchinese\b|\bxi\b|beijing/i],
  ["stocks", /stock market|\bstocks?\b|\bdow\b|nasdaq|s&p|wall street|all[- ]time high/i],
];

/**
 * Validate Gemini's categories and impact: unknown categories dropped,
 * aliases mapped, duplicates removed, display order applied, and "other"
 * dropped next to a real topic.
 */
export function parseMarketTags(data: unknown): { categories: string[]; impact: Impact | null } {
  if (!data || typeof data !== "object" || Array.isArray(data)) return { categories: [], impact: null };
  const obj = data as Record<string, unknown>;
  const found = new Set<string>();
  const raw = typeof obj.categories === "string" ? [obj.categories] : obj.categories;
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item !== "string") continue;
      let key = item.trim().toLowerCase().replace(/[ -]/g, "_");
      key = CATEGORY_ALIASES[key] ?? key;
      if (key in MARKET_CATEGORIES) found.add(key);
    }
  }
  if (found.size > 1) found.delete("other");
  const categories = CATEGORY_KEYS.filter((c) => found.has(c));
  const impact = typeof obj.impact === "string" ? obj.impact.trim().toLowerCase() : "";
  return { categories, impact: (IMPACT_LEVELS as readonly string[]).includes(impact) ? (impact as Impact) : null };
}

export function keywordCategories(text: string): string[] {
  const found = KEYWORD_CATEGORIES.filter(([, re]) => re.test(text)).map(([key]) => key);
  return found.length ? found : ["other"];
}

/**
 * Posts on these topics move markets: their impact is never below medium
 * (🟠), whatever Gemini answered and even when only keywords found them.
 */
export const IMPACT_FLOOR_TOPICS = new Set(["tariffs", "fed_rates", "oil", "geopolitics"]);

/** Merge Gemini's and the keyword topics, then apply the impact floor. */
export function finalTags(
  geminiCategories: string[],
  geminiImpact: Impact | null,
  text: string,
): { categories: string[]; impact: Impact | null } {
  const found = new Set([...geminiCategories, ...keywordCategories(text)]);
  if (found.size > 1) found.delete("other");
  const categories = CATEGORY_KEYS.filter((c) => found.has(c));
  let impact = geminiImpact;
  if (categories.some((c) => IMPACT_FLOOR_TOPICS.has(c)) && impact !== "high") impact = "medium";
  return { categories, impact };
}

export interface PostAnalysis {
  hebrew: string;
  translated: boolean;
  categories: string[];
  impact: Impact | null;
  provider: string;
  /** Why Gemini wasn't used (kept in the KV cache for diagnosis). */
  geminiError?: string;
}

/**
 * Translate and tag a post with one Gemini call. Falls back to the free
 * translation chain plus keyword topics (no impact level) when Gemini isn't
 * configured or fails.
 */
export async function analyzePost(ctx: Ctx, text: string): Promise<PostAnalysis> {
  let geminiError: string | undefined;
  if (ctx.cfg.geminiApiKey && needsTranslation(text) && text.length <= GEMINI_MAX_CHARS) {
    try {
      const data = await geminiJson(ctx, text);
      const hebrew = typeof data.hebrew === "string" ? data.hebrew.trim() : "";
      if (looksTranslated(text, hebrew)) {
        const parsed = parseMarketTags(data);
        // Invalid tags from Gemini: keep only what keywords can vouch for.
        const { categories, impact } = finalTags(parsed.categories, parsed.categories.length ? parsed.impact : null, text);
        ctx.log.info(`Translated and tagged post via gemini: ${categories.join(",")}, impact=${impact}`);
        return { hebrew, translated: true, categories, impact, provider: "gemini" };
      }
      geminiError = hebrew ? "untranslated text" : "no answer";
      ctx.log.warn(`Translation provider gemini returned ${geminiError}`);
    } catch (err) {
      if (!(err instanceof GeminiError)) throw err;
      geminiError = err.message.slice(0, 200);
      ctx.log.warn("Translation provider gemini failed:", err.message);
    }
  }
  const t = await translateToHebrew(ctx, text);
  const { categories, impact } = finalTags([], null, text);
  return {
    hebrew: t.text,
    translated: t.translated,
    categories,
    impact,
    provider: t.translated ? "free" : "",
    ...(geminiError ? { geminiError } : {}),
  };
}
