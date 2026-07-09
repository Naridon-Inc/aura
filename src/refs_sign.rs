// M4b — sovereign substrate, slice 1 of SIGNED CANONICAL REFS (AURA-22).
//
// Radicle-style endorsement of a branch tip: `aura refs sign` says "this
// identity endorses ref R at commit O" in a way any peer can check
// cryptographically, and the endorsement travels as a STANDARD git note
// (refs/notes/aura-sigs) through any host — GitHub included.
//
// ── Note format ────────────────────────────────────────────────────────
// The note is attached to the COMMIT the ref points at. Content is JSON
// Lines, one object per endorsement, field order fixed by `SigLine`:
//
//   {"ref":"refs/heads/main","oid":"<40-hex>","signer":"Owner",
//    "key_id":"did:aura:key/AbCdEfGhIjk","pubkey":"<b64url-no-pad 32B>",
//    "sig":"<b64-std-no-pad 64B ed25519>","ts":1765432100}
//
// `pubkey` is the signer's FULL 32-byte Ed25519 verifying key
// (base64url, no padding — same encoding the key-rotation blocks use).
// It makes the line self-certifying: `key_id` is derived from the first
// 8 bytes of the pubkey, so a verifier checks (a) the embedded pubkey
// derives the claimed key_id and (b) the signature verifies — no key
// server needed. WHO owns a key_id is anchored out-of-band (compare
// `aura identity` output over any trusted channel).
//
// ── Signed payload (byte-for-byte) ─────────────────────────────────────
// The Ed25519 signature covers the UTF-8 bytes of EXACTLY this string —
// verifiers must reproduce it byte-for-byte:
//
//   "aura-ref-sig\n<ref>\n<oid>\n<ts>"
//
// where <ref> is the FULL ref name (e.g. refs/heads/main), <oid> is the
// full lowercase 40-hex commit id the ref resolves to, and <ts> is the
// decimal unix-seconds signing time. No trailing newline.
//
// ── Dedupe / union semantics ───────────────────────────────────────────
// Lines dedupe on (ref, oid, key_id): re-signing the same tip is
// idempotent apart from `ts`, and the newest ts wins. Foreign or
// unparsable lines are preserved verbatim (exact-line dedupe) so a
// newer client's lines are never destroyed by an older one.
//
// ── Future: delegate QUORUM (explicitly OUT of scope for slice 1) ─────
// The format already reserves room for it: a note can carry MULTIPLE
// signature lines per (ref, oid), one per key_id. A future slice adds a
// delegate set + threshold ("2-of-3 maintainers") evaluated over those
// same lines; nothing about the payload or note layout changes. Slice 1
// is single-signer: ≥1 cryptographically valid line ⇒ VALID.
//
// ── Identity ───────────────────────────────────────────────────────────
// Signing reuses the repo-local awareness identity (the same Ed25519
// keypair that signs `aura radar` events): seed at
// `.aura/awareness/identity.key`, created by `aura identity`.
// `refs sign` LOADS strictly and never mints a key silently — if no
// identity exists it fails with guidance to run `aura identity`.
//
// Local note plumbing is git2; the `git` binary is shelled out ONLY for
// transport (push/fetch of the notes ref), exactly like `aura meta`.

use clap::Subcommand;
use colored::Colorize;
use git2::{Oid, Repository};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use aura_attestation::{SignatureBytes, SigningKey, VerifyingKey};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64URL, Engine};

use crate::meta_refs::notes::{note_body, signature};
use crate::meta_refs::{git_transport, open_repo, repo_dir};

#[cfg(test)]
#[path = "refs_sign_tests.rs"]
mod tests;

/// The endorsement plane. Plain `git push origin refs/notes/aura-sigs`
/// round-trips it through any host.
pub const SIGS_REF: &str = "refs/notes/aura-sigs";

/// Staging ref `aura refs pull` fetches into before union-merging, so a
/// diverged remote never clobbers local endorsements. Deleted after merge.
pub const SIGS_INCOMING_REF: &str = "refs/notes/aura-sigs-incoming";

/// Domain-separation tag — first line of every signed payload.
pub const PAYLOAD_TAG: &str = "aura-ref-sig";

