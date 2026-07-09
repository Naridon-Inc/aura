use std::sync::Arc;
use aura_blockstore::{BlockStore, BlockFilter};
use aura_blocks::{Block, BlockState};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct FleetPanelQuery {
    pub active_only: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct FleetPanelData {
    pub actors: Vec<ActorGroup>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ActorGroup {
    pub actor_id: String,
    pub active_blocks: Vec<Block>,
}

pub struct FleetService {
    store: Arc<BlockStore>,
}

impl FleetService {
    pub fn new(store: Arc<BlockStore>) -> Self {
        Self { store }
    }

    /// Query the BlockStore to generate the data structure needed for the
    /// aura-term sidebar Fleet view.
    pub fn get_fleet_data(&self, query: &FleetPanelQuery) -> Result<FleetPanelData, String> {
        let filter = BlockFilter::default();
        // Since we can't query by multiple states in BlockFilter, we filter in memory.
        let blocks = self.store.list_blocks(&filter).map_err(|e| e.to_string())?;

        let mut groups: std::collections::HashMap<String, Vec<Block>> = std::collections::HashMap::new();

        for block in blocks {
            if query.active_only && block.state != BlockState::Proposed && block.state != BlockState::Running {
                continue;
            }
            
            let actor_str = match serde_json::to_value(&block.provenance.actor) {
                Ok(serde_json::Value::String(s)) => s,
                Ok(v) => v.to_string(),
                _ => format!("{:?}", block.provenance.actor),
            };
            groups.entry(actor_str).or_default().push(block);
        }

        let actors = groups.into_iter().map(|(actor_id, active_blocks)| {
            ActorGroup {
                actor_id,
                active_blocks,
            }
        }).collect();

        Ok(FleetPanelData { actors })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use aura_blockstore::BlockStore;
    use aura_blocks::{Block, BlockState, BlockKind, AnchorRef, AgentRef, Provenance, Intent, DeclaredImpacts, BlockPayload, BlockId};
    use tempfile::tempdir;
    use std::sync::Arc;
    use time::OffsetDateTime;

    #[test]
    fn test_get_fleet_data_active_only() {
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("blocks.db");
        let store = Arc::new(BlockStore::open(&db_path).unwrap());
        
        let create_mock_block = |actor: &str, state: BlockState| -> Block {
            let mut block = Block {
                id: BlockId::new(),
                schema_version: aura_blocks::SchemaVersion { major: 1, minor: 0, patch: 0 },
                kind: BlockKind::Command,
                parent_id: None,
                prior_sibling_id: None,
                supersedes_id: None,
                anchor: AnchorRef::None,
                intent: Intent {
                    summary: "test".to_string(),
                    detail: Some("test".to_string()),
                    parent_intent: None,
                },
                declared_impacts: DeclaredImpacts {
                    writes_paths: vec![],
                    reads_paths: vec![],
                    network: vec![],
                    touches_zones: vec![],
                    installs_packages: vec![],
                    mutates_secrets: vec![],
                    deploys: vec![],
                },
                actual_impacts: None,
                payload: BlockPayload::Command { command: "test".into(), shell: None, cwd: "/".into() },
                state,
                policy: None,
                provenance: Provenance {
                    actor: AgentRef(actor.to_string()),
                    on_behalf_of: None,
                    origin_host: "test".to_string(),
                    signature: None,
                },
                attestations: Default::default(),
                created_at: OffsetDateTime::now_utc(),
                updated_at: OffsetDateTime::now_utc(),
                extensions: Default::default(),
            };
            block
        };

        let block1 = create_mock_block("agent_a", BlockState::Proposed);
        let block2 = create_mock_block("agent_b", BlockState::Running);
        let block3 = create_mock_block("agent_a", BlockState::Denied); // Not active
        
        store.insert_block(&block1).unwrap();
        store.insert_block(&block2).unwrap();
        store.insert_block(&block3).unwrap();
        
        let service = FleetService::new(store);
        
        // Active only
        let data = service.get_fleet_data(&FleetPanelQuery { active_only: true }).unwrap();
        assert_eq!(data.actors.len(), 2); // agent_a and agent_b
        
        let agent_a_group = data.actors.iter().find(|a| a.actor_id.contains("agent_a")).unwrap();
        assert_eq!(agent_a_group.active_blocks.len(), 1); // Only the Proposed one, Denied is filtered out
        
        // All blocks
        let data_all = service.get_fleet_data(&FleetPanelQuery { active_only: false }).unwrap();
        let agent_a_all = data_all.actors.iter().find(|a| a.actor_id.contains("agent_a")).unwrap();
        assert_eq!(agent_a_all.active_blocks.len(), 2); // Proposed and Denied
    }
}
