//! Two phases at a place: the setup phase installs, the agent phase does not.
//!
//! [`place_env`](super::place_env) is the setup phase and needs nothing from
//! this file — it runs with whatever network the machine has, because installing
//! *is* network use and every host it reaches is one the project named by
//! installing from it. This file is the other half: it works out what the agent
//! phase may reach, writes the guard that holds it to that, and reads back
//! afterwards what it wanted and did not get.
//!
//! ## The list, and why it comes out of the signed spec
//!
//! `[env.network] allow` lives inside [`aura_env::EnvSpec`], which means it is
//! inside the digest the lock signs. An agent that has been talked into adding
//! its own exfiltration host to `.aura/settings.toml` has not widened the list
//! it is about to run behind; it has produced a spec whose seal no longer
//! matches, and this file then honours **none** of the declared entries — only
//! the floor. That is the whole reason the allowlist is not a config file
//! sitting next to the repository.
//!
//! ## Both place-modes, or neither
//!
//! Everything here goes through [`Place`], so a session started on this laptop
//! and a session started on a box get the same guard, from the same spec, by the
//! same code path. What differs is the wall underneath — seatbelt here,
//! nftables there — and that difference is [`aura_egress::wall`]'s business, one
//! layer below this one.
//!
//! ## What happens on a machine that cannot hold a wall
//!
//! It is asked first, over the wire, with the same shell the guard itself uses
//! ([`wall::WHICH`]). A machine that answers nothing does not get a guard
//! delivered — and does not quietly get an unconfined agent either: the plan
//! comes back with [`AgentPhase::holdable`] false and a sentence saying so, and
//! the surfaces that start work print it where the work is. Silence is the one
//! outcome this must never produce, because "the agent phase is confined" would
//! then be a claim nobody could check.

use std::time::Duration;

use aura_egress::{floor, wall, Egress, Guard, Phase, Report};
use serde::{Deserialize, Serialize};

use crate::cloudbox::script::quote;

use super::place::Place;

/// How long to spend asking a machine a one-line question about itself.
const PROBE_WAIT: Duration = Duration::from_secs(60);

/// A journal is one line per refusal. A run that produced more than this has
/// something in a retry loop, and the tally of the first megabyte says so just
/// as well as the tally of all of it.
const JOURNAL_CAP: usize = 1024 * 1024;

/// What the agent phase of a run at this place may reach, worked out before
/// anything starts.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentPhase {
    /// Always [`Phase::Agent`]. Carried so a surface showing this cannot get
    /// which half of the run it is describing wrong.
    pub phase: Phase,
    /// The list, each entry with why it is on it.
    pub allowed: Vec<aura_egress::Allowed>,
    /// The same list as one line.
    pub summary: String,
    /// Did the project's own `[env.network]` entries survive the seal check?
    /// False means the spec has been edited since it was signed and only the
    /// floor is being honoured.
    pub declared_honoured: bool,
    /// Can this machine hold the agent phase to the list at all?
    pub holdable: bool,
    /// Which wall it would use — `seatbelt`, `netfilter`, or empty.
    pub wall: String,
    /// The sentence to show. Always says something true; never empty.
    pub note: String,
}

impl AgentPhase {
    /// The list as the guard script takes it.
    fn egress(&self) -> Egress {
        Egress::of(self.allowed.clone())
    }
}

/// What a surface that starts an agent gets back: the wall, and what to say
/// about it.
#[derive(Debug, Clone, Default, PartialEq)]
pub(super) struct Confinement {
    /// The guard script to run the agent behind, in the member's own home.
    /// `None` means it is not confined here, and `note` says why.
    pub guard: Option<String>,
    /// The sentence to print where the work is. `None` only for work that is
    /// not the agent phase at all.
    pub note: Option<String>,
}

impl Confinement {
    /// Not confined, and here is why — the shape every failure takes.
    fn open(why: &str) -> Confinement {
        Confinement {
            guard: None,
            note: Some(why.trim().to_string()),
        }
    }

    /// The line that puts the sentence on screen before the work starts.
    ///
    /// Empty when there is nothing to say, so a shell session's command is
    /// byte-for-byte what it always was.
    pub fn announcement(&self) -> String {
        match self.note.as_deref().map(str::trim).filter(|n| !n.is_empty()) {
            Some(note) => format!("printf '%s\\n\\n' {}; ", quote(note)),
            None => String::new(),
        }
    }
}

