import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { DoKV } from "../src/do-kv";
import { emptyMeta, openStore, Store } from "../src/store";

/** Counts KV writes on the legacy namespace. */
class CountingKV {
  writes = 0;
  lists = 0;
  constructor(private readonly kv: KVNamespace) {}
  get(...a: Parameters<KVNamespace["get"]>) {
    return (this.kv.get as (...x: unknown[]) => unknown)(...a);
  }
  getWithMetadata(...a: Parameters<KVNamespace["getWithMetadata"]>) {
    return (this.kv.getWithMetadata as (...x: unknown[]) => unknown)(...a);
  }
  list(...a: Parameters<KVNamespace["list"]>) {
    this.lists += 1;
    return this.kv.list(...a);
  }
  put() {
    this.writes += 1;
    return Promise.resolve();
  }
  delete() {
    this.writes += 1;
    return Promise.resolve();
  }
}

const lock = () => env.COORDINATOR.getByName("cron");

beforeEach(async () => {
  for (const { name } of (await env.STATE.list()).keys) await env.STATE.delete(name);
  await lock().reset();
});

describe("Durable Object state (KV write reduction)", () => {
  it("migrates legacy meta on read and never writes KV", async () => {
    const legacy = { ...emptyMeta(), lastSeen: "42", sentAhead: ["43"], menu: "m1" };
    await env.STATE.put("meta", JSON.stringify(legacy));
    const kv = new CountingKV(env.STATE);
    const store = new Store(new DoKV(lock(), kv as unknown as KVNamespace) as unknown as KVNamespace, lock());
    const meta = await store.getMeta();
    expect(meta.lastSeen).toBe("42");
    expect(meta.sentAhead).toEqual(["43"]);
    await store.putMeta({ ...meta, lastSeen: "44" });
    expect((await store.getMeta()).lastSeen).toBe("44");
    expect(kv.writes).toBe(0);
    // Legacy KV untouched; the DO copy wins.
    expect(((await env.STATE.get("meta", "json")) as { lastSeen: string }).lastSeen).toBe("42");
  });

  it("imports legacy subscribers once, keeps topics, and honours deletes", async () => {
    await env.STATE.put("sub:1", "1", { metadata: { thread: "7" } });
    await env.STATE.put("sub:2", "1", { metadata: { thread: null } });
    const kv = new CountingKV(env.STATE);
    const mk = () =>
      new Store(new DoKV(lock(), kv as unknown as KVNamespace) as unknown as KVNamespace, lock());
    const store = mk();
    expect(await store.listSubscribers()).toEqual([
      { chatId: "1", threadId: "7" },
      { chatId: "2", threadId: null },
    ]);
    await store.deleteSubscriber("1");
    await store.putSubscriber("3", null);
    expect(await store.getSubscriber("1")).toBeNull();
    const again = mk();
    expect((await again.listSubscribers()).map((s) => s.chatId)).toEqual(["2", "3"]);
    expect(kv.lists).toBe(1);
    expect(kv.writes).toBe(0);
  });

  it("expires TTL keys", async () => {
    let now = 1_000_000;
    const kv = new DoKV(lock(), env.STATE, () => now);
    await kv.put("alert:x", "1", { expirationTtl: 60 });
    expect(await kv.get("alert:x")).toBe("1");
    now += 61_000;
    expect(await kv.get("alert:x")).toBeNull();
  });

  it("openStore defaults to the Durable Object", async () => {
    const store = openStore(env);
    await store.putMeta({ ...emptyMeta(), lastSeen: "9" });
    expect(await env.STATE.get("meta")).toBeNull();
    expect((await store.getMeta()).lastSeen).toBe("9");
  });
});
