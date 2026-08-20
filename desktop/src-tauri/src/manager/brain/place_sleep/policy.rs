//! When a place is idle, and what "idle" is allowed to mean.
//!
//! Everything here is a pure function over facts somebody else went and got.
//! That is the point of the file: the arguable part of scaling to zero is not
//! the API call that stops a machine, it is the judgement that nobody wanted it
//! — and a judgement buried in the middle of an async sweep is one nobody reads
//! until it has stopped a box somebody was using.
//!
//! ## The policy, in one sentence
//!
//! A machine Aura is allowed to switch off is put to sleep when nobody is
//! attached to it and it has been quiet for [`IDLE_AFTER`] — or, if sessions are
//! still open on it, when nothing has happened in any of them for
//! [`SESSIONS_GO_STALE_AFTER`].
//!
//! ## Why sessions get the longer number
//!
//! Stopping a machine keeps its disk and ends its processes. The files are all
//! there when it comes back; the tmux server is not, and neither is the agent
//! that was running under it. So an open session is treated as work in progress
//! for a long time after it last moved, because the cost of getting it wrong is
//! asymmetric: sleeping a box half an hour early saves a few cents, and sleeping
//! one with somebody's half-finished run on it costs them the run.
//!
//! A box with no sessions at all has nothing to lose, which is why the short
//! number governs there. That is the ordinary case — a machine somebody opened,
//! did a thing on, and closed.
//!
//! ## What never gets slept, and why it is structural
//!
//! Aura may only stop a machine somebody has given it the standing to stop.
//! That is not a check somebody has to remember to write: a place carries a
//! handle only if Aura made it, or if its owner granted Aura a role in the
//! account it runs in ([`crate::cmd_machines::Machine::instance_id`]), and
//! without a handle there is nothing to name in a request. Anything else reaches
//! [`Kept::NotOurs`] before any of the timing is consulted.
//!
//! Note what that boundary is *about*. It was written when the two facts were
//! the same fact — Aura made the machine, so Aura paid for it, so Aura could
//! stop it — and a customer's own box that Aura may stop pulls them apart. Who
//! *pays* is unchanged and is theirs; what changed is who was given permission
//! to switch it off. A gate that still asked about the bill would refuse to
//! sleep the machines this arm exists to sleep.

use std::time::Duration;

use crate::cloudbox::domain::BoxSession;

/// How long a place with nothing open on it stays up before Aura stops paying
/// for it.
///
/// Half an hour rather than five minutes because waking is not free — a stopped
/// machine takes the better part of a minute to answer again, and a member who
/// steps away for coffee should not come back to a wait. Half an hour rather
/// than four hours because the whole offer of a managed place is that an idle
/// one costs nothing, and a number long enough to be invisible is a number that
/// never fires.
pub const IDLE_AFTER: Duration = Duration::from_secs(30 * 60);

/// How long an open session has to sit perfectly still before it stops counting
/// as work in progress.
///
/// A working day, because that is the shape of the thing being protected: a
/// session left open over lunch, over a meeting, over an afternoon of doing
/// something else is a session somebody means to come back to, and stopping the
/// machine would end it. A session nothing has touched since yesterday is a
/// window somebody forgot to close, and keeping a machine up for it is exactly
/// the bill this feature exists to stop.
pub const SESSIONS_GO_STALE_AFTER: Duration = Duration::from_secs(8 * 60 * 60);

/// The two numbers, together, so a caller states them once and a test can hand
/// in shorter ones without pretending eight hours have passed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Policy {
    pub idle_after: Duration,
    pub sessions_go_stale_after: Duration,
}

impl Default for Policy {
    fn default() -> Self {
        Policy {
            idle_after: IDLE_AFTER,
            sessions_go_stale_after: SESSIONS_GO_STALE_AFTER,
        }
    }
}

