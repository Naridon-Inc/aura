//! handback — telling a conversation what came back from the machine.
//!
//! `handoff` is half of a handover: this conversation, packed up and sent to a
//! box that isn't this laptop. The other half is the return. Without it the
//! conversation you handed over goes quiet at exactly the moment it matters —
//! the work finishes, or fails one `/login` away from finishing, and the chat
//! that placed it says nothing. You find out by remembering to go and look.
//!
//! So the app looks instead. `aura_cloud_send` stamps the chat's session id
//! onto the board row as its `context_id`; this watcher reads the board back,
//! finds rows that have settled, and puts a note in the conversation that
//! placed them. The note says which branch and commit the work landed on —
//! and, on a failure, the runner's own words, which are usually the fix.
//!
//! Two rules keep it from becoming noise:
//!
//! * **Only what a conversation placed.** A row with no `context_id` was minted
//!   by the composer, the CLI or another machine. There is no conversation to
//!   hand it back to, so it is left alone rather than announced somewhere
//!   arbitrary.
//! * **Only what is recent.** The board keeps history. Announcing every
//!   terminal row on the first tick would replay months of finished work into
//!   old conversations the moment the app opens. A job that settled within
//!   [`RECENT`] is news; anything older has already been seen or has already
//!   stopped mattering.
//!
//! Saying it twice is prevented by the note itself: it carries the job id, and
//! `push_app_note_once` refuses to add a note whose marker is already in the
//! transcript. There is no side file of "already announced" ids to drift out of
//! step with the conversations it describes.

use std::time::Duration;

use chrono::{DateTime, Utc};
use serde_json::Value;
use tauri::AppHandle;

/// How often the board is asked. Slower than the UI's own 20s poll on purpose:
/// this runs for the whole life of the app whether or not anyone is looking at
/// a cloud surface, and a note arriving half a minute late costs nothing.
const POLL: Duration = Duration::from_secs(30);

/// A pause before the first ask, so a cold launch isn't racing the credential
/// read that every cloud call depends on.
const WARMUP: Duration = Duration::from_secs(25);

/// How much of the board to read. The window that matters is the last day; a
/// page this size covers it many times over for any real account.
const PAGE: u32 = 100;

/// How long after a job settles it is still worth telling someone about.
///
/// This is the whole guard against replaying history. It also decides what
/// happens to work that finished while the app was closed: inside the window it
/// is still announced when you next open the app — which is the right answer to
/// "what happened while I was away" — and outside it, it stays where it is.
const RECENT: chrono::Duration = chrono::Duration::hours(24);

/// A finished job and the conversation waiting to hear about it.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Handback {
    session_id: String,
    /// Doubles as the note's dedupe marker, so it must appear in `text`.
    job_id: String,
    text: String,
}

/// Start watching the board for work that has come back.
///
/// Runs for the life of the app. Every failure mode — signed out, offline, a
/// row that makes no sense — resolves to "nothing to say this tick", because a
/// watcher that cannot reach the board must be silent rather than wrong.
pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(WARMUP).await;
        loop {
            tick(&app).await;
            tokio::time::sleep(POLL).await;
        }
    });
}

async fn tick(app: &AppHandle) {
    let rows = crate::cmd_cloud_jobs::board_rows(PAGE).await;
    if rows.is_empty() {
        return;
    }
    for hb in handbacks(&rows, Utc::now()) {
        // Writing a turn touches the session file and takes the runtime's
        // session lock; neither belongs on the async runtime's thread.
        let app = app.clone();
        crate::blocking::run(move || {
            crate::cmd_brain_chat::push_app_note_once(
                &app,
                &hb.session_id,
                &hb.job_id,
                hb.text.clone(),
            )
        })
        .await;
    }
}

/// Every note owed to a conversation, given what the board currently says.
///
/// Pure, so the rules above are testable without a server: a row is only
/// carried when it names a conversation, has actually settled, and settled
/// recently enough to still be news.
fn handbacks(rows: &[Value], now: DateTime<Utc>) -> Vec<Handback> {
    rows.iter()
        .filter_map(|row| {
            let session_id = field(row, "context_id")?;
            let job_id = field(row, "id")?;
            let status = field(row, "status")?;
            if !is_terminal(&status) || !settled_recently(row, now) {
                return None;
            }
            Some(Handback {
                text: note(row, &status, &job_id),
                session_id,
                job_id,
            })
        })
        .collect()
}

