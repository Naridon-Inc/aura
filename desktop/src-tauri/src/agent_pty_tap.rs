//! In-process taps on an agent session's terminal output.
//!
//! Agent output already goes three places from the pump: out to the webview as
//! an event, into the replay history, and through the block parser. All three
//! are either across the IPC boundary or bookkeeping. A native GPU pane needs
//! the same bytes *in this process*, because its grid and renderer live on a
//! Rust thread and a round trip through the webview would defeat the point of
//! rendering natively at all.
//!
//! So: a session id maps to zero or more senders, and the pump offers each
//! flushed chunk to whoever is listening.
//!
//! The common case is nobody listening, and that case must stay free — this
//! sits in the path every byte of every agent takes. [`publish`] therefore
//! looks the id up and returns before copying anything; a chunk is only cloned
//! once there is somewhere for it to go.
//!
//! Senders are pruned when their receiver is gone, so a closed pane leaves
//! nothing behind and a session that nobody ever attached to never allocates.

use std::collections::HashMap;
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Mutex, OnceLock};

type Taps = Mutex<HashMap<String, Vec<Sender<Vec<u8>>>>>;

fn taps() -> &'static Taps {
    static TAPS: OnceLock<Taps> = OnceLock::new();
    TAPS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Listen to a session's output. The receiver gets every chunk flushed after
/// this call; earlier output is not replayed, because the caller that wants
/// scrollback asks for the history buffer instead.
pub fn subscribe(session_id: &str) -> Receiver<Vec<u8>> {
    let (tx, rx) = channel();
    taps()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .entry(session_id.to_string())
        .or_default()
        .push(tx);
    rx
}

/// Offer a flushed chunk to this session's listeners, if it has any.
///
/// Returns early without touching `bytes` when nobody is attached, which is
/// the usual state — this runs on every flush of every agent session.
pub fn publish(session_id: &str, bytes: &[u8]) {
    let mut all = taps().lock().unwrap_or_else(|e| e.into_inner());
    let Some(senders) = all.get_mut(session_id) else {
        return;
    };
    // A receiver that has been dropped means its pane is gone; forget the
    // sender rather than cloning into it again on every future chunk.
    senders.retain(|tx| tx.send(bytes.to_vec()).is_ok());
    if senders.is_empty() {
        all.remove(session_id);
    }
}

/// How many live listeners a session has. For tests and diagnostics.
pub fn listener_count(session_id: &str) -> usize {
    taps()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(session_id)
        .map_or(0, Vec::len)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Tests share one process-wide registry, so each uses its own id.
    fn id(name: &str) -> String {
        format!("{name}-{:?}", std::thread::current().id())
    }

    #[test]
    fn a_listener_receives_what_the_pump_flushes() {
        let s = id("basic");
        let rx = subscribe(&s);
        publish(&s, b"hello");
        assert_eq!(rx.try_recv().unwrap(), b"hello".to_vec());
    }

    #[test]
    fn output_is_carried_byte_for_byte() {
        // Terminal output is not text: a chunk boundary can land mid-sequence,
        // and the grid has to see exactly what the shell wrote.
        let s = id("raw");
        let rx = subscribe(&s);
        let raw = vec![0x1b, 0x5b, 0x33, 0x31, 0x6d, 0x00, 0x80, 0xff];
        publish(&s, &raw);
        assert_eq!(rx.try_recv().unwrap(), raw);
    }

    #[test]
    fn a_session_nobody_listens_to_stores_nothing() {
        // The zero-subscriber path is the hot one: it must not allocate an
        // entry just because a chunk went past.
        let s = id("quiet");
        publish(&s, b"lots of build output");
        assert_eq!(listener_count(&s), 0);
    }

    #[test]
    fn every_listener_on_a_session_gets_the_chunk() {
        // Two panes can show one agent — a popout next to the main view.
        let s = id("fanout");
        let a = subscribe(&s);
        let b = subscribe(&s);
        publish(&s, b"both");
        assert_eq!(a.try_recv().unwrap(), b"both".to_vec());
        assert_eq!(b.try_recv().unwrap(), b"both".to_vec());
    }

    #[test]
    fn a_closed_pane_is_forgotten_rather_than_written_to_forever() {
        let s = id("dropped");
        let keep = subscribe(&s);
        drop(subscribe(&s));
        assert_eq!(listener_count(&s), 2);

        publish(&s, b"tick");

        // The live one still gets it; the dead one is gone.
        assert_eq!(keep.try_recv().unwrap(), b"tick".to_vec());
        assert_eq!(listener_count(&s), 1);

        drop(keep);
        publish(&s, b"tock");
        assert_eq!(listener_count(&s), 0);
    }

    #[test]
    fn sessions_do_not_hear_each_other() {
        let mine = id("mine");
        let other = id("other");
        let rx = subscribe(&mine);
        publish(&other, b"not for you");
        assert!(rx.try_recv().is_err());
    }
}
