//! Foundational Contracts & Core Data Models (Stage 5 Wave 1)
//!
//! Provides JSON schema definitions and validation utilities for 
//! inter-service data exchange between `aura-policy`, `aura-sandbox`, 
//! and `aura-verifier`.

use jsonschema::Validator;
use schemars::{schema_for, JsonSchema};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ─── Sandbox Contracts ──────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct SandboxRequest {
    /// The block identifier
    pub block_id: String,
    /// The AST/Payload required for speculative execution
    pub payload: serde_json::Value,
    /// Relevant context for sandbox (e.g. env vars, mocked state)
    pub context: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct SandboxResponse {
    pub block_id: String,
    /// True if the sandbox successfully executed the proposed action
    pub success: bool,
    /// Any errors or divergence detected during execution
    pub error: Option<String>,
    /// Post-execution state changes (ActualImpacts)
    pub actual_impacts: Option<serde_json::Value>,
}

// ─── Verifier Contracts ─────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct VerifierRequest {
    pub block_id: String,
    /// The mathematical proof target (Verus logic or specific invariant)
    pub target_invariant: String,
    /// AST nodes related to the proof
    pub ast_context: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct VerifierResponse {
    pub block_id: String,
    pub verified: bool,
    /// Detailed verifier output, counter-examples if failed
    pub proof_output: String,
}

// ─── Schema Validation Utility ──────────────────────────────────────────

/// Shared schema validation utility (AURA-504 implementation)
pub struct SchemaValidator {
    schema: Validator,
}

impl SchemaValidator {
    pub fn new<T: JsonSchema>() -> Self {
        let schema_obj = schema_for!(T);
        let schema_json = serde_json::to_value(&schema_obj).unwrap();
        let schema = jsonschema::validator_for(&schema_json).expect("Invalid JSON schema definition");
        Self { schema }
    }

    pub fn validate(&self, instance: &serde_json::Value) -> Result<(), Vec<String>> {
        if let Err(e) = self.schema.validate(instance) {
            return Err(vec![format!("Validation error: {}", e)]);
        }
        Ok(())
    }
}
