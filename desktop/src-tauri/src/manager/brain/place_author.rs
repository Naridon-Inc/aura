//! Whose name ends up on the commit.
//!
//! The tenth question in the runtime contract, and the half of "push as myself"
//! that [`super::place_git`] deliberately did not answer: that one settles
//! **whose token goes over the wire**, this one settles **whose name is written
//! into the commit object before it gets there**. They are genuinely different
//! failures. A push with the right credential and the wrong author lands under
//! the right account with somebody else's name in `git log` forever, and a
//! credential fix cannot reach back and correct it.
//!
//! ## What was already right, and where it stopped
//!
//! `cmd_identity::git_identity_set` writes repo-LOCAL `user.name` / `user.email`
//! from the signed-in Aura account, never `--global`, and that judgement is
//! correct — adopting your account identity in one repo must not silently change
//! who you are in every other repo on the disk. What it could not do is leave the
//! laptop. It shelled `git` in a local directory, so the moment the work moved to
//! a box the identity stayed behind, and the commit came back authored by
//! whoever the box thought it was.
//!
//! Which, on a runner box, was a hardcoded person: `aura-runner/aws/bootstrap.sh`
//! set `Aura Runner <runner@auravcs.com>` on the clone it made. Every commit from
//! that machine carried it. That is worse than an unset identity, because it is
//! well-formed — it looks like a person, it never errors, and nothing downstream
//! has any way to notice the member is missing.
//!
//! ## Why the write is a script and not a `Command`
//!
//! Because "set the author" has to be one implementation for both place-modes,
//! and [`Place::ask`] is the only thing in this file that knows whether "here" is
//! this disk or a machine at the end of a multiplexed connection. A local arm
//! that shelled `git` directly and a remote arm that sent a script would agree
//! for exactly as long as nobody fixed anything — see [`crate::cloudbox::sole_ssh`]
//! for the same rule applied to the transport. So [`survey_script`] and
//! [`adopt_script`] are plain strings, [`parse_facts`] is a plain function, and
//! `git_identity_set` is now a caller of this seam rather than a second one.
//!
//! ## Never `--global`, and now provably
//!
//! The repo-local rule was a comment before. It is
//! `nothing_here_ever_writes_a_global_git_config` now: no script this file emits
//! may contain `--global` or `--system`, asserted over both of them, because a
//! seam that can reach a box is a seam that could rewrite the identity on a
//! machine ten other people share.
//!
//! ## Why "the machine's own name" is a value rather than a bug
//!
//! [`Authorship`] has four cases, not two. A commit authored by the box is not
//! the same answer as no author at all, and neither is the same as a *different
//! person* — a teammate's identity left in a shared checkout is the one case
//! where overwriting without asking would be wrong. Each of them leads somewhere
//! different, so each of them is sayable.

use serde::{Deserialize, Serialize};

use super::place::Place;
use crate::cloudbox::script::quote;

/// Marks the start of the machine-readable report. Split in the rendered script
/// with `""` for the reason every marker here is: a line that contains its own
/// marker matches itself.
const REPORT: &str = "___AURA_AUTHOR___";

/// The email the runner bootstrap used to bake into every clone it made. Named
/// here rather than only deleted there, because the boxes already provisioned
/// with it still hold it, and a member looking at "who am I here" deserves to be
/// told that this one is the machine rather than a colleague.
const RUNNER_EMAIL: &str = "runner@auravcs.com";

/// Names that are the machine talking about itself. Matched case-insensitively
/// against `user.name`, since a commit signed `aura runner` reads exactly as
/// wrongly as one signed `Aura Runner`.
const MACHINE_NAMES: [&str; 4] = ["aura runner", "aura-runner", "runner", "aura"];

/// A git author, as the two fields a commit actually carries.
///
/// The same pair the frontend's `gitIdentityFromAccount` derives from a signed-in
/// account — deliberately the same shape, so the value that crosses the wire is
/// the value that gets written, with no third spelling in between to disagree
/// with either.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Author {
    pub name: String,
    pub email: String,
}

impl Author {
    /// A validated author, or the named reason there isn't one.
    ///
    /// The email check is deliberately shallow — an `@` with something on both
    /// sides — and that is the whole intent. Full RFC validation would refuse
    /// addresses git is perfectly happy to author with; what this catches is the
    /// fat-fingered value that would otherwise land as a permanent commit field
    /// nobody notices until it is in history.
    pub fn new(name: &str, email: &str) -> Result<Self, AuthorGap> {
        let name = name.trim();
        let email = email.trim();
        if name.is_empty() {
            return Err(AuthorGap::NoName);
        }
        if email.is_empty() {
            return Err(AuthorGap::NoEmail);
        }
        let looks_like_an_address = email
            .split_once('@')
            .is_some_and(|(user, host)| !user.is_empty() && host.contains('.'));
        if !looks_like_an_address {
            return Err(AuthorGap::NotAnEmail(email.to_string()));
        }
        Ok(Author {
            name: name.to_string(),
            email: email.to_string(),
        })
    }

