/** Google Gemini: one call per post returns the translation and the market tags. */
import type { Ctx } from "./runtime";

export const GEMINI_SYSTEM_PROMPT = `\
You translate posts that Donald Trump published on Truth Social into Hebrew,
for an Israeli audience that follows the news and the markets.

Translation rules:
- Translate the whole post accurately and completely. Do not summarize, omit,
  add, explain, or soften anything, and do not intensify it either.
- Write natural, fluent modern Hebrew, the way Israeli news outlets quote him.
  Keep his register: short punchy sentences stay short, exclamation marks stay,
  and words he writes in ALL CAPS for emphasis keep that emphasis.
- Names of people, places, organizations, and media outlets: use the spelling
  Israeli media use (Donald Trump = דונלד טראמפ, Joe Biden = ג'ו ביידן,
  Federal Reserve = הפדרל ריזרב). Without an established Hebrew form,
  transliterate the name and add the English in parentheses once.
- Keep numbers, percentages, dollar amounts, dates, stock tickers, hashtags,
  @handles, and URLs exactly as written.
- Use precise economic and political terms: tariffs = מכסים,
  interest rates = ריבית, trade deal = הסכם סחר.
- Keep the original line breaks.
- Stay politically neutral. You render his words; you neither endorse nor
  criticize them. Add no commentary, disclaimers, or quotation marks.

Market classification (judge the English original):
- "categories": every topic that applies, from: tariffs (tariffs, trade
  deals, import duties), fed_rates (the Federal Reserve, its chair, interest
  rates), oil (oil, gas, OPEC, energy supply, energy infrastructure, energy
  prices), geopolitics (wars, ceasefires, truces, peace deals, sanctions,
  military action; e.g. Russia–Ukraine, Iran, Israel, the Middle East),
  crypto (cryptocurrencies, stablecoins, digital assets), china (China, Xi,
  Chinese companies), stocks (the stock market or specific listed companies).
  Use "other" only when none of these applies.
- "impact": how likely the post is to move financial markets in the coming
  hours.
  high   = a concrete new action, threat, or deadline with market consequences:
           new, raised, paused, or removed tariffs; a direct demand on the Fed
           over rates; a ceasefire, truce, peace deal, escalation, or military
           action in a war; new or lifted sanctions; moves affecting oil or
           energy supply; crypto policy; a deal or rupture with China; a
           statement that targets a specific listed company.
  medium = market-related commentary without a concrete new action: praising
           the stock market, criticizing the Fed in general terms, repeating
           known trade or foreign-policy positions.
  low    = no plausible market effect: campaigning, endorsements, media or
           personal attacks, greetings.
  A post about war, a ceasefire, energy, oil, sanctions, tariffs, interest
  rates, or the Fed is NEVER low: it is at least medium.

Return JSON only, matching the response schema.
`;

export const CATEGORY_KEYS = ["tariffs", "fed_rates", "oil", "geopolitics", "crypto", "china", "stocks", "other"] as const;
export const IMPACT_LEVELS = ["high", "medium", "low"] as const;

export const GEMINI_RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    hebrew: { type: "STRING", description: "The full Hebrew translation" },
    categories: { type: "ARRAY", items: { type: "STRING", enum: [...CATEGORY_KEYS] } },
    impact: { type: "STRING", enum: [...IMPACT_LEVELS] },
  },
  required: ["hebrew", "categories", "impact"],
  propertyOrdering: ["hebrew", "categories", "impact"],
};

export const GEMINI_MAX_TOKENS = 8192;
/** A post goes to Gemini in one piece; Truth Social posts are far shorter. */
export const GEMINI_MAX_CHARS = 12_000;
/** Wait out a free-tier 429 at most this long. */
export const GEMINI_MAX_RETRY_DELAY_MS = 10_000;
/** Pause before retrying a 5xx ("model overloaded") once. */
export const GEMINI_5XX_RETRY_MS = 2_000;
/** Time kept back from every Gemini call for sending the post afterwards. */
export const GEMINI_TIME_RESERVE_MS = 8_000;

