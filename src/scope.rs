// Canonical scope manifest — AUDIT-CAP-01.
//
// One versioned identity envelope shared by every event family (session,
// intent, usage, memory, checkpoint) and every surface (CLI, desktop, cloud,
// console). An event carries WHERE it happened explicitly — immutable
// repository ID, checkout (worktree) ID, session, checkpoint lineage, agent
// and transcript cursor — instead of being inferred from whatever repo or
// agent happens to be globally active at read time.
//
// The contamination this kills: an event written with no discoverable repo
// used to fall back to `./.aura/…` and silently attach to whatever project
// the process was started from. Under this module such an event is
// QUARANTINED (to `~/.aura/quarantine/events.jsonl`, or the repo-local
// quarantine when the repo is known but the scope is ambiguous) and never
// attributed to another project.
//
// Schema versioning: `scope_version` on every stamp. Version 1 is the
// current schema; version 0 marks a legacy row migrated in place (it had no
// scope when written, and no scope will be invented for it).

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// Current scope schema version. Bump only with a migration.
pub const SCOPE_SCHEMA_VERSION: u32 = 1;

/// Durable, immutable repository identity. Lives in `.aura/identity.json`,
/// written exactly once; every later read returns the stored value verbatim
/// (even if the derivation inputs — e.g. the root commit — later change).
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct RepoIdentity {
    /// `rid-<16 hex>` — sha256 of the root commit when history exists at
    /// creation time (stable across clones), else a random UUID (stable for
    /// the life of the checkout family via the committed identity file).
    pub repo_id: String,
    /// How the id was derived: "root-commit" | "random".
    pub derived_from: String,
    /// Root commit sha at creation time, when one existed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root_commit: Option<String>,
    pub created_at: u64,
}

/// The manifest itself — the envelope stamped onto events as `"scope": {…}`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct ScopeManifest {
    pub scope_version: u32,
    /// Immutable repository ID (see [`RepoIdentity`]).
    pub repo_id: String,
    /// This checkout/worktree — distinct per worktree of the same repo.
    pub checkout_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// Checkpoint the event happened under (staged or latest durable).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checkpoint_id: Option<String>,
    /// That checkpoint's parent, when known — gives events a lineage.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_checkpoint: Option<String>,
    /// Who produced the event (agent id or "user").
    pub agent: String,
    /// Position in the agent transcript at stamp time, when the harness
    /// exports one (AURA_TRANSCRIPT_CURSOR).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transcript_cursor: Option<u64>,
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn short_hex(input: &str, len: usize) -> String {
    let mut h = Sha256::new();
    h.update(input.as_bytes());
    hex::encode(h.finalize())[..len].to_string()
}

/// Read-or-create the immutable repo identity. Read-first: an existing
/// `.aura/identity.json` is NEVER regenerated or rewritten, so the id
/// survives history rewrites, re-clones (the file is meant to be committed)
/// and identity-derivation changes in later Aura versions.
pub fn repo_identity(repo_root: &Path) -> std::io::Result<RepoIdentity> {
    let path = repo_root.join(".aura").join("identity.json");
    if let Ok(raw) = fs::read_to_string(&path) {
        if let Ok(existing) = serde_json::from_str::<RepoIdentity>(&raw) {
            return Ok(existing);
        }
        // Corrupt identity file: do NOT clobber it — that would mint a new
        // repo_id and split history. Surface the error instead.
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("{} exists but does not parse; refusing to regenerate repo_id", path.display()),
        ));
    }

    // Mint only inside a repo that OPTED IN to Aura (`.aura/` exists) —
    // establishing identity must never be the thing that scaffolds `.aura`
    // into a repo that never asked for it.
    if !repo_root.join(".aura").is_dir() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            format!("{} has no .aura directory — repo has not opted into Aura", repo_root.display()),
        ));
    }
    let (seed, derived_from, root_commit) = match root_commit_sha(repo_root) {
        Some(sha) => (sha.clone(), "root-commit".to_string(), Some(sha)),
        None => (uuid::Uuid::new_v4().to_string(), "random".to_string(), None),
    };
    let identity = RepoIdentity {
        repo_id: format!("rid-{}", short_hex(&seed, 16)),
        derived_from,
        root_commit,
        created_at: now_secs(),
    };
    fs::write(&path, serde_json::to_string_pretty(&identity)?)?;
    Ok(identity)
}

