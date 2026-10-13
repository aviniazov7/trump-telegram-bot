import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { menuFingerprint, POST_RETRY_WINDOW_MS, runCron } from "../src/broadcast";
import type { Config } from "../src/config";
import type { RunLock } from "../src/coordinator";
import { resetMemoryMutes } from "../src/monitor";
import { emptyMeta, openStore, Store } from "../src/store";
import {
  CNN_HOST,
  GEMINI,
  geminiAnswer,
  type Handler,
  json,
  RSS_HOST,
  rssFeed,
  TELEGRAM,
  testCtx,
} from "./helpers";

const NOW = 1_800_000_000_000;
const store = openStore(env);

beforeEach(async () => {
  for (const { name } of (await env.STATE.list()).keys) await env.STATE.delete(name);
  await env.COORDINATOR.getByName("cron").reset();
  resetMemoryMutes();
});

/** A fake Telegram that records sends and can misbehave per chat. */
class FakeTelegram {
  sent: { chat: string; text: string; thread?: number }[] = [];
  behavior = new Map<string, (n: number) => Response>();
  methods: string[] = [];
  private counts = new Map<string, number>();

  handler: Handler = (call) => {
    const method = call.url.split("/").pop() ?? "";
    this.methods.push(method);
    if (method !== "sendMessage") return json({ ok: true, result: true });
    const body = JSON.parse(call.body) as { chat_id: string; text: string; message_thread_id?: number };
    const n = this.counts.get(body.chat_id) ?? 0;
    this.counts.set(body.chat_id, n + 1);
    const custom = this.behavior.get(body.chat_id);
    if (custom) {
      const res = custom(n);
      if (res.status !== 200) return res;
    }
    this.sent.push({ chat: body.chat_id, text: body.text, thread: body.message_thread_id });
    return json({ ok: true, result: { message_id: this.sent.length } });
  };

  postsTo(chat: string): string[] {
    return this.sent.filter((s) => s.chat === chat).map((s) => /number-(\w+)/.exec(s.text)?.[1] ?? "?");
  }
}

const tgError = (code: number, description: string, parameters?: Record<string, unknown>) =>
  json({ ok: false, error_code: code, description, ...(parameters ? { parameters } : {}) }, code);

function setup(opts: {
  feed: string[];
  impacts?: Record<string, "high" | "medium" | "low">;
  cfg?: Partial<Config>;
  now?: number;
  gemini?: Handler;
}) {
  const tg = new FakeTelegram();
  const gemini: Handler =
    opts.gemini ??
    ((call) => {
      const text = JSON.parse(call.body).contents[0].parts[0].text as string;
      const id = /number-(\w+)/.exec(text)?.[1] ?? "";
      return json(
        geminiAnswer({
          hebrew: `תרגום של פוסט number-${id}`,
          categories: ["other"],
          impact: opts.impacts?.[id] ?? "low",
        }),
      );
    });
  const ctx = testCtx(
    {
      [RSS_HOST]: () => new Response(rssFeed(opts.feed, (id) => `Post number-${id} here`)),
      [TELEGRAM]: tg.handler,
      [GEMINI]: gemini,
    },
    { maxSubrequests: 200, ...opts.cfg },
    { now: () => opts.now ?? NOW },
  );
  return { tg, ctx, run: () => runCron(ctx, store) };
}

async function seed(
  lastSeen: string,
  subscribers: string[],
  extra: Partial<ReturnType<typeof emptyMeta>> = {},
) {
  await store.putMeta({
    ...emptyMeta(),
    lastSeen,
    lastSuccess: NOW,
    menu: await menuFingerprint("test-bot-token"),
    ...extra,
  });
  for (const chat of subscribers) await store.putSubscriber(chat, null);
}

