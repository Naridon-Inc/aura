//! Conductor (com.conductor.app).
//!
//! Verified against a real install: one SQLite file,
//! `~/Library/Application Support/com.conductor.app/conductor.db`, with
//!
//! * `repos` — `root_path`, `name`, `default_branch`, and per-repo
//!   `setup_script` / `run_script` / `archive_script` plus custom prompts
//!   (`custom_prompt_code_review`, `custom_prompt_create_pr`,
//!   `custom_prompt_resolve_merge_conflicts`).
//! * `workspaces` — one git worktree each: `workspace_path`, `branch`,
//!   `directory_name` (the name Conductor shows), `workspace_name`,
//!   `state` (`ready` / `archived`), `pinned_at`.
//! * `sessions` — a chat in a workspace: `title`, `agent_type`
//!   (`claude` / `codex`), `created_at`, `last_message_at`.
//! * `session_messages` — `role` `user` rows hold the typed prompt as plain
//!   text; `assistant` rows hold one agent-SDK stream message each as JSON,
//!   the same `{"type":"assistant"|"user"|"system"|"result", "message":…}`
//!   lines Claude Code writes to its transcripts — so they go through the
//!   same reader.
//!
//! A repo can also carry `conductor.json` (`{"scripts":{"setup","run",
//! "archive"}}`) at its root; that shape is from Conductor's docs and is
//! covered by a fixture.
//!
//! Conductor's MCP servers are Claude Code's own config, which Aura reads
//! already, so there is no MCP item here.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use rusqlite::Connection;
use serde_json::Value;

use super::apply::{ChatImport, Scripts};
use super::model::{Item, ItemKind};
use super::{path_str, repo_item, rules_item, sqlite_ro, tilde, vscode_folders, ChatPlan, Ctx, Plan, Scanned};

pub const ID: &str = "conductor";
pub const NAME: &str = "Conductor";

pub fn db_path(home: &Path) -> PathBuf {
    vscode_folders::app_support(home).join("com.conductor.app").join("conductor.db")
}

/// Where to find one Conductor chat's messages.
pub struct ChatRef {
    pub db: PathBuf,
    pub session_id: String,
    pub agent_type: String,
    pub title: String,
    pub root: String,
    pub created_ms: i64,
    pub updated_ms: i64,
}

/// `col` if the table has it, else an empty string — Conductor's schema has
/// grown over releases and an older file may lack newer columns.
fn col(cols: &[String], name: &str) -> String {
    if cols.iter().any(|c| c == name) {
        format!("coalesce(cast(\"{name}\" as text), '')")
    } else {
        "''".to_string()
    }
}

/// Conductor writes `2026-10-02 08:14:51` in some tables and
/// `2026-10-02T08:14:51.123Z` in others. Both → epoch ms.
pub fn parse_time(s: &str) -> Option<i64> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(s) {
        return Some(dt.timestamp_millis());
    }
    for fmt in ["%Y-%m-%d %H:%M:%S%.f", "%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S%.f"] {
        if let Ok(dt) = chrono::NaiveDateTime::parse_from_str(s, fmt) {
            return Some(dt.and_utc().timestamp_millis());
        }
    }
    s.parse::<i64>().ok().map(|n| if n < 100_000_000_000 { n * 1000 } else { n })
}

fn opt(s: String) -> Option<String> {
    Some(s).filter(|v| !v.trim().is_empty())
}

struct Repo {
    id: String,
    name: String,
    root: PathBuf,
    branch: String,
    scripts: Scripts,
}

struct Workspace {
    id: String,
    repo_id: String,
    path: PathBuf,
    name: String,
    branch: String,
    archived: bool,
    pinned: bool,
    when: Option<i64>,
}