/// First commit reachable from HEAD (topological order, reversed), if any.
fn root_commit_sha(repo_root: &Path) -> Option<String> {
    let repo = git2::Repository::open(repo_root).ok()?;
    let mut walk = repo.revwalk().ok()?;
    walk.push_head().ok()?;
    walk.set_sorting(git2::Sort::TOPOLOGICAL | git2::Sort::REVERSE).ok()?;
    walk.next()?.ok().map(|oid| oid.to_string())
}

/// Stable id for THIS checkout — two worktrees of the same repo get
/// different ids, the same worktree gets the same id every time.
pub fn checkout_id(repo_root: &Path) -> String {
    let canon = repo_root
        .canonicalize()
        .unwrap_or_else(|_| repo_root.to_path_buf());
    format!("wtr-{}", short_hex(&canon.to_string_lossy(), 12))
}

impl ScopeManifest {
    /// Build the manifest for an event happening now in `repo_root`.
    ///
    /// `session_id`: pass the caller's session when it has one; falls back to
    /// `AURA_SESSION_ID`. Checkpoint context comes from the cheap staged
    /// checkpoint file (`.git/AURA_CTX.json`) when present — callers on the
    /// checkpoint path itself should override via [`Self::with_checkpoint`].
    ///
    /// Errors when the repository identity cannot be established — the
    /// caller must then QUARANTINE the event, not attach it anywhere.
    pub fn capture(
        repo_root: &Path,
        agent: &str,
        session_id: Option<&str>,
    ) -> Result<ScopeManifest, String> {
        let identity = repo_identity(repo_root).map_err(|e| e.to_string())?;
        let session = session_id
            .map(str::to_string)
            .or_else(|| std::env::var("AURA_SESSION_ID").ok().filter(|s| !s.is_empty()));
        let transcript_cursor = std::env::var("AURA_TRANSCRIPT_CURSOR")
            .ok()
            .and_then(|v| v.parse::<u64>().ok());
        Ok(ScopeManifest {
            scope_version: SCOPE_SCHEMA_VERSION,
            repo_id: identity.repo_id,
            checkout_id: checkout_id(repo_root),
            session_id: session,
            checkpoint_id: staged_checkpoint_id(repo_root),
            parent_checkpoint: None,
            agent: agent.to_string(),
            transcript_cursor,
        })
    }

    pub fn with_checkpoint(mut self, id: Option<String>, parent: Option<String>) -> Self {
        self.checkpoint_id = id;
        self.parent_checkpoint = parent;
        self
    }

    /// Schema validation. Every NEW event must pass before it is attached to
    /// a store; failures list every violated rule.
    pub fn validate(&self) -> Result<(), Vec<String>> {
        let mut problems = Vec::new();
        if self.scope_version == 0 || self.scope_version > SCOPE_SCHEMA_VERSION {
            problems.push(format!(
                "scope_version {} outside supported range 1..={}",
                self.scope_version, SCOPE_SCHEMA_VERSION
            ));
        }
        if !self.repo_id.starts_with("rid-") || self.repo_id.len() < 8 {
            problems.push(format!("repo_id '{}' is not a canonical rid-<hex> id", self.repo_id));
        }
        if !self.checkout_id.starts_with("wtr-") || self.checkout_id.len() < 8 {
            problems.push(format!("checkout_id '{}' is not a canonical wtr-<hex> id", self.checkout_id));
        }
        if self.agent.trim().is_empty() {
            problems.push("agent is empty".to_string());
        }
        if problems.is_empty() { Ok(()) } else { Err(problems) }
    }

    /// Stamp this manifest onto a JSON event as `"scope"`.
    pub fn stamp(&self, event: &mut serde_json::Value) {
        if let Ok(scope) = serde_json::to_value(self) {
            event["scope"] = scope;
        }
    }
}

