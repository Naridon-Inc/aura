// M4 — sovereign substrate: a portable, signed "meaning bundle".
//
// `aura bundle export` packs the repo's MEANING — its intent log, its
// goal ledger, and the commit list those attach to — into ONE signed
// JSON file. `aura bundle import` verifies that file's Ed25519 signature
// OFFLINE (the signer's public key travels inside the bundle) and, with
// `--apply`, merge-appends the meaning into the local clone.
//
// ── Why a bundle at all ─────────────────────────────────────────────────
// Aura already mirrors intent onto `refs/notes/aura-intent` and signs
// branch tips onto `refs/notes/aura-sigs` (see `meta_refs.rs` /
// `refs_sign.rs`) — but SOME hosts strip or refuse `refs/notes/*` on
// push/fetch. The bundle is the belt-and-suspenders: it round-trips the
// SOURCE meaning files (`.aura/intent_log.jsonl`, `.aura/goals.jsonl`)
// directly, as a single artifact you can email, attach to a release, or
// drop into any clone on any forge — and verify with no network.
//
// The competitive edge vs host-locked meaning (Cursor Origin): Aura's
// intent + proof travel as a self-certifying file, not a row in someone
// else's database.
//
// ── Signing contract (must match across export/import) ──────────────────
// We reuse the SAME repo-local Ed25519 identity that signs radar events
// and `aura refs sign` endorsements: `refs_sign::load_repo_identity`.
// The signature covers the canonical JSON of the WHOLE bundle with
// `signature_hex` blanked to "" (see `canonical_unsigned_bytes`): set the
// field empty, serialize deterministically, sign those exact bytes, then
// fill the field in. Import reproduces the same bytes and verifies the
// embedded pubkey, so verification needs nothing but the file itself.
//
// Identity machinery (key load, sign, verify, pubkey bytes) is REUSED
// from `aura_attestation` / `refs_sign` — this module never reimplements
// any crypto primitive.

use clap::Subcommand;
use colored::Colorize;
use git2::Repository;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use aura_attestation::{SignatureBytes, VerifyingKey};

use crate::goals::model::GoalRecord;
use crate::intent_query::{read_all_rows, IntentRow};

/// Default artifact name when `--output` is omitted.
pub const DEFAULT_OUTPUT: &str = "aura-meaning-bundle.json";

/// Hard cap on the commit list so a deep history never blows the bundle
/// up. The meaning files (intent + goals) are always carried whole; only
/// the commit *manifest* is capped.
pub const COMMIT_CAP: usize = 500;

// ───────────────────────── bundle shape ─────────────────────────

/// A commit in the bundle's manifest: the SHA the meaning attaches to and
/// its one-line summary, so an importer can show "what shipped" without
/// the original history.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BundleCommit {
    pub sha: String,
    pub summary: String,
}

/// One intent row, mirrored into the bundle. We keep our OWN serializable
/// mirror (rather than `IntentRow`, which is a query-time normalized form
/// without Serialize) so the field set is explicit and stable on the wire
/// and matches the `.aura/intent_log.jsonl` line shape closely enough to
/// re-emit when applying.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BundleIntent {
    pub timestamp: u64,
    pub agent_id: String,
    pub intent: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub intent_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signed_block_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_id: Option<String>,
}

impl BundleIntent {
    fn from_row(r: &IntentRow) -> Self {
        Self {
            timestamp: r.timestamp,
            agent_id: r.agent_id.clone(),
            intent: r.intent.clone(),
            intent_type: r.intent_type.clone(),
            signed_block_id: r.signed_block_id.clone(),
            key_id: r.key_id.clone(),
        }
    }

    /// Re-emit as the EXACT JSONL line shape the intent log uses, so an
    /// applied row is byte-identical to a natively-logged one and the
    /// dedupe (exact-line) is meaningful. `IntentRow::to_json` is the
    /// canonical shape (`intent_query.rs`); we round-trip through it.
    fn to_log_line(&self) -> String {
        let row = IntentRow {
            timestamp: self.timestamp,
            agent_id: self.agent_id.clone(),
            intent: self.intent.clone(),
            intent_type: self.intent_type.clone(),
            signed_block_id: self.signed_block_id.clone(),
            key_id: self.key_id.clone(),
        };
        // serde_json on a serde_json::Value is deterministic for object
        // key order (it preserves insertion order via the map impl used
        // here), and to_json builds the keys in a fixed order.
        serde_json::to_string(&row.to_json()).unwrap_or_default()
    }
}