describe("new posts and idempotent delivery", () => {
  it("sends a backlog oldest first to every subscriber and advances the cursor", async () => {
    await seed("1", ["a", "b"]);
    const { tg, run } = setup({ feed: ["4", "3", "2", "1"] });
    await run();
    expect(tg.postsTo("a")).toEqual(["2", "3", "4"]);
    expect(tg.postsTo("b")).toEqual(["2", "3", "4"]);
    const meta = await store.getMeta();
    expect(meta).toMatchObject({ lastSeen: "4", sentAhead: [], pending: {} });
    expect((await store.getSendLog("3")).a).toBe("ok");
  });

  it("never sends the same post twice, even if the cursor didn't move", async () => {
    await seed("1", ["a"]);
    await setup({ feed: ["2", "1"] }).run();
    // Simulate a stale meta read (KV eventual consistency): cursor back at 1.
    await store.putMeta({ ...(await store.getMeta()), lastSeen: "1" });
    const second = setup({ feed: ["2", "1"] });
    await second.run();
    expect(second.tg.sent).toEqual([]);
    expect((await store.getMeta()).lastSeen).toBe("2");
  });

  it("resumes a partial send in the next run without repeating anyone", async () => {
    await seed("1", ["a", "b", "c"]);
    // Budget for: RSS + CNN + Gemini + one send (+2 reserved).
    const first = setup({ feed: ["2", "1"], cfg: { maxSubrequests: 6 } });
    await first.run();
    expect(first.tg.postsTo("a")).toEqual(["2"]);
    expect(first.tg.sent).toHaveLength(1);
    expect((await store.getMeta()).lastSeen).toBe("1");
    expect(Object.keys((await store.getMeta()).pending)).toEqual(["2"]);

    const second = setup({ feed: ["2", "1"] });
    await second.run();
    expect(second.tg.sent.map((s) => s.chat)).toEqual(["b", "c"]);
    expect((await store.getMeta()).lastSeen).toBe("2");
    // The cached analysis was reused: Gemini was asked only once in total.
    expect(second.ctx.hosts()).not.toContain(GEMINI);
  });

  it("takes only the newest post on the very first run", async () => {
    await seed("", ["a"]);
    const { tg, run } = setup({ feed: ["3", "2", "1"] });
    await run();
    expect(tg.postsTo("a")).toEqual(["3"]);
  });

  it("does nothing when there is nothing new", async () => {
    await seed("2", ["a"]);
    const { tg, ctx, run } = setup({ feed: ["2", "1"] });
    await run();
    expect(tg.sent).toEqual([]);
    expect(ctx.hosts().sort()).toEqual([CNN_HOST, RSS_HOST].sort());
  });

  it("delivers to the forum topic a group subscribed from", async () => {
    await seed("1", []);
    await store.putSubscriber("-100", "77");
    const { tg, run } = setup({ feed: ["2", "1"] });
    await run();
    expect(tg.sent[0]).toMatchObject({ chat: "-100", thread: 77 });
  });
});

