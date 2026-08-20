//! Where a member's global installs land, so two people on one box don't
//! overwrite each other.
//!
//! The other half of the tenth question. [`super::place_author`] settles whose
//! name is on the commit; this settles whose `npm install -g` it was — and they
//! are in the same task because they are the same bug wearing two hats. On a
//! shared place, anything that defaults to "the machine" instead of "the member"
//! silently becomes everybody's, and the first anyone finds out is when a
//! teammate's toolchain changes under them.
//!
//! ## What per-member accounts did and did not buy
//!
//! [`super::place_account`] gives each member a real Unix user, a `0700` home and
//! `umask 077`. That makes three of the five directories below private *by
//! accident of `$HOME`* — and accident is the operative word. Two members who end
//! up on the same login (the box's bootstrap account, which is exactly what a
//! team gets before anyone runs the account wizard) share all five. A tool told
//! to look somewhere machine-wide shares them regardless of `$HOME`. And the
//! property nobody ever wrote down is the property nobody notices losing.
//!
//! ## The one that is shared even when everything else is right
//!
//! npm's prefix. It does not default to the home directory at all — it defaults
//! to node's install prefix, `/usr/local`, so `npm install -g` is a machine-wide
//! write that needs `sudo` and lands one member's version of a package on
//! everybody. `aura-runner/aws/bootstrap.sh` does exactly this on purpose for the
//! agent CLI, which is fine: that is the machine's own tooling, installed once,
//! by the machine. A *member's* install is not that, and pointing their prefix at
//! their own home is what makes `npm install -g` stop needing root and stop being
//! everyone's.
//!
//! ## Why this is a list and not five lines in the provisioning script
//!
//! Because the question "is this place separated?" has to be answerable *after*
//! provisioning, on a box somebody set up months ago, and by a surface rather
//! than by reading a shell script. So [`SCOPED`] is the single list,
//! [`profile_block`] renders it into the member's profile, [`survey_script`]
//! reads back what a login shell of theirs actually exports, and [`scope_of`]
//! judges each answer. Adding a sixth tool is one row in [`SCOPED`] and nothing
//! else — the write, the read and the verdict all follow from it.

use serde::{Deserialize, Serialize};

use super::place::Place;
use crate::cloudbox::script::quote;

/// Marks the start of the machine-readable report. Split in the rendered script
/// with `""`, because a line that contains its own marker matches itself.
const REPORT: &str = "___AURA_TOOLCHAIN___";

/// The comment that marks the block we own in a member's profile. Matched to
/// keep [`profile_block`] idempotent — a member's `.profile` must not grow a
/// fresh copy every time their account is verified.
///
/// Deliberately free of apostrophes, and that is load-bearing rather than
/// stylistic: the whole block is carried into the provisioning script as a
/// single-quoted shell word, so one apostrophe anywhere in it would end the
/// quoting early and hand the box a fragment to execute. `no_quote_in_the_block`
/// holds the rule for everything else in there.
pub const MARK: &str = "aura: keep global installs in this account";

/// Paths that mean "everybody on this machine". A tool pointed at one of these
/// is shared no matter how private the member's home is.
const MACHINE_WIDE: [&str; 5] = ["/usr/local", "/usr", "/opt", "/var", "/srv"];

/// One tool's state directory, and what happens when it isn't the member's.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ScopedVar {
    /// The environment variable the tool reads.
    pub var: &'static str,
    /// What a person calls the tool.
    pub tool: &'static str,
    /// Where it goes, relative to the member's own home.
    pub under: &'static str,
    /// The directory of executables this creates, when it makes one. Scoping the
    /// prefix without putting its `bin` on `PATH` gives a member installs they
    /// cannot run, which reads as the scoping being broken.
    pub bin: Option<&'static str>,
    /// Is this tool's own default already somewhere shared?
    ///
    /// The honest distinction. Four of these default to the member's home and are
    /// only *implicitly* theirs; npm's prefix defaults to `/usr/local` and is
    /// explicitly everybody's. An unset variable therefore means two different
    /// things, and a report that flattened them would cry wolf on four rows and
    /// under-report the one that matters.
    pub default_is_shared: bool,
    /// What collides when this isn't scoped — in the words of the thing that
    /// actually breaks, not the name of the variable.
    pub collides: &'static str,
}

