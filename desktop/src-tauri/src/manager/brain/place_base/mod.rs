//! The team's environment, built once, and each member started from it.
//!
//! ## The bill the second member was paying
//!
//! [`super::place_account`] gives every member of a shared place their own Unix
//! account, and [`super::place_toolchain`] points every tool that keeps state at
//! that account's own home — their `CARGO_HOME`, their `RUSTUP_HOME`, their npm
//! prefix. That is the right answer to "whose `npm install -g` was that", and it
//! has a cost nobody wrote down: the directories those variables name start
//! empty. The first member joins a box and brings it to the project's declared
//! spec — a rust toolchain, a thousand crates, a node, a `cargo install` that
//! compiles for eleven minutes. The second member joins the same box, gets their
//! own empty `.cargo`, and does the whole thing again, on the same machine, over
//! the same network, for the same bytes.
//!
//! So there is a third account here that belongs to nobody: `aura-base`. The
//! declared spec is applied once, in *its* home, and a member joining starts
//! with a copy of what it holds. The first member pays the install. The second
//! member pays a file copy.
//!
//! ## Why the shared half is a different account and not a shared directory
//!
//! Because the members were separated for a reason, and the reason survives
//! this. A shared directory that two members' `CARGO_HOME` both pointed at would
//! be quick to write and would undo [`super::place_toolchain`] entirely: one
//! member's `cargo install` would land in the other's toolchain, which is the
//! collision that whole file exists to stop. What comes out of the base is a
//! *copy* the member then owns. Sharing the bytes underneath is the filesystem's
//! business — `cp --reflink` where there is one — and nobody above has to care.
//!
//! Making it an account also means the base needs no new machinery to be built
//! correctly. It reads the same profile block every member gets, so `CARGO_HOME`
//! and the rest resolve to its own home for free, and the environment is applied
//! through [`super::place_env`]'s pump — the same state machine, the same
//! commands, the same signature check — running as the base instead of as a
//! person.
//!
//! ## What the shared half may not hold
//!
//! Anything of anybody's. That is the whole reason a member still has a private
//! home: a key, a `gh` token, an agent CLI's sign-in and the name on a commit
//! stay where they were, and the base is checked for every one of them
//! ([`layers::PRIVATE`]) both when it is built and again at the moment before a
//! byte is copied out of it. A base that is holding one is refused, out loud,
//! naming the file.
//!
//! ## What this laptop answers
//!
//! That there is one member here and it is you. The base on a place with a
//! single member is that member's own environment: there is nothing to build
//! once because you are the only person who would use it, and nothing to copy
//! because you are already standing in it. Both facts are *reported*, by the
//! same script and the same parser the shared arm uses — the question "where
//! does the team's environment live here" has an answer on every place, and on
//! this one the answer is "yours".

/// What the team shares and what it never will — the two lists the whole of
/// this module is an argument about.
pub mod layers;
/// The shell the far side runs and the reports it prints back, kept apart from
/// the seam for the same reason `place_account`'s is: a script is testable
/// without a machine, and a machine is where it is hardest to be sure.
pub mod script;

use serde::{Deserialize, Serialize};

use aura_env::{EnvReport, Plan, Run, Scope, StepKind};

use super::place::Place;
use super::place_account::{member_login, member_login_here};
pub use script::BASE_LOGIN;
use script::{BasePlan, BranchPlan};

/// How long a member's copy out of the base may take.
///
/// Generous, because the thing being copied is the whole point: a cold crate
/// cache and a rust toolchain are gigabytes, and a copy that timed out halfway
/// would leave a member with a directory that looks warm and is short. Still
/// bounded — a copy that has not finished in this long is not a slow disk, it is
/// a wedged one.
const BRANCH_WAIT: std::time::Duration = std::time::Duration::from_secs(20 * 60);

/// One thing the base holds, with the sentence that goes with it.
///
/// The path is carried alongside the words rather than translated into them at
/// the last moment, because a surface shows the sentence and a bug report needs
/// the path.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Held {
    pub under: String,
    pub tool: String,
    /// What it holds, in words a person reads.
    pub holds: String,
}

impl Held {
    /// A path the table knows, described. A path it does not is still reported —
    /// it came off the machine, and dropping it would be the app hiding
    /// something it does not recognise.
    fn of(under: &str) -> Self {
        match script::layer_named(under) {
            Some(l) => Held {
                under: l.under.to_string(),
                tool: l.tool.to_string(),
                holds: l.holds.to_string(),
            },
            None => Held {
                under: under.to_string(),
                tool: String::new(),
                holds: String::new(),
            },
        }
    }
}

