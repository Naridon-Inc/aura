use crate::checkpoint::{CheckpointData, CheckpointStore, SnapshotStore};
use crate::live_events::{
    AstStateCache, LiveEvent, LiveEventBuffer, FunctionChange,
    current_branch, repo_name, git_user, now_ms,
};
use crate::parser::SemanticParser;
use git2::Repository;
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use uuid::Uuid;

/// How often the watch loop wakes up to confirm the tree it was pointed at is
/// still there. Long enough to be free, short enough that an abandoned daemon
/// is gone within a minute of the directory it was watching.
const LIVENESS_INTERVAL: Duration = Duration::from_secs(30);

/// The background daemon is silent by default. Per-file and per-AST-node tracing
/// is opt-in via `AURA_DAEMON_VERBOSE=1` — without this gate the per-node "Found …"
/// print fires once per parsed symbol and can balloon the daemon log into the
/// multi-gigabyte range on a busy tree.
fn daemon_verbose() -> bool {
    std::env::var("AURA_DAEMON_VERBOSE")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
}

/// Set this to stop `aura init` leaving a watcher behind.
pub const NO_DAEMON_ENV: &str = "AURA_NO_DAEMON";

/// Whether `init` may start a watcher over the tree it just prepared.
///
/// A watcher is the right default for a checkout someone is about to work in,
/// and exactly wrong for a throwaway one. The daemon outlives the `init`
/// process that started it and keeps its own parser and AST cache, so a test
/// suite that inits thirty temporary repositories leaves thirty resident
/// watchers behind — every run, over directories that were deleted seconds
/// later, for as long as the machine stays up.
pub fn autostart_allowed() -> bool {
    autostart_allowed_with(std::env::var(NO_DAEMON_ENV).ok().as_deref())
}

/// The rule, split out from the environment so it can be stated as a test.
/// Presence is the signal, as with every other opt-out in this crate, but an
/// explicit `0` / `false` / `no` reads as "don't disable it" — a harness that
/// exports `AURA_NO_DAEMON=0` means the opposite of silence, and honouring the
/// bare presence there would silently ignore what it asked for.
pub(crate) fn autostart_allowed_with(value: Option<&str>) -> bool {
    match value {
        None => true,
        Some(v) => matches!(v.trim(), "" | "0" | "false" | "no"),
    }
}

/// The PID of a watcher daemon already running over `root`, if there is one.
///
/// Starting a second watcher on a tree that already has one is pure waste:
/// both parse every save, both write snapshots, and nothing tells them apart
/// afterwards. Callers that auto-start the daemon (`aura init`) ask first.
///
/// Identity is the process's working directory, because that is exactly what
/// the daemon watches — `aura daemon` takes no path argument and always
/// watches where it was started.
pub fn daemon_watching(root: &Path) -> Option<u32> {
    use sysinfo::System;
    let want = fs::canonicalize(root).ok()?;
    let mut sys = System::new();
    sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
    sys.processes().values().find_map(|p| {
        let is_daemon = p.name().to_string_lossy().contains("aura")
            && p.cmd()
                .iter()
                .any(|a| a.to_string_lossy() == "daemon");
        if !is_daemon {
            return None;
        }
        // A process is only a duplicate if it is watching *this* tree.
        match p.cwd() {
            Some(cwd) if cwd == want => Some(p.pid().as_u32()),
            _ => None,
        }
    })
}

pub struct ContinuousTracker {
    parser: Arc<Mutex<SemanticParser>>,
    ast_cache: Arc<Mutex<AstStateCache>>,
    live_mode: bool,
}

impl ContinuousTracker {
    pub fn new(parser: SemanticParser) -> Self {
        Self {
            parser: Arc::new(Mutex::new(parser)),
            ast_cache: Arc::new(Mutex::new(AstStateCache::new())),
            live_mode: false,
        }
    }

