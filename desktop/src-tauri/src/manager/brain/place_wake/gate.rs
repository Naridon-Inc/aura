//! One wake per machine, however many surfaces ask for it.
//!
//! Waking is not a request that can simply be repeated. A member opening a
//! sleeping place does five things at once without meaning to — the session
//! list, the capability probe, the drift report, the project list and whatever
//! the chat's first tool does — and each of those is a `Place` call that finds a
//! stopped machine. Five starts against one instance is, at best, four wasted
//! round trips against somebody's API rate limit and five spinners that finish
//! at different times; at worst it is a cloud that answers the second one with a
//! refusal and a member who is shown "couldn't start it" about a machine that is
//! starting perfectly well.
//!
//! So the first caller leads and the rest wait on the answer it gets. That is
//! the whole of this file, and the reason it is a file: the interesting part is
//! not the happy path but what happens when the leader goes away.
//!
//! ## The leader can vanish, and the flight must not outlive it
//!
//! A wake takes about a minute, which is long enough for the surface that
//! started it to be closed, the command to be cancelled, or the tab to be shut.
//! Dropping a future is how all three end, and none of them runs a line at the
//! bottom of a function. A flight left in the book after its leader has gone is
//! the worst possible failure here: every later call joins a flight that will
//! never land, and the machine becomes one nothing in the app can ever wake
//! again. [`Leading`] is a `Drop` guard for exactly that, and a follower whose
//! leader disappeared goes round the loop and leads instead of reporting a
//! failure that never happened.
//!
//! ## In-process, and honestly so
//!
//! This gate holds one desktop's callers apart from each other. Two laptops
//! reaching the same sleeping place will each start a wake, and that is fine
//! rather than merely tolerated: starting a machine that is already starting is
//! idempotent on every substrate we target — the request names an instance and
//! asks for it to be running, which it already is. What is NOT idempotent is
//! this laptop showing five different answers about one machine, and that is
//! what this prevents.

use std::collections::HashMap;
use std::future::Future;
use std::sync::{Mutex, MutexGuard, OnceLock, PoisonError};

use tokio::sync::watch;

use super::super::place::unix_now;

/// How a wake ended: the address the machine came back on, or the sentence
/// saying why it did not.
///
/// Cloneable on purpose — every follower gets the same answer as the leader,
/// and an answer only one caller can have is an answer the other four have to
/// go and find out for themselves.
pub(super) type Landing = Result<String, String>;

/// A wake somebody is already waiting on.
struct Flight {
    /// When it started, so a surface can say how long it has been rather than
    /// showing a spinner with no end in sight.
    since: i64,
    /// The outcome, once there is one. `None` while it is still in the air.
    landing: watch::Receiver<Option<Landing>>,
}

/// Every wake currently in the air, by machine id.
fn book() -> MutexGuard<'static, HashMap<String, Flight>> {
    static FLIGHTS: OnceLock<Mutex<HashMap<String, Flight>>> = OnceLock::new();
    // A panic inside a wake would poison the lock and, left alone, would make
    // every later wake on this desktop panic too — turning one bad machine into
    // an app that can no longer start any of them. The map itself is a plain
    // table of ids; there is no invariant a panic could have half-broken.
    FLIGHTS
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
}

/// The leader's hold on a flight, released however the wake ends.
///
/// The removal is in `Drop` rather than at the end of the happy path because
/// the leading future can be dropped mid-wake, and a line at the bottom of a
/// function does not run when that happens.
///
/// Field order matters: `Drop::drop` runs before the struct's fields are
/// dropped, so the entry leaves the book *before* the sender does. A follower
/// woken by the sender closing therefore looks at a book with no flight in it
/// and takes over, rather than racing the removal and joining a corpse.
struct Leading {
    machine_id: String,
    landing: watch::Sender<Option<Landing>>,
}

impl Drop for Leading {
    fn drop(&mut self) {
        book().remove(&self.machine_id);
    }
}

