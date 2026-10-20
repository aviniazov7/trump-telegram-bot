/**
 * Helpers that decide whether a text needs translating and whether an answer
 * really is Hebrew.
 *
 * Gemini is the primary translator. When it fails, analyzePost asks Workers
 * AI (see workers-ai.ts). Keyless web translators stay unused: tested from
 * Cloudflare's network on 2026-10-12, Google's endpoints answered 429,
 * Lingva 403/400 and MyMemory "quota used up" — every time.
 *
 * Arabic script in a Hebrew answer is a bad translation (the lite model mixes
 * the two). hasArabicScript detects it; repairArabicScript is the last resort
 * after a stricter retry still returns those characters.
 */

const HEBREW_RE = /[\u0590-\u05FF]/;
const LATIN_WORD_RE = /[A-Za-z]{2,}/g;
const URL_RE = /https?:\/\/\S+|www\.\S+/g;
const HANDLE_RE = /@[A-Za-z0-9_]+/g;
/** The "RT" token in a boost label is not a word that has to become Hebrew. */
const RT_TOKEN_RE = /\bRT\b:?/g;
/** Below this many Latin words a chunk ("MAGA!") may legitimately come back unchanged. */
const MIN_LATIN_WORDS_FOR_HEBREW_CHECK = 3;

export function latinWordCount(text: string): number {
  const stripped = text.replace(URL_RE, " ").replace(HANDLE_RE, " ").replace(RT_TOKEN_RE, " ");
  return (stripped.match(LATIN_WORD_RE) ?? []).length;
}

export const needsTranslation = (text: string): boolean => latinWordCount(text) > 0;

/** Reject empty answers and answers that are still English (echoes, refusals). */
export function looksTranslated(source: string, candidate: string | null | undefined): boolean {
  if (!candidate?.trim()) return false;
  if (latinWordCount(source) < MIN_LATIN_WORDS_FOR_HEBREW_CHECK) return true;
  return HEBREW_RE.test(candidate);
}

/** Arabic, Arabic Supplement, and both Arabic presentation-form blocks. */
export function isArabicCodePoint(cp: number): boolean {
  return (
    (cp >= 0x0600 && cp <= 0x06ff) ||
    (cp >= 0x0750 && cp <= 0x077f) ||
    (cp >= 0xfb50 && cp <= 0xfdff) ||
    (cp >= 0xfe70 && cp <= 0xfeff)
  );
}

export function hasArabicScript(text: string): boolean {
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp !== undefined && isArabicCodePoint(cp)) return true;
  }
  return false;
}

/**
 * Last-resort map for Arabic letters the model used in place of Hebrew.
 * Unlisted Arabic characters are deleted. Digits and punctuation are kept
 * as their ASCII forms so numbers survive.
 */
const ARABIC_TO_HEBREW: Record<string, string> = {
  "\u0621": "", // hamza
  "\u0622": "א",
  "\u0623": "א",
  "\u0624": "ו",
  "\u0625": "א",
  "\u0626": "י",
  "\u0627": "א",
  "\u0628": "ב",
  "\u0629": "ה",
  "\u062a": "ת",
  "\u062b": "ת",
  "\u062c": "ג",
  "\u062d": "ח",
  "\u062e": "ח",
  "\u062f": "ד",
  "\u0630": "ד",
  "\u0631": "ר",
  "\u0632": "ז",
  "\u0633": "ס",
  "\u0634": "ש",
  "\u0635": "צ",
  "\u0636": "צ",
  "\u0637": "ט",
  "\u0638": "ט",
  "\u0639": "ע",
  "\u063a": "ע",
  "\u0640": "", // tatweel
  "\u0641": "פ",
  "\u0642": "ק",
  "\u0643": "כ",
  "\u0644": "ל",
  "\u0645": "מ",
  "\u0646": "נ",
  "\u0647": "ה",
  "\u0648": "ו",
  "\u0649": "י",
  "\u064a": "י",
  "\u0671": "א",
  "\u067e": "פ",
  "\u0686": "צ",
  "\u0698": "ז",
  "\u06a9": "כ",
  "\u06af": "ג",
  "\u06cc": "י",
  "\u06d5": "ה",
  "\u060c": ",",
  "\u061b": ";",
  "\u061f": "?",
  "\u066a": "%",
  "\u066b": ".",
  "\u066c": ",",
  "\u06d4": ".",
  "\u0660": "0",
  "\u0661": "1",
  "\u0662": "2",
  "\u0663": "3",
  "\u0664": "4",
  "\u0665": "5",
  "\u0666": "6",
  "\u0667": "7",
  "\u0668": "8",
  "\u0669": "9",
  "\u06f0": "0",
  "\u06f1": "1",
  "\u06f2": "2",
  "\u06f3": "3",
  "\u06f4": "4",
  "\u06f5": "5",
  "\u06f6": "6",
  "\u06f7": "7",
  "\u06f8": "8",
  "\u06f9": "9",
};

/**
 * Replace Arabic-script characters with Hebrew lookalikes, ASCII digits, or
 * punctuation. Presentation forms are folded with NFKC first. Anything still
 * Arabic and unmapped (diacritics, supplemental letters) is removed.
 */
export function repairArabicScript(text: string): string {
  let out = "";
  for (const ch of text) {
    if (!hasArabicScript(ch)) {
      out += ch;
      continue;
    }
    for (const piece of ch.normalize("NFKC")) {
      if (!hasArabicScript(piece)) {
        out += piece;
        continue;
      }
      out += ARABIC_TO_HEBREW[piece] ?? "";
    }
  }
  return out;
}
