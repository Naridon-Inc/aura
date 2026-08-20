//! The shell the machine runs, and how its answer is read back.
//!
//! Same shape as [`super::super::place_account`]'s, and for the same reason:
//! the judgement is one script and one parser, and [`Place::ask`] supplies the
//! only thing they cannot — somewhere to run. Written twice, once for a box and
//! once for this laptop, the two would agree until the first fix.
//!
//! [`Place::ask`]: super::super::place::Place::ask
//!
//! ## Three scripts, because they are three different lengths of wait
//!
//! [`base_script`] is a question with a `useradd` in it: it answers in under a
//! second. [`branch_script`] copies directories that may be gigabytes. And
//! [`stamp_script`] writes two lines. A single script would have to be given the
//! longest of those three waits, and a surface asking "is the team's environment
//! built?" would then hang for as long as building it is allowed to take.
//!
//! ## POSIX `sh`, not bash
//!
//! The same text runs under `ssh` on a distro whose `/bin/sh` is dash, and under
//! `sh -c` on this laptop. No arrays, no `local`, no `[[`.

use crate::cloudbox::script::quote;

use super::layers::{private_within, Layer, Secret, PRIVATE, SHARED};

/// Marks the start of the base's report. Split in the rendered script with `""`
/// for the same reason the account's is — a line that contains its own marker
/// matches itself.
const BASE_REPORT: &str = "___AURA_BASE___";

/// Marks the start of a branch's report.
const BRANCH_REPORT: &str = "___AURA_BRANCH___";

/// Where the base writes down which spec it was last built from.
///
/// In the base's own home rather than under `/etc` or `/var`, because it is a
/// fact about that account's directories and it should go away with them. A box
/// whose base was deleted and remade must read as cold, and a stamp that
/// outlived the thing it describes would say it was warm.
pub const STAMP: &str = ".aura-team-base";

/// The account the team's environment is built in.
///
/// A system account, so it is out of the way of `getent passwd` output a person
/// reads and out of the range a member's login can be assigned. It has no
/// password, no key in its `authorized_keys` and no member behind it — nobody
/// ever logs in as the base, which is most of why it holds nothing private.
pub const BASE_LOGIN: &str = "aura-base";

/// What to build, and whether this place may build it.
#[derive(Debug, Clone, PartialEq)]
pub struct BasePlan {
    /// The account that owns the base. `None` means "whoever this session is",
    /// which is what this laptop answers: there is one member here and their own
    /// environment is the only one.
    pub login: Option<String>,
    /// Is the base a thing separate from the member, or is it the member?
    pub shared: bool,
    /// May this call change the machine — make the account, open its home,
    /// write its profile? False makes the whole script a read-out.
    pub may_provision: bool,
}

/// Who is branching from what.
#[derive(Debug, Clone, PartialEq)]
pub struct BranchPlan {
    /// The account holding the team's built environment. `None` is this
    /// session's own, which makes the branch a no-op it reports as such.
    pub base_login: Option<String>,
    /// The member starting from it. `None` is this session's own.
    pub member_login: Option<String>,
    pub may_provision: bool,
}

/// The privilege preamble both scripts open with.
///
/// One copy, because the two scripts have to agree about what "we can change
/// this machine" means. `sudo -n` never prompts: a question asked down a pipe
/// with nobody in front of it is a hang, not a question.
fn privilege() -> &'static str {
    r#"if [ "$(id -u)" -eq 0 ]; then PRIV=root
elif sudo -n true >/dev/null 2>&1; then PRIV=sudo
else PRIV=none
fi
as_root() {
  [ "$PROVISION" = yes ] || return 1
  case "$PRIV" in
    root) "$@" ;;
    sudo) sudo -n "$@" ;;
    *) return 1 ;;
  esac
}
"#
}

/// Ask a box where an account lives rather than assuming `/home/<login>`: it is
/// wrong on a box with a non-standard layout and wrong for every account whose
/// name is not its directory.
fn home_of() -> &'static str {
    r#"home_of() {
  if [ "$ME" = "$1" ]; then printf '%s' "$HOME"; return; fi
  AURA_H=$(getent passwd "$1" 2>/dev/null | cut -d: -f6)
  [ -n "$AURA_H" ] || AURA_H="/home/$1"
  printf '%s' "$AURA_H"
}
"#
}

/// A list of paths as shell words, for a `for` loop.
fn words<'a>(paths: impl Iterator<Item = &'a str>) -> String {
    paths.map(quote).collect::<Vec<_>>().join(" ")
}

/// The layers a tool falls back from when they are missing, under the base's
/// home, quoted for where they are being spliced.
///
/// Two spellings for the same reason [`super::super::place_toolchain`] has two:
/// double quotes for bare words in the script, single quotes for inside a
/// `sh -c "…"`, where the surrounding double quotes are already expanding
/// `$HOME_DIR` and single quotes are what keep the result one word.
fn made_dirs(q: char) -> String {
    SHARED
        .into_iter()
        .filter(|l| l.make)
        .map(|l| format!("{q}$HOME_DIR/{}{q}", l.under))
        .collect::<Vec<_>>()
        .join(" ")
}

