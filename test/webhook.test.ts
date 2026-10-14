import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { UPDATE_DEDUPE_TTL_MS } from "../src/coordinator";
import worker from "../src/index";
import { openStore } from "../src/store";
import { handleWebhook, timingSafeEqual, type Update, webhookPath } from "../src/webhook";
import { fakeFetch, json, TELEGRAM } from "./helpers";

const SECRET = "test-webhook-secret-0123456789abcdef"; // test-only, from vitest.config.ts
const store = openStore(env);
let nextUpdateId = 1;

beforeEach(async () => {
  nextUpdateId = 1;
  for (const { name } of (await env.STATE.list()).keys) await env.STATE.delete(name);
  await env.COORDINATOR.getByName("cron").reset();
});

function telegram(opts: { adminIds?: number[]; username?: string } = {}) {
  const sent: { chat: string; text: string; thread?: number }[] = [];
  const fake = fakeFetch({
    [TELEGRAM]: (call) => {
      const method = call.url.split("/").pop();
      const body = JSON.parse(call.body || "{}");
      if (method === "getMe")
        return json({ ok: true, result: { username: opts.username ?? "TrumpHebrewBot" } });
      if (method === "getChatMember") {
        const status = opts.adminIds?.includes(body.user_id) ? "administrator" : "member";
        return json({ ok: true, result: { status } });
      }
      sent.push({ chat: String(body.chat_id), text: body.text, thread: body.message_thread_id });
      return json({ ok: true, result: {} });
    },
  });
  return { ...fake, sent };
}

async function post(
  update: unknown,
  opts: {
    secret?: string;
    path?: string;
    method?: string;
    tg?: ReturnType<typeof telegram>;
    waitUntil?: (promise: Promise<unknown>) => void;
  } = {},
) {
  const tg = opts.tg ?? telegram();
  const path = opts.path ?? (await webhookPath(SECRET));
  const request = new Request(`https://bot.example${path}`, {
    method: opts.method ?? "POST",
    headers: { "X-Telegram-Bot-Api-Secret-Token": opts.secret ?? SECRET, "Content-Type": "application/json" },
    body: opts.method === "GET" ? undefined : typeof update === "string" ? update : JSON.stringify(update),
  });
  const res = await handleWebhook(request, env, { fetch: tg.fetch, waitUntil: opts.waitUntil });
  return { res, tg };
}

const msg = (
  text: string,
  chat: { id: number; type: string },
  extra: Record<string, unknown> = {},
): Update => ({
  update_id: nextUpdateId++,
  message: { text, chat, from: { id: 42 }, ...extra },
});
const privateChat = { id: 5551234567, type: "private" };
const group = { id: -1009876543210, type: "supergroup" };
const membership = (status: string, chat: { id: number; type: string } = group) => ({
  update_id: nextUpdateId++,
  my_chat_member: { chat, new_chat_member: { status } },
});

describe("webhook authentication", () => {
  it("accepts Telegram with the right path and secret header", async () => {
    const { res } = await post(msg("hello", privateChat));
    expect(res.status).toBe(200);
  });

  it("derives an unguessable path that doesn't reveal the secret", async () => {
    const path = await webhookPath(SECRET);
    expect(path).toMatch(/^\/telegram\/[0-9a-f]{32}$/);
    expect(path).not.toContain(SECRET);
    expect(await webhookPath(`${SECRET}x`)).not.toBe(path);
  });

  it.each([
    ["a wrong secret header", { secret: "wrong-secret-wrong-secret-wrong-00" }],
    ["a missing secret header", { secret: "" }],
    ["the wrong path", { path: "/telegram/0123456789abcdef0123456789abcdef" }],
    ["the secret itself as path", { path: `/telegram/${SECRET}` }],
    ["GET", { method: "GET" }],
  ])("rejects %s with 404 and touches nothing", async (_name, opts) => {
    const { res, tg } = await post(msg("/start", privateChat), opts);
    expect(res.status).toBe(404);
    expect(tg.calls).toHaveLength(0);
    expect(await store.listSubscribers()).toEqual([]);
  });

  it("is disabled (fails closed) without a long enough secret", async () => {
    const request = new Request(`https://bot.example${await webhookPath("short")}`, {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": "short" },
      body: JSON.stringify(msg("/start", privateChat)),
    });
    expect((await handleWebhook(request, { ...env, TELEGRAM_WEBHOOK_SECRET: "short" })).status).toBe(404);
    expect((await handleWebhook(request, { ...env, TELEGRAM_WEBHOOK_SECRET: "" })).status).toBe(404);
  });

  it("rejects malformed JSON", async () => {
    expect((await post("{not json")).res.status).toBe(400);
  });

  it("compares secrets without short-circuiting", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
    expect(timingSafeEqual("", "")).toBe(true);
  });

  it("routes only /telegram/* to the webhook", async () => {
    const res = await worker.fetch(
      new Request("https://bot.example/"),
      env,
      undefined as unknown as ExecutionContext,
    );
    expect(res.status).toBe(404);
  });
});

