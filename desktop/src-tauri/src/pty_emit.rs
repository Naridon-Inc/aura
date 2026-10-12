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

/// A chunk in the form it crosses to the webview in.
///
/// `emit` serializes whatever it is handed as JSON, and a `Vec<u8>` becomes a
/// JSON array of integers — a decimal number and a comma for every byte.
/// Measured on a 64 KB chunk of build output that is ~3.5x the bytes it
/// carries, and the cost does not stop at the wire: the webview parses that
/// text into a JS array, and the frontend then copies it elementwise into a
/// `Uint8Array`. Measured end to end at 132 MB/s.
///
/// Base64 spends 4 bytes per 3 and decodes in a single pass, so the same chunk
/// crosses as ~1.33x instead of ~3.5x — measured 4.8x faster to take delivery
/// of, and faster still where the engine has a native `Uint8Array.fromBase64`.
///
/// It has to be an encoding rather than a plain string. PTY output is arbitrary
/// binary — half a UTF-8 sequence left at a chunk boundary, a bare `0x1b`, a
/// `0x00` — so there is no `String` that round-trips it unchanged. Base64 is
/// the cheapest form that is both exact and valid JSON.
///
/// The frontend counterpart is `decodePtyChunk` in `src/lib/ptyPayload.ts`;
/// the two must change together.
pub fn encode_chunk(bytes: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.encode(bytes)
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

    #[test]
    fn encoding_round_trips_bytes_that_are_not_valid_utf8() {
        use base64::Engine as _;
        // A chunk boundary can fall mid-sequence, so the stream is not text:
        // a lone continuation byte, a bare escape, an interior NUL.
        let raw = b"\x1b[31m\x80\x00ready\xff";
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(encode_chunk(raw))
            .expect("what we emit must decode");
        assert_eq!(decoded, raw.to_vec(), "the stream must survive exactly");
    }

    /// Pinned on both sides of the boundary: `src/lib/ptyPayload.test.ts`
    /// decodes this exact string back to these exact bytes. Neither end can
    /// change alphabet or padding without the other's test failing.
    #[test]
    fn the_wire_format_matches_the_vector_the_frontend_pins() {
        let raw = [
            0x1b, 0x5b, 0x33, 0x31, 0x6d, 0x80, 0x00, 0x6f, 0x6b, 0xff, 0xfe, 0x0d, 0x0a,
        ];
        // Standard alphabet, padded. URL-safe would end `__4NCg==` here.
        assert_eq!(encode_chunk(&raw), "G1szMW2AAG9r//4NCg==");
    }

    #[test]
    fn an_empty_chunk_encodes_to_an_empty_string() {
        assert_eq!(encode_chunk(b""), "");
    }

    #[test]
    fn encoding_is_far_smaller_than_the_json_array_it_replaces() {
        let chunk = vec![b'x'; FLUSH_BYTES];
        let as_json_array = serde_json::to_string(&chunk).expect("bytes serialize");
        let as_base64 = serde_json::to_string(&encode_chunk(&chunk)).expect("string serializes");
        // The whole point of the change: the payload a full flush puts on the
        // wire has to shrink, not merely change shape.
        assert!(
            as_base64.len() * 2 < as_json_array.len(),
            "base64 {} should be less than half of the JSON array {}",
            as_base64.len(),
            as_json_array.len()
        );
    }
}
