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
use std::sync::mpsc::channel;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

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

    /// Starts watching the specified directory indefinitely
    pub fn watch(&self, path_str: &str) -> notify::Result<()> {
        let (tx, rx) = channel();

        let mut watcher = RecommendedWatcher::new(tx, notify::Config::default())?;
        watcher.watch(Path::new(path_str), RecursiveMode::Recursive)?;

        let mode_label = if self.live_mode { " + Live Mode" } else { "" };
        println!("[Aura Daemon] Watching {} for continuous semantic changes{mode_label}...", path_str);

        if self.live_mode {
            println!("[Aura Live] Streaming function-level diffs to .aura/live/events.jsonl");
            println!("[Aura Live] User: {} | Branch: {} | Repo: {}", git_user(), current_branch(), repo_name());
        }

        for res in rx {
            match res {
                Ok(event) => self.handle_event(event),
                Err(e) => println!("Watcher error: {:?}", e),
            }
        }

        Ok(())
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

                println!("\n[Aura Daemon] Detected file activity: {:?}", path.file_name().unwrap());

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
            println!("  --> Re-parsing {} Abstract Syntax Tree...", lang_name);

            let mut staged_nodes = Vec::new();
            for node in &ast_nodes {
                let name = node.identifier.clone().unwrap_or_else(|| "Anonymous".to_string());
                println!("      Found {}: '{}' (Hash: {})", node.kind, name, node.content_hash);
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
        let mut cache = self.ast_cache.lock().unwrap();
        let changes = cache.diff_and_update(file_path, new_nodes);

        if changes.is_empty() {
            return;
        }

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
            env_fingerprint: None,
        };

        if let Ok(repo) = Repository::open(".") {
            if let Ok(_) = CheckpointStore::commit_direct(&repo, &data) {
                println!("  --> Continuous micro-state persisted to hidden branch: {}", &id[0..8]);
            } else {
                println!("  --> Failed to write continuous micro-state to Git.");
            }
        }
    }
}
