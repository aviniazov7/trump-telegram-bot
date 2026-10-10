/** Text helpers ported from the Python bot: HTML handling and splitting. */

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  ndash: "–",
  mdash: "—",
  hellip: "…",
};

/** Decode HTML entities (named subset + all numeric), like Python's html.unescape. */
export function htmlUnescape(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? Number.parseInt(body.slice(2), 16) : Number(body.slice(1));
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

/** Escape for Telegram HTML, like Python's html.escape(quote=True). */
export function htmlEscape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

/** Remove HTML tags and URLs from a feed post, keeping line structure. */
export function stripHtml(input: string): string {
  let text = input.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<\/a>/gi, " ");
  text = text.replace(/<\/p>/gi, "\n");
  text = text.replace(/<[^>]+>/g, "");
  text = htmlUnescape(text);
  text = text.replace(/RT:\s*https?:\/\/\S+\s*/g, "");
  text = text.replace(/https?:\/\/\S+/g, "");
  text = text.replace(/\n{3,}/g, "\n\n");
  text = text.replace(/ {2,}/g, " ");
  return text.trim();
}

/** Skip empty, RT-only and "[No Title]" placeholder posts. */
export function isMeaningfulText(text: string): boolean {
  const cleaned = text.trim();
  if (!cleaned) return false;
  if (/^RT:\s*https?:\/\/\S+$/.test(cleaned)) return false;
  if (cleaned.startsWith("[No Title]")) return false;
  return true;
}

/** Split for a translation provider, preferring line then sentence breaks. */
export function splitText(input: string, maxLen: number): string[] {
  if (input.length <= maxLen) return [input];
  const chunks: string[] = [];
  let text = input;
  while (text) {
    if (text.length <= maxLen) {
      chunks.push(text);
      break;
    }
    let cut = text.lastIndexOf("\n", maxLen - 1);
    if (cut < Math.floor(maxLen / 2)) cut = text.lastIndexOf(". ", maxLen - 2);
    if (cut < Math.floor(maxLen / 2)) cut = maxLen;
    else cut += 1;
    chunks.push(text.slice(0, cut));
    text = text.slice(cut).trimStart();
  }
  return chunks;
}

/** Telegram caps messages at 4096 characters; keep a margin. */
export const TELEGRAM_MAX_MESSAGE_LEN = 4000;

/**
 * Split a message so each piece fits Telegram's limit. Splits at newlines,
 * then spaces, so HTML tags (always on one line in buildMessage) stay whole.
 */
export function splitForTelegram(text: string, maxLen = TELEGRAM_MAX_MESSAGE_LEN): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    let cut = remaining.lastIndexOf("\n", maxLen - 1);
    if (cut <= 0) cut = remaining.lastIndexOf(" ", maxLen - 1);
    if (cut <= 0) cut = maxLen;
    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