/// Make sure the team's base account exists and is somewhere a member can start
/// from, then report what it holds.
///
/// Idempotent in the sense that matters: run against a base that already exists,
/// this is how anybody *verifies* the team's environment is still shared and
/// still clean — not a second attempt at creating it. Every step asks before it
/// acts, and every step reports what it found rather than what it did.
pub fn base_script(plan: &BasePlan) -> String {
    let login = quote(plan.login.as_deref().unwrap_or(""));
    let shared = if plan.shared { "yes" } else { "no" };
    let may_provision = if plan.may_provision { "yes" } else { "no" };

    format!(
        r#"set -u
LOGIN={login}
SHARED={shared}
PROVISION={may_provision}
# The toolchain block, named before it is used and never inlined into a
# double-quoted command: its `$HOME` belongs to the account that will READ the
# profile. See `place_toolchain`.
{toolchain_assign}
ME=$(id -un)
[ -n "$LOGIN" ] || LOGIN="$ME"

{privilege}{home_of}
CREATED=no
if ! id -u "$LOGIN" >/dev/null 2>&1; then
  if [ "$PROVISION" != yes ]; then
    echo "this machine has no shared environment for the team, and this place does not make one" >&2
    exit 4
  fi
  if [ "$PRIV" = none ]; then
    echo "building the team's environment once, so the next person doesn't, needs root. Ask whoever administers this machine to run: sudo useradd --system --create-home --shell /bin/bash $LOGIN" >&2
    exit 2
  fi
  as_root useradd --system --create-home --shell /bin/bash "$LOGIN" >&2 || exit 3
  CREATED=yes
fi
HOME_DIR=$(home_of "$LOGIN")

# Readable by everyone here, writable by nobody but the base itself. Deliberate,
# and safe for exactly one reason: the base holds nothing private. The `carries=`
# lines below are where that stops being an assumption — nothing is copied out of
# a base that reports one.
as_root chmod 755 "$HOME_DIR" >/dev/null 2>&1 || true
READABLE=no
case "$(ls -ld "$HOME_DIR" 2>/dev/null | cut -c1-10)" in
  ??????r?x*) READABLE=yes ;;
esac

# The same profile block every member gets, so what the spec installs lands in
# the base's own directories instead of somewhere machine-wide. Without it a
# `cargo install` here would write to whatever CARGO_HOME the connecting login
# had, and the base would end up holding nothing.
SCOPED=no
RC="$HOME_DIR/.profile"
if grep -qF {mark} "$RC" 2>/dev/null; then
  SCOPED=yes
elif as_root sh -c "printf '%s' '$AURA_TOOLCHAIN_BLOCK' >> '$RC'" >/dev/null 2>&1; then
  SCOPED=yes
fi
as_root chown "$LOGIN" "$RC" >/dev/null 2>&1 || true

# The directories those variables name. npm falls back to /usr/local when its
# prefix does not exist, so a base whose prefix was never made installs the
# team's packages onto the machine instead of into the base.
as_root sh -c "mkdir -p {made_within_root}" >/dev/null 2>&1 || true
as_root chown -R "$LOGIN" {made} >/dev/null 2>&1 || true

echo "{report_head}""{report_tail}"
echo "login=$LOGIN"
echo "home=$HOME_DIR"
echo "created=$CREATED"
echo "shared=$SHARED"
echo "readable=$READABLE"
echo "scoped=$SCOPED"
echo "you=$ME"
for P in {private}; do
  if [ -e "$HOME_DIR/$P" ]; then echo "carries=$P"; fi
done
for P in {shared_paths}; do
  if [ -d "$HOME_DIR/$P" ]; then
    if [ -n "$(ls -A "$HOME_DIR/$P" 2>/dev/null)" ]; then echo "holds=$P"; fi
  elif [ -f "$HOME_DIR/$P" ]; then
    echo "holds=$P"
  fi
done
if [ -f "$HOME_DIR/{stamp}" ]; then
  while IFS= read -r L; do
    case "$L" in
      version=*|digest=*) echo "stamp_$L" ;;
    esac
  done < "$HOME_DIR/{stamp}"
fi
"#,
        toolchain_assign = super::super::place_toolchain::provision_assign(),
        privilege = privilege(),
        home_of = home_of(),
        mark = quote(super::super::place_toolchain::MARK),
        made_within_root = made_dirs('\''),
        made = made_dirs('"'),
        report_head = &BASE_REPORT[..8],
        report_tail = &BASE_REPORT[8..],
        private = words(PRIVATE.iter().map(|s| s.under)),
        shared_paths = words(SHARED.iter().map(|l| l.under)),
        stamp = STAMP,
    )
}

