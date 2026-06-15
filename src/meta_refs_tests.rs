// Hermetic tests for `aura meta` (M4a slice 1). Everything runs in tmp
// dirs against a LOCAL bare repo standing in for "origin" — zero
// network. Library functions are called directly; the `git` binary is
// shelled out only for transport (clone/push/fetch on local paths),
// mirroring exactly what the commands do.

use super::notes::{
    attribute_rows, collect_log, merge_incoming_notes, parse_note_line, render_note_line,
    union_lines, write_notes_for_range, CommitWindow, NoteLine, INCOMING_REF, NOTES_REF,
};
use crate::intent_query::IntentRow;
use git2::{Oid, Repository, Signature, Time};
use std::path::Path;
use std::process::Command;

// ---------- helpers ----------

fn row(ts: u64, agent: &str, intent: &str) -> IntentRow {
    IntentRow {
        timestamp: ts,
        agent_id: agent.to_string(),
        intent: intent.to_string(),
        intent_type: Some("BugFix".to_string()),
        signed_block_id: Some(format!("blk_{}", ts)),
        key_id: Some("k1".to_string()),
    }
}

fn window(oid_seed: u8, who: &str, parent_time: i64, commit_time: i64) -> CommitWindow {
    CommitWindow {
        oid: Oid::from_bytes(&[oid_seed; 20]).unwrap(),
        who: who.to_lowercase(),
        parent_time,
        commit_time,
    }
}

fn sh_git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("HOME", dir)
        .output()
        .expect("spawn git");
    assert!(
        out.status.success(),
        "git {:?} failed in {:?}: {}",
        args,
        dir,
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).to_string()
}

/// Create a commit with a controlled timestamp so attribution windows
/// are deterministic.
fn commit_file(
    repo: &Repository,
    name: &str,
    content: &str,
    msg: &str,
    when_secs: i64,
    author: &str,
    email: &str,
) -> Oid {
    let workdir = repo.workdir().expect("non-bare");
    std::fs::write(workdir.join(name), content).unwrap();
    let mut index = repo.index().unwrap();
    index.add_path(Path::new(name)).unwrap();
    index.write().unwrap();
    let tree_id = index.write_tree().unwrap();
    let tree = repo.find_tree(tree_id).unwrap();
    let sig = Signature::new(author, email, &Time::new(when_secs, 0)).unwrap();
    let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
    let parents: Vec<&git2::Commit> = parent.iter().collect();
    repo.commit(Some("HEAD"), &sig, &sig, msg, &tree, &parents)
        .unwrap()
}

// ---------- unit: note-line ser/de ----------

#[test]
fn note_line_render_is_deterministic_and_round_trips() {
    let r = row(100, "claude", "fix the retry loop");
    let line = render_note_line(&NoteLine::from(&r));
    assert_eq!(
        line,
        r#"{"ts":100,"agent_id":"claude","intent":"fix the retry loop","intent_type":"BugFix","key_id":"k1","signed_block_id":"blk_100"}"#
    );
    let parsed = parse_note_line(&line).unwrap();
    assert_eq!(parsed, NoteLine::from(&r));
}

