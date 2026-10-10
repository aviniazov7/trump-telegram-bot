/**
 * Logging that can't leak secrets or identify people.
 *
 * Workers logs are private to the Cloudflare account, but they still get
 * copied, pasted into issues and screenshotted. So: every line is scrubbed of
 * anything token-shaped, and chat IDs are only ever logged through
 * redactChat(), a keyed hash that is stable across runs but not reversible
 * without the bot token.
 */

const SCRUB: [RegExp, string][] = [
  [/bot\d{6,12}:[A-Za-z0-9_-]{20,}/g, "bot<redacted>"],
  [/\d{6,12}:AA[A-Za-z0-9_-]{30,}/g, "<redacted-token>"],
  [/AIza[0-9A-Za-z_-]{30,}/g, "<redacted-key>"],
  [/([?&](?:key|token|secret)=)[^&\s"]+/gi, "$1<redacted>"],
];

export function scrub(text: string): string {
  let out = text;
  for (const [re, replacement] of SCRUB) out = out.replace(re, replacement);
  return out;
}

type Level = "debug" | "info" | "warn" | "error";

export class Logger {
  readonly lines: string[] = [];
  private keyPromise: Promise<CryptoKey> | undefined;

  constructor(
    private readonly hashSecret: string,
    private readonly sink: (level: Level, line: string) => void = defaultSink,
    private readonly keep = false,
  ) {}

  private emit(level: Level, parts: unknown[]): void {
    const line = scrub(parts.map((p) => (p instanceof Error ? `${p.name}: ${p.message}` : String(p))).join(" "));
    if (this.keep) this.lines.push(`[${level}] ${line}`);
    this.sink(level, line);
  }

  debug(...parts: unknown[]): void {
    this.emit("debug", parts);
  }
  info(...parts: unknown[]): void {
    this.emit("info", parts);
  }
  warn(...parts: unknown[]): void {
    this.emit("warn", parts);
  }
  error(...parts: unknown[]): void {
    this.emit("error", parts);
  }

  /** Log-safe stand-in for a chat ID: "chat#" + 10 hex chars of HMAC-SHA256. */
  async chat(chatId: string | number | null | undefined): Promise<string> {
    if (chatId === null || chatId === undefined || chatId === "") return "chat#-";
    this.keyPromise ??= crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(this.hashSecret || "no-secret"),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = await crypto.subtle.sign("HMAC", await this.keyPromise, new TextEncoder().encode(String(chatId)));
    return `chat#${toHex(sig).slice(0, 10)}`;
  }
}

export function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function defaultSink(level: Level, line: string): void {
  const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  fn(`[${level}] ${line}`);
}

/** A logger that records lines (for tests) and stays silent. */
export function memoryLogger(hashSecret = "test"): Logger {
  return new Logger(hashSecret, () => {}, true);
}
