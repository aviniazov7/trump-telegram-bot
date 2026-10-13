/**
 * Post sources: trumpstruth.org RSS (primary) and the CNN Truth Social archive
 * (fallback, and deep scan when the RSS window doesn't reach last_seen).
 */
import type { Ctx } from "./runtime";
import { isMeaningfulText, stripHtml } from "./text";

export type MediaKind = "image" | "video";

/** A post quoted inside another (a Truth Social "quote post"). */
export interface Quote {
  author: string;
  text: string;
  media: MediaKind[];
}

export interface Post {
  id: string;
  /** The post's own words, without media placeholders or the quoted post. */
  text: string;
  createdAt: string;
  url: string;
  /** Images/videos attached to the post itself. */
  media?: MediaKind[];
  quote?: Quote | null;
  /**
   * Status id this item re-posts, when the feed marks it `RT: <status url>`.
   * A wordless re-post of a status already in the same window is not a new
   * post — Truth Social archives the original and the boost as two ids.
   */
  repostOf?: string | null;
}

export const TRUMPSTRUTH_RSS = "https://www.trumpstruth.org/feed";
export const CNN_ARCHIVE_JSON = "https://ix.cnn.io/data/truth-social/truth_archive.json";
export const TRUTH_SOCIAL_PROFILE = "https://truthsocial.com/@realDonaldTrump";
const USER_AGENT = "Mozilla/5.0 (compatible; trump-telegram-bot/2.0)";

/**
 * The archive is ~20 MB of JSON, newest first. Parsing all of it would blow
 * the Workers CPU limit, so only the first bytes are read and the leading
 * objects extracted from them.
 */
export const CNN_READ_BYTES = 512 * 1024;

function xmlTag(item: string, tag: string): string {
  const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(item);
  if (!m?.[1]) return "";
  const content = m[1].trim();
  const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(content);
  return cdata?.[1] ?? content;
}

// "RT: <url>" marks a re-post. In HTML the URL ends at the next tag; the
// CNN archive glues it to the following text ("…/1174198068520301149 9%"),
// so there only an exact Truth Social status URL (18-digit ID) is removed.
const RT_HTML_RE = /RT:\s*https?:\/\/[^\s<]+/gi;
const RT_TEXT_RE = /RT:\s*https?:\/\/truthsocial\.com\/(?:users\/[^/\s]+\/statuses|@[^/\s]+)\/\d{18}/gi;
const RT_STATUS_RE =
  /RT:\s*https?:\/\/truthsocial\.com\/(?:users\/[^/\s<"']+\/statuses|@[^/\s<"']+)\/(\d{18})/i;

/** Truth Social status id a feed item is re-posting, or null. */
export function repostTarget(raw: string): string | null {
  return RT_STATUS_RE.exec(raw)?.[1] ?? null;
}

/**
 * Ids of wordless re-posts whose original status is in `posts`.
 * The caller marks them done without sending: subscribers already get the
 * original, and the boost is the same video/quote a minute later.
 */
export function pureRepostIds(posts: Post[]): string[] {
  const ids = new Set(posts.map((p) => p.id));
  return posts
    .filter((p) => p.repostOf && p.repostOf !== p.id && ids.has(p.repostOf) && !isMeaningfulText(p.text))
    .map((p) => p.id);
}
const MEDIA_LINK_RE = /<a\b[^>]*>\s*View (image|video|media)\s*<\/a>/gi;

/** Split trumpstruth's post HTML into own text, media and the quoted post. */
export function parseTruthHtml(html: string): { text: string; media: MediaKind[]; quote: Quote | null } {
  let body = html.replace(RT_HTML_RE, "");
  let quote: Quote | null = null;
  const quoted = /<blockquote>([\s\S]*?)<\/blockquote>/i.exec(body);
  const quotedBy = /<p>\s*Quoted\s*([\s\S]*?)<\/p>/i.exec(body);
  if (quoted) {
    const inner = parseTruthHtml(quoted[1] ?? "");
    quote = {
      author: stripHtml(quotedBy?.[1] ?? ""),
      text: inner.text,
      media: [...inner.media, ...(inner.quote?.media ?? [])],
    };
    body = body.replace(quoted[0], "");
  }
  if (quotedBy) body = body.replace(quotedBy[0], "");
  const media: MediaKind[] = [];
  body = body.replace(MEDIA_LINK_RE, (_m, kind: string) => {
    media.push(kind.toLowerCase() === "video" ? "video" : "image");
    return "";
  });
  return { text: stripHtml(body), media, quote };
}

/** Worth sending: own text, quoted text, or at least an image/video. */
export function hasContent(post: Pick<Post, "text" | "media" | "quote">): boolean {
  return (
    isMeaningfulText(post.text) ||
    Boolean(post.quote?.text) ||
    Boolean(post.media?.length) ||
    Boolean(post.quote?.media.length)
  );
}

export function parseRss(xml: string, limit: number): Post[] {
  const posts: Post[] = [];
  for (const match of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const item = match[1] ?? "";
    const description = xmlTag(item, "description");
    const title = xmlTag(item, "title");
    const link = xmlTag(item, "link") || xmlTag(item, "guid");
    // Titles of text-less posts are placeholders ("Video post from …"), so
    // the title is only a fallback for an empty description.
    const parsed = description
      ? parseTruthHtml(description)
      : { text: stripHtml(title), media: [], quote: null };
    const post: Post = {
      id: xmlTag(item, "truth:originalId") || (link ? (link.replace(/\/+$/, "").split("/").pop() ?? "") : ""),
      text: isMeaningfulText(parsed.text) ? parsed.text : "",
      createdAt: xmlTag(item, "pubDate"),
      url: xmlTag(item, "truth:originalUrl") || link,
      media: parsed.media,
      quote: parsed.quote,
      repostOf: repostTarget(description) || repostTarget(title),
    };
    if (!hasContent(post)) continue;
    posts.push(post);
    if (posts.length >= limit) break;
  }
  return posts;
}

const VIDEO_URL_RE = /\.(mp4|mov|m3u8|webm)(\?|$)/i;

/**
 * Extract the leading top-level objects of a JSON array that may be cut off
 * mid-way. Tracks string/escape state so braces inside text don't count.
 */
export function leadingJsonObjects(text: string, max: number): unknown[] {
  const out: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = text.indexOf("[") + 1; i > 0 && i < text.length && out.length < max; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        try {
          out.push(JSON.parse(text.slice(start, i + 1)));
        } catch {
          // A malformed object: skip it rather than lose the rest.
        }
        start = -1;
      }
    } else if (ch === "]" && depth === 0) break;
  }
  return out;
}

