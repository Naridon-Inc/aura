//! Importer tests. Every source is exercised against a fixture built in a
//! borrowed HOME with the table and file shapes read off real installs (see
//! each module's header); `conductor.json` and `.superset/config.json` follow
//! those apps' docs.

use std::path::{Path, PathBuf};

use rusqlite::Connection;
use serde_json::json;

use super::model::{ItemKind, ItemState, OutcomeStatus};
use super::*;
use crate::manager::ChatRole;

fn write(path: &Path, text: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

fn repo(path: &Path) -> PathBuf {
    std::fs::create_dir_all(path.join(".git")).unwrap();
    path.to_path_buf()
}

/// A worktree of `repo` at `path`, laid out the way `git worktree add` does.
fn worktree(repo: &Path, path: &Path, id: &str) {
    let admin = repo.join(".git").join("worktrees").join(id);
    std::fs::create_dir_all(&admin).unwrap();
    write(&path.join(".git"), &format!("gitdir: {}\n", admin.display()));
}

fn db(path: &Path, sql: &str) -> Connection {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let conn = Connection::open(path).unwrap();
    conn.execute_batch(sql).unwrap();
    conn
}

fn ctx(home: &Path, known: &[&Path]) -> Ctx {
    let known: Vec<String> = known.iter().map(|p| path_str(p)).collect();
    Ctx::new(home.to_path_buf(), &known, ledger::Ledger::load())
}

fn item<'a>(s: &'a Scanned, key: &str) -> &'a model::Item {
    s.scan.items.iter().find(|i| i.key == key).unwrap_or_else(|| panic!("no item {key}: {:#?}", s.scan.items))
}

fn keys_of(s: &Scanned, state: ItemState) -> Vec<String> {
    s.scan.items.iter().filter(|i| i.state == state).map(|i| i.key.clone()).collect()
}

fn run_all(source: &str, home: &Path, known: &[&Path], room: usize) -> RunReport {
    let mut c = ctx(home, known);
    let keys: Vec<String> = scan(source, &c).unwrap().scan.items.iter().map(|i| i.key.clone()).collect();
    let mut ticks = 0;
    let report = run(source, &mut c, &keys, room, &mut |_| ticks += 1).unwrap();
    assert!(ticks > keys.len(), "a tick per item plus the last one");
    report
}

// ── shared pieces ────────────────────────────────────────────────────────

#[test]
fn sqlite_ro_reads_a_path_with_spaces_and_never_writes() {
    let home = crate::test_home::borrow();
    let path = home.path().join("App Support #1").join("state?.db");
    drop(db(&path, "create table t(x); insert into t values (1), (2);"));
    let before = std::fs::read(&path).unwrap();

    let conn = sqlite_ro::open(&path).unwrap();
    let n: i64 = conn.query_row("select count(*) from t", [], |r| r.get(0)).unwrap();
    assert_eq!(n, 2);
    assert!(conn.execute("insert into t values (3)", []).is_err(), "opened read-only");
    assert!(sqlite_ro::has_table(&conn, "t"));
    assert_eq!(sqlite_ro::columns(&conn, "t"), vec!["x".to_string()]);
    drop(conn);
    assert_eq!(std::fs::read(&path).unwrap(), before);
    assert!(!path.with_file_name("state?.db-wal").exists(), "no WAL left behind");
}

#[test]
fn sqlite_ro_sees_rows_still_in_a_live_wal() {
    let home = crate::test_home::borrow();
    let path = home.path().join("live.db");
    let writer = db(&path, "create table t(x); insert into t values (1);");
    let mode: String = writer.query_row("pragma journal_mode=wal", [], |r| r.get(0)).unwrap();
    assert_eq!(mode, "wal");
    let _: i64 = writer.query_row("pragma wal_autocheckpoint=0", [], |r| r.get(0)).unwrap();
    writer.execute("insert into t values (2)", []).unwrap();
    assert!(path.with_file_name("live.db-wal").metadata().unwrap().len() > 0);
    let conn = sqlite_ro::open(&path).unwrap();
    let n: i64 = conn.query_row("select count(*) from t", [], |r| r.get(0)).unwrap();
    assert_eq!(n, 2, "the uncheckpointed row is read too");
    drop(writer);
}

#[test]
fn parse_time_reads_every_shape_the_sources_write() {
    let iso = conductor::parse_time("2026-10-02T08:14:51.123Z").unwrap();
    assert_eq!(conductor::parse_time("2026-10-02 08:14:51.123"), Some(iso));
    assert_eq!(conductor::parse_time("2026-10-02 08:14:51"), Some(iso - 123));
    assert_eq!(conductor::parse_time("1790000000"), Some(1_790_000_000_000));
    assert_eq!(conductor::parse_time("1790000000123"), Some(1_790_000_000_123));
    assert_eq!(conductor::parse_time(""), None);
}

#[test]
fn worktree_of_only_accepts_that_repos_worktrees() {
    let home = crate::test_home::borrow();
    let a = repo(&home.path().join("a"));
    let b = repo(&home.path().join("b"));
    let w = home.path().join("w");
    worktree(&a, &w, "w");
    assert!(conductor::worktree_of(&w, &a));
    assert!(!conductor::worktree_of(&w, &b));
    assert!(!conductor::worktree_of(&a, &a), "a repo is not its own worktree");
}