describe("Gemini failures", () => {
  const MIN = 60_000;
  const fail = () =>
    new Response('{"error":{"code":503,"message":"The model is overloaded."}}', { status: 503 });
  const translate = (call: { body: string }) => {
    const text = JSON.parse(call.body).contents[0].parts[0].text as string;
    const id = /number-(\w+)/.exec(text)?.[1] ?? "";
    return json(geminiAnswer({ hebrew: `תרגום של פוסט number-${id}`, categories: ["other"], impact: "low" }));
  };
  const alerts = (tg: FakeTelegram) =>
    tg.sent.filter((s) => s.chat === "999" && s.text.includes("Gemini נכשל"));
  const runAt = async (minutes: number, gemini: Handler) => {
    const s = setup({ feed: ["2", "1"], now: NOW + minutes * MIN, gemini });
    await s.run();
    return s;
  };

  it("retries every run for 15 minutes, then sends in English with one alert, saving every reason", async () => {
    await seed("1", ["a"]);
    for (const minute of [0, 5, 10]) {
      const r = await runAt(minute, fail);
      expect(r.tg.sent).toEqual([]); // held back, not sent in English yet
    }
    const last = await runAt(15, fail);
    expect(last.tg.postsTo("a")).toEqual(["2"]);
    expect(last.tg.sent.find((s) => s.chat === "a")?.text).toContain("התרגום לעברית נכשל");
    expect(alerts(last.tg)).toHaveLength(1);
    expect(alerts(last.tg)[0]?.text).toContain("overloaded");

    const record = await store.getGeminiFailures("2");
    expect(record?.firstFailureAt).toBe(NOW);
    expect(record?.gaveUpAt).toBe(NOW + 15 * MIN);
    expect(record?.attempts).toHaveLength(4);
    expect(record?.attempts[0]?.error).toMatch(
      /gemini-3\.5-flash-lite: HTTP 503.*\| gemini-3\.8-flash: HTTP 503/,
    );
    expect((await store.getMeta()).lastSeen).toBe("2");
  });

  it("sends the Hebrew translation as soon as a retry succeeds", async () => {
    await seed("1", ["a"]);
    expect((await runAt(0, fail)).tg.sent).toEqual([]);
    const ok = await runAt(5, translate);
    expect(ok.tg.sent[0]?.text).toContain("תרגום של פוסט number-2");
    expect(alerts(ok.tg)).toEqual([]);
    expect((await store.getGeminiFailures("2"))?.attempts).toHaveLength(1); // the failure stays on record
  });

  it("lets newer posts go out while an older one waits for Gemini", async () => {
    await seed("1", ["a"]);
    const s = setup({
      feed: ["3", "2", "1"],
      gemini: (call) =>
        JSON.parse(call.body).contents[0].parts[0].text.includes("number-2") ? fail() : translate(call),
    });
    await s.run();
    expect(s.tg.postsTo("a")).toEqual(["3"]);
    expect(await store.getMeta()).toMatchObject({ lastSeen: "1", sentAhead: ["3"] });
  });

  it("saves the primary model's failure when the fallback model saves the post", async () => {
    await seed("1", ["a"]);
    const s = setup({
      feed: ["2", "1"],
      gemini: (call) => (call.url.includes("gemini-3.5-flash-lite") ? fail() : translate(call)),
    });
    await s.run();
    expect(s.tg.postsTo("a")).toEqual(["2"]);
    expect((await store.getAnalysis("2"))?.model).toBe("gemini-3.8-flash");
    expect((await store.getGeminiFailures("2"))?.attempts[0]?.error).toContain(
      "gemini-3.5-flash-lite: HTTP 503",
    );
  });

  it("still sends the alert when Gemini used up the run's time (the Oct 12 bug)", async () => {
    await seed("1", ["a"]);
    // The post has been failing for 20 minutes, so this run gives up on it.
    await store.putGeminiFailures({ postId: "2", firstFailureAt: NOW - 20 * MIN, attempts: [] });
    let t = NOW;
    const tg = new FakeTelegram();
    const ctx = testCtx(
      {
        [RSS_HOST]: () => new Response(rssFeed(["2", "1"], (id) => `Post number-${id} here`)),
        [TELEGRAM]: tg.handler,
        [GEMINI]: () => {
          t += 95_000; // a call that hangs past the 90 s run budget
          return fail();
        },
      },
      { maxSubrequests: 200 },
      { now: () => t },
    );
    await runCron(ctx, store);
    expect(ctx.budget.timeUp()).toBe(true);
    expect(alerts(tg)).toHaveLength(1); // before the fix: dropped silently
    expect(tg.postsTo("a")).toEqual([]); // no time left to deliver; next run will
  });
});

describe("media-only posts", () => {
  it("are delivered with a short line and never sent to Gemini", async () => {
    await seed("1", ["a"]);
    const tg = new FakeTelegram();
    const video = '</p><p><a href="https://archive.example/v.mp4">View video</a>';
    const ctx = testCtx(
      {
        [RSS_HOST]: () =>
          new Response(rssFeed(["2", "1"], (id) => (id === "2" ? video : `Post number-${id}`))),
        [TELEGRAM]: tg.handler,
      },
      { maxSubrequests: 200 },
      { now: () => NOW },
    );
    await runCron(ctx, store);
    expect(tg.sent).toHaveLength(1);
    expect(tg.sent[0]?.text).toContain("🎥 פוסט וידאו ללא טקסט");
    expect(tg.sent[0]?.text).not.toContain("View video");
    expect(ctx.hosts()).not.toContain(GEMINI);
    expect(await store.getAnalysis("2")).toBeNull(); // nothing to cache
    expect((await store.getMeta()).lastSeen).toBe("2");
  });
});