export function parseCnnArchive(text: string, limit: number): Post[] {
  const posts: Post[] = [];
  // Over-read: some leading items are RT-only and get skipped.
  for (const raw of leadingJsonObjects(text, limit * 2)) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const rawBody = String(item.content || item.text || "");
    const body = rawBody.replace(RT_TEXT_RE, "");
    const postText = stripHtml(body);
    const media: MediaKind[] = (Array.isArray(item.media) ? item.media : [])
      .filter((m): m is string => typeof m === "string")
      .map((url) => (VIDEO_URL_RE.test(url) ? "video" : "image"));
    const id = String(item.id ?? "");
    const post: Post = {
      id,
      text: isMeaningfulText(postText) ? postText : "",
      createdAt: String(item.created_at ?? ""),
      url: id ? `${TRUTH_SOCIAL_PROFILE}/${id}` : "",
      media,
      quote: null,
      repostOf: repostTarget(rawBody),
    };
    if (!hasContent(post)) continue;
    posts.push(post);
    if (posts.length >= limit) break;
  }
  return posts;
}

/** Order newest first by snowflake ID; keep source order if any ID isn't numeric. */
export function newestFirst(posts: Post[]): Post[] {
  if (!posts.every((p) => /^\d+$/.test(p.id))) return posts;
  return [...posts].sort((a, b) => (BigInt(b.id) > BigInt(a.id) ? 1 : BigInt(b.id) < BigInt(a.id) ? -1 : 0));
}

export const contains = (posts: Post[], id: string): boolean => posts.some((p) => p.id === id);

async function readPrefix(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < maxBytes) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    chunks.push(value);
    size += value.byteLength;
  }
  await reader.cancel().catch(() => {});
  const buf = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    buf.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(buf);
}

