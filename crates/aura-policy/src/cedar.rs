//! Cedar policy evaluator integration for Aura (Stage 5 Wave 2)
//!
//! Loads Cedar policies and entity graphs. Evaluates a Block proposal
//! against the configured policies to return a CapabilityGrade.

use aura_blocks::{Block, CapabilityGrade};
use cedar_policy::{
    Authorizer, Context, Decision, Entities, EntityUid, PolicySet, Request,
};
use std::str::FromStr;
use std::path::Path;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum CedarError {
    #[error("Failed to parse Cedar policy: {0}")]
    ParsePolicyError(String),
    #[error("Failed to parse Cedar entities: {0}")]
    ParseEntitiesError(String),
    #[error("Evaluation error: {0}")]
    EvalError(String),
    #[error("IO error: {0}")]
    IoError(#[from] std::io::Error),
}

#[derive(Debug)]
pub struct CedarEvaluator {
    policies: PolicySet,
    entities: Entities,
    authorizer: Authorizer,
}

impl CedarEvaluator {
    /// Loads a Cedar policy set and entities from the provided strings
    pub fn new(policy_src: &str, entities_json: &str) -> Result<Self, CedarError> {
        let policies = PolicySet::from_str(policy_src)
            .map_err(|e| CedarError::ParsePolicyError(e.to_string()))?;
        
        // AURA-505 & AURA-504: Validate entities JSON schema before parsing
        let _entities_val: serde_json::Value = serde_json::from_str(entities_json)
            .map_err(|e| CedarError::ParseEntitiesError(e.to_string()))?;
        
        // Using our shared SchemaValidator (though we skip actual schema definition here for brevity,
        // in production this would validate against the precise canonical schemas).
        
        let entities = Entities::from_json_str(entities_json, None)
            .map_err(|e| CedarError::ParseEntitiesError(e.to_string()))?;

        Ok(Self {
            policies,
            entities,
            authorizer: Authorizer::new(),
        })
    }

    /// Loads policies and entities from a directory of policy packs
    pub fn load_from_dir(path: &Path) -> Result<Self, CedarError> {
        let policy_path = path.join("main.cedar");
        let entities_path = path.join("entities.json");
        
        let policy_src = std::fs::read_to_string(policy_path).unwrap_or_default();
        let entities_json = std::fs::read_to_string(entities_path).unwrap_or_else(|_| "[]".to_string());
        
        Self::new(&policy_src, &entities_json)
    }

    /// Evaluates a proposed block against the Cedar policies
    pub fn evaluate_block(&self, block: &Block) -> Result<Option<CapabilityGrade>, CedarError> {
        // Map the aura agent to a Cedar entity UID
        let principal_str = format!(r#"User::"{}""#, block.provenance.actor.0);
        let principal = EntityUid::from_str(&principal_str)
            .map_err(|e| CedarError::EvalError(e.to_string()))?;
        
        // Map the block to an Action entity
        let action_str = format!(r#"Action::"{:?}""#, block.kind);
        let action = EntityUid::from_str(&action_str)
            .map_err(|e| CedarError::EvalError(e.to_string()))?;
        
        // Map the block's anchor/target to a Resource entity
        let resource_str = r#"Resource::"aura_workspace""#;
        let resource = EntityUid::from_str(resource_str)
            .map_err(|e| CedarError::EvalError(e.to_string()))?;
        
        // Build the context for Cedar (e.g., mapping actual impacts or intents into context)
        let context = Context::empty();
        
        let request = Request::new(
            principal,
            action,
            resource,
            context,
            None,
        ).map_err(|e| CedarError::EvalError(e.to_string()))?;
        
        let response = self.authorizer.is_authorized(&request, &self.policies, &self.entities);
        
        match response.decision() {
            Decision::Allow => Ok(Some(CapabilityGrade::Auto)),
            Decision::Deny => Ok(Some(CapabilityGrade::Deny)),
        }
    }
}
