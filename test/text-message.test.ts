import { describe, expect, it } from "vitest";
import { buildMessage, buildTagLine, formatTimestamp } from "../src/message";
import type { Post } from "../src/sources";
import {
  TELEGRAM_MAX_MESSAGE_LEN,
  htmlEscape,
  htmlUnescape,
  isMeaningfulText,
  splitForTelegram,
  splitText,
  stripHtml,
} from "../src/text";

const POST: Post = {
  id: "1",
  text: `Tariffs <now> & "forever"`,
  createdAt: "Sat, 10 Oct 2026 18:59:16 +0000",
  url: "https://truthsocial.com/@realDonaldTrump/1?a=1&b=2",
};

describe("html helpers", () => {
  it("escapes like Python's html.escape", () => {
    expect(htmlEscape(`<a href="x">'&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&#x27;&amp;&#x27;&lt;/a&gt;");
  });

  it("unescapes named and numeric entities", () => {
    expect(htmlUnescape("&amp;&lt;&#8217;&#x27;&rsquo;&bogus;")).toBe("&<’'’&bogus;");
  });

  it("strips feed HTML and URLs", () => {
    const raw = '<p>Hello&amp;bye<br/>RT: https://x.com/a <a href="u">link</a></p><p>Next</p>';
    expect(stripHtml(raw)).toBe("Hello&bye\nlink \nNext");
  });

  it("recognises placeholder posts", () => {
    expect(isMeaningfulText("RT: https://truthsocial.com/x")).toBe(false);
    expect(isMeaningfulText("[No Title] - Post from ...")).toBe(false);
    expect(isMeaningfulText("Video post from October 14, 2026")).toBe(false);
    expect(isMeaningfulText("View video")).toBe(false);
    expect(isMeaningfulText("  ")).toBe(false);
    expect(isMeaningfulText("MAKE AMERICA GREAT AGAIN!")).toBe(true);
    expect(isMeaningfulText("Greenland has enormous oil")).toBe(true);
  });

  it("treats an RT @handle / Reposted name boost as empty, and keeps real commentary", () => {
    const live =
      '<p>RT <span class="h-card"><a href="https://truthsocial.com/@realDonaldTrump">@realDonaldTrump</a></span></p>' +
      '<p>Reposted <a href="https://www.trumpstruth.org/statuses/42328">Donald J. Trump</a></p>';
    expect(stripHtml(live)).toBe("");
    expect(isMeaningfulText("RT @realDonaldTrump")).toBe(false);
    expect(isMeaningfulText("Reposted Donald J. Trump")).toBe(false);
    expect(isMeaningfulText("RT @realDonaldTrump\nReposted Donald J. Trump")).toBe(false);
    expect(stripHtml(`<p>Look at this</p>${live}`)).toBe("Look at this");
    expect(isMeaningfulText("Look at this\nRT @realDonaldTrump\nReposted Donald J. Trump")).toBe(true);
  });
});

describe("buildMessage", () => {
  it("lays out header, Israel time, both texts and the link", () => {
    const msg = buildMessage(POST, { hebrew: "מכסים <עכשיו>", translated: true });
    const lines = msg.split("\n");
    expect(lines[0]).toBe("🇺🇸 <b>טראמפ — פוסט חדש</b>");
    expect(lines[1]).toBe("🕐 10/10/2026 21:59"); // UTC+3 in October
    expect(msg).toContain("Tariffs &lt;now&gt; &amp; &quot;forever&quot;");
    expect(msg).toContain("🇮🇱 <b>תרגום לעברית:</b>\nמכסים &lt;עכשיו&gt;");
    expect(msg.endsWith('<a href="https://truthsocial.com/@realDonaldTrump/1?a=1&amp;b=2">לפוסט המקורי</a>')).toBe(true);
  });

  it("shows a notice instead of English under the Hebrew heading", () => {
    const msg = buildMessage(POST, { hebrew: POST.text, translated: false });
    expect(msg).not.toContain("תרגום לעברית:");
    expect(msg).toContain("התרגום לעברית נכשל");
  });

  it("puts the tag line first", () => {
    const msg = buildMessage(POST, { hebrew: "x", translated: true, categories: ["china", "tariffs"], impact: "high" });
    expect(msg.split("\n")[0]).toBe("🔴 <b>השפעה גבוהה על השווקים</b> · #סין #מכסים");
  });

  it("omits the link when there is no URL", () => {
    expect(buildMessage({ ...POST, url: "" }, { hebrew: "x", translated: true })).not.toContain("<a ");
  });
});

describe("formatTimestamp", () => {
  it("handles RFC 2822, ISO with and without zone, and junk", () => {
    expect(formatTimestamp("2026-10-10T18:59:16.056Z")).toBe("10/10/2026 21:59");
    expect(formatTimestamp("2026-01-10T18:59:16")).toBe("10/01/2026 20:59"); // winter: UTC+2
    expect(formatTimestamp("sometime")).toBe("sometime");
    expect(formatTimestamp("")).toBe("—");
  });
});

describe("buildTagLine", () => {
  it("formats each impact level", () => {
    expect(buildTagLine(["fed_rates"], "medium")).toBe("🟠 השפעה בינונית על השווקים · #ריבית_הפד");
    expect(buildTagLine(["other"], "low")).toBe("⚪ השפעה נמוכה על השווקים · #כללי");
    expect(buildTagLine([], "high")).toBe("🔴 <b>השפעה גבוהה על השווקים</b>");
  });

  it("shows only topics when impact is unknown", () => {
    expect(buildTagLine(["oil", "crypto"], null)).toBe("🏷️ #נפט_ואנרגיה #קריפטו");
  });

  it("is empty without valid data", () => {
    expect(buildTagLine(null, null)).toBe("");
    expect(buildTagLine(["bogus"], "bogus")).toBe("");
  });
});

describe("splitting", () => {
  it("leaves short messages alone", () => {
    expect(splitForTelegram("hello")).toEqual(["hello"]);
  });

  it("splits at newlines within the limit and loses nothing", () => {
    const text = Array.from({ length: 200 }, (_, i) => `line ${i} ${"x".repeat(50)}`).join("\n");
    const chunks = splitForTelegram(text, 1000);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= 1000)).toBe(true);
    expect(chunks.join("\n")).toBe(text);
  });

  it("falls back to spaces, then a hard cut", () => {
    expect(splitForTelegram(Array(500).fill("word").join(" "), 100).every((c) => c.length <= 100)).toBe(true);
    expect(splitForTelegram("x".repeat(250), 100)).toEqual(["x".repeat(100), "x".repeat(100), "x".repeat(50)]);
  });

  it("never cuts through an HTML tag in a long post", () => {
    const long: Post = { ...POST, text: Array(40).fill("A long paragraph of text. ".repeat(10)).join("\n") };
    const msg = buildMessage(long, {
      hebrew: Array(40).fill("פסקה ארוכה מאוד. ".repeat(10)).join("\n"),
      translated: true,
      categories: ["stocks"],
      impact: "high",
    });
    const chunks = splitForTelegram(msg);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(TELEGRAM_MAX_MESSAGE_LEN);
      for (const tag of ["b", "a"]) {
        const opens = chunk.match(new RegExp(`<${tag}[ >]`, "g"))?.length ?? 0;
        expect(opens).toBe(chunk.split(`</${tag}>`).length - 1);
      }
    }
  });

  it("splitText prefers newlines, then sentences, then a hard cut", () => {
    expect(splitText(`${"a".repeat(60)}\n${"b".repeat(60)}`, 100)).toEqual([`${"a".repeat(60)}\n`, "b".repeat(60)]);
    expect(splitText(`${"a".repeat(60)}. ${"b".repeat(60)}`, 100)).toEqual([`${"a".repeat(60)}.`, "b".repeat(60)]);
    expect(splitText("x".repeat(250), 100)).toEqual(["x".repeat(100), "x".repeat(100), "x".repeat(50)]);
  });
});
