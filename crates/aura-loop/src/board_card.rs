//! The one table between a task **card** and a task **board row**.
//!
//! `.aura/tasks/` grew two stores that never knew about each other. The
//! desktop app writes every task into a single `tasks.json` document. The
//! `aura task` CLI — and the crew, when it files a card for a node — writes
//! one `T-xxxxxxxx.json` file per task in the same directory, so a crash
//! mid-write can only ever cost the one card being written.
//!
//! Each reader saw only its own shape and read the other's absence as an
//! empty board. Rename `tasks.json` aside and the desktop List and Board go
//! to zero while `aura task list` still prints every card; file a card from
//! the crew and it never reaches the app at all. Nothing errors, because
//! "the file isn't there" is indistinguishable from "there is no work" once
//! you only know one filename. That is how it survived unnoticed.
//!
//! So the directory is the board, and this module is the projection both
//! surfaces read it through. It lives in `aura-loop` rather than in either
//! surface for the same reason `board_link` does: the desktop app, the
//! agent-facing MCP board and the crew runner all write these files, and a
//! second copy of this table would let them disagree about what a status
//! means — which is the failure this module exists to end.
//!
//! Everything here is `serde_json::Value` on the board side. The board row
//! carries thirty-odd fields that are none of this module's business, and
//! naming them would mean revisiting this file every time the app adds one.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// The per-file card the CLI and the crew write: one task, one file, named
/// for its id. Unknown fields ride along in `rest` untouched, so a card
/// written by a newer build survives a round trip through an older one.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Card {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub priority: String,
    #[serde(default)]
    pub author: String,
    #[serde(default)]
    pub assignee: Option<String>,
    #[serde(default)]
    pub claimed_by: Option<String>,
    #[serde(default)]
    pub labels: Vec<String>,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default)]
    pub comments: Vec<Value>,
    #[serde(default)]
    pub linked_pr: Option<String>,
    #[serde(default)]
    pub linked_branch: Option<String>,
    /// The board's human handle (`AURA-{n}`). Cards are minted without one,
    /// and the board allocates it on first read — so it has to come back
    /// here, or every read hands the same card a new number and the handle
    /// the user just quoted stops resolving.
    #[serde(default)]
    pub sequence_id: u64,
    /// Everything this build does not model, kept verbatim.
    #[serde(flatten)]
    pub rest: BTreeMap<String, Value>,
}

pub fn tasks_dir(repo_root: &Path) -> PathBuf {
    repo_root.join(".aura").join("tasks")
}

fn card_path(repo_root: &Path, id: &str) -> PathBuf {
    tasks_dir(repo_root).join(format!("{id}.json"))
}

/// True for an id this module round-trips as a per-file card.
///
/// The two stores mint disjoint id shapes — `T-7af2c091` from the CLI,
/// `task_<uuid>` from the desktop — so the id alone says which store a row
/// belongs to, and no separate provenance map has to be kept in step.
pub fn is_card_id(id: &str) -> bool {
    id.starts_with("T-")
}

// ─── status ⇄ state ─────────────────────────────────────────────────────
//
// The card's vocabulary is open / in_progress / blocked / done / cancelled.
// The board's canonical pointer is `state_id` into the per-repo catalog.
// Every card status lands on a state the app seeds by default — `blocked`
// included, which is why that seeder ships six states and not five.

/// Catalog state for a card status. An unknown status reads as not-started
/// rather than being dropped: unrecognised work is still work.
pub fn card_status_to_state_id(status: &str) -> &'static str {
    match status {
        "in_progress" => "started",
        "blocked" => "blocked",
        "done" => "completed",
        "cancelled" | "canceled" => "cancelled",
        _ => "unstarted",
    }
}

