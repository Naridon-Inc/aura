//! The script that puts the wall up, and starts the work behind it.
//!
//! A file rather than a line, and delivered to the machine rather than typed
//! into it, because the alternative is a shell command containing a heredoc
//! containing an nftables ruleset, quoted twice — once for `sh -c` and once for
//! `ssh` — and every bug in that is silent and remote. As a file it is readable
//! on the machine it runs on, which is where somebody debugging it will be.
//!
//! It is written fresh every time an agent starts, from the signed spec, so an
//! edit to the copy on disk lasts exactly until the next run and is not
//! something the seal has to cover.
//!
//! ## The order, and why it is that order
//!
//! 1. **Refuse if this machine cannot hold it.** Fail-closed is the whole
//!    posture: a run that could not confine and carried on anyway is the one
//!    outcome nothing else here would catch.
//! 2. **Start the broker** — while the machine still has the network, and
//!    outside the wall, because it is the thing that will be reaching hosts on
//!    the work's behalf.
//! 3. **Point the work at it** with the proxy variables every agent CLI already
//!    reads.
//! 4. **Put the wall up and start the work inside it.** Only now, and never
//!    before the broker has a port, so there is no window in which the work is
//!    running and the list is not.

use crate::policy::Egress;
use crate::wall::{self, GROUP};

/// Where the guard, its journal and its profile live on the machine the work
/// runs on: the member's own home, not a shared temporary directory.
///
/// On a box with per-member accounts that is a different directory for every
/// member, which is the point — a run's journal names the hosts that run's agent
/// wanted, and that is nobody else's business.
pub const REL_DIR: &str = ".config/aura/egress";

/// Everything one confined run needs, as one file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Guard {
    run: String,
    command: String,
    egress: Egress,
}

impl Guard {
    /// `run` names this run — it becomes a filename and is written into the
    /// script, so it is refused rather than quoted if it is not a plain name.
    /// `command` is the work's own command line, already shell-quoted by
    /// whoever built it.
    pub fn new(run: &str, command: &str, egress: Egress) -> Result<Guard, String> {
        let run = run.trim();
        if !is_run_name(run) {
            return Err(format!("{run:?} isn't a name a run can be filed under."));
        }
        if command.trim().is_empty() {
            return Err("There is no command to run behind the wall.".into());
        }
        Ok(Guard {
            run: run.to_string(),
            command: command.to_string(),
            egress,
        })
    }

    pub fn run(&self) -> &str {
        &self.run
    }

    pub fn egress(&self) -> &Egress {
        &self.egress
    }

    /// The guard itself, relative to the home of whoever the work runs as.
    pub fn rel_path(&self) -> String {
        format!("{REL_DIR}/{}.sh", self.run)
    }

    /// The same path as a place spells it when delivering a file.
    pub fn home_path(&self) -> String {
        format!("~/{}", self.rel_path())
    }

    /// Where this run's refusals are written down.
    pub fn journal_home_path(&self) -> String {
        format!("~/{REL_DIR}/{}.jsonl", self.run)
    }

    /// The script.
    pub fn script(&self) -> String {
        let mut s = String::with_capacity(4096);
        s.push_str(HEADER);
        s.push_str("\nAURA_EGRESS_RUN=");
        s.push_str(&q(&self.run));
        s.push('\n');
        s.push_str("AURA_EGRESS_ALLOW=");
        s.push_str(&q(&self.egress.as_arg()));
        s.push('\n');
        s.push_str("AURA_EGRESS_CMD=");
        s.push_str(&q(&self.command));
        s.push('\n');
        s.push_str(SETUP);
        s.push_str(REFUSE);
        s.push_str(&choose_wall());
        s.push_str(BROKER);
        s.push_str(&run_behind_the_wall());
        s
    }
}

/// A run name is a filename and a shell word on somebody else's machine.
pub fn is_run_name(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        && !s.starts_with('.')
}

