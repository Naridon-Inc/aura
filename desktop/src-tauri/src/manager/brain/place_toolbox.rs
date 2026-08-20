//! Installing something for just me, without root.
//!
//! The escape hatch that makes the declared spec tolerable. [`super::place_env`]
//! is the right way to put a tool on a machine — declare it in
//! `.aura/settings.toml`, sign it, and every place converges on it — and it is
//! the right way precisely because it is deliberate: a commit, a review, a
//! bumped `[env] version`, and the tool arrives for everybody with a reason
//! attached.
//!
//! That deliberateness is also the reason people route around it. Nobody amends
//! a signed, committed, team-wide spec to try `hyperfine` for an hour. What they
//! do instead is `sudo npm install -g`, which on a shared box is one member
//! changing everybody's machine — and the person it breaks is never the person
//! who ran it. **A spec you must amend for a one-hour experiment is a spec people
//! route around**, so the honest fix is not to make the spec harder to avoid. It
//! is to make the hour-long experiment land somewhere it cannot hurt anyone.
//!
//! ## What "for just me" is made of
//!
//! Nothing here invents a private directory. [`super::place_toolchain`] already
//! decided where a member's tooling lives and already wrote it into their login
//! profile, so this reads [`SCOPED`] rather than keeping a second opinion about
//! where `cargo install` should write. What this file adds is the other half of
//! that list: the per-invocation knobs for the managers that need one — `pip`'s
//! `--user` behaviour, `go`'s `GOBIN`, `gem`'s prefix, `bun` and `pnpm`'s global
//! directories — all pointed at the same `~/.local` the profile block already
//! puts on the member's `PATH`.
//!
//! That is the whole mechanism, and it is why nothing here runs `sudo`. An
//! install that lands under `$HOME` needs no privilege, and a privilege this
//! never asks for is a privilege it cannot misuse. [`no_sudo_anywhere_in_it`]
//! pins that as a property of the rendered script rather than as an intention.
//!
//! ## The managers this refuses, and why refusing is the feature
//!
//! `apt`, `dnf`, `apk` and `brew` install for the machine. There is no per-member
//! spelling of `apt-get install`, and the useful answer to "install postgres for
//! just me" is not to run it with `sudo` and hope — it is to say that this one
//! belongs to the box's own bootstrap or to the project's declared spec, both of
//! which are somebody's deliberate decision. [`Refused::Machine`] carries that
//! sentence. The four per-member managers Aura already knows how to drive
//! (`npm`, `pnpm`, `bun`, `cargo`, plus `pip`, `go` and `gem`) go through
//! unchanged.
//!
//! ## Why the commands themselves are not written here
//!
//! `aura_env::managers` already knows how to ask each manager whether something
//! is present and how to install it, because the declared spec needs exactly
//! that. A second table would be a second opinion about what `cargo install`
//! looks like, and the two would agree until the first fix. So the check and the
//! install come from there verbatim, and "for just me" is entirely a property of
//! the *environment they run in*. That is also what makes this work for a manager
//! nobody has thought about yet: an entry that brings its own `check`/`install`
//! is per-member for free, because the prefix it writes into is already the
//! member's.
//!
//! ## Both place-modes, one script
//!
//! [`Place::install_for_me`] renders one POSIX `sh` script and hands it to
//! [`Place::ask`], which already knows whether "here" is this disk or a machine
//! at the end of a multiplexed connection. A laptop with one member installs
//! into that member's home; a shared box with six installs into six. The script
//! does not know the difference and there is nothing for the two modes to drift
//! on.

use serde::{Deserialize, Serialize};

use aura_env::managers::package_commands;
use aura_env::spec::Package;

use super::place::Place;
use super::place_toolchain::SCOPED;
use crate::cloudbox::script::{is_bin_name, quote};

/// Marks the start of the machine-readable report. Split in the rendered script
/// with `""`, because a line that contains its own marker matches itself.
const REPORT: &str = "___AURA_TOOLBOX___";

/// The prefix a per-member install writes into, relative to the member's home.
///
/// Not a fresh opinion — it is the row [`super::place_toolchain::SCOPED`] holds
/// for `pip`, which is also the row that puts `~/.local/bin` on the member's
/// `PATH`. Named here so the managers that take a prefix rather than a
/// dedicated variable have somewhere to point that the member can actually run
/// things out of afterwards.
const OWN_PREFIX: &str = ".local";

/// Managers that install for the machine, and what to do instead.
///
/// Not a blocklist to be worked around: these genuinely have no per-member
/// spelling. `apt-get install` writes `/usr`, and no environment variable makes
/// that somebody's own. Saying so, and naming the two surfaces that *are* meant
/// to change a shared machine, is a better answer than a `sudo` that succeeds
/// and quietly redecorates a box six people are working on.
const MACHINE_WIDE: [(&str, &str); 6] = [
    ("apt", "apt"),
    ("apt-get", "apt"),
    ("dnf", "dnf"),
    ("yum", "dnf"),
    ("apk", "apk"),
    ("brew", "brew"),
];

