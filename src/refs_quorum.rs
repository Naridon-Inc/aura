// M4b — sovereign substrate, slice 2 of SIGNED CANONICAL REFS: the
// DELEGATE QUORUM (AURA-22 / AURA-128, "who owns main").
//
// Slice 1 (`refs_sign.rs`) let any identity endorse a ref tip and left
// the note format room for this slice: a note already carries MULTIPLE
// signature lines per (ref, oid), one per key_id. This slice adds the
// missing authority layer — a signed, chained POLICY that names the
// delegate set and threshold ("2-of-3 maintainers"), and a verify mode
// that evaluates those same endorsement lines against it. Nothing about
// the endorsement payload or note layout changes.
//
// ── Policy file ────────────────────────────────────────────────────────
// `.aura/quorum.json` in the repo worktree — COMMITTED, so the policy
// travels with every clone and merges like any other file. It holds the
// FULL chain of policies, genesis first:
//
//   {"schema_version":1,"policies":[{...seq 0...},{...seq 1...}]}
//
// Each entry:
//
//   {"seq":0,"threshold":2,
//    "delegates":[{"name":"Ashiq","key_id":"did:aura:key/...",
//                  "pubkey":"<b64url no-pad 32B>"}],
//    "created_at":1757000000,"prev_hash":"",
//    "sigs":[{"key_id":"did:aura:key/...","sig":"<b64 std no-pad 64B>"}]}
//
// Delegates embed their FULL verifying key, so the chain is
// self-certifying exactly like the endorsement lines: a verifier needs
// no key server, only this file. WHO a key_id belongs to is anchored
// out-of-band (compare `aura identity` output over a trusted channel).
//
// ── Signed payload (byte-for-byte) ─────────────────────────────────────
// Every sig in `sigs` is Ed25519 over the UTF-8 bytes of EXACTLY:
//
//   "aura-quorum\nv1\n<seq>\n<threshold>\n<prev_hash>\n<delegates>\n<created_at>"
//
// where <delegates> is the serde_json rendering of the [key_id, pubkey,
// name] triples sorted by key_id — deterministic, and it BINDS the
// display names so a rename cannot ride an old signature. No trailing
// newline. `prev_hash` is the sha256 hex of the PREVIOUS entry's
// payload ("" for genesis) — the chain detects insert/reorder/rewrite.
//
// ── Rotation rules (TUF-style root rotation) ───────────────────────────
// Who may sign entry N is decided by entry N-1: a rotation requires
// ≥ threshold(N-1) valid signatures from the OLD delegate set — the old
// quorum hands authority to the new one. Genesis is trust-on-first-use
// (like the reflog pin store) and needs ≥1 signature from its OWN
// delegates. The final entry may be PENDING (signed but not yet at the
// old threshold) — `aura refs quorum endorse` lets the other delegates
// co-sign it; until then the last fully-endorsed entry stays active.
// Any signature that fails crypto is tamper evidence and hard-fails the
// whole chain — a policy file is small and append-only, there is no
// innocent way for a sig in it to rot.
//
// ── Quorum verdict on a ref ────────────────────────────────────────────
// `aura refs verify --quorum` (or `aura refs quorum verify`) counts the
// cryptographically VALID endorsement lines at the ref's current tip
// whose key_id is in the ACTIVE policy's delegate set, deduped by
// key_id. count ≥ threshold ⇒ QUORUM MET, else exit non-zero listing
// which delegates are missing.

use clap::Subcommand;
use colored::Colorize;
use git2::Repository;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::path::PathBuf;

use aura_attestation::{SignatureBytes, SigningKey, VerifyingKey};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64URL, Engine};

use crate::refs_sign::{LineStatus, VerifyReport};

/// Domain-separation tag — first line of every signed policy payload.
pub const POLICY_TAG: &str = "aura-quorum";

/// Where the policy chain lives, relative to the repo worktree root.
pub const POLICY_FILE: &str = ".aura/quorum.json";

