//! Stopping a place nobody is using, and saying so where it shows.
//!
//! The offer of a machine Aura made is that an idle one costs nothing. Nothing
//! in the app collected on that: a managed box, once created, ran until somebody
//! remembered to end it — and ending one destroys its disk, so the only lever
//! anybody had was the one nobody wants to pull. This is the other lever. The
//! machine stops, the disk stays, and starting it again puts everything back.
//!
//! ## Two halves, and the second one is the feature
//!
//! Stopping the box is the easy half — [`policy`] decides, the provisioning seam
//! does it, the machine book writes it down. The half that matters is that a
//! stopped place has to READ as stopped. Everything in this app that draws a
//! machine draws it by trying to reach it, and a machine that is asleep refuses
//! every connection exactly the way a broken one does. Left alone, the first
//! thing scaling to zero would have done is make every member's roster fill up
//! with boxes that look dead.
//!
//! So sleeping is written down on the row ([`Machine::asleep_since`]), not
//! inferred from a failed dial, and every surface that could otherwise draw a
//! sleeping place as an unreachable one reads that field first. It is also why
//! [`place_sleeping`] does not dial: asking a sleeping machine how it is doing
//! is how the report would come to say "unreachable" about the state it exists
//! to describe.
//!
//! ## Aura may only stop what it was given permission to stop
//!
//! Structural rather than remembered. A row carries a substrate handle only if
//! somebody put one there — Aura's own provisioning, for a machine it made, or
//! the customer connecting a box of their own in a cloud account they have let
//! Aura act in. Without a handle there is nothing to name in a request, so a box
//! nobody gave Aura the keys to falls out of the policy before any of the timing
//! is consulted, and this laptop never gets that far at all. The refusal is a
//! sentence, not a missing button: a place that could not explain why it will
//! not sleep would read as a place where the feature is broken.
//!
//! Note that this is a question about permission and not about ownership, and
//! the two came apart the moment a customer could grant a role in their own
//! account. A machine on somebody else's bill can be sleepable; the thing that
//! decides is whether anybody handed Aura a way to switch it off.
//!
//! [`Machine::asleep_since`]: crate::cmd_machines::Machine::asleep_since

pub mod policy;

use serde::{Deserialize, Serialize};

use crate::cloudbox::domain::BoxSession;
use crate::cmd_machines::Machine;
use crate::provisioner::{provisioner_for, ProvisionKind, TargetId};

use super::place::{billing_of, unix_now, Place};
use policy::{Kept, Observed, Policy, Rest, Work};

/// How often the sweep looks for places nobody is using.
///
/// Comfortably shorter than [`policy::IDLE_AFTER`], so a machine that goes quiet
/// is stopped near the moment it earns it rather than up to a second full window
/// later — and comfortably longer than a person's patience, because almost every
/// pass ends in the machine book with nothing dialled at all.
pub const SWEEP_EVERY: std::time::Duration = std::time::Duration::from_secs(5 * 60);

/// Whether a place is asleep, whether it could be, and what is keeping it up.
///
/// One shape for all three questions because they are asked together every time:
/// a surface drawing a machine wants to know what to say about it, and a surface
/// offering a Sleep button wants to know whether to offer one.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Sleeping {
    /// What to call the place in a sentence.
    pub place: String,
    /// The book's key, or `None` for this laptop.
    pub machine_id: Option<String>,
    /// `"awake"` or `"asleep"`. Deliberately not a boolean called `online`: the
    /// whole bug this module is against is a third state being folded into a
    /// field that only has room for two.
    pub state: String,
    /// Unix seconds since Aura stopped it; `0` while it is up.
    pub asleep_since: i64,
    /// Could Aura stop this place at all? False for this laptop, for a box
    /// nobody gave Aura permission to switch off, and for a machine whose handle
    /// the book has lost.
    pub can_sleep: bool,
    /// Seconds since the most recent thing anything here knows happened at this
    /// place. `0` when nothing is recorded, which is not "just now".
    pub quiet_for: i64,
    /// The idle window in seconds, so a surface can draw how long is left
    /// without keeping its own copy of the policy.
    pub idle_after: i64,
    /// One sentence about THIS place — why it is up, why it is asleep, or why
    /// Aura will not touch it.
    pub note: String,
    /// The policy itself, in one sentence, identical for every place.
    pub policy: String,
}

