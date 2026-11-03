/**
 * Regression for the Nov 3 2026 screen-recording report:
 * - "Today" seemed to appear inside words (Bou Today hard, DON. Today . TRUMP).
 * - Several posts seemed glued into one message, English of one post next to
 *   the Hebrew of another.
 * The pipeline never inserts "Today" and sends one message per post, each
 * with the Hebrew of that same post. This drives the real cron end to end.
 */
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { menuFingerprint, runCron } from "../src/broadcast";
import { resetMemoryMutes } from "../src/monitor";
import { emptyMeta, openStore } from "../src/store";
import { stripHtml } from "../src/text";
import { GEMINI, geminiAnswer, json, RSS_HOST, TELEGRAM, testCtx } from "./helpers";

const NOW = 1_800_000_000_000;
const store = openStore(env);

const POSTS: Record<string, { en: string; he: string }> = {
  "100": { en: "Already sent earlier.", he: "נשלח כבר." },
  "101": {
    en: "Congratulations to Jeff Bouchard, M.D., a great Candidate for the 7th Congressional District. NO TAX ON TIPS! DON. J. TRUMP",
    he: "ברכות לד\"ר ג'ף בושאר, מועמד נהדר למחוז השביעי לקונגרס. ביטול המס על טיפים! דונלד ג'יי טראמפ",
  },
  "102": {
    en: "Our great Attorney General is doing a fantastic job for Congress, CJT. President DJT",
    he: "התובע הכללי הנהדר שלנו עושה עבודה פנטסטית למען הקונגרס. הנשיא דונלד ג'יי טראמפ",
  },
  "103": {
    en: "Today is a big day &amp; tomorrow&#8217;s even bigger — MAKE AMERICA GREAT AGAIN!",
    he: "היום הוא יום גדול ומחר יהיה גדול עוד יותר — להחזיר לאמריקה את גדולתה!",
  },
};

function feed(ids: string[]): string {
  const items = ids
    .map(
      (id) => `<item>
  <title><![CDATA[${POSTS[id]?.en}]]></title>
  <link>https://www.trumpstruth.org/statuses/${id}</link>
  <description><![CDATA[<p>${POSTS[id]?.en}</p>]]></description>
  <pubDate>Tue, 03 Nov 2026 15:0${ids.indexOf(id)}:00 +0000</pubDate>
  <truth:originalId>${id}</truth:originalId>
  <truth:originalUrl>https://truthsocial.com/@realDonaldTrump/${id}</truth:originalUrl>
</item>`,
    )
    .join("");
  return `<rss><channel>${items}</channel></rss>`;
}

beforeEach(async () => {
  for (const { name } of (await env.STATE.list()).keys) await env.STATE.delete(name);
  await env.COORDINATOR.getByName("cron").reset();
  resetMemoryMutes();
});

describe("no 'Today' injection, one message per post, 1:1 translation", () => {
  it("text cleanup leaves Bouchard, DON. J. TRUMP and 7th intact", () => {
    for (const { en } of Object.values(POSTS)) {
      const out = stripHtml(`<p>${en}</p>`);
      for (const word of ["Bouchard", "DON. J. TRUMP", "7th Congressional", "Congress", "CJT"]) {
        if (en.includes(word)) expect(out).toContain(word);
      }
      expect(out.match(/Today/g)?.length ?? 0).toBe(en.match(/Today/g)?.length ?? 0);
    }
  });

  it("sends three separate messages, each English with its own Hebrew", async () => {
    await store.putMeta({
      ...emptyMeta(),
      lastSeen: "100",
      lastSuccess: NOW,
      menu: await menuFingerprint("test-bot-token"),
    });
    await store.putSubscriber("a", null);
    const sent: string[] = [];
    // Answer out of order and slowly for the first post, to catch any
    // positional mapping between requests and answers.
    const ctx = testCtx(
      {
        [RSS_HOST]: () => new Response(feed(["103", "102", "101", "100"])),
        [TELEGRAM]: (call) => {
          const body = JSON.parse(call.body || "{}");
          if (body.chat_id === "a" && body.text) sent.push(body.text);
          return json({ ok: true, result: { message_id: sent.length } });
        },
        [GEMINI]: (call) => {
          const text = JSON.parse(call.body).contents[0].parts[0].text as string;
          const id = Object.keys(POSTS).find((k) => stripHtml(POSTS[k]?.en ?? "") === text);
          return json(
            geminiAnswer({ hebrew: POSTS[id ?? ""]?.he ?? "", categories: ["other"], impact: "low" }),
          );
        },
      },
      { maxSubrequests: 200 },
      { now: () => NOW },
    );
    await runCron(ctx, store);

    expect(sent).toHaveLength(3);
    const ids = ["101", "102", "103"];
    sent.forEach((message, i) => {
      const post = POSTS[ids[i] ?? ""];
      const [english, hebrew] = message.split("━━━━━━━━━━━━━━━");
      // Exactly one post per message.
      expect(message.match(/פוסט חדש/g)).toHaveLength(1);
      expect(message).toContain(`truthsocial.com/@realDonaldTrump/${ids[i]}`);
      // Its own Hebrew, and none of the others'.
      expect(hebrew).toContain(post?.he.replace(/"/g, "&quot;").replace(/'/g, "&#x27;"));
      for (const other of ids.filter((x) => x !== ids[i])) {
        expect(hebrew).not.toContain(POSTS[other]?.he.slice(0, 20));
      }
      // No "Today" inserted into the English; only the one the post really has.
      expect(english?.match(/Today/g)?.length ?? 0).toBe(ids[i] === "103" ? 1 : 0);
      expect(english).not.toMatch(/\w Today \w/);
      expect(message).not.toMatch(/HTTP \d|quota|skipped/);
    });
    expect(sent[0]).toContain("Bouchard");
    expect(sent[0]).toContain("DON. J. TRUMP");
    expect(sent[0]).toContain("7th Congressional");
  });
});
