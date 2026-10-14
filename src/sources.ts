/**
 * Post sources: trumpstruth.org RSS (primary) and the CNN Truth Social archive
 * (fallback, and deep scan when the RSS window doesn't reach last_seen).
 */
import type { Ctx } from "./runtime";
import { htmlUnescape, isMeaningfulText, stripHtml } from "./text";

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
  /**
   * Attachment file URLs, including a quoted post's video. Used to notice
   * the same file posted again under another status id.
   */
  mediaUrls?: string[];
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

/** Host + path, without a query, so the same file isn't two keys. */
export function canonicalMediaUrl(url: string): string {
  const bare = url.trim().split("?")[0]?.replace(/\/+$/, "") ?? "";
  try {
    const parsed = new URL(bare);
    return `${parsed.host}${parsed.pathname}`.toLowerCase();
  } catch {
    return bare.toLowerCase();
  }
}

/**
 * Wordless posts whose video file already belongs to an earlier status in
 * this window. Truth Social's re-post is a second id pointing at the same
 * mp4; the `RT:` line is usually there too, but a missing one must not
 * deliver the video again.
 */
export function sameMediaRepostIds(posts: Post[]): string[] {
  const chrono = [...posts].sort((a, b) => {
    if (/^\d+$/.test(a.id) && /^\d+$/.test(b.id)) {
      return BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0;
    }
    return 0;
  });
  const seen = new Set<string>();
  const skip: string[] = [];
  for (const post of chrono) {
    const videos = (post.mediaUrls ?? []).map(canonicalMediaUrl).filter((url) => VIDEO_URL_RE.test(url));
    if (!isMeaningfulText(post.text) && videos.some((url) => seen.has(url))) skip.push(post.id);
    for (const url of videos) seen.add(url);
  }
  return skip;
}

const MEDIA_LINK_RE = /<a\b([^>]*)>\s*View (image|video|media)\s*<\/a>/gi;

function attr(attrs: string, name: string): string {
  const match = new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i").exec(attrs);
  return match?.[1] ? htmlUnescape(match[1]) : "";
}

