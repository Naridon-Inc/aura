//! What a session said while nobody was watching.
//!
//! A tmux session on a machine keeps running when the laptop closes — that is
//! the whole reason the work lives in tmux rather than in the connection. But
//! until now nothing could read it back except a live pty attach, so a person
//! returning to a tab saw a terminal *from the moment they sat down* and
//! nothing of the hour before it. The agent finished, or failed, or asked a
//! question, and the only evidence was whatever was still on screen.
//!
//! tmux holds the scrollback, and `capture-pane` hands it back as plain text.
//! This asks for it through `Place`, so the answer is the same for a machine
//! you brought and one Aura made, and for this laptop — a session here is held
//! in the same tmux and answers the same question.
//!
//! What comes back is text, not a terminal: joined lines (`-J`), no escape
//! codes, capped at a number of lines the far side enforces so a runaway build
//! log costs one screenful of transfer rather than the whole log.

use serde::Serialize;

use crate::cloudbox::script::{is_session_name, quote};

use super::place::Place;

/// How far back to read when the caller didn't say.
pub const DEFAULT_LINES: u32 = 2000;

/// The most anyone can ask for in one read. Enforced here rather than trusted
/// to the frontend: the box does the work of producing it and the wire the
/// work of carrying it.
pub const MAX_LINES: u32 = 20_000;

/// How long a capture may take. It is one tmux command against memory, so a
/// box that takes longer than this is not answering.
const CAPTURE_WAIT: std::time::Duration = std::time::Duration::from_secs(20);

/// A session's scrollback, as of the moment it was read.
#[derive(Debug, Clone, Serialize)]
pub struct Capture {
    /// The pane's text, oldest line first. May be empty: a session that has
    /// printed nothing yet is a real answer.
    pub text: String,
    /// When this was read, as unix seconds on this laptop — the stamp a
    /// "seen up to here" marker is set against.
    pub captured_at: u64,
}

/// The tmux command that reads the last `lines` of a session's scrollback.
///
/// `-p` prints to stdout, `-J` joins lines tmux wrapped at the pane's width
/// back into the lines the program wrote, and `-S -N` starts N lines above the
/// visible screen. `-t` names the session; its first window's active pane is
/// where a session started by `Place::start` runs. The `|| true` is not
/// applied — a session that isn't there should come back as an error with
/// tmux's own words, not as an empty transcript.
pub fn capture_line(session: &str, lines: u32) -> String {
    format!(
        "tmux capture-pane -p -J -S -{} -t {}",
        clamp_lines(lines),
        quote(session)
    )
}

/// Between one line and [`MAX_LINES`].
pub fn clamp_lines(lines: u32) -> u32 {
    lines.clamp(1, MAX_LINES)
}

impl Place {
    /// Read what a session here has printed, up to `lines` back.
    pub async fn capture(&self, session: &str, lines: Option<u32>) -> Result<Capture, String> {
        if !is_session_name(session) {
            return Err(format!("{session} isn't a session on that machine."));
        }
        let lines = clamp_lines(lines.unwrap_or(DEFAULT_LINES));
        let out = self.sh(&capture_line(session, lines), CAPTURE_WAIT).await?;
        if !out.ok() {
            return Err(session_gone(self.label(), session, &out.stderr));
        }
        Ok(Capture {
            text: out.stdout,
            captured_at: unix_now(),
        })
    }
}

/// A capture that failed, in words about the session rather than about tmux.
///
/// tmux's "can't find session" and "no server running" both mean the same
/// thing to the person reading: whatever they came back for has ended. Any
/// other failure is passed on in tmux's own words, which say what to do next.
fn session_gone(label: &str, session: &str, stderr: &str) -> String {
    let said = stderr
        .lines()
        .rev()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("")
        .trim();
    let low = said.to_ascii_lowercase();
    if low.contains("can't find") || low.contains("no server running") || low.contains("no such") {
        format!("{session} isn't running on {label} any more.")
    } else if said.is_empty() {
        format!("{label} couldn't read {session}.")
    } else {
        format!("{label} couldn't read {session}: {said}")
    }
}

fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// What a session on a machine printed while nobody was attached.
///
/// Names a machine, asks `Place`, and touches nothing that reaches a box
/// itself — so the same transcript comes back for a managed VM the day there
/// is one. `lines` is how far back to read; unset means [`DEFAULT_LINES`], and
/// more than [`MAX_LINES`] is read as [`MAX_LINES`].
#[tauri::command]
pub async fn place_session_capture(
    machine_id: String,
    session: String,
    lines: Option<u32>,
) -> Result<Capture, String> {
    Place::at_machine(&machine_id)?.capture(&session, lines).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_capture_reads_joined_lines_from_the_named_session() {
        let line = capture_line("aura-agent-proj-1a2b", 500);
        assert_eq!(
            line,
            "tmux capture-pane -p -J -S -500 -t 'aura-agent-proj-1a2b'"
        );
    }

    #[test]
    fn how_far_back_is_capped_on_this_side() {
        assert_eq!(clamp_lines(0), 1);
        assert_eq!(clamp_lines(2000), 2000);
        assert_eq!(clamp_lines(u32::MAX), MAX_LINES);
        assert!(capture_line("s", 1_000_000).contains(&format!("-S -{MAX_LINES} ")));
    }

    #[tokio::test]
    async fn a_session_name_that_is_not_one_is_refused_before_anything_runs() {
        // The name goes into a command line; a name is all it may ever be.
        let here = Place::Here { root: "/tmp".into() };
        let e = here
            .capture("x; tmux kill-server", None)
            .await
            .unwrap_err();
        assert!(e.contains("isn't a session"), "{e}");
    }

    #[test]
    fn a_session_that_ended_is_said_as_ended_not_as_a_tmux_error() {
        let e = session_gone("build-box", "aura-agent-p-1", "can't find session: aura-agent-p-1\n");
        assert_eq!(e, "aura-agent-p-1 isn't running on build-box any more.");
        let e = session_gone("this laptop", "s", "no server running on /tmp/tmux-501/default\n");
        assert!(e.ends_with("any more."), "{e}");
        // Anything else is tmux's own sentence, which says what to do next.
        let e = session_gone("build-box", "s", "tmux: command not found\n");
        assert!(e.contains("command not found"), "{e}");
    }

    #[tokio::test]
    async fn a_session_this_laptop_does_not_hold_is_an_error_not_an_empty_transcript() {
        // Whatever the state of tmux on the machine running this test, no
        // session by this name exists on it — and "nothing printed" would be a
        // lie about a session that isn't there.
        let here = Place::Here { root: "/tmp".into() };
        let e = here
            .capture("aura-test-never-started-000", Some(10))
            .await
            .unwrap_err();
        assert!(!e.is_empty());
    }
}
