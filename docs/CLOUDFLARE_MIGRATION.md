# Proposal: move scheduling to a Cloudflare Worker

**Status: implemented**, then cut over on 2026-10-12. On 2026-10-13 the
GitHub Actions workflow and `legacy/` were deleted, and a Durable Object
(`Coordinator`) took the single-flight lease and the send claims — the
duplicate-send risk called out below. The live bot is described in
[operations.md](operations.md). The repository README is the portfolio
overview. The rest of this document is the original proposal, kept for its
reasoning.

## Why

The workflow is scheduled `*/10 * * * *`, but GitHub treats schedules as best
effort and skips or delays runs under load. The real gaps between runs have
been **2.5–8 hours**. The catch-up logic (deep scan, per-post checkpoints)
means posts are no longer *lost*, but they arrive hours late. That defeats the
point of 🔴 high-impact alerts. A Cloudflare Cron Trigger fires every minute
reliably, so latency drops from hours to about a minute.

## Target architecture

```
Cloudflare Cron Trigger  (* * * * *, every minute)
  └─ Worker  scheduled()
       1. acquire lease            → Durable Object "bot-state" (single-flight lock)
       2. load state               ← Durable Object storage (strongly consistent)
       3. getUpdates               ← Telegram  (or a webhook, see step 7 below)
       4. fetch RSS                ← trumpstruth.org (100 posts)
       5. analyze new posts        ← Gemini (translation + tags), free chain fallback
       6. send: in_flight → 🔴 → rest
            sendMessage            → Telegram, per subscriber
            save state per post    → Durable Object
       7. heartbeat + release lease

Secrets: wrangler secret put TELEGRAM_BOT_TOKEN / GEMINI_API_KEY / ADMIN_CHAT_ID
GitHub Actions: kept as a manual (workflow_dispatch) fallback, schedule removed
```

The run logic stays exactly as it is now. The scan for `last_seen`, the
`in_flight` and `sent_ahead` handling, the high-impact-first order, the
Telegram retry rules and the alerts are all ported unchanged. Only the shell
around them changes: scheduling, HTTP and state storage.

## The constraints that drive the design

| | Workers Free | Workers Paid ($5/mo minimum) |
|---|---|---|
| CPU time per Cron Trigger | **10 ms** | 30 s (interval < 1 h) |
| Wall-clock per Cron Trigger | 15 min | 15 min |
| Subrequests (`fetch`) per invocation | **50** | 10,000 |
| Cron Triggers per account | 5 | 250 |
| KV writes/day (free) | 1,000 | unlimited |
| KV writes to the same key | 1/s | 1/s |
| Durable Objects (SQLite) | yes: 100k req/day, 100k rows written/day | yes |

Source: developers.cloudflare.com, *Workers limits*, *KV limits* and
*Durable Objects pricing*, checked 2026-10-10. Check them again before
starting.

What this means for the bot:

- **CPU.** Network waits don't count, but parsing a 145 KB RSS feed, building
  messages and parsing JSON can come close to 10 ms. The CNN archive fallback
  is a 20 MB JSON file, which is impossible within 10 ms, so it must be dropped
  or moved to Paid.
- **Subrequests.** Every `sendMessage` is one subrequest. On the free plan a
  run can reach only about 45 chats (50, minus getUpdates, the RSS fetch,
  Gemini and alerts). A backlog, or more subscribers, needs Paid.
- **Overlap.** Cloudflare does not stop a slow run from overlapping the next
  minute's run. GitHub's concurrency group does this today, so on Cloudflare
  we need our own lock.

## State: KV or Durable Object?

The requested design was KV. It works, but it has a real risk.

**KV is eventually consistent.** A write can take 60 seconds or more to be
visible from another location, and Cloudflare says KV "is not ideal for
applications where you need support for atomic operations". With a cron every
minute, the next run can read the *old* `last_seen` and send the same posts
again. Two overlapping runs can also both read the state, both send, and then
overwrite each other's writes. That is exactly the duplicate-send class of
bugs this repo just fixed.

**Recommendation: a single Durable Object holds the state** (SQLite backend,
included in the free plan):

- It is strongly consistent and serialized, so every run reads the latest
  write.
- It also serves as the lock: a `lease` row with an expiry, so a second run
  that starts while the first is still sending exits immediately.
- Its free quota (100k rows written per day) is far above our needs, which
  are about 1,440 heartbeats plus a few writes per post each day.

If KV is still preferred, then:

1. Write the heartbeat at most every 5 minutes (as now). That is about 288
   writes a day, plus about 2 per post, which stays under 1,000 a day.