/// The portable, signed meaning bundle. `version` lets future readers
/// reject shapes they don't understand. Field ORDER here is the canonical
/// signing order — `serde_json` serializes struct fields in declaration
/// order, and that determinism is what makes the signature reproducible.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BundleV1 {
    pub version: u32,
    /// Full HEAD oid at export time — the tip the meaning was packed at.
    pub repo_head: String,
    /// Unix seconds at export.
    pub generated_at: u64,
    pub commits: Vec<BundleCommit>,
    pub intent: Vec<BundleIntent>,
    pub goals: Vec<GoalRecord>,
    /// Signer's FULL 32-byte Ed25519 public key, lowercase hex. Makes the
    /// bundle self-certifying: import verifies with no key server.
    pub pubkey_hex: String,
    /// Ed25519 signature over `canonical_unsigned_bytes`, lowercase hex.
    /// Empty while building / signing; filled last.
    pub signature_hex: String,
}

impl BundleV1 {
    /// The EXACT bytes the signature covers: the whole bundle serialized
    /// with `signature_hex` blanked to "". Export sets it empty, signs
    /// these bytes, then fills it; import blanks it again and reproduces
    /// these bytes to verify. Anything that changes the JSON (a flipped
    /// intent byte, an added goal) changes these bytes → verification
    /// fails. Determinism: struct fields serialize in declaration order
    /// and we never use a HashMap, so two machines produce identical bytes.
    pub fn canonical_unsigned_bytes(&self) -> Vec<u8> {
        let mut clone = self.clone();
        clone.signature_hex = String::new();
        // Compact (no pretty) form for signing — stable regardless of how
        // the file on disk is later pretty-printed for humans.
        serde_json::to_vec(&clone).unwrap_or_default()
    }
}

// ───────────────────────── hex helpers ─────────────────────────
// Small, dependency-free lowercase-hex codec for the 32-byte pubkey and
// 64-byte signature. We don't pull a hex crate for two fixed-size blobs.

fn to_hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{:02x}", b));
    }
    s
}

fn from_hex(s: &str) -> Result<Vec<u8>, String> {
    let s = s.trim();
    if s.len() % 2 != 0 {
        return Err(format!("odd hex length {}", s.len()));
    }
    let mut out = Vec::with_capacity(s.len() / 2);
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let hi = hex_nibble(bytes[i])?;
        let lo = hex_nibble(bytes[i + 1])?;
        out.push((hi << 4) | lo);
        i += 2;
    }
    Ok(out)
}

fn hex_nibble(c: u8) -> Result<u8, String> {
    match c {
        b'0'..=b'9' => Ok(c - b'0'),
        b'a'..=b'f' => Ok(c - b'a' + 10),
        b'A'..=b'F' => Ok(c - b'A' + 10),
        other => Err(format!("invalid hex char {:?}", other as char)),
    }
}

// ───────────────────────── paths ─────────────────────────

/// Repo workdir — the anchor for `.aura/...` source files. Falls back to
/// the git dir for a bare repo (where there is no workdir).
fn workdir(repo: &Repository) -> PathBuf {
    repo.workdir()
        .map(|w| w.to_path_buf())
        .unwrap_or_else(|| repo.path().to_path_buf())
}

fn intent_log_path(root: &Path) -> PathBuf {
    root.join(".aura").join("intent_log.jsonl")
}

