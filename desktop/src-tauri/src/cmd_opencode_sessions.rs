//! Resume data source and chat record for OpenCode tabs.
//!
//! OpenCode runs as a full TUI, so the same rule as Codex and Kimi applies:
//! scraping the terminal back into a conversation drags the CLI's own
//! furniture along with it — the echoed prompt, the composer placeholder, the
//! status footer — none of which the agent said. The structured record behind
//! that screen is what the chat reads.
//!
//! Where OpenCode differs is WHERE that record lives. Codex and Kimi append
//! JSONL beside the session, so `jsonl_tail` serves them both. OpenCode keeps
//! everything in one SQLite database at `~/.local/share/opencode/opencode.db`:
//!
//!   session(id, directory, parent_id, agent, model, version, time_*)
//!   message(id, session_id, data)        -- data.role, data.tokens, data.cost
//!   part(id, message_id, session_id, time_created, time_updated, data)
//!
//! `part.data` is the exact `Part` JSON that `opencode run --format json`
//! publishes, minus the three fields SQLite lifted out into columns (`id`,
//! `messageID`, `sessionID`). Putting them back reconstructs the run wire
//! byte-for-byte, which is why the frontend adapter written against that wire
//! (`agentProtocol/adapters/opencode.ts`) parses this with no second schema.
//!
//! Two things this source has that the run wire does not, and both are real
//! rather than invented:
//!
//!   * the USER's side. `opencode run` never echoes the prompt it was given,
//!     so its transcript is half a conversation. Here a user message is a
//!     `message` row with `data.role = "user"` and its own text parts, so the
//!     record carries `role` on every envelope.
//!   * the MODEL. The run wire carries no model name at all — it lives on the
//!     session. `session.model` is `{id, providerID, variant}`, which is the
//!     one fact a BYO-provider user most wants confirmed ("is this actually
//!     talking to my z.ai plan?"), so the first record is a `session_init`
//!     built from the session row.
//!
//! The cursor is NOT a byte offset. A part row is mutated in place — a tool
//! call goes `pending → running → completed` on the same `id` — so a byte or
//! row-count cursor would hand back the request and never the result. The
//! cursor is `max(part.time_updated)` in milliseconds instead, and the query
//! is `>=`, so the row that last moved is re-delivered once alongside whatever
//! is new. That repeat is free: the frontend reducer folds events by id, and
//! the part id now comes from the row's primary key rather than its position
//! in the slice, so the same row always lands on the same card.

use std::path::PathBuf;

use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Value};

use crate::jsonl_tail::{same_dir, JsonlChunk};

/// How many of the newest sessions to consider when looking for this repo's.
/// A machine that has run OpenCode for months accumulates thousands, and the
/// one we want is always recent — the alternative is scanning the whole table
/// on a 400ms poll to find something that was never there.
const SESSION_SCAN_LIMIT: usize = 300;

/// `~/.local/share/opencode/opencode.db`, or None when OpenCode has never run
/// on this machine.
///
/// `XDG_DATA_HOME` first because OpenCode honours it, then the XDG default.
/// Deliberately NOT `dirs::data_local_dir()`: on macOS that resolves to
/// `~/Library/Application Support`, where OpenCode does not write.
fn db_path() -> Option<PathBuf> {
    let base = match std::env::var_os("XDG_DATA_HOME") {
        Some(v) if !v.is_empty() => PathBuf::from(v),
        _ => dirs::home_dir()?.join(".local").join("share"),
    };
    let db = base.join("opencode").join("opencode.db");
    db.exists().then_some(db)
}

/// Open the store read-only.
///
/// Read-only is the whole point: this is another program's live database and
/// we are a spectator. `SQLITE_OPEN_READ_ONLY` also means a WAL that needs
/// recovery fails here rather than being rewritten underneath OpenCode.
fn open(db: &PathBuf) -> Result<Connection, String> {
    Connection::open_with_flags(
        db,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| format!("open opencode store: {e}"))
}

/// The session row the chat should read for `repo_root`.
struct Session {
    id: String,
    directory: String,
    agent: Option<String>,
    /// `{"id":"…","providerID":"…","variant":"…"}` as OpenCode stores it.
    model: Option<String>,
    version: Option<String>,
    created: i64,
}