// ───────────────────────── model ─────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Delegate {
    /// Display name — bound into the signed payload, so it is as
    /// tamper-evident as the key material.
    pub name: String,
    /// `did:aura:key/...` — must derive from `pubkey`.
    pub key_id: String,
    /// Full 32-byte Ed25519 verifying key, base64url no-pad.
    pub pubkey: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PolicySig {
    pub key_id: String,
    /// Base64 (std, no pad) Ed25519 signature over [`policy_payload`].
    pub sig: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PolicyEntry {
    pub seq: u64,
    pub threshold: usize,
    pub delegates: Vec<Delegate>,
    pub created_at: u64,
    /// sha256 hex of the previous entry's payload; "" for genesis.
    pub prev_hash: String,
    pub sigs: Vec<PolicySig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuorumFile {
    pub schema_version: u32,
    pub policies: Vec<PolicyEntry>,
}

/// The EXACT byte string every policy signature covers. Verifiers
/// reproduce this byte-for-byte.
pub fn policy_payload(entry: &PolicyEntry) -> String {
    let mut triples: Vec<[&str; 3]> = entry
        .delegates
        .iter()
        .map(|d| [d.key_id.as_str(), d.pubkey.as_str(), d.name.as_str()])
        .collect();
    triples.sort();
    let delegates = serde_json::to_string(&triples).unwrap_or_else(|_| "[]".to_string());
    format!(
        "{}\nv1\n{}\n{}\n{}\n{}\n{}",
        POLICY_TAG, entry.seq, entry.threshold, entry.prev_hash, delegates, entry.created_at
    )
}

/// sha256 hex of an entry's payload — what the NEXT entry chains to.
pub fn entry_hash(entry: &PolicyEntry) -> String {
    let mut h = Sha256::new();
    h.update(policy_payload(entry).as_bytes());
    format!("{:x}", h.finalize())
}

fn decode_pubkey(b64: &str) -> Result<VerifyingKey, String> {
    let raw = B64URL
        .decode(b64.as_bytes())
        .map_err(|e| format!("base64: {}", e))?;
    if raw.len() != 32 {
        return Err(format!("{} bytes (expected 32)", raw.len()));
    }
    let mut buf = [0u8; 32];
    buf.copy_from_slice(&raw);
    VerifyingKey::from_bytes(&buf).map_err(|e| e.to_string())
}

// ───────────────────────── chain verification ─────────────────────────

#[derive(Debug, Serialize)]
pub struct EntryReport {
    pub seq: u64,
    pub threshold: usize,
    pub delegates: usize,
    /// Valid signatures from the AUTHORIZING set (previous entry's
    /// delegates; the entry's own for genesis), deduped by key_id.
    pub valid_sigs: usize,
    /// How many authorizer signatures this entry needs to be active.
    pub required: usize,
    pub endorsed: bool,
}

#[derive(Debug, Serialize)]
pub struct ChainReport {
    pub entries: Vec<EntryReport>,
    /// Index into `entries` of the ACTIVE (last fully-endorsed) policy.
    pub active_index: usize,
    /// True when the final entry is still gathering endorsements.
    pub pending: bool,
}

/// Structural per-entry checks that do not depend on chain position.
fn check_entry_shape(entry: &PolicyEntry) -> Result<(), String> {
    if entry.delegates.is_empty() {
        return Err(format!("policy seq {}: no delegates", entry.seq));
    }
    if entry.threshold == 0 || entry.threshold > entry.delegates.len() {
        return Err(format!(
            "policy seq {}: threshold {} out of range for {} delegate(s)",
            entry.seq,
            entry.threshold,
            entry.delegates.len()
        ));
    }
    let mut seen = HashSet::new();
    for d in &entry.delegates {
        if !seen.insert(d.key_id.as_str()) {
            return Err(format!(
                "policy seq {}: duplicate delegate {}",
                entry.seq, d.key_id
            ));
        }
        let vk = decode_pubkey(&d.pubkey).map_err(|e| {
            format!(
                "policy seq {}: delegate {} pubkey unparsable: {}",
                entry.seq, d.key_id, e
            )
        })?;
        if vk.key_id() != d.key_id {
            return Err(format!(
                "policy seq {}: delegate pubkey derives {} but the entry claims {} — forged binding",
                entry.seq,
                vk.key_id(),
                d.key_id
            ));
        }
    }
    Ok(())
}

/// Verify the whole policy chain. Hard-fails on any structural problem,
/// broken link, or cryptographically INVALID signature; the only
/// tolerated incompleteness is a final entry still gathering
/// endorsements (reported as `pending`).
pub fn verify_chain(file: &QuorumFile) -> Result<ChainReport, String> {
    if file.schema_version != 1 {
        return Err(format!(
            "unsupported quorum schema_version {}",
            file.schema_version
        ));
    }
    if file.policies.is_empty() {
        return Err("quorum file has no policies".to_string());
    }

    let mut entries = Vec::new();
    for (i, entry) in file.policies.iter().enumerate() {
        if entry.seq != i as u64 {
            return Err(format!(
                "policy at position {} has seq {} — chain reordered or truncated",
                i, entry.seq
            ));
        }
        check_entry_shape(entry)?;

        let expected_prev = if i == 0 {
            String::new()
        } else {
            entry_hash(&file.policies[i - 1])
        };
        if entry.prev_hash != expected_prev {
            return Err(format!(
                "policy seq {}: prev_hash does not match the previous entry — chain broken",
                entry.seq
            ));
        }

        // Who authorizes THIS entry: its own delegates for genesis, the
        // previous entry's delegates for every rotation.
        let authorizers = if i == 0 {
            &entry.delegates
        } else {
            &file.policies[i - 1].delegates
        };
        let required = if i == 0 {
            1
        } else {
            file.policies[i - 1].threshold
        };

        let payload = policy_payload(entry);
        let mut valid: HashSet<&str> = HashSet::new();
        for s in &entry.sigs {
            let Some(auth) = authorizers.iter().find(|d| d.key_id == s.key_id) else {
                // A signature from outside the authorizing set carries no
                // authority; it is ignored rather than treated as tamper
                // (a new delegate may eagerly co-sign its own rotation).
                continue;
            };
            let vk = decode_pubkey(&auth.pubkey)
                .map_err(|e| format!("policy seq {}: authorizer pubkey: {}", entry.seq, e))?;
            let sig = SignatureBytes::from_b64(&s.sig).map_err(|e| {
                format!(
                    "policy seq {}: malformed signature from {}: {}",
                    entry.seq, s.key_id, e
                )
            })?;
            if vk.verify(payload.as_bytes(), &sig).is_err() {
                return Err(format!(
                    "policy seq {}: signature from {} does not verify — policy tampered",
                    entry.seq, s.key_id
                ));
            }
            valid.insert(auth.key_id.as_str());
        }

        let endorsed = valid.len() >= required;
        if !endorsed && i + 1 != file.policies.len() {
            return Err(format!(
                "policy seq {}: only {} of {} required endorsement(s) but a later policy chains onto it",
                entry.seq,
                valid.len(),
                required
            ));
        }
        entries.push(EntryReport {
            seq: entry.seq,
            threshold: entry.threshold,
            delegates: entry.delegates.len(),
            valid_sigs: valid.len(),
            required,
            endorsed,
        });
    }

    let pending = !entries.last().map(|e| e.endorsed).unwrap_or(false);
    if pending && entries.len() == 1 {
        return Err(
            "genesis policy carries no valid signature from its own delegates".to_string(),
        );
    }
    let active_index = if pending {
        entries.len() - 2
    } else {
        entries.len() - 1
    };
    Ok(ChainReport {
        entries,
        active_index,
        pending,
    })
}

// ───────────────────────── quorum verdict on a ref ─────────────────────

#[derive(Debug, Serialize)]
pub struct QuorumVerdict {
    pub policy_seq: u64,
    pub threshold: usize,
    pub met: bool,
    /// Delegates whose VALID endorsement of the tip was found.
    pub endorsed_by: Vec<String>,
    /// Delegates yet to endorse this tip.
    pub missing: Vec<String>,
}

/// Evaluate a slice-1 [`VerifyReport`] against the active policy: count
/// cryptographically VALID endorsement lines whose key_id is a
/// delegate, deduped by key_id.
pub fn evaluate(policy: &PolicyEntry, report: &VerifyReport) -> QuorumVerdict {
    let valid_keys: HashSet<&str> = report
        .signatures
        .iter()
        .filter(|l| l.status == LineStatus::Valid)
        .map(|l| l.key_id.as_str())
        .collect();

    let mut endorsed_by = Vec::new();
    let mut missing = Vec::new();
    for d in &policy.delegates {
        let label = format!("{} · {}", d.name, d.key_id);
        if valid_keys.contains(d.key_id.as_str()) {
            endorsed_by.push(label);
        } else {
            missing.push(label);
        }
    }
    QuorumVerdict {
        policy_seq: policy.seq,
        threshold: policy.threshold,
        met: endorsed_by.len() >= policy.threshold,
        endorsed_by,
        missing,
    }
}

// ───────────────────────── file I/O ─────────────────────────

pub fn policy_path(repo: &Repository) -> PathBuf {
    let root = repo
        .workdir()
        .map(|w| w.to_path_buf())
        .unwrap_or_else(|| repo.path().to_path_buf());
    root.join(POLICY_FILE)
}

pub fn load_file(repo: &Repository) -> Result<QuorumFile, String> {
    let path = policy_path(repo);
    let text = std::fs::read_to_string(&path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            format!(
                "no quorum policy at {} — run `aura refs quorum init --threshold K` to create one",
                path.display()
            )
        } else {
            format!("cannot read {}: {}", path.display(), e)
        }
    })?;
    serde_json::from_str(&text).map_err(|e| format!("{} is not valid: {}", path.display(), e))
}

