//! Read a `/usr/bin/sample` and answer one question: **is the main thread
//! actually blocked, or is it just parked?**
//!
//! The watchdog used to answer that from beat silence alone — "the main
//! thread has not run my closure for a minute, therefore it is wedged" — and
//! that inference is wrong. `run_on_main_thread` posts a user event to the
//! event loop; a silent beat proves the loop did not *pump*, not that the
//! thread is stuck. An app whose window is hidden is fed no events by macOS,
//! parks in `ReceiveNextEventCommon`, and looks identical from the beat's
//! side to one deadlocked in AppKit.
//!
//! It is not a hypothetical difference. Of the 17 stalls this app recorded
//! against itself on this machine between 2026-09-01 and 2026-09-08, each of
//! which ended in `SIGKILL` and a relaunch, replaying the captured samples
//! through [`classify`] gives:
//!
//! ```text
//!  4  Blocked      main thread inside a synchronous XPC call
//! 13  NotWedged    main thread parked in the ordinary event pump
//! ```
//!
//! Thirteen healthy apps killed mid-session. So the sample stops being an
//! after-the-fact artefact filed with the report and becomes the evidence the
//! verdict is made from: no blocking frame, no kill.
//!
//! **How a sample is read.** `sample` prints a call tree per thread, deepest
//! frames indented furthest, each line prefixed by how many of the run's
//! samples passed through that frame:
//!
//! ```text
//!     1438 Thread_32924647   DispatchQueue_1: com.apple.main-thread  (serial)
//!     + 1438 main  (in aura-shell) + 52  [0x104e2d544]
//!     + ! 1259 WebKit::ProcessAssertion::remainingRunTimeInSeconds(int) …
//!     + !   1046 -[RBSXPCMessage invoke] …
//! ```
//!
//! We take the main thread's block, and look for a frame naming a call that
//! *cannot return on its own* — a synchronous XPC round trip, a semaphore or
//! condvar wait, WebKit's synchronous IPC, the AppKit scene re-entrancy of the
//! original 2026-08-30 freeze — that held the thread for at least half the
//! run. Half, rather than all, because the pump keeps turning around a slow
//! callout; and named primitives rather than "is it in `mach_msg2_trap`",
//! because the idle pump sits in `mach_msg2_trap` too. That single distinction
//! is the whole module.

/// Calls a main thread does not come back from by itself. Anything here,
/// holding the thread for most of the sample, is a real wedge.
///
/// `ReceiveNextEventCommon` and `mach_msg2_trap` are deliberately absent: an
/// idle event pump sits in both, and so does a blocked one — they say the
/// thread is waiting, not that it is stuck.
const BLOCKING_FRAMES: &[&str] = &[
    // Synchronous XPC. Every stall on this machine that was real was one of
    // these: WebKit's ProcessThrottler releasing a process assertion, which
    // round-trips to RunningBoard on the main thread.
    "xpc_connection_send_message_with_reply_sync",
    "RBSXPCMessage",
    "RBSConnection",
    // Waiting on another queue or thread to hand the main thread back.
    "__DISPATCH_WAIT_FOR_QUEUE__",
    "dispatch_semaphore_wait",
    "_dispatch_sema4_wait",
    "semaphore_wait_trap",
    "psynch_cvwait",
    "pthread_cond_wait",
    "__ulock_wait",
    // WebKit synchronous IPC — the web process must answer before we run again.
    "waitForAndDispatchImmediately",
    "sendSyncMessage",
    // The 2026-08-30 AppKit scene-update deadlock this watchdog was written for.
    "_setFrameCommon",
    "FBSScene",
];

/// A frame must hold the main thread for at least this share of the sample
/// before it counts. A genuinely stuck thread is in one call for the whole
/// run; a busy one passes through many.
const DOMINANT_NUMERATOR: u32 = 1;
const DOMINANT_DENOMINATOR: u32 = 2;

/// What the sample says about the main thread.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MainThread {
    /// Held in a call that will not return on its own. The frame and the
    /// share of the sample it held, for the report.
    Blocked { frame: String, percent: u32 },
    /// Parked in the ordinary event pump with nothing blocking below it.
    /// The app is healthy and must not be killed.
    NotWedged,
    /// No main thread in the text — a truncated or failed sample. Says
    /// nothing either way, so it must not be read as permission to kill.
    Unreadable,
}

impl MainThread {
    /// The only question the watchdog asks.
    pub fn is_blocked(&self) -> bool {
        matches!(self, MainThread::Blocked { .. })
    }

    /// One line for the crash report, naming what was actually measured
    /// rather than the failure mode we guessed at when this was written.
    pub fn describe(&self) -> String {
        match self {
            MainThread::Blocked { frame, percent } => format!(
                "the main thread is blocked in {frame}, which held it for {percent}% of the sample"
            ),
            MainThread::NotWedged => {
                "the main thread is parked in the event pump with nothing blocking it".to_string()
            }
            MainThread::Unreadable => "the sample could not be read".to_string(),
        }
    }
}

/// Classify the main thread in `sample` output.
pub fn classify(sample: &str) -> MainThread {
    let Some((total, body)) = main_thread_block(sample) else {
        return MainThread::Unreadable;
    };
    if total == 0 {
        return MainThread::Unreadable;
    }
    for line in body {
        let Some((count, name)) = frame(line) else {
            continue;
        };
        if count * DOMINANT_DENOMINATOR < total * DOMINANT_NUMERATOR {
            continue;
        }
        if let Some(hit) = BLOCKING_FRAMES.iter().find(|b| name.contains(*b)) {
            return MainThread::Blocked {
                frame: (*hit).to_string(),
                percent: (count.saturating_mul(100) / total) as u32,
            };
        }
    }
    MainThread::NotWedged
}

