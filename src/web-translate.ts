/**
 * Last-resort chunked English → Hebrew translation when both Gemini and
 * Workers AI fail (e.g. Gemini blocked by PoP location + Workers AI outage).
 * Tries MyMemory, Google gtx, and Google clients5, validating each chunk.
 */
import type { Ctx } from "./runtime";
import { htmlUnescape, splitText } from "./text";
import { hasArabicScript, looksTranslated, sanitizeArabicWords } from "./translate";

const MAX_CHUNK_CHARS = 450;
const MAX_CHUNKS = 8;
const WEB_TIMEOUT_MS = 6_000;
const TIME_RESERVE_MS = 8_000;

export class WebTranslateError extends Error {}

function cleanChunk(source: string, raw: string): string | null {
  let text = htmlUnescape(raw).trim();
  if (!text) return null;
  if (/MYMEMORY WARNING|QUOTA|PLEASE SELECT TWO DISTINCT/i.test(text)) return null;
  if (hasArabicScript(text)) text = sanitizeArabicWords(text);
  if (!looksTranslated(source, text) || hasArabicScript(text)) return null;
  return text;
}

async function fetchJson(ctx: Ctx, url: string): Promise<unknown> {
  const timeoutMs = Math.min(WEB_TIMEOUT_MS, ctx.budget.msLeft() - TIME_RESERVE_MS);
  if (timeoutMs < 1_500 || !ctx.budget.canFetch()) throw new WebTranslateError("no time left in this run");
  const res = await ctx.http(url, {
    timeoutMs,
    headers: { "User-Agent": "Mozilla/5.0" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function callMyMemory(ctx: Ctx, chunk: string): Promise<string> {
  const q = encodeURIComponent(chunk);
  const data = (await fetchJson(ctx, `https://api.mymemory.translated.net/get?q=${q}&langpair=en|he`)) as {
    responseStatus?: number;
    quotaFinished?: boolean;
    responseData?: { translatedText?: string };
  };
  if (data.quotaFinished || Number(data.responseStatus) !== 200) {
    throw new Error(`status ${data.responseStatus ?? "quota"}`);
  }
  const cleaned = cleanChunk(chunk, data.responseData?.translatedText ?? "");
  if (!cleaned) throw new Error("untranslated text");
  return cleaned;
}

async function callGtx(ctx: Ctx, chunk: string): Promise<string> {
  const q = encodeURIComponent(chunk);
  const data = (await fetchJson(
    ctx,
    `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=iw&dt=t&q=${q}`,
  )) as unknown[];
  const segments = Array.isArray(data?.[0]) ? (data[0] as unknown[][]) : [];
  const raw = segments.map((s) => (Array.isArray(s) && typeof s[0] === "string" ? s[0] : "")).join("");
  const cleaned = cleanChunk(chunk, raw);
  if (!cleaned) throw new Error("untranslated text");
  return cleaned;
}

async function callClients5(ctx: Ctx, chunk: string): Promise<string> {
  const q = encodeURIComponent(chunk);
  const data = await fetchJson(
    ctx,
    `https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=en&tl=iw&q=${q}`,
  );
  let raw = "";
  if (Array.isArray(data)) {
    const first = data[0];
    if (typeof first === "string") raw = first;
    else if (Array.isArray(first)) {
      raw = first
        .map((seg) =>
          Array.isArray(seg) && typeof seg[0] === "string" ? seg[0] : typeof seg === "string" ? seg : "",
        )
        .join("");
    }
  } else if (data && typeof data === "object" && "sentences" in data) {
    const sentences = (data as { sentences?: { trans?: string }[] }).sentences ?? [];
    raw = sentences.map((s) => s.trans ?? "").join("");
  }
  const cleaned = cleanChunk(chunk, raw);
  if (!cleaned) throw new Error("untranslated text");
  return cleaned;
}

const PROVIDERS: { name: string; fn: (ctx: Ctx, chunk: string) => Promise<string> }[] = [
  { name: "mymemory", fn: callMyMemory },
  { name: "gtx", fn: callGtx },
  { name: "clients5", fn: callClients5 },
];

export async function webTranslate(ctx: Ctx, text: string): Promise<{ hebrew: string; provider: string }> {
  const chunks = splitText(text, MAX_CHUNK_CHARS);
  if (chunks.length > MAX_CHUNKS) throw new WebTranslateError(`post too long (${chunks.length} chunks)`);
  const errors: string[] = [];
  for (const { name, fn } of PROVIDERS) {
    if (ctx.budget.timeUp() || !ctx.budget.canFetch(chunks.length)) {
      errors.push(`${name}: no time or budget left`);
      break;
    }
    try {
      const translated: string[] = [];
      for (const chunk of chunks) translated.push(await fn(ctx, chunk));
      return { hebrew: translated.join(" "), provider: name };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${name}: ${msg}`.slice(0, 120));
    }
  }
  throw new WebTranslateError(errors.join(" | ") || "web translation failed");
}
