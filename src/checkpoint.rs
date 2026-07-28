use git2::{Repository, Signature};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// Resolve the real `.git` directory, honouring worktrees where `.git`
/// is a file pointer rather than a directory. Falls back to a literal
/// `.git` path if we can't open the repo (e.g. aura invoked outside a
/// repo — the subsequent write will fail loudly with a git error, which
/// is the correct behaviour).
fn git_dir() -> PathBuf {
    Repository::open(".")
        .map(|r| r.path().to_path_buf())
        .unwrap_or_else(|_| PathBuf::from(".git"))
}

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
    /// Which embedding model produced `intent_vector` (W1). Vectors from
    /// different models live in different spaces — `aura ask` only compares
    /// same-model. Additive: old checkpoints deserialize with `None`.
    #[serde(default)]
    pub intent_vector_model: Option<String>,
    #[serde(default)]
    pub env_fingerprint: Option<String>,
}

/// A durable file-level snapshot stored on disk in .aura/snapshots/
/// This survives regardless of git state — even if no commit exists.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct FileSnapshot {
    pub file_path: String,
    pub content: String,
    pub timestamp: u64,
    pub trigger: String,  // "mcp_edit", "watcher", "pre_commit", "manual"
    pub agent_id: String,
}

pub struct SnapshotStore;

impl SnapshotStore {
    const SNAPSHOT_DIR: &'static str = ".aura/snapshots";
    const MAX_SNAPSHOTS_PER_FILE: usize = 50;
    const MAX_TOTAL_SNAPSHOTS: usize = 500;

    /// Ensure the snapshot directory exists
    fn ensure_dir() {
        let _ = fs::create_dir_all(Self::SNAPSHOT_DIR);
    }

    /// Take a durable snapshot of a file before it gets modified.
    /// Returns the snapshot ID (filename) on success.
    pub fn snapshot_file(file_path: &str, trigger: &str, agent_id: &str) -> Result<String, String> {
        Self::ensure_dir();

        let content = fs::read_to_string(file_path)
            .map_err(|e| format!("Cannot snapshot {}: {}", file_path, e))?;

        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;

        let snapshot = FileSnapshot {
            file_path: file_path.to_string(),
            content,
            timestamp,
            trigger: trigger.to_string(),
            agent_id: agent_id.to_string(),
        };

        // Filename: sanitized_path__timestamp.json
        let safe_name = file_path.replace('/', "__").replace('\\', "__");
        let filename = format!("{}__{}.json", safe_name, timestamp);
        let snap_path = format!("{}/{}", Self::SNAPSHOT_DIR, filename);

        let json = serde_json::to_string(&snapshot)
            .map_err(|e| format!("Serialize error: {}", e))?;

        // Atomic write
        let tmp_path = format!("{}.tmp", snap_path);
        fs::write(&tmp_path, &json).map_err(|e| format!("Write error: {}", e))?;
        fs::rename(&tmp_path, &snap_path).map_err(|e| format!("Rename error: {}", e))?;

        // Prune old snapshots for this file
        Self::prune_file_snapshots(file_path);

        // Best-effort cloud push (async, never blocks)
        let config = crate::config::ConfigManager::load();
        if config.sync_enabled && config.cloud_api_token.is_some() {
            use sha2::{Digest, Sha256};
            let mut hasher = Sha256::new();
            hasher.update(snapshot.content.as_bytes());
            let sha = format!("{:x}", hasher.finalize());
            let size = snapshot.content.len() as u64;
            let repo_full = git2::Repository::open(".").ok()
                .and_then(|r| r.find_remote("origin").ok().and_then(|rem| rem.url().map(String::from)));
            crate::sync::GlobalSync::push_snapshot(
                &snapshot.file_path,
                &sha,
                size,
                &snapshot.trigger,
                &snapshot.agent_id,
                repo_full.as_deref(),
            );
        }

        Ok(filename)
    }

