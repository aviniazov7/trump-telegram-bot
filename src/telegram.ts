/**
 * Telegram Bot API calls.
 *
 * sendMessage is not idempotent: if a request times out after Telegram got
 * it, sending again delivers the post twice. So sends are never retried
 * blindly:
 *   - 429: Telegram guarantees nothing was sent; wait retry_after (if short
 *     and within the run budget) and retry.
 *   - timeout or 5xx: the message may have been delivered → "uncertain",
 *     never resent.
 *   - other network errors (connection refused, DNS): retried on a later run.
 * Read-only/set-style methods (getChatMember, setMyCommands) pass
 * idempotent: true and are retried freely.
 */
import { type Ctx, isTimeout } from "./runtime";
import { splitForTelegram } from "./text";

export interface TgResponse {
  ok: boolean;
  result?: unknown;
  /** 0 = no HTTP answer (network error or timeout). */
  errorCode: number;
  description: string;
  retryAfter: number;
  /** Set when a group was upgraded to a supergroup (its new chat ID). */
  migrateTo: string;
  /** The request may have reached Telegram. */
  uncertain: boolean;
}

const GONE_400 = ["chat not found", "group chat was deactivated", "peer_id_invalid", "user is deactivated"];

/** The chat can never receive messages from the bot again (blocked, kicked, deleted). */
export function chatGone(r: TgResponse): boolean {
  if (r.errorCode === 403) return true;
  const d = r.description.toLowerCase();
  return r.errorCode === 400 && GONE_400.some((g) => d.includes(g));
}

export const TELEGRAM_ATTEMPTS = 3;
/** Don't wait out a 429 longer than this within a run; the next run retries. */
export const TELEGRAM_MAX_RETRY_AFTER_S = 10;

async function request(ctx: Ctx, method: string, payload: unknown): Promise<TgResponse> {
  const empty = { errorCode: 0, description: "", retryAfter: 0, migrateTo: "", uncertain: false };
  let res: Response;
  try {
    res = await ctx.http(`https://api.telegram.org/bot${ctx.cfg.botToken}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    // Never include the URL: it contains the bot token.
    const name = err instanceof Error ? err.name : "Error";
    return { ...empty, ok: false, description: name, uncertain: isTimeout(err) };
  }
  let data: Record<string, unknown>;
  try {
    data = (await res.json()) as Record<string, unknown>;
  } catch {
    return { ...empty, ok: false, errorCode: res.status, description: "non-JSON response", uncertain: res.status >= 500 };
  }
  const params = (data.parameters ?? {}) as Record<string, unknown>;
  const errorCode = Number(data.error_code ?? (res.ok ? 0 : res.status));
  return {
    ok: data.ok === true,
    result: data.result,
    errorCode,
    description: String(data.description ?? ""),
    retryAfter: Number(params.retry_after ?? 0),
    migrateTo: params.migrate_to_chat_id === undefined ? "" : String(params.migrate_to_chat_id),
    uncertain: errorCode >= 500,
  };
}

/** Call a Bot API method, retrying only when it is safe to. */
export async function telegramCall(
  ctx: Ctx,
  method: string,
  payload: unknown,
  { idempotent = false, urgent = false } = {},
): Promise<TgResponse> {
  let resp: TgResponse = { ok: false, errorCode: 0, description: "budget", retryAfter: 0, migrateTo: "", uncertain: false };
  for (let attempt = 1; attempt <= TELEGRAM_ATTEMPTS; attempt++) {
    if (!ctx.budget.canFetch(1, { urgent })) return resp;
    resp = await request(ctx, method, payload);
    if (resp.ok) return resp;
    const last = attempt === TELEGRAM_ATTEMPTS;

    if (resp.errorCode === 429) {
      const wait = Math.max(resp.retryAfter, 1);
      if (last || wait > TELEGRAM_MAX_RETRY_AFTER_S || wait * 1000 >= ctx.budget.msLeft()) {
        ctx.log.warn(`Telegram ${method} rate-limited (retry_after=${wait}s) — leaving it for the next run`);
        return resp;
      }
      ctx.log.warn(`Telegram ${method} rate-limited — waiting ${wait}s as asked`);
      await ctx.sleep(wait * 1000);
      continue;
    }
    const transient = resp.errorCode === 0 || resp.errorCode >= 500;
    if (transient && idempotent && !last) {
      await ctx.sleep(500 * attempt);
      continue;
    }
    break;
  }
  // Only the code and Telegram's description: the full response can contain
  // chat IDs (migrate_to_chat_id).
  ctx.log.warn(`Telegram ${method} failed: ${resp.errorCode || "network"} ${resp.description}`);
  return resp;
}

/**
 * How a send ended, for the per-chat send log:
 *   ok        delivered
 *   uncertain may or may not have arrived (timeout/5xx, or a long message cut
 *             short) — final, never resent
 *   gone      chat blocked the bot / no longer exists — unsubscribe it
 *   failed    Telegram rejected it for good (e.g. bad request) — final
 *   retry     definitely not delivered (429 too long, network error, budget)
 *             — try again next run
 */
export type SendStatus = "ok" | "uncertain" | "gone" | "failed" | "retry";

export interface SendResult {
  status: SendStatus;
  migratedTo: string;
}

export interface SendOptions {
  threadId?: string | null;
  replyMarkup?: unknown;
  /** Subrequests to leave unused for alerts after this send. */
  reserve?: number;
  /** Admin alerts: may run past the run's time budget (see Budget.canFetch). */
  urgent?: boolean;
}

export async function sendMessage(ctx: Ctx, chatId: string, text: string, opts: SendOptions = {}): Promise<SendResult> {
  const chunks = splitForTelegram(text);
  const urgent = opts.urgent ?? false;
  if (!ctx.budget.canFetch(chunks.length + (opts.reserve ?? 0), { urgent })) return { status: "retry", migratedTo: "" };

  let target = chatId;
  let migratedTo = "";
  for (const [i, chunk] of chunks.entries()) {
    const payload: Record<string, unknown> = {
      chat_id: target,
      text: chunk,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    };
    if (opts.threadId) payload.message_thread_id = Number(opts.threadId);
    if (opts.replyMarkup && i === chunks.length - 1) payload.reply_markup = opts.replyMarkup;

    let resp = await telegramCall(ctx, "sendMessage", payload, { urgent });
    if (!resp.ok && resp.migrateTo && !migratedTo) {
      // Group upgraded to a supergroup: Telegram did not deliver to the old
      // ID, so resend there once.
      ctx.log.info(`Chat ${await ctx.log.chat(target)} migrated to ${await ctx.log.chat(resp.migrateTo)}`);
      target = migratedTo = resp.migrateTo;
      payload.chat_id = target;
      resp = await telegramCall(ctx, "sendMessage", payload, { urgent });
    }
    if (resp.ok) continue;

    // A later chunk failing means earlier ones arrived: resending would
    // duplicate them, so the whole message counts as uncertain.
    let status: SendStatus;
    if (i > 0) status = "uncertain";
    else if (chatGone(resp)) status = "gone";
    else if (resp.uncertain) status = "uncertain";
    else if (resp.errorCode === 0 || resp.errorCode === 429) status = "retry";
    else status = "failed";
    ctx.log.warn(`Send to ${await ctx.log.chat(target)} chunk ${i + 1}/${chunks.length}: ${status}`);
    return { status, migratedTo };
  }
  return { status: "ok", migratedTo };
}
