//! Reaching a sleeping place starts it, and says how long that is taking.
//!
//! Sleeping an idle machine is only half a feature. The other half is what
//! happens the next time somebody wants it — and until this, the answer was: the
//! member finds a panel with a button on it, presses the button, waits, and then
//! does the thing they came to do. Every other way in failed. A chat tool
//! reading a file on the box, a terminal opening, the drift report, an agent
//! starting: all of them dial a stopped machine and get back the machine's own
//! words for a door that is not open. "Connection refused" about a box that is
//! working exactly as designed is the bug that makes scale-to-zero not worth
//! having, because the state Aura put the machine in is one the member has to
//! learn to recognise.
//!
//! So waking is part of reaching. It hangs off `Place::run_remote` — the single
//! line in this app that goes to another machine — rather than off any of the
//! verbs above it, because a verb that woke on its own would be one verb that
//! works on a sleeping place and eight that do not, and nobody would find out
//! which was which until they tried.
//!
//! ## Invisible means costing nothing when there is nothing to do
//!
//! A hook in front of every remote call is a hook that runs thousands of times
//! for every once it does something. [`before_reaching`] is therefore an integer
//! comparison on a field the caller is already holding: a place that is not
//! asleep costs no lock, no book read and no round trip. Only a row that says it
//! is asleep goes any further.
//!
//! What waking itself costs is a cloud's own time — the better part of a minute
//! for a stopped instance to be running with an address again — and no amount of
//! arrangement here changes that. What this can do, and does, is spend it once:
//! opening a place fires five reads at the same moment, and [`gate`] makes them
//! one wake with five callers on it rather than five wakes.
//!
//! ## Honest about the wait
//!
//! A minute of nothing is indistinguishable from a hang. [`place_waking`] is the
//! question a surface asks while it waits — is something happening, since when,
//! and how long it usually takes — answered out of the gate and the machine book
//! with nothing dialled, so a panel may ask on every draw. The words that go with
//! it are `src/lib/place/wake.ts`, and the rule they keep is the one sleeping
//! already keeps: a machine that is starting is never described as broken.

mod gate;

use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::cmd_machines::Machine;
use crate::provisioner::{provisioner_for, ProvisionKind, TargetId};

use super::place::Place;
use super::place_sleep::policy::{plainly, Kept};
use super::place_sleep::{handle_of, sleeping_of, Sleeping};

/// How long starting a stopped machine usually takes.
///
/// Not a timeout — how long Aura will actually wait is the provisioning seam's
/// business and is measured in minutes, because a cloud having a bad afternoon
/// is a real thing. This is the *expectation*, and it exists so a surface can
/// say "about a minute" instead of showing a spinner with no end in sight. A
/// member who knows the shape of the wait will wait; one who does not will click
/// the button again, and then again.
pub const USUALLY_TAKES: Duration = Duration::from_secs(60);

/// Whether this place is starting, and how the waiting is going.
///
/// Kept apart from [`Sleeping`] rather than folded into it, because the two are
/// asked at opposite moments and by different code. Sleeping is read while
/// drawing a list of machines nobody is touching; this is read by one surface
/// that is waiting on one machine, several times a second, and it is the only
/// thing in the app that knows a wake is in the air at all — the book does not
/// learn about it until it lands.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Waking {
    /// What to call the place in a sentence.
    pub place: String,
    /// The book's key, or `None` for this laptop.
    pub machine_id: Option<String>,
    /// `"awake"`, `"waking"` or `"asleep"`.
    ///
    /// Three, and the middle one is the whole point. Folded into the other two,
    /// a machine that is starting reads either as one that is down — so a
    /// surface offers to start it again — or as one that is up, so a surface
    /// dials it and reports the refusal as a fault.
    pub state: String,
    /// Unix seconds the wake in the air started; `0` when none is.
    pub since: i64,
    /// How long a wake usually takes, in seconds, so a surface can draw the
    /// shape of the wait without keeping its own copy of the number.
    pub usually: i64,
    /// Would reaching this place start it? False for this laptop and for a box
    /// nobody gave Aura a way into — without an account it can act in, Aura has
    /// nothing to switch the machine on with. True for one it made, and equally
    /// true for one somebody else owns in an account they granted Aura a role
    /// in, which is the same permission read the same way.
    pub wakes_on_demand: bool,
    /// One sentence about what is happening to THIS place right now.
    pub note: String,
}