impl Policy {
    /// The policy itself, in the words it would be read in.
    ///
    /// Composed from the same two fields the decision is made with, rather than
    /// written out beside them, because a sentence that drifts from the number
    /// it describes is worse than no sentence: it is the thing a person believes
    /// while the machine does something else.
    pub fn sentence(&self) -> String {
        format!(
            "A machine Aura is allowed to switch off goes to sleep when nobody is attached to it \
             and it has been quiet for {}. If sessions are still open on it, it waits until \
             nothing has happened in any of them for {} — stopping the machine ends them, and the \
             files survive but the work in progress does not. Machines nobody gave Aura \
             permission to stop are never touched.",
            plainly(self.idle_after),
            plainly(self.sessions_go_stale_after),
        )
    }

    /// What should happen to this place.
    ///
    /// The whole decision, in one place, from facts and nothing else — no clock
    /// of its own, no book, no network. Every case below is reachable from a
    /// literal in a test.
    pub fn read(&self, seen: &Observed<'_>) -> Rest {
        if seen.asleep_since > 0 {
            return Rest::Kept(Kept::AlreadyAsleep);
        }
        if !seen.aura_may_stop_it {
            return Rest::Kept(Kept::NotOurs);
        }
        // Aura is allowed to stop it and the book has lost the handle the cloud
        // knows it by. Named rather than folded into `NotOurs`, because the two
        // send somebody to opposite places: one is a machine that is working
        // exactly as promised, the other is a row that can never be stopped again
        // and is billing until a person notices.
        if seen.handle.map(str::trim).filter(|h| !h.is_empty()).is_none() {
            return Rest::Kept(Kept::Handleless);
        }

        // Opening a place is work even when nothing is running yet: somebody is
        // in the middle of getting to it. Measured from this laptop's own record
        // rather than from the machine, because the moment worth protecting is
        // the one before anything has been started over there.
        if within(seen.now, seen.last_used_at, self.idle_after) {
            return Rest::Busy(Work::Opened);
        }

        let Some(sessions) = seen.sessions else {
            return Rest::Unasked;
        };
        if let Some(s) = sessions.iter().find(|s| s.attached > 0) {
            return Rest::Busy(Work::Watched(s.name.clone()));
        }
        if let Some(s) = sessions
            .iter()
            .find(|s| within(seen.now, s.activity_at, self.sessions_go_stale_after))
        {
            return Rest::Busy(Work::Running(s.name.clone()));
        }
        Rest::Idle
    }
}

/// Everything the decision is made from.
///
/// Borrowed rather than owned so the caller's book row and the machine's own
/// answer are read where they already are — and so nothing here can be tempted
/// to go and fetch a missing one.
#[derive(Debug, Clone, Copy)]
pub struct Observed<'a> {
    /// Has anybody given Aura the standing to switch this machine off?
    ///
    /// True two ways, and they are genuinely different arrangements: Aura made
    /// the machine, in an account it holds the credential for; or somebody
    /// else's account granted Aura a role that may stop and start the machines
    /// they marked ([`crate::provisioner::grant`]).
    ///
    /// Deliberately **not** "did Aura make it", which is what this used to ask.
    /// The two were the same fact while the only machines Aura could stop were
    /// the ones it made, and the grant arm exists precisely to separate them —
    /// the bill stays the customer's and the permission does not. Left as a
    /// question about billing, this gate would refuse to sleep the machines that
    /// whole arm was built to sleep, and the refusal would look like a rule
    /// rather than a leftover.
    pub aura_may_stop_it: bool,
    /// The substrate's own handle for it, when there is one.
    pub handle: Option<&'a str>,
    /// Unix seconds since Aura stopped it, or `0` for a place that is up.
    pub asleep_since: i64,
    /// Unix seconds of the last time this laptop opened the place.
    pub last_used_at: i64,
    /// What the machine says is running on it — `None` when nobody has asked.
    ///
    /// Distinguished from an empty list on purpose. "I asked and there is
    /// nothing running" and "I have not asked" look identical in a `Vec` and
    /// mean opposite things: one is a machine that may be stopped, the other is
    /// a machine about to be stopped on no evidence at all.
    pub sessions: Option<&'a [BoxSession]>,
    /// Unix seconds, now, in the units tmux stamps a session with.
    pub now: i64,
}

