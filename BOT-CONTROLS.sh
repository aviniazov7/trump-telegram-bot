#!/usr/bin/env bash
# ============================================================================
# BOT-CONTROLS.sh — Manage the Trump Truth Social → Telegram Bot
# ============================================================================
# Usage: ./BOT-CONTROLS.sh <command>
#
# Commands:
#   status    — Show workflow status and last runs
#   run       — Trigger a manual run
#   enable    — Enable the scheduled workflow
#   disable   — Disable the scheduled workflow
#   logs      — View logs from the last run
#   help      — Show this help message
# ============================================================================

set -euo pipefail

REPO="trump-telegram-bot"
WORKFLOW="trump-check.yml"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

info()  { echo -e "${BLUE}ℹ️  $*${NC}"; }
ok()    { echo -e "${GREEN}✅ $*${NC}"; }
warn()  { echo -e "${YELLOW}⚠️  $*${NC}"; }
error() { echo -e "${RED}❌ $*${NC}"; }

# Check gh CLI is installed
check_gh() {
    if ! command -v gh &>/dev/null; then
        error "GitHub CLI (gh) is not installed."
        echo "  Install: https://cli.github.com/"
        exit 1
    fi
    if ! gh auth status &>/dev/null; then
        error "Not authenticated with GitHub CLI."
        echo "  Run: gh auth login"
        exit 1
    fi
}

cmd_status() {
    info "Workflow status for ${WORKFLOW}:"
    echo ""
    gh workflow list
    echo ""
    info "Last 5 runs:"
    gh run list --workflow="${WORKFLOW}" --limit=5
}

cmd_run() {
    info "Triggering manual run of ${WORKFLOW}..."
    gh workflow run "${WORKFLOW}"
    ok "Workflow triggered! Check status with: ./BOT-CONTROLS.sh status"
    echo ""
    info "Or view in browser:"
    gh browse --settings 2>/dev/null || true
    echo "  → Go to: Actions tab → ${WORKFLOW}"
}

cmd_enable() {
    info "Enabling workflow ${WORKFLOW}..."
    gh workflow enable "${WORKFLOW}"
    ok "Workflow enabled — cron schedule is active"
}

cmd_disable() {
    warn "Disabling workflow ${WORKFLOW}..."
    gh workflow disable "${WORKFLOW}"
    ok "Workflow disabled — cron schedule paused"
}

cmd_logs() {
    info "Fetching logs from the last run..."
    local run_id
    run_id=$(gh run list --workflow="${WORKFLOW}" --limit=1 --json databaseId --jq '.[0].databaseId')
    if [[ -z "$run_id" ]]; then
        warn "No runs found."
        return
    fi
    gh run view "$run_id" --log
}

cmd_help() {
    echo "============================================="
    echo " Trump Truth Social → Telegram Bot Controls"
    echo "============================================="
    echo ""
    echo "Usage: ./BOT-CONTROLS.sh <command>"
    echo ""
    echo "Commands:"
    echo "  status    Show workflow status and last runs"
    echo "  run       Trigger a manual run now"
    echo "  enable    Enable the scheduled workflow"
    echo "  disable   Disable the scheduled workflow"
    echo "  logs      View logs from the last run"
    echo "  help      Show this help message"
    echo ""
    echo "Examples:"
    echo "  ./BOT-CONTROLS.sh status"
    echo "  ./BOT-CONTROLS.sh run"
    echo ""
    echo "Manual trigger from GitHub web UI:"
    echo "  1. Go to your repo → Actions tab"
    echo "  2. Click 'Trump Truth Social Check'"
    echo "  3. Click 'Run workflow' → 'Run workflow'"
}

# Main
check_gh

case "${1:-help}" in
    status)  cmd_status ;;
    run)     cmd_run ;;
    enable)  cmd_enable ;;
    disable) cmd_disable ;;
    logs)    cmd_logs ;;
    help)    cmd_help ;;
    *)
        error "Unknown command: $1"
        cmd_help
        exit 1
        ;;
esac