/// Start this place if it is asleep, and hand back the row it came back on.
///
/// The hook in front of every remote call, and the reason it answers with a
/// [`Machine`] rather than with `()`: a stopped machine gives up its address and
/// is given a different one when it starts. A caller told only "it is up" would
/// go on to dial the host it was already holding, which is now somebody else's
/// machine or nothing at all.
///
/// `Ok(None)` means *reach it as you were about to* — either it was never
/// asleep, or it is not a place Aura could start and the machine's own answer is
/// a better one than any sentence written here. `Err` is reserved for a wake
/// that was Aura's to do and did not work, because that is the one case where
/// dialling on would produce a connection error about a machine nobody started.
pub(super) async fn before_reaching(machine: &Machine) -> Result<Option<Machine>, String> {
    // The fast path, and it has to be genuinely free: this sits in front of
    // every single remote call the app makes. A row that is not asleep costs one
    // integer comparison — no lock, no book read, no round trip.
    if machine.asleep_since == 0 {
        return Ok(None);
    }
    // A place Aura cannot start is dialled exactly as it would have been. It may
    // well be up — somebody else's console can start a box Aura's cannot — and if
    // it is not, "Connection refused" from the machine is a truer answer than a
    // sentence from here about a wake nobody asked for.
    if handle_of(&as_place(machine)).is_err() {
        return Ok(None);
    }

    let id = machine.id.clone();
    gate::once(&id, || start(&id)).await?;

    // Re-read rather than patching the host onto the row in hand: the wake wrote
    // the new address into the book, and the book is the one place an address
    // lives. A row that has since been removed falls back to dialling what the
    // caller had, which will fail in the machine's own words rather than in a
    // sentence about bookkeeping.
    Ok(crate::cmd_machines::find_machine(&id))
}

/// Start one machine and write down where it came back.
///
/// Only ever called through [`gate::once`], which is what makes it safe to be
/// this direct about the book: at most one of these is running per machine on
/// this desktop, so the read-then-write below cannot interleave with itself.
async fn start(machine_id: &str) -> Result<String, String> {
    let place = Place::at_machine(machine_id)?;

    // Asked again, inside the gate. A caller that queued behind somebody else's
    // wake arrives here with the machine already up, and starting it a second
    // time would be a request to a cloud about a machine that is running.
    let awake = sleeping_of(&place, None);
    if awake.state != "asleep" {
        return Ok(host_of(&place));
    }

    let handle = handle_of(&place).map_err(|why| refusal(&place, why))?;
    let host = provisioner_for(ProvisionKind::Managed)
        .wake(&TargetId(handle))
        .await
        .map_err(|e| e.to_string())?;

    // The address first, then the state. In that order because a crash between
    // the two leaves a row that says "asleep" about a machine that is up — which
    // costs money and is corrected by the next wake — where the other order would
    // leave one that says "awake" and points at an address nothing answers on,
    // which reads to every surface as a broken box.
    crate::cmd_machines::set_host(machine_id, &host)?;
    crate::cmd_machines::set_asleep_since(machine_id, 0)?;
    Ok(host)
}