describe("Telegram errors during a broadcast", () => {
  it("unsubscribes chats that blocked the bot and still delivers to the rest", async () => {
    await seed("1", ["a", "b"]);
    const { tg, run } = setup({ feed: ["2", "1"] });
    tg.behavior.set("a", () => tgError(403, "Forbidden: bot was blocked by the user"));
    await run();
    expect(tg.postsTo("b")).toEqual(["2"]);
    expect(await store.getSubscriber("a")).toBeNull();
    expect((await store.getMeta()).lastSeen).toBe("2");
  });

  it("never resends after a timeout", async () => {
    await seed("1", ["a"]);
    const first = setup({ feed: ["2", "1"] });
    first.tg.behavior.set("a", () => {
      throw new DOMException("timed out", "TimeoutError");
    });
    await first.run();
    expect((await store.getSendLog("2")).a).toBe("uncertain");
    expect((await store.getMeta()).lastSeen).toBe("2");

    const second = setup({ feed: ["3", "2", "1"] });
    await second.run();
    expect(second.tg.postsTo("a")).toEqual(["3"]);
  });

  it("retries a definitely-unsent chat next run, then gives up after the window", async () => {
    await seed("1", ["a", "b"]);
    const first = setup({ feed: ["2", "1"] });
    first.tg.behavior.set("a", () => tgError(429, "Too Many Requests", { retry_after: 600 }));
    await first.run();
    expect(first.tg.postsTo("b")).toEqual(["2"]);
    expect((await store.getMeta()).lastSeen).toBe("1");

    const second = setup({ feed: ["2", "1"] });
    await second.run();
    expect(second.tg.sent.map((s) => s.chat)).toEqual(["a"]); // b not repeated
    expect((await store.getMeta()).lastSeen).toBe("2");
  });

  it("stops retrying a chat after the retry window", async () => {
    await seed("1", ["a"], { pending: { "2": NOW - POST_RETRY_WINDOW_MS - 1 } });
    const { tg, run } = setup({ feed: ["2", "1"] });
    tg.behavior.set("a", () => tgError(429, "Too Many Requests", { retry_after: 600 }));
    await run();
    expect((await store.getMeta()).lastSeen).toBe("2");
  });

  it("moves a migrated group to its new ID", async () => {
    await seed("1", []);
    await store.putSubscriber("-5", "12");
    const { tg, run } = setup({ feed: ["2", "1"] });
    tg.behavior.set("-5", () =>
      tgError(400, "Bad Request: group chat was upgraded", { migrate_to_chat_id: -100777 }),
    );
    await run();
    expect(tg.postsTo("-100777")).toEqual(["2"]);
    expect(await store.getSubscriber("-5")).toBeNull();
    expect(await store.getSubscriber("-100777")).toEqual({ chatId: "-100777", threadId: "12" });
  });
});

describe("high impact first", () => {
  it("sends a high-impact post ahead of an older backlog, without skipping or repeating", async () => {
    await seed("1", ["a"]);
    // Room for RSS + CNN + 4 Gemini calls + one send.
    const first = setup({
      feed: ["5", "4", "3", "2", "1"],
      impacts: { "4": "high" },
      cfg: { maxSubrequests: 9 },
    });
    await first.run();
    expect(first.tg.postsTo("a")).toEqual(["4"]);
    expect(first.tg.sent[0]?.text.startsWith("🔴")).toBe(true);
    expect(await store.getMeta()).toMatchObject({ lastSeen: "1", sentAhead: ["4"] });

    const second = setup({ feed: ["5", "4", "3", "2", "1"], impacts: { "4": "high" } });
    await second.run();
    expect(second.tg.postsTo("a")).toEqual(["2", "3", "5"]);
    expect(await store.getMeta()).toMatchObject({ lastSeen: "5", sentAhead: [] });
  });
});