/// Where the team's already-built environment lives on a place.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TeamBase {
    /// The place, in the words a person calls it.
    pub place: String,
    /// The account it is built in.
    pub login: String,
    pub home: String,
    /// Did this call create it?
    pub created: bool,
    /// Is it shared — an account of its own that members start from — or is it
    /// simply the one member's own environment, because there is one member?
    pub shared: bool,
    /// Can the members actually read it? A base nobody can read is a base
    /// nobody starts from, and it would fail one member at a time.
    pub readable: bool,
    /// Does the base install into its own directories rather than the machine's?
    /// Without this it comes up empty however many times the spec is applied.
    pub scoped: bool,
    /// What it already holds.
    pub holds: Vec<Held>,
    /// Anything of one person's found in a place meant to be everyone's. Must be
    /// empty; anything here stops a member being started from it.
    pub carries: Vec<String>,
    /// `[env] version` the base was last built to. Zero means never.
    pub built_version: u32,
    /// The digest of the spec it was last built from, so "already built" is a
    /// fact about a particular spec rather than about a directory existing.
    pub built_digest: String,
}

/// What one member started from.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WarmStart {
    pub member: String,
    pub home: String,
    /// The account it came out of.
    pub from: String,
    /// Is the member the base? True on a place with one member, where there is
    /// nothing to copy and nothing missing.
    pub alone: bool,
    /// What came across.
    pub seeded: Vec<Held>,
    /// What the member already had, and kept. Never overwritten.
    pub kept: Vec<String>,
    /// What the base did not have to give.
    pub missing: Vec<String>,
    /// What was tried and did not copy — a full disk, a permission. Reported
    /// rather than swallowed: the member is about to find out the slow way.
    pub failed: Vec<String>,
    /// Why nothing came across, when nothing did. Empty otherwise.
    pub refused: String,
    /// Did this member start from work somebody else already paid for?
    pub warm: bool,
}

/// The team's environment and what it cost this member to join it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BaseBuild {
    pub base: TeamBase,
    /// Was the base already at this spec, so this call installed nothing?
    ///
    /// The claim the whole feature is judged on. True for the second member.
    pub already_built: bool,
    /// What bringing the base to spec did. `None` when nothing had to run.
    pub report: Option<EnvReport>,
    pub start: WarmStart,
}

impl Place {
    /// What this place will do when asked for the team's environment.
    ///
    /// Split out from [`Place::team_base`] because it is the whole of the
    /// mode-dependence and none of the machine: it decides, and reaches nothing.
    /// That makes it answerable about a box nobody can dial, which is what the
    /// workflow matrix needs to ask both places the same question with a live
    /// machine on neither end.
    pub(super) fn base_plan(&self) -> BasePlan {
        match self {
            // One member, and it is the person typing. Their own environment is
            // the base, there is nobody to share it with, and `useradd` on the
            // computer somebody is sitting at is not what a button about a
            // shared box should do. So: report, change nothing.
            Place::Here { .. } => BasePlan {
                login: None,
                shared: false,
                may_provision: false,
            },
            Place::Box { .. } => BasePlan {
                login: Some(BASE_LOGIN.to_string()),
                shared: true,
                may_provision: true,
            },
        }
    }

    /// What this place will do when asked to start a member from it.
    pub(super) fn branch_plan(&self, member: &str) -> BranchPlan {
        match self {
            Place::Here { .. } => BranchPlan {
                base_login: None,
                member_login: None,
                may_provision: false,
            },
            Place::Box { .. } => BranchPlan {
                base_login: Some(BASE_LOGIN.to_string()),
                member_login: Some(member.to_string()),
                may_provision: true,
            },
        }
    }

    /// Where the team's environment is here, and what it already holds.
    ///
    /// Makes the account on a place that shares one, because "where is it" and
    /// "there isn't one yet" are the same question asked a minute apart, and a
    /// surface that had to ask twice would show a member an error the first time
    /// they ever looked.
    pub async fn team_base(&self) -> Result<TeamBase, String> {
        let out = self.ask(script::base_script(&self.base_plan())).await?;
        let r = script::parse_base(&out)?;
        Ok(TeamBase {
            place: self.label().to_string(),
            login: r.login,
            home: r.home,
            created: r.created,
            shared: r.shared,
            readable: r.readable,
            scoped: r.scoped,
            holds: r.holds.iter().map(|u| Held::of(u)).collect(),
            carries: r.carries,
            built_version: r.stamp_version,
            built_digest: r.stamp_digest,
        })
    }