/** Split trumpstruth's post HTML into own text, media and the quoted post. */
export function parseTruthHtml(html: string): {
  text: string;
  media: MediaKind[];
  mediaUrls: string[];
  quote: Quote | null;
} {
  let body = html.replace(RT_HTML_RE, "");
  let quote: Quote | null = null;
  let quotedUrls: string[] = [];
  const quoted = /<blockquote>([\s\S]*?)<\/blockquote>/i.exec(body);
  const quotedBy = /<p>\s*Quoted\s*([\s\S]*?)<\/p>/i.exec(body);
  if (quoted) {
    const inner = parseTruthHtml(quoted[1] ?? "");
    quote = {
      author: stripHtml(quotedBy?.[1] ?? ""),
      text: inner.text,
      media: [...inner.media, ...(inner.quote?.media ?? [])],
    };
    quotedUrls = inner.mediaUrls;
    body = body.replace(quoted[0], "");
  }
  if (quotedBy) body = body.replace(quotedBy[0], "");
  const media: MediaKind[] = [];
  const mediaUrls: string[] = [];
  body = body.replace(MEDIA_LINK_RE, (_m, attrs: string, kind: string) => {
    media.push(kind.toLowerCase() === "video" ? "video" : "image");
    const href = attr(attrs, "href");
    if (href) mediaUrls.push(href);
    return "";
  });
  return { text: stripHtml(body), media, mediaUrls: [...mediaUrls, ...quotedUrls], quote };
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

const MEDIA_CONTENT_RE = /<media:content\b([^>]*)\/?>/gi;

function mediaKind(url: string, medium: string): MediaKind {
  if (medium.toLowerCase() === "video" || VIDEO_URL_RE.test(url)) return "video";
  return "image";
}

/** Caption on the post's own media, ignoring a quoted status's attachments. */
function ownMediaCaption(item: string): string {
  const own = item.replace(/<archive:reference\b[\s\S]*?<\/archive:reference>/gi, "");
  const description = stripHtml(xmlTag(own, "media:description"));
  const title = stripHtml(xmlTag(own, "media:title"));
  if (isMeaningfulText(description)) return description;
  if (isMeaningfulText(title)) return title;
  return "";
}

function xmlMedia(item: string): { url: string; kind: MediaKind }[] {
  const found: { url: string; kind: MediaKind }[] = [];
  for (const match of item.matchAll(MEDIA_CONTENT_RE)) {
    const url = attr(match[1] ?? "", "url");
    if (!url) continue;
    found.push({ url, kind: mediaKind(url, attr(match[1] ?? "", "medium")) });
  }
  return found;
}

function archiveReferenceId(item: string): string | null {
  const match = /<archive:reference\b[^>]*\boriginalId\s*=\s*["'](\d+)["']/i.exec(item);
  return match?.[1] ?? null;
}

function dedupeUrls(urls: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const url of urls) {
    const key = canonicalMediaUrl(url);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(url);
  }
  return out;
}

export function parseRss(xml: string, limit: number): Post[] {
  const posts: Post[] = [];
  const seen = new Set<string>();
  for (const match of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const item = match[1] ?? "";
    const description = xmlTag(item, "description");
    const title = stripHtml(xmlTag(item, "title"));
    const link = xmlTag(item, "link") || xmlTag(item, "guid");
    // Titles of text-less posts are placeholders ("Video post from …").
    // A real title is used only when the description has no words of its own.
    const parsed = description
      ? parseTruthHtml(description)
      : { text: "", media: [], mediaUrls: [], quote: null };
    const attachments = xmlMedia(item.replace(/<archive:reference\b[\s\S]*?<\/archive:reference>/gi, ""));
    const quotedAttachments = xmlMedia(
      /<archive:reference\b[\s\S]*?<\/archive:reference>/i.exec(item)?.[0] ?? "",
    );
    for (const attachment of attachments) {
      if (!parsed.media.includes(attachment.kind)) parsed.media.push(attachment.kind);
    }
    const caption = ownMediaCaption(item);
    const text = [parsed.text, caption, title].find((part) => isMeaningfulText(part)) ?? "";
    const post: Post = {
      id: xmlTag(item, "truth:originalId") || (link ? (link.replace(/\/+$/, "").split("/").pop() ?? "") : ""),
      text,
      createdAt: xmlTag(item, "pubDate"),
      url: xmlTag(item, "truth:originalUrl") || link,
      media: parsed.media,
      mediaUrls: dedupeUrls([
        ...parsed.mediaUrls,
        ...attachments.map((a) => a.url),
        ...quotedAttachments.map((a) => a.url),
      ]),
      quote: parsed.quote,
      repostOf: repostTarget(description) || repostTarget(title) || archiveReferenceId(item),
    };
    if (!post.id || !hasContent(post)) continue;
    const prior = seen.has(post.id) ? posts.findIndex((p) => p.id === post.id) : -1;
    if (prior >= 0) {
      const current = posts[prior];
      if (current) posts[prior] = combinePosts(current, post);
      continue;
    }
    seen.add(post.id);
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
    const urls = (Array.isArray(item.media) ? item.media : []).filter(
      (m): m is string => typeof m === "string",
    );
    const media: MediaKind[] = urls.map((url) => (VIDEO_URL_RE.test(url) ? "video" : "image"));
    const id = String(item.id ?? "");
    const post: Post = {
      id,
      text: isMeaningfulText(postText) ? postText : "",
      createdAt: String(item.created_at ?? ""),
      url: id ? `${TRUTH_SOCIAL_PROFILE}/${id}` : "",
      media,
      mediaUrls: dedupeUrls(urls),
      quote: null,
      repostOf: repostTarget(rawBody),
    };
    if (!id || posts.some((p) => p.id === id) || !hasContent(post)) continue;
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

function hasWords(post: Post): boolean {
  return isMeaningfulText(post.text) || isMeaningfulText(post.quote?.text ?? "");
}

/**
 * One status seen in both sources. The primary copy wins, except when only
 * the other copy actually has words — a caption must not be thrown away
 * because the RSS description was just "View video".
 */
function combinePosts(primary: Post, other: Post): Post {
  const useOther = !hasWords(primary) && hasWords(other);
  const base = useOther ? other : primary;
  const fill = useOther ? primary : other;
  return {
    ...base,
    url: base.url || fill.url,
    createdAt: base.createdAt || fill.createdAt,
    media: base.media?.length ? base.media : fill.media,
    mediaUrls: dedupeUrls([...(primary.mediaUrls ?? []), ...(other.mediaUrls ?? [])]),
    repostOf: base.repostOf || fill.repostOf || null,
    quote: base.quote ?? fill.quote ?? null,
    text: isMeaningfulText(base.text) ? base.text : fill.text,
  };
}

/** Union of two newest-first lists by post ID. See `combinePosts` for duplicates. */
export function mergePosts(primary: Post[], secondary: Post[]): Post[] {
  const extras = new Map(secondary.map((post) => [post.id, post]));
  const merged = primary.map((post) => {
    const other = extras.get(post.id);
    return other ? combinePosts(post, other) : post;
  });
  const seen = new Set(primary.map((p) => p.id));
  return newestFirst([...merged, ...secondary.filter((p) => !seen.has(p.id))]);
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