/// Every tool that keeps per-member state a shared box would otherwise merge.
///
/// `gh` is first on purpose: its `hosts.yml` is a login token, and one of those
/// shared between two members is the exact bug [`super::place_git`] exists to
/// stop — a push that lands under whoever authenticated first.
pub const SCOPED: [ScopedVar; 6] = [
    ScopedVar {
        var: "GH_CONFIG_DIR",
        tool: "gh",
        under: ".config/gh",
        bin: None,
        default_is_shared: false,
        collides: "one GitHub login for the whole machine, so a push lands under whoever ran `gh auth login` first",
    },
    ScopedVar {
        var: "CARGO_HOME",
        tool: "cargo",
        under: ".cargo",
        bin: Some("bin"),
        default_is_shared: false,
        collides: "one set of `cargo install` binaries and one registry credential, shared by everybody here",
    },
    ScopedVar {
        var: "RUSTUP_HOME",
        tool: "rustup",
        under: ".rustup",
        bin: None,
        default_is_shared: false,
        collides: "one default toolchain, so a member pinning nightly pins it for the whole box",
    },
    ScopedVar {
        var: "NPM_CONFIG_PREFIX",
        tool: "npm",
        under: ".npm-global",
        bin: Some("bin"),
        default_is_shared: true,
        collides: "`npm install -g` writes into /usr/local, so it needs root and one member's version of a package becomes everyone's",
    },
    ScopedVar {
        var: "NPM_CONFIG_CACHE",
        tool: "npm",
        under: ".npm",
        bin: None,
        default_is_shared: false,
        collides: "a cache left root-owned by an earlier `sudo npm` that no member can write to afterwards",
    },
    // The second manager whose default is everybody's, and the one that gives
    // every OTHER per-member install somewhere to put a binary. `pip install`
    // without it writes into the system `site-packages`, so it needs root and
    // one member's version of a library becomes everyone's; with it, pip lands
    // in `~/.local` — the directory the rest of the world already means by "a
    // tool I installed for myself", and whose `bin` this row therefore puts on
    // the member's own PATH. [`super::place_toolbox`] points `go`, `gem`, `bun`
    // and `pnpm` at the same prefix for exactly that reason: a binary installed
    // somewhere the member's PATH does not reach is an install they cannot run.
    ScopedVar {
        var: "PYTHONUSERBASE",
        tool: "pip",
        under: ".local",
        bin: Some("bin"),
        default_is_shared: true,
        collides: "`pip install` writes into the system site-packages, so it needs root and one member's version of a library becomes everyone's",
    },
];

impl ScopedVar {
    /// Where this belongs for a member whose home is `home`.
    pub fn path_under(&self, home: &str) -> String {
        format!("{}/{}", home.trim_end_matches('/'), self.under)
    }

    /// The executables this puts on `PATH`, when it makes any.
    pub fn bin_under(&self, home: &str) -> Option<String> {
        self.bin.map(|b| format!("{}/{b}", self.path_under(home)))
    }
}

/// Every variable and the path it should hold, for one member's home.
pub fn scoped_env(home: &str) -> Vec<(&'static str, String)> {
    SCOPED
        .iter()
        .map(|s| (s.var, s.path_under(home)))
        .collect()
}

/// The block appended to a member's login profile.
///
/// Written against `$HOME` rather than against a baked path, deliberately. The
/// profile is read by the member's own login shell, where `$HOME` is already
/// theirs — so the block is correct for whoever reads it, survives a home
/// directory being moved, and cannot hand one member a path pointing into
/// another's home if the caller passed the wrong login.
///
/// POSIX `sh`: `.profile` is read by dash on Debian and Ubuntu, so no `export
/// FOO=bar` chaining and no bashisms.
pub fn profile_block() -> String {
    let mut out = String::from("\n# ");
    out.push_str(MARK);
    out.push('\n');
    for s in SCOPED {
        out.push_str(&format!("{}=\"$HOME/{}\"\n", s.var, s.under));
        out.push_str(&format!("export {}\n", s.var));
    }
    // One PATH line for all of them, prepended: a member's own install must win
    // over the machine-wide copy of the same binary, or scoping the prefix
    // changes where things are written without changing which one runs.
    let bins: Vec<String> = SCOPED
        .iter()
        .filter_map(|s| s.bin.map(|b| format!("$HOME/{}/{b}", s.under)))
        .collect();
    out.push_str(&format!("PATH=\"{}:$PATH\"\n", bins.join(":")));
    out.push_str("export PATH\n");
    out
}