impl Sleeping {
    fn of(place: &Place, seen: &Observed<'_>, rest: &Rest, policy: &Policy) -> Self {
        Sleeping {
            place: place.label().to_string(),
            machine_id: match place {
                Place::Here { .. } => None,
                Place::Box { machine, .. } => Some(machine.id.clone()),
            },
            state: if seen.asleep_since > 0 { "asleep" } else { "awake" }.into(),
            asleep_since: seen.asleep_since,
            can_sleep: !matches!(rest, Rest::Kept(Kept::NotOurs | Kept::Handleless)),
            quiet_for: quiet_for(seen),
            idle_after: policy.idle_after.as_secs() as i64,
            note: note(place, rest, seen, policy),
            policy: policy.sentence(),
        }
    }
}

/// The report for a place, from what is already in hand.
///
/// Pure — no book, no network, no clock beyond the current second. Every
/// command below is this plus an act, which is what keeps "what does this place
/// say about itself" answerable in a test without a machine anywhere near it,
/// and what lets the conformance matrix ask a place of every mode the same
/// question.
///
/// `sessions` is `None` when nobody has asked the machine what is running on
/// it, which is the ordinary case for anything drawing a list.
pub(super) fn sleeping_of(place: &Place, sessions: Option<&[BoxSession]>) -> Sleeping {
    let policy = Policy::default();
    let facts = facts_of(place);
    let seen = observed(&facts, sessions);
    let rest = policy.read(&seen);
    Sleeping::of(place, &seen, &rest, &policy)
}

/// What this place's sleep state is, without touching it.
///
/// Reads the machine book and stops. A surface drawing a list of places calls
/// this once per row, and a version that dialled would turn every roster paint
/// into one ssh attempt per machine — most of which, for the rows this is really
/// about, would time out, because the machine is asleep.
#[tauri::command]
pub async fn place_sleeping(
    root: Option<String>,
    machine_id: Option<String>,
) -> Result<Sleeping, String> {
    let place = match machine_id.as_deref().map(str::trim).filter(|id| !id.is_empty()) {
        Some(id) => Place::at_machine(id)?,
        None => Place::resolve(root.unwrap_or_default(), None),
    };
    Ok(sleeping_of(&place, None))
}

/// Stop this place now.
///
/// The deliberate act, as opposed to the sweep: somebody has decided they are
/// done with a machine and would rather not pay for the next half hour of it.
/// So it does not consult the timings — a member who has just closed their work
/// should not be told to wait thirty minutes for permission to stop paying — but
/// it does consult everything about ownership, because those are not the
/// member's to overrule.
///
/// What it will not do is pretend. Stopping a machine ends the sessions on it;
/// the note that comes back says which, and the surface that offers the button
/// is expected to have said so first.
#[tauri::command]
pub async fn place_sleep(machine_id: String) -> Result<Sleeping, String> {
    let place = Place::at_machine(&machine_id)?;
    let policy = Policy::default();
    let facts = facts_of(&place);
    let rest = policy.read(&observed(&facts, None));
    if let Rest::Kept(why) = rest {
        return Err(refusal(&place, why));
    }
    // Unreachable while the policy checks ownership before the timings, and
    // asked anyway: the alternative is a request naming an empty machine, which
    // some cloud somewhere will one day answer with a shrug.
    let handle = handle_of(&place).map_err(|why| refusal(&place, why))?;
    provisioner_for(ProvisionKind::Managed)
        .sleep(&TargetId(handle))
        .await
        .map_err(|e| e.to_string())?;

    // Written down only once the machine really stopped. A book that said
    // "asleep" about a running box would be a bill nobody is watching.
    let at = unix_now();
    crate::cmd_machines::set_asleep_since(&machine_id, at)?;
    place_sleeping(None, Some(machine_id)).await
}