fn goals_path(root: &Path) -> PathBuf {
    root.join(".aura").join("goals.jsonl")
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

// ───────────────────────── commit list ─────────────────────────

/// Resolve the commit manifest for `range` (default = all reachable from
/// HEAD, capped at `COMMIT_CAP`). `range` accepts anything `revparse`
/// understands as a range (`A..B`) or a single revision (treated as "all
/// reachable from that revision"). Newest-first.
fn collect_commits(
    repo: &Repository,
    range: Option<&str>,
) -> Result<Vec<BundleCommit>, Box<dyn std::error::Error>> {
    let mut walk = repo.revwalk()?;
    walk.set_sorting(git2::Sort::TOPOLOGICAL | git2::Sort::TIME)?;

    match range {
        Some(r) if r.contains("..") => {
            // A..B style range — let git2 push the revspec range for us.
            walk.push_range(r)
                .map_err(|e| format!("bad range '{}': {}", r, e.message()))?;
        }
        Some(r) => {
            // Single revision: all commits reachable from it.
            let obj = repo
                .revparse_single(r)
                .map_err(|e| format!("cannot resolve '{}': {}", r, e.message()))?;
            let commit = obj
                .peel_to_commit()
                .map_err(|e| format!("'{}' is not a commit: {}", r, e.message()))?;
            walk.push(commit.id())?;
        }
        None => {
            // Default: everything reachable from HEAD.
            walk.push_head()
                .map_err(|e| format!("cannot resolve HEAD ({})", e.message()))?;
        }
    }

    let mut out = Vec::new();
    for oid in walk {
        let oid = oid?;
        let commit = repo.find_commit(oid)?;
        let summary = commit.summary().unwrap_or("").to_string();
        out.push(BundleCommit {
            sha: oid.to_string(),
            summary,
        });
        if out.len() >= COMMIT_CAP {
            break;
        }
    }
    Ok(out)
}

// ───────────────────────── build / sign ─────────────────────────

/// Build and SIGN a bundle from the repo's current meaning. Reuses the
/// repo-local identity (`refs_sign::load_repo_identity`) — the same key
/// that signs `aura refs sign` endorsements and radar events. Fails if no
/// identity exists, with that path's guidance.
pub fn build_signed_bundle(
    repo: &Repository,
    range: Option<&str>,
) -> Result<BundleV1, Box<dyn std::error::Error>> {
    let root = workdir(repo);

    let head = repo
        .head()
        .ok()
        .and_then(|h| h.peel_to_commit().ok())
        .map(|c| c.id().to_string())
        .unwrap_or_default();

    let commits = collect_commits(repo, range)?;

    let intent: Vec<BundleIntent> = read_all_rows(&intent_log_path(&root))
        .iter()
        .map(BundleIntent::from_row)
        .collect();

    let goals = crate::goals::store::load(&root);

    let sk = crate::refs_sign::load_repo_identity(repo)?;
    let pubkey_hex = to_hex(&sk.verifying_key().to_bytes());

    let mut bundle = BundleV1 {
        version: 1,
        repo_head: head,
        generated_at: now_secs(),
        commits,
        intent,
        goals,
        pubkey_hex,
        signature_hex: String::new(),
    };

    // Sign over the canonical bytes with signature blanked, then fill in.
    let payload = bundle.canonical_unsigned_bytes();
    let sig = sk.sign(&payload);
    bundle.signature_hex = to_hex(sig.as_bytes());

    Ok(bundle)
}

// ───────────────────────── verify ─────────────────────────

/// Why a bundle failed to verify, so import can report precisely.
#[derive(Debug)]
pub enum VerifyError {
    UnsupportedVersion(u32),
    BadPubkey(String),
    BadSignature(String),
    DoesNotVerify,
}

impl std::fmt::Display for VerifyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            VerifyError::UnsupportedVersion(v) => {
                write!(f, "unsupported bundle version {} (this build reads v1)", v)
            }
            VerifyError::BadPubkey(e) => write!(f, "embedded pubkey is unusable: {}", e),
            VerifyError::BadSignature(e) => write!(f, "embedded signature is malformed: {}", e),
            VerifyError::DoesNotVerify => write!(
                f,
                "signature does not verify over the bundle — the meaning was altered after signing, or the pubkey does not match"
            ),
        }
    }
}

impl std::error::Error for VerifyError {}