/// The block as a shell assignment, for the top of the provisioning script.
///
/// Split from [`provision_snippet`] because of where the block has to survive
/// unexpanded. The snippet's write goes through `priv_sh "…"`, a DOUBLE-quoted
/// string — so a `$HOME` written straight into it would expand right there, in
/// the provisioning session, and bake whoever ran the wizard into every member's
/// profile. Naming it once here, single-quoted, and referring to the variable
/// there means the outer shell substitutes the block's *text* and the inner
/// `sh -c` receives it inside single quotes, where `$HOME` stays a `$HOME` for
/// the member's own login shell to expand.
pub fn provision_assign() -> String {
    format!("AURA_TOOLCHAIN_BLOCK={}", quote(&profile_block()))
}

/// Shell that appends [`profile_block`] to `$RC` exactly once.
///
/// Rendered rather than inlined so [`super::place_account::provision_script`] —
/// which is where a member's account is actually made — carries one line instead
/// of a copy of this knowledge. `$RC` and `$HOME_DIR` are that script's own
/// variables, and `$AURA_TOOLCHAIN_BLOCK` is [`provision_assign`]; that is the
/// whole coupling.
///
/// `priv_sh` is the caller's helper for "write into the member's home", which is
/// how this stays a thing an admin can do on somebody's behalf.
pub fn provision_snippet() -> String {
    format!(
        r#"if grep -qF {mark} "$HOME_DIR/$RC" 2>/dev/null; then
    SCOPED=yes
  elif priv_sh "printf '%s' '$AURA_TOOLCHAIN_BLOCK' >> '$HOME_DIR/$RC'" >/dev/null 2>&1; then
    SCOPED=yes
  fi"#,
        mark = quote(MARK)
    )
}

/// The directories [`profile_block`] names, as words for the provisioning
/// script — which spells the member's home `$HOME_DIR`.
///
/// They have to be MADE, not just named. npm falls back to `/usr/local` when the
/// prefix it is given does not exist, so a variable pointing at a directory
/// nobody created is a collision that only shows up on the first install.
///
/// Rendered with double quotes, for use as bare words in that script.
pub fn provision_dirs() -> String {
    dirs_with('"')
}

/// The same directories for use INSIDE `priv_sh "…"`, where the surrounding
/// double quotes are already expanding `$HOME_DIR` and single quotes are what
/// keep the expansion one word on the far side.
pub fn provision_dirs_within_priv_sh() -> String {
    dirs_with('\'')
}

fn dirs_with(q: char) -> String {
    SCOPED
        .iter()
        .map(|s| format!("{q}$HOME_DIR/{}{q}", s.under))
        .collect::<Vec<_>>()
        .join(" ")
}

/// Where one tool's state actually lives, from the member's point of view.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "scope", rename_all = "snake_case")]
pub enum Scope {
    /// Under this member's own home. Theirs.
    Mine,
    /// Somewhere every account on this machine writes.
    Everybody { path: String },
    /// Inside a different member's home — the worst case, because it looks
    /// scoped right up until someone reads the path.
    SomeoneElse { path: String },
    /// Not set. Whether that is fine depends on the tool, which is why
    /// [`ScopedVar::default_is_shared`] exists.
    Unset { shared_by_default: bool },
}

impl Scope {
    /// Would two members collide on this one?
    pub fn collides(&self) -> bool {
        match self {
            Scope::Mine => false,
            Scope::Everybody { .. } | Scope::SomeoneElse { .. } => true,
            Scope::Unset { shared_by_default } => *shared_by_default,
        }
    }
}

/// One variable, as the place answered it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VarState {
    pub var: String,
    pub tool: String,
    /// What a login shell of theirs exports, verbatim. Empty when unset.
    pub value: String,
    pub scope: Scope,
    /// What breaks if this one is shared — carried on the row so a surface can
    /// say why it matters without a second table mapping variables to
    /// consequences.
    pub collides: String,
}

/// What a place holds for one member's tooling.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolchainReport {
    pub place: String,
    /// The member this is about.
    pub login: String,
    /// Their home, as the box spells it.
    pub home: String,
    /// The login that answered.
    pub you: String,
    /// Could we actually start a login shell as them and read what it exports?
    ///
    /// False is not a failure — it means nobody could become that member from
    /// this session — but it does mean the rows below are what their profile
    /// *says* rather than what their shell *does*, and a surface must be able to
    /// tell those apart.
    pub observed: bool,
    /// Is Aura's block in their profile?
    pub scoped: bool,
    pub vars: Vec<VarState>,
}

