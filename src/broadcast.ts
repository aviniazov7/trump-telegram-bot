/**
 * The cron run: fetch → analyze → deliver, resumable and idempotent.
 *
 * Delivery of each post is claimed in the Coordinator Durable Object BEFORE
 * sending, then the outcomes are recorded. A run that stops anywhere — out
 * of subrequests, out of time, killed, or because KV stopped accepting
 * writes — never repeats a send. Overlapping cron invocations take a lease
 * on that same object and the loser leaves the tick alone. The next run
 * picks up exactly where the winner left off.
 *
 * Any failed KV write stops all further sends in the run at once (a send
 * whose record can't be saved would otherwise be repeated by every later
 * run), and alerts the admin.
 */

import { RUN_LEASE_MS } from "./coordinator";
import { scrub, toHex } from "./log";
import { buildMediaDigest, buildMessage, translatableText } from "./message";
import { alertAdmin, checkHeartbeat, recordSourceFailure, recordSuccess } from "./monitor";
import { advanceCursor, filterNewPosts, mediaDigestId, sendOrder } from "./posts";
import type { Ctx } from "./runtime";
import { contains, fetchPosts, type Post, pureRepostIds, sameMediaRepostIds } from "./sources";
import { KvWriteError, type Meta, type Store, type Subscriber } from "./store";
import { analyzePost, type PostAnalysis } from "./tagging";
import { sendMessage, telegramCall } from "./telegram";
import { htmlEscape, isMeaningfulText, splitForTelegram } from "./text";

/** Give up on chats still failing this long after a post was first attempted. */
export const POST_RETRY_WINDOW_MS = 60 * 60 * 1000;
/** Subrequests kept back for alerts and the healthcheck ping. */
const RESERVED_SUBREQUESTS = 2;
/** How long a KV-failure alert stays muted (the free-plan quota resets daily). */
const KV_ALERT_MUTE_MINUTES = 12 * 60;

/** The bot is broadcast-only: no slash-command menu, default menu button. */
export const BOT_MENU_CONFIG: [string, unknown][] = [
  ["setMyCommands", { commands: [] }],
  ["setChatMenuButton", { menu_button: { type: "default" } }],
];

/** Fingerprint of the menu config, keyed with the bot token (a new bot → new fingerprint). */
export async function menuFingerprint(botToken: string, config = BOT_MENU_CONFIG): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(botToken),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
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

/** A post with no words needs no translation, tags or Gemini call. */
const MEDIA_ONLY: PostAnalysis = {
  hebrew: "",
  translated: true,
  categories: [],
  impact: null,
  provider: "none",
};

/** In dry run every preview is logged under this pseudo-chat, never a real one. */
const DRY_RUN_CHAT = "dry-run";

interface Target extends Subscriber {
  /** Key in the send log ("dry-run" for previews). */
  logKey: string;
}

/**
 * Deliver one post to every target that has no claim yet.
 *
 *   1. Claim, in the Durable Object: the chats this run may send to. A chat
 *      already claimed (by this run or another) is skipped. If the claim
 *      throws, nothing is sent.
 *   2. Send, collecting outcomes in memory.
 *   3. Record the outcomes. "retry" and chats never attempted are released
 *      so the next run can take them. If the KV mirror write fails, the
 *      object still holds the claim — at most once, never twice.
 *
 * One KV write per post per run (the mirror), however many subscribers.
 */
