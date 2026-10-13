import { describe, expect, it } from "vitest";
import { advanceCursor, type Cursor, filterNewPosts, sendOrder } from "../src/posts";
import {
  CNN_FRESH_BYTES,
  CNN_READ_BYTES,
  fetchPosts,
  freshRssUrl,
  leadingJsonObjects,
  mergePosts,
  newestFirst,
  type Post,
  parseCnnArchive,
  parseRss,
  pureRepostIds,
} from "../src/sources";
import { CNN_HOST, RSS_HOST, rssFeed, testCtx } from "./helpers";

const post = (id: string): Post => ({ id, text: `Post ${id}`, createdAt: "", url: "" });
const feed = (...ids: string[]) => ids.map(post);
const ids = (posts: Post[]) => posts.map((p) => p.id);

describe("filterNewPosts", () => {
  it("returns posts newer than lastSeen, oldest first", () => {
    expect(ids(filterNewPosts(feed("5", "4", "3", "2"), "3"))).toEqual(["4", "5"]);
  });

  it("returns nothing when nothing is new", () => {
    expect(filterNewPosts(feed("5", "4"), "5")).toEqual([]);
  });

  it("takes only the latest on the first run", () => {
    expect(ids(filterNewPosts(feed("5", "4"), ""))).toEqual(["5"]);
  });

  it("takes only the latest when lastSeen fell out of the window (safe cap)", () => {
    expect(ids(filterNewPosts(feed("9", "8"), "1"))).toEqual(["9"]);
  });

  it("keeps a whole backlog, not just 10", () => {
    const posts = feed(...Array.from({ length: 40 }, (_, i) => String(40 - i)));
    expect(ids(filterNewPosts(posts, "15"))).toEqual(Array.from({ length: 25 }, (_, i) => String(16 + i)));
  });

  it("handles an empty feed", () => {
    expect(filterNewPosts([], "1")).toEqual([]);
  });
});

describe("advanceCursor", () => {
  const chrono = ["2", "3", "4", "5"];
  const cursor = (lastSeen: string, sentAhead: string[] = []): Cursor => ({ lastSeen, sentAhead });

  it("moves in order", () => {
    const c = cursor("1");
    advanceCursor(c, chrono, "2");
    expect(c).toEqual(cursor("2"));
  });

  it("parks out-of-order posts in sentAhead until the gap closes", () => {
    const c = cursor("1");
    advanceCursor(c, chrono, "4");
    expect(c).toEqual(cursor("1", ["4"]));
    advanceCursor(c, chrono, "2");
    expect(c).toEqual(cursor("2", ["4"]));
    advanceCursor(c, chrono, "3");
    expect(c).toEqual(cursor("4"));
  });

  it("catches up over posts already sent ahead", () => {
    const c = cursor("1", ["2", "3"]);
    advanceCursor(c, chrono);
    expect(c).toEqual(cursor("3"));
  });

  it("drops stale sentAhead IDs", () => {
    const c = cursor("1", ["99"]);
    advanceCursor(c, chrono);
    expect(c).toEqual(cursor("1"));
  });
});

describe("sendOrder", () => {
  it("puts started posts first, then high impact, then the rest — each oldest first", () => {
    const items = [
      { post: post("1"), impact: "low" },
      { post: post("2"), impact: "high" },
      { post: post("3"), impact: null },
      { post: post("4"), impact: "high" },
      { post: post("5"), impact: "medium" },
    ];
    expect(sendOrder(items, new Set(["3"])).map((i) => i.post.id)).toEqual(["3", "2", "4", "1", "5"]);
  });
});

