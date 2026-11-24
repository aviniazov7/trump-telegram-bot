import { describe, expect, it } from "vitest";
import { chatGone, deleteMessage, editMessage, sendMessage, telegramCall } from "../src/telegram";
import { TELEGRAM, json, testCtx, timeout } from "./helpers";

const tgError = (code: number, description: string, parameters?: Record<string, unknown>) =>
  json({ ok: false, error_code: code, description, ...(parameters ? { parameters } : {}) }, code);
const tgOk = () => json({ ok: true, result: { message_id: 1 } });

describe("telegramCall", () => {
  it("returns the result on success", async () => {
    const ctx = testCtx({ [TELEGRAM]: tgOk });
    const r = await telegramCall(ctx, "sendMessage", {});
    expect(r.ok).toBe(true);
    expect(r.result).toEqual({ message_id: 1 });
  });

  it("never retries a send after a timeout", async () => {
    const ctx = testCtx({ [TELEGRAM]: timeout });
    const r = await telegramCall(ctx, "sendMessage", {});
    expect(r).toMatchObject({ ok: false, uncertain: true });
    expect(ctx.calls).toHaveLength(1);
  });

  it("never retries a send after a 5xx", async () => {
    const ctx = testCtx({ [TELEGRAM]: () => tgError(502, "Bad Gateway") });
    expect((await telegramCall(ctx, "sendMessage", {})).uncertain).toBe(true);
    expect(ctx.calls).toHaveLength(1);
  });

  it("retries idempotent calls", async () => {
    const ctx = testCtx({ [TELEGRAM]: (_c, n) => (n < 2 ? timeout() : tgOk()) });
    expect((await telegramCall(ctx, "setMyCommands", {}, { idempotent: true })).ok).toBe(true);
    expect(ctx.calls).toHaveLength(3);
  });

  it("waits retry_after on 429, then retries", async () => {
    const ctx = testCtx({
      [TELEGRAM]: (_c, n) => (n === 0 ? tgError(429, "Too Many Requests", { retry_after: 7 }) : tgOk()),
    });
    expect((await telegramCall(ctx, "sendMessage", {})).ok).toBe(true);
    expect(ctx.sleeps).toEqual([7000]);
  });

  it("leaves a long 429 for the next run", async () => {
    const ctx = testCtx({ [TELEGRAM]: () => tgError(429, "Too Many Requests", { retry_after: 600 }) });
    const r = await telegramCall(ctx, "sendMessage", {});
    expect(r).toMatchObject({ ok: false, errorCode: 429, retryAfter: 600 });
    expect(ctx.sleeps).toEqual([]);
  });

  it("doesn't wait past the run's time budget", async () => {
    let t = 0;
    const ctx = testCtx(
      { [TELEGRAM]: () => tgError(429, "Too Many Requests", { retry_after: 8 }) },
      { runTimeBudgetMs: 5000 },
      { now: () => t },
    );
    t = 1000;
    expect((await telegramCall(ctx, "sendMessage", {})).ok).toBe(false);
    expect(ctx.sleeps).toEqual([]);
  });

  it("recognises chats that are gone for good", async () => {
    const cases: [number, string, boolean][] = [
      [403, "Forbidden: bot was blocked by the user", true],
      [403, "Forbidden: bot was kicked from the group chat", true],
      [400, "Bad Request: chat not found", true],
      [400, "Bad Request: can't parse entities", false],
    ];
    for (const [code, description, gone] of cases) {
      const ctx = testCtx({ [TELEGRAM]: () => tgError(code, description) });
      expect(chatGone(await telegramCall(ctx, "sendMessage", {}))).toBe(gone);
    }
  });

  it("never logs the token or chat IDs", async () => {
    const ctx = testCtx({
      [TELEGRAM]: () => tgError(400, "Bad Request: upgraded", { migrate_to_chat_id: -1001234567890 }),
    });
    const r = await telegramCall(ctx, "sendMessage", { chat_id: "5551234567" });
    expect(r.migrateTo).toBe("-1001234567890");
    const logs = ctx.log.lines.join("\n");
    expect(logs).not.toContain("1234567890");
    expect(logs).not.toContain("5551234567");
    expect(logs).not.toContain("test-bot-token");
  });
});

