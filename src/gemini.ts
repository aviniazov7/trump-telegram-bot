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
  rates), oil (oil, gas, OPEC, energy supply), crypto (cryptocurrencies,
  stablecoins, digital assets), china (China, Xi, Chinese companies), stocks
  (the stock market or specific listed companies). Use "other" only when none
  of these applies.
- "impact": how likely the post is to move financial markets in the coming
  hours.
  high   = a concrete new action, threat, or deadline with market consequences:
           new, raised, paused, or removed tariffs; a direct demand on the Fed
           over rates; sanctions or moves affecting oil supply; crypto policy;
           a deal or rupture with China; a statement that targets a specific
           listed company.
  medium = market-related commentary without a concrete new action: praising
           the stock market, criticizing the Fed in general terms, repeating
           known trade positions.
  low    = no plausible market effect: campaigning, endorsements, media or
           personal attacks, greetings.

Return JSON only, matching the response schema.
`;

export const CATEGORY_KEYS = ["tariffs", "fed_rates", "oil", "crypto", "china", "stocks", "other"] as const;
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
/** Wait out a free-tier 429 at most this long (the run has ~40 s). */
export const GEMINI_MAX_RETRY_DELAY_MS = 10_000;
const GEMINI_TIMEOUT_MS = 30_000;

export class GeminiError extends Error {}

/** Seconds from a 429's RetryInfo detail ("retryDelay": "23s"), plus one. */
export function geminiRetryDelayMs(body: string): number | null {
  const m = /"retryDelay"\s*:\s*"(\d+)(?:\.\d+)?s"/.exec(body);
  return m?.[1] ? (Number(m[1]) + 1) * 1000 : null;
}

async function request(ctx: Ctx, payload: unknown): Promise<unknown> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(ctx.cfg.geminiModel)}:generateContent`;
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (!ctx.budget.canFetch()) throw new GeminiError("run budget exhausted");
    let res: Response;
    try {
      res = await ctx.http(url, {
        method: "POST",
        // The key travels in a header, never in the URL, so it can't reach logs.
        headers: { "Content-Type": "application/json", "x-goog-api-key": ctx.cfg.geminiApiKey },
        body: JSON.stringify(payload),
        timeoutMs: Math.min(GEMINI_TIMEOUT_MS, Math.max(1000, ctx.budget.msLeft())),
      });
    } catch (err) {
      throw new GeminiError(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
    }
    if (res.ok) {
      try {
        return await res.json();
      } catch {
        throw new GeminiError("response is not JSON");
      }
    }
    const detail = (await res.text()).slice(0, 300);
    const delay = geminiRetryDelayMs(detail);
    if (res.status === 429 && attempt === 1 && delay !== null && delay <= GEMINI_MAX_RETRY_DELAY_MS && delay < ctx.budget.msLeft()) {
      ctx.log.warn(`Gemini rate-limited — waiting ${delay / 1000}s as asked`);
      await ctx.sleep(delay);
      continue;
    }
    throw new GeminiError(`HTTP ${res.status}: ${detail}`);
  }
  throw new GeminiError("rate-limited");
}

/** Ask Gemini about one post; returns its parsed JSON answer or throws GeminiError. */
export async function geminiJson(ctx: Ctx, text: string): Promise<Record<string, unknown>> {
  if (!ctx.cfg.geminiApiKey) throw new GeminiError("GEMINI_API_KEY not set");
  const generationConfig: Record<string, unknown> = {
    temperature: 0.2,
    maxOutputTokens: GEMINI_MAX_TOKENS,
    responseMimeType: "application/json",
    responseSchema: GEMINI_RESPONSE_SCHEMA,
  };
  if (ctx.cfg.geminiThinkingLevel) generationConfig.thinkingConfig = { thinkingLevel: ctx.cfg.geminiThinkingLevel };
  const result = (await request(ctx, {
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
