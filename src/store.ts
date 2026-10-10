/**
 * Bot state in Workers KV.
 *
 * Keys:
 *   meta                    cursor (lastSeen, sentAhead), posts in progress,
 *                           heartbeat, source-failure counter, menu fingerprint
 *   sub:<chatId>            one key per subscriber; forum topic in metadata
 *   sent:<postId>:<chatId>  send log: how delivering that post to that chat
 *                           ended (see SendStatus). Expires after 30 days.
 *   analysis:<postId>       cached translation + tags, so a resumed post is
 *                           sent with the exact same text. Expires after 7 days.
 *   alert:<kind>            exists while that alert is muted (TTL = repeat window)
 *
 * Why one key per subscriber and per send: KV allows one write per second per
 * key and has no transactions. The webhook (adding subscribers) and the cron
 * (removing dead chats) never write the same key, so neither can overwrite
 * the other's change, and the send log never needs a read-modify-write.
 *
 * KV is eventually consistent (a write can take up to ~60 s to be visible in
 * other locations). Runs are a minute apart and each send is recorded in its
 * own key right after it happens, which keeps the window for a duplicate tiny;
 * see README → "Consistency".
 */
import type { Cursor } from "./posts";
import type { PostAnalysis } from "./tagging";
import type { SendStatus } from "./telegram";

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
}

export const emptyMeta = (): Meta => ({
  v: 1,
  lastSeen: "",
  sentAhead: [],
  pending: {},
  menu: "",
  lastSuccess: 0,
  sourceFailures: 0,
});

export interface Subscriber {
  chatId: string;
  threadId: string | null;
}

const DAY_S = 24 * 60 * 60;
export const SENT_TTL_S = 30 * DAY_S;
export const ANALYSIS_TTL_S = 7 * DAY_S;
/** KV's minimum expirationTtl. */
const MIN_TTL_S = 60;

export class Store {
  constructor(private readonly kv: KVNamespace) {}

  async getMeta(): Promise<Meta> {
    const raw = await this.kv.get<Partial<Meta>>("meta", "json");
    if (!raw) return emptyMeta();
    const meta = { ...emptyMeta(), ...raw };
    if (meta.v !== 1) throw new Error(`Unsupported state version ${String(meta.v)}`);
    return meta;
  }

  async putMeta(meta: Meta): Promise<void> {
    await this.kv.put("meta", JSON.stringify(meta));
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
    await this.kv.put(`sub:${chatId}`, "1", { metadata: { thread: threadId } });
  }

  async deleteSubscriber(chatId: string): Promise<void> {
    await this.kv.delete(`sub:${chatId}`);
  }

  async getSent(postId: string, chatId: string): Promise<SendStatus | null> {
    return (await this.kv.get(`sent:${postId}:${chatId}`)) as SendStatus | null;
  }

  async putSent(postId: string, chatId: string, status: SendStatus): Promise<void> {
    await this.kv.put(`sent:${postId}:${chatId}`, status, { expirationTtl: SENT_TTL_S });
  }

  async getAnalysis(postId: string): Promise<PostAnalysis | null> {
    return this.kv.get<PostAnalysis>(`analysis:${postId}`, "json");
  }

  async putAnalysis(postId: string, analysis: PostAnalysis): Promise<void> {
    await this.kv.put(`analysis:${postId}`, JSON.stringify(analysis), { expirationTtl: ANALYSIS_TTL_S });
  }

  async alertMuted(kind: string): Promise<boolean> {
    return (await this.kv.get(`alert:${kind}`)) !== null;
  }

  async muteAlert(kind: string, seconds: number): Promise<void> {
    await this.kv.put(`alert:${kind}`, "1", { expirationTtl: Math.max(MIN_TTL_S, seconds) });
  }

  async get(key: string): Promise<string | null> {
    return this.kv.get(key);
  }

  async put(key: string, value: string): Promise<void> {
    await this.kv.put(key, value);
  }
}