fn repos(conn: &Connection) -> Vec<Repo> {
    let cols = sqlite_ro::columns(conn, "repos");
    if cols.is_empty() {
        return Vec::new();
    }
    let sql = format!(
        "select {}, {}, {}, {}, {}, {}, {}, {}, {}, {} from repos order by {}",
        col(&cols, "id"),
        col(&cols, "name"),
        col(&cols, "root_path"),
        col(&cols, "default_branch"),
        col(&cols, "setup_script"),
        col(&cols, "run_script"),
        col(&cols, "archive_script"),
        col(&cols, "custom_prompt_code_review"),
        col(&cols, "custom_prompt_create_pr"),
        col(&cols, "custom_prompt_resolve_merge_conflicts"),
        if cols.iter().any(|c| c == "display_order") { "display_order" } else { "rowid" },
    );
    let Ok(mut stmt) = conn.prepare(&sql) else { return Vec::new() };
    stmt.query_map([], |r| {
        Ok(Repo {
            id: r.get(0)?,
            name: r.get(1)?,
            root: PathBuf::from(r.get::<_, String>(2)?),
            branch: r.get(3)?,
            scripts: Scripts {
                setup: opt(r.get(4)?),
                run: opt(r.get(5)?),
                archive: opt(r.get(6)?),
                review: opt(r.get(7)?),
                pr: opt(r.get(8)?),
                conflicts: opt(r.get(9)?),
            },
        })
    })
    .map(|rows| rows.filter_map(Result::ok).filter(|r| !r.root.as_os_str().is_empty()).collect())
    .unwrap_or_default()
}

fn workspaces(conn: &Connection, home: &Path, repos: &HashMap<String, &Repo>) -> Vec<Workspace> {
    let cols = sqlite_ro::columns(conn, "workspaces");
    if cols.is_empty() {
        return Vec::new();
    }
    let sql = format!(
        "select {}, {}, {}, {}, {}, {}, {}, {}, {}, {} from workspaces",
        col(&cols, "id"),
        col(&cols, "repository_id"),
        col(&cols, "workspace_path"),
        col(&cols, "directory_name"),
        col(&cols, "workspace_name"),
        col(&cols, "branch"),
        col(&cols, "state"),
        col(&cols, "pinned_at"),
        col(&cols, "updated_at"),
        col(&cols, "created_at"),
    );
    let Ok(mut stmt) = conn.prepare(&sql) else { return Vec::new() };
    let rows: Vec<[String; 10]> = stmt
        .query_map([], |r| {
            Ok([
                r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?,
                r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?, r.get(9)?,
            ])
        })
        .map(|rows| rows.filter_map(Result::ok).collect())
        .unwrap_or_default();
    rows.into_iter()
        .map(|[id, repo_id, path, dir, name, branch, state, pinned, updated, created]| {
            // Older rows have no `workspace_path`; Conductor put those under
            // ~/conductor/workspaces/<repo>/<directory>.
            let path = if path.trim().is_empty() {
                let repo_name = repos.get(&repo_id).map(|r| r.name.clone()).unwrap_or_default();
                home.join("conductor").join("workspaces").join(repo_name).join(&dir)
            } else {
                PathBuf::from(path)
            };
            Workspace {
                id,
                repo_id,
                name: opt(name).unwrap_or(dir),
                path,
                branch,
                archived: state.eq_ignore_ascii_case("archived"),
                pinned: !pinned.trim().is_empty(),
                when: parse_time(&updated).or_else(|| parse_time(&created)),
            }
        })
        .collect()
}

/// Is `path` a git worktree of the repository at `repo`? A worktree's `.git`
/// is a file naming `<repo>/.git/worktrees/<id>`.
pub fn worktree_of(path: &Path, repo: &Path) -> bool {
    let Ok(text) = std::fs::read_to_string(path.join(".git")) else {
        return false;
    };
    let Some(gitdir) = text.lines().find_map(|l| l.strip_prefix("gitdir:")) else {
        return false;
    };
    let gitdir = PathBuf::from(gitdir.trim());
    let common = std::fs::canonicalize(repo.join(".git")).unwrap_or_else(|_| repo.join(".git"));
    let gitdir = std::fs::canonicalize(&gitdir).unwrap_or(gitdir);
    gitdir.starts_with(common)
}