/// Verify a parsed bundle's Ed25519 signature against its embedded pubkey
/// over `canonical_unsigned_bytes`. OFFLINE — no key server, no network.
/// Returns the resolved verifying key on success so callers needn't
/// re-decode it.
pub fn verify_bundle(bundle: &BundleV1) -> Result<VerifyingKey, VerifyError> {
    if bundle.version != 1 {
        return Err(VerifyError::UnsupportedVersion(bundle.version));
    }

    let pk_bytes = from_hex(&bundle.pubkey_hex).map_err(VerifyError::BadPubkey)?;
    if pk_bytes.len() != 32 {
        return Err(VerifyError::BadPubkey(format!(
            "{} bytes (expected 32)",
            pk_bytes.len()
        )));
    }
    let mut pk = [0u8; 32];
    pk.copy_from_slice(&pk_bytes);
    let vk = VerifyingKey::from_bytes(&pk).map_err(|e| VerifyError::BadPubkey(e.to_string()))?;

    let sig_bytes = from_hex(&bundle.signature_hex).map_err(VerifyError::BadSignature)?;
    if sig_bytes.len() != 64 {
        return Err(VerifyError::BadSignature(format!(
            "{} bytes (expected 64)",
            sig_bytes.len()
        )));
    }
    let mut sig = [0u8; 64];
    sig.copy_from_slice(&sig_bytes);
    let sig = SignatureBytes(sig);

    let payload = bundle.canonical_unsigned_bytes();
    vk.verify(&payload, &sig)
        .map_err(|_| VerifyError::DoesNotVerify)?;
    Ok(vk)
}

// ───────────────────────── apply ─────────────────────────

/// What `--apply` changed in the local clone.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct ApplyReport {
    pub intent_added: usize,
    pub goals_upserted: usize,
}

/// Merge-append the bundle's intent rows into the local intent log,
/// deduping by EXACT serialized line (a row already present byte-for-byte
/// is skipped). Returns how many lines were appended.
fn apply_intent(root: &Path, bundle: &BundleV1) -> Result<usize, Box<dyn std::error::Error>> {
    let path = intent_log_path(root);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    let mut present: std::collections::HashSet<String> = existing
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();

    let mut appended = String::new();
    let mut added = 0usize;
    for row in &bundle.intent {
        let line = row.to_log_line();
        if line.is_empty() {
            continue;
        }
        if present.insert(line.clone()) {
            appended.push_str(&line);
            appended.push('\n');
            added += 1;
        }
    }

    if added > 0 {
        let mut combined = existing;
        if !combined.is_empty() && !combined.ends_with('\n') {
            combined.push('\n');
        }
        combined.push_str(&appended);
        std::fs::write(&path, combined)?;
    }
    Ok(added)
}

/// Upsert the bundle's goal records into the local goal ledger, keyed by
/// `id`: an incoming record replaces a local one with the SAME id only
/// when its `updated_at` is strictly newer; a brand-new id is inserted.
/// Returns how many records were inserted-or-replaced.
fn apply_goals(root: &Path, bundle: &BundleV1) -> Result<usize, Box<dyn std::error::Error>> {
    let path = goals_path(root);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    // Load locals preserving order; index by id.
    let mut locals = crate::goals::store::load(root);
    let mut index: std::collections::HashMap<String, usize> = locals
        .iter()
        .enumerate()
        .map(|(i, g)| (g.id.clone(), i))
        .collect();

    let mut upserted = 0usize;
    for incoming in &bundle.goals {
        match index.get(&incoming.id).copied() {
            Some(i) => {
                if incoming.updated_at > locals[i].updated_at {
                    locals[i] = incoming.clone();
                    upserted += 1;
                }
            }
            None => {
                index.insert(incoming.id.clone(), locals.len());
                locals.push(incoming.clone());
                upserted += 1;
            }
        }
    }

    if upserted > 0 {
        let mut buf = String::new();
        for g in &locals {
            let line = serde_json::to_string(g)?;
            buf.push_str(&line);
            buf.push('\n');
        }
        std::fs::write(&path, buf)?;
    }
    Ok(upserted)
}

/// Apply a verified bundle into the clone rooted at `root`. Caller MUST
/// verify first — apply assumes the signature already checked out.
pub fn apply_bundle(
    root: &Path,
    bundle: &BundleV1,
) -> Result<ApplyReport, Box<dyn std::error::Error>> {
    let intent_added = apply_intent(root, bundle)?;
    let goals_upserted = apply_goals(root, bundle)?;
    Ok(ApplyReport {
        intent_added,
        goals_upserted,
    })
}

// ───────────────────────── CLI ─────────────────────────