/// The handle Aura may name in a stop or start request for this place, or the
/// typed reason there isn't one.
///
/// Both lifecycle verbs ask exactly this, and they must not each work it out for
/// themselves: a wake more willing than a sleep would start machines Aura has no
/// way to stop again, and one less willing would leave a member with a box that
/// can be put down and never picked up. So the decision lives here, beside the
/// policy that makes the rest of them, and [`super::place_wake`] asks it rather
/// than re-deriving it.
///
/// A [`Kept`] rather than a sentence, because the two callers say different
/// things about the same fact. "Aura holds no account for a machine it did not
/// make" means *it stays up on its owner's bill* to the half that stops things
/// and *its owner has to switch it on* to the half that starts them. One
/// decision, two vocabularies — which is the arrangement that cannot drift.
pub(super) fn handle_of(place: &Place) -> Result<String, Kept> {
    let facts = facts_of(place);
    if !facts.aura_may_stop_it {
        return Err(Kept::NotOurs);
    }
    facts
        .handle
        .map(|h| h.trim().to_string())
        .filter(|h| !h.is_empty())
        .ok_or(Kept::Handleless)
}

/// Look at every place in the book and stop the ones nobody is using.
///
/// Two passes on purpose. The first is the machine book alone — a file on this
/// disk — and it rules out this laptop, every box somebody brought, everything
/// already asleep and everything opened recently, which on a normal install is
/// all of it. Only what survives is worth a round trip, and only what the
/// machine itself then says is quiet gets stopped.
///
/// A place that cannot be reached is left alone rather than assumed idle. That
/// is the safe direction: the cost of not sleeping a dead box is a bill, and the
/// cost of sleeping a live one is somebody's work.
///
/// Answers with the places it actually stopped, so the caller can say what
/// happened without asking again.
#[tauri::command]
pub async fn places_sleep_idle() -> Result<Vec<Sleeping>, String> {
    let policy = Policy::default();
    let mut slept = vec![];
    for machine in crate::cmd_machines::every_machine() {
        let facts = Facts::of_machine(&machine);
        if !matches!(policy.read(&observed(&facts, None)), Rest::Unasked) {
            continue;
        }
        // Reaching the place is what makes the second pass worth anything, and
        // it goes through `Place` like everything else that names a machine —
        // so a substrate whose sessions arrive some other way gets this without
        // the sweep being edited.
        let Ok(place) = Place::at_machine(&machine.id) else {
            continue;
        };
        let Ok(sessions) = place.sessions().await else {
            continue;
        };
        if !policy.read(&observed(&facts, Some(&sessions))).is_idle() {
            continue;
        }
        // One failure is not the end of the sweep. A machine whose cloud
        // refused a stop is one bill; giving up on the rest of the book because
        // of it is all of them.
        if let Ok(report) = place_sleep(machine.id.clone()).await {
            slept.push(report);
        }
    }
    Ok(slept)
}

/// The facts about a place that the policy needs, lifted out of it.
///
/// Owned rather than borrowed from the `Place`, because [`Observed`] borrows and
/// the place is a temporary in every caller here. Small, and it keeps the one
/// translation from "what a place is" to "what the policy reads" in a single
/// readable function instead of at four call sites.
struct Facts {
    aura_may_stop_it: bool,
    handle: Option<String>,
    asleep_since: i64,
    last_used_at: i64,
}

impl Facts {
    fn of_machine(m: &Machine) -> Self {
        let handle = m.instance_id.clone();
        Facts {
            // True two ways, and they are genuinely different facts. Either Aura
            // made the machine — the same question the meter asks, asked the
            // same way, because Aura stops what Aura bills for and a second
            // spelling of "did we make this" is a second answer waiting to
            // disagree with the first. Or somebody else's machine carries a
            // handle qualified by an account they granted Aura a role in, which
            // is them saying, in the one place a row can say it, that switching
            // this off is allowed.
            //
            // The second question is asked of the handle's shape alone and
            // reaches nothing, which is what lets a roster paint a hundred rows
            // without a file read each. Whether that account is still set up on
            // this computer is asked later, by the call that is about to spend
            // it, and answered with a sentence.
            aura_may_stop_it: billing_of(m).1
                || handle.as_deref().is_some_and(crate::provisioner::granted_handle),
            handle,
            asleep_since: m.asleep_since,
            last_used_at: m.last_used_at,
        }
    }
}