/// `conductor.json` at a repo's root: `{"scripts":{"setup","run","archive"}}`.
pub fn read_repo_config(root: &Path) -> Scripts {
    let Ok(text) = std::fs::read_to_string(root.join("conductor.json")) else {
        return Scripts::default();
    };
    let Ok(v) = serde_json::from_str::<Value>(&text) else {
        return Scripts::default();
    };
    let get = |k: &str| {
        v.get("scripts")
            .and_then(|s| s.get(k))
            .and_then(Value::as_str)
            .map(str::to_string)
            .filter(|s| !s.trim().is_empty())
    };
    Scripts { setup: get("setup"), run: get("run"), archive: get("archive"), ..Scripts::default() }
}

/// Conductor's own per-repo settings win over the checked-in file, the way
/// Conductor itself resolves them.
fn merged_scripts(db: &Scripts, file: Scripts) -> Scripts {
    Scripts {
        setup: db.setup.clone().or(file.setup),
        run: db.run.clone().or(file.run),
        archive: db.archive.clone().or(file.archive),
        review: db.review.clone(),
        pr: db.pr.clone(),
        conflicts: db.conflicts.clone(),
    }
}

struct SessionRow {
    id: String,
    workspace_id: String,
    title: String,
    agent: String,
    created: Option<i64>,
    last: Option<i64>,
}

fn sessions(conn: &Connection) -> Vec<SessionRow> {
    let cols = sqlite_ro::columns(conn, "sessions");
    if cols.is_empty() {
        return Vec::new();
    }
    let sql = format!(
        "select {}, {}, {}, {}, {}, {}, {} from sessions",
        col(&cols, "id"),
        col(&cols, "workspace_id"),
        col(&cols, "title"),
        col(&cols, "agent_type"),
        col(&cols, "created_at"),
        col(&cols, "last_message_at"),
        col(&cols, "updated_at"),
    );
    let Ok(mut stmt) = conn.prepare(&sql) else { return Vec::new() };
    stmt.query_map([], |r| {
        let created: String = r.get(4)?;
        let last: String = r.get(5)?;
        let updated: String = r.get(6)?;
        Ok(SessionRow {
            id: r.get(0)?,
            workspace_id: r.get(1)?,
            title: r.get(2)?,
            agent: r.get(3)?,
            created: parse_time(&created),
            last: parse_time(&last).or_else(|| parse_time(&updated)),
        })
    })
    .map(|rows| rows.filter_map(Result::ok).collect())
    .unwrap_or_default()
}

fn message_counts(conn: &Connection) -> HashMap<String, usize> {
    if !sqlite_ro::has_table(conn, "session_messages") {
        return HashMap::new();
    }
    let Ok(mut stmt) = conn.prepare("select session_id, count(*) from session_messages group by session_id") else {
        return HashMap::new();
    };
    stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? as usize)))
        .map(|rows| rows.filter_map(Result::ok).collect())
        .unwrap_or_default()
}

fn agent_name(agent: &str) -> &'static str {
    match agent {
        "claude" => "Claude Code",
        "codex" => "Codex",
        _ => "Agent",
    }
}

