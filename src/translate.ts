/**
 * Helpers that decide whether a text needs translating and whether an answer
 * really is Hebrew.
 *
 * The Worker no longer has keyless fallback translators: tested from
 * Cloudflare's network on 2026-10-12, Google's endpoints answered 429,
 * Lingva 403/400 and MyMemory "quota used up" — every time. Gemini (primary
 * and fallback model) is the only translator; see tagging.ts → analyzePost.
 */

const HEBREW_RE = /[\u0590-\u05FF]/;
const LATIN_WORD_RE = /[A-Za-z]{2,}/g;
const URL_RE = /https?:\/\/\S+|www\.\S+/g;
/** Below this many Latin words a chunk ("MAGA!") may legitimately come back unchanged. */
const MIN_LATIN_WORDS_FOR_HEBREW_CHECK = 3;

export function latinWordCount(text: string): number {
  return (text.replace(URL_RE, " ").match(LATIN_WORD_RE) ?? []).length;
}

export const needsTranslation = (text: string): boolean => latinWordCount(text) > 0;

/** Reject empty answers and answers that are still English (echoes, refusals). */
export function looksTranslated(source: string, candidate: string | null | undefined): boolean {
  if (!candidate?.trim()) return false;
  if (latinWordCount(source) < MIN_LATIN_WORDS_FOR_HEBREW_CHECK) return true;
  return HEBREW_RE.test(candidate);
}