    /// Create a tracker with live mode enabled (streams events to buffer).
    pub fn with_live_mode(parser: SemanticParser) -> Self {
        LiveEventBuffer::init();
        let mut cache = AstStateCache::new();
        // Mark initial scan done immediately — the watcher has no initial scan phase,
        // so any new files detected should emit "added" events.
        cache.mark_initial_scan_done();
        Self {
            parser: Arc::new(Mutex::new(parser)),
            ast_cache: Arc::new(Mutex::new(cache)),
            live_mode: true,
        }
    }

    /// Starts watching the specified directory until it goes away.
    pub fn watch(&self, path_str: &str) -> notify::Result<()> {
        self.watch_every(path_str, LIVENESS_INTERVAL)
    }

    /// `watch`, with the idle-wakeup period as an argument so the "the tree
    /// went away, stop" path can be exercised in a test without waiting out
    /// the production interval.
    pub(crate) fn watch_every(&self, path_str: &str, idle: Duration) -> notify::Result<()> {
        let (tx, rx) = channel();

        let mut watcher = RecommendedWatcher::new(tx, notify::Config::default())?;
        watcher.watch(Path::new(path_str), RecursiveMode::Recursive)?;

        // Resolve the watched tree to an absolute path up front, while it is
        // certainly still there. The liveness check below cannot use the
        // relative `path_str`: the daemon is normally started with "." and a
        // deleted directory still resolves through the process's own cwd
        // handle, so `Path::new(".").exists()` answers `true` forever.
        let root = fs::canonicalize(path_str).unwrap_or_else(|_| Path::new(path_str).to_path_buf());

        let mode_label = if self.live_mode { " + Live Mode" } else { "" };
        println!("[Aura Daemon] Watching {} for continuous semantic changes{mode_label}...", path_str);

        if self.live_mode {
            println!("[Aura Live] Streaming function-level diffs to .aura/live/events.jsonl");
            println!("[Aura Live] User: {} | Branch: {} | Repo: {}", git_user(), current_branch(), repo_name());
        }

        // `for res in rx` blocks forever, which is right while there is a tree
        // to watch and wrong once there isn't: when the directory is deleted,
        // FSEvents simply stops delivering — no event, no error — so the loop
        // parks on an empty channel for the rest of the machine's uptime. That
        // is how a run of `aura init` in a scratch directory leaves a daemon
        // behind, each one holding its own parser and AST cache; they pile up
        // across runs until something notices the memory. Wake periodically
        // and stop when the tree we were asked to watch is gone.
        loop {
            match rx.recv_timeout(idle) {
                Ok(Ok(event)) => self.handle_event(event),
                Ok(Err(e)) => println!("Watcher error: {:?}", e),
                Err(RecvTimeoutError::Timeout) => {
                    if !root.exists() {
                        println!(
                            "[Aura Daemon] {} no longer exists — nothing left to watch, stopping.",
                            root.display()
                        );
                        return Ok(());
                    }
                }
                // The watcher hung up: no further events can arrive, so
                // waiting for one is waiting for nothing.
                Err(RecvTimeoutError::Disconnected) => return Ok(()),
            }
        }
    }

    /// Read the latest intent from the intent log to link snapshots to AI context
    fn get_latest_intent() -> (String, String) {
        let intent_path = ".aura/intent_log.jsonl";
        if let Ok(file) = fs::File::open(intent_path) {
            let reader = BufReader::new(file);
            if let Some(last_line) = reader.lines().filter_map(|l| l.ok()).last() {
                if let Ok(entry) = serde_json::from_str::<serde_json::Value>(&last_line) {
                    let agent = entry["agent_id"].as_str().unwrap_or("unknown").to_string();
                    let intent = entry["intent"].as_str().unwrap_or("").to_string();
                    if !intent.is_empty() {
                        return (agent, intent);
                    }
                }
            }
        }
        ("Aura Continuous Daemon".to_string(), String::new())
    }