fn save_file(repo: &Repository, file: &QuorumFile) -> Result<(), String> {
    let path = policy_path(repo);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("mkdir {}: {}", dir.display(), e))?;
    }
    let body = serde_json::to_string_pretty(file).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, body.as_bytes()).map_err(|e| format!("write {}: {}", tmp.display(), e))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("rename into {}: {}", path.display(), e))
}

// ───────────────────────── CLI ─────────────────────────

#[derive(Subcommand)]
pub enum QuorumSubcommands {
    /// Create the genesis delegate policy. Your repo identity becomes a
    /// delegate automatically; add peers with --delegate.
    Init {
        /// How many delegate endorsements a canonical ref needs.
        #[arg(long)]
        threshold: usize,
        /// Extra delegate as NAME=<pubkey> (the base64url verifying key
        /// `aura identity` prints on the peer's machine). Repeatable.
        #[arg(long = "delegate")]
        delegates: Vec<String>,
    },
    /// Show and verify the policy chain.
    Show {
        #[arg(long)]
        json: bool,
    },
    /// Propose a NEW policy (rotate delegates / change threshold). Needs
    /// co-signatures from the OLD quorum before it becomes active — the
    /// other delegates run `aura refs quorum endorse`.
    Rotate {
        #[arg(long)]
        threshold: usize,
        /// Delegate of the NEW policy as NAME=<pubkey>. Repeatable.
        #[arg(long = "delegate")]
        delegates: Vec<String>,
        /// Carry the currently active delegate set into the new policy
        /// (on top of any --delegate additions).
        #[arg(long)]
        keep: bool,
    },
    /// Co-sign the pending policy proposal with your repo identity.
    Endorse {
        #[arg(long)]
        json: bool,
    },
    /// Verify a ref against the active policy (same as
    /// `aura refs verify --quorum`).
    Verify {
        /// Ref to verify (short or full name). Default: current branch.
        #[arg(long = "ref")]
        ref_name: Option<String>,
        #[arg(long)]
        json: bool,
    },
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Parse `NAME=<pubkey>` (or a bare pubkey — the key_id becomes the
/// name) into a self-certified Delegate.
fn parse_delegate(arg: &str) -> Result<Delegate, String> {
    let (name, pubkey) = match arg.split_once('=') {
        Some((n, p)) => (n.trim().to_string(), p.trim().to_string()),
        None => (String::new(), arg.trim().to_string()),
    };
    let vk = decode_pubkey(&pubkey)
        .map_err(|e| format!("--delegate '{}': pubkey unparsable ({})", arg, e))?;
    let key_id = vk.key_id();
    let name = if name.is_empty() { key_id.clone() } else { name };
    Ok(Delegate {
        name,
        key_id,
        pubkey,
    })
}

fn self_delegate(sk: &SigningKey, name: &str) -> Delegate {
    Delegate {
        name: name.to_string(),
        key_id: sk.key_id(),
        pubkey: B64URL.encode(sk.verifying_key().to_bytes()),
    }
}

fn sign_entry(entry: &mut PolicyEntry, sk: &SigningKey) {
    let payload = policy_payload(entry);
    let key_id = sk.key_id();
    entry.sigs.retain(|s| s.key_id != key_id);
    entry.sigs.push(PolicySig {
        key_id,
        sig: sk.sign(payload.as_bytes()).to_b64(),
    });
}

fn run_init(threshold: usize, delegate_args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    let repo = crate::meta_refs::open_repo()?;
    let path = policy_path(&repo);
    if path.exists() {
        return Err(format!(
            "{} already exists — use `aura refs quorum rotate` to change the policy (the chain must not be rewritten)",
            path.display()
        )
        .into());
    }
    let sk = crate::refs_sign::load_repo_identity(&repo)?;
    let signer = crate::live_events::git_user();

    let mut delegates = vec![self_delegate(&sk, &signer)];
    for arg in delegate_args {
        let d = parse_delegate(arg)?;
        if delegates.iter().any(|x| x.key_id == d.key_id) {
            return Err(format!("duplicate delegate {}", d.key_id).into());
        }
        delegates.push(d);
    }
    if threshold == 0 || threshold > delegates.len() {
        return Err(format!(
            "threshold {} out of range for {} delegate(s)",
            threshold,
            delegates.len()
        )
        .into());
    }

    let mut entry = PolicyEntry {
        seq: 0,
        threshold,
        delegates,
        created_at: now_secs(),
        prev_hash: String::new(),
        sigs: Vec::new(),
    };
    sign_entry(&mut entry, &sk);

    let file = QuorumFile {
        schema_version: 1,
        policies: vec![entry],
    };
    verify_chain(&file).map_err(|e| format!("freshly built policy failed self-verify: {}", e))?;
    save_file(&repo, &file)?;

    let p = &file.policies[0];
    println!(
        "{} genesis policy — {}-of-{} · {}",
        "refs quorum".bold(),
        p.threshold,
        p.delegates.len(),
        path.display()
    );
    for d in &p.delegates {
        println!("  {} {} · {}", "·".dimmed(), d.name.bold(), d.key_id);
    }
    println!(
        "  {} commit {} so the policy travels with the repo",
        "→".dimmed(),
        POLICY_FILE
    );
    Ok(())
}

fn run_show(json: bool) -> Result<(), Box<dyn std::error::Error>> {
    let repo = crate::meta_refs::open_repo()?;
    let file = load_file(&repo)?;
    let report = verify_chain(&file)?;

    if json {
        let active = &file.policies[report.active_index];
        let v = serde_json::json!({
            "chain": report,
            "active": active,
        });
        println!("{}", serde_json::to_string_pretty(&v)?);
        return Ok(());
    }

    println!("{} chain of {} policy(ies) — VALID", "refs quorum".bold(), report.entries.len());
    for (i, e) in report.entries.iter().enumerate() {
        let mark = if i == report.active_index {
            "ACTIVE".green().bold().to_string()
        } else if !e.endorsed {
            "PENDING".yellow().bold().to_string()
        } else {
            "superseded".dimmed().to_string()
        };
        println!(
            "  seq {} · {}-of-{} · sigs {}/{} · {}",
            e.seq, e.threshold, e.delegates, e.valid_sigs, e.required, mark
        );
    }
    let active = &file.policies[report.active_index];
    for d in &active.delegates {
        println!("  {} {} · {}", "·".dimmed(), d.name.bold(), d.key_id);
    }
    if report.pending {
        println!(
            "  {} pending rotation awaits `aura refs quorum endorse` from the old quorum",
            "→".yellow()
        );
    }
    Ok(())
}

fn run_rotate(
    threshold: usize,
    delegate_args: &[String],
    keep: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let repo = crate::meta_refs::open_repo()?;
    let mut file = load_file(&repo)?;
    let report = verify_chain(&file)?;
    if report.pending {
        return Err(
            "a rotation is already pending — endorse or delete it before proposing another".into(),
        );
    }
    let sk = crate::refs_sign::load_repo_identity(&repo)?;
    let last = file.policies.last().expect("chain verified non-empty");
    if !last.delegates.iter().any(|d| d.key_id == sk.key_id()) {
        return Err(format!(
            "only a delegate of the active policy may propose a rotation — your identity {} is not one",
            sk.key_id()
        )
        .into());
    }

    let mut delegates: Vec<Delegate> = if keep { last.delegates.clone() } else { Vec::new() };
    for arg in delegate_args {
        let d = parse_delegate(arg)?;
        if delegates.iter().any(|x| x.key_id == d.key_id) {
            continue;
        }
        delegates.push(d);
    }
    if delegates.is_empty() {
        return Err("new policy has no delegates — pass --delegate and/or --keep".into());
    }
    if threshold == 0 || threshold > delegates.len() {
        return Err(format!(
            "threshold {} out of range for {} delegate(s)",
            threshold,
            delegates.len()
        )
        .into());
    }

    let required = last.threshold;
    let mut entry = PolicyEntry {
        seq: last.seq + 1,
        threshold,
        delegates,
        created_at: now_secs(),
        prev_hash: entry_hash(last),
        sigs: Vec::new(),
    };
    sign_entry(&mut entry, &sk);
    file.policies.push(entry);

    let report = verify_chain(&file)?;
    save_file(&repo, &file)?;

    let e = report.entries.last().expect("just pushed");
    println!(
        "{} rotation seq {} proposed — {}-of-{} · sigs {}/{}",
        "refs quorum".bold(),
        e.seq,
        e.threshold,
        e.delegates,
        e.valid_sigs,
        required
    );
    if report.pending {
        println!(
            "  {} needs {} more old-quorum endorsement(s): peers run `aura refs quorum endorse`",
            "→".yellow(),
            required.saturating_sub(e.valid_sigs)
        );
    } else {
        println!("  {} active immediately (old threshold already met)", "✓".green());
    }
    Ok(())
}

fn run_endorse(json: bool) -> Result<(), Box<dyn std::error::Error>> {
    let repo = crate::meta_refs::open_repo()?;
    let mut file = load_file(&repo)?;
    verify_chain(&file)?;
    let sk = crate::refs_sign::load_repo_identity(&repo)?;

    let n = file.policies.len();
    let authorizers = if n == 1 {
        file.policies[0].delegates.clone()
    } else {
        file.policies[n - 2].delegates.clone()
    };
    if !authorizers.iter().any(|d| d.key_id == sk.key_id()) {
        return Err(format!(
            "your identity {} is not in the authorizing delegate set for the latest policy",
            sk.key_id()
        )
        .into());
    }

    let last = file.policies.last_mut().expect("verified non-empty");
    let already = last.sigs.iter().any(|s| s.key_id == sk.key_id());
    sign_entry(last, &sk);

    let report = verify_chain(&file)?;
    save_file(&repo, &file)?;

    let e = report.entries.last().expect("non-empty");
    if json {
        let v = serde_json::json!({
            "seq": e.seq,
            "already_signed": already,
            "valid_sigs": e.valid_sigs,
            "required": e.required,
            "active": !report.pending,
        });
        println!("{}", serde_json::to_string_pretty(&v)?);
        return Ok(());
    }
    println!(
        "{} endorsed seq {} — sigs {}/{}{}",
        "refs quorum".bold(),
        e.seq,
        e.valid_sigs,
        e.required,
        if already { " (re-signed)" } else { "" }
    );
    if report.pending {
        println!("  {} still pending — more old-quorum endorsements needed", "→".yellow());
    } else {
        println!("  {} policy is ACTIVE", "✓".green());
    }
    Ok(())
}

/// Shared by `refs verify --quorum` and `refs quorum verify`: returns
/// the verdict so the caller can print the slice-1 report first, and
/// exits non-zero on an unmet quorum.
pub fn run_verify(ref_arg: Option<&str>, json: bool) -> Result<(), Box<dyn std::error::Error>> {
    let repo = crate::meta_refs::open_repo()?;
    let file = load_file(&repo)?;
    let chain = verify_chain(&file)?;
    let active = &file.policies[chain.active_index];

    let local_key = crate::refs_sign::load_repo_identity(&repo).ok();
    let report = crate::refs_sign::verify_ref(&repo, ref_arg, local_key.as_ref(), now_secs())?;
    let verdict = evaluate(active, &report);

    if json {
        let v = serde_json::json!({
            "ref": report.ref_name,
            "oid": report.oid,
            "quorum": verdict,
        });
        println!("{}", serde_json::to_string_pretty(&v)?);
    } else {
        print_verdict(&report.ref_name, &report.oid, &verdict);
    }
    if !verdict.met {
        std::process::exit(1);
    }
    Ok(())
}

pub fn print_verdict(ref_name: &str, oid: &str, v: &QuorumVerdict) {
    let label = if v.met {
        "QUORUM MET".green().bold()
    } else {
        "QUORUM NOT MET".red().bold()
    };
    let short: String = oid.chars().take(7).collect();
    println!(
        "{} {} @ {} — {} ({}/{} delegate endorsements, policy seq {})",
        "refs quorum".bold(),
        ref_name,
        short.yellow(),
        label,
        v.endorsed_by.len(),
        v.threshold,
        v.policy_seq
    );
    for d in &v.endorsed_by {
        println!("  {} {}", "✓".green(), d);
    }
    for d in &v.missing {
        println!("  {} {}", "·".dimmed(), d.dimmed());
    }
}

pub fn run(sub: &QuorumSubcommands) -> Result<(), Box<dyn std::error::Error>> {
    match sub {
        QuorumSubcommands::Init {
            threshold,
            delegates,
        } => run_init(*threshold, delegates),
        QuorumSubcommands::Show { json } => run_show(*json),
        QuorumSubcommands::Rotate {
            threshold,
            delegates,
            keep,
        } => run_rotate(*threshold, delegates, *keep),
        QuorumSubcommands::Endorse { json } => run_endorse(*json),
        QuorumSubcommands::Verify { ref_name, json } => run_verify(ref_name.as_deref(), *json),
    }
}

// ───────────────────────── tests ─────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::refs_sign::LineReport;

    fn key(seed: u8) -> SigningKey {
        SigningKey::from_seed([seed; 32])
    }

    fn delegate_of(sk: &SigningKey, name: &str) -> Delegate {
        Delegate {
            name: name.to_string(),
            key_id: sk.key_id(),
            pubkey: B64URL.encode(sk.verifying_key().to_bytes()),
        }
    }

    fn genesis(threshold: usize, keys: &[&SigningKey]) -> QuorumFile {
        let mut entry = PolicyEntry {
            seq: 0,
            threshold,
            delegates: keys
                .iter()
                .enumerate()
                .map(|(i, k)| delegate_of(k, &format!("d{}", i)))
                .collect(),
            created_at: 1_757_000_000,
            prev_hash: String::new(),
            sigs: Vec::new(),
        };
        sign_entry(&mut entry, keys[0]);
        QuorumFile {
            schema_version: 1,
            policies: vec![entry],
        }
    }

    fn valid_line(sk: &SigningKey) -> LineReport {
        LineReport {
            signer: "t".to_string(),
            key_id: sk.key_id(),
            ts: 1,
            age_secs: 0,
            status: LineStatus::Valid,
            reason: None,
        }
    }

    #[test]
    fn genesis_verifies_and_is_active() {
        let a = key(1);
        let file = genesis(1, &[&a]);
        let report = verify_chain(&file).expect("chain valid");
        assert_eq!(report.active_index, 0);
        assert!(!report.pending);
        assert!(report.entries[0].endorsed);
    }

    #[test]
    fn genesis_without_own_signature_is_rejected() {
        let a = key(1);
        let mut file = genesis(1, &[&a]);
        file.policies[0].sigs.clear();
        let err = verify_chain(&file).unwrap_err();
        assert!(err.contains("genesis"), "got: {}", err);
    }

    #[test]
    fn tampered_threshold_breaks_the_signature() {
        let a = key(1);
        let mut file = genesis(1, &[&a]);
        file.policies[0].threshold = 1; // unchanged → still fine
        verify_chain(&file).expect("untouched chain verifies");
        // Now actually tamper: bump created_at after signing.
        file.policies[0].created_at += 1;
        let err = verify_chain(&file).unwrap_err();
        assert!(err.contains("does not verify"), "got: {}", err);
    }

    #[test]
    fn forged_delegate_binding_is_rejected() {
        let a = key(1);
        let b = key(2);
        let mut file = genesis(1, &[&a]);
        // Claim b's key_id over a's pubkey.
        file.policies[0].delegates[0].key_id = b.key_id();
        let err = verify_chain(&file).unwrap_err();
        assert!(err.contains("forged binding"), "got: {}", err);
    }

    #[test]
    fn rotation_needs_the_old_quorum_then_activates() {
        let a = key(1);
        let b = key(2);
        let c = key(3);
        let mut file = genesis(2, &[&a, &b]);
        sign_entry(&mut file.policies[0], &b); // genesis endorsed by both

        // Propose: hand over to c alone, signed only by a so far.
        let last_hash = entry_hash(&file.policies[0]);
        let mut next = PolicyEntry {
            seq: 1,
            threshold: 1,
            delegates: vec![delegate_of(&c, "c")],
            created_at: 1_757_000_100,
            prev_hash: last_hash,
            sigs: Vec::new(),
        };
        sign_entry(&mut next, &a);
        file.policies.push(next);

        let report = verify_chain(&file).expect("pending chain still verifies");
        assert!(report.pending, "1 of 2 old sigs → pending");
        assert_eq!(report.active_index, 0, "old policy stays active");

        // Second old delegate endorses → active.
        let last = file.policies.last_mut().unwrap();
        sign_entry(last, &b);
        let report = verify_chain(&file).expect("chain valid");
        assert!(!report.pending);
        assert_eq!(report.active_index, 1);
    }

    #[test]
    fn signature_from_outside_the_old_quorum_carries_no_authority() {
        let a = key(1);
        let c = key(3);
        let mut file = genesis(1, &[&a]);
        let mut next = PolicyEntry {
            seq: 1,
            threshold: 1,
            delegates: vec![delegate_of(&c, "c")],
            created_at: 1_757_000_100,
            prev_hash: entry_hash(&file.policies[0]),
            sigs: Vec::new(),
        };
        sign_entry(&mut next, &c); // only the NEW delegate signed
        file.policies.push(next);
        let report = verify_chain(&file).expect("ignored sig, chain still parses");
        assert!(report.pending, "new delegate cannot authorize its own rotation");
        assert_eq!(report.active_index, 0);
    }

    #[test]
    fn broken_prev_hash_is_detected() {
        let a = key(1);
        let mut file = genesis(1, &[&a]);
        let mut next = PolicyEntry {
            seq: 1,
            threshold: 1,
            delegates: vec![delegate_of(&a, "a")],
            created_at: 1_757_000_100,
            prev_hash: "deadbeef".to_string(),
            sigs: Vec::new(),
        };
        sign_entry(&mut next, &a);
        file.policies.push(next);
        let err = verify_chain(&file).unwrap_err();
        assert!(err.contains("chain broken"), "got: {}", err);
    }

    #[test]
    fn quorum_verdict_counts_only_valid_delegate_lines() {
        let a = key(1);
        let b = key(2);
        let stranger = key(9);
        let file = genesis(2, &[&a, &b]);
        let policy = &file.policies[0];

        let report = VerifyReport {
            ref_name: "refs/heads/main".to_string(),
            oid: "0".repeat(40),
            status: crate::refs_sign::RefStatus::Valid,
            signatures: vec![valid_line(&a), valid_line(&stranger)],
        };
        let v = evaluate(policy, &report);
        assert!(!v.met, "1 delegate + 1 stranger < threshold 2");
        assert_eq!(v.endorsed_by.len(), 1);
        assert_eq!(v.missing.len(), 1);

        let report = VerifyReport {
            ref_name: "refs/heads/main".to_string(),
            oid: "0".repeat(40),
            status: crate::refs_sign::RefStatus::Valid,
            signatures: vec![valid_line(&a), valid_line(&b), valid_line(&a)],
        };
        let v = evaluate(policy, &report);
        assert!(v.met);
        assert_eq!(v.endorsed_by.len(), 2, "duplicate lines dedupe by key_id");
    }

    #[test]
    fn payload_binds_display_names() {
        let a = key(1);
        let mut file = genesis(1, &[&a]);
        file.policies[0].delegates[0].name = "impostor".to_string();
        let err = verify_chain(&file).unwrap_err();
        assert!(err.contains("does not verify"), "renamed delegate breaks the sig: {}", err);
    }
}
