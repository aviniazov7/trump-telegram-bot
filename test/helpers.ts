import { type Config, loadConfig } from "../src/config";
import type { Env } from "../src/env";
import { memoryLogger } from "../src/log";
import { type Ctx, makeCtx } from "../src/runtime";

export interface Call {
  url: string;
  host: string;
  method: string;
  headers: Headers;
  body: string;
}

export type Handler = (call: Call, n: number) => Response | Promise<Response>;

/**
 * A fake fetch routed by hostname. Unrouted hosts fail like a network error.
 * `n` is how many times that host has been called before (0-based).
 */
export function fakeFetch(routes: Record<string, Handler>) {
  const calls: Call[] = [];
  const counts = new Map<string, number>();
  const fetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const host = new URL(url).hostname;
    const call: Call = {
      url,
      host,
      method: init.method ?? "GET",
      headers: new Headers(init.headers),
      body: typeof init.body === "string" ? init.body : "",
    };
    calls.push(call);
    const n = counts.get(host) ?? 0;
    counts.set(host, n + 1);
    const handler = routes[host];
    if (!handler) throw new TypeError(`Network connection lost (${host})`);
    return handler(call, n);
  };
  return { fetch, calls, hosts: () => calls.map((c) => c.host) };
}

export const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

export const timeout = (): never => {
  throw new DOMException("The operation timed out.", "TimeoutError");
};

export function testConfig(overrides: Partial<Config> = {}, env: Partial<Env> = {}): Config {
  const base = loadConfig({
    STATE: undefined as unknown as KVNamespace,
    TELEGRAM_BOT_TOKEN: "test-bot-token",
    TELEGRAM_WEBHOOK_SECRET: "test-webhook-secret-0123456789abcdef",
    GEMINI_API_KEY: "test-gemini-key",
    ADMIN_CHAT_ID: "999",
    DRY_RUN: "false",
    ...env,
  });
  return { ...base, ...overrides };
}

export function testCtx(
  routes: Record<string, Handler> = {},
  overrides: Partial<Config> = {},
  opts: { now?: () => number } = {},
): Ctx & { calls: Call[]; hosts: () => string[]; sleeps: number[] } {
  const fake = fakeFetch(routes);
  const sleeps: number[] = [];
  const ctx = makeCtx(testConfig(overrides), {
    fetch: fake.fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    now: opts.now,
    log: memoryLogger(),
  });
  return Object.assign(ctx, { calls: fake.calls, hosts: fake.hosts, sleeps });
}

export const GEMINI = "generativelanguage.googleapis.com";
export const GTX = "translate.googleapis.com";
export const CLIENTS5 = "clients5.google.com";
export const MYMEMORY = "api.mymemory.translated.net";
export const TELEGRAM = "api.telegram.org";
export const RSS_HOST = "www.trumpstruth.org";
export const CNN_HOST = "ix.cnn.io";

export function geminiAnswer(data: unknown, finishReason = "STOP", thought?: string) {
  const text = typeof data === "string" ? data : JSON.stringify(data);
  const parts: { text: string; thought?: boolean }[] = thought ? [{ text: thought, thought: true }] : [];
  parts.push({ text });
  return { candidates: [{ content: { parts }, finishReason }] };
}

export function rssFeed(ids: string[], text = (id: string) => `Post number ${id}`): string {
  const items = ids
    .map(
      (id, n) => `<item>
  <title><![CDATA[${text(id)}]]></title>
  <link>https://www.trumpstruth.org/statuses/${n}</link>
  <description><![CDATA[<p>${text(id)}</p>]]></description>
  <pubDate>Sat, 10 Oct 2026 18:59:16 +0000</pubDate>
  <truth:originalId>${id}</truth:originalId>
  <truth:originalUrl>https://truthsocial.com/@realDonaldTrump/${id}</truth:originalUrl>
</item>`,
    )
    .join("");
  return `<rss><channel>${items}</channel></rss>`;
}
