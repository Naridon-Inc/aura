//! Hermetic unit tests for the semantic 3-way merge engine. String fixtures
//! only — no repo needed (the engine shells out to `git merge-file` for the
//! line-level legs, which works on temp files).

use super::engine::{semantic_merge_3way, SemanticMerge};

const MARKER: usize = 7;

fn rs_base() -> String {
    [
        "use std::fmt;",
        "",
        "fn alpha() -> i32 {",
        "    1",
        "}",
        "",
        "fn beta() -> i32 {",
        "    2",
        "}",
        "",
    ]
    .join("\n")
}

// (a) Two sides edit DIFFERENT functions → clean merge with both edits.
#[test]
fn different_functions_merge_clean() {
    let base = rs_base();
    let ours = base.replace("    1", "    10 + 32");
    let theirs = base.replace("    2", "    20 - 7");

    match semantic_merge_3way(&base, &ours, &theirs, "rs", MARKER) {
        SemanticMerge::Clean(out) => {
            assert!(out.contains("10 + 32"), "ours edit missing:\n{}", out);
            assert!(out.contains("20 - 7"), "theirs edit missing:\n{}", out);
            assert!(!out.contains("<<<<<<<"), "unexpected markers:\n{}", out);
            assert!(out.contains("use std::fmt;"), "scaffold text lost:\n{}", out);
        }
        other => panic!("expected Clean, got {:?}", other),
    }
}

// (a2) Same thing for TypeScript arrow-function consts, the other headline shape.
#[test]
fn different_ts_consts_merge_clean() {
    let base = [
        "import { x } from './x';",
        "",
        "export const first = () => {",
        "  return 1;",
        "};",
        "",
        "export const second = () => {",
        "  return 2;",
        "};",
        "",
    ]
    .join("\n");
    let ours = base.replace("return 1;", "return 100;");
    let theirs = base.replace("return 2;", "return 200;");

    match semantic_merge_3way(&base, &ours, &theirs, "ts", MARKER) {
        SemanticMerge::Clean(out) => {
            assert!(out.contains("return 100;"), "ours edit missing:\n{}", out);
            assert!(out.contains("return 200;"), "theirs edit missing:\n{}", out);
        }
        other => panic!("expected Clean, got {:?}", other),
    }
}

// (b) Same function changed differently on both sides → conflict markers,
// and the nonconflicting parts stay intact.
#[test]
fn same_function_conflicts_with_markers() {
    let base = rs_base();
    let ours = base.replace("    1", "    111");
    let theirs = base.replace("    1", "    999");

    match semantic_merge_3way(&base, &ours, &theirs, "rs", MARKER) {
        SemanticMerge::Conflicted { content, conflicts, .. } => {
            assert!(conflicts >= 1);
            assert!(content.contains("<<<<<<< ours"), "missing ours marker:\n{}", content);
            assert!(content.contains("======="), "missing separator:\n{}", content);
            assert!(content.contains(">>>>>>> theirs"), "missing theirs marker:\n{}", content);
            assert!(content.contains("111"), "ours side missing:\n{}", content);
            assert!(content.contains("999"), "theirs side missing:\n{}", content);
            // The untouched function and the imports survive verbatim.
            assert!(content.contains("fn beta() -> i32 {"), "beta lost:\n{}", content);
            assert!(content.contains("use std::fmt;"), "imports lost:\n{}", content);
        }
        other => panic!("expected Conflicted, got {:?}", other),
    }
}

// (b2) Custom marker size must be honored.
#[test]
fn conflict_markers_respect_marker_size() {
    let base = rs_base();
    let ours = base.replace("    1", "    111");
    let theirs = base.replace("    1", "    999");

    match semantic_merge_3way(&base, &ours, &theirs, "rs", 11) {
        SemanticMerge::Conflicted { content, .. } => {
            assert!(
                content.contains(&format!("{} ours", "<".repeat(11))),
                "marker size not honored:\n{}",
                content
            );
            assert!(
                !content.lines().any(|l| l == "<<<<<<< ours" || l == "======="),
                "default-size marker leaked:\n{}",
                content
            );
        }
        other => panic!("expected Conflicted, got {:?}", other),
    }
}

