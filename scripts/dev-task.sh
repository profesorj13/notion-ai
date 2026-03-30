#!/usr/bin/env bash
# dev-task.sh — Autonomous development task executor
# Runs as user 'paperclip' on VPS
#
# Usage:
#   dev-task.sh --repo <git-url> --task "<description>" [--base main] [--task-id <id>] [--context "<extra>"]
#
# Output: JSON to stdout
#   {"status":"pr_created|needs_info|no_changes|error","message":"...","pr_url":"...","branch":"..."}

set -uo pipefail

# --- Config ---
REPOS_DIR="$HOME/repos"
WORKSPACES_DIR="$HOME/workspaces"
MAX_DEV_TURNS=50
LOG_DIR="$HOME/logs"

# --- Parse args ---
REPO_URL="" TASK_DESC="" BASE_BRANCH="main" TASK_ID="" EXTRA_CONTEXT=""
while [[ $# -gt 0 ]]; do
  case $1 in
    --repo)    REPO_URL="$2";      shift 2;;
    --task)    TASK_DESC="$2";     shift 2;;
    --base)    BASE_BRANCH="$2";   shift 2;;
    --task-id) TASK_ID="$2";       shift 2;;
    --context) EXTRA_CONTEXT="$2"; shift 2;;
    *) jq -nc --arg m "Unknown arg: $1" '{"status":"error","message":$m}'; exit 1;;
  esac
done

# --- Validate ---
if [[ -z "$REPO_URL" || -z "$TASK_DESC" ]]; then
  jq -nc '{"status":"error","message":"Missing required args: --repo and --task"}'
  exit 1
fi

# --- Helpers ---
REPO_NAME=$(basename "$REPO_URL" .git)
TS=$(date +%s)
TASK_SLUG=${TASK_ID:-$TS}
BRANCH_NAME="dev/${TASK_SLUG}"
WORKSPACE_DIR="$WORKSPACES_DIR/${REPO_NAME}-${TASK_SLUG}"
REPO_DIR="$REPOS_DIR/$REPO_NAME"

mkdir -p "$LOG_DIR"
LOGFILE="$LOG_DIR/dev-task-${TASK_SLUG}.log"

log() { echo "[$(date '+%H:%M:%S')] $*" >> "$LOGFILE"; echo "[dev-task] $*" >&2; }

json_out() {
  jq -nc \
    --arg status "$1" \
    --arg message "$2" \
    --arg pr_url "${3:-}" \
    --arg branch "${4:-}" \
    '{"status":$status,"message":$message,"pr_url":$pr_url,"branch":$branch}'
}

cleanup_worktree() {
  if [[ -d "$WORKSPACE_DIR" ]]; then
    log "Cleaning up worktree $WORKSPACE_DIR"
    git -C "$REPO_DIR" worktree remove "$WORKSPACE_DIR" --force 2>/dev/null || rm -rf "$WORKSPACE_DIR"
  fi
}

# ========================================
# Phase 1: TRIAGE (lightweight, no tools)
# ========================================
log "=== TRIAGE === repo=$REPO_NAME task_id=$TASK_SLUG"
log "Task: $TASK_DESC"

TRIAGE_PROMPT="You are a senior developer evaluating a task before starting work.

Task: ${TASK_DESC}
Repository: ${REPO_URL}
Base branch: ${BASE_BRANCH}
${EXTRA_CONTEXT:+Additional context: ${EXTRA_CONTEXT}}

Evaluate if you have enough information to START CODING. You need at minimum:
1. A clear description of WHAT to change (bug to fix, feature to add, etc.)
2. Which repository to work on (already provided above)

You do NOT need perfect info — you can explore the codebase yourself once you start.
Only flag as not-ready if the task is genuinely too ambiguous to begin.