    /// Snapshot a file that lives OUTSIDE the current working tree — e.g. inside
    /// a throwaway loop worktree that's about to be discarded — into a chosen
    /// repo's `.aura/snapshots/`. Reads `source` (any readable path) and writes
    /// the durable snapshot under `repo_root/.aura/snapshots/`, keyed by
    /// `logical_path` (the repo-relative path to recover to). Unlike
    /// [`Self::snapshot_file`], the read source and the write destination are
    /// decoupled, so a recovery snapshot survives the source worktree's deletion.
    /// Local-first: no cloud push (recovery is on this machine).
    pub fn snapshot_external(
        repo_root: &Path,
        source: &Path,
        logical_path: &str,
        trigger: &str,
        agent_id: &str,
    ) -> Result<String, String> {
        let dir = repo_root.join(".aura").join("snapshots");
        fs::create_dir_all(&dir)
            .map_err(|e| format!("Cannot create snapshot dir: {}", e))?;

        let content = fs::read_to_string(source)
            .map_err(|e| format!("Cannot snapshot {}: {}", source.display(), e))?;

        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;

        let snapshot = FileSnapshot {
            file_path: logical_path.to_string(),
            content,
            timestamp,
            trigger: trigger.to_string(),
            agent_id: agent_id.to_string(),
        };

        let safe_name = logical_path.replace('/', "__").replace('\\', "__");
        let filename = format!("{}__{}.json", safe_name, timestamp);
        let snap_path = dir.join(&filename);

        let json = serde_json::to_string(&snapshot)
            .map_err(|e| format!("Serialize error: {}", e))?;
        let tmp_path = dir.join(format!("{}.tmp", filename));
        fs::write(&tmp_path, &json).map_err(|e| format!("Write error: {}", e))?;
        fs::rename(&tmp_path, &snap_path).map_err(|e| format!("Rename error: {}", e))?;

        Ok(filename)
    }

    /// Get all snapshots for a specific file, sorted newest first
    pub fn get_snapshots_for_file(file_path: &str) -> Vec<FileSnapshot> {
        Self::ensure_dir();
        let safe_name = file_path.replace('/', "__").replace('\\', "__");

        let mut snapshots = Vec::new();
        if let Ok(entries) = fs::read_dir(Self::SNAPSHOT_DIR) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.starts_with(&safe_name) && name.ends_with(".json") {
                    if let Ok(content) = fs::read_to_string(entry.path()) {
                        if let Ok(snap) = serde_json::from_str::<FileSnapshot>(&content) {
                            snapshots.push(snap);
                        }
                    }
                }
            }
        }

        snapshots.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
        snapshots
    }

    /// Get all snapshots across all files, sorted newest first
    pub fn get_all_snapshots() -> Vec<FileSnapshot> {
        Self::ensure_dir();
        let mut snapshots = Vec::new();

        if let Ok(entries) = fs::read_dir(Self::SNAPSHOT_DIR) {
            for entry in entries.flatten() {
                if entry.path().extension().map(|e| e == "json").unwrap_or(false) {
                    if let Ok(content) = fs::read_to_string(entry.path()) {
                        if let Ok(snap) = serde_json::from_str::<FileSnapshot>(&content) {
                            snapshots.push(snap);
                        }
                    }
                }
            }
        }

        snapshots.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
        snapshots
    }

    /// Find the most recent snapshot of a file that contains a specific function/identifier
    pub fn find_snapshot_with_node(file_path: &str, identifier: &str) -> Option<FileSnapshot> {
        let snapshots = Self::get_snapshots_for_file(file_path);
        for snap in snapshots {
            // Quick check: does the snapshot content contain the identifier?
            if snap.content.contains(identifier) {
                return Some(snap);
            }
        }
        None
    }

    /// Prune old snapshots for a file, keeping only MAX_SNAPSHOTS_PER_FILE
    fn prune_file_snapshots(file_path: &str) {
        let safe_name = file_path.replace('/', "__").replace('\\', "__");
        let mut entries: Vec<_> = Vec::new();

        if let Ok(dir) = fs::read_dir(Self::SNAPSHOT_DIR) {
            for entry in dir.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.starts_with(&safe_name) && name.ends_with(".json") {
                    entries.push(entry.path());
                }
            }
        }

        if entries.len() > Self::MAX_SNAPSHOTS_PER_FILE {
            // Sort by name (which includes timestamp) — oldest first
            entries.sort();
            let to_remove = entries.len() - Self::MAX_SNAPSHOTS_PER_FILE;
            for path in entries.iter().take(to_remove) {
                let _ = fs::remove_file(path);
            }
        }
    }

    /// Global prune to keep total snapshots under MAX_TOTAL_SNAPSHOTS
    pub fn prune_global() {
        let mut entries: Vec<_> = Vec::new();

        if let Ok(dir) = fs::read_dir(Self::SNAPSHOT_DIR) {
            for entry in dir.flatten() {
                if entry.path().extension().map(|e| e == "json").unwrap_or(false) {
                    entries.push(entry.path());
                }
            }
        }

        if entries.len() > Self::MAX_TOTAL_SNAPSHOTS {
            entries.sort();
            let to_remove = entries.len() - Self::MAX_TOTAL_SNAPSHOTS;
            for path in entries.iter().take(to_remove) {
                let _ = fs::remove_file(path);
            }
        }
    }
}

