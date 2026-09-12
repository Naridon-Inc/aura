//! Bridges — keeping a downstream forge in sync FROM this node (P4).
//!
//! A mirror pulls someone else's repository onto your node; a bridge is
//! the same relationship pointed the other way. The node is where pushes
//! land, and after every accepted push it forwards branches and tags to a
//! downstream URL — GitHub, GitLab, any remote git can push to. That is
//! what lets a team adopt `aura://` as the primary remote WITHOUT leaving
//! GitHub: CI, PRs and colleagues who never heard of Aura keep seeing
//! every commit, seconds after it lands here.
//!
//! This is the substrate guardrail made mechanical. The plan's rule is
//! "code stays plain git — `git push` to GitHub always works"; a bridge
//! removes the one way that promise could rot in practice, which is
//! somebody forgetting to push twice.
//!
//! **Forwarding is best-effort and NEVER gates the push.** The push to
//! this node succeeded the moment receive-pack committed it and the
//! signed ref-log recorded it; a GitHub outage must not turn that into a
//! failure. A failed forward is recorded on the bridge record (visible in
//! `aura node bridge list`) and retried by the next push or a manual
//! `aura node bridge sync`.
//!
//! **Branches and tags only, forced, never pruned.** Forced, because the
//! node is the source of truth and a downstream that diverged should be
//! overwritten — that is what "follows this node" means. Never pruned,
//! because deleting refs on a downstream forge is the kind of surprise
//! that costs someone their afternoon; a branch deleted here simply stops
//! updating there.
//!
//! **No downstream credential is ever stored** — enforced, not merely
//! intended: a URL carrying one (`https://user:token@…`, or a bare token
//! as userinfo over http/https) is REFUSED at `bridge add`, and any
//! userinfo git quotes back in an error is scrubbed before it reaches the
//! record. The forward inherits whatever git on this machine already uses
//! (credential helper, SSH key); `GIT_TERMINAL_PROMPT=0` so an unattended
//! forward fails fast instead of hanging on a prompt.
//!
//! A mirror cannot be bridged: it already follows an upstream, and
//! forwarding it back out would make this node a silent man-in-the-middle
//! of somebody else's repository.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;

use clap::Subcommand;
use colored::Colorize;
use serde::{Deserialize, Serialize};

use super::mirror;
use super::NodeStore;

/// Where a repo's bridge record lives — inside its own bare repo, like the
/// mirror record, so deleting the repo deletes the record.
pub const BRIDGE_FILE: &str = "aura-bridge.json";

pub const BRIDGE_VERSION: u32 = 1;

/// What a forward pushes: branches and tags, forced (the node is the
/// source of truth), and deliberately nothing else — no notes, no
/// internal refs, and no `--prune`.
const REFSPECS: [&str; 2] = ["+refs/heads/*:refs/heads/*", "+refs/tags/*:refs/tags/*"];

#[derive(Subcommand)]
pub enum BridgeSubcommands {
    /// Bridge a hosted repo to a downstream forge, and push it once now.
    ///
    /// After this, every push accepted by the node is forwarded to the
    /// downstream automatically — GitHub stays in sync without anyone
    /// pushing twice.
    Add {
        /// Repo id on this node.
        id: String,
        /// Downstream URL to keep in sync — anything git can push to,
        /// e.g. https://github.com/<owner>/<repo>.git or git@github.com:….
        downstream: String,
        #[arg(long)]
        data_dir: Option<String>,
        /// Record the bridge without pushing. The next push (or `sync`)
        /// forwards.
        #[arg(long)]
        no_push: bool,
    },
    /// List the bridges on this node and when each last forwarded.
    List {
        #[arg(long)]
        data_dir: Option<String>,
    },
    /// Forward one bridged repo (or every one) to its downstream now.
    Sync {
        /// Repo id to forward. Omit with --all to forward every bridge.
        id: Option<String>,
        /// Forward every bridged repo on the node.
        #[arg(long)]
        all: bool,
        #[arg(long)]
        data_dir: Option<String>,
    },
    /// Stop forwarding a repo. The downstream keeps what it has; it
    /// simply stops updating.
    Remove {
        /// Repo id to stop bridging.
        id: String,
        #[arg(long)]
        data_dir: Option<String>,
    },
}

