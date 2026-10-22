/** Market-impact tagging, and the per-post analysis that combines it with translation. */
import {
  CATEGORY_KEYS,
  GEMINI_MAX_CHARS,
  GEMINI_STRICT_SYSTEM_PROMPT,
  GEMINI_SYSTEM_PROMPT,
  GeminiError,
  geminiJson,
  IMPACT_LEVELS,
  msUntilQuotaReset,
} from "./gemini";
import type { Ctx } from "./runtime";
import { isMeaningfulText } from "./text";
import { hasArabicScript, looksTranslated, needsTranslation, sanitizeArabicWords } from "./translate";
import { workersAiTranslate } from "./workers-ai";

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
  return {
    categories,
    impact: (IMPACT_LEVELS as readonly string[]).includes(impact) ? (impact as Impact) : null,
  };
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
  /** "gemini" or "workers-ai" (with `model`), "none" when nothing needed translating, "" when it failed. */
  provider: string;
  model?: string;
  /** Why translation failed, per provider (also saved under gemini-error:<post>). */
  geminiError?: string;
  /** The run ran out of time before Gemini could be asked: not a failure. */
  outOfTime?: boolean;
  /** Every Gemini model's daily quota is used up and Workers AI is not configured. */
  quotaExhausted?: boolean;
  /**
   * Every provider that was asked returned an echo (or already had, on an
   * earlier run). Calling them again spends quota and cannot succeed.
   */
  deterministic?: boolean;
}

/** Remembers which models are out of daily quota (backed by KV in the Worker). */
export interface QuotaTracker {
  exhausted(model: string): Promise<string | null>;
  markExhausted(model: string, reason: string, seconds: number): Promise<void>;
}

const noQuotaTracking: QuotaTracker = { exhausted: async () => null, markExhausted: async () => {} };

const ECHO_REASON = /:\s*(?:untranslated text|no answer|skipped — earlier untranslated text)\s*$/;

/** Providers whose last answer was an echo. Asking them again burns quota. */
export function echoedProviders(error: string): Set<string> {
  const found = new Set<string>();
  if (!error) return found;
  for (const part of error.split(" | ")) {
    const match = /^\s*(.+?):\s*(?:untranslated text|no answer|skipped — earlier untranslated text)\s*$/.exec(
      part,
    );
    if (match?.[1]) found.add(match[1]);
  }
  return found;
}

function deterministicFailure(errors: string[]): boolean {
  return errors.length > 0 && errors.every((part) => ECHO_REASON.test(part));
}

/**
 * Translate and tag a post. Gemini first (primary, then GEMINI_FALLBACK_MODEL).
 * If both fail — quota, HTTP error, or an answer that is still English —
 * one Workers AI call is the fallback. A failure returns `translated: false`
 * with every reason, and the caller retries or sends the English original.
 * `priorError` is the last saved failure, so a model that already echoed this
 * post is not called again.
 *
 * Hebrew that contains Arabic script is not accepted. The same model is asked
 * once more with stricter instructions. If Arabic script remains, the next
 * fallback model is asked with those instructions. Words that still contain
 * Arabic are then replaced or removed, and that Hebrew is what gets sent.
 */