/// Start this machine, or wait on the start somebody else already began.
///
/// `wake` is a closure rather than a future because a call may have to lead
/// after all — the leader it was waiting on disappeared — and a future that has
/// already been handed over cannot be made again.
///
/// The loop is bounded in practice by the same thing that bounds any wake: each
/// turn either lands (leader or follower, both return) or discovers an abandoned
/// flight, which has already been removed from the book by the time the follower
/// is woken. The next turn therefore leads.
pub(super) async fn once<F, W>(machine_id: &str, wake: W) -> Landing
where
    W: Fn() -> F,
    F: Future<Output = Landing>,
{
    loop {
        // The book is consulted and released inside this block, before anything
        // is awaited. Holding a std mutex across an await is how one machine
        // taking a minute to start blocks every other machine's report for a
        // minute — and, on a single-threaded runtime, deadlocks outright.
        let turn = {
            let mut flights = book();
            match flights.get(machine_id) {
                Some(flight) => Turn::Follow(flight.landing.clone()),
                None => {
                    let (sender, landing) = watch::channel(None);
                    flights.insert(
                        machine_id.to_string(),
                        Flight {
                            since: unix_now(),
                            landing,
                        },
                    );
                    Turn::Lead(Leading {
                        machine_id: machine_id.to_string(),
                        landing: sender,
                    })
                }
            }
        };

        match turn {
            Turn::Follow(mut waiting) => match landed(&mut waiting).await {
                Some(answer) => return answer,
                // The leader went away without landing. Round again: this call
                // leads rather than reporting a failure that never happened.
                None => continue,
            },
            Turn::Lead(leading) => {
                let outcome = wake().await;
                // Told to the followers first, then the flight is cleared by
                // `Drop`. A caller arriving in between joins a flight that has
                // already landed and is handed its answer immediately, which is
                // the right answer: the machine really is up.
                let _ = leading.landing.send(Some(outcome.clone()));
                return outcome;
            }
        }
    }
}

/// Whether this call is starting the machine or waiting on somebody who is.
///
/// A value rather than two branches inside the lock, so the decision is made
/// while the book is held and everything slow happens after it is released.
enum Turn {
    Follow(watch::Receiver<Option<Landing>>),
    Lead(Leading),
}

/// Wait for a flight to land. `None` means its leader disappeared.
async fn landed(waiting: &mut watch::Receiver<Option<Landing>>) -> Option<Landing> {
    loop {
        // Checked before waiting, because a flight can land between being read
        // out of the book and being waited on, and `changed()` only reports what
        // happens after it is called.
        if let Some(answer) = waiting.borrow().clone() {
            return Some(answer);
        }
        waiting.changed().await.ok()?;
    }
}

