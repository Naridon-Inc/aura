//! Durable read/write access to the goal ledger at `.aura/goals.jsonl`.
//!
//! The ledger is **git-tracked** (like `.aura/intent_log.jsonl`), one JSON
//! `GoalRecord` per line, so goals — and the proof that backs them — travel
//! with the repo and are shared with the whole team. It is NOT a private
//! scratchpad and NOT gitignored.
//!
//! Free functions in the `board.rs` style (no struct ceremony): every read
//! loads the whole file (it's small — one line per goal), every write rewrites
//! it atomically via temp-file + rename so a concurrent reader never sees a
//! torn file. JSONL (not a single JSON array) so an append-minded future and a
//! line-oriented `git diff` both stay friendly.

use std::fs;
use std::path::{Path, PathBuf};

use super::model::{Decomposition, GoalRecord, GoalRun};

/// Newest-first run cap per goal — matches the frontend `RUN_CAP`.
pub const RUN_CAP: usize = 24;

fn ledger_path(root: &Path) -> PathBuf {
    root.join(".aura").join("goals.jsonl")
}

/// Current unix time in millis — the unit the frontend's `Date.now()` uses, so
/// timestamps compare directly across the engine/app boundary.
pub fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ── id parity with the frontend ───────────────────────────────────────────
// Byte-for-byte the same djb2 hash as `goalStore.ts:idForText`, so a goal
// created in the desktop app and one created from `aura prove` collapse onto
// ONE record. Do not "improve" this without changing both sides in lockstep.

/// `s.trim().toLowerCase().replace(/\s+/g, " ")` — trim, lowercase, collapse
/// every run of whitespace to a single space.
fn normalize(s: &str) -> String {
    s.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

/// JS `Number.toString(36)` — lowercase base-36, "0" for zero.
fn base36(mut n: u32) -> String {
    if n == 0 {
        return "0".to_string();
    }
    const DIGITS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut out: Vec<u8> = Vec::new();
    while n > 0 {
        out.push(DIGITS[(n % 36) as usize]);
        n /= 36;
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}

/// Stable id from the goal text. Replicates the frontend djb2 exactly:
/// `h = ((h << 5) + h + charCode) | 0` over UTF-16 code units (JS string
/// semantics), salted by the UTF-16 length, both base-36.
pub fn id_for_text(text: &str) -> String {
    let n = normalize(text);
    let mut h: i32 = 5381;
    let mut units: u32 = 0;
    for u in n.encode_utf16() {
        // ((h << 5) + h + u) | 0  ==  (h*33 + u) truncated to i32.
        h = h
            .wrapping_shl(5)
            .wrapping_add(h)
            .wrapping_add(u as i32);
        units = units.wrapping_add(1);
    }
    format!("goal_{}{}", base36(h as u32), base36(units))
}

// ── Atomic write (board.rs precedent) ──────────────────────────────────────

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    let tmp = path.with_extension(format!("tmp-{}", uuid::Uuid::new_v4().simple()));
    fs::write(&tmp, bytes).map_err(|e| format!("write {}: {e}", tmp.display()))?;
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("rename into {}: {e}", path.display())
    })
}

// ── Cross-process write lock ────────────────────────────────────────────────
// `atomic_write` stops a torn *read* (rename is atomic), but it does NOT stop a
// lost *update*: two writers each `load()` the whole ledger, mutate their own
// copy, and `save()` — the second rename wins and the first writer's change is
// gone. The writers here are genuinely concurrent and live in SEPARATE OS
// processes — the post-commit hook auto-proving goals, the MCP agent path, and
// a desktop-driven write — so an in-process `Mutex` would be useless. We need
// an advisory *file* lock held across the full load→mutate→save of each
// mutator, which serializes those processes.
//
// The lock file lives in the OS temp dir, keyed by a stable hash of the repo
// root, NOT inside the repo: every same-user process operating on the same repo
// derives the identical path (so the lock is shared), and nothing is ever
// written into `.aura/` to pollute `git status`. Cross-user / cross-machine
// concurrency is a different problem already handled by git merging the tracked
// ledger; this lock only orders the local process family.

