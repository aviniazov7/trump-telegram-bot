/**
 * Bot state in Workers KV.
 *
 * Keys:
 *   meta                    cursor (lastSeen, sentAhead), posts in progress,
 *                           heartbeat, source-failure counter, menu fingerprint
 *   sub:<chatId>            one key per subscriber; forum topic in metadata
 *   sent:<postId>           mirror of the send claim in the Coordinator
 *                           Durable Object: { chatId: status }. The object
 *                           is what makes a send exactly-once; this key is
 *                           written once per post per run for operators and
 *                           for a deploy that still has claims only in KV.
 *                           Expires after 30 days.
 *   analysis:<postId>       cached translation + tags, so a resumed post is
 *                           sent with the exact same text. Expires after 7 days.
 *   gemini-quota:<model>    exists while that model's daily free quota is used
 *                           up; expires at the quota reset (midnight Pacific).
 *   gemini-error:<postId>   every failed Gemini attempt for that post: when it
 *                           first failed and each attempt's reason, per model.
 *                           Expires after 7 days. Read with
 *                           `npm run gemini-errors`.
 *   alert:<kind>            exists while that alert is muted (TTL = repeat window)
 *
 * Why claims live in the Durable Object: KV is eventually consistent and
 * cannot compare-and-swap. Two overlapping runs can both read an empty
 * `sent:<post>` and both deliver. The object reserves each chat before the
 * send. A failed reservation sends nothing. A failed mirror write leaves
 * the object holding "sending" or the final status, which counts as
 * delivered — at most once, never twice. The KV key is a mirror of that.
 *
 * Subscribers are one key each: the webhook (adding) and the cron (removing
 * dead chats) never write the same key, so neither overwrites the other.
 *
 * Every write goes through write(): any failure becomes a KvWriteError, which
 * stops the run's sends immediately (see broadcast.ts).
 */
import { RUN_LOCK_NAME, type RunLock } from "./coordinator";
import type { Env } from "./env";
import type { Cursor } from "./posts";
import type { PostAnalysis } from "./tagging";
import type { SendStatus } from "./telegram";