impl Place {
    /// What the agent phase would be allowed to reach here, changing nothing.
    ///
    /// Two round trips at most: the spec off the place's own checkout, and one
    /// line asking the machine what it can hold. The git remote comes from the
    /// same checkout, because the remote an agent may push to is the one *that*
    /// machine has, not the one this laptop happens to be pointed at.
    pub async fn agent_phase(&self, bin: &str) -> Result<AgentPhase, String> {
        let declared = self.declared_env().await?;
        let remote = self.origin_remote().await;
        let wall = self.which_wall().await;
        agent_phase_of(bin, &declared, remote.as_deref(), &wall)
    }

    /// Everything a surface that starts an agent needs from this file: the
    /// guard to run it behind, and the sentence to print where the work is.
    ///
    /// Never fails the run. A place that could not be asked, a spec that would
    /// not parse, a home directory that would not take a file — each of those
    /// is a reason to say plainly that the agent phase is *not* confined here,
    /// and not a reason to leave somebody staring at a session that refused to
    /// start. The one thing this must not do is stay quiet.
    pub(super) async fn confine_agent(
        &self,
        session: &str,
        bin: &str,
        args: &[String],
        prompt: Option<&str>,
    ) -> Confinement {
        let plan = match self.agent_phase(bin).await {
            Ok(plan) => plan,
            Err(e) => return Confinement::open(&format!(
                "Aura could not work out this project's allowlist, so the agent phase is running \
                 with the whole network: {e}"
            )),
        };
        let run = run_name(session);
        // The guard runs the agent's *whole* line, flags included. Handing it a
        // line the flags were stripped out of would put the wall up around a
        // different command than the one the member asked for.
        let command = crate::cloudbox::script::agent_line(bin, args, prompt);
        match self.install_guard(&run, &plan, &command).await {
            Ok(Some(guard)) => Confinement {
                guard: Some(guard),
                note: Some(plan.note),
            },
            Ok(None) => Confinement::open(&plan.note),
            Err(e) => Confinement::open(&format!(
                "Aura could not put this run's allowlist on the machine, so the agent phase is \
                 running with the whole network: {e}"
            )),
        }
    }

    /// Write this run's guard onto the place, and say where it landed.
    ///
    /// `command` is the work's own command line, already shell-quoted by
    /// whoever built it — the guard runs it and nothing else. The script is
    /// `0700` in the member's own home, and is rewritten from the spec every
    /// time a run starts, so an edit to the copy on disk lasts exactly one run
    /// and is not something the seal has to cover.
    ///
    /// `Ok(None)` means this machine cannot hold a wall. Not an error, and not
    /// a silent pass: the caller gets the plan's own sentence to print where
    /// the work is.
    pub(super) async fn install_guard(
        &self,
        run: &str,
        plan: &AgentPhase,
        command: &str,
    ) -> Result<Option<String>, String> {
        if !plan.holdable {
            return Ok(None);
        }
        let guard = Guard::new(run, command, plan.egress())?;
        self.deliver(&guard.home_path(), 0o700, &guard.script())
            .await?;
        Ok(Some(guard.home_path()))
    }

    /// What one run's agent phase was refused.
    ///
    /// The journal is read off the place rather than kept here, because it is
    /// written by the broker on the machine the work ran on — which, for a box,
    /// is not this computer and may not have been reachable while the run was
    /// happening.
    pub async fn egress_report(&self, run: &str, bin: &str) -> Result<Report, String> {
        if !aura_egress::is_run_name(run) {
            return Err(format!("{run:?} isn't a run this can look up."));
        }
        let plan = self.agent_phase(bin).await?;
        // Through `sh` rather than `read`, which resolves against the project
        // root: a journal lives in the member's own home, and on a box with
        // per-member accounts only that machine knows where that is. A run that
        // was never confined, or that refused nothing, leaves no file — and an
        // empty report is the right answer to both.
        let rel = format!("{}/{run}.jsonl", aura_egress::REL_DIR);
        let cmd = format!("head -c {JOURNAL_CAP} \"$HOME\"/{} 2>/dev/null", quote(&rel));
        let text = match self.sh(&cmd, PROBE_WAIT).await {
            Ok(out) if out.ok() => out.stdout,
            _ => String::new(),
        };
        Ok(Report::read(run, &plan.egress(), &text))
    }

