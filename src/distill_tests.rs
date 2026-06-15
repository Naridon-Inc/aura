//! Hermetic tests for `aura distill` — every test builds its own throwaway
//! repo under a tempdir; no cwd changes, no shared state, no network.

use super::*;
use git2::Repository;
use std::fs;
use std::path::Path;

fn init_repo(dir: &Path) -> Repository {
    let repo = Repository::init(dir).unwrap();
    let mut cfg = repo.config().unwrap();
    cfg.set_str("user.name", "Distill Test").unwrap();
    cfg.set_str("user.email", "distill@example.com").unwrap();
    repo
}

fn write_file(root: &Path, rel: &str, content: &str) {
    let p = root.join(rel);
    fs::create_dir_all(p.parent().unwrap()).unwrap();
    fs::write(p, content).unwrap();
}

fn commit_all(repo: &Repository, msg: &str) -> git2::Oid {
    let mut index = repo.index().unwrap();
    index
        .add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None)
        .unwrap();
    index.write().unwrap();
    let tree_id = index.write_tree().unwrap();
    let tree = repo.find_tree(tree_id).unwrap();
    let sig = repo.signature().unwrap();
    let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
    let parents: Vec<&git2::Commit> = parent.iter().collect();
    repo.commit(Some("HEAD"), &sig, &sig, msg, &tree, &parents)
        .unwrap()
}

/// Append rows to .aura/intent_log.jsonl — the same shape aura_log_intent
/// writes (timestamp / agent_id / intent / intent_type / key_id / ...).
fn write_intents(root: &Path, rows: &[serde_json::Value]) {
    let lines: Vec<String> = rows.iter().map(|r| r.to_string()).collect();
    write_file(root, ".aura/intent_log.jsonl", &(lines.join("\n") + "\n"));
}

fn opts(dry_run: bool, json: bool, include_untracked: bool, max_groups: usize) -> DistillOptions {
    DistillOptions {
        dry_run,
        json,
        include_untracked,
        max_groups,
    }
}

/// Count of dirty *tracked* entries (untracked excluded on purpose: the
/// hermetic intent log itself stays untracked in most tests).
fn dirty_tracked(repo: &Repository) -> usize {
    let mut so = git2::StatusOptions::new();
    so.include_untracked(false);
    repo.statuses(Some(&mut so)).unwrap().len()
}

/// Paths a commit changed vs its first parent (or vs empty for a root).
fn commit_paths(repo: &Repository, commit: &git2::Commit) -> Vec<String> {
    let parent_tree = commit.parent(0).ok().map(|p| p.tree().unwrap());
    let tree = commit.tree().unwrap();
    let diff = repo
        .diff_tree_to_tree(parent_tree.as_ref(), Some(&tree), None)
        .unwrap();
    let mut out: Vec<String> = diff
        .deltas()
        .filter_map(|d| d.new_file().path().map(|p| p.to_string_lossy().to_string()))
        .collect();
    out.sort();
    out
}

