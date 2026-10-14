import type { Env } from "./env";

/**
 * Free-plan multilingual instruct model (100+ languages, including Hebrew).
 * Not one of the models Cloudflare moved to Workers Paid.
 * https://developers.cloudflare.com/workers-ai/models/glm-4.7-flash/
 */
export const DEFAULT_WORKERS_AI_MODEL = "@cf/zai-org/glm-4.7-flash";

/** Parsed, defaulted configuration for one invocation. */
export interface Config {
  botToken: string;
  webhookSecret: string;
  geminiApiKey: string;
  adminChatId: string;
  healthcheckUrl: string;
  dryRun: boolean;
  geminiModel: string;
  geminiThinkingLevel: string;
  /** Tried when the primary model fails; "" disables it. */
  geminiFallbackModel: string;
  /**
   * Workers AI model used only after Gemini fails. "" disables it.
   * Default is a multilingual instruct model that stays on the Workers Free
   * plan (10,000 neurons/day). Paid-only models are not used.
   */
  workersAiModel: string;
  /** Per Gemini call, so one slow call can't eat the run. */
  geminiTimeoutMs: number;
  /** Keep retrying Gemini (each run) this long before sending in English. */
  geminiRetryMs: number;
  staleAlertMinutes: number;
  sourceFailureAlertRuns: number;
  alertRepeatMinutes: number;
  maxScanPosts: number;
  maxSubrequests: number;
  runTimeBudgetMs: number;
}

function int(value: string | undefined, fallback: number): number {
  const n = Number.parseInt((value ?? "").trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const str = (value: string | undefined): string => (value ?? "").trim();

export function loadConfig(env: Env): Config {
  return {
    botToken: str(env.TELEGRAM_BOT_TOKEN),
    webhookSecret: str(env.TELEGRAM_WEBHOOK_SECRET),
    geminiApiKey: str(env.GEMINI_API_KEY),
    adminChatId: str(env.ADMIN_CHAT_ID),
    healthcheckUrl: str(env.HEALTHCHECK_URL),
    // Anything but an explicit "false" keeps shadow mode on: failing safe
    // means previewing to the admin, never double-sending to subscribers.
    dryRun: str(env.DRY_RUN).toLowerCase() !== "false",
    geminiModel: str(env.GEMINI_MODEL) || "gemini-3.5-flash-lite",
    geminiThinkingLevel: str(env.GEMINI_THINKING_LEVEL).toLowerCase(),
    geminiFallbackModel: env.GEMINI_FALLBACK_MODEL === undefined ? "gemini-3.8-flash" : str(env.GEMINI_FALLBACK_MODEL),
    workersAiModel: env.WORKERS_AI_MODEL === undefined ? DEFAULT_WORKERS_AI_MODEL : str(env.WORKERS_AI_MODEL),
    geminiTimeoutMs: int(env.GEMINI_TIMEOUT_SECONDS, 12) * 1000,
    geminiRetryMs: int(env.GEMINI_RETRY_MINUTES, 15) * 60_000,
    staleAlertMinutes: int(env.STALE_ALERT_MINUTES, 35),
    sourceFailureAlertRuns: int(env.SOURCE_FAILURE_ALERT_RUNS, 10),
    alertRepeatMinutes: int(env.ALERT_REPEAT_MINUTES, 60),
    maxScanPosts: int(env.MAX_SCAN_POSTS, 100),
    maxSubrequests: int(env.MAX_SUBREQUESTS, 45),
    runTimeBudgetMs: int(env.RUN_TIME_BUDGET_SECONDS, 90) * 1000,
  };
}