/// What the policy says to do about a place.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Rest {
    /// Out of scope for sleeping altogether, for a stated reason.
    Kept(Kept),
    /// In use, and here is what is using it.
    Busy(Work),
    /// Nothing this laptop knows rules it out, and the machine has not been
    /// asked what is running on it.
    ///
    /// A real answer rather than a shrug: it is what makes the sweep cheap. The
    /// book alone rules out almost every place on almost every pass, and only
    /// the handful that reach here are worth a round trip.
    Unasked,
    /// Nobody is using it and nothing is running on it.
    Idle,
}

/// A reason a place is not a candidate at all.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kept {
    /// Nobody gave Aura the standing to switch this one off — it is neither a
    /// machine Aura made nor one whose owner granted Aura a role in the account
    /// it runs in. A box you brought, and this laptop.
    NotOurs,
    /// Aura may stop it, and the address book no longer holds the handle the
    /// cloud knows it by.
    Handleless,
    /// It is already asleep. Stopping a stopped machine is harmless, and asking
    /// the cloud to do it every few minutes is not.
    AlreadyAsleep,
}

/// A thing happening at a place that keeps it up, carrying the name of the
/// session it is happening in so a surface can say which one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Work {
    /// Somebody has a terminal open on it right now.
    Watched(String),
    /// A session moved recently enough to still count as in progress.
    Running(String),
    /// The place itself was opened from this laptop recently.
    Opened,
}

impl Rest {
    /// Whether this is the one answer that leads to a machine being stopped.
    pub fn is_idle(&self) -> bool {
        matches!(self, Rest::Idle)
    }
}

/// Whether `at` is inside `window` of `now`.
///
/// A zero timestamp is not inside any window — that is a fact nobody recorded,
/// not a thing that happened at the start of 1970 — and a timestamp in the
/// future is, because a machine whose clock runs fast is not a reason to stop
/// it while somebody is typing on it.
fn within(now: i64, at: i64, window: Duration) -> bool {
    at > 0 && now.saturating_sub(at) < window.as_secs() as i64
}