Respond with ONLY a raw JSON object (no markdown, no backticks, no explanation):
If ready:     {\"ready\": true, \"plan\": \"brief 2-3 line plan\"}
If not ready:  {\"ready\": false, \"missing\": [\"specific question 1\", \"specific question 2\"]}"

TRIAGE_RAW=$(claude -p "$TRIAGE_PROMPT" --max-turns 1 2>>"$LOGFILE") || {
  log "Triage claude call failed"
  json_out "error" "Triage failed — Claude CLI error"
  exit 1
}

log "Triage response: $TRIAGE_RAW"

# Parse triage — extract JSON from response
TRIAGE_JSON=$(echo "$TRIAGE_RAW" | python3 -c "
import sys, json, re
text = sys.stdin.read().strip()
# Remove markdown backticks if present
text = re.sub(r'^```json?\s*', '', text)
text = re.sub(r'\s*```$', '', text)
match = re.search(r'\{.*\}', text, re.DOTALL)
if match:
    d = json.loads(match.group())
    json.dump(d, sys.stdout)
else:
    json.dump({'ready': True, 'plan': 'Could not parse triage, proceeding'}, sys.stdout)
" 2>/dev/null) || TRIAGE_JSON='{"ready":true,"plan":"Triage parse failed, proceeding"}'

READY=$(echo "$TRIAGE_JSON" | jq -r '.ready')

if [[ "$READY" == "false" ]]; then
  MISSING=$(echo "$TRIAGE_JSON" | jq -r '.missing // ["Info no especificada"] | join("; ")')
  log "TRIAGE: needs_info — $MISSING"
  json_out "needs_info" "$MISSING"
  exit 0
fi

PLAN=$(echo "$TRIAGE_JSON" | jq -r '.plan // "No plan provided"')
log "TRIAGE: ready — $PLAN"

# ========================================
# Phase 2: SETUP (clone + worktree)
# ========================================
log "=== SETUP ==="
mkdir -p "$REPOS_DIR" "$WORKSPACES_DIR"

if [[ ! -d "$REPO_DIR/.git" ]]; then
  log "Cloning $REPO_URL → $REPO_DIR"
  if ! git clone "$REPO_URL" "$REPO_DIR" 2>>"$LOGFILE"; then
    json_out "error" "Git clone failed — check repo URL and access"
    exit 1
  fi
else
  log "Updating existing clone"
  git -C "$REPO_DIR" fetch origin 2>>"$LOGFILE"
  git -C "$REPO_DIR" checkout "$BASE_BRANCH" 2>>"$LOGFILE" || true
  git -C "$REPO_DIR" pull origin "$BASE_BRANCH" 2>>"$LOGFILE" || true
fi

log "Creating worktree: $BRANCH_NAME → $WORKSPACE_DIR"
if ! git -C "$REPO_DIR" worktree add "$WORKSPACE_DIR" -b "$BRANCH_NAME" "origin/$BASE_BRANCH" 2>>"$LOGFILE"; then
  json_out "error" "Failed to create worktree (branch $BRANCH_NAME may already exist)"
  exit 1
fi

# ========================================
# Phase 3: DEV SESSION (Claude with tools)
# ========================================
log "=== DEV SESSION ==="
cd "$WORKSPACE_DIR"

DEV_PROMPT="You are a senior developer. Complete this task by modifying code in this repository.

TASK: ${TASK_DESC}
${EXTRA_CONTEXT:+CONTEXT: ${EXTRA_CONTEXT}}

PLAN from triage: ${PLAN}

INSTRUCTIONS:
1. Explore the codebase to understand the structure and relevant files
2. Make the necessary code changes — keep them minimal and focused
3. If tests exist and are relevant, run them to verify your changes
4. Do NOT run git commands (no commit, push, or PR) — just make code changes
5. Write clean, production-ready code"

log "Starting Claude dev session (max $MAX_DEV_TURNS turns)..."
if ! claude -p "$DEV_PROMPT" \
  --dangerously-skip-permissions \
  --max-turns "$MAX_DEV_TURNS" \
  >>"$LOGFILE" 2>&1; then
  log "Dev session failed"
  cleanup_worktree
  json_out "error" "Dev session failed — check logs at $LOGFILE"
  exit 1
fi
log "Dev session completed"

# ========================================
# Phase 4: SHIP (commit + push + PR)
# ========================================
log "=== SHIP ==="
cd "$WORKSPACE_DIR"

if [[ -z "$(git status --porcelain)" ]]; then
  log "No changes detected"
  cleanup_worktree
  json_out "no_changes" "Claude analyzed the code but made no changes"
  exit 0
fi

# Show what changed
CHANGES=$(git diff --stat)
log "Changes:\n$CHANGES"

# Commit
git add -A
COMMIT_MSG=$(printf '%s\n\nTask: %s\nTask ID: %s\n\nAutomated by AI Team dev-task' \
  "$(echo "$TASK_DESC" | head -c 70)" "$TASK_DESC" "$TASK_ID")
git commit -m "$COMMIT_MSG" 2>>"$LOGFILE"
log "Committed"

# Push
if ! git push -u origin "$BRANCH_NAME" 2>>"$LOGFILE"; then
  log "Push failed"
  cleanup_worktree
  json_out "error" "Git push failed — check access/permissions"
  exit 1
fi
log "Pushed to $BRANCH_NAME"

# Create PR
PR_BODY=$(printf '## Task\n%s\n\n%s\n\n## Changes\n```\n%s\n```\n\n---\n*Automated by AI Team dev-task | Task ID: %s*' \
  "$TASK_DESC" \
  "${EXTRA_CONTEXT:+**Context:** $EXTRA_CONTEXT}" \
  "$CHANGES" \
  "${TASK_ID:-n/a}")

PR_URL=$(gh pr create \
  --repo "$REPO_URL" \
  --title "$(echo "$TASK_DESC" | head -c 70)" \
  --body "$PR_BODY" \
  --base "$BASE_BRANCH" \
  --head "$BRANCH_NAME" 2>>"$LOGFILE") || {
  log "PR creation failed (branch pushed: $BRANCH_NAME)"
  cleanup_worktree
  json_out "error" "PR creation failed but branch $BRANCH_NAME was pushed"
  exit 1
}

log "PR created: $PR_URL"
cleanup_worktree
json_out "pr_created" "PR created" "$PR_URL" "$BRANCH_NAME"
