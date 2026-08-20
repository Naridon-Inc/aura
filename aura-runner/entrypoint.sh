#!/usr/bin/env bash
#
# Aura Runner — headless crew loop (AURA-87, part of AURA-86)
#
# Runs Aura's autonomous Crew loop on a detached box so work continues while the
# local machine is off. The loop layer is identical whether this runs on your own
# box, AWS Fargate, or a machine0 VM — only the surrounding deploy differs.
#
# This entrypoint does the container-level bootstrap (clone the repo, set git
# identity, install Aura capture hooks) and then hands the supervise loop to the
# `aura runner serve` command, which owns one cycle:
#
#   1. crew sync --pull-only    — pull peers'/laptop's task-graph over git
#   2. crew cloud-sync --pull   — pull work initiated from mobile/console/an agent
#   3. crew run --max 0         — drain the ready set: claim, dispatch, verify, commit
#   4. crew cloud-sync --push   — report finished tasks back to the cloud board
#   5. crew sync --push-only    — commit + push the task-graph and the agent's commits
#   6. heartbeat + sleep, repeat
#
# Two delivery planes, both covered: the GIT plane (`crew sync`) carries tasks
# between machines over your remote; the CLOUD plane (`crew cloud-sync`) carries
# work initiated from anywhere with no git client — this is what lets you start a
# job from the phone after closing the laptop. If AURA_RUNNER_TOKEN is set, the
# runner also registers its liveness so it shows online in the app.
#
# Secrets (agent API key, git credentials, AURA_RUNNER_TOKEN) are injected at
# runtime via env — never baked into the image. See AURA-89 and runner.env.example.

set -euo pipefail

log() { printf '%s [aura-runner] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
die() { log "FATAL: $*"; exit 1; }

# ---- config (env, with sane defaults) ---------------------------------------
REPO_URL="${AURA_RUNNER_REPO:-}"                 # required: git URL to clone/run
WORKDIR="${AURA_RUNNER_WORKDIR:-/workspace}"     # where the repo lives
BRANCH="${AURA_RUNNER_BRANCH:-}"                 # optional: branch to track (default: remote HEAD)
AGENT="${AURA_RUNNER_AGENT:-claude}"            # agent CLI the loop dispatches
LEASE_SECS="${AURA_RUNNER_LEASE_SECS:-1800}"     # crash-recovery lease window
POLL_SECS="${AURA_RUNNER_POLL_SECS:-30}"         # idle wait between drain cycles
NAME="${AURA_RUNNER_NAME:-}"                     # optional display name for logs/registry
GIT_NAME="${AURA_RUNNER_GIT_NAME:-Aura Runner}"
GIT_EMAIL="${AURA_RUNNER_GIT_EMAIL:-runner@auravcs.com}"
# AURA_RUNNER_TOKEN (optional): RunnerAuth token from `aura runner register`.
# Present -> the box registers + heartbeats so it shows online in the app.
# Consumed directly by `aura runner serve` from the environment.

[ -n "$REPO_URL" ] || die "AURA_RUNNER_REPO is required (git URL to run the crew on)."
command -v aura >/dev/null 2>&1 || die "'aura' not on PATH — build from aura-runner/Dockerfile."
command -v git  >/dev/null 2>&1 || die "'git' not on PATH."
if ! command -v "$AGENT" >/dev/null 2>&1; then
  log "WARNING: agent '$AGENT' not on PATH — the loop will fail to dispatch until it (and its key) are present."
fi

# ---- clone or refresh the repo ----------------------------------------------
REPO_DIR="$WORKDIR/repo"
if [ ! -d "$REPO_DIR/.git" ]; then
  log "cloning $REPO_URL -> $REPO_DIR"
  mkdir -p "$WORKDIR"
  git clone "$REPO_URL" "$REPO_DIR"
fi
cd "$REPO_DIR"
git config user.name  "$GIT_NAME"
git config user.email "$GIT_EMAIL"
[ -n "$BRANCH" ] && { log "checking out $BRANCH"; git checkout "$BRANCH"; }

# ---- install Aura hooks (idempotent) ----------------------------------------
log "ensuring Aura capture is enabled (aura enable)"
aura enable || log "WARNING: 'aura enable' returned non-zero — continuing"

if [ -n "${AURA_RUNNER_TOKEN:-}" ]; then
  log "AURA_RUNNER_TOKEN present — runner will register + heartbeat to the cloud."
else
  log "no AURA_RUNNER_TOKEN — running unregistered (won't show in the app). Mint one with 'aura runner register'."
fi

# ---- hand off to the supervise loop -----------------------------------------
# `aura runner serve` owns the cycle (both delivery planes + heartbeat). `exec`
# lets stop signals reach it directly: Ctrl-C finishes the current cycle, and a
# container SIGTERM that races a task is safe — the task's lease expires and the
# next cycle reclaims it.
SERVE_ARGS=(runner serve
  --agent "$AGENT"
  --lease-secs "$LEASE_SECS"
  --poll-secs "$POLL_SECS"
  --git-sync)
[ -n "$NAME" ] && SERVE_ARGS+=(--name "$NAME")

log "runner up. repo=$REPO_DIR branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo HEAD) agent=$AGENT poll=${POLL_SECS}s"
exec aura "${SERVE_ARGS[@]}"
