//! The work running at a place, and how to start more of it.
//!
//! This is the half of the contract that used to be spelled `box_*` and only
//! existed for a machine. Reading it now, none of it was ever about a machine:
//! "what is running here", "start one", "stop it", "which projects do you
//! hold", "which agents can you run" are questions this laptop answers too, and
//! it answers them the same way — because the answer is tmux either side.
//!
//! So the bodies moved here rather than being reimplemented, and the `box_*`
//! commands became one line each that names a machine and asks *this*. There is
//! no second implementation to keep in step, which is the only version of
//! parity that survives contact with a deadline.
//!
//! ## Why tmux is the registry, in both places
//!
//! tmux holds `@`-prefixed options per session and hands them back in a format
//! string, so the session list is not a record we keep and hope stays true —
//! the sessions **are** the record. Nothing to install, no daemon, no second
//! source of truth to drift, and when a session ends so does everything we knew
//! about it. That was written for a box that may never have heard of Aura; it
//! turns out to be exactly as good a deal locally.

use crate::cloudbox::domain::{BoxProject, BoxSession, NewSession};
use crate::cloudbox::{nonce, parse, script};

use super::place::Place;
use super::place_contract::{Capabilities, TOOLS};
use super::place_egress::Confinement;
use super::place_git;

/// A sentence printed into a session before the work in it starts.
///
/// Spelled the same way as [`Confinement::announcement`] because it is the same
/// act — telling the person who started this what is about to happen on their
/// behalf, where they are looking — and two spellings would be two places for a
/// quote inside somebody's name to break the line. Nothing to say is the
/// ordinary case and costs an empty string, never a blank line.
fn say(sentence: &str) -> String {
    match sentence.trim() {
        "" => String::new(),
        s => format!("printf '%s\\n\\n' {}; ", script::quote(s)),
    }
}

impl Place {
    /// Everything running here, right now.
    ///
    /// Read back every time rather than remembered: a session we believe in
    /// that died an hour ago is worse than no list at all — you click it, a
    /// terminal opens on nothing, and the app looks like it lied.
    pub async fn sessions(&self) -> Result<Vec<BoxSession>, String> {
        Ok(parse::sessions(&self.ask(script::list_sessions()).await?))
    }

    /// Every project this place has a copy of.
    pub async fn projects(&self) -> Result<Vec<BoxProject>, String> {
        Ok(parse::projects(&self.ask(script::list_projects()).await?))
    }

    /// What this place can actually run.
    ///
    /// `agent_bins` is the candidate set — the picker's own list of binary
    /// names. The answer holds the subset present, in the order asked, so a
    /// picker offers what will run HERE rather than the six the laptop imagines
    /// every place holds and then discovers, one failed session at a time, that
    /// it doesn't. An empty `agents` is a real answer, distinct from an error.
    pub async fn capabilities(&self, agent_bins: &[String]) -> Result<Capabilities, String> {
        // The tools go on the end, and only when not already asked for, so the
        // agent half of the answer keeps the caller's own order and nothing is
        // probed — or printed — twice.
        let mut probe = agent_bins.to_vec();
        for tool in TOOLS {
            if !probe.iter().any(|b| b == tool) {
                probe.push(tool.to_string());
            }
        }
        let found = parse::installed(&self.ask(script::probe_agents(&probe)).await?);
        let has = |name: &str| found.iter().any(|f| f == name);
        Ok(Capabilities {
            agents: found
                .iter()
                .filter(|f| agent_bins.iter().any(|b| b == *f))
                .cloned()
                .collect(),
            git: has("git"),
            tmux: has("tmux"),
            aura: has("aura"),
        })
    }

