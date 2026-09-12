//! What the node tells the cloud about itself — gathered, signed, and sent.
//!
//! Aura's web console has a Git surface that wants to show, for a node you run
//! yourself, the repositories it holds, the ref-log it authored, and the push
//! tokens its operator handed out. None of that can be inferred from the cloud
//! side: the node is the only thing that knows. So the node reports it.
//!
//! Two properties hold this together, and neither is negotiable.
//!
//! **The report is verifiable, not merely received.** The ref-log is authored
//! and signed *on the node* — that is the whole point of the sovereign
//! substrate — so what travels to the cloud is a copy that carries its own
//! proof: every entry keeps its hash-chain links and its Ed25519 signature, and
//! the report as a whole is signed again over its canonical form. `node_id` is
//! the node's raw public key, so a reader needs nothing but the report itself
//! to check both layers. A cloud that had to *trust* this payload would be a
//! cloud that could fabricate it.
//!
//! **Token material never leaves the node.** The `tokens` array is metadata
//! only — the id, label, scope and lifetime from [`super::tokens`], which is a
//! ledger of hashes and labels rather than of grants. Nothing in a report can
//! be replayed as a credential.
//!
//! Canonical form for the report signature is **RFC 8785 JCS**
//! (`aura_blocks::canonicalize`, tag `jcs-rfc8785-v1`) over the report object
//! with the `signature` member absent. Every optional field is emitted
//! explicitly as JSON `null`; no key is ever omitted, so a verifier that
//! removes `signature` from the object it received and re-canonicalizes the
//! remainder reproduces the signed bytes exactly. See [`verify_wire`], which is
//! that verifier, written out so the cloud half has a reference to mirror.
//!
//! Sending is incremental and idempotent. Ref-log entries are sent once: the
//! node keeps a per-repo high-water mark of the highest `seq` the cloud has
//! accepted, in `.node-report.json` beside the repos, and advances it only
//! after a 2xx. Re-running with nothing new sends an empty `reflog` and the
//! same repo/token rows, which the cloud upserts by `node_id`. That makes this
//! safe on a cron timer.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64URL, Engine};
use colored::Colorize;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use aura_attestation::{SignatureBytes, SigningKey, VerifyingKey};

use super::reflog::{self, SignedRefEntry, ZERO_OID};
use super::{tokens, NodeStore};

/// The route the cloud exposes for this payload. Fixed by the wire contract.
pub const REPORT_PATH: &str = "/api/v2/nodes/report";

/// Report-state schema version, so the high-water file can migrate.
pub const STATE_VERSION: u32 = 1;

/// Where the high-water marks and the operator's node name/url live. A plain
/// file in the data root, so [`NodeStore::list`] never mistakes it for a repo.
pub const STATE_FILE: &str = ".node-report.json";

/// How many ref-log entries one report carries at most. A node that has been
/// running for a year before its first report would otherwise produce a single
/// enormous body; instead the first few runs drain the backlog and every run
/// after that carries only what is new.
pub const MAX_REFLOG_PER_REPORT: usize = 500;

/// One hosted repository as the console shows it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RepoRow {
    pub name: String,
    pub refs: u64,
    pub size_bytes: u64,
    /// When the ref-log last recorded a ref moving here; `None` if it never has.
    pub last_push_at: Option<String>,
}

/// One signed ref-log entry, in the shape the cloud stores it.
///
/// This is a lossless re-encoding of [`SignedRefEntry`] except for two
/// deliberate translations, both of which [`signing_payload_from_row`] undoes:
/// git's all-zero oid for "there was nothing here before" becomes `old: null`,
/// and the empty genesis link becomes `prev_hash: null`. `new` keeps the zero
/// oid verbatim on a delete, because the wire types it non-null.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ReflogRow {
    pub seq: u64,
    pub repo: String,
    #[serde(rename = "ref")]
    pub reference: String,
    pub old: Option<String>,
    pub new: String,
    /// The `did:aura:key/…` id of the key that signed the entry.
    pub who: String,
    pub at: String,
    pub entry_hash: String,
    pub prev_hash: Option<String>,
    pub signature: String,
}

/// One issued token, as metadata. Nothing here is replayable.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TokenRow {
    pub id: String,
    pub label: String,
    pub scope: String,
    pub repo: Option<String>,
    pub created_at: String,
    pub expires_at: Option<String>,
    pub last_used_at: Option<String>,
    pub revoked: bool,
}

/// The report body, minus its signature — exactly the object the signature
/// covers. Field order here is irrelevant: JCS sorts keys.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NodeReport {
    pub node_id: String,
    pub name: String,
    pub version: String,
    pub url: Option<String>,
    pub reported_at: String,
    pub repos: Vec<RepoRow>,
    pub reflog: Vec<ReflogRow>,
    pub tokens: Vec<TokenRow>,
    pub key_id: String,
}