    /// Which wall this machine can hold, asked in the guard's own words.
    async fn which_wall(&self) -> String {
        match self.sh(wall::WHICH, PROBE_WAIT).await {
            Ok(out) if out.ok() => out.stdout.trim().to_string(),
            // A machine we could not ask is a machine we cannot claim confines
            // anything. The empty answer is the safe one and the honest one.
            _ => String::new(),
        }
    }

    /// Where this place's checkout came from, if it came from anywhere.
    ///
    /// Best-effort: a checkout with no remote is ordinary — a scratch worktree,
    /// a repository that has never been pushed — and it means the floor has one
    /// fewer entry, not that the run cannot start.
    async fn origin_remote(&self) -> Option<String> {
        let out = self
            .sh("git remote get-url origin 2>/dev/null", PROBE_WAIT)
            .await
            .ok()?;
        let url = out.stdout.trim().to_string();
        (out.ok() && !url.is_empty()).then_some(url)
    }
}

/// The same answer, assembled from measurements already taken.
///
/// Split out because the join is the part worth testing and it needs no machine
/// on the other end: given a spec whose seal has broken, or a machine that can
/// hold no wall, the plan it produces can be read exactly in a suite that never
/// dials. It is also how the conformance matrix asks both place-modes this
/// question — the one thing this feature must not do is exist on a box and not
/// on a laptop.
///
/// `wall` is what the machine said it can hold — `seatbelt`, `netfilter`, or
/// empty for neither. `remote` is the origin of *that* place's checkout, not
/// this laptop's, because the remote an agent may push to is the one it has.
pub fn agent_phase_of(
    bin: &str,
    declared: &super::place_env::Declared,
    remote: Option<&str>,
    wall: &str,
) -> Result<AgentPhase, String> {
    // A spec whose seal no longer matches contributes NOTHING, rather than
    // contributing what it says with a warning attached. That is what makes the
    // seal load-bearing: an agent talked into widening its own allowlist has
    // not widened anything it can use in the same run.
    let honoured = declared.trust.may_apply();
    let asked: Vec<String> = if honoured {
        declared.spec.network.allow.clone()
    } else {
        Vec::new()
    };
    let egress = Egress::plan(&asked, floor(bin, remote))?;

    Ok(AgentPhase {
        phase: Phase::Agent,
        summary: egress.summary(),
        allowed: egress.entries().to_vec(),
        declared_honoured: honoured,
        holdable: !wall.is_empty(),
        note: note(declared, honoured, wall, &egress),
        wall: wall.to_string(),
    })
}

/// The name a run's guard and journal are filed under, from the session's own
/// name.
///
/// Derived rather than generated so that anybody holding a session name can ask
/// what that run was refused, months later, without a second book to look it up
/// in. A session name may be longer than a run name is allowed to be; what gets
/// cut is the *front*, because the end is the nonce that makes it unique.
pub fn run_name(session: &str) -> String {
    let text = session.trim();
    let tail = if text.len() > 64 {
        &text[text.len() - 64..]
    } else {
        text
    };
    let name: String = tail
        .trim_start_matches(['.', '-', '_'])
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        .collect();
    if aura_egress::is_run_name(&name) {
        name
    } else {
        "agent".to_string()
    }
}

/// The sentence a person is shown about this run's network.
///
/// Every branch says something true and actionable. "This is confined" with no
/// detail is the sentence that gets believed when it should not be.
fn note(
    declared: &super::place_env::Declared,
    honoured: bool,
    wall: &str,
    egress: &Egress,
) -> String {
    if wall.is_empty() {
        return "This machine can't hold the agent phase to an allowlist — macOS needs \
                sandbox-exec, Linux needs nft, sg and root — so an agent started here would run \
                with the whole network. Declare nftables in this project's environment so the \
                setup phase installs it, or start the agent somewhere that can hold it."
            .to_string();
    }
    if !honoured {
        return format!(
            "This project's `[env.network]` list is being ignored because its seal no longer \
             matches: {}. The agent phase gets only what it cannot work without — {}. Run `aura \
             env sign` after reviewing the change.",
            declared.trust.describe(),
            egress.summary()
        );
    }
    format!(
        "The agent phase can reach {} — everything else is refused, and refusals are written \
         down. The setup phase before it had the whole network.",
        egress.summary()
    )
}

