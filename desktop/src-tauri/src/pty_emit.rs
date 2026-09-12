//! Gather PTY output into one event per frame instead of one per read.
//!
//! Every `emit` to the frontend is a `runJavaScript` on the webview, and on
//! macOS WebKit brackets each one with a process assertion whose *release*
//! is a synchronous XPC round trip to RunningBoard, made on the main thread.
//! That is not a small cost paid off-thread: it is the exact stack the app
//! was caught frozen in on 2026-09-08, sampled mid-stall —
//!
//! ```text
//! IPC::Connection::dispatchIncomingMessages
//!   WebKit::ProcessThrottlerActivity::~ProcessThrottlerActivity
//!     WebKit::ProcessAssertion::remainingRunTimeInSeconds
//!       -[RBSConnection handleForIdentifier:]
//!         -[RBSXPCMessage invoke]        ← main thread, waiting on RunningBoard
//! ```
//!
//! A PTY hands us whatever the child happened to write, which for a busy
//! agent is dozens of small reads a second — measured on this machine at
//! **~66 evals/second** with a few agents running. Each one was a separate
//! emit, so the main thread spent its time in RunningBoard round trips
//! rather than in layout and paint, which is both the freeze and the reason
//! the window can look painted-but-dead while the web process is plainly
//! alive and running script.
//!
//! Coalescing fixes the cause rather than the symptom. Bytes are appended in
//! arrival order and released as one payload, so xterm sees exactly the same
//! stream — escape codes included, since nothing here interprets them — and
//! the emit rate drops to at most one per [`FLUSH_WINDOW`]. A terminal is
//! repainted once a frame no matter how many events fed it, so nothing is
//! lost in the trade: the same bytes arrive within the same frame, in one
//! call instead of forty.

use std::time::{Duration, Instant};

/// Longest a byte waits to be sent. One frame at 60Hz — below the threshold
/// where a terminal feels less than instant, and the render happens on the
/// frame boundary regardless.
pub const FLUSH_WINDOW: Duration = Duration::from_millis(16);

/// Send immediately once this much has gathered, whatever the clock says.
/// A build log or a `cat` of something large arrives far faster than the
/// window and should not be held back behind it.
pub const FLUSH_BYTES: usize = 64 * 1024;

/// Bytes waiting to go out, and how long the oldest has been waiting.
#[derive(Debug, Default)]
pub struct Coalescer {
    pending: Vec<u8>,
    since: Option<Instant>,
}

impl Coalescer {
    pub fn new() -> Self {
        Self::default()
    }

    /// Take bytes off the PTY. They are held until [`Coalescer::due`].
    pub fn push(&mut self, bytes: &[u8]) {
        if self.pending.is_empty() {
            self.since = Some(Instant::now());
        }
        self.pending.extend_from_slice(bytes);
    }

    pub fn is_empty(&self) -> bool {
        self.pending.is_empty()
    }

    /// Whether what is held should go out now — the window has elapsed, or
    /// enough has gathered that waiting only adds latency.
    pub fn due(&self) -> bool {
        if self.pending.is_empty() {
            return false;
        }
        self.pending.len() >= FLUSH_BYTES
            || self
                .since
                .map(|t| t.elapsed() >= FLUSH_WINDOW)
                .unwrap_or(true)
    }

    /// How long the caller may block waiting for more bytes: the rest of the
    /// flush window when something is held, or the caller's own `idle` when
    /// nothing is. Holding bytes past the window is the one thing this must
    /// never allow, so a due buffer asks for no wait at all.
    pub fn wait(&self, idle: Duration) -> Duration {
        match self.since {
            None => idle,
            Some(t) => FLUSH_WINDOW.saturating_sub(t.elapsed()),
        }
    }

    /// Everything held, in arrival order, leaving the coalescer empty.
    pub fn take(&mut self) -> Vec<u8> {
        self.since = None;
        std::mem::take(&mut self.pending)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nothing_held_means_nothing_to_send() {
        let c = Coalescer::new();
        assert!(c.is_empty());
        assert!(!c.due());
        // …and the caller waits on its own terms, not ours.
        assert_eq!(c.wait(Duration::from_secs(9)), Duration::from_secs(9));
    }

    #[test]
    fn small_reads_are_gathered_rather_than_sent_one_by_one() {
        let mut c = Coalescer::new();
        for _ in 0..40 {
            c.push(b"tick ");
        }
        // Forty reads, still one payload waiting — the whole point.
        assert!(
            !c.due(),
            "a burst inside one frame must not send forty events"
        );
        assert_eq!(c.take().len(), 200);
        assert!(c.is_empty());
    }

    #[test]
    fn order_is_preserved_exactly() {
        let mut c = Coalescer::new();
        c.push(b"\x1b[31m");
        c.push(b"error");
        c.push(b"\x1b[0m\r\n");
        assert_eq!(c.take(), b"\x1b[31merror\x1b[0m\r\n".to_vec());
    }

    #[test]
    fn a_large_read_does_not_wait_for_the_clock() {
        let mut c = Coalescer::new();
        c.push(&vec![b'x'; FLUSH_BYTES]);
        assert!(c.due(), "a full buffer must go out without waiting");
        // And the wait it asks for cannot exceed one window.
        assert!(c.wait(Duration::from_secs(9)) <= FLUSH_WINDOW);
    }

    #[test]
    fn the_window_is_never_extended_by_later_reads() {
        let mut c = Coalescer::new();
        c.push(b"first");
        let after_first = c.wait(Duration::from_secs(9));
        c.push(b"second");
        // The deadline belongs to the oldest byte. A steady stream of new
        // reads must not keep pushing it back, or a chatty agent's output
        // would never be sent at all.
        assert!(c.wait(Duration::from_secs(9)) <= after_first);
    }

    #[test]
    fn taking_resets_the_deadline() {
        let mut c = Coalescer::new();
        c.push(b"a");
        let _ = c.take();
        assert_eq!(c.wait(Duration::from_secs(9)), Duration::from_secs(9));
        assert!(!c.due());
    }

    #[test]
    fn an_elapsed_window_is_due() {
        let mut c = Coalescer::new();
        c.push(b"a");
        std::thread::sleep(FLUSH_WINDOW + Duration::from_millis(5));
        assert!(c.due());
        assert_eq!(c.wait(Duration::from_secs(9)), Duration::ZERO);
    }
}