    /// Start a member from what the team already built.
    ///
    /// Copies what they do not have and never touches what they do. A member who
    /// pinned their own toolchain keeps it; a member whose account was made five
    /// seconds ago and holds five empty directories gets the team's.
    pub async fn branch_from_base(&self, login: Option<&str>) -> Result<WarmStart, String> {
        let member = match self {
            // The login is not asked for and not used: there is one member here
            // and the script reads it off the machine itself.
            Place::Here { .. } => String::new(),
            Place::Box { .. } => match login.map(str::trim).filter(|l| !l.is_empty()) {
                Some(l) => member_login(l)?,
                None => member_login_here()?,
            },
        };
        let plan = self.branch_plan(&member);
        // Through `sh` with a wait of its own rather than through `ask`: this is
        // the one call here that moves gigabytes, and the 25 seconds a question
        // gets would cut a cold crate cache in half.
        let out = self
            .sh(&script::branch_script(&plan), BRANCH_WAIT)
            .await?;
        if !out.ok() {
            return Err(format!(
                "{}: {}",
                self.label(),
                out.stderr.lines().last().unwrap_or("could not start you from the team's environment").trim()
            ));
        }
        let r = script::parse_branch(&out.stdout)?;
        Ok(WarmStart {
            warm: !r.seeded.is_empty(),
            member: r.member,
            home: r.member_home,
            from: r.base,
            alone: r.same,
            seeded: r.seeded.iter().map(|u| Held::of(u)).collect(),
            kept: r.kept,
            missing: r.absent,
            failed: r.failed,
            refused: r.refused,
        })
    }

    /// Build the team's environment once, and start this member from it.
    ///
    /// The order matters and is the feature: the base is brought to the declared
    /// spec *first*, so that the member branching a moment later gets a warm one
    /// rather than an empty one. The second member through finds the stamp
    /// already matching the spec's digest and installs nothing at all — which is
    /// the claim this whole module is judged on, and it is a fact about a
    /// particular spec rather than about a directory existing, because a project
    /// that bumps its toolchain has to be built again.
    pub async fn warm_team_base(
        &self,
        login: Option<&str>,
        force: bool,
    ) -> Result<BaseBuild, String> {
        let base = self.team_base().await?;
        if !base.carries.is_empty() {
            return Err(format!(
                "the team's environment on {} is holding something that belongs to one person \
                 ({}). Nothing was copied out of it — a shared environment carries downloads, \
                 never credentials.",
                base.place,
                base.carries.join(", ")
            ));
        }

        // A place with one member has nothing to build once. The branch still
        // runs, and still answers — it is how "you are already standing in it"
        // gets said rather than assumed.
        if !base.shared {
            let start = self.branch_from_base(login).await?;
            return Ok(BaseBuild {
                base,
                already_built: true,
                report: None,
                start,
            });
        }

        let declared = self.declared_env().await?;
        if !declared.trust.may_apply() && !force {
            return Err(format!(
                "refusing to build the team's environment on {} — {}",
                base.place,
                declared.trust.describe()
            ));
        }
        let plan = installing_only(
            aura_env::plan(&declared.spec, Scope::Environment).map_err(|e| e.to_string())?,
        );
        let already_built = already_at(&base, &plan, force);

        let report = if already_built {
            None
        } else {
            let version = plan.version;
            let digest = plan.digest.clone();
            let r = self
                .pump_as(Run::new(plan), declared.trust.clone(), Some(&base.login))
                .await?;
            // Stamped only when every step came out met. A stamp written because
            // somebody asked for a build is a stamp the next member reads as
            // "already done", and they inherit a half-built environment with
            // nothing to tell them so.
            if r.at_spec && script::is_digest(&digest) {
                self.ask(script::stamp_script(Some(&base.login), version, &digest))
                    .await?;
            }
            Some(r)
        };

        let start = self.branch_from_base(login).await?;
        // Re-read, so what comes back is what the base IS rather than what it was
        // before this call built it. The stamp in particular: a surface that
        // showed the old one would tell the first member their install did not
        // happen.
        let base = self.team_base().await?;
        Ok(BaseBuild {
            base,
            already_built,
            report,
            start,
        })
    }
}

