#!/usr/bin/env bash
#
# aura-runner/aws/floor.sh — bring a fresh Linux box up to the floor a place is
# asked about.
#
# `Capabilities` (aura-shell's `manager::brain::place_contract`) reads four
# things off a machine: which agent CLIs are there, git, tmux, and aura. This
# script is what puts them there, and it is ONE script because there are two
# ways to come by a machine and they must not answer that question differently.
# A box somebody built by hand runs it from bootstrap.sh. A box Aura made runs
# the same text as its first-boot user data — `provisioner::managed::floor`
# embeds this file rather than restating it. Written twice, the two would agree
# until the first fix, and then a managed place would quietly hold less than a
# hand-built one with nobody able to see why.
#
# ## What is deliberately not here
#
# The toolchain. No rust version, no project dependencies, and no node beyond
# the one it takes to install an agent CLI at all. Those belong to the project,
# are declared in its own checkout (`.aura/settings.toml`), sealed
# (`.aura/env.lock.json`) and committed — so they are reviewed, attributable and
# visible from the repo. A version pinned in a boot script is a version nobody
# reviews and nobody can find. The last step below is what applies the declared
# one, through `aura env apply`, which is the same code the desktop runs against
# a box somebody brought.
#
# ## Inputs, all optional, all from the environment
#
#   AURA_FLOOR_USER      the login the work runs as                (default ubuntu)
#   AURA_FLOOR_AGENTS    space-separated agent CLI names           (default claude)
#   AURA_FLOOR_SWAP_GB   swap to lay down, in gigabytes            (default 8)
#   AURA_FLOOR_SRC       an Aura source tree holding aura-cli/     (default none)
#   AURA_FLOOR_PROJECT   absolute path the project is kept at      (default none)
#
# Idempotent by construction: every step asks before it acts, so a second run
# costs a few seconds and changes nothing. That is not tidiness — a managed box
# sleeps and wakes, and a boot script that reinstalled the world each time would
# turn a ninety-second wake into a coffee break.
set -euo pipefail

AURA_FLOOR_USER="${AURA_FLOOR_USER:-ubuntu}"
AURA_FLOOR_AGENTS="${AURA_FLOOR_AGENTS:-claude}"
AURA_FLOOR_SWAP_GB="${AURA_FLOOR_SWAP_GB:-8}"
AURA_FLOOR_SRC="${AURA_FLOOR_SRC:-}"
AURA_FLOOR_PROJECT="${AURA_FLOOR_PROJECT:-}"

log()  { printf '\n\033[36m=== %s ===\033[0m\n' "$*"; }
warn() { printf '\033[33m!!! %s\033[0m\n' "$*" >&2; }

# How this run becomes root, resolved once rather than assumed on every line.
#
# The two callers arrive differently: cloud-init runs first-boot user data AS
# root, and bootstrap.sh runs as the box's own login with sudo. A minimal image
# may not have sudo installed at all, so "root already" has to be a real case
# rather than a fallback nobody exercises.
if [ "$(id -u)" -eq 0 ]; then
  as_root() { "$@"; }
elif command -v sudo >/dev/null 2>&1; then
  as_root() { sudo "$@"; }
else
  echo "floor: run this as root, or as a login that can sudo" >&2
  exit 1
fi

log "swap — ${AURA_FLOOR_SWAP_GB}G"
# A box with no swap does not slow down under memory pressure, it stops, and the
# cloud goes on reporting it as running — which is the worst shape a failure can
# take, because every surface above says the place is fine.
if ! as_root swapon --show | grep -q '/swapfile'; then
  as_root fallocate -l "${AURA_FLOOR_SWAP_GB}G" /swapfile
  as_root chmod 600 /swapfile
  as_root mkswap /swapfile
  as_root swapon /swapfile
  echo '/swapfile none swap sw 0 0' | as_root tee -a /etc/fstab >/dev/null
fi

# git and tmux are two of the four things a place is asked whether it has, and
# tmux is the one that decides whether anything here outlives its connection.
# The rest are what it takes to build anything at all: a declared spec that
# installs a crate on a box with no compiler fails at the last step, having
# already spent the minutes.
FLOOR_PACKAGES="build-essential pkg-config libssl-dev git tmux curl jq unzip ca-certificates"
FLOOR_MISSING=""
for pkg in $FLOOR_PACKAGES; do
  dpkg -s "$pkg" >/dev/null 2>&1 || FLOOR_MISSING="$FLOOR_MISSING $pkg"
done
if [ -n "$FLOOR_MISSING" ]; then
  log "apt packages:$FLOOR_MISSING"
  as_root apt-get update -y
  # shellcheck disable=SC2086 — the list is ours and is space-separated on purpose.
  as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y $FLOOR_MISSING
fi

# Node is here for exactly one reason: the agent CLIs are npm packages. It is
# therefore the floor's own dependency rather than the project's toolchain, and
# a project that needs a different node says so in its declared spec, which runs
# after this and wins.
if ! command -v node >/dev/null 2>&1; then
  log "node"
  curl -fsSL https://deb.nodesource.com/setup_20.x | as_root bash -
  as_root apt-get install -y nodejs
fi