/// The main thread's own slice of the tree, with the run's sample count.
///
/// `sample` labels it two ways depending on the OS build — `Thread_N: main`
/// and `Thread_N   DispatchQueue_1: com.apple.main-thread` both appear in the
/// stalls on this machine — so both have to be recognised or the classifier
/// silently reads nothing and every stall comes back `Unreadable`.
fn main_thread_block(sample: &str) -> Option<(u32, Vec<&str>)> {
    let mut lines = sample.lines().enumerate();
    let (start, total) = loop {
        let (i, line) = lines.next()?;
        if let Some(count) = thread_header(line) {
            if line.contains("com.apple.main-thread") || line.trim_end().ends_with(": main") {
                break (i, count);
            }
        }
    };
    let rest: Vec<&str> = sample.lines().skip(start + 1).collect();
    let end = rest
        .iter()
        .position(|l| thread_header(l).is_some())
        .unwrap_or(rest.len());
    Some((total, rest[..end].to_vec()))
}

/// `    1438 Thread_32924647   DispatchQueue_1: …` → the leading count.
fn thread_header(line: &str) -> Option<u32> {
    let rest = line.strip_prefix("    ")?;
    let (count, tail) = rest.split_once(' ')?;
    tail.starts_with("Thread_")
        .then(|| count.parse().ok())
        .flatten()
}

/// `    + ! 1259 WebKit::ProcessAssertion::…` → `(1259, "WebKit::…")`.
///
/// The tree-drawing prefix varies per branch, so we skip leading whitespace
/// and box characters and take the first number we land on.
fn frame(line: &str) -> Option<(u32, &str)> {
    let trimmed =
        line.trim_start_matches(|c: char| c.is_whitespace() || matches!(c, '+' | '|' | '!' | ':'));
    let (count, name) = trimmed.split_once(' ')?;
    Some((count.parse().ok()?, name.trim()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Shape of a real sample: the header carries the count, the frames are
    /// indented under it, and a second thread ends the block.
    const IDLE: &str = "\
Analysis of sampling aura-shell (pid 51988) every 1 millisecond
Call graph:
    1353 Thread_32924647   DispatchQueue_1: com.apple.main-thread  (serial)
    + 1353 main  (in aura-shell) + 52  [0x104e2d544]
    +   1353 RunCurrentEventLoopInMode  (in HIToolbox) + 320  [0x1908a7]
    +     1238 ReceiveNextEventCommon  (in HIToolbox) + 688  [0x1908a8]
    +       1238 mach_msg2_trap  (in libsystem_kernel.dylib) + 8  [0x1839bb]
    1353 Thread_32925162: notify-rs fsevents loop
    + 1353 __psynch_cvwait  (in libsystem_kernel.dylib) + 8  [0x1839bc]
";

    const BLOCKED: &str = "\
Call graph:
    1438 Thread_32924647   DispatchQueue_1: com.apple.main-thread  (serial)
    + 1438 main  (in aura-shell) + 52  [0x104e2d544]
    +   1438 ReceiveNextEventCommon  (in HIToolbox) + 688  [0x1908a8]
    +     1259 WebKit::ProcessAssertion::remainingRunTimeInSeconds(int)  (in WebKit)
    +       1046 -[RBSXPCMessage invoke]  (in RunningBoardServices) + 40  [0x1a2b]
    1438 Thread_32925173: com.apple.NSEventThread
";

    #[test]
    fn a_parked_event_pump_is_not_a_wedge() {
        assert_eq!(classify(IDLE), MainThread::NotWedged);
    }

    #[test]
    fn the_idle_pump_frames_are_never_read_as_blocking() {
        // Both threads in IDLE sit in mach traps, and the *other* thread is in
        // a condvar wait that is on the blocking list — proof the classifier
        // reads the main thread's block and stops at the next header.
        assert!(!classify(IDLE).is_blocked());
    }

    #[test]
    fn a_synchronous_xpc_round_trip_is_a_wedge() {
        match classify(BLOCKED) {
            MainThread::Blocked { frame, percent } => {
                assert_eq!(frame, "RBSXPCMessage");
                assert_eq!(percent, 72);
            }
            other => panic!("expected a wedge, got {other:?}"),
        }
    }

    #[test]
    fn a_blocking_frame_under_half_the_sample_is_a_slow_call_not_a_wedge() {
        let brief = BLOCKED.replace("1046 -[RBSXPCMessage", "40 -[RBSXPCMessage");
        assert_eq!(classify(&brief), MainThread::NotWedged);
    }

    #[test]
    fn the_other_main_thread_label_is_recognised() {
        let alt = BLOCKED.replace(
            "Thread_32924647   DispatchQueue_1: com.apple.main-thread  (serial)",
            "Thread_32924647: main",
        );
        assert!(classify(&alt).is_blocked());
    }

    #[test]
    fn a_sample_with_no_main_thread_never_authorises_a_kill() {
        let headless = "    1353 Thread_32925162: notify-rs fsevents loop\n\
                        + 1353 __psynch_cvwait  (in libsystem_kernel.dylib)\n";
        assert_eq!(classify(headless), MainThread::Unreadable);
        assert!(!classify(headless).is_blocked());
        assert!(!classify("").is_blocked());
    }

    #[test]
    fn the_description_names_the_measured_frame() {
        let d = classify(BLOCKED).describe();
        assert!(d.contains("RBSXPCMessage"), "{d}");
        assert!(d.contains("72%"), "{d}");
    }
}
