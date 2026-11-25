/** Which posts are new, in what order to send them, and how far the cursor moves. */
import type { Post } from "./sources";

/**
 * Posts newer than lastSeen, oldest first (input is newest first).
 *
 * If lastSeen is empty (first run) or isn't in the window (an outage longer
 * than the scan window), only the newest post is returned — the safe cap that
 * keeps subscribers from being flooded.
 */
export const isNumericId = (id: string): boolean => /^\d+$/.test(id);

function oldestNumericId(posts: Post[]): bigint | null {
  if (!posts.length || !posts.every((p) => isNumericId(p.id))) return null;
  let min: bigint | null = null;
  for (const post of posts) {
    const id = BigInt(post.id);
    if (min === null || id < min) min = id;
  }
  return min;
}

/**
 * True when `lastSeen` fell completely behind the scanned window — i.e., even
 * the oldest post we fetched is still newer than `lastSeen`. False when
 * `lastSeen` is in `posts`, when the source is lagging behind `lastSeen`, or
 * when `lastSeen` was deleted inside the window.
 */
export function hasGap(posts: Post[], lastSeen: string): boolean {
  if (!lastSeen || !posts.length) return false;
  if (posts.some((p) => p.id === lastSeen)) return false;
  if (isNumericId(lastSeen)) {
    const oldest = oldestNumericId(posts);
    if (oldest !== null) return oldest > BigInt(lastSeen);
  }
  return true;
}

export function filterNewPosts(posts: Post[], lastSeen: string): Post[] {
  if (!posts.length) return [];
  if (!lastSeen) return posts.slice(0, 1);
  if (posts.some((p) => p.id === lastSeen)) {
    const fresh: Post[] = [];
    for (const post of posts) {
      if (post.id === lastSeen) break;
      fresh.push(post);
    }
    return fresh.reverse();
  }
  if (isNumericId(lastSeen) && posts.every((p) => isNumericId(p.id))) {
    if (hasGap(posts, lastSeen)) return posts.slice(0, 1);
    const cursorId = BigInt(lastSeen);
    return posts.filter((p) => BigInt(p.id) > cursorId).reverse();
  }
  return posts.slice(0, 1);
}

export interface Cursor {
  /** Every post up to and including this one is done. */
  lastSeen: string;
  /** Posts newer than lastSeen that are already done (sent out of order). */
  sentAhead: string[];
}

/**
 * Mark `doneId` finished and move lastSeen as far as possible.
 *
 * Posts can finish out of order (high impact first, or an older post still
 * retrying a chat), but lastSeen means "everything up to here is done", so it
 * only passes a post once all older new posts are done too. Finished posts
 * ahead of it wait in sentAhead and are skipped until the cursor catches up.
 */
export function advanceCursor(cursor: Cursor, chronologicalIds: string[], doneId = ""): void {
  const done = new Set(cursor.sentAhead);
  if (doneId) done.add(doneId);
  let ids = chronologicalIds;
  const at = ids.indexOf(cursor.lastSeen);
  if (at >= 0) {
    ids = ids.slice(at + 1);
  } else if (isNumericId(cursor.lastSeen)) {
    const cur = BigInt(cursor.lastSeen);
    ids = ids.filter((id) => !isNumericId(id) || BigInt(id) > cur);
  }
  for (const id of ids) {
    if (!done.has(id)) break;
    cursor.lastSeen = id;
    done.delete(id);
  }
  // Keep only IDs still ahead of the cursor; anything else is stale.
  cursor.sentAhead = ids.filter((id) => done.has(id));
}

/**
 * Send order: posts already partly sent first (finish what was started), then
 * high-impact posts, then the rest — each group oldest first.
 */
/**
 * KV key for the single Telegram message that covers these textless posts.
 * Short backlogs keep the ids readable; a long one is hashed so the key
 * stays under KV's limit.
 */
export function mediaDigestId(ids: string[]): string {
  const body = ids.join(".");
  if (body.length <= 420) return `digest:${body}`;
  let hash = 0xcbf29ce484222325n;
  for (const ch of body) {
    hash ^= BigInt(ch.codePointAt(0) ?? 0);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return `digest:${hash.toString(16)}`;
}

export function sendOrder<T extends { post: Post; impact: string | null }>(
  items: T[],
  startedIds: Set<string>,
): T[] {
  const rank = (item: T): number => (startedIds.has(item.post.id) ? 0 : item.impact === "high" ? 1 : 2);
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => rank(a.item) - rank(b.item) || a.index - b.index)
    .map(({ item }) => item);
}
