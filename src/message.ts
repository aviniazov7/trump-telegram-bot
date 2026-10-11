/** Telegram message layout (HTML parse mode). */
import type { Post } from "./sources";
import { IMPACT_MARKERS, MARKET_CATEGORIES } from "./tagging";
import { htmlEscape } from "./text";

const ISRAEL_TIME = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Jerusalem",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** "dd/mm/yyyy HH:MM" in Israel time (DST-aware); the raw string if unparseable. */
export function formatTimestamp(date: string): string {
  if (!date) return "—";
  // RFC 2822 and ISO 8601 both parse; tz-less ISO is treated as UTC.
  const iso = /^\d{4}-\d{2}-\d{2}T[\d:.]+$/.test(date) ? `${date}Z` : date;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return date;
  const parts = Object.fromEntries(ISRAEL_TIME.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return `${parts.day}/${parts.month}/${parts.year} ${parts.hour}:${parts.minute}`;
}

/** First line: impact marker and topic hashtags. Single line, so splitting never cuts a tag. */
export function buildTagLine(categories: string[] | null | undefined, impact: string | null | undefined): string {
  const labels = (categories ?? []).flatMap((c) => (c in MARKET_CATEGORIES ? [MARKET_CATEGORIES[c]] : []));
  const tags = labels.map((label) => `#${label}`).join(" ");
  const marker = impact ? IMPACT_MARKERS[impact] : undefined;
  if (marker && tags) return `${marker} · ${tags}`;
  if (marker) return marker;
  return tags ? `🏷️ ${tags}` : "";
}

/** What gets translated and tagged: the post's own words, then the quoted post's. */
export function translatableText(post: Post): string {
  return [post.text, post.quote?.text ?? ""].filter((t) => t.trim()).join("\n\n");
}

const kindLabel = (kinds: string[] | undefined): string =>
  kinds?.includes("video") ? "וידאו" : kinds?.length ? "תמונה" : "";

/**
 * The line shown instead of a translation when a post has no words at all —
 * e.g. "🎥 פוסט וידאו ללא טקסט" — rather than translating the archive's
 * "View video" / "Quoted …" placeholders.
 */
export function mediaOnlyLine(post: Post): string {
  const parts: string[] = [];
  const own = kindLabel(post.media);
  if (own) parts.push(`${own === "וידאו" ? "🎥" : "🖼️"} פוסט ${own} ללא טקסט`);
  if (post.quote) {
    const quoted = kindLabel(post.quote.media);
    const author = post.quote.author ? ` של ${htmlEscape(post.quote.author)}` : "";
    parts.push(`🔁 ציטוט של פוסט${quoted ? ` ${quoted}` : ""}${author}`);
  }
  return parts.join(" · ") || "📎 פוסט ללא טקסט";
}

export interface MessageParts {
  hebrew: string;
  translated: boolean;
  categories?: string[] | null;
  impact?: string | null;
}

/**
 * English original + Hebrew translation. When translation failed everywhere,
 * a notice replaces the Hebrew block instead of repeating the English under a
 * "translated" heading. A post with no words (only media / a media-only
 * quote) gets a single descriptive line and no translation block.
 */
export function buildMessage(post: Post, parts: MessageParts): string {
  const header = `🇺🇸 <b>טראמפ — פוסט חדש</b>\n🕐 ${formatTimestamp(post.createdAt)}\n\n`;
  const link = post.url ? `\n🔗 <a href="${htmlEscape(post.url)}">לפוסט המקורי</a>` : "";

  if (!translatableText(post)) return `${header}${mediaOnlyLine(post)}\n${link}`;

  const original = [
    post.text ? htmlEscape(post.text) : "",
    post.quote?.text
      ? `🔁 <i>Quoting ${htmlEscape(post.quote.author || "a post")}:</i>\n${htmlEscape(post.quote.text)}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const hebrewBlock = parts.translated
    ? `🇮🇱 <b>תרגום לעברית:</b>\n${htmlEscape(parts.hebrew)}\n`
    : "⚠️ <b>התרגום לעברית נכשל כרגע — הפוסט מוצג באנגלית בלבד.</b>\n";
  const tagLine = buildTagLine(parts.categories, parts.impact);
  return (
    (tagLine ? `${tagLine}\n` : "") +
    header +
    `${original}\n\n` +
    "━━━━━━━━━━━━━━━\n\n" +
    hebrewBlock +
    link
  );
}
