/** Which posts are new, in what order to send them, and how far the cursor moves. */
import type { Post } from "./sources";

/**
 * Posts newer than lastSeen, oldest first (input is newest first).
 *
 * If lastSeen is empty (first run) or isn't in the window (an outage longer
 * than the scan window), only the newest post is returned — the safe cap that
 * keeps subscribers from being flooded.
 */
export function filterNewPosts(posts: Post[], lastSeen: string): Post[] {
  if (!lastSeen || !posts.some((p) => p.id === lastSeen)) return posts.slice(0, 1);
  const fresh: Post[] = [];
  for (const post of posts) {
    if (post.id === lastSeen) break;
    fresh.push(post);
  }
  return fresh.reverse();
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
  if (at >= 0) ids = ids.slice(at + 1);
  for (const id of ids) {
    if (!done.has(id)) break;
    cursor.lastSeen = id;
    done.delete(id);
  }
  // Keep only IDs still ahead of the cursor; anything else is stale.
  cursor.sentAhead = chronologicalIds.filter((id) => done.has(id));
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
