/**
 * Post sources: trumpstruth.org RSS (primary) and the CNN Truth Social archive
 * (fallback, and deep scan when the RSS window doesn't reach last_seen).
 */
import type { Ctx } from "./runtime";
import { isMeaningfulText, stripHtml } from "./text";

export interface Post {
  id: string;
  text: string;
  createdAt: string;
  url: string;
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

export function parseRss(xml: string, limit: number): Post[] {
  const posts: Post[] = [];
  for (const match of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const item = match[1] ?? "";
    const title = xmlTag(item, "title");
    const description = xmlTag(item, "description");
    const link = xmlTag(item, "link") || xmlTag(item, "guid");
    const text = stripHtml(description || title);
    if (!isMeaningfulText(text)) continue;
    const originalId = xmlTag(item, "truth:originalId");
    posts.push({
      id: originalId || (link ? (link.replace(/\/+$/, "").split("/").pop() ?? "") : ""),
      text,
      createdAt: xmlTag(item, "pubDate"),
      url: xmlTag(item, "truth:originalUrl") || link,
    });
    if (posts.length >= limit) break;
  }
  return posts;
}

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
    const body = String(item.content || item.text || "");
    const postText = stripHtml(body);
    if (!isMeaningfulText(postText)) continue;
    const id = String(item.id ?? "");
    posts.push({
      id,
      text: postText,
      createdAt: String(item.created_at ?? ""),
      url: id ? `${TRUTH_SOCIAL_PROFILE}/${id}` : "",
    });
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

export async function fetchRss(ctx: Ctx): Promise<Post[]> {
  const res = await ctx.http(TRUMPSTRUTH_RSS, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`RSS HTTP ${res.status}`);
  return parseRss(await res.text(), ctx.cfg.maxScanPosts);
}

export async function fetchCnn(ctx: Ctx): Promise<Post[]> {
  const res = await ctx.http(CNN_ARCHIVE_JSON, {
    headers: { "User-Agent": USER_AGENT, Range: `bytes=0-${CNN_READ_BYTES - 1}` },
  });
  if (!res.ok) throw new Error(`CNN HTTP ${res.status}`);
  return parseCnnArchive(await readPrefix(res, CNN_READ_BYTES), ctx.cfg.maxScanPosts);
}

/**
 * Fetch up to MAX_SCAN_POSTS recent posts, newest first. Uses the CNN archive
 * when the RSS fails, or when its window doesn't reach last_seen. Returns []
 * only when no source could be reached.
 */
export async function fetchPosts(ctx: Ctx, lastSeen: string): Promise<Post[]> {
  let posts: Post[] = [];
  try {
    posts = newestFirst(await fetchRss(ctx));
  } catch (err) {
    ctx.log.warn("trumpstruth.org RSS failed:", err);
  }
  if (posts.length && (!lastSeen || contains(posts, lastSeen))) return posts;
  if (posts.length) ctx.log.warn(`last_seen not in the RSS window of ${posts.length} posts — checking the CNN archive`);

  let archive: Post[] = [];
  if (ctx.budget.canFetch()) {
    try {
      archive = newestFirst(await fetchCnn(ctx));
    } catch (err) {
      ctx.log.warn("CNN archive fallback failed:", err);
    }
  }
  if (archive.length && (!posts.length || contains(archive, lastSeen))) return archive;
  if (posts.length) return posts;
  ctx.log.error("All post sources failed");
  return [];
}