describe("dry run", () => {
  it("previews each post to the admin only and leaves subscribers' send log untouched", async () => {
    await seed("1", ["a", "b"]);
    const { tg, run } = setup({ feed: ["3", "2", "1"], cfg: { dryRun: true } });
    await run();
    expect(tg.sent.map((s) => s.chat)).toEqual(["999", "999"]);
    expect(tg.sent[0]?.text).toContain("DRY RUN");
    expect(tg.sent[0]?.text).toContain("ל-2 מנויים");
    expect((await store.getSendLog("2")).a).toBeUndefined();
    expect((await store.getMeta()).lastSeen).toBe("3");
  });

  it("never unsubscribes anyone", async () => {
    await seed("1", ["a"]);
    const { tg, run } = setup({ feed: ["2", "1"], cfg: { dryRun: true, adminChatId: "999" } });
    tg.behavior.set("999", () => tgError(403, "Forbidden: bot was blocked by the user"));
    await run();
    expect(await store.getSubscriber("a")).not.toBeNull();
  });
});

describe("monitoring", () => {
  const adminAlerts = (tg: FakeTelegram) =>
    tg.sent.filter((s) => s.chat === "999" && s.text.includes("התראת"));

  it("alerts when the last successful run is too old, once per hour", async () => {
    await seed("1", ["a"], { lastSuccess: NOW - 40 * 60_000 });
    const first = setup({ feed: ["1"] });
    await first.run();
    expect(adminAlerts(first.tg)[0]?.text).toContain("40 דק׳");
    expect((await store.getMeta()).lastSuccess).toBe(NOW);

    resetMemoryMutes(); // a fresh Worker instance still sees the KV mute
    await env.COORDINATOR.getByName("cron").reset(); // drop the heartbeat this run just wrote
    await store.putMeta({ ...(await store.getMeta()), lastSuccess: NOW - 40 * 60_000 });
    const second = setup({ feed: ["1"] });
    await second.run();
    expect(adminAlerts(second.tg)).toEqual([]);
  });

  it("refreshes the heartbeat on every success, so one missed cron is not an outage", async () => {
    await seed("1", ["a"], { lastSuccess: NOW - 10 * 60_000 });
    const { tg, run } = setup({ feed: ["1"] });
    await run();
    expect(adminAlerts(tg)).toEqual([]);
    expect((await store.getMeta()).lastSuccess).toBe(NOW);
    expect(await store.heartbeat()).toBe(NOW);
  });

  it("does not page while runs keep succeeding, even across the old 30-minute heartbeat", async () => {
    await seed("1", ["a"], { lastSuccess: NOW });
    for (let step = 1; step <= 8; step++) {
      const tick = setup({ feed: ["1"], now: NOW + step * 5 * 60_000 });
      await tick.run();
      expect(adminAlerts(tick.tg)).toEqual([]);
    }
    expect((await store.getMeta()).lastSuccess).toBe(NOW + 8 * 5 * 60_000);
  });

  it("alerts only once the gap is actually past STALE_ALERT_MINUTES", async () => {
    await seed("1", ["a"], { lastSuccess: NOW - 35 * 60_000 });
    const under = setup({ feed: ["1"] });
    await under.run();
    expect(adminAlerts(under.tg)).toEqual([]);

    await env.COORDINATOR.getByName("cron").reset();
    await store.putMeta({ ...(await store.getMeta()), lastSuccess: NOW - 36 * 60_000 });
    const over = setup({ feed: ["1"] });
    await over.run();
    expect(adminAlerts(over.tg)[0]?.text).toContain("36 דק׳");
  });

  it("alerts after 10 runs in a row without a reachable source", async () => {
    await seed("1", ["a"], { sourceFailures: 8 });
    const failing = () => {
      const tg = new FakeTelegram();
      const ctx = testCtx({ [TELEGRAM]: tg.handler }, {}, { now: () => NOW });
      return { tg, run: () => runCron(ctx, store) };
    };
    const ninth = failing();
    await ninth.run();
    expect(adminAlerts(ninth.tg)).toEqual([]);
    const tenth = failing();
    await tenth.run();
    expect(adminAlerts(tenth.tg)[0]?.text).toContain("10 ריצות");
    expect((await store.getMeta()).sourceFailures).toBe(10);

    // A working run resets the counter.
    await setup({ feed: ["1"] }).run();
    expect((await store.getMeta()).sourceFailures).toBe(0);
  });

  it("alerts when lastSeen fell out of the scanned window", async () => {
    await seed("1", ["a"]);
    const tg = new FakeTelegram();
    const ctx = testCtx(
      {
        [RSS_HOST]: () => new Response(rssFeed(["9", "8"], (id) => `Post number-${id}`)),
        [TELEGRAM]: tg.handler,
        [CNN_HOST]: () => new Response("[]"),
      },
      { geminiApiKey: "" },
      { now: () => NOW },
    );
    await runCron(ctx, store);
    expect(adminAlerts(tg)[0]?.text).toContain("ייתכן שפוסטים הוחמצו");
  });

  it("pings the healthcheck URL after a successful run", async () => {
    await seed("1", ["a"]);
    const tg = new FakeTelegram();
    let pinged = 0;
    const ctx = testCtx(
      {
        [RSS_HOST]: () => new Response(rssFeed(["1"])),
        [TELEGRAM]: tg.handler,
        "hc-ping.com": () => {
          pinged += 1;
          return new Response("OK");
        },
      },
      { healthcheckUrl: "https://hc-ping.com/abc" },
      { now: () => NOW },
    );
    await runCron(ctx, store);
    expect(pinged).toBe(1);
  });
});