// (b3) Same function edited in DIFFERENT places on both sides → the inner
// line-level 3-way resolves it cleanly (never worse than plain git).
#[test]
fn same_function_disjoint_edits_inner_merge_clean() {
    let base = [
        "fn long_one() -> i32 {",
        "    let a = 1;",
        "    let b = 2;",
        "    let c = 3;",
        "    let d = 4;",
        "    let e = 5;",
        "    a + b + c + d + e",
        "}",
        "",
    ]
    .join("\n");
    let ours = base.replace("let a = 1;", "let a = 100;");
    let theirs = base.replace("let e = 5;", "let e = 500;");

    match semantic_merge_3way(&base, &ours, &theirs, "rs", MARKER) {
        SemanticMerge::Clean(out) => {
            assert!(out.contains("let a = 100;"), "ours edit missing:\n{}", out);
            assert!(out.contains("let e = 500;"), "theirs edit missing:\n{}", out);
        }
        other => panic!("expected Clean, got {:?}", other),
    }
}

// (c) One side deletes a function, the other leaves it untouched → deleted.
#[test]
fn delete_vs_untouched_deletes() {
    let base = rs_base();
    let ours = base.replace("fn alpha() -> i32 {\n    1\n}\n\n", "");
    let theirs = base.clone();

    match semantic_merge_3way(&base, &ours, &theirs, "rs", MARKER) {
        SemanticMerge::Clean(out) => {
            assert!(!out.contains("fn alpha"), "alpha should be deleted:\n{}", out);
            assert!(out.contains("fn beta"), "beta must survive:\n{}", out);
        }
        other => panic!("expected Clean, got {:?}", other),
    }
}

// (d) Delete on one side + modify on the other → conflict.
#[test]
fn delete_vs_modify_conflicts() {
    let base = rs_base();
    let ours = base.replace("fn alpha() -> i32 {\n    1\n}\n\n", "");
    let theirs = base.replace("    1", "    42");

    match semantic_merge_3way(&base, &ours, &theirs, "rs", MARKER) {
        SemanticMerge::Conflicted { content, conflicts, .. } => {
            assert!(conflicts >= 1);
            assert!(content.contains("<<<<<<< ours"), "missing markers:\n{}", content);
            assert!(content.contains("    42"), "modified body must be visible:\n{}", content);
            assert!(content.contains("fn beta"), "beta must survive:\n{}", content);
        }
        other => panic!("expected Conflicted, got {:?}", other),
    }
}

// (e) Garbage input → engine declines and reports Fallback (the driver then
// runs `git merge-file` on the real files).
#[test]
fn garbage_input_falls_back() {
    let base = "fn broken( {{{ this is not rust ]]]";
    let ours = "fn broken( {{{ this is not rust at all ]]]";
    let theirs = "fn broken( {{{ unparseable ]]]";

    match semantic_merge_3way(base, ours, theirs, "rs", MARKER) {
        SemanticMerge::Fallback(reason) => {
            assert!(reason.contains("syntax errors"), "unexpected reason: {}", reason);
        }
        other => panic!("expected Fallback, got {:?}", other),
    }
}

// (e2) Unsupported extension → fallback, before any parsing.
#[test]
fn unsupported_extension_falls_back() {
    match semantic_merge_3way("a", "b", "c", "lua", MARKER) {
        SemanticMerge::Fallback(reason) => {
            assert!(reason.contains("unsupported"), "unexpected reason: {}", reason);
        }
        other => panic!("expected Fallback, got {:?}", other),
    }
}

// (f) Both sides ADD different functions at the same spot (end of file) —
// textual git conflicts here; the semantic union keeps both.
#[test]
fn add_add_different_functions_union() {
    let base = rs_base();
    let ours = format!("{}fn gamma() -> i32 {{\n    3\n}}\n", base);
    let theirs = format!("{}fn delta() -> i32 {{\n    4\n}}\n", base);

    match semantic_merge_3way(&base, &ours, &theirs, "rs", MARKER) {
        SemanticMerge::Clean(out) => {
            assert!(out.contains("fn gamma"), "ours addition missing:\n{}", out);
            assert!(out.contains("fn delta"), "theirs addition missing:\n{}", out);
            assert!(!out.contains("<<<<<<<"), "unexpected markers:\n{}", out);
        }
        other => panic!("expected Clean, got {:?}", other),
    }
}