    fn handle_event(&self, event: Event) {
        // Check for Git locks before processing any filesystem event.
        if Path::new(".git/index.lock").exists() ||
           Path::new(".git/rebase-merge").exists() ||
           Path::new(".git/rebase-apply").exists() {
            return;
        }

        // Skip if auto-pull is writing files — prevents feedback loop
        if Path::new(".aura/live/pull_in_progress").exists() {
            return;
        }

        if matches!(event.kind, EventKind::Modify(_) | EventKind::Create(_)) {
            for path in event.paths {
                let path_str = path.to_string_lossy();

                // Ignore build artifacts, .git, and our own state
                if path_str.contains(".aura") || path_str.contains("target/")
                    || path_str.contains(".git") || path_str.contains("node_modules/")
                    || path_str.contains(".next/") || path_str.contains("dist/")
                    || path_str.contains("build/") || path_str.contains("__pycache__/")
                    || path_str.contains(".cache/") || path_str.contains("vendor/") {
                    continue;
                }

                // Identify language — support all tree-sitter languages
                let ext = if path_str.ends_with(".rs") { "rs" }
                    else if path_str.ends_with(".py") { "py" }
                    else if path_str.ends_with(".ts") { "ts" }
                    else if path_str.ends_with(".tsx") { "tsx" }
                    else if path_str.ends_with(".js") { "js" }
                    else if path_str.ends_with(".jsx") { "jsx" }
                    else if path_str.ends_with(".go") { "go" }
                    else if path_str.ends_with(".java") { "java" }
                    else if path_str.ends_with(".cs") { "cs" }
                    else if path_str.ends_with(".rb") { "rb" }
                    else if path_str.ends_with(".cpp") || path_str.ends_with(".cc") || path_str.ends_with(".cxx") { "cpp" }
                    else if path_str.ends_with(".hpp") { "hpp" }
                    else if path_str.ends_with(".c") { "c" }
                    else if path_str.ends_with(".h") { "h" }
                    else if path_str.ends_with(".php") { "php" }
                    else { continue; };

                if daemon_verbose() {
                    println!("\n[Aura Daemon] Detected file activity: {:?}", path.file_name().unwrap());
                }

                if let Ok(source_code) = fs::read_to_string(&path) {
                    // Link snapshot to the latest AI intent
                    let (agent_id, intent_ctx) = Self::get_latest_intent();
                    let trigger_label = if intent_ctx.is_empty() {
                        "watcher".to_string()
                    } else {
                        format!("watcher:{}", &intent_ctx[..intent_ctx.len().min(100)])
                    };

                    // Durable snapshot BEFORE processing — survives even without git commits
                    let _ = SnapshotStore::snapshot_file(
                        &path_str, &trigger_label, &agent_id
                    );

                    // Make path relative for consistent cross-machine tracking
                    let relative_path = path_str
                        .strip_prefix(&format!("{}/", std::env::current_dir().unwrap_or_default().display()))
                        .unwrap_or(&path_str)
                        .to_string();

                    self.process_semantic_update(&source_code, ext, &relative_path);
                }
            }
        }
    }

    fn process_semantic_update(&self, source_code: &str, ext: &str, file_path: &str) {
        let mut parser = self.parser.lock().unwrap();

        let lang_name = match ext {
            "rs" => "Rust",
            "py" => "Python",
            "ts" | "tsx" => "TypeScript",
            "js" | "jsx" => "JavaScript",
            "go" => "Go",
            "java" => "Java",
            "cs" => "C#",
            "rb" => "Ruby",
            "cpp" | "cc" | "cxx" | "hpp" => "C++",
            "c" | "h" => "C",
            "php" => "PHP",
            _ => ext,
        };

        if let Ok(ast_nodes) = parser.parse_file(source_code, ext) {
            let verbose = daemon_verbose();
            if verbose {
                println!("  --> Re-parsing {} Abstract Syntax Tree...", lang_name);
            }

            let mut staged_nodes = Vec::new();
            for node in &ast_nodes {
                if verbose {
                    let name = node.identifier.clone().unwrap_or_else(|| "Anonymous".to_string());
                    println!("      Found {}: '{}' (Hash: {})", node.kind, name, node.content_hash);
                }
                staged_nodes.push(node.clone());
            }

            // Compute function-level diffs for Aura Live
            if self.live_mode {
                self.emit_live_event(file_path, &ast_nodes);
            }

            self.commit_micro_state(staged_nodes);
        }
    }

