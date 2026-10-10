/**
 * Keyless translation providers, tried in order after Gemini. They are
 * unofficial endpoints that throttle shared IPs, so each answer is checked for
 * real Hebrew and a provider must translate every chunk or it counts as failed.
 */
import type { Ctx } from "./runtime";
import { splitText } from "./text";

export interface Provider {
  name: string;
  maxChunk: number;
  translate(ctx: Ctx, chunk: string): Promise<string | null>;
}

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const HEBREW_RE = /[֐-׿]/;
const LATIN_WORD_RE = /[A-Za-z]{2,}/g;
const URL_RE = /https?:\/\/\S+|www\.\S+/g;
/** Below this many Latin words a chunk ("MAGA!") may legitimately come back unchanged. */
const MIN_LATIN_WORDS_FOR_HEBREW_CHECK = 3;

export function latinWordCount(text: string): number {
  return (text.replace(URL_RE, " ").match(LATIN_WORD_RE) ?? []).length;
}

export const needsTranslation = (text: string): boolean => latinWordCount(text) > 0;

/** Reject empty answers and answers that are still English (echoes, quota notices). */
export function looksTranslated(chunk: string, candidate: string | null | undefined): boolean {
  if (!candidate?.trim()) return false;
  if (latinWordCount(chunk) < MIN_LATIN_WORDS_FOR_HEBREW_CHECK) return true;
  return HEBREW_RE.test(candidate);
}

async function getJson(ctx: Ctx, url: string): Promise<unknown> {
  const res = await ctx.http(url, { headers: { "User-Agent": BROWSER_UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const qs = (params: Record<string, string>) => new URLSearchParams(params).toString();

/** clients5 answers in several shapes: "x", ["x"], [["x","src"]], {sentences:[{trans}]}. */
export function extractClients5Text(result: unknown): string | null {
  if (typeof result === "string") return result;
  if (Array.isArray(result)) {
    return result
      .map((item) => (typeof item === "string" ? item : Array.isArray(item) && typeof item[0] === "string" ? item[0] : ""))
      .join("");
  }
  if (result && typeof result === "object") {
    const sentences = (result as { sentences?: unknown }).sentences;
    if (!Array.isArray(sentences)) return null;
    return sentences.map((s) => (s && typeof s === "object" ? String((s as { trans?: unknown }).trans ?? "") : "")).join("");
  }
  return null;
}

export const LINGVA_INSTANCES = [
  "https://lingva.ml",
  "https://lingva.garudalinux.org",
  "https://translate.plausibility.cloud",
];

export const FREE_PROVIDERS: Provider[] = [
  {
    name: "google-gtx",
    maxChunk: 4500,
    async translate(ctx, chunk) {
      const data = await getJson(
        ctx,
        `https://translate.googleapis.com/translate_a/single?${qs({ client: "gtx", sl: "en", tl: "he", dt: "t", q: chunk })}`,
      );
      if (!Array.isArray(data) || !Array.isArray(data[0])) return null;
      return (data[0] as unknown[]).map((seg) => (Array.isArray(seg) && typeof seg[0] === "string" ? seg[0] : "")).join("");
    },
  },
  {
    name: "google-clients5",
    maxChunk: 4500,
    async translate(ctx, chunk) {
      const data = await getJson(
        ctx,
        `https://clients5.google.com/translate_a/t?${qs({ client: "dict-chrome-ex", sl: "en", tl: "he", q: chunk })}`,
      );
      return extractClients5Text(data);
    },
  },
  {
    name: "lingva",
    maxChunk: 1200,
    async translate(ctx, chunk) {
      const path = encodeURIComponent(chunk);
      for (const base of LINGVA_INSTANCES) {
        if (!ctx.budget.canFetch()) return null;
        try {
          const data = (await getJson(ctx, `${base}/api/v1/en/he/${path}`)) as { translation?: unknown };
          if (typeof data?.translation === "string" && data.translation.trim()) return data.translation;
        } catch {
          // Next instance.
        }
      }
      return null;
    },
  },
  {
    name: "mymemory",
    maxChunk: 450,
    async translate(ctx, chunk) {
      const data = (await getJson(ctx, `https://api.mymemory.translated.net/get?${qs({ q: chunk, langpair: "en|he" })}`)) as {
        responseData?: { translatedText?: unknown };
      };
      const text = data?.responseData?.translatedText;
      // Over quota, MyMemory answers 200 with an English warning here;
      // looksTranslated rejects it.
      return typeof text === "string" ? text : null;
    },
  },
];

/** Translate the whole text with one provider, or null if any chunk fails. */
export async function translateWithProvider(ctx: Ctx, provider: Provider, text: string): Promise<string | null> {
  const parts: string[] = [];
  for (const chunk of splitText(text, provider.maxChunk)) {
    if (!needsTranslation(chunk)) {
      parts.push(chunk);
      continue;
    }
    if (!ctx.budget.canFetch()) return null;
    let candidate: string | null;
    try {
      candidate = await provider.translate(ctx, chunk);
    } catch (err) {
      ctx.log.warn(`Translation provider ${provider.name} failed:`, err);
      return null;
    }
    if (!looksTranslated(chunk, candidate)) {
      ctx.log.warn(`Translation provider ${provider.name} returned ${candidate ? "untranslated text" : "no answer"}`);
      return null;
    }
    parts.push(candidate as string);
  }
  return parts.join("");
}

export interface Translation {
  text: string;
  translated: boolean;
  provider: string;
}

/** Try each provider in turn; `translated: false` means the text is the English original. */
export async function translateToHebrew(ctx: Ctx, text: string, providers = FREE_PROVIDERS): Promise<Translation> {
  if (!text.trim() || !needsTranslation(text)) return { text, translated: true, provider: "" };
  for (const provider of providers) {
    if (!ctx.budget.canFetch()) break;
    const result = await translateWithProvider(ctx, provider, text);
    if (result !== null) {
      ctx.log.info(`Translated post via ${provider.name}`);
      return { text: result, translated: true, provider: provider.name };
    }
  }
  ctx.log.error("All translation providers failed — the post goes out in English");
  return { text, translated: false, provider: "" };
}
