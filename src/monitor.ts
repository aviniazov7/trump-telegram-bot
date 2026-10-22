/** Admin alerts, the heartbeat and the optional dead-man's-switch ping. */
import type { Ctx } from "./runtime";
import { KvWriteError, type Meta, type Store } from "./store";
import { sendMessage } from "./telegram";

/**
 * How often `meta.lastSuccess` may be written. The cron is every 5 minutes;
 * bumping the timestamp every run made `persist()` rewrite `meta` ~288
 * times a day and burned most of the free-tier 1,000 KV writes. The Durable
 * Object heartbeat is still updated on every success, and `checkHeartbeat`
 * uses whichever copy is newer, so a threshold under this interval (the
 * default is 35 minutes) still measures a real gap.
 */
export const LAST_SUCCESS_WRITE_INTERVAL_MS = 3_600_000;

/**
 * How long since the last *successful* run before the in-band alert.
 * `checkHeartbeat` takes the newer of `meta.lastSuccess` and the Durable
 * Object heartbeat. The object is written every successful run, so this is
 * a real gap even though the KV copy is refreshed at most once an hour.
 * Alerting from that KV copy alone made the next cron look like an outage.
 * Faster detection is HEALTHCHECK_URL's job.
 */
export function staleThresholdMs(staleAlertMinutes: number): number {
  return staleAlertMinutes * 60_000;
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
    // Urgent: alerts often fire exactly when a run is out of time (a slow
    // Gemini ate it). Before this, such alerts were dropped silently.
    const result = await sendMessage(ctx, admin, `🚨 <b>התראת בוט טראמפ</b>\n${text}`, { urgent: true });
    if (result.status !== "ok") {
      ctx.log.error(`Alert '${kind}' could not be sent to the admin: ${result.status}`);
      return false;
    }
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
 * Alert when the previous successful run is older than STALE_ALERT_MINUTES.
 * Fires at the start of the first run after an outage; a Worker that isn't
 * running at all can't report anything — HEALTHCHECK_URL covers that.
 *
 * The Durable Object copy wins over `meta.lastSuccess` when it is newer.
 * That copy is updated every successful run, while `meta.lastSuccess` lags
 * by up to an hour, so a threshold under an hour still sees a real gap. A
 * stale KV read (or a lost meta write) can't page for a run that succeeded.
 */
export async function checkHeartbeat(ctx: Ctx, store: Store, meta: Meta): Promise<void> {
  let beat = 0;
  try {
    beat = await store.heartbeat();
  } catch (err) {
    ctx.log.warn("Heartbeat read failed:", err);
  }
  const last = Math.max(meta.lastSuccess, beat);
  if (!last) return;
  const gap = ctx.now() - last;
  if (gap <= staleThresholdMs(ctx.cfg.staleAlertMinutes)) return;
  const since = ISRAEL_SHORT.format(new Date(last)).replace(",", "");
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

/**
 * Mark the run successful: refresh the Durable Object heartbeat every run,
 * and ping HEALTHCHECK_URL. `meta` is touched only when a field changes, so
 * an idle cron does not spend a KV write.
 */
export async function recordSuccess(ctx: Ctx, store: Store, meta: Meta): Promise<void> {
  if (meta.sourceFailures !== 0) meta.sourceFailures = 0;
  if (ctx.now() - meta.lastSuccess > LAST_SUCCESS_WRITE_INTERVAL_MS) meta.lastSuccess = ctx.now();
  try {
    await store.markHeartbeat(ctx.now());
  } catch (err) {
    ctx.log.warn("Heartbeat write failed:", err);
  }
  if (ctx.cfg.healthcheckUrl && ctx.budget.canFetch()) {
    try {
      await ctx.http(ctx.cfg.healthcheckUrl, { timeoutMs: 5000 });
    } catch (err) {
      ctx.log.warn("Healthcheck ping failed:", err);
    }
  }
}