/// What a node records about a bridged repo. No credential ever lands here.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BridgeConfig {
    pub schema_version: u32,
    pub repo_id: String,
    /// The URL forwarded to, as the operator gave it — guaranteed
    /// credential-free by `reject_credential_url` at `bridge add`.
    pub downstream: String,
    pub added_at: i64,
    /// Unix seconds of the last forward attempt, successful or not.
    #[serde(default)]
    pub last_push: i64,
    /// Whether that attempt succeeded.
    #[serde(default)]
    pub last_push_ok: bool,
    /// Why the last attempt failed, if it did. Cleared on success.
    #[serde(default)]
    pub last_error: Option<String>,
}

impl BridgeConfig {
    pub fn new(repo_id: &str, downstream: &str, now: i64) -> Self {
        Self {
            schema_version: BRIDGE_VERSION,
            repo_id: repo_id.to_string(),
            downstream: downstream.to_string(),
            added_at: now,
            last_push: 0,
            last_push_ok: false,
            last_error: None,
        }
    }
}

pub fn bridge_path(repo_git_dir: &Path) -> PathBuf {
    repo_git_dir.join(BRIDGE_FILE)
}

/// Read a repo's bridge record. `Ok(None)` means it forwards nowhere.
pub fn read(repo_git_dir: &Path) -> Result<Option<BridgeConfig>, String> {
    let path = bridge_path(repo_git_dir);
    if !path.exists() {
        return Ok(None);
    }
    let raw =
        std::fs::read_to_string(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let cfg: BridgeConfig =
        serde_json::from_str(&raw).map_err(|e| format!("parse {}: {e}", path.display()))?;
    Ok(Some(cfg))
}

pub fn write(repo_git_dir: &Path, cfg: &BridgeConfig) -> Result<(), String> {
    let path = bridge_path(repo_git_dir);
    let body = serde_json::to_string_pretty(cfg).map_err(|e| format!("serialize bridge: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, format!("{body}\n"))
        .map_err(|e| format!("write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("rename into {}: {e}", path.display()))?;
    Ok(())
}

/// Cheap "is this bridged?" check for the post-push path.
pub fn is_bridge(repo_git_dir: &Path) -> bool {
    bridge_path(repo_git_dir).is_file()
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

// ─── Forward engine ──────────────────────────────────────────────────────────

/// Push one bridged repo's branches and tags to its downstream, and
/// record the outcome on the bridge record either way.
///
/// Shells out to `git push` for the same load-bearing reason mirrors
/// shell out to fetch: the downstream may itself be `aura://…`, whose
/// transport is the `git-remote-aura` PATH helper libgit2 cannot drive.
pub fn forward_one(store: &NodeStore, id: &str, cfg: &mut BridgeConfig) -> Result<(), String> {
    let path = store
        .repo_path(id)
        .ok_or_else(|| format!("invalid repo id '{id}'"))?;

    let mut cmd = Command::new("git");
    cmd.arg("--git-dir")
        .arg(&path)
        .arg("push")
        .arg("--quiet")
        .arg(&cfg.downstream)
        // Anchor the child's cwd: this runs from background tasks whose
        // inherited cwd may no longer exist, and git refuses to start when
        // it can't read its working directory.
        .current_dir(&path);
    for spec in REFSPECS {
        cmd.arg(spec);
    }
    // A forward runs unattended (post-push hook, timer, background task);
    // a credential prompt there is a hang, not a question. Configured
    // helpers still answer.
    cmd.env("GIT_TERMINAL_PROMPT", "0");

    let out = cmd.output().map_err(|e| format!("run git push: {e}"))?;

    cfg.last_push = now_secs();
    if out.status.success() {
        cfg.last_push_ok = true;
        cfg.last_error = None;
        write(&path, cfg)?;
        Ok(())
    } else {
        let err = scrub_userinfo(String::from_utf8_lossy(&out.stderr).trim());
        let detail = if err.is_empty() {
            format!("git push exited {}", out.status)
        } else {
            err
        };
        cfg.last_push_ok = false;
        cfg.last_error = Some(detail.clone());
        let _ = write(&path, cfg);
        Err(detail)
    }
}

/// Best-effort post-push forward, called from the serving path after a
/// successful receive-pack. Never returns an error — the push already
/// succeeded and its ref-log entry is written; a downstream failure is
/// recorded on the bridge record and printed to the node's console.
pub fn forward_after_push(store: &NodeStore, id: &str) {
    let Some(path) = store.repo_path(id) else {
        return;
    };
    let mut cfg = match read(&path) {
        Ok(Some(c)) => c,
        Ok(None) => return,
        Err(e) => {
            eprintln!("aura node: bridge record unreadable for {id}: {e}");
            return;
        }
    };
    match forward_one(store, id, &mut cfg) {
        Ok(()) => eprintln!("aura node: {id} forwarded to {}", cfg.downstream),
        Err(e) => eprintln!(
            "aura node: forward of {id} to {} failed ({e}) — recorded; retried on next push or `aura node bridge sync {id}`",
            cfg.downstream
        ),
    }
}

/// Every bridge on the node, by repo id.
pub fn all_bridges(store: &NodeStore) -> BTreeMap<String, BridgeConfig> {
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

// ─── Commands ────────────────────────────────────────────────────────────────

pub fn run(
    sub: &BridgeSubcommands,
    resolve_data_dir: impl Fn(Option<&str>) -> PathBuf,
) -> Result<(), Box<dyn std::error::Error>> {
    match sub {
        BridgeSubcommands::Add {
            id,
            downstream,
            data_dir,
            no_push,
        } => {
            let store = NodeStore::new(resolve_data_dir(data_dir.as_deref()))?;
            run_add(&store, id, downstream, *no_push)
        }
        BridgeSubcommands::List { data_dir } => {
            let store = NodeStore::new(resolve_data_dir(data_dir.as_deref()))?;
            run_list(&store)
        }
        BridgeSubcommands::Sync { id, all, data_dir } => {
            let store = NodeStore::new(resolve_data_dir(data_dir.as_deref()))?;
            run_sync(&store, id.as_deref(), *all)
        }
        BridgeSubcommands::Remove { id, data_dir } => {
            let store = NodeStore::new(resolve_data_dir(data_dir.as_deref()))?;
            run_remove(&store, id)
        }
    }
}

fn run_add(
    store: &NodeStore,
    id: &str,
    downstream: &str,
    no_push: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    if !NodeStore::is_valid_id(id) {
        return Err(format!(
            "'{id}' is not a valid repo id — use ascii letters, digits, '-' and '_'"
        )
        .into());
    }
    reject_credential_url(downstream)?;
    if !store.exists(id) {
        return Err(format!(
            "{id} is not hosted on this node yet — push it first, or see `aura node list`"
        )
        .into());
    }
    let path = store.repo_path(id).ok_or("invalid repo id")?;
    if mirror::is_mirror(&path) {
        return Err(format!(
            "{id} is a mirror — it follows an upstream, and forwarding it back out would relay \
             somebody else's repository. Bridge only repos that are pushed to here."
        )
        .into());
    }
    if let Ok(Some(existing)) = read(&path) {
        return Err(format!(
            "{id} already bridges to {} — remove it first with `aura node bridge remove {id}`",
            existing.downstream
        )
        .into());
    }

    let mut cfg = BridgeConfig::new(id, downstream, now_secs());
    write(&path, &cfg)?;

    println!("{}", "◆ bridge added".bold());
    println!("  • {} → {}", id.cyan(), downstream.dimmed());
    println!("  • every accepted push now forwards automatically");

    if no_push {
        println!("  • not pushed yet — run `aura node bridge sync {id}`");
        return Ok(());
    }

    match forward_one(store, id, &mut cfg) {
        Ok(()) => {
            println!("  {} forwarded to {}", "✓".green(), downstream.dimmed());
            Ok(())
        }
        // The record stays so the operator can fix credentials and retry
        // without retyping the URL — but the command still fails, because a
        // bridge that has never once reached its downstream is a trap.
        Err(e) => Err(format!(
            "first forward failed: {e}\n  the bridge is recorded — fix the cause and run `aura node bridge sync {id}`"
        )
        .into()),
    }
}

fn run_list(store: &NodeStore) -> Result<(), Box<dyn std::error::Error>> {
    let bridges = all_bridges(store);
    if bridges.is_empty() {
        println!("{}", "no bridges on this node".dimmed());
        println!("  → add one: aura node bridge add <repo-id> https://github.com/<owner>/<repo>.git");
        return Ok(());
    }
    println!("{}", format!("◆ {} bridge(s)", bridges.len()).bold());
    for (id, cfg) in &bridges {
        println!("  • {}", id.cyan());
        println!("      downstream  {}", cfg.downstream.dimmed());
        if cfg.last_push == 0 {
            println!("      forwarded   {}", "never".yellow());
        } else if cfg.last_push_ok {
            println!(
                "      forwarded   {} ago",
                mirror::humanize_age(now_secs() - cfg.last_push)
            );
        } else {
            println!(
                "      forwarded   {} ago · {}",
                mirror::humanize_age(now_secs() - cfg.last_push),
                "FAILED".red()
            );
            // git errors run several lines; the first carries the cause.
            if let Some(line) = cfg.last_error.as_deref().and_then(|e| e.lines().next()) {
                println!("      error       {}", line.red());
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
        let bridges = all_bridges(store);
        if bridges.is_empty() {
            println!("{}", "no bridges on this node".dimmed());
            return Ok(());
        }
        let mut failed = 0;
        for (id, mut cfg) in bridges {
            match forward_one(store, &id, &mut cfg) {
                Ok(()) => println!(
                    "  {} {} → {}",
                    "✓".green(),
                    id.cyan(),
                    cfg.downstream.dimmed()
                ),
                Err(e) => {
                    failed += 1;
                    println!("  {} {} — {}", "✗".red(), id.cyan(), e.red());
                }
            }
        }
        if failed > 0 {
            return Err(format!("{failed} bridge(s) failed to forward").into());
        }
        return Ok(());
    }

    let id = id.ok_or("pass a repo id, or --all to forward every bridge")?;
    let path = store.repo_path(id).ok_or("invalid repo id")?;
    let mut cfg = read(&path)?
        .ok_or_else(|| format!("{id} is not bridged — see `aura node bridge list`"))?;
    match forward_one(store, id, &mut cfg) {
        Ok(()) => {
            println!(
                "  {} {} → {}",
                "✓".green(),
                id.cyan(),
                cfg.downstream.dimmed()
            );
            Ok(())
        }
        Err(e) => Err(format!("forward failed: {e}").into()),
    }
}

fn run_remove(store: &NodeStore, id: &str) -> Result<(), Box<dyn std::error::Error>> {
    let path = store.repo_path(id).ok_or("invalid repo id")?;
    if read(&path)?.is_none() {
        return Err(format!("{id} is not bridged on this node").into());
    }
    std::fs::remove_file(bridge_path(&path)).map_err(|e| format!("remove bridge record: {e}"))?;
    println!("{}", "◆ bridge removed".bold());
    println!("  • {} no longer forwards — the downstream keeps what it has", id.cyan());
    Ok(())
}

// ─── credential guard ────────────────────────────────────────────────────────
//
// The bridge promises that no downstream credential is ever stored. The
// record holds the URL the operator gave, so that promise only holds if a
// credential-bearing URL never gets in. `https://user:tok@host/…` and the
// bare-token `https://tok@host/…` are the two shapes people reach for when
// scripting a push, and either would land the secret in aura-bridge.json
// inside the bare repo and echo it on every forward.
//
// SSH is the case that must NOT be caught: `git@github.com:o/r.git` is
// scp-style with no scheme, and `ssh://git@host/…` carries a username, not
// a secret. So the rule is narrow — reject userinfo on http/https, and
// reject a password component (`user:pass@`) on any scheme.

/// The `userinfo` of a scheme'd URL (`scheme://userinfo@host/…`), if any.
/// Returns `None` for scp-style `git@host:path`, which has no scheme.
fn scheme_userinfo(url: &str) -> Option<(&str, &str)> {
    let (scheme, rest) = url.split_once("://")?;
    let authority = rest.split(['/', '?', '#']).next().unwrap_or(rest);
    let (userinfo, _) = authority.rsplit_once('@')?;
    Some((scheme, userinfo))
}

/// Reject a downstream URL that carries a secret, naming the alternative.
/// Anything git can authenticate on its own is left alone.
fn reject_credential_url(url: &str) -> Result<(), String> {
    let Some((scheme, userinfo)) = scheme_userinfo(url) else {
        return Ok(()); // scp-style git@host:path — a username, not a secret
    };
    let has_password = userinfo.contains(':');
    let is_web = scheme.eq_ignore_ascii_case("http") || scheme.eq_ignore_ascii_case("https");
    if !has_password && !is_web {
        return Ok(()); // ssh://git@host/… — a username, not a secret
    }
    Err(format!(
        "that downstream URL carries a credential in it ({}://…@…). A bridge record lives in \
         the bare repo and is printed on every forward, so the secret would be stored and \
         logged. Give the plain URL instead — the forward already uses whatever git on this \
         machine authenticates with (credential helper, or an SSH remote like \
         git@host:owner/repo.git).",
        scheme
    ))
}

/// Blank out any `userinfo@` git echoed back at us. git prints the remote
/// it failed to reach, so an auth failure can quote a URL we never stored.
fn scrub_userinfo(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(i) = rest.find("://") {
        let (head, tail) = rest.split_at(i + 3);
        out.push_str(head);
        let end = tail
            .find(|c: char| c.is_whitespace() || c == '/' || c == '\'' || c == '"')
            .unwrap_or(tail.len());
        let (authority, after) = tail.split_at(end);
        match authority.rsplit_once('@') {
            Some((_, host)) => {
                out.push_str("[REDACTED]@");
                out.push_str(host);
            }
            None => out.push_str(authority),
        }
        rest = after;
    }
    out.push_str(rest);
    out
}

// ─── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn store() -> (TempDir, NodeStore) {
        let dir = TempDir::new().unwrap();
        let store = NodeStore::new(dir.path().join("repos")).unwrap();
        (dir, store)
    }

    fn git(args: &[&str], cwd: &Path) {
        let out = Command::new("git")
            .args(args)
            .current_dir(cwd)
            .env("GIT_TERMINAL_PROMPT", "0")
            .output()
            .expect("run git");
        assert!(
            out.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&out.stderr)
        );
    }

    /// Give a hosted repo one real commit on `main` so a forward has
    /// something to push.
    fn seed_commit(store: &NodeStore, id: &str, scratch: &Path) {
        let bare = store.open_or_init(id).unwrap();
        let work = scratch.join("work");
        std::fs::create_dir_all(&work).unwrap();
        git(&["init", "-q", "-b", "main", "."], &work);
        git(&["config", "user.name", "T"], &work);
        git(&["config", "user.email", "t@t.io"], &work);
        std::fs::write(work.join("a.txt"), "hello").unwrap();
        git(&["add", "a.txt"], &work);
        git(&["commit", "-qm", "one"], &work);
        git(
            &["push", "-q", bare.to_str().unwrap(), "main:main"],
            &work,
        );
    }

    #[test]
    fn record_round_trips_and_marks_the_repo_bridged() {
        let (_dir, store) = store();
        let path = store.open_or_init("r1").unwrap();
        assert!(!is_bridge(&path));

        let cfg = BridgeConfig::new("r1", "https://example.com/x.git", 42);
        write(&path, &cfg).unwrap();
        assert!(is_bridge(&path));

        let back = read(&path).unwrap().expect("record present");
        assert_eq!(back.downstream, "https://example.com/x.git");
        assert_eq!(back.repo_id, "r1");
        assert_eq!(back.last_push, 0, "never forwarded yet");
    }

    #[test]
    fn forward_pushes_branches_to_the_downstream() {
        let (dir, store) = store();
        seed_commit(&store, "r1", dir.path());

        // A local bare repo stands in for GitHub.
        let downstream = dir.path().join("github.git");
        git(
            &["init", "-q", "--bare", downstream.to_str().unwrap()],
            dir.path(),
        );

        let path = store.repo_path("r1").unwrap();
        let mut cfg = BridgeConfig::new("r1", downstream.to_str().unwrap(), now_secs());
        write(&path, &cfg).unwrap();

        forward_one(&store, "r1", &mut cfg).expect("forward succeeds");
        assert!(cfg.last_push_ok);
        assert!(cfg.last_error.is_none());

        // The downstream now has the branch at the same tip.
        let ours = Command::new("git")
            .args(["--git-dir", path.to_str().unwrap(), "rev-parse", "refs/heads/main"])
            .current_dir(dir.path())
            .output()
            .unwrap();
        let theirs = Command::new("git")
            .args(["--git-dir", downstream.to_str().unwrap(), "rev-parse", "refs/heads/main"])
            .current_dir(dir.path())
            .output()
            .unwrap();
        assert!(theirs.status.success(), "downstream has the branch");
        assert_eq!(
            String::from_utf8_lossy(&ours.stdout),
            String::from_utf8_lossy(&theirs.stdout),
            "same tip on both sides"
        );
    }

    #[test]
    fn failed_forward_is_recorded_not_swallowed() {
        let (dir, store) = store();
        seed_commit(&store, "r1", dir.path());
        let path = store.repo_path("r1").unwrap();
        let mut cfg = BridgeConfig::new(
            "r1",
            dir.path().join("nowhere.git").to_str().unwrap(),
            now_secs(),
        );
        write(&path, &cfg).unwrap();

        let err = forward_one(&store, "r1", &mut cfg).unwrap_err();
        assert!(!err.is_empty());

        let back = read(&path).unwrap().unwrap();
        assert!(!back.last_push_ok);
        assert!(back.last_error.is_some(), "the failure is on the record");
        assert!(back.last_push > 0, "the attempt time is recorded");
    }

    #[test]
    fn forward_after_push_is_a_quiet_noop_without_a_bridge() {
        let (dir, store) = store();
        seed_commit(&store, "r1", dir.path());
        // No bridge record — must simply do nothing.
        forward_after_push(&store, "r1");
        forward_after_push(&store, "definitely-not-hosted");
    }

    #[test]
    fn a_mirror_cannot_be_bridged() {
        let (_dir, store) = store();
        let path = store.open_or_init("m1").unwrap();
        let mcfg = mirror::MirrorConfig::new("m1", "https://github.com/x/y.git", 42);
        mirror::write(&path, &mcfg).unwrap();

        let err = run_add(&store, "m1", "https://github.com/a/b.git", true)
            .expect_err("bridging a mirror must refuse");
        assert!(err.to_string().contains("mirror"), "got: {err}");
    }

    #[test]
    fn a_downstream_url_carrying_a_credential_is_refused() {
        for url in [
            "https://ashiq:ghp_examplevalue@github.com/o/r.git",
            "https://ghp_examplevalue@github.com/o/r.git",
            "http://user:pw@example.com/r.git",
            "ssh://user:pw@example.com/r.git",
        ] {
            let err = reject_credential_url(url).unwrap_err();
            assert!(err.contains("carries a credential"), "{url}: {err}");
        }
    }

    #[test]
    fn the_normal_ways_to_reach_a_forge_still_pass() {
        for url in [
            "https://github.com/o/r.git",
            "git@github.com:o/r.git",
            "ssh://git@github.com/o/r.git",
            "aura://node.example/r",
            "/srv/mirrors/r.git",
        ] {
            assert!(reject_credential_url(url).is_ok(), "{url} should be allowed");
        }
    }

    #[test]
    fn add_refuses_before_writing_any_record() {
        let (_d, store) = store();
        let id = "r1";
        store.open_or_init(id).unwrap();
        let err = run_add(&store, id, "https://x:ghp_examplevalue@github.com/o/r.git", true)
            .unwrap_err()
            .to_string();
        assert!(err.contains("carries a credential"), "got: {err}");
        let path = store.repo_path(id).unwrap();
        assert!(
            read(&path).unwrap().is_none(),
            "a refused bridge must leave no record behind"
        );
    }

    #[test]
    fn git_errors_lose_any_userinfo_they_quote_back() {
        let raw = "fatal: could not read from 'https://bob:ghp_examplevalue@github.com/o/r.git'\nremote: denied";
        let out = scrub_userinfo(raw);
        assert!(!out.contains("ghp_examplevalue"), "token survived: {out}");
        assert!(!out.contains("bob"), "username survived: {out}");
        assert!(out.contains("[REDACTED]@github.com/o/r.git"), "host lost: {out}");
        assert!(out.contains("remote: denied"), "rest of the message lost: {out}");
    }

    #[test]
    fn a_clean_error_is_left_exactly_as_git_wrote_it() {
        let raw = "fatal: repository 'https://github.com/o/r.git' not found";
        assert_eq!(scrub_userinfo(raw), raw);
    }

}