/// The card status a board state means.
///
/// Driven by `state_id`, never by the legacy `status` string beside it:
/// that string is rewritten on read from the state's *group*, and the group
/// for `blocked` is `unstarted`, so a round trip through the string would
/// quietly turn a blocked card into an ordinary to-do.
pub fn state_id_to_card_status(state_id: &str) -> &'static str {
    match state_id {
        "started" => "in_progress",
        "blocked" => "blocked",
        "completed" => "done",
        "cancelled" => "cancelled",
        _ => "open",
    }
}

/// The legacy free-form `status` the board writes beside the state pointer.
/// Kept in step with the app's own heal pass so what we write reads back
/// unchanged.
fn card_status_to_legacy(status: &str) -> &'static str {
    match status {
        "in_progress" => "in_progress",
        "done" => "done",
        // `blocked` and `cancelled` have no legacy string of their own; both
        // read back out of `state_id`, so the legacy field only has to heal
        // to a group that doesn't overstate progress.
        _ => "todo",
    }
}

/// The card ladder tops out at `critical`; the board's tops out at `urgent`.
/// Every other rung already shares a name.
fn card_priority_to_board(p: &str) -> &str {
    match p {
        "critical" => "urgent",
        "" => "medium",
        other => other,
    }
}

fn board_priority_to_card(p: &str) -> &str {
    match p {
        "urgent" => "critical",
        "" => "medium",
        other => other,
    }
}

fn unix_to_rfc3339(secs: i64) -> String {
    chrono::DateTime::from_timestamp(secs, 0)
        .unwrap_or_else(chrono::Utc::now)
        .to_rfc3339()
}

fn rfc3339_to_unix(s: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(s)
        .map(|d| d.timestamp())
        .unwrap_or_else(|_| chrono::Utc::now().timestamp())
}

/// Project a card onto the board row the app and the MCP board render.
///
/// Only the fields a card actually carries are set. The rest of the row is
/// absent, which every reader already treats as its default — rows written
/// before a field existed arrive the same way.
pub fn card_to_row(card: &Card) -> Value {
    json!({
        "id": card.id,
        "sequence_id": card.sequence_id,
        "title": card.title,
        "description": card.body,
        "status": card_status_to_legacy(&card.status),
        "state_id": card_status_to_state_id(&card.status),
        "priority": card_priority_to_board(&card.priority),
        "assignee": card.assignee,
        "assignee_ids": card.assignee.clone().map(|a| vec![a]).unwrap_or_default(),
        "agent_assignee": card.claimed_by,
        "reporter": (!card.author.is_empty()).then(|| card.author.clone()),
        "labels": card.labels,
        "linked_pr": card.linked_pr.as_deref().and_then(pr_row),
        "created_at": unix_to_rfc3339(card.created_at),
        "updated_at": unix_to_rfc3339(card.updated_at),
    })
}

/// A card records its pull request as one string — whatever the CLI was
/// handed. The board wants `{repo, number, url}`, and only a full GitHub URL
/// carries all three. Anything else (a bare number, a shortlink) stays on the
/// card rather than being guessed at: a wrong repo on a task is worse than no
/// link, and `row_into_card` carries the original string through untouched.
fn pr_row(link: &str) -> Option<Value> {
    let rest = link
        .strip_prefix("https://github.com/")
        .or_else(|| link.strip_prefix("http://github.com/"))?;
    let (repo, tail) = rest.split_once("/pull/")?;
    let number: u64 = tail
        .split(['/', '?', '#'])
        .next()
        .unwrap_or_default()
        .parse()
        .ok()?;
    if repo.split('/').count() != 2 {
        return None;
    }
    Some(json!({ "repo": repo, "number": number, "url": link }))
}

fn str_at<'a>(row: &'a Value, key: &str) -> &'a str {
    row.get(key).and_then(Value::as_str).unwrap_or_default()
}