// (f2) Both sides add a function with the SAME name but different bodies —
// that must stay a conflict, not a silent union or pick.
#[test]
fn add_add_same_name_conflicts() {
    let base = rs_base();
    let ours = format!("{}fn gamma() -> i32 {{\n    3\n}}\n", base);
    let theirs = format!("{}fn gamma() -> i32 {{\n    33\n}}\n", base);

    match semantic_merge_3way(&base, &ours, &theirs, "rs", MARKER) {
        SemanticMerge::Conflicted { content, .. } => {
            assert!(content.contains("<<<<<<< ours"), "missing markers:\n{}", content);
            assert!(content.contains("    3"), "ours body missing:\n{}", content);
            assert!(content.contains("    33"), "theirs body missing:\n{}", content);
        }
        other => panic!("expected Conflicted, got {:?}", other),
    }
}

// Identical edits on both sides converge without conflict.
#[test]
fn identical_edits_converge() {
    let base = rs_base();
    let ours = base.replace("    1", "    7");
    let theirs = base.replace("    1", "    7");

    match semantic_merge_3way(&base, &ours, &theirs, "rs", MARKER) {
        SemanticMerge::Clean(out) => {
            assert!(out.contains("    7"));
            assert_eq!(out.matches("fn alpha").count(), 1);
        }
        other => panic!("expected Clean, got {:?}", other),
    }
}

// Inter-node text (imports) merges line-level: each side adds a different import.
#[test]
fn imports_merge_line_level() {
    let base = rs_base();
    let ours = base.replace("use std::fmt;", "use std::fmt;\nuse std::io;");
    let theirs = base.replace("    2", "    22");

    match semantic_merge_3way(&base, &ours, &theirs, "rs", MARKER) {
        SemanticMerge::Clean(out) => {
            assert!(out.contains("use std::io;"), "ours import missing:\n{}", out);
            assert!(out.contains("    22"), "theirs edit missing:\n{}", out);
        }
        other => panic!("expected Clean, got {:?}", other),
    }
}

// Python sanity: different defs edited on each side merge cleanly.
#[test]
fn python_different_defs_merge_clean() {
    let base = [
        "import os",
        "",
        "def one():",
        "    return 1",
        "",
        "def two():",
        "    return 2",
        "",
    ]
    .join("\n");
    let ours = base.replace("return 1", "return 100");
    let theirs = base.replace("return 2", "return 200");

    match semantic_merge_3way(&base, &ours, &theirs, "py", MARKER) {
        SemanticMerge::Clean(out) => {
            assert!(out.contains("return 100"));
            assert!(out.contains("return 200"));
        }
        other => panic!("expected Clean, got {:?}", other),
    }
}

// Driver-level check for the fallback leg: run_driver-equivalent through the
// public `run()` with a garbage file must leave a valid `git merge-file`
// result in the ours file (markers present, exit 1) — never a corrupted file.
#[test]
fn driver_fallback_writes_git_merge_file_result() {
    let dir = tempfile::tempdir().expect("tempdir");
    let write = |name: &str, content: &str| {
        let p = dir.path().join(name);
        std::fs::write(&p, content).expect("write fixture");
        p
    };
    let base = write("base", "fn broken( {{{\nshared line\n");
    let ours = write("ours", "fn broken( {{{\nshared line\nours tail\n");
    let theirs = write("theirs", "fn broken( {{{\ntheirs head\nshared line\n");

    let code = super::run(
        Some(&base),
        Some(&ours),
        Some(&theirs),
        Some("src/whatever.rs"),
        7,
        false,
        false,
        false,
        false,
    );
    let merged = std::fs::read_to_string(dir.path().join("ours")).expect("read ours");
    // Both sides' changes must be present (clean or conflicted — that part is
    // git merge-file's call), and the exit code must match its semantics.
    assert!(merged.contains("ours tail"), "ours change lost:\n{}", merged);
    assert!(merged.contains("theirs head"), "theirs change lost:\n{}", merged);
    if merged.contains("<<<<<<<") {
        assert!(code >= 1, "markers present but exit {}", code);
    } else {
        assert_eq!(code, 0, "clean fallback merge must exit 0:\n{}", merged);
    }
}

