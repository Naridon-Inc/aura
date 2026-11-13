use std::sync::{Arc, Mutex};
use std::time::Duration;

use super::*;

fn run(status: ScriptStatus) -> ScriptRun {
    ScriptRun {
        kind: ScriptKind::Setup,
        worktree_path: "/w".into(),
        command: "true".into(),
        status,
        started_at: 10,
        ended_at: None,
        exit_code: None,
        reason: None,
    }
}

#[test]
fn exit_codes_map_to_how_it_ended() {
    assert_eq!(status_after_exit(Some(0), false), (ScriptStatus::Completed, None));
    assert_eq!(status_after_exit(Some(3), false).0, ScriptStatus::Failed);
    assert_eq!(status_after_exit(None, false).0, ScriptStatus::Failed);
    assert!(status_after_exit(None, false).1.is_some());
    // A stop wins over whatever code the dying script left.
    assert_eq!(status_after_exit(Some(143), true).0, ScriptStatus::Cancelled);
    assert_eq!(status_after_exit(Some(0), true).0, ScriptStatus::Cancelled);
}

#[test]
fn a_running_record_with_no_process_was_cut_off() {
    let settled = settle_on_read(run(ScriptStatus::Running), false);
    assert_eq!(settled.status, ScriptStatus::Cancelled);
    assert_eq!(settled.ended_at, Some(10));
    assert!(settled.reason.unwrap().contains("closed"));

    // Still live, or already over: left alone.
    assert_eq!(settle_on_read(run(ScriptStatus::Running), true).status, ScriptStatus::Running);
    assert_eq!(settle_on_read(run(ScriptStatus::Failed), false).status, ScriptStatus::Failed);
}

#[test]
fn text_never_splits_a_character() {
    let bytes = "héllo".as_bytes();
    // Cut inside the two-byte é.
    let mut pending = bytes[..2].to_vec();
    assert_eq!(take_text(&mut pending), "h");
    assert_eq!(pending, bytes[1..2].to_vec());
    pending.extend_from_slice(&bytes[2..]);
    assert_eq!(take_text(&mut pending), "éllo");
    assert!(pending.is_empty());
}

#[test]
fn kinds_and_statuses_serialize_as_the_app_reads_them() {
    let json = serde_json::to_value(run(ScriptStatus::DidNotStart)).unwrap();
    assert_eq!(json["kind"], "setup");
    assert_eq!(json["status"], "did_not_start");
    assert_eq!(json["worktreePath"], "/w");
    assert!(json.get("startedAt").is_some());
}

fn collecting_sink() -> (Sink, Arc<Mutex<Vec<ScriptEvent>>>) {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let s = seen.clone();
    (Arc::new(move |e: ScriptEvent| s.lock().unwrap().push(e)), seen)
}

#[cfg(unix)]
#[test]
fn a_failing_script_is_logged_and_reported() {
    let dir = tempfile::tempdir().unwrap();
    let work = dir.path().join("work");
    std::fs::create_dir_all(&work).unwrap();
    let store_dir = dir.path().join("store");
    let path = work.to_string_lossy().to_string();
    let registry = ScriptRegistry::default();
    let (sink, seen) = collecting_sink();

    let started = registry.start(
        StartSpec {
            kind: ScriptKind::Setup,
            worktree_path: path.clone(),
            command: "echo \"hi $AURA_WORK_NAME\"; echo oops 1>&2; exit 3".into(),
            env: vec![("AURA_WORK_NAME".into(), "brave-otter".into())],
            store_dir: Some(store_dir.clone()),
            preface: vec!["Copied .env into this workspace".into()],
        },
        sink,
    );
    assert_eq!(started.status, ScriptStatus::Running);

    let ended = registry.wait(&path, ScriptKind::Setup, Duration::from_secs(20)).unwrap();
    // The last snapshot taken while it ran may still say Running; the
    // record on disk is the final word.
    let _ = ended;
    let record = store::read_record(&store_dir, ScriptKind::Setup).unwrap();
    assert_eq!(record.status, ScriptStatus::Failed);
    assert_eq!(record.exit_code, Some(3));
    assert!(record.ended_at.is_some());
    assert!(registry.current(&path, ScriptKind::Setup).is_none());

    let log = store::read_log_tail(&store_dir, ScriptKind::Setup, store::LOG_TAIL_BYTES);
    assert!(log.starts_with("Copied .env into this workspace\n"));
    assert!(log.contains("hi brave-otter"));
    assert!(log.contains("oops"));

    let events = seen.lock().unwrap();
    let last = events.iter().rev().find_map(|e| e.run.clone()).unwrap();
    assert_eq!(last.status, ScriptStatus::Failed);
    let printed: String = events.iter().filter_map(|e| e.chunk.clone()).collect();
    assert!(printed.contains("hi brave-otter"));
}

#[cfg(unix)]
#[test]
fn starting_twice_hands_back_the_run_in_progress_and_stop_cancels_it() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().to_string_lossy().to_string();
    let registry = ScriptRegistry::default();
    let spec = || StartSpec {
        kind: ScriptKind::Archive,
        worktree_path: path.clone(),
        command: "sleep 30".into(),
        env: vec![],
        store_dir: None,
        preface: vec![],
    };
    let (sink, seen) = collecting_sink();
    let first = registry.start(spec(), sink.clone());
    let second = registry.start(spec(), sink);
    assert_eq!(first.started_at, second.started_at);

    let stopping = registry.stop(&path, ScriptKind::Archive).unwrap();
    assert_eq!(stopping.status, ScriptStatus::Stopping);
    registry.wait(&path, ScriptKind::Archive, Duration::from_secs(20));
    assert!(registry.current(&path, ScriptKind::Archive).is_none());
    let last = seen.lock().unwrap().iter().rev().find_map(|e| e.run.clone()).unwrap();
    assert_eq!(last.status, ScriptStatus::Cancelled);
}

#[test]
fn a_shell_that_cannot_start_did_not_start() {
    let registry = ScriptRegistry::default();
    let (sink, _) = collecting_sink();
    let run = registry.start(
        StartSpec {
            kind: ScriptKind::Setup,
            worktree_path: "/definitely/not/a/folder/here".into(),
            command: "true".into(),
            env: vec![],
            store_dir: None,
            preface: vec![],
        },
        sink,
    );
    assert_eq!(run.status, ScriptStatus::DidNotStart);
    assert!(run.reason.is_some());
    assert!(registry.current("/definitely/not/a/folder/here", ScriptKind::Setup).is_none());
}