/// Statuses that mean the machine is done with it, one way or another.
///
/// Spelled out rather than written as "not in flight" so a status nobody has
/// seen before — a new server state, a typo, an empty string — is treated as
/// still running and stays quiet, instead of being announced as an outcome the
/// note would then have to invent.
fn is_terminal(status: &str) -> bool {
    matches!(
        status,
        "completed"
            | "failed"
            | "canceled"
            | "cancelled"
            | "rejected"
            | "auth-required"
            | "auth_required"
    )
}

/// Did this settle recently enough to be worth saying out loud?
///
/// `updated_at` is the moment the runner PATCHed the outcome back, which is the
/// real settling time. `created_at` stands in when it is missing — for a row
/// that has already settled, when it was placed is a lower bound on when it
/// finished, so an old job stays old either way. A row with neither timestamp
/// cannot be dated and is left alone.
fn settled_recently(row: &Value, now: DateTime<Utc>) -> bool {
    let stamp = field(row, "updated_at")
        .or_else(|| field(row, "created_at"))
        .and_then(|s| DateTime::parse_from_rfc3339(&s).ok());
    match stamp {
        Some(t) => now.signed_duration_since(t.with_timezone(&Utc)) <= RECENT,
        None => false,
    }
}

/// What the conversation is told, in the words someone reading their own chat
/// would want: what happened, where it went, and — when it went wrong — the
/// reason, which is the only part they can act on.
fn note(row: &Value, status: &str, job_id: &str) -> String {
    let machine = field(row, "agent_kind")
        .map(|k| k.trim_start_matches("a2a:").to_string())
        .filter(|k| !k.is_empty())
        .map(|k| format!("The {k} on your machine"))
        .unwrap_or_else(|| "Your machine".to_string());
    let what = brief(row)
        .map(|b| format!(" — “{b}” —"))
        .unwrap_or_default();

    let body = match status {
        "completed" => {
            let mut s = format!("{machine} finished the work this conversation sent over{what}.");
            match (field(row, "branch"), field(row, "commit_sha")) {
                (Some(branch), Some(sha)) => s.push_str(&format!(
                    " It landed on branch `{branch}`, at commit `{}`. It is not on this \
                     computer yet — a cloud sync brings it down.",
                    short(&sha)
                )),
                (Some(branch), None) => s.push_str(&format!(
                    " It was working on branch `{branch}` but reported no commit, so there \
                     may be nothing to bring down."
                )),
                // Work sent from a conversation with no local copy has no branch
                // to name. Saying so is better than implying a commit exists.
                (None, Some(sha)) => {
                    s.push_str(&format!(" It landed at commit `{}`.", short(&sha)))
                }
                (None, None) => {
                    s.push_str(" It reported no branch and no commit for the work.")
                }
            }
            s
        }
        "auth-required" | "auth_required" => format!(
            "{machine} stopped on the work this conversation sent over{what}: the agent \
             there is not signed in, so it could not start.{}",
            reason(row)
        ),
        "rejected" => format!(
            "{machine} would not take the work this conversation sent over{what}.{}",
            reason(row)
        ),
        "canceled" | "cancelled" => format!(
            "The work this conversation sent to your machine{what} was canceled before it \
             finished."
        ),
        _ => format!(
            "{machine} could not finish the work this conversation sent over{what}.{}",
            reason(row)
        ),
    };
    format!("{body}\n\n(cloud job {job_id})")
}

/// The runner's own explanation, when it left one. A failure with no reason is
/// said plainly rather than dressed up — knowing the machine stayed silent is
/// itself worth knowing.
fn reason(row: &Value) -> String {
    match field(row, "error_message") {
        Some(e) => format!(" It said: {}", clip(&e, 400)),
        None => " It did not say why.".to_string(),
    }
}

/// A short name for the work, for a note that has to say *which* job.
///
/// Returns nothing when the conversation itself was handed over: that brief
/// opens with the transcript digest, so its first line is the digest's heading
/// and names nothing at all. The note reads perfectly well without it — "the
/// work this conversation sent over" is unambiguous when the conversation *is*
/// what was sent.
fn brief(row: &Value) -> Option<String> {
    if carried_a_conversation(row) {
        return None;
    }
    let text = field(row, "input_text")?;
    let line = text.lines().find(|l| !l.trim().is_empty())?.trim();
    Some(clip(line, 90))
}