impl ToolchainReport {
    /// The variables two members would collide on.
    pub fn collisions(&self) -> Vec<&VarState> {
        self.vars.iter().filter(|v| v.scope.collides()).collect()
    }

    /// Is this member's tooling their own?
    pub fn separated(&self) -> bool {
        self.collisions().is_empty()
    }
}

/// Judge one answer.
///
/// Pure, and the whole verdict: a path under the member's home is theirs, a path
/// under a directory every account writes to is everybody's, and a path under
/// `/home/<somebody-else>` is the case that looks scoped and isn't.
pub fn scope_of(s: &ScopedVar, value: &str, home: &str) -> Scope {
    let value = value.trim();
    if value.is_empty() {
        return Scope::Unset {
            shared_by_default: s.default_is_shared,
        };
    }
    let home = home.trim().trim_end_matches('/');
    if !home.is_empty() && (value == home || value.starts_with(&format!("{home}/"))) {
        return Scope::Mine;
    }
    if MACHINE_WIDE
        .iter()
        .any(|m| value == *m || value.starts_with(&format!("{m}/")))
    {
        return Scope::Everybody {
            path: value.to_string(),
        };
    }
    // Anything else that lives under a home-shaped root belongs to a person, and
    // we already know it is not this one.
    Scope::SomeoneElse {
        path: value.to_string(),
    }
}

/// Ask a place where one member's tools keep their state.
///
/// POSIX `sh`, one script for both place-modes. It runs a LOGIN shell as the
/// member and asks that shell what it exports, rather than reading the profile
/// we wrote — reading our own block back would only ever confirm that we wrote
/// it, and would miss a machine-wide `/etc/profile.d` entry setting the same
/// variable afterwards, which is precisely how a box ends up shared despite
/// per-member homes.
pub fn survey_script(login: &str) -> String {
    let login = quote(login);
    let mark = quote(MARK);
    // The probe runs inside the member's own login shell, so it must be one
    // string that shell can take. Every variable is read with `:-` so an unset
    // one prints empty instead of tripping `set -u` over there.
    let probe = SCOPED
        .iter()
        .map(|s| format!("printf '{}=%s\\n' \"${{{}:-}}\"", s.var, s.var))
        .collect::<Vec<_>>()
        .join("; ");
    let probe = quote(&probe);
    format!(
        r#"set -u
LOGIN={login}
MARK={mark}
PROBE={probe}
ME=$(id -un 2>/dev/null || echo "${{USER:-}}")

if [ "$ME" = "$LOGIN" ]; then HOME_DIR="$HOME"
else HOME_DIR=$(getent passwd "$LOGIN" 2>/dev/null | cut -d: -f6); fi
[ -n "$HOME_DIR" ] || HOME_DIR=$(eval printf '%s' "~$LOGIN" 2>/dev/null)
case "$HOME_DIR" in ""|"~"*) HOME_DIR="/home/$LOGIN" ;; esac

# Is our block in their profile? Asked separately from the shell probe, because
# an admin can read a member's profile in cases where they cannot become them.
SCOPED=no
for RC in .profile .bash_profile; do
  if grep -qF "$MARK" "$HOME_DIR/$RC" 2>/dev/null; then SCOPED=yes; fi
done

# What a login shell of theirs ACTUALLY exports. `sudo -n` never prompts: a
# question asked down a pipe with nobody in front of it is a hang, not a
# question.
OBSERVED=no
VALUES=""
if [ "$ME" = "$LOGIN" ]; then
  VALUES=$(sh -lc "$PROBE" 2>/dev/null) && OBSERVED=yes
elif sudo -n true >/dev/null 2>&1; then
  VALUES=$(sudo -n -u "$LOGIN" -i sh -c "$PROBE" 2>/dev/null) && OBSERVED=yes
fi

echo "___AURA""_TOOLCHAIN___"
echo "you=$ME"
echo "login=$LOGIN"
echo "home=$HOME_DIR"
echo "scoped=$SCOPED"
echo "observed=$OBSERVED"
printf '%s\n' "$VALUES"
"#
    )
}

