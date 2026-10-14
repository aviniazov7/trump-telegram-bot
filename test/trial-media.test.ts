/**
 * Cases reported from the dry run on 2026-10-11, using the real posts.
 */
import { describe, expect, it } from "vitest";
import { buildMessage, mediaOnlyLine, translatableText } from "../src/message";
import { type Post, parseCnnArchive, parseRss, parseTruthHtml } from "../src/sources";

const rss = (description: string, title = "Video post from October 11, 2026") =>
  `<rss><channel><item><title><![CDATA[${title}]]></title><link>https://www.trumpstruth.org/statuses/1</link>` +
  `<description><![CDATA[${description}]]></description><pubDate>Sun, 11 Oct 2026 15:21:00 +0000</pubDate>` +
  "<truth:originalId>117422953300698902</truth:originalId>" +
  "<truth:originalUrl>https://truthsocial.com/@realDonaldTrump/117422953300698902</truth:originalUrl></item></channel></rss>";

const VIDEO_ONLY = '<p></p><p><a href="https://archive.example/a.mp4">View video</a></p>';
const IMAGE_ONLY = '<p></p><p><a href="https://archive.example/a.jpg">View image</a></p>';
const QUOTE_OF_VIDEO =
  '<p><span><br />RT: https://truthsocial.com/users/realDonaldTrump/statuses/117422953300698902</span></p>' +
  '<p><a href="https://archive.example/b.jpg">View image</a></p>' +
  '<p>Quoted <a href="https://www.trumpstruth.org/statuses/42252">Donald J. Trump</a></p>' +
  '<blockquote><p></p><p><a href="https://archive.example/a.mp4">View video</a></p></blockquote>';
const QUOTE_WITH_TEXT =
  '<p><span><br />RT: https://truthsocial.com/users/realDonaldTrump/statuses/117419806852030114</span></p>' +
  '<p>Quoted <a href="https://www.trumpstruth.org/statuses/1">Donald J. Trump</a></p>' +
  "<blockquote><p>We will win BIG on November 3rd!</p></blockquote>";

describe("2. media-only and quote posts", () => {
  it("parses the archive's media and quote markup instead of keeping placeholders", () => {
    expect(parseTruthHtml(VIDEO_ONLY)).toEqual({
      text: "",
      media: ["video"],
      mediaUrls: ["https://archive.example/a.mp4"],
      quote: null,
    });
    expect(parseTruthHtml(QUOTE_OF_VIDEO)).toEqual({
      text: "",
      media: ["image"],
      mediaUrls: ["https://archive.example/b.jpg", "https://archive.example/a.mp4"],
      quote: { author: "Donald J. Trump", text: "", media: ["video"] },
    });
    expect(parseTruthHtml(QUOTE_WITH_TEXT).quote?.text).toBe("We will win BIG on November 3rd!");
  });

  it("keeps media-only posts (they used to be skipped or 'translated')", () => {
    const [post] = parseRss(rss(VIDEO_ONLY), 10);
    expect(post).toMatchObject({ text: "", media: ["video"] });
  });

  it.each([
    ["video", VIDEO_ONLY, "🎥 פוסט וידאו ללא טקסט"],
    ["image", IMAGE_ONLY, "🖼️ פוסט תמונה ללא טקסט"],
    ["quote of a video", QUOTE_OF_VIDEO, "🖼️ פוסט תמונה ללא טקסט · 🔁 ציטוט של פוסט וידאו של Donald J. Trump"],
  ])("a %s post gets one line, no translation block, and the link", (_name, html, line) => {
    const [post] = parseRss(rss(html), 10) as [Post];
    expect(translatableText(post)).toBe("");
    expect(mediaOnlyLine(post)).toBe(line);
    const msg = buildMessage(post, { hebrew: "", translated: true });
    expect(msg).toContain(line);
    expect(msg).not.toContain("תרגום לעברית");
    expect(msg).not.toMatch(/View (image|video)|Quoted|צפה ב/);
    expect(msg).toContain('<a href="https://truthsocial.com/@realDonaldTrump/117422953300698902">לפוסט המקורי</a>');
  });

  it("translates the quoted text when the quote post has no words of its own", () => {
    const [post] = parseRss(rss(QUOTE_WITH_TEXT, "Quote post from October 11, 2026"), 10) as [Post];
    expect(translatableText(post)).toBe("We will win BIG on November 3rd!");
    const msg = buildMessage(post, { hebrew: "ננצח בגדול ב-3 בנובמבר!", translated: true });
    expect(msg).toContain("🔁 <i>Quoting Donald J. Trump:</i>\nWe will win BIG on November 3rd!");
    expect(msg).toContain("ננצח בגדול");
  });

  it("CNN archive: media-only posts are kept, and a glued RT URL no longer eats the text", () => {
    const archive = JSON.stringify([
      {
        id: "117419813539563711",
        content:
          "RT: https://truthsocial.com/users/realDonaldTrump/statuses/11741980685203011499% Approval Rating, highest ever.",
        media: ["https://static.example/x.jpg"],
      },
      { id: "117422953300698902", content: "", media: ["https://static.example/y.mp4"] },
      { id: "117422953300698903", content: "RT: https://truthsocial.com/users/realDonaldTrump/statuses/117422953300698902", media: [] },
    ]);
    const posts = parseCnnArchive(archive, 10);
    expect(posts.map((p) => [p.id, p.text, p.media])).toEqual([
      ["117419813539563711", "99% Approval Rating, highest ever.", ["image"]],
      ["117422953300698902", "", ["video"]],
    ]);
  });
});