fn facts_of(place: &Place) -> Facts {
    match place {
        // Nobody can grant Aura permission to switch off the computer it is
        // running on, this laptop has no handle, and it is never asleep. Three
        // honest zeroes rather than a branch above the policy.
        Place::Here { .. } => Facts {
            aura_may_stop_it: false,
            handle: None,
            asleep_since: 0,
            last_used_at: 0,
        },
        Place::Box { machine, .. } => Facts::of_machine(machine),
    }
}

fn observed<'a>(facts: &'a Facts, sessions: Option<&'a [BoxSession]>) -> Observed<'a> {
    Observed {
        aura_may_stop_it: facts.aura_may_stop_it,
        handle: facts.handle.as_deref(),
        asleep_since: facts.asleep_since,
        last_used_at: facts.last_used_at,
        sessions,
        now: unix_now(),
    }
}

/// How long since the most recent thing anybody here knows happened.
///
/// The machine's own answer wins when there is one, because a session that moved
/// two minutes ago is a better account of "quiet for" than this laptop's memory
/// of when it last opened the place.
fn quiet_for(seen: &Observed<'_>) -> i64 {
    let last = seen
        .sessions
        .unwrap_or(&[])
        .iter()
        .map(|s| s.activity_at)
        .chain(std::iter::once(seen.last_used_at))
        .filter(|t| *t > 0)
        .max()
        .unwrap_or(0);
    if last == 0 {
        return 0;
    }
    seen.now.saturating_sub(last).max(0)
}

/// Why Aura will not sleep this place, as the sentence a member is shown.
///
/// A typed refusal rather than a silent no-op, and in plain words rather than in
/// the cloud's: "you turned it on and nothing happened" is the worst possible
/// answer to a question about a bill.
fn refusal(place: &Place, why: Kept) -> String {
    let label = place.label();
    match (place, why) {
        (Place::Here { .. }, _) => "Work here runs on your own computer, and Aura doesn't switch \
             that off. Anything you leave running is still running when you come back."
            .to_string(),
        (_, Kept::NotOurs) => format!(
            "Aura didn't make {label}, so it holds no account that could stop it. It stays up on \
             its owner's bill — walking away costs you nothing, but the idle isn't free."
        ),
        (_, Kept::Handleless) => format!(
            "Aura made {label}, but this laptop no longer holds the name its cloud knows it by, so \
             it can't be stopped from here. It is still costing money — reconnect it to fix that."
        ),
        (_, Kept::AlreadyAsleep) => format!("{label} is already asleep."),
    }
}