describe("commands", () => {
  it("/start in a private chat subscribes and welcomes once", async () => {
    const { tg } = await post(msg("/start", privateChat));
    expect(await store.getSubscriber("5551234567")).toEqual({ chatId: "5551234567", threadId: null });
    expect(tg.sent).toHaveLength(1);
    expect(tg.sent[0]?.text).toContain("ברוכים הבאים");
    expect(tg.sent[0]?.text).toContain("/stop");
  });

  it("/stop in a private chat unsubscribes and confirms", async () => {
    await store.putSubscriber("5551234567", null);
    const { tg } = await post(msg("/stop", privateChat));
    expect(await store.getSubscriber("5551234567")).toBeNull();
    expect(tg.sent[0]?.text).toContain("הפסקתי");
  });

  it("/trumphere inside a forum topic pins broadcasts to that topic", async () => {
    const { tg } = await post(
      msg("/trumphere@TrumpHebrewBot", group, { is_topic_message: true, message_thread_id: 77 }),
    );
    expect(await store.getSubscriber("-1009876543210")).toEqual({ chatId: "-1009876543210", threadId: "77" });
    expect(tg.sent[0]).toMatchObject({ thread: 77 });
    expect(tg.sent[0]?.text).toContain("בנושא הזה");
  });

  it("treats a reply thread as no topic", async () => {
    await post(msg("/start", group, { message_thread_id: 9 }));
    expect(await store.getSubscriber("-1009876543210")).toEqual({ chatId: "-1009876543210", threadId: null });
  });

  it("ignores commands addressed to another bot", async () => {
    const { tg } = await post(msg("/start@SomeOtherBot", group));
    expect(await store.getSubscriber("-1009876543210")).toBeNull();
    expect(tg.sent).toEqual([]);
  });

  it("lets only group admins /stop a group", async () => {
    await store.putSubscriber("-1009876543210", null);
    await post(msg("/stop", group), { tg: telegram({ adminIds: [] }) });
    expect(await store.getSubscriber("-1009876543210")).not.toBeNull();
    await post(msg("/stop", group), { tg: telegram({ adminIds: [42] }) });
    expect(await store.getSubscriber("-1009876543210")).toBeNull();
  });

  it("ignores everything else", async () => {
    for (const update of [
      msg("hello", privateChat),
      msg("/stats", privateChat),
      { update_id: 3 },
      { message: { chat: privateChat } },
    ]) {
      const { res, tg } = await post(update);
      expect(res.status).toBe(200);
      expect(tg.sent).toEqual([]);
    }
    expect(await store.listSubscribers()).toEqual([]);
  });
});

