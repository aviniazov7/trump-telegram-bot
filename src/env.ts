import type { Coordinator } from "./coordinator";

/** Bindings, secrets and vars available to the Worker. */
export interface Env {
  /** KV namespace holding all bot state (see src/store.ts). */
  STATE: KVNamespace;
  /**
   * One Durable Object. Serializes cron runs and holds the send claims,
   * so overlapping invocations can't deliver the same post twice.
   */
  COORDINATOR: DurableObjectNamespace<Coordinator>;
  /**
   * Workers AI. Translation fallback after Gemini fails. The call disables
   * reasoning so it stays inside the free daily neuron allowance.
   */
  AI?: Ai;

  // Secrets — set with `wrangler secret put`, never in wrangler.toml.
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  GEMINI_API_KEY?: string;
  ADMIN_CHAT_ID?: string;
  HEALTHCHECK_URL?: string;

  // Plain vars from wrangler.toml [vars].
  DRY_RUN?: string;
  GEMINI_MODEL?: string;
  GEMINI_THINKING_LEVEL?: string;
  GEMINI_FALLBACK_MODEL?: string;
  /** "" disables the Workers AI fallback. Default: @cf/zai-org/glm-4.7-flash. */
  WORKERS_AI_MODEL?: string;
  GEMINI_TIMEOUT_SECONDS?: string;
  GEMINI_RETRY_MINUTES?: string;
  STALE_ALERT_MINUTES?: string;
  SOURCE_FAILURE_ALERT_RUNS?: string;
  ALERT_REPEAT_MINUTES?: string;
  MAX_SCAN_POSTS?: string;
  MAX_SUBREQUESTS?: string;
  RUN_TIME_BUDGET_SECONDS?: string;
}
