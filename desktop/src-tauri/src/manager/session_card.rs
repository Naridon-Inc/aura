//! Session cards — the cheap read path behind the chat list.
//!
//! A `ManagerSession` on disk carries its whole chat transcript. Listing
//! sessions needs none of that: a title, a status, two timestamps, a task
//! tally, and the project roots the session is bound to. Yet the list used to
//! JSON-parse and deep-clone every session file to get them, and transcripts
//! grow without bound — a single long-running chat here is 99 MB, with 159 MB
//! across the folder. That parse ran on every Sessions/Trace open, which is
//! most of why opening the pane stalled.
//!
//! A card is that handful of fields, cached next to the session as
//! `<id>.card` and validated against the session file's (mtime, len). Cards
//! are written on every save, so the sidecar is normally already correct; the
//! full parse only ever happens once per session, for files that predate this.
//!
//! The `.card` extension is deliberate — `list_session_ids()` filters on
//! `.json`, so cards can never be mistaken for sessions.

use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::Path;
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};

use super::{ManagerSession, ManagerStatus, ManagerTaskStatus, ProjectRef};
use crate::cmd_manager::ManagerSummary;

/// What listing a session needs, and nothing else.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SessionCard {
    pub summary: ManagerSummary,
    /// Every project root the session is bound to. The summary keeps only the
    /// first one for display, but workspace scoping has to test all of them —
    /// a multi-project chat belongs to each of its workspaces.
    pub roots: Vec<String>,
}

/// The on-disk sidecar: a card plus the stamp of the session it describes.
#[derive(Serialize, Deserialize)]
struct Sidecar {
    src_mtime: u128,
    src_len: u64,
    card: SessionCard,
}

/// Just enough of a session to build a card. Unknown fields — `chat` above
/// all — are skipped by serde rather than materialised, so the one-time
/// backfill parse of a 99 MB transcript doesn't also allocate it.
#[derive(Deserialize)]
struct SessionHead {
    id: String,
    #[serde(default)]
    objective: String,
    status: ManagerStatus,
    created_at: u64,
    updated_at: u64,
    #[serde(default)]
    projects: Vec<ProjectRef>,
    /// The machine this conversation's hands are on. Read off disk so a
    /// card built without loading the session still says where the chat
    /// runs — the whole point of the field on `ManagerSummary`.
    #[serde(default)]
    machine_id: Option<String>,
    #[serde(default)]
    tasks: Vec<TaskHead>,
}

#[derive(Deserialize)]
struct TaskHead {
    status: ManagerTaskStatus,
}

/// In-process card cache, keyed by session id → (mtime, len, card). Cards are
/// small, so unlike the full-session cache this one is cheap to hold.
#[allow(clippy::type_complexity)]
fn card_cache() -> &'static Mutex<HashMap<String, (u128, u64, SessionCard)>> {
    static CACHE: OnceLock<Mutex<HashMap<String, (u128, u64, SessionCard)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn done_count(statuses: impl Iterator<Item = ManagerTaskStatus>) -> usize {
    statuses
        .filter(|s| matches!(s, ManagerTaskStatus::Done | ManagerTaskStatus::Skipped))
        .count()
}

impl SessionCard {
    /// Build a card from a session already in memory.
    pub fn of(s: &ManagerSession) -> Self {
        SessionCard {
            summary: ManagerSummary::from(s),
            roots: s.projects.iter().map(|p| p.root.clone()).collect(),
        }
    }

    fn from_head(h: SessionHead) -> Self {
        let task_count = h.tasks.len();
        let done = done_count(h.tasks.into_iter().map(|t| t.status));
        SessionCard {
            summary: ManagerSummary {
                id: h.id,
                objective: h.objective,
                status: h.status,
                created_at: h.created_at,
                updated_at: h.updated_at,
                task_count,
                done_count: done,
                repo_root: h.projects.first().map(|p| p.root.clone()),
                machine_id: h.machine_id,
            },
            roots: h.projects.into_iter().map(|p| p.root).collect(),
        }
    }
}