export async function analyzePost(
  ctx: Ctx,
  text: string,
  quota: QuotaTracker = noQuotaTracking,
  priorError = "",
): Promise<PostAnalysis> {
  const untranslated = (geminiError: string, extra: Partial<PostAnalysis> = {}): PostAnalysis => ({
    hebrew: text,
    translated: false,
    ...finalTags([], null, text),
    provider: "",
    geminiError,
    ...extra,
  });
  if (!isMeaningfulText(text) || !needsTranslation(text)) {
    return { hebrew: text, translated: true, ...finalTags([], null, text), provider: "none" };
  }
  if (!ctx.cfg.geminiApiKey) return untranslated("GEMINI_API_KEY not set");
  if (text.length > GEMINI_MAX_CHARS) return untranslated(`post longer than ${GEMINI_MAX_CHARS} chars`);

  const models = [...new Set([ctx.cfg.geminiModel, ctx.cfg.geminiFallbackModel].filter(Boolean))];
  const echoed = echoedProviders(priorError);
  const errors: string[] = [];
  let outOfQuota = 0;
  let contaminated: { model: string; hebrew: string; data: Record<string, unknown> } | null = null;
  /** After Arabic script, later models are asked with the strict prompt only. */
  let arabicSeen = false;

  const acceptGemini = (model: string, hebrew: string, data: Record<string, unknown>): PostAnalysis => {
    const parsed = parseMarketTags(data);
    // Invalid tags from Gemini: keep only what keywords can vouch for.
    const { categories, impact } = finalTags(
      parsed.categories,
      parsed.categories.length ? parsed.impact : null,
      text,
    );
    ctx.log.info(
      `Translated and tagged post via gemini (${model}): ${categories.join(",")}, impact=${impact}`,
    );
    return {
      hebrew,
      translated: true,
      categories,
      impact,
      provider: "gemini",
      model,
      ...(errors.length ? { geminiError: errors.join(" | ") } : {}),
    };
  };

  const onGeminiError = async (
    model: string,
    err: unknown,
  ): Promise<"out-of-time" | "break" | "continue"> => {
    if (!(err instanceof GeminiError)) throw err;
    if (err.message === "no time left in this run")
      return errors.length || contaminated ? "break" : "out-of-time";
    errors.push(`${model}: ${err.message}`.slice(0, 300));
    if (err.dailyQuota) {
      outOfQuota += 1;
      // Don't spend calls (and run time) on it again until the reset.
      await quota.markExhausted(model, err.message, msUntilQuotaReset(ctx.now()) / 1000);
      ctx.log.warn(`Gemini ${model}: daily quota used up — skipping it until the reset (midnight Pacific)`);
    }
    return "continue";
  };

  const consider = (
    model: string,
    data: Record<string, unknown>,
  ): PostAnalysis | { model: string; hebrew: string; data: Record<string, unknown> } | null => {
    const hebrew = typeof data.hebrew === "string" ? data.hebrew.trim() : "";
    if (!looksTranslated(text, hebrew)) {
      errors.push(`${model}: ${hebrew ? "untranslated text" : "no answer"}`);
      return null;
    }
    if (!hasArabicScript(hebrew)) return acceptGemini(model, hebrew, data);
    errors.push(`${model}: arabic script in translation`);
    return { model, hebrew, data };
  };

  let halted = false;
  for (const model of models) {
    if (echoed.has(model)) {
      errors.push(`${model}: skipped — earlier untranslated text`);
      continue;
    }
    const exhausted = await quota.exhausted(model);
    if (exhausted) {
      outOfQuota += 1;
      errors.push(`${model}: skipped — ${exhausted}`);
      continue;
    }
    // Ordinary prompt, then one strict retry when that answer mixed scripts.
    // A later model is asked once, with the strict prompt: that is the
    // fallback attempt, not a second strict retry.
    const prompts = arabicSeen
      ? [GEMINI_STRICT_SYSTEM_PROMPT]
      : [GEMINI_SYSTEM_PROMPT, GEMINI_STRICT_SYSTEM_PROMPT];
    for (const prompt of prompts) {
      try {
        const data = await geminiJson(ctx, text, model, prompt);
        const outcome = consider(model, data);
        if (outcome && "translated" in outcome) return outcome;
        ctx.log.warn(`Gemini failed — ${errors.at(-1)}`);
        if (outcome) {
          contaminated = outcome;
          arabicSeen = true;
          if (prompt === GEMINI_SYSTEM_PROMPT) continue;
        }
        break;
      } catch (err) {
        const action = await onGeminiError(model, err);
        if (action === "out-of-time") {
          return untranslated(err instanceof Error ? err.message : "no time left in this run", {
            outOfTime: true,
          });
        }
        ctx.log.warn(`Gemini failed — ${errors.at(-1)}`);
        if (action === "break") halted = true;
        break;
      }
    }
    if (halted) break;
  }

  if (contaminated) {
    const repaired = sanitizeArabicWords(contaminated.hebrew);
    if (looksTranslated(text, repaired) && !hasArabicScript(repaired)) {
      errors.push(`${contaminated.model}: arabic script repaired`);
      ctx.log.warn(`Gemini ${contaminated.model}: replaced or removed Arabic words in the translation`);
      return acceptGemini(contaminated.model, repaired, contaminated.data);
    }
  }

  const aiModel = ctx.cfg.workersAiModel;
  const aiReady = Boolean(ctx.ai && aiModel);
  if (aiReady && echoed.has("workers-ai")) {
    errors.push("workers-ai: skipped — earlier untranslated text");
  } else if (aiReady) {
    if (ctx.budget.timeUp() || !ctx.budget.canFetch()) {
      errors.push("workers-ai: no time left in this run");
    } else {
      try {
        let hebrew = await workersAiTranslate(ctx, text);
        if (hasArabicScript(hebrew)) {
          const repaired = sanitizeArabicWords(hebrew);
          if (looksTranslated(text, repaired) && !hasArabicScript(repaired)) {
            errors.push("workers-ai: arabic script repaired");
            hebrew = repaired;
          } else {
            errors.push("workers-ai: arabic script in translation");
            ctx.log.warn(`Workers AI failed — ${errors.at(-1)}`);
            hebrew = "";
          }
        }
        if (looksTranslated(text, hebrew) && !hasArabicScript(hebrew)) {
          const { categories, impact } = finalTags([], null, text);
          ctx.log.info(
            `Translated post via workers-ai (${aiModel}): ${categories.join(",")}, impact=${impact}`,
          );
          return {
            hebrew,
            translated: true,
            categories,
            impact,
            provider: "workers-ai",
            model: aiModel,
            ...(errors.length ? { geminiError: errors.join(" | ") } : {}),
          };
        }
        if (hebrew || !errors.at(-1)?.endsWith("arabic script in translation")) {
          errors.push(`workers-ai: ${hebrew ? "untranslated text" : "no answer"}`);
          ctx.log.warn(`Workers AI failed — ${errors.at(-1)}`);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push(`workers-ai: ${message}`.slice(0, 300));
        ctx.log.warn(`Workers AI failed — ${errors.at(-1)}`);
      }
    }
  }

  const extra: Partial<PostAnalysis> = {};
  if (outOfQuota === models.length && models.length > 0 && !aiReady) extra.quotaExhausted = true;
  if (deterministicFailure(errors)) extra.deterministic = true;
  return untranslated(errors.join(" | "), extra);
}