/// Write down which spec the base was built from.
///
/// Its own script because it runs after the install, and only when the install
/// finished at spec. A stamp written alongside the build would claim a base was
/// warm because somebody asked for it to be, which is the one thing this file
/// must not say — the next member reads it and skips the install.
pub fn stamp_script(login: Option<&str>, version: u32, digest: &str) -> String {
    format!(
        r#"set -u
LOGIN={login}
PROVISION=yes
ME=$(id -un)
[ -n "$LOGIN" ] || LOGIN="$ME"

{privilege}{home_of}
HOME_DIR=$(home_of "$LOGIN")
STAMP="$HOME_DIR/{stamp}"
if [ "$ME" = "$LOGIN" ]; then
  printf 'version=%s\ndigest=%s\n' {version} {digest} > "$STAMP"
else
  as_root sh -c "printf 'version=%s\ndigest=%s\n' {version} {digest} > '$STAMP'" || exit 5
fi
as_root chown "$LOGIN" "$STAMP" >/dev/null 2>&1 || true
"#,
        login = quote(login.unwrap_or("")),
        privilege = privilege(),
        home_of = home_of(),
        stamp = STAMP,
        version = version,
        digest = quote(digest),
    )
}

/// Start a member from what the team already built.
///
/// The rule is one sentence: **seed what the member does not have, and never
/// overwrite what they do.** A member who already has their own `.cargo` keeps
/// it — they may have pinned something, or published to it — and a member who
/// has only the empty directory `place_account` made gets the team's, because an
/// empty directory is not somebody having something.
pub fn branch_script(plan: &BranchPlan) -> String {
    let base = quote(plan.base_login.as_deref().unwrap_or(""));
    let member = quote(plan.member_login.as_deref().unwrap_or(""));
    let may_provision = if plan.may_provision { "yes" } else { "no" };

    format!(
        r#"set -u
BASE={base}
MEMBER={member}
PROVISION={may_provision}
ME=$(id -un)
[ -n "$BASE" ] || BASE="$ME"
[ -n "$MEMBER" ] || MEMBER="$ME"

{privilege}{home_of}
# Enough rights to write into the member's own home: being root will do, and so
# will being the member.
priv_sh() {{
  [ "$PROVISION" = yes ] || return 1
  if [ "$ME" = "$MEMBER" ]; then sh -c "$1"; else as_root sh -c "$1"; fi
}}

# A private path that lives inside a shared one, taken back out of the copy and
# only out of the copy. A sweep over the member's whole home would delete
# credentials this call never put there.
scrub() {{
  case "$1" in
{scrub}    *) : ;;
  esac
}}

seed() {{
  LAYER="$1"
  SRC="$BASE_HOME/$LAYER"
  DST="$MEMBER_HOME/$LAYER"
  if [ ! -e "$SRC" ]; then echo "absent=$LAYER"; return; fi
  if [ -d "$SRC" ] && [ -z "$(ls -A "$SRC" 2>/dev/null)" ]; then echo "absent=$LAYER"; return; fi
  # An empty directory is what making the member's account leaves behind, not the
  # member already having something.
  if [ -d "$DST" ] && [ -z "$(ls -A "$DST" 2>/dev/null)" ]; then
    priv_sh "rmdir '$DST'" >/dev/null 2>&1 || true
  fi
  if [ -e "$DST" ]; then echo "kept=$LAYER"; return; fi
  PARENT=$(dirname "$DST")
  priv_sh "mkdir -p '$PARENT'" >/dev/null 2>&1 || true
  # A copy-on-write clone where the filesystem has one, a plain copy where it
  # does not. Either way the member owns their own files afterwards: sharing the
  # bytes is an optimisation, sharing the file is a teammate able to change what
  # is under you.
  if priv_sh "cp -a --reflink=auto '$SRC' '$DST'" >/dev/null 2>&1 ||
     priv_sh "cp -a '$SRC' '$DST'" >/dev/null 2>&1; then
    as_root chown -R "$MEMBER" "$DST" >/dev/null 2>&1 || true
    scrub "$LAYER"
    echo "seeded=$LAYER"
  else
    echo "failed=$LAYER"
  fi
}}

BASE_HOME=$(home_of "$BASE")
MEMBER_HOME=$(home_of "$MEMBER")

echo "{report_head}""{report_tail}"
echo "base=$BASE"
echo "base_home=$BASE_HOME"
echo "member=$MEMBER"
echo "member_home=$MEMBER_HOME"
echo "you=$ME"

if [ "$BASE" = "$MEMBER" ]; then
  echo "same=yes"
  exit 0
fi
echo "same=no"

if [ ! -d "$BASE_HOME" ]; then
  echo "refused=this machine has no shared environment for the team yet"
  exit 0
fi

# The same check the base's own report makes, asked again at the moment it
# matters. That report can be minutes old, and what this is guarding against is a
# file that appeared since.
CARRIES=
for P in {private}; do
  if [ -e "$BASE_HOME/$P" ]; then CARRIES="$CARRIES $P"; echo "carries=$P"; fi
done
if [ -n "$CARRIES" ]; then
  echo "refused=the team's shared environment is holding something that belongs to one person, so nothing was copied out of it"
  exit 0
fi

for E in {shared_paths}; do
  seed "$E"
done
"#,
        privilege = privilege(),
        home_of = home_of(),
        scrub = scrub_cases(),
        report_head = &BRANCH_REPORT[..8],
        report_tail = &BRANCH_REPORT[8..],
        private = words(PRIVATE.iter().map(|s| s.under)),
        shared_paths = words(SHARED.iter().map(|l| l.under)),
    )
}

