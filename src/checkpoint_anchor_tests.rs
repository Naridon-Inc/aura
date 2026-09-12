//! Hermetic tests for [`CheckpointStore::checkpoint_for_commit`] — every test
//! builds its own throwaway repo under a tempdir; no cwd changes, no shared
//! state, no network.
//!
//! What these pin is one specific failure the loop used to have: several
//! branches (or several crew runs) write into the one shared `refs/notes/aura`,
//! so "the newest checkpoint" is whoever committed most recently *anywhere*.
//! Grading a commit against that snapshot reports a confident, wrong zero.

use super::*;
use git2::Repository;
use std::path::Path;

fn init_repo(dir: &Path) -> Repository {
    let repo = Repository::init(dir).unwrap();
    let mut cfg = repo.config().unwrap();
    cfg.set_str("user.name", "Anchor Test").unwrap();
    cfg.set_str("user.email", "anchor@example.com").unwrap();
    repo
}

fn commit(repo: &Repository, msg: &str) -> git2::Oid {
    let mut index = repo.index().unwrap();
    let tree_id = index.write_tree().unwrap();
    let tree = repo.find_tree(tree_id).unwrap();
    let sig = repo.signature().unwrap();
    let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
    let parents: Vec<&git2::Commit> = parent.iter().collect();
    repo.commit(Some("HEAD"), &sig, &sig, msg, &tree, &parents).unwrap()
}

/// A checkpoint naming one built symbol, stamped at `timestamp`.
fn checkpoint(id: &str, symbol: &str, timestamp: u64) -> CheckpointData {
    CheckpointData {
        id: id.to_string(),
        agent_id: "anchor-test".to_string(),
        intent: format!("built {symbol}"),
        ast_nodes: vec![AstNode {
            node_id: format!("{symbol}#0"),
            kind: "function_definition".to_string(),
            identifier: Some(symbol.to_string()),
            content_hash: format!("hash-{symbol}"),
            children: Vec::new(),
            dependencies: Vec::new(),
            contains_secret: false,
            is_stub: false,
            derived_from: None,
            confidence: 1.0,
            file_path: Some("src/thing.ts".to_string()),
            start_line: Some(1),
            end_line: Some(9),
            signature: None,
            doc_comment: None,
            top_level: true,
        }],
        timestamp,
        intent_vector: None,
        intent_vector_model: None,
        env_fingerprint: None,
        file_oids: Default::default(),
        scope: None,
    }
}

fn note_on(repo: &Repository, oid: git2::Oid, data: &CheckpointData) {
    let c = repo.find_commit(oid).unwrap();
    CheckpointStore::add_note(repo, &c, data).unwrap();
}

/// The point of the whole thing: an OLDER commit still resolves to its OWN
/// snapshot, even when a newer checkpoint exists elsewhere in the repo.
#[test]
fn resolves_the_commits_own_snapshot_not_the_newest() {
    let dir = tempfile::tempdir().unwrap();
    let repo = init_repo(dir.path());

    let first = commit(&repo, "first");
    note_on(&repo, first, &checkpoint("cp-first", "buildsTheFirstThing", 1_000));

    let second = commit(&repo, "second");
    note_on(&repo, second, &checkpoint("cp-second", "buildsSomethingElse", 9_000));

    let found = CheckpointStore::checkpoint_for_commit(&repo, &first.to_string())
        .expect("the first commit carries a note");
    assert_eq!(found.id, "cp-first");
    assert_eq!(found.ast_nodes[0].identifier.as_deref(), Some("buildsTheFirstThing"));

    // …and the unanchored path really would have handed back the other one,
    // which is exactly the bug: same repo, same call, wrong answer.
    let newest = CheckpointStore::get_all_checkpoints(&repo).unwrap();
    assert_eq!(newest.first().unwrap().id, "cp-second");
}

/// A short sha is what the loop actually has to hand, so it must resolve too.
#[test]
fn accepts_a_short_sha_and_a_symbolic_rev() {
    let dir = tempfile::tempdir().unwrap();
    let repo = init_repo(dir.path());

    let only = commit(&repo, "only");
    note_on(&repo, only, &checkpoint("cp-only", "theThing", 1_000));

    let full = only.to_string();
    assert_eq!(
        CheckpointStore::checkpoint_for_commit(&repo, &full[..9]).unwrap().id,
        "cp-only"
    );
    assert_eq!(
        CheckpointStore::checkpoint_for_commit(&repo, "HEAD").unwrap().id,
        "cp-only"
    );
}

/// No note on the commit is "we can't judge this", NOT "nothing was built".
/// Callers turn `None` into an `unknown` verdict, which never fails a node —
/// the alternative is discarding good work over missing evidence.
#[test]
fn a_commit_without_a_snapshot_is_none_never_a_neighbours_snapshot() {
    let dir = tempfile::tempdir().unwrap();
    let repo = init_repo(dir.path());

    let noted = commit(&repo, "noted");
    note_on(&repo, noted, &checkpoint("cp-noted", "theThing", 1_000));
    let bare = commit(&repo, "bare — the agent committed with hooks skipped");

    assert!(CheckpointStore::checkpoint_for_commit(&repo, &bare.to_string()).is_none());
    // Its parent has one, and we must NOT silently borrow it.
    assert!(CheckpointStore::checkpoint_for_commit(&repo, &noted.to_string()).is_some());
}

/// A repo with no `refs/notes/aura` at all, and a rev that doesn't exist,
/// both answer `None` rather than panicking.
#[test]
fn missing_notes_ref_or_unknown_rev_is_none() {
    let dir = tempfile::tempdir().unwrap();
    let repo = init_repo(dir.path());
    let only = commit(&repo, "only");

    assert!(CheckpointStore::checkpoint_for_commit(&repo, &only.to_string()).is_none());
    assert!(CheckpointStore::checkpoint_for_commit(&repo, "deadbeefdeadbeef").is_none());
}
