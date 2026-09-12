//! Mirrors — keeping an upstream repository resident on a node you own.
//!
//! A mirror is a hosted repo whose contents come from somewhere else: a GitHub
//! repository, a GitLab one, or another Aura node. The node fetches it, stores
//! it as an ordinary bare repo like any other, and serves it over the same
//! smart-HTTP as everything else — so `git clone aura://your-node/<id>` gets
//! the upstream's code from your own disk.
//!
//! Two reasons that matters, and they are different reasons:
//!
//! 1. **Reads stop going to the forge.** A crew of agents cloning and fetching
//!    all day hammers whoever hosts the origin, and forges answer that with
//!    rate limits. A mirror moves that traffic onto hardware you control.
//! 2. **Replication is the same mechanism.** An upstream of `aura://other-node/<id>`
//!    makes this node a replica of that one. Two nodes in two regions, each
//!    mirroring the other's repos, is the whole of geographic replication —
//!    there is no separate replication engine to build, and none to operate.
//!
//! **Mirrored updates are signed exactly like pushed ones.** A sync diffs the
//! refs before and after the fetch and appends the result to the same
//! hash-chained ref-log (see [`super::reflog`]) that a push writes, under the
//! node's own key. So a client can verify the branch history of a mirror with
//! `aura node verify-log`, and a mirror that quietly rewrites history is caught
//! by the same rollback pin. A mirror is not a less trustworthy copy — it
//! carries its own evidence.
//!
//! **A mirror does not accept pushes.** The next sync fast-forwards every ref
//! to whatever the upstream says, so a push landing here would be silently
//! erased. The node refuses it instead (see `smart_http`), because losing a
//! commit quietly is far worse than being told no.
//!
//! **The node stores no upstream credentials.** A private upstream is reached
//! with whatever git on this machine is already configured to use — a
//! credential helper, an SSH key, a token in the URL the operator typed. We
//! never copy a secret into the mirror record, so the record is safe to read,
//! back up, and hand to a colleague.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;

use clap::Subcommand;
use colored::Colorize;
use serde::{Deserialize, Serialize};

use super::reflog;
use super::NodeStore;

/// Where a repo's mirror record lives, inside its own bare repo. Keeping it
/// there rather than in a node-wide index means removing the repo removes the
/// record with it, and there is no second file to fall out of step.
pub const MIRROR_FILE: &str = "aura-mirror.json";

pub const MIRROR_VERSION: u32 = 1;

/// The refspecs a sync pulls. Deliberately branches and tags only: the
/// upstream's remote-tracking refs are its bookkeeping, not its content, and
/// GitHub's `refs/pull/*` would multiply the ref count by the number of PRs
/// ever opened. Both are forced, so an upstream force-push is reflected rather
/// than leaving the mirror silently stuck.
const REFSPECS: [&str; 2] = [
    "+refs/heads/*:refs/heads/*",
    "+refs/tags/*:refs/tags/*",
];

#[derive(Subcommand)]
pub enum MirrorSubcommands {
    /// Mirror an upstream repository onto this node, and fetch it once now.
    ///
    /// The upstream may be any URL git can clone — `https://github.com/…`, an
    /// `ssh://`/`git@` remote, or `aura://another-node/<id>` to replicate a
    /// second Aura node.
    Add {
        /// Upstream repository URL to mirror.
        upstream: String,
        /// Repo id to host it under. Defaults to one derived from the URL.
        #[arg(long)]
        id: Option<String>,
        #[arg(long)]
        data_dir: Option<String>,
        /// Record the mirror without fetching. The next `sync` picks it up.
        #[arg(long)]
        no_fetch: bool,
    },
    /// List the mirrors on this node and when each last synced.
    List {
        #[arg(long)]
        data_dir: Option<String>,
    },
    /// Fetch upstream changes for one mirror, or for every mirror.
    Sync {
        /// Repo id to sync. Omit with --all to sync every mirror.
        id: Option<String>,
        /// Sync every mirror on the node.
        #[arg(long)]
        all: bool,
        #[arg(long)]
        data_dir: Option<String>,
    },
    /// Stop mirroring a repo. The hosted copy stays; it simply stops updating.
    Remove {
        /// Repo id to stop mirroring.
        id: String,
        #[arg(long)]
        data_dir: Option<String>,
    },
}