    /// The author as git renders it, for a sentence a person reads.
    pub fn line(&self) -> String {
        format!("{} <{}>", self.name, self.email)
    }

    /// Is this the same person? Decided on the email alone, case-insensitively,
    /// because that is the field git and every forge key identity off — a member
    /// who changed their display name has not become somebody else.
    pub fn same_as(&self, other: &Author) -> bool {
        self.email.eq_ignore_ascii_case(&other.email)
    }
}

/// Why there is no author to write.
///
/// Never a bare string: each of these is a different thing for a surface to say,
/// and "invalid identity" collapses them into one that says nothing.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "gap", rename_all = "snake_case")]
pub enum AuthorGap {
    NoName,
    NoEmail,
    NotAnEmail(String),
}

impl std::fmt::Display for AuthorGap {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AuthorGap::NoName => write!(
                f,
                "A commit needs a name on it, and none was given. Sign in to Aura, or set one for this project."
            ),
            AuthorGap::NoEmail => write!(
                f,
                "A commit needs an email on it, and none was given. Sign in to Aura, or set one for this project."
            ),
            AuthorGap::NotAnEmail(v) => {
                write!(f, "\"{v}\" isn't an email address, so it can't author a commit.")
            }
        }
    }
}

/// What the place actually holds right now — every field the machine's own
/// answer, never what we asked for.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct PlaceAuthorFacts {
    /// What to call this place in a sentence.
    pub place: String,
    /// The login that answered the survey.
    pub you: String,
    /// The checkout that was asked about.
    pub root: String,
    /// Is there a git repository there at all?
    pub repo: bool,
    /// The repo-local identity, when the checkout has one of its own.
    pub local: Option<Author>,
    /// What git would actually use for the next commit here — local, global,
    /// system, or nothing.
    pub effective: Option<Author>,
    /// Which file the effective identity came from, in git's own
    /// `--show-origin` spelling. Empty means git INVENTED it from the login and
    /// the hostname, which is the quietest way to get a wrong author.
    pub origin: String,
    /// Is `user.useConfigOnly` on, so git refuses to invent one rather than
    /// guessing?
    pub only_config: bool,
}

/// Whose name a commit made here right now would carry.
///
/// Four cases rather than a bool, because they lead four different places. A
/// commit authored by the box is not "no author": it succeeds, silently, and the
/// audit trail loses the person. A commit authored by a *colleague* is the one
/// case where writing over it unasked would be the wrong move.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "who", rename_all = "snake_case")]
pub enum Authorship {
    /// The member's own — nothing to do.
    Mine { author: Author },
    /// The machine's, or one it made up. `why` is what gave it away.
    Machine { author: Author, why: String },
    /// A real person's, and not this member's.
    Someone { author: Author },
    /// Git has nothing to author with here.
    Missing { why: String },
}

impl Authorship {
    /// Would a commit made here right now carry the member's own name?
    pub fn is_mine(&self) -> bool {
        matches!(self, Authorship::Mine { .. })
    }

    /// The author this place would use, whoever's it is.
    pub fn author(&self) -> Option<&Author> {
        match self {
            Authorship::Mine { author }
            | Authorship::Machine { author, .. }
            | Authorship::Someone { author } => Some(author),
            Authorship::Missing { .. } => None,
        }
    }
}

/// Is this author the machine rather than a person?
///
/// Three ways a box ends up claiming to be somebody. The bootstrap identity a
/// provisioning script baked in; the login the image came with, which
/// [`super::place_account::is_bootstrap_login`] already knows by name so there is
/// no second list to keep in step; and a name that is the product talking about
/// itself.
///
/// Git's *invented* identity — `ubuntu@ip-172-31-4-7` — is usually caught by the
/// login test, but not always (a member's own login on a box with no mail domain
/// gives `mo@ip-172-31-4-7`). That case is caught by [`authorship`] instead,
/// through the empty `--show-origin`: an identity from no file is one git made
/// up, and no list of names could have known it.
pub fn is_machine_author(a: &Author) -> bool {
    if a.email.eq_ignore_ascii_case(RUNNER_EMAIL) {
        return true;
    }
    let name = a.name.trim().to_ascii_lowercase();
    if MACHINE_NAMES.contains(&name.as_str()) {
        return true;
    }
    let local = a.email.split('@').next().unwrap_or_default();
    super::place_account::is_bootstrap_login(local) || super::place_account::is_bootstrap_login(&name)
}