/// What a member asked to have, for themselves.
#[derive(Debug, Clone, PartialEq)]
pub struct Ask {
    /// The tool, in the same words `.aura/settings.toml` would use — so a member
    /// who decides the experiment worked can paste the entry into the spec and
    /// have it mean the same thing for everybody.
    pub package: Package,
    /// The binary it leaves behind, when that is not the package's own name.
    /// `@anthropic-ai/claude-code` leaves `claude`, and a report that looked for
    /// a binary called `@anthropic-ai/claude-code` would say a good install
    /// failed.
    pub bin: Option<String>,
    /// The login this must be running as. `Some` refuses rather than installs
    /// when the session turns out to be somebody else — writing into another
    /// member's home is the one thing "install for just me" must never mean,
    /// even when the session has the privilege to do it.
    pub login: Option<String>,
}

impl Ask {
    /// One tool, from a manager, optionally pinned.
    pub fn tool(manager: &str, name: &str, version: Option<&str>) -> Ask {
        Ask {
            package: Package {
                manager: manager.trim().to_string(),
                name: name.trim().to_string(),
                version: version
                    .map(str::trim)
                    .filter(|v| !v.is_empty())
                    .map(str::to_string),
                // A tool a member installs to use is global within their own
                // prefix by definition: it is not a dependency of the checkout
                // they happen to be standing in.
                global: true,
                check: None,
                install: None,
            },
            bin: None,
            login: None,
        }
    }

    /// The binary to look for once it is installed.
    pub fn binary(&self) -> &str {
        match self.bin.as_deref().map(str::trim).filter(|b| !b.is_empty()) {
            Some(b) => b,
            None => self.package.name.trim(),
        }
    }
}

/// Why a place would not install something for one member.
///
/// Four cases rather than a string because they are four different next steps,
/// and a caller that can only print them is still a caller that has to choose
/// what to offer.
#[derive(Debug, Clone, PartialEq)]
pub enum Refused {
    /// The manager installs for the whole machine.
    Machine { manager: String },
    /// Aura has never heard of the manager and the ask did not spell out both
    /// halves.
    Unknown { detail: String },
    /// The manager is one we know, but nothing said how to obtain this entry —
    /// a spec that pinned a version without saying where it comes from.
    NoInstall { name: String },
    /// There is no home directory to install into.
    Homeless { home: String },
}

impl std::fmt::Display for Refused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Refused::Machine { manager } => write!(
                f,
                "`{manager}` installs for the whole machine, so there is no version of this that \
                 is only yours. Put it in the project's `.aura/settings.toml` so everybody here \
                 gets it deliberately, or ask whoever administers this place to add it to the \
                 box's own setup."
            ),
            Refused::Unknown { detail } => write!(f, "{detail}"),
            Refused::NoInstall { name } => write!(
                f,
                "nothing says how to obtain {name}, so there is no command to run for you. Give \
                 it its own `check` and `install` and Aura will run them in your own prefix."
            ),
            Refused::Homeless { home } => write!(
                f,
                "there is no home directory to install into here{}. An install for just you needs \
                 somewhere that is just yours.",
                if home.trim().is_empty() {
                    String::new()
                } else {
                    format!(" ({})", home.trim())
                }
            ),
        }
    }
}

