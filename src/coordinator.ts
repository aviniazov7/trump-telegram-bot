/**
 * Single-flight lease and per-post send claims.
 *
 * Cron Triggers can start a second invocation while one is still running
 * (a duplicate dispatch, or a retry). Workers KV is eventually consistent and
 * has no compare-and-swap, so two of those invocations can both read an empty
 * send log and both deliver. This object is the lock: requests to one id are
 * serialized, and its storage is strongly consistent.
 *
 * One instance ("cron") coordinates the whole bot. Send claims live here for
 * two days; KV keeps a mirror so the existing `sent:<post>` keys stay readable.
 */
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";

export const RUN_LOCK_NAME = "cron";
/** Long enough that a crashed run's lease expires before the next cron is blocked for good. */
export const RUN_LEASE_MS = 4 * 60 * 1000;
/** Claims older than this are dropped. Delivery retries give up after 60 minutes. */
const CLAIM_TTL_MS = 2 * 24 * 60 * 60 * 1000;
/**
 * How long a processed Telegram update_id is remembered. Telegram retries a
 * webhook that was slow or non-200 for about a day; two days covers that
 * window with margin. KV can't compare-and-swap, so the claim lives here.
 */
export const UPDATE_DEDUPE_TTL_MS = 2 * 24 * 60 * 60 * 1000;

interface Lease {
  token: string;
  until: number;
}

interface SendRecord {
  /** Last time this post's claim was touched (ms). */
  at: number;
  chats: Record<string, string>;
}

export interface RunLock {
  tryAcquire(now: number, ttlMs: number): Promise<string | null>;
  release(token: string): Promise<void>;
  claim(postId: string, chatIds: string[], prior: Record<string, string>, now: number): Promise<string[]>;
  record(postId: string, updates: Record<string, string | null>, now: number): Promise<void>;
  getLog(postId: string): Promise<Record<string, string>>;
  heartbeat(): Promise<number>;
  markHeartbeat(now: number): Promise<void>;
  /** True when this caller is the first to process `updateId` inside the TTL. */
  claimUpdate(updateId: number, now: number): Promise<boolean>;
  /** Drop a claim so a failed attempt can be retried. */
  releaseUpdate(updateId: number): Promise<void>;
  reset(): Promise<void>;
}

const sentKey = (postId: string) => `sent:${postId}`;

export class Coordinator extends DurableObject<Env> implements RunLock {
  async tryAcquire(now: number, ttlMs: number): Promise<string | null> {
    await this.prune(now);
    const lease = await this.ctx.storage.get<Lease>("lease");
    if (lease && lease.until > now) return null;
    const token = crypto.randomUUID();
    await this.ctx.storage.put("lease", { token, until: now + ttlMs } satisfies Lease);
    return token;
  }

  async release(token: string): Promise<void> {
    const lease = await this.ctx.storage.get<Lease>("lease");
    if (lease?.token === token) await this.ctx.storage.delete("lease");
  }

  /**
   * Chats this caller may send to. `prior` is the KV mirror (imported on
   * first use so a deploy doesn't resend posts KV already recorded).
   * Entries already present — including "sending" — are not returned.
   */
  async claim(
    postId: string,
    chatIds: string[],
    prior: Record<string, string>,
    now: number,
  ): Promise<string[]> {
    const key = sentKey(postId);
    return this.ctx.storage.transaction(async (txn) => {
      const current = (await txn.get<SendRecord>(key)) ?? { at: now, chats: {} };
      const chats = { ...prior, ...current.chats };
      const todo = [...new Set(chatIds)].filter((id) => id && !chats[id]);
      if (!todo.length) {
        if (!Object.keys(current.chats).length && Object.keys(prior).length) {
          await txn.put(key, { at: now, chats } satisfies SendRecord);
        }
        return [];
      }
      for (const id of todo) chats[id] = "sending";
      await txn.put(key, { at: now, chats } satisfies SendRecord);
      return todo;
    });
  }

  /** `null` releases a chat so a later run can send it. Anything else is final. */
  async record(postId: string, updates: Record<string, string | null>, now: number): Promise<void> {
    const key = sentKey(postId);
    await this.ctx.storage.transaction(async (txn) => {
      const current = (await txn.get<SendRecord>(key)) ?? { at: now, chats: {} };
      const chats = { ...current.chats };
      for (const [id, status] of Object.entries(updates)) {
        if (status === null || status === "") delete chats[id];
        else chats[id] = status;
      }
      await txn.put(key, { at: now, chats } satisfies SendRecord);
    });
  }

  async getLog(postId: string): Promise<Record<string, string>> {
    return (await this.ctx.storage.get<SendRecord>(sentKey(postId)))?.chats ?? {};
  }

  async heartbeat(): Promise<number> {
    return (await this.ctx.storage.get<number>("heartbeat")) ?? 0;
  }

  async markHeartbeat(now: number): Promise<void> {
    await this.ctx.storage.put("heartbeat", now);
  }

  async claimUpdate(updateId: number, now: number): Promise<boolean> {
    const key = `upd:${updateId}`;
    return this.ctx.storage.transaction(async (txn) => {
      const at = await txn.get<number>(key);
      if (at !== undefined && now - at < UPDATE_DEDUPE_TTL_MS) return false;
      await txn.put(key, now);
      return true;
    });
  }

  async releaseUpdate(updateId: number): Promise<void> {
    await this.ctx.storage.delete(`upd:${updateId}`);
  }

  /** Test helper. Wipes the lease, claims and heartbeat. */
  async reset(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }

  private async prune(now: number): Promise<void> {
    try {
      const stale: string[] = [];
      const claims = await this.ctx.storage.list<SendRecord>({ prefix: "sent:" });
      const claimCutoff = now - CLAIM_TTL_MS;
      for (const [key, value] of claims) if ((value?.at ?? 0) < claimCutoff) stale.push(key);
      const updates = await this.ctx.storage.list<number>({ prefix: "upd:" });
      const updateCutoff = now - UPDATE_DEDUPE_TTL_MS;
      for (const [key, at] of updates) if ((at ?? 0) < updateCutoff) stale.push(key);
      if (stale.length) await this.ctx.storage.delete(stale);
    } catch (err) {
      console.warn("Coordinator prune failed:", err instanceof Error ? err.message : String(err));
    }
  }
}
