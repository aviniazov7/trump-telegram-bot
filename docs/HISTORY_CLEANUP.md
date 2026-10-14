# History cleanup: remove bot state from git history

**Status: not run.** This is a step-by-step guide for the repository owner.
Nothing here has been run against GitHub.

**Update 2026-10-13:** `trump-check.yml`, `legacy/`, and `BOT-CONTROLS.sh` have
been removed. Steps below that pause or re-enable that workflow are historical.
The live bot is the Cloudflare Worker cron; pausing it means deploying with
`crons = []`.

## Audit: what is exposed right now (2026-10-10)

A read-only mirror clone of `github.com/aviniazov7/trump-telegram-bot`
(every branch, tag and `refs/pull/*`) gave the following results:

| Where | State files in history | Chat IDs |
|---|---|---|
| `main` + the 4 `claude/*` branches | **none** (no `data/` path in any commit) | none |
| `refs/pull/1/head` … `refs/pull/4/head` | `data/last_seen.txt`, `data/last_update_id.txt` | none: post IDs and Telegram update counters only |
| `data/subscribers.txt` | **not present in any ref** | — |
| Other files, all revisions | — | only placeholders in old README examples (`123456789`, `-100…`) and fake IDs in tests |
| Actions run logs | — | **4 runs** created before 2026-09-28 (before commit `4bb1c02`, which redacts chat IDs). Their logs may show raw chat IDs and are public |
| Forks | — | 0 |

So the branches have already been rewritten. The ~792-commit history with
`data/subscribers.txt` is no longer reachable from any branch, and a
`git filter-repo` run against GitHub today changes **only** `refs/pull/1-4`.
A dry run on a throwaway mirror confirmed this: those four refs changed, and
every branch hash stayed identical. GitHub does not let anyone push to
`refs/pull/*`. A force-push therefore achieves nothing here.

What is still left to do:

1. Delete the logs of the 4 old workflow runs (step 2).
2. Ask GitHub Support to purge the old, now-unreachable commits and the
   `refs/pull/1-4` refs (step 3). GitHub keeps serving unreachable commits to
   anyone who knows their SHA until it garbage-collects them.
3. Make sure no old clone pushes the old history back (step 4).

The full `git filter-repo` procedure is still documented (step 5), in case the
audit in step 1 finds state files on a branch again.

## Step 1: re-run the audit

Run this before anything else, because the situation may have changed since
2026-10-10. It only reads from GitHub.

```bash
cd "$(mktemp -d)"
git clone --mirror https://github.com/aviniazov7/trump-telegram-bot.git audit.git
cd audit.git

# 1a. Which refs carry data/ history? Expected: only refs/pull/1..4/head
for r in $(git for-each-ref --format='%(refname)'); do
  n=$(git log --format= --name-only "$r" -- data/ | grep -c '^data/')
  [ "$n" -gt 0 ] && echo "$r: $n data/ changes"
done

# 1b. Was a subscribers file ever committed in any reachable ref? Expected: nothing
git log --all --format= --name-only | sort -u | grep -i subscriber

# 1c. Search every revision for your real chat IDs. Take them from BOT_STATE
#     (Settings → Secrets and variables → Actions → Variables) and put one per
#     line in a file OUTSIDE the repo, e.g. ~/chat_ids.txt. Expected: nothing.
git rev-list --all | while read c; do git grep -F -f ~/chat_ids.txt "$c" -- ; done
```

- If **1a lists any `refs/heads/*` or `refs/tags/*`**, or **1c finds
  anything on a branch**, do step 5 (rewrite), then steps 2–4.
- If the output matches the expected results, skip step 5 and do steps 2–4.

Delete `~/chat_ids.txt` when you're done.

## Step 2: delete the old workflow-run logs

These runs predate the log redaction, so their logs can contain raw chat IDs.
Deleting the logs keeps the run records (status, timing) and removes only the
output.

```bash
REPO=aviniazov7/trump-telegram-bot

# List the runs first: expect 4, all created before 2026-09-28T19:18:48Z
gh run list -R "$REPO" --limit 1000 --json databaseId,createdAt,workflowName \
  -q '.[] | select(.createdAt < "2026-09-28T19:18:48Z") | "\(.databaseId) \(.createdAt) \(.workflowName)"'

# Delete their logs
gh run list -R "$REPO" --limit 1000 --json databaseId,createdAt \
  -q '.[] | select(.createdAt < "2026-09-28T19:18:48Z") | .databaseId' |
while read -r id; do
  gh api -X DELETE "repos/$REPO/actions/runs/$id/logs" >/dev/null && echo "deleted logs of run $id"
done
```

To remove the runs completely instead, use
`gh api -X DELETE "repos/$REPO/actions/runs/$id"`.