fn opt_str(row: &Value, key: &str) -> Option<String> {
    row.get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// Fold a board row back into the card it came from.
///
/// `prev` is the card as it sits on disk. Comments, the linked branch and
/// any field this build doesn't model have no home on the board row, so
/// they are carried from `prev` rather than reconstructed — a task edited
/// in the app must not cost the CLI the discussion recorded on its card.
pub fn row_into_card(row: &Value, prev: Option<&Card>) -> Card {
    let assignee = opt_str(row, "assignee").or_else(|| {
        row.get("assignee_ids")
            .and_then(Value::as_array)
            .and_then(|a| a.first())
            .and_then(Value::as_str)
            .map(str::to_string)
    });
    Card {
        id: str_at(row, "id").to_string(),
        title: str_at(row, "title").to_string(),
        body: str_at(row, "description").to_string(),
        status: state_id_to_card_status(str_at(row, "state_id")).to_string(),
        priority: board_priority_to_card(str_at(row, "priority")).to_string(),
        author: prev
            .map(|c| c.author.clone())
            .filter(|a| !a.is_empty())
            .or_else(|| opt_str(row, "reporter"))
            .unwrap_or_default(),
        assignee,
        claimed_by: opt_str(row, "agent_assignee"),
        labels: row
            .get("labels")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default(),
        created_at: rfc3339_to_unix(str_at(row, "created_at")),
        updated_at: rfc3339_to_unix(str_at(row, "updated_at")),
        comments: prev.map(|c| c.comments.clone()).unwrap_or_default(),
        linked_pr: row
            .get("linked_pr")
            .and_then(|pr| pr.get("url"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| prev.and_then(|c| c.linked_pr.clone())),
        linked_branch: prev.and_then(|c| c.linked_branch.clone()),
        sequence_id: row
            .get("sequence_id")
            .and_then(Value::as_u64)
            .filter(|n| *n > 0)
            .or_else(|| prev.map(|c| c.sequence_id))
            .unwrap_or(0),
        rest: prev.map(|c| c.rest.clone()).unwrap_or_default(),
    }
}

/// Lay a card's fields over an aggregate row, leaving every field the card
/// does not model exactly as it was.
///
/// The aggregate rows carry two dozen fields a card has never had — the
/// epic, the cycle, the dependency list, the estimate. A writer that
/// rebuilt the row from the card would delete all of them, so an edit made
/// from the CLI patches the row rather than replacing it.
pub fn merge_card_into_row(card: &Card, row: &mut Value) {
    let Some(obj) = row.as_object_mut() else { return };
    obj.insert("title".into(), json!(card.title));
    obj.insert("description".into(), json!(card.body));
    obj.insert("status".into(), json!(card_status_to_legacy(&card.status)));
    obj.insert("state_id".into(), json!(card_status_to_state_id(&card.status)));
    obj.insert("priority".into(), json!(card_priority_to_board(&card.priority)));
    obj.insert("assignee".into(), json!(card.assignee));
    obj.insert(
        "assignee_ids".into(),
        json!(card.assignee.clone().map(|a| vec![a]).unwrap_or_default()),
    );
    obj.insert("agent_assignee".into(), json!(card.claimed_by));
    obj.insert("labels".into(), json!(card.labels));
    if let Some(pr) = card.linked_pr.as_deref().and_then(pr_row) {
        obj.insert("linked_pr".into(), pr);
    }
    if card.sequence_id > 0 {
        obj.insert("sequence_id".into(), json!(card.sequence_id));
    }
    obj.insert("updated_at".into(), json!(unix_to_rfc3339(card.updated_at)));
}

/// A card's inline comments, in the shape the app's comment store uses.
///
/// Comments split the same way the board did: the app keeps them in
/// `task_comments.json`, the CLI writes them inline on the card, and each
/// surface saw only its own. Neither store moves — each reader unions the
/// other in, which is why the ids here are derived rather than minted: the
/// same card must project to the same comment ids on every read.
pub fn card_comment_rows(card: &Card) -> Vec<Value> {
    card.comments
        .iter()
        .enumerate()
        .map(|(i, c)| {
            let at = c.get("at").and_then(Value::as_i64).unwrap_or(card.updated_at);
            let stamp = unix_to_rfc3339(at);
            json!({
                "id": format!("cmt_card_{}_{i}", card.id),
                "task_id": card.id,
                "parent_comment_id": Value::Null,
                "author_handle": c.get("author").and_then(Value::as_str).unwrap_or("unknown"),
                "body": c.get("body").and_then(Value::as_str).unwrap_or_default(),
                "created_at": stamp,
                "updated_at": stamp,
            })
        })
        .collect()
}

/// Read every per-file card in the directory, in stable filename order.
///
/// A card that will not parse is skipped rather than failing the whole
/// board: one torn file must never blank the app.
pub fn read_cards(repo_root: &Path) -> Vec<Card> {
    let dir = tasks_dir(repo_root);
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .filter_map(|e| e.ok())
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| n.starts_with("T-") && n.ends_with(".json"))
        // `T-xxxx.json.tmp.NNN` is a half-written card from an atomic
        // write in flight. It doesn't end in `.json`, but say so anyway.
        .filter(|n| !n.contains(".tmp."))
        .collect();
    names.sort();
    names
        .iter()
        .filter_map(|n| std::fs::read(dir.join(n)).ok())
        .filter_map(|b| serde_json::from_slice::<Card>(&b).ok())
        .collect()
}

/// Read every card as a board row, ready to merge into the aggregate.
pub fn read_card_rows(repo_root: &Path) -> Vec<Value> {
    read_cards(repo_root).iter().map(card_to_row).collect()
}

/// Write one card back to its own file, atomically — temp file beside the
/// target, then rename, so a reader never sees a half-written card.
pub fn write_card(repo_root: &Path, card: &Card) -> Result<(), String> {
    let dir = tasks_dir(repo_root);
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir {}: {e}", dir.display()))?;
    let target = card_path(repo_root, &card.id);
    let tmp = dir.join(format!("{}.json.tmp.{}", card.id, std::process::id()));
    let body = serde_json::to_vec_pretty(card).map_err(|e| format!("encode {}: {e}", card.id))?;
    std::fs::write(&tmp, &body).map_err(|e| format!("write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, &target).map_err(|e| format!("rename {}: {e}", target.display()))
}

/// Delete a card's file. A card that is already gone is not an error — two
/// surfaces removing the same task must not turn into a failed save.
pub fn remove_card(repo_root: &Path, id: &str) -> Result<(), String> {
    match std::fs::remove_file(card_path(repo_root, id)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("remove card {id}: {e}")),
    }
}

/// The aggregate document beside the cards: one file holding every row that
/// is not a card. The desktop app has always written it, the CLI never knew
/// it existed, and when it went missing by hand the app read an empty board
/// while the CLI kept listing cards perfectly happily.
pub fn board_file(repo_root: &Path) -> PathBuf {
    tasks_dir(repo_root).join("tasks.json")
}

/// The aggregate document's rows, without the cards beside it.
///
/// A missing document is an empty *document*, not an empty board — it is
/// written lazily on the first task the app creates, and the cards in the
/// same directory are work either way.
pub fn read_rows(repo_root: &Path) -> Vec<Value> {
    let Ok(bytes) = std::fs::read(board_file(repo_root)) else {
        return Vec::new();
    };
    let Ok(doc) = serde_json::from_slice::<Value>(&bytes) else {
        return Vec::new();
    };
    doc.get("tasks")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

/// The whole board: the aggregate document AND every card in the directory,
/// as the rows every surface renders.
pub fn read_board(repo_root: &Path) -> Vec<Value> {
    let mut rows = read_rows(repo_root);
    merge_cards_into(&mut rows, repo_root);
    rows
}

/// Write only the aggregate document, leaving every card untouched.
///
/// Separate from [`write_board`] on purpose: that one owns the whole board
/// and deletes any card missing from the list it is handed, which is exactly
/// wrong for a caller that only ever loaded the aggregate half.
pub fn write_rows(repo_root: &Path, rows: &[Value]) -> Result<(), String> {
    let path = board_file(repo_root);
    // Keep whatever else the document carries — a schema version, a cursor,
    // anything a newer writer added. Only the row list is ours to replace.
    let mut doc: Value = std::fs::read(&path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}));
    doc["tasks"] = Value::Array(rows.to_vec());

    let dir = tasks_dir(repo_root);
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir {}: {e}", dir.display()))?;
    let tmp = dir.join(format!("tasks.json.tmp.{}", std::process::id()));
    let body = serde_json::to_vec_pretty(&doc).map_err(|e| format!("encode board: {e}"))?;
    std::fs::write(&tmp, &body).map_err(|e| format!("write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("rename {}: {e}", path.display()))
}

/// Write the board back, each row to the store it came from.
///
/// A card goes to its own file and everything else into the aggregate
/// document, so the cards keep the property they exist for — one file per
/// task, so a crash mid-write costs at most the task being written. A row
/// dropped from the list is deleted from whichever store held it; a card
/// that survived removal would simply reappear on the next read.
///
/// Every caller therefore reads the whole board, edits it, and writes it
/// back. Handing this function a partial list deletes the rest.
pub fn write_board(repo_root: &Path, rows: &[Value]) -> Result<(), String> {
    let previous: BTreeMap<String, Card> = read_cards(repo_root)
        .into_iter()
        .map(|c| (c.id.clone(), c))
        .collect();

    let mut kept: Vec<Value> = Vec::new();
    let mut written: std::collections::HashSet<String> = std::collections::HashSet::new();
    for row in rows {
        let id = str_at(row, "id");
        if is_card_id(id) {
            write_card(repo_root, &row_into_card(row, previous.get(id)))?;
            written.insert(id.to_string());
        } else {
            kept.push(row.clone());
        }
    }
    for id in previous.keys() {
        if !written.contains(id) {
            remove_card(repo_root, id)?;
        }
    }

    write_rows(repo_root, &kept)
}

/// Merge every card into an aggregate row list, card winning on a shared id.
///
/// A card is the live row for its id: it is what the CLI rewrites, and it is
/// written one file at a time, so it is also the copy that survives a crash
/// mid-write.
pub fn merge_cards_into(rows: &mut Vec<Value>, repo_root: &Path) {
    for row in read_card_rows(repo_root) {
        let id = str_at(&row, "id").to_string();
        match rows
            .iter_mut()
            .find(|r| r.get("id").and_then(Value::as_str) == Some(id.as_str()))
        {
            Some(slot) => *slot = row,
            None => rows.push(row),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_repo() -> PathBuf {
        let p = std::env::temp_dir().join(format!("aura-board-card-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(p.join(".aura").join("tasks")).unwrap();
        p
    }

    fn card(id: &str, status: &str) -> Card {
        Card {
            id: id.into(),
            title: "a task".into(),
            body: "why it exists".into(),
            status: status.into(),
            priority: "critical".into(),
            author: "ashiq".into(),
            assignee: Some("ashiq".into()),
            claimed_by: Some("claude".into()),
            labels: vec!["audit".into()],
            created_at: 1_767_225_600,
            updated_at: 1_767_225_600,
            comments: vec![json!({ "body": "picked it up" })],
            linked_pr: Some("https://github.com/MHASK/aura-sovereign/pull/57".into()),
            linked_branch: Some("post-audit".into()),
            sequence_id: 412,
            rest: BTreeMap::new(),
        }
    }

    #[test]
    fn every_card_status_survives_the_projection() {
        for status in ["open", "in_progress", "blocked", "done", "cancelled"] {
            let c = card("T-00000001", status);
            let back = row_into_card(&card_to_row(&c), Some(&c));
            assert_eq!(back.status, status, "{status} did not come back");
        }
    }

    #[test]
    fn a_blocked_card_never_reads_as_an_ordinary_todo() {
        // The legacy string cannot express `blocked`, so the state pointer
        // has to carry it. This is the bug that would silently mark blocked
        // work as ready to pick up.
        let row = card_to_row(&card("T-00000002", "blocked"));
        assert_eq!(row["state_id"], "blocked");
        assert_eq!(row_into_card(&row, None).status, "blocked");
    }

    #[test]
    fn the_handle_the_board_allocated_comes_back_to_the_card() {
        let c = card("T-00000003", "open");
        let mut row = card_to_row(&c);
        assert_eq!(row["sequence_id"], 412);
        // A card minted by the CLI has no handle; the board allocates one
        // and it must land back on disk, or the next read allocates again.
        let fresh = Card { sequence_id: 0, ..c.clone() };
        row = card_to_row(&fresh);
        assert_eq!(row["sequence_id"], 0);
        row["sequence_id"] = json!(99);
        assert_eq!(row_into_card(&row, Some(&fresh)).sequence_id, 99);
    }

    #[test]
    fn card_only_fields_survive_an_edit_made_on_the_board() {
        let disk = card("T-00000004", "open");
        let mut row = card_to_row(&disk);
        row["state_id"] = json!("started");
        let back = row_into_card(&row, Some(&disk));
        assert_eq!(back.status, "in_progress");
        assert_eq!(back.comments.len(), 1, "the CLI's discussion was dropped");
        assert_eq!(back.linked_branch.as_deref(), Some("post-audit"));
        assert_eq!(
            back.linked_pr.as_deref(),
            Some("https://github.com/MHASK/aura-sovereign/pull/57")
        );
    }

    #[test]
    fn a_github_pull_request_link_reaches_the_board_whole() {
        let row = card_to_row(&card("T-00000005", "open"));
        assert_eq!(row["linked_pr"]["repo"], "MHASK/aura-sovereign");
        assert_eq!(row["linked_pr"]["number"], 57);
        assert_eq!(
            row_into_card(&row, None).linked_pr.as_deref(),
            Some("https://github.com/MHASK/aura-sovereign/pull/57")
        );
    }

    #[test]
    fn a_link_the_board_cannot_model_stays_on_the_card_rather_than_being_guessed() {
        // A bare number names no repository. Inventing one would put the
        // task's evidence on the wrong project.
        let mut c = card("T-00000006", "open");
        c.linked_pr = Some("57".into());
        let row = card_to_row(&c);
        assert!(row["linked_pr"].is_null());
        assert_eq!(row_into_card(&row, Some(&c)).linked_pr.as_deref(), Some("57"));
    }

    #[test]
    fn priority_crosses_the_two_ladders_without_drifting() {
        assert_eq!(card_to_row(&card("T-5", "open"))["priority"], "urgent");
        let mut row = card_to_row(&card("T-5", "open"));
        row["priority"] = json!("low");
        assert_eq!(row_into_card(&row, None).priority, "low");
    }

    #[test]
    fn the_directory_is_the_board() {
        let repo = tmp_repo();
        write_card(&repo, &card("T-aaaaaaaa", "open")).unwrap();
        write_card(&repo, &card("T-bbbbbbbb", "done")).unwrap();

        let mut rows = vec![json!({ "id": "task_from_the_app", "title": "app row" })];
        merge_cards_into(&mut rows, &repo);
        let ids: Vec<&str> = rows.iter().filter_map(|r| r["id"].as_str()).collect();
        assert_eq!(ids.len(), 3, "{ids:?}");
        assert!(ids.contains(&"T-aaaaaaaa"));
        assert!(ids.contains(&"task_from_the_app"));
    }

    #[test]
    fn a_card_that_will_not_parse_does_not_blank_the_board() {
        let repo = tmp_repo();
        write_card(&repo, &card("T-cccccccc", "open")).unwrap();
        std::fs::write(tasks_dir(&repo).join("T-torn.json"), b"{ not json").unwrap();
        assert_eq!(read_cards(&repo).len(), 1);
    }

    #[test]
    fn a_card_wins_over_a_stale_aggregate_row_for_the_same_id() {
        let repo = tmp_repo();
        write_card(&repo, &card("T-dddddddd", "done")).unwrap();
        let mut rows = vec![json!({ "id": "T-dddddddd", "title": "stale", "state_id": "unstarted" })];
        merge_cards_into(&mut rows, &repo);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["state_id"], "completed");
        assert_eq!(rows[0]["title"], "a task");
    }

    #[test]
    fn removing_a_card_twice_is_not_an_error() {
        let repo = tmp_repo();
        write_card(&repo, &card("T-eeeeeeee", "open")).unwrap();
        remove_card(&repo, "T-eeeeeeee").unwrap();
        remove_card(&repo, "T-eeeeeeee").unwrap();
        assert!(read_cards(&repo).is_empty());
    }

    #[test]
    fn card_ids_and_board_ids_stay_apart() {
        assert!(is_card_id("T-7af2c091"));
        assert!(!is_card_id("task_9a0d3f11-0000-4000-8000-000000000000"));
    }
    #[test]
    fn the_board_is_the_aggregate_and_the_cards_together() {
        let root = tmp_repo();
        std::fs::create_dir_all(tasks_dir(&root)).unwrap();
        std::fs::write(
            board_file(&root),
            serde_json::to_vec(&json!({ "tasks": [ { "id": "task_1", "title": "from the app" } ] }))
                .unwrap(),
        )
        .unwrap();
        write_card(&root, &card("T-aaaaaaaa", "open")).unwrap();

        let rows = read_board(&root);
        assert_eq!(rows.len(), 2, "both stores are one board");
        assert_eq!(read_rows(&root).len(), 1, "the aggregate half is still one row");
    }

    #[test]
    fn writing_only_the_aggregate_does_not_delete_the_cards() {
        let root = tmp_repo();
        write_card(&root, &card("T-bbbbbbbb", "open")).unwrap();
        write_rows(&root, &[json!({ "id": "task_1", "title": "kept" })]).unwrap();
        assert_eq!(read_cards(&root).len(), 1, "an aggregate write is not a board write");
        assert_eq!(read_rows(&root).len(), 1);
    }

    #[test]
    fn a_cli_edit_patches_an_aggregate_row_instead_of_flattening_it() {
        let mut row = json!({
            "id": "task_1",
            "title": "old",
            "state_id": "unstarted",
            "epic_id": "epic_7",
            "dependencies": ["task_0"],
            "estimate": 3.0,
        });
        let mut card = card("task_1", "done");
        card.title = "new".into();
        merge_card_into_row(&card, &mut row);
        assert_eq!(row["title"], json!("new"));
        assert_eq!(row["state_id"], json!("completed"));
        assert_eq!(row["epic_id"], json!("epic_7"), "the epic a card cannot model survived");
        assert_eq!(row["dependencies"], json!(["task_0"]));
        assert_eq!(row["estimate"], json!(3.0));
    }

    #[test]
    fn a_comment_left_on_a_card_reads_as_a_comment_the_app_can_render() {
        let mut card = card("T-cccccccc", "open");
        card.comments = vec![json!({ "author": "ashiq", "at": 1_767_225_600i64, "body": "picked it up" })];
        let rows = card_comment_rows(&card);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["task_id"], json!("T-cccccccc"));
        assert_eq!(rows[0]["author_handle"], json!("ashiq"));
        assert_eq!(rows[0]["body"], json!("picked it up"));
        assert_eq!(
            rows[0]["id"], card_comment_rows(&card)[0]["id"],
            "the same comment must keep the same id across reads"
        );
    }

}