/// What a node records about a mirrored repo. No credential ever lands here.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MirrorConfig {
    pub schema_version: u32,
    pub repo_id: String,
    /// The URL to fetch from, exactly as the operator gave it.
    pub upstream: String,
    pub added_at: i64,
    /// Unix seconds of the last sync attempt, successful or not.
    #[serde(default)]
    pub last_sync: i64,
    /// Whether that attempt succeeded.
    #[serde(default)]
    pub last_sync_ok: bool,
    /// Why the last attempt failed, if it did. Cleared on success.
    #[serde(default)]
    pub last_error: Option<String>,
    /// Signed ref-log entries written by the last successful sync.
    #[serde(default)]
    pub last_changes: usize,
}

impl MirrorConfig {
    pub fn new(repo_id: &str, upstream: &str, now: i64) -> Self {
        Self {
            schema_version: MIRROR_VERSION,
            repo_id: repo_id.to_string(),
            upstream: upstream.to_string(),
            added_at: now,
            last_sync: 0,
            last_sync_ok: false,
            last_error: None,
            last_changes: 0,
        }
    }
}

/// What one sync did, for reporting.
pub struct SyncOutcome {
    pub changes: Vec<reflog::RefChange>,
    /// Entries appended to the signed ref-log — equal to `changes.len()` unless
    /// signing was unavailable, in which case the fetch still stands.
    pub signed: usize,
}

pub fn mirror_path(repo_git_dir: &Path) -> PathBuf {
    repo_git_dir.join(MIRROR_FILE)
}

/// Read a repo's mirror record. `Ok(None)` means it is an ordinary hosted repo.
pub fn read(repo_git_dir: &Path) -> Result<Option<MirrorConfig>, String> {
    let path = mirror_path(repo_git_dir);
    if !path.exists() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(&path)
        .map_err(|e| format!("read {}: {e}", path.display()))?;
    let cfg: MirrorConfig = serde_json::from_str(&raw)
        .map_err(|e| format!("parse {}: {e}", path.display()))?;
    Ok(Some(cfg))
}

pub fn write(repo_git_dir: &Path, cfg: &MirrorConfig) -> Result<(), String> {
    let path = mirror_path(repo_git_dir);
    let body = serde_json::to_string_pretty(cfg).map_err(|e| format!("serialize mirror: {e}"))?;
    // Write-then-rename so a crash mid-write can't leave a half-parsed record
    // that makes the node forget an upstream.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, format!("{body}\n")).map_err(|e| format!("write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("rename into {}: {e}", path.display()))?;
    Ok(())
}