/// The newest live session OpenCode recorded for this directory.
///
/// `parent_id is null` matters: the `task` tool spawns a CHILD session in the
/// same directory, and a delegated subagent is routinely the most recently
/// touched row. Without the filter, opening the chat while a subagent runs
/// would show the subagent's transcript in place of the conversation the user
/// is actually having.
///
/// `time_archived is null` for the same reason in the other direction — an
/// archived session is one the user put away.
fn newest_session(conn: &Connection, repo_root: &str) -> Result<Option<Session>, String> {
    let mut stmt = conn
        .prepare(
            "select id, directory, agent, model, version, time_created \
             from session \
             where parent_id is null and time_archived is null \
             order by time_updated desc \
             limit ?1",
        )
        .map_err(|e| format!("prepare session lookup: {e}"))?;
    let rows = stmt
        .query_map([SESSION_SCAN_LIMIT as i64], |r| {
            Ok(Session {
                id: r.get(0)?,
                directory: r.get(1)?,
                agent: r.get(2)?,
                model: r.get(3)?,
                version: r.get(4)?,
                created: r.get(5)?,
            })
        })
        .map_err(|e| format!("scan sessions: {e}"))?;
    for row in rows {
        let s = row.map_err(|e| format!("read session row: {e}"))?;
        if same_dir(&s.directory, repo_root) {
            return Ok(Some(s));
        }
    }
    Ok(None)
}

/// The `session_init` record, built from the session row.
///
/// Not on the run wire — this is the model, provider and agent the session is
/// actually bound to, read from the row OpenCode itself keeps. `model` is
/// re-emitted as the object OpenCode stores rather than flattened, so the
/// adapter can show `providerID/id` the way OpenCode's own `-m` flag spells
/// it.
fn session_init(s: &Session) -> Value {
    let model: Value = s
        .model
        .as_deref()
        .and_then(|m| serde_json::from_str(m).ok())
        .unwrap_or(Value::Null);
    json!({
        "type": "session_init",
        "timestamp": s.created,
        "sessionID": s.id,
        "cwd": s.directory,
        "agent": s.agent,
        "model": model,
        "version": s.version,
    })
}

/// The cursor floor. `0` has to keep meaning "nothing read yet" so the reader
/// knows when to emit `session_init`; a session that exists but has not
/// written a part yet would otherwise report a cursor of 0 and re-send its
/// init on every poll. Every real `time_updated` is a millisecond timestamp,
/// so flooring at 1 costs nothing and never hides a row.
const CURSOR_FLOOR: i64 = 1;

/// Reconstruct one run-wire record from a part row.
///
/// The envelope names the record twice — `type` at the top with underscores
/// (`step_finish`) and `part.type` inside with hyphens (`step-finish`) — the
/// way `opencode run --format json` writes it, because the adapter treats
/// `part.type` as authoritative and falls back to the top-level name only for
/// a record with no part.
fn record(
    id: String,
    message_id: String,
    session_id: &str,
    created: i64,
    role: Option<String>,
    data: &str,
) -> Value {
    let mut part: Value = serde_json::from_str(data).unwrap_or_else(|_| json!({}));
    if let Some(obj) = part.as_object_mut() {
        obj.insert("id".into(), json!(id));
        obj.insert("messageID".into(), json!(message_id));
        obj.insert("sessionID".into(), json!(session_id));
    }
    let kind = part
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or("part")
        .replace('-', "_");
    json!({
        "type": kind,
        "timestamp": created,
        "sessionID": session_id,
        "role": role,
        "part": part,
    })
}

/// Newest OpenCode session id recorded for `repo_root`, or `None` when this
/// directory has no session of its own.
///
/// `None` is a real answer, not a failure: the caller starts a fresh TUI with
/// it. The alternative — resuming OpenCode's own machine-wide latest — would
/// reopen another project's conversation in this tab, which on a box driving
/// several worktrees at once is the common case rather than the corner one.
#[tauri::command]
pub async fn opencode_latest_session(repo_root: String) -> Result<Option<String>, String> {
    let Some(db) = db_path() else {
        return Ok(None);
    };
    tokio::task::spawn_blocking(move || {
        let conn = open(&db)?;
        Ok(newest_session(&conn, &repo_root)?.map(|s| s.id))
    })
    .await
    .map_err(|e| format!("scan opencode sessions: {e}"))?
}