/// Start this place now, and say where it came back.
///
/// The deliberate version of what [`before_reaching`] does on the way past: a
/// member looking at a sleeping place who would rather it were up before they
/// start typing. It goes through the same gate as everything else, so pressing
/// the button while a wake is already in the air joins that wake instead of
/// asking a cloud to start a machine it is already starting.
#[tauri::command]
pub async fn place_wake(machine_id: String) -> Result<Sleeping, String> {
    let place = Place::at_machine(&machine_id)?;
    // Asked before the gate so a place Aura cannot start says so immediately,
    // rather than after a round trip that was never going to be made.
    handle_of(&place).map_err(|why| refusal(&place, why))?;
    gate::once(&machine_id, || start(&machine_id)).await?;
    super::place_sleep::place_sleeping(None, Some(machine_id)).await
}

/// Is anything starting this place, and how long has it been?
///
/// Reads the gate and the machine book, and reaches nothing — safe to ask on
/// every draw of a panel that is waiting, which is exactly what it is for. A
/// version that dialled to find out whether the box was up yet would be adding a
/// connect timeout to every frame of the wait it exists to describe.
#[tauri::command]
pub async fn place_waking(
    root: Option<String>,
    machine_id: Option<String>,
) -> Result<Waking, String> {
    let place = match machine_id.as_deref().map(str::trim).filter(|id| !id.is_empty()) {
        Some(id) => Place::at_machine(id)?,
        None => Place::resolve(root.unwrap_or_default(), None),
    };
    Ok(waking_of(&place))
}

/// The report for a place, out of what is already in hand.
///
/// Pure but for the gate, which is a table in this process. No book write, no
/// network, no clock beyond the current second — which is what lets the
/// conformance matrix ask a place of every mode the same question without a
/// machine anywhere near it.
pub(super) fn waking_of(place: &Place) -> Waking {
    let label = place.label().to_string();
    let machine_id = match place {
        Place::Here { .. } => None,
        Place::Box { machine, .. } => Some(machine.id.clone()),
    };
    let since = machine_id.as_deref().and_then(gate::since);
    let asleep = sleeping_of(place, None).state == "asleep";
    let wakeable = handle_of(place);

    let state = match (since.is_some(), asleep) {
        (true, _) => "waking",
        (false, true) => "asleep",
        (false, false) => "awake",
    };

    let note = note(&label, state, &wakeable);
    Waking {
        place: label,
        machine_id,
        state: state.to_string(),
        since: since.unwrap_or(0),
        usually: USUALLY_TAKES.as_secs() as i64,
        wakes_on_demand: wakeable.is_ok(),
        note,
    }
}

/// One sentence about what is happening to this place right now.
///
/// The wording is the feature. A member watching a minute of nothing needs to be
/// told three things — that something is happening, roughly how long it takes,
/// and that nothing was lost — and the one thing that must never appear is a word
/// that describes a machine which is starting perfectly well as a machine that is
/// broken.
fn note(label: &str, state: &str, wakeable: &Result<String, Kept>) -> String {
    match (state, wakeable) {
        ("waking", _) => format!(
            "Starting {label} — that usually takes about {}. Nothing on it was lost, and what you \
             asked for runs as soon as it answers.",
            plainly(USUALLY_TAKES)
        ),
        ("asleep", Ok(_)) => format!(
            "{label} is asleep and costing nothing. Anything you do here starts it first, which \
             takes about {}.",
            plainly(USUALLY_TAKES)
        ),
        ("asleep", Err(why)) => refusal_words(label, *why),
        (_, Ok(_)) => format!("{label} is up, so there is nothing to wait for."),
        // This laptop, and a box somebody brought: both are already up as far as
        // anything here is concerned, and neither is something Aura switches on.
        (_, Err(_)) => format!("{label} is up. Aura doesn't switch it on or off — it's not ours."),
    }
}