export class GeminiError extends Error {
  /** Set when the model's daily (per-day) free-tier quota is used up. */
  dailyQuota = false;
}

export interface QuotaInfo {
  /** "day" = per-day quota (resets at midnight Pacific), "minute" = per-minute, else unknown. */
  scope: "day" | "minute" | "unknown";
  /** e.g. "GenerateRequestsPerDayPerProjectPerModel-FreeTier". */
  quotaId: string;
}

/**
 * Which quota a 429 hit. Google's body carries QuotaFailure details
 * ("quotaId": "…PerDay…") and a message ("Quota exceeded for metric: …,
 * limit: …"); the scope is read from either.
 */
export function parseQuotaInfo(body: string): QuotaInfo {
  const quotaId = /"quotaId"\s*:\s*"([^"]+)"/.exec(body)?.[1] ?? /Quota exceeded for metric:\s*([^,\\"]+)/.exec(body)?.[1]?.trim() ?? "";
  const hay = `${quotaId} ${body}`;
  const scope = /per_?day|PerDay|requests per day|RPD/i.test(hay)
    ? "day"
    : /per_?minute|PerMinute|requests per minute|RPM|TPM/i.test(hay)
      ? "minute"
      : "unknown";
  return { scope, quotaId };
}

const PACIFIC_CLOCK = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

/** Milliseconds until the Gemini API's daily quotas reset: midnight Pacific time. */
export function msUntilQuotaReset(now: number): number {
  const parts = Object.fromEntries(PACIFIC_CLOCK.formatToParts(new Date(now)).map((p) => [p.type, Number(p.value)]));
  const elapsed = ((parts.hour ?? 0) * 3600 + (parts.minute ?? 0) * 60 + (parts.second ?? 0)) * 1000;
  return 24 * 3600 * 1000 - elapsed;
}

/** Thinking settings are for full models; "lite" models are fast without them. */
export const usesThinking = (model: string): boolean => !/lite/i.test(model);

/** Seconds from a 429's RetryInfo detail ("retryDelay": "23s"), plus one. */
export function geminiRetryDelayMs(body: string): number | null {
  const m = /"retryDelay"\s*:\s*"(\d+)(?:\.\d+)?s"/.exec(body);
  return m?.[1] ? (Number(m[1]) + 1) * 1000 : null;
}

/** A 400 that complains about thinking settings the model doesn't support. */
const THINKING_REJECTED_RE = /thinking/i;

