// Hermetic tests for `aura meta` (M4a slice 1). Everything runs in tmp
// dirs against a LOCAL bare repo standing in for "origin" — zero
// network. Library functions are called directly; the `git` binary is
// shelled out only for transport (clone/push/fetch on local paths),
// mirroring exactly what the commands do.

use super::notes::{
    attribute_rows, build_proof_note, collect_log, merge_incoming_notes, parse_note_line,
    parse_proof_note, render_note_line, render_proof_note, union_lines, verify_range,
    write_notes_for_range, write_proof_for_range, CommitWindow, NoteLine, INCOMING_REF, NOTES_REF,
    PROOF_REF,
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
        source: None,
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
        source: None,
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

// ---------- proof plane (M4 — refs/notes/aura-proof) ----------

/// Write a `.aura/goals.jsonl` with a single goal whose newest run binds to
/// `commit` (a sha prefix) with the given verdict. Deterministic `at`.
fn write_goal_ledger(
    workdir: &Path,
    goal_text: &str,
    commit_prefix: &str,
    verdict: &str,
    ok: usize,
    total: usize,
    at: u64,
) {
    let aura = workdir.join(".aura");
    std::fs::create_dir_all(&aura).unwrap();
    // id is djb2 of normalized text — any stable string works for the test
    // since we round-trip through build_proof_note which doesn't recompute it.
    let id = crate::goals::store::id_for_text(goal_text);
    let record = serde_json::json!({
        "id": id,
        "text": goal_text,
        "runs": [
            {
                "run_key": "build",
                "verdict": verdict,
                "ok": ok,
                "total": total,
                "commit": commit_prefix,
                "at": at,
            }
        ],
        "created_at": at,
        "updated_at": at,
    });
    std::fs::write(
        aura.join("goals.jsonl"),
        format!("{}\n", serde_json::to_string(&record).unwrap()),
    )
    .unwrap();
}

#[test]
fn proof_note_render_round_trips() {
    let note = build_proof_note_fixture();
    let body = render_proof_note(&note);
    let parsed = parse_proof_note(&body).unwrap();
    assert_eq!(parsed, note);
    // Compact single line — no pretty-printing.
    assert!(!body.contains('\n'));
}

fn build_proof_note_fixture() -> super::notes::ProofNote {
    super::notes::ProofNote {
        commit: "a".repeat(40),
        verdict: "verified".to_string(),
        ok: 3,
        total: 3,
        goals: vec![super::notes::ProofGoal {
            id: "goal_x".to_string(),
            text: "users can sign in".to_string(),
            verdict: "verified".to_string(),
            ok: 3,
            total: 3,
        }],
        at: 1_700_000_000_000,
    }
}

#[test]
fn proof_round_trip_write_and_verify_through_repo() {
    let tmp = tempfile::tempdir().unwrap();
    let origin = tmp.path().join("origin.git");
    let a_dir = tmp.path().join("clone_a");
    sh_git(tmp.path(), &["init", "--bare", origin.to_str().unwrap()]);
    sh_git(
        tmp.path(),
        &["clone", origin.to_str().unwrap(), a_dir.to_str().unwrap()],
    );

    let repo = Repository::open(&a_dir).unwrap();
    let t1: i64 = 3_000_000;
    let c1 = commit_file(
        &repo, "f.txt", "f", "feat: provable", t1, "Claude Agent", "claude@anthropic.com",
    );

    // Goal proven against a sha-prefix of c1 (mirrors the auto-prove path,
    // which records the short sha).
    let prefix: String = c1.to_string().chars().take(12).collect();
    write_goal_ledger(
        &a_dir,
        "users can sign in via google",
        &prefix,
        "verified",
        3,
        3,
        1_700_000_000_000,
    );

    // build_proof_note selects the goal by prefix and rolls up to verified.
    let note = build_proof_note(&a_dir, &c1.to_string()).expect("a proof note for c1");
    assert_eq!(note.commit, c1.to_string());
    assert_eq!(note.verdict, "verified");
    assert_eq!(note.ok, 3);
    assert_eq!(note.total, 3);
    assert_eq!(note.goals.len(), 1);

    // A commit with no matching goal gets no note.
    assert!(build_proof_note(&a_dir, &"f".repeat(40)).is_none());

    // write_proof_for_range creates the note under PROOF_REF.
    let report = write_proof_for_range(&repo, None).unwrap();
    assert_eq!(report.commits_in_range, 1);
    assert_eq!(report.commits_proven, 1);
    assert_eq!(report.commits_changed, 1);
    assert!(repo.find_note(Some(PROOF_REF), c1).is_ok());

    // Idempotent: an unchanged snapshot writes nothing the second time.
    let again = write_proof_for_range(&repo, None).unwrap();
    assert_eq!(again.commits_proven, 1);
    assert_eq!(again.commits_changed, 0);

    // verify_range reports the commit as proven AND bound.
    let v = verify_range(&repo, None).unwrap();
    assert_eq!(v.commits, 1);
    assert_eq!(v.proven, 1);
    assert!(v.ok);
    assert!(v.issues.is_empty());
    assert_eq!(v.per_commit.len(), 1);
    assert!(v.per_commit[0].binding_ok);
    assert_eq!(
        v.per_commit[0].proof.as_ref().unwrap().verdict,
        "verified"
    );

    // render/parse round-trips the exact snapshot build produced.
    let reparsed = parse_proof_note(&render_proof_note(&note)).unwrap();
    assert_eq!(reparsed, note);

    // collect_log carries the proof on a commit that ALSO has intent: write
    // an intent row in c1's window, push intent notes, and confirm the log
    // entry surfaces the proof snapshot alongside the rows.
    std::fs::write(
        a_dir.join(".aura").join("intent_log.jsonl"),
        format!(
            "{}\n",
            format!(
                r#"{{"timestamp":{},"agent_id":"claude","intent":"wire sign-in"}}"#,
                t1 - 1
            )
        ),
    )
    .unwrap();
    write_notes_for_range(&repo, None).unwrap();
    let entries = collect_log(&repo, 10).unwrap();
    assert_eq!(entries.len(), 1);
    let proof = entries[0].proof.as_ref().expect("log entry carries proof");
    assert_eq!(proof.verdict, "verified");
    assert_eq!(proof.commit, c1.to_string());
}

#[test]
fn proof_verify_rejects_a_tampered_binding() {
    let tmp = tempfile::tempdir().unwrap();
    let origin = tmp.path().join("origin.git");
    let a_dir = tmp.path().join("clone_a");
    sh_git(tmp.path(), &["init", "--bare", origin.to_str().unwrap()]);
    sh_git(
        tmp.path(),
        &["clone", origin.to_str().unwrap(), a_dir.to_str().unwrap()],
    );
    let repo = Repository::open(&a_dir).unwrap();
    let t1: i64 = 3_100_000;
    let c1 = commit_file(
        &repo, "f.txt", "f", "feat: tampered", t1, "Dev", "dev@x.com",
    );

    // Hand-write a proof note whose `commit` field points at the WRONG oid.
    let bogus = super::notes::ProofNote {
        commit: "0".repeat(40), // not c1
        verdict: "verified".to_string(),
        ok: 1,
        total: 1,
        goals: vec![],
        at: 1_700_000_000_000,
    };
    let sig = Signature::new("aura", "meta@aura.local", &Time::new(t1, 0)).unwrap();
    let body = render_proof_note(&bogus);
    repo.note(&sig, &sig, Some(PROOF_REF), c1, &body, true).unwrap();

    let v = verify_range(&repo, None).unwrap();
    assert_eq!(v.commits, 1);
    assert_eq!(v.proofs, 1, "a (mis-bound) proof note is still present");
    assert_eq!(
        v.proven, 0,
        "a note that binds to another commit is evidence about that commit, not this one"
    );
    assert!(!v.ok, "tampered binding makes the report not-ok");
    assert_eq!(v.issues.len(), 1);
    assert!(!v.per_commit[0].binding_ok);
    assert!(v.issues[0].contains("binds to"));
}

/// A proof note whose verdict says the goals were never wired up is not a
/// proof that they were. `proven` counted any parseable note, so the desktop
/// panel printed "Verified on this clone — N changes proven" over evidence
/// that said the opposite, in green, under a shield.
#[test]
fn verify_counts_by_verdict_not_by_note_presence() {
    let tmp = tempfile::tempdir().unwrap();
    let origin = tmp.path().join("origin.git");
    let a_dir = tmp.path().join("clone_a");
    sh_git(tmp.path(), &["init", "--bare", origin.to_str().unwrap()]);
    sh_git(
        tmp.path(),
        &["clone", origin.to_str().unwrap(), a_dir.to_str().unwrap()],
    );
    let repo = Repository::open(&a_dir).unwrap();

    let mut oids = Vec::new();
    for (i, name) in ["a.txt", "b.txt", "c.txt"].iter().enumerate() {
        oids.push(commit_file(
            &repo,
            name,
            "x",
            &format!("feat: {name}"),
            3_200_000 + i as i64,
            "Dev",
            "dev@x.com",
        ));
    }

    // One note per verdict, each correctly bound to its own commit.
    for (oid, verdict) in oids.iter().zip(["verified", "partial", "not_wired"]) {
        let note = super::notes::ProofNote {
            commit: oid.to_string(),
            verdict: verdict.to_string(),
            ok: if verdict == "verified" { 2 } else { 1 },
            total: 2,
            goals: vec![],
            at: 1_700_000_000_000,
        };
        let sig = Signature::new("aura", "meta@aura.local", &Time::new(3_200_000, 0)).unwrap();
        repo.note(
            &sig,
            &sig,
            Some(PROOF_REF),
            *oid,
            &render_proof_note(&note),
            true,
        )
        .unwrap();
    }

    let v = verify_range(&repo, None).unwrap();
    assert_eq!(v.commits, 3);
    assert_eq!(v.proofs, 3, "all three carry a proof snapshot");
    assert_eq!(v.proven, 1, "only the verified one is proven");
    assert_eq!(v.partial, 1);
    assert!(v.ok, "an honest not_wired verdict is not a problem to fix");
    assert!(!v.truncated);
}

/// A proof note this build can't parse is not the same as no proof note. It
/// used to fold into the same `None`, so an unreadable file counted as a
/// commit nobody had tried to prove and the report still came back ok.
#[test]
fn an_unreadable_proof_note_is_reported_not_swallowed() {
    let tmp = tempfile::tempdir().unwrap();
    let origin = tmp.path().join("origin.git");
    let a_dir = tmp.path().join("clone_a");
    sh_git(tmp.path(), &["init", "--bare", origin.to_str().unwrap()]);
    sh_git(
        tmp.path(),
        &["clone", origin.to_str().unwrap(), a_dir.to_str().unwrap()],
    );
    let repo = Repository::open(&a_dir).unwrap();
    let t1: i64 = 3_300_000;
    let c1 = commit_file(&repo, "f.txt", "f", "feat: future", t1, "Dev", "dev@x.com");

    // What a newer Aura's proof format looks like to this one.
    let sig = Signature::new("aura", "meta@aura.local", &Time::new(t1, 0)).unwrap();
    repo.note(
        &sig,
        &sig,
        Some(PROOF_REF),
        c1,
        "{\"schema\":2,\"attestation\":{}}",
        true,
    )
    .unwrap();

    let v = verify_range(&repo, None).unwrap();
    assert_eq!(v.proofs, 0, "we couldn't read it, so it proves nothing");
    assert_eq!(v.proven, 0);
    assert!(!v.ok, "an unread file is not an absent one");
    assert_eq!(v.issues.len(), 1);
    assert!(v.issues[0].contains("can't read it"));
}

#[test]
fn proof_pull_resolves_newest_at_wins() {
    use super::notes::{merge_incoming_proof, INCOMING_PROOF_REF};
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
    let t1: i64 = 3_200_000;
    let c1 = commit_file(
        &repo_a, "f.txt", "f", "feat: shared proof", t1, "Dev", "dev@x.com",
    );
    sh_git(&a_dir, &["push", "origin", "HEAD"]);

    // A proves NEWER (verified, at=200) and pushes the proof ref.
    let prefix: String = c1.to_string().chars().take(12).collect();
    write_goal_ledger(&a_dir, "shared goal", &prefix, "verified", 2, 2, 200);
    write_proof_for_range(&repo_a, None).unwrap();
    sh_git(&a_dir, &["push", "origin", PROOF_REF]);

    // B clones, proves OLDER locally (partial, at=100), then pulls A's proof:
    // newest-at (A's verified, 200) must win over B's local (partial, 100).
    sh_git(
        tmp.path(),
        &["clone", origin.to_str().unwrap(), b_dir.to_str().unwrap()],
    );
    let repo_b = Repository::open(&b_dir).unwrap();
    write_goal_ledger(&b_dir, "shared goal", &prefix, "partial", 1, 2, 100);
    write_proof_for_range(&repo_b, None).unwrap();

    let refspec = format!("+{}:{}", PROOF_REF, INCOMING_PROOF_REF);
    sh_git(&b_dir, &["fetch", "origin", &refspec]);
    let pull = merge_incoming_proof(&repo_b).unwrap();
    assert!(pull.incoming_present);
    assert_eq!(pull.commits_seen, 1);
    assert_eq!(pull.commits_updated, 1, "A's newer snapshot wins");
    assert!(repo_b.find_reference(INCOMING_PROOF_REF).is_err());

    // The resolved local note is A's verified snapshot.
    let body = super::notes::note_body(&repo_b, PROOF_REF, c1).unwrap();
    let resolved = parse_proof_note(&body).unwrap();
    assert_eq!(resolved.verdict, "verified");
    assert_eq!(resolved.at, 200);

    // Pulling again resolves nothing new (incoming is not strictly newer).
    sh_git(&b_dir, &["fetch", "origin", &refspec]);
    let pull2 = merge_incoming_proof(&repo_b).unwrap();
    assert_eq!(pull2.commits_updated, 0);
}