// (a) Two files + two matching intent rows → two commits, the right files in
// each, subjects typed from intent_type, bodies carrying the WHY verbatim.
#[test]
fn distill_two_intents_into_two_typed_commits() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let repo = init_repo(root);
    write_file(root, "src/login.rs", "pub fn login_flow() -> u32 { 1 }\n");
    write_file(root, "src/billing.rs", "pub fn billing_total() -> u32 { 2 }\n");
    commit_all(&repo, "initial");

    write_file(root, "src/login.rs", "pub fn login_flow() -> u32 { 41 }\n");
    write_file(root, "src/billing.rs", "pub fn billing_total() -> u32 { 42 }\n");
    write_intents(
        root,
        &[
            serde_json::json!({
                "timestamp": 100u64,
                "agent_id": "claude",
                "intent": "Rework the login flow to support OAuth refresh.",
                "intent_type": "FeatureAdd",
            }),
            serde_json::json!({
                "timestamp": 200u64,
                "agent_id": "claude",
                "intent": "Fix the billing rounding error in billing_total.",
                "intent_type": "BugFix",
                "key_id": "k1",
                "signed_block_id": "blk_42",
            }),
        ],
    );

    let plan = distill(&repo, &opts(false, false, false, 8)).unwrap();
    assert!(plan.error.is_none(), "unexpected error: {:?}", plan.error);
    assert_eq!(plan.groups.len(), 2);
    assert_eq!(plan.committed, 2);

    // Group order is intent-log order; subjects carry the conventional type.
    assert!(
        plan.groups[0].subject.starts_with("feat: "),
        "got subject {:?}",
        plan.groups[0].subject
    );
    assert!(plan.groups[1].subject.starts_with("fix: "));
    assert_eq!(
        plan.groups[0].files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(),
        vec!["src/login.rs"]
    );
    assert_eq!(
        plan.groups[1].files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(),
        vec!["src/billing.rs"]
    );

    // WHY verbatim + provenance trailers in the body.
    assert!(plan.groups[0]
        .message
        .contains("Why: Rework the login flow to support OAuth refresh."));
    assert!(plan.groups[0].message.contains("Agent: claude"));
    assert!(plan.groups[1]
        .message
        .contains("Why: Fix the billing rounding error in billing_total."));
    assert!(plan.groups[1].message.contains("Intent-Id: blk_42"));
    assert!(plan.groups[1].message.contains("Key-Id: k1"));

    // The commits actually landed, in order, each touching only its files.
    let head = repo.head().unwrap().peel_to_commit().unwrap();
    assert!(head.message().unwrap().starts_with("fix: "));
    assert_eq!(commit_paths(&repo, &head), vec!["src/billing.rs"]);
    let first = head.parent(0).unwrap();
    assert!(first.message().unwrap().starts_with("feat: "));
    assert_eq!(commit_paths(&repo, &first), vec!["src/login.rs"]);
    assert_eq!(first.parent(0).unwrap().message().unwrap(), "initial");

    // Author is the repo's configured user; the tree ends clean.
    assert_eq!(head.author().name(), Some("Distill Test"));
    assert_eq!(dirty_tracked(&repo), 0);
}

// (b) A file no intent explains lands in the honest leftover commit — fixed
// subject, no invented "Why".
#[test]
fn distill_no_intent_yields_honest_leftover_commit() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let repo = init_repo(root);
    write_file(root, "notes.txt", "first\n");
    commit_all(&repo, "initial");
    write_file(root, "notes.txt", "first\nsecond\n");

    let plan = distill(&repo, &opts(false, false, false, 8)).unwrap();
    assert!(plan.error.is_none());
    assert_eq!(plan.groups.len(), 1);
    assert_eq!(plan.groups[0].subject, LEFTOVER_SUBJECT);
    assert!(plan.groups[0].intent.is_none());
    assert!(!plan.groups[0].message.contains("Why:"));
    assert_eq!(plan.committed, 1);

    let head = repo.head().unwrap().peel_to_commit().unwrap();
    assert_eq!(
        head.message().unwrap().trim(),
        "chore: remaining changes (no recorded intent)"
    );
    assert_eq!(commit_paths(&repo, &head), vec!["notes.txt"]);
    assert_eq!(dirty_tracked(&repo), 0);
}

