//! Superset.
//!
//! Verified against a real install. Superset has kept its state in two
//! generations of SQLite file, and an install can hold both:
//!
//! * `~/.superset/local.db` — `projects` (`main_repo_path`, `name`,
//!   `default_branch`), `worktrees` (`path`, `branch`, `project_id`) and
//!   `workspaces` (`type` `branch` = the repo itself, else a worktree via
//!   `worktree_id`; `name`, `is_unnamed`).
//! * `~/.superset/host/<id>/host.db` — `projects` (`repo_path`, `name`) and
//!   `workspaces` (`worktree_path`, `branch`, `name`, `type` `main` |
//!   `worktree`).
//!
//! Setup and teardown scripts live in the repo at `.superset/config.json`,
//! `{"setup": "…" | ["…"], "teardown": "…" | ["…"]}`. That file's shape is from
//! Superset's docs (no repo here has one) and is covered by a fixture.
//!
//! Superset runs agents in terminals and keeps no chat history on disk.

use std::path::{Path, PathBuf};

use rusqlite::Connection;
use serde_json::Value;

use super::apply::Scripts;
use super::conductor::worktree_of;
use super::model::{Item, ItemKind};
use super::{path_str, repo_item, rules_item, sqlite_ro, tilde, Ctx, Plan, Scanned};

pub const ID: &str = "superset";

fn root_dir(home: &Path) -> PathBuf {
    home.join(".superset")
}

fn host_dbs(home: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(root_dir(home).join("host")) else {
        return Vec::new();
    };
    let mut out: Vec<PathBuf> = entries
        .filter_map(|e| e.ok())
        .map(|e| e.path().join("host.db"))
        .filter(|p| p.is_file())
        .collect();
    out.sort();
    out
}

pub fn found(home: &Path) -> bool {
    root_dir(home).join("local.db").is_file() || !host_dbs(home).is_empty()
}

fn ms(n: i64) -> Option<i64> {
    match n {
        0 => None,
        n if n < 100_000_000_000 => Some(n * 1000),
        n => Some(n),
    }
}

struct Project {
    path: PathBuf,
    name: String,
    branch: String,
}

struct Worktree {
    path: PathBuf,
    repo: PathBuf,
    name: Option<String>,
    branch: String,
    when: Option<i64>,
}

