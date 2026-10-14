/**
 * Telegram webhook: POST /telegram/<path>.
 *
 * Two layers of authentication, both derived from TELEGRAM_WEBHOOK_SECRET:
 *   1. <path> = first 32 hex chars of SHA-256("telegram-webhook-path:" + secret),
 *      so the route itself is unguessable (and isn't the secret).
 *   2. Telegram sends the secret in X-Telegram-Bot-Api-Secret-Token
 *      (set via setWebhook's secret_token); compared in constant time.
 * Anything that fails either check gets the same 404 an unknown route gets.
 * Without a configured secret (or one shorter than 32 chars) the webhook is
 * disabled: fail closed.
 */
import { loadConfig } from "./config";
import type { Env } from "./env";
import { toHex } from "./log";
import { type Ctx, type Fetcher, makeCtx } from "./runtime";
import { openStore, type Store } from "./store";
import { sendMessage, telegramCall } from "./telegram";

export const MIN_SECRET_LENGTH = 32;
const MAX_BODY_BYTES = 1024 * 1024;
const WEBHOOK_TIME_BUDGET_MS = 20_000;

export async function sha256Hex(text: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

export async function webhookPath(secret: string): Promise<string> {
  return `/telegram/${(await sha256Hex(`telegram-webhook-path:${secret}`)).slice(0, 32)}`;
}

/** Constant-time string comparison (no early exit on the first difference). */
export function timingSafeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

const notFound = () => new Response("Not found", { status: 404 });

export async function handleWebhook(
  request: Request,
  env: Env,
  opts: { fetch?: Fetcher; waitUntil?: (promise: Promise<unknown>) => void } = {},
): Promise<Response> {
  const cfg = loadConfig(env);
  if (cfg.webhookSecret.length < MIN_SECRET_LENGTH || !cfg.botToken) {
    console.error(
      "Webhook disabled: TELEGRAM_WEBHOOK_SECRET (>= 32 chars) and TELEGRAM_BOT_TOKEN must be set",
    );
    return notFound();
  }
  const url = new URL(request.url);
  if (url.pathname !== (await webhookPath(cfg.webhookSecret))) return notFound();
  const header = request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
  if (request.method !== "POST" || !timingSafeEqual(header, cfg.webhookSecret)) {
    console.warn("Webhook request rejected: bad method or secret header");
    return notFound();
  }
  if (Number(request.headers.get("Content-Length") ?? 0) > MAX_BODY_BYTES) {
    return new Response("Payload too large", { status: 413 });
  }

  let update: Update;
  try {
    update = (await request.json()) as Update;
  } catch {
    return new Response("Bad request", { status: 400 });
  }

  const ctx = makeCtx({ ...cfg, runTimeBudgetMs: WEBHOOK_TIME_BUDGET_MS }, { fetch: opts.fetch });
  const store = openStore(env);
  const task = deliverUpdate(ctx, store, update);
  if (opts.waitUntil) {
    // 200 before sendMessage. Telegram retries an update when the webhook is
    // slow or not 2xx, and the retry is a second delivery of the same update_id.
    opts.waitUntil(task.catch((err) => ctx.log.error("Webhook update failed:", err)));
    return new Response("ok");
  }
  try {
    // Tests call in without waitUntil and need the send finished, and a
    // thrown KV error, before this returns. 500 lets Telegram redeliver.
    await task;
  } catch (err) {
    ctx.log.error("Webhook update failed:", err);
    return new Response("Error", { status: 500 });
  }
  return new Response("ok");
}

/**
 * One Telegram update, at most once. The claim is taken before any send and
 * dropped if handling throws, so a later delivery of the same update_id can
 * still apply. A duplicate that arrives while the first attempt is in flight
 * loses the claim and sends nothing.
 */
async function deliverUpdate(ctx: Ctx, store: Store, update: Update): Promise<void> {
  const updateId = typeof update.update_id === "number" ? update.update_id : undefined;
  if (updateId !== undefined && !(await store.claimUpdate(updateId, ctx.now()))) {
    ctx.log.info(`Duplicate Telegram update ${updateId} ignored`);
    return;
  }
  try {
    await handleUpdate(ctx, store, update);
  } catch (err) {
    if (updateId !== undefined) {
      await store.releaseUpdate(updateId).catch((releaseErr) => {
        ctx.log.error("Failed to release update claim:", releaseErr);
      });
    }
    throw err;
  }
}

interface Chat {
  id: number | string;
  type: string;
}

export interface Update {
  update_id?: number;
  message?: {
    text?: string;
    chat?: Chat;
    from?: { id: number };
    is_topic_message?: boolean;
    message_thread_id?: number;
  };
  my_chat_member?: {
    chat?: Chat;
    new_chat_member?: { status?: string };
  };
}

const GROUP_TYPES = new Set(["group", "supergroup"]);

const WELCOME_PRIVATE =
  "🇺🇸🇮🇱 <b>ברוכים הבאים!</b>\n\n" +
  "אני שולח את הפוסטים של דונלד טראמפ מ-Truth Social, מתורגמים לעברית, עם תיוג השפעה על השווקים.\n\n" +
  "📬 כל פוסט חדש יישלח אליך אוטומטית. להפסקה — /stop\n\n" +
  "💡 אפשר גם להוסיף אותי לקבוצה או לערוץ. כדי שאשלח לנושא ספציפי\nבקבוצה — שלח /trumphere בתוך הנושא הרצוי.";
const WELCOME_TOPIC = "🇺🇸🇮🇱 <b>שלום!</b>\nאני אשלח את הפוסטים של טראמפ <b>בנושא הזה</b>, מתורגמים לעברית.";
const WELCOME_GROUP =
  "🇺🇸🇮🇱 <b>שלום!</b>\nאני אשלח לקבוצה הזאת את הפוסטים של טראמפ מתורגמים לעברית, אוטומטית.\n\n" +
  "💡 אם תרצה שאשלח לנושא ספציפי — שלח /trumphere בתוך הנושא הרצוי.";
const STOPPED = "🛑 הפסקתי לשלוח לכאן את הפוסטים של טראמפ. כדי לחזור — /start";
// A private user may still have the old reply keyboard stuck.
const REMOVE_KEYBOARD = { remove_keyboard: true };

async function welcome(ctx: Ctx, chatId: string, chatType: string, threadId: string | null): Promise<void> {
  if (chatType === "private")
    await sendMessage(ctx, chatId, WELCOME_PRIVATE, { replyMarkup: REMOVE_KEYBOARD });
  else if (GROUP_TYPES.has(chatType))
    await sendMessage(ctx, chatId, threadId ? WELCOME_TOPIC : WELCOME_GROUP, { threadId });
}

/** The bot's @username, cached in KV (only needed for "/cmd@bot" in groups). */
async function botUsername(ctx: Ctx, store: Store): Promise<string> {
  const key = `bot:username:${(await sha256Hex(ctx.cfg.botToken)).slice(0, 8)}`;
  const cached = await store.get(key);
  if (cached) return cached;
  const r = await telegramCall(ctx, "getMe", {}, { idempotent: true });
  const username = String((r.result as { username?: string } | undefined)?.username ?? "").toLowerCase();
  if (username) await store.put(key, username);
  return username;
}

async function isGroupAdmin(ctx: Ctx, chatId: string, userId: number | undefined): Promise<boolean> {
  if (userId === undefined) return false;
  const r = await telegramCall(
    ctx,
    "getChatMember",
    { chat_id: chatId, user_id: userId },
    { idempotent: true },
  );
  const status = (r.result as { status?: string } | undefined)?.status;
  return status === "creator" || status === "administrator";
}

/**
 * /start and /trumphere subscribe (in a forum topic, /trumphere pins
 * broadcasts to that topic), /stop unsubscribes — in groups only when a
 * group admin sends it. Adding/removing the bot to/from a chat subscribes or
 * unsubscribes it. Everything else is ignored: the bot is broadcast-only.
 */
export async function handleUpdate(ctx: Ctx, store: Store, update: Update): Promise<void> {
  const member = update.my_chat_member;
  if (member?.chat) {
    const chatId = String(member.chat.id);
    const status = member.new_chat_member?.status ?? "";
    if (["member", "administrator", "creator"].includes(status)) {
      if (!(await store.getSubscriber(chatId))) {
        await store.putSubscriber(chatId, null);
        ctx.log.info(`Subscribed ${await ctx.log.chat(chatId)} (bot added)`);
        // In a private chat Telegram sends this update together with the
        // /start message when the user presses Start (the user was "kicked"
        // until then). /start sends the welcome. Doing it here as well
        // delivered the same text twice on 2026-10-14. Groups have no paired
        // /start, so they are still welcomed here.
        if (member.chat.type !== "private") await welcome(ctx, chatId, member.chat.type, null);
      }
    } else if (["kicked", "left", "restricted"].includes(status)) {
      await store.deleteSubscriber(chatId);
      ctx.log.info(`Unsubscribed ${await ctx.log.chat(chatId)} (bot removed)`);
    }
    return;
  }

  const message = update.message;
  const text = message?.text?.trim() ?? "";
  if (!message?.chat || !text.startsWith("/")) return;
  const chatId = String(message.chat.id);
  const chatType = message.chat.type;
  const [command = "", mention] = (text.split(/\s+/)[0] ?? "").slice(1).toLowerCase().split("@");
  if (!["start", "trumphere", "stop"].includes(command)) return;
  // "/start@OtherBot" in a group is meant for another bot.
  if (mention && mention !== (await botUsername(ctx, store))) return;

  // Only a real forum topic pins broadcasts; a reply thread is not one.
  const threadId =
    message.is_topic_message && message.message_thread_id !== undefined
      ? String(message.message_thread_id)
      : null;

  if (command === "stop") {
    if (
      chatType !== "private" &&
      !(GROUP_TYPES.has(chatType) && (await isGroupAdmin(ctx, chatId, message.from?.id)))
    ) {
      return;
    }
    await store.deleteSubscriber(chatId);
    ctx.log.info(`Unsubscribed ${await ctx.log.chat(chatId)} (/stop)`);
    await sendMessage(ctx, chatId, STOPPED, { threadId });
    return;
  }

  if (chatType === "private") {
    await store.putSubscriber(chatId, null);
  } else if (GROUP_TYPES.has(chatType)) {
    await store.putSubscriber(chatId, threadId);
  } else {
    return;
  }
  ctx.log.info(`Subscribed ${await ctx.log.chat(chatId)} (/${command}${threadId ? " in a topic" : ""})`);
  await welcome(ctx, chatId, chatType, threadId);
}