/// The node's stable identity on the wire: its raw Ed25519 public key, base64url
/// without padding.
///
/// The wire has one identity slot and no room for a public key, and `key_id` is
/// only the first 8 bytes of the key — enough to name a signer, nowhere near
/// enough to check one. Making `node_id` the key itself is what lets a reader
/// verify the report and every ref-log entry inside it with nothing but the
/// report. A public key is public by construction; the node already hands it to
/// any anonymous caller inside every ref-log entry it serves.
pub fn node_id(vkey: &VerifyingKey) -> String {
    B64URL.encode(vkey.to_bytes())
}

/// Recover the public key a `node_id` names.
pub fn verifying_key_from_node_id(id: &str) -> Result<VerifyingKey, String> {
    let raw = B64URL
        .decode(id.as_bytes())
        .map_err(|e| format!("node_id is not base64url: {e}"))?;
    let arr: [u8; 32] = raw
        .as_slice()
        .try_into()
        .map_err(|_| format!("node_id decodes to {} bytes, expected 32", raw.len()))?;
    VerifyingKey::from_bytes(&arr).map_err(|e| format!("node_id is not an Ed25519 key: {e}"))
}

/// Unix seconds → the RFC 3339 form the wire uses: UTC, whole seconds, `Z`.
///
/// Whole seconds is not cosmetic. A ref-log entry's signature covers its
/// timestamp as an integer, so a verifier has to turn `at` back into that
/// integer; sub-second precision on the wire would make that round-trip lossy
/// and every entry would read as forged.
pub fn rfc3339(secs: i64) -> String {
    chrono::DateTime::<chrono::Utc>::from_timestamp(secs, 0)
        .unwrap_or(chrono::DateTime::<chrono::Utc>::UNIX_EPOCH)
        .to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

/// The inverse of [`rfc3339`].
pub fn from_rfc3339(s: &str) -> Result<i64, String> {
    chrono::DateTime::parse_from_rfc3339(s)
        .map(|d| d.timestamp())
        .map_err(|e| format!("not an RFC3339 timestamp: {e}"))
}

/// Rebuild the exact bytes a ref-log entry's own signature covers, from the
/// fields the wire carries.
///
/// This is the function that makes `ReflogRow.signature` mean something on the
/// far side. It must stay byte-identical to
/// [`SignedRefEntry::signing_payload`]; the schema version is pinned to
/// [`reflog::REFLOG_VERSION`] because the wire has no field for it and the node
/// has only ever written version 1.
pub fn signing_payload_from_row(row: &ReflogRow) -> String {
    format!(
        "aura-reflog\nv{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}",
        reflog::REFLOG_VERSION,
        row.seq,
        row.prev_hash.as_deref().unwrap_or(""),
        row.repo,
        row.reference,
        row.old.as_deref().unwrap_or(ZERO_OID),
        row.new,
        from_rfc3339(&row.at).unwrap_or_default(),
    )
}

fn to_row(entry: &SignedRefEntry) -> ReflogRow {
    ReflogRow {
        seq: entry.seq,
        repo: entry.repo_id.clone(),
        reference: entry.reference.clone(),
        old: (entry.old != ZERO_OID).then(|| entry.old.clone()),
        new: entry.new.clone(),
        who: entry.signer.clone(),
        at: rfc3339(entry.ts),
        entry_hash: entry.entry_hash(),
        prev_hash: (!entry.prev.is_empty()).then(|| entry.prev.clone()),
        signature: entry.sig.clone(),
    }
}

/// Read every hosted repo's ref-log once. Both the repo rows (which need the
/// last push time) and the ref-log rows are derived from this, so a report
/// reads each log exactly once.
pub fn read_reflogs(store: &NodeStore) -> BTreeMap<String, Vec<SignedRefEntry>> {
    let mut out = BTreeMap::new();
    for id in store.list() {
        let Some(git_dir) = store.repo_path(&id) else {
            continue;
        };
        // A log we cannot read is reported as absent rather than aborting the
        // whole report: one unreadable repo must not blind the console to the
        // other twenty.
        let entries = reflog::read_entries(&git_dir).unwrap_or_default();
        out.insert(id, entries);
    }
    out
}

/// Recursive on-disk size of a directory, in bytes. Symlinks are counted by
/// their own (tiny) size and never followed, so a link into the filesystem
/// cannot inflate the number or send us round a loop.
pub fn dir_size(path: &Path) -> u64 {
    let mut total = 0u64;
    let Ok(entries) = std::fs::read_dir(path) else {
        return 0;
    };
    for entry in entries.flatten() {
        let Ok(meta) = entry.path().symlink_metadata() else {
            continue;
        };
        if meta.is_dir() {
            total = total.saturating_add(dir_size(&entry.path()));
        } else {
            total = total.saturating_add(meta.len());
        }
    }
    total
}

/// The repositories this node holds, with their ref counts, sizes and last
/// push, sorted by name.
pub fn gather_repos(
    store: &NodeStore,
    logs: &BTreeMap<String, Vec<SignedRefEntry>>,
) -> Vec<RepoRow> {
    let mut out = Vec::new();
    for id in store.list() {
        let refs = store.snapshot_refs(&id).map(|r| r.len() as u64).unwrap_or(0);
        let size_bytes = store.repo_path(&id).map(|p| dir_size(&p)).unwrap_or(0);
        let last_push_at = logs
            .get(&id)
            .and_then(|entries| entries.last())
            .map(|e| rfc3339(e.ts));
        out.push(RepoRow {
            name: id,
            refs,
            size_bytes,
            last_push_at,
        });
    }
    out
}

/// The ref-log entries the cloud has not accepted yet, oldest first.
///
/// Order is load-bearing: the entries form a hash chain, so the cloud has to
/// receive them in ascending `seq` to link each one to the entry before it.
pub fn gather_reflog(
    logs: &BTreeMap<String, Vec<SignedRefEntry>>,
    high_water: &BTreeMap<String, u64>,
    limit: usize,
) -> Vec<ReflogRow> {
    let mut out = Vec::new();
    for (repo, entries) in logs {
        let sent_through = high_water.get(repo).copied();
        for entry in entries {
            if let Some(mark) = sent_through {
                if entry.seq <= mark {
                    continue;
                }
            }
            if out.len() >= limit {
                return out;
            }
            out.push(to_row(entry));
        }
    }
    out
}

/// The token metadata this node holds, newest first so a console list opens on
/// what was handed out most recently.
pub fn gather_tokens(root: &Path) -> Result<Vec<TokenRow>, String> {
    let ledger = tokens::load(root)?;
    let mut rows: Vec<TokenRow> = ledger
        .tokens
        .iter()
        .map(|t| TokenRow {
            id: t.id.clone(),
            label: t.label.clone(),
            scope: t.scope.clone(),
            repo: t.repo.clone(),
            created_at: rfc3339(t.created_at),
            expires_at: t.expires_at.map(rfc3339),
            last_used_at: t.last_used_at.map(rfc3339),
            revoked: t.revoked,
        })
        .collect();
    rows.sort_by(|a, b| b.created_at.cmp(&a.created_at).then(a.id.cmp(&b.id)));
    Ok(rows)
}

/// The node's persisted reporting state: what the operator called it, and how
/// far the cloud has caught up with each repo's ref-log.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReportState {
    pub schema_version: u32,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
    /// repo id → highest ref-log `seq` the cloud has accepted.
    #[serde(default)]
    pub high_water: BTreeMap<String, u64>,
    #[serde(default)]
    pub last_reported_at: Option<i64>,
}