2. Put a lease key with a TTL in front of every run, and accept that the
   lease itself is eventually consistent. This is a best-effort lock only.
3. Keep the per-chat `in_flight` record. It limits a duplicate to the posts
   from at most the last ~60 seconds.

## Language

The worker can't simply run `src/main.py` as it is:

- **Python Workers** run on Pyodide. Blocking `urllib` sockets don't work
  there, so the HTTP layer would have to be rewritten with `fetch`, and support
  for scheduled handlers and cold-start CPU on the 10 ms free plan need to be
  checked first.
- **TypeScript** (recommended) is the first-class runtime and has the
  smallest cold start. Port the `src/main.py` logic module by module and keep
  the Python unit tests as the specification. Every Python test has a
  TypeScript twin, run under `vitest` with `@cloudflare/vitest-pool-workers`.

## Pros and cons

**Pros**
- About one minute of latency instead of 2.5–8 hours. 🔴 alerts become
  useful.
- The ⏰ stale-run alert becomes meaningful instead of firing on most runs.
- No PAT (`STATE_TOKEN`) anymore, and no 48 KB GitHub-variable ceiling.
- Optional: a Telegram **webhook** on the same Worker makes `/start`
  instant.
- Cost: $0 on Free with a few dozen subscribers, $5/month on Paid.

**Cons**
- A second platform to own: a Cloudflare account, `wrangler`, secrets in two
  places during the transition.
- A port to TypeScript (about 1,000 lines of logic) with a risk of
  behaviour drift. The shared test suite mitigates it.
- Free-plan limits (10 ms CPU, 50 subrequests) cap the subscriber count and
  rule out the CNN fallback, so realistically this needs Paid as the bot
  grows.
- Run logs move from public Actions logs to Cloudflare (private: good for
  privacy, but less transparent).
- With a webhook, `getUpdates` stops working, so the GitHub fallback must
  then skip update handling.

## Migration steps

1. **Prepare.** Create the Cloudflare account and a `wrangler` project
   (`worker/` in this repo) with the TypeScript template and a Durable Object
   binding `BOT_STATE`. Add `wrangler.toml` with `[triggers] crons =
   ["* * * * *"]`. Add `worker-tests` to CI.
2. **Port.** Port the pure functions first: feed parsing,
   `filter_new_posts`, `advance_cursor`, `send_order`, tag parsing, message
   building and splitting. Then port `telegram_call`, the Gemini call and the
   free chain. Port each Python test alongside its function.
3. **State backend.** A Durable Object class with `load()`, `save(state)`
   and `acquireLease(ttl)`. Store the same JSON document as `BOT_STATE`
   (`version: 1`), so state moves across unchanged.
4. **Secrets.** `wrangler secret put TELEGRAM_BOT_TOKEN`, `GEMINI_API_KEY`,
   `ADMIN_CHAT_ID`, `TELEGRAM_CHAT_ID`, and optionally `HEALTHCHECK_URL`.
   Never commit `.dev.vars`.
5. **Shadow run (about 2 days).** Deploy with `DRY_RUN=1`. The worker keeps
   its own copy of the state, sends nothing to subscribers, and sends a
   summary to `ADMIN_CHAT_ID` only ("would send post X to N chats"). Compare
   the summaries with what GitHub actually sent.
6. **Cutover.**
   1. Disable the GitHub workflow (`./BOT-CONTROLS.sh disable`) and wait for
      any running job to finish.
   2. Copy the current `BOT_STATE` value: `gh variable get BOT_STATE`.
   3. Write it into the Durable Object with a one-off authenticated admin
      endpoint, or with `wrangler` and a seed script.
   4. Turn off `DRY_RUN`. The next minute's run continues from the same
      `last_seen`, so nothing is duplicated or lost.
   5. Remove `schedule:` from `trump-check.yml` and keep `workflow_dispatch`
      for emergencies. Point the healthchecks.io period at 5 minutes.
7. **Optional: webhook.** Add a `fetch()` handler for Telegram updates
   (verify the `X-Telegram-Bot-Api-Secret-Token` header), then call
   `setWebhook`. Update handling becomes instant.
8. **Rollback.** Disable the cron trigger (`wrangler triggers` / remove it
   from `wrangler.toml` and deploy). Copy the state back with `gh variable
   set BOT_STATE` and re-enable the GitHub workflow. If a webhook was set,
   call `deleteWebhook`.

## Open questions

- Free or Paid? It depends on the expected subscriber count and on whether
  the CNN deep-scan fallback is worth $5 a month. With a cron every minute,
  backlogs stay small, so RSS alone is likely enough.
- Keep the public Actions logs as a transparency feature, or not?
