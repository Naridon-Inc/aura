#!/usr/bin/env bash
#
# aura-runner/aws/bootstrap.sh — runs ON the runner box (Ubuntu 24.04 arm64).
#
# provision.sh rsyncs the Aura source to $SRC_DIR and the target repo's git
# credential onto the box, then runs this. It brings the box to the floor
# (floor.sh), clones the repo the runner will drain, and lays down the systemd
# unit. It does NOT start the service — provision.sh writes the secret env files
# and starts it once, so a half-set-up box never begins spending tokens.
#
# The floor — swap, apt packages, node, the agent CLI, the `aura` binary and the
# no-anonymous-commits guard — is NOT written here. It lives in floor.sh, which
# is also what a box Aura provisions runs as its first-boot user data. Two
# copies of those steps would agree until the first fix, and then a managed
# place would quietly hold less than this one with nobody able to see why.
#
# Idempotent: safe to re-run (the floor skips what is present; so does the clone).
set -euo pipefail

AGENT="${AGENT:-claude}"
SRC_DIR="${SRC_DIR:-/opt/aura-src}"
REPO_SLUG="${REPO_SLUG:?REPO_SLUG=owner/name is required}"
BRANCH="${BRANCH:-}"
FLOOR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/floor.sh"

log() { printf '\n\033[36m=== %s ===\033[0m\n' "$*"; }

log "the floor: git, tmux, aura and the $AGENT CLI"
# 12G rather than the floor's default 8: this box also builds the aura-sovereign
# Rust workspace per task, and rustc is what finds the ceiling first.
#
# $SRC_DIR is handed over because this box HAS the dev tree — so `aura` is built
# from it rather than fetched, which is the difference that matters here: the
# published mirror doesn't carry `runner serve` yet.
AURA_FLOOR_AGENTS="$AGENT" \
AURA_FLOOR_SWAP_GB="${SWAP_GB:-12}" \
AURA_FLOOR_SRC="$SRC_DIR" \
  bash "$FLOOR"

# shellcheck disable=SC1091
source "$HOME/.cargo/env" 2>/dev/null || true
/usr/local/bin/aura --version

log "clone the repo the runner will drain: $REPO_SLUG"
sudo mkdir -p /opt/aura-runner
sudo chown "$USER":"$USER" /opt/aura-runner
if [ ! -d /opt/aura-runner/repo/.git ]; then
  git clone "https://github.com/${REPO_SLUG}.git" /opt/aura-runner/repo
fi
cd /opt/aura-runner/repo
if [ -n "$BRANCH" ]; then git checkout "$BRANCH" || true; fi
# NO person is baked into this clone. A runner drains work for a MEMBER, and the
# member's own name and email are written repo-local, per place, by the place
# seam (`manager::brain::place_author`) before anything is committed.
#
# This used to be `Aura Runner <runner@auravcs.com>`, and that was worse than
# leaving it unset: it is well-formed, it never errors, and every commit the box
# ever made carried it — so the audit trail lost the person while looking
# completely healthy.
#
# `useConfigOnly` is what turns the requirement into an enforcement. With no
# identity set, git REFUSES to commit rather than inventing `ubuntu@ip-172-31-…`
# from the login and the hostname. A loud failure at the moment nobody said who
# this is beats a commit on GitHub with the wrong name on it forever.
git config user.useConfigOnly true
git config --unset user.name  || true
git config --unset user.email || true
# Install Aura capture hooks so the agent's commits carry intent/provenance.
/usr/local/bin/aura enable || echo "warning: 'aura enable' returned non-zero — continuing"

# The floor again, now that there is a checkout to read a spec out of.
#
# The first call could not do this — the clone had not happened — and the second
# is nearly free, because every step in it asks before it acts. What it buys is
# the one step that matters here: the box converges on the environment the
# project DECLARES, from the same `aura env apply` a box Aura made runs on its
# first boot, rather than on a list of versions somebody pinned in this file
# where nobody reviewing the repo would ever see them.
AURA_FLOOR_AGENTS="$AGENT" \
AURA_FLOOR_SWAP_GB="${SWAP_GB:-12}" \
AURA_FLOOR_SRC="$SRC_DIR" \
AURA_FLOOR_USER="$USER" \
AURA_FLOOR_PROJECT=/opt/aura-runner/repo \
  bash "$FLOOR"

log "systemd unit"
sudo mkdir -p /etc/aura-runner
sudo cp "$SRC_DIR/aura-runner/aws/aura-runner.service" /etc/systemd/system/aura-runner.service
sudo systemctl daemon-reload
sudo systemctl enable aura-runner >/dev/null 2>&1 || true

log "bootstrap complete — provision.sh will write the env files and start the service"
