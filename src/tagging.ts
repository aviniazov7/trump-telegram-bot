/** Market-impact tagging, and the per-post analysis that combines it with translation. */
import { CATEGORY_KEYS, GEMINI_MAX_CHARS, GeminiError, IMPACT_LEVELS, geminiJson } from "./gemini";
import type { Ctx } from "./runtime";
import { looksTranslated, needsTranslation, translateToHebrew } from "./translate";

/** Machine keys → Hebrew hashtag labels, in display order. */
export const MARKET_CATEGORIES: Record<string, string> = {
  tariffs: "מכסים",
  fed_rates: "ריבית_הפד",
  oil: "נפט",
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
  stock: "stocks",
  stock_market: "stocks",
};

/**
 * Used only when Gemini can't classify a post. It finds topics but can't
 * judge impact, so a keyword match never earns a 🔴.
 */
const KEYWORD_CATEGORIES: [string, RegExp][] = [
  ["tariffs", /\btariffs?\b|\bduties\b|trade (?:deal|war|deficit)|reciprocal/i],
  ["fed_rates", /\bthe fed\b|federal reserve|\bpowell\b|interest rates?|rate cuts?/i],
  ["oil", /\boil\b|\bopec\b|\bcrude\b|gasoline|drill(?:ing)?\b|\bnatural gas\b/i],
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

export interface PostAnalysis {
  hebrew: string;
  translated: boolean;
  categories: string[];
  impact: Impact | null;
  provider: string;
}

/**
 * Translate and tag a post with one Gemini call. Falls back to the free
 * translation chain plus keyword topics (no impact level) when Gemini isn't
 * configured or fails.
 */
export async function analyzePost(ctx: Ctx, text: string): Promise<PostAnalysis> {
  if (ctx.cfg.geminiApiKey && needsTranslation(text) && text.length <= GEMINI_MAX_CHARS) {
    try {
      const data = await geminiJson(ctx, text);
      const hebrew = typeof data.hebrew === "string" ? data.hebrew.trim() : "";
      if (looksTranslated(text, hebrew)) {
        let { categories, impact } = parseMarketTags(data);
        if (!categories.length) {
          categories = keywordCategories(text);
          impact = null;
        }
        ctx.log.info(`Translated and tagged post via gemini: ${categories.join(",")}, impact=${impact}`);
        return { hebrew, translated: true, categories, impact, provider: "gemini" };
      }
      ctx.log.warn(`Translation provider gemini returned ${hebrew ? "untranslated text" : "no answer"}`);
    } catch (err) {
      if (!(err instanceof GeminiError)) throw err;
      ctx.log.warn("Translation provider gemini failed:", err.message);
    }
  }
  const t = await translateToHebrew(ctx, text);
  return {
    hebrew: t.text,
    translated: t.translated,
    categories: keywordCategories(text),
    impact: null,
    provider: t.translated ? "free" : "",
  };
}