/// Write (or refresh) the sidecar for a session that was just saved to `src`.
///
/// Takes the path rather than looking it up again: the card must describe the
/// exact bytes `save` produced, and re-deriving the location would let the two
/// disagree if the sessions directory moved in between.
///
/// Best-effort — a card that fails to write just means the next read pays for
/// a parse, never a lost session.
pub fn write_beside(session: &ManagerSession, src: &Path) {
    let Some((src_mtime, src_len)) = super::persist::stamp_of(src) else {
        return;
    };
    let card = SessionCard::of(session);
    if let Ok(mut cache) = card_cache().lock() {
        cache.insert(session.id.clone(), (src_mtime, src_len, card.clone()));
    }
    persist_sidecar(
        &src.with_extension("card"),
        &Sidecar {
            src_mtime,
            src_len,
            card,
        },
    );
}

fn persist_sidecar(path: &Path, sidecar: &Sidecar) {
    let Some(dir) = path.parent() else {
        return;
    };
    let Ok(json) = serde_json::to_string(sidecar) else {
        return;
    };
    // Same atomic tempfile+rename as the session itself: a card is only ever
    // whole or absent, never a truncated file that parses to nonsense.
    let Ok(mut tmp) = tempfile::Builder::new()
        .prefix(".tmp-card-")
        .tempfile_in(dir)
    else {
        return;
    };
    if tmp.write_all(json.as_bytes()).is_err() {
        return;
    }
    let _ = tmp.persist(path);
}

/// The card for a session id, cheapest source first: memory, then sidecar,
/// then a one-time partial parse of the session itself.
///
/// `None` means the session file is gone or unreadable — the caller drops it
/// from the list, which is what listing a missing session should do.
pub fn read(id: &str) -> Option<SessionCard> {
    let src = super::persist::session_path_of(id)?;
    let (src_mtime, src_len) = super::persist::stamp_of(&src)?;

    if let Ok(cache) = card_cache().lock() {
        if let Some((m, l, card)) = cache.get(id) {
            if (*m, *l) == (src_mtime, src_len) {
                return Some(card.clone());
            }
        }
    }

    if let Some(card) = read_sidecar(&src.with_extension("card"), src_mtime, src_len) {
        if let Ok(mut cache) = card_cache().lock() {
            cache.insert(id.to_string(), (src_mtime, src_len, card.clone()));
        }
        return Some(card);
    }

    // Backfill: no usable sidecar, so parse the session head once and leave a
    // card behind so this never happens again for this revision of the file.
    let raw = fs::read_to_string(&src).ok()?;
    let card = card_from_json(&raw)?;
    if let Ok(mut cache) = card_cache().lock() {
        cache.insert(id.to_string(), (src_mtime, src_len, card.clone()));
    }
    persist_sidecar(
        &src.with_extension("card"),
        &Sidecar {
            src_mtime,
            src_len,
            card: card.clone(),
        },
    );
    Some(card)
}

/// A sidecar is only trusted when it names the exact session bytes on disk.
/// Any drift — a session written by an older shell, a hand-edited file, a
/// restored backup — falls through to a fresh parse rather than serving a
/// card that describes a session that no longer exists.
fn read_sidecar(path: &Path, src_mtime: u128, src_len: u64) -> Option<SessionCard> {
    let raw = fs::read_to_string(path).ok()?;
    sidecar_if_current(&raw, src_mtime, src_len)
}

/// A card built straight from session JSON, without loading the transcript.
fn card_from_json(raw: &str) -> Option<SessionCard> {
    serde_json::from_str::<SessionHead>(raw)
        .ok()
        .map(SessionCard::from_head)
}

/// The card inside a sidecar, but only when it still describes these bytes.
fn sidecar_if_current(raw: &str, src_mtime: u128, src_len: u64) -> Option<SessionCard> {
    let sidecar: Sidecar = serde_json::from_str(raw).ok()?;
    if sidecar.src_mtime == src_mtime && sidecar.src_len == src_len {
        Some(sidecar.card)
    } else {
        None
    }
}