/// Read the facts, decide whose name is on the next commit.
///
/// Pure, and asked of the contract rather than of the variant: a laptop and a
/// box reach this with the same struct, so neither can be given an answer the
/// other cannot have.
pub fn authorship(facts: &PlaceAuthorFacts, mine: Option<&Author>) -> Authorship {
    let Some(current) = facts.effective.clone() else {
        return Authorship::Missing {
            why: if facts.repo {
                "git has no name or email here, so a commit would be refused".into()
            } else {
                format!("{} isn't a git checkout", facts.root)
            },
        };
    };
    if let Some(mine) = mine {
        if current.same_as(mine) {
            return Authorship::Mine { author: current };
        }
    }
    // An identity that came from no file is one git assembled from the login and
    // the hostname. It is not in any list, and it is not a person.
    if facts.origin.trim().is_empty() {
        return Authorship::Machine {
            author: current,
            why: "git made this up from the login and the hostname — nothing here set an author"
                .into(),
        };
    }
    if is_machine_author(&current) {
        return Authorship::Machine {
            author: current,
            why: format!("this is the machine's own identity, set in {}", facts.origin),
        };
    }
    Authorship::Someone { author: current }
}

/// What a commit from a place would be authored as, and what could be done
/// about it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AuthorPlan {
    pub place: String,
    pub root: String,
    /// The login the place answered as.
    pub you: String,
    /// What the signed-in account offers, when anything is signed in.
    pub member: Option<Author>,
    /// Whose name the next commit would carry.
    pub authorship: Authorship,
    /// Where the current identity came from, in git's own words.
    pub origin: String,
    /// Did THIS call write the identity? Only ever true from [`Place::adopt_author`].
    pub adopted: bool,
    /// The one sentence a surface shows. Written here so every surface says it
    /// the same way.
    pub note: String,
}

/// The sentence for a plan. One phrasing, because a warning that is worded
/// differently in two places is a warning people learn to skim.
fn note_for(plan_place: &str, authorship: &Authorship, adopted: bool) -> String {
    match authorship {
        Authorship::Mine { author } if adopted => {
            format!("Commits from {plan_place} are now authored as {}.", author.line())
        }
        Authorship::Mine { author } => {
            format!("Commits from {plan_place} are authored as {}.", author.line())
        }
        Authorship::Machine { author, why } => format!(
            "Commits from {plan_place} would be authored as {} — {why}. Your own name would not be on them.",
            author.line()
        ),
        Authorship::Someone { author } => format!(
            "Commits from {plan_place} would be authored as {}, which is somebody else.",
            author.line()
        ),
        Authorship::Missing { why } => {
            format!("Nothing would author a commit on {plan_place}: {why}.")
        }
    }
}

/// Ask a checkout who it thinks it is.
///
/// POSIX `sh`, not bash: one script runs under `ssh` on a distro whose `/bin/sh`
/// is dash and under `sh -c` on this laptop, and there is exactly one of it for
/// both.
///
/// Exits 0 with an empty answer when git holds nothing. "This repo has no
/// author" is an ANSWER — [`Place::ask`] turns a non-zero exit into a failure,
/// and reporting the most common state in the codebase as an outage would make
/// the surface useless on precisely the machines it exists for.
pub fn survey_script(root: &str) -> String {
    let root = quote(root);
    format!(
        r#"set -u
ROOT={root}
ME=$(id -un 2>/dev/null || echo "${{USER:-}}")

if [ ! -d "$ROOT" ]; then
  echo "there is no directory called $ROOT here" >&2
  exit 5
fi

REPO=no
if git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1; then REPO=yes; fi

# `|| true` on every read: git exits non-zero for an unset key, which is a
# perfectly ordinary state and must not read as the place failing to answer.
LOCAL_NAME=""
LOCAL_EMAIL=""
EFF_NAME=""
EFF_EMAIL=""
ORIGIN=""
ONLY=""
if [ "$REPO" = yes ]; then
  LOCAL_NAME=$(git -C "$ROOT" config --local --get user.name 2>/dev/null || true)
  LOCAL_EMAIL=$(git -C "$ROOT" config --local --get user.email 2>/dev/null || true)
  EFF_NAME=$(git -C "$ROOT" config --get user.name 2>/dev/null || true)
  EFF_EMAIL=$(git -C "$ROOT" config --get user.email 2>/dev/null || true)
  # Which FILE the identity came from. Empty means no file did — git would
  # assemble one from the login and the hostname, which is the quiet way to get
  # a commit authored by a machine.
  ORIGIN=$(git -C "$ROOT" config --show-origin --get user.email 2>/dev/null | cut -f1 || true)
  ONLY=$(git -C "$ROOT" config --get user.useConfigOnly 2>/dev/null || true)
fi

echo "___AURA""_AUTHOR___"
echo "you=$ME"
echo "root=$ROOT"
echo "repo=$REPO"
echo "local_name=$LOCAL_NAME"
echo "local_email=$LOCAL_EMAIL"
echo "effective_name=$EFF_NAME"
echo "effective_email=$EFF_EMAIL"
echo "origin=$ORIGIN"
echo "only_config=$ONLY"
"#
    )
}