/// Where each per-member install actually lands, for a member whose home is
/// `home`.
///
/// Two halves, and keeping them apart is the point. The first comes from
/// [`SCOPED`] verbatim — the variables [`super::place_toolchain`] already wrote
/// into this member's profile, so an install and their own login shell agree
/// about where `cargo install` writes. The second is the per-invocation knobs
/// those five rows do not cover: managers that take a prefix rather than a
/// dedicated state directory, all pointed at the one `~/.local` whose `bin` is
/// already on their `PATH`.
///
/// `home` may be an absolute path or the literal `$HOME`, which is what a
/// command running inside the member's own session wants — the values are
/// rendered into double quotes, so `$HOME` stays a `$HOME` for the far shell to
/// expand and cannot be one member's home baked into another member's session.
pub fn install_env(home: &str) -> Vec<(&'static str, String)> {
    let home = home.trim().trim_end_matches('/');
    let under = |rest: &str| format!("{home}/{rest}");
    let own = under(OWN_PREFIX);

    let mut env: Vec<(&'static str, String)> = SCOPED
        .iter()
        .map(|s| (s.var, s.path_under(home)))
        .collect();

    // `pip install` obeys `--user` without being told, once this is set. Spelled
    // as an environment variable rather than by rewriting the command, because
    // the command is `aura_env::managers`' and a second spelling of it is the
    // thing this file exists not to have.
    env.push(("PIP_USER", "1".to_string()));
    // `go install` puts the binary here rather than in `$GOPATH/bin`, which is
    // not on the member's PATH.
    env.push(("GOBIN", format!("{own}/bin")));
    // `gem install` writes binstubs into `$GEM_HOME/bin`, so pointing GEM_HOME
    // at the prefix itself lands them beside everything else.
    env.push(("GEM_HOME", own.clone()));
    env.push(("GEM_PATH", own.clone()));
    // `bun add -g` writes `$BUN_INSTALL/bin`; `pnpm add -g` writes `$PNPM_HOME`.
    env.push(("BUN_INSTALL", own.clone()));
    env.push(("PNPM_HOME", format!("{own}/bin")));
    env
}

/// Every directory [`install_env`] names that has to exist before a manager
/// writes into it.
///
/// npm falls back to `/usr/local` when the prefix it is handed does not exist,
/// which turns a per-member install into a machine-wide one that then fails for
/// want of root — the exact collision this is here to stop, arriving as a
/// permissions error nobody reads as "your prefix is missing".
pub fn install_dirs(home: &str) -> Vec<String> {
    let home = home.trim().trim_end_matches('/');
    let mut dirs: Vec<String> = SCOPED.iter().map(|s| s.path_under(home)).collect();
    dirs.push(format!("{home}/{OWN_PREFIX}/bin"));
    dirs
}

/// The `PATH` a per-member install runs with, and the one its result is found
/// on afterwards.
///
/// The member's own directories first, and that order is the whole feature: a
/// `PATH` where the machine-wide copy shadows the one somebody just installed
/// for themselves makes "install it for just me" a command that changes where a
/// file is written without changing which one runs.
pub fn install_path(home: &str) -> String {
    let home = home.trim().trim_end_matches('/');
    let mut bins: Vec<String> = SCOPED
        .iter()
        .filter_map(|s| s.bin_under(home))
        .collect();
    // Everything `install_env` points at the shared prefix ends up here too.
    let own = format!("{home}/{OWN_PREFIX}/bin");
    if !bins.contains(&own) {
        bins.push(own);
    }
    format!("{}:$PATH", bins.join(":"))
}

/// [`install_env`] as one line of POSIX `sh`, for a command rather than a
/// profile.
///
/// Double quotes, so a `$HOME` written by the caller is expanded by the shell
/// that runs it. Everything inside them is a path this file built out of a home
/// and a fixed suffix, never a value a member typed.
pub fn exports(home: &str) -> String {
    let mut out = String::new();
    for (var, value) in install_env(home) {
        out.push_str(&format!("{var}=\"{value}\"; export {var}; "));
    }
    out.push_str(&format!("PATH=\"{}\"; export PATH; ", install_path(home)));
    out
}

/// The check and the install for one ask, in a shape that lands in one member's
/// own home.
///
/// The commands are [`aura_env::managers`]' own. All this does is refuse the
/// managers that cannot be one person's, and say which of the two halves was
/// missing when one was.
pub fn commands(ask: &Ask) -> Result<(String, String), Refused> {
    let p = &ask.package;
    let spelled_out = p.check.is_some() && p.install.is_some();
    if !spelled_out {
        if let Some((_, family)) = MACHINE_WIDE
            .iter()
            .find(|(m, _)| m.eq_ignore_ascii_case(p.manager.trim()))
        {
            return Err(Refused::Machine {
                manager: (*family).to_string(),
            });
        }
    }
    let derived = package_commands(p).map_err(|e| Refused::Unknown {
        detail: e.to_string(),
    })?;
    let install = derived.apply.ok_or_else(|| Refused::NoInstall {
        name: p.name.clone(),
    })?;
    // A check is optional in the general case — an entry may describe a state
    // nobody can cheaply ask about — and `false` is the honest stand-in: it
    // means "assume it isn't here", which costs an install that may be a no-op
    // rather than skipping one that was needed.
    let check = derived.check.unwrap_or_else(|| "false".to_string());
    Ok((check, install))
}

/// The script that installs one tool for one member, and reports what really
/// happened.
///
/// Idempotent in the sense that matters: run against a member who already has
/// the tool, it is how they *verify* the thing they installed is still theirs,
/// not a second attempt at installing it.
///
/// POSIX `sh`, not bash — the same script runs under `ssh` on a distro whose
/// `/bin/sh` is dash and under `sh -c` on this laptop.
pub fn install_script(home: &str, ask: &Ask) -> Result<String, Refused> {
    let home_dir = home.trim().trim_end_matches('/');
    if home_dir.is_empty() || !home_dir.starts_with('/') {
        return Err(Refused::Homeless {
            home: home.to_string(),
        });
    }
    let (check, install) = commands(ask)?;
    let expect = ask
        .login
        .as_deref()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .unwrap_or_default();

    Ok(format!(
        r#"set -u
EXPECT={expect}
HOME_DIR={home_q}
ME=$(id -un)

# Whose install this is, settled before anything is written. A session that is
# somebody else may well have the privilege to write into this home; using it
# would make "install for just me" mean "install into a colleague's account",
# which is the one thing it must never mean.
if [ -n "$EXPECT" ] && [ "$ME" != "$EXPECT" ]; then
  echo "this session is $ME, not $EXPECT, so an install here would land in somebody else's home. Connect as $EXPECT and try again." >&2
  exit 5
fi
[ -d "$HOME_DIR" ] || {{ echo "$HOME_DIR is not a directory on this machine, so there is nowhere of your own to install into." >&2; exit 6; }}

# Everything below is the member's own and nobody else's to read. The account's
# profile carries the same umask for its login shells; a command arriving over
# ssh reads no profile, so it has to be said here too.
umask 077
mkdir -p {dirs} 2>/dev/null || true

# Where this lands: `place_toolchain`'s own list, plus the per-invocation knobs
# for the managers that take a prefix. `HOME` is set with them because a manager
# that reads `~/.npmrc` must read THIS member's.
HOME="$HOME_DIR"; export HOME
{exports}
STATE=already
if {check} >/dev/null 2>&1; then
  :
else
  if {install} >&2; then
    STATE=installed
  else
    echo "the install did not finish. Nothing outside your own home was touched." >&2
    exit 7
  fi
fi

# Where the binary actually is, asked of the same PATH the member's own login
# shell will use. Empty means it installed and cannot be run, which is a
# different problem from not installing and has to be reported as one.
WHERE=$(command -v {bin} 2>/dev/null || true)

echo "___AURA""_TOOLBOX___"
echo "login=$ME"
echo "home=$HOME_DIR"
echo "state=$STATE"
echo "where=$WHERE"
"#,
        expect = quote(expect),
        home_q = quote(home_dir),
        dirs = install_dirs(home_dir)
            .iter()
            .map(|d| quote(d))
            .collect::<Vec<_>>()
            .join(" "),
        exports = exports(home_dir),
        bin = quote(ask.binary()),
    ))
}

/// What a place did about one member's install.
///
/// Every field is what the machine said rather than what was asked for. `at` is
/// where the binary is *now*, read off the member's own `PATH`; [`Installed::mine`]
/// is that path judged against their home, which is the acceptance criterion of
/// this whole feature expressed as something a surface can render rather than as
/// a claim in a commit message.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Installed {
    /// The login the install actually ran as.
    pub login: String,
    /// Their home, as the box spells it.
    pub home: String,
    /// The binary that was asked for.
    pub tool: String,
    /// `installed` — this call put it there; `already` — it was theirs before.
    pub state: String,
    /// Where the binary is now, on the member's own `PATH`. Empty when it isn't
    /// on one.
    pub at: String,
    /// Is `at` inside this member's own home?
    ///
    /// The claim, checked rather than asserted: false means the thing that ran
    /// afterwards was somebody else's copy, and a surface that reported success
    /// on that would be reporting the opposite of what happened.
    pub mine: bool,
}