// There is deliberately no `forget(id)`: nothing in the app deletes a session,
// and `read` already ignores a card whose session file is gone. If a delete
// path is ever added, it should remove `<id>.card` alongside `<id>.json`.

#[cfg(test)]
mod tests {
    use super::*;
    use crate::manager::{ManagerTask, ManagerTaskStatus};
    use serde_json::{Value, json};

    fn task(id: usize, status: ManagerTaskStatus) -> ManagerTask {
        ManagerTask {
            id,
            description: "t".into(),
            agent_id: None,
            depends_on: vec![],
            status,
            project_root: "/tmp".into(),
            zones: vec![],
            blocked_reason: None,
            output: String::new(),
            summary: None,
            started_at: None,
            completed_at: None,
            stream_channel: None,
            worktree_path: None,
            a2a_task_id: None,
            pre_dispatch_snapshot_ids: Vec::new(),
            recent_output: Vec::new(),
            line_count: 0,
            pending_skill: None,
        }
    }

    fn project(root: &str) -> ProjectRef {
        ProjectRef {
            root: root.into(),
            label: root.into(),
        }
    }

    fn sample() -> ManagerSession {
        ManagerSession::new(
            "sid".into(),
            "ship the thing".into(),
            vec![project("/a"), project("/b")],
            vec![
                task(1, ManagerTaskStatus::Done),
                task(2, ManagerTaskStatus::Skipped),
                task(3, ManagerTaskStatus::Pending),
            ],
        )
    }

    /// The whole design rests on two paths producing the same card: the cheap
    /// partial parse used for backfill, and the in-memory build used on save.
    /// If they ever drift, the list quietly shows stale or wrong rows — so
    /// pin them against each other.
    #[test]
    fn the_partial_parse_agrees_with_the_full_session() {
        let s = sample();
        let raw = serde_json::to_string(&s).unwrap();
        let parsed = card_from_json(&raw).expect("session JSON parses into a card");
        assert_eq!(
            serde_json::to_value(&parsed).unwrap(),
            serde_json::to_value(SessionCard::of(&s)).unwrap(),
        );
    }

    #[test]
    fn a_card_counts_done_and_skipped_as_finished() {
        let card = SessionCard::of(&sample());
        assert_eq!(card.summary.task_count, 3);
        assert_eq!(card.summary.done_count, 2);
    }

    /// Workspace scoping tests every root, not just the one the summary
    /// displays — a chat spanning two projects belongs to both.
    #[test]
    fn every_project_root_survives_into_the_card() {
        let card = SessionCard::of(&sample());
        assert_eq!(card.roots, vec!["/a".to_string(), "/b".to_string()]);
        assert_eq!(card.summary.repo_root.as_deref(), Some("/a"));
    }

    /// The point of the card is not reading the transcript. A session whose
    /// chat is enormous — or shaped in a way this build doesn't understand —
    /// must still produce a card.
    #[test]
    fn the_transcript_is_never_needed_to_build_a_card() {
        let mut raw: Value = serde_json::to_value(sample()).unwrap();
        let junk: Vec<Value> = (0..500)
            .map(|i| json!({ "unknown_shape": i, "body": "x".repeat(200) }))
            .collect();
        raw["chat"] = Value::Array(junk);
        raw["some_field_from_a_future_build"] = json!(true);

        let card = card_from_json(&raw.to_string()).expect("card survives an unknown transcript");
        assert_eq!(card.summary.task_count, 3);
        assert_eq!(card.summary.objective, "ship the thing");
    }

    #[test]
    fn a_sidecar_stamped_for_other_bytes_is_rejected() {
        let sidecar = Sidecar {
            src_mtime: 111,
            src_len: 222,
            card: SessionCard::of(&sample()),
        };
        let raw = serde_json::to_string(&sidecar).unwrap();

        assert!(sidecar_if_current(&raw, 111, 222).is_some());
        assert!(
            sidecar_if_current(&raw, 111, 223).is_none(),
            "a session that changed length must not serve its old card"
        );
        assert!(
            sidecar_if_current(&raw, 112, 222).is_none(),
            "a session rewritten in place must not serve its old card"
        );
    }
}