describe("bot menu", () => {
  it("is applied once and then skipped until the config or token changes", async () => {
    await store.putMeta({ ...emptyMeta(), lastSeen: "1", lastSuccess: NOW });
    const first = setup({ feed: ["1"] });
    await first.run();
    expect(first.tg.methods).toEqual(["setMyCommands", "setChatMenuButton"]);
    const second = setup({ feed: ["1"] });
    await second.run();
    expect(second.tg.methods).toEqual([]);
    expect(await menuFingerprint("another-token")).not.toBe(await menuFingerprint("test-bot-token"));
  });
});

/** KV wrapper whose writes fail on demand, like an exhausted free-plan quota. */
class FlakyKV {
  writes: string[] = [];
  failAll = false;
  failWhen: (key: string, priorWritesToKey: number) => boolean = () => false;

  constructor(private readonly kv: KVNamespace) {}

  private check(key: string) {
    const prior = this.writes.filter((k) => k === key).length;
    if (this.failAll || this.failWhen(key, prior)) throw new Error("KV put() limit exceeded for the day.");
    this.writes.push(key);
  }
  get(...args: Parameters<KVNamespace["get"]>) {
    return (this.kv.get as (...a: unknown[]) => unknown)(...args);
  }
  getWithMetadata(...args: Parameters<KVNamespace["getWithMetadata"]>) {
    return (this.kv.getWithMetadata as (...a: unknown[]) => unknown)(...args);
  }
  list(...args: Parameters<KVNamespace["list"]>) {
    return this.kv.list(...args);
  }
  async put(key: string, value: string, opts?: KVNamespacePutOptions) {
    this.check(key);
    return this.kv.put(key, value, opts);
  }
  async delete(key: string) {
    this.check(key);
    return this.kv.delete(key);
  }
}