describe("exactly one welcome", () => {
  it("sends one message for a single /start", async () => {
    const { tg } = await post(msg("/start", privateChat));
    expect(tg.sent).toHaveLength(1);
    expect(tg.sent[0]?.text).toContain("ברוכים הבאים");
  });

  it("sends one message when the same update is delivered twice", async () => {
    const tg = telegram();
    const update = msg("/start", privateChat);
    expect((await post(update, { tg })).res.status).toBe(200);
    expect((await post(update, { tg })).res.status).toBe(200);
    expect(tg.sent).toHaveLength(1);
    expect(await store.getSubscriber("5551234567")).toEqual({ chatId: "5551234567", threadId: null });
  });

  it("sends one message when a private Start is a membership update and /start", async () => {
    const tg = telegram();
    // Production order on 2026-10-14: my_chat_member (member) then /start, ~200ms apart.
    await post(membership("member", privateChat), { tg });
    expect(tg.sent).toHaveLength(0);
    await post(msg("/start", privateChat), { tg });
    expect(tg.sent).toHaveLength(1);
    expect(tg.sent[0]?.text).toContain("ברוכים הבאים");
    expect(await store.getSubscriber("5551234567")).toEqual({ chatId: "5551234567", threadId: null });
  });

  it("returns 200 before the welcome is sent, and a concurrent retry sends nothing more", async () => {
    const base = telegram();
    let releaseSend = (): void => {};
    const gate = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const pending: Promise<unknown>[] = [];
    const slow = {
      ...base,
      fetch: async (url: string, init?: RequestInit) => {
        if (url.endsWith("/sendMessage")) await gate;
        return base.fetch(url, init);
      },
    };
    const update = msg("/start", privateChat);
    try {
      const first = await post(update, { tg: slow, waitUntil: (promise) => pending.push(promise) });
      expect(first.res.status).toBe(200);
      expect(base.sent).toHaveLength(0);
      const second = await post(update, { tg: base, waitUntil: (promise) => pending.push(promise) });
      expect(second.res.status).toBe(200);
      releaseSend();
      await Promise.all(pending);
      expect(base.sent).toHaveLength(1);
    } finally {
      releaseSend();
      await Promise.all(pending);
    }
  });

  it("returns 500 and accepts a redelivery when the first attempt throws", async () => {
    const update = msg("/start", privateChat);
    const state = {
      get: (...args: Parameters<KVNamespace["get"]>) => env.STATE.get(...args),
      getWithMetadata: (...args: Parameters<KVNamespace["getWithMetadata"]>) =>
        env.STATE.getWithMetadata(...args),
      list: (...args: Parameters<KVNamespace["list"]>) => env.STATE.list(...args),
      put: () => Promise.reject(new Error("KV put() limit exceeded")),
      delete: (...args: Parameters<KVNamespace["delete"]>) => env.STATE.delete(...args),
    } as unknown as KVNamespace;
    const tg = telegram();
    const path = await webhookPath(SECRET);
    const failed = await handleWebhook(
      new Request(`https://bot.example${path}`, {
        method: "POST",
        headers: { "X-Telegram-Bot-Api-Secret-Token": SECRET, "Content-Type": "application/json" },
        body: JSON.stringify(update),
      }),
      { ...env, STATE: state },
      { fetch: tg.fetch },
    );
    expect(failed.status).toBe(500);
    expect(tg.sent).toHaveLength(0);
    expect((await post(update, { tg })).res.status).toBe(200);
    expect(tg.sent).toHaveLength(1);
  });

  it("remembers an update id only inside the dedupe window", async () => {
    const lock = env.COORDINATOR.getByName("cron");
    const [first, second] = await Promise.all([lock.claimUpdate(7, 1_000), lock.claimUpdate(7, 1_000)]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(await lock.claimUpdate(7, 1_000 + UPDATE_DEDUPE_TTL_MS - 1)).toBe(false);
    expect(await lock.claimUpdate(7, 1_000 + UPDATE_DEDUPE_TTL_MS)).toBe(true);
    await lock.releaseUpdate(7);
    expect(await lock.claimUpdate(7, 1_000)).toBe(true);
  });
});

describe("bot added to / removed from a chat", () => {
  it("subscribes and welcomes once when added", async () => {
    const first = await post(membership("administrator"));
    expect(first.tg.sent).toHaveLength(1);
    const second = await post(membership("administrator"));
    expect(second.tg.sent).toHaveLength(0);
    expect(await store.listSubscribers()).toEqual([{ chatId: "-1009876543210", threadId: null }]);
  });

  it.each(["kicked", "left"])("unsubscribes when %s", async (status) => {
    await store.putSubscriber("-1009876543210", "5");
    await post(membership(status));
    expect(await store.getSubscriber("-1009876543210")).toBeNull();
  });
});

describe("logging", () => {
  it("never logs chat IDs, the token or the secret", async () => {
    const logs: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    try {
      await post(msg("/start", privateChat));
      await post(msg("/stop", privateChat));
    } finally {
      console.log = original;
    }
    const output = logs.join("\n");
    expect(output).toContain("chat#");
    for (const secret of ["5551234567", "test-bot-token", SECRET]) expect(output).not.toContain(secret);
  });
});