/**
 * trumpstruth.org serves its feed through a CDN cache that kept copies up to
 * ~110 minutes old (cf-cache-status: HIT, age: 6558) — the real cause of
 * 80–100 min delivery delays. A unique query string makes the CDN pass the
 * request to the origin (cf-cache-status: DYNAMIC, age: 0).
 */
export function freshRssUrl(now: number): string {
  return `${TRUMPSTRUTH_RSS}?_=${Math.floor(now / 1000)}`;
}

const NO_CACHE = { "Cache-Control": "no-cache", Pragma: "no-cache" };

export async function fetchRss(ctx: Ctx): Promise<Post[]> {
  const res = await ctx.http(freshRssUrl(ctx.now()), { headers: { "User-Agent": USER_AGENT, ...NO_CACHE } });
  if (!res.ok) throw new Error(`RSS HTTP ${res.status}`);
  return parseRss(await res.text(), ctx.cfg.maxScanPosts);
}

/**
 * Bytes of the CNN archive read every run as a second, independent source:
 * enough for its newest ~30 posts, cheap enough for the free plan's CPU.
 */
export const CNN_FRESH_BYTES = 64 * 1024;

export async function fetchCnn(ctx: Ctx, bytes = CNN_READ_BYTES): Promise<Post[]> {
  const res = await ctx.http(CNN_ARCHIVE_JSON, {
    headers: { "User-Agent": USER_AGENT, Range: `bytes=0-${bytes - 1}`, ...NO_CACHE },
  });
  if (!res.ok) throw new Error(`CNN HTTP ${res.status}`);
  return parseCnnArchive(await readPrefix(res, bytes), ctx.cfg.maxScanPosts);
}

/** Union of two newest-first lists by post ID; the first list wins on duplicates. */
export function mergePosts(primary: Post[], secondary: Post[]): Post[] {
  const seen = new Set(primary.map((p) => p.id));
  return newestFirst([...primary, ...secondary.filter((p) => !seen.has(p.id))]);
}

/**
 * Fetch recent posts, newest first, from both sources at once and merge them,
 * so a post goes out as soon as EITHER source has it:
 *   - trumpstruth.org RSS (cache-bypassed; up to MAX_SCAN_POSTS, ~a week)
 *   - the newest ~30 posts of the CNN archive (updated every few minutes)
 * If last_seen isn't in the merged window, a deeper slice of the CNN archive
 * is read. Returns [] only when no source could be reached.
 */
export async function fetchPosts(ctx: Ctx, lastSeen: string): Promise<Post[]> {
  const [rss, cnn] = await Promise.allSettled([
    fetchRss(ctx),
    ctx.budget.canFetch(2) ? fetchCnn(ctx, CNN_FRESH_BYTES) : Promise.resolve([]),
  ]);
  if (rss.status === "rejected") ctx.log.warn("trumpstruth.org RSS failed:", rss.reason);
  if (cnn.status === "rejected") ctx.log.warn("CNN archive failed:", cnn.reason);
  const rssPosts = rss.status === "fulfilled" ? newestFirst(rss.value) : [];
  const cnnPosts = cnn.status === "fulfilled" ? newestFirst(cnn.value) : [];

  // Which source is ahead tells us about source lag; worth a log line.
  const rssIds = new Set(rssPosts.map((p) => p.id));
  const newestRss = rssPosts[0]?.id ?? "";
  const cnnOnly = cnnPosts.filter(
    (p) => !rssIds.has(p.id) && (!newestRss || BigInt(p.id) > BigInt(newestRss)),
  );
  if (cnnOnly.length) ctx.log.info(`${cnnOnly.length} post(s) seen first in the CNN archive (RSS lagging)`);

  const posts = mergePosts(rssPosts, cnnPosts);
  if (posts.length && (!lastSeen || contains(posts, lastSeen))) return posts;
  if (posts.length)
    ctx.log.warn(`last_seen not in the ${posts.length} newest posts — reading deeper into the CNN archive`);

  let archive: Post[] = [];
  if (ctx.budget.canFetch()) {
    try {
      archive = newestFirst(await fetchCnn(ctx));
    } catch (err) {
      ctx.log.warn("CNN archive deep scan failed:", err);
    }
  }
  if (archive.length && contains(archive, lastSeen)) return mergePosts(posts, archive);
  if (posts.length) return posts;
  if (archive.length) return archive;
  ctx.log.error("All post sources failed");
  return [];
}
