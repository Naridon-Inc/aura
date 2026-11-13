//! A conversation that spans several projects, driven through each plane.
//!
//! Aura's chat can be bound to more than one project. When it is, a tool call
//! has no "current" project to fall back on, so every plane makes the same
//! promise: the call lands in the project it names, or it is refused and the
//! model is told to name one. These tests hold each plane to that promise with
//! two real checkouts side by side — an anchor (`A`, where the chat's process
//! happens to run) and another project (`B`) — and check that what was asked
//! of B happened in B and nowhere else.
//!
//! The planes covered here are the ones whose earlier tests only reached the
//! resolver: new workspaces, pull requests, live agents, and sending work to
//! another machine. Anything that would leave the machine (GitHub, the runner
//! board) is stopped before it does — by a reader handed in, or by a check
//! that refuses ahead of the network — so nothing here needs a connection.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};

use super::cloud_plane::DISPATCH_TOOL;
use super::control_plane::{pr_detail_with, prs_list_with};
use super::native_tools::{CHAT_AUTHOR, execute_board_tool};
use super::project_plane::resolution_root;

/// The root a chat bound to several projects hands every tool: none.
fn fleet() -> &'static str {
    resolution_root("/anchor/never/used", 2)
}

fn s(p: &Path) -> String {
    p.to_string_lossy().to_string()
}

fn canon(p: impl AsRef<Path>) -> PathBuf {
    std::fs::canonicalize(p.as_ref()).unwrap_or_else(|_| p.as_ref().to_path_buf())
}

fn git(dir: &Path, args: &[&str]) -> std::process::Output {
    Command::new("git")
        .args([
            "-c",
            "user.name=Aura Test",
            "-c",
            "user.email=test@aura.invalid",
            "-c",
            "commit.gpgsign=false",
            "-c",
            "core.hooksPath=/dev/null",
        ])
        .args(args)
        .current_dir(dir)
        .output()
        .expect("git runs")
}

/// A real repository with one commit, so a branch can start from `HEAD`.
fn git_repo(name: &str) -> tempfile::TempDir {
    let dir = tempfile::Builder::new().prefix(name).tempdir().unwrap();
    let out = git(dir.path(), &["init", "-q", "-b", "main"]);
    assert!(out.status.success(), "git init: {}", String::from_utf8_lossy(&out.stderr));
    std::fs::write(dir.path().join("README.md"), format!("# {name}\n")).unwrap();
    assert!(git(dir.path(), &["add", "README.md"]).status.success());
    let out = git(dir.path(), &["commit", "-q", "-m", "first"]);
    assert!(out.status.success(), "git commit: {}", String::from_utf8_lossy(&out.stderr));
    dir
}

/// A plain checkout (a `.git` directory) — enough for the readers that only
/// look at `.aura/`.
fn checkout(name: &str) -> tempfile::TempDir {
    let dir = tempfile::Builder::new().prefix(name).tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join(".git")).unwrap();
    dir
}

/// Register projects in the borrowed `HOME`'s `~/.aura/projects.json`, the
/// same file the app writes on every open, so names resolve the way they do
/// for a real user.
fn register(home: &Path, projects: &[(&str, &str, &Path)]) {
    let rows: Vec<Value> = projects
        .iter()
        .enumerate()
        .map(|(i, (id, label, root))| {
            json!({
                "id": id,
                "label": label,
                "root": s(root),
                "last_opened_at": 1_000 - i as u64,
            })
        })
        .collect();
    std::fs::create_dir_all(home.join(".aura")).unwrap();
    std::fs::write(
        home.join(".aura").join("projects.json"),
        serde_json::to_string(&rows).unwrap(),
    )
    .unwrap();
}

// ── new workspaces ─────────────────────────────────────────────────────