/// Did this job carry the conversation with it? Stamped by `aura_cloud_send`
/// at mint time. The column is json; some drivers hand it back as a string
/// holding json, so both are read.
fn carried_a_conversation(row: &Value) -> bool {
    let meta = row.get("input_metadata");
    let owned;
    let meta = match meta {
        Some(Value::String(s)) => {
            owned = serde_json::from_str::<Value>(s).unwrap_or(Value::Null);
            &owned
        }
        Some(v) => v,
        None => return false,
    };
    meta.get("handoff").and_then(|v| v.as_str()) == Some("conversation")
}

/// Read a non-empty string field off a board row.
fn field(row: &Value, key: &str) -> Option<String> {
    row.get(key)
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// The first seven of a commit sha — what a person recognises and can paste.
fn short(sha: &str) -> String {
    sha.chars().take(7).collect()
}

/// Clip on a character boundary so a multi-byte name can't split mid-glyph.
fn clip(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let head: String = s.chars().take(max).collect();
    format!("{head}…")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn now() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-08-03T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc)
    }

    fn row(status: &str, extra: Value) -> Value {
        let mut base = json!({
            "id": "14a68896-1426-4ee8-a237-bb6ced03c75f",
            "context_id": "sid-7",
            "status": status,
            "agent_kind": "a2a:claude",
            "input_text": "Add the retry backoff",
            "updated_at": "2026-08-03T11:40:00Z",
        });
        for (k, v) in extra.as_object().expect("an object of overrides") {
            base[k] = v.clone();
        }
        base
    }

    #[test]
    fn a_finished_job_reaches_the_conversation_that_placed_it() {
        let rows = vec![row(
            "completed",
            json!({"branch": "feat/backoff", "commit_sha": "abc1234def5678"}),
        )];
        let out = handbacks(&rows, now());
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].session_id, "sid-7");
        assert!(out[0].text.contains("finished"));
        assert!(out[0].text.contains("feat/backoff"));
        assert!(out[0].text.contains("abc1234"), "the sha, shortened");
        assert!(
            !out[0].text.contains("abc1234def5678"),
            "and not the whole thing"
        );
    }

    /// The dedupe in `push_app_note_once` keys on the job id, so a note that
    /// doesn't carry its own id can never be recognised as already said — and
    /// would be re-posted on every single poll.
    #[test]
    fn every_note_carries_the_id_it_will_be_recognised_by() {
        for status in ["completed", "failed", "canceled", "rejected", "auth-required"] {
            let hb = handbacks(&[row(status, json!({}))], now());
            assert_eq!(hb.len(), 1, "{status} settles");
            assert!(
                hb[0].text.contains(&hb[0].job_id),
                "{status} note must contain its marker"
            );
        }
    }

    /// The reason is the whole value of a failure note — it is usually one
    /// `/login` away from being the fix.
    #[test]
    fn a_failure_hands_back_the_machines_own_words() {
        let rows = vec![row(
            "failed",
            json!({"error_message": "agent 'claude' exited 1: Not logged in · Please run /login"}),
        )];
        let out = handbacks(&rows, now());
        assert!(out[0].text.contains("could not finish"));
        assert!(out[0].text.contains("Please run /login"));
    }

    #[test]
    fn a_failure_with_no_reason_says_so_rather_than_inventing_one() {
        let out = handbacks(&[row("failed", json!({}))], now());
        assert!(out[0].text.contains("did not say why"));
    }

    /// Work that hasn't settled must stay quiet — a note is a full stop, and
    /// posting one mid-run tells the user the job is over when it is running.
    #[test]
    fn work_still_running_is_not_announced() {
        for live in ["submitted", "working", "claimed", "running"] {
            assert!(
                handbacks(&[row(live, json!({}))], now()).is_empty(),
                "{live} is not an outcome"
            );
        }
    }

    /// A status the shell has never seen is not an outcome it can describe. It
    /// must read as "still going" rather than be announced with a made-up
    /// summary.
    #[test]
    fn an_unrecognised_status_is_treated_as_unfinished() {
        assert!(handbacks(&[row("quarantined", json!({}))], now()).is_empty());
        assert!(handbacks(&[row("", json!({}))], now()).is_empty());
    }

    /// The board is a permanent record. Without this, opening the app would
    /// dump every job it has ever run into the conversations that placed them.
    #[test]
    fn history_is_not_replayed_into_old_conversations() {
        let old = row("completed", json!({"updated_at": "2026-07-01T09:00:00Z"}));
        assert!(handbacks(&[old], now()).is_empty());
        let yesterday = row("completed", json!({"updated_at": "2026-08-02T13:00:00Z"}));
        assert_eq!(
            handbacks(&[yesterday], now()).len(),
            1,
            "work that settled while the app was closed is still news"
        );
    }

    /// Falls back to when it was placed. For a row that has already settled,
    /// that is a lower bound on when it finished, so an ancient job stays
    /// ancient rather than sneaking in on a missing field.
    #[test]
    fn a_row_with_no_settle_time_is_dated_by_when_it_was_placed() {
        let mut r = row("completed", json!({"created_at": "2026-08-03T11:00:00Z"}));
        r.as_object_mut().unwrap().remove("updated_at");
        assert_eq!(handbacks(&[r], now()).len(), 1);

        let mut ancient = row("completed", json!({"created_at": "2025-01-01T00:00:00Z"}));
        ancient.as_object_mut().unwrap().remove("updated_at");
        assert!(handbacks(&[ancient], now()).is_empty());
    }

    #[test]
    fn a_row_that_cannot_be_dated_is_left_alone() {
        let mut r = row("completed", json!({}));
        let obj = r.as_object_mut().unwrap();
        obj.remove("updated_at");
        obj.remove("created_at");
        assert!(handbacks(&[r], now()).is_empty());
    }

    /// Work minted by the composer or the CLI belongs to no conversation.
    /// There is nowhere to hand it back to, and picking a chat to announce it
    /// in would be a fabrication.
    #[test]
    fn a_job_no_conversation_placed_is_handed_back_to_nobody() {
        let mut r = row("completed", json!({}));
        r.as_object_mut().unwrap().remove("context_id");
        assert!(handbacks(&[r], now()).is_empty());
        assert!(handbacks(&[row("completed", json!({"context_id": "  "}))], now()).is_empty());
    }

    /// Naming the work makes a note useful when several jobs are in flight.
    #[test]
    fn the_note_names_the_work_it_is_about() {
        let out = handbacks(&[row("completed", json!({}))], now());
        assert!(out[0].text.contains("Add the retry backoff"));
        assert!(out[0].text.contains("claude"), "and which agent ran it");
    }

    /// When the conversation itself was sent, the brief opens with the
    /// transcript digest — so quoting its first line would name the digest's
    /// heading instead of any work.
    #[test]
    fn a_handed_over_conversation_is_not_quoted_by_its_digest_heading() {
        let rows = vec![row(
            "completed",
            json!({
                "input_metadata": {"handoff": "conversation", "aura_chat_session": "sid-7"},
                "input_text": "## The conversation you are continuing\n\nlots of transcript",
            }),
        )];
        let out = handbacks(&rows, now());
        assert!(!out[0].text.contains("The conversation you are continuing"));
        assert!(out[0].text.contains("the work this conversation sent over"));
    }

    /// Same column, handed back as a json string instead of an object.
    #[test]
    fn metadata_is_read_whether_it_arrives_as_json_or_as_text() {
        let rows = vec![row(
            "completed",
            json!({
                "input_metadata": "{\"handoff\":\"conversation\"}",
                "input_text": "## The conversation you are continuing\n\nlots of transcript",
            }),
        )];
        assert!(!handbacks(&rows, now())[0]
            .text
            .contains("The conversation you are continuing"));
    }

    /// A completed job with nothing to show for it is a real outcome, and one
    /// worth reading — it means there is nothing waiting to be pulled down.
    #[test]
    fn a_job_that_produced_nothing_says_that_plainly() {
        let out = handbacks(&[row("completed", json!({}))], now());
        assert!(out[0].text.contains("no branch and no commit"));
    }

    #[test]
    fn a_job_stopped_for_a_login_says_which_wall_it_hit() {
        let out = handbacks(&[row("auth-required", json!({}))], now());
        assert!(out[0].text.contains("not signed in"));
    }

    #[test]
    fn a_multibyte_reason_clips_without_splitting_a_character() {
        let long = "é".repeat(500);
        let out = handbacks(&[row("failed", json!({"error_message": long}))], now());
        assert!(out[0].text.contains('…'));
        assert!(out[0].text.chars().count() < 600);
    }
}