describe("KV write failures", () => {
  const adminAlerts = (tg: FakeTelegram) => tg.sent.filter((s) => s.chat === "999" && s.text.includes("KV"));

  function flakySetup(flaky: FlakyKV, feed: string[]) {
    const s = setup({ feed });
    return { ...s, run: () => runCron(s.ctx, openStore(env, flaky as unknown as KVNamespace)) };
  }

  it("stops all sends when the send log can't be saved, alerts once, and never re-sends", async () => {
    await seed("1", ["a", "b"]);
    const flaky = new FlakyKV(env.STATE);
    // The claim is in the Durable Object. The KV mirror is the write that fails.
    flaky.failWhen = (key) => key === "sent:2";

    const first = flakySetup(flaky, ["3", "2", "1"]);
    await first.run();
    expect(first.tg.postsTo("a")).toEqual(["2"]);
    expect(first.tg.postsTo("b")).toEqual(["2"]);
    // Halted: post 3 was not sent in this run.
    expect(adminAlerts(first.tg)).toHaveLength(1);
    expect(adminAlerts(first.tg)[0]?.text).toContain("עצרתי את כל השליחות");

    // KV is now out of writes entirely: later runs send nothing and don't re-alert.
    flaky.failAll = true;
    for (let i = 0; i < 3; i++) {
      const next = flakySetup(flaky, ["3", "2", "1"]);
      await next.run();
      expect(next.tg.sent.filter((s) => s.chat !== "999")).toEqual([]);
      expect(adminAlerts(next.tg)).toEqual([]);
    }

    // Quota back: post 3 goes out; post 2 is never repeated (its claim stands).
    flaky.failAll = false;
    flaky.failWhen = () => false;
    const recovered = flakySetup(flaky, ["3", "2", "1"]);
    await recovered.run();
    expect(recovered.tg.postsTo("a")).toEqual(["3"]);
    expect(recovered.tg.postsTo("b")).toEqual(["3"]);
    expect((await store.getMeta()).lastSeen).toBe("3");
  });

  it("sends nothing when the send claim can't be recorded", async () => {
    await seed("1", ["a", "b"]);
    const real = env.COORDINATOR.getByName("cron");
    const lock: RunLock = {
      tryAcquire: (now, ttl) => real.tryAcquire(now, ttl),
      release: (token) => real.release(token),
      claim: () => Promise.reject(new Error("coordinator unavailable")),
      record: (postId, updates, now) => real.record(postId, updates, now),
      getLog: (postId) => real.getLog(postId),
      heartbeat: () => real.heartbeat(),
      markHeartbeat: (now) => real.markHeartbeat(now),
      reset: () => real.reset(),
    };
    const { tg, ctx } = setup({ feed: ["2", "1"] });
    await expect(runCron(ctx, new Store(env.STATE, lock))).rejects.toThrow(/coordinator unavailable/);
    expect(tg.sent.filter((s) => s.chat !== "999")).toEqual([]);
  });

  it("stops mid-post when unsubscribing a dead chat fails, and releases the rest", async () => {
    await seed("1", ["a", "b", "c"]);
    const flaky = new FlakyKV(env.STATE);
    flaky.failWhen = (key) => key === "sub:a";
    const first = flakySetup(flaky, ["2", "1"]);
    first.tg.behavior.set("a", () => tgError(403, "Forbidden: bot was blocked by the user"));
    await first.run();
    expect(first.tg.sent.filter((s) => s.chat !== "999")).toEqual([]); // b and c not sent after the failure
    const log = await store.getSendLog("2");
    expect(log).toEqual({ a: "gone" }); // b and c released for the next run

    flaky.failWhen = () => false;
    const second = flakySetup(flaky, ["2", "1"]);
    await second.run();
    expect(second.tg.sent.map((s) => s.chat)).toEqual(["b", "c"]);
  });

  it("does not deliver a post whose analysis can't be cached", async () => {
    await seed("1", ["a"]);
    const flaky = new FlakyKV(env.STATE);
    flaky.failWhen = (key) => key.startsWith("analysis:");
    const { tg, run } = flakySetup(flaky, ["2", "1"]);
    await run();
    expect(tg.postsTo("a")).toEqual([]);
  });

  it("mirrors the send log to KV once per post, however many subscribers", async () => {
    await seed("1", ["a", "b", "c", "d", "e"]);
    const flaky = new FlakyKV(env.STATE);
    const { tg, run } = flakySetup(flaky, ["2", "1"]);
    await run();
    expect(tg.sent).toHaveLength(5);
    expect(flaky.writes.filter((k) => k.startsWith("sent:"))).toEqual(["sent:2"]);
    // mirror + analysis + meta (cursor and heartbeat)
    expect(flaky.writes).toHaveLength(3);
  });
});