/// Write the member's own name onto this checkout, then report what git holds.
///
/// Repo-LOCAL, on both sides of the wire. There is no `--global` here and there
/// is a test that says so: this seam can reach a machine other people share, and
/// a global write there would change who *they* are the next time they commit —
/// the exact failure the local implementation was careful to avoid, made worse
/// by distance.
///
/// The survey is appended rather than the write being trusted. What comes back
/// is what git holds afterwards, so a write that silently did nothing (a
/// read-only config, a checkout that turned out not to be a repo) reports the
/// truth rather than our intention.
pub fn adopt_script(root: &str, author: &Author) -> String {
    let root_q = quote(root);
    let name = quote(&author.name);
    let email = quote(&author.email);
    format!(
        r#"set -u
if git -C {root_q} rev-parse --git-dir >/dev/null 2>&1; then
  # --local, never --global: this place may be a box a team shares, and the
  # identity being adopted belongs to one member of it.
  git -C {root_q} config --local user.name {name} || true
  git -C {root_q} config --local user.email {email} || true
  # With a name of their own written down, git must never fall back to
  # inventing one from the login and the hostname again.
  git -C {root_q} config --local user.useConfigOnly true || true
fi
{survey}"#,
        survey = survey_script(root)
    )
}

/// Read the report back.
///
/// Everything before the marker is the place's own noise — a MOTD, a sudo
/// lecture, whatever a profile prints — and is dropped rather than parsed around.
pub fn parse_facts(place: &str, out: &str) -> Result<PlaceAuthorFacts, String> {
    let body = out
        .split_once(REPORT)
        .map(|(_, rest)| rest)
        .ok_or_else(|| "the place didn't say who it would author a commit as".to_string())?;
    let f = |k: &str| -> String {
        body.lines()
            .filter_map(|l| l.trim().split_once('='))
            .find(|(key, _)| *key == k)
            .map(|(_, v)| v.trim().to_string())
            .unwrap_or_default()
    };
    let you = f("you");
    if you.is_empty() {
        return Err("the place didn't say which login it answered as".into());
    }
    // A half-set identity is not an identity: git refuses to commit with a name
    // and no email just as it does with neither, so it is reported as neither
    // rather than as an author with a blank half.
    let pair = |name: String, email: String| -> Option<Author> {
        (!name.trim().is_empty() && !email.trim().is_empty()).then_some(Author { name, email })
    };
    Ok(PlaceAuthorFacts {
        place: place.to_string(),
        root: f("root"),
        repo: f("repo") == "yes",
        local: pair(f("local_name"), f("local_email")),
        effective: pair(f("effective_name"), f("effective_email")),
        origin: f("origin"),
        only_config: matches!(f("only_config").as_str(), "true" | "yes" | "1"),
        you,
    })
}

impl Place {
    /// Whose name a commit made here right now would carry.
    ///
    /// One call for both place-modes, because it is a `Place` method and the
    /// survey is one script through [`Place::ask`]: this laptop answers it about
    /// its own checkout, a box answers it about the one it holds, and neither has
    /// an implementation the other lacks.
    pub async fn author(&self, mine: Option<&Author>) -> Result<AuthorPlan, String> {
        let out = self.ask(survey_script(self.root())).await?;
        self.plan_from(&out, mine, false)
    }

    /// Adopt this author for the checkout here, and report what git holds after.
    ///
    /// Idempotent, and in the sense that matters: running it against a checkout
    /// that already carries the identity is how a member *verifies* their name is
    /// the one on their commits, not a second attempt at setting it.
    pub async fn adopt_author(&self, author: &Author) -> Result<AuthorPlan, String> {
        let out = self.ask(adopt_script(self.root(), author)).await?;
        let plan = self.plan_from(&out, Some(author), true)?;
        // The write is only "done" if git came back holding it. A checkout whose
        // config could not be written would otherwise report success and author
        // the next commit as the machine anyway.
        if !plan.authorship.is_mine() {
            return Err(format!(
                "{} didn't take the identity: {}",
                self.label(),
                plan.note
            ));
        }
        Ok(plan)
    }