#[derive(Subcommand)]
pub enum BundleSubcommands {
    /// Pack the repo's meaning (intent log + goal ledger + the commit list
    /// it attaches to) into one signed JSON file, verifiable offline on
    /// any clone. Default output: `aura-meaning-bundle.json`.
    Export {
        /// Where to write the bundle. Default: aura-meaning-bundle.json.
        #[arg(long)]
        output: Option<String>,
        /// Commit range to manifest — `A..B`, a single revision (all
        /// reachable from it), or omit for all reachable from HEAD.
        #[arg(long)]
        range: Option<String>,
        #[arg(long)]
        json: bool,
    },
    /// Verify a bundle's signature offline and report its contents. With
    /// `--apply`, merge the meaning into this clone (dedup intent rows,
    /// upsert goals by newest `updated_at`).
    Import {
        /// Path to the bundle file to import.
        input: String,
        /// Merge the verified meaning into this clone. Without it, verify
        /// and report only — nothing is written.
        #[arg(long)]
        apply: bool,
        #[arg(long)]
        json: bool,
    },
}

pub fn run(sub: &BundleSubcommands) -> Result<(), Box<dyn std::error::Error>> {
    match sub {
        BundleSubcommands::Export {
            output,
            range,
            json,
        } => run_export(output.as_deref(), range.as_deref(), *json),
        BundleSubcommands::Import { input, apply, json } => run_import(input, *apply, *json),
    }
}

fn open_repo() -> Result<Repository, Box<dyn std::error::Error>> {
    Repository::discover(".").map_err(|e| {
        format!(
            "not inside a git repository ({}). `aura bundle` operates on a repo's meaning files.",
            e.message()
        )
        .into()
    })
}

fn run_export(
    output: Option<&str>,
    range: Option<&str>,
    json: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let repo = open_repo()?;
    let bundle = build_signed_bundle(&repo, range)?;

    let out_path = output.unwrap_or(DEFAULT_OUTPUT);
    let pretty = serde_json::to_string_pretty(&bundle)?;
    std::fs::write(out_path, format!("{}\n", pretty))?;

    if json {
        let v = serde_json::json!({
            "output": out_path,
            "commits": bundle.commits.len(),
            "intent_rows": bundle.intent.len(),
            "goals": bundle.goals.len(),
            "signed": true,
        });
        println!("{}", serde_json::to_string_pretty(&v)?);
    } else {
        println!(
            "{} {} · {} commit(s) · {} intent · {} goal(s) · {}",
            "bundle export".bold(),
            out_path.cyan(),
            bundle.commits.len(),
            bundle.intent.len(),
            bundle.goals.len(),
            "signed".green(),
        );
    }
    Ok(())
}