// (c) Dry-run commits nothing and the JSON plan is a stable machine shape.
#[test]
fn distill_dry_run_commits_nothing_and_json_parses() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let repo = init_repo(root);
    write_file(root, "src/cache.rs", "pub fn cache_get() -> u32 { 1 }\n");
    commit_all(&repo, "initial");
    let head_before = repo.head().unwrap().target().unwrap();

    write_file(root, "src/cache.rs", "pub fn cache_get() -> u32 { 7 }\n");
    write_intents(
        root,
        &[serde_json::json!({
            "timestamp": 100u64,
            "agent_id": "claude",
            "intent": "Speed up cache lookups in cache.rs.",
            "intent_type": "Performance",
        })],
    );

    let plan = distill(&repo, &opts(true, true, false, 8)).unwrap();
    assert_eq!(plan.mode, "plan");
    assert_eq!(plan.committed, 0);

    // Nothing moved: HEAD identical, working tree still dirty.
    assert_eq!(repo.head().unwrap().target().unwrap(), head_before);
    assert!(dirty_tracked(&repo) > 0);

    // The JSON round-trips and exposes the stable keys.
    let v: serde_json::Value =
        serde_json::from_str(&serde_json::to_string(&plan).unwrap()).unwrap();
    assert_eq!(v["mode"], "plan");
    assert_eq!(v["groups"].as_array().unwrap().len(), 1);
    let g = &v["groups"][0];
    assert!(g["subject"].as_str().unwrap().starts_with("perf: "));
    assert!(g["message"].as_str().unwrap().contains("Why: Speed up cache lookups in cache.rs."));
    assert!(g["commit"].is_null());
    assert_eq!(g["files"][0]["path"], "src/cache.rs");
    assert_eq!(g["files"][0]["symbols"][0]["name"], "cache_get");
    assert_eq!(g["files"][0]["symbols"][0]["action"], "modified");
}

// (d) Symbol-level WHAT shows up in the subject for a parsed .rs change.
#[test]
fn distill_subject_carries_symbol_level_what() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let repo = init_repo(root);
    write_file(
        root,
        "src/interest.rs",
        "pub fn compute_interest(p: f64) -> f64 { p * 0.05 }\n",
    );
    commit_all(&repo, "initial");
    write_file(
        root,
        "src/interest.rs",
        "pub fn compute_interest(p: f64) -> f64 { p * 0.04 }\npub fn apr_to_apy(r: f64) -> f64 { r }\n",
    );
    write_intents(
        root,
        &[serde_json::json!({
            "timestamp": 100u64,
            "agent_id": "claude",
            "intent": "Restructure the interest math module.",
            "intent_type": "Refactor",
        })],
    );

    let plan = distill(&repo, &opts(true, false, false, 8)).unwrap();
    assert_eq!(plan.groups.len(), 1);
    let subject = &plan.groups[0].subject;
    assert_eq!(subject, "refactor: add apr_to_apy; update compute_interest");
    assert!(subject.chars().count() <= 72);
}

// (e) --max-groups overflow merges into the nearest group by shared
// directory, the merge is reported, and no file is lost.
#[test]
fn distill_max_groups_overflow_merges_and_reports() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let repo = init_repo(root);
    write_file(root, "src/a/alpha.rs", "pub fn alpha_run() -> u32 { 1 }\n");
    write_file(root, "src/a/beta.rs", "pub fn beta_run() -> u32 { 2 }\n");
    write_file(root, "src/b/gamma.rs", "pub fn gamma_run() -> u32 { 3 }\n");
    commit_all(&repo, "initial");
    write_file(root, "src/a/alpha.rs", "pub fn alpha_run() -> u32 { 10 }\n");
    write_file(root, "src/a/beta.rs", "pub fn beta_run() -> u32 { 20 }\n");
    write_file(root, "src/b/gamma.rs", "pub fn gamma_run() -> u32 { 30 }\n");
    write_intents(
        root,
        &[
            serde_json::json!({
                "timestamp": 100u64, "agent_id": "claude",
                "intent": "Tighten alpha handling.", "intent_type": "Refactor",
            }),
            serde_json::json!({
                "timestamp": 200u64, "agent_id": "claude",
                "intent": "Tighten beta handling.", "intent_type": "Refactor",
            }),
            serde_json::json!({
                "timestamp": 300u64, "agent_id": "claude",
                "intent": "Tighten gamma handling.", "intent_type": "Refactor",
            }),
        ],
    );

    let plan = distill(&repo, &opts(true, false, false, 2)).unwrap();
    assert_eq!(plan.groups.len(), 2);

    // Every dirty file appears exactly once across the plan.
    let mut all: Vec<&str> = plan
        .groups
        .iter()
        .flat_map(|g| g.files.iter().map(|f| f.path.as_str()))
        .collect();
    all.sort();
    assert_eq!(all, vec!["src/a/alpha.rs", "src/a/beta.rs", "src/b/gamma.rs"]);

    // The gamma group (overflow, lowest rank) merged somewhere and said so.
    assert!(
        plan.notes.iter().any(|n| n.contains("merged") && n.contains("gamma")),
        "expected a merge note, got: {:?}",
        plan.notes
    );
    let merged = plan.groups.iter().find(|g| g.files.len() == 2).unwrap();
    assert!(merged.files.iter().any(|f| f.path == "src/b/gamma.rs"));
}