    /// The facts, read into a plan. Shared by both verbs so the answer to "who
    /// would author this" is assembled once, whether or not we just wrote it.
    ///
    /// A survey that came back without a report is an error rather than an empty
    /// plan. The script exits 0 for every ordinary state — no identity, no repo,
    /// no directory is the one case it exits non-zero for — so reaching here with
    /// nothing to parse means the place answered something we do not understand,
    /// and guessing "no author" from it would put a machine's name on a commit
    /// while reporting that everything was fine.
    fn plan_from(
        &self,
        out: &str,
        mine: Option<&Author>,
        adopted: bool,
    ) -> Result<AuthorPlan, String> {
        let facts = parse_facts(self.label(), out)?;
        let authorship = authorship(&facts, mine);
        Ok(AuthorPlan {
            note: note_for(self.label(), &authorship, adopted),
            place: facts.place,
            root: facts.root,
            you: facts.you,
            member: mine.cloned(),
            origin: facts.origin,
            authorship,
            adopted,
        })
    }
}

/// Whose name a commit from a place would carry, before it is made.
///
/// `machine_id` names a box; omit it and the answer is about this laptop, in
/// `root`. One command for both, so the day a managed place exists it is asked
/// this in the same words. `name` / `email` are the signed-in account's, derived
/// on the frontend by `gitIdentityFromAccount` — omit them and the answer is
/// still honest, it just cannot say whether the current author is *yours*.
#[tauri::command]
pub async fn place_author(
    root: Option<String>,
    machine_id: Option<String>,
    name: Option<String>,
    email: Option<String>,
) -> Result<AuthorPlan, String> {
    let place = place_of(root, machine_id)?;
    let mine = account_author(name, email)?;
    place.author(mine.as_ref()).await
}

/// Write the account's identity onto the checkout at a place, wherever it is.
///
/// This is the whole point of the task: the identity a member is signed in as
/// crosses the wire and lands on the machine the work is actually running on,
/// repo-local, instead of stopping at the laptop that happened to open the app.
#[tauri::command]
pub async fn place_author_adopt(
    root: Option<String>,
    machine_id: Option<String>,
    name: String,
    email: String,
) -> Result<AuthorPlan, String> {
    let place = place_of(root, machine_id)?;
    let author = Author::new(&name, &email).map_err(|gap| gap.to_string())?;
    place.adopt_author(&author).await
}

/// The place a command was asked about. An unknown machine id is an error rather
/// than a quiet answer about this laptop: "who would author my commits" answered
/// about the wrong computer is worse than unanswered.
fn place_of(root: Option<String>, machine_id: Option<String>) -> Result<Place, String> {
    match machine_id.as_deref().map(str::trim).filter(|id| !id.is_empty()) {
        Some(id) => Place::at_machine(id),
        None => Ok(Place::resolve(root.unwrap_or_default(), None)),
    }
}