/// FNV-1a over the canonical repo path — a small, build-stable hash so every
/// process names the same lock file (unlike `DefaultHasher`, whose algorithm
/// may differ between toolchains).
fn path_key(root: &Path) -> u64 {
    let canonical = root
        .canonicalize()
        .unwrap_or_else(|_| root.to_path_buf());
    let s = canonical.to_string_lossy();
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in s.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

/// RAII handle for the ledger write lock. Dropping it closes the file, which
/// releases the advisory lock — so the lock is held exactly for the lifetime of
/// the guard binding in each mutator.
struct LedgerLock {
    _file: std::fs::File,
}

/// Acquire the exclusive advisory lock for `root`'s ledger, blocking until it's
/// free. Held across the caller's whole read-modify-write. On platforms without
/// `flock` the lock is a best-effort no-op (the ledger is small and single-user
/// there) rather than failing the write.
fn lock_ledger(root: &Path) -> Result<LedgerLock, String> {
    let lock_path =
        std::env::temp_dir().join(format!("aura-goals-{:016x}.lock", path_key(root)));
    let file = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(false)
        .open(&lock_path)
        .map_err(|e| format!("open lock {}: {e}", lock_path.display()))?;
    acquire_exclusive(&file)?;
    Ok(LedgerLock { _file: file })
}

#[cfg(unix)]
fn acquire_exclusive(file: &std::fs::File) -> Result<(), String> {
    use std::os::unix::io::AsRawFd;
    // Blocking exclusive lock; auto-released when the fd closes on drop.
    let rc = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) };
    if rc != 0 {
        return Err(format!("flock goals ledger: {}", std::io::Error::last_os_error()));
    }
    Ok(())
}

#[cfg(not(unix))]
fn acquire_exclusive(_file: &std::fs::File) -> Result<(), String> {
    // No portable advisory lock without an extra dependency. These targets are
    // effectively single-user for the ledger, so proceed best-effort.
    Ok(())
}

// ── Reads ───────────────────────────────────────────────────────────────────

/// Load every goal record. A missing/empty ledger is an empty list, not an
/// error. Malformed lines are skipped, not fatal — a partial ledger still
/// surfaces the goals it can parse.
pub fn load(root: &Path) -> Vec<GoalRecord> {
    let p = ledger_path(root);
    let raw = match fs::read_to_string(&p) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    raw.lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str::<GoalRecord>(l).ok())
        .collect()
}

pub fn get(root: &Path, id: &str) -> Option<GoalRecord> {
    load(root).into_iter().find(|g| g.id == id)
}

/// All goals linked under one task (by task uuid).
pub fn for_task(root: &Path, task_id: &str) -> Vec<GoalRecord> {
    load(root)
        .into_iter()
        .filter(|g| g.task_id.as_deref() == Some(task_id))
        .collect()
}

/// All goals that have at least one run proven against `commit` — the reverse
/// code↔goal index ("what goals did this commit deliver?").
pub fn for_commit(root: &Path, commit: &str) -> Vec<GoalRecord> {
    load(root)
        .into_iter()
        .filter(|g| g.runs.iter().any(|r| r.commit.as_deref() == Some(commit)))
        .collect()
}

// ── Writes (every mutation rewrites the ledger atomically) ──────────────────

fn save(root: &Path, goals: &[GoalRecord]) -> Result<(), String> {
    let mut buf = String::new();
    for g in goals {
        let line = serde_json::to_string(g).map_err(|e| format!("serialize goal {}: {e}", g.id))?;
        buf.push_str(&line);
        buf.push('\n');
    }
    atomic_write(&ledger_path(root), buf.as_bytes())
}

/// Find-or-create a record for `text`. Returns the (existing or new) record.
/// If the text changed but normalizes to the same id, the stored text is
/// refreshed so the display follows the latest phrasing.
pub fn upsert_by_text(root: &Path, text: &str) -> Result<GoalRecord, String> {
    let _lock = lock_ledger(root)?;
    let mut goals = load(root);
    let id = id_for_text(text);
    let trimmed = text.trim().to_string();
    if let Some(existing) = goals.iter_mut().find(|g| g.id == id) {
        if existing.text != trimmed {
            existing.text = trimmed;
            existing.updated_at = now_millis();
            let snapshot = existing.clone();
            save(root, &goals)?;
            return Ok(snapshot);
        }
        return Ok(existing.clone());
    }
    let ts = now_millis();
    let rec = GoalRecord {
        id,
        text: trimmed,
        task_id: None,
        task_seq: None,
        acceptance: Vec::new(),
        decomposition: None,
        runs: Vec::new(),
        created_at: ts,
        updated_at: ts,
    };
    goals.insert(0, rec.clone());
    save(root, &goals)?;
    Ok(rec)
}

/// Link a goal under a task (task uuid + optional `AURA-<n>` sequence).
pub fn link_task(root: &Path, goal_id: &str, task_id: &str, task_seq: Option<u64>) -> Result<(), String> {
    let _lock = lock_ledger(root)?;
    let mut goals = load(root);
    if let Some(g) = goals.iter_mut().find(|g| g.id == goal_id) {
        g.task_id = Some(task_id.to_string());
        g.task_seq = task_seq;
        g.updated_at = now_millis();
        save(root, &goals)?;
    }
    Ok(())
}

