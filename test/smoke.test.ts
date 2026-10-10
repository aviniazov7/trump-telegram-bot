import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";

describe("worker", () => {
  it("answers unknown routes with 404", async () => {
    const res = await worker.fetch(new Request("https://bot.example/"), env);
    expect(res.status).toBe(404);
  });

  it("has a KV binding and test-only secrets", async () => {
    await env.STATE.put("k", "v");
    expect(await env.STATE.get("k")).toBe("v");
    expect(env.TELEGRAM_BOT_TOKEN).toBe("test-bot-token");
  });
});