/// Read this repo's OpenCode conversation from `since_offset` to the end.
///
/// Same contract as `codex_rollout_read` so the frontend record store needs no
/// special case, with two fields carrying OpenCode-shaped meanings:
///
///   * `path` is the SESSION ID, not a filename. A session is the record here;
///     there is no file to name, and when the id changes the caller must drop
///     what it accumulated exactly as it would on a rotated file.
///   * `offset` is `max(part.time_updated)` in milliseconds, not a byte count.
///     See the module note: part rows mutate in place.
///
/// An idle poll — nothing has moved since the caller's cursor — returns no
/// lines at all and costs one indexed `max()`. That short-circuit is what
/// stops the `>=` boundary row being re-delivered forever while a session sits
/// quiet.
#[tauri::command]
pub async fn opencode_record_read(
    repo_root: String,
    path: Option<String>,
    since_offset: u64,
) -> Result<JsonlChunk, String> {
    let Some(db) = db_path() else {
        return Ok(JsonlChunk::default());
    };
    tokio::task::spawn_blocking(move || read_chunk(&db, &repo_root, path, since_offset))
        .await
        .map_err(|e| format!("read opencode record: {e}"))?
}

fn read_chunk(
    db: &PathBuf,
    repo_root: &str,
    path: Option<String>,
    since_offset: u64,
) -> Result<JsonlChunk, String> {
    let conn = open(db)?;
    let Some(session) = newest_session(&conn, repo_root)? else {
        return Ok(JsonlChunk::default());
    };
    read_session(&conn, &session, path, since_offset)
}