/// Cache the one-time decomposition on a goal. The expensive LLM step runs
/// once; every later re-prove reuses these requirements as a free AST check.
pub fn set_decomposition(root: &Path, goal_id: &str, decomposition: Decomposition) -> Result<(), String> {
    let _lock = lock_ledger(root)?;
    let mut goals = load(root);
    if let Some(g) = goals.iter_mut().find(|g| g.id == goal_id) {
        g.decomposition = Some(decomposition);
        g.updated_at = now_millis();
        save(root, &goals)?;
    }
    Ok(())
}

/// Append (or replace, by `run_key`) a run verdict — newest first, capped.
pub fn record_run(root: &Path, goal_id: &str, run: GoalRun) -> Result<(), String> {
    let _lock = lock_ledger(root)?;
    let mut goals = load(root);
    if let Some(g) = goals.iter_mut().find(|g| g.id == goal_id) {
        g.runs.retain(|r| r.run_key != run.run_key);
        g.runs.insert(0, run);
        g.runs.truncate(RUN_CAP);
        g.updated_at = now_millis();
        save(root, &goals)?;
    }
    Ok(())
}

/// Set/replace the plain-language acceptance / verify plan on a goal. Empties
/// are dropped; the list is stored verbatim otherwise (order preserved).
pub fn set_acceptance(root: &Path, goal_id: &str, checks: Vec<String>) -> Result<(), String> {
    let _lock = lock_ledger(root)?;
    let mut goals = load(root);
    if let Some(g) = goals.iter_mut().find(|g| g.id == goal_id) {
        g.acceptance = checks
            .into_iter()
            .map(|c| c.trim().to_string())
            .filter(|c| !c.is_empty())
            .collect();
        g.updated_at = now_millis();
        save(root, &goals)?;
    }
    Ok(())
}

/// Set/replace the full text of a goal in place.
pub fn set_text(root: &Path, goal_id: &str, text: &str) -> Result<(), String> {
    let _lock = lock_ledger(root)?;
    let mut goals = load(root);
    if let Some(g) = goals.iter_mut().find(|g| g.id == goal_id) {
        g.text = text.trim().to_string();
        g.updated_at = now_millis();
        save(root, &goals)?;
    }
    Ok(())
}