describe("sources", () => {
  it("parses the RSS feed beyond 10 items and respects the limit", () => {
    const all = Array.from({ length: 30 }, (_, i) => String(1000 - i));
    const posts = parseRss(rssFeed(all), 100);
    expect(ids(posts)).toEqual(all);
    expect(posts[0]?.url).toBe("https://truthsocial.com/@realDonaldTrump/1000");
    expect(posts[0]?.createdAt).toBe("Sat, 10 Oct 2026 18:59:16 +0000");
    expect(parseRss(rssFeed(["3", "2", "1"]), 2)).toHaveLength(2);
  });

  it("skips placeholder RSS items", () => {
    const xml = rssFeed(["2", "1"], (id) => (id === "2" ? "[No Title]" : "Real post"));
    expect(ids(parseRss(xml, 100))).toEqual(["1"]);
  });

  it("extracts leading objects from a truncated JSON array", () => {
    const text = '[{"id":"3","content":"a } tricky \\" string {"},{"id":"2","content":"b"},{"id":"1","cont';
    expect(leadingJsonObjects(text, 10)).toEqual([
      { id: "3", content: 'a } tricky " string {' },
      { id: "2", content: "b" },
    ]);
  });

  it("parses the CNN archive prefix and skips RT-only posts", () => {
    const text = JSON.stringify([
      { id: "3", created_at: "2026-10-10T18:59:16.056Z", content: "<p>Big news &amp; more</p>" },
      { id: "2", content: "RT: https://truthsocial.com/x" },
      { id: "1", content: "", text: "Older post" },
    ]);
    const posts = parseCnnArchive(text, 100);
    expect(ids(posts)).toEqual(["3", "1"]);
    expect(posts[0]).toMatchObject({
      text: "Big news & more",
      url: "https://truthsocial.com/@realDonaldTrump/3",
    });
  });

  it("treats a wordless RT as a re-post of that status, and keeps one that adds words", () => {
    const video = "117433335383227958";
    const repost = "117433336229580757";
    const quote =
      `<p><span><br />RT: https://truthsocial.com/users/realDonaldTrump/statuses/${video}</span></p>` +
      '<p><a href="https://archive.example/b.jpg">View image</a></p>' +
      '<blockquote><p></p><p><a href="https://archive.example/a.mp4">View video</a></p></blockquote>';
    const commentary = `<p>Look at this<br />RT: https://truthsocial.com/users/realDonaldTrump/statuses/${video}</p>`;
    const xml = (id: string, description: string) =>
      `<rss><channel><item><title>x</title><description><![CDATA[${description}]]></description>` +
      `<pubDate>Tue, 13 Oct 2026 11:21:00 +0000</pubDate><truth:originalId>${id}</truth:originalId>` +
      `<truth:originalUrl>https://truthsocial.com/@realDonaldTrump/${id}</truth:originalUrl></item>` +
      `<item><title>Video</title><description><![CDATA[<p></p><p><a href="https://archive.example/a.mp4">View video</a></p>]]></description>` +
      `<pubDate>Tue, 13 Oct 2026 11:21:00 +0000</pubDate><truth:originalId>${video}</truth:originalId>` +
      `<truth:originalUrl>https://truthsocial.com/@realDonaldTrump/${video}</truth:originalUrl></item></channel></rss>`;

    const bare = parseRss(xml(repost, quote), 10);
    expect(bare.find((p) => p.id === repost)?.repostOf).toBe(video);
    expect(pureRepostIds(bare)).toEqual([repost]);

    const withWords = parseRss(xml("117433336229580758", commentary), 10);
    expect(withWords.find((p) => p.id === "117433336229580758")?.text).toContain("Look at this");
    expect(pureRepostIds(withWords)).toEqual([]);

    const alone = parseRss(
      `<rss><channel><item><title>Quote</title><description><![CDATA[${quote}]]></description>` +
        `<truth:originalId>${repost}</truth:originalId><truth:originalUrl>https://truthsocial.com/@realDonaldTrump/${repost}</truth:originalUrl>` +
        `</item></channel></rss>`,
      10,
    );
    expect(pureRepostIds(alone)).toEqual([]);
  });

  it("sorts newest first by numeric snowflake ID", () => {
    expect(ids(newestFirst(feed("2", "117418148236895862", "10")))).toEqual([
      "117418148236895862",
      "10",
      "2",
    ]);
    expect(ids(newestFirst(feed("b", "a")))).toEqual(["b", "a"]);
  });
});