impl Installed {
    /// Did this call change anything?
    pub fn changed(&self) -> bool {
        self.state == "installed"
    }
}

/// Read the report back.
///
/// Everything before the marker is the box's own noise — a MOTD, a sudo lecture,
/// whatever npm printed — and is dropped rather than parsed around.
pub fn parse_install(out: &str) -> Result<Installed, String> {
    let body = out
        .split_once(REPORT)
        .map(|(_, rest)| rest)
        .ok_or("the machine did not say what it installed")?;
    let f = |k: &str| -> String {
        body.lines()
            .filter_map(|l| l.trim().split_once('='))
            .find(|(key, _)| *key == k)
            .map(|(_, v)| v.trim().to_string())
            .unwrap_or_default()
    };
    let login = f("login");
    if login.is_empty() {
        return Err("the machine did not say who it installed for".into());
    }
    let home = f("home");
    let at = f("where");
    Ok(Installed {
        mine: is_under(&at, &home),
        tool: f("tool"),
        state: match f("state").as_str() {
            "installed" => "installed".into(),
            _ => "already".into(),
        },
        at,
        home,
        login,
    })
}

/// Is this path inside that home?
///
/// A prefix test with the separator insisted upon, so `/home/mo` does not
/// swallow `/home/mo2` — the same trap [`super::place_toolchain::scope_of`]
/// avoids, for the same reason, and worth spelling out in both: a path that
/// merely starts the same belongs to somebody else.
fn is_under(path: &str, home: &str) -> bool {
    let path = path.trim();
    let home = home.trim().trim_end_matches('/');
    !path.is_empty() && !home.is_empty() && path.starts_with(&format!("{home}/"))
}

/// The agent CLIs Aura can fetch for a member, and the package each one is.
///
/// Short on purpose, and it is a table rather than a guess for a reason worth
/// keeping: an agent whose name is not here gets a sentence and a shell, exactly
/// as it always did. Turning `command -v foo` into `npm install -g foo` for
/// anything a caller happened to name would be Aura installing a stranger's
/// package off the internet because a session was opened with a typo in it.
pub const AGENT_PACKAGES: [(&str, &str); 3] = [
    ("claude", "@anthropic-ai/claude-code"),
    ("codex", "@openai/codex"),
    ("gemini", "@google/gemini-cli"),
];

