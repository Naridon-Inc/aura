//! Non-blocking keystroke delivery into a PTY master.
//!
//! Writing to a PTY master is a plain blocking `write(2)`. When the
//! program on the other end stops draining its input — a suspended
//! child, an agent CLI wedged mid-render, a shell whose own output is
//! backed up — the kernel input buffer fills and that write blocks
//! *indefinitely*.
//!
//! Both terminal registries used to do that write inline, on the async
//! worker thread Tauri dispatches the command on, while still holding
//! the whole-registry `sessions` mutex. One wedged child therefore:
//!
//!   1. parked the registry lock forever, so **every** terminal in the
//!      app stopped accepting input (not just the wedged one), and
//!   2. burned one async worker thread per keystroke, since each new
//!      `pty_write` queued behind that same lock — after a handful of
//!      keypresses the shared runtime had no free worker left and every
//!      other Tauri command in the app hung too.
//!
//! That is the "terminals stop taking input, and eventually the whole
//! window freezes, and only quitting fixes it" report: nothing in the
//! process ever released the lock, so nothing short of a new process
//! could recover.
//!
//! This module makes the write survivable instead:
//!
//!   * the writer lives behind an `Arc<tokio::sync::Mutex<…>>`, so the
//!     caller clones it and drops the registry lock *before* writing —
//!     one wedged session can never stall a different session;
//!   * lock acquisition is `await`ed, not blocked on, so a queued
//!     keystroke costs a pending future rather than a worker thread,
//!     and normal contention still delivers bytes in typing order;
//!   * the write itself runs on the blocking pool under a deadline. If
//!     it outlives the budget we detach it and report a stall. The
//!     detached write keeps the lock, so later keystrokes fail fast
//!     instead of piling more stuck threads on top of it.
//!
//! When the child finally drains its input the detached write
//! completes, the guard drops, and typing starts working again with no
//! user action — the session heals itself.

use std::io::Write;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::sync::Mutex;

/// A PTY master writer shared between the registry entry and whichever
/// task is currently pushing bytes into it.
pub type SharedPtyWriter = Arc<Mutex<Box<dyn Write + Send>>>;

/// Wrap a freshly-taken `portable_pty` writer for the registry.
pub fn shared_writer(writer: Box<dyn Write + Send>) -> SharedPtyWriter {
    Arc::new(Mutex::new(writer))
}

/// Total wall-clock a single write may spend waiting for its turn plus
/// waiting on the kernel. Generous enough that an ordinary redraw
/// burst never trips it, short enough that a wedged child reports back
/// while the user is still looking at the terminal.
pub const PTY_WRITE_BUDGET: Duration = Duration::from_secs(5);

/// Floor for the write's own slice of the budget. Queueing can eat
/// nearly all of `PTY_WRITE_BUDGET`; handing the write a zero deadline
/// would abandon a write that was about to land, so it always gets a
/// real (if short) chance.
const MIN_WRITE_SLICE: Duration = Duration::from_millis(250);

/// How much of `total` is left after `spent`, floored at
/// [`MIN_WRITE_SLICE`].
fn remaining_budget(total: Duration, spent: Duration) -> Duration {
    let left = total.saturating_sub(spent);
    if left < MIN_WRITE_SLICE {
        MIN_WRITE_SLICE
    } else {
        left
    }
}

/// Why a keystroke didn't reach the program in the terminal.
#[derive(Debug)]
pub enum PtyWriteError {
    /// The program isn't reading its input right now. Transient by
    /// nature — the same session usually accepts input again once it
    /// catches up, so this is a "try again", not a "session is dead".
    Stalled,
    /// The pipe itself failed (child gone, fd closed). Terminal.
    Io(String),
}

impl std::fmt::Display for PtyWriteError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            // Both strings surface straight to the user, so they say
            // what happened and what to expect — no fds, no pipes.
            Self::Stalled => write!(
                f,
                "The program running here is busy and didn't take that yet. It should catch up on its own."
            ),
            Self::Io(e) => write!(f, "This terminal's session has ended. Open a new one to keep going. ({e})"),
        }
    }
}

/// Run `f` against the PTY writer without blocking the async runtime.
///
/// `f` gets the raw writer so callers can keep their own framing (the
/// agent path chunks a bracketed paste); this module only owns the
/// locking, the deadline and the flush.
pub async fn write_with<F>(writer: &SharedPtyWriter, f: F) -> Result<(), PtyWriteError>
where
    F: FnOnce(&mut (dyn Write + Send)) -> std::io::Result<()> + Send + 'static,
{
    let started = Instant::now();
    // Awaiting the lock keeps ordering (tokio's mutex is FIFO) without
    // parking a worker thread, so a busy session queues keystrokes
    // instead of dropping them.
    let guard = match tokio::time::timeout(PTY_WRITE_BUDGET, writer.clone().lock_owned()).await {
        Ok(g) => g,
        // Someone ahead of us is still stuck in the kernel. Fail fast
        // rather than adding to the pile.
        Err(_) => return Err(PtyWriteError::Stalled),
    };
    let slice = remaining_budget(PTY_WRITE_BUDGET, started.elapsed());
    // The blocking pool is the right home for a call that can park in
    // the kernel; the async workers stay free for the rest of the app.
    let join = tokio::task::spawn_blocking(move || {
        // The guard rides into the closure so it is released exactly
        // when the write finishes — including when we've already given
        // up on it and detached this task.
        let mut guard = guard;
        let w: &mut (dyn Write + Send) = &mut **guard;
        f(w)?;
        w.flush()
    });
    match tokio::time::timeout(slice, join).await {
        Ok(Ok(Ok(()))) => Ok(()),
        Ok(Ok(Err(e))) => Err(PtyWriteError::Io(e.to_string())),
        // The blocking task panicked — treat it like a broken pipe so
        // the session is reported as ended rather than silently idle.
        Ok(Err(e)) => Err(PtyWriteError::Io(e.to_string())),
        // Deadline hit. Dropping the JoinHandle detaches the write; it
        // still holds the lock, which is what makes every subsequent
        // keystroke fail fast until the child drains.
        Err(_) => Err(PtyWriteError::Stalled),
    }
}

