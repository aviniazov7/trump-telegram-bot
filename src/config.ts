import type { Env } from "./env";

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
    geminiModel: str(env.GEMINI_MODEL) || "gemini-3.8-flash",
    geminiThinkingLevel: str(env.GEMINI_THINKING_LEVEL).toLowerCase(),
    staleAlertMinutes: int(env.STALE_ALERT_MINUTES, 35),
    sourceFailureAlertRuns: int(env.SOURCE_FAILURE_ALERT_RUNS, 10),
    alertRepeatMinutes: int(env.ALERT_REPEAT_MINUTES, 60),
    maxScanPosts: int(env.MAX_SCAN_POSTS, 100),
    maxSubrequests: int(env.MAX_SUBREQUESTS, 45),
    runTimeBudgetMs: int(env.RUN_TIME_BUDGET_SECONDS, 40) * 1000,
  };
}