# The agent CLIs, machine-wide and on purpose.
#
# `place_toolchain` is emphatic that a MEMBER's `npm install -g` must land in
# their own home, because on a shared box a machine-wide one is everybody's.
# This is the other case it names: the machine's own tooling, installed once, by
# the machine, before anybody has an account here. A member who wants a
# different version still gets one — `place_toolbox` fetches it into their home
# and their prefix comes first on their PATH.
#
# The package for each name is the same table the app holds in
# `place_toolbox::AGENT_PACKAGES`, and the two are pinned against each other by
# a test rather than by memory: an agent the picker offers and this script has
# never heard of is a place that answers `capabilities()` with less than the
# picker shows.
for agent in $AURA_FLOOR_AGENTS; do
  if command -v "$agent" >/dev/null 2>&1; then
    continue
  fi
  case "$agent" in
    claude) package="@anthropic-ai/claude-code" ;;
    codex)  package="@openai/codex" ;;
    gemini) package="@google/gemini-cli" ;;
    *)      warn "no package known for the agent CLI '$agent' — install it yourself"; continue ;;
  esac
  log "agent CLI: $agent ($package)"
  as_root npm install -g "$package"
done

if command -v aura >/dev/null 2>&1; then
  log "aura is already here"
elif [ -n "$AURA_FLOOR_SRC" ] && [ -d "$AURA_FLOOR_SRC/aura-cli" ]; then
  # A box that was handed the dev tree builds it, because that tree carries
  # `runner serve` and the published mirror does not yet.
  log "build aura from $AURA_FLOOR_SRC/aura-cli"
  if [ ! -x "$HOME/.cargo/bin/cargo" ] && ! command -v cargo >/dev/null 2>&1; then
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable
  fi
  # shellcheck disable=SC1091
  . "$HOME/.cargo/env" 2>/dev/null || true
  (
    cd "$AURA_FLOOR_SRC/aura-cli"
    # 2 jobs keeps peak RAM under the 8 GB + swap ceiling; fall back to 1 on OOM.
    CARGO_BUILD_JOBS=2 CARGO_PROFILE_RELEASE_DEBUG=0 cargo build --release ||
      CARGO_BUILD_JOBS=1 CARGO_PROFILE_RELEASE_DEBUG=0 cargo build --release
    as_root install -m 0755 target/release/aura /usr/local/bin/aura
  )
else
  # No source tree, and nothing here to fetch one WITH. A box Aura made carries
  # no credential in its boot script — the metadata service would read one back
  # to every process on the machine — so the only route left is the published
  # build, which is exactly what a person with a fresh box would install.
  log "install aura from the published build"
  curl -fsSL https://auravcs.com/install.sh | as_root env AURA_INSTALL_DIR=/usr/local/bin bash
fi
command -v aura >/dev/null 2>&1 || {
  echo "floor: aura is not on this machine and could not be installed" >&2
  exit 1
}

# NO person is baked into this machine. A box does work for a MEMBER, and the
# member's own name and email are written per place, repo-local, by the place
# seam (`manager::brain::place_author`) before anything is committed.
#
# `useConfigOnly` is what turns that requirement into an enforcement: with no
# identity set, git REFUSES to commit rather than inventing one from the login
# and the hostname. A loud failure at the moment nobody said who this is beats a
# commit on GitHub with the wrong name on it forever.
as_root git config --system user.useConfigOnly true

if [ -n "$AURA_FLOOR_PROJECT" ]; then
  # Owned by the login that will work in it — a directory root owns is a
  # directory every later write fails in.
  as_root install -d -m 0755 -o "$AURA_FLOOR_USER" -g "$AURA_FLOOR_USER" "$AURA_FLOOR_PROJECT"
fi

# The toolchain, from the one place it is versioned and reviewable.
#
# Everything above is the floor — what a place is ASKED whether it has. What the
# work actually needs is the project's business, and `aura env apply` is the
# same implementation the desktop drives over ssh against a box somebody
# brought. Running it here is what makes a machine Aura made converge on the
# declared environment by the same route, rather than by a second recipe that
# would have to be kept in step by hand.
#
# Skipped rather than failed when there is no checkout yet: a machine can be
# made before anybody has put a project on it, and a spec that is not there is
# not a spec that failed. A spec that IS there and does not apply is a warning
# rather than a dead boot — the box is usable, the gap is reported by the drift
# report the moment anyone looks at it, and a machine that refused to finish
# booting over a missing package would be a machine nobody can log in to fix.
if [ -n "$AURA_FLOOR_PROJECT" ] && [ -f "$AURA_FLOOR_PROJECT/.aura/settings.toml" ]; then
  log "apply the environment $AURA_FLOOR_PROJECT declares"
  if [ "$(id -un)" = "$AURA_FLOOR_USER" ]; then
    (cd "$AURA_FLOOR_PROJECT" && aura env apply) ||
      warn "the environment $AURA_FLOOR_PROJECT declares did not fully apply — 'aura env show' says what is short"
  else
    as_root su -l "$AURA_FLOOR_USER" -c "cd \"$AURA_FLOOR_PROJECT\" && aura env apply" ||
      warn "the environment $AURA_FLOOR_PROJECT declares did not fully apply — 'aura env show' says what is short"
  fi
fi

log "floor complete — git, tmux, aura and the agent CLIs are on this machine"