/// Read the report back. Everything before the marker is the place's own noise.
pub fn parse_report(place: &str, out: &str) -> Result<ToolchainReport, String> {
    let body = out
        .split_once(REPORT)
        .map(|(_, rest)| rest)
        .ok_or_else(|| "the place didn't say where its tools keep their state".to_string())?;
    let f = |k: &str| -> String {
        body.lines()
            .filter_map(|l| l.trim().split_once('='))
            .find(|(key, _)| *key == k)
            .map(|(_, v)| v.trim().to_string())
            .unwrap_or_default()
    };
    let login = f("login");
    if login.is_empty() {
        return Err("the place didn't say which member it answered about".into());
    }
    let home = f("home");
    let vars = SCOPED
        .iter()
        .map(|s| {
            let value = f(s.var);
            VarState {
                scope: scope_of(s, &value, &home),
                var: s.var.to_string(),
                tool: s.tool.to_string(),
                collides: s.collides.to_string(),
                value,
            }
        })
        .collect();
    Ok(ToolchainReport {
        place: place.to_string(),
        you: f("you"),
        scoped: f("scoped") == "yes",
        observed: f("observed") == "yes",
        login,
        home,
        vars,
    })
}

impl Place {
    /// Where this member's global installs go here, and whether they are theirs.
    ///
    /// One call for both place-modes, because it is a `Place` method and the
    /// survey is one script through [`Place::ask`]. This laptop answers it about
    /// the account somebody is sitting at — which is a real answer, and usually
    /// "yes, they are yours, there is nobody else here" — and a box answers it
    /// about a member among several.
    pub async fn toolchain(&self, login: &str) -> Result<ToolchainReport, String> {
        let out = self.ask(survey_script(login)).await?;
        parse_report(self.label(), &out)
    }
}