/// Why Aura cannot start this place, in the words of the direction it was asked
/// from.
///
/// The same two facts [`super::place_sleep`] refuses on, said the other way
/// round. Aura holding no account for a machine it did not make means *it stays
/// up on its owner's bill* to the half that stops things, and *its owner has to
/// switch it on* to the half that starts them; one sentence serving both would be
/// wrong in one of the two places it appeared.
fn refusal_words(label: &str, why: Kept) -> String {
    match why {
        Kept::NotOurs => format!(
            "Aura didn't make {label}, so it holds no account that could start it. Whoever owns \
             the machine has to switch it on."
        ),
        Kept::Handleless => format!(
            "Aura made {label}, but this laptop no longer holds the name its cloud knows it by, so \
             it can't be started from here. Reconnect it to fix that."
        ),
        // Reached only when the row says asleep, which is what `state` already
        // said — so this is the same sentence from the other side.
        Kept::AlreadyAsleep => format!("{label} is asleep."),
    }
}

/// The row in hand, as a place.
///
/// For the questions that are about the machine rather than about the work —
/// who owns it, and what to call it. Deliberately not [`Place::at_machine`],
/// which would go back to the book for a row the caller is already holding, and
/// which refuses an address this laptop cannot dial. That refusal is a fact
/// about reaching the machine, and reaching it is not what is being asked here.
fn as_place(machine: &Machine) -> Place {
    Place::Box {
        machine: Box::new(machine.clone()),
        root: machine.repo_path.clone().unwrap_or_default(),
        here: machine.project_root.clone().unwrap_or_default(),
    }
}

/// Where this place is, as the book currently spells it.
fn host_of(place: &Place) -> String {
    match place {
        Place::Here { .. } => String::new(),
        Place::Box { machine, .. } => machine.host.clone(),
    }
}

