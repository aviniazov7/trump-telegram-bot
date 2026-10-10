/**
 * The cron run: fetch → analyze → deliver, resumable and idempotent.
 *
 * Delivery is tracked per (post, chat) in the send log (store.ts), so a run
 * that stops anywhere — out of subrequests, out of time, or killed — never
 * repeats a send, and the next minute's run picks up exactly where it left
 * off.
 */
import { alertAdmin, checkHeartbeat, recordSourceFailure, recordSuccess } from "./monitor";
import { buildMessage } from "./message";
import { advanceCursor, filterNewPosts, sendOrder } from "./posts";
import type { Ctx } from "./runtime";
import { type Post, contains, fetchPosts } from "./sources";
import type { Meta, Store, Subscriber } from "./store";
import { type PostAnalysis, analyzePost } from "./tagging";
import { sendMessage, telegramCall } from "./telegram";
import { toHex } from "./log";

/** Give up on chats still failing this long after a post was first attempted. */
export const POST_RETRY_WINDOW_MS = 60 * 60 * 1000;
/** Subrequests kept back for alerts and the healthcheck ping. */
const RESERVED_SUBREQUESTS = 2;

/** The bot is broadcast-only: no slash-command menu, default menu button. */
export const BOT_MENU_CONFIG: [string, unknown][] = [
  ["setMyCommands", { commands: [] }],
  ["setChatMenuButton", { menu_button: { type: "default" } }],
];

/** Fingerprint of the menu config, keyed with the bot token (a new bot → new fingerprint). */
export async function menuFingerprint(botToken: string, config = BOT_MENU_CONFIG): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(botToken), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(JSON.stringify(config)));
  return toHex(sig).slice(0, 16);
}

async function applyMenu(ctx: Ctx, meta: Meta): Promise<void> {
  const fingerprint = await menuFingerprint(ctx.cfg.botToken);
  if (meta.menu === fingerprint) return;
  let allOk = true;
  for (const [method, payload] of BOT_MENU_CONFIG) {
    const r = await telegramCall(ctx, method, payload, { idempotent: true });
    allOk &&= r.ok;
  }
  if (allOk) meta.menu = fingerprint;
}

interface Prepared {
  post: Post;
  message: string;
  impact: PostAnalysis["impact"];
}

type DeliveryOutcome = "done" | "retry-later" | "out-of-budget";

/**
 * Deliver one post to every target that doesn't have it yet, recording each
 * outcome in the send log immediately after the send.
 */
async function deliverPost(ctx: Ctx, store: Store, item: Prepared, targets: Subscriber[]): Promise<DeliveryOutcome> {
  let retryLater = false;
  for (const target of targets) {
    if (await store.getSent(item.post.id, target.chatId)) continue;
    if (ctx.budget.timeUp() || !ctx.budget.canFetch(1 + RESERVED_SUBREQUESTS)) return "out-of-budget";

    const result = await sendMessage(ctx, target.chatId, item.message, {
      threadId: target.threadId,
      reserve: RESERVED_SUBREQUESTS,
    });
    const chat = await ctx.log.chat(target.chatId);

    if (result.migratedTo && !ctx.cfg.dryRun) {
      await store.deleteSubscriber(target.chatId);
      await store.putSubscriber(result.migratedTo, target.threadId);
      await store.putSent(item.post.id, result.migratedTo, result.status);
    }
    switch (result.status) {
      case "retry":
        // Definitely not delivered. Out of budget → stop; otherwise next run.
        if (!ctx.budget.canFetch(1 + RESERVED_SUBREQUESTS)) return "out-of-budget";
        retryLater = true;
        break;
      case "gone":
        await store.putSent(item.post.id, target.chatId, "gone");
        if (!ctx.cfg.dryRun) {
          await store.deleteSubscriber(target.chatId);
          ctx.log.info(`Unsubscribed ${chat}: blocked the bot or no longer exists`);
        }
        break;
      default:
        await store.putSent(item.post.id, target.chatId, result.status);
    }
    // Telegram's broadcast limit is ~30 msgs/s; stay well under it.
    await ctx.sleep(40);
  }
  return retryLater ? "retry-later" : "done";
}

const DRY_RUN_CHAT = "dry-run";

/** Who receives posts this run. In dry run: only the admin, as a preview. */
async function deliveryTargets(ctx: Ctx, store: Store): Promise<{ targets: Subscriber[]; subscriberCount: number }> {
  const subscribers = await store.listSubscribers();
  if (!ctx.cfg.dryRun) return { targets: subscribers, subscriberCount: subscribers.length };
  // The send log is keyed "dry-run" so previews never mark real chats as sent.
  const targets = ctx.cfg.adminChatId ? [{ chatId: ctx.cfg.adminChatId, threadId: null }] : [];
  return { targets, subscriberCount: subscribers.length };
}