/// The EXACT byte string an endorsement signs. Verifiers reproduce this
/// byte-for-byte; see the module docs for the field definitions.
pub fn signing_payload(ref_name: &str, oid: &str, ts: u64) -> String {
    format!("{}\n{}\n{}\n{}", PAYLOAD_TAG, ref_name, oid, ts)
}

/// One JSON line inside an aura-sigs note. Field order is fixed by this
/// struct so serialisation is deterministic across machines.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SigLine {
    /// Full ref name, e.g. `refs/heads/main`.
    #[serde(rename = "ref")]
    pub ref_name: String,
    /// Full lowercase 40-hex commit id the ref pointed at when signed.
    pub oid: String,
    /// Display name of the signer (git user.name at signing time).
    pub signer: String,
    /// `did:aura:key/...` — derived from the first 8 bytes of the pubkey.
    pub key_id: String,
    /// Full 32-byte Ed25519 verifying key, base64url no-pad. Optional in
    /// the parser for forward-compat, but always written by this slice —
    /// without it peers can't verify (key_id alone is truncated).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pubkey: Option<String>,
    /// Base64 (std, no pad) Ed25519 signature over [`signing_payload`].
    pub sig: String,
    /// Unix seconds at signing time.
    pub ts: u64,
}

/// Canonical single-line rendering. The fallback keeps a broken row
/// visible to `parse_sig_line` (which rejects it) instead of panicking.
pub fn render_sig_line(line: &SigLine) -> String {
    serde_json::to_string(line).unwrap_or_else(|_| "{}".to_string())
}

/// Parse one note line. Tolerant of unknown extra fields and a missing
/// `pubkey` (older/foreign writers); returns None for blank / non-JSON /
/// structurally incomplete lines so they fall through to verbatim
/// preservation in the union.
pub fn parse_sig_line(line: &str) -> Option<SigLine> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    let v: serde_json::Value = serde_json::from_str(line).ok()?;
    let s = |k: &str| v.get(k).and_then(|x| x.as_str()).map(|x| x.to_string());
    Some(SigLine {
        ref_name: s("ref")?,
        oid: s("oid")?,
        signer: s("signer").unwrap_or_else(|| "unknown".to_string()),
        key_id: s("key_id")?,
        pubkey: s("pubkey"),
        sig: s("sig")?,
        ts: v.get("ts").and_then(|t| t.as_u64())?,
    })
}

// ───────────────────────── union merge ─────────────────────────

struct UnionEntry {
    raw: String,
    ts: u64,
}

fn absorb_line(
    raw: &str,
    counting: bool,
    order: &mut Vec<UnionEntry>,
    by_key: &mut HashMap<(String, String, String), usize>,
    exact: &mut HashSet<String>,
    changed: &mut usize,
) {
    let l = raw.trim();
    if l.is_empty() {
        return;
    }
    match parse_sig_line(l) {
        Some(p) => {
            let key = (p.ref_name, p.oid, p.key_id);
            match by_key.get(&key) {
                Some(&i) => {
                    // Same (ref, oid, key_id): newest ts wins, in place.
                    if p.ts > order[i].ts && order[i].raw != l {
                        order[i].raw = l.to_string();
                        order[i].ts = p.ts;
                        if counting {
                            *changed += 1;
                        }
                    }
                }
                None => {
                    by_key.insert(key, order.len());
                    order.push(UnionEntry {
                        raw: l.to_string(),
                        ts: p.ts,
                    });
                    if counting {
                        *changed += 1;
                    }
                }
            }
        }
        None => {
            // Foreign/unparsable line: preserve verbatim, exact dedupe.
            if exact.insert(l.to_string()) {
                order.push(UnionEntry {
                    raw: l.to_string(),
                    ts: 0,
                });
                if counting {
                    *changed += 1;
                }
            }
        }
    }
}