## Step 3: ask GitHub Support to purge cached history

Open <https://support.github.com/request> → *Remove sensitive data*. Paste:

> Repository: aviniazov7/trump-telegram-bot (public).
> Earlier commits in this repository contained `data/subscribers.txt` with
> users' Telegram chat IDs. The branches have been rewritten and no longer
> reference those commits. Please:
> 1. run garbage collection and dereference all unreachable commits, and
>    remove any cached views of them;
> 2. remove the read-only refs `refs/pull/1/head` through `refs/pull/4/head`.
>    They still point at old history containing `data/` state files, and we
>    can't update them ourselves.
>
> First changed commit from `git filter-repo --sensitive-data-removal`:
> `c402e57dd84c47f2b054dd2ad5220d0aa95161ba`.

That SHA comes from the dry run. If you run step 5, use the value from your own
`filter-repo/first-changed-commits` file instead.

Closing the PRs does not remove `refs/pull/*`. Only Support can.

## Step 4: old clones

Any clone made before the rewrite still holds the old history. One `git push`
from it puts the chat IDs back on GitHub.

```bash
# In every clone you have (laptop, Codespaces, other machines):
git rev-list --all | wc -l      # the rewritten history has ~50 commits; ~800 means old
git log --all --format= --name-only | grep -c '^data/subscribers.txt'   # must print 0
```

Delete any clone that fails either check and clone again. Don't push from it.

## Step 5 (only if step 1 found state files on a branch): rewrite with git filter-repo

These are the exact commands, checked in a dry run on a throwaway mirror
(`git-filter-repo` a40bce548d2c, `git` 2.54). Nothing was pushed.

### Preconditions

1. Merge or close every open PR, and push every branch you want to keep.
   Branches left out of the rewrite keep the old history.
2. Copy the `BOT_STATE` variable value somewhere private as a backup. The bot
   reads only `BOT_STATE`, never `data/`.
3. Install the tools: `brew install git-filter-repo` (or `pipx install
   git-filter-repo`). You need `git` ≥ 2.36 and `git-filter-repo` ≥ 2.47, which
   added `--sensitive-data-removal`.
4. If `main` is protected: *Settings → Branches → main → Allow force pushes*
   (turn it off again in step 5.6).
5. Pause the bot so it doesn't run during the rewrite:
   `./BOT-CONTROLS.sh disable`.

### Commands

Run them in a new, empty directory, not in your working clone.

```bash
# 5.1 Fresh mirror clone (filter-repo refuses a non-fresh clone)
git clone --mirror https://github.com/aviniazov7/trump-telegram-bot.git cleanup.git
cd cleanup.git

# 5.2 Private offline backup of the ORIGINAL history. It contains the chat
#     IDs: keep it off GitHub/Dropbox/iCloud and delete it when you're done.
git bundle create ../trump-bot-backup-before-cleanup.bundle --all

# 5.3 Rewrite. --sensitive-data-removal fetches every ref first and writes
#     filter-repo/first-changed-commits for GitHub Support. It keeps the
#     'origin' remote.
git filter-repo --sensitive-data-removal --invert-paths \
  --path data/subscribers.txt \
  --path data/last_seen.txt \
  --path data/last_update_id.txt \
  --path data/posts_log.txt \
  --path data/last_summary_date.txt \
  --prune-empty never --prune-degenerate never

# 5.4 Verify. Both commands must print "clean".
git log --all --format= --name-only | grep '^data/' || echo clean
git rev-list --all --objects | grep ' data/' || echo clean
cat filter-repo/changed-refs            # which refs were rewritten

# 5.5 Push branches and tags only. A --mirror push would also try
#     refs/pull/*, which GitHub rejects.
git push --force origin 'refs/heads/*:refs/heads/*'
git push --force origin 'refs/tags/*:refs/tags/*'

# 5.6 Keep this for GitHub Support (step 3)
cat filter-repo/first-changed-commits
```

`--prune-empty never` keeps commits that only touched `data/` (the old
"🔄 Update bot state" commits) as empty commits, so the log keeps its shape.
To drop them instead, use `--prune-empty auto`.

### Afterwards

1. Turn off *Allow force pushes* again, and re-enable the bot:
   `./BOT-CONTROLS.sh enable`.
2. Do steps 2, 3 and 4.
3. After Support confirms, delete the backup bundle.

## Preventing a repeat

- `data/` is in `.gitignore`, and the workflow has `contents: read`, so it
  can't commit state anymore.
- State lived in the `BOT_STATE` repository variable, which only
  collaborators can see. The live Worker stores state in KV; see
  [State in KV](operations.md#state-in-kv).
- Logs show chat IDs only as keyed hashes (`chat#3a1f76687d`), and a test
  (`LogRedactionTests`) fails if a raw ID reaches the logs.