#[test]
fn note_line_omits_absent_optionals() {
    let r = IntentRow {
        timestamp: 5,
        agent_id: "a".into(),
        intent: "x".into(),
        intent_type: None,
        signed_block_id: None,
        key_id: None,
    };
    let line = render_note_line(&NoteLine::from(&r));
    assert_eq!(line, r#"{"ts":5,"agent_id":"a","intent":"x"}"#);
}

#[test]
fn parse_note_line_accepts_legacy_timestamp_key() {
    let parsed =
        parse_note_line(r#"{"timestamp":42,"agent_id":"a","intent":"legacy row"}"#).unwrap();
    assert_eq!(parsed.ts, 42);
    assert_eq!(parsed.intent, "legacy row");
}

#[test]
fn parse_note_line_rejects_blank_and_garbage() {
    assert!(parse_note_line("").is_none());
    assert!(parse_note_line("   ").is_none());
    assert!(parse_note_line("not json").is_none());
    assert!(parse_note_line(r#"{"ts":1}"#).is_none()); // no intent
}

// ---------- unit: union merge ----------

#[test]
fn union_lines_dedupes_exact_lines_and_preserves_order() {
    let existing = "a\nb\n";
    let additions = vec!["b".to_string(), "c".to_string(), "a".to_string()];
    let (merged, added) = union_lines(Some(existing), &additions);
    assert_eq!(merged, "a\nb\nc\n");
    assert_eq!(added, 1);
}

#[test]
fn union_lines_from_empty_existing() {
    let additions = vec!["x".to_string(), "x".to_string(), "y".to_string()];
    let (merged, added) = union_lines(None, &additions);
    assert_eq!(merged, "x\ny\n");
    assert_eq!(added, 2);
}

#[test]
fn union_lines_is_idempotent() {
    let additions = vec!["x".to_string(), "y".to_string()];
    let (first, _) = union_lines(None, &additions);
    let (second, added) = union_lines(Some(&first), &additions);
    assert_eq!(first, second);
    assert_eq!(added, 0);
}

// ---------- unit: timestamp-attribution windowing ----------

#[test]
fn attribute_window_bounds_are_exclusive_inclusive() {
    // windows newest-first: c2 (100,200], c1 (0,100]
    let windows = vec![window(2, "dev <d@x>", 100, 200), window(1, "dev <d@x>", 0, 100)];
    let rows = vec![
        row(100, "dev", "exactly parent time of c2 → c1"), // ts == c1.commit_time → c1
        row(101, "dev", "just inside c2"),
        row(200, "dev", "exactly c2 commit time → c2"),
    ];
    let a = attribute_rows(&windows, &rows);
    assert_eq!(a.windowed, 3);
    assert_eq!(a.unmatched, 0);
    assert_eq!(a.per_commit[1].len(), 1); // c1
    assert_eq!(a.per_commit[1][0].intent, "exactly parent time of c2 → c1");
    assert_eq!(a.per_commit[0].len(), 2); // c2
}

#[test]
fn attribute_unmatched_rows_go_to_newest_commit() {
    let windows = vec![window(2, "dev <d@x>", 100, 200), window(1, "dev <d@x>", 0, 100)];
    let rows = vec![
        row(999, "dev", "after every commit"),
        row(0, "dev", "legacy zero ts"),
    ];
    let a = attribute_rows(&windows, &rows);
    assert_eq!(a.windowed, 0);
    assert_eq!(a.unmatched, 2);
    // Newest = max commit_time = c2 = index 0
    assert_eq!(a.per_commit[0].len(), 2);
    assert_eq!(a.per_commit[1].len(), 0);
}

#[test]
fn attribute_prefers_agent_match_on_overlapping_windows() {
    // Two overlapping windows (merge topology): same span, different
    // authors. The row's agent_id should pick its author's commit even
    // though the other window also contains the timestamp.
    let windows = vec![
        window(2, "Claude Agent <claude@anthropic.com>", 100, 300),
        window(1, "Gemini Agent <gemini@google.com>", 100, 300),
    ];
    let rows = vec![row(150, "gemini", "gemini work"), row(160, "claude", "claude work")];
    let a = attribute_rows(&windows, &rows);
    assert_eq!(a.windowed, 2);
    assert_eq!(a.per_commit[0].len(), 1);
    assert_eq!(a.per_commit[0][0].intent, "claude work");
    assert_eq!(a.per_commit[1].len(), 1);
    assert_eq!(a.per_commit[1][0].intent, "gemini work");
}

#[test]
fn attribute_overlap_without_agent_match_picks_earliest_seal() {
    let windows = vec![
        window(2, "dev <d@x>", 100, 300), // sealed later
        window(1, "dev <d@x>", 100, 250), // sealed earlier — tighter
    ];
    let rows = vec![row(200, "somebody-else", "ambiguous work")];
    let a = attribute_rows(&windows, &rows);
    assert_eq!(a.per_commit[1].len(), 1);
    assert_eq!(a.per_commit[0].len(), 0);
}

#[test]
fn attribute_with_no_commits_drops_nothing_into_panic() {
    let a = attribute_rows(&[], &[row(1, "a", "x")]);
    assert_eq!(a.windowed, 0);
    assert_eq!(a.unmatched, 0);
    assert!(a.per_commit.is_empty());
}

#[test]
fn attribute_sorts_rows_oldest_first_within_a_commit() {
    let windows = vec![window(1, "dev <d@x>", 0, 100)];
    let rows = vec![row(90, "dev", "later"), row(10, "dev", "earlier")];
    let a = attribute_rows(&windows, &rows);
    assert_eq!(a.per_commit[0][0].intent, "earlier");
    assert_eq!(a.per_commit[0][1].intent, "later");
}

// ---------- integration: hermetic round-trip through a bare origin ----------

#[test]
fn meta_round_trip_through_local_bare_origin() {
    let tmp = tempfile::tempdir().unwrap();
    let origin = tmp.path().join("origin.git");
    let a_dir = tmp.path().join("clone_a");
    let b_dir = tmp.path().join("clone_b");

    sh_git(tmp.path(), &["init", "--bare", origin.to_str().unwrap()]);
    sh_git(
        tmp.path(),
        &["clone", origin.to_str().unwrap(), a_dir.to_str().unwrap()],
    );

    let repo_a = Repository::open(&a_dir).unwrap();
    // Two commits with controlled times: t1=1_000_000, t2=1_000_200.
    let t1: i64 = 1_000_000;
    let t2: i64 = 1_000_200;
    let c1 = commit_file(
        &repo_a, "one.txt", "one", "feat: first", t1, "Claude Agent", "claude@anthropic.com",
    );
    let c2 = commit_file(
        &repo_a, "two.txt", "two", "feat: second", t2, "Claude Agent", "claude@anthropic.com",
    );
    sh_git(&a_dir, &["push", "origin", "HEAD"]);

    // Synthetic intent log: one row inside (t1,t2] → c2, one inside
    // (0,t1] → c1, one after t2 → unmatched → newest (c2).
    let aura_dir = a_dir.join(".aura");
    std::fs::create_dir_all(&aura_dir).unwrap();
    let log = format!(
        "{}\n{}\n{}\n",
        format!(
            r#"{{"timestamp":{},"agent_id":"claude","intent":"prep the ground","intent_type":"Refactor","key_id":"kA","signed_block_id":"b1"}}"#,
            t1 - 50
        ),
        format!(
            r#"{{"timestamp":{},"agent_id":"claude","intent":"wire the feature","intent_type":"FeatureAdd","key_id":"kA","signed_block_id":"b2"}}"#,
            t1 + 100
        ),
        format!(
            r#"{{"timestamp":{},"agent_id":"claude","intent":"post-commit note to self","intent_type":"Docs","key_id":"kA","signed_block_id":"b3"}}"#,
            t2 + 999
        ),
    );
    std::fs::write(aura_dir.join("intent_log.jsonl"), log).unwrap();

    // --- push side (library fn + transport shell to LOCAL origin) ---
    let report = write_notes_for_range(&repo_a, None).unwrap();
    assert_eq!(report.commits_in_range, 2);
    assert_eq!(report.commits_noted, 2);
    assert_eq!(report.rows_attached, 3);
    assert_eq!(report.rows_windowed, 2);
    assert_eq!(report.rows_unmatched, 1);
    assert_eq!(report.rows_already_noted, 0);

    // Idempotency: a second run attaches nothing and re-notes nothing.
    let again = write_notes_for_range(&repo_a, None).unwrap();
    assert_eq!(again.rows_attached, 0);
    assert_eq!(again.commits_noted, 0);
    assert_eq!(again.rows_already_noted, 3);

    // Explicit range over already-noted commits: union-merge keeps it
    // a no-op rather than duplicating lines.
    let ranged = write_notes_for_range(&repo_a, Some("HEAD~1..HEAD")).unwrap();
    assert_eq!(ranged.commits_in_range, 1);
    assert_eq!(ranged.rows_attached, 0);

    sh_git(&a_dir, &["push", "origin", NOTES_REF]);

    // --- pull side ---
    sh_git(
        tmp.path(),
        &["clone", origin.to_str().unwrap(), b_dir.to_str().unwrap()],
    );
    let repo_b = Repository::open(&b_dir).unwrap();
    let refspec = format!("+{}:{}", NOTES_REF, INCOMING_REF);
    sh_git(&b_dir, &["fetch", "origin", &refspec]);

    let pull = merge_incoming_notes(&repo_b).unwrap();
    assert!(pull.incoming_present);
    assert_eq!(pull.commits_seen, 2);
    assert_eq!(pull.commits_updated, 2);
    assert_eq!(pull.lines_added, 3);
    // Staging ref is cleaned up; the real ref exists.
    assert!(repo_b.find_reference(INCOMING_REF).is_err());
    assert!(repo_b.find_reference(NOTES_REF).is_ok());

    // Merging again after a re-fetch adds nothing (union semantics).
    sh_git(&b_dir, &["fetch", "origin", &refspec]);
    let pull2 = merge_incoming_notes(&repo_b).unwrap();
    assert!(pull2.incoming_present);
    assert_eq!(pull2.lines_added, 0);
    assert_eq!(pull2.commits_updated, 0);

    // --- log side: right intent on the right commit ---
    let entries = collect_log(&repo_b, 10).unwrap();
    assert_eq!(entries.len(), 2);
    // Newest-first: entries[0] = c2, entries[1] = c1.
    assert_eq!(entries[0].sha, c2.to_string());
    assert_eq!(entries[1].sha, c1.to_string());

    let c2_intents: Vec<&str> = entries[0].rows.iter().map(|r| r.intent.as_str()).collect();
    assert_eq!(
        c2_intents,
        vec!["wire the feature", "post-commit note to self"],
        "c2 carries the windowed row AND the unmatched→newest row, oldest-first"
    );
    assert_eq!(entries[0].summary, "feat: second");

    let c1_intents: Vec<&str> = entries[1].rows.iter().map(|r| r.intent.as_str()).collect();
    assert_eq!(c1_intents, vec!["prep the ground"]);
    assert_eq!(entries[1].rows[0].intent_type.as_deref(), Some("Refactor"));
    assert_eq!(entries[1].rows[0].key_id.as_deref(), Some("kA"));
    assert_eq!(entries[1].rows[0].agent_id, "claude");

    // The plane is plain git: the bare origin itself carries the ref.
    let ls = sh_git(&origin, &["for-each-ref", "refs/notes"]);
    assert!(
        ls.contains("refs/notes/aura-intent"),
        "origin must hold the notes ref: {}",
        ls
    );
}

#[test]
fn meta_pull_merges_divergent_notes_as_union() {
    // A and B both note the SAME commit with different rows; after B
    // pulls A's ref into the staging ref, B's note is the union.
    let tmp = tempfile::tempdir().unwrap();
    let origin = tmp.path().join("origin.git");
    let a_dir = tmp.path().join("a");
    let b_dir = tmp.path().join("b");
    sh_git(tmp.path(), &["init", "--bare", origin.to_str().unwrap()]);
    sh_git(
        tmp.path(),
        &["clone", origin.to_str().unwrap(), a_dir.to_str().unwrap()],
    );
    let repo_a = Repository::open(&a_dir).unwrap();
    let t1: i64 = 2_000_000;
    commit_file(&repo_a, "f.txt", "f", "feat: shared", t1, "Dev", "dev@x.com");
    sh_git(&a_dir, &["push", "origin", "HEAD"]);

    // A notes the commit with row 1 and pushes the ref.
    let aura_a = a_dir.join(".aura");
    std::fs::create_dir_all(&aura_a).unwrap();
    std::fs::write(
        aura_a.join("intent_log.jsonl"),
        format!(
            "{}\n",
            format!(
                r#"{{"timestamp":{},"agent_id":"claude","intent":"row from A"}}"#,
                t1 - 1
            )
        ),
    )
    .unwrap();
    write_notes_for_range(&repo_a, None).unwrap();
    sh_git(&a_dir, &["push", "origin", NOTES_REF]);

    // B clones, writes its OWN different row locally (no push), then
    // pulls A's notes — union must hold both rows.
    sh_git(
        tmp.path(),
        &["clone", origin.to_str().unwrap(), b_dir.to_str().unwrap()],
    );
    let repo_b = Repository::open(&b_dir).unwrap();
    let aura_b = b_dir.join(".aura");
    std::fs::create_dir_all(&aura_b).unwrap();
    std::fs::write(
        aura_b.join("intent_log.jsonl"),
        format!(
            "{}\n",
            format!(
                r#"{{"timestamp":{},"agent_id":"gemini","intent":"row from B"}}"#,
                t1 - 2
            )
        ),
    )
    .unwrap();
    write_notes_for_range(&repo_b, None).unwrap();

    let refspec = format!("+{}:{}", NOTES_REF, INCOMING_REF);
    sh_git(&b_dir, &["fetch", "origin", &refspec]);
    let pull = merge_incoming_notes(&repo_b).unwrap();
    assert_eq!(pull.lines_added, 1, "only A's row is new to B");

    let entries = collect_log(&repo_b, 10).unwrap();
    assert_eq!(entries.len(), 1);
    let intents: Vec<&str> = entries[0].rows.iter().map(|r| r.intent.as_str()).collect();
    assert!(intents.contains(&"row from A"));
    assert!(intents.contains(&"row from B"));
    assert_eq!(entries[0].rows.len(), 2);
}
