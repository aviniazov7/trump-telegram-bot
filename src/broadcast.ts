/**
 * The cron run: fetch → analyze → deliver, resumable and idempotent.
 *
 * Delivery of each post is tracked in its send log (store.ts). A run reserves
 * the chats it is about to send to BEFORE sending, then records the
 * outcomes, so a run that stops anywhere — out of subrequests, out of time,
 * killed, or because KV stopped accepting writes — never repeats a send. The
 * next run picks up exactly where it left off.
 *
 * Any failed KV write stops all further sends in the run at once (a send
 * whose record can't be saved would otherwise be repeated by every later
 * run), and alerts the admin.
 */
import { toHex } from "./log";
import { buildMessage } from "./message";
import { alertAdmin, checkHeartbeat, recordSourceFailure, recordSuccess } from "./monitor";
import { advanceCursor, filterNewPosts, sendOrder } from "./posts";
import type { Ctx } from "./runtime";
import { type Post, contains, fetchPosts } from "./sources";
import { KvWriteError, type Meta, type SendLog, type Store, type Subscriber } from "./store";
import { type PostAnalysis, analyzePost } from "./tagging";
import { sendMessage, telegramCall } from "./telegram";
import { splitForTelegram } from "./text";

/** Give up on chats still failing this long after a post was first attempted. */
export const POST_RETRY_WINDOW_MS = 60 * 60 * 1000;
/** Subrequests kept back for alerts and the healthcheck ping. */
const RESERVED_SUBREQUESTS = 2;
/** KV allows one write per second to the same key; reservation → result. */
export const SAME_KEY_WRITE_GAP_MS = 1100;
/** How long a KV-failure alert stays muted (the free-plan quota resets daily). */
const KV_ALERT_MUTE_MINUTES = 12 * 60;

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

/** In dry run every preview is logged under this pseudo-chat, never a real one. */
const DRY_RUN_CHAT = "dry-run";

interface Target extends Subscriber {
  /** Key in the send log ("dry-run" for previews). */
  logKey: string;
}

/**
 * Deliver one post to every target that has no entry in its send log.
 *
 *   1. Reserve: write the batch as "sending". If this fails, nothing is sent.
 *   2. Send, collecting outcomes in memory.
 *   3. Record: write the outcomes. "retry" entries are dropped so the next
 *      run tries those chats again. If this write fails, the reserved chats
 *      stay "sending" and are treated as delivered — never sent twice.
 *
 * Two KV writes per post per run, however many subscribers there are.
 */
async function deliverPost(ctx: Ctx, store: Store, item: Prepared, targets: Target[]): Promise<DeliveryOutcome> {
  const id = item.post.id;
  const log: SendLog = await store.getSendLog(id);
  const todo = targets.filter((t) => !log[t.logKey]);
  if (!todo.length) return "done";

  const perSend = splitForTelegram(item.message).length;
  const room = Math.floor((ctx.budget.maxSubrequests - ctx.budget.subrequestsUsed - RESERVED_SUBREQUESTS) / perSend);
  if (room <= 0 || ctx.budget.timeUp()) return "out-of-budget";
  const batch = todo.slice(0, room);

  for (const t of batch) log[t.logKey] = "sending";
  const reservedAt = ctx.now();
  await store.putSendLog(id, log); // throws KvWriteError → nothing sent

  let retryLater = false;
  let stopped = false;
  let kvError: KvWriteError | null = null;
  for (const target of batch) {
    if (stopped || ctx.budget.timeUp()) {
      // Reserved but not attempted: release it for the next run.
      delete log[target.logKey];
      stopped = true;
      continue;
    }
    const result = await sendMessage(ctx, target.chatId, item.message, {
      threadId: target.threadId,
      reserve: RESERVED_SUBREQUESTS,
    });
    if (result.status === "retry") {
      delete log[target.logKey]; // definitely not delivered
      retryLater = true;
    } else {
      log[target.logKey] = result.status;
    }
    try {
      if (!ctx.cfg.dryRun && result.migratedTo) {
        log[result.migratedTo] = result.status;
        await store.deleteSubscriber(target.chatId);
        await store.putSubscriber(result.migratedTo, target.threadId);
      }
      if (!ctx.cfg.dryRun && result.status === "gone") {
        await store.deleteSubscriber(target.chatId);
        ctx.log.info(`Unsubscribed ${await ctx.log.chat(target.chatId)}: blocked the bot or no longer exists`);
      }
    } catch (err) {
      if (!(err instanceof KvWriteError)) throw err;
      kvError = err;
      stopped = true; // stop all further sends at once
      continue;
    }
    // Telegram's broadcast limit is ~30 msgs/s; stay well under it.
    await ctx.sleep(40);
  }

  const wait = SAME_KEY_WRITE_GAP_MS - (ctx.now() - reservedAt);
  if (wait > 0) await ctx.sleep(wait);
  await store.putSendLog(id, log); // throws KvWriteError → reservation stands
  if (kvError) throw kvError;

  if (stopped || batch.length < todo.length) return "out-of-budget";
  return retryLater ? "retry-later" : "done";
}