/// When the wake in the air for this machine started, if there is one.
///
/// The whole of what a surface needs to say the honest thing while it waits:
/// that something is happening, and since when. Reading it costs a lock and no
/// round trip, so a panel may ask on every draw.
pub(super) fn since(machine_id: &str) -> Option<i64> {
    book().get(machine_id).map(|flight| flight.since)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::Duration;

    /// A machine id per test, because the gate is one table for the process and
    /// two tests sharing an id would wait on each other's flights.
    fn only_here(what: &str) -> String {
        format!("gate-test-{what}")
    }

    #[tokio::test]
    async fn two_surfaces_reaching_one_sleeping_place_start_one_wake() {
        // The acceptance criterion of the concurrency half. Opening a place
        // fires several reads at once and every one of them finds a stopped
        // machine; five starts against one instance is four wasted requests and
        // five spinners that finish at different times.
        let id = only_here("one-wake");
        let starts = Arc::new(AtomicUsize::new(0));
        let wake = || {
            let starts = starts.clone();
            async move {
                starts.fetch_add(1, Ordering::SeqCst);
                // Long enough that the others are certainly waiting rather than
                // arriving after it finished, which would prove nothing.
                tokio::time::sleep(Duration::from_millis(50)).await;
                Ok("10.0.0.9".to_string())
            }
        };

        let answers = futures_util::future::join_all((0..5).map(|_| once(&id, &wake))).await;

        assert_eq!(starts.load(Ordering::SeqCst), 1, "the machine was started more than once");
        for answer in &answers {
            assert_eq!(answer.as_deref(), Ok("10.0.0.9"), "a caller got a different answer");
        }
    }

    #[tokio::test]
    async fn everybody_waiting_on_a_wake_that_failed_is_told_the_same_thing() {
        // The other half of sharing an answer. A follower handed "it worked"
        // because only the leader saw the refusal would go on to dial a machine
        // that is still stopped, and report the connection error as the fault.
        let id = only_here("shared-failure");
        let wake = || async {
            tokio::time::sleep(Duration::from_millis(20)).await;
            Err("the cloud is out of capacity this afternoon".to_string())
        };
        let answers = futures_util::future::join_all((0..3).map(|_| once(&id, &wake))).await;
        for answer in &answers {
            assert_eq!(
                answer.as_ref().err().map(String::as_str),
                Some("the cloud is out of capacity this afternoon")
            );
        }
    }

    #[tokio::test]
    async fn a_failed_wake_leaves_nothing_behind_to_join() {
        // A flight that outlived its answer would make the next attempt wait on
        // a machine nobody is starting. Asking again after a failure has to
        // really ask again — a cloud out of capacity at 3pm is not out of
        // capacity at 3:05.
        let id = only_here("clears-after-failure");
        let starts = Arc::new(AtomicUsize::new(0));
        let wake = || {
            let starts = starts.clone();
            async move {
                starts.fetch_add(1, Ordering::SeqCst);
                Err("no capacity".to_string())
            }
        };
        assert!(once(&id, &wake).await.is_err());
        assert_eq!(since(&id), None, "a landed flight is still in the book");
        assert!(once(&id, &wake).await.is_err());
        assert_eq!(starts.load(Ordering::SeqCst), 2, "the second ask joined a dead flight");
    }

    #[tokio::test]
    async fn a_wake_whose_caller_walked_away_does_not_wedge_the_machine() {
        // The failure this file is really about. A member starts a place and
        // closes the panel; the future leading the wake is dropped. Without the
        // guard the flight sits in the book for the life of the process and the
        // machine can never be woken by anything again.
        let id = only_here("abandoned");
        let starts = Arc::new(AtomicUsize::new(0));
        let slow = {
            let starts = starts.clone();
            move || {
                let starts = starts.clone();
                async move {
                    starts.fetch_add(1, Ordering::SeqCst);
                    tokio::time::sleep(Duration::from_secs(30)).await;
                    Ok("never".to_string())
                }
            }
        };

        let led = tokio::spawn({
            let id = id.clone();
            let slow = slow.clone();
            async move { once(&id, slow).await }
        });
        // Wait until it is genuinely in the air, so the abort lands mid-wake
        // rather than before the flight was ever entered.
        while since(&id).is_none() {
            tokio::task::yield_now().await;
        }
        led.abort();
        let _ = led.await;

        // The book is clear, and the next caller leads.
        while since(&id).is_some() {
            tokio::task::yield_now().await;
        }
        let quick = || async { Ok("10.0.0.9".to_string()) };
        assert_eq!(once(&id, quick).await.as_deref(), Ok("10.0.0.9"));
        assert_eq!(
            starts.load(Ordering::SeqCst),
            1,
            "the abandoned wake was somehow run twice"
        );
    }

    #[tokio::test]
    async fn a_follower_whose_leader_vanished_starts_the_machine_itself() {
        // The recovery path, from the follower's side: it must not report a
        // failure the cloud never gave. A leader that was dropped said nothing
        // about the machine at all, so the honest response is to ask.
        let id = only_here("follower-leads");
        let leader_started = Arc::new(tokio::sync::Notify::new());
        let led = tokio::spawn({
            let id = id.clone();
            let leader_started = leader_started.clone();
            async move {
                once(&id, || {
                    let leader_started = leader_started.clone();
                    async move {
                        leader_started.notify_waiters();
                        tokio::time::sleep(Duration::from_secs(30)).await;
                        Ok("never".to_string())
                    }
                })
                .await
            }
        });
        while since(&id).is_none() {
            tokio::task::yield_now().await;
        }

        let follower = tokio::spawn({
            let id = id.clone();
            async move { once(&id, || async { Ok("10.0.0.9".to_string()) }).await }
        });
        // Give the follower a chance to join the leader's flight before the
        // leader is taken away, or it would simply lead from the start.
        tokio::time::sleep(Duration::from_millis(20)).await;
        led.abort();
        let _ = led.await;

        assert_eq!(
            follower.await.expect("the follower survived its leader").as_deref(),
            Ok("10.0.0.9")
        );
    }

    #[tokio::test]
    async fn a_place_nobody_is_starting_has_no_wait_to_report() {
        assert_eq!(since(&only_here("untouched")), None);
    }

    #[tokio::test]
    async fn a_wake_in_the_air_says_when_it_began() {
        // What a surface draws "20s so far" from. Nothing else in the app knows
        // when a wake started — the book only learns about it once it lands.
        let id = only_here("since");
        let seen = Arc::new(Mutex::new(None));
        let watched = seen.clone();
        once(&id, || {
            let watched = watched.clone();
            let id = id.clone();
            async move {
                *watched.lock().unwrap_or_else(PoisonError::into_inner) = since(&id);
                Ok("10.0.0.9".to_string())
            }
        })
        .await
        .expect("it woke");
        let began = seen.lock().unwrap_or_else(PoisonError::into_inner).expect("a start time");
        assert!(
            (began - unix_now()).abs() < 5,
            "a wake claimed to have started at {began}"
        );
    }
}