/// One sentence about this place, whatever state it is in.
fn note(place: &Place, rest: &Rest, seen: &Observed<'_>, policy: &Policy) -> String {
    let label = place.label();
    match rest {
        Rest::Kept(Kept::AlreadyAsleep) => format!(
            "{label} is asleep and costing nothing. Nothing is lost — its disk is exactly as you \
             left it, and opening it starts it again."
        ),
        Rest::Kept(why) => refusal(place, *why),
        Rest::Busy(Work::Watched(session)) => {
            format!("Somebody has {session} open on {label} right now, so it stays up.")
        }
        Rest::Busy(Work::Running(session)) => {
            format!("{session} is still working on {label}, so it stays up.")
        }
        Rest::Busy(Work::Opened) => {
            format!("You were on {label} in the last {}, so it stays up.", policy::plainly(policy.idle_after))
        }
        // Nothing recorded is not "quiet for zero minutes" — it is a place this
        // laptop has never been on, which is a different sentence and a common
        // one for a machine somebody else on the team made.
        Rest::Unasked if quiet_for(seen) == 0 => format!(
            "Nothing here has a record of anything happening on {label}. Aura asks it what's \
             running before it stops anything."
        ),
        Rest::Unasked => format!(
            "Nothing has happened on {label} here for {}. Aura asks it what's running before it \
             stops anything.",
            policy::plainly(std::time::Duration::from_secs(quiet_for(seen) as u64))
        ),
        Rest::Idle => format!(
            "Nothing is running on {label} and nobody is on it, so Aura will put it to sleep."
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A box you brought: no handle, and `mine` is not a machine Aura made.
    fn byoc() -> Machine {
        Machine {
            id: "ubuntu@10.0.0.4:/srv/alpha".into(),
            name: "aura-runner".into(),
            host: "10.0.0.4".into(),
            user: "ubuntu".into(),
            key_path: "/Users/me/.ssh/aura-runner.pem".into(),
            box_kind: "mine".into(),
            repo_path: Some("/srv/alpha".into()),
            repo_branch: None,
            project_root: None,
            org_slug: None,
            forward_agent: false,
            instance_id: None,
            asleep_since: 0,
            added_at: 1_750_000_000,
            last_used_at: 0,
        }
    }

    /// One Aura made: a substrate handle, and the kind that bills.
    fn managed() -> Machine {
        Machine {
            id: "ubuntu@10.0.0.9:/srv/alpha".into(),
            name: "crew-box".into(),
            host: "10.0.0.9".into(),
            box_kind: "managed".into(),
            instance_id: Some("i-0123456789abcdef0".into()),
            ..byoc()
        }
    }

    /// A box the customer owns, in a cloud account they granted Aura a role in.
    /// Still their metal and still their bill — what changed is that they handed
    /// over a way to switch it off, and the row says so in its handle.
    fn granted() -> Machine {
        Machine {
            instance_id: Some("grant:acme-eu/i-0123456789abcdef0".into()),
            ..byoc()
        }
    }

    fn a_box(machine: Machine) -> Place {
        Place::Box {
            machine: Box::new(machine),
            root: "/srv/alpha".into(),
            here: std::env::temp_dir().display().to_string(),
        }
    }

    fn report(place: &Place, sessions: Option<&[BoxSession]>) -> Sleeping {
        sleeping_of(place, sessions)
    }

    #[test]
    fn a_sleeping_place_reads_as_asleep_and_not_as_one_that_stopped_answering() {
        // The acceptance criterion of the whole task, at the one point every
        // surface reads. `state` comes off the row rather than off a dial, so a
        // machine that refuses connections because Aura stopped it never has to
        // be told apart from a broken one by guessing.
        let mut m = managed();
        m.asleep_since = unix_now() - 900;
        let said = report(&a_box(m), None);
        assert_eq!(said.state, "asleep");
        assert!(said.asleep_since > 0);
        assert!(said.note.contains("asleep and costing nothing"), "{}", said.note);
        assert!(
            said.note.contains("exactly as you left it"),
            "a member has to be told the disk survived, or asleep reads as lost: {}",
            said.note
        );
        for alarming in ["unreachable", "offline", "failed", "error"] {
            assert!(
                !said.note.to_lowercase().contains(alarming),
                "a sleeping place described itself as {alarming}: {}",
                said.note
            );
        }
    }

    #[test]
    fn a_box_you_brought_says_why_aura_will_not_stop_it() {
        // Not a missing button. A place that could not explain itself would
        // read as a place where the feature is broken.
        let said = report(&a_box(byoc()), Some(&[]));
        assert!(!said.can_sleep);
        assert_eq!(said.state, "awake");
        assert!(said.note.contains("didn't make"), "{}", said.note);
        assert!(said.note.contains("owner's bill"), "{}", said.note);
        for jargon in ["instance", "EC2", "substrate", "provisioner", "handle"] {
            assert!(!said.note.contains(jargon), "{}", said.note);
        }
    }

    #[test]
    fn this_laptop_is_never_a_thing_aura_switches_off() {
        let here = Place::Here {
            root: std::env::temp_dir().display().to_string(),
        };
        let said = report(&here, None);
        assert!(!said.can_sleep);
        assert_eq!(said.machine_id, None);
        assert_eq!(said.place, "this laptop");
        assert!(said.note.contains("your own computer"), "{}", said.note);
    }

    #[test]
    fn a_machine_aura_made_with_nothing_on_it_is_offered_for_sleep() {
        let said = report(&a_box(managed()), Some(&[]));
        assert!(said.can_sleep);
        assert!(said.note.contains("put it to sleep"), "{}", said.note);
    }

    #[test]
    fn a_box_you_brought_in_an_account_you_opened_up_is_offered_for_sleep_too() {
        // The acceptance criterion of the grant: same hardware, same bill, same
        // `box_kind` as the row above that is refused — and it sleeps, because
        // its owner said Aura may switch it off. This is the point where the
        // lifecycle asymmetry stops being one.
        let said = report(&a_box(granted()), Some(&[]));
        assert!(said.can_sleep);
        assert!(said.note.contains("put it to sleep"), "{}", said.note);

        // And the machine it names is the customer's, not one of Aura's — the
        // account travels with the handle so a stop is signed by the role they
        // granted rather than by Aura's own credential.
        let handle = handle_of(&a_box(granted())).expect("a handle to name");
        assert!(crate::provisioner::granted_handle(&handle), "{handle}");
    }

    #[test]
    fn the_same_box_without_the_grant_is_still_left_alone() {
        // The other half of the pair, and the one that keeps the grant from
        // becoming "every box is sleepable now". Nothing about the hardware
        // decides this; the handle does.
        let said = report(&a_box(byoc()), Some(&[]));
        assert!(!said.can_sleep);
        assert_eq!(handle_of(&a_box(byoc())).err(), Some(Kept::NotOurs));
    }

    #[test]
    fn a_report_carries_the_policy_it_was_decided_by() {
        // So a surface never writes its own version of "after 30 minutes" and
        // then drifts from the number the sweep actually uses.
        let said = report(&a_box(managed()), Some(&[]));
        assert_eq!(said.idle_after, policy::IDLE_AFTER.as_secs() as i64);
        assert_eq!(said.policy, Policy::default().sentence());
        assert!(said.policy.contains("30 minutes"), "{}", said.policy);
    }

    #[test]
    fn how_long_it_has_been_quiet_prefers_the_machines_own_answer() {
        // The book knows when THIS laptop last opened the place. The machine
        // knows what happened on it since, which is the better account — a
        // teammate's session moving is not something this laptop's record can
        // see at all.
        let now = unix_now();
        let mut m = managed();
        m.last_used_at = now - 10_000;
        let sessions = [BoxSession {
            name: "agent-1".into(),
            project: "/srv/alpha".into(),
            kind: "agent".into(),
            agent: Some("claude".into()),
            branch: None,
            title: "work".into(),
            created_at: now - 20_000,
            activity_at: now - 120,
            attached: 0,
        }];
        let said = report(&a_box(m), Some(&sessions));
        assert!(said.quiet_for < 200, "quiet_for was {}", said.quiet_for);
        assert!(said.note.contains("agent-1"), "{}", said.note);
    }

    #[test]
    fn a_place_nobody_recorded_anything_about_is_not_quiet_since_1970() {
        // `0` in the book is "nothing recorded", and subtracting it from now
        // would put half a century in a sentence a person reads.
        let said = report(&a_box(managed()), Some(&[]));
        assert_eq!(said.quiet_for, 0);
    }

    #[test]
    fn a_deliberate_sleep_is_still_refused_for_a_machine_aura_does_not_own() {
        // The one thing a member may not overrule. They can decide they are
        // done with a machine; they cannot give Aura an account it does not
        // have for hardware it did not make.
        let told = refusal(&a_box(byoc()), Kept::NotOurs);
        assert!(told.contains("no account that could stop it"), "{told}");
        let lost = refusal(&a_box(managed()), Kept::Handleless);
        assert!(lost.contains("still costing money"), "{lost}");
        assert!(
            lost != told,
            "a machine Aura made and lost track of reads exactly like one it never made"
        );
    }

    /// The governing rule of the place programme, made structural here too.
    ///
    /// Sleeping is the first capability in this programme that genuinely only
    /// one mode can perform, and that makes this file the most likely place for
    /// the branch to reappear: it would be very easy to ask a row what
    /// `box_kind` it is. It must not. Who pays is asked through `Place::billing`
    /// — one spelling, already proved by the conformance matrix — and everything
    /// else here is about a handle that either exists or does not.
    #[test]
    fn nothing_here_asks_a_row_what_kind_of_place_it_is() {
        let src = include_str!("mod.rs");
        let code = src
            .lines()
            .take_while(|l| !l.starts_with("#[cfg(test)]"))
            .filter(|l| !l.trim_start().starts_with("//") && !l.trim_start().starts_with("///"))
            .collect::<Vec<_>>()
            .join("\n");
        for asked in ["box_kind", "\"managed\"", "provisioning_mode", "is_byoc"] {
            assert!(
                !code.contains(asked),
                "place_sleep branches on `{asked}` instead of asking Place::billing who pays"
            );
        }
    }
}