/** A KV write or delete failed (quota exhausted, rate limit, outage). */
export class KvWriteError extends Error {
  constructor(what: string, cause: unknown) {
    super(`KV write failed (${what}): ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "KvWriteError";
  }
}

/** "sending" = reserved by a run that may or may not have finished the send. */
export type LogStatus = SendStatus | "sending";
export type SendLog = Record<string, LogStatus>;

export interface Meta extends Cursor {
  v: 1;
  /** Posts started but not finished: postId → first attempt (ms). */
  pending: Record<string, number>;
  /** Fingerprint of the bot menu last applied to Telegram. */
  menu: string;
  /** End of the last successful run (ms); the heartbeat. */
  lastSuccess: number;
  /** Consecutive runs in which no post source could be reached. */
  sourceFailures: number;
  /**
   * Textless media posts already committed to one digest message.
   * Set before the send so a retry uses the same set and cannot include
   * a post that arrived later (that would deliver the earlier ones twice).
   */
  openDigest: string[];
}

export const emptyMeta = (): Meta => ({
  v: 1,
  lastSeen: "",
  sentAhead: [],
  pending: {},
  menu: "",
  lastSuccess: 0,
  sourceFailures: 0,
  openDigest: [],
});

export interface Subscriber {
  chatId: string;
  threadId: string | null;
}

const DAY_S = 24 * 60 * 60;
export const SENT_TTL_S = 30 * DAY_S;
export const ANALYSIS_TTL_S = 7 * DAY_S;
export const GEMINI_ERROR_TTL_S = 7 * DAY_S;
/** Attempts kept per post (newest last). */
const GEMINI_ERROR_MAX_ATTEMPTS = 20;

export interface GeminiFailureRecord {
  postId: string;
  /** First failed attempt (ms) — the retry window counts from here. */
  firstFailureAt: number;
  attempts: { at: number; error: string }[];
  /** Set once the post went out in English. */
  gaveUpAt?: number;
}
/** KV's minimum expirationTtl. */
const MIN_TTL_S = 60;

export function openStore(env: Env, kv: KVNamespace = env.STATE): Store {
  return new Store(kv, env.COORDINATOR.getByName(RUN_LOCK_NAME));
}

export class Store {
  /** KV writes made through this Store (for logs and tests). */
  writes = 0;

  constructor(
    private readonly kv: KVNamespace,
    private readonly lock: RunLock,
  ) {}

  tryAcquire(now: number, ttlMs: number): Promise<string | null> {
    return this.lock.tryAcquire(now, ttlMs);
  }

  release(token: string): Promise<void> {
    return this.lock.release(token);
  }

  heartbeat(): Promise<number> {
    return this.lock.heartbeat();
  }

  markHeartbeat(now: number): Promise<void> {
    return this.lock.markHeartbeat(now);
  }

  /**
   * Chats this run may send this post to. KV's mirror counts as already
   * sent (so existing claims survive the move to the Durable Object) and
   * is imported into the object on first claim.
   */
  async claimSends(postId: string, chatIds: string[], now: number): Promise<string[]> {
    const prior = await this.getSendLog(postId);
    return this.lock.claim(postId, chatIds, prior, now);
  }

  /** Record outcomes in the object, then mirror the full log to KV. */
  async recordSends(postId: string, updates: Record<string, string | null>, now: number): Promise<void> {
    await this.lock.record(postId, updates, now);
    await this.putSendLog(postId, (await this.lock.getLog(postId)) as SendLog);
  }

  private async write(what: string, op: () => Promise<void>): Promise<void> {
    try {
      await op();
      this.writes += 1;
    } catch (err) {
      throw new KvWriteError(what, err);
    }
  }

  async getMeta(): Promise<Meta> {
    const raw = await this.kv.get<Partial<Meta>>("meta", "json");
    if (!raw) return emptyMeta();
    const meta = { ...emptyMeta(), ...raw };
    if (!Array.isArray(meta.openDigest)) meta.openDigest = [];
    if (meta.v !== 1) throw new Error(`Unsupported state version ${String(meta.v)}`);
    return meta;
  }

  async putMeta(meta: Meta): Promise<void> {
    await this.write("meta", () => this.kv.put("meta", JSON.stringify(meta)));
  }

  async listSubscribers(): Promise<Subscriber[]> {
    const subs: Subscriber[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.kv.list<{ thread?: string | null }>({ prefix: "sub:", cursor });
      for (const key of page.keys) {
        subs.push({ chatId: key.name.slice(4), threadId: key.metadata?.thread ?? null });
      }
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
    return subs.sort((a, b) => a.chatId.localeCompare(b.chatId));
  }

  async getSubscriber(chatId: string): Promise<Subscriber | null> {
    const { value, metadata } = await this.kv.getWithMetadata<{ thread?: string | null }>(`sub:${chatId}`);
    return value === null ? null : { chatId, threadId: metadata?.thread ?? null };
  }

  async putSubscriber(chatId: string, threadId: string | null): Promise<void> {
    // Thread in metadata, so listSubscribers needs no per-key reads.
    await this.write("subscriber", () =>
      this.kv.put(`sub:${chatId}`, "1", { metadata: { thread: threadId } }),
    );
  }

  async deleteSubscriber(chatId: string): Promise<void> {
    await this.write("subscriber delete", () => this.kv.delete(`sub:${chatId}`));
  }

  async getSendLog(postId: string): Promise<SendLog> {
    return (await this.kv.get<SendLog>(`sent:${postId}`, "json")) ?? {};
  }

  async putSendLog(postId: string, log: SendLog): Promise<void> {
    await this.write("send log", () =>
      this.kv.put(`sent:${postId}`, JSON.stringify(log), { expirationTtl: SENT_TTL_S }),
    );
  }

  async getAnalysis(postId: string): Promise<PostAnalysis | null> {
    return this.kv.get<PostAnalysis>(`analysis:${postId}`, "json");
  }

  async putAnalysis(postId: string, analysis: PostAnalysis): Promise<void> {
    await this.write("analysis", () =>
      this.kv.put(`analysis:${postId}`, JSON.stringify(analysis), { expirationTtl: ANALYSIS_TTL_S }),
    );
  }

  async getGeminiFailures(postId: string): Promise<GeminiFailureRecord | null> {
    return this.kv.get<GeminiFailureRecord>(`gemini-error:${postId}`, "json");
  }

  /** Append one failed attempt (always saved, also when the post is later sent in English). */
  async recordGeminiFailure(postId: string, at: number, error: string): Promise<GeminiFailureRecord> {
    const record = (await this.getGeminiFailures(postId)) ?? { postId, firstFailureAt: at, attempts: [] };
    record.attempts = [...record.attempts, { at, error }].slice(-GEMINI_ERROR_MAX_ATTEMPTS);
    await this.putGeminiFailures(record);
    return record;
  }

  async putGeminiFailures(record: GeminiFailureRecord): Promise<void> {
    await this.write("gemini error", () =>
      this.kv.put(`gemini-error:${record.postId}`, JSON.stringify(record), {
        expirationTtl: GEMINI_ERROR_TTL_S,
      }),
    );
  }

  /** Why the model's daily quota is marked used up, or null. */
  async geminiQuotaExhausted(model: string): Promise<string | null> {
    return this.kv.get(`gemini-quota:${model}`);
  }

  async markGeminiQuotaExhausted(model: string, reason: string, seconds: number): Promise<void> {
    await this.write("gemini quota", () =>
      this.kv.put(`gemini-quota:${model}`, reason, {
        expirationTtl: Math.max(MIN_TTL_S, Math.ceil(seconds)),
      }),
    );
  }

  async alertMuted(kind: string): Promise<boolean> {
    return (await this.kv.get(`alert:${kind}`)) !== null;
  }

  async muteAlert(kind: string, seconds: number): Promise<void> {
    await this.write("alert mute", () =>
      this.kv.put(`alert:${kind}`, "1", { expirationTtl: Math.max(MIN_TTL_S, seconds) }),
    );
  }

  async get(key: string): Promise<string | null> {
    return this.kv.get(key);
  }

  async put(key: string, value: string): Promise<void> {
    await this.write(key, () => this.kv.put(key, value));
  }
}
