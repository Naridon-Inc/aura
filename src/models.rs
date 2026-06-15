use serde::{Deserialize, Serialize};

// A cryptographic hash representing the semantic identity of code (not just text)
pub type SemanticHash = String;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DependencyUri {
    pub name: String,
    pub uri: Option<String>,
}

/// Represents a single node in the Abstract Syntax Tree (AST).
/// Instead of lines of code, Aura tracks functions, classes, and logic blocks.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AstNode {
    pub node_id: String,            // Immutable Logic Identity
    pub kind: String,               // e.g., "function_definition", "class_definition"
    pub identifier: Option<String>, // e.g., "calculate_tax" (if applicable)
    pub content_hash: SemanticHash, // Hash of the specific logic block
    pub children: Vec<SemanticHash>,// Merkle links to child AST nodes
    pub dependencies: Vec<DependencyUri>, // The Global Merkle-Graph with URIs
    #[serde(default)]
    pub contains_secret: bool,      // Semantic Sentinel flag
    #[serde(default)]
    pub is_stub: bool,              // True if node contains TODO, todo!(), or stubs
    pub derived_from: Option<String>, // KILL SHOT FIX: Lineage tracking
    #[serde(default)]
    pub confidence: f32,           // Epistemic certainty score
    #[serde(default)]
    pub file_path: Option<String>,  // Source file (e.g., "src/server.rs")
    #[serde(default)]
    pub start_line: Option<u32>,    // Line number where the node starts (1-based)
    #[serde(default)]
    pub end_line: Option<u32>,      // Line number where the node ends
    #[serde(default)]
    pub signature: Option<String>,  // Human-readable signature (e.g., "fn health_check(state: AppState) -> StatusCode")
    #[serde(default)]
    pub doc_comment: Option<String>,// Doc comment / docstring if present
    /// True when this symbol is defined at module top level (or as a class
    /// member) rather than nested inside a function/closure body. Lets the
    /// change-note card list the symbols a reader cares about and drop
    /// body-locals (loop counters, temporaries). Defaults to `true` so an
    /// older serialized node — or any builder that doesn't set scope — is
    /// treated as visible, never silently hidden.
    #[serde(default = "default_true")]
    pub top_level: bool,
}

/// serde default for `AstNode::top_level` — absent scope means "visible".
fn default_true() -> bool {
    true
}

/// The metadata around *why* the code changed.
/// Git tracks "who" (Author) and "what" (Diff). Aura tracks "why" (Intent).
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Intent {
    pub description: String,          // e.g., "Refactor authentication flow"
    pub agent_id: String,             // e.g., "aider-v1", "cursor-copilot"
    pub prompt_trace: Option<String>, // Optional reference to the LLM prompt/reasoning
}

/// The validation gating mechanism.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Verification {
    pub health_score: f32,              // 0.0 (tests failed) to 1.0 (all green)
    pub test_log_hash: Option<String>,  // Hash of the test execution logs for auditing
}

/// A StateNode replaces the concept of a "Commit" in Git.
/// It represents a verified transition in the continuous DAG.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct StateNode {
    pub parent_hashes: Vec<SemanticHash>, // Multiple parents if it's a merge
    pub root_ast_hash: SemanticHash,      // The root of the codebase DAG at this exact moment
    pub intent: Intent,
    pub verification: Verification,
    pub timestamp_ms: u64,
}

/// Configuration for an external AI Agent connecting to the Aura Daemon
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AgentConfig {
    pub agent_name: String,     // e.g., "Aider", "Cursor", "AutoGPT"
    pub local_port: u16,        // Port the agent is communicating over
    pub capabilities: Vec<String>,
}
