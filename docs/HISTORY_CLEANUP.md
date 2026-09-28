# History cleanup: remove state files from git history

**Status: prepared, NOT run.** Run it only after the new state storage is live
(see the preconditions). It rewrites every commit hash in the repository.

## What it removes

Every runtime state file that was ever committed:

| Path | What it held |
|---|---|
| `data/subscribers.txt` | Subscribers' Telegram chat IDs (PII) |
| `data/last_seen.txt` | Last broadcast post ID |
| `data/last_update_id.txt` | Last processed Telegram update ID |
| `data/posts_log.txt` | Per-post log (removed feature, still in history) |
| `data/last_summary_date.txt` | Daily-summary date (removed feature, still in history) |

This is the full list: `git log --all --name-only` shows no other paths under
`data/`. Checked: the chat IDs appear nowhere outside `data/`, not in other
files and not in commit messages.

**Nothing else changes.** No commits are squashed or dropped. With
`--prune-empty never`, the ~753 "🔄 Update bot state" commits stay as empty
commits, so the log keeps its shape and its messages. Every commit hash still
changes, because the trees change.

> To also drop those now-empty bot commits, which leaves a much cleaner log,
> replace `--prune-empty never` with `--prune-empty auto`. Everything else stays
> the same.

## Preconditions

1. The PR that moves state to the `BOT_STATE` variable is merged.
2. `BOT_STATE` exists under *Settings → Secrets and variables → Actions →
   Variables*, and the last few scheduled runs are green.
3. The legacy files are no longer needed, because the bot reads only
   `BOT_STATE`. As a backup, you can copy the variable's value somewhere
   private first.
4. Tools: `git` ≥ 2.36 and `git-filter-repo` ≥ 2.47 (`pip install git-filter-repo`).
5. If `main` has branch protection, temporarily allow force pushes
   (*Settings → Branches → main → Allow force pushes*), then turn it back off
   afterwards.

## Commands

Run them in a new directory. Don't run them in your normal working clone.

```bash
# 1. Fresh bare clone (filter-repo refuses to run on a non-fresh clone)
git clone --bare https://github.com/aviniazov7/trump-telegram-bot.git trump-bot-cleanup.git
cd trump-bot-cleanup.git

# 2. Offline backup of the ORIGINAL history. It contains the PII, so keep it
#    private and delete it once you are satisfied.
git bundle create ../trump-bot-backup-before-cleanup.bundle --all

# 3. Rewrite. --sensitive-data-removal also fetches every other ref and records
#    the "first changed commits" that GitHub Support may ask for.
git filter-repo --sensitive-data-removal --invert-paths \
  --path data/subscribers.txt \
  --path data/last_seen.txt \
  --path data/last_update_id.txt \
  --path data/posts_log.txt \
  --path data/last_summary_date.txt \
  --prune-empty never --prune-degenerate never

# 4. Verify. Both commands must print "clean".
git log --all --format= --name-only | grep '^data/' || echo clean
git rev-list --all --objects | grep ' data/' || echo clean

# 5. Force-push all branches and tags
git push --force --all origin
git push --force --tags origin

# 6. Keep this for a GitHub Support request (step 3 below)
cat filter-repo/first-changed-commits
```

A dry run on a copy of the repository (792 commits) gave: 792/792 commits
rewritten, 792 commits still present, and 0 `data/` objects left.

## After pushing

1. **Re-clone everywhere.** Delete every old clone (laptop, Codespaces, other
   machines) and clone again. Pushing from an old clone would bring the files
   back.
2. **Other branches and PRs.** Step 5 rewrites all branches. Open PRs from old
   branches will show the rewritten commits. Merged PRs keep read-only
   `refs/pull/*` refs that you can't force-push.
3. **GitHub's cached copies.** Old commits stay reachable by SHA, and through
   `refs/pull/*`, until GitHub garbage-collects them. To purge them, open a
   request at <https://support.github.com/request>. Ask them to remove cached
   views and dereference the old commits for this repository, and include the
   first changed commit(s) from step 6.
4. **Forks.** Forks keep their own copy of the history. Check *Insights → Forks*.
5. **Old workflow logs.** Runs before the log-redaction change printed raw
   chat IDs, and in a public repo those logs are public (default retention is
   90 days). To delete the logs but keep the run records:

   ```bash
   gh run list -R aviniazov7/trump-telegram-bot --workflow trump-check.yml \
     --limit 5000 --json databaseId -q '.[].databaseId' |
   while read -r id; do
     gh api -X DELETE "repos/aviniazov7/trump-telegram-bot/actions/runs/$id/logs" >/dev/null && echo "deleted logs of $id"
   done
   ```

6. Turn branch protection's force-push setting off again. Also delete the
   backup bundle when you no longer need it.
