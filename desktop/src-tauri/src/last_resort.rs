//! Where a record goes when the disk will not take one.
//!
//! `crash.rs` and `watchdog.rs` both explain themselves by writing a file
//! under `~/.aura/aura-shell-crashes`. When the volume is full every one of
//! those writes fails, and the failure was reported with `eprintln!` — which,
//! for a bundle launched from Finder, is `/dev/null`. So the evidence vanishes
//! at exactly the moment it is worth most: on 2026-09-22 this machine's disk
//! hit 100%, the app stalled and was quit repeatedly, and afterwards there was
//! nothing at all on disk to read — no report, no bundle, not even a line
//! saying a report had been attempted.
//!
//! The system log is the one sink that still works then. It needs no free
//! space from us, it outlives the relaunch, and `log show` reads it back days
//! later:
//!
//! ```text
//! log show --last 6h --predicate 'eventMessage CONTAINS "aura-shell could not write"'
//! ```
//!
//! `logger(1)` is the dependency-free way in, and shelling out to a system
//! tool on a recovery path is already the house style here — `watchdog_sample`
//! reaches for `/usr/bin/sample` the same way.

use std::io;
#[cfg(unix)]
use std::process::{Command, Stdio};
#[cfg(unix)]
use std::time::{Duration, Instant};

/// How long `logger` gets before we stop waiting on it. It writes one line
/// and exits, so this is a deadlock guard rather than a budget: every caller
/// here is already mid-failure, and one of them is a wedged app that must
/// reach its relaunch.
#[cfg(unix)]
const LOGGER_GRACE: Duration = Duration::from_secs(2);

/// How much of `detail` survives into the one-line record. Long enough for a
/// watchdog verdict, short enough to stay readable in `log show` output.
const DETAIL_CHARS: usize = 400;

/// Say — somewhere that survives a full disk — that a record we owed the user
/// could not be written.
///
/// `kind` names what was lost ("the stall bundle"), and `detail` carries
/// whatever of its contents fits on one line, so a reader who has nothing but
/// the system log still learns what the lost file would have said.
pub fn note(kind: &str, err: &io::Error, detail: &str) {
    let line = compose(kind, err, detail);
    // A dev run has a terminal attached, and this is the shortest path to it.
    eprintln!("[last_resort] {line}");
    to_system_log(&line);
}

/// The whole record, as one line. Pure so the wording is testable without
/// spawning anything.
fn compose(kind: &str, err: &io::Error, detail: &str) -> String {
    let reason = describe(err);
    let detail = one_line(detail);
    if detail.is_empty() {
        format!("aura-shell could not write {kind}: {reason}")
    } else {
        format!("aura-shell could not write {kind}: {reason} — {detail}")
    }
}

/// Plain words for the failures worth telling apart. `ENOSPC` is the one that
/// prompted this module: "No space left on device" is accurate and still
/// leaves the reader guessing whether the app or the machine is at fault.
fn describe(err: &io::Error) -> String {
    if let Some(known) = errno_reason(err) {
        return known.to_string();
    }
    match err.kind() {
        io::ErrorKind::PermissionDenied => "permission denied".to_string(),
        io::ErrorKind::NotFound => "the directory is gone".to_string(),
        _ => err.to_string(),
    }
}

#[cfg(unix)]
fn errno_reason(err: &io::Error) -> Option<&'static str> {
    match err.raw_os_error() {
        Some(libc::ENOSPC) => Some("the disk is full"),
        Some(libc::EDQUOT) => Some("the disk quota is exhausted"),
        Some(libc::EROFS) => Some("the volume is read-only"),
        _ => None,
    }
}

#[cfg(not(unix))]
fn errno_reason(_err: &io::Error) -> Option<&'static str> {
    None
}

/// Collapse a multi-line detail (the watchdog's verdict is three lines) into
/// something one log record can hold, cutting on a character boundary so a
/// truncated multi-byte character cannot panic this path.
fn one_line(detail: &str) -> String {
    let flat = detail.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= DETAIL_CHARS {
        return flat;
    }
    let mut out: String = flat.chars().take(DETAIL_CHARS).collect();
    out.push('…');
    out
}

/// Hand the line to the system log, and do not wait forever for it.
#[cfg(unix)]
fn to_system_log(line: &str) {
    let spawned = Command::new("/usr/bin/logger")
        .args(["-p", "user.error", "-t", "aura-shell", line])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
    // No logger on this box is not worth a second failure report — the
    // eprintln above already ran.
    let Ok(mut child) = spawned else { return };
    let deadline = Instant::now() + LOGGER_GRACE;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return,
            Err(_) => return,
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
        }
    }
}

#[cfg(not(unix))]
fn to_system_log(_line: &str) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn a_full_disk_is_named_as_one() {
        let err = io::Error::from_raw_os_error(libc::ENOSPC);
        assert_eq!(describe(&err), "the disk is full");
    }

    #[test]
    fn an_unrecognised_failure_keeps_the_original_wording() {
        let err = io::Error::other("socket hung up");
        assert_eq!(describe(&err), "socket hung up");
    }

    #[cfg(unix)]
    #[test]
    fn the_record_names_what_was_lost_and_why() {
        let err = io::Error::from_raw_os_error(libc::ENOSPC);
        let line = compose("the stall bundle", &err, "main thread silent 68s");
        assert_eq!(
            line,
            "aura-shell could not write the stall bundle: the disk is full — main thread silent 68s"
        );
    }

    #[test]
    fn a_detail_free_record_does_not_trail_a_dash() {
        let err = io::Error::other("nope");
        assert_eq!(
            compose("the crash report", &err, ""),
            "aura-shell could not write the crash report: nope"
        );
    }

    #[test]
    fn a_multi_line_verdict_becomes_one_line() {
        let flat = one_line("UI froze:\n  the main thread stopped\n\nanswering 68s ago.");
        assert_eq!(flat, "UI froze: the main thread stopped answering 68s ago.");
    }

    #[test]
    fn an_overlong_detail_is_cut_on_a_character_boundary() {
        let long = "é".repeat(DETAIL_CHARS + 50);
        let cut = one_line(&long);
        assert_eq!(cut.chars().count(), DETAIL_CHARS + 1);
        assert!(cut.ends_with('…'));
    }
}
