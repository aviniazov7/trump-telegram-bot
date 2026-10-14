/**
 * Hebrew fallback when Gemini fails. One short call, reasoning off, so it
 * stays inside the Workers Free daily neuron allowance (10,000/day).
 *
 * Model: @cf/zai-org/glm-4.7-flash — multilingual instruct, still on the free
 * plan as of the 2026-07-28 catalog change. Paid-only models (Kimi, GLM-5.x)
 * are not used. The binding is `env.AI`; this module never calls the REST API.
 */
import { BudgetExhausted, type Ctx, type WorkersAiClient } from "./runtime";

/** Cap the completion so a rambling answer can't spend the day's neurons. */
export const WORKERS_AI_MAX_TOKENS = 2048;
const TIME_RESERVE_MS = 8_000;

const SYSTEM_PROMPT = `\
You translate Donald Trump's Truth Social posts into Hebrew for Israeli readers.
Translate the whole post completely. Do not summarize, omit, add, or comment.
Write natural modern Hebrew. Keep line breaks, @handles, URLs, numbers, and hashtags unchanged.
Transliterate names the way Israeli media do (Donald Trump = דונלד טראמפ).
Return only the Hebrew translation. No JSON, no quotes, no preamble.
`;

export class WorkersAiError extends Error {}

/** Wrap the platform binding. The model id is config, not a type-level literal. */
export function bindWorkersAi(ai: Ai): WorkersAiClient {
  return {
    run(model, input, options) {
      const body: Record<string, unknown> = {
        messages: input.messages,
        temperature: input.temperature,
        max_completion_tokens: input.max_completion_tokens,
        chat_template_kwargs: input.chat_template_kwargs,
      };
      return ai.run(model, body, options);
    },
  };
}

function messageContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return "";
      const row = part as { type?: string; text?: string };
      if (row.type === "reasoning" || row.type === "thinking") return "";
      return typeof row.text === "string" ? row.text : "";
    })
    .join("");
}

function cleanTranslation(raw: string): string {
  let text = raw.trim();
  const fenced = /^```[a-z]*\s*([\s\S]*?)\s*```$/i.exec(text);
  if (fenced?.[1]) text = fenced[1].trim();
  if (text.startsWith("{")) {
    try {
      const data = JSON.parse(text) as { hebrew?: unknown };
      if (typeof data.hebrew === "string") return data.hebrew.trim();
    } catch {
      // Prose that happens to start with a brace.
    }
  }
  if (text.length >= 2 && (text[0] === '"' || text[0] === "'") && text.at(-1) === text[0]) {
    return text.slice(1, -1).trim();
  }
  return text;
}

/** Pull the answer out of a chat-completion payload. Reasoning text is ignored. */
export function extractWorkersAiText(result: unknown): { text: string; truncated: boolean } {
  if (!result || typeof result !== "object") return { text: "", truncated: false };
  const root = result as Record<string, unknown>;
  const nested = root.result && typeof root.result === "object" ? (root.result as Record<string, unknown>) : undefined;
  const payload = Array.isArray(root.choices) ? root : nested;
  const choices = payload && Array.isArray(payload.choices) ? payload.choices : undefined;
  const choice = choices?.[0];
  if (choice && typeof choice === "object") {
    const row = choice as { finish_reason?: string; message?: { content?: unknown } };
    return {
      text: cleanTranslation(messageContent(row.message?.content)),
      truncated: row.finish_reason === "length",
    };
  }
  if (typeof root.response === "string") return { text: cleanTranslation(root.response), truncated: false };
  if (nested && typeof nested.response === "string") return { text: cleanTranslation(nested.response), truncated: false };
  return { text: "", truncated: false };
}

/**
 * Translate one post. Throws WorkersAiError on timeout, truncation, or a
 * missing binding. The caller decides whether that is fatal.
 */
export async function workersAiTranslate(ctx: Ctx, text: string): Promise<string> {
  const ai = ctx.ai;
  const model = ctx.cfg.workersAiModel;
  if (!ai || !model) throw new WorkersAiError("Workers AI is not configured");
  const timeoutMs = Math.min(ctx.cfg.geminiTimeoutMs, ctx.budget.msLeft() - TIME_RESERVE_MS);
  if (timeoutMs < 2_000 || !ctx.budget.canFetch()) throw new WorkersAiError("no time left in this run");
  let result: unknown;
  try {
    ctx.budget.take();
    result = await ai.run(
      model,
      {
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: text },
        ],
        temperature: 0.2,
        max_completion_tokens: WORKERS_AI_MAX_TOKENS,
        // On by default for this model. The chain of thought is not the
        // translation, and it spends the free neuron allowance.
        chat_template_kwargs: { enable_thinking: false },
      },
      { signal: AbortSignal.timeout(timeoutMs) },
    );
  } catch (err) {
    if (err instanceof BudgetExhausted) throw new WorkersAiError("no time left in this run");
    const name = err instanceof Error ? err.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      throw new WorkersAiError(`timeout after ${timeoutMs / 1000}s`);
    }
    throw new WorkersAiError(err instanceof Error ? err.message : String(err));
  }
  const extracted = extractWorkersAiText(result);
  if (extracted.truncated) throw new WorkersAiError("truncated answer");
  return extracted.text;
}