    /// Start something, and hand back the session it started so the caller can
    /// open it without asking a second time what just happened.
    pub async fn start(&self, spec: NewSession) -> Result<BoxSession, String> {
        if !script::is_abs_path(&spec.project) {
            return Err(format!("{} isn't a directory on that machine.", spec.project));
        }
        let branch = match spec.branch.as_deref().map(str::trim).filter(|b| !b.is_empty()) {
            Some(b) if !script::is_branch(b) => {
                return Err(format!("{b} isn't a branch name git will take."))
            }
            Some(b) => Some(b.to_string()),
            None => None,
        };

        // Its own branch means its own directory. Two agents editing one
        // checkout is not parallelism, it's a merge conflict with extra steps.
        let dir = match &branch {
            Some(b) => {
                let path = script::worktree_path(&spec.project, b);
                self.ask(script::add_worktree(&spec.project, &path, b)).await?;
                path
            }
            None => spec.project.clone(),
        };

        let kind = if spec.kind == "agent" { "agent" } else { "shell" };
        let spec = NewSession {
            kind: kind.into(),
            branch: branch.clone(),
            ..spec
        };
        // The work this starts is the work that pushes, so it gets the same
        // member's secrets the credential seam is about to name — put there as
        // environment, before anything runs, rather than handed to the agent to
        // pass along. Nothing held is the ordinary case and costs an empty
        // string.
        let member = place_git::member_for(self, None).await;
        let preload = self.install_session_secrets(&member).await?;
        let name = script::session_name(kind, &dir, &nonce());

        // Whose credential this run spends, decided before it starts rather than
        // inherited from whatever the machine happens to hold. The same bargain
        // `clone_project` makes just below: the member is resolved first, the
        // place is asked what it has for *them*, and the answer is announced in
        // the session rather than discovered on a bill. A shell spends nothing,
        // so it is not asked.
        let (load, whose) = match spec.agent.as_deref().filter(|_| kind == "agent") {
            Some(engine) => self.agent_key_spend(&member, engine).await,
            None => (String::new(), String::new()),
        };

        // The two phases split here. Everything above ran with whatever network
        // this machine has, because installing is what a network is for. An
        // agent does not get that: it is started by a guard holding this
        // project's allowlist, and what it wanted and did not get is written
        // down beside the guard.
        //
        // A shell session is not the agent phase and is not confined — a person
        // at a keyboard is who the allowlist is protecting, not who it is
        // protecting against.
        let confine = match spec.agent.as_deref().filter(|_| kind == "agent") {
            // A detached session spec carries no flags — `NewSession` has no argv.
            Some(bin) => {
                self.confine_agent(&name, bin, &[], spec.prompt.as_deref())
                    .await
            }
            None => Confinement::default(),
        };
        // Both sentences are printed inside the session, before the work starts,
        // where the person who started it is looking. A run that could not be
        // confined must never be quiet about it: "the agent phase is walled"
        // would otherwise be a claim nobody could check from the outside. And
        // whose credential is about to be spent is said *before* the key is
        // loaded, not after the engine has already billed somebody.
        let preload = format!("{preload}{}{load}{}", say(&whose), confine.announcement());

        self.ask(script::start_session(
            &spec,
            &name,
            &dir,
            &preload,
            confine.guard.as_deref(),
        ))
        .await?;

        // Read it back rather than describing what we asked for: the place is
        // the authority on what exists, and a row we invented here would be the
        // first thing to disagree with it.
        self.sessions()
            .await?
            .into_iter()
            .find(|s| s.name == name)
            .ok_or_else(|| "The machine took the session but didn't list it afterwards.".to_string())
    }

    /// End a session. Whatever it was running ends with it.
    pub async fn stop(&self, session: &str) -> Result<(), String> {
        if !script::is_session_name(session) {
            return Err(format!("{session} isn't a session on that machine."));
        }
        self.ask(script::stop_session(session)).await?;
        Ok(())
    }

