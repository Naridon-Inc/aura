//! Lending a place your ssh agent, and taking it back.
//!
//! The tenth question in the runtime contract: **when work here pushes, signs,
//! or reaches another host over ssh, whose key does it use?** Until now the
//! answer on a box was always "the box's" — `ssh_argv` named no `-A` and no
//! `ForwardAgent`, so there was no way for a member's own key to be the one that
//! signed, short of copying it onto a machine they share. Copying a key onto a
//! box is the thing this exists to make unnecessary.
//!
//! ## Why it is off until somebody says otherwise
//!
//! Forwarding does not send the key. It sends a *channel to the key*: for as
//! long as the connection is up, anything running as that login on that box can
//! ask your agent to sign, and your agent will. It cannot read the key, and it
//! cannot keep anything after the connection goes — but while the connection is
//! there, it can open any host your key opens. On a box you share with your
//! team, that is a decision about how much you trust the machine and everyone
//! with root on it.
//!
//! So it is not a preference, not a global setting and not something a wizard
//! turns on while doing something else. It is per place, it starts off, and a
//! book written before this existed reads as off rather than as consent nobody
//! gave ([`crate::cmd_machines::Machine::forward_agent`]).
//!
//! ## The three moments
//!
//! * [`place_forwarding`] — is this place lending, and what would lending mean
//! * [`place_forward_set`] — the member decides, for this place
//! * [`place_forward_release`] — take it back now, without waiting for a timeout
//!
//! Turning it off hangs up the connection that carried it, because the flag
//! alone would only change what the *next* connection does while the current one
//! kept the window open. The same hang-up happens when the last session on the
//! place ends ([`Place::stop_and_release`]).
//!
//! ## Both place-modes, one answer
//!
//! This laptop cannot lend itself an agent, and that is not a missing feature —
//! work here already runs beside your agent, which is the state a box is being
//! lent. [`Forwarding::supported`] says which of the two a place is, so a
//! surface renders one control and never has to ask what kind of place it holds.
//! Nothing here reads how a place was provisioned, so a managed place gets this
//! the day it exists, with none of it edited.

use serde::{Deserialize, Serialize};

use super::place::Place;

/// Whether this place is using your key, and whether it could.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Forwarding {
    /// What to call the place in a sentence.
    pub place: String,
    /// Can this place be lent an agent at all?
    pub supported: bool,
    /// Is it being lent one now?
    pub on: bool,
    /// The state in the place's own terms, for a surface that would otherwise
    /// have to write three sentences and keep them in step with this file.
    pub note: String,
}

impl Forwarding {
    fn here(place: &str) -> Self {
        Forwarding {
            place: place.to_string(),
            supported: false,
            on: false,
            note: "Work here already runs beside your agent, so there is nothing to forward."
                .into(),
        }
    }

    fn on_a_box(place: &str, on: bool) -> Self {
        Forwarding {
            place: place.to_string(),
            supported: true,
            on,
            note: if on {
                format!(
                    "{place} can ask your agent to sign while it is connected. It never receives \
                     the key itself, and it loses even that when the connection closes."
                )
            } else {
                format!("{place} uses its own key. Nothing of yours is reachable from it.")
            },
        }
    }

    fn of(place: &Place) -> Self {
        match place {
            Place::Here { .. } => Forwarding::here(place.label()),
            Place::Box { .. } => Forwarding::on_a_box(place.label(), place.forwards_agent()),
        }
    }
}

/// Is this place using your key?
///
/// `machine_id` names a box; omit it and the answer is about this laptop, which
/// answers rather than erroring — a surface that has to know which kind of place
/// it holds before it can ask a question is a surface that will get it wrong
/// somewhere.
#[tauri::command]
pub async fn place_forwarding(
    root: Option<String>,
    machine_id: Option<String>,
) -> Result<Forwarding, String> {
    let place = match machine_id.as_deref().map(str::trim).filter(|id| !id.is_empty()) {
        Some(id) => Place::at_machine(id)?,
        None => Place::resolve(root.unwrap_or_default(), None),
    };
    Ok(Forwarding::of(&place))
}