#[tokio::test]
async fn a_new_workspace_is_cut_from_the_project_the_call_names() {
    // Managed worktrees live under ~/.aura/worktrees — borrow HOME so this
    // writes nowhere real.
    let home = crate::test_home::borrow();
    let a = git_repo("anchor-a");
    let b = git_repo("other-b");

    let (text, is_error) = super::project_plane::execute(
        fleet(),
        "aura_workspace_create",
        &json!({ "project": s(b.path()), "branch": "feat/only-in-b" }),
    )
    .await;
    assert!(!is_error, "{text}");
    let v: Value = serde_json::from_str(&text).unwrap();

    // The answer names B as the project it acted on, and the workspace as
    // where the next step should run.
    assert_eq!(v["created"], true);
    assert_eq!(v["target"]["root"], json!(s(b.path())));
    let path = PathBuf::from(v["workspace"]["path"].as_str().unwrap());
    assert_eq!(v["target"]["workspace"], json!(s(&path)));
    assert_eq!(v["workspace"]["branch"], "feat/only-in-b");

    // It is a real worktree of B, on the new branch, in Aura's managed folder.
    assert!(
        canon(&path).starts_with(canon(home.path().join(".aura").join("worktrees"))),
        "{} is outside the managed folder",
        path.display()
    );
    let common = git(&path, &["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    assert!(common.status.success());
    let common = String::from_utf8_lossy(&common.stdout).trim().to_string();
    assert_eq!(canon(&common), canon(b.path().join(".git")));
    let head = git(&path, &["rev-parse", "--abbrev-ref", "HEAD"]);
    assert_eq!(String::from_utf8_lossy(&head.stdout).trim(), "feat/only-in-b");

    // And A — where the chat was anchored — gained nothing.
    let in_a = git(a.path(), &["rev-parse", "--verify", "--quiet", "refs/heads/feat/only-in-b"]);
    assert!(!in_a.status.success(), "the branch leaked into the anchor");
    let a_trees = git(a.path(), &["worktree", "list", "--porcelain"]);
    assert_eq!(
        String::from_utf8_lossy(&a_trees.stdout)
            .lines()
            .filter(|l| l.starts_with("worktree "))
            .count(),
        1,
        "the anchor has only its own checkout"
    );
}

#[tokio::test]
async fn a_new_workspace_with_no_project_is_refused_and_nothing_is_made() {
    let home = crate::test_home::borrow();
    let (text, is_error) =
        super::project_plane::execute(fleet(), "aura_workspace_create", &json!({ "branch": "x" }))
            .await;
    assert!(is_error);
    assert!(text.contains("pass `project` explicitly"), "{text}");
    assert!(
        !home.path().join(".aura").join("worktrees").exists(),
        "a refused call must not have started making a worktree"
    );
}

// ── pull requests ──────────────────────────────────────────────────────

fn pr(number: u64, title: &str) -> crate::cmd_prs::PrSummary {
    crate::cmd_prs::PrSummary {
        number,
        title: title.to_string(),
        state: "OPEN".into(),
        author: "someone".into(),
        head_ref: "feat/x".into(),
        base_ref: "main".into(),
        is_draft: false,
        additions: 1,
        deletions: 0,
        created_at: "2026-11-01T00:00:00Z".into(),
        updated_at: "2026-11-02T00:00:00Z".into(),
        review_decision: None,
        url: format!("https://example.invalid/pull/{number}"),
        aura_risk_score: None,
        aura_risk_label: None,
        checks_state: None,
        checks_total: 0,
        checks_passing: 0,
        checks_failing: 0,
        checks_pending: 0,
        is_authored_by_me: false,
        is_review_requested_for_me: false,
        labels: Vec::new(),
        is_cross_repository: false,
        head_repo_owner: "someone".into(),
    }
}

/// A PR reader that records every checkout it was asked about and answers
/// with one PR titled after that checkout.
fn recording_reader(
    seen: Arc<Mutex<Vec<String>>>,
) -> impl Fn(String) -> std::pin::Pin<
    Box<dyn std::future::Future<Output = Result<Vec<crate::cmd_prs::PrSummary>, String>> + Send>,
> {
    move |root: String| {
        let seen = seen.clone();
        Box::pin(async move {
            seen.lock().unwrap().push(root.clone());
            Ok(vec![pr(7, &format!("open in {root}"))])
        })
    }
}

#[tokio::test]
async fn listing_prs_for_a_named_project_reads_only_that_project() {
    let home = crate::test_home::borrow();
    let a = checkout("prs-a");
    let b = checkout("prs-b");
    register(home.path(), &[("p-a", "Alpha", a.path()), ("p-b", "Beta", b.path())]);

    let seen = Arc::new(Mutex::new(Vec::new()));
    let (text, is_error) =
        prs_list_with(fleet(), &json!({ "project": "Beta" }), recording_reader(seen.clone())).await;
    assert!(!is_error, "{text}");
    assert_eq!(*seen.lock().unwrap(), vec![s(b.path())], "only B was read");
    let v: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(v["projects"].as_array().unwrap().len(), 1);
    assert_eq!(v["projects"][0]["project"], "Beta");
    assert_eq!(v["projects"][0]["root"], json!(s(b.path())));
}

#[tokio::test]
async fn listing_prs_with_no_project_sweeps_every_project_and_labels_each() {
    // In a sweep, "no project" means all of them — never quietly just the
    // anchor — and each row says which project it came from.
    let home = crate::test_home::borrow();
    let a = checkout("sweep-a");
    let b = checkout("sweep-b");
    register(home.path(), &[("p-a", "Alpha", a.path()), ("p-b", "Beta", b.path())]);

    let seen = Arc::new(Mutex::new(Vec::new()));
    let (text, is_error) = prs_list_with(fleet(), &json!({}), recording_reader(seen.clone())).await;
    assert!(!is_error, "{text}");
    let mut got = seen.lock().unwrap().clone();
    got.sort();
    let mut want = vec![s(a.path()), s(b.path())];
    want.sort();
    assert_eq!(got, want);
    let v: Value = serde_json::from_str(&text).unwrap();
    let labels: Vec<&str> = v["projects"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["project"].as_str().unwrap())
        .collect();
    assert_eq!(labels, vec!["Alpha", "Beta"]);
    assert_eq!(v["pr_count"], 2);
}

#[tokio::test]
async fn listing_prs_for_an_unknown_project_is_refused_without_reading_any() {
    let home = crate::test_home::borrow();
    let a = checkout("unk-a");
    register(home.path(), &[("p-a", "Alpha", a.path())]);

    let seen = Arc::new(Mutex::new(Vec::new()));
    let (text, is_error) =
        prs_list_with(fleet(), &json!({ "project": "Gamma" }), recording_reader(seen.clone())).await;
    assert!(is_error);
    assert!(text.contains("Known projects: Alpha"), "{text}");
    assert!(seen.lock().unwrap().is_empty(), "nothing may be read on a refusal");
}

#[tokio::test]
async fn pr_detail_is_looked_up_in_the_named_project() {
    let home = crate::test_home::borrow();
    let a = checkout("det-a");
    let b = checkout("det-b");
    register(home.path(), &[("p-a", "Alpha", a.path()), ("p-b", "Beta", b.path())]);

    let asked: Arc<Mutex<Option<(String, u64)>>> = Arc::new(Mutex::new(None));
    let rec = asked.clone();
    let (text, is_error) = pr_detail_with(
        fleet(),
        &json!({ "project": "Beta", "number": 41 }),
        move |root, number| async move {
            *rec.lock().unwrap() = Some((root, number));
            Ok((json!({ "number": number, "title": "in B" }), vec![]))
        },
    )
    .await;
    assert!(!is_error, "{text}");
    assert_eq!(*asked.lock().unwrap(), Some((s(b.path()), 41)));
    let v: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(v["project"], "Beta");
    assert_eq!(v["pr"]["title"], "in B");

    // A failure names the project it was looked up in, so "no PR #41" is
    // never mistaken for an answer about the anchor.
    let (text, is_error) = pr_detail_with(
        fleet(),
        &json!({ "project": "Beta", "number": 41 }),
        |_root, _n| async move { Err::<(Value, Vec<Value>), _>("not found".to_string()) },
    )
    .await;
    assert!(is_error);
    assert_eq!(text, "PR #41 in Beta: not found");
}

#[tokio::test]
async fn pr_detail_with_no_project_is_refused_without_a_lookup() {
    let called = Arc::new(Mutex::new(false));
    let rec = called.clone();
    let (text, is_error) =
        pr_detail_with(fleet(), &json!({ "number": 41 }), move |_root, _n| async move {
            *rec.lock().unwrap() = true;
            Ok((Value::Null, vec![]))
        })
        .await;
    assert!(is_error);
    assert!(text.contains("pass `project` explicitly"), "{text}");
    assert!(!*called.lock().unwrap(), "an ambiguous call must not reach GitHub");
}

// ── live agents ────────────────────────────────────────────────────────

/// A claim file for a live agent: our own pid is the one process we know is
/// running.
fn running_agent(root: &Path, session: &str, branch: &str) {
    let dir = root.join(".aura").join("sentinel").join("claims");
    std::fs::create_dir_all(&dir).unwrap();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    std::fs::write(
        dir.join(format!("{session}.json")),
        json!({
            "session_id": session,
            "agent_id": "claude",
            "pid": std::process::id(),
            "last_heartbeat": now,
            "claims": [{ "file_path": "src/lib.rs", "function_name": "run", "claimed_at": now }],
            "branch": branch,
        })
        .to_string(),
    )
    .unwrap();
}

#[tokio::test]
async fn live_agents_for_a_named_project_come_from_that_project_only() {
    let home = crate::test_home::borrow();
    let a = checkout("live-a");
    let b = checkout("live-b");
    running_agent(a.path(), "sess-in-a", "feat/a");
    running_agent(b.path(), "sess-in-b", "feat/b");
    register(home.path(), &[("p-a", "Alpha", a.path()), ("p-b", "Beta", b.path())]);

    let (text, is_error, _) = execute_board_tool(
        fleet(),
        "aura_agents_live",
        &json!({ "project": "Beta" }),
        CHAT_AUTHOR,
    )
    .await;
    assert!(!is_error, "{text}");
    let v: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(v["running_count"], 1);
    let projects = v["projects"].as_array().unwrap();
    assert_eq!(projects.len(), 1);
    assert_eq!(projects[0]["project"], "Beta");
    assert_eq!(projects[0]["agents"][0]["session_id"], "sess-in-b");
    assert_eq!(projects[0]["agents"][0]["branch"], "feat/b");
    assert!(!text.contains("sess-in-a"), "A's agent must not appear: {text}");
    // The answer is stamped with the project it read, for the chat's chip.
    assert_eq!(v["target"]["root"], json!(s(b.path())));
    assert_eq!(v["target"]["project"], "Beta");
}

#[tokio::test]
async fn live_agents_with_no_project_sweep_every_project() {
    let home = crate::test_home::borrow();
    let a = checkout("lsweep-a");
    let b = checkout("lsweep-b");
    running_agent(a.path(), "sess-in-a", "feat/a");
    running_agent(b.path(), "sess-in-b", "feat/b");
    register(home.path(), &[("p-a", "Alpha", a.path()), ("p-b", "Beta", b.path())]);

    let (text, is_error, _) =
        execute_board_tool(fleet(), "aura_agents_live", &json!({}), CHAT_AUTHOR).await;
    assert!(!is_error, "{text}");
    let v: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(v["running_count"], 2);
    let by_project: Vec<(String, String)> = v["projects"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| {
            (
                p["project"].as_str().unwrap().to_string(),
                p["agents"][0]["session_id"].as_str().unwrap().to_string(),
            )
        })
        .collect();
    assert_eq!(
        by_project,
        vec![
            ("Alpha".to_string(), "sess-in-a".to_string()),
            ("Beta".to_string(), "sess-in-b".to_string()),
        ]
    );
    // A sweep names no single project, so it carries no single target.
    assert!(v.get("target").is_none(), "{text}");
}

#[tokio::test]
async fn live_agents_with_nothing_registered_and_no_project_are_refused() {
    let _home = crate::test_home::borrow();
    let (text, is_error, _) =
        execute_board_tool(fleet(), "aura_agents_live", &json!({}), CHAT_AUTHOR).await;
    assert!(is_error);
    assert!(text.contains("no projects are registered"), "{text}");
}

// ── sending work to another machine ────────────────────────────────────

fn rules(root: &Path, stance: &str) {
    std::fs::create_dir_all(root.join(".aura")).unwrap();
    std::fs::write(
        root.join(".aura").join("settings.toml"),
        format!("[authority]\ndispatch_to_machine = \"{stance}\"\n"),
    )
    .unwrap();
}

fn board_with(root: &Path, id: &str, title: &str) {
    let dir = root.join(".aura").join("tasks");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("tasks.json"),
        json!({ "tasks": [{
            "id": id,
            "title": title,
            "status": "backlog",
            "priority": "high",
            "created_at": "2026-11-01T00:00:00Z",
            "updated_at": "2026-11-01T00:00:00Z",
        }]})
        .to_string(),
    )
    .unwrap();
}

#[tokio::test]
async fn sending_work_obeys_the_named_projects_rules_not_the_anchors() {
    // The anchor refuses dispatch; B allows it. The rules that count are the
    // ones of the project whose work is leaving.
    let a = checkout("send-a");
    let b = checkout("send-b");
    rules(a.path(), "refuse");
    rules(b.path(), "allow");
    board_with(b.path(), "t-only-b", "Only B has this task");

    // Named B, from a chat anchored on A: B's "allow" lets it through the
    // gate, and the brief is read from B's own board. The call then stops at
    // the first check that needs no network — this headless call has no
    // conversation to hand over — which is only reachable once both of those
    // have succeeded.
    let (text, is_error, _) = execute_board_tool(
        &s(a.path()),
        DISPATCH_TOOL,
        &json!({ "project": s(b.path()), "task": "t-only-b", "continue_conversation": true }),
        CHAT_AUTHOR,
    )
    .await;
    assert!(is_error);
    assert!(
        text.contains("could not be read back from disk"),
        "expected to pass B's gate and B's board: {text}"
    );
    assert!(!text.contains("settings.toml"), "A's refusal must not apply to B: {text}");

    // Named A, from a chat anchored on B: A's own refusal stops it, even
    // though the anchor would have allowed it.
    let (text, is_error, _) = execute_board_tool(
        &s(b.path()),
        DISPATCH_TOOL,
        &json!({ "project": s(a.path()), "text": "ship the A thing" }),
        CHAT_AUTHOR,
    )
    .await;
    assert!(is_error);
    assert!(text.contains("dispatch_to_machine"), "A's rule must refuse: {text}");
    assert!(text.contains("settings.toml"), "{text}");
}

#[tokio::test]
async fn sending_a_task_reads_the_brief_from_the_named_projects_board() {
    // Both allow. The task exists only on B, so naming A cannot find it —
    // the board consulted is the named project's, not wherever the task is.
    let a = checkout("brief-a");
    let b = checkout("brief-b");
    rules(a.path(), "allow");
    rules(b.path(), "allow");
    board_with(b.path(), "t-only-b", "Only B has this task");

    let (text, is_error, _) = execute_board_tool(
        &s(b.path()),
        DISPATCH_TOOL,
        &json!({ "project": s(a.path()), "task": "t-only-b" }),
        CHAT_AUTHOR,
    )
    .await;
    assert!(is_error);
    assert!(text.contains("no task matching 't-only-b'"), "{text}");
}

#[tokio::test]
async fn sending_work_with_no_project_is_refused_before_anyone_is_asked() {
    let (text, is_error, _) = execute_board_tool(
        fleet(),
        DISPATCH_TOOL,
        &json!({ "text": "do the thing" }),
        CHAT_AUTHOR,
    )
    .await;
    assert!(is_error);
    assert!(text.contains("pass `project` explicitly"), "{text}");
}