/// One shell word, whatever is in it.
///
/// The same rule as `cloudbox::script::quote` on the app side. Spelled again
/// here because this crate is the one that runs on the machine, and a crate that
/// generates a shell script cannot depend on the desktop app to quote it.
fn q(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

const HEADER: &str = r#"#!/bin/sh
# The agent phase of an Aura run.
#
# The setup phase ran before this file existed and had the whole network,
# because installing is what a network is for. This half does not: it can reach
# the machines this project declared in `[env.network]` of its signed spec, plus
# the agent's own model and the remote this checkout came from, and nothing
# else. What it tried and was refused is written down beside this file.
#
# Written by Aura from the signed spec every time an agent starts. Editing it
# changes one run and is not covered by the seal.
set -u
"#;

const SETUP: &str = r#"
AURA_EGRESS_DIR="$HOME/.config/aura/egress"
AURA_EGRESS_JOURNAL="$AURA_EGRESS_DIR/$AURA_EGRESS_RUN.jsonl"
AURA_EGRESS_PORT_FILE="$AURA_EGRESS_DIR/$AURA_EGRESS_RUN.port"
AURA_EGRESS_PROFILE="$AURA_EGRESS_DIR/$AURA_EGRESS_RUN.sb"
# Which build of Aura holds the list. The suite points this at the one it just
# compiled; a machine where Aura is not on PATH can point it at the binary.
AURA_EGRESS_BIN="${AURA_EGRESS_BIN:-aura}"
AURA_EGRESS_RC=0

umask 077
mkdir -p "$AURA_EGRESS_DIR" 2>/dev/null
chmod 0700 "$AURA_EGRESS_DIR" 2>/dev/null
# One run, one journal: what the last run wanted is not this run's report.
rm -f "$AURA_EGRESS_PORT_FILE" "$AURA_EGRESS_JOURNAL" 2>/dev/null
"#;

const REFUSE: &str = r#"
# Nothing starts unless the wall goes up. A run that could not confine and
# carried on anyway is the single outcome this file exists to prevent.
aura_egress_refuse() {
    printf '\n%s\n\n' 'Aura did not start the agent.' >&2
    printf '%s\n' "$1" >&2
    printf '\n%s\n' 'Installing is unaffected — the setup phase has the network. This is only about the agent phase.' >&2
    if [ -t 0 ]; then exec "${SHELL:-/bin/sh}" -l; fi
    exit 78
}

aura_egress_can_root() {
    [ "$(id -u)" = '0' ] || sudo -n true 2>/dev/null
}

aura_egress_root() {
    if [ "$(id -u)" = '0' ]; then "$@"; else sudo -n "$@"; fi
}
"#;

/// Which wall this machine can hold, decided on the machine.
///
/// Neither answer is knowable from the laptop that wrote the file — a box is
/// whatever somebody brought — so the choice is made here, once, and everything
/// after it is written in terms of `$aura_egress_wall`.
fn choose_wall() -> String {
    let missing = "This machine cannot hold the agent phase to an allowlist, so nothing was run. \
         macOS holds it with sandbox-exec, which is not on this machine. Linux holds it with \
         nftables and a Unix group, which needs `nft` and `sg` and either root or passwordless \
         sudo. Declare nftables in this project's environment spec so the setup phase installs \
         it, or start the agent on a machine that can hold it.";
    format!(
        r#"
aura_egress_wall=$({which})
[ -n "$aura_egress_wall" ] || aura_egress_refuse {missing}
"#,
        which = wall::WHICH,
        missing = q(missing)
    )
}

const BROKER: &str = r#"
command -v "$AURA_EGRESS_BIN" >/dev/null 2>&1 || aura_egress_refuse 'This machine has no `aura` on PATH, and the allowlist is held by `aura egress broker`. Install Aura here, or declare it in this project'"'"'s environment spec so the setup phase installs it.'

# Started before the wall and outside it: this is the process that reaches the
# allowed hosts on the work'"'"'s behalf, so it is the one thing that must not be
# confined.
"$AURA_EGRESS_BIN" egress broker \
    --allow "$AURA_EGRESS_ALLOW" \
    --journal "$AURA_EGRESS_JOURNAL" \
    --port-file "$AURA_EGRESS_PORT_FILE" &
AURA_EGRESS_BROKER=$!

aura_egress_cleanup() {
    if [ -n "${AURA_EGRESS_BROKER:-}" ]; then
        kill "$AURA_EGRESS_BROKER" 2>/dev/null
    fi
    # The journal stays: it is the report, and it is read after the run ends.
    rm -f "$AURA_EGRESS_PORT_FILE" 2>/dev/null
    return 0
}
trap aura_egress_cleanup EXIT INT TERM HUP

aura_egress_waited=0
while [ ! -s "$AURA_EGRESS_PORT_FILE" ]; do
    kill -0 "$AURA_EGRESS_BROKER" 2>/dev/null || break
    aura_egress_waited=$((aura_egress_waited + 1))
    if [ "$aura_egress_waited" -gt 100 ]; then break; fi
    sleep 0.1 2>/dev/null || sleep 1
done
[ -s "$AURA_EGRESS_PORT_FILE" ] || aura_egress_refuse 'The allowlist did not come up, so the agent was not started. `aura egress broker` failed to start on this machine — run it by hand to see what it says.'
AURA_EGRESS_PORT=$(cat "$AURA_EGRESS_PORT_FILE")

# The variables every agent CLI already reads. Anything that ignores them does
# not get out — it is refused by the wall rather than by the list, and says so
# in the journal.
AURA_EGRESS_PROXY="http://127.0.0.1:$AURA_EGRESS_PORT"
HTTP_PROXY="$AURA_EGRESS_PROXY"
HTTPS_PROXY="$AURA_EGRESS_PROXY"
ALL_PROXY="$AURA_EGRESS_PROXY"
http_proxy="$AURA_EGRESS_PROXY"
https_proxy="$AURA_EGRESS_PROXY"
all_proxy="$AURA_EGRESS_PROXY"
NO_PROXY='127.0.0.1,localhost'
no_proxy='127.0.0.1,localhost'
export HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy NO_PROXY no_proxy
"#;

/// The wall, and the work inside it.
///
/// The command is run rather than `exec`'d in both arms, which is deliberate:
/// `exec` would replace this shell and the broker it started would outlive the
/// run with nothing left to kill it.
fn run_behind_the_wall() -> String {
    let group_lost = "This machine has nftables but would not put the agent in its own group, \
         so nothing was run. `groupadd` and `usermod` need root here.";
    let rules_lost = "This machine would not install the egress rules, so nothing was run. \
         `nft -f -` failed — run it by hand to see what it says.";
    format!(
        r#"
if [ "$aura_egress_wall" = 'seatbelt' ]; then
    cat > "$AURA_EGRESS_PROFILE" <<'AURA_SEATBELT_PROFILE'
{profile}AURA_SEATBELT_PROFILE
    chmod 0600 "$AURA_EGRESS_PROFILE" 2>/dev/null
    sandbox-exec -f "$AURA_EGRESS_PROFILE" /bin/sh -c "$AURA_EGRESS_CMD"
    AURA_EGRESS_RC=$?
else
    aura_egress_root groupadd -f {group} 2>/dev/null || aura_egress_refuse {group_lost}
    AURA_EGRESS_GID=$(getent group {group} | cut -d: -f3)
    [ -n "$AURA_EGRESS_GID" ] || aura_egress_refuse {group_lost}
    aura_egress_root usermod -aG {group} "$(id -un)" 2>/dev/null
    # `sg` reads the group file, so a membership added a moment ago counts —
    # but if it did not land, `sg` would sit waiting for a group password with
    # nobody there to type one.
    if [ "$(id -u)" != '0' ] && ! getent group {group} | cut -d: -f4 | tr ',' '\n' | grep -qx "$(id -un)"; then
        aura_egress_refuse {group_lost}
    fi
    if ! aura_egress_root nft -f - <<AURA_NFT_RULES
{rules}AURA_NFT_RULES
    then
        aura_egress_refuse {rules_lost}
    fi
    sg {group} -c "$AURA_EGRESS_CMD"
    AURA_EGRESS_RC=$?
fi

aura_egress_cleanup
exit "$AURA_EGRESS_RC"
"#,
        profile = wall::seatbelt_profile(),
        rules = wall::nft_ruleset("$AURA_EGRESS_GID"),
        group = q(GROUP),
        group_lost = q(group_lost),
        rules_lost = q(rules_lost),
    )
}

#[cfg(test)]
mod tests;