async function deliverPost(
  ctx: Ctx,
  store: Store,
  item: Prepared,
  targets: Target[],
): Promise<DeliveryOutcome> {
  const id = item.post.id;
  const perSend = splitForTelegram(item.message).length;
  const room = Math.floor(
    (ctx.budget.maxSubrequests - ctx.budget.subrequestsUsed - RESERVED_SUBREQUESTS) / perSend,
  );
  if (room <= 0 || ctx.budget.timeUp()) return "out-of-budget";

  const claimed = new Set(
    await store.claimSends(
      id,
      targets.map((t) => t.logKey),
      ctx.now(),
    ),
  );
  const todo = targets.filter((t) => claimed.has(t.logKey));
  if (!todo.length) return "done";
  const batch = todo.slice(0, room);

  const updates: Record<string, string | null> = {};
  for (const target of todo.slice(room)) updates[target.logKey] = null;

  let retryLater = false;
  let stopped = false;
  let kvError: KvWriteError | null = null;
  for (const target of batch) {
    if (stopped || ctx.budget.timeUp()) {
      // Claimed but not attempted: release it for the next run.
      updates[target.logKey] = null;
      stopped = true;
      continue;
    }
    const result = await sendMessage(ctx, target.chatId, item.message, {
      threadId: target.threadId,
      reserve: RESERVED_SUBREQUESTS,
    });
    if (result.status === "retry") {
      updates[target.logKey] = null; // definitely not delivered
      retryLater = true;
    } else {
      updates[target.logKey] = result.status;
    }
    try {
      if (!ctx.cfg.dryRun && result.migratedTo) {
        updates[result.migratedTo] = result.status;
        await store.deleteSubscriber(target.chatId);
        await store.putSubscriber(result.migratedTo, target.threadId);
      }
      if (!ctx.cfg.dryRun && result.status === "gone") {
        await store.deleteSubscriber(target.chatId);
        ctx.log.info(
          `Unsubscribed ${await ctx.log.chat(target.chatId)}: blocked the bot or no longer exists`,
        );
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

  await store.recordSends(id, updates, ctx.now()); // KV mirror throws KvWriteError; the claim stands
  if (kvError) throw kvError;

  if (stopped || batch.length < todo.length) return "out-of-budget";
  return retryLater ? "retry-later" : "done";
}

/** Who receives posts this run. In dry run: only the admin, as a preview. */
async function deliveryTargets(
  ctx: Ctx,
  store: Store,
): Promise<{ targets: Target[]; subscriberCount: number }> {
  const subscribers = await store.listSubscribers();
  if (!ctx.cfg.dryRun) {
    return {
      targets: subscribers.map((s) => ({ ...s, logKey: s.chatId })),
      subscriberCount: subscribers.length,
    };
  }
  const targets = ctx.cfg.adminChatId
    ? [{ chatId: ctx.cfg.adminChatId, threadId: null, logKey: DRY_RUN_CHAT }]
    : [];
  return { targets, subscriberCount: subscribers.length };
}

export async function runCron(ctx: Ctx, store: Store): Promise<"ok" | "busy"> {
  const token = await store.tryAcquire(ctx.now(), RUN_LEASE_MS);
  if (!token) {
    ctx.log.info("Another run holds the lease — skipping this tick");
    return "busy";
  }
  try {
    await runCronBody(ctx, store);
    return "ok";
  } finally {
    await store.release(token);
  }
}

async function runCronBody(ctx: Ctx, store: Store): Promise<void> {
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
  // A wordless RT of a status already in this window is the same post again
  // (Truth Social archives the original and the boost under two ids). So is
  // a second id that points at a video file we already have. Mark it done
  // so the cursor can pass it, and don't deliver it.
  const reposts = new Set([...pureRepostIds(posts), ...sameMediaRepostIds(posts)]);
  const skipping = fresh.filter((p) => reposts.has(p.id));
  if (skipping.length)
    ctx.log.info(`Skipping ${skipping.length} pure re-post(s) already covered by the original`);
  for (const post of skipping) if (!meta.sentAhead.includes(post.id)) meta.sentAhead.push(post.id);
  const chronological = fresh.map((p) => p.id);
  advanceCursor(meta, chronological);
  // Forget progress on posts that are no longer pending (stale entries).
  // A media digest id is not a status id, so it is kept until that digest finishes.
  const digestKey = meta.openDigest.length ? mediaDigestId(meta.openDigest) : "";
  for (const id of Object.keys(meta.pending)) {
    if (id === digestKey) continue;
    if (!chronological.includes(id)) delete meta.pending[id];
  }

  const todo = fresh.filter((p) => !meta.sentAhead.includes(p.id));
  if (todo.length || meta.openDigest.length)
    await deliverNewPosts(ctx, store, meta, todo, chronological, posts, persist);
  await recordSuccess(ctx, store, meta);
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
  allPosts: Post[],
  persist: () => Promise<void>,
) {
  const readable = (post: Post) => isMeaningfulText(translatableText(post));
  const textual = todo.filter(readable);
  const textless = todo.filter((post) => !readable(post));
  const { targets, subscriberCount } = await deliveryTargets(ctx, store);
  ctx.log.info(
    `${textual.length} new post(s) for ${subscriberCount} subscriber(s)` +
      (textless.length ? `, ${textless.length} caption-less` : "") +
      (ctx.cfg.dryRun ? " [DRY RUN]" : ""),
  );

  // Translate and classify first (cached per post), so high-impact posts can
  // jump the queue and a resumed post is sent with identical text.
  const prepared: Prepared[] = [];
  const gaveUp: { id: string; error: string; quota: boolean; immediate: boolean }[] = [];
  for (const post of textual) {
    const text = translatableText(post);
    let analysis = text ? await store.getAnalysis(post.id) : MEDIA_ONLY;
    if (!analysis) {
      if (ctx.budget.timeUp() || !ctx.budget.canFetch(1 + RESERVED_SUBREQUESTS)) break;
      const prior = await store.getGeminiFailures(post.id);
      const fresh = await analyzePost(
        ctx,
        text,
        {
          exhausted: (model) => store.geminiQuotaExhausted(model),
          markExhausted: (model, reason, seconds) => store.markGeminiQuotaExhausted(model, reason, seconds),
        },
        prior?.attempts.at(-1)?.error ?? "",
      );
      if (fresh.outOfTime) break; // not a failure: try again next run
      if (fresh.translated) {
        // The fallback model saved it, but keep the primary's failure too.
        if (fresh.geminiError) await store.recordGeminiFailure(post.id, ctx.now(), fresh.geminiError);
        await store.putAnalysis(post.id, fresh);
        analysis = fresh;
      } else {
        // Always keep the reason, also when we're about to give up.
        const record = await store.recordGeminiFailure(post.id, ctx.now(), fresh.geminiError ?? "unknown");
        const waited = ctx.now() - record.firstFailureAt;
        // Waiting is pointless when every model is out of daily quota.
        // An echo will not become Hebrew on the next run. A 429 or a 5xx might,
        // and so might Workers AI, so those keep the retry window.
        if (ctx.cfg.geminiApiKey && !fresh.quotaExhausted && !fresh.deterministic && waited < ctx.cfg.geminiRetryMs) {
          ctx.log.warn(
            `Post ${post.id}: no translation yet (${fresh.geminiError}) — retrying next run ` +
              `(${Math.floor(waited / 60_000)}/${ctx.cfg.geminiRetryMs / 60_000} min)`,
          );
          continue; // not sent this run; newer posts may go ahead (sentAhead)
        }
        ctx.log.error(
          `Post ${post.id}: still no translation after ${Math.floor(waited / 60_000)} min — sending in English`,
        );
        await store.putGeminiFailures({ ...record, gaveUpAt: ctx.now() });
        // Frozen, so every chat gets the same English message.
        await store.putAnalysis(post.id, fresh);
        analysis = fresh;
        gaveUp.push({
          id: post.id,
          error: fresh.geminiError ?? "unknown",
          quota: Boolean(fresh.quotaExhausted),
          immediate: Boolean(fresh.deterministic),
        });
      }
    }
    let message = buildMessage(post, analysis);
    if (ctx.cfg.dryRun) message = `🧪 <b>DRY RUN</b> — היה נשלח ל-${subscriberCount} מנויים:\n\n${message}`;
    prepared.push({ post, message, impact: analysis.impact });
  }
  const quotaOut = gaveUp.filter((g) => g.quota);
  if (quotaOut.length) {
    await alertAdmin(
      ctx,
      store,
      "gemini-quota",
      `⛽ המכסה היומית החינמית של Gemini נגמרה בכל המודלים — ${quotaOut.length} פוסט(ים) נשלחים באנגלית.\n` +
        "המכסה מתאפסת בחצות שעון החוף המערבי (10:00 שעון ישראל), ואז התרגום חוזר לבד.",
      12 * 60,
    );
  }
  const otherFailures = gaveUp.filter((g) => !g.quota);
  if (otherFailures.length) {
    const [first] = otherFailures;
    const triedWorkersAi = otherFailures.some((failure) => failure.error.includes("workers-ai"));
    const who = triedWorkersAi ? "Gemini ו-Workers AI" : "Gemini";
    const span = otherFailures.every((failure) => failure.immediate)
      ? "בניסיון אחד"
      : `במשך ${ctx.cfg.geminiRetryMs / 60_000} דק׳`;
    await alertAdmin(
      ctx,
      store,
      "translation",
      `⚠️ ${who} נכשל ${span} ב-${otherFailures.length} פוסט(ים) — הם נשלחים באנגלית בלבד.\n` +
        `סיבה אחרונה: <code>${htmlEscape(scrub(first?.error ?? "").slice(0, 300))}</code>\n` +
        `פרטים: <code>npm run gemini-errors</code> (מפתח gemini-error:${first?.id} ב-KV).`,
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

  await deliverTextless(
    ctx,
    store,
    meta,
    textless,
    chronological,
    allPosts,
    targets,
    subscriberCount,
    persist,
  );
}

/**
 * Caption-less posts are not each sent as "video without text".
 * One of them has nothing to say, so it is marked done and skipped.
 * Two or more that are ready together become a single digest. The id set
 * is saved in `meta.openDigest` before the send, so a retry cannot grow
 * the set and deliver the earlier posts a second time.
 */
async function deliverTextless(
  ctx: Ctx,
  store: Store,
  meta: Meta,
  textless: Post[],
  chronological: string[],
  allPosts: Post[],
  targets: Target[],
  subscriberCount: number,
  persist: () => Promise<void>,
): Promise<void> {
  if (!meta.openDigest.length) {
    if (textless.length < 2) {
      const lone = textless[0];
      if (lone) {
        advanceCursor(meta, chronological, lone.id);
        ctx.log.info(`Skipping caption-less post ${lone.id}`);
        await persist();
      }
      return;
    }
    meta.openDigest = textless.map((p) => p.id);
    meta.pending[mediaDigestId(meta.openDigest)] ??= ctx.now();
    await persist();
  }

  const ids = meta.openDigest;
  const byId = new Map(allPosts.map((p) => [p.id, p]));
  const chosen = ids.flatMap((id) => {
    const post = byId.get(id);
    return post ? [post] : [];
  });
  const digestId = mediaDigestId(ids);
  if (chosen.length < 2) {
    ctx.log.warn(`Dropping media digest ${digestId}: not enough posts still in the window`);
    delete meta.pending[digestId];
    for (const id of ids) advanceCursor(meta, chronological, id);
    meta.openDigest = [];
    await persist();
    return;
  }

  let message = buildMediaDigest(chosen);
  if (ctx.cfg.dryRun) message = `🧪 <b>DRY RUN</b> — היה נשלח ל-${subscriberCount} מנויים:\n\n${message}`;
  const item: Prepared = {
    post: { id: digestId, text: "", createdAt: chosen[0]?.createdAt ?? "", url: "" },
    message,
    impact: null,
  };
  if (meta.pending[digestId] === undefined) {
    meta.pending[digestId] = ctx.now();
    await persist();
  }
  const outcome = await deliverPost(ctx, store, item, targets);
  const expired = ctx.now() - (meta.pending[digestId] ?? ctx.now()) > POST_RETRY_WINDOW_MS;
  if (outcome === "done" || (outcome === "retry-later" && expired)) {
    if (outcome !== "done")
      ctx.log.warn(`Media digest ${digestId}: giving up on chats still failing after 60 min`);
    delete meta.pending[digestId];
    for (const id of ids) advanceCursor(meta, chronological, id);
    meta.openDigest = [];
    await persist();
  } else if (outcome === "out-of-budget") {
    ctx.log.info(`Run budget used up on media digest ${digestId} — continuing next run`);
  }
}