    /// Compute AST diff and emit a LiveEvent to the buffer.
    fn emit_live_event(&self, file_path: &str, new_nodes: &[crate::models::AstNode]) {
        // Filter non-source files — screenshots, OS junk, binaries, editor temp files.
        let fp_lower = file_path.to_lowercase();
        let skip_exts = [
            ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".pdf", ".mp4",
            ".mov", ".zip", ".tar", ".tar.gz", ".tgz", ".dmg", ".ds_store",
            ".lock", ".log", ".swp", ".swo", ".pyc", ".class",
        ];
        if skip_exts.iter().any(|e| fp_lower.ends_with(e))
            || file_path.contains("/var/folders/")
            || file_path.contains("/TemporaryItems/")
            || file_path.contains("/.git/")
            || file_path.contains("/node_modules/")
            || file_path.contains("/target/")
            || file_path.contains("/dist/")
        {
            return;
        }

        let mut cache = self.ast_cache.lock().unwrap();
        let mut changes = cache.diff_and_update(file_path, new_nodes);

        if changes.is_empty() {
            return;
        }

        // Enrich with AI-generated rationales (free no-op if no key or intent)
        let (_agent, intent) = Self::get_latest_intent();
        crate::live_events::enrich_with_rationales(&mut changes, &intent);

        // Persist rationales to the commit-keyed store with a "pending" SHA.
        // The post-commit hook (persist-checkpoint) backfills the real SHA
        // once the commit lands, so `intent vs actual` can later join these
        // per-symbol rationales onto a historical commit's report.
        crate::live_events::persist_rationales(None, file_path, &changes);

        let change_summary: Vec<String> = changes.iter().map(|c| {
            let action = match c.change_type {
                crate::live_events::ChangeType::Added => "+",
                crate::live_events::ChangeType::Modified => "~",
                crate::live_events::ChangeType::Deleted => "-",
            };
            format!("{}{} {}", action, c.kind, c.name)
        }).collect();

        println!("  [Live] {} changes: {}", changes.len(), change_summary.join(", "));

        let event = LiveEvent {
            event_id: Uuid::new_v4().to_string(),
            timestamp: now_ms(),
            user: git_user(),
            branch: current_branch(),
            repo: repo_name(),
            file_path: file_path.to_string(),
            changes,
        };

        if let Err(e) = LiveEventBuffer::append(&event) {
            println!("  [Live] Failed to buffer event: {}", e);
        }
    }