    /// End a session, and stop lending this place your agent once nothing of
    /// yours is running here any more.
    ///
    /// A forwarded agent lasts exactly as long as the connection, and the
    /// connection is shared by every session on the place — so it can only be
    /// let go when the last one ends, and it must be, or the box keeps the use
    /// of your key after the work it was lent for is over. That is the
    /// difference between a decision you made about a piece of work and one you
    /// made about a machine, permanently, without noticing.
    ///
    /// The count is read back from the place rather than tracked here: sessions
    /// are started and killed by other surfaces and by people typing `tmux`, and
    /// a tally kept on this laptop would be wrong the first time either happened.
    ///
    /// Letting go is best-effort on purpose. The session really did end, and a
    /// caller told that ending it failed would try again and end a second one.
    /// What is not best-effort is the deadline: a connection nobody hung up
    /// expires on its own, because a forwarded one is set to persist for
    /// seconds rather than minutes ([`crate::cloudbox`]).
    pub async fn stop_and_release(&self, session: &str) -> Result<(), String> {
        self.stop(session).await?;
        if !self.forwards_agent() {
            return Ok(());
        }
        if self.sessions().await.is_ok_and(|left| left.is_empty()) {
            let _ = self.stop_forwarding().await;
        }
        Ok(())
    }

    /// Put a project here, in a session you can watch it arrive in.
    ///
    /// `member` is who the clone is for. It matters because a clone is the first
    /// push credential a project ever spends: run bare, it silently uses
    /// whatever the box happens to hold — on a shared box, the token of whoever
    /// provisioned it. So the credential is chosen first, by name, and the
    /// session says which one it got.
    pub async fn clone_project(
        &self,
        remote_url: &str,
        dir: &str,
        member: Option<&str>,
    ) -> Result<BoxSession, String> {
        if !script::is_remote_url(remote_url) {
            return Err(
                "That doesn't look like a git remote the machine can clone (https, ssh or git@)."
                    .to_string(),
            );
        }
        // A folder name rather than a path is the normal answer to "what should
        // this be called", and only the machine that will hold it knows where
        // its own home is — so it gets asked instead of guessed. A full path
        // still works, for the case where you mean somewhere specific.
        let dir = if dir.contains('/') {
            dir.to_string()
        } else if script::is_dir_name(dir) {
            let home = self.ask(script::home_dir()).await?;
            let home = home.trim().trim_end_matches('/');
            if home.is_empty() {
                return Err("The machine didn't say where its home directory is.".to_string());
            }
            format!("{home}/{dir}")
        } else {
            return Err(format!("{dir} isn't a name the machine can make a folder out of."));
        };
        if !script::is_abs_path(&dir) {
            return Err(format!("{dir} isn't a directory the machine can clone into."));
        }
        let name = script::session_name("clone", &dir, &nonce());
        let member = place_git::member_for(self, member).await;
        let (opts, note) = self.git_credential_args(&member, remote_url).await;
        self.ask(script::clone_project(remote_url, &dir, &name, &opts, &note))
            .await?;
        self.sessions()
            .await?
            .into_iter()
            .find(|s| s.name == name)
            .ok_or_else(|| {
                "The machine started the clone but didn't list it afterwards.".to_string()
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bins(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    /// The probe list the capability question sends, without a machine.
    fn probed(agent_bins: &[String]) -> Vec<String> {
        let mut probe = agent_bins.to_vec();
        for tool in TOOLS {
            if !probe.iter().any(|b| b == tool) {
                probe.push(tool.to_string());
            }
        }
        probe
    }

    #[test]
    fn asking_what_runs_here_costs_one_round_trip_not_two() {
        // Agents and tools go in the same `command -v` loop. Splitting them
        // would double the wait on a box across an ocean for no new fact.
        let probe = probed(&bins(&["claude", "codex"]));
        assert_eq!(probe, bins(&["claude", "codex", "git", "tmux", "aura"]));
        let script = script::probe_agents(&probe);
        for want in ["'claude'", "'codex'", "'git'", "'tmux'", "'aura'"] {
            assert!(script.contains(want), "{want} missing from {script}");
        }
    }

    #[test]
    fn a_tool_the_caller_already_asked_about_is_not_asked_about_twice() {
        // Otherwise it prints twice and reads back as two installs.
        assert_eq!(
            probed(&bins(&["git", "claude"])),
            bins(&["git", "claude", "tmux", "aura"])
        );
    }

    #[test]
    fn the_agents_come_back_in_the_order_they_were_asked_for() {
        // The picker draws them in this order; a set would reshuffle the list
        // every time the answer arrived.
        let asked = bins(&["claude", "codex", "gemini"]);
        let found = parse::installed("claude\ngemini\ngit\ntmux\n");
        let agents: Vec<String> = found
            .iter()
            .filter(|f| asked.iter().any(|b| b == *f))
            .cloned()
            .collect();
        assert_eq!(agents, bins(&["claude", "gemini"]));
    }

    #[test]
    fn a_place_with_no_agents_is_an_answer_not_a_failure() {
        let found = parse::installed("git\ntmux\n");
        let asked = bins(&["claude"]);
        let agents: Vec<String> = found
            .iter()
            .filter(|f| asked.iter().any(|b| b == *f))
            .cloned()
            .collect();
        assert!(agents.is_empty());
        assert!(found.iter().any(|f| f == "git"));
    }

    #[tokio::test]
    async fn the_laptop_answers_the_capability_question_for_real() {
        // Not a string test. This runs `cloudbox`'s own probe script through
        // the local arm and reads it back with `cloudbox`'s own parser, which
        // is the claim: the box's implementation IS the implementation.
        //
        // `sh` rather than an agent, because a test may not assume which CLIs
        // the machine running it happens to have — but it is certainly running
        // under a shell.
        let here = Place::Here { root: "/tmp".into() };
        let caps = here.capabilities(&bins(&["sh"])).await.expect("an answer");
        assert_eq!(caps.agents, bins(&["sh"]));
        // git/tmux/aura are *answered* either way; asserting they are installed
        // would be asserting something about whoever's machine this is.
        assert_eq!(caps.git, which("git"));
        assert_eq!(caps.tmux, which("tmux"));
    }

    #[tokio::test]
    async fn a_laptop_with_no_tmux_running_has_no_sessions_rather_than_an_error() {
        // A machine nobody is using is the normal state of a machine, and tmux
        // says so on stderr with a non-zero exit. That is an empty list, not a
        // fault — and it has to read that way locally too, or the local arm
        // fails wherever the remote one is merely quiet.
        let here = Place::Here { root: "/tmp".into() };
        here.sessions().await.expect("a list, empty or not");
    }

    fn which(bin: &str) -> bool {
        std::process::Command::new("sh")
            .args(["-c", &format!("command -v {bin} >/dev/null 2>&1")])
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }

    #[tokio::test]
    async fn a_session_name_that_is_not_one_is_refused_before_anything_runs() {
        // The check has to happen up here, not in the quoting: `stop` addresses
        // a session BY NAME, and a name is all it can ever be.
        let here = Place::Here { root: "/tmp".into() };
        let e = here.stop("a; tmux kill-server").await.unwrap_err();
        assert!(e.contains("isn't a session"), "{e}");
    }

    #[tokio::test]
    async fn starting_somewhere_that_is_not_a_directory_is_refused() {
        let here = Place::Here { root: "/tmp".into() };
        let e = here
            .start(NewSession {
                project: "not/absolute".into(),
                kind: "shell".into(),
                agent: None,
                title: None,
                branch: None,
                prompt: None,
            })
            .await
            .unwrap_err();
        assert!(e.contains("isn't a directory"), "{e}");
    }

    #[tokio::test]
    async fn a_branch_name_git_would_not_take_never_reaches_git() {
        let here = Place::Here { root: "/tmp".into() };
        let e = here
            .start(NewSession {
                project: "/tmp".into(),
                kind: "shell".into(),
                agent: None,
                title: None,
                branch: Some("../../etc".into()),
                prompt: None,
            })
            .await
            .unwrap_err();
        assert!(e.contains("isn't a branch name"), "{e}");
    }

    #[tokio::test]
    async fn something_that_is_not_a_git_remote_is_refused_wherever_it_would_land() {
        let here = Place::Here { root: "/tmp".into() };
        let e = here
            .clone_project("rm -rf /", "naridon", None)
            .await
            .unwrap_err();
        assert!(e.contains("git remote"), "{e}");
    }
}