/// Where a member's global installs land at a place, and whether a teammate
/// would collide with them.
///
/// `machine_id` names a box; omit it and the answer is about this laptop, in
/// `root`. `login` is the member's account HERE — the one
/// [`super::place_account`] made — which is not always their Aura handle, so it
/// is passed rather than re-derived.
#[tauri::command]
pub async fn place_toolchain(
    root: Option<String>,
    machine_id: Option<String>,
    login: Option<String>,
) -> Result<ToolchainReport, String> {
    let place = match machine_id.as_deref().map(str::trim).filter(|id| !id.is_empty()) {
        Some(id) => Place::at_machine(id)?,
        None => Place::resolve(root.unwrap_or_default(), None),
    };
    let login = super::place_git::member_for(&place, login.as_deref()).await;
    place.toolchain(&login).await
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOME: &str = "/home/mo";

    fn var(name: &str) -> &'static ScopedVar {
        SCOPED
            .iter()
            .find(|s| s.var == name)
            .expect("no such scoped variable")
    }

    fn report(values: &[(&str, &str)]) -> ToolchainReport {
        let mut out = format!(
            "{REPORT}\nyou=ubuntu\nlogin=mo\nhome={HOME}\nscoped=yes\nobserved=yes\n"
        );
        for (k, v) in values {
            out.push_str(&format!("{k}={v}\n"));
        }
        parse_report("shed", &out).expect("the report did not parse")
    }

    #[test]
    fn a_path_under_my_own_home_is_mine() {
        assert_eq!(
            scope_of(var("CARGO_HOME"), "/home/mo/.cargo", HOME),
            Scope::Mine
        );
        // A trailing slash on the home is a spelling, not a different directory.
        assert_eq!(
            scope_of(var("CARGO_HOME"), "/home/mo/.cargo", "/home/mo/"),
            Scope::Mine
        );
    }

    #[test]
    fn npms_default_is_everybodys_and_the_others_are_not() {
        // The one row where "unset" is the bug rather than the ordinary state.
        assert_eq!(
            scope_of(var("NPM_CONFIG_PREFIX"), "", HOME),
            Scope::Unset {
                shared_by_default: true
            }
        );
        assert!(scope_of(var("NPM_CONFIG_PREFIX"), "", HOME).collides());
        for name in ["CARGO_HOME", "RUSTUP_HOME", "GH_CONFIG_DIR"] {
            assert!(
                !scope_of(var(name), "", HOME).collides(),
                "{name} unset was reported as a collision, but its default is the member's home"
            );
        }
    }

    #[test]
    fn usr_local_is_everybodys_however_it_got_there() {
        assert_eq!(
            scope_of(var("NPM_CONFIG_PREFIX"), "/usr/local", HOME),
            Scope::Everybody {
                path: "/usr/local".into()
            }
        );
        assert_eq!(
            scope_of(var("CARGO_HOME"), "/opt/rust/cargo", HOME),
            Scope::Everybody {
                path: "/opt/rust/cargo".into()
            }
        );
    }

    #[test]
    fn a_path_in_somebody_elses_home_is_the_case_that_looks_scoped() {
        // Set, private-looking, per-user shaped — and still not this member's.
        assert_eq!(
            scope_of(var("GH_CONFIG_DIR"), "/home/ana/.config/gh", HOME),
            Scope::SomeoneElse {
                path: "/home/ana/.config/gh".into()
            }
        );
        assert!(scope_of(var("GH_CONFIG_DIR"), "/home/ana/.config/gh", HOME).collides());
    }

    #[test]
    fn a_home_that_merely_starts_the_same_is_not_the_same_home() {
        // `/home/mo` must not swallow `/home/mo2`.
        assert!(matches!(
            scope_of(var("CARGO_HOME"), "/home/mo2/.cargo", HOME),
            Scope::SomeoneElse { .. }
        ));
    }

    #[test]
    fn a_fully_scoped_member_collides_with_nobody() {
        let got = report(&[
            ("GH_CONFIG_DIR", "/home/mo/.config/gh"),
            ("CARGO_HOME", "/home/mo/.cargo"),
            ("RUSTUP_HOME", "/home/mo/.rustup"),
            ("NPM_CONFIG_PREFIX", "/home/mo/.npm-global"),
            ("NPM_CONFIG_CACHE", "/home/mo/.npm"),
            ("PYTHONUSERBASE", "/home/mo/.local"),
        ]);
        assert!(got.separated(), "{:?}", got.collisions());
        assert!(got.observed && got.scoped);
    }

    #[test]
    fn the_box_as_provisioned_today_collides_on_the_ones_that_matter() {
        // No block, nothing exported: what a member gets on a machine set up
        // before any of this existed. Two of the six are actually shared when
        // unset — the two package managers whose default prefix is a system
        // directory — and naming those two rather than all six is the
        // difference between a report and an alarm.
        let got = report(&[]);
        let hit = got.collisions();
        let named: Vec<&str> = hit.iter().map(|v| v.var.as_str()).collect();
        assert_eq!(named, vec!["NPM_CONFIG_PREFIX", "PYTHONUSERBASE"], "{hit:?}");
        assert!(hit[0].collides.contains("/usr/local"), "{}", hit[0].collides);
        assert!(
            hit[1].collides.contains("site-packages"),
            "{}",
            hit[1].collides
        );
    }

    #[test]
    fn two_members_sharing_one_login_is_reported_as_a_collision() {
        // The bootstrap-login case: everything points at ubuntu's home, and this
        // member's home is not ubuntu's.
        let got = report(&[
            ("GH_CONFIG_DIR", "/home/ubuntu/.config/gh"),
            ("CARGO_HOME", "/home/ubuntu/.cargo"),
            ("RUSTUP_HOME", "/home/ubuntu/.rustup"),
            ("NPM_CONFIG_PREFIX", "/usr/local"),
            ("NPM_CONFIG_CACHE", "/home/ubuntu/.npm"),
            ("PYTHONUSERBASE", "/home/ubuntu/.local"),
        ]);
        assert_eq!(got.collisions().len(), 6);
        assert!(!got.separated());
    }

    #[test]
    fn every_scoped_tool_says_what_breaks_without_it() {
        for s in SCOPED {
            assert!(!s.collides.is_empty(), "{} has no consequence", s.var);
            assert!(
                !s.under.starts_with('/'),
                "{} is an absolute path, so it is not under the member's home",
                s.var
            );
        }
    }

    #[test]
    fn the_profile_block_scopes_every_tool_and_puts_their_bins_first() {
        let block = profile_block();
        for s in SCOPED {
            assert!(block.contains(&format!("{}=\"$HOME/{}\"", s.var, s.under)), "{}", s.var);
            assert!(block.contains(&format!("export {}", s.var)), "{}", s.var);
        }
        // Against `$HOME`, never a baked path: the profile is read by the
        // member's own shell, so it stays right if their home ever moves.
        assert!(!block.contains("/home/"), "a home directory is baked in");
        assert!(
            block.contains("$HOME/.npm-global/bin") && block.contains("$HOME/.cargo/bin"),
            "a member's own installs are not on PATH, so they cannot run them"
        );
        assert!(
            block.contains(":$PATH\""),
            "the member's own binaries do not win over the machine-wide copies"
        );
    }

    #[test]
    fn the_provision_snippet_appends_once() {
        let snip = provision_snippet();
        assert!(snip.contains("grep -qF"), "the block would be appended twice");
        assert!(snip.contains(MARK), "nothing marks the block as ours");
        assert!(snip.contains(">> '$HOME_DIR/$RC'"), "the block is not appended");
        // Written through the caller's own privileged helper, so an admin can do
        // this on a member's behalf.
        assert!(snip.contains("priv_sh"), "the write does not go through priv_sh");
        // Through the VARIABLE, never the block inline: `priv_sh "…"` is double
        // quoted, so an inline `$HOME` would expand in the provisioning session.
        assert!(
            snip.contains("'$AURA_TOOLCHAIN_BLOCK'"),
            "the block is written inline, where $HOME would expand too early"
        );
    }

    #[test]
    fn no_quote_in_the_block() {
        // The block crosses into the provisioning script as one single-quoted
        // shell word. A single apostrophe anywhere in it ends that quoting early
        // and hands the far side a fragment to run — so this is the invariant
        // that keeps `provision_assign` safe, not a style preference.
        let assign = provision_assign();
        assert!(
            !profile_block().contains('\''),
            "an apostrophe in the block would break out of its own quoting"
        );
        assert!(
            assign.starts_with("AURA_TOOLCHAIN_BLOCK='") && assign.ends_with('\''),
            "the block is not one quoted word: {assign}"
        );
        // Exactly two apostrophes in the whole assignment: the pair around it.
        assert_eq!(assign.matches('\'').count(), 2, "{assign}");
    }

    #[test]
    fn the_survey_asks_the_members_own_login_shell() {
        let script = survey_script("mo");
        assert!(
            script.contains("sh -lc") && script.contains("sudo -n -u"),
            "the survey does not run a login shell as the member"
        );
        // Reading our own block back would confirm nothing but that we wrote it.
        for s in SCOPED {
            assert!(script.contains(s.var), "{} is not surveyed", s.var);
        }
    }

    #[test]
    fn nothing_a_login_is_called_can_become_a_second_command() {
        let script = survey_script("mo'; rm -rf / #");
        assert!(!script.contains("; rm -rf / #\n"), "a login escaped its quotes");
        assert!(script.contains(r"'\''; rm -rf / #"), "the login was not quoted");
    }

    #[test]
    fn the_script_never_contains_the_marker_it_prints() {
        assert!(!survey_script("mo").contains(REPORT));
    }

    #[test]
    fn a_place_that_could_not_become_the_member_says_so_rather_than_guessing() {
        let out = format!(
            "{REPORT}\nyou=ubuntu\nlogin=mo\nhome=/home/mo\nscoped=yes\nobserved=no\n"
        );
        let got = parse_report("shed", &out).unwrap();
        assert!(!got.observed, "an unread shell was reported as read");
        // Still a full set of rows — the answer is "unset", which is honest,
        // rather than an empty table that reads as "nothing to worry about".
        assert_eq!(got.vars.len(), SCOPED.len());
    }

    #[test]
    fn output_without_a_report_is_not_an_answer() {
        assert!(parse_report("shed", "Permission denied (publickey)").is_err());
    }

    // ---- against a real shell -----------------------------------------------

    /// What a login shell exports after reading the block, with `HOME` set to
    /// `home`. Real `sh`, because the whole design rests on `$HOME` being
    /// expanded by the member's own shell rather than by whoever provisioned the
    /// account, and that is a claim about a shell and not about a string.
    fn exported(home: &str) -> Vec<(String, String)> {
        // A path with no shell metacharacters in it: this one is SOURCED by name
        // rather than passed as argv, and `ThreadId(3)` would put brackets into
        // the command line.
        static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "aura-toolchain-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let rc = dir.join(format!("profile-{}", home.replace('/', "_")));
        std::fs::write(&rc, profile_block()).expect("write");
        let probe = SCOPED
            .iter()
            .map(|s| format!("printf '{}=%s\\n' \"${{{}:-}}\"", s.var, s.var))
            .collect::<Vec<_>>()
            .join("; ");
        let out = std::process::Command::new("sh")
            .arg("-c")
            .arg(format!(". {} ; {probe}", rc.display()))
            .env("HOME", home)
            .output()
            .expect("sh");
        let text = String::from_utf8_lossy(&out.stdout).into_owned();
        assert!(
            out.status.success(),
            "a real shell could not read the block: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        let _ = std::fs::remove_dir_all(&dir);
        text.lines()
            .filter_map(|l| l.split_once('='))
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn two_members_reading_one_block_get_two_disjoint_toolchains() {
        // THE acceptance criterion for this half: the same profile text, read by
        // two members' own shells, resolves to two sets of directories with
        // nothing in common — so neither member's `npm install -g` or
        // `cargo install` can land on the other's.
        let mine = exported("/home/mo");
        let theirs = exported("/home/ana");
        assert_eq!(mine.len(), SCOPED.len(), "a variable was not exported");
        assert_eq!(theirs.len(), SCOPED.len());

        for ((var, mine_path), (_, their_path)) in mine.iter().zip(theirs.iter()) {
            assert!(
                mine_path.starts_with("/home/mo/"),
                "{var} resolved to {mine_path}, which is not under the member's home"
            );
            assert!(their_path.starts_with("/home/ana/"), "{var} → {their_path}");
            assert_ne!(mine_path, their_path, "{var} is the same directory for both");
        }

        // And the judgement agrees with the shell: each is Mine to its own
        // member, and SomeoneElse to the other.
        for (var, path) in &mine {
            let s = SCOPED.iter().find(|s| s.var == *var).expect("known var");
            assert_eq!(scope_of(s, path, "/home/mo"), Scope::Mine, "{var}");
            assert!(scope_of(s, path, "/home/ana").collides(), "{var}");
        }
    }

    #[test]
    fn npm_stops_needing_root_because_its_prefix_is_now_a_members_own() {
        // The one that was genuinely shared however private the homes were:
        // npm's prefix defaults to /usr/local, so `npm install -g` needed sudo
        // and overwrote everybody. After the block it is under the member.
        let mine = exported("/home/mo");
        let prefix = mine
            .iter()
            .find(|(k, _)| k == "NPM_CONFIG_PREFIX")
            .map(|(_, v)| v.clone())
            .expect("npm's prefix was not exported");
        assert_eq!(prefix, "/home/mo/.npm-global");
        assert!(
            !MACHINE_WIDE.iter().any(|m| prefix.starts_with(m)),
            "npm still installs into somewhere everybody writes"
        );
    }

    #[test]
    fn the_block_written_the_way_provisioning_writes_it_keeps_home_unexpanded() {
        // The exact round trip `place_account::provision_script` performs: the
        // assignment, then the append through a DOUBLE-quoted `priv_sh`. If the
        // block's `$HOME` expanded at provision time, every member's profile
        // would point at whoever ran the wizard.
        let dir = std::env::temp_dir().join(format!("aura-provision-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp dir");
        let rc = dir.join(".profile");
        std::fs::write(&rc, "").expect("write");

        let script = format!(
            "{assign}\nHOME_DIR={home}\nRC=.profile\npriv_sh() {{ sh -c \"$1\"; }}\n{snippet}\necho \"scoped=$SCOPED\"\n",
            assign = provision_assign(),
            home = quote(&dir.display().to_string()),
            snippet = provision_snippet(),
        );
        // Run it twice: the second run must find its own mark and add nothing.
        for _ in 0..2 {
            let out = std::process::Command::new("sh")
                .arg("-c")
                .arg(&script)
                // A home that is NOT the member's, to catch an early expansion.
                .env("HOME", "/home/whoever-ran-the-wizard")
                .output()
                .expect("sh");
            assert!(
                String::from_utf8_lossy(&out.stdout).contains("scoped=yes"),
                "the block was not written: {}",
                String::from_utf8_lossy(&out.stderr)
            );
        }

        let written = std::fs::read_to_string(&rc).expect("read");
        assert!(
            !written.contains("/home/whoever-ran-the-wizard"),
            "the provisioning session's own home was baked into the member's profile:\n{written}"
        );
        assert!(
            written.contains("CARGO_HOME=\"$HOME/.cargo\""),
            "$HOME did not survive into the profile:\n{written}"
        );
        assert_eq!(
            written.matches(MARK).count(),
            1,
            "the block was appended twice:\n{written}"
        );
        let _ = std::fs::remove_dir_all(dir);
    }
}