#[test]
fn ledger_counts_an_import_only_while_its_target_exists() {
    let home = crate::test_home::borrow();
    let mut l = ledger::Ledger::load();
    let target = home.path().join("ws");
    std::fs::create_dir_all(&target).unwrap();
    l.record("conductor", "workspace:1", ItemKind::Workspace, &path_str(&target));
    l.record("conductor", "chat:1", ItemKind::Chat, "no-such-session");
    l.save().unwrap();
    let l = ledger::Ledger::load();
    assert!(l.done("conductor", "workspace:1").is_some());
    assert!(l.done("conductor", "chat:1").is_none(), "the chat it made is gone, so it can come over again");
    assert_eq!(l.count("conductor"), 1);
    assert_eq!(l.count("cursor"), 0);
    std::fs::remove_dir(&target).unwrap();
    assert!(ledger::Ledger::load().done("conductor", "workspace:1").is_none());
}

#[test]
fn save_chat_keeps_the_latest_turns_and_archives_the_rest() {
    let home = crate::test_home::borrow();
    let root = repo(&home.path().join("proj"));
    let turns: Vec<_> = (0..450)
        .map(|i| crate::cmd_agent_history::PrerollTurn {
            role: if i % 2 == 0 { "user".into() } else { "assistant".into() },
            text: format!("turn {i}"),
            ts: 1_790_000_000_000 + i as i64 * 1000,
            tool_calls: Vec::new(),
            thinking: None,
        })
        .collect();
    let id = apply::save_chat(apply::ChatImport {
        source: "cursor",
        source_name: "Cursor",
        source_key: "c/1".into(),
        title: String::new(),
        root: path_str(&root),
        created_ms: 1_790_000_000_000,
        updated_ms: 1_790_000_450_000,
        brain: "cli:cursor",
        turns,
        raw: vec!["{}".into()],
    })
    .unwrap();
    let s = crate::manager::persist::load(&id).unwrap();
    assert_eq!(s.chat.len(), apply::KEEP_TURNS + 1, "the kept turns plus the note");
    assert!(matches!(s.chat[0].role, ChatRole::Manager));
    assert!(s.chat[0].text.contains("Cursor — 450 messages"), "{}", s.chat[0].text);
    assert!(s.chat[0].text.contains("the 50 before them are kept"), "{}", s.chat[0].text);
    assert_eq!(s.chat[1].text, "turn 50");
    assert_eq!(s.chat.last().unwrap().brain.as_deref(), Some("cli:cursor"));
    assert_eq!(s.objective, "turn 0", "no title: named after the first message");
    assert_eq!(s.projects[0].root, path_str(&root));
    assert_eq!(s.created_at, 1_790_000_000);
    let copy = home.path().join(".aura").join("imports").join("cursor");
    assert_eq!(std::fs::read_dir(copy).unwrap().count(), 1, "a raw copy is kept");
}

#[test]
fn save_chat_refuses_an_empty_conversation() {
    let _home = crate::test_home::borrow();
    let err = apply::save_chat(apply::ChatImport {
        source: "void",
        source_name: "Void",
        source_key: "x".into(),
        title: "t".into(),
        root: "/tmp".into(),
        created_ms: 0,
        updated_ms: 0,
        brain: "cli:void",
        turns: Vec::new(),
        raw: Vec::new(),
    })
    .unwrap_err();
    assert!(err.contains("no messages"));
}

#[test]
fn merge_scripts_fills_only_what_aura_has_not_set() {
    let home = crate::test_home::borrow();
    let root = repo(&home.path().join("r"));
    let mut mine = crate::cmd_repo_settings::load_settings(&root);
    mine.setup = Some("make setup".into());
    crate::cmd_repo_settings::save_settings(&root, &mine).unwrap();
    let wrote = apply::merge_scripts(
        &root,
        &apply::Scripts { setup: Some("npm i".into()), run: Some("npm run dev".into()), ..Default::default() },
    )
    .unwrap();
    assert_eq!(wrote, vec!["run"]);
    let after = crate::cmd_repo_settings::load_settings(&root);
    assert_eq!(after.setup.as_deref(), Some("make setup"), "Aura's own value stays");
    assert_eq!(after.run.as_deref(), Some("npm run dev"));
}