export async function runCron(ctx: Ctx, store: Store): Promise<void> {
  const meta = await store.getMeta();
  const before = JSON.stringify(meta);
  const save = async () => {
    const now = JSON.stringify(meta);
    if (now !== before) await store.putMeta(meta);
  };

  try {
    await checkHeartbeat(ctx, store, meta);
    await applyMenu(ctx, meta);

    const posts = await fetchPosts(ctx, meta.lastSeen);
    if (!posts.length) {
      await recordSourceFailure(ctx, store, meta);
      return;
    }
    if (meta.lastSeen && !contains(posts, meta.lastSeen)) {
      await alertAdmin(
        ctx,
        store,
        "gap",
        `⚠️ הפוסט האחרון שנשלח לא נמצא ב-${posts.length} הפוסטים האחרונים — ייתכן שפוסטים הוחמצו. נשלח רק הפוסט החדש ביותר.`,
      );
    }

    const fresh = filterNewPosts(posts, meta.lastSeen);
    const chronological = fresh.map((p) => p.id);
    advanceCursor(meta, chronological);
    // Forget progress on posts that are no longer pending (stale entries).
    for (const id of Object.keys(meta.pending)) if (!chronological.includes(id)) delete meta.pending[id];

    const todo = fresh.filter((p) => !meta.sentAhead.includes(p.id));
    if (todo.length) await deliverNewPosts(ctx, store, meta, todo, chronological);
    await recordSuccess(ctx, meta);
  } finally {
    await save();
  }
}

async function deliverNewPosts(ctx: Ctx, store: Store, meta: Meta, todo: Post[], chronological: string[]) {
  const { targets, subscriberCount } = await deliveryTargets(ctx, store);
  ctx.log.info(`${todo.length} new post(s) for ${subscriberCount} subscriber(s)${ctx.cfg.dryRun ? " [DRY RUN]" : ""}`);

  // Translate and classify first (cached per post), so high-impact posts can
  // jump the queue and a resumed post is sent with identical text.
  const prepared: Prepared[] = [];
  let untranslated = 0;
  for (const post of todo) {
    let analysis = await store.getAnalysis(post.id);
    if (!analysis) {
      if (ctx.budget.timeUp() || !ctx.budget.canFetch(1 + RESERVED_SUBREQUESTS)) break;
      analysis = await analyzePost(ctx, post.text);
      if (analysis.translated) await store.putAnalysis(post.id, analysis);
      else untranslated += 1;
    }
    let message = buildMessage(post, analysis);
    if (ctx.cfg.dryRun) message = `🧪 <b>DRY RUN</b> — היה נשלח ל-${subscriberCount} מנויים:\n\n${message}`;
    prepared.push({ post, message, impact: analysis.impact });
  }
  if (untranslated) {
    await alertAdmin(
      ctx,
      store,
      "translation",
      `⚠️ כל ספקי התרגום נכשלו ב-${untranslated} פוסט(ים) — הם נשלחים באנגלית בלבד.\n` +
        "בדוק את GEMINI_API_KEY ואת המכסה ב-AI Studio.",
    );
  }

  const started = new Set(Object.keys(meta.pending));
  for (const item of sendOrder(prepared, started)) {
    const id = item.post.id;
    meta.pending[id] ??= ctx.now();
    if (item.impact === "high") ctx.log.info(`Post ${id} is high-impact — sending first`);

    const outcome = ctx.cfg.dryRun
      ? await deliverDryRun(ctx, store, item, targets)
      : await deliverPost(ctx, store, item, targets);

    const expired = ctx.now() - (meta.pending[id] ?? ctx.now()) > POST_RETRY_WINDOW_MS;
    if (outcome === "done" || (outcome === "retry-later" && expired)) {
      if (outcome !== "done") ctx.log.warn(`Post ${id}: giving up on chats still failing after 60 min`);
      delete meta.pending[id];
      advanceCursor(meta, chronological, id);
      await store.putMeta(meta);
    }
    if (outcome === "out-of-budget") {
      ctx.log.info(`Run budget used up at post ${id} — continuing next run`);
      break;
    }
  }
}

/** Dry run: one preview per post to the admin, logged under a dry-run key. */
async function deliverDryRun(ctx: Ctx, store: Store, item: Prepared, targets: Subscriber[]): Promise<DeliveryOutcome> {
  if (await store.getSent(item.post.id, DRY_RUN_CHAT)) return "done";
  const [admin] = targets;
  if (!admin) {
    ctx.log.info(`[DRY RUN] would send post ${item.post.id} (no ADMIN_CHAT_ID for previews)`);
    await store.putSent(item.post.id, DRY_RUN_CHAT, "ok");
    return "done";
  }
  if (!ctx.budget.canFetch(1 + RESERVED_SUBREQUESTS)) return "out-of-budget";
  const result = await sendMessage(ctx, admin.chatId, item.message, { reserve: RESERVED_SUBREQUESTS });
  if (result.status === "retry") return "retry-later";
  await store.putSent(item.post.id, DRY_RUN_CHAT, result.status);
  return "done";
}