fn read_session(
    conn: &Connection,
    session: &Session,
    path: Option<String>,
    since_offset: u64,
) -> Result<JsonlChunk, String> {
    // Only a caller already reading THIS session can be continuing one. A
    // first read (`path: None`) starts at the top and is not a reset — there
    // is nothing on the other side to throw away.
    let continuing = path.as_deref() == Some(session.id.as_str());
    let reset = path.is_some() && !continuing;

    let latest: i64 = conn
        .query_row(
            "select coalesce(max(time_updated), 0) from part where session_id = ?1",
            [&session.id],
            |r| r.get(0),
        )
        .map_err(|e| format!("read opencode cursor: {e}"))?;
    let cursor = latest.max(CURSOR_FLOOR);

    let since = if continuing { since_offset as i64 } else { 0 };
    // Nothing has moved and the caller is already on this session: hand back
    // the cursor unchanged and read no rows.
    if continuing && since >= cursor {
        return Ok(JsonlChunk {
            path: Some(session.id.clone()),
            session_id: Some(session.id.clone()),
            offset: cursor as u64,
            lines: Vec::new(),
            reset: false,
        });
    }

    let mut lines: Vec<String> = Vec::new();
    // The model and provider this session is bound to, once, ahead of the
    // conversation — and only on a read that starts from the top, since the
    // caller keeps everything it has already been given.
    if since == 0 {
        lines.push(session_init(session).to_string());
    }

    let mut stmt = conn
        .prepare(
            "select p.id, p.message_id, p.time_created, p.data, \
                    json_extract(m.data, '$.role') \
             from part p join message m on m.id = p.message_id \
             where p.session_id = ?1 and p.time_updated >= ?2 \
             order by p.time_created asc, p.id asc",
        )
        .map_err(|e| format!("prepare part read: {e}"))?;
    let rows = stmt
        .query_map(rusqlite::params![&session.id, since], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, Option<String>>(4)?,
            ))
        })
        .map_err(|e| format!("read parts: {e}"))?;
    for row in rows {
        let (id, message_id, created, data, role) =
            row.map_err(|e| format!("read part row: {e}"))?;
        lines.push(record(id, message_id, &session.id, created, role, &data).to_string());
    }

    Ok(JsonlChunk {
        path: Some(session.id.clone()),
        session_id: Some(session.id.clone()),
        offset: cursor as u64,
        lines,
        reset,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A store shaped like OpenCode's, built from its real DDL so a schema
    /// drift shows up here rather than as an empty chat.
    fn store() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "create table session (
                 id text primary key, project_id text not null, parent_id text,
                 slug text not null, directory text not null, title text not null,
                 version text, time_created integer not null,
                 time_updated integer not null, time_archived integer,
                 agent text, model text
             );
             create table message (
                 id text primary key, session_id text not null,
                 time_created integer not null, time_updated integer not null,
                 data text not null
             );
             create table part (
                 id text primary key, message_id text not null,
                 session_id text not null, time_created integer not null,
                 time_updated integer not null, data text not null
             );",
        )
        .unwrap();
        conn
    }

    fn add_session(conn: &Connection, id: &str, dir: &str, updated: i64, parent: Option<&str>) {
        conn.execute(
            "insert into session (id, project_id, parent_id, slug, directory, title,
                                  version, time_created, time_updated, agent, model)
             values (?1, 'proj', ?2, 'slug', ?3, 'title', '1.18.11', 1000, ?4, 'build',
                     '{\"id\":\"glm-5.2\",\"providerID\":\"zai\",\"variant\":\"default\"}')",
            rusqlite::params![id, parent, dir, updated],
        )
        .unwrap();
    }

    fn add_message(conn: &Connection, id: &str, session: &str, role: &str) {
        conn.execute(
            "insert into message (id, session_id, time_created, time_updated, data)
             values (?1, ?2, 1000, 1000, ?3)",
            rusqlite::params![id, session, format!("{{\"role\":\"{role}\"}}")],
        )
        .unwrap();
    }

    fn add_part(
        conn: &Connection,
        id: &str,
        message: &str,
        session: &str,
        created: i64,
        updated: i64,
        data: &str,
    ) {
        conn.execute(
            "insert or replace into part (id, message_id, session_id, time_created,
                                          time_updated, data)
             values (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![id, message, session, created, updated, data],
        )
        .unwrap();
    }

    fn session_of(conn: &Connection, repo: &str) -> Session {
        newest_session(conn, repo).unwrap().expect("session found")
    }

    fn parsed(chunk: &JsonlChunk) -> Vec<Value> {
        chunk
            .lines
            .iter()
            .map(|l| serde_json::from_str::<Value>(l).unwrap())
            .collect()
    }

    #[test]
    fn a_delegated_subagent_does_not_replace_the_conversation_on_screen() {
        // `task` opens a CHILD session in the same directory, and while it
        // runs it is the most recently touched row. Reading it would swap the
        // user's transcript for the subagent's mid-run.
        let conn = store();
        add_session(&conn, "ses_main", "/repo", 10, None);
        add_session(&conn, "ses_child", "/repo", 99, Some("ses_main"));
        assert_eq!(session_of(&conn, "/repo").id, "ses_main");
    }

    #[test]
    fn a_directory_opencode_never_ran_in_gets_no_session_rather_than_someone_elses() {
        let conn = store();
        add_session(&conn, "ses_other", "/somewhere/else", 10, None);
        assert!(newest_session(&conn, "/repo").unwrap().is_none());
    }

    #[test]
    fn the_first_read_leads_with_the_model_the_session_is_bound_to() {
        // The run wire carries no model at all. For someone on a BYO plan this
        // is the one fact worth confirming, so it opens the transcript.
        let conn = store();
        add_session(&conn, "ses_1", "/repo", 10, None);
        let chunk = read_session(&conn, &session_of(&conn, "/repo"), None, 0).unwrap();
        let init = &parsed(&chunk)[0];
        assert_eq!(init["type"], "session_init");
        assert_eq!(init["model"]["providerID"], "zai");
        assert_eq!(init["model"]["id"], "glm-5.2");
        assert_eq!(init["agent"], "build");
        assert_eq!(init["cwd"], "/repo");
    }

    #[test]
    fn the_users_own_prompt_is_in_the_record_even_though_the_run_wire_drops_it() {
        let conn = store();
        add_session(&conn, "ses_1", "/repo", 10, None);
        add_message(&conn, "msg_u", "ses_1", "user");
        add_message(&conn, "msg_a", "ses_1", "assistant");
        add_part(&conn, "prt_1", "msg_u", "ses_1", 100, 100, r#"{"type":"text","text":"hi"}"#);
        add_part(&conn, "prt_2", "msg_a", "ses_1", 200, 200, r#"{"type":"text","text":"hello"}"#);

        let rows = parsed(&read_session(&conn, &session_of(&conn, "/repo"), None, 0).unwrap());
        assert_eq!(rows[1]["role"], "user");
        assert_eq!(rows[1]["part"]["text"], "hi");
        assert_eq!(rows[2]["role"], "assistant");
    }

    #[test]
    fn a_part_carries_the_identity_sqlite_lifted_into_columns() {
        // Without these the adapter falls back to keying on a record's INDEX,
        // and an incremental slice renumbers every card it hands back.
        let conn = store();
        add_session(&conn, "ses_1", "/repo", 10, None);
        add_message(&conn, "msg_a", "ses_1", "assistant");
        add_part(&conn, "prt_1", "msg_a", "ses_1", 100, 100, r#"{"type":"text","text":"x"}"#);

        let rows = parsed(&read_session(&conn, &session_of(&conn, "/repo"), None, 0).unwrap());
        assert_eq!(rows[1]["part"]["id"], "prt_1");
        assert_eq!(rows[1]["part"]["messageID"], "msg_a");
        assert_eq!(rows[1]["part"]["sessionID"], "ses_1");
    }

    #[test]
    fn the_envelope_spells_the_kind_with_underscores_and_the_part_with_hyphens() {
        // Exactly what `opencode run --format json` writes, so one adapter
        // reads both this and a live run.
        let conn = store();
        add_session(&conn, "ses_1", "/repo", 10, None);
        add_message(&conn, "msg_a", "ses_1", "assistant");
        add_part(&conn, "prt_1", "msg_a", "ses_1", 100, 100, r#"{"type":"step-finish"}"#);

        let rows = parsed(&read_session(&conn, &session_of(&conn, "/repo"), None, 0).unwrap());
        assert_eq!(rows[1]["type"], "step_finish");
        assert_eq!(rows[1]["part"]["type"], "step-finish");
    }

    #[test]
    fn a_tool_that_settles_after_it_was_read_comes_back_again() {
        // The whole reason the cursor is `time_updated` and not a byte count:
        // the row that carried the REQUEST is the row that carries the RESULT.
        let conn = store();
        add_session(&conn, "ses_1", "/repo", 10, None);
        add_message(&conn, "msg_a", "ses_1", "assistant");
        add_part(
            &conn, "prt_1", "msg_a", "ses_1", 100, 100,
            r#"{"type":"tool","tool":"bash","state":{"status":"running"}}"#,
        );
        let first = read_session(&conn, &session_of(&conn, "/repo"), None, 0).unwrap();
        assert_eq!(parsed(&first)[1]["part"]["state"]["status"], "running");

        // Same row, mutated in place.
        add_part(
            &conn, "prt_1", "msg_a", "ses_1", 100, 400,
            r#"{"type":"tool","tool":"bash","state":{"status":"completed"}}"#,
        );
        let next = read_session(
            &conn,
            &session_of(&conn, "/repo"),
            Some("ses_1".into()),
            first.offset,
        )
        .unwrap();
        let rows = parsed(&next);
        assert_eq!(rows.len(), 1, "only the row that moved");
        assert_eq!(rows[0]["part"]["state"]["status"], "completed");
        assert_eq!(rows[0]["part"]["id"], "prt_1", "same id → same card");
        assert!(!next.reset);
    }

    #[test]
    fn an_idle_poll_reads_nothing_rather_than_the_boundary_row_forever() {
        let conn = store();
        add_session(&conn, "ses_1", "/repo", 10, None);
        add_message(&conn, "msg_a", "ses_1", "assistant");
        add_part(&conn, "prt_1", "msg_a", "ses_1", 100, 100, r#"{"type":"text","text":"x"}"#);

        let first = read_session(&conn, &session_of(&conn, "/repo"), None, 0).unwrap();
        let idle = read_session(
            &conn,
            &session_of(&conn, "/repo"),
            Some("ses_1".into()),
            first.offset,
        )
        .unwrap();
        assert!(idle.lines.is_empty());
        assert_eq!(idle.offset, first.offset);
        assert!(!idle.reset);
    }

    #[test]
    fn an_empty_session_delivers_its_init_once_and_not_on_every_tick() {
        // A session with no parts yet reports a cursor of 0 unless it is
        // floored, and a cursor of 0 means "start from the top" — which would
        // re-send `session_init` on every poll for as long as the model takes
        // to answer the first prompt.
        let conn = store();
        add_session(&conn, "ses_1", "/repo", 10, None);
        let first = read_session(&conn, &session_of(&conn, "/repo"), None, 0).unwrap();
        assert_eq!(first.lines.len(), 1);
        assert!(first.offset > 0);

        let again = read_session(
            &conn,
            &session_of(&conn, "/repo"),
            Some("ses_1".into()),
            first.offset,
        )
        .unwrap();
        assert!(again.lines.is_empty());
    }

    /// Against the real store on this machine, when there is one.
    ///
    /// Ignored by default — it depends on OpenCode having run here, which is
    /// true of a developer's box and not of CI. Run it with
    /// `cargo test -p aura-shell reads_this_machines_real_store -- --ignored`
    /// after an OpenCode upgrade: the in-memory schema above is a copy of
    /// OpenCode's DDL, and a copy can go stale without anything failing.
    ///
    /// It asserts shapes and never prints a record — the parts hold the
    /// user's own conversation.
    #[test]
    #[ignore]
    fn reads_this_machines_real_store() {
        let Some(db) = db_path() else {
            eprintln!("opencode has never run here — nothing to read");
            return;
        };
        let conn = open(&db).expect("open the real store read-only");
        let mut stmt = conn
            .prepare("select directory from session where parent_id is null limit 1")
            .expect("the session table still has parent_id and directory");
        let Some(dir) = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .next()
            .transpose()
            .unwrap()
        else {
            eprintln!("no sessions recorded — nothing to read");
            return;
        };

        let session = newest_session(&conn, &dir).unwrap().expect("its own session");
        let chunk = read_session(&conn, &session, None, 0).unwrap();
        assert_eq!(chunk.path.as_deref(), Some(session.id.as_str()));
        assert!(chunk.offset >= CURSOR_FLOOR as u64);

        let rows = parsed(&chunk);
        assert_eq!(rows[0]["type"], "session_init");
        for row in rows.iter().skip(1) {
            // Every reconstructed record is a real envelope: a named kind, the
            // session it belongs to, and a part carrying back the identity
            // SQLite lifted into columns.
            assert!(row["type"].is_string());
            assert_eq!(row["sessionID"], session.id.as_str());
            assert!(row["part"]["id"].is_string());
            assert!(row["part"]["type"].is_string());
            assert!(matches!(
                row["role"].as_str(),
                Some("user") | Some("assistant") | None
            ));
        }

        // A second read at the returned cursor is the idle case: nothing new.
        let idle =
            read_session(&conn, &session, Some(session.id.clone()), chunk.offset).unwrap();
        assert!(idle.lines.is_empty());
    }

    #[test]
    fn starting_a_new_session_resets_rather_than_splicing_two_conversations() {
        let conn = store();
        add_session(&conn, "ses_old", "/repo", 10, None);
        add_session(&conn, "ses_new", "/repo", 20, None);
        let chunk = read_session(
            &conn,
            &session_of(&conn, "/repo"),
            Some("ses_old".into()),
            500,
        )
        .unwrap();
        assert!(chunk.reset);
        assert_eq!(chunk.path.as_deref(), Some("ses_new"));
        // A reset reads from the top, so the new session leads with its init.
        assert_eq!(parsed(&chunk)[0]["type"], "session_init");
    }
}
