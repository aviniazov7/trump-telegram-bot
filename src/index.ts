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
import { openStore } from "./store";
import { handleWebhook } from "./webhook";
import { bindWorkersAi } from "./workers-ai";

export { Coordinator } from "./coordinator";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname.startsWith("/telegram/")) return handleWebhook(request, env);
    return new Response("Not found", { status: 404 });
  },

  async scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const cfg = loadConfig(env);
    if (!cfg.botToken) {
      console.error("TELEGRAM_BOT_TOKEN is not set — run `wrangler secret put TELEGRAM_BOT_TOKEN`");
      return;
    }
    const ctx = makeCtx(cfg, { ai: env.AI ? bindWorkersAi(env.AI) : undefined });
    ctx.log.info(`Run start${cfg.dryRun ? " [DRY RUN]" : ""}`);
    const outcome = await runCron(ctx, openStore(env));
    // A duplicate dispatch should not be retried; the run that holds the lease is doing the work.
    if (outcome === "busy") controller.noRetry();
    ctx.log.info(`Run end — ${ctx.budget.subrequestsUsed} subrequest(s)`);
  },
} satisfies ExportedHandler<Env>;