fn run_import(input: &str, apply: bool, json: bool) -> Result<(), Box<dyn std::error::Error>> {
    let raw = std::fs::read_to_string(input)
        .map_err(|e| format!("cannot read bundle '{}': {}", input, e))?;
    let bundle: BundleV1 = serde_json::from_str(&raw)
        .map_err(|e| format!("'{}' is not a valid bundle file: {}", input, e))?;

    // Verify FIRST — fail loudly before touching anything.
    let _vk = match verify_bundle(&bundle) {
        Ok(vk) => vk,
        Err(e) => {
            if json {
                let v = serde_json::json!({
                    "valid": false,
                    "error": e.to_string(),
                    "commits": bundle.commits.len(),
                    "intent_rows": bundle.intent.len(),
                    "goals": bundle.goals.len(),
                    "applied": serde_json::Value::Null,
                });
                println!("{}", serde_json::to_string_pretty(&v)?);
            } else {
                eprintln!(
                    "{} {} — {}",
                    "bundle import".bold(),
                    "INVALID".red().bold(),
                    e
                );
            }
            return Err(format!("bundle verification failed: {}", e).into());
        }
    };

    let applied = if apply {
        let repo = open_repo()?;
        let root = workdir(&repo);
        Some(apply_bundle(&root, &bundle)?)
    } else {
        None
    };

    if json {
        let applied_json = match &applied {
            Some(r) => serde_json::json!({
                "intent_added": r.intent_added,
                "goals_upserted": r.goals_upserted,
            }),
            None => serde_json::Value::Null,
        };
        let v = serde_json::json!({
            "valid": true,
            "commits": bundle.commits.len(),
            "intent_rows": bundle.intent.len(),
            "goals": bundle.goals.len(),
            "applied": applied_json,
        });
        println!("{}", serde_json::to_string_pretty(&v)?);
    } else {
        println!(
            "{} {} · {} commit(s) · {} intent · {} goal(s)",
            "bundle import".bold(),
            "VALID".green().bold(),
            bundle.commits.len(),
            bundle.intent.len(),
            bundle.goals.len(),
        );
        match &applied {
            Some(r) => println!(
                "  applied: {} intent row(s) added · {} goal(s) upserted",
                r.intent_added, r.goals_upserted
            ),
            None => println!(
                "  {} verify-only — pass {} to merge into this clone",
                "·".dimmed(),
                "--apply".cyan()
            ),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::goals::model::{GoalRecord, GoalRun, Verdict};
    use git2::{Repository, Signature, Time};
    use std::process::Command;

    // ---------- helpers ----------

    fn sh_git(dir: &Path, args: &[&str]) {
        let out = Command::new("git")
            .args(args)
            .current_dir(dir)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("HOME", dir)
            .output()
            .expect("spawn git");
        assert!(
            out.status.success(),
            "git {:?} failed in {:?}: {}",
            args,
            dir,
            String::from_utf8_lossy(&out.stderr)
        );
    }

    fn commit_file(repo: &Repository, name: &str, content: &str, msg: &str) -> git2::Oid {
        let workdir = repo.workdir().expect("non-bare");
        std::fs::write(workdir.join(name), content).unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new(name)).unwrap();
        index.write().unwrap();
        let tree_id = index.write_tree().unwrap();
        let tree = repo.find_tree(tree_id).unwrap();
        let sig = Signature::new("Dev", "dev@x.com", &Time::new(1_700_000_000, 0)).unwrap();
        let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
        let parents: Vec<&git2::Commit> = parent.iter().collect();
        repo.commit(Some("HEAD"), &sig, &sig, msg, &tree, &parents)
            .unwrap()
    }

    /// Fresh non-bare repo on branch `canon` with two commits.
    fn repo_with_commits(dir: &Path) -> Repository {
        sh_git(dir, &["init", "-b", "canon", "."]);
        let repo = Repository::open(dir).unwrap();
        commit_file(&repo, "a.txt", "a", "feat: first");
        commit_file(&repo, "b.txt", "b", "feat: second");
        repo
    }

    /// Create the repo-local identity EXACTLY where `aura identity` puts it.
    fn fixture_identity(repo: &Repository) {
        let path = repo
            .workdir()
            .unwrap()
            .join(".aura")
            .join("awareness")
            .join("identity.key");
        aura_attestation::load_or_create(&path).unwrap();
    }

    /// Write a synthetic intent log under the repo workdir.
    fn write_intent_log(root: &Path, lines: &[&str]) {
        let aura = root.join(".aura");
        std::fs::create_dir_all(&aura).unwrap();
        std::fs::write(
            aura.join("intent_log.jsonl"),
            format!("{}\n", lines.join("\n")),
        )
        .unwrap();
    }

    fn sample_goal(id: &str, updated_at: u64) -> GoalRecord {
        GoalRecord {
            id: id.into(),
            text: format!("goal {}", id),
            task_id: None,
            task_seq: None,
            acceptance: Vec::new(),
            decomposition: None,
            runs: vec![GoalRun {
                run_key: "adhoc".into(),
                label: None,
                agent_id: None,
                verdict: Verdict::Verified,
                ok: 1,
                total: 1,
                commit: None,
                trigger: None,
                files: vec![],
                at: updated_at,
            }],
            created_at: 1,
            updated_at,
        }
    }

    // ---------- hex codec ----------

    #[test]
    fn hex_roundtrips() {
        let bytes = [0u8, 1, 15, 16, 255, 128, 64, 7];
        let h = to_hex(&bytes);
        assert_eq!(h, "00010f10ff804007");
        assert_eq!(from_hex(&h).unwrap(), bytes);
    }

    #[test]
    fn hex_rejects_garbage() {
        assert!(from_hex("xyz").is_err()); // odd + invalid
        assert!(from_hex("0g").is_err()); // invalid nibble
        assert!(from_hex("abc").is_err()); // odd length
    }

    // ---------- export → verify ----------

    #[test]
    fn export_builds_signed_bundle_that_verifies() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = repo_with_commits(tmp.path());
        fixture_identity(&repo);
        write_intent_log(
            tmp.path(),
            &[
                r#"{"agent_id":"claude","intent":"wire the feature","timestamp":100,"intent_type":"FeatureAdd"}"#,
                r#"{"agent_id":"claude","intent":"fix the loop","timestamp":200}"#,
            ],
        );
        // A goal in the local ledger so the bundle carries it.
        crate::goals::store::upsert_by_text(tmp.path(), "users can sign in").unwrap();

        let bundle = build_signed_bundle(&repo, None).unwrap();
        assert_eq!(bundle.version, 1);
        assert_eq!(bundle.commits.len(), 2);
        assert_eq!(bundle.intent.len(), 2);
        assert_eq!(bundle.goals.len(), 1);
        assert_eq!(bundle.pubkey_hex.len(), 64); // 32 bytes
        assert_eq!(bundle.signature_hex.len(), 128); // 64 bytes
        assert!(!bundle.repo_head.is_empty());

        // Round-trips through JSON and still verifies (export writes JSON).
        let json = serde_json::to_string_pretty(&bundle).unwrap();
        let parsed: BundleV1 = serde_json::from_str(&json).unwrap();
        assert!(verify_bundle(&parsed).is_ok(), "fresh bundle must verify");
    }

    #[test]
    fn flipping_an_intent_byte_breaks_verification() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = repo_with_commits(tmp.path());
        fixture_identity(&repo);
        write_intent_log(
            tmp.path(),
            &[r#"{"agent_id":"claude","intent":"original intent","timestamp":100}"#],
        );

        let mut bundle = build_signed_bundle(&repo, None).unwrap();
        assert!(verify_bundle(&bundle).is_ok());

        // Tamper: change one intent's text AFTER signing. The signature was
        // computed over the original meaning → must now fail.
        bundle.intent[0].intent = "tampered intent".to_string();
        match verify_bundle(&bundle) {
            Err(VerifyError::DoesNotVerify) => {}
            other => panic!("tampered bundle must fail verification, got {:?}", other),
        }
    }

    #[test]
    fn tampering_with_goals_breaks_verification() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = repo_with_commits(tmp.path());
        fixture_identity(&repo);
        write_intent_log(tmp.path(), &[]);
        crate::goals::store::upsert_by_text(tmp.path(), "original goal").unwrap();

        let mut bundle = build_signed_bundle(&repo, None).unwrap();
        assert!(verify_bundle(&bundle).is_ok());

        bundle.goals.push(sample_goal("goal_injected", 5));
        assert!(
            matches!(verify_bundle(&bundle), Err(VerifyError::DoesNotVerify)),
            "an injected goal must break the signature"
        );
    }

    #[test]
    fn wrong_version_is_rejected_before_crypto() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = repo_with_commits(tmp.path());
        fixture_identity(&repo);
        write_intent_log(tmp.path(), &[]);
        let mut bundle = build_signed_bundle(&repo, None).unwrap();
        bundle.version = 2;
        assert!(matches!(
            verify_bundle(&bundle),
            Err(VerifyError::UnsupportedVersion(2))
        ));
    }

    // ---------- apply + dedup ----------

    #[test]
    fn apply_appends_intent_and_is_idempotent() {
        // Source repo builds a bundle; a SEPARATE target clone applies it
        // twice — the second apply adds nothing (exact-line dedup).
        let src = tempfile::tempdir().unwrap();
        let repo = repo_with_commits(src.path());
        fixture_identity(&repo);
        write_intent_log(
            src.path(),
            &[
                r#"{"agent_id":"claude","intent":"row one","timestamp":100}"#,
                r#"{"agent_id":"claude","intent":"row two","timestamp":200,"intent_type":"BugFix"}"#,
            ],
        );
        let bundle = build_signed_bundle(&repo, None).unwrap();
        assert!(verify_bundle(&bundle).is_ok());

        // Empty target clone (just needs a .aura root).
        let target = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(target.path().join(".aura")).unwrap();

        let first = apply_bundle(target.path(), &bundle).unwrap();
        assert_eq!(first.intent_added, 2, "both rows are new");

        // Importing the same bundle again adds nothing.
        let second = apply_bundle(target.path(), &bundle).unwrap();
        assert_eq!(second.intent_added, 0, "exact-line dedup on re-apply");

        // And the on-disk log actually has exactly the two rows.
        let log = std::fs::read_to_string(target.path().join(".aura").join("intent_log.jsonl"))
            .unwrap();
        let rows = read_all_rows(&target.path().join(".aura").join("intent_log.jsonl"));
        assert_eq!(rows.len(), 2, "log holds exactly two rows: {}", log);
    }

    #[test]
    fn apply_preserves_existing_local_intent() {
        let src = tempfile::tempdir().unwrap();
        let repo = repo_with_commits(src.path());
        fixture_identity(&repo);
        write_intent_log(
            src.path(),
            &[r#"{"agent_id":"claude","intent":"from bundle","timestamp":100}"#],
        );
        let bundle = build_signed_bundle(&repo, None).unwrap();

        let target = tempfile::tempdir().unwrap();
        write_intent_log(
            target.path(),
            &[r#"{"agent_id":"local","intent":"already here","timestamp":50}"#],
        );

        let r = apply_bundle(target.path(), &bundle).unwrap();
        assert_eq!(r.intent_added, 1);
        let rows = read_all_rows(&intent_log_path(target.path()));
        assert_eq!(rows.len(), 2, "local row kept + bundle row appended");
        assert!(rows.iter().any(|r| r.intent == "already here"));
        assert!(rows.iter().any(|r| r.intent == "from bundle"));
    }

    #[test]
    fn apply_upserts_goals_by_newer_updated_at() {
        let src = tempfile::tempdir().unwrap();
        let repo = repo_with_commits(src.path());
        fixture_identity(&repo);
        write_intent_log(src.path(), &[]);

        // Bundle carries: shared id at updated_at=100 (newer) + a fresh id.
        let mut bundle = build_signed_bundle(&repo, None).unwrap();
        bundle.goals = vec![sample_goal("goal_shared", 100), sample_goal("goal_new", 100)];

        // Target has the shared id at an OLDER updated_at and one untouched.
        let target = tempfile::tempdir().unwrap();
        let target_root = target.path();
        std::fs::create_dir_all(target_root.join(".aura")).unwrap();
        let locals = vec![sample_goal("goal_shared", 50), sample_goal("goal_local", 50)];
        let mut buf = String::new();
        for g in &locals {
            buf.push_str(&serde_json::to_string(g).unwrap());
            buf.push('\n');
        }
        std::fs::write(goals_path(target_root), buf).unwrap();

        let r = apply_goals(target_root, &bundle).unwrap();
        // shared (replaced, newer) + new (inserted) = 2 upserts.
        assert_eq!(r, 2);

        let reloaded = crate::goals::store::load(target_root);
        assert_eq!(reloaded.len(), 3, "shared replaced, local kept, new added");
        let shared = reloaded.iter().find(|g| g.id == "goal_shared").unwrap();
        assert_eq!(shared.updated_at, 100, "newer bundle record won");
        assert!(reloaded.iter().any(|g| g.id == "goal_local"));
        assert!(reloaded.iter().any(|g| g.id == "goal_new"));

        // Re-applying the same goals is now a no-op (not strictly newer).
        let again = apply_goals(target_root, &bundle).unwrap();
        assert_eq!(again, 0, "equal updated_at does not re-upsert");
    }

    #[test]
    fn build_without_identity_fails() {
        // No identity keyfile → export must fail (never mints a key).
        let tmp = tempfile::tempdir().unwrap();
        let repo = repo_with_commits(tmp.path());
        write_intent_log(tmp.path(), &[]);
        let err = build_signed_bundle(&repo, None).unwrap_err();
        assert!(
            err.to_string().contains("aura identity"),
            "must point at the identity command, got: {}",
            err
        );
    }

    #[test]
    fn range_limits_the_commit_manifest() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = repo_with_commits(tmp.path());
        fixture_identity(&repo);
        write_intent_log(tmp.path(), &[]);

        // HEAD~1..HEAD is exactly the second commit.
        let bundle = build_signed_bundle(&repo, Some("HEAD~1..HEAD")).unwrap();
        assert_eq!(bundle.commits.len(), 1);
        assert_eq!(bundle.commits[0].summary, "feat: second");
        // Still verifies — range is part of the signed bytes.
        assert!(verify_bundle(&bundle).is_ok());
    }
}