/// Lend this place your agent, or stop.
///
/// Turning it off closes the connection that was carrying it, so the decision
/// takes effect on the connection in hand rather than on the next one. Turning
/// it on does not open anything: the next call to the place carries the agent,
/// and until then nothing has changed on the far side.
///
/// A place that cannot be lent one is a named refusal rather than a silent
/// success, because "you turned it on and nothing happened" is the worst
/// possible answer to a question about a key.
#[tauri::command]
pub async fn place_forward_set(machine_id: String, on: bool) -> Result<Forwarding, String> {
    // Read before writing. This is the place as it is *now* — including the
    // socket the current connection is multiplexed on, which is the one that has
    // to be hung up if the answer is changing to no. Rebuilding it after the
    // write would name the socket a connection that does not exist yet will use.
    let place = Place::at_machine(&machine_id)?;
    let was = place.forwards_agent();
    crate::cmd_machines::set_forward_agent(&machine_id, on)?;

    if was && !on {
        // Best-effort, and deliberately so: the member's decision is recorded
        // whatever the box does about it, and a connection nobody could hang up
        // expires on its own within seconds. Reporting a failure here would
        // leave the surface showing "on" for a place that is no longer lending.
        let _ = place.stop_forwarding().await;
    }
    Ok(Forwarding::of(&Place::at_machine(&machine_id)?))
}