/// Push raw bytes into the PTY. The keystroke path.
pub async fn write_bytes(writer: &SharedPtyWriter, bytes: Vec<u8>) -> Result<(), PtyWriteError> {
    write_with(writer, move |w| w.write_all(&bytes)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    /// A writer that parks until the test releases it, standing in for
    /// a child that has stopped reading its input. Dropping the paired
    /// sender is "the child started reading again".
    struct WedgedWriter {
        entered: Arc<AtomicBool>,
        release: std::sync::mpsc::Receiver<()>,
    }

    impl Write for WedgedWriter {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.entered.store(true, Ordering::SeqCst);
            // Returns immediately once the sender is dropped; the
            // timeout is only a backstop so a broken test can't wedge
            // the suite the way the bug wedged the app.
            let _ = self.release.recv_timeout(Duration::from_secs(30));
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    /// Build a writer that's stuck until the returned sender is dropped.
    fn wedged() -> (SharedPtyWriter, std::sync::mpsc::Sender<()>, Arc<AtomicBool>) {
        let (tx, rx) = std::sync::mpsc::channel();
        let entered = Arc::new(AtomicBool::new(false));
        let writer = shared_writer(Box::new(WedgedWriter {
            entered: entered.clone(),
            release: rx,
        }));
        (writer, tx, entered)
    }

    struct CountingWriter {
        sink: Arc<Mutex<Vec<u8>>>,
    }

    impl Write for CountingWriter {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.sink.blocking_lock().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    struct BrokenWriter;

    impl Write for BrokenWriter {
        fn write(&mut self, _buf: &[u8]) -> std::io::Result<usize> {
            Err(std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                "child gone",
            ))
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn remaining_budget_subtracts_time_already_spent() {
        let left = remaining_budget(Duration::from_secs(5), Duration::from_secs(2));
        assert_eq!(left, Duration::from_secs(3));
    }

    #[test]
    fn remaining_budget_never_drops_below_the_floor() {
        // Queueing ate the whole budget — the write still gets a real
        // chance instead of a zero-length deadline.
        let left = remaining_budget(Duration::from_secs(5), Duration::from_secs(9));
        assert_eq!(left, MIN_WRITE_SLICE);
        let exact = remaining_budget(Duration::from_secs(5), Duration::from_secs(5));
        assert_eq!(exact, MIN_WRITE_SLICE);
    }

    #[tokio::test]
    async fn healthy_writer_takes_the_bytes() {
        let sink = Arc::new(Mutex::new(Vec::new()));
        let writer = shared_writer(Box::new(CountingWriter { sink: sink.clone() }));
        write_bytes(&writer, b"ls\n".to_vec()).await.expect("write");
        assert_eq!(sink.lock().await.as_slice(), b"ls\n");
    }

    #[tokio::test]
    async fn broken_pipe_reports_the_session_ended() {
        let writer = shared_writer(Box::new(BrokenWriter));
        let err = write_bytes(&writer, b"x".to_vec()).await.unwrap_err();
        assert!(matches!(err, PtyWriteError::Io(_)));
        assert!(err.to_string().contains("session has ended"));
    }

    /// The regression this module exists for: a child that stops
    /// reading must NOT hold the caller. The write reports a stall
    /// inside the budget and the async task returns — and once the
    /// child starts reading again, typing works with no restart.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn wedged_child_stalls_then_heals_itself() {
        let (writer, release, entered) = wedged();

        let started = Instant::now();
        let first = write_bytes(&writer, b"a".to_vec()).await;
        assert!(matches!(first, Err(PtyWriteError::Stalled)));
        assert!(entered.load(Ordering::SeqCst), "write should have started");
        // Bounded: it returned rather than hanging forever.
        assert!(started.elapsed() < PTY_WRITE_BUDGET * 3);

        // The detached write still owns the lock, so the next keystroke
        // fails fast instead of stacking another stuck blocking thread.
        let second_started = Instant::now();
        let second = write_bytes(&writer, b"b".to_vec()).await;
        assert!(matches!(second, Err(PtyWriteError::Stalled)));
        assert!(second_started.elapsed() < PTY_WRITE_BUDGET * 3);

        // The child starts reading again. Nothing restarts, nothing is
        // re-opened — the very next keystroke lands.
        drop(release);
        write_bytes(&writer, b"c".to_vec())
            .await
            .expect("session should accept input again once the child drains");
    }

    /// A stalled session must not affect a different session's writer —
    /// this is what stops one bad terminal freezing all of them.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn one_stalled_session_does_not_block_another() {
        let (stuck, release, _) = wedged();
        let sink = Arc::new(Mutex::new(Vec::new()));
        let healthy = shared_writer(Box::new(CountingWriter { sink: sink.clone() }));

        let stalling = tokio::spawn(async move { write_bytes(&stuck, b"a".to_vec()).await });
        // The healthy session keeps working while the other is stuck.
        write_bytes(&healthy, b"echo hi\n".to_vec())
            .await
            .expect("healthy write");
        assert_eq!(sink.lock().await.as_slice(), b"echo hi\n");

        assert!(matches!(
            stalling.await.expect("join"),
            Err(PtyWriteError::Stalled)
        ));
        drop(release);
    }
}
