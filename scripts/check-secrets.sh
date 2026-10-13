#!/usr/bin/env bash
# Fail if anything that looks like a secret or a real Telegram chat ID is about
# to be committed. The repository is public: anything committed is published.
#
#   bash scripts/check-secrets.sh            # scan staged changes (pre-commit)
#   bash scripts/check-secrets.sh --all      # scan every tracked file (CI)
#
# Optional: list your real chat IDs (one per line) in a file OUTSIDE the repo,
# e.g. ~/.config/trump-bot/chat_ids.txt, or point CHAT_IDS_FILE at it. Any
# exact match is then reported too.
#
# Enable as a git hook once:  git config core.hooksPath .githooks

set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

mode="${1:---staged}"
chat_ids_file="${CHAT_IDS_FILE:-$HOME/.config/trump-bot/chat_ids.txt}"

# Generated or vendored files that can't hold our secrets.
skip='^(package-lock\.json|node_modules/|\.wrangler/|coverage/)'

if [[ "$mode" == "--all" ]]; then
  files=$(git ls-files | grep -Ev "$skip" || true)
  content() { cat -- "$1"; }
else
  files=$(git diff --cached --name-only --diff-filter=ACMR | grep -Ev "$skip" || true)
  # Only lines being added; existing content was checked when it was added.
  content() { git diff --cached -U0 -- "$1" | grep -E '^\+' | grep -Ev '^\+\+\+' || true; }
fi

fail=0
report() {
  echo "✗ $1: $2" >&2
  fail=1
}

# Files that must never be committed at all.
for f in $files; do
  case "$f" in
    .dev.vars.example) ;;
    .dev.vars|.dev.vars.*|.env|.env.*|*.env) report "$f" "local secrets file" ;;
  esac
done

patterns=(
  'Telegram bot token|[0-9]{8,10}:AA[A-Za-z0-9_-]{33}'
  'Google API key|AIza[0-9A-Za-z_-]{35}'
  'GitHub token|(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})'
  'Cloudflare API token assignment|CLOUDFLARE_API_TOKEN[[:space:]]*[=:][[:space:]]*["'"'"']?[A-Za-z0-9_-]{40}'
  'Private key|-----BEGIN [A-Z ]*PRIVATE KEY-----'
  'Webhook secret assignment|TELEGRAM_WEBHOOK_SECRET[[:space:]]*[=:][[:space:]]*["'"'"']?[A-Fa-f0-9]{32,}'
)

for f in $files; do
  [[ -f "$f" ]] || continue
  text=$(content "$f")
  [[ -n "$text" ]] || continue
  for entry in "${patterns[@]}"; do
    name="${entry%%|*}"
    regex="${entry#*|}"
    if grep -Eq -- "$regex" <<<"$text"; then
      report "$f" "$name"
    fi
  done
  # Supergroup/channel chat IDs (-100 + 10 digits). Tests use obviously fake
  # ones, and docs use placeholders, so only code and config are checked.
  case "$f" in
    test/*|*.md) ;;
    *) grep -Eq -- '-100[0-9]{10}' <<<"$text" && report "$f" "Telegram group/channel chat ID" ;;
  esac
  if [[ -s "$chat_ids_file" ]] && grep -Fqx -f <(grep -Eo -- '-?[0-9]+' "$chat_ids_file") <(grep -Eo -- '-?[0-9]{5,}' <<<"$text"); then
    report "$f" "one of your real chat IDs (from $chat_ids_file)"
  fi
done

if (( fail )); then
  echo "Secret scan failed — remove the value(s) above before committing." >&2
  exit 1
fi
echo "✓ secret scan clean (${mode#--})"
