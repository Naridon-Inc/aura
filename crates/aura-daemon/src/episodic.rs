use std::sync::Arc;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use crate::db::DaemonDb;

#[derive(Debug, Serialize, Deserialize)]
pub struct EpisodicEvent {
    pub event_id: Uuid,
    pub agent_id: String,
    pub event_type: String,
    pub summary: String,
    pub timestamp: Option<String>,
}

pub struct EpisodicMemoryManager {
    db: Arc<DaemonDb>,
}

impl EpisodicMemoryManager {
    pub fn new(db: Arc<DaemonDb>) -> Self {
        Self { db }
    }

    /// Ingest a new episodic memory event into the embedded database
    pub async fn ingest_event(&self, event: EpisodicEvent) -> Result<(), String> {
        let db = self.db.clone();
        tokio::task::spawn_blocking(move || {
            let conn = rusqlite::Connection::open(&db.path).map_err(|e| e.to_string())?;
            conn.execute(
                "INSERT INTO episodic_memory (event_id, agent_id, event_type, summary)
                 VALUES (?1, ?2, ?3, ?4)",
                params![
                    event.event_id.to_string(),
                    event.agent_id,
                    event.event_type,
                    event.summary,
                ],
            ).map_err(|e| e.to_string())?;
            Ok::<(), String>(())
        })
        .await
        .unwrap_or_else(|e| Err(format!("Task failed: {}", e)))
    }

    /// Query episodic memory events with pagination and filtering
    pub async fn query_events(&self, agent_id: Option<String>, limit: i64) -> Result<Vec<EpisodicEvent>, String> {
        let db = self.db.clone();
        tokio::task::spawn_blocking(move || {
            let conn = rusqlite::Connection::open(&db.path).map_err(|e| e.to_string())?;
            let mut query_str = "SELECT event_id, agent_id, event_type, summary, timestamp FROM episodic_memory".to_string();
            
            if agent_id.is_some() {
                query_str.push_str(" WHERE agent_id = ?1");
            }
            query_str.push_str(" ORDER BY timestamp DESC LIMIT ?2");
            
            let mut stmt = conn.prepare(&query_str).map_err(|e| e.to_string())?;
            let mut events = Vec::new();
            
            let map_fn = |row: &rusqlite::Row| {
                Ok(EpisodicEvent {
                    event_id: Uuid::parse_str(&row.get::<_, String>(0)?).unwrap_or_default(),
                    agent_id: row.get(1)?,
                    event_type: row.get(2)?,
                    summary: row.get(3)?,
                    timestamp: Some(row.get(4)?),
                })
            };

            let rows = if let Some(aid) = agent_id {
                stmt.query_map(params![aid, limit], map_fn)
            } else {
                stmt.query_map(params!["", limit], map_fn)
            };

            if let Ok(mapped_rows) = rows {
                for r in mapped_rows {
                    if let Ok(event) = r {
                        events.push(event);
                    }
                }
            }
            Ok(events)
        })
        .await
        .unwrap_or_else(|e| Err(format!("Task failed: {}", e)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[tokio::test]
    async fn test_episodic_memory_manager() {
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("test.db");
        let db = Arc::new(DaemonDb::new(&db_path));
        db.init().await.unwrap();

        let manager = EpisodicMemoryManager::new(db);

        let event1 = EpisodicEvent {
            event_id: Uuid::new_v4(),
            agent_id: "agent_a".to_string(),
            event_type: "action".to_string(),
            summary: "Did something".to_string(),
            timestamp: None,
        };

        let event2 = EpisodicEvent {
            event_id: Uuid::new_v4(),
            agent_id: "agent_b".to_string(),
            event_type: "thought".to_string(),
            summary: "Thought about it".to_string(),
            timestamp: None,
        };

        manager.ingest_event(event1).await.unwrap();
        manager.ingest_event(event2).await.unwrap();

        let all_events = manager.query_events(None, 10).await.unwrap();
        assert_eq!(all_events.len(), 2);

        let agent_a_events = manager.query_events(Some("agent_a".to_string()), 10).await.unwrap();
        assert_eq!(agent_a_events.len(), 1);
        assert_eq!(agent_a_events[0].agent_id, "agent_a");
    }
}
