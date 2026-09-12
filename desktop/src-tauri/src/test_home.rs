//! A borrowed `HOME` for tests, and the lock that makes borrowing it safe.
//!
//! Several subsystems here locate their storage off `$HOME` — the manager's
//! session store, the project registry, the agent-handoff transcripts. Tests
//! for those point `HOME` at a tempdir so they touch nothing real. But `HOME`
//! is process-global and cargo runs tests in parallel threads, so two of those
//! tests overlapping used to interleave: one would repoint `HOME` while another
//! was mid-write, and — worse — every one of them left `HOME` pointing at a
//! tempdir that was deleted the moment the test returned. Any later test that
//! merely *read* `HOME` then saw a directory that no longer existed, and failed
//! for reasons that had nothing to do with what it was testing. That is the
//! shape of a flake that never reproduces on its own.
//!
//! `borrow()` closes both holes: it serialises every `HOME` mutation in the
//! process, and it restores the previous value on drop while keeping the
//! tempdir alive for exactly as long as the borrow lasts.
//!
//! ```ignore
//! let home = test_home::borrow();
//! save(&session).unwrap();          // writes under home.path()
//! ```

use std::ffi::OsString;
use std::path::Path;
use std::sync::{Mutex, MutexGuard, OnceLock};

fn home_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

/// Exclusive use of the process's `HOME` for the lifetime of the value.
pub struct TestHome {
    dir: tempfile::TempDir,
    previous: Option<OsString>,
    // Held so no other borrow can run concurrently. Declared last so it is
    // released only after `HOME` has been put back.
    _guard: MutexGuard<'static, ()>,
}

impl TestHome {
    /// The directory `HOME` currently points at.
    pub fn path(&self) -> &Path {
        self.dir.path()
    }

    /// The `HOME` this borrow displaced, and will restore on drop. Sampled
    /// under the lock, so it is the only baseline a test can trust — reading
    /// the environment before borrowing races with whoever holds it now.
    pub fn previous(&self) -> Option<&OsString> {
        self.previous.as_ref()
    }
}

impl Drop for TestHome {
    fn drop(&mut self) {
        // Restore before the tempdir is removed, so `HOME` never spends even an
        // instant naming a directory that has already been deleted.
        match self.previous.take() {
            Some(prev) => unsafe { std::env::set_var("HOME", prev) },
            None => unsafe { std::env::remove_var("HOME") },
        }
    }
}

/// Point `HOME` at a fresh tempdir until the returned value is dropped.
///
/// Blocks while another test holds the borrow, so callers can assume they are
/// the only writer. Panics if the lock was poisoned by a panicking test — that
/// is a real failure to surface, not one to paper over.
pub fn borrow() -> TestHome {
    let guard = home_lock().lock().unwrap_or_else(|e| e.into_inner());
    let dir = tempfile::tempdir().expect("tempdir for HOME");
    let previous = std::env::var_os("HOME");
    unsafe { std::env::set_var("HOME", dir.path()) };
    TestHome {
        dir,
        previous,
        _guard: guard,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn home_points_at_the_borrowed_dir_and_is_restored_after() {
        let (borrowed, before) = {
            let home = borrow();
            assert_eq!(
                std::env::var_os("HOME").map(std::path::PathBuf::from),
                Some(home.path().to_path_buf())
            );
            // The baseline has to come from the borrow, not from the
            // environment before it: another test may hold `HOME` right up to
            // the moment we take the lock.
            (home.path().to_path_buf(), home.previous().cloned())
        };
        assert_eq!(std::env::var_os("HOME"), before, "HOME must be put back");
        assert!(
            !borrowed.exists(),
            "the borrowed dir is cleaned up, which is exactly why HOME had to be restored first"
        );
    }
}