/// Has the team's environment already been built to this plan's spec?
///
/// The whole claim, as one decision with nothing else in it. A project that
/// declares nothing has nothing to build for anybody, so every member is the
/// second member. A project that declares something is built once per SPEC
/// rather than once per directory: bumping the toolchain builds again, instead
/// of handing everyone a version the project stopped asking for last month.
///
/// An empty digest never matches. It is what a base nobody has built reports,
/// and reading it as agreement would tell the first member their install had
/// already happened.
fn already_at(base: &TeamBase, plan: &Plan, force: bool) -> bool {
    if force {
        return false;
    }
    plan.is_empty()
        || (!plan.digest.is_empty()
            && base.built_version == plan.version
            && base.built_digest == plan.digest)
}

/// The stages of a plan that put something on a machine.
///
/// Preflight, toolchains and packages — the parts that download, compile and
/// take minutes, and the parts that are the same for everybody. Services are
/// left out on purpose: a service is something that RUNS, and starting the
/// team's database under an account nobody logs in as would be a second copy of
/// it competing for the same port. Project dependencies are left out for the
/// same reason they are a separate [`Scope`] — they live in a member's own
/// checkout, and there is no shared checkout to install them into. Both still
/// land, per member, through [`super::place_env`]; what they no longer do is
/// re-download the world to get there, because the cache they need came out of
/// the base.
fn installing_only(plan: Plan) -> Plan {
    Plan {
        version: plan.version,
        digest: plan.digest,
        steps: plan
            .steps
            .into_iter()
            .filter(|s| {
                matches!(
                    s.kind,
                    StepKind::Preflight | StepKind::Toolchain | StepKind::Package
                )
            })
            .collect(),
    }
}

/// Where the team's environment is on a place, and what it holds.
///
/// `machine_id` absent means this laptop — the same command answers for both
/// modes, which is the only way the two can be kept honest.
#[tauri::command]
pub async fn place_team_base(
    root: Option<String>,
    machine_id: Option<String>,
) -> Result<TeamBase, String> {
    Place::resolve(root.unwrap_or_default(), machine_id.as_deref())
        .team_base()
        .await
}