/// Union of an existing note body and new raw lines. Parsable lines
/// dedupe on (ref, oid, key_id) with newest-ts-wins replacement in
/// place; unparsable lines dedupe on the exact string. Returns the
/// merged body and how many of the additions changed it.
pub fn union_sig_lines(existing: Option<&str>, additions: &[String]) -> (String, usize) {
    let mut order: Vec<UnionEntry> = Vec::new();
    let mut by_key: HashMap<(String, String, String), usize> = HashMap::new();
    let mut exact: HashSet<String> = HashSet::new();
    let mut changed = 0usize;

    if let Some(body) = existing {
        for raw in body.lines() {
            absorb_line(raw, false, &mut order, &mut by_key, &mut exact, &mut changed);
        }
    }
    for raw in additions {
        absorb_line(raw, true, &mut order, &mut by_key, &mut exact, &mut changed);
    }

    let mut body = order
        .iter()
        .map(|e| e.raw.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    if !body.is_empty() {
        body.push('\n');
    }
    (body, changed)
}

/// Union-merge `additions` into the aura-sigs note on `commit`. Writes
/// only when something actually changed; returns the change count.
pub fn write_sig_note(
    repo: &Repository,
    commit: Oid,
    additions: &[String],
) -> Result<usize, Box<dyn std::error::Error>> {
    let current = note_body(repo, SIGS_REF, commit);
    let (merged, changed) = union_sig_lines(current.as_deref(), additions);
    if changed > 0 {
        let sig = signature(repo);
        repo.note(&sig, &sig, Some(SIGS_REF), commit, &merged, true)?;
    }
    Ok(changed)
}

// ───────────────────────── identity ─────────────────────────

/// The repo-local awareness identity keyfile — the SAME path
/// `awareness::identity` uses (`aura identity` / radar event signing),
/// anchored at the repo workdir so `aura refs` behaves identically from
/// any subdirectory.
pub fn identity_key_path(repo: &Repository) -> PathBuf {
    let root = repo
        .workdir()
        .map(|w| w.to_path_buf())
        .unwrap_or_else(|| repo.path().to_path_buf());
    root.join(".aura").join("awareness").join("identity.key")
}

/// Strictly LOAD the repo-local signing identity. Unlike the awareness
/// emit path (which creates one on first use so events are never lost),
/// `refs sign` must never mint a key silently: an endorsement from an
/// identity nobody has ever seen is worthless. Missing keyfile ⇒ error
/// with the existing creation guidance (`aura identity`).
pub fn load_repo_identity(repo: &Repository) -> Result<SigningKey, String> {
    let path = identity_key_path(repo);
    match aura_attestation::load_signing_key(&path) {
        Ok(k) => Ok(k),
        Err(aura_attestation::AttestationError::Io(e))
            if e.kind() == std::io::ErrorKind::NotFound =>
        {
            Err(format!(
                "no signing identity at {} — run `aura identity` in this repo to create one (it also signs your radar events); `aura refs sign` never generates keys silently",
                path.display()
            ))
        }
        Err(e) => Err(format!(
            "signing identity at {} is unreadable: {}",
            path.display(),
            e
        )),
    }
}

// ───────────────────────── ref resolution ─────────────────────────

/// Resolve the ref to endorse/verify: explicit `--ref` (short or full
/// name) or the current branch. The returned OID is the COMMIT the ref
/// resolves to — that commit is where the note attaches.
fn resolve_ref(
    repo: &Repository,
    ref_arg: Option<&str>,
) -> Result<(String, Oid), Box<dyn std::error::Error>> {
    let reference = match ref_arg {
        Some(name) => {
            if name.starts_with("refs/") {
                repo.find_reference(name)
                    .map_err(|e| format!("ref '{}' not found ({})", name, e.message()))?
            } else {
                repo.resolve_reference_from_short_name(name)
                    .map_err(|e| format!("ref '{}' not found ({})", name, e.message()))?
            }
        }
        None => {
            let head = repo
                .head()
                .map_err(|e| format!("cannot resolve HEAD ({})", e.message()))?;
            if !head.is_branch() {
                return Err(
                    "HEAD is detached — pass --ref <branch> to name the ref you mean".into(),
                );
            }
            head
        }
    };
    let full = reference
        .name()
        .ok_or("ref name is not valid UTF-8")?
        .to_string();
    let commit = reference.peel_to_commit().map_err(|e| {
        format!(
            "ref '{}' does not point at a commit ({})",
            full,
            e.message()
        )
    })?;
    Ok((full, commit.id()))
}

// ───────────────────────── sign ─────────────────────────

#[derive(Debug, Serialize)]
pub struct SignReport {
    pub ref_name: String,
    pub oid: String,
    pub key_id: String,
    /// False when this exact (ref, oid, key_id) was already endorsed at
    /// an equal-or-newer ts — i.e. the call was an idempotent no-op.
    pub updated: bool,
}

/// Endorse `ref_arg` (default: current branch) at its current tip with
/// `sk`. Appends/updates one [`SigLine`] in the aura-sigs note on the
/// tip commit, deduped on (ref, oid, key_id) with newest ts winning.
pub fn sign_ref(
    repo: &Repository,
    ref_arg: Option<&str>,
    sk: &SigningKey,
    signer: &str,
    ts: u64,
) -> Result<SignReport, Box<dyn std::error::Error>> {
    let (ref_name, oid) = resolve_ref(repo, ref_arg)?;
    let oid_hex = oid.to_string();

    let payload = signing_payload(&ref_name, &oid_hex, ts);
    let sig_b64 = sk.sign(payload.as_bytes()).to_b64();
    let line = SigLine {
        ref_name: ref_name.clone(),
        oid: oid_hex.clone(),
        signer: signer.to_string(),
        key_id: sk.key_id(),
        pubkey: Some(B64URL.encode(sk.verifying_key().to_bytes())),
        sig: sig_b64,
        ts,
    };

    let changed = write_sig_note(repo, oid, &[render_sig_line(&line)])?;
    Ok(SignReport {
        ref_name,
        oid: oid_hex,
        key_id: sk.key_id(),
        updated: changed > 0,
    })
}

// ───────────────────────── verify ─────────────────────────

/// Per-line verification outcome.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LineStatus {
    /// Signature verifies against the resolved public key.
    Valid,
    /// The crypto check FAILED: bad signature, or a pubkey that does not
    /// derive the claimed key_id (a forged binding).
    Invalid,
    /// The signer's public key could not be resolved at all — distinct
    /// from Invalid: nothing failed, we just can't check.
    UnknownKey,
}