/// Why Aura will not start this place, as a caller's error string.
fn refusal(place: &Place, why: Kept) -> String {
    refusal_words(place.label(), why)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::manager::brain::place::unix_now;

    /// A box you brought: no substrate handle, and `mine` is not a machine Aura
    /// made.
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

    fn asleep(mut m: Machine) -> Machine {
        m.asleep_since = unix_now() - 900;
        m
    }

    #[tokio::test]
    async fn a_place_that_is_up_costs_nothing_on_the_way_past() {
        // The hook sits in front of every remote call the app makes, so the
        // ordinary case has to be free. `Ok(None)` here means "reach it as you
        // were about to" — no lock taken, no book read, nothing asked of a cloud.
        assert!(before_reaching(&managed())
            .await
            .expect("an awake place answers")
            .is_none());
    }

    #[tokio::test]
    async fn a_sleeping_box_aura_did_not_make_is_still_dialled() {
        // Not a refusal. Aura holds no account that could start somebody else's
        // hardware, but the machine may well be up — its owner's console can
        // start what Aura's cannot. Turning that into an error here would take a
        // box that is answering and make the app refuse to talk to it.
        assert!(before_reaching(&asleep(byoc()))
            .await
            .expect("a box Aura did not make answers")
            .is_none());
        // And the same for a machine Aura made whose handle the book has lost:
        // there is nothing to name in a start request, and the address is still
        // worth trying.
        let mut lost = asleep(managed());
        lost.instance_id = None;
        assert!(before_reaching(&lost).await.expect("a handleless place answers").is_none());
    }

    #[test]
    fn reaching_a_machine_starts_it_before_the_connection_is_attempted() {
        // The acceptance criterion, held where it is actually kept. There is one
        // line in this app that goes to another machine, and the promise of this
        // module is that waking happens in front of it — not beside it, and not
        // in whichever verb somebody remembered. A `run_remote` that dialled
        // first would work perfectly on every awake box and fail on every
        // sleeping one, with a connection error for a machine that is merely
        // cheap.
        let src = include_str!("../place.rs");
        let at = src
            .find("async fn run_remote(")
            .expect("Place no longer has one door to the wire");
        let body = &src[at..];
        let wakes = body
            .find("place_wake::before_reaching")
            .expect("the one call that reaches a machine no longer starts a sleeping one");
        let dials = body.find("dial(machine").expect("run_remote no longer dials");
        assert!(
            wakes < dials,
            "run_remote dials before it wakes, so a sleeping place answers with a connection error"
        );
    }

    #[test]
    fn a_place_that_is_starting_is_never_described_as_broken() {
        // The rule sleeping already keeps, kept through the minute that follows
        // it. Every word below is one somebody would read as "go and find
        // support", and the machine is doing exactly what it was asked to.
        let said = note("crew-box", "waking", &Ok("i-0123456789abcdef0".into()));
        assert!(said.contains("Starting crew-box"), "{said}");
        assert!(said.contains("about a minute"), "{said}");
        assert!(
            said.contains("Nothing on it was lost"),
            "a member watching a wake has to be told the disk survived: {said}"
        );
        for alarming in ["unreachable", "offline", "failed", "error", "broken", "timed out"] {
            assert!(
                !said.to_lowercase().contains(alarming),
                "a place being started described itself as {alarming}: {said}"
            );
        }
    }

    #[test]
    fn a_sleeping_place_says_that_using_it_will_start_it() {
        // The half that makes the feature discoverable. Told only "asleep", a
        // member goes looking for the button; told this, they simply carry on
        // and the machine is up by the time it matters.
        let report = waking_of(&as_place(&asleep(managed())));
        assert_eq!(report.state, "asleep");
        assert!(report.wakes_on_demand);
        assert_eq!(report.usually, USUALLY_TAKES.as_secs() as i64);
        assert_eq!(report.since, 0, "nothing is starting it yet");
        assert!(report.note.contains("starts it first"), "{}", report.note);
        assert!(report.note.contains("about a minute"), "{}", report.note);
    }

    #[test]
    fn a_place_that_is_up_has_no_wait_to_report() {
        let report = waking_of(&as_place(&managed()));
        assert_eq!(report.state, "awake");
        assert_eq!(report.since, 0);
        assert!(report.note.contains("nothing to wait for"), "{}", report.note);
    }

    #[test]
    fn a_box_you_brought_says_who_has_to_switch_it_on() {
        // The same fact `place_sleep` refuses on, said the other way round.
        // "It stays up on its owner's bill" is the right sentence about a
        // machine nobody is stopping and the wrong one about a machine somebody
        // is trying to start.
        let report = waking_of(&as_place(&asleep(byoc())));
        assert!(!report.wakes_on_demand);
        assert!(report.note.contains("has to switch it on"), "{}", report.note);
        assert!(
            !report.note.contains("owner's bill"),
            "a member trying to start a machine was told about the bill instead: {}",
            report.note
        );
        for jargon in ["instance", "EC2", "substrate", "provisioner", "handle"] {
            assert!(!report.note.contains(jargon), "{}", report.note);
        }
    }

    #[test]
    fn a_machine_aura_made_and_lost_track_of_reads_differently_from_one_it_never_made() {
        // Two rows that both answer "Aura will not start this", sending somebody
        // to opposite places: one is working as promised, the other is billing
        // until a person notices.
        let never = refusal_words("aura-runner", Kept::NotOurs);
        let lost = refusal_words("crew-box", Kept::Handleless);
        assert!(lost.contains("Reconnect it"), "{lost}");
        assert_ne!(never, lost);
    }

    #[test]
    fn this_laptop_is_never_something_aura_switches_on() {
        let here = Place::Here {
            root: std::env::temp_dir().display().to_string(),
        };
        let report = waking_of(&here);
        assert_eq!(report.machine_id, None);
        assert_eq!(report.place, "this laptop");
        assert!(!report.wakes_on_demand);
        assert_eq!(report.state, "awake");
    }

    /// The governing rule of the place programme, made structural here too.
    ///
    /// Starting a machine is the second capability only one mode can perform,
    /// which makes this the second most likely file for the branch to reappear
    /// in: it would be very easy to ask a row whether it is `"managed"`. It must
    /// not. Who owns the machine is asked through `place_sleep::handle_of` —
    /// which asks `Place::billing` — and everything else here is about a handle
    /// that either exists or does not.
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
                "place_wake branches on `{asked}` instead of asking who owns the machine"
            );
        }
    }
}