describe("sendMessage", () => {
  it("sends HTML with link previews off and the forum topic", async () => {
    const ctx = testCtx({ [TELEGRAM]: tgOk });
    expect(await sendMessage(ctx, "1", "hi", { threadId: "77" })).toEqual({
      status: "ok",
      migratedTo: "",
      messageIds: [1],
    });
    const body = JSON.parse(ctx.calls[0]?.body ?? "{}");
    expect(body).toMatchObject({ chat_id: "1", parse_mode: "HTML", message_thread_id: 77 });
    expect(ctx.calls[0]?.url).toBe("https://api.telegram.org/bottest-bot-token/sendMessage");
  });

  it.each([
    ["blocked", () => tgError(403, "Forbidden: bot was blocked by the user"), "gone"],
    ["timed out", timeout, "uncertain"],
    ["5xx", () => tgError(500, "Internal"), "uncertain"],
    ["bad request", () => tgError(400, "Bad Request: can't parse entities"), "failed"],
    [
      "network error",
      () => {
        throw new TypeError("Network connection lost");
      },
      "retry",
    ],
    ["long 429", () => tgError(429, "Too Many Requests", { retry_after: 600 }), "retry"],
  ])("maps %s to %s", async (_name, handler, status) => {
    const ctx = testCtx({ [TELEGRAM]: handler });
    expect((await sendMessage(ctx, "1", "hi")).status).toBe(status);
  });

  it("follows a group migration and resends there once", async () => {
    const ctx = testCtx({
      [TELEGRAM]: (_c, n) =>
        n === 0
          ? tgError(400, "Bad Request: group chat was upgraded", { migrate_to_chat_id: -100777 })
          : tgOk(),
    });
    expect(await sendMessage(ctx, "-5", "hi")).toEqual({
      status: "ok",
      migratedTo: "-100777",
      messageIds: [1],
    });
    expect(JSON.parse(ctx.calls[1]?.body ?? "{}").chat_id).toBe("-100777");
  });

  it("marks a long message cut short as uncertain, so it isn't resent", async () => {
    const ctx = testCtx({
      [TELEGRAM]: (_c, n) => (n === 0 ? tgOk() : tgError(429, "Too Many Requests", { retry_after: 600 })),
    });
    expect((await sendMessage(ctx, "1", "a\n".repeat(5000))).status).toBe("uncertain");
  });

  it("doesn't start a send it can't finish within the subrequest budget", async () => {
    const ctx = testCtx({ [TELEGRAM]: tgOk }, { maxSubrequests: 2 });
    expect((await sendMessage(ctx, "1", "hi", { reserve: 2 })).status).toBe("retry");
    expect(ctx.calls).toHaveLength(0);
  });
});

describe("editMessage & deleteMessage", () => {
  it("edits a message and treats message-is-not-modified as ok", async () => {
    const okCtx = testCtx({ [TELEGRAM]: tgOk });
    expect(await editMessage(okCtx, "1", 42, "updated")).toBe("ok");
    expect(JSON.parse(okCtx.calls[0]?.body ?? "{}")).toMatchObject({
      chat_id: "1",
      message_id: 42,
      text: "updated",
    });

    const sameCtx = testCtx({ [TELEGRAM]: () => tgError(400, "Bad Request: message is not modified") });
    expect(await editMessage(sameCtx, "1", 42, "same")).toBe("ok");
  });

  it("maps gone, retry, and failed edit responses properly", async () => {
    const goneCtx = testCtx({ [TELEGRAM]: () => tgError(400, "Bad Request: message to edit not found") });
    expect(await editMessage(goneCtx, "1", 42, "x")).toBe("gone");

    const retryCtx = testCtx({ [TELEGRAM]: () => tgError(429, "Too Many Requests", { retry_after: 600 }) });
    expect(await editMessage(retryCtx, "1", 42, "x")).toBe("retry");

    const delCtx = testCtx({ [TELEGRAM]: tgOk });
    await deleteMessage(delCtx, "1", 43);
    expect(delCtx.calls[0]?.url).toContain("/deleteMessage");
  });
});