/// What the agent phase at a place may reach, before anything is started.
///
/// `machine_id` absent means this laptop. One command answers for both modes,
/// which is the only way the two can be kept honest.
#[tauri::command]
pub async fn place_agent_phase(
    root: String,
    machine_id: Option<String>,
    bin: String,
) -> Result<AgentPhase, String> {
    Place::resolve(root, machine_id.as_deref())
        .agent_phase(&bin)
        .await
}

/// What one run's agent phase wanted and was refused.
#[tauri::command]
pub async fn place_egress_report(
    root: String,
    machine_id: Option<String>,
    run: String,
    bin: String,
) -> Result<Report, String> {
    Place::resolve(root, machine_id.as_deref())
        .egress_report(&run, &bin)
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use aura_env::TrustState;

    fn block_on<F: std::future::Future>(f: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("a runtime")
            .block_on(f)
    }

    fn declared(trust: TrustState) -> super::super::place_env::Declared {
        super::super::place_env::Declared {
            spec: aura_env::EnvSpec::default(),
            trust,
            source: "this laptop".into(),
        }
    }

    #[test]
    fn a_machine_that_cannot_confine_is_said_so_rather_than_assumed_safe() {
        let text = note(
            &declared(TrustState::Unsigned),
            true,
            "",
            &Egress::default(),
        );
        assert!(text.contains("whole network"), "{text}");
        assert!(text.contains("sandbox-exec") && text.contains("nft"), "{text}");
    }

    #[test]
    fn an_edited_spec_grants_nothing_it_added() {
        // The point of keeping the list inside the signed spec. An agent that
        // talked its way into editing `.aura/settings.toml` gets the floor.
        let text = note(
            &declared(TrustState::Stale {
                sealed: "aaa".into(),
                actual: "bbb".into(),
            }),
            false,
            "seatbelt",
            &Egress::plan(&[], floor("claude", None)).expect("a plan"),
        );
        assert!(text.contains("is being ignored"), "{text}");
        assert!(text.contains("aura env sign"), "{text}");
        assert!(text.contains("api.anthropic.com:443"), "{text}");
    }

    #[test]
    fn an_ordinary_run_says_what_it_can_reach_and_that_setup_had_more() {
        let text = note(
            &declared(TrustState::SelfSigned {
                key_id: "k".into(),
            }),
            true,
            "seatbelt",
            &Egress::plan(&["github.com".into()], vec![]).expect("a plan"),
        );
        assert!(text.contains("one machine: github.com:443"), "{text}");
        assert!(text.contains("The setup phase before it had the whole network"), "{text}");
    }

    #[test]
    fn this_laptop_is_asked_which_wall_it_can_hold_for_real() {
        // Not a fixture: the same one-liner the guard runs, against the machine
        // the suite is on. On a developer's mac that is `seatbelt`; in a
        // container with no nft it is empty, and empty must stay a legal answer
        // rather than an error.
        let here = Place::resolve(".", None);
        let answer = block_on(here.which_wall());
        assert!(
            matches!(answer.as_str(), "seatbelt" | "netfilter" | ""),
            "the machine answered {answer:?}"
        );
        if cfg!(target_os = "macos") {
            assert_eq!(answer, "seatbelt");
        }
    }

    #[test]
    fn a_run_name_that_is_not_a_name_is_refused_before_a_path_is_built_from_it() {
        let here = Place::resolve(".", None);
        for bad in ["../../etc/passwd", "a b", "a;rm -rf ~", ""] {
            assert!(
                block_on(here.egress_report(bad, "claude")).is_err(),
                "{bad:?} was looked up"
            );
        }
    }

    #[test]
    fn the_plan_for_this_laptop_carries_its_own_model_and_says_which_phase_it_is() {
        let here = Place::resolve(".", None);
        let plan = block_on(here.agent_phase("claude")).expect("a plan");
        assert_eq!(plan.phase, Phase::Agent);
        assert!(plan.phase.is_confined());
        assert!(
            plan.allowed
                .iter()
                .any(|a| a.endpoint.host() == "api.anthropic.com"),
            "{:?}",
            plan.allowed
        );
        assert!(!plan.note.trim().is_empty());
        // This repository has a remote, and an agent that cannot fetch from it
        // is an agent that cannot do the job it was started for.
        assert!(
            plan.allowed
                .iter()
                .any(|a| a.reason == aura_egress::Reason::Remote),
            "{:?}",
            plan.allowed
        );
    }
}