pub struct CheckpointStore;

impl CheckpointStore {
    const NOTES_REF: &'static str = "refs/notes/aura";

    /// Save the checkpoint data locally in a temp file during pre-commit
    pub fn stage_checkpoint(data: &CheckpointData) -> Result<(), Box<dyn std::error::Error>> {
        let json = serde_json::to_string_pretty(data)?;
        fs::write(git_dir().join("AURA_CTX.json"), json)?;
        Ok(())
    }

    /// Read the staged checkpoint data
    pub fn read_staged() -> Result<Option<CheckpointData>, Box<dyn std::error::Error>> {
        let path = git_dir().join("AURA_CTX.json");
        if !path.exists() {
            return Ok(None);
        }
        let json = fs::read_to_string(&path)?;
        let data: CheckpointData = serde_json::from_str(&json)?;
        Ok(Some(data))
    }

    /// Clean up the staged checkpoint
    pub fn cleanup_staged() {
        let _ = fs::remove_file(git_dir().join("AURA_CTX.json"));
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

    /// Retrieve the checkpoint that best represents the code **at a given commit** —
    /// so a goal can be proven against the snapshot that session actually produced,
    /// not whatever branch happens to be checked out. Resolution order:
    ///   1. a checkpoint note attached directly to `commit_ish`,
    ///   2. else the nearest **descendant** commit that carries a note (the first
    ///      checkpoint taken *after* this commit — its tree is the closest superset
    ///      of this commit's code, so functions present here are present there),
    ///   3. else the nearest **ancestor** commit that carries a note (best-effort
    ///      fallback when nothing downstream was ever checkpointed).
    /// Returns `None` when the commit can't be resolved or no note exists anywhere
    /// reachable — the caller treats that as "can't tell", never "not reached".
    ///
    /// Why the descendant-first fallback matters: intent rows point at the commit a
    /// file was written on (e.g. the notes-store commit), but a checkpoint is only
    /// taken later, at a session-log commit downstream. That descendant checkpoint's
    /// full-tree AST still contains everything this commit introduced, so proving
    /// against it yields the honest verdict for the session's own code.
    pub fn get_checkpoint_for_commit(repo: &Repository, commit_ish: &str) -> Option<CheckpointData> {
        let target = repo
            .revparse_single(commit_ish)
            .ok()?
            .peel_to_commit()
            .ok()?
            .id();

        // 1. Direct hit — a note on this exact commit.
        if let Some(cp) = Self::note_checkpoint(repo, target) {
            return Some(cp);
        }

        let bearing = Self::checkpoint_bearing_commits(repo);

        // 2. Nearest DESCENDANT with a note (fewest commits ahead of target).
        let mut best_desc: Option<(usize, CheckpointData)> = None;
        for (oid, cp) in &bearing {
            if *oid == target {
                return Some(cp.clone());
            }
            if repo.graph_descendant_of(*oid, target).unwrap_or(false) {
                let ahead = repo
                    .graph_ahead_behind(*oid, target)
                    .map(|(a, _)| a)
                    .unwrap_or(usize::MAX);
                if best_desc.as_ref().map_or(true, |(b, _)| ahead < *b) {
                    best_desc = Some((ahead, cp.clone()));
                }
            }
        }
        if let Some((_, cp)) = best_desc {
            return Some(cp);
        }

        // 3. Nearest ANCESTOR with a note (fewest commits behind target).
        let mut best_anc: Option<(usize, CheckpointData)> = None;
        for (oid, cp) in &bearing {
            if repo.graph_descendant_of(target, *oid).unwrap_or(false) {
                let behind = repo
                    .graph_ahead_behind(target, *oid)
                    .map(|(a, _)| a)
                    .unwrap_or(usize::MAX);
                if best_anc.as_ref().map_or(true, |(b, _)| behind < *b) {
                    best_anc = Some((behind, cp.clone()));
                }
            }
        }
        best_anc.map(|(_, cp)| cp)
    }

    /// Decode the checkpoint note attached to a single commit, if any.
    fn note_checkpoint(repo: &Repository, commit: git2::Oid) -> Option<CheckpointData> {
        let note = repo.find_note(Some(Self::NOTES_REF), commit).ok()?;
        let msg = note.message()?;
        serde_json::from_str::<CheckpointData>(msg).ok()
    }

    /// Every commit that carries an Aura checkpoint note, paired with its decoded
    /// checkpoint. Walks `refs/notes/aura`; each entry is (annotated_commit, data).
    fn checkpoint_bearing_commits(repo: &Repository) -> Vec<(git2::Oid, CheckpointData)> {
        let mut out = Vec::new();
        if let Ok(notes) = repo.notes(Some(Self::NOTES_REF)) {
            for entry in notes.flatten() {
                // entry = (note_blob_oid, annotated_commit_oid)
                if let Some(cp) = Self::note_checkpoint(repo, entry.1) {
                    out.push((entry.1, cp));
                }
            }
        }
        out
    }

    /// Semantic Compaction: prune old git notes, keeping the last N checkpoints.
    /// Shadow branch is unaffected (it's the permanent archive).
    pub fn compact_history(repo: &Repository, keep: usize) -> Result<usize, Box<dyn std::error::Error>> {
        let mut checkpoints = Self::get_all_checkpoints(repo)?;
        if checkpoints.len() <= keep {
            return Ok(0);
        }

        // Sort newest first (already sorted), remove old ones from notes
        let to_remove = checkpoints.split_off(keep);
        let mut pruned = 0;

        // Walk all commits and remove notes for old checkpoints
        let notes_ref = match repo.find_reference(Self::NOTES_REF) {
            Ok(r) => r,
            Err(_) => return Ok(0),
        };
        let sig = Signature::now("Aura Agent", "ai@aura.vcs")?;

        let mut revwalk = repo.revwalk()?;
        revwalk.push_head()?;

        for oid in revwalk.take(200) {
            let oid = match oid { Ok(o) => o, Err(_) => continue };
            if let Ok(note) = repo.find_note(Some(Self::NOTES_REF), oid) {
                let note_text = note.message().unwrap_or("");
                // Check if this note belongs to a checkpoint we want to remove
                let should_remove = to_remove.iter().any(|cp| note_text.contains(&cp.id));
                if should_remove {
                    let _ = repo.note_delete(oid, Some(Self::NOTES_REF), &sig, &sig);
                    pruned += 1;
                }
            }
        }

        Ok(pruned)
    }

    // ── Shadow Branch: durable checkpoint storage that survives rebase/stash/pull ──

    const SHADOW_BRANCH: &'static str = "aura/checkpoints";
    /// Shadow session dir lives under the per-worktree gitdir so each
    /// worktree tracks its own base commit independently.
    fn shadow_session_dir() -> PathBuf {
        git_dir().join("aura-sessions")
    }

    /// Condense checkpoint + session data onto the shadow orphan branch.
    /// Called after persist-checkpoint to make data rebase-proof.
    ///
    /// Storage layout (256-shard, multi-session per checkpoint):
    ///   <id[0..2]>/<id[2..]>/
    ///     metadata.json          — aggregated checkpoint summary
    ///     <session_count>/       — numbered subfolder per session (0, 1, 2, ...)
    ///       checkpoint.json      — full checkpoint data
    ///       session.json         — session metadata
    ///       transcript.jsonl     — conversation transcript
    pub fn condense_to_shadow(repo: &Repository, data: &CheckpointData, session_json: Option<&str>) -> Result<(), Box<dyn std::error::Error>> {
        let sig = Signature::now("Aura Agent", "ai@aura.vcs")?;

        // Shard by checkpoint ID: first 2 chars / rest (256 shards)
        let shard = &data.id[..2];
        let rest = &data.id[2..];

        // Get existing shadow tree or start empty
        let parent = repo.find_reference(&format!("refs/heads/{}", Self::SHADOW_BRANCH))
            .ok()
            .and_then(|r| r.peel_to_commit().ok());

        let mut tb = repo.treebuilder(parent.as_ref().and_then(|c| c.tree().ok()).as_ref())?;

        // Get or create shard tree
        let existing_shard = parent.as_ref()
            .and_then(|c| c.tree().ok())
            .and_then(|t| t.get_name(shard).map(|e| e.id()));
        let mut shard_tb = if let Some(shard_oid) = existing_shard {
            let shard_tree = repo.find_tree(shard_oid)?;
            repo.treebuilder(Some(&shard_tree))?
        } else {
            repo.treebuilder(None)?
        };

        // Determine session number: count existing numbered subfolders in this checkpoint
        let existing_cp = existing_shard
            .and_then(|sid| repo.find_tree(sid).ok())
            .and_then(|st| st.get_name(rest).map(|e| e.id()))
            .and_then(|cid| repo.find_tree(cid).ok());

        let session_num = if let Some(ref cp_tree) = existing_cp {
            // Count existing numbered session subfolders
            cp_tree.iter()
                .filter(|e| e.kind() == Some(git2::ObjectType::Tree))
                .filter(|e| e.name().map(|n| n.parse::<u32>().is_ok()).unwrap_or(false))
                .count() as u32
        } else {
            0
        };

        // Build session subfolder: <session_num>/<files>
        let mut sess_tb = repo.treebuilder(None)?;

        let checkpoint_blob = serde_json::to_string_pretty(data)?;
        let blob_oid = repo.blob(checkpoint_blob.as_bytes())?;
        sess_tb.insert("checkpoint.json", blob_oid, 0o100644)?;

        if let Some(sess) = session_json {
            let sess_blob = repo.blob(sess.as_bytes())?;
            sess_tb.insert("session.json", sess_blob, 0o100644)?;
        }

        // Find and attach transcript from any matching session
        let _ = fs::create_dir_all(".aura/transcripts");
        if let Ok(entries) = fs::read_dir(".aura/transcripts") {
            // Get the most recent transcript file
            let mut latest: Option<(std::time::SystemTime, std::path::PathBuf)> = None;
            for entry in entries.flatten() {
                if entry.path().extension().map(|e| e == "jsonl").unwrap_or(false) {
                    if let Ok(meta) = entry.metadata() {
                        if let Ok(modified) = meta.modified() {
                            if latest.as_ref().map(|(t, _)| modified > *t).unwrap_or(true) {
                                latest = Some((modified, entry.path()));
                            }
                        }
                    }
                }
            }
            if let Some((_, path)) = latest {
                if let Ok(transcript) = fs::read_to_string(&path) {
                    if !transcript.is_empty() {
                        let t_blob = repo.blob(transcript.as_bytes())?;
                        sess_tb.insert("transcript.jsonl", t_blob, 0o100644)?;
                    }
                }
            }
        }

        let sess_tree_oid = sess_tb.write()?;

        // Build the checkpoint subtree with existing sessions + new one
        let mut cp_tb = if let Some(ref cp_tree) = existing_cp {
            repo.treebuilder(Some(cp_tree))?
        } else {
            repo.treebuilder(None)?
        };

        cp_tb.insert(&session_num.to_string(), sess_tree_oid, 0o040000)?;

        // Write aggregated metadata
        let metadata = serde_json::json!({
            "checkpoint_id": data.id,
            "agent_id": data.agent_id,
            "session_count": session_num + 1,
            "latest_timestamp": data.timestamp,
            "ast_node_count": data.ast_nodes.len(),
        });
        let meta_blob = repo.blob(metadata.to_string().as_bytes())?;
        cp_tb.insert("metadata.json", meta_blob, 0o100644)?;

        let cp_tree_oid = cp_tb.write()?;
        shard_tb.insert(rest, cp_tree_oid, 0o040000)?;
        let shard_tree_oid = shard_tb.write()?;
        tb.insert(shard, shard_tree_oid, 0o040000)?;

        let tree_oid = tb.write()?;
        let tree = repo.find_tree(tree_oid)?;

        // Commit onto the shadow branch
        let msg = format!("aura: checkpoint {} (session {})", &data.id[..8], session_num);
        if let Some(ref parent_commit) = parent {
            repo.commit(
                Some(&format!("refs/heads/{}", Self::SHADOW_BRANCH)),
                &sig, &sig, &msg, &tree, &[parent_commit],
            )?;
        } else {
            repo.commit(
                Some(&format!("refs/heads/{}", Self::SHADOW_BRANCH)),
                &sig, &sig, &msg, &tree, &[],
            )?;
        }

        Ok(())
    }

    /// Migrate shadow branch when HEAD changes (after rebase/pull/stash-apply).
    /// Reads stored base_commit from session state and compares with current HEAD.
    /// If they differ, renames the shadow branch reference.
    pub fn migrate_shadow_if_needed(repo: &Repository) -> Result<bool, Box<dyn std::error::Error>> {
        let session_dir = Self::shadow_session_dir();
        let _ = fs::create_dir_all(&session_dir);

        let state_path = session_dir.join("base_commit.txt");
        let current_head = repo.head()
            .ok()
            .and_then(|h| h.peel_to_commit().ok())
            .map(|c| c.id().to_string()[..7].to_string());

        let current_head = match current_head {
            Some(h) => h,
            None => return Ok(false),
        };

        if let Ok(stored) = fs::read_to_string(&state_path) {
            let stored = stored.trim().to_string();
            if stored != current_head && !stored.is_empty() {
                // HEAD changed — rebase/pull happened
                // The shadow branch data is still valid, just update the stored base
                fs::write(&state_path, &current_head)?;
                return Ok(true); // Signal that migration occurred
            }
        }

        // Store current HEAD for future comparisons
        fs::write(&state_path, &current_head)?;
        Ok(false)
    }

    /// Retrieve checkpoints from the shadow branch (survives rebase)
    pub fn get_shadow_checkpoints(repo: &Repository) -> Result<Vec<CheckpointData>, Box<dyn std::error::Error>> {
        let mut checkpoints = Vec::new();

        let shadow_ref = match repo.find_reference(&format!("refs/heads/{}", Self::SHADOW_BRANCH)) {
            Ok(r) => r,
            Err(_) => return Ok(checkpoints),
        };

        let commit = shadow_ref.peel_to_commit()?;
        let root_tree = commit.tree()?;

        // Walk shard/rest/<session_num>/checkpoint.json (multi-session layout)
        for shard_entry in root_tree.iter() {
            if shard_entry.kind() != Some(git2::ObjectType::Tree) { continue; }
            let shard_tree = repo.find_tree(shard_entry.id())?;
            for cp_entry in shard_tree.iter() {
                if cp_entry.kind() != Some(git2::ObjectType::Tree) { continue; }
                let cp_tree = repo.find_tree(cp_entry.id())?;
                // Look inside numbered session subfolders
                for sess_entry in cp_tree.iter() {
                    if sess_entry.kind() != Some(git2::ObjectType::Tree) { continue; }
                    if let Ok(sess_tree) = repo.find_tree(sess_entry.id()) {
                        if let Some(blob_entry) = sess_tree.get_name("checkpoint.json") {
                            let obj = blob_entry.to_object(repo)?;
                            if let Some(blob) = obj.as_blob() {
                                if let Ok(json) = std::str::from_utf8(blob.content()) {
                                    if let Ok(data) = serde_json::from_str::<CheckpointData>(json) {
                                        checkpoints.push(data);
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        checkpoints.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
        Ok(checkpoints)
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