/// Cheap "is this a mirror?" check for the request path, which asks it on every
/// push and must not pay for a JSON parse to find out.
pub fn is_mirror(repo_git_dir: &Path) -> bool {
    mirror_path(repo_git_dir).is_file()
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Turn an upstream URL into a repo id that is stable, readable, and safe as a
/// path component. `https://github.com/Naridon-Inc/aura.git` becomes
/// `github-com-naridon-inc-aura`, so two different forges hosting a repo of the
/// same name never collide on one node.
pub fn derive_id(upstream: &str) -> Result<String, String> {
    let trimmed = upstream.trim();
    if trimmed.is_empty() {
        return Err("upstream URL is empty".into());
    }

    // Strip the scheme, then any userinfo — a token or username in the URL must
    // never end up in the id, which is public in every clone URL and log line.
    let after_scheme = trimmed
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(trimmed);
    let after_userinfo = after_scheme
        .rsplit_once('@')
        .map(|(_, rest)| rest)
        .unwrap_or(after_scheme);

    // `host:port/path` and scp-style `host:path` both lose the colon here; the
    // port is not part of a repo's identity.
    let mut out = String::new();
    let mut last_dash = true;
    for ch in after_userinfo.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    let out = out.trim_matches('-').to_string();
    let out = out.strip_suffix("-git").map(str::to_string).unwrap_or(out);

    if out.is_empty() {
        return Err(format!("cannot derive a repo id from '{upstream}'"));
    }
    // `is_valid_id` caps ids at 128; keep the tail, which is the repo name, and
    // is what a person recognises.
    let out = if out.len() > 128 {
        out[out.len() - 128..].trim_matches('-').to_string()
    } else {
        out
    };
    if !NodeStore::is_valid_id(&out) {
        return Err(format!("derived id '{out}' is not a valid repo id"));
    }
    Ok(out)
}

// ─── Sync engine ─────────────────────────────────────────────────────────────

/// Fetch one mirror's upstream and record what moved into the signed ref-log.
///
/// The fetch shells out to `git` rather than using libgit2 in-process, and that
/// is load-bearing rather than incidental: an upstream may be `aura://…`, whose
/// transport is our own `git-remote-aura` helper — a program git finds on PATH.
/// libgit2 has no remote-helper mechanism, so an in-process fetch could never
/// replicate from another Aura node, which is half the point of mirrors.
pub fn sync_one(
    store: &NodeStore,
    id: &str,
    cfg: &mut MirrorConfig,
) -> Result<SyncOutcome, String> {
    let path = store.open_or_init(id)?;

    let before = store.snapshot_refs(id).unwrap_or_default();

    let mut cmd = Command::new("git");
    cmd.arg("--git-dir")
        .arg(&path)
        .arg("fetch")
        .arg("--prune")
        .arg("--prune-tags")
        .arg("--quiet")
        .arg(&cfg.upstream);
    for spec in REFSPECS {
        cmd.arg(spec);
    }
    // Never block on a credential prompt: a sync runs unattended, from a timer
    // or a background task on a serving node, where a prompt is a hang rather
    // than a question. Configured helpers still answer; only the terminal is
    // shut off, so a private upstream fails fast with a message the operator
    // can act on.
    cmd.env("GIT_TERMINAL_PROMPT", "0");

    let out = cmd
        .output()
        .map_err(|e| format!("run git fetch: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let detail = if err.is_empty() {
            format!("git fetch exited {}", out.status)
        } else {
            err
        };
        return Err(detail);
    }

    let after = store.snapshot_refs(id).unwrap_or_default();
    let changes = NodeStore::diff_ref_snapshots(&before, &after);

    // Keep HEAD on a real branch so a clone of the mirror checks out, the same
    // fixup a push gets.
    let _ = store.fixup_head(id);

    let signed = sign_changes(store, &path, id, &changes);

    cfg.last_sync = now_secs();
    cfg.last_sync_ok = true;
    cfg.last_error = None;
    cfg.last_changes = changes.len();
    write(&path, cfg)?;

    Ok(SyncOutcome { changes, signed })
}

/// Append the fetched ref movements to the repo's signed ref-log. A signing
/// failure is reported but does not undo the fetch — the objects are on disk
/// either way, and a mirror that refuses to serve code because it could not
/// write a log line would be a worse outcome than one whose log has a gap.
fn sign_changes(
    store: &NodeStore,
    repo_git_dir: &Path,
    id: &str,
    changes: &[reflog::RefChange],
) -> usize {
    if changes.is_empty() {
        return 0;
    }
    let key = match store.node_signing_key() {
        Ok(k) => k,
        Err(e) => {
            eprintln!("aura node: ref-log skipped for {id}: {e}");
            return 0;
        }
    };
    match reflog::append_changes(repo_git_dir, id, changes, now_secs(), &key) {
        Ok(entries) => entries.len(),
        Err(e) => {
            eprintln!("aura node: ref-log append failed for {id}: {e}");
            0
        }
    }
}

/// Record a sync failure on the mirror config so `mirror list` can show it.
/// Best-effort: if we cannot even write the record, the console message stands.
fn record_failure(store: &NodeStore, id: &str, cfg: &mut MirrorConfig, err: &str) {
    cfg.last_sync = now_secs();
    cfg.last_sync_ok = false;
    cfg.last_error = Some(err.to_string());
    if let Some(path) = store.repo_path(id) {
        let _ = write(&path, cfg);
    }
}

/// Every mirror on the node, by repo id.
pub fn all_mirrors(store: &NodeStore) -> BTreeMap<String, MirrorConfig> {
    let mut out = BTreeMap::new();
    for id in store.list() {
        let Some(path) = store.repo_path(&id) else {
            continue;
        };
        if let Ok(Some(cfg)) = read(&path) {
            out.insert(id, cfg);
        }
    }
    out
}

/// Sync every mirror, returning each result. Used by `mirror sync --all` and by
/// the serving node's refresh timer.
pub fn sync_all(store: &NodeStore) -> Vec<(String, Result<SyncOutcome, String>)> {
    let mut results = Vec::new();
    for (id, mut cfg) in all_mirrors(store) {
        let res = sync_one(store, &id, &mut cfg);
        if let Err(e) = &res {
            record_failure(store, &id, &mut cfg, e);
        }
        results.push((id, res));
    }
    results
}

// ─── Commands ────────────────────────────────────────────────────────────────

pub fn run(
    sub: &MirrorSubcommands,
    resolve_data_dir: impl Fn(Option<&str>) -> PathBuf,
) -> Result<(), Box<dyn std::error::Error>> {
    match sub {
        MirrorSubcommands::Add {
            upstream,
            id,
            data_dir,
            no_fetch,
        } => {
            let store = NodeStore::new(resolve_data_dir(data_dir.as_deref()))?;
            run_add(&store, upstream, id.as_deref(), *no_fetch)
        }
        MirrorSubcommands::List { data_dir } => {
            let store = NodeStore::new(resolve_data_dir(data_dir.as_deref()))?;
            run_list(&store)
        }
        MirrorSubcommands::Sync { id, all, data_dir } => {
            let store = NodeStore::new(resolve_data_dir(data_dir.as_deref()))?;
            run_sync(&store, id.as_deref(), *all)
        }
        MirrorSubcommands::Remove { id, data_dir } => {
            let store = NodeStore::new(resolve_data_dir(data_dir.as_deref()))?;
            run_remove(&store, id)
        }
    }
}

fn run_add(
    store: &NodeStore,
    upstream: &str,
    id: Option<&str>,
    no_fetch: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let id = match id {
        Some(explicit) => {
            if !NodeStore::is_valid_id(explicit) {
                return Err(format!(
                    "'{explicit}' is not a valid repo id — use ascii letters, digits, '-' and '_'"
                )
                .into());
            }
            explicit.to_string()
        }
        None => derive_id(upstream)?,
    };

    let path = store.repo_path(&id).ok_or("invalid repo id")?;
    if let Ok(Some(existing)) = read(&path) {
        return Err(format!(
            "{id} already mirrors {} — remove it first, or pass --id for a second copy",
            existing.upstream
        )
        .into());
    }
    if store.exists(&id) {
        return Err(format!(
            "{id} is already hosted on this node as a normal repo — pass --id to mirror under a different id"
        )
        .into());
    }

    store.open_or_init(&id)?;
    let mut cfg = MirrorConfig::new(&id, upstream, now_secs());
    write(&path, &cfg)?;

    println!("{}", "◆ mirror added".bold());
    println!("  • {} → {}", upstream.dimmed(), id.cyan());

    if no_fetch {
        println!("  • not fetched yet — run `aura node mirror sync {id}`");
        return Ok(());
    }

    match sync_one(store, &id, &mut cfg) {
        Ok(outcome) => {
            print_sync_result(&id, &outcome);
            print_clone_hint(&id);
            Ok(())
        }
        Err(e) => {
            record_failure(store, &id, &mut cfg, &e);
            // The record stays so the operator can fix credentials and retry
            // without retyping the URL — but the command still fails, because
            // an empty mirror that reports success is a trap.
            Err(format!("first sync failed: {e}\n  the mirror is recorded — fix the cause and run `aura node mirror sync {id}`").into())
        }
    }
}

fn run_list(store: &NodeStore) -> Result<(), Box<dyn std::error::Error>> {
    let mirrors = all_mirrors(store);
    if mirrors.is_empty() {
        println!("{}", "no mirrors on this node".dimmed());
        println!("  → add one: aura node mirror add https://github.com/<owner>/<repo>.git");
        return Ok(());
    }
    println!("{}", format!("◆ {} mirror(s)", mirrors.len()).bold());
    for (id, cfg) in &mirrors {
        println!("  • {}", id.cyan());
        println!("      upstream  {}", cfg.upstream.dimmed());
        if cfg.last_sync == 0 {
            println!("      synced    {}", "never".yellow());
        } else if cfg.last_sync_ok {
            println!(
                "      synced    {} ago · {} ref change(s)",
                humanize_age(now_secs() - cfg.last_sync),
                cfg.last_changes
            );
        } else {
            println!(
                "      synced    {} ago · {}",
                humanize_age(now_secs() - cfg.last_sync),
                "FAILED".red()
            );
            if let Some(err) = &cfg.last_error {
                println!("      error     {}", err.red());
            }
        }
    }
    Ok(())
}

fn run_sync(
    store: &NodeStore,
    id: Option<&str>,
    all: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    if all {
        let results = sync_all(store);
        if results.is_empty() {
            println!("{}", "no mirrors on this node".dimmed());
            return Ok(());
        }
        let mut failed = 0;
        for (id, res) in &results {
            match res {
                Ok(outcome) => print_sync_result(id, outcome),
                Err(e) => {
                    failed += 1;
                    println!("  {} {} — {}", "✗".red(), id.cyan(), e.red());
                }
            }
        }
        if failed > 0 {
            return Err(format!("{failed} of {} mirror(s) failed to sync", results.len()).into());
        }
        return Ok(());
    }

    let id = id.ok_or("pass a repo id, or --all to sync every mirror")?;
    let path = store.repo_path(id).ok_or("invalid repo id")?;
    let mut cfg = read(&path)?
        .ok_or_else(|| format!("{id} is not a mirror on this node — see `aura node mirror list`"))?;
    match sync_one(store, id, &mut cfg) {
        Ok(outcome) => {
            print_sync_result(id, &outcome);
            Ok(())
        }
        Err(e) => {
            record_failure(store, id, &mut cfg, &e);
            Err(format!("sync failed: {e}").into())
        }
    }
}

fn run_remove(store: &NodeStore, id: &str) -> Result<(), Box<dyn std::error::Error>> {
    let path = store.repo_path(id).ok_or("invalid repo id")?;
    if read(&path)?.is_none() {
        return Err(format!("{id} is not a mirror on this node").into());
    }
    std::fs::remove_file(mirror_path(&path))
        .map_err(|e| format!("remove mirror record: {e}"))?;
    println!("{}", "◆ mirror removed".bold());
    println!("  • {} no longer follows its upstream", id.cyan());
    println!("  • the hosted copy and its signed ref-log are untouched — it is now an ordinary repo, and accepts pushes again");
    Ok(())
}

fn print_sync_result(id: &str, outcome: &SyncOutcome) {
    if outcome.changes.is_empty() {
        println!("  {} {} — already up to date", "✓".green(), id.cyan());
        return;
    }
    println!(
        "  {} {} — {} ref change(s), {} signed into the ref-log",
        "✓".green(),
        id.cyan(),
        outcome.changes.len(),
        outcome.signed
    );
    for change in outcome.changes.iter().take(8) {
        println!(
            "      {} {}",
            super::ref_action(&change.old, &change.new),
            change.reference.dimmed()
        );
    }
    if outcome.changes.len() > 8 {
        println!("      … and {} more", outcome.changes.len() - 8);
    }
}

fn print_clone_hint(id: &str) {
    println!("  → clone it: git clone aura://<this-node>/{id}");
}

pub(super) fn humanize_age(secs: i64) -> String {
    if secs < 60 {
        return format!("{secs}s");
    }
    if secs < 3600 {
        return format!("{}m", secs / 60);
    }
    if secs < 86_400 {
        return format!("{}h", secs / 3600);
    }
    format!("{}d", secs / 86_400)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_id_derived_from_a_github_url_names_the_forge_and_the_repo() {
        assert_eq!(
            derive_id("https://github.com/Naridon-Inc/aura.git").unwrap(),
            "github-com-naridon-inc-aura"
        );
    }

    #[test]
    fn two_forges_hosting_the_same_repo_name_get_different_ids() {
        let a = derive_id("https://github.com/acme/widget.git").unwrap();
        let b = derive_id("https://gitlab.com/acme/widget.git").unwrap();
        assert_ne!(a, b);
    }

    #[test]
    fn an_aura_upstream_derives_an_id_so_a_node_can_replicate_a_node() {
        let id = derive_id("aura://node-eu.example.com/demo-sovereign-01").unwrap();
        assert!(id.contains("demo-sovereign-01"), "got {id}");
        assert!(NodeStore::is_valid_id(&id));
    }

    #[test]
    fn a_token_in_the_upstream_url_never_reaches_the_repo_id() {
        // The id shows up in clone URLs, listings and logs. A credential that
        // leaked into it would be published by every one of them.
        let id = derive_id("https://x-access-token:ghp_SECRETVALUE@github.com/acme/widget.git")
            .unwrap();
        assert!(!id.contains("ghp"), "got {id}");
        assert!(!id.contains("secretvalue"), "got {id}");
        assert_eq!(id, "github-com-acme-widget");
    }

    #[test]
    fn an_scp_style_remote_derives_a_valid_id() {
        let id = derive_id("git@github.com:acme/widget.git").unwrap();
        assert_eq!(id, "github-com-acme-widget");
        assert!(NodeStore::is_valid_id(&id));
    }

    #[test]
    fn a_derived_id_is_always_short_enough_to_be_a_path_component() {
        let long = format!("https://example.com/{}/repo.git", "a".repeat(400));
        let id = derive_id(&long).unwrap();
        assert!(id.len() <= 128, "len {}", id.len());
        assert!(NodeStore::is_valid_id(&id));
    }

    #[test]
    fn an_empty_upstream_is_refused_rather_than_producing_an_empty_id() {
        assert!(derive_id("   ").is_err());
    }

    #[test]
    fn a_mirror_record_round_trips_and_carries_no_credential_field() {
        let dir = std::env::temp_dir().join(format!("aura-mirror-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let cfg = MirrorConfig::new("demo", "https://github.com/acme/widget.git", 1_700_000_000);
        write(&dir, &cfg).unwrap();

        let raw = std::fs::read_to_string(mirror_path(&dir)).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&raw).unwrap();
        let keys: Vec<&str> = parsed
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        // Pinned exactly: a field added here is a field written to disk, and
        // the point of this record is that it holds nothing secret.
        assert_eq!(
            keys,
            vec![
                "schema_version",
                "repo_id",
                "upstream",
                "added_at",
                "last_sync",
                "last_sync_ok",
                "last_error",
                "last_changes",
            ]
        );

        let back = read(&dir).unwrap().unwrap();
        assert_eq!(back.upstream, cfg.upstream);
        assert_eq!(back.repo_id, "demo");
        assert!(is_mirror(&dir));

        std::fs::remove_file(mirror_path(&dir)).unwrap();
        assert!(!is_mirror(&dir));
        assert!(read(&dir).unwrap().is_none());
    }

    #[test]
    fn the_refspecs_force_and_cover_branches_and_tags() {
        // An upstream force-push must be reflected, not silently dropped, or a
        // mirror drifts from the thing it claims to be a copy of.
        assert!(REFSPECS.iter().all(|s| s.starts_with('+')));
        assert!(REFSPECS.iter().any(|s| s.contains("refs/heads/")));
        assert!(REFSPECS.iter().any(|s| s.contains("refs/tags/")));
        assert!(!REFSPECS.iter().any(|s| s.contains("refs/pull/")));
    }
}