fn plural(n: usize, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

pub fn scan(ctx: &Ctx, out: &mut Scanned) {
    let db = db_path(&ctx.home);
    let conn = match sqlite_ro::open(&db) {
        Ok(c) => c,
        Err(e) => {
            out.note(format!("Aura couldn't read Conductor's data: {e}"));
            return;
        }
    };
    let repos = repos(&conn);
    let by_id: HashMap<String, &Repo> = repos.iter().map(|r| (r.id.clone(), r)).collect();
    let workspaces = workspaces(&conn, &ctx.home, &by_id);
    let ws_by_id: HashMap<String, &Workspace> = workspaces.iter().map(|w| (w.id.clone(), w)).collect();
    let sessions = sessions(&conn);
    let counts = message_counts(&conn);

    let mut ws_per_repo: HashMap<&str, usize> = HashMap::new();
    for w in workspaces.iter().filter(|w| !w.archived) {
        *ws_per_repo.entry(w.repo_id.as_str()).or_default() += 1;
    }
    let mut chats_per_repo: HashMap<String, usize> = HashMap::new();
    for s in sessions.iter().filter(|s| counts.get(&s.id).is_some_and(|n| *n > 0)) {
        if let Some(w) = ws_by_id.get(&s.workspace_id) {
            *chats_per_repo.entry(w.repo_id.clone()).or_default() += 1;
        }
    }

    for r in &repos {
        let mut bits = Vec::new();
        if !r.branch.is_empty() {
            bits.push(r.branch.clone());
        }
        bits.push(plural(*ws_per_repo.get(r.id.as_str()).unwrap_or(&0), "workspace", "workspaces"));
        bits.push(plural(*chats_per_repo.get(&r.id).unwrap_or(&0), "chat", "chats"));
        let item = repo_item(ctx, format!("repo:{}", r.id), &r.root, Some(&r.name), bits.join(" · "));
        out.push(item, Plan::Repo { root: r.root.clone() });

        let scripts = merged_scripts(&r.scripts, read_repo_config(&r.root));
        if !scripts.is_empty() && r.root.is_dir() {
            let key = format!("scripts:{}", r.id);
            let mut item = Item::new(key.clone(), ItemKind::Scripts, format!("Scripts for {}", r.name))
                .detail(scripts.labels().join(", "))
                .root(path_str(&r.root));
            if ctx.ledger.done(ID, &key).is_some() {
                item = item.done("Already in this repo's Aura settings");
            }
            out.push(item, Plan::Scripts { root: r.root.clone(), scripts });
        }
        if let Some(item) = rules_item(ctx, ID, &r.root) {
            out.push(item, Plan::Rules { root: r.root.clone() });
        }
    }

    for w in &workspaces {
        let Some(repo) = by_id.get(&w.repo_id) else { continue };
        let key = format!("workspace:{}", w.id);
        let detail = format!("{} · {}", if w.branch.is_empty() { "no branch" } else { &w.branch }, repo.name);
        let mut item = Item::new(key.clone(), ItemKind::Workspace, w.name.clone())
            .detail(detail)
            .when(w.when)
            .root(path_str(&w.path));
        item = if w.archived {
            item.unavailable("Archived in Conductor")
        } else if !w.path.is_dir() {
            item.unavailable(format!("{} isn't on this Mac any more", tilde(&ctx.home, &w.path)))
        } else if !worktree_of(&w.path, &repo.root) {
            item.unavailable(format!("Not a git worktree of {}", repo.name))
        } else if ctx.ledger.done(ID, &key).is_some() {
            item.done("Already in Aura")
        } else {
            item
        };
        out.push(
            item,
            Plan::Workspace { path: w.path.clone(), name: Some(w.name.clone()), pinned: w.pinned, repo: repo.root.clone() },
        );
    }

    let mut empty = 0usize;
    for s in &sessions {
        let n = *counts.get(&s.id).unwrap_or(&0);
        if n == 0 {
            empty += 1;
            continue;
        }
        let ws = ws_by_id.get(&s.workspace_id);
        let repo = ws.and_then(|w| by_id.get(&w.repo_id));
        // A chat lands in its workspace when that worktree is still here,
        // else in its repo — the conversation is about that code either way.
        let root = ws
            .map(|w| w.path.clone())
            .filter(|p| p.is_dir())
            .or_else(|| repo.map(|r| r.root.clone()).filter(|p| p.is_dir()));
        let key = format!("chat:{}", s.id);
        let title = Some(s.title.trim().to_string()).filter(|t| !t.is_empty() && t != "Untitled").unwrap_or_else(|| {
            ws.map(|w| format!("Chat in {}", w.name)).unwrap_or_else(|| "Conductor chat".into())
        });
        let place = ws.map(|w| w.name.clone()).or_else(|| repo.map(|r| r.name.clone())).unwrap_or_default();
        let mut bits = vec![agent_name(&s.agent).to_string(), plural(n, "message", "messages")];
        if !place.is_empty() {
            bits.push(place);
        }
        let mut item = Item::new(key.clone(), ItemKind::Chat, title.clone()).detail(bits.join(" · ")).when(s.last.or(s.created));
        if let Some(root) = &root {
            item = item.root(path_str(root));
        }
        item = if root.is_none() {
            item.unavailable("Its workspace and repo aren't on this Mac any more")
        } else if s.agent != "claude" && s.agent != "codex" {
            item.unavailable(format!("Aura can't read {} chats yet", if s.agent.is_empty() { "this kind of" } else { &s.agent }))
        } else if ctx.ledger.done(ID, &key).is_some() {
            item.done("Already in Aura")
        } else {
            item
        };
        out.push(
            item,
            Plan::Chat(ChatPlan::Conductor(ChatRef {
                db: db.clone(),
                session_id: s.id.clone(),
                agent_type: s.agent.clone(),
                title,
                root: root.map(|r| path_str(&r)).unwrap_or_default(),
                created_ms: s.created.unwrap_or(0),
                updated_ms: s.last.or(s.created).unwrap_or(0),
            })),
        );
    }
    if empty > 0 {
        out.note(format!("{} with no messages {} left out.", plural(empty, "chat", "chats"), if empty == 1 { "is" } else { "are" }));
    }
    out.note("Conductor's MCP servers are Claude Code's own settings, which Aura already reads — nothing to bring over there.");
}

/// Read one chat's messages, oldest first, into the shape Aura imports.
pub fn load_chat(r: &ChatRef) -> Result<ChatImport, String> {
    let conn = sqlite_ro::open(&r.db)?;
    let mut stmt = conn
        .prepare("select role, coalesce(content, ''), coalesce(cast(created_at as text), '') from session_messages where session_id = ?1 order by rowid")
        .map_err(|e| format!("couldn't read the chat: {e}"))?;
    let rows = stmt
        .query_map([&r.session_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?))
        })
        .map_err(|e| format!("couldn't read the chat: {e}"))?;
    let mut turns = Vec::new();
    let mut raw = Vec::new();
    for row in rows {
        let (role, content, created) = row.map_err(|e| format!("couldn't read a message: {e}"))?;
        raw.push(serde_json::json!({ "role": role, "created_at": created, "content": content }).to_string());
        let ts = parse_time(&created).unwrap_or(r.created_ms);
        if role == "user" {
            let text = content.trim();
            if !text.is_empty() {
                turns.push(crate::cmd_agent_history::PrerollTurn {
                    role: "user".into(),
                    text: text.to_string(),
                    ts,
                    tool_calls: Vec::new(),
                    thinking: None,
                });
            }
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(&content) else { continue };
        // A Claude subagent's own steps stream into the same table tagged
        // with the tool call that started it. The parent conversation already
        // carries that call and its result; the steps would read as the main
        // agent talking. They stay in the raw copy.
        if r.agent_type == "claude" && v.get("parent_tool_use_id").and_then(Value::as_str).is_some_and(|s| !s.is_empty()) {
            continue;
        }
        crate::cmd_agent_history::push_claude_line(&mut turns, &v, ts);
    }
    Ok(ChatImport {
        source: ID,
        source_name: NAME,
        source_key: r.session_id.clone(),
        title: r.title.clone(),
        root: r.root.clone(),
        created_ms: r.created_ms,
        updated_ms: r.updated_ms,
        brain: if r.agent_type == "codex" { "cli:codex" } else { "cli:claude_code" },
        turns,
        raw,
    })
}