async function request(ctx: Ctx, model: string, payload: Record<string, unknown>): Promise<unknown> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  let body = payload;
  for (let attempt = 1; attempt <= 2; attempt++) {
    // Never let one call eat the run: cap it at GEMINI_TIMEOUT_SECONDS and
    // keep GEMINI_TIME_RESERVE_MS for sending.
    const timeoutMs = Math.min(ctx.cfg.geminiTimeoutMs, ctx.budget.msLeft() - GEMINI_TIME_RESERVE_MS);
    if (timeoutMs < 2_000 || !ctx.budget.canFetch()) throw new GeminiError("no time left in this run");
    let res: Response;
    try {
      res = await ctx.http(url, {
        method: "POST",
        // The key travels in a header, never in the URL, so it can't reach logs.
        headers: { "Content-Type": "application/json", "x-goog-api-key": ctx.cfg.geminiApiKey },
        body: JSON.stringify(body),
        timeoutMs,
      });
    } catch (err) {
      const what = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      throw new GeminiError(err instanceof Error && err.name === "TimeoutError" ? `timeout after ${timeoutMs / 1000}s` : what);
    }
    if (res.ok) {
      try {
        return await res.json();
      } catch {
        throw new GeminiError("response is not JSON");
      }
    }
    const fullBody = await res.text();
    const detail = fullBody.slice(0, 300);
    if (res.status === 429) {
      const quota = parseQuotaInfo(fullBody);
      if (quota.scope === "day") {
        const err = new GeminiError(`HTTP 429: daily quota exhausted (${quota.quotaId || "per-day limit"})`);
        err.dailyQuota = true;
        throw err;
      }
    }
    const generationConfig = body.generationConfig as Record<string, unknown> | undefined;
    if (res.status === 400 && attempt === 1 && generationConfig?.thinkingConfig && THINKING_REJECTED_RE.test(detail)) {
      ctx.log.warn(`Gemini ${model} rejected the thinking setting — retrying without it`);
      const { thinkingConfig: _dropped, ...rest } = generationConfig;
      body = { ...body, generationConfig: rest };
      continue;
    }
    const delay = geminiRetryDelayMs(detail);
    if (res.status === 429 && attempt === 1 && delay !== null && delay <= GEMINI_MAX_RETRY_DELAY_MS && delay + 2_000 < ctx.budget.msLeft() - GEMINI_TIME_RESERVE_MS) {
      ctx.log.warn(`Gemini rate-limited — waiting ${delay / 1000}s as asked`);
      await ctx.sleep(delay);
      continue;
    }
    // 500/503 ("overloaded") are usually momentary: one retry is cheap.
    if (res.status >= 500 && attempt === 1 && GEMINI_5XX_RETRY_MS + 2_000 < ctx.budget.msLeft() - GEMINI_TIME_RESERVE_MS) {
      ctx.log.warn(`Gemini HTTP ${res.status} — retrying once`);
      await ctx.sleep(GEMINI_5XX_RETRY_MS);
      continue;
    }
    const quota = res.status === 429 ? parseQuotaInfo(fullBody) : null;
    throw new GeminiError(
      quota?.quotaId ? `HTTP 429: ${quota.scope} quota ${quota.quotaId}` : `HTTP ${res.status}: ${detail}`,
    );
  }
  throw new GeminiError("gave up after a retry");
}

/**
 * Ask one Gemini model about one post; returns its parsed JSON answer or
 * throws GeminiError. The thinking level applies to full models only; "lite"
 * models run with their fast defaults.
 */
export async function geminiJson(
  ctx: Ctx,
  text: string,
  model = ctx.cfg.geminiModel,
): Promise<Record<string, unknown>> {
  if (!ctx.cfg.geminiApiKey) throw new GeminiError("GEMINI_API_KEY not set");
  const generationConfig: Record<string, unknown> = {
    temperature: 0.2,
    maxOutputTokens: GEMINI_MAX_TOKENS,
    responseMimeType: "application/json",
    responseSchema: GEMINI_RESPONSE_SCHEMA,
  };
  if (ctx.cfg.geminiThinkingLevel && usesThinking(model)) {
    generationConfig.thinkingConfig = { thinkingLevel: ctx.cfg.geminiThinkingLevel };
  }
  const result = (await request(ctx, model, {
    systemInstruction: { parts: [{ text: GEMINI_SYSTEM_PROMPT }] },
    contents: [{ role: "user", parts: [{ text }] }],
    generationConfig,
  })) as {
    candidates?: { finishReason?: string; content?: { parts?: { text?: string; thought?: boolean }[] } }[];
    promptFeedback?: { blockReason?: string };
  };

  const candidate = result?.candidates?.[0];
  if (!candidate) throw new GeminiError(`no candidates (blockReason=${result?.promptFeedback?.blockReason})`);
  const finish = candidate.finishReason ?? "STOP";
  // MAX_TOKENS would hand us a truncated translation; SAFETY etc. none at all.
  if (finish !== "STOP") throw new GeminiError(`finishReason=${finish}`);
  // Thinking models may return their reasoning as separate "thought" parts.
  const raw = (candidate.content?.parts ?? [])
    .filter((p) => p && !p.thought)
    .map((p) => p.text ?? "")
    .join("");
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new GeminiError(`answer is not JSON: ${JSON.stringify(raw.slice(0, 120))}`);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new GeminiError("answer is not a JSON object");
  return data as Record<string, unknown>;
}