/// One `case` arm per layer that has something private inside it.
fn scrub_cases() -> String {
    let mut out = String::new();
    for layer in SHARED {
        let inside: Vec<Secret> = private_within(&layer);
        if inside.is_empty() {
            continue;
        }
        let paths = inside
            .iter()
            .map(|s| format!("'$MEMBER_HOME/{}'", s.under))
            .collect::<Vec<_>>()
            .join(" ");
        out.push_str(&format!(
            "    {}) priv_sh \"rm -rf {paths}\" >/dev/null 2>&1 || true ;;\n",
            layer.under
        ));
    }
    out
}

/// What the base said about itself.
#[derive(Debug, Clone, PartialEq)]
pub struct BaseReport {
    pub login: String,
    pub home: String,
    pub created: bool,
    pub shared: bool,
    pub readable: bool,
    pub scoped: bool,
    pub you: String,
    /// Private paths found in the base. Must be empty; anything here stops a
    /// branch.
    pub carries: Vec<String>,
    /// Shared layers the base actually has something in.
    pub holds: Vec<String>,
    pub stamp_version: u32,
    pub stamp_digest: String,
}

/// What a branch actually did.
#[derive(Debug, Clone, PartialEq)]
pub struct BranchReport {
    pub base: String,
    pub base_home: String,
    pub member: String,
    pub member_home: String,
    pub you: String,
    /// Is the base the member? True on a place with one member, where there is
    /// nothing to copy and nothing missing.
    pub same: bool,
    pub seeded: Vec<String>,
    pub kept: Vec<String>,
    pub absent: Vec<String>,
    pub failed: Vec<String>,
    pub carries: Vec<String>,
    /// Why nothing was copied, when nothing was. Empty otherwise.
    pub refused: String,
}

/// Read the base's report back.
pub fn parse_base(out: &str) -> Result<BaseReport, String> {
    let body = after(out, BASE_REPORT)
        .ok_or("the machine did not say what the team's environment is")?;
    let login = field(body, "login");
    if login.is_empty() {
        return Err("the machine did not name the account the team's environment is built in".into());
    }
    let home = field(body, "home");
    Ok(BaseReport {
        home: if home.is_empty() {
            format!("/home/{login}")
        } else {
            home
        },
        created: field(body, "created") == "yes",
        shared: field(body, "shared") == "yes",
        readable: field(body, "readable") == "yes",
        scoped: field(body, "scoped") == "yes",
        you: match field(body, "you") {
            y if y.is_empty() => login.clone(),
            y => y,
        },
        carries: fields(body, "carries"),
        holds: fields(body, "holds"),
        // A stamp we cannot read is a base we have to treat as cold. Rebuilding
        // an environment that was already there costs minutes; skipping one that
        // was not costs a member a machine that cannot build the project.
        stamp_version: field(body, "stamp_version").parse().unwrap_or(0),
        stamp_digest: field(body, "stamp_digest"),
        login,
    })
}

/// Read a branch's report back.
pub fn parse_branch(out: &str) -> Result<BranchReport, String> {
    let body =
        after(out, BRANCH_REPORT).ok_or("the machine did not say what it started this member from")?;
    let member = field(body, "member");
    if member.is_empty() {
        return Err("the machine did not name the member it was starting".into());
    }
    Ok(BranchReport {
        base: field(body, "base"),
        base_home: field(body, "base_home"),
        member_home: field(body, "member_home"),
        you: match field(body, "you") {
            y if y.is_empty() => member.clone(),
            y => y,
        },
        same: field(body, "same") == "yes",
        seeded: fields(body, "seeded"),
        kept: fields(body, "kept"),
        absent: fields(body, "absent"),
        failed: fields(body, "failed"),
        carries: fields(body, "carries"),
        refused: field(body, "refused"),
        member,
    })
}

/// Everything after the marker. What comes before is the box's own noise — a
/// MOTD, a sudo lecture, whatever the profile prints — and is dropped rather
/// than parsed around.
fn after<'a>(out: &'a str, marker: &str) -> Option<&'a str> {
    out.split_once(marker).map(|(_, rest)| rest)
}

fn field(body: &str, key: &str) -> String {
    fields(body, key).into_iter().next().unwrap_or_default()
}

fn fields(body: &str, key: &str) -> Vec<String> {
    body.lines()
        .filter_map(|l| l.trim().split_once('='))
        .filter(|(k, _)| *k == key)
        .map(|(_, v)| v.trim().to_string())
        .collect()
}

/// Is this a digest a script may be handed?
///
/// It is spliced into a command that runs as root, and it arrives from a file in
/// a checkout. `sha256:` plus hex is all it is ever meant to be, and anything
/// else is either a bug above or a file somebody edited.
pub fn is_digest(v: &str) -> bool {
    !v.is_empty()
        && v.len() <= 128
        && v.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, ':' | '.' | '_' | '-'))
}