    fn commit_micro_state(&self, ast_nodes: Vec<crate::models::AstNode>) {
        if ast_nodes.is_empty() {
            return;
        }

        // Pull latest intent so the checkpoint knows what the agent was doing
        let (agent_id, intent_ctx) = Self::get_latest_intent();
        let intent = if intent_ctx.is_empty() {
            format!("Auto-save: tracked {} semantic nodes.", ast_nodes.len())
        } else {
            format!("Auto-save ({}): {} nodes.", &intent_ctx[..intent_ctx.len().min(80)], ast_nodes.len())
        };

        let id = Uuid::new_v4().to_string();
        let timestamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64;

        let data = CheckpointData {
            id: id.clone(),
            agent_id,
            intent,
            ast_nodes,
            timestamp,
            intent_vector: None,
            intent_vector_model: None,
            env_fingerprint: None,
            // The watcher parses whatever changed on disk rather than walking
            // the index, so it has no blob OIDs to record. Left empty on
            // purpose: an auto-save checkpoint simply doesn't seed the parse
            // cache, and the next real capture parses from source.
            file_oids: std::collections::HashMap::new(),
        };

        if let Ok(repo) = Repository::open(".") {
            match CheckpointStore::commit_direct(&repo, &data) {
                Ok(_) if daemon_verbose() => {
                    println!("  --> Continuous micro-state persisted to hidden branch: {}", &id[0..8]);
                }
                Ok(_) => {}
                Err(_) => eprintln!("  --> Failed to write continuous micro-state to Git."),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc::sync_channel;
    use std::thread;

    /// The other half of the same leak: a watcher that was never started
    /// cannot outlive anything. `init` is run by test harnesses dozens of
    /// times per suite, in directories that exist for a few seconds each.
    #[test]
    fn a_harness_can_ask_init_to_leave_no_watcher_behind() {
        assert!(autostart_allowed_with(None), "the default is a watcher");
        assert!(!autostart_allowed_with(Some("1")));
        assert!(!autostart_allowed_with(Some("true")));
        // Presence is the signal, so any other value counts too — someone
        // setting this is telling us what they want, not typing a keyword.
        assert!(!autostart_allowed_with(Some("yes please")));
    }

    #[test]
    fn setting_it_to_zero_asks_for_the_watcher_not_against_it() {
        // A harness that exports `AURA_NO_DAEMON=0` means the opposite of
        // silence; reading bare presence here would ignore what it asked for.
        assert!(autostart_allowed_with(Some("0")));
        assert!(autostart_allowed_with(Some("false")));
        assert!(autostart_allowed_with(Some("no")));
        assert!(autostart_allowed_with(Some("  ")), "an empty value is not a request");
    }

    /// The daemon must not outlive the directory it was pointed at.
    ///
    /// This is the leak that put dozens of idle `aura daemon` processes on a
    /// developer machine: every `aura init` run in a scratch directory left
    /// one behind, and the old `for res in rx` loop had no way to notice the
    /// tree had been deleted out from under it.
    #[test]
    fn stops_once_the_watched_tree_is_deleted() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().to_path_buf();
        // Keep the directory alive past the TempDir guard so this test — not
        // the drop order — decides when it disappears.
        let dir = dir.into_path();

        let parser = match SemanticParser::new() {
            Ok(p) => p,
            // The parser needs its grammars; without them there is nothing to
            // test here, and failing would be reporting the wrong defect.
            Err(_) => return,
        };
        let tracker = ContinuousTracker::new(parser);

        let (done_tx, done_rx) = sync_channel(1);
        let watched = root.clone();
        thread::spawn(move || {
            let r = tracker.watch_every(
                watched.to_str().expect("utf-8 path"),
                Duration::from_millis(50),
            );
            let _ = done_tx.send(r.is_ok());
        });

        // Let the watcher get as far as its first idle wakeup, then take the
        // tree away.
        thread::sleep(Duration::from_millis(150));
        let _ = fs::remove_dir_all(&dir);

        let returned = done_rx
            .recv_timeout(Duration::from_secs(10))
            .expect("watch() should return once its directory is gone");
        assert!(returned, "watch() should return Ok, not an error");
    }

    /// The liveness check has to resolve the path before the directory can go
    /// away — a relative "." keeps resolving through the process's own cwd
    /// handle long after the directory is unlinked.
    #[test]
    fn a_deleted_absolute_path_reads_as_gone() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = fs::canonicalize(dir.path()).expect("canonicalize");
        assert!(root.exists());
        drop(dir);
        assert!(!root.exists(), "an absolute path to a deleted dir is gone");
    }

    /// Nothing is watching a directory that has never had a daemon, so `init`
    /// is free to start one.
    #[test]
    fn no_daemon_reported_for_an_unwatched_directory() {
        let dir = tempfile::tempdir().expect("tempdir");
        assert_eq!(daemon_watching(dir.path()), None);
    }
}