/// The agent CLIs a machine can be brought up holding, by binary name.
///
/// The same table, read from the other end. [`agent_ask`] answers "put this one
/// in a member's home, now, because a session asked for it"; this answers "which
/// ones should be on a machine before anybody has asked for anything", which is
/// what a provisioner needs and is the only difference between a place Aura made
/// and one somebody built by hand as far as `Capabilities` is concerned.
///
/// Derived rather than restated so the two cannot disagree. An agent added to
/// the table above arrives on every newly made machine without anybody
/// remembering to add it twice — which is exactly the drift a fresh box would
/// otherwise show up with, and only ever in one place-mode.
pub fn installable_agent_bins() -> Vec<String> {
    AGENT_PACKAGES.iter().map(|(bin, _)| bin.to_string()).collect()
}

/// The ask that would put this agent CLI in a member's own home, if Aura knows
/// which package it is.
pub fn agent_ask(bin: &str) -> Option<Ask> {
    let bin = bin.trim();
    if !is_bin_name(bin) {
        return None;
    }
    let (_, package) = AGENT_PACKAGES.iter().find(|(b, _)| *b == bin)?;
    let mut ask = Ask::tool("npm", package, None);
    ask.bin = Some(bin.to_string());
    Some(ask)
}

/// The one-liner a session runs when the agent it was opened for isn't there.
///
/// This is what replaces "install it here and start it again". That sentence was
/// honest and it was also a dead end: the member is sitting in front of the
/// machine, the install is one command, and the reason they were told to type it
/// themselves was that nothing knew how to run it without root. Now something
/// does, so the session fetches the agent into the member's own home and starts
/// it — and on a shared box the teammate in the next tmux window is not affected
/// by any of it.
///
/// `$HOME`-relative rather than taking a home directory, deliberately: this runs
/// *inside* the member's own session, where `$HOME` is already theirs. A home
/// path resolved on this laptop and pasted into a session would be this laptop's
/// idea of who is sitting there.
///
/// Announced rather than silent, and on stderr so it cannot be mistaken for the
/// agent's own first words. Software arriving on somebody's machine without a
/// line saying so is how people stop trusting a tool.
pub fn fetch_line(bin: &str) -> Option<String> {
    let ask = agent_ask(bin)?;
    let (_, install) = commands(&ask).ok()?;
    Some(format!(
        "{{ echo {saying}; {exports}{install}; }} >&2 2>&1",
        saying = quote(&format!(
            "{bin} isn't on this machine yet — fetching it into your own home. Nobody else here is changed by this.",
        )),
        exports = exports("$HOME"),
    ))
}

/// What both place-modes put in front of "the agent isn't here yet".
///
/// One function because two surfaces need it — a detached session in
/// [`crate::cloudbox::script`] and an interactive terminal in
/// [`super::place_open`] — and the governing rule of this whole programme is
/// that no feature lands in one place-mode only. Spelled twice, a box would
/// fetch what a laptop told you to install by hand within a release.
///
/// Empty for an agent Aura does not know the package for, and that empty string
/// is why the sentence after it is still in both files: the fetch is an *extra*
/// chance, not a replacement for the honest answer when there is nothing to run.
/// The same is true when the fetch itself fails — the check after it is the one
/// that decides, so a machine with no npm still lands on a shell and a sentence
/// rather than on a stack trace.
pub fn fetch_if_missing(bin: &str) -> String {
    match fetch_line(bin) {
        Some(line) => format!(
            "command -v {b} >/dev/null 2>&1 || {{ {line}; }}; ",
            b = quote(bin)
        ),
        None => String::new(),
    }
}

impl Place {
    /// Install one tool for one member, into a home that is only theirs.
    ///
    /// The same call on both modes. This laptop has one member and installs into
    /// their home; a shared box has as many as it has accounts and installs into
    /// the one whose session this is. Neither needs root, and neither reaches
    /// anything outside that home.
    pub async fn install_for_me(&self, home: &str, ask: &Ask) -> Result<Installed, String> {
        let script = install_script(home, ask).map_err(|r| format!("{}: {r}", self.label()))?;
        let out = self.ask(script).await?;
        let mut got = parse_install(&out)?;
        // The report says where a binary is; only the caller knows which one it
        // asked about, and a report that named the wrong tool would be a report
        // nobody could check.
        got.tool = ask.binary().to_string();
        Ok(got)
    }
}