/// Build the team's environment once, and start this member from it.
#[tauri::command]
pub async fn place_team_base_warm(
    root: Option<String>,
    machine_id: Option<String>,
    login: Option<String>,
    force: bool,
) -> Result<BaseBuild, String> {
    Place::resolve(root.unwrap_or_default(), machine_id.as_deref())
        .warm_team_base(login.as_deref(), force)
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use aura_env::{Step, StepKind};

    fn here() -> Place {
        Place::Here {
            root: "/Users/me/alpha".into(),
        }
    }

    fn a_box() -> Place {
        Place::Box {
            machine: Box::new(crate::cmd_machines::Machine {
                id: "ubuntu@10.0.0.4:/srv/alpha".into(),
                name: "aura-runner".into(),
                host: "10.0.0.4".into(),
                user: "ubuntu".into(),
                key_path: "/Users/me/.ssh/aura-runner.pem".into(),
                // The case every one of these is about: a box two people share.
                box_kind: "shared".into(),
                repo_path: Some("/srv/alpha".into()),
                repo_branch: Some("main".into()),
                project_root: Some("/Users/me/alpha".into()),
                org_slug: None,
                forward_agent: false,
                instance_id: None,
                asleep_since: 0,
                added_at: 1_750_000_000,
                last_used_at: 1_750_003_600,
            }),
            root: "/srv/alpha".into(),
            here: "/Users/me/alpha".into(),
        }
    }

    fn step(id: &str, kind: StepKind) -> Step {
        Step {
            id: id.into(),
            title: id.into(),
            kind,
            check: Some("true".into()),
            apply: Some("true".into()),
            verify: None,
            wait_secs: 0,
        }
    }

    #[test]
    fn a_shared_place_builds_the_team_environment_in_an_account_of_its_own() {
        let plan = a_box().base_plan();
        assert_eq!(plan.login.as_deref(), Some(BASE_LOGIN));
        assert!(plan.shared);
        assert!(plan.may_provision);
        // And it is not a login a member could ever be handed, or two people
        // would end up owning the thing they are both supposed to start from.
        assert!(member_login(BASE_LOGIN).is_err());
    }

    #[test]
    fn this_laptop_has_one_member_and_says_so_instead_of_making_an_account() {
        let plan = here().base_plan();
        assert_eq!(plan.login, None);
        assert!(!plan.shared);
        assert!(
            !plan.may_provision,
            "asking where this laptop's environment is would have made a Unix account on it"
        );
        // The branch is the same shape: asked, answered, nothing copied.
        let branch = here().branch_plan("mo");
        assert_eq!(branch.base_login, None);
        assert_eq!(branch.member_login, None);
        assert!(!branch.may_provision);
    }

    #[test]
    fn two_members_of_one_place_branch_from_the_same_base() {
        let place = a_box();
        let mine = place.branch_plan("mo");
        let theirs = place.branch_plan("ana");
        assert_eq!(mine.base_login, theirs.base_login);
        assert_ne!(mine.member_login, theirs.member_login);
    }

    #[test]
    fn only_the_stages_that_install_something_are_built_once() {
        // A service is something that RUNS. Started in the base it would be a
        // second copy of the team's database, on the same box, holding the same
        // port — which is not a warm start, it is an outage.
        let plan = installing_only(Plan {
            version: 4,
            digest: "sha256:abc".into(),
            steps: vec![
                step("mise", StepKind::Preflight),
                step("node", StepKind::Toolchain),
                step("ripgrep", StepKind::Package),
                step("npm ci", StepKind::Deps),
                step("postgres", StepKind::Service),
            ],
        });
        let kept: Vec<&str> = plan.steps.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(kept, vec!["mise", "node", "ripgrep"]);
        // The spec it came from travels with it, because that — not the step
        // list — is what the stamp compares and what decides whether the second
        // member pays.
        assert_eq!(plan.version, 4);
        assert_eq!(plan.digest, "sha256:abc");
    }

    /// A base that says it was built to `version`/`digest`.
    fn stamped(version: u32, digest: &str) -> TeamBase {
        TeamBase {
            place: "aura-runner".into(),
            login: BASE_LOGIN.into(),
            home: "/home/aura-base".into(),
            created: false,
            shared: true,
            readable: true,
            scoped: true,
            holds: vec![],
            carries: vec![],
            built_version: version,
            built_digest: digest.into(),
        }
    }

    #[test]
    fn the_second_member_through_installs_nothing() {
        // The acceptance criterion as a decision: given a base already built to
        // the spec in front of it, the answer is "nothing to do" — which is what
        // makes the second member's join a file copy rather than an install.
        let plan = Plan {
            version: 5,
            digest: "sha256:new".into(),
            steps: vec![step("node", StepKind::Toolchain)],
        };
        assert!(already_at(&stamped(5, "sha256:new"), &plan, false));
        // And a project that declares nothing: nobody ever pays, and the first
        // member is not told they did.
        let nothing = Plan {
            version: 1,
            digest: "sha256:empty".into(),
            steps: vec![],
        };
        assert!(already_at(&stamped(0, ""), &nothing, false));
    }

    #[test]
    fn a_base_built_from_one_spec_is_not_warm_for_another() {
        // The stamp is a fact about a spec, not about a directory existing. A
        // project that bumps its rust version has to be built again, and a base
        // that answered "already done" would hand every member a toolchain the
        // project stopped asking for a month ago.
        let plan = Plan {
            version: 5,
            digest: "sha256:new".into(),
            steps: vec![step("node", StepKind::Toolchain)],
        };
        assert!(
            !already_at(&stamped(4, "sha256:old"), &plan, false),
            "an older spec read as warm"
        );
        assert!(
            !already_at(&stamped(5, "sha256:old"), &plan, false),
            "an edited spec read as warm"
        );
        assert!(
            !already_at(&stamped(0, ""), &plan, false),
            "a base nobody built read as warm"
        );
        // A digest of nothing must never agree with a base that holds nothing,
        // or the emptiest possible state would read as the finished one.
        let no_digest = Plan {
            version: 0,
            digest: String::new(),
            steps: vec![step("node", StepKind::Toolchain)],
        };
        assert!(!already_at(&stamped(0, ""), &no_digest, false));
        // And forcing means forcing, whatever the stamp says.
        assert!(!already_at(&stamped(5, "sha256:new"), &plan, true));
    }

    #[test]
    fn what_the_base_holds_is_described_rather_than_listed_as_paths() {
        let held = Held::of(".cargo");
        assert_eq!(held.tool, "cargo");
        assert!(held.holds.contains("downloaded"), "{}", held.holds);
        // A path off the machine that the table has never heard of is still
        // reported. Dropping it would be the app hiding something it found.
        let odd = Held::of(".something-new");
        assert_eq!(odd.under, ".something-new");
        assert!(odd.tool.is_empty());
    }
}