/// Take the agent back now.
///
/// For the end of a piece of work rather than the end of the arrangement: the
/// place stays opted in, and the next thing that reaches it carries the agent
/// again. What it does not do is leave a window open onto your key across a
/// break in which nothing of yours is running there.
#[tauri::command]
pub async fn place_forward_release(
    root: Option<String>,
    machine_id: Option<String>,
) -> Result<Forwarding, String> {
    let place = match machine_id.as_deref().map(str::trim).filter(|id| !id.is_empty()) {
        Some(id) => Place::at_machine(id)?,
        None => Place::resolve(root.unwrap_or_default(), None),
    };
    place.stop_forwarding().await?;
    Ok(Forwarding::of(&place))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn machine(forward: bool) -> crate::cmd_machines::Machine {
        crate::cmd_machines::Machine {
            id: "ubuntu@10.0.0.4:/srv/alpha".into(),
            name: "aura-runner".into(),
            host: "10.0.0.4".into(),
            user: "ubuntu".into(),
            key_path: "/Users/mo/.ssh/aura.pem".into(),
            box_kind: "mine".into(),
            repo_path: Some("/srv/alpha".into()),
            project_root: None,
            repo_branch: None,
            org_slug: None,
            forward_agent: forward,
            instance_id: None,
            asleep_since: 0,
            added_at: 1,
            last_used_at: 2,
        }
    }

    fn a_box(forward: bool) -> Place {
        Place::Box {
            machine: Box::new(machine(forward)),
            root: "/srv/alpha".into(),
            here: std::env::temp_dir().display().to_string(),
        }
    }

    #[test]
    fn a_place_nobody_lent_an_agent_says_it_uses_its_own_key() {
        let state = Forwarding::of(&a_box(false));
        assert!(state.supported, "a box is a place that could be lent one");
        assert!(!state.on, "forwarding was on for a place nobody opted in");
        assert!(state.note.contains("its own key"), "{}", state.note);
        assert!(
            state.note.contains("Nothing of yours"),
            "off must say what off means: {}",
            state.note
        );
    }

    #[test]
    fn a_place_that_was_lent_one_says_what_it_can_do_with_it() {
        // The sentence a member reads before deciding. It has to say the two
        // things that are true and easy to get wrong: the box can USE the key,
        // and it never HAS the key.
        let state = Forwarding::of(&a_box(true));
        assert!(state.on);
        assert!(state.note.contains("ask your agent to sign"), "{}", state.note);
        assert!(state.note.contains("never receives the key"), "{}", state.note);
        assert!(
            state.note.contains("connection closes"),
            "the sentence must bound it in time: {}",
            state.note
        );
    }

    #[test]
    fn this_laptop_is_not_a_place_that_can_be_lent_an_agent() {
        // And says why, rather than offering a control that would do nothing.
        let here = Place::Here {
            root: std::env::temp_dir().display().to_string(),
        };
        let state = Forwarding::of(&here);
        assert!(!state.supported && !state.on);
        assert_eq!(state.place, "this laptop");
        assert!(state.note.contains("nothing to forward"), "{}", state.note);
    }

    #[tokio::test]
    async fn taking_the_agent_back_is_something_every_place_answers() {
        // The parity rule for the release: this laptop has nothing to hang up
        // and succeeds, so a caller tidying up after a session never has to know
        // which kind of place it just finished with.
        let state = place_forward_release(Some(std::env::temp_dir().display().to_string()), None)
            .await
            .expect("this laptop must be able to answer");
        assert!(!state.supported);
    }

    #[test]
    fn a_place_is_never_opted_in_by_being_written_down_again() {
        // The default is the feature. A machine row saved by the connect wizard,
        // or re-saved to correct a key path, must come back off — and a book
        // written before this field existed must read as off rather than as a
        // decision nobody made.
        let fresh: crate::cmd_machines::Machine =
            serde_json::from_str(r#"{"id":"ubuntu@h:/p","name":"n","host":"h","user":"ubuntu",
                 "key_path":"/k.pem","box_kind":"mine","added_at":1,"last_used_at":2}"#)
                .expect("a row from before the field existed");
        assert!(!fresh.forward_agent);
    }

    /// The governing rule of this programme, made structural: nothing here can
    /// tell a box you brought from one Aura provisioned, because there is
    /// nothing here to tell it with.
    #[test]
    fn lending_an_agent_never_asks_what_kind_of_place_this_is() {
        let src = include_str!("place_forward.rs");
        let code = src
            .lines()
            .take_while(|l| !l.starts_with("#[cfg(test)]"))
            .filter(|l| !l.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n");
        for asked in ["box_kind", "managed", "provisioning_mode", "is_byoc"] {
            assert!(
                !code.contains(asked),
                "place_forward branches on `{asked}` — one place-mode is about to get a \
                 way of pushing as yourself that the other doesn't"
            );
        }
    }
}

/// The whole arrangement, against a real box and a real remote.
///
/// Everything above proves the decision is recorded, the argv is built and the
/// sentence is right. None of it proves the thing the member is actually being
/// offered: **that a push from that box goes out signed by the key on this
/// laptop, and that the key is not on the box.** Only a live run can say that.
///
/// ```text
/// AURA_LIVE_MACHINE='ubuntu@host:/home/ubuntu/naridon' \
/// AURA_LIVE_SSH_REMOTE='git@github.com:you/scratch.git' \
///   cargo test --lib manager::brain::place_forward::live -- --ignored --test-threads=1
/// ```
///
/// `AURA_LIVE_SSH_REMOTE` should be a repository you may write to; the push is a
/// `--dry-run`, so it authenticates and negotiates and then writes nothing.
///
/// Nothing here touches the machine book. The opted-in place is built in memory
/// from the row that is already there, so a test run never leaves a box lent an
/// agent it was not lent before.
#[cfg(test)]
mod live {
    use super::*;
    use crate::manager::brain::place_git::{parse_survey, survey_script};
    use std::time::Duration;

    /// The box under test, exactly as the book has it — which must be off.
    fn plain() -> Option<Place> {
        let id = std::env::var("AURA_LIVE_MACHINE").ok().filter(|v| !v.is_empty())?;
        let p = Place::at_machine(&id).expect("a machine in the book");
        assert!(
            !p.forwards_agent(),
            "{id} is already opted into forwarding — the off-by-default half of this \
             cannot be observed against it"
        );
        Some(p)
    }

    /// The same box with the member's agent lent to it.
    fn lent(p: &Place) -> Place {
        let Place::Box { machine, root, here } = p else {
            unreachable!("plain() asserts this is a box")
        };
        let mut machine = machine.clone();
        machine.forward_agent = true;
        Place::Box {
            machine,
            root: root.clone(),
            here: here.clone(),
        }
    }

    fn block_on<F: std::future::Future>(f: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("a runtime")
            .block_on(f)
    }

    fn agent_on(p: &Place) -> crate::manager::brain::place_git::AgentFacts {
        let out = block_on(p.ask(survey_script("nobody", "github.com"))).expect("a survey");
        parse_survey(p.label(), &out).expect("facts").agent
    }

    #[test]
    #[ignore = "needs a real box; set AURA_LIVE_MACHINE"]
    fn a_box_nobody_lent_an_agent_cannot_reach_one() {
        let Some(p) = plain() else { return };
        let there = agent_on(&p);
        assert!(
            !there.usable(),
            "an unlent box reached an agent at {} — either it runs one of its own, or \
             ForwardAgent is being set by something other than this code",
            there.socket
        );
    }

    #[test]
    #[ignore = "needs a real box; set AURA_LIVE_MACHINE"]
    fn a_lent_box_reaches_the_agent_on_this_laptop_and_no_key_lands_there() {
        let Some(p) = plain() else { return };
        let lent = lent(&p);
        let there = agent_on(&lent);
        assert!(
            there.usable(),
            "the box was lent an agent and could not reach one — is `ssh-add -l` empty here?"
        );

        // The same key, both ends. This is what "your own key" means, and the
        // only check that can tell it from an agent the machine runs itself.
        let here = Place::Here {
            root: std::env::temp_dir().display().to_string(),
        };
        let mine = {
            let out = block_on(here.ask(survey_script("nobody", "github.com"))).expect("a survey");
            parse_survey("this laptop", &out).expect("facts").agent.fingerprints
        };
        assert!(
            there.shares_a_key_with(&mine),
            "the box reached an agent holding none of this laptop's keys: {:?} vs {:?}",
            there.fingerprints,
            mine
        );

        // And the key itself is not there. An agent socket is a channel, not a
        // file — `ssh-add -L` prints public keys and no private material exists
        // on the far side to print.
        let private = block_on(lent.sh(
            "ls -1 ~/.ssh/id_* 2>/dev/null | grep -v '\\.pub$' | wc -l",
            Duration::from_secs(20),
        ))
        .expect("a listing");
        assert_eq!(
            private.stdout.trim(),
            "0",
            "there are private keys in that login's ~/.ssh — forwarding is not what put \
             them there, but this box cannot prove the claim"
        );
    }

    #[test]
    #[ignore = "needs a real box; set AURA_LIVE_MACHINE"]
    fn the_credential_seam_picks_the_lent_key_for_an_ssh_remote() {
        let Some(p) = plain() else { return };
        let remote = std::env::var("AURA_LIVE_SSH_REMOTE")
            .ok()
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| "git@github.com:naridon/aura.git".into());
        let member = block_on(super::super::place_git::member_for(&p, None));

        let unlent = block_on(p.push_credential(&member, &remote)).expect("an answer");
        assert!(
            unlent.credential.is_none(),
            "an unlent box offered {:?} for an ssh push",
            unlent.credential.map(|c| c.source)
        );

        let lent = lent(&p);
        let plan = block_on(lent.push_credential(&member, &remote)).expect("an answer");
        let cred = plan
            .credential
            .unwrap_or_else(|| panic!("a lent box chose nothing: {:?}", plan.considered));
        assert_eq!(cred.source, "ssh-agent");
        assert!(!cred.shared && !cred.last_resort);
        assert!(cred.git_config_args().is_empty());
    }

    #[test]
    #[ignore = "needs a real box; set AURA_LIVE_SSH_REMOTE and AURA_LIVE_MACHINE"]
    fn a_push_from_the_box_is_signed_by_the_key_on_this_laptop() {
        // The end goal, run for real. `--dry-run` authenticates, negotiates and
        // writes nothing — so this proves the push would land, using a key the
        // box does not have, without leaving a commit behind to clean up.
        let Some(p) = plain() else { return };
        let Some(remote) = std::env::var("AURA_LIVE_SSH_REMOTE").ok().filter(|v| !v.is_empty())
        else {
            return;
        };
        let lent = lent(&p);

        // Reachable first, so a failure below is about the push rather than
        // about a laptop with an empty agent.
        assert!(agent_on(&lent).usable(), "no key to push with");

        let cmd = format!(
            "cd \"$(mktemp -d)\" && git init -q scratch && cd scratch && \
             git remote add origin {remote} && \
             git ls-remote origin >/dev/null && \
             git fetch -q --depth 1 origin HEAD && \
             git checkout -q FETCH_HEAD && \
             git push --dry-run origin HEAD:refs/heads/aura-agent-forward-probe 2>&1"
        );
        let out = block_on(lent.sh(&cmd, Duration::from_secs(120))).expect("the push ran");
        assert!(
            out.ok(),
            "a push over the lent agent failed:\n{}\n{}",
            out.stdout,
            out.stderr
        );

        // And the same push without the agent must NOT succeed, or the box has a
        // key of its own for that host and this proves nothing about forwarding.
        let without = block_on(p.sh(&cmd, Duration::from_secs(120))).expect("the push ran");
        assert!(
            !without.ok(),
            "the box pushed to {remote} with no agent lent to it — it holds a key for that \
             host itself, so this box cannot prove the claim:\n{}",
            without.stdout
        );
    }
}