/// The signed-in account's author, when both halves were given. Neither given is
/// "nobody is signed in", which is an answer; one given is a caller bug and is
/// reported as one rather than silently authoring with half an identity.
fn account_author(
    name: Option<String>,
    email: Option<String>,
) -> Result<Option<Author>, String> {
    let name = name.unwrap_or_default();
    let email = email.unwrap_or_default();
    if name.trim().is_empty() && email.trim().is_empty() {
        return Ok(None);
    }
    Author::new(&name, &email)
        .map(Some)
        .map_err(|gap| gap.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn me() -> Author {
        Author {
            name: "mo".into(),
            email: "mo@users.noreply.auravcs.com".into(),
        }
    }

    fn facts(effective: Option<Author>, origin: &str) -> PlaceAuthorFacts {
        PlaceAuthorFacts {
            place: "shed".into(),
            you: "mo".into(),
            root: "/srv/alpha".into(),
            repo: true,
            local: effective.clone(),
            effective,
            origin: origin.into(),
            only_config: false,
        }
    }

    #[test]
    fn an_author_needs_both_halves_and_an_address() {
        assert_eq!(Author::new("", "mo@x.com"), Err(AuthorGap::NoName));
        assert_eq!(Author::new("mo", "  "), Err(AuthorGap::NoEmail));
        assert_eq!(
            Author::new("mo", "mo-at-example"),
            Err(AuthorGap::NotAnEmail("mo-at-example".into()))
        );
        // A bare hostname is what git INVENTS, so it must not pass as one a
        // person typed.
        assert!(Author::new("mo", "mo@ip-172-31-4-7").is_err());
        assert_eq!(Author::new(" mo ", " mo@x.com ").unwrap(), Author {
            name: "mo".into(),
            email: "mo@x.com".into()
        });
    }

    #[test]
    fn the_same_person_with_a_new_display_name_is_still_them() {
        let renamed = Author {
            name: "Mo Ashiq".into(),
            email: "MO@users.noreply.auravcs.com".into(),
        };
        assert!(me().same_as(&renamed));
        assert!(!me().same_as(&Author {
            name: "mo".into(),
            email: "ana@users.noreply.auravcs.com".into()
        }));
    }

    #[test]
    fn the_runner_identity_is_recognised_as_the_machine() {
        assert!(is_machine_author(&Author {
            name: "Aura Runner".into(),
            email: "runner@auravcs.com".into()
        }));
        // Even re-labelled, the address gives it away.
        assert!(is_machine_author(&Author {
            name: "Mo".into(),
            email: "runner@auravcs.com".into()
        }));
        // And re-addressed, the name does.
        assert!(is_machine_author(&Author {
            name: "aura-runner".into(),
            email: "ci@example.com".into()
        }));
    }

    #[test]
    fn a_login_the_image_came_with_is_the_machine_not_a_person() {
        for login in ["ubuntu", "ec2-user", "root", "admin"] {
            assert!(
                is_machine_author(&Author {
                    name: login.into(),
                    email: format!("{login}@example.com")
                }),
                "{login} read as a person"
            );
        }
        assert!(!is_machine_author(&me()));
    }

    #[test]
    fn my_own_name_on_my_own_commit_is_the_quiet_answer() {
        let got = authorship(&facts(Some(me()), "file:/srv/alpha/.git/config"), Some(&me()));
        assert!(got.is_mine());
        assert_eq!(got.author(), Some(&me()));
    }

    #[test]
    fn the_boxs_baked_in_author_is_called_the_machine() {
        let runner = Author {
            name: "Aura Runner".into(),
            email: RUNNER_EMAIL.into(),
        };
        let got = authorship(
            &facts(Some(runner.clone()), "file:/srv/alpha/.git/config"),
            Some(&me()),
        );
        match got {
            Authorship::Machine { author, why } => {
                assert_eq!(author, runner);
                assert!(why.contains("/srv/alpha/.git/config"), "{why}");
            }
            other => panic!("the runner identity read as {other:?}"),
        }
    }

    #[test]
    fn an_identity_from_no_file_at_all_is_one_git_made_up() {
        // The case no list of names could catch: a real member's login, on a box
        // whose hostname is not a domain, assembled by git itself.
        let invented = Author {
            name: "mo".into(),
            email: "mo@ip-172-31-4-7".into(),
        };
        let got = authorship(&facts(Some(invented), ""), Some(&me()));
        match got {
            Authorship::Machine { why, .. } => assert!(why.contains("made this up"), "{why}"),
            other => panic!("an invented identity read as {other:?}"),
        }
    }

    #[test]
    fn a_teammates_identity_is_a_person_rather_than_the_machine() {
        let ana = Author {
            name: "ana".into(),
            email: "ana@users.noreply.auravcs.com".into(),
        };
        let got = authorship(
            &facts(Some(ana.clone()), "file:/srv/alpha/.git/config"),
            Some(&me()),
        );
        // The one case where overwriting unasked would be wrong, so it must not
        // be lumped in with the machine's.
        assert_eq!(got, Authorship::Someone { author: ana });
    }

    #[test]
    fn a_half_set_identity_is_no_identity() {
        let out = format!(
            "{REPORT}\nyou=mo\nroot=/srv/alpha\nrepo=yes\nlocal_name=mo\nlocal_email=\n\
             effective_name=mo\neffective_email=\norigin=\nonly_config=\n"
        );
        let got = parse_facts("shed", &out).unwrap();
        assert_eq!(got.effective, None, "a name with no email authored nothing");
        assert!(matches!(
            authorship(&got, Some(&me())),
            Authorship::Missing { .. }
        ));
    }

    #[test]
    fn a_place_that_is_not_a_checkout_says_so_rather_than_failing() {
        let out = format!(
            "{REPORT}\nyou=mo\nroot=/srv/alpha\nrepo=no\nlocal_name=\nlocal_email=\n\
             effective_name=\neffective_email=\norigin=\nonly_config=\n"
        );
        let got = parse_facts("shed", &out).unwrap();
        match authorship(&got, Some(&me())) {
            Authorship::Missing { why } => assert!(why.contains("/srv/alpha"), "{why}"),
            other => panic!("a directory with no repo read as {other:?}"),
        }
    }

    #[test]
    fn the_report_is_what_the_machine_says_it_holds() {
        let out = format!(
            "Welcome to Ubuntu 24.04\n{REPORT}\nyou=ubuntu\nroot=/srv/alpha\nrepo=yes\n\
             local_name=mo\nlocal_email=mo@users.noreply.auravcs.com\n\
             effective_name=mo\neffective_email=mo@users.noreply.auravcs.com\n\
             origin=file:/srv/alpha/.git/config\nonly_config=true\n"
        );
        let got = parse_facts("shed", &out).unwrap();
        assert_eq!(got.you, "ubuntu", "the login that answered is not the author");
        assert_eq!(got.local, Some(me()));
        assert!(got.only_config);
        assert_eq!(got.origin, "file:/srv/alpha/.git/config");
    }

    #[test]
    fn output_without_a_report_is_not_an_answer() {
        assert!(parse_facts("shed", "Permission denied (publickey)").is_err());
    }

    #[test]
    fn nothing_here_ever_writes_a_global_git_config() {
        // The rule this seam lives or dies by. It can reach a machine ten people
        // share, so a `--global` write here would change who THEY are — a comment
        // was not enough to hold that.
        for script in [survey_script("/srv/alpha"), adopt_script("/srv/alpha", &me())] {
            // Comments are stripped first, so the rule is about what the place is
            // asked to RUN. The adopt script says "--local, never --global" in a
            // comment on purpose — the next person to edit it should read the
            // reason there, not discover it here.
            let runs: String = script
                .lines()
                .filter(|l| !l.trim_start().starts_with('#'))
                .collect::<Vec<_>>()
                .join("\n");
            assert!(!runs.contains("--global"), "a script reaches for --global");
            assert!(!runs.contains("--system"), "a script reaches for --system");
        }
        let adopt = adopt_script("/srv/alpha", &me());
        assert!(
            adopt.contains("config --local user.name"),
            "the write is not repo-local"
        );
        assert!(
            adopt.contains("config --local user.email"),
            "the write is not repo-local"
        );
    }

    #[test]
    fn nothing_a_member_is_called_can_become_a_second_command() {
        let hostile = Author {
            name: "'; rm -rf / #".into(),
            email: "x'; touch /tmp/pwned #@evil.com".into(),
        };
        let script = adopt_script("/srv/alpha'; rm -rf / #", &hostile);
        assert!(!script.contains("rm -rf / #\n"), "a name escaped its quotes");
        // Every hostile fragment survives only inside a quoted word.
        for fragment in ["'\\''; rm -rf / #", "'\\''; touch /tmp/pwned #@evil.com"] {
            assert!(script.contains(fragment), "expected {fragment} quoted");
        }
    }

    #[test]
    fn the_script_never_contains_the_marker_it_prints() {
        // Otherwise the survey's own text matches the split and everything after
        // it parses as a report.
        assert!(!survey_script("/srv/alpha").contains(REPORT));
        assert!(!adopt_script("/srv/alpha", &me()).contains(REPORT));
    }

    #[test]
    fn adopting_turns_off_gits_habit_of_inventing_one() {
        // Writing a name is only half of it: git falls back to the login and the
        // hostname whenever a config read comes up empty, and a member who moves
        // to a second checkout on the same box would get the machine again.
        assert!(adopt_script("/srv/alpha", &me()).contains("user.useConfigOnly true"));
    }

    #[test]
    fn the_sentence_names_the_place_and_whose_name_would_be_on_it() {
        let machine = Authorship::Machine {
            author: Author {
                name: "Aura Runner".into(),
                email: RUNNER_EMAIL.into(),
            },
            why: "this is the machine's own identity".into(),
        };
        let note = note_for("shed", &machine, false);
        assert!(note.contains("shed"), "{note}");
        assert!(note.contains(RUNNER_EMAIL), "{note}");
        assert!(note.contains("would not be on them"), "{note}");
    }

    #[test]
    fn an_account_with_half_an_identity_is_a_caller_bug_not_a_signed_out_one() {
        assert_eq!(account_author(None, None).unwrap(), None);
        assert_eq!(
            account_author(Some("  ".into()), Some(String::new())).unwrap(),
            None
        );
        assert!(account_author(Some("mo".into()), None).is_err());
    }

    // ---- against a real git, on a real disk ---------------------------------
    //
    // Everything above is the judgement; this is the wire. `Place::Here` runs
    // these scripts through the same `Place::ask` a box does, so what is proven
    // here is the script itself — that the strings this file emits are ones git
    // actually accepts, which no amount of asserting about their text can say.

    fn block_on<F: std::future::Future>(f: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(f)
    }

    fn git(root: &std::path::Path, args: &[&str]) -> String {
        let out = std::process::Command::new("git")
            .args(args)
            .current_dir(root)
            .output()
            .expect("git is not on PATH");
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    /// A checkout with a commit-able tree and NO identity of its own — the state
    /// a fresh clone on a shared box is in.
    fn a_checkout(name: &str) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!(
            "aura-author-{name}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("temp dir");
        git(&root, &["init", "-q"]);
        std::fs::write(root.join("a.txt"), "hello\n").expect("write");
        git(&root, &["add", "a.txt"]);
        root
    }

    #[test]
    fn two_members_committing_from_one_place_land_as_two_different_people() {
        // THE acceptance criterion, executed rather than asserted about: one
        // machine, two members, two checkouts, and two commits that carry the
        // right name each. This is what `Aura Runner <runner@auravcs.com>` made
        // impossible — every commit from the box was the same person.
        let mo = Author {
            name: "mo".into(),
            email: "mo@users.noreply.auravcs.com".into(),
        };
        let ana = Author {
            name: "ana".into(),
            email: "ana@users.noreply.auravcs.com".into(),
        };

        let mut landed = vec![];
        for (who, author) in [("mo", &mo), ("ana", &ana)] {
            let root = a_checkout(who);
            let place = Place::Here {
                root: root.display().to_string(),
            };

            // Before: the checkout has no identity of its own.
            let before = block_on(place.author(Some(author))).expect("the place must answer");
            assert!(
                !before.authorship.is_mine(),
                "{who}'s checkout already claimed to be them: {:?}",
                before.authorship
            );

            let after = block_on(place.adopt_author(author)).expect("the identity must take");
            assert!(after.adopted && after.authorship.is_mine(), "{after:?}");

            // And now a real commit, made by git itself.
            git(&root, &["commit", "-q", "-m", "first"]);
            landed.push((
                git(&root, &["log", "-1", "--format=%an"]),
                git(&root, &["log", "-1", "--format=%ae"]),
                root,
            ));
        }

        assert_eq!(landed[0].0, "mo");
        assert_eq!(landed[0].1, "mo@users.noreply.auravcs.com");
        assert_eq!(landed[1].0, "ana");
        assert_eq!(landed[1].1, "ana@users.noreply.auravcs.com");
        assert_ne!(
            landed[0].1, landed[1].1,
            "two members' commits landed under one author"
        );
        for (_, _, root) in landed {
            let _ = std::fs::remove_dir_all(root);
        }
    }

    #[test]
    fn adopting_an_identity_never_reaches_past_the_repo_it_was_asked_about() {
        // The rule the local implementation was careful about and this one has
        // to keep across a wire: a member adopting their account identity in one
        // checkout must not become that person in the one next door.
        let mine = a_checkout("scoped-mine");
        let neighbour = a_checkout("scoped-neighbour");
        let author = Author {
            name: "mo".into(),
            email: "mo@users.noreply.auravcs.com".into(),
        };
        block_on(
            Place::Here {
                root: mine.display().to_string(),
            }
            .adopt_author(&author),
        )
        .expect("the identity must take");

        assert_eq!(
            git(&mine, &["config", "--local", "--get", "user.email"]),
            author.email
        );
        assert_eq!(
            git(&neighbour, &["config", "--local", "--get", "user.email"]),
            "",
            "adopting an identity in one checkout reached into another"
        );
        let _ = std::fs::remove_dir_all(mine);
        let _ = std::fs::remove_dir_all(neighbour);
    }

    #[test]
    fn a_place_holding_the_runners_baked_in_author_is_told_it_is_the_machine() {
        // A box provisioned before this existed: the identity is really there,
        // in a real config file, and reads as a person. The seam has to name it.
        let root = a_checkout("runner");
        git(&root, &["config", "--local", "user.name", "Aura Runner"]);
        git(&root, &["config", "--local", "user.email", RUNNER_EMAIL]);
        let mine = Author {
            name: "mo".into(),
            email: "mo@users.noreply.auravcs.com".into(),
        };
        let plan = block_on(
            Place::Here {
                root: root.display().to_string(),
            }
            .author(Some(&mine)),
        )
        .expect("the place must answer");

        match &plan.authorship {
            Authorship::Machine { author, .. } => assert_eq!(author.email, RUNNER_EMAIL),
            other => panic!("the runner identity read as {other:?}"),
        }
        assert!(plan.note.contains("would not be on them"), "{}", plan.note);
        let _ = std::fs::remove_dir_all(root);
    }
}