/// Cheap read of the currently STAGED checkpoint id (`.git/AURA_CTX.json`),
/// if one exists — avoids a git-notes walk on hot fire-and-forget paths.
fn staged_checkpoint_id(repo_root: &Path) -> Option<String> {
    let repo = git2::Repository::open(repo_root).ok()?;
    let raw = fs::read_to_string(repo.path().join("AURA_CTX.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    v.get("id").and_then(|i| i.as_str()).map(str::to_string)
}

/// Where quarantined events go when the repo IS known but the scope is
/// ambiguous/invalid.
pub fn repo_quarantine_path(repo_root: &Path) -> PathBuf {
    repo_root.join(".aura").join("quarantine").join("events.jsonl")
}

/// Where quarantined events go when there is NO discoverable repository —
/// the case that used to scaffold `./.aura` into arbitrary directories and
/// attach the event to whatever project the process started from.
pub fn global_quarantine_path() -> PathBuf {
    let home = std::env::var("AURA_HOME_DIR")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join(".aura").join("quarantine").join("events.jsonl")
}

/// Append an event that could not be scoped. Returns the quarantine file it
/// landed in. Never attaches the event to any project store.
pub fn quarantine_event(
    repo_root: Option<&Path>,
    kind: &str,
    reason: &str,
    event: &serde_json::Value,
) -> std::io::Result<PathBuf> {
    let path = match repo_root {
        Some(root) => repo_quarantine_path(root),
        None => global_quarantine_path(),
    };
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let row = serde_json::json!({
        "quarantined_at": now_secs(),
        "kind": kind,
        "reason": reason,
        "event": event,
    });
    let mut f = fs::OpenOptions::new().create(true).append(true).open(&path)?;
    writeln!(f, "{}", row)?;
    Ok(path)
}

/// Validate-or-quarantine gate for JSON-row event families (intent log).
/// On a valid manifest the event is stamped and `Ok(())` returned; anything
/// else quarantines the event and returns `Err(reason)` — the caller MUST
/// NOT write the event to its store in that case.
pub fn stamp_or_quarantine(
    repo_root: &Path,
    kind: &str,
    agent: &str,
    session_id: Option<&str>,
    event: &mut serde_json::Value,
) -> Result<(), String> {
    match ScopeManifest::capture(repo_root, agent, session_id) {
        Ok(manifest) => match manifest.validate() {
            Ok(()) => {
                manifest.stamp(event);
                Ok(())
            }
            Err(problems) => {
                let reason = format!("invalid scope: {}", problems.join("; "));
                let _ = quarantine_event(Some(repo_root), kind, &reason, event);
                Err(reason)
            }
        },
        Err(e) => {
            let reason = format!("no scope: {}", e);
            let _ = quarantine_event(Some(repo_root), kind, &reason, event);
            Err(reason)
        }
    }
}

/// Best-effort scope for typed structs (sessions, checkpoints, memory,
/// usage) that always live inside a known repo store: returns the stamped
/// JSON value, or `None` when identity can't be established (the struct is
/// then written without a scope claim rather than a wrong one — and the
/// failure is recorded in quarantine for the doctor to surface).
pub fn scope_value(repo_root: &Path, agent: &str, session_id: Option<&str>) -> Option<serde_json::Value> {
    match ScopeManifest::capture(repo_root, agent, session_id) {
        Ok(m) if m.validate().is_ok() => serde_json::to_value(&m).ok(),
        Ok(m) => {
            let _ = quarantine_event(
                Some(repo_root),
                "scope-invalid",
                &format!("invalid scope for {} event", agent),
                &serde_json::to_value(&m).unwrap_or_default(),
            );
            None
        }
        Err(_) => None,
    }
}

/// Migration for rows written before this schema existed: mark them
/// `scope_version: 0` in place. No identity is invented for them — a legacy
/// row states honestly that its scope was never recorded.
pub fn migrate_legacy(event: &mut serde_json::Value) -> bool {
    if event.get("scope").is_some() {
        return false;
    }
    event["scope"] = serde_json::json!({ "scope_version": 0, "legacy": true });
    true
}

/// Migrate a JSONL file in place (used by `aura scope --migrate`): every row
/// without a scope gets the v0 legacy marker. Returns (total, migrated).
pub fn migrate_jsonl(path: &Path) -> std::io::Result<(usize, usize)> {
    let raw = match fs::read_to_string(path) {
        Ok(r) => r,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok((0, 0)),
        Err(e) => return Err(e),
    };
    let mut total = 0usize;
    let mut migrated = 0usize;
    let mut out = String::with_capacity(raw.len());
    for line in raw.lines() {
        if line.trim().is_empty() {
            continue;
        }
        total += 1;
        match serde_json::from_str::<serde_json::Value>(line) {
            Ok(mut v) => {
                if migrate_legacy(&mut v) {
                    migrated += 1;
                }
                out.push_str(&v.to_string());
            }
            // Unparseable rows pass through untouched — migration must never
            // destroy data it does not understand.
            Err(_) => out.push_str(line),
        }
        out.push('\n');
    }
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    let mut tmp = tempfile::NamedTempFile::new_in(dir)?;
    tmp.write_all(out.as_bytes())?;
    tmp.persist(path).map_err(|e| e.error)?;
    Ok((total, migrated))
}

/// The machine-readable schema contract, printed by `aura scope --schema`
/// for desktop/cloud/console consumers.
pub fn schema_json() -> serde_json::Value {
    serde_json::json!({
        "$id": "aura://schema/scope-manifest",
        "version": SCOPE_SCHEMA_VERSION,
        "type": "object",
        "required": ["scope_version", "repo_id", "checkout_id", "agent"],
        "properties": {
            "scope_version": { "type": "integer", "minimum": 0, "maximum": SCOPE_SCHEMA_VERSION,
                "description": "0 = legacy row migrated without recorded scope; 1 = current schema" },
            "repo_id": { "type": "string", "pattern": "^rid-[0-9a-f]{16}$",
                "description": "Immutable repository id from .aura/identity.json" },
            "checkout_id": { "type": "string", "pattern": "^wtr-[0-9a-f]{12}$",
                "description": "This worktree/checkout" },
            "session_id": { "type": ["string", "null"] },
            "checkpoint_id": { "type": ["string", "null"] },
            "parent_checkpoint": { "type": ["string", "null"] },
            "agent": { "type": "string", "minLength": 1 },
            "transcript_cursor": { "type": ["integer", "null"] }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch_repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("tempdir");
        git2::Repository::init(dir.path()).expect("git init");
        // Opt the repo into Aura — identity minting requires it.
        fs::create_dir_all(dir.path().join(".aura")).expect("mk .aura");
        dir
    }

    #[test]
    fn identity_never_minted_in_a_repo_that_did_not_opt_in() {
        let dir = tempfile::tempdir().unwrap();
        git2::Repository::init(dir.path()).unwrap();
        assert!(repo_identity(dir.path()).is_err());
        assert!(
            !dir.path().join(".aura").exists(),
            "identity minting must not scaffold .aura"
        );
    }

    #[test]
    fn repo_identity_is_created_once_and_immutable() {
        let dir = scratch_repo();
        let first = repo_identity(dir.path()).expect("create identity");
        assert!(first.repo_id.starts_with("rid-"), "canonical prefix");
        // A second read returns the SAME id even though a commit now exists
        // (derivation inputs changed — the stored identity must not).
        std::fs::write(dir.path().join("f.txt"), "x").unwrap();
        let repo = git2::Repository::open(dir.path()).unwrap();
        let mut idx = repo.index().unwrap();
        idx.add_path(Path::new("f.txt")).unwrap();
        idx.write().unwrap();
        let tree = repo.find_tree(idx.write_tree().unwrap()).unwrap();
        let sig = git2::Signature::now("t", "t@t").unwrap();
        repo.commit(Some("HEAD"), &sig, &sig, "root", &tree, &[]).unwrap();
        let second = repo_identity(dir.path()).expect("reread identity");
        assert_eq!(first.repo_id, second.repo_id);
        assert_eq!(second.derived_from, "random", "pre-commit derivation survives");
    }

    #[test]
    fn corrupt_identity_file_is_never_clobbered() {
        let dir = scratch_repo();
        fs::create_dir_all(dir.path().join(".aura")).unwrap();
        fs::write(dir.path().join(".aura/identity.json"), "{not json").unwrap();
        assert!(repo_identity(dir.path()).is_err());
        assert_eq!(
            fs::read_to_string(dir.path().join(".aura/identity.json")).unwrap(),
            "{not json",
            "corrupt file left intact for a human"
        );
    }

    #[test]
    fn checkout_ids_differ_per_worktree_and_are_stable() {
        let a = scratch_repo();
        let b = scratch_repo();
        assert_ne!(checkout_id(a.path()), checkout_id(b.path()));
        assert_eq!(checkout_id(a.path()), checkout_id(a.path()));
        assert!(checkout_id(a.path()).starts_with("wtr-"));
    }

    #[test]
    fn capture_validate_stamp_roundtrip() {
        let dir = scratch_repo();
        let m = ScopeManifest::capture(dir.path(), "claude", Some("sess-1")).expect("capture");
        m.validate().expect("valid");
        let mut event = serde_json::json!({ "intent": "test" });
        m.stamp(&mut event);
        let scope = &event["scope"];
        assert_eq!(scope["scope_version"], SCOPE_SCHEMA_VERSION);
        assert_eq!(scope["session_id"], "sess-1");
        assert_eq!(scope["agent"], "claude");
        let back: ScopeManifest = serde_json::from_value(scope.clone()).expect("deserialize");
        assert_eq!(back, m);
    }

    #[test]
    fn validation_rejects_legacy_and_malformed_scopes() {
        let dir = scratch_repo();
        let good = ScopeManifest::capture(dir.path(), "claude", None).unwrap();

        let mut v0 = good.clone();
        v0.scope_version = 0;
        assert!(v0.validate().is_err(), "v0 is a migration marker, not a valid new event scope");

        let mut future = good.clone();
        future.scope_version = SCOPE_SCHEMA_VERSION + 1;
        assert!(future.validate().is_err());

        let mut bad_repo = good.clone();
        bad_repo.repo_id = "my-project".into();
        assert!(bad_repo.validate().is_err());

        let mut no_agent = good;
        no_agent.agent = "  ".into();
        assert!(no_agent.validate().is_err());
    }

    #[test]
    fn stamp_or_quarantine_quarantines_instead_of_attaching() {
        let dir = scratch_repo();
        // Corrupt identity → capture fails → the event must land in
        // quarantine and the gate must refuse the write.
        fs::create_dir_all(dir.path().join(".aura")).unwrap();
        fs::write(dir.path().join(".aura/identity.json"), "{broken").unwrap();
        let mut event = serde_json::json!({ "intent": "orphan" });
        let res = stamp_or_quarantine(dir.path(), "intent", "claude", None, &mut event);
        assert!(res.is_err());
        assert!(event.get("scope").is_none(), "no scope invented");
        let q = fs::read_to_string(repo_quarantine_path(dir.path())).expect("quarantine written");
        assert!(q.contains("\"orphan\""));
        assert!(q.contains("\"kind\":\"intent\""));
    }

    #[test]
    fn global_quarantine_used_when_no_repo() {
        let fake_home = tempfile::tempdir().unwrap();
        unsafe { std::env::set_var("AURA_HOME_DIR", fake_home.path()) };
        let event = serde_json::json!({ "intent": "nowhere" });
        let path = quarantine_event(None, "intent", "no repository discovered", &event).unwrap();
        unsafe { std::env::remove_var("AURA_HOME_DIR") };
        assert!(path.starts_with(fake_home.path()));
        let q = fs::read_to_string(&path).unwrap();
        assert!(q.contains("no repository discovered"));
    }

    #[test]
    fn migrate_legacy_marks_v0_and_is_idempotent() {
        let mut old_row = serde_json::json!({ "intent": "pre-schema row" });
        assert!(migrate_legacy(&mut old_row));
        assert_eq!(old_row["scope"]["scope_version"], 0);
        assert!(!migrate_legacy(&mut old_row), "second pass is a no-op");
    }

    #[test]
    fn migrate_jsonl_stamps_only_unscoped_rows_and_keeps_garbage() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("log.jsonl");
        fs::write(
            &path,
            "{\"intent\":\"old\"}\nnot json at all\n{\"intent\":\"new\",\"scope\":{\"scope_version\":1}}\n",
        )
        .unwrap();
        let (total, migrated) = migrate_jsonl(&path).unwrap();
        assert_eq!((total, migrated), (3, 1));
        let out = fs::read_to_string(&path).unwrap();
        assert!(out.contains("not json at all"), "unparseable rows preserved");
        let first: serde_json::Value = serde_json::from_str(out.lines().next().unwrap()).unwrap();
        assert_eq!(first["scope"]["scope_version"], 0);
    }

    #[test]
    fn staged_checkpoint_id_read_when_present() {
        let dir = scratch_repo();
        let repo = git2::Repository::open(dir.path()).unwrap();
        fs::write(repo.path().join("AURA_CTX.json"), "{\"id\":\"ckpt-42\"}").unwrap();
        let m = ScopeManifest::capture(dir.path(), "claude", None).unwrap();
        assert_eq!(m.checkpoint_id.as_deref(), Some("ckpt-42"));
    }
}
