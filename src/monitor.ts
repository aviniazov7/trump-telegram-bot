/** Admin alerts, the heartbeat and the optional dead-man's-switch ping. */
import type { Ctx } from "./runtime";
import { KvWriteError, type Meta, type Store } from "./store";
import { sendMessage } from "./telegram";

/**
 * Refresh the stored heartbeat at most this often. Each refresh is a KV write
 * (free plan: 1,000 writes/day per account), so 30 min → 48 writes/day.
 */
export const HEARTBEAT_WRITE_MS = 30 * 60 * 1000;

/**
 * The in-band "no successful run" alert can't fire sooner than the heartbeat
 * is refreshed, or every healthy run would look stale. Faster detection is
 * HEALTHCHECK_URL's job (it costs no KV writes).
 */
export function staleThresholdMs(staleAlertMinutes: number): number {
  return Math.max(staleAlertMinutes * 60_000, HEARTBEAT_WRITE_MS + 60_000);
}

/**
 * Alerts muted in this Worker instance's memory. Used when KV can't record a
 * mute (writes failing), so a broken KV doesn't turn into an alert every
 * run. Best effort: a new instance starts with an empty map.
 */
const memoryMutes = new Map<string, number>();

export function resetMemoryMutes(): void {
  memoryMutes.clear();
}

/**
 * Send an alert to ADMIN_CHAT_ID, at most once per mute window per kind
 * (ALERT_REPEAT_MINUTES unless `muteMinutes` is given). Never throws:
 * monitoring must not break a broadcast.
 */
export async function alertAdmin(
  ctx: Ctx,
  store: Store,
  kind: string,
  text: string,
  muteMinutes = ctx.cfg.alertRepeatMinutes,
): Promise<boolean> {
  const admin = ctx.cfg.adminChatId;
  if (!admin) {
    ctx.log.warn(`Alert '${kind}' not sent — ADMIN_CHAT_ID is not set`);
    return false;
  }
  const muteMs = muteMinutes * 60_000;
  if (ctx.now() - (memoryMutes.get(kind) ?? -Infinity) < muteMs) {
    ctx.log.info(`Alert '${kind}' already sent recently (this instance) — not repeating it`);
    return false;
  }
  try {
    if (await store.alertMuted(kind)) {
      ctx.log.info(`Alert '${kind}' already sent recently — not repeating it`);
      return false;
    }
    const result = await sendMessage(ctx, admin, `🚨 <b>התראת בוט טראמפ</b>\n${text}`);
    if (result.status !== "ok") return false;
    memoryMutes.set(kind, ctx.now());
    ctx.log.info(`Alert '${kind}' sent to admin`);
    try {
      await store.muteAlert(kind, muteMinutes * 60);
    } catch (err) {
      if (!(err instanceof KvWriteError)) throw err;
      ctx.log.warn(`Alert '${kind}' mute kept in memory only: ${err.message}`);
    }
    return true;
  } catch (err) {
    ctx.log.warn(`Alert '${kind}' failed:`, err);
    return false;
  }
}

export function formatDuration(ms: number): string {
  const minutes = Math.floor(Math.max(ms, 0) / 60_000);
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours} שע׳ ${minutes % 60} דק׳` : `${minutes} דק׳`;
}

const ISRAEL_SHORT = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Jerusalem",
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/**
 * Alert when the previous successful run is older than STALE_ALERT_MINUTES
 * (but never sooner than the heartbeat interval allows; see staleThresholdMs).
 * Fires at the start of the first run after an outage; a Worker that isn't
 * running at all can't report anything — HEALTHCHECK_URL covers that.
 */
export async function checkHeartbeat(ctx: Ctx, store: Store, meta: Meta): Promise<void> {
  if (!meta.lastSuccess) return;
  const gap = ctx.now() - meta.lastSuccess;
  if (gap <= staleThresholdMs(ctx.cfg.staleAlertMinutes)) return;
  const since = ISRAEL_SHORT.format(new Date(meta.lastSuccess)).replace(",", "");
  ctx.log.warn(`No successful run for ${Math.round(gap / 1000)}s`);
  await alertAdmin(
    ctx,
    store,
    "stale",
    `⏰ לא הייתה ריצה מוצלחת כבר ${formatDuration(gap)} (מאז ${since}).\n` +
      "הבוט רץ עכשיו שוב ומשלים פוסטים שהוחמצו. אם זה חוזר — בדוק את הלוגים ב-Cloudflare.",
  );
}

/** Count a run in which no source could be reached; alert after N in a row. */
export async function recordSourceFailure(ctx: Ctx, store: Store, meta: Meta): Promise<void> {
  meta.sourceFailures += 1;
  ctx.log.warn(`Post sources failed (${meta.sourceFailures} run(s) in a row)`);
  if (meta.sourceFailures >= ctx.cfg.sourceFailureAlertRuns) {
    await alertAdmin(
      ctx,
      store,
      "source",
      `📡 לא הצלחתי לקרוא את הפוסטים של טראמפ ב-${meta.sourceFailures} ריצות ברצף ` +
        "(trumpstruth.org וגם הארכיון של CNN).",
    );
  }
}

/** Mark the run successful: refresh the heartbeat and ping HEALTHCHECK_URL. */
export async function recordSuccess(ctx: Ctx, meta: Meta): Promise<void> {
  meta.sourceFailures = 0;
  if (ctx.now() - meta.lastSuccess >= HEARTBEAT_WRITE_MS) meta.lastSuccess = ctx.now();
  if (ctx.cfg.healthcheckUrl && ctx.budget.canFetch()) {
    try {
      await ctx.http(ctx.cfg.healthcheckUrl, { timeoutMs: 5000 });
    } catch (err) {
      ctx.log.warn("Healthcheck ping failed:", err);
    }
  }
}