#[test]
fn parse_migrate_reads_the_cli_answer() {
    let m = apply::parse_migrate(r#"{"sources":[{"path":".cursorrules"},{"path":"GEMINI.md"}],"applied":true,"wrote_agents_md":true}"#).unwrap();
    assert_eq!(m, apply::Migrated { wrote: true, sources: 2 });
    assert!(apply::parse_migrate("not json").is_err());
}

#[test]
fn rule_files_are_listed_for_the_rules_item() {
    let home = crate::test_home::borrow();
    let root = repo(&home.path().join("r"));
    write(&root.join(".cursorrules"), "x");
    write(&root.join(".cursor/rules/style.mdc"), "x");
    let files = apply::rule_files(&root);
    assert_eq!(files.len(), 2, "{files:?}");
    let c = ctx(home.path(), &[]);
    let it = rules_item(&c, "cursor", &root).unwrap();
    assert_eq!(it.kind, ItemKind::Rules);
    assert_eq!(it.detail, "2 rule files → AGENTS.md");
}

// ── Conductor ────────────────────────────────────────────────────────────

fn conductor_fixture(home: &Path) -> (PathBuf, PathBuf) {
    let root = repo(&home.join("code").join("my app"));
    write(&root.join("conductor.json"), r#"{"scripts":{"setup":"ignored","run":"bun dev"}}"#);
    let ws = home.join("conductor").join("workspaces").join("app").join("oslo");
    worktree(&root, &ws, "oslo");
    let gone = home.join("conductor").join("workspaces").join("app").join("gone");
    let path = conductor::db_path(home);
    let conn = db(
        &path,
        "create table repos(id text, name text, root_path text, default_branch text, setup_script text, run_script text, archive_script text, display_order integer);
         create table workspaces(id text, repository_id text, workspace_path text, directory_name text, workspace_name text, branch text, state text, pinned_at text, updated_at text, created_at text);
         create table sessions(id text, workspace_id text, title text, agent_type text, created_at text, last_message_at text, updated_at text);
         create table session_messages(id integer primary key, session_id text, role text, content text, created_at text);",
    );
    conn.execute(
        "insert into repos values ('r1', 'app', ?1, 'main', 'bun i', null, null, 0)",
        [path_str(&root)],
    )
    .unwrap();
    conn.execute(
        "insert into workspaces values ('w1', 'r1', ?1, 'oslo', 'Oslo', 'feat/oslo', 'ready', '2026-10-01 10:00:00', '2026-10-02 10:00:00', '2026-10-01 09:00:00')",
        [path_str(&ws)],
    )
    .unwrap();
    conn.execute(
        "insert into workspaces values ('w2', 'r1', ?1, 'gone', 'Gone', 'b', 'archived', null, null, null)",
        [path_str(&gone)],
    )
    .unwrap();
    conn.execute_batch(
        "insert into sessions values ('s1', 'w1', 'Fix login', 'claude', '2026-10-01 09:30:00', '2026-10-01 09:40:00', null);
         insert into sessions values ('s2', 'w1', 'Untitled', 'claude', '2026-10-01 09:00:00', null, null);
         insert into sessions values ('s3', 'w1', 'Other', 'gemini', '2026-10-01 09:00:00', null, null);
         insert into session_messages(session_id, role, content, created_at) values ('s3', 'user', 'hi', '2026-10-01 09:00:00');",
    )
    .unwrap();
    let lines = [
        ("user", "Why does login fail?".to_string()),
        ("assistant", json!({"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Reading the handler."},{"type":"tool_use","id":"toolu_1","name":"Read","input":{"file_path":"auth.rs"}}]},"parent_tool_use_id":null}).to_string()),
        ("assistant", json!({"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"SUBAGENT STEP"}]},"parent_tool_use_id":"toolu_9"}).to_string()),
        ("assistant", json!({"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"fn login() {}"}]},"parent_tool_use_id":null}).to_string()),
        ("assistant", json!({"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"The token check is inverted."}]},"parent_tool_use_id":null}).to_string()),
        ("assistant", json!({"type":"result","subtype":"success","result":"done"}).to_string()),
    ];
    for (role, content) in lines {
        conn.execute(
            "insert into session_messages(session_id, role, content, created_at) values ('s1', ?1, ?2, '2026-10-01 09:31:00')",
            [role, content.as_str()],
        )
        .unwrap();
    }
    (root, ws)
}

#[test]
fn conductor_scan_lists_repos_workspaces_chats_and_scripts() {
    let home = crate::test_home::borrow();
    let (root, ws) = conductor_fixture(home.path());
    let s = scan("conductor", &ctx(home.path(), &[])).unwrap();
    assert!(s.scan.found);

    let r = item(&s, "repo:r1");
    assert_eq!((r.title.as_str(), r.state), ("app", ItemState::Ready));
    assert_eq!(r.detail, "main · 1 workspace · 2 chats", "the empty one isn't counted");

    let w = item(&s, "workspace:w1");
    assert_eq!((w.title.as_str(), w.state), ("Oslo", ItemState::Ready));
    assert_eq!(w.root.as_deref(), Some(path_str(&ws).as_str()));
    assert_eq!(item(&s, "workspace:w2").state, ItemState::Unavailable);

    let c = item(&s, "chat:s1");
    assert_eq!((c.title.as_str(), c.state), ("Fix login", ItemState::Ready));
    assert_eq!(c.detail, "Claude Code · 6 messages · Oslo");
    assert_eq!(c.root.as_deref(), Some(path_str(&ws).as_str()), "lands in its workspace");
    assert_eq!(item(&s, "chat:s3").state, ItemState::Unavailable, "an agent Aura can't read");
    assert!(s.scan.items.iter().all(|i| i.key != "chat:s2"), "empty chats are left out");

    let sc = item(&s, "scripts:r1");
    assert_eq!(sc.detail, "setup, run");
    match s.plans.get("scripts:r1") {
        Some(Plan::Scripts { scripts, .. }) => {
            assert_eq!(scripts.setup.as_deref(), Some("bun i"), "Conductor's own setting wins over the file");
            assert_eq!(scripts.run.as_deref(), Some("bun dev"));
        }
        _ => panic!("scripts plan"),
    }
    assert!(s.scan.notes.iter().any(|n| n.contains("1 chat with no messages")));
    let _ = root;
}

#[test]
fn conductor_import_is_complete_and_idempotent() {
    let home = crate::test_home::borrow();
    let (root, ws) = conductor_fixture(home.path());
    let report = run_all("conductor", home.path(), &[], 10);
    let status = |k: &str| report.outcomes.iter().find(|o| o.key == k).map(|o| o.status);
    assert_eq!(status("repo:r1"), Some(OutcomeStatus::Imported));
    assert_eq!(status("workspace:w1"), Some(OutcomeStatus::Imported));
    assert_eq!(status("chat:s1"), Some(OutcomeStatus::Imported));
    assert_eq!(status("scripts:r1"), Some(OutcomeStatus::Imported));
    assert_eq!(status("workspace:w2"), Some(OutcomeStatus::Skipped));
    assert_eq!(status("chat:s3"), Some(OutcomeStatus::Skipped));

    assert!(report.adopt.iter().any(|a| a.project && a.root == path_str(&root)));
    let adopted = report.adopt.iter().find(|a| !a.project).unwrap();
    assert_eq!(adopted.root, path_str(&ws));
    assert_eq!(adopted.name.as_deref(), Some("Oslo"));
    assert!(adopted.pinned);

    let chat_id = report.outcomes.iter().find(|o| o.key == "chat:s1").unwrap().aura_ref.clone().unwrap();
    let s = crate::manager::persist::load(&chat_id).unwrap();
    assert_eq!(s.objective, "Fix login");
    let texts: Vec<&str> = s.chat.iter().map(|t| t.text.as_str()).collect();
    assert!(texts.contains(&"Why does login fail?"));
    assert!(!texts.iter().any(|t| t.contains("SUBAGENT")), "subagent steps stay out: {texts:?}");
    let with_tool = s.chat.iter().find(|t| !t.tool_calls.is_empty()).expect("the tool call came over");
    assert_eq!(with_tool.tool_calls[0].name, "Read");
    assert_eq!(with_tool.tool_calls[0].result.as_ref().map(|r| r.content.as_str()), Some("fn login() {}"));
    assert_eq!(with_tool.brain.as_deref(), Some("cli:claude_code"));
    assert_eq!(crate::cmd_repo_settings::load_settings(&root).run.as_deref(), Some("bun dev"));

    // Second run, with the repo now in Aura's list: nothing comes twice.
    let again = run_all("conductor", home.path(), &[&root], 10);
    assert!(again.outcomes.iter().all(|o| o.status != OutcomeStatus::Imported), "{:#?}", again.outcomes);
    assert!(again.adopt.is_empty());
    assert_eq!(crate::manager::persist::list_session_ids().len(), 1);
}

#[test]
fn a_full_project_list_is_never_pushed_over() {
    let home = crate::test_home::borrow();
    conductor_fixture(home.path());
    let report = run_all("conductor", home.path(), &[], 0);
    let repo = report.outcomes.iter().find(|o| o.key == "repo:r1").unwrap();
    assert_eq!(repo.status, OutcomeStatus::Skipped);
    assert!(repo.reason.as_deref().unwrap_or("").contains("project list is full"));
    let ws = report.outcomes.iter().find(|o| o.key == "workspace:w1").unwrap();
    assert_eq!(ws.status, OutcomeStatus::Skipped, "its repo couldn't be added");
    assert!(report.adopt.is_empty());
}

// ── Superset ─────────────────────────────────────────────────────────────

#[test]
fn superset_lists_projects_worktrees_and_config_scripts() {
    let home = crate::test_home::borrow();
    let root = repo(&home.path().join("src").join("site"));
    write(&root.join(".superset/config.json"), r#"{"setup":["bun install","cp .env.example .env"],"teardown":"docker compose down"}"#);
    let wt = home.path().join(".superset").join("worktrees").join("site").join("blue");
    worktree(&root, &wt, "blue");
    let conn = db(
        &home.path().join(".superset").join("local.db"),
        "create table projects(id text, main_repo_path text, name text, default_branch text, worktree_base_dir text);
         create table worktrees(id text, project_id text, path text, branch text, base_branch text, created_at integer);
         create table workspaces(id text, project_id text, worktree_id text, type text, branch text, name text, created_at integer, updated_at integer, last_opened_at integer, is_unnamed integer);",
    );
    conn.execute("insert into projects values ('p1', ?1, 'site', 'main', null)", [path_str(&root)]).unwrap();
    conn.execute("insert into worktrees values ('t1', 'p1', ?1, 'blue', 'main', 1790000000000)", [path_str(&wt)]).unwrap();
    conn.execute_batch("insert into workspaces values ('x1', 'p1', 't1', 'worktree', 'blue', 'Blue sky', 1790000000000, 1790000001000, 1790000002000, 0);").unwrap();
    drop(conn);
    // A second host database with a project already listed above.
    let host = db(
        &home.path().join(".superset").join("host").join("h1").join("host.db"),
        "create table projects(id text, repo_path text, repo_name text, repo_url text, name text);
         create table workspaces(id text, project_id text, worktree_path text, branch text, name text, type text, created_at integer, updated_at integer);",
    );
    host.execute("insert into projects values ('hp', ?1, 'site', '', 'site')", [path_str(&root)]).unwrap();
    drop(host);

    let s = scan("superset", &ctx(home.path(), &[])).unwrap();
    let key = format!("repo:{}", path_str(&root));
    assert_eq!(item(&s, &key).detail, "main · 1 workspace");
    assert_eq!(s.scan.items.iter().filter(|i| i.kind == ItemKind::Repo).count(), 1, "listed once");
    let w = item(&s, &format!("workspace:{}", path_str(&wt)));
    assert_eq!((w.title.as_str(), w.state), ("Blue sky", ItemState::Ready));
    assert_eq!(w.when, Some(1_790_000_002_000));
    match s.plans.get(&format!("scripts:{}", path_str(&root))) {
        Some(Plan::Scripts { scripts, .. }) => {
            assert_eq!(scripts.setup.as_deref(), Some("bun install\ncp .env.example .env"));
            assert_eq!(scripts.archive.as_deref(), Some("docker compose down"));
        }
        _ => panic!("scripts plan"),
    }
    assert!(keys_of(&s, ItemState::Ready).iter().all(|k| !k.starts_with("chat:")));
}

// ── Cursor ───────────────────────────────────────────────────────────────

fn cursor_fixture(home: &Path) -> PathBuf {
    let root = repo(&home.join("work").join("api"));
    write(&root.join(".cursor/mcp.json"), r#"{"mcpServers":{"linear":{"command":"npx","args":["-y","linear-mcp"],"env":{"LINEAR_TOKEN":"do-not-show"}}}}"#);
    let user = vscode_folders::user_dir(home, "Cursor");
    let storage = user.join("workspaceStorage").join("abc123");
    let uri = url::Url::from_directory_path(&root).unwrap().to_string();
    write(&storage.join("workspace.json"), &json!({ "folder": uri.trim_end_matches('/') }).to_string());
    let per = db(&storage.join("state.vscdb"), "create table ItemTable(key text unique, value blob);");
    per.execute(
        "insert into ItemTable values ('composer.composerData', ?1)",
        [json!({"allComposers":[{"composerId":"c1","createdAt":1790000000000_i64,"type":"head"}],"selectedComposerId":"c1"}).to_string()],
    )
    .unwrap();
    drop(per);

    let g = db(&user.join("globalStorage").join("state.vscdb"), "create table cursorDiskKV(key text unique on conflict replace, value blob);");
    let put = |k: String, v: serde_json::Value| {
        g.execute("insert into cursorDiskKV values (?1, ?2)", [k, v.to_string()]).unwrap();
    };
    put(
        "composerData:c1".into(),
        json!({"_v":10,"composerId":"c1","name":"Rate limiter","createdAt":1790000000000_i64,"lastUpdatedAt":1790000300000_i64,
               "fullConversationHeadersOnly":[{"bubbleId":"b1","type":1},{"bubbleId":"b2","type":2},{"bubbleId":"b3","type":2},{"bubbleId":"b4","type":2}]}),
    );
    put("bubbleId:c1:b1".into(), json!({"type":1,"text":"Add a rate limiter","createdAt":"2026-09-21T10:00:00.000Z"}));
    put("bubbleId:c1:b2".into(), json!({"type":2,"text":"","allThinkingBlocks":[{"thinking":"Token bucket fits."}],
        "toolFormerData":{"name":"read_file","rawArgs":"{\"path\":\"limit.rs\"}","result":"// empty","status":"completed","toolCallId":"call_1"}}));
    put("bubbleId:c1:b3".into(), json!({"type":2,"text":"Added a token bucket."}));
    put("bubbleId:c1:b4".into(), json!({"type":2,"text":"","toolFormerData":{"name":"run_terminal_cmd","params":null,"rawArgs":null,"result":"exit 1","status":"error","toolCallId":null}}));
    // Newer format: the body is an encrypted blob.
    put("composerData:c2".into(), json!({"_v":13,"composerId":"c2","createdAt":1790000000000_i64,"conversationState":"~opaque~","blobEncryptionKey":"k"}));
    // Opened and never used.
    put("composerData:c3".into(), json!({"_v":10,"composerId":"c3","createdAt":1790000000000_i64,"fullConversationHeadersOnly":[]}));
    // Headers name a folder that is gone.
    put("composerData:c4".into(), json!({"_v":10,"composerId":"c4","createdAt":1790000000000_i64,"fullConversationHeadersOnly":[{"bubbleId":"x","type":1}]}));
    put("bubbleId:c4:x".into(), json!({"type":1,"text":"hi"}));
    g.execute_batch("create table composerHeaders(composerId text, workspaceId text, createdAt integer, value text);").unwrap();
    g.execute(
        "insert into composerHeaders values ('c4', 'w', 0, ?1)",
        [json!({"name":"Old","workspaceIdentifier":{"id":"w","uri":{"fsPath":"/nonexistent/old repo","scheme":"file"}}}).to_string()],
    )
    .unwrap();
    root
}

#[test]
fn cursor_scan_maps_chats_to_their_folder_and_explains_what_it_skips() {
    let home = crate::test_home::borrow();
    let root = cursor_fixture(home.path());
    let s = scan("cursor", &ctx(home.path(), &[])).unwrap();

    let r = item(&s, &format!("repo:{}", path_str(&root)));
    assert_eq!(r.detail, format!("1 chat · ~/work/api"));
    let c = item(&s, "chat:c1");
    assert_eq!((c.title.as_str(), c.state), ("Rate limiter", ItemState::Ready));
    assert_eq!(c.detail, "4 messages · api");
    assert_eq!(c.when, Some(1_790_000_300_000));
    assert_eq!(c.root.as_deref(), Some(path_str(&root).as_str()));
    let old = item(&s, "chat:c4");
    assert_eq!((old.title.as_str(), old.state), ("Old", ItemState::Unavailable));
    assert!(s.scan.items.iter().all(|i| i.key != "chat:c2" && i.key != "chat:c3"));
    assert!(s.scan.notes.iter().any(|n| n.contains("1 newer Cursor chat is stored in an encrypted format")), "{:?}", s.scan.notes);
    assert!(s.scan.notes.iter().any(|n| n.contains("1 empty chat is left out")));

    let mcp = s.scan.items.iter().find(|i| i.kind == ItemKind::Mcp).expect("project MCP server listed");
    assert_eq!(mcp.title, "linear");
    assert_eq!(mcp.detail, "npx -y linear-mcp · 1 env variable");
    assert!(!serde_json::to_string(&s.scan).unwrap().contains("do-not-show"), "env values never leave Rust");
}

#[test]
fn cursor_chat_comes_over_with_tools_and_thinking() {
    let home = crate::test_home::borrow();
    let root = cursor_fixture(home.path());
    let s = scan("cursor", &ctx(home.path(), &[])).unwrap();
    let Some(Plan::Chat(ChatPlan::Cursor(r))) = s.plans.get("chat:c1") else { panic!("chat plan") };
    let c = cursor::load_chat(r).unwrap();
    assert_eq!(c.root, path_str(&root));
    assert_eq!(c.raw.len(), 5, "the composer plus each bubble");
    assert_eq!(c.turns.len(), 2, "one ask, one reply");
    assert_eq!(c.turns[0].text, "Add a rate limiter");
    let reply = &c.turns[1];
    assert_eq!(reply.text, "Added a token bucket.");
    assert_eq!(reply.thinking.as_deref(), Some("Token bucket fits."));
    assert_eq!(reply.tool_calls.len(), 2);
    assert_eq!(reply.tool_calls[0].input, json!({"path":"limit.rs"}));
    assert!(!reply.tool_calls[0].result.as_ref().unwrap().is_error);
    assert!(reply.tool_calls[1].result.as_ref().unwrap().is_error);
}

// ── Void ─────────────────────────────────────────────────────────────────

#[test]
fn void_threads_find_their_repo_from_the_files_they_touched() {
    let home = crate::test_home::borrow();
    let root = repo(&home.path().join("proj"));
    std::fs::create_dir_all(root.join("src")).unwrap();
    let file = url::Url::from_file_path(root.join("src").join("main.rs")).unwrap().to_string();
    let mut snapshot = serde_json::Map::new();
    snapshot.insert(file.clone(), json!({}));
    let threads = json!({
        "t1": {"id":"t1","createdAt":"2026-09-01T10:00:00.000Z","lastModified":"2026-09-01T11:00:00.000Z","filesWithUserChanges":[],"state":{},
               "messages":[
                   {"role":"user","content":"full prompt","displayContent":"Rename main","selections":[],"state":{}},
                   {"role":"assistant","displayContent":"On it.","reasoning":"Simple rename.","anthropicReasoning":null},
                   {"role":"tool","type":"success","name":"edit_file","id":"e1","params":{},"rawParams":{"uri":file},"result":{"ok":true},"content":"edited"},
                   {"role":"tool","type":"tool_error","name":"run_command","id":"e2","params":{},"rawParams":{},"result":"boom","content":""},
                   {"role":"checkpoint","type":"user_edit","userModifications":{},"voidFileSnapshotOfURI":snapshot}
               ]},
        "t2": {"id":"t2","createdAt":"2026-09-02T10:00:00.000Z","lastModified":"2026-09-02T10:00:00.000Z","filesWithUserChanges":[],"state":{},
               "messages":[{"role":"user","content":"hi","displayContent":"hi","selections":[],"state":{}}]},
        "t3": {"id":"t3","createdAt":"2026-09-03T10:00:00.000Z","lastModified":"2026-09-03T10:00:00.000Z","filesWithUserChanges":[],"state":{},"messages":[]}
    });
    let conn = db(&void::db_path(home.path()), "create table ItemTable(key text unique, value blob);");
    conn.execute("insert into ItemTable values ('void.chatThreadStorageII', ?1)", [threads.to_string()]).unwrap();
    drop(conn);

    let s = scan("void", &ctx(home.path(), &[])).unwrap();
    let t1 = item(&s, "chat:t1");
    assert_eq!((t1.title.as_str(), t1.state), ("Chat in proj", ItemState::Ready));
    assert_eq!(t1.root.as_deref(), Some(path_str(&root).as_str()));
    assert_eq!(t1.detail, "4 messages · proj");
    assert_eq!(item(&s, "chat:t2").state, ItemState::Unavailable, "touched no file");
    assert!(s.scan.notes.iter().any(|n| n.contains("1 empty chat")));
    assert_eq!(item(&s, &format!("repo:{}", path_str(&root))).state, ItemState::Ready);

    let Some(Plan::Chat(ChatPlan::Void(r))) = s.plans.get("chat:t1") else { panic!("chat plan") };
    let c = void::load_chat(r).unwrap();
    assert_eq!(c.turns.len(), 2);
    assert_eq!(c.turns[0].text, "Rename main", "what the person typed, not the expanded prompt");
    assert_eq!(c.turns[1].thinking.as_deref(), Some("Simple rename."));
    let calls = &c.turns[1].tool_calls;
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[0].result.as_ref().unwrap().content, "edited");
    assert!(calls[1].result.as_ref().unwrap().is_error);
    assert_eq!(calls[1].result.as_ref().unwrap().content, "boom");
}

// ── Zed ──────────────────────────────────────────────────────────────────

/// A real zstd frame (made with the `zstd` tool) of a small 0.3.0 thread
/// whose project snapshot names `/nonexistent/zed "fixture" repo`.
const ZED_THREAD_ZSTD: &str = "28b52ffd647a01b50b00c617461f408f73441d1111ab4d3213164d874c072f1c07821ca5a2578d98b23b8a626e3b003b003f0099532ba4fe009fab9a4bd8a58657520d6672797b63cbe8b81d65e4ce23fa76ea3d6b8d678f765e89635eebcee7f27457b3936eb09778fbc27efd2cddbebdf0b26464e277a7be3dbbf37a89e7e32eb54b9376d7a5eced4daff8a68b9b77bef05513e576be7d2d177bb901a564fc91c45791529149100fcf013d508322460409a048602040043751db8ebae8d7a2bc8b3bb5d60a218d4d65cd9a00c035b15a86ae6a9f72ce9d9669d4dc90f2ce094ad97720b52e9d01f5d05378a0b747f978aec57159ae79adb7ed9aa77e923b97d7cee6d24edad8ab2e35d46606fcb08d320e766757a6bcc8095f2ef2d491a5c8794dd0bd0e252020c69073b407eb03a182324e37e4d63c9a02972c87ba403603e08bef7d2c9f76a9c76c6b86553680d4cf41c64a97b51223d0d76a9e66e25049518603996178ede34f691cbe8d5580beb1045c354cebf6f416529ee0b19ca5ca68fbc2c0";

fn unhex(s: &str) -> Vec<u8> {
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
}

fn zed_thread_json(folder: &Path) -> String {
    json!({
        "title": "Fix the parser",
        "messages": [
            {"User": {"id": "u1", "content": [{"Text": "why does it fail?"}, {"Mention": {"uri": {"File": {"abs_path": "/p/a.rs"}}, "content": "fn a() {}"}}]}},
            {"Agent": {"content": [{"Text": "Looking."}, {"ToolUse": {"id": "t1", "name": "read_file", "raw_input": "{\"path\":\"a.rs\"}", "input": {"path": "a.rs"}, "is_input_complete": true}}],
                       "tool_results": {"t1": {"tool_use_id": "t1", "tool_name": "read_file", "is_error": false, "content": {"Text": "fn a() {}"}, "output": null}}}},
            {"Agent": {"content": [{"Thinking": {"text": "It's the escape.", "signature": null}}, {"Text": "Found it."}], "tool_results": {}}},
            "Resume"
        ],
        "updated_at": "2026-10-01T10:00:00Z",
        "initial_project_snapshot": {"worktree_snapshots": [{"worktree_path": path_str(folder), "git_state": null}], "timestamp": "2026-10-01T10:00:00Z"},
        "version": "0.3.0"
    })
    .to_string()
}

#[test]
fn zed_snapshot_folder_reads_compressed_and_plain_threads() {
    let blob = unhex(ZED_THREAD_ZSTD);
    let mut r = zed_reader(&blob, "zstd");
    assert_eq!(zed::snapshot_folder(&mut *r), Some(PathBuf::from("/nonexistent/zed \"fixture\" repo")));
    let plain = zed_thread_json(Path::new("/x/y z"));
    let mut r = zed_reader(plain.as_bytes(), "json");
    assert_eq!(zed::snapshot_folder(&mut *r), Some(PathBuf::from("/x/y z")));
    // Chunk boundaries can split the marker anywhere.
    struct Drip<'a>(&'a [u8]);
    impl std::io::Read for Drip<'_> {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            let n = self.0.len().min(7).min(buf.len());
            buf[..n].copy_from_slice(&self.0[..n]);
            self.0 = &self.0[n..];
            Ok(n)
        }
    }
    assert_eq!(zed::snapshot_folder(&mut Drip(plain.as_bytes())), Some(PathBuf::from("/x/y z")));
    assert_eq!(zed::snapshot_folder(&mut Drip(br#"{"title":"no snapshot"}"#)), None);
}

fn zed_reader<'a>(data: &'a [u8], kind: &str) -> Box<dyn std::io::Read + 'a> {
    zed::thread_reader_for_tests(kind, data).unwrap()
}

#[test]
fn zed_threads_and_folders_come_over() {
    let home = crate::test_home::borrow();
    let root = repo(&home.path().join("code").join("lang"));
    let t = db(
        &zed::threads_db(home.path()),
        "create table threads(id text primary key, summary text not null, updated_at text not null, data_type text not null, data blob not null, parent_id text, folder_paths text, folder_paths_order text, created_at text);",
    );
    t.execute(
        "insert into threads values ('z1', 'Fix the parser', '2026-10-01T10:00:00Z', 'json', ?1, null, null, null, '2026-10-01T09:00:00Z')",
        [zed_thread_json(&root).into_bytes()],
    )
    .unwrap();
    t.execute(
        "insert into threads values ('z2', 'Elsewhere', '2026-09-01T10:00:00Z', 'zstd', ?1, null, '', null, null)",
        [unhex(ZED_THREAD_ZSTD)],
    )
    .unwrap();
    drop(t);
    let w = db(&zed::workspace_db(home.path()), "create table workspaces(workspace_id integer primary key, paths text, remote_connection_id integer, timestamp text);");
    w.execute("insert into workspaces(paths, timestamp) values (?1, '2026-10-01 10:00:00')", [path_str(&root)]).unwrap();
    w.execute("insert into workspaces(paths, remote_connection_id) values ('/remote/box', 1)", []).unwrap();
    drop(w);

    let s = scan("zed", &ctx(home.path(), &[])).unwrap();
    let z1 = item(&s, "chat:z1");
    assert_eq!((z1.title.as_str(), z1.state), ("Fix the parser", ItemState::Ready));
    assert_eq!(z1.root.as_deref(), Some(path_str(&root).as_str()));
    assert_eq!(item(&s, "chat:z2").state, ItemState::Unavailable, "its folder isn't here");
    assert_eq!(item(&s, &format!("repo:{}", path_str(&root))).detail, "1 thread · ~/code/lang");
    assert!(s.scan.items.iter().all(|i| !i.key.contains("/remote/box")));

    let Some(Plan::Chat(ChatPlan::Zed(r))) = s.plans.get("chat:z1") else { panic!("chat plan") };
    let c = zed::load_chat(r).unwrap();
    assert_eq!(c.turns.len(), 2);
    assert_eq!(c.turns[0].text, "why does it fail? @/p/a.rs");
    let reply = &c.turns[1];
    assert_eq!(reply.text, "Looking.\n\nFound it.");
    assert_eq!(reply.thinking.as_deref(), Some("It's the escape."));
    assert_eq!(reply.tool_calls[0].result.as_ref().unwrap().content, "fn a() {}");

    let Some(Plan::Chat(ChatPlan::Zed(r2))) = s.plans.get("chat:z2") else { panic!("chat plan") };
    assert_eq!(zed::load_chat(r2).unwrap().turns.len(), 2, "the compressed thread decodes too");
}

// ── Windsurf / detection ─────────────────────────────────────────────────

#[test]
fn windsurf_brings_repos_and_says_its_chats_stay() {
    let home = crate::test_home::borrow();
    let root = repo(&home.path().join("w").join("svc"));
    write(&root.join(".windsurfrules"), "be brief");
    let storage = vscode_folders::user_dir(home.path(), "Windsurf").join("workspaceStorage").join("h");
    write(&storage.join("workspace.json"), &json!({"folder": url::Url::from_file_path(&root).unwrap().to_string()}).to_string());
    let gone = vscode_folders::user_dir(home.path(), "Windsurf").join("workspaceStorage").join("g");
    write(&gone.join("workspace.json"), r#"{"folder":"file:///nonexistent/old"}"#);
    write(&home.path().join(".codeium/windsurf/cascade/a.pb"), "x");
    write(&home.path().join(".codeium/windsurf/cascade/b.pb"), "x");
    write(&home.path().join(".codeium/windsurf/memories/global_rules.md"), "x");

    let s = scan("windsurf", &ctx(home.path(), &[&root])).unwrap();
    assert_eq!(item(&s, &format!("repo:{}", path_str(&root))).state, ItemState::Done, "already in Aura");
    assert_eq!(item(&s, &format!("rules:{}", path_str(&root))).detail, ".windsurfrules → AGENTS.md");
    assert!(s.scan.notes.iter().any(|n| n.contains("2 conversations encrypted")));
    assert!(s.scan.notes.iter().any(|n| n.contains("global_rules.md")));
    assert!(s.scan.notes.iter().any(|n| n.contains("1 folder Windsurf opened is no longer")));
}

#[test]
fn detect_reports_each_source_and_what_came_over() {
    let home = crate::test_home::borrow();
    conductor_fixture(home.path());
    let found: Vec<(String, bool)> = detect(home.path(), &ledger::Ledger::load()).into_iter().map(|d| (d.id, d.found)).collect();
    assert_eq!(found.iter().find(|(id, _)| id == "conductor").map(|(_, f)| *f), Some(true));
    assert_eq!(found.iter().find(|(id, _)| id == "cursor").map(|(_, f)| *f), Some(false));
    assert_eq!(found.len(), SOURCES.len());
    run_all("conductor", home.path(), &[], 10);
    let after = detect(home.path(), &ledger::Ledger::load());
    assert!(after.iter().find(|d| d.id == "conductor").unwrap().imported >= 2);
    assert!(scan("nope", &ctx(home.path(), &[])).is_err());
}

