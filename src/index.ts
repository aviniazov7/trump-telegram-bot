/**
 * Cloudflare Worker entry point.
 *   scheduled()  every 5 minutes: fetch, translate, tag and deliver new posts
 *   fetch()      POST /telegram/<path>: Telegram webhook (see webhook.ts);
 *                everything else is 404
 */
import { runCron } from "./broadcast";
import { loadConfig } from "./config";
import type { Env } from "./env";
import { makeCtx } from "./runtime";
import { Store } from "./store";
import { handleWebhook } from "./webhook";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname.startsWith("/telegram/")) return handleWebhook(request, env);
    return new Response("Not found", { status: 404 });
  },

  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const cfg = loadConfig(env);
    if (!cfg.botToken) {
      console.error("TELEGRAM_BOT_TOKEN is not set — run `wrangler secret put TELEGRAM_BOT_TOKEN`");
      return;
    }
    const ctx = makeCtx(cfg);
    ctx.log.info(`Run start${cfg.dryRun ? " [DRY RUN]" : ""}`);
    await runCron(ctx, new Store(env.STATE));
    ctx.log.info(`Run end — ${ctx.budget.subrequestsUsed} subrequest(s)`);
  },
} satisfies ExportedHandler<Env>;