/// Which shared layer a path names, for a surface that has a path and wants the
/// sentence that goes with it.
pub fn layer_named(under: &str) -> Option<Layer> {
    SHARED.into_iter().find(|l| l.under == under)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shared_plan() -> BasePlan {
        BasePlan {
            login: Some(BASE_LOGIN.into()),
            shared: true,
            may_provision: true,
        }
    }

    #[test]
    fn a_base_that_does_not_exist_is_made_once_and_owned_by_nobody() {
        let s = base_script(&shared_plan());
        assert!(
            s.contains("useradd --system --create-home --shell /bin/bash \"$LOGIN\""),
            "{s}"
        );
        // No key is ever installed for it and no password is ever set, which is
        // most of why it can be a directory the whole team reads: there is no
        // sign-in for it to hold.
        assert!(!s.contains("authorized_keys"), "the base was given a way in");
        assert!(!s.contains("passwd -d"), "the base was given a password");
    }

    #[test]
    fn a_place_that_may_change_nothing_only_reads() {
        // What this laptop gets. Everything that would touch the machine goes
        // through `as_root`, which refuses outright when PROVISION is not yes —
        // so a read-out cannot chmod the home directory of the person sitting at
        // the computer.
        let s = base_script(&BasePlan {
            login: None,
            shared: false,
            may_provision: false,
        });
        assert!(s.contains("PROVISION=no"), "{s}");
        assert!(s.contains(r#"[ "$PROVISION" = yes ] || return 1"#), "{s}");
        for changes in ["chmod 755", "mkdir -p", "chown"] {
            for line in s.lines().filter(|l| l.contains(changes)) {
                assert!(
                    line.trim_start().starts_with("as_root")
                        || line.contains("sudo useradd"),
                    "{changes} runs outside as_root: {line}"
                );
            }
        }
    }

    #[test]
    fn the_base_installs_into_its_own_directories_rather_than_the_machines() {
        // The whole reason the base is an account. Without the profile block a
        // `cargo install` run here writes to whatever CARGO_HOME the connecting
        // login had, and the base ends up holding nothing to branch from.
        let s = base_script(&shared_plan());
        assert!(s.contains("AURA_TOOLCHAIN_BLOCK="), "{s}");
        assert!(s.contains(r#"$HOME_DIR/.profile"#), "{s}");
    }

    #[test]
    fn the_directories_a_tool_falls_back_from_are_made_before_anything_installs() {
        let s = base_script(&shared_plan());
        for layer in SHARED.iter().filter(|l| l.make) {
            assert!(
                s.contains(&format!("$HOME_DIR/{}", layer.under)),
                "{} is never made in the base",
                layer.under
            );
        }
    }

    #[test]
    fn the_base_is_asked_whether_it_is_holding_anything_of_anybodys() {
        let s = base_script(&shared_plan());
        for secret in PRIVATE {
            assert!(
                s.contains(&quote(secret.under)),
                "the base is never checked for {}",
                secret.under
            );
        }
        assert!(s.contains("carries=$P"), "{s}");
    }

    #[test]
    fn a_branch_copies_only_what_the_team_declared_shareable() {
        let s = branch_script(&BranchPlan {
            base_login: Some(BASE_LOGIN.into()),
            member_login: Some("mo".into()),
            may_provision: true,
        });
        for layer in SHARED {
            assert!(
                s.contains(&quote(layer.under)),
                "{} is never branched",
                layer.under
            );
        }
        // And the copy is a loop over that list, so nothing outside it can be
        // reached: there is no `cp -a "$BASE_HOME"/. ` anywhere.
        assert!(!s.contains(r#""$BASE_HOME"/."#), "{s}");
        assert!(!s.contains("$BASE_HOME/*"), "{s}");
    }

    #[test]
    fn a_branch_refuses_a_base_that_is_holding_somebodys_credential() {
        let s = branch_script(&BranchPlan {
            base_login: Some(BASE_LOGIN.into()),
            member_login: Some("mo".into()),
            may_provision: true,
        });
        // The refusal comes BEFORE the seeding loop, or it is not a refusal.
        let refused = s.find("refused=the team's shared environment").expect("refusal");
        let seeding = s.find("seed \"$E\"").expect("seeding");
        assert!(refused < seeding, "the copy happens before the check");
    }

    #[test]
    fn the_crates_io_token_is_taken_out_of_the_cache_that_would_carry_it() {
        let s = branch_script(&BranchPlan {
            base_login: Some(BASE_LOGIN.into()),
            member_login: Some("mo".into()),
            may_provision: true,
        });
        assert!(
            s.contains("$MEMBER_HOME/.cargo/credentials.toml"),
            "a publish token would come across with the crate cache: {s}"
        );
        // Out of the COPY, not out of the member's home generally — a sweep would
        // delete a credential this call never put there.
        assert!(s.contains(r#"    .cargo) priv_sh "rm -rf "#), "{s}");
    }

    #[test]
    fn a_member_who_already_has_something_keeps_it() {
        let s = branch_script(&BranchPlan {
            base_login: Some(BASE_LOGIN.into()),
            member_login: Some("mo".into()),
            may_provision: true,
        });
        assert!(s.contains(r#"if [ -e "$DST" ]; then echo "kept=$LAYER"; return; fi"#), "{s}");
        // Except an empty directory, which is what making their account leaves
        // behind and is not the member having anything.
        assert!(s.contains(r#"priv_sh "rmdir '$DST'""#), "{s}");
    }

    #[test]
    fn one_member_on_a_place_branches_from_themselves_and_nothing_happens() {
        let s = branch_script(&BranchPlan {
            base_login: None,
            member_login: None,
            may_provision: false,
        });
        assert!(s.contains(r#"if [ "$BASE" = "$MEMBER" ]; then"#), "{s}");
        let same = s.find("same=yes").expect("same");
        let seeding = s.find("seed \"$E\"").expect("seeding");
        assert!(same < seeding, "a place with one member still copies");
    }

    #[test]
    fn the_marker_does_not_match_itself() {
        // Both scripts print their own marker. Written whole, the `echo` line
        // matches the split the parser makes, and everything real ends up on the
        // wrong side of it.
        for s in [
            base_script(&shared_plan()),
            branch_script(&BranchPlan {
                base_login: Some(BASE_LOGIN.into()),
                member_login: Some("mo".into()),
                may_provision: true,
            }),
        ] {
            assert!(!s.contains(BASE_REPORT), "the base marker is written whole");
            assert!(!s.contains(BRANCH_REPORT), "the branch marker is written whole");
        }
    }

    #[test]
    fn neither_script_carries_a_secret() {
        // These run unattended on somebody's machine and their text ends up in
        // logs. The private list is PATHS — names of places a credential would
        // be — and nothing here may be a credential itself.
        for s in [
            base_script(&shared_plan()),
            stamp_script(Some(BASE_LOGIN), 4, "sha256:abc"),
            branch_script(&BranchPlan {
                base_login: Some(BASE_LOGIN.into()),
                member_login: Some("mo".into()),
                may_provision: true,
            }),
        ] {
            let lowered = s.to_lowercase();
            for leak in ["-----begin", "aws_secret", "password=", "authorization:"] {
                assert!(!lowered.contains(leak), "a script says {leak:?}");
            }
        }
    }

    #[test]
    fn a_stamp_is_two_lines_and_a_digest_is_checked_before_it_gets_there() {
        let s = stamp_script(Some(BASE_LOGIN), 7, "sha256:deadbeef");
        assert!(s.contains("version=%s"), "{s}");
        assert!(s.contains("'sha256:deadbeef'"), "{s}");
        assert!(is_digest("sha256:deadbeef"));
        // The shapes that would end the quoting early, or add a second command.
        assert!(!is_digest("sha256:dead'beef"));
        assert!(!is_digest("$(rm -rf /)"));
        assert!(!is_digest(""));
    }

    #[test]
    fn a_report_is_read_back_whole_past_whatever_the_box_printed_first() {
        let out = format!(
            "Welcome to Ubuntu\nsudo: a terminal is required\n{BASE_REPORT}\n\
             login=aura-base\nhome=/home/aura-base\ncreated=yes\nshared=yes\nreadable=yes\n\
             scoped=yes\nyou=ubuntu\nholds=.cargo\nholds=.rustup\nstamp_version=4\n\
             stamp_digest=sha256:abc\n"
        );
        let r = parse_base(&out).unwrap();
        assert_eq!(r.login, "aura-base");
        assert_eq!(r.home, "/home/aura-base");
        assert!(r.created && r.shared && r.readable && r.scoped);
        assert_eq!(r.you, "ubuntu");
        assert_eq!(r.holds, vec![".cargo", ".rustup"]);
        assert!(r.carries.is_empty());
        assert_eq!(r.stamp_version, 4);
        assert_eq!(r.stamp_digest, "sha256:abc");
    }

    #[test]
    fn a_base_holding_a_credential_says_which_one() {
        let out = format!(
            "{BASE_REPORT}\nlogin=aura-base\nhome=/home/aura-base\nshared=yes\n\
             carries=.config/gh\ncarries=.npmrc\n"
        );
        let r = parse_base(&out).unwrap();
        assert_eq!(r.carries, vec![".config/gh", ".npmrc"]);
    }

    #[test]
    fn a_box_that_said_nothing_is_not_read_as_a_base_that_exists() {
        assert!(parse_base("").is_err());
        assert!(parse_base(&format!("{BASE_REPORT}\nhome=/home/x\n")).is_err());
        assert!(parse_branch("").is_err());
    }

    #[test]
    fn a_branch_report_says_what_came_across_and_what_did_not() {
        let out = format!(
            "{BRANCH_REPORT}\nbase=aura-base\nbase_home=/home/aura-base\nmember=ana\n\
             member_home=/home/ana\nyou=ubuntu\nsame=no\nseeded=.cargo\nseeded=.rustup\n\
             kept=.npm\nabsent=.proto\n"
        );
        let r = parse_branch(&out).unwrap();
        assert_eq!(r.member, "ana");
        assert!(!r.same);
        assert_eq!(r.seeded, vec![".cargo", ".rustup"]);
        assert_eq!(r.kept, vec![".npm"]);
        assert_eq!(r.absent, vec![".proto"]);
        assert!(r.failed.is_empty());
        assert!(r.refused.is_empty());
    }

    #[test]
    fn every_layer_a_report_can_name_has_a_sentence_to_go_with_it() {
        // A surface shows "started you from the crates cargo already downloaded",
        // not ".cargo". A layer the parser can hand back and the table cannot
        // describe is a row of a path in the UI.
        for layer in SHARED {
            assert!(layer_named(layer.under).is_some(), "{}", layer.under);
        }
        assert!(layer_named(".config/gh").is_none());
    }

    #[test]
    fn every_rendered_script_parses_as_posix_sh() {
        // The box's `/bin/sh` may be dash. A construct only bash accepts fails
        // there and nowhere here, which is the worst place to find out: the
        // first member's install has already run by then.
        let mut scripts = vec![
            ("stamp", stamp_script(Some(BASE_LOGIN), 4, "sha256:abcd")),
            ("stamp-here", stamp_script(None, 1, "sha256:0")),
        ];
        for may_provision in [true, false] {
            for shared in [true, false] {
                scripts.push((
                    "base",
                    base_script(&BasePlan {
                        login: shared.then(|| BASE_LOGIN.to_string()),
                        shared,
                        may_provision,
                    }),
                ));
                scripts.push((
                    "branch",
                    branch_script(&BranchPlan {
                        base_login: shared.then(|| BASE_LOGIN.to_string()),
                        member_login: shared.then(|| "mo".to_string()),
                        may_provision,
                    }),
                ));
            }
        }
        for (i, (what, text)) in scripts.iter().enumerate() {
            let path = std::env::temp_dir().join(format!("aura-base-{what}-{i}.sh"));
            std::fs::write(&path, text).expect("write the script out");
            let out = std::process::Command::new("sh")
                .arg("-n")
                .arg(&path)
                .output()
                .expect("run sh -n");
            let _ = std::fs::remove_file(&path);
            assert!(
                out.status.success(),
                "the {what} script does not parse:\n{}",
                String::from_utf8_lossy(&out.stderr)
            );
        }
    }

    /// The acceptance criterion, run for real against two directories on this
    /// disk: a base holding what an install produced, and a member whose home
    /// holds the empty directories making their account left behind.
    ///
    /// Not a shared box, and deliberately so — what is under test is the SCRIPT,
    /// and the script is the same text either way. A box adds `useradd`, `sudo`
    /// and an ssh hop, none of which decide whether a member ends up holding the
    /// team's crates; this does.
    #[test]
    fn a_member_ends_up_holding_what_the_team_already_downloaded() {
        let Some(box_) = FakeBox::make("warm") else {
            return;
        };
        box_.base_has(".cargo/registry/cache/serde-1.0.crate", "a crate nobody wants twice");
        box_.base_has(".rustup/toolchains/stable/bin/rustc", "a toolchain");
        box_.base_has(".npm/_cacache/index-v5/aa/bb", "a tarball");
        box_.base_has(".tool-versions", "node 22.0.0\n");
        box_.base_has(".npm-global/bin/tsc", "the team's version");
        // What `place_account` leaves behind: the directories, and nothing in
        // them. An empty directory is not the member already having something.
        box_.member_has_dir(".cargo");
        box_.member_has_dir(".rustup");
        // Except this one, which they filled themselves and must keep — the base
        // has its own copy, so this is the case where the two really collide.
        box_.member_has(".npm-global/bin/tsc", "the version they pinned");

        let report = box_.branch();
        assert!(!report.same, "two different logins read as one");
        assert!(report.refused.is_empty(), "refused: {}", report.refused);
        assert!(report.failed.is_empty(), "failed: {:?}", report.failed);

        for layer in [".cargo", ".rustup", ".npm", ".tool-versions"] {
            assert!(
                report.seeded.iter().any(|s| s == layer),
                "{layer} did not come across: {report:?}"
            );
        }
        assert!(
            report.kept.iter().any(|k| k == ".npm-global"),
            "the member's own pinned install was not kept: {report:?}"
        );
        assert!(
            report.absent.iter().any(|a| a == ".gem"),
            "a layer the base never had was not reported as absent: {report:?}"
        );

        // And the point of all of it: the bytes are there, so nothing downloads
        // them again.
        assert_eq!(
            box_.member_read(".cargo/registry/cache/serde-1.0.crate"),
            Some("a crate nobody wants twice".to_string())
        );
        assert_eq!(
            box_.member_read(".rustup/toolchains/stable/bin/rustc"),
            Some("a toolchain".to_string())
        );
        assert_eq!(
            box_.member_read(".tool-versions"),
            Some("node 22.0.0\n".to_string())
        );
        assert_eq!(
            box_.member_read(".npm-global/bin/tsc"),
            Some("the version they pinned".to_string()),
            "the member's own install was overwritten by the team's"
        );
    }

    #[test]
    fn a_token_inside_a_shared_cache_does_not_ride_across_with_it() {
        // `.cargo` is shared and `.cargo/credentials.toml` is inside it. The base
        // is refused outright for holding one — this is the second net, for a
        // token that reached the copy some other way: it is taken back out of
        // the member's copy, and only out of the copy.
        let Some(box_) = FakeBox::make("scrub") else {
            return;
        };
        box_.base_has(".cargo/registry/cache/x.crate", "a crate");
        box_.base_has(".cargo/credentials.toml", "[registry]\ntoken = \"…\"\n");
        // A credential the member had before any of this, which a sweep over
        // their home rather than over the copy would have deleted.
        box_.member_has(".ssh/id_ed25519", "theirs, and none of our business");

        let report = box_.branch();
        assert!(
            report.carries.iter().any(|c| c == ".cargo/credentials.toml"),
            "the base was not caught holding a token: {report:?}"
        );
        assert!(
            !report.refused.is_empty(),
            "a base holding a token was copied out of anyway"
        );
        assert!(
            report.seeded.is_empty(),
            "something crossed out of a base that was refused: {report:?}"
        );
        assert_eq!(
            box_.member_read(".ssh/id_ed25519"),
            Some("theirs, and none of our business".to_string()),
            "the member's own key was touched"
        );
    }

    /// Two directories standing in for two accounts, so the branch script can be
    /// run for real without a machine, a login or root.
    ///
    /// `getent` is stubbed rather than mocked out of the script: the script asks
    /// a box where an account lives instead of assuming `/home/<login>`, and a
    /// test that skipped that would be testing a different script from the one
    /// that ships. `sudo` is stubbed to fail for the same honesty — nothing here
    /// needs root, and a machine where `sudo -n` happens to work must not make
    /// this pass for a reason the box would not have.
    struct FakeBox {
        dir: std::path::PathBuf,
        me: String,
    }

    impl FakeBox {
        /// `None` where the script's own tools are not on this machine, which is
        /// not a failure: `sh -n` above still proves it parses, and the box it
        /// runs on is Linux.
        fn make(what: &str) -> Option<Self> {
            let me = String::from_utf8(
                std::process::Command::new("id").arg("-un").output().ok()?.stdout,
            )
            .ok()?
            .trim()
            .to_string();
            if me.is_empty() {
                return None;
            }
            let dir = std::env::temp_dir().join(format!("aura-base-{what}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(dir.join("base")).ok()?;
            std::fs::create_dir_all(dir.join("member")).ok()?;

            let bin = dir.join("bin");
            std::fs::create_dir_all(&bin).ok()?;
            let base_home = dir.join("base");
            write_program(
                &bin.join("getent"),
                &format!(
                    "#!/bin/sh\n[ \"$1\" = passwd ] || exit 2\n\
                     [ \"$2\" = {BASE_LOGIN} ] || exit 2\n\
                     echo '{BASE_LOGIN}:x:900:900::{}:/bin/bash'\n",
                    base_home.display()
                ),
            )?;
            write_program(&bin.join("sudo"), "#!/bin/sh\nexit 1\n")?;
            Some(FakeBox { dir, me })
        }

        fn base_has(&self, rel: &str, body: &str) {
            put(&self.dir.join("base").join(rel), body);
        }

        fn member_has(&self, rel: &str, body: &str) {
            put(&self.dir.join("member").join(rel), body);
        }

        fn member_has_dir(&self, rel: &str) {
            let _ = std::fs::create_dir_all(self.dir.join("member").join(rel));
        }

        fn member_read(&self, rel: &str) -> Option<String> {
            std::fs::read_to_string(self.dir.join("member").join(rel)).ok()
        }

        /// Run the real script, as the member, with the base a login away.
        fn branch(&self) -> BranchReport {
            let script = branch_script(&BranchPlan {
                base_login: Some(BASE_LOGIN.to_string()),
                member_login: Some(self.me.clone()),
                may_provision: true,
            });
            let path = std::env::var("PATH").unwrap_or_default();
            let out = std::process::Command::new("sh")
                .arg("-c")
                .arg(&script)
                .env("HOME", self.dir.join("member"))
                .env("PATH", format!("{}:{path}", self.dir.join("bin").display()))
                .output()
                .expect("run the branch script");
            let said = String::from_utf8_lossy(&out.stdout).into_owned();
            parse_branch(&said).unwrap_or_else(|e| {
                panic!("{e}\nstdout:\n{said}\nstderr:\n{}", String::from_utf8_lossy(&out.stderr))
            })
        }
    }

    impl Drop for FakeBox {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn put(path: &std::path::Path, body: &str) {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        std::fs::write(path, body).expect("lay a file down in the fake box");
    }

    fn write_program(path: &std::path::Path, body: &str) -> Option<()> {
        std::fs::write(path, body).ok()?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).ok()?;
        }
        Some(())
    }
}
