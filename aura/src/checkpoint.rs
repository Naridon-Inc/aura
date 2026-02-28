use git2::{Repository, Signature};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

use crate::models::AstNode;

#[derive(Serialize, Deserialize, Clone)]
pub struct CheckpointData {
    pub id: String,
    pub agent_id: String,
    pub intent: String,
    pub ast_nodes: Vec<AstNode>,
    pub timestamp: u64,
    #[serde(default)]
    pub intent_vector: Option<Vec<f32>>,
    #[serde(default)]
    pub env_fingerprint: Option<String>,
}

pub struct CheckpointStore;

impl CheckpointStore {
    const NOTES_REF: &'static str = "refs/notes/aura";

    /// Save the checkpoint data locally in a temp file during pre-commit
    pub fn stage_checkpoint(data: &CheckpointData) -> Result<(), Box<dyn std::error::Error>> {
        let json = serde_json::to_string_pretty(data)?;
        fs::write(".git/AURA_CTX.json", json)?;
        Ok(())
    }

    /// Read the staged checkpoint data
    pub fn read_staged() -> Result<Option<CheckpointData>, Box<dyn std::error::Error>> {
        let path = Path::new(".git/AURA_CTX.json");
        if !path.exists() {
            return Ok(None);
        }
        let json = fs::read_to_string(path)?;
        let data: CheckpointData = serde_json::from_str(&json)?;
        Ok(Some(data))
    }

    /// Clean up the staged checkpoint
    pub fn cleanup_staged() {
        let _ = fs::remove_file(".git/AURA_CTX.json");
    }

    /// Persist the staged checkpoint permanently into Git Notes attached to the current HEAD
    pub fn commit_staged(repo: &Repository) -> Result<(), Box<dyn std::error::Error>> {
        let data = match Self::read_staged()? {
            Some(d) => d,
            None => return Ok(()), // Nothing to commit
        };
        
        if let Ok(head) = repo.head().and_then(|r| r.peel_to_commit()) {
            Self::add_note(repo, &head, &data)?;
        }
        
        Self::cleanup_staged();
        Ok(())
    }

    /// Attach a semantic checkpoint as a Git Note to a specific commit
    pub fn add_note(repo: &Repository, commit: &git2::Commit, data: &CheckpointData) -> Result<(), Box<dyn std::error::Error>> {
        let json_payload = serde_json::to_string_pretty(data)?;
        let signature = Signature::now("Aura Agent", "ai@aura.vcs")?;
        
        // Add the note to the refs/notes/aura namespace
        repo.note(
            &signature,
            &signature,
            Some(Self::NOTES_REF),
            commit.id(),
            &json_payload,
            true, // Overwrite existing note
        )?;
        
        Ok(())
    }

    /// Commit directly (used by daemon). In the Notes architecture, we attach to current HEAD.
    pub fn commit_direct(repo: &Repository, data: &CheckpointData) -> Result<(), Box<dyn std::error::Error>> {
        if let Ok(head) = repo.head().and_then(|r| r.peel_to_commit()) {
            Self::add_note(repo, &head, data)?;
        }
        Ok(())
    }

    /// Retrieve all checkpoints from the repository by scanning Git Notes
    pub fn get_all_checkpoints(repo: &Repository) -> Result<Vec<CheckpointData>, Box<dyn std::error::Error>> {
        let mut checkpoints = Vec::new();
        
        // Notes in Git are stored in a tree where filenames are OIDs.
        // We find the 'refs/notes/aura' reference and walk its tree.
        let notes_ref = match repo.find_reference(Self::NOTES_REF) {
            Ok(r) => r,
            Err(_) => return Ok(checkpoints), // No notes yet
        };

        let commit = notes_ref.peel_to_commit()?;
        let tree = commit.tree()?;

        // Recursively walk the tree to find all note blobs
        self::walk_notes_tree(repo, &tree, &mut checkpoints)?;
        
        // Sort by timestamp descending
        checkpoints.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
        Ok(checkpoints)
    }

    /// Semantic Compaction for Git Notes (Placeholder for Note-Pruning logic)
    pub fn compact_history(_repo: &Repository) -> Result<usize, Box<dyn std::error::Error>> {
        Ok(0)
    }
}

fn walk_notes_tree(repo: &Repository, tree: &git2::Tree, checkpoints: &mut Vec<CheckpointData>) -> Result<(), Box<dyn std::error::Error>> {
    for entry in tree.iter() {
        match entry.kind() {
            Some(git2::ObjectType::Blob) => {
                let obj = entry.to_object(repo)?;
                if let Some(blob) = obj.as_blob() {
                    if let Ok(json) = std::str::from_utf8(blob.content()) {
                        if let Ok(data) = serde_json::from_str::<CheckpointData>(json) {
                            checkpoints.push(data);
                        }
                    }
                }
            }
            Some(git2::ObjectType::Tree) => {
                let subtree = repo.find_tree(entry.id())?;
                walk_notes_tree(repo, &subtree, checkpoints)?;
            }
            _ => {}
        }
    }
    Ok(())
}