/** Who receives posts this run. In dry run: only the admin, as a preview. */
async function deliveryTargets(ctx: Ctx, store: Store): Promise<{ targets: Target[]; subscriberCount: number }> {
  const subscribers = await store.listSubscribers();
  if (!ctx.cfg.dryRun) {
    return { targets: subscribers.map((s) => ({ ...s, logKey: s.chatId })), subscriberCount: subscribers.length };
  }
  const targets = ctx.cfg.adminChatId ? [{ chatId: ctx.cfg.adminChatId, threadId: null, logKey: DRY_RUN_CHAT }] : [];
  return { targets, subscriberCount: subscribers.length };
}

export async function runCron(ctx: Ctx, store: Store): Promise<void> {
  const meta = await store.getMeta();
  let saved = JSON.stringify(meta);
  /** Write meta only if it changed since the last write. */
  const persist = async () => {
    const now = JSON.stringify(meta);
    if (now === saved) return;
    await store.putMeta(meta);
    saved = now;
  };

  try {
    await runSteps(ctx, store, meta, persist);
    await persist();
  } catch (err) {
    if (err instanceof KvWriteError) {
      // Don't pile more writes onto a failing store.
      await haltOnKvFailure(ctx, store, err);
      return;
    }
    // Keep whatever progress was made before an unexpected error.
    await persist().catch(() => {});
    throw err;
  }
}

async function runSteps(ctx: Ctx, store: Store, meta: Meta, persist: () => Promise<void>): Promise<void> {
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
  if (todo.length) await deliverNewPosts(ctx, store, meta, todo, chronological, persist);
  await recordSuccess(ctx, meta);
}

async function haltOnKvFailure(ctx: Ctx, store: Store, err: KvWriteError): Promise<void> {
  ctx.log.error(`${err.message} — stopping all sends in this run`);
  await alertAdmin(
    ctx,
    store,
    "kv-write",
    "🛑 כתיבה ל-Cloudflare KV נכשלה — עצרתי את כל השליחות כדי לא לשלוח פוסטים פעמיים.\n" +
      "סיבה סבירה: נגמרה מכסת 1,000 הכתיבות היומית של התוכנית החינמית (מתאפסת בחצות UTC — 02:00 בחורף / 03:00 בקיץ בשעון ישראל). " +
      "הבוט ימשיך לבד כשהכתיבה תחזור. אם זה חוזר — עבור ל-Workers Paid (ראה README).",
    KV_ALERT_MUTE_MINUTES,
  );
}

async function deliverNewPosts(
  ctx: Ctx,
  store: Store,
  meta: Meta,
  todo: Post[],
  chronological: string[],
  persist: () => Promise<void>,
) {
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

    const outcome = await deliverPost(ctx, store, item, targets);

    const expired = ctx.now() - (meta.pending[id] ?? ctx.now()) > POST_RETRY_WINDOW_MS;
    if (outcome === "done" || (outcome === "retry-later" && expired)) {
      if (outcome !== "done") ctx.log.warn(`Post ${id}: giving up on chats still failing after 60 min`);
      delete meta.pending[id];
      advanceCursor(meta, chronological, id);
      await persist();
    }
    if (outcome === "out-of-budget") {
      ctx.log.info(`Run budget used up at post ${id} — continuing next run`);
      break;
    }
  }
}
