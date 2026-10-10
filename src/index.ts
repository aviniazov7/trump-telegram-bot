import type { Env } from "./env";

export default {
  async fetch(_request: Request, _env: Env): Promise<Response> {
    return new Response("Not found", { status: 404 });
  },

  async scheduled(_controller: ScheduledController, _env: Env, _ctx: ExecutionContext): Promise<void> {},
} satisfies ExportedHandler<Env>;