/// Remove a goal from the ledger entirely.
pub fn delete(root: &Path, goal_id: &str) -> Result<(), String> {
    let _lock = lock_ledger(root)?;
    let mut goals = load(root);
    let before = goals.len();
    goals.retain(|g| g.id != goal_id);
    if goals.len() != before {
        save(root, &goals)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::goals::model::Verdict;

    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("aura_goals_{}", uuid::Uuid::new_v4().simple()));
        fs::create_dir_all(dir.join(".aura")).unwrap();
        dir
    }

    // The id MUST match goalStore.ts:idForText for the same input, or a goal
    // born in the app and one born in the CLI split into two records.
    #[test]
    fn id_parity_with_frontend() {
        // Values computed from the exact JS algorithm in goalStore.ts.
        // normalize("Users can sign in via Google") = "users can sign in via google" (len 27)
        // djb2 over that string, base36(h>>>0) + base36(27).
        assert_eq!(id_for_text("Users can sign in via Google"), js_id("Users can sign in via Google"));
        assert_eq!(id_for_text("  hello   WORLD  "), js_id("  hello   WORLD  "));
        assert_eq!(id_for_text("a"), js_id("a"));
        assert_eq!(id_for_text(""), js_id(""));
        // Whitespace-collapse + case-fold means these are the SAME goal.
        assert_eq!(id_for_text("Users can sign in via Google"), id_for_text("users  can sign  in via google"));
    }

    /// Reference implementation of goalStore.ts:idForText, in Rust, computed
    /// independently of the production path so the test pins the contract
    /// rather than tautologically re-running it.
    fn js_id(text: &str) -> String {
        let n: String = text.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase();
        let mut h: i64 = 5381;
        let mut len: u32 = 0;
        for u in n.encode_utf16() {
            h = (((h << 5) + h + u as i64) as i32) as i64; // | 0 each step
            len += 1;
        }
        let unsigned = (h as i32) as u32;
        fn b36(mut x: u32) -> String {
            if x == 0 {
                return "0".into();
            }
            let d = b"0123456789abcdefghijklmnopqrstuvwxyz";
            let mut o = vec![];
            while x > 0 {
                o.push(d[(x % 36) as usize]);
                x /= 36;
            }
            o.reverse();
            String::from_utf8(o).unwrap()
        }
        format!("goal_{}{}", b36(unsigned), b36(len))
    }

    #[test]
    fn jsonl_roundtrip() {
        let root = scratch();
        let g = upsert_by_text(&root, "users can sign in").unwrap();
        assert_eq!(g.runs.len(), 0);
        record_run(
            &root,
            &g.id,
            GoalRun {
                run_key: "adhoc".into(),
                label: Some("Ad-hoc check".into()),
                agent_id: None,
                verdict: Verdict::Verified,
                ok: 3,
                total: 3,
                commit: Some("abc123".into()),
                trigger: Some("manual".into()),
                files: vec!["src/auth.rs".into()],
                at: now_millis(),
            },
        )
        .unwrap();
        link_task(&root, &g.id, "task-uuid-1", Some(42)).unwrap();

        let reloaded = get(&root, &g.id).unwrap();
        assert_eq!(reloaded.text, "users can sign in");
        assert_eq!(reloaded.task_id.as_deref(), Some("task-uuid-1"));
        assert_eq!(reloaded.task_seq, Some(42));
        assert_eq!(reloaded.runs.len(), 1);
        assert_eq!(reloaded.runs[0].verdict, Verdict::Verified);
        let (verdict, ok, total, _) = reloaded.rollup();
        assert_eq!((verdict, ok, total), (Verdict::Verified, 3, 3));

        // Reverse index: the commit knows which goals it delivered.
        assert_eq!(for_commit(&root, "abc123").len(), 1);
        assert_eq!(for_commit(&root, "nope").len(), 0);
        assert_eq!(for_task(&root, "task-uuid-1").len(), 1);
    }

    #[test]
    fn record_run_replaces_by_key_and_caps() {
        let root = scratch();
        let g = upsert_by_text(&root, "goal with many runs").unwrap();
        for i in 0..(RUN_CAP + 5) {
            record_run(
                &root,
                &g.id,
                GoalRun {
                    run_key: format!("run-{i}"),
                    label: None,
                    agent_id: None,
                    verdict: Verdict::Partial,
                    ok: 1,
                    total: 2,
                    commit: None,
                    trigger: None,
                    files: vec![],
                    at: now_millis() + i as u64,
                },
            )
            .unwrap();
        }
        let reloaded = get(&root, &g.id).unwrap();
        assert_eq!(reloaded.runs.len(), RUN_CAP, "runs capped at RUN_CAP");
        // Re-recording an existing key replaces rather than appends.
        record_run(
            &root,
            &g.id,
            GoalRun {
                run_key: format!("run-{}", RUN_CAP + 4),
                label: None,
                agent_id: None,
                verdict: Verdict::Verified,
                ok: 2,
                total: 2,
                commit: None,
                trigger: None,
                files: vec![],
                at: now_millis() + 999,
            },
        )
        .unwrap();
        let reloaded = get(&root, &g.id).unwrap();
        assert_eq!(reloaded.runs.len(), RUN_CAP, "replace keeps cap");
        assert_eq!(reloaded.runs[0].verdict, Verdict::Verified);
    }

    #[test]
    fn upsert_is_idempotent_on_normalized_text() {
        let root = scratch();
        let a = upsert_by_text(&root, "Build the thing").unwrap();
        let b = upsert_by_text(&root, "  build   the   THING ").unwrap();
        assert_eq!(a.id, b.id);
        assert_eq!(load(&root).len(), 1, "same normalized text → one record");
    }

    /// Concurrent writers must not lose each other's records. Each mutator now
    /// holds the ledger lock across its whole load→mutate→save, so 16 distinct
    /// inserts racing on one ledger all survive. Without the lock this fails
    /// nondeterministically (a writer's save clobbers a sibling's). flock binds
    /// the lock to the open file description — separate opens conflict even
    /// inside one process — so threads here exercise the same path as the
    /// separate-process writers the lock actually guards.
    #[test]
    fn concurrent_writers_dont_lose_updates() {
        use std::sync::Arc;
        let root = Arc::new(scratch());
        let n = 16;
        let handles: Vec<_> = (0..n)
            .map(|i| {
                let root = Arc::clone(&root);
                std::thread::spawn(move || {
                    upsert_by_text(&root, &format!("distinct goal number {i}")).unwrap();
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }
        assert_eq!(
            load(&root).len(),
            n,
            "every concurrent insert must survive — no lost updates"
        );
    }
}
