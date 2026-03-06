use crate::checkpoint::{CheckpointData, CheckpointStore, SnapshotStore};
use crate::parser::SemanticParser;
use git2::Repository;
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::fs;
use std::path::Path;
use std::sync::mpsc::channel;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

pub struct ContinuousTracker {
    parser: Arc<Mutex<SemanticParser>>,
}

impl ContinuousTracker {
    pub fn new(parser: SemanticParser) -> Self {
        Self {
            parser: Arc::new(Mutex::new(parser)),
        }
    }

    /// Starts watching the specified directory indefinitely
    pub fn watch(&self, path_str: &str) -> notify::Result<()> {
        let (tx, rx) = channel();
        
        let mut watcher = RecommendedWatcher::new(tx, notify::Config::default())?;
        watcher.watch(Path::new(path_str), RecursiveMode::Recursive)?;

        println!("[Aura Daemon] Watching {} for continuous semantic changes (Rust & Python)...", path_str);

        for res in rx {
            match res {
                Ok(event) => self.handle_event(event),
                Err(e) => println!("Watcher error: {:?}", e),
            }
        }

        Ok(())
    }

    fn handle_event(&self, event: Event) {
        // KILL SHOT FIX: Repo-State Awareness
        // Check for Git locks before processing any filesystem event.
        if Path::new(".git/index.lock").exists() || 
           Path::new(".git/rebase-merge").exists() || 
           Path::new(".git/rebase-apply").exists() {
            // Git is busy mutating the repo. Pause the daemon to prevent thrashing.
            return;
        }

        if matches!(event.kind, EventKind::Modify(_) | EventKind::Create(_)) {
            for path in event.paths {
                let path_str = path.to_string_lossy();
                
                // Ignore build artifacts, .git, and our own DB
                if path_str.contains(".aura") || path_str.contains("target/") || path_str.contains(".git") {
                    continue;
                }

                // Identify language
                let ext = if path_str.ends_with(".rs") {
                    "rs"
                } else if path_str.ends_with(".py") {
                    "py"
                } else {
                    continue;
                };

                println!("\n[Aura Daemon] Detected file activity: {:?}", path.file_name().unwrap());
                
                if let Ok(source_code) = fs::read_to_string(&path) {
                    // Durable snapshot BEFORE processing — survives even without git commits
                    let _ = SnapshotStore::snapshot_file(
                        &path_str, "watcher", "Aura Continuous Daemon"
                    );
                    self.process_semantic_update(&source_code, ext);
                }
            }
        }
    }

    fn process_semantic_update(&self, source_code: &str, ext: &str) {
        let mut parser = self.parser.lock().unwrap();
        
        if let Ok(ast_nodes) = parser.parse_file(source_code, ext) {
            println!("  --> Re-parsing {} Abstract Syntax Tree...", if ext == "rs" { "Rust" } else { "Python" });
            
            let mut staged_nodes = Vec::new();
            for node in &ast_nodes {
                let name = node.identifier.clone().unwrap_or_else(|| "Anonymous".to_string());
                println!("      Found {}: '{}' (Hash: {})", node.kind, name, node.content_hash);
                staged_nodes.push(node.clone());
            }

            self.commit_micro_state(staged_nodes);
        }
    }

    fn commit_micro_state(&self, ast_nodes: Vec<crate::models::AstNode>) {
        if ast_nodes.is_empty() {
            return;
        }

        let agent_id = "Aura Continuous Daemon".to_string();
        let intent = format!("Implicit Auto-Save triggered. Tracked {} semantic nodes.", ast_nodes.len());
        
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
