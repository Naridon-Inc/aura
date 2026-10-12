//! Where a rendered terminal's keystrokes and resizes go.
//!
//! The render loop reads output from a channel and writes input back through
//! this trait. Those are the only two things it does to whatever is on the
//! other end, so naming them is enough to decouple the renderer from *owning*
//! a shell: a pane can drive the PTY it spawned itself, or one that something
//! else already owns — an agent session, say — without the loop knowing which.
//!
//! Both methods swallow their errors. A write fails when the child is already
//! gone, which the loop learns properly from `PtyEvent::Closed` on the output
//! channel; there is nothing useful to do with the error at the keystroke that
//! happened to race the exit, and the call sites discarded it before this
//! trait existed.

/// The input half of a terminal: somewhere to put keystrokes, and something to
/// tell when the viewport changes shape.
pub trait TerminalSink: Send {
    /// Keystrokes / paste bytes, already encoded for the wire.
    fn write(&mut self, bytes: &[u8]);

    /// The viewport is now `cols`x`rows` cells, `px_w`x`px_h` physical pixels.
    fn resize(&mut self, cols: u16, rows: u16, px_w: u16, px_h: u16);
}

/// A terminal that owns the shell it renders — the pane spawned it, so input
/// goes straight back down the same PTY.
impl TerminalSink for aura_term_core::PtySession {
    fn write(&mut self, bytes: &[u8]) {
        let _ = aura_term_core::PtySession::write(self, bytes);
    }

    fn resize(&mut self, cols: u16, rows: u16, px_w: u16, px_h: u16) {
        let _ = aura_term_core::PtySession::resize(self, cols, rows, px_w, px_h);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    /// Records what the loop sent, so a test can drive a sink with no shell.
    #[derive(Default)]
    pub struct Recorder {
        pub writes: Arc<Mutex<Vec<Vec<u8>>>>,
        pub resizes: Arc<Mutex<Vec<(u16, u16, u16, u16)>>>,
    }

    impl TerminalSink for Recorder {
        fn write(&mut self, bytes: &[u8]) {
            self.writes.lock().unwrap().push(bytes.to_vec());
        }

        fn resize(&mut self, cols: u16, rows: u16, px_w: u16, px_h: u16) {
            self.resizes.lock().unwrap().push((cols, rows, px_w, px_h));
        }
    }

    #[test]
    fn a_sink_can_be_driven_without_a_shell_behind_it() {
        // The point of the trait: the render loop's two interactions can be
        // satisfied by something that never spawned a process.
        let rec = Recorder::default();
        let writes = rec.writes.clone();
        let resizes = rec.resizes.clone();

        let mut sink: Box<dyn TerminalSink> = Box::new(rec);
        sink.write(b"ls\n");
        sink.resize(80, 24, 960, 384);

        assert_eq!(writes.lock().unwrap().as_slice(), &[b"ls\n".to_vec()]);
        assert_eq!(resizes.lock().unwrap().as_slice(), &[(80, 24, 960, 384)]);
    }

    #[test]
    fn bytes_reach_the_sink_unaltered() {
        // Keystrokes carry escape sequences and can be non-UTF-8 on paste, so
        // the sink must not be a place where bytes get normalised.
        let rec = Recorder::default();
        let writes = rec.writes.clone();
        let mut sink: Box<dyn TerminalSink> = Box::new(rec);

        let raw = vec![0x1b, 0x5b, 0x41, 0x00, 0x80, 0xff];
        sink.write(&raw);

        assert_eq!(writes.lock().unwrap().as_slice(), &[raw]);
    }
}
