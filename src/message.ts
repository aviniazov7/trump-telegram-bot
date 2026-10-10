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

export interface MessageParts {
  hebrew: string;
  translated: boolean;
  categories?: string[] | null;
  impact?: string | null;
}

/**
 * English original + Hebrew translation. When translation failed everywhere,
 * a notice replaces the Hebrew block instead of repeating the English under a
 * "translated" heading.
 */
export function buildMessage(post: Post, parts: MessageParts): string {
  const hebrewBlock = parts.translated
    ? `🇮🇱 <b>תרגום לעברית:</b>\n${htmlEscape(parts.hebrew)}\n`
    : "⚠️ <b>התרגום לעברית נכשל כרגע — הפוסט מוצג באנגלית בלבד.</b>\n";
  const tagLine = buildTagLine(parts.categories, parts.impact);
  let msg =
    (tagLine ? `${tagLine}\n` : "") +
    "🇺🇸 <b>טראמפ — פוסט חדש</b>\n" +
    `🕐 ${formatTimestamp(post.createdAt)}\n\n` +
    `${htmlEscape(post.text)}\n\n` +
    "━━━━━━━━━━━━━━━\n\n" +
    hebrewBlock;
  if (post.url) msg += `\n🔗 <a href="${htmlEscape(post.url)}">לפוסט המקורי</a>`;
  return msg;
}