/// Install a tool for the member whose session this is.
///
/// `machine_id` absent means this laptop — the same command answers for both
/// modes, which is the only way the two can be kept honest.
///
/// `home` is the member's own home directory *on that place*, which the caller
/// already holds: it is what [`super::place_account::MemberAccount::home`]
/// reported when the account was made. Asked for rather than guessed, because
/// `/home/<login>` is wrong on macOS, wrong on a box with a non-standard layout,
/// and wrong for every account whose name is not its directory.
#[tauri::command]
pub async fn place_install_for_me(
    root: Option<String>,
    machine_id: Option<String>,
    home: String,
    manager: String,
    name: String,
    version: Option<String>,
    bin: Option<String>,
    login: Option<String>,
) -> Result<Installed, String> {
    let mut ask = Ask::tool(&manager, &name, version.as_deref());
    ask.bin = bin.map(|b| b.trim().to_string()).filter(|b| !b.is_empty());
    ask.login = login.map(|l| l.trim().to_string()).filter(|l| !l.is_empty());
    Place::resolve(root.unwrap_or_default(), machine_id.as_deref())
        .install_for_me(&home, &ask)
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOME: &str = "/home/mo";

    fn npm(name: &str, version: Option<&str>) -> Ask {
        Ask::tool("npm", name, version)
    }

    #[test]
    fn a_members_install_lands_where_their_own_profile_already_looks() {
        // The claim this file rests on: an install and the member's own login
        // shell agree about where things go, because both read one list.
        let env = install_env(HOME);
        for s in SCOPED {
            let got = env
                .iter()
                .find(|(v, _)| *v == s.var)
                .unwrap_or_else(|| panic!("{} is not in the install environment", s.var));
            assert_eq!(got.1, s.path_under(HOME));
        }
        // And everything else points into the one prefix whose bin is on that
        // same PATH, so an installed binary is a binary that runs.
        let path = install_path(HOME);
        for (var, _) in env.iter().filter(|(v, _)| *v == "GOBIN" || *v == "PNPM_HOME") {
            let value = &env.iter().find(|(v, _)| v == var).unwrap().1;
            assert!(path.contains(value.as_str()), "{var} is not on the PATH");
        }
        assert!(path.contains("/home/mo/.local/bin"));
        assert!(path.ends_with(":$PATH"));
    }

    #[test]
    fn a_members_own_copy_wins_over_the_machines() {
        // Order, not membership. A PATH with the member's directories at the
        // back would change where a tool is WRITTEN without changing which one
        // RUNS, which is an install that appears to do nothing.
        let path = install_path(HOME);
        let own = path.find("/home/mo/.local/bin").expect("their own bin");
        let inherited = path.find("$PATH").expect("what the box already had");
        assert!(own < inherited, "{path}");
    }

    #[test]
    fn no_sudo_anywhere_in_it() {
        // The property, not the intention. An install that lands under $HOME
        // needs no privilege, and a privilege this never asks for is one it
        // cannot misuse.
        for ask in [
            npm("cowsay", None),
            Ask::tool("cargo", "hyperfine", Some("1.18.0")),
            Ask::tool("pip", "httpie", None),
            Ask::tool("go", "github.com/x/y/cmd/foo", None),
            Ask::tool("gem", "rails", None),
        ] {
            let script = install_script(HOME, &ask).expect("a per-member install");
            assert!(!script.contains("sudo"), "{}", ask.package.name);
            assert!(!script.contains("$S "), "{}", ask.package.name);
        }
    }

    #[test]
    fn nothing_outside_the_members_own_home_is_written() {
        // Every path the script creates has to be under the home it was given.
        // A directory made anywhere else is a member's install touching a
        // machine several people share.
        for dir in install_dirs(HOME) {
            assert!(dir.starts_with("/home/mo/"), "{dir}");
        }
        let script = install_script(HOME, &npm("cowsay", None)).unwrap();
        assert!(script.contains("mkdir -p '/home/mo/"));
        assert!(!script.contains("mkdir -p '/usr"), "{script}");
    }

    #[test]
    fn the_managers_that_cannot_be_one_persons_say_so_instead_of_reaching_for_root() {
        for (manager, family) in [("apt", "apt"), ("apt-get", "apt"), ("brew", "brew"), ("apk", "apk")] {
            let err = install_script(HOME, &Ask::tool(manager, "postgresql", None))
                .expect_err("a machine-wide manager");
            assert_eq!(err, Refused::Machine { manager: family.into() });
            // The refusal has to name what to do instead, or it is a wall.
            let said = err.to_string();
            assert!(said.contains("settings.toml"), "{said}");
            assert!(said.contains("administers"), "{said}");
        }
    }

    #[test]
    fn an_entry_that_brings_its_own_commands_is_per_member_for_free() {
        // Including one whose manager Aura has never heard of, and one whose
        // manager is machine-wide — a project that has worked out how to install
        // something into a prefix is not second-guessed about it.
        let mut ask = Ask::tool("nix", "ripgrep", None);
        ask.package.check = Some("command -v rg".into());
        ask.package.install = Some("nix profile install nixpkgs#ripgrep".into());
        let script = install_script(HOME, &ask).expect("a spelled-out entry");
        assert!(script.contains("nix profile install"));

        let mut theirs = Ask::tool("brew", "ripgrep", None);
        theirs.package.check = Some("command -v rg".into());
        theirs.package.install = Some("./install-into-prefix.sh".into());
        assert!(install_script(HOME, &theirs).is_ok());
    }

    #[test]
    fn an_unknown_manager_that_spelled_nothing_out_is_named_rather_than_guessed_at() {
        let err = install_script(HOME, &Ask::tool("nix", "ripgrep", None)).expect_err("unknown");
        match err {
            Refused::Unknown { detail } => assert!(detail.contains("nix"), "{detail}"),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_place_with_no_home_to_install_into_refuses_before_it_runs_anything() {
        for home in ["", "   ", "~", "relative/path"] {
            assert!(matches!(
                install_script(home, &npm("cowsay", None)),
                Err(Refused::Homeless { .. })
            ));
        }
    }

    #[test]
    fn a_session_that_is_somebody_else_refuses_rather_than_writing_into_their_home() {
        let mut ask = npm("cowsay", None);
        ask.login = Some("mo".into());
        let script = install_script(HOME, &ask).unwrap();
        assert!(script.contains("EXPECT='mo'"));
        assert!(script.contains(r#"[ "$ME" != "$EXPECT" ]"#));
        // And with nobody insisted upon, it installs for whoever the session is
        // rather than refusing every unattended call.
        let anyone = install_script(HOME, &npm("cowsay", None)).unwrap();
        assert!(anyone.contains("EXPECT=''"));
    }

    #[test]
    fn a_login_with_an_apostrophe_in_it_cannot_end_the_quoting() {
        let mut ask = npm("cowsay", None);
        ask.login = Some("mo'; rm -rf /".into());
        let script = install_script(HOME, &ask).unwrap();
        assert!(script.contains(r"EXPECT='mo'\''; rm -rf /'"), "{script}");
        assert!(!script.contains("EXPECT='mo'; rm"), "{script}");
    }

    #[test]
    fn the_binary_looked_for_is_the_one_the_package_leaves_behind() {
        // `@anthropic-ai/claude-code` leaves `claude`. A report that looked for
        // a binary named after the package would call a good install a failure.
        let ask = agent_ask("claude").expect("a known agent");
        assert_eq!(ask.binary(), "claude");
        assert_eq!(ask.package.name, "@anthropic-ai/claude-code");
        let script = install_script(HOME, &ask).unwrap();
        assert!(script.contains("command -v 'claude'"));
        assert!(script.contains("npm install -g '@anthropic-ai/claude-code'"));
    }

    #[test]
    fn an_agent_aura_does_not_know_the_package_for_is_not_guessed_at() {
        // The alternative is `npm install -g <whatever the caller typed>`, which
        // is Aura installing a stranger's package because a session was opened
        // with a typo in it.
        assert!(agent_ask("definitely-not-an-agent").is_none());
        assert!(fetch_line("definitely-not-an-agent").is_none());
        assert!(agent_ask("").is_none());
        assert!(agent_ask("rm -rf /").is_none());
    }

    #[test]
    fn the_session_fetch_is_one_line_and_belongs_to_whoever_is_sitting_there() {
        let line = fetch_line("claude").expect("a known agent");
        assert!(!line.contains('\n'), "a session command must be one line");
        // `$HOME`, unexpanded — resolved here it would be this laptop's idea of
        // who is sitting in front of that box.
        assert!(line.contains("NPM_CONFIG_PREFIX=\"$HOME/.npm-global\""), "{line}");
        assert!(!line.contains("/home/mo"), "{line}");
        // It says what it is doing, and says it away from the agent's own words.
        assert!(line.contains("Nobody else here is changed"), "{line}");
        assert!(line.trim_end().ends_with(">&2 2>&1"), "{line}");
    }

    #[test]
    fn a_version_reaches_the_command_that_installs_it() {
        let script = install_script(HOME, &npm("cowsay", Some("1.5.0"))).unwrap();
        assert!(script.contains("npm install -g 'cowsay@1.5.0'"), "{script}");
        let pinned = install_script(HOME, &Ask::tool("cargo", "hyperfine", Some("1.18.0"))).unwrap();
        assert!(pinned.contains("--version '1.18.0'"), "{pinned}");
    }

    #[test]
    fn a_report_is_read_back_as_what_the_machine_said() {
        let got = parse_install(
            "Welcome to Ubuntu\nadded 1 package\n___AURA_TOOLBOX___\nlogin=mo\nhome=/home/mo\n\
             state=installed\nwhere=/home/mo/.npm-global/bin/cowsay\n",
        )
        .expect("a report");
        assert_eq!(got.login, "mo");
        assert!(got.changed());
        assert!(got.mine, "an install into the member's own home read as somebody else's");
    }

    #[test]
    fn an_install_that_landed_somewhere_shared_is_not_reported_as_mine() {
        // The whole acceptance criterion, as the thing that catches its own
        // failure: a binary resolved out of /usr/local is the machine's copy,
        // whatever the install said.
        let shared = parse_install(
            "___AURA_TOOLBOX___\nlogin=mo\nhome=/home/mo\nstate=installed\n\
             where=/usr/local/bin/cowsay\n",
        )
        .unwrap();
        assert!(!shared.mine);

        // A neighbour's home, which is the case that looks right until somebody
        // reads the path.
        let theirs = parse_install(
            "___AURA_TOOLBOX___\nlogin=mo\nhome=/home/mo\nstate=installed\n\
             where=/home/mo2/.npm-global/bin/cowsay\n",
        )
        .unwrap();
        assert!(!theirs.mine, "a path that merely starts the same was read as this member's");

        // And one that installed but cannot be run: a different problem from
        // not installing, and it must not read as success.
        let unreachable = parse_install(
            "___AURA_TOOLBOX___\nlogin=mo\nhome=/home/mo\nstate=installed\nwhere=\n",
        )
        .unwrap();
        assert!(!unreachable.mine);
        assert!(unreachable.at.is_empty());
    }

    #[test]
    fn a_machine_that_said_nothing_is_not_read_as_a_successful_install() {
        assert!(parse_install("npm ERR! code EACCES\n").is_err());
        assert!(parse_install("___AURA_TOOLBOX___\nhome=/home/mo\n").is_err());
    }

    #[test]
    fn what_gets_spliced_into_a_session_is_shell_a_shell_will_accept() {
        // The install script is proven by being run below; the fetch line is
        // not, because running it would install something. So it is parsed
        // instead. A syntax error here is a session that dies on connect —
        // the exact failure the sentence it replaces existed to prevent.
        let line = fetch_if_missing("claude");
        for candidate in [line.clone(), format!("{line}exec \"$SHELL\" -l")] {
            let out = std::process::Command::new("sh")
                .args(["-n", "-c", &candidate])
                .output()
                .expect("parse it");
            assert!(
                out.status.success(),
                "{}\n{candidate}",
                String::from_utf8_lossy(&out.stderr)
            );
        }
        assert!(fetch_if_missing("definitely-not-an-agent").is_empty());
    }

    /// Two members, one machine, two versions of one tool — the claim, executed.
    ///
    /// Everything here is real: two homes, the script this file renders, and
    /// `sh` running it. The tool is declared with its own `check`/`install` so
    /// the test needs no network and no npm registry, but every other part is
    /// the path a real install takes — the same prefix, the same `PATH`, the
    /// same report — and the proof is on disk afterwards rather than in what the
    /// report claimed.
    ///
    /// This is the case a shared box exists to survive, and the one that used to
    /// be impossible: before, both of these were `sudo npm install -g` and the
    /// second one silently replaced the first.
    #[test]
    fn two_members_install_conflicting_versions_and_each_keeps_their_own() {
        let stage = std::env::temp_dir().join(format!("aura-toolbox-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&stage);

        // A tool whose install is a script that prints its own version, so
        // "which one is on this member's PATH" is answerable by running it.
        let widget = |version: &str| {
            let mut ask = Ask::tool("custom", "widget", Some(version));
            ask.package.check = Some(format!(
                "widget 2>/dev/null | grep -qx 'widget {version}'"
            ));
            ask.package.install = Some(format!(
                "printf '#!/bin/sh\\necho \"widget {version}\"\\n' > \"$PYTHONUSERBASE/bin/widget\" \
                 && chmod 755 \"$PYTHONUSERBASE/bin/widget\""
            ));
            ask
        };

        let mut homes = vec![];
        for (who, version) in [("mo", "1.0.0"), ("ana", "2.0.0")] {
            let home = stage.join(who);
            std::fs::create_dir_all(&home).expect("a home");
            let home = home.display().to_string();
            let script = install_script(&home, &widget(version)).expect("a per-member install");
            let out = std::process::Command::new("sh")
                .args(["-c", &script])
                .output()
                .expect("run it");
            let report = parse_install(&String::from_utf8_lossy(&out.stdout))
                .unwrap_or_else(|e| panic!("{who}: {e}\n{}", String::from_utf8_lossy(&out.stderr)));

            assert_eq!(report.state, "installed", "{who} did not install");
            assert!(report.mine, "{who}'s install landed at {}", report.at);
            assert!(
                report.at.starts_with(&format!("{home}/")),
                "{who} got {} rather than something in their own home",
                report.at
            );
            homes.push((who, home, version.to_string(), report));
        }

        // Each member's own copy is the one their own PATH finds, and it is
        // theirs — not the last one installed, which is what a machine-wide
        // prefix would have given both of them.
        for (who, home, version, report) in &homes {
            let ran = std::process::Command::new("sh")
                .args(["-c", &format!("PATH=\"{}\"; widget", install_path(home))])
                .output()
                .expect("run the installed tool");
            assert_eq!(
                String::from_utf8_lossy(&ran.stdout).trim(),
                format!("widget {version}"),
                "{who} is running somebody else's version"
            );
            // And nothing of theirs is inside anybody else's home.
            for (other, other_home, _, _) in &homes {
                if other != who {
                    assert!(
                        !report.at.starts_with(&format!("{other_home}/")),
                        "{who}'s install landed in {other}'s home"
                    );
                }
            }
        }

        // Asked again, it reinstalls nothing — a member verifying their own tool
        // is still theirs must not be a second install.
        let (_, home, version, _) = &homes[0];
        let again = std::process::Command::new("sh")
            .args(["-c", &install_script(home, &widget(version)).unwrap()])
            .output()
            .expect("run it again");
        let report = parse_install(&String::from_utf8_lossy(&again.stdout)).expect("a report");
        assert_eq!(report.state, "already");
        assert!(!report.changed());

        let _ = std::fs::remove_dir_all(&stage);
    }
}