// (f) Untracked files are excluded by default and included (into the honest
// leftover group) only with --include-untracked. Nothing is ever lost.
#[test]
fn distill_untracked_only_with_flag() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let repo = init_repo(root);
    write_file(root, "README.md", "hello\n");
    commit_all(&repo, "initial");
    write_file(root, "extra.txt", "scratch\n");

    // Without the flag: nothing to distill.
    let plan = distill(&repo, &opts(true, false, false, 8)).unwrap();
    assert!(plan.groups.is_empty());

    // With the flag: the untracked file rides in the leftover group...
    let plan = distill(&repo, &opts(false, false, true, 8)).unwrap();
    assert!(plan.error.is_none());
    assert_eq!(plan.groups.len(), 1);
    assert_eq!(plan.groups[0].subject, LEFTOVER_SUBJECT);
    assert_eq!(plan.groups[0].files[0].path, "extra.txt");
    assert_eq!(plan.groups[0].files[0].change, "added");

    // ...and is genuinely committed.
    let head = repo.head().unwrap().peel_to_commit().unwrap();
    assert_eq!(commit_paths(&repo, &head), vec!["extra.txt"]);
    let mut so = git2::StatusOptions::new();
    so.include_untracked(true);
    assert_eq!(repo.statuses(Some(&mut so)).unwrap().len(), 0);
}

// Deterministic subject composer: 72-char budget, overflow degrades to "+N
// more" instead of an over-long or truncated-mid-word subject.
#[test]
fn distill_subject_budget_is_respected() {
    let files: Vec<FileChange> = (0..12)
        .map(|i| FileChange {
            path: format!("src/m{i}.rs"),
            change: "modified".to_string(),
            symbols: vec![ChangedSymbol {
                name: format!("very_long_symbol_name_number_{i:02}"),
                action: "added".to_string(),
                line: None,
                kind: None,
            }],
        })
        .collect();
    let subject = compose_line(Some("feat"), &summary_items(&files), 72);
    assert!(subject.chars().count() <= 72, "subject too long: {subject:?}");
    assert!(subject.starts_with("feat: add "));
    assert!(subject.ends_with("more"), "expected overflow marker: {subject:?}");

    // And the conventional-type mapping is exactly the documented table.
    assert_eq!(type_prefix(Some("FeatureAdd")), "feat");
    assert_eq!(type_prefix(Some("BugFix")), "fix");
    assert_eq!(type_prefix(Some("Refactor")), "refactor");
    assert_eq!(type_prefix(Some("Docs")), "docs");
    assert_eq!(type_prefix(Some("Deps")), "build");
    assert_eq!(type_prefix(Some("Performance")), "perf");
    assert_eq!(type_prefix(Some("Revert")), "revert");
    assert_eq!(type_prefix(None), "chore");
    assert_eq!(type_prefix(Some("SomethingElse")), "chore");
}