fn query<T>(conn: &Connection, sql: &str, f: impl FnMut(&rusqlite::Row<'_>) -> rusqlite::Result<T>) -> Vec<T> {
    let Ok(mut stmt) = conn.prepare(sql) else { return Vec::new() };
    stmt.query_map([], f).map(|rows| rows.filter_map(Result::ok).collect()).unwrap_or_default()
}

fn read_local(conn: &Connection, projects: &mut Vec<Project>, worktrees: &mut Vec<Worktree>) {
    if sqlite_ro::has_table(conn, "projects") {
        projects.extend(query(
            conn,
            "select coalesce(main_repo_path, ''), coalesce(name, ''), coalesce(default_branch, '') from projects",
            |r| Ok(Project { path: PathBuf::from(r.get::<_, String>(0)?), name: r.get(1)?, branch: r.get(2)? }),
        ));
    }
    if sqlite_ro::has_table(conn, "worktrees") && sqlite_ro::has_table(conn, "workspaces") {
        worktrees.extend(query(
            conn,
            "select coalesce(t.path, ''), coalesce(p.main_repo_path, ''), \
                    case when coalesce(w.is_unnamed, 0) = 1 then '' else coalesce(w.name, '') end, \
                    coalesce(t.branch, w.branch, ''), coalesce(w.last_opened_at, w.updated_at, t.created_at, 0) \
             from worktrees t join projects p on p.id = t.project_id \
             left join workspaces w on w.worktree_id = t.id",
            |r| {
                Ok(Worktree {
                    path: PathBuf::from(r.get::<_, String>(0)?),
                    repo: PathBuf::from(r.get::<_, String>(1)?),
                    name: Some(r.get::<_, String>(2)?).filter(|s| !s.trim().is_empty()),
                    branch: r.get(3)?,
                    when: ms(r.get(4)?),
                })
            },
        ));
    }
}

fn read_host(conn: &Connection, projects: &mut Vec<Project>, worktrees: &mut Vec<Worktree>) {
    if sqlite_ro::has_table(conn, "projects") {
        projects.extend(query(
            conn,
            "select coalesce(repo_path, ''), coalesce(name, repo_name, ''), '' from projects",
            |r| Ok(Project { path: PathBuf::from(r.get::<_, String>(0)?), name: r.get(1)?, branch: r.get(2)? }),
        ));
    }
    if sqlite_ro::has_table(conn, "workspaces") {
        worktrees.extend(query(
            conn,
            "select coalesce(w.worktree_path, ''), coalesce(p.repo_path, ''), coalesce(w.name, ''), \
                    coalesce(w.branch, ''), coalesce(w.updated_at, w.created_at, 0) \
             from workspaces w join projects p on p.id = w.project_id where w.type = 'worktree'",
            |r| {
                Ok(Worktree {
                    path: PathBuf::from(r.get::<_, String>(0)?),
                    repo: PathBuf::from(r.get::<_, String>(1)?),
                    name: Some(r.get::<_, String>(2)?).filter(|s| !s.trim().is_empty()),
                    branch: r.get(3)?,
                    when: ms(r.get(4)?),
                })
            },
        ));
    }
}

fn joined(v: Option<&Value>) -> Option<String> {
    match v? {
        Value::String(s) => Some(s.trim().to_string()).filter(|s| !s.is_empty()),
        Value::Array(items) => {
            let lines: Vec<&str> = items.iter().filter_map(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).collect();
            (!lines.is_empty()).then(|| lines.join("\n"))
        }
        _ => None,
    }
}

/// `.superset/config.json`: `setup` and `teardown` (a command or a list of
/// them) → Aura's setup and archive scripts.
pub fn read_repo_config(root: &Path) -> Scripts {
    let Ok(text) = std::fs::read_to_string(root.join(".superset").join("config.json")) else {
        return Scripts::default();
    };
    let Ok(v) = serde_json::from_str::<Value>(&text) else {
        return Scripts::default();
    };
    Scripts {
        setup: joined(v.get("setup")),
        run: joined(v.get("run")),
        archive: joined(v.get("teardown")),
        ..Scripts::default()
    }
}

pub fn scan(ctx: &Ctx, out: &mut Scanned) {
    let mut projects = Vec::new();
    let mut worktrees = Vec::new();
    let local = root_dir(&ctx.home).join("local.db");
    if local.is_file() {
        match sqlite_ro::open(&local) {
            Ok(conn) => read_local(&conn, &mut projects, &mut worktrees),
            Err(e) => out.note(format!("Aura couldn't read {}: {e}", tilde(&ctx.home, &local))),
        }
    }
    for db in host_dbs(&ctx.home) {
        match sqlite_ro::open(&db) {
            Ok(conn) => read_host(&conn, &mut projects, &mut worktrees),
            Err(e) => out.note(format!("Aura couldn't read {}: {e}", tilde(&ctx.home, &db))),
        }
    }

    for p in projects.iter().filter(|p| !p.path.as_os_str().is_empty()) {
        let copies = worktrees.iter().filter(|w| w.repo == p.path).count();
        let mut bits = Vec::new();
        if !p.branch.is_empty() {
            bits.push(p.branch.clone());
        }
        bits.push(format!("{copies} {}", if copies == 1 { "workspace" } else { "workspaces" }));
        let item = repo_item(ctx, format!("repo:{}", path_str(&p.path)), &p.path, Some(&p.name), bits.join(" · "));
        out.push(item, Plan::Repo { root: p.path.clone() });

        let scripts = read_repo_config(&p.path);
        if !scripts.is_empty() {
            let key = format!("scripts:{}", path_str(&p.path));
            let mut item = Item::new(key.clone(), ItemKind::Scripts, format!("Scripts for {}", p.name))
                .detail(format!("{} from .superset/config.json", scripts.labels().join(", ")))
                .root(path_str(&p.path));
            if ctx.ledger.done(ID, &key).is_some() {
                item = item.done("Already in this repo's Aura settings");
            }
            out.push(item, Plan::Scripts { root: p.path.clone(), scripts });
        }
        if let Some(item) = rules_item(ctx, ID, &p.path) {
            out.push(item, Plan::Rules { root: p.path.clone() });
        }
    }

    for w in worktrees.iter().filter(|w| !w.path.as_os_str().is_empty()) {
        let key = format!("workspace:{}", path_str(&w.path));
        let name = w
            .name
            .clone()
            .unwrap_or_else(|| w.path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default());
        let repo_name = w.repo.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let detail = format!("{} · {repo_name}", if w.branch.is_empty() { "no branch" } else { &w.branch });
        let mut item = Item::new(key.clone(), ItemKind::Workspace, name.clone()).detail(detail).when(w.when).root(path_str(&w.path));
        item = if !w.path.is_dir() {
            item.unavailable(format!("{} isn't on this Mac any more", tilde(&ctx.home, &w.path)))
        } else if !worktree_of(&w.path, &w.repo) {
            item.unavailable(format!("Not a git worktree of {repo_name}"))
        } else if ctx.ledger.done(ID, &key).is_some() {
            item.done("Already in Aura")
        } else {
            item
        };
        out.push(item, Plan::Workspace { path: w.path.clone(), name: w.name.clone(), pinned: false, repo: w.repo.clone() });
    }
    out.note("Superset runs agents in terminals and keeps no chat history on this Mac, so there are no chats to bring over.");
}