// ─── Engine: per-node conflict details (wire 5) ────────────────────────────

fn is_short_hash(s: &str) -> bool {
    s.len() == 16 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

// Same node modified on both sides → exactly one detail naming the node, with
// both full bodies and the base content hash.
#[test]
fn conflict_details_name_the_node() {
    let base = rs_base();
    let ours = base.replace("    1", "    111");
    let theirs = base.replace("    1", "    999");

    match semantic_merge_3way(&base, &ours, &theirs, "rs", MARKER) {
        SemanticMerge::Conflicted { details, .. } => {
            assert_eq!(details.len(), 1, "one node in conflict: {:?}", details);
            let d = &details[0];
            assert_eq!(d.identifier, "alpha");
            assert!(d.ours.contains("111"), "ours body: {}", d.ours);
            assert!(d.theirs.contains("999"), "theirs body: {}", d.theirs);
            assert!(is_short_hash(&d.base_hash), "base_hash: {}", d.base_hash);
        }
        other => panic!("expected Conflicted, got {:?}", other),
    }
}

// Delete-vs-modify → the deleting side's body is EMPTY, the modifying side's
// body is the full new version.
#[test]
fn conflict_details_delete_vs_modify() {
    let base = rs_base();
    let ours = base.replace("fn alpha() -> i32 {\n    1\n}\n\n", "");
    let theirs = base.replace("    1", "    42");

    match semantic_merge_3way(&base, &ours, &theirs, "rs", MARKER) {
        SemanticMerge::Conflicted { details, .. } => {
            assert_eq!(details.len(), 1, "one node in conflict: {:?}", details);
            let d = &details[0];
            assert_eq!(d.identifier, "alpha");
            assert!(d.ours.is_empty(), "deleted side must be empty: {}", d.ours);
            assert!(d.theirs.contains("42"), "theirs body: {}", d.theirs);
            assert!(is_short_hash(&d.base_hash), "base_hash: {}", d.base_hash);
        }
        other => panic!("expected Conflicted, got {:?}", other),
    }
}

// Add/add of the same name → detail with both new bodies; base_hash is the
// hash of the empty body (the node never existed in base).
#[test]
fn conflict_details_add_add_same_name() {
    let base = rs_base();
    let ours = format!("{}fn gamma() -> i32 {{\n    3\n}}\n", base);
    let theirs = format!("{}fn gamma() -> i32 {{\n    33\n}}\n", base);

    match semantic_merge_3way(&base, &ours, &theirs, "rs", MARKER) {
        SemanticMerge::Conflicted { details, .. } => {
            assert_eq!(details.len(), 1, "one node in conflict: {:?}", details);
            let d = &details[0];
            assert_eq!(d.identifier, "gamma");
            assert!(d.ours.contains("    3"), "ours body: {}", d.ours);
            assert!(d.theirs.contains("    33"), "theirs body: {}", d.theirs);
            assert!(is_short_hash(&d.base_hash), "base_hash: {}", d.base_hash);
        }
        other => panic!("expected Conflicted, got {:?}", other),
    }
}

// ─── Driver: rows land in .aura/conflicts.jsonl (wire 5) ───────────────────
//
// These tests mutate the process cwd and env, so they serialize on the same
// crate-wide lock every other cwd-mutating test uses.

use crate::TEST_CWD_LOCK as SERIAL;

struct CwdGuard(std::path::PathBuf);
impl Drop for CwdGuard {
    fn drop(&mut self) {
        let _ = std::env::set_current_dir(&self.0);
    }
}

fn enter_tmp() -> (CwdGuard, tempfile::TempDir) {
    let guard = CwdGuard(std::env::current_dir().expect("cwd"));
    let dir = tempfile::tempdir().expect("tmp");
    std::env::set_current_dir(dir.path()).expect("cd");
    (guard, dir)
}

/// Sets an env var for the test's scope and restores the previous state on
/// drop (panic-safe). Only used under the SERIAL lock.
struct EnvGuard {
    key: String,
    prev: Option<String>,
}
impl EnvGuard {
    fn set(key: &str, value: &str) -> EnvGuard {
        let prev = std::env::var(key).ok();
        unsafe { std::env::set_var(key, value) };
        EnvGuard { key: key.to_string(), prev }
    }
}
impl Drop for EnvGuard {
    fn drop(&mut self) {
        unsafe {
            match &self.prev {
                Some(v) => std::env::set_var(&self.key, v),
                None => std::env::remove_var(&self.key),
            }
        }
    }
}

/// Field-for-field mirror of aura-shell `cmd_conflicts.rs::ConflictedNode`.
/// `deny_unknown_fields` proves the driver's rows carry NOTHING the desktop
/// resolver doesn't know about — they deserialize there unchanged.
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct ShellConflictedNode {
    id: String,
    file: String,
    identifier: String,
    base_hash: String,
    ours: String,
    theirs: String,
    ours_agent: String,
    theirs_agent: String,
    opened_at: u64,
    #[serde(default)]
    resolved_at: Option<u64>,
    #[serde(default)]
    resolved_in_commit: Option<String>,
    #[serde(default)]
    resolution_body: Option<String>,
}

fn read_rows() -> Vec<ShellConflictedNode> {
    let body = std::fs::read_to_string(".aura/conflicts.jsonl").expect("read conflicts.jsonl");
    body.lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| serde_json::from_str::<ShellConflictedNode>(l).expect("schema-compatible row"))
        .collect()
}