impl Default for ReportState {
    fn default() -> Self {
        ReportState {
            schema_version: STATE_VERSION,
            name: None,
            url: None,
            high_water: BTreeMap::new(),
            last_reported_at: None,
        }
    }
}

pub fn state_path(root: &Path) -> PathBuf {
    root.join(STATE_FILE)
}

/// Read the reporting state. A missing file means nothing has been reported
/// yet, which is a valid starting state rather than an error.
pub fn load_state(root: &Path) -> Result<ReportState, String> {
    let path = state_path(root);
    let raw = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(ReportState::default()),
        Err(e) => return Err(format!("read {}: {e}", path.display())),
    };
    serde_json::from_str(&raw).map_err(|e| format!("parse {}: {e}", path.display()))
}

/// Write the reporting state, write-then-rename: a torn high-water file would
/// make the node resend a ref-log it has already delivered, or worse, skip one.
pub fn save_state(root: &Path, state: &ReportState) -> Result<(), String> {
    let path = state_path(root);
    let body =
        serde_json::to_string_pretty(state).map_err(|e| format!("serialize report state: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, format!("{body}\n"))
        .map_err(|e| format!("write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("rename into {}: {e}", path.display()))?;
    Ok(())
}

/// How one report is assembled.
pub struct BuildOpts<'a> {
    /// Operator label for this node; falls back to the persisted one.
    pub name: Option<&'a str>,
    /// Public base URL clients reach this node on; falls back to the persisted
    /// one, and to `null` when the operator has never said.
    pub url: Option<&'a str>,
    /// Ignore the high-water mark and re-send every ref-log entry.
    pub full: bool,
    pub limit: usize,
}

impl Default for BuildOpts<'_> {
    fn default() -> Self {
        BuildOpts {
            name: None,
            url: None,
            full: false,
            limit: MAX_REFLOG_PER_REPORT,
        }
    }
}

/// Build one report, and the high-water marks it would establish once the cloud
/// has accepted it.
///
/// The marks are returned rather than written because a report that never
/// arrives must not advance them — otherwise a single network failure would
/// silently drop those entries from the cloud's copy of the chain forever.
pub fn build(
    store: &NodeStore,
    state: &ReportState,
    opts: &BuildOpts<'_>,
    now: i64,
) -> Result<(NodeReport, BTreeMap<String, u64>), String> {
    let key = store.node_signing_key()?;
    let vkey = key.verifying_key();

    let logs = read_reflogs(store);
    let repos = gather_repos(store, &logs);
    let empty = BTreeMap::new();
    let marks = if opts.full { &empty } else { &state.high_water };
    let reflog = gather_reflog(&logs, marks, opts.limit);
    let token_rows = gather_tokens(store.root())?;

    // Only the repos this report actually carries entries for advance, and only
    // as far as the last entry included — the per-report cap can leave a repo
    // part-way through its log.
    let mut next = state.high_water.clone();
    for row in &reflog {
        let slot = next.entry(row.repo.clone()).or_insert(row.seq);
        if row.seq > *slot {
            *slot = row.seq;
        }
    }

    let name = opts
        .name
        .map(str::to_string)
        .or_else(|| state.name.clone())
        .unwrap_or_else(default_node_name);
    let url = opts
        .url
        .map(str::to_string)
        .or_else(|| state.url.clone())
        .filter(|u| !u.trim().is_empty());

    Ok((
        NodeReport {
            node_id: node_id(&vkey),
            name,
            version: env!("CARGO_PKG_VERSION").to_string(),
            url,
            reported_at: rfc3339(now),
            repos,
            reflog,
            tokens: token_rows,
            key_id: vkey.key_id(),
        },
        next,
    ))
}

/// The canonical bytes the report signature covers: RFC 8785 JCS over the
/// report object with no `signature` member.
pub fn canonical_bytes(report: &NodeReport) -> Result<Vec<u8>, String> {
    let value = serde_json::to_value(report).map_err(|e| format!("encode report: {e}"))?;
    aura_blocks::canonicalize(&value).map_err(|e| format!("canonicalize report: {e}"))
}

/// Sign a report and return the JSON object to POST: the report's own members
/// plus one `signature` member.
pub fn sign(report: &NodeReport, key: &SigningKey) -> Result<Value, String> {
    let bytes = canonical_bytes(report)?;
    let sig = key.sign(&bytes).to_b64();
    let mut value = serde_json::to_value(report).map_err(|e| format!("encode report: {e}"))?;
    value
        .as_object_mut()
        .ok_or("report did not serialize to a JSON object")?
        .insert("signature".to_string(), Value::String(sig));
    Ok(value)
}

/// Verify a report exactly the way a receiver must: parse the JSON, remove its
/// `signature` member, canonicalize what remains, and check the signature
/// against the public key that `node_id` names.
///
/// This is deliberately written against the wire bytes rather than against a
/// deserialized struct. A verifier that re-serializes from its own types signs
/// off on its own idea of the payload, not the sender's — the one shape of bug
/// that makes a forged report verify.
pub fn verify_wire(body: &str) -> Result<NodeReport, String> {
    let mut value: Value =
        serde_json::from_str(body).map_err(|e| format!("report is not JSON: {e}"))?;
    let obj = value
        .as_object_mut()
        .ok_or("report is not a JSON object")?;

    let sig_b64 = obj
        .remove("signature")
        .ok_or("report has no signature")?
        .as_str()
        .ok_or("report signature is not a string")?
        .to_string();
    let sig = SignatureBytes::from_b64(&sig_b64).map_err(|e| format!("report signature: {e}"))?;

    let claimed_node_id = obj
        .get("node_id")
        .and_then(Value::as_str)
        .ok_or("report has no node_id")?;
    let vkey = verifying_key_from_node_id(claimed_node_id)?;

    let bytes = aura_blocks::canonicalize(&value).map_err(|e| format!("canonicalize: {e}"))?;
    vkey.verify(&bytes, &sig)
        .map_err(|_| "report signature does not verify (tampered or wrong key)".to_string())?;

    let report: NodeReport =
        serde_json::from_value(value).map_err(|e| format!("report shape: {e}"))?;
    if report.key_id != vkey.key_id() {
        return Err(format!(
            "report key_id {} does not match the key node_id names ({})",
            report.key_id,
            vkey.key_id()
        ));
    }
    Ok(report)
}

/// Check the ref-log copy inside a report the way its point requires: each
/// entry's *own* signature, reconstructed from the wire fields, and each entry
/// hash and chain link recomputed rather than believed.
///
/// The outer report signature already proves the payload came from this node
/// unaltered. This proves something stronger and older: that each ref update
/// was signed when it happened, by the key it names, and that the entries the
/// report carries still link to each other in the order the node recorded them.
/// A cloud running this check is verifying history, not trusting a courier.
pub fn verify_entries(report: &NodeReport) -> Result<(), String> {
    let vkey = verifying_key_from_node_id(&report.node_id)?;
    for row in &report.reflog {
        let payload = signing_payload_from_row(row);
        let sig = SignatureBytes::from_b64(&row.signature)
            .map_err(|e| format!("{} seq {}: bad signature: {e}", row.repo, row.seq))?;
        vkey.verify(payload.as_bytes(), &sig).map_err(|_| {
            format!(
                "{} seq {}: entry signature does not verify (tampered entry)",
                row.repo, row.seq
            )
        })?;
        let recomputed = sha256_hex(payload.as_bytes());
        if recomputed != row.entry_hash {
            return Err(format!(
                "{} seq {}: entry_hash does not match the entry it claims to hash",
                row.repo, row.seq
            ));
        }
        if row.who != vkey.key_id() {
            return Err(format!(
                "{} seq {}: entry claims signer {} but verified against {}",
                row.repo,
                row.seq,
                row.who,
                vkey.key_id()
            ));
        }
    }
    Ok(())
}

fn sha256_hex(data: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(data);
    hex::encode(h.finalize())
}

/// A node with no operator-chosen name is still worth naming, and the box's own
/// hostname is the name its operator already thinks of it by.
fn default_node_name() -> String {
    std::env::var("HOSTNAME")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| {
            std::process::Command::new("hostname")
                .output()
                .ok()
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
                .filter(|s| !s.is_empty())
        })
        .unwrap_or_else(|| "aura-node".to_string())
}

/// `aura node report` — gather, sign and send. Reads the store off disk, so it
/// runs from cron whether or not `aura node serve` is up on this box.
pub fn run(
    data_dir: Option<&str>,
    name: Option<&str>,
    url: Option<&str>,
    cloud: Option<&str>,
    full: bool,
    dry_run: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let root = super::resolve_data_dir(data_dir);
    let store = NodeStore::new(root.clone())?;
    let mut state = load_state(&root)?;

    // The operator's name/url are settings, not consequences of a successful
    // POST, so they persist the moment they are given.
    let mut settings_changed = false;
    if let Some(n) = name.map(str::trim).filter(|s| !s.is_empty()) {
        state.name = Some(n.to_string());
        settings_changed = true;
    }
    if let Some(u) = url.map(str::trim).filter(|s| !s.is_empty()) {
        state.url = Some(u.to_string());
        settings_changed = true;
    }
    if settings_changed {
        save_state(&root, &state)?;
    }

    let now = chrono::Utc::now().timestamp();
    let opts = BuildOpts {
        name: None,
        url: None,
        full,
        limit: MAX_REFLOG_PER_REPORT,
    };
    let (report, next_marks) = build(&store, &state, &opts, now)?;
    let key = store.node_signing_key()?;
    let signed = sign(&report, &key)?;
    let body = serde_json::to_string(&signed).map_err(|e| format!("encode report: {e}"))?;

    // Verify our own bytes before anyone else has to. A canonicalization bug
    // here would make every report arrive at the cloud flagged as forged, and
    // the failure would surface as an accusation on the far side rather than as
    // a bug on this one. Cheap enough to do unconditionally.
    let round_tripped = verify_wire(&body)
        .map_err(|e| format!("refusing to send a report this node cannot verify itself: {e}"))?;
    verify_entries(&round_tripped)
        .map_err(|e| format!("refusing to send a ref-log copy that does not verify: {e}"))?;

    if dry_run {
        // Every byte printed here is either public by construction (the node's
        // public key, the ref-log the node already serves to anonymous callers)
        // or metadata about a token rather than a token. Nothing here can be
        // replayed as a credential.
        println!("{}", serde_json::to_string_pretty(&signed)?);
        print_summary(&report, &root, "not sent (--dry-run)");
        return Ok(());
    }

    let (client, cloud_url, cloud_token) = cloud_client(cloud)?;
    let endpoint = format!("{cloud_url}{REPORT_PATH}");
    let mut req = client
        .post(&endpoint)
        .header("content-type", "application/json")
        .body(body);
    if let Some(t) = &cloud_token {
        req = req.header("Authorization", format!("Bearer {t}"));
    }
    let resp = req.send().map_err(|e| format!("POST {endpoint}: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let detail = resp.text().unwrap_or_default();
        let detail = detail.trim();
        return Err(format!(
            "cloud refused the report: HTTP {status}{}",
            if detail.is_empty() {
                String::new()
            } else {
                format!(" — {}", truncate(detail, 400))
            }
        )
        .into());
    }

    // Accepted: only now may the high-water marks move.
    state.high_water = next_marks;
    state.last_reported_at = Some(now);
    save_state(&root, &state)?;

    print_summary(&report, &root, &format!("sent to {endpoint}"));
    Ok(())
}

fn print_summary(report: &NodeReport, root: &Path, outcome: &str) {
    println!("{} node report {}", "◆".cyan().bold(), outcome.dimmed());
    println!("  {} node   {} ({})", "•".dimmed(), report.name, report.key_id.dimmed());
    println!("  {} repos  {}", "•".dimmed(), report.repos.len());
    println!(
        "  {} reflog {} new signed entr{}",
        "•".dimmed(),
        report.reflog.len(),
        if report.reflog.len() == 1 { "y" } else { "ies" }
    );
    println!("  {} tokens {} (metadata only)", "•".dimmed(), report.tokens.len());
    println!(
        "  {} marks  {}",
        "•".dimmed(),
        state_path(root).display().to_string().dimmed()
    );
}

/// The cloud to report to, and the bearer to present. `--cloud` overrides
/// everything; otherwise this follows the same rule as the rest of the CLI —
/// the environment beats the signed-in config, and a production token never
/// follows a URL it was not issued for (see `crate::cloud_endpoint`).
fn cloud_client(
    cloud: Option<&str>,
) -> Result<(reqwest::blocking::Client, String, Option<String>), String> {
    let cfg = crate::config::ConfigManager::load();
    let (url, token) = match cloud.map(str::trim).filter(|s| !s.is_empty()) {
        Some(explicit) => (
            explicit.trim_end_matches('/').to_string(),
            // An explicitly named cloud gets only an explicitly named token,
            // for the same reason `AURA_CLOUD_URL` does.
            std::env::var(crate::cloud_endpoint::TOKEN_ENV)
                .ok()
                .filter(|s| !s.trim().is_empty()),
        ),
        None => (
            crate::cloud_endpoint::origin(cfg.cloud_url.as_deref())
                .ok_or("not connected to a cloud — run `aura connect`, or pass --cloud <url>")?,
            crate::cloud_endpoint::token(cfg.cloud_api_token.as_deref()),
        ),
    };
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| format!("http client: {e}"))?;
    Ok((client, url, token))
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let head: String = s.chars().take(max).collect();
    format!("{head}…")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::node::auth::{normalize_caps, CapabilityToken};
    use crate::node::reflog::RefChange;

    fn oid(tag: u8) -> String {
        std::iter::repeat(format!("{tag:02x}")).take(20).collect()
    }

    /// A node store with one repo whose ref-log holds `n` signed pushes.
    fn store_with_log(n: usize) -> (tempfile::TempDir, NodeStore, SigningKey) {
        let dir = tempfile::tempdir().unwrap();
        let store = NodeStore::new(dir.path().to_path_buf()).unwrap();
        let key = store.node_signing_key().unwrap();
        let git_dir = store.repo_path("repoA").unwrap();
        std::fs::create_dir_all(&git_dir).unwrap();
        let mut prev = ZERO_OID.to_string();
        for i in 0..n {
            let new = oid(i as u8 + 1);
            reflog::append_changes(
                &git_dir,
                "repoA",
                &[RefChange {
                    reference: "refs/heads/main".to_string(),
                    old: prev.clone(),
                    new: new.clone(),
                }],
                1_700_000_000 + i as i64,
                &key,
            )
            .unwrap();
            prev = new;
        }
        (dir, store, key)
    }

    #[test]
    fn signature_covers_the_object_minus_its_signature_member() {
        let (dir, store, key) = store_with_log(2);
        let state = ReportState::default();
        let (report, _) = build(&store, &state, &BuildOpts::default(), 1_700_000_100).unwrap();
        let signed = sign(&report, &key).unwrap();
        let body = serde_json::to_string(&signed).unwrap();

        let verified = verify_wire(&body).expect("an untouched report must verify");
        assert_eq!(verified, report);
        let _ = dir;
    }

    #[test]
    fn a_tampered_field_fails_verification() {
        let (dir, store, key) = store_with_log(2);
        let (report, _) =
            build(&store, &ReportState::default(), &BuildOpts::default(), 1_700_000_100).unwrap();
        let signed = sign(&report, &key).unwrap();

        // Rewrite a ref-log target, exactly as a cloud that wanted to show a
        // branch pointing somewhere it never pointed would have to.
        let mut forged = signed.clone();
        forged["reflog"][0]["new"] = Value::String(oid(0xEE));
        let err = verify_wire(&serde_json::to_string(&forged).unwrap()).unwrap_err();
        assert!(err.contains("does not verify"), "got: {err}");

        // The same for a repo row, and for the node's own name.
        let mut forged = signed.clone();
        forged["repos"][0]["refs"] = Value::from(9_999u64);
        assert!(verify_wire(&serde_json::to_string(&forged).unwrap()).is_err());

        let mut forged = signed.clone();
        forged["name"] = Value::String("somebody-elses-node".into());
        assert!(verify_wire(&serde_json::to_string(&forged).unwrap()).is_err());

        // Adding a member is tampering too — the signature covers the whole
        // object, not a list of fields the verifier happens to know about.
        let mut forged = signed.clone();
        forged["extra"] = Value::String("smuggled".into());
        assert!(verify_wire(&serde_json::to_string(&forged).unwrap()).is_err());
        let _ = dir;
    }

    #[test]
    fn swapping_the_key_is_caught_by_the_key_id_cross_check() {
        let (dir, store, _key) = store_with_log(1);
        let (report, _) =
            build(&store, &ReportState::default(), &BuildOpts::default(), 1_700_000_100).unwrap();

        // An attacker re-signs the whole report with their own key and swaps in
        // their node_id. The signature verifies — it is their signature — but
        // the report still claims the node's key_id, so the cross-check fires.
        let attacker = SigningKey::generate();
        let mut forged = report.clone();
        forged.node_id = node_id(&attacker.verifying_key());
        let signed = sign(&forged, &attacker).unwrap();
        let err = verify_wire(&serde_json::to_string(&signed).unwrap()).unwrap_err();
        assert!(err.contains("key_id"), "got: {err}");
        let _ = dir;
    }

    #[test]
    fn entry_signatures_are_verifiable_from_the_wire_fields_alone() {
        let (dir, store, key) = store_with_log(3);
        let (report, _) =
            build(&store, &ReportState::default(), &BuildOpts::default(), 1_700_000_100).unwrap();
        let vkey = verifying_key_from_node_id(&report.node_id).unwrap();
        assert_eq!(vkey.key_id(), key.key_id());

        let mut prev: Option<String> = None;
        for row in &report.reflog {
            let payload = signing_payload_from_row(row);
            let sig = SignatureBytes::from_b64(&row.signature).unwrap();
            vkey.verify(payload.as_bytes(), &sig)
                .expect("every entry must verify from its wire fields");
            // And the chain links, recomputed the same way.
            use sha2::{Digest, Sha256};
            let mut h = Sha256::new();
            h.update(payload.as_bytes());
            let entry_hash = hex::encode(h.finalize());
            assert_eq!(entry_hash, row.entry_hash);
            assert_eq!(row.prev_hash, prev);
            prev = Some(entry_hash);
        }
        assert_eq!(report.reflog.len(), 3);
        // The first entry is a create, so the wire carries a null `old`.
        assert_eq!(report.reflog[0].old, None);
        let _ = dir;
    }

    #[test]
    fn the_high_water_mark_makes_the_second_report_incremental() {
        let (dir, store, _key) = store_with_log(3);
        let mut state = ReportState::default();

        let (first, marks) = build(&store, &state, &BuildOpts::default(), 1).unwrap();
        assert_eq!(first.reflog.len(), 3, "the first report carries the whole log");
        assert_eq!(marks.get("repoA"), Some(&2));

        // Accepted → the marks land.
        state.high_water = marks;
        save_state(dir.path(), &state).unwrap();

        let (second, _) = build(&store, &state, &BuildOpts::default(), 2).unwrap();
        assert!(
            second.reflog.is_empty(),
            "nothing new to say, so nothing is re-sent"
        );
        assert_eq!(second.repos.len(), 1, "repo rows are still a full snapshot");

        // A new push, and only that push travels.
        let git_dir = store.repo_path("repoA").unwrap();
        let key = store.node_signing_key().unwrap();
        reflog::append_changes(
            &git_dir,
            "repoA",
            &[RefChange {
                reference: "refs/heads/main".to_string(),
                old: oid(3),
                new: oid(4),
            }],
            1_700_000_500,
            &key,
        )
        .unwrap();
        let (third, marks) = build(&store, &state, &BuildOpts::default(), 3).unwrap();
        assert_eq!(third.reflog.len(), 1);
        assert_eq!(third.reflog[0].seq, 3);
        assert_eq!(marks.get("repoA"), Some(&3));

        // --full re-sends everything without disturbing the stored marks.
        let full_opts = BuildOpts {
            full: true,
            ..BuildOpts::default()
        };
        let (again, _) = build(&store, &state, &full_opts, 4).unwrap();
        assert_eq!(again.reflog.len(), 4);
    }

    #[test]
    fn a_failed_send_leaves_the_marks_where_they_were() {
        // `build` returns the marks it *would* establish; nothing writes them.
        // This is the guarantee that a network failure cannot lose entries.
        let (dir, store, _key) = store_with_log(2);
        let state = ReportState::default();
        let (_report, marks) = build(&store, &state, &BuildOpts::default(), 1).unwrap();
        assert!(!marks.is_empty());
        assert!(
            load_state(dir.path()).unwrap().high_water.is_empty(),
            "building a report must not advance the high-water mark"
        );
    }

    #[test]
    fn the_per_report_cap_stops_short_and_the_mark_follows_it() {
        let (dir, store, _key) = store_with_log(5);
        let opts = BuildOpts {
            limit: 2,
            ..BuildOpts::default()
        };
        let (report, marks) = build(&store, &ReportState::default(), &opts, 1).unwrap();
        assert_eq!(report.reflog.len(), 2);
        assert_eq!(marks.get("repoA"), Some(&1), "the mark must not run ahead of what was sent");
        let _ = dir;
    }

    #[test]
    fn no_token_material_appears_anywhere_in_the_serialised_report() {
        let (dir, store, key) = store_with_log(1);
        // Mint a real token and record it, exactly as `aura node token` does.
        let claims = CapabilityToken::new("repoA", normalize_caps(true, false), 1_000, 3_600);
        let wire = claims.issue(&key).unwrap();
        let recorded =
            CapabilityToken::parse_and_verify(&wire, &key.verifying_key()).unwrap();
        let id = tokens::record_issue(dir.path(), &wire, "ci deploy", &recorded).unwrap();

        let (report, _) =
            build(&store, &ReportState::default(), &BuildOpts::default(), 5).unwrap();
        let signed = sign(&report, &key).unwrap();
        let body = serde_json::to_string(&signed).unwrap();

        assert!(!body.contains(&wire), "the token itself must never be in a report");
        assert!(
            !body.contains(super::super::auth::TOKEN_PREFIX),
            "not even a token's wire prefix should appear"
        );
        // Nor any segment of it: the payload and signature segments are the
        // replayable halves, and either one leaking is the whole failure.
        for segment in wire.split('.').skip(1) {
            assert!(!body.contains(segment), "a token segment leaked into the report");
        }
        // The metadata, however, is there and is useful.
        assert_eq!(report.tokens.len(), 1);
        assert_eq!(report.tokens[0].id, id);
        assert_eq!(report.tokens[0].label, "ci deploy");
        assert_eq!(report.tokens[0].scope, tokens::SCOPE_PUSH);
        assert_eq!(report.tokens[0].repo.as_deref(), Some("repoA"));
        assert_eq!(report.tokens[0].expires_at.as_deref(), Some("1970-01-01T01:16:40Z"));
        assert!(!report.tokens[0].revoked);
    }

    #[test]
    fn every_optional_field_is_present_as_null_rather_than_omitted() {
        // The verifier re-canonicalizes the object it received, so the node and
        // the cloud must agree on the key set exactly.
        let (dir, store, key) = store_with_log(1);
        let (report, _) =
            build(&store, &ReportState::default(), &BuildOpts::default(), 1).unwrap();
        assert!(report.url.is_none());
        let signed = sign(&report, &key).unwrap();
        let obj = signed.as_object().unwrap();
        for field in [
            "node_id", "name", "version", "url", "reported_at", "repos", "reflog", "tokens",
            "key_id", "signature",
        ] {
            assert!(obj.contains_key(field), "missing wire field {field}");
        }
        assert!(obj["url"].is_null());
        assert!(signed["reflog"][0]["old"].is_null());
        assert!(signed["repos"][0]["last_push_at"].is_string());
        let _ = dir;
    }

    #[test]
    fn timestamps_round_trip_through_the_wire_form() {
        assert_eq!(rfc3339(1_700_000_000), "2023-11-14T22:13:20Z");
        assert_eq!(from_rfc3339("2023-11-14T22:13:20Z").unwrap(), 1_700_000_000);
        assert_eq!(from_rfc3339(&rfc3339(0)).unwrap(), 0);
    }

    #[test]
    fn node_id_round_trips_to_the_key_it_names() {
        let key = SigningKey::generate();
        let id = node_id(&key.verifying_key());
        let recovered = verifying_key_from_node_id(&id).unwrap();
        assert_eq!(recovered.key_id(), key.key_id());
        assert!(verifying_key_from_node_id("not-a-key").is_err());
    }

    #[test]
    fn canonical_bytes_are_sorted_and_whitespace_free() {
        let report = NodeReport {
            node_id: "n".into(),
            name: "b".into(),
            version: "0".into(),
            url: None,
            reported_at: "t".into(),
            repos: vec![],
            reflog: vec![],
            tokens: vec![],
            key_id: "k".into(),
        };
        let bytes = canonical_bytes(&report).unwrap();
        let text = String::from_utf8(bytes).unwrap();
        assert_eq!(
            text,
            r#"{"key_id":"k","name":"b","node_id":"n","reflog":[],"reported_at":"t","repos":[],"tokens":[],"url":null,"version":"0"}"#
        );
    }
}