#[derive(Debug, Serialize)]
pub struct LineReport {
    pub signer: String,
    pub key_id: String,
    pub ts: u64,
    pub age_secs: u64,
    pub status: LineStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// Overall ref verdict. Slice-1 (single-signer) semantics:
/// ≥1 valid line ⇒ Valid; else ≥1 crypto failure ⇒ Invalid; else lines
/// exist but no key was resolvable ⇒ UnknownKey; else ⇒ Unsigned.
/// (UnknownKey is the spec'd "unknown key" status surfaced at ref level
/// when it is the ONLY story — it never masks a real Invalid.)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RefStatus {
    Valid,
    Invalid,
    UnknownKey,
    Unsigned,
}

impl RefStatus {
    pub fn label(&self) -> &'static str {
        match self {
            RefStatus::Valid => "VALID",
            RefStatus::Invalid => "INVALID",
            RefStatus::UnknownKey => "UNKNOWN KEY",
            RefStatus::Unsigned => "UNSIGNED",
        }
    }
}

#[derive(Debug, Serialize)]
pub struct VerifyReport {
    #[serde(rename = "ref")]
    pub ref_name: String,
    pub oid: String,
    pub status: RefStatus,
    pub signatures: Vec<LineReport>,
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

/// Check one line. Public-key resolution order — exactly the stores the
/// existing identity machinery has (there is NO peer-key registry yet):
///   1. the pubkey embedded in the line itself (self-certifying: must
///      derive the claimed key_id, else Invalid);
///   2. the LOCAL identity keyfile, when the line's key_id matches it;
///   3. otherwise UnknownKey.
fn check_line(line: &SigLine, local_key: Option<&SigningKey>, now: u64) -> LineReport {
    let base = |status: LineStatus, reason: Option<String>| LineReport {
        signer: line.signer.clone(),
        key_id: line.key_id.clone(),
        ts: line.ts,
        age_secs: now.saturating_sub(line.ts),
        status,
        reason,
    };

    let vk = if let Some(pk) = &line.pubkey {
        match decode_pubkey(pk) {
            Ok(vk) => {
                if vk.key_id() != line.key_id {
                    return base(
                        LineStatus::Invalid,
                        Some(format!(
                            "embedded pubkey derives {} but the line claims {}",
                            vk.key_id(),
                            line.key_id
                        )),
                    );
                }
                vk
            }
            Err(e) => {
                return base(
                    LineStatus::UnknownKey,
                    Some(format!("embedded pubkey unparsable: {}", e)),
                )
            }
        }
    } else if let Some(sk) = local_key.filter(|sk| sk.key_id() == line.key_id) {
        sk.verifying_key()
    } else {
        return base(
            LineStatus::UnknownKey,
            Some("no embedded pubkey and key_id does not match the local identity".to_string()),
        );
    };

    let payload = signing_payload(&line.ref_name, &line.oid, line.ts);
    let sig = match SignatureBytes::from_b64(&line.sig) {
        Ok(s) => s,
        Err(e) => {
            return base(
                LineStatus::Invalid,
                Some(format!("malformed signature: {}", e)),
            )
        }
    };
    match vk.verify(payload.as_bytes(), &sig) {
        Ok(()) => base(LineStatus::Valid, None),
        Err(_) => base(
            LineStatus::Invalid,
            Some("signature does not verify over the canonical payload".to_string()),
        ),
    }
}

/// Verify every endorsement of `ref_arg` at its CURRENT tip. Lines for
/// other refs (or for a tip the branch has since moved past) do not
/// count — a moved branch reads as Unsigned by design.
pub fn verify_ref(
    repo: &Repository,
    ref_arg: Option<&str>,
    local_key: Option<&SigningKey>,
    now: u64,
) -> Result<VerifyReport, Box<dyn std::error::Error>> {
    let (ref_name, oid) = resolve_ref(repo, ref_arg)?;
    let oid_hex = oid.to_string();

    let mut signatures = Vec::new();
    if let Some(body) = note_body(repo, SIGS_REF, oid) {
        for raw in body.lines() {
            let Some(line) = parse_sig_line(raw) else {
                continue;
            };
            if line.ref_name != ref_name || line.oid != oid_hex {
                continue;
            }
            signatures.push(check_line(&line, local_key, now));
        }
    }

    let status = if signatures.iter().any(|l| l.status == LineStatus::Valid) {
        RefStatus::Valid
    } else if signatures.iter().any(|l| l.status == LineStatus::Invalid) {
        RefStatus::Invalid
    } else if !signatures.is_empty() {
        RefStatus::UnknownKey
    } else {
        RefStatus::Unsigned
    };

    Ok(VerifyReport {
        ref_name,
        oid: oid_hex,
        status,
        signatures,
    })
}

// ───────────────────────── transport ─────────────────────────

#[derive(Debug, Serialize)]
pub struct SigPullReport {
    /// False when the remote has no aura-sigs ref yet.
    pub incoming_present: bool,
    pub commits_seen: usize,
    pub commits_updated: usize,
    pub lines_changed: usize,
}

/// Union-merge refs/notes/aura-sigs-incoming into the local aura-sigs
/// ref, then delete the staging ref. Same shape as the meta pull merge,
/// but with sig-line semantics ((ref,oid,key_id) dedupe, newest ts wins).
pub fn merge_incoming_sigs(
    repo: &Repository,
) -> Result<SigPullReport, Box<dyn std::error::Error>> {
    let incoming: Vec<Oid> = match repo.notes(Some(SIGS_INCOMING_REF)) {
        Ok(notes) => notes.flatten().map(|(_, annotated)| annotated).collect(),
        Err(_) => {
            return Ok(SigPullReport {
                incoming_present: false,
                commits_seen: 0,
                commits_updated: 0,
                lines_changed: 0,
            });
        }
    };

    let mut commits_updated = 0usize;
    let mut lines_changed = 0usize;
    for annotated in &incoming {
        let Some(theirs) = note_body(repo, SIGS_INCOMING_REF, *annotated) else {
            continue;
        };
        let their_lines: Vec<String> = theirs
            .lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .collect();
        let changed = write_sig_note(repo, *annotated, &their_lines)?;
        if changed > 0 {
            commits_updated += 1;
            lines_changed += changed;
        }
    }

    if let Ok(mut staging) = repo.find_reference(SIGS_INCOMING_REF) {
        staging.delete()?;
    }

    Ok(SigPullReport {
        incoming_present: true,
        commits_seen: incoming.len(),
        commits_updated,
        lines_changed,
    })
}

// ───────────────────────── CLI ─────────────────────────

#[derive(Subcommand)]
pub enum RefsSubcommands {
    /// Endorse a ref's current tip with your repo-local Ed25519 identity.
    /// The endorsement lands as a line in the refs/notes/aura-sigs note
    /// on the tip commit. Default ref: the current branch.
    Sign {
        /// Ref to endorse (short or full name). Default: current branch.
        #[arg(long = "ref")]
        ref_name: Option<String>,
    },
    /// Verify every endorsement of a ref at its CURRENT tip. Exits 0
    /// only when at least one signature is cryptographically VALID.
    Verify {
        /// Ref to verify (short or full name). Default: current branch.
        #[arg(long = "ref")]
        ref_name: Option<String>,
        #[arg(long)]
        json: bool,
    },
    /// Push refs/notes/aura-sigs to the remote.
    Push {
        #[arg(long, default_value = "origin")]
        remote: String,
        #[arg(long)]
        json: bool,
    },
    /// Fetch the remote's aura-sigs notes and union-merge them into the
    /// local ref. Never overwrites — merge is a union of endorsements.
    Pull {
        #[arg(long, default_value = "origin")]
        remote: String,
        #[arg(long)]
        json: bool,
    },
}

pub fn run(sub: &RefsSubcommands) -> Result<(), Box<dyn std::error::Error>> {
    match sub {
        RefsSubcommands::Sign { ref_name } => run_sign(ref_name.as_deref()),
        RefsSubcommands::Verify { ref_name, json } => run_verify(ref_name.as_deref(), *json),
        RefsSubcommands::Push { remote, json } => run_push(remote, *json),
        RefsSubcommands::Pull { remote, json } => run_pull(remote, *json),
    }
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn short(oid: &str) -> String {
    oid.chars().take(7).collect()
}

fn age_str(secs: u64) -> String {
    if secs < 60 {
        format!("{}s ago", secs)
    } else if secs < 3600 {
        format!("{}m ago", secs / 60)
    } else if secs < 86_400 {
        format!("{}h ago", secs / 3600)
    } else {
        format!("{}d ago", secs / 86_400)
    }
}

fn run_sign(ref_arg: Option<&str>) -> Result<(), Box<dyn std::error::Error>> {
    let repo = open_repo()?;
    let sk = load_repo_identity(&repo)?;
    let signer = crate::live_events::git_user();
    let report = sign_ref(&repo, ref_arg, &sk, &signer, now_secs())?;

    println!(
        "{} {} @ {} · {}",
        "refs sign".bold(),
        report.ref_name,
        short(&report.oid).yellow(),
        report.key_id.green(),
    );
    if !report.updated {
        println!(
            "  {} already endorsed at this tip by this key (idempotent)",
            "·".dimmed()
        );
    }
    Ok(())
}

fn run_verify(ref_arg: Option<&str>, json: bool) -> Result<(), Box<dyn std::error::Error>> {
    let repo = open_repo()?;
    // Strict load only — verify must work (and report UnknownKey
    // honestly) on a machine with no identity at all.
    let local_key = load_repo_identity(&repo).ok();
    let report = verify_ref(&repo, ref_arg, local_key.as_ref(), now_secs())?;

    if json {
        println!("{}", serde_json::to_string_pretty(&report)?);
    } else {
        let label = match report.status {
            RefStatus::Valid => report.status.label().green().bold(),
            RefStatus::Invalid => report.status.label().red().bold(),
            RefStatus::UnknownKey => report.status.label().yellow().bold(),
            RefStatus::Unsigned => report.status.label().dimmed().bold(),
        };
        println!(
            "{} {} @ {} — {}",
            "refs verify".bold(),
            report.ref_name,
            short(&report.oid).yellow(),
            label,
        );
        for line in &report.signatures {
            let (glyph, reason) = match line.status {
                LineStatus::Valid => ("✓".green().to_string(), String::new()),
                LineStatus::Invalid => (
                    "✗".red().to_string(),
                    line.reason.clone().unwrap_or_default(),
                ),
                LineStatus::UnknownKey => (
                    "?".yellow().to_string(),
                    line.reason.clone().unwrap_or_default(),
                ),
            };
            print!(
                "  {} {} · {} · signed {}",
                glyph,
                line.signer.bold(),
                line.key_id,
                age_str(line.age_secs)
            );
            if reason.is_empty() {
                println!();
            } else {
                println!(" · {}", reason.dimmed());
            }
        }
        if report.signatures.is_empty() {
            println!(
                "  {} no aura-sigs note for this tip — branch moved since signing, or never signed",
                "·".dimmed()
            );
        }
    }

    if report.status != RefStatus::Valid {
        std::process::exit(1);
    }
    Ok(())
}

fn run_push(remote: &str, json: bool) -> Result<(), Box<dyn std::error::Error>> {
    let repo = open_repo()?;
    let ref_exists = repo.find_reference(SIGS_REF).is_ok();
    let mut pushed = false;
    let mut push_error: Option<String> = None;
    if ref_exists {
        let dir = repo_dir(&repo);
        match git_transport(&dir, &["push", remote, SIGS_REF]) {
            Ok(_) => pushed = true,
            Err(e) => push_error = Some(e),
        }
    }

    if json {
        let mut v = serde_json::json!({
            "pushed": pushed,
            "remote": remote,
            "notes_ref": SIGS_REF,
            "ref_exists": ref_exists,
        });
        if let Some(e) = &push_error {
            v["push_error"] = serde_json::json!(e);
        }
        println!("{}", serde_json::to_string_pretty(&v)?);
    } else if pushed {
        println!(
            "{} {} → {}",
            "refs push".bold(),
            SIGS_REF,
            remote
        );
    } else if !ref_exists {
        println!(
            "{} nothing to push — no {} ref yet (run `aura refs sign` first)",
            "refs push".bold(),
            SIGS_REF
        );
    }

    if let Some(e) = push_error {
        return Err(format!(
            "push of {} to '{}' failed: {}\nhint: run `aura refs pull --remote {}` to merge the remote's endorsements first, then push again",
            SIGS_REF, remote, e, remote
        )
        .into());
    }
    Ok(())
}

fn run_pull(remote: &str, json: bool) -> Result<(), Box<dyn std::error::Error>> {
    let repo = open_repo()?;
    let dir = repo_dir(&repo);

    // Force refspec into the staging ref: a rewritten remote ref must
    // still land so the union-merge can reconcile it.
    let refspec = format!("+{}:{}", SIGS_REF, SIGS_INCOMING_REF);
    let mut remote_missing = false;
    if let Err(e) = git_transport(&dir, &["fetch", remote, &refspec]) {
        let lowered = e.to_lowercase();
        if lowered.contains("couldn't find remote ref")
            || lowered.contains("could not find remote ref")
        {
            remote_missing = true;
        } else {
            return Err(format!(
                "fetch of {} from '{}' failed: {}",
                SIGS_REF, remote, e
            )
            .into());
        }
    }

    let report = if remote_missing {
        SigPullReport {
            incoming_present: false,
            commits_seen: 0,
            commits_updated: 0,
            lines_changed: 0,
        }
    } else {
        merge_incoming_sigs(&repo)?
    };

    if json {
        let mut v = serde_json::to_value(&report)?;
        v["remote"] = serde_json::json!(remote);
        v["notes_ref"] = serde_json::json!(SIGS_REF);
        println!("{}", serde_json::to_string_pretty(&v)?);
    } else if !report.incoming_present {
        println!(
            "{} no {} on '{}' yet — nothing to merge",
            "refs pull".bold(),
            SIGS_REF,
            remote
        );
    } else {
        println!(
            "{} {} noted commit(s) fetched · {} updated · {} endorsement(s) merged",
            "refs pull".bold(),
            report.commits_seen,
            report.commits_updated,
            report.lines_changed,
        );
    }
    Ok(())
}
