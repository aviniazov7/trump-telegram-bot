import type { Config } from "./config";
import { Logger } from "./log";

/**
 * Per-invocation limits. Workers cap subrequests per invocation (50 on the
 * free plan) and a cron run should end well before the next run (5 min)
 * starts, so every outbound fetch goes through here.
 */
export class Budget {
  private used = 0;
  private readonly deadline: number;

  constructor(
    readonly maxSubrequests: number,
    timeBudgetMs: number,
    private readonly now: () => number = Date.now,
  ) {
    this.deadline = now() + timeBudgetMs;
  }

  get subrequestsUsed(): number {
    return this.used;
  }

  /**
   * Room for `n` more subrequests and some time left? `urgent` work (admin
   * alerts) ignores the time budget — it's a soft limit we set ourselves,
   * far below the platform's 15 min — but never the subrequest cap.
   */
  canFetch(n = 1, { urgent = false } = {}): boolean {
    return this.used + n <= this.maxSubrequests && (urgent || !this.timeUp());
  }

  timeUp(): boolean {
    return this.now() >= this.deadline;
  }

  msLeft(): number {
    return Math.max(0, this.deadline - this.now());
  }

  /** Record one subrequest; throws once the cap is reached. */
  take(): void {
    if (this.used >= this.maxSubrequests) throw new BudgetExhausted();
    this.used += 1;
  }
}

export class BudgetExhausted extends Error {
  constructor() {
    super("subrequest budget exhausted");
  }
}

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

/** Chat input for the Workers AI fallback. Tests pass a fake `run`. */
export interface WorkersAiChatInput {
  messages: { role: "system" | "user" | "assistant"; content: string }[];
  temperature?: number;
  max_completion_tokens?: number;
  chat_template_kwargs?: { enable_thinking?: boolean };
}

export interface WorkersAiClient {
  run(model: string, input: WorkersAiChatInput, options?: { signal?: AbortSignal }): Promise<unknown>;
}

/** Everything a unit of work needs; tests swap `fetch`, `sleep`, `now` and `ai`. */
export interface Ctx {
  cfg: Config;
  budget: Budget;
  log: Logger;
  /** Counted, budget-checked fetch with a timeout. */
  http(url: string, init?: RequestInit & { timeoutMs?: number }): Promise<Response>;
  sleep(ms: number): Promise<void>;
  now(): number;
  /** Present when the Worker has an AI binding and the fallback model is set. */
  ai?: WorkersAiClient;
}

export const HTTP_TIMEOUT_MS = 15_000;

export function makeCtx(
  cfg: Config,
  opts: {
    fetch?: Fetcher;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    log?: Logger;
    ai?: WorkersAiClient;
  } = {},
): Ctx {
  const now = opts.now ?? Date.now;
  const doFetch = opts.fetch ?? ((url, init) => fetch(url, init));
  const budget = new Budget(cfg.maxSubrequests, cfg.runTimeBudgetMs, now);
  return {
    cfg,
    budget,
    log: opts.log ?? new Logger(cfg.botToken),
    now,
    ...(opts.ai ? { ai: opts.ai } : {}),
    sleep: opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    async http(url, init = {}) {
      budget.take();
      const { timeoutMs = HTTP_TIMEOUT_MS, ...rest } = init;
      return doFetch(url, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
    },
  };
}

/** A fetch that gave up waiting: the request may still have been processed. */
export function isTimeout(err: unknown): boolean {
  return err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
}