describe("fetchPosts", () => {
  const rss =
    (...list: string[]) =>
    () =>
      new Response(rssFeed(list));
  const cnn =
    (...list: string[]) =>
    () =>
      new Response(JSON.stringify(list.map((id) => ({ id, content: `CNN post ${id}` }))), { status: 206 });

  it("bypasses the RSS CDN cache with a unique query string", async () => {
    const ctx = testCtx({ [RSS_HOST]: rss("3", "2") }, {}, { now: () => 1_791_695_630_123 });
    await fetchPosts(ctx, "2");
    const call = ctx.calls.find((c) => c.host === RSS_HOST);
    expect(call?.url).toBe("https://www.trumpstruth.org/feed?_=1791695630");
    expect(call?.url).toBe(freshRssUrl(1_791_695_630_123));
    expect(call?.headers.get("Cache-Control")).toBe("no-cache");
  });

  it("reads both sources every run, the CNN one as a small prefix", async () => {
    const ctx = testCtx({ [RSS_HOST]: rss("3", "2"), [CNN_HOST]: cnn("3", "2") });
    expect(ids(await fetchPosts(ctx, "2"))).toEqual(["3", "2"]);
    expect(ctx.hosts().sort()).toEqual([CNN_HOST, RSS_HOST].sort());
    const cnnCall = ctx.calls.find((c) => c.host === CNN_HOST);
    expect(cnnCall?.headers.get("Range")).toBe(`bytes=0-${CNN_FRESH_BYTES - 1}`);
  });

  it("delivers a post as soon as the CNN archive has it, even if the RSS lags", async () => {
    const ctx = testCtx({ [RSS_HOST]: rss("3", "2"), [CNN_HOST]: cnn("5", "4", "3") });
    expect(ids(await fetchPosts(ctx, "2"))).toEqual(["5", "4", "3", "2"]);
    expect(ctx.log.lines.join("\n")).toContain("2 post(s) seen first in the CNN archive");
  });

  it("reads deeper into the archive when lastSeen isn't in either window", async () => {
    const ctx = testCtx({
      [RSS_HOST]: rss("9", "8"),
      [CNN_HOST]: (_c, n) => (n === 0 ? cnn("9", "8")() : cnn("9", "8", "7", "6")()),
    });
    expect(ids(await fetchPosts(ctx, "6"))).toEqual(["9", "8", "7", "6"]);
    const cnnCalls = ctx.calls.filter((c) => c.host === CNN_HOST);
    expect(cnnCalls.map((c) => c.headers.get("Range"))).toEqual([
      `bytes=0-${CNN_FRESH_BYTES - 1}`,
      `bytes=0-${CNN_READ_BYTES - 1}`,
    ]);
  });

  it("keeps the RSS when the CNN archive is down", async () => {
    const ctx = testCtx({ [RSS_HOST]: rss("3", "2") });
    expect(ids(await fetchPosts(ctx, "2"))).toEqual(["3", "2"]);
  });

  it("mergePosts keeps the first source's copy of a duplicate", () => {
    const a = [{ ...post("2"), text: "from RSS" }];
    const b = [{ ...post("3") }, { ...post("2"), text: "from CNN" }];
    const merged = mergePosts(a, b);
    expect(ids(merged)).toEqual(["3", "2"]);
    expect(merged[1]?.text).toBe("from RSS");
  });

  it("keeps the RSS when the archive doesn't help", async () => {
    const ctx = testCtx({ [RSS_HOST]: rss("9", "8") });
    expect(ids(await fetchPosts(ctx, "1"))).toEqual(["9", "8"]);
  });

  it("falls back to the archive when the RSS fails", async () => {
    const ctx = testCtx({ [RSS_HOST]: () => new Response("down", { status: 503 }), [CNN_HOST]: cnn("4") });
    expect(ids(await fetchPosts(ctx, "1"))).toEqual(["4"]);
  });

  it("returns [] when every source fails", async () => {
    expect(await fetchPosts(testCtx({}), "1")).toEqual([]);
  });
});