fn git_init_here() {
    let ok = std::process::Command::new("git")
        .args(["init", "-q"])
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    assert!(ok, "git init failed");
}

fn write_conflict_fixtures(dir: &std::path::Path) -> (std::path::PathBuf, std::path::PathBuf, std::path::PathBuf) {
    let base = rs_base();
    let write = |name: &str, content: &str| {
        let p = dir.join(name);
        std::fs::write(&p, content).expect("write fixture");
        p
    };
    (
        write("merge_base", &base),
        write("merge_ours", &base.replace("    1", "    111")),
        write("merge_theirs", &base.replace("    1", "    999")),
    )
}

fn run_driver_on(
    base: &std::path::Path,
    ours: &std::path::Path,
    theirs: &std::path::Path,
) -> i32 {
    super::run(
        Some(base),
        Some(ours),
        Some(theirs),
        Some("src/lib.rs"),
        7,
        false,
        false,
        false,
        false,
    )
}

// A real semantic conflict in a repo WITH `.aura/` → exactly one well-formed
// ConflictedNode row, attributed from GIT_AUTHOR_NAME + GITHEAD_*; re-running
// the merge does not duplicate it.
#[test]
fn conflict_rows_appended_for_aura_repo() {
    let _lk = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let (_g, dir) = enter_tmp();
    git_init_here();
    std::fs::create_dir(".aura").expect("mk .aura");
    let _author = EnvGuard::set("GIT_AUTHOR_NAME", "Agent Smith");
    let _githead = EnvGuard::set(
        "GITHEAD_0123456789abcdef0123456789abcdef01234567",
        "feature-x",
    );

    let (base, ours, theirs) = write_conflict_fixtures(dir.path());
    let code = run_driver_on(&base, &ours, &theirs);
    assert_eq!(code, 1, "semantic conflict must exit 1");
    let merged = std::fs::read_to_string(&ours).expect("read ours");
    assert!(merged.contains("<<<<<<< ours"), "markers expected:\n{}", merged);

    let rows = read_rows();
    assert_eq!(rows.len(), 1, "exactly one row expected");
    let row = &rows[0];
    assert!(!row.id.is_empty());
    assert_eq!(row.file, "src/lib.rs");
    assert_eq!(row.identifier, "alpha");
    assert!(is_short_hash(&row.base_hash), "base_hash: {}", row.base_hash);
    assert!(row.ours.contains("111"), "ours body: {}", row.ours);
    assert!(row.theirs.contains("999"), "theirs body: {}", row.theirs);
    assert_eq!(row.ours_agent, "Agent Smith");
    assert_eq!(row.theirs_agent, "feature-x");
    assert!(row.opened_at > 0);
    assert!(row.resolved_at.is_none());
    assert!(row.resolved_in_commit.is_none());
    assert!(row.resolution_body.is_none());

    // Same divergence again (merge re-run after abort) → deduped, still 1 row.
    std::fs::write(&ours, rs_base().replace("    1", "    111")).expect("reset ours");
    let code = run_driver_on(&base, &ours, &theirs);
    assert_eq!(code, 1);
    assert_eq!(read_rows().len(), 1, "re-run must not duplicate the row");
}

