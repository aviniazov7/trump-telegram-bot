# Configuration

Secrets, plain vars, and the optional GitHub deploy. How the Worker behaves
with these values is in [operations.md](operations.md). The portfolio
overview is the [README](../README.md).

Nothing in this file is a secret. Namespace ids and model names are not
secrets. Tokens and keys are set only with `wrangler secret put`, or locally
in `.dev.vars` (gitignored). [`.dev.vars.example`](../.dev.vars.example)
lists placeholder names only.

## Secrets

Secrets are set with `npx wrangler secret put NAME`:

| Secret | Required | Meaning |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | yes | From @BotFather |
| `TELEGRAM_WEBHOOK_SECRET` | yes | 32+ chars of `A-Za-z0-9_-` (`openssl rand -hex 32`) |
| `GEMINI_API_KEY` | recommended | Primary translator + tags |
| `ADMIN_CHAT_ID` | recommended | Where alerts and dry-run previews go |
| `HEALTHCHECK_URL` | optional | Dead-man's switch ping |

Each `wrangler secret put` prompts for the value. Nothing lands in shell
history. Without a webhook secret of 32 or more characters, the webhook is
off.

## Vars

Vars live in [`wrangler.toml`](../wrangler.toml) under `[vars]`. The Default
column is what `loadConfig` uses when a var is unset. Anything except an
explicit `"false"` keeps `DRY_RUN` on.

The committed file is the live Worker: `DRY_RUN` is `"false"` (cut over on
2026-10-12). A fresh install should start at `"true"` so subscribers get
nothing until the dry run looks right. See [Setup](operations.md#setup) and
[Rollback](operations.md#rollback).

| Var | Default | Meaning |
|---|---|---|
| `DRY_RUN` | `"true"` | Previews to the admin only. Anything except `"false"` keeps it on |
| `GEMINI_MODEL` | `gemini-3.8-flash` | Primary translator. Check *AI Studio → Rate limits* for your free tier |
| `GEMINI_THINKING_LEVEL` | `low` | `minimal`/`low`/`medium`/`high`. Full (non-lite) models only |
| `GEMINI_FALLBACK_MODEL` | `gemini-3.5-flash-lite` | Asked in the same run when the primary fails or its free daily quota is used up. Also asked when a translation still contains Arabic script after one strict retry of the previous model. `""` disables it |
| `WORKERS_AI_MODEL` | `@cf/zai-org/glm-4.7-flash` | Workers AI fallback after Gemini fails. Free-plan multilingual model. `""` disables it |
| `GEMINI_TIMEOUT_SECONDS` | `12` | Per call |
| `GEMINI_RETRY_MINUTES` | `15` | How long a 429 or a 5xx is retried before the post goes out in English. An English echo does not wait this out: Gemini is not asked again, and Workers AI is tried once |
| `STALE_ALERT_MINUTES` | `35` | ⏰ threshold, measured from the last successful run |
| `SOURCE_FAILURE_ALERT_RUNS` | `10` | 📡 threshold |
| `ALERT_REPEAT_MINUTES` | `60` | Mute window per alert kind |
| `MAX_SCAN_POSTS` | `100` | How far back a run looks for `lastSeen` |
| `MAX_SUBREQUESTS` | `45` | Per run. Free plan: 50. Raise on Workers Paid |
| `RUN_TIME_BUDGET_SECONDS` | `90` | Stop starting new work after this (runs are 5 min apart) |

`GEMINI_RETRY_MINUTES` still defaults to 15. The retry rule is narrower than
"any failure": a model that already returned an English echo for that post
is not called again. Details are in
[When Gemini fails](operations.md#when-gemini-fails).

## Workers AI binding

Workers AI is a binding, not a secret. `wrangler.toml` sets:

```toml
[ai]
binding = "AI"
remote = true
```

`remote = true` is a local-dev flag: this binding has no local simulator.
Vitest sets `remoteBindings: false` and injects a fake client. The model id
is `WORKERS_AI_MODEL`. Reasoning is turned off in the call, and the
completion is capped, so a fallback stays inside the 10,000 neurons/day
included on the Workers Free plan. Paid-only models are not used. `""`
disables the fallback.

The cron is `*/5 * * * *`. The KV namespace binding is `STATE`. The Durable
Object binding is `COORDINATOR` (class `Coordinator`, SQLite-backed,
migration tag `v1`).

## Optional: deploy from GitHub

Add the repository secrets `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID`. Create the token from the *Edit Cloudflare Workers*
template, scoped to your account. Without the token, the workflow does
nothing.

With the token, every push to `main` that touches the Worker goes through
[`deploy.yml`](../.github/workflows/deploy.yml):

1. **check** (no approval): runs the tests and refuses a placeholder KV id.
2. **deploy** waits in the **`production` environment** until a required
   reviewer clicks **Review deployments → Approve and deploy** on the run.
   That environment is set up with `aviniazov7` as required reviewer and
   accepts only the `main` branch (*Settings → Environments → production*).
   Nothing reaches Cloudflare without that click.

The deploy workflow runs on pushes to `main` that touch `src/**`,
`wrangler.toml`, `package.json`, or `package-lock.json`, and on
`workflow_dispatch`. It uses Wrangler `4.141.0`.
