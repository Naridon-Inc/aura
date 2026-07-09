use rusqlite::Connection;
use std::path::{Path, PathBuf};
use tokio::task;

#[derive(Clone)]
pub struct DaemonDb {
    pub path: PathBuf,
}

impl DaemonDb {
    pub fn new<P: AsRef<Path>>(path: P) -> Self {
        Self {
            path: path.as_ref().to_path_buf(),
        }
    }

    pub async fn init(&self) -> Result<(), String> {
        let path = self.path.clone();
        task::spawn_blocking(move || {
            let conn = Connection::open(&path).map_err(|e| e.to_string())?;
            
            // ACP Policies table
            conn.execute(
                "CREATE TABLE IF NOT EXISTS acp_policies (
                    id TEXT PRIMARY KEY,
                    policy_json TEXT NOT NULL,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )",
                [],
            ).map_err(|e| e.to_string())?;
            
            // Episodic Memory table
            conn.execute(
                "CREATE TABLE IF NOT EXISTS episodic_memory (
                    event_id TEXT PRIMARY KEY,
                    agent_id TEXT NOT NULL,
                    event_type TEXT NOT NULL,
                    summary TEXT NOT NULL,
                    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
                )",
                [],
            ).map_err(|e| e.to_string())?;
            
            // Signatures metadata table
            conn.execute(
                "CREATE TABLE IF NOT EXISTS signature_metadata (
                    block_id TEXT PRIMARY KEY,
                    signature TEXT NOT NULL,
                    signer_identity TEXT NOT NULL,
                    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
                )",
                [],
            ).map_err(|e| e.to_string())?;

            Ok::<_, String>(())
        })
        .await
        .unwrap_or_else(|e| Err(format!("Task failed: {}", e)))
    }
}