// Without GITHEAD_* in the env (rebase / cherry-pick shape), theirs falls
// back to the honest "incoming" — never a fabricated name.
#[test]
fn conflict_rows_theirs_falls_back_to_incoming() {
    let _lk = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let (_g, dir) = enter_tmp();
    git_init_here();
    std::fs::create_dir(".aura").expect("mk .aura");
    let _author = EnvGuard::set("GIT_AUTHOR_NAME", "Agent Smith");

    let (base, ours, theirs) = write_conflict_fixtures(dir.path());
    assert_eq!(run_driver_on(&base, &ours, &theirs), 1);
    let rows = read_rows();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].theirs_agent, "incoming");
}

// No `.aura/` dir → the repo never opted into Aura: no rows, no `.aura`
// created, and the exit code is identical.
#[test]
fn no_aura_dir_no_rows_same_exit() {
    let _lk = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let (_g, dir) = enter_tmp();
    git_init_here();

    let (base, ours, theirs) = write_conflict_fixtures(dir.path());
    let code = run_driver_on(&base, &ours, &theirs);
    assert_eq!(code, 1, "exit code must be unchanged");
    let merged = std::fs::read_to_string(&ours).expect("read ours");
    assert!(merged.contains("<<<<<<< ours"), "markers expected:\n{}", merged);
    assert!(
        !std::path::Path::new(".aura").exists(),
        "driver must not create .aura in a repo that never opted in"
    );
}

// Emission failure (the store path is unwritable — a DIRECTORY squats on
// conflicts.jsonl) → merge result and exit code completely unchanged.
#[test]
fn emission_failure_never_affects_merge() {
    let _lk = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let (_g, dir) = enter_tmp();
    git_init_here();
    std::fs::create_dir_all(".aura/conflicts.jsonl").expect("squat dir");
    let _author = EnvGuard::set("GIT_AUTHOR_NAME", "Agent Smith");

    let (base, ours, theirs) = write_conflict_fixtures(dir.path());
    let code = run_driver_on(&base, &ours, &theirs);
    assert_eq!(code, 1, "exit code must survive emission failure");
    let merged = std::fs::read_to_string(&ours).expect("read ours");
    assert!(merged.contains("<<<<<<< ours"), "markers expected:\n{}", merged);
    assert!(merged.contains("111") && merged.contains("999"), "both sides:\n{}", merged);
    assert!(
        std::path::Path::new(".aura/conflicts.jsonl").is_dir(),
        "squatting dir untouched"
    );
}

// The full-file fallback path (garbage input) is NOT a semantic conflict —
// no rows, even with `.aura/` present.
#[test]
fn fallback_path_emits_no_rows() {
    let _lk = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let (_g, dir) = enter_tmp();
    git_init_here();
    std::fs::create_dir(".aura").expect("mk .aura");

    let write = |name: &str, content: &str| {
        let p = dir.path().join(name);
        std::fs::write(&p, content).expect("write fixture");
        p
    };
    let base = write("merge_base", "fn broken( {{{\nshared\n");
    let ours = write("merge_ours", "fn broken( {{{\nshared\nours line\n");
    let theirs = write("merge_theirs", "fn broken( {{{\ntheirs line\nshared\n");

    let _ = run_driver_on(&base, &ours, &theirs);
    assert!(
        !std::path::Path::new(".aura/conflicts.jsonl").exists(),
        "fallback merges must not write conflict rows"
    );
}