describe("overlapping runs and pure re-posts", () => {
  it("delivers each post once when two runs start together", async () => {
    await seed("1", ["a", "b"]);
    const one = setup({ feed: ["2", "1"] });
    const two = setup({ feed: ["2", "1"] });
    const [first, second] = await Promise.all([one.run(), two.run()]);
    expect([first, second].filter((r) => r === "busy")).toHaveLength(1);
    const sent = [...one.tg.postsTo("a"), ...two.tg.postsTo("a")];
    expect(sent).toEqual(["2"]);
    expect([...one.tg.postsTo("b"), ...two.tg.postsTo("b")]).toEqual(["2"]);
  });

  it("claims each chat once even if both callers get past the lease", async () => {
    const lock = env.COORDINATOR.getByName("cron");
    const [a, b] = await Promise.all([
      lock.claim("post", ["a", "b"], {}, NOW),
      lock.claim("post", ["a", "b"], {}, NOW),
    ]);
    expect([...a, ...b].sort()).toEqual(["a", "b"]);
  });

  it("sends a video once when the feed also has Truth Social's re-post of it", async () => {
    await seed("old", ["a", "b"]);
    const video = "117433335383227958";
    const repost = "117433336229580757";
    const quote =
      `<p><span><br />RT: https://truthsocial.com/users/realDonaldTrump/statuses/${video}</span></p>` +
      '<p><a href="https://archive.example/b.jpg">View image</a></p>' +
      '<p>Quoted <a href="https://www.trumpstruth.org/statuses/1">Donald J. Trump</a></p>' +
      '<blockquote><p></p><p><a href="https://archive.example/a.mp4">View video</a></p></blockquote>';
    const xml =
      "<rss><channel>" +
      `<item><title>Quote</title><description><![CDATA[${quote}]]></description>` +
      `<pubDate>Tue, 13 Oct 2026 11:21:46 +0000</pubDate><truth:originalId>${repost}</truth:originalId>` +
      `<truth:originalUrl>https://truthsocial.com/@realDonaldTrump/${repost}</truth:originalUrl></item>` +
      '<item><title>Video</title><description><![CDATA[<p></p><p><a href="https://archive.example/a.mp4">View video</a></p>]]></description>' +
      `<pubDate>Tue, 13 Oct 2026 11:21:33 +0000</pubDate><truth:originalId>${video}</truth:originalId>` +
      `<truth:originalUrl>https://truthsocial.com/@realDonaldTrump/${video}</truth:originalUrl></item>` +
      `<item><title>Older</title><description><![CDATA[<p>Older post</p>]]></description>` +
      `<pubDate>Tue, 13 Oct 2026 11:00:00 +0000</pubDate><truth:originalId>old</truth:originalId>` +
      `<truth:originalUrl>https://truthsocial.com/@realDonaldTrump/old</truth:originalUrl></item>` +
      "</channel></rss>";
    const tg = new FakeTelegram();
    const ctx = testCtx(
      { [RSS_HOST]: () => new Response(xml), [TELEGRAM]: tg.handler, [CNN_HOST]: () => new Response("[]") },
      {},
      { now: () => NOW },
    );
    await runCron(ctx, store);
    const to = (chat: string) => tg.sent.filter((s) => s.chat === chat);
    expect(to("a")).toHaveLength(1);
    expect(to("b")).toHaveLength(1);
    expect(to("a")[0]?.text).toContain("פוסט וידאו ללא טקסט");
    expect(to("a")[0]?.text).not.toContain("ציטוט");
    expect((await store.getMeta()).lastSeen).toBe(repost);
    expect((await store.getSendLog(repost)).a).toBeUndefined();
  });
});