/// A duration as somebody would say it out loud.
///
/// Only the shapes these two constants take, because that is all this is for: a
/// general-purpose humaniser here would be four more branches nobody ever reads
/// and one more thing to get wrong in a sentence a member is shown.
pub(crate) fn plainly(d: Duration) -> String {
    let mins = d.as_secs() / 60;
    match (mins / 60, mins % 60) {
        (0, 1) => "a minute".to_string(),
        (0, m) => format!("{m} minutes"),
        (1, 0) => "an hour".to_string(),
        (h, 0) => format!("{h} hours"),
        (h, m) => format!("{h}h {m}m"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_760_000_000;
    const HANDLE: &str = "i-0123456789abcdef0";

    /// A managed place nobody has touched for a day, with nothing on it.
    fn quiet() -> Observed<'static> {
        Observed {
            aura_may_stop_it: true,
            handle: Some(HANDLE),
            asleep_since: 0,
            last_used_at: NOW - 86_400,
            sessions: Some(&[]),
            now: NOW,
        }
    }

    fn session(name: &str, activity_at: i64, attached: u32) -> BoxSession {
        BoxSession {
            name: name.into(),
            project: "/srv/alpha".into(),
            kind: "agent".into(),
            agent: Some("claude".into()),
            branch: None,
            title: "work".into(),
            created_at: NOW - 90_000,
            activity_at,
            attached,
        }
    }

    #[test]
    fn a_managed_place_with_nothing_on_it_is_idle() {
        assert_eq!(Policy::default().read(&quiet()), Rest::Idle);
    }

    #[test]
    fn a_box_nobody_gave_aura_the_keys_to_is_never_slept() {
        // The hard boundary of the whole feature. Nobody has given Aura standing
        // to switch this one off, and a version of this that tried anyway would
        // be an app taking down a machine it was never let near.
        let mut theirs = quiet();
        theirs.aura_may_stop_it = false;
        theirs.handle = None;
        assert_eq!(
            Policy::default().read(&theirs),
            Rest::Kept(Kept::NotOurs),
            "a machine nobody let Aura stop was a candidate for being stopped"
        );
    }

    #[test]
    fn a_box_nobody_gave_aura_the_keys_to_is_left_alone_even_with_a_handle_on_it() {
        // Belt and braces on the one boundary that reaches into somebody else's
        // account. The handle is what makes stopping *possible*; permission is
        // what makes it *allowed*, and the second is checked first — so a stale
        // handle left on a row whose grant was withdrawn stops nothing.
        let mut theirs = quiet();
        theirs.aura_may_stop_it = false;
        assert_eq!(Policy::default().read(&theirs), Rest::Kept(Kept::NotOurs));
    }

    #[test]
    fn a_box_you_brought_in_an_account_you_opened_up_sleeps_like_any_other() {
        // The acceptance criterion of the grant arm, at the gate that used to
        // refuse it. Nothing about the machine changed — it is the customer's
        // metal, on the customer's bill — and the one thing that did is that
        // somebody said Aura may switch it off. From here it is an ordinary
        // idle place, and the timings that follow are the same timings.
        let mut theirs = quiet();
        theirs.aura_may_stop_it = true;
        theirs.handle = Some("grant:acme-eu/i-0123456789abcdef0");
        assert_eq!(Policy::default().read(&theirs), Rest::Idle);

        // And a busy one is busy for the ordinary reason rather than being
        // exempt for a special one.
        let sessions = [session("agent-1", NOW - 60, 0)];
        theirs.sessions = Some(&sessions);
        assert_eq!(
            Policy::default().read(&theirs),
            Rest::Busy(Work::Running("agent-1".into()))
        );
    }

    #[test]
    fn a_machine_aura_made_with_no_handle_is_a_defect_not_a_byoc_box() {
        // Both answers keep the machine up, so folding them together would
        // compile and behave identically today. They send a person to opposite
        // places: one is the feature working, the other is a row that can never
        // be stopped again and is billing until somebody notices.
        let mut lost = quiet();
        lost.handle = None;
        assert_eq!(Policy::default().read(&lost), Rest::Kept(Kept::Handleless));
        let mut blank = quiet();
        blank.handle = Some("   ");
        assert_eq!(Policy::default().read(&blank), Rest::Kept(Kept::Handleless));
    }

    #[test]
    fn a_place_that_is_already_asleep_is_not_slept_again() {
        let mut sleeping = quiet();
        sleeping.asleep_since = NOW - 600;
        assert_eq!(
            Policy::default().read(&sleeping),
            Rest::Kept(Kept::AlreadyAsleep)
        );
    }

    #[test]
    fn somebody_watching_a_session_keeps_the_machine_up() {
        // Even one that has not moved in a week. An attached client is a person
        // sitting in front of it, and no amount of stillness makes that idle.
        let sessions = [session("agent-1", NOW - 700_000, 1)];
        let mut watched = quiet();
        watched.sessions = Some(&sessions);
        assert_eq!(
            Policy::default().read(&watched),
            Rest::Busy(Work::Watched("agent-1".into()))
        );
    }

    #[test]
    fn a_session_that_moved_recently_keeps_the_machine_up() {
        let sessions = [session("agent-1", NOW - 120, 0)];
        let mut running = quiet();
        running.sessions = Some(&sessions);
        assert_eq!(
            Policy::default().read(&running),
            Rest::Busy(Work::Running("agent-1".into()))
        );
    }

    #[test]
    fn a_session_still_since_yesterday_is_a_forgotten_window() {
        // The other side of the same number. Left open, nothing in it, nobody
        // looking: keeping a machine up for that is the bill this exists to
        // stop.
        let sessions = [session("agent-1", NOW - 9 * 60 * 60, 0)];
        let mut stale = quiet();
        stale.sessions = Some(&sessions);
        assert_eq!(Policy::default().read(&stale), Rest::Idle);
    }

    #[test]
    fn one_live_session_among_stale_ones_is_enough() {
        let sessions = [
            session("old", NOW - 100_000, 0),
            session("older", NOW - 200_000, 0),
            session("busy", NOW - 60, 0),
        ];
        let mut mixed = quiet();
        mixed.sessions = Some(&sessions);
        assert_eq!(
            Policy::default().read(&mixed),
            Rest::Busy(Work::Running("busy".into()))
        );
    }

    #[test]
    fn opening_a_place_counts_as_work_before_anything_is_running_on_it() {
        // The gap this closes is small and nasty: you provision a box, the
        // sweep runs before you have started anything, and the machine you are
        // waiting for goes to sleep underneath you.
        let mut just_opened = quiet();
        just_opened.last_used_at = NOW - 60;
        assert_eq!(
            Policy::default().read(&just_opened),
            Rest::Busy(Work::Opened)
        );
    }

    #[test]
    fn a_place_nobody_has_asked_about_is_not_slept_on_the_books_word_alone() {
        // The sweep's own safety catch. The book knows when this laptop last
        // opened the place; it does not know what is running over there, and a
        // machine stopped on that much evidence is a machine stopped while a
        // teammate is working on it.
        let mut unasked = quiet();
        unasked.sessions = None;
        assert_eq!(Policy::default().read(&unasked), Rest::Unasked);
        assert!(!Rest::Unasked.is_idle());
    }

    #[test]
    fn a_place_ruled_out_by_the_book_is_never_worth_a_round_trip() {
        // What makes the sweep cheap enough to run every few minutes: the three
        // `Kept` answers and the recently-opened one are all reached without
        // asking the machine anything, so a book full of boxes you brought
        // costs no network at all.
        let unasked = Observed {
            sessions: None,
            ..quiet()
        };
        for (case, seen) in [
            ("a box you brought", Observed { aura_may_stop_it: false, ..unasked }),
            ("a row with no handle", Observed { handle: None, ..unasked }),
            ("a place already asleep", Observed { asleep_since: NOW - 10, ..unasked }),
            ("a place just opened", Observed { last_used_at: NOW - 5, ..unasked }),
        ] {
            assert_ne!(
                Policy::default().read(&seen),
                Rest::Unasked,
                "{case} would have cost a round trip to rule out"
            );
        }
        // And the one case that is genuinely worth asking about still asks.
        assert_eq!(Policy::default().read(&unasked), Rest::Unasked);
    }

    #[test]
    fn a_time_nobody_recorded_is_not_a_time_something_happened() {
        // A row with no `last_used_at` — written before the field, or by a
        // create path that had nothing to put there — must not read as "opened
        // in 1970 and therefore idle" by accident, nor as "opened now".
        let mut never = quiet();
        never.last_used_at = 0;
        assert_eq!(Policy::default().read(&never), Rest::Idle);
        assert!(!within(NOW, 0, IDLE_AFTER));
    }

    #[test]
    fn a_machine_whose_clock_runs_fast_is_not_stopped_for_it() {
        // Two clocks are involved — this laptop's and the box's — and tmux
        // stamps sessions with the box's. A few seconds of skew must not read
        // as "this happened in the future, so it never happened".
        let sessions = [session("agent-1", NOW + 30, 0)];
        let mut ahead = quiet();
        ahead.sessions = Some(&sessions);
        assert_eq!(
            Policy::default().read(&ahead),
            Rest::Busy(Work::Running("agent-1".into()))
        );
    }

    #[test]
    fn the_stated_policy_is_built_from_the_numbers_it_states() {
        // The sentence is shown to a member. A sentence that drifts from the
        // constant beside it is worse than none: it is what somebody believes
        // while the machine does something else.
        let said = Policy::default().sentence();
        assert!(said.contains("30 minutes"), "{said}");
        assert!(said.contains("8 hours"), "{said}");
        assert!(
            said.contains("never touched"),
            "the policy must state the boundary, not only the timings: {said}"
        );

        let shorter = Policy {
            idle_after: Duration::from_secs(60),
            sessions_go_stale_after: Duration::from_secs(90 * 60),
        };
        let said = shorter.sentence();
        assert!(said.contains("a minute"), "{said}");
        assert!(said.contains("1h 30m"), "{said}");
    }

    #[test]
    fn the_default_numbers_are_the_ones_written_down() {
        // Two constants and a `Default` that could quietly stop agreeing.
        assert_eq!(Policy::default().idle_after, IDLE_AFTER);
        assert_eq!(
            Policy::default().sessions_go_stale_after,
            SESSIONS_GO_STALE_AFTER
        );
        assert!(
            SESSIONS_GO_STALE_AFTER > IDLE_AFTER,
            "an open session must be protected for longer than an empty box, or the \
             longer window does nothing"
        );
    }
}
