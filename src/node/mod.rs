//! `aura serve` — a self-hostable Aura git-hosting node.
//!
//! This is the substrate half of the sovereign-git track: a node you run
//! yourself that hosts repositories keyed by their **Aura repo id** (the
//! signed UUID minted by `aura repo-id init`, or any 64-hex room id) and
//! serves them over the standard **git smart-HTTP** protocol. A stock
//! `git clone` / `git push` works against it with no GitHub in the loop.
//!
//! Objects are stored as ordinary bare git repositories under the node's data
//! directory — git's object database is already content-addressed by SHA, so
//! hosting bare repos gives us a correct content-addressed store for free. The
//! wire protocol is handled by shelling out to `git http-backend` (git's own
//! smart-HTTP server), so negotiation, packfile encode/decode, and ref
//! advertisement are exactly git's, not a reimplementation.
//!
//! Every ref update on push is signed into a tamper-evident, hash-chained log
//! (P2a, see [`reflog`]) that any client can verify. Push (and, unless
//! `--public-read`, clone/fetch) can be gated behind signed **capability
//! tokens** (P2b, see [`auth`]) minted with the node's own identity key. The
//! node still refuses to bind a non-loopback address without `--allow-remote`,
//! and off loopback it demands `--require-auth` unless `--allow-anonymous` is
//! passed, so it can never be *accidentally* exposed unauthenticated.

mod auth;
mod pins;
mod reflog;
mod smart_http;

use std::collections::BTreeMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use clap::Subcommand;
use colored::Colorize;

use aura_attestation::{SigningKey, VerifyingKey};

pub use reflog::{RefChange, ZERO_OID};

#[derive(Subcommand)]
pub enum NodeSubcommands {
    /// Run the node: serve hosted repos over git smart-HTTP.
    Serve {
        /// Address to bind. Non-loopback requires `--allow-remote`.
        #[arg(long, default_value = "127.0.0.1:9419")]
        addr: String,
        /// Where hosted repos live (default: `~/.aura/node/repos`).
        #[arg(long)]
        data_dir: Option<String>,
        /// Permit binding a non-loopback address. Off loopback you must also
        /// pass --require-auth (or the explicit --allow-anonymous override).
        #[arg(long)]
        allow_remote: bool,
        /// Require a signed capability token for push (and for read unless
        /// --public-read). Tokens are minted with `aura node token`.
        #[arg(long)]
        require_auth: bool,
        /// With --require-auth, still allow anonymous clone/fetch (only push is
        /// gated). Handy for a public repo that accepts authenticated pushes.
        #[arg(long)]
        public_read: bool,
        /// Explicitly serve a non-loopback address WITHOUT auth. A foot-gun:
        /// anyone who can reach the port can push. Only for trusted networks.
        #[arg(long)]
        allow_anonymous: bool,
    },
    /// List the repos hosted on this node.
    List {
        #[arg(long)]
        data_dir: Option<String>,
    },
    /// Show the signed, tamper-evident ref-log for one hosted repo and verify
    /// its chain (node-operator view; reads the on-disk log directly).
    Reflog {
        /// Repo id as hosted on this node.
        id: String,
        #[arg(long)]
        data_dir: Option<String>,
        /// Print each entry as raw NDJSON instead of a table.
        #[arg(long)]
        json: bool,
    },
    /// Fetch a repo's signed ref-log from a node and verify it end-to-end — the
    /// "any client can check the branch history for itself" proof. The URL may
    /// be `aura://host/<id>` or `http(s)://host/<id>`.
    VerifyLog {
        /// Node URL including the repo id, e.g. `aura://localhost/<id>`.
        url: String,
        /// Require every entry to be signed by this key id (`did:aura:key/…`).
        #[arg(long)]
        expect_key: Option<String>,
        /// Record (or advance) the local head-hash pin for this repo after a
        /// successful verify, so a later rollback can be detected. On first use
        /// this establishes the pin (trust-on-first-use).
        #[arg(long)]
        pin: bool,
        /// Skip checking the fetched log against any stored pin. By default a
        /// rollback (a shrunk or rewritten history) fails the command.
        #[arg(long)]
        no_pin_check: bool,
        /// Override the pin-store location (default `~/.aura/reflog-pins.json`).
        #[arg(long)]
        pins_file: Option<String>,
    },
    /// Mint a signed capability token that authorizes clone/push to a repo on
    /// this node. Present it to stock git via the URL
    /// (`aura://x-access-token:<token>@host/<id>`) or when git prompts.
    Token {
        /// Repo id to scope the token to. Omit with --all-repos for a token
        /// valid on every repo this node hosts.
        id: Option<String>,
        /// Scope the token to every repo on the node (`*`).
        #[arg(long)]
        all_repos: bool,
        /// Grant push (receive-pack). Implies read.
        #[arg(long)]
        push: bool,
        /// Grant read (upload-pack / clone / fetch).
        #[arg(long)]
        read: bool,
        /// Time-to-live in seconds (default 30 days; `0` = never expires).
        #[arg(long)]
        ttl: Option<i64>,
        #[arg(long)]
        data_dir: Option<String>,
    },
    /// Install the `git-remote-aura` helper onto PATH so stock git can clone,
    /// fetch and push `aura://` URLs. Creates a `git-remote-aura` symlink to the
    /// running `aura` binary (which acts as the helper when invoked by that
    /// name), next to `aura` by default.
    InstallHelper {
        /// Directory to install into (must be on PATH). Defaults to the
        /// directory containing the running `aura` binary.
        #[arg(long)]
        dir: Option<String>,
        /// Replace an existing `git-remote-aura` at the target path.
        #[arg(long)]
        force: bool,
    },
}

pub fn run(sub: &NodeSubcommands) -> Result<(), Box<dyn std::error::Error>> {
    match sub {
        NodeSubcommands::Serve {
            addr,
            data_dir,
            allow_remote,
            require_auth,
            public_read,
            allow_anonymous,
        } => run_serve(
            addr,
            data_dir.as_deref(),
            ServeAuth {
                allow_remote: *allow_remote,
                require_auth: *require_auth,
                public_read: *public_read,
                allow_anonymous: *allow_anonymous,
            },
        ),
        NodeSubcommands::List { data_dir } => run_list(data_dir.as_deref()),
        NodeSubcommands::Reflog { id, data_dir, json } => {
            run_reflog(id, data_dir.as_deref(), *json)
        }
        NodeSubcommands::VerifyLog {
            url,
            expect_key,
            pin,
            no_pin_check,
            pins_file,
        } => run_verify_log(
            url,
            expect_key.as_deref(),
            VerifyPin {
                record: *pin,
                check: !*no_pin_check,
                store: pins_file.as_deref(),
            },
        ),
        NodeSubcommands::Token {
            id,
            all_repos,
            push,
            read,
            ttl,
            data_dir,
        } => run_token(id.as_deref(), *all_repos, *push, *read, *ttl, data_dir.as_deref()),
        NodeSubcommands::InstallHelper { dir, force } => {
            run_install_helper(dir.as_deref(), *force)
        }
    }
}

/// Auth configuration for `aura node serve`, parsed from its flags.
struct ServeAuth {
    allow_remote: bool,
    require_auth: bool,
    public_read: bool,
    allow_anonymous: bool,
}

/// How `verify-log` should interact with the local rollback pin store.
struct VerifyPin<'a> {
    /// Record/advance the pin after a successful verify.
    record: bool,
    /// Check the fetched log against any existing pin (fail on a rollback).
    check: bool,
    /// Override for the pin-store path.
    store: Option<&'a str>,
}

/// Default data directory: `~/.aura/node/repos`.
fn default_data_dir() -> PathBuf {
    let home = std::env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."));
    home.join(".aura").join("node").join("repos")
}

fn resolve_data_dir(data_dir: Option<&str>) -> PathBuf {
    data_dir.map(PathBuf::from).unwrap_or_else(default_data_dir)
}

fn run_serve(
    addr: &str,
    data_dir: Option<&str>,
    auth: ServeAuth,
) -> Result<(), Box<dyn std::error::Error>> {
    // Fail fast if the system git can't provide the smart-HTTP backend.
    smart_http::ensure_http_backend()?;

    let sock: SocketAddr = addr
        .parse()
        .map_err(|e| format!("invalid --addr '{addr}': {e}"))?;
    if !sock.ip().is_loopback() {
        if !auth.allow_remote {
            return Err(format!(
                "refusing to bind non-loopback {sock} without --allow-remote — pass \
                 --allow-remote (and --require-auth) once it is behind your own TLS."
            )
            .into());
        }
        // Exposed to the network: demand capability-token auth unless the
        // operator explicitly opts into an anonymous, trusted-network node.
        if !auth.require_auth && !auth.allow_anonymous {
            return Err(format!(
                "refusing to expose {sock} without auth — pass --require-auth to gate push \
                 with capability tokens (recommended), or --allow-anonymous to serve it open \
                 on a trusted network."
            )
            .into());
        }
    }

    let root = resolve_data_dir(data_dir);
    let mut store = NodeStore::new(root.clone())?;
    let node_id = store.load_key()?;
    store.set_auth(auth.require_auth, auth.public_read);
    let store = Arc::new(store);

    println!(
        "{} Aura node serving {} on {}",
        "◆".cyan().bold(),
        root.display().to_string().dimmed(),
        format!("http://{sock}").cyan()
    );
    println!(
        "  {} node identity {} {}",
        "•".dimmed(),
        node_id.cyan(),
        "· signs the tamper-evident ref-log on every push".dimmed()
    );
    if auth.require_auth {
        let scope = if auth.public_read {
            "push requires a capability token; clone/fetch is public"
        } else {
            "push and clone/fetch require a capability token"
        };
        println!(
            "  {} auth {} {}",
            "•".dimmed(),
            "ON".green().bold(),
            format!("· {scope} · mint one with `aura node token`").dimmed()
        );
    } else {
        println!(
            "  {} auth {} {}",
            "•".dimmed(),
            "OFF".yellow().bold(),
            "· anyone who can reach this port can push".dimmed()
        );
    }
    let hosted = store.list();
    if hosted.is_empty() {
        println!(
            "  {} no repos yet — {} to a repo id to create one:",
            "•".dimmed(),
            "git push".bold()
        );
        println!(
            "    {}",
            format!("git push http://{sock}/<repo-id> <branch>").dimmed()
        );
    } else {
        println!("  {} {} repo(s) hosted:", "•".dimmed(), hosted.len());
        for id in &hosted {
            println!("    {} {}", "→".dimmed(), id);
        }
    }

    let rt = tokio::runtime::Runtime::new().map_err(|e| format!("tokio runtime: {e}"))?;
    rt.block_on(async move {
        let app = smart_http::router(store);
        let listener = tokio::net::TcpListener::bind(sock)
            .await
            .map_err(|e| format!("bind {sock}: {e}"))?;
        axum::serve(listener, app)
            .await
            .map_err(|e| format!("serve: {e}"))?;
        Ok::<(), String>(())
    })?;
    Ok(())
}

fn run_list(data_dir: Option<&str>) -> Result<(), Box<dyn std::error::Error>> {
    let root = resolve_data_dir(data_dir);
    let store = NodeStore::new(root.clone())?;
    let hosted = store.list();
    if hosted.is_empty() {
        println!("{} no repos hosted under {}", "•".yellow(), root.display());
        return Ok(());
    }
    println!("{} {} repo(s) under {}:", "◆".cyan(), hosted.len(), root.display());
    for id in hosted {
        println!("  {} {}", "→".dimmed(), id);
    }
    Ok(())
}

/// `aura node token` — mint a signed capability token that authorizes clone
/// and/or push to a repo hosted on this node. Signed with the node's own
/// identity key, so the same node verifies it later with no external state.
fn run_token(
    id: Option<&str>,
    all_repos: bool,
    push: bool,
    read: bool,
    ttl: Option<i64>,
    data_dir: Option<&str>,
) -> Result<(), Box<dyn std::error::Error>> {
    let scope = if all_repos {
        auth::SCOPE_ALL.to_string()
    } else {
        let id = id.ok_or("provide a repo id, or --all-repos for a node-wide token")?;
        if !NodeStore::is_valid_id(id) {
            return Err(format!("invalid repo id '{id}'").into());
        }
        id.to_string()
    };

    let caps = auth::normalize_caps(push, read);
    if caps.is_empty() {
        return Err("grant at least one capability: --push and/or --read".into());
    }

    // Default 30-day TTL; `--ttl 0` mints a non-expiring token.
    let ttl = ttl.unwrap_or(30 * 24 * 3600);
    let now = chrono::Utc::now().timestamp();

    let store = NodeStore::new(resolve_data_dir(data_dir))?;
    let key = store.node_signing_key()?;
    let issuer = key.key_id();
    let token = auth::CapabilityToken::new(scope.clone(), caps.clone(), now, ttl).issue(&key)?;

    let scope_display = if scope == auth::SCOPE_ALL {
        "* (every repo on this node)".to_string()
    } else {
        scope.clone()
    };
    println!("{} capability token minted", "◆".cyan().bold());
    println!("  {} repo   {}", "•".dimmed(), scope_display);
    println!("  {} caps   {}", "•".dimmed(), caps.join(", "));
    println!("  {} issuer {}", "•".dimmed(), issuer.dimmed());
    if ttl <= 0 {
        println!("  {} expiry {}", "•".dimmed(), "never".dimmed());
    } else {
        println!(
            "  {} expiry {}",
            "•".dimmed(),
            format!("in {ttl}s (unix {})", now + ttl).dimmed()
        );
    }
    println!();
    println!("{}", token.bold());
    println!();
    let id_hint = if scope == auth::SCOPE_ALL { "<repo-id>" } else { &scope };
    println!("  {} clone/push with stock git:", "→".dimmed());
    println!(
        "      {}",
        format!("git clone aura://x-access-token:{token}@<host>/{id_hint}").dimmed()
    );
    Ok(())
}

/// `aura node reflog <id>` — node-operator view of one repo's signed ref-log,
/// read straight off disk and chain-verified.
fn run_reflog(
    id: &str,
    data_dir: Option<&str>,
    json: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let root = resolve_data_dir(data_dir);
    let store = NodeStore::new(root.clone())?;
    if !store.exists(id) {
        return Err(format!("no repo '{id}' hosted under {}", root.display()).into());
    }
    let git_dir = store.repo_path(id).ok_or("invalid repo id")?;
    let entries = reflog::read_entries(&git_dir)?;

    if json {
        for e in &entries {
            println!("{}", serde_json::to_string(e)?);
        }
        // Verify anyway so a bad chain still fails the command.
        reflog::verify_chain(&entries, Some(id))?;
        return Ok(());
    }
    print_reflog_report(id, &entries)?;
    Ok(())
}

/// `aura node verify-log <url>` — fetch a repo's signed ref-log from a node and
/// verify it end-to-end. This is the client-side proof: the branch history a
/// node serves you is checkable with nothing but the log itself.
fn run_verify_log(
    url: &str,
    expect_key: Option<&str>,
    pin: VerifyPin<'_>,
) -> Result<(), Box<dyn std::error::Error>> {
    let (base, repo_id) = resolve_node_url(url)?;
    let reflog_url = format!("{base}/aura/reflog");
    println!("{} fetching ref-log from {}", "◆".cyan(), reflog_url.dimmed());
    let body = reqwest::blocking::get(&reflog_url)
        .and_then(|r| r.error_for_status())
        .and_then(|r| r.text())
        .map_err(|e| format!("fetch {reflog_url}: {e}"))?;

    let entries = reflog::parse_ndjson(&body)?;
    let summary = reflog::verify_chain(&entries, repo_id.as_deref())?;

    if let Some(want) = expect_key {
        if summary.signers != vec![want.to_string()] {
            return Err(format!(
                "signer pin failed: ref-log is signed by {:?}, expected only {want}",
                summary.signers
            )
            .into());
        }
    }
    print_verify_summary(repo_id.as_deref(), &summary);

    // Rollback protection (P2c): compare against, and optionally advance, the
    // local head-hash pin. The chain above only proves internal consistency; a
    // node could still serve a *shorter* valid chain. The pin is what turns a
    // silent rollback into a loud one.
    apply_rollback_pin(&entries, &base, &pin)?;
    Ok(())
}

/// Check the verified log against the stored pin and (with `--pin`) advance it.
/// A detected rollback returns an error so the command exits non-zero.
fn apply_rollback_pin(
    entries: &[reflog::SignedRefEntry],
    source: &str,
    opts: &VerifyPin<'_>,
) -> Result<(), Box<dyn std::error::Error>> {
    if !opts.check && !opts.record {
        return Ok(());
    }
    // The pinned repo id comes from the (already verified) entries; nothing to
    // pin for an empty log.
    let repo_id = match entries.iter().map(|e| e.repo_id.as_str()).next() {
        Some(id) => id.to_string(),
        None => return Ok(()),
    };

    let path = opts
        .store
        .map(PathBuf::from)
        .unwrap_or_else(pins::default_pins_path);
    let mut store = pins::load(&path)?;
    let existing = pins::find(&store, &repo_id).cloned();

    if opts.check {
        match pins::check(existing.as_ref(), entries) {
            pins::PinVerdict::FirstSight => {
                println!(
                    "  {} no rollback pin yet for this repo {}",
                    "•".dimmed(),
                    if opts.record {
                        "· recording one now (trust-on-first-use)".dimmed()
                    } else {
                        "· pass --pin to start tracking rollbacks".dimmed()
                    }
                );
            }
            pins::PinVerdict::Consistent { advanced } => {
                if advanced == 0 {
                    println!(
                        "  {} rollback pin OK — head unchanged since last verify",
                        "✓".green()
                    );
                } else {
                    println!(
                        "  {} rollback pin OK — history is append-only ({} new entr{} since pin)",
                        "✓".green(),
                        advanced,
                        if advanced == 1 { "y" } else { "ies" }
                    );
                }
            }
            pins::PinVerdict::Rollback { detail } => {
                return Err(format!(
                    "ROLLBACK DETECTED — {detail}. The node is serving a history that \
                     diverges from what you previously verified. Do not trust it. \
                     (Override with --no-pin-check only if you know the pin is stale.)"
                )
                .into());
            }
        }
    }

    if opts.record {
        if let Some(updated) = pins::build_pin(existing.as_ref(), entries, source, chrono::Utc::now().timestamp())
        {
            let seq = updated.seq;
            let head = updated.head_hash.clone();
            pins::upsert(&mut store, updated);
            pins::save(&path, &store)?;
            println!(
                "  {} pinned head seq {} ({}…) to {}",
                "✓".green().bold(),
                seq,
                &head[..head.len().min(12)],
                path.display().to_string().dimmed()
            );
        }
    }
    Ok(())
}

fn print_reflog_report(
    id: &str,
    entries: &[reflog::SignedRefEntry],
) -> Result<(), Box<dyn std::error::Error>> {
    if entries.is_empty() {
        println!(
            "{} repo {} has no ref-log yet (no pushes recorded)",
            "•".yellow(),
            id
        );
        return Ok(());
    }
    // Verify before printing the summary so a broken chain fails loudly.
    let summary = reflog::verify_chain(entries, Some(id))?;
    for e in entries {
        println!(
            "  {:>3}  {:<7} {}  {}..{}",
            e.seq,
            ref_action(&e.old, &e.new),
            e.reference,
            short(&e.old),
            short(&e.new),
        );
    }
    println!();
    println!(
        "  {} {} signed update(s), chain verified",
        "✓".green(),
        summary.count
    );
    println!("  {} signed by {}", "•".dimmed(), summary.signers.join(", "));
    println!("  {} head refs:", "•".dimmed());
    for (name, oid) in &summary.refs {
        println!("      {} {}", name, short(oid));
    }
    Ok(())
}

fn print_verify_summary(repo_id: Option<&str>, summary: &reflog::ChainSummary) {
    println!();
    println!(
        "  {} ref-log VERIFIED — every entry signed, chain intact",
        "✓".green().bold()
    );
    if let Some(id) = repo_id {
        println!("  {} repo {}", "•".dimmed(), id);
    }
    println!("  {} {} signed update(s)", "•".dimmed(), summary.count);
    println!("  {} signed by {}", "•".dimmed(), summary.signers.join(", "));
    if !summary.head_hash.is_empty() {
        println!(
            "  {} head hash {} {}",
            "•".dimmed(),
            short(&summary.head_hash),
            "· pass --pin to detect a later rollback".dimmed()
        );
    }
    println!("  {} current branch state:", "•".dimmed());
    for (name, oid) in &summary.refs {
        println!("      {} {}", name, short(oid));
    }
}

/// Install the `git-remote-aura` helper onto PATH.
///
/// The main `aura` binary is multi-call: invoked under the name
/// `git-remote-aura` it runs the remote helper (see the dispatch in `main`). So
/// "installing the helper" is just placing a `git-remote-aura` symlink to the
/// running `aura` binary somewhere on PATH — git resolves the scheme `aura` to
/// that name and runs it. `cargo install` already drops a real standalone
/// binary; this command is for installs that ship only `aura` (the app bundle),
/// or to add the helper to a chosen PATH directory.
fn run_install_helper(dir: Option<&str>, force: bool) -> Result<(), Box<dyn std::error::Error>> {
    // The binary git should exec for `aura://` remotes: the real `aura` on disk.
    // Canonicalize so the link points at the actual file, not another symlink.
    let source = std::env::current_exe()
        .map_err(|e| format!("cannot locate the running aura binary: {e}"))?;
    let source = std::fs::canonicalize(&source).unwrap_or(source);

    // Target directory: explicit --dir, else next to `aura` (already on PATH,
    // since the user ran `aura`).
    let target_dir = match dir {
        Some(d) => PathBuf::from(d),
        None => source
            .parent()
            .map(|p| p.to_path_buf())
            .ok_or("cannot determine the directory containing the aura binary")?,
    };
    if !target_dir.is_dir() {
        return Err(format!("target directory does not exist: {}", target_dir.display()).into());
    }

    let helper_name = if cfg!(windows) {
        "git-remote-aura.exe"
    } else {
        "git-remote-aura"
    };
    let target = target_dir.join(helper_name);

    // Already there? A real binary (cargo-install) or our own symlink both work
    // — leave it unless --force asks for a clean re-link.
    if target.exists() {
        if !force {
            let via = match std::fs::read_link(&target) {
                Ok(dest) => format!("symlink → {}", dest.display()),
                Err(_) => "existing binary".to_string(),
            };
            println!(
                "  {} git-remote-aura already installed at {} ({via})",
                "✓".green().bold(),
                target.display()
            );
            warn_if_not_on_path(&target_dir);
            print_helper_test_hint();
            return Ok(());
        }
        std::fs::remove_file(&target)
            .map_err(|e| format!("cannot replace {}: {e}", target.display()))?;
    }

    install_symlink(&source, &target)?;

    println!(
        "  {} installed git-remote-aura → {}",
        "✓".green().bold(),
        source.display()
    );
    println!("      {}", target.display().to_string().dimmed());
    warn_if_not_on_path(&target_dir);
    print_helper_test_hint();
    Ok(())
}

/// Create the `git-remote-aura` entry pointing at the `aura` binary. A symlink
/// on unix (so it always tracks the installed binary); a copy elsewhere, where
/// symlinks need privilege.
#[cfg(unix)]
fn install_symlink(source: &std::path::Path, target: &std::path::Path) -> Result<(), String> {
    std::os::unix::fs::symlink(source, target).map_err(|e| {
        format!(
            "cannot create symlink {} → {}: {e}",
            target.display(),
            source.display()
        )
    })
}

#[cfg(not(unix))]
fn install_symlink(source: &std::path::Path, target: &std::path::Path) -> Result<(), String> {
    std::fs::copy(source, target)
        .map(|_| ())
        .map_err(|e| format!("cannot copy {} → {}: {e}", source.display(), target.display()))
}

/// Warn (not fail) when the install directory is not on PATH — git only finds
/// the helper if it is.
fn warn_if_not_on_path(target_dir: &std::path::Path) {
    let canon_target = std::fs::canonicalize(target_dir).unwrap_or_else(|_| target_dir.to_path_buf());
    let on_path = std::env::var_os("PATH")
        .map(|paths| {
            std::env::split_paths(&paths).any(|p| {
                std::fs::canonicalize(&p).map(|c| c == canon_target).unwrap_or(false)
            })
        })
        .unwrap_or(false);
    if !on_path {
        println!(
            "  {} {} is not on your PATH — add it so git can find the helper:",
            "!".yellow().bold(),
            target_dir.display()
        );
        println!(
            "      {}",
            format!("export PATH=\"{}:$PATH\"", target_dir.display()).dimmed()
        );
    }
}

fn print_helper_test_hint() {
    println!(
        "  {} test it: {}",
        "→".dimmed(),
        "git clone aura://<host>/<repo-id>".dimmed()
    );
}

fn ref_action(old: &str, new: &str) -> &'static str {
    if old == ZERO_OID {
        "create"
    } else if new == ZERO_OID {
        "delete"
    } else {
        "update"
    }
}

fn short(oid: &str) -> String {
    if oid == ZERO_OID {
        "∅".to_string()
    } else {
        oid.chars().take(10).collect()
    }
}

/// Resolve a node URL for the ref-log fetch. Accepts `aura://` (rewritten to
/// the node's smart-HTTP the same way `git-remote-aura` does) and plain
/// `http(s)://`. Returns `(base_url_without_trailing_slash, repo_id)`.
fn resolve_node_url(url: &str) -> Result<(String, Option<String>), String> {
    let full = if let Some(rest) = url.strip_prefix("aura://") {
        let insecure = env_insecure();
        let (authority, path) = match rest.find('/') {
            Some(i) => (&rest[..i], &rest[i..]),
            None => (rest, ""),
        };
        if authority.is_empty() {
            return Err(format!("aura:// URL has no host: {url}"));
        }
        let (userinfo, hostport) = match authority.rfind('@') {
            Some(i) => (&authority[..=i], &authority[i + 1..]),
            None => ("", authority),
        };
        let (host, has_port) = split_host_port(hostport);
        let use_http = insecure || is_loopback_host(host);
        let scheme = if use_http { "http" } else { "https" };
        let hostport = if use_http && !has_port {
            format!("{hostport}:9419")
        } else {
            hostport.to_string()
        };
        format!("{scheme}://{userinfo}{hostport}{path}")
    } else if url.starts_with("http://") || url.starts_with("https://") {
        url.to_string()
    } else {
        return Err(format!(
            "unsupported node URL '{url}' — use aura://, http://, or https://"
        ));
    };
    let full = full.trim_end_matches('/').to_string();
    let repo_id = full
        .rsplit('/')
        .next()
        .map(|s| s.strip_suffix(".git").unwrap_or(s).to_string())
        .filter(|s| !s.is_empty());
    Ok((full, repo_id))
}

fn env_insecure() -> bool {
    std::env::var("AURA_REMOTE_INSECURE")
        .map(|v| matches!(v.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on"))
        .unwrap_or(false)
}

/// Extract host + whether an explicit port is present, handling `[ipv6]` forms.
/// Mirrors the resolver in `bin/git_remote_aura.rs` (kept in sync by hand; the
/// crate has no lib target to share it through).
fn split_host_port(hostport: &str) -> (&str, bool) {
    if let Some(close) = hostport.strip_prefix('[').and_then(|_| hostport.find(']')) {
        let host = &hostport[1..close];
        let has_port = hostport[close + 1..].starts_with(':');
        return (host, has_port);
    }
    match hostport.rfind(':') {
        Some(i)
            if hostport[i + 1..].chars().all(|c| c.is_ascii_digit()) && i + 1 < hostport.len() =>
        {
            (&hostport[..i], true)
        }
        _ => (hostport, false),
    }
}

fn is_loopback_host(host: &str) -> bool {
    matches!(
        host.to_ascii_lowercase().as_str(),
        "localhost" | "127.0.0.1" | "::1"
    )
}

/// A node's on-disk repo store. Repos are bare git repositories named
/// `<repo-id>.git` under a single root, so git's SHA-addressed object database
/// *is* the content store. Repo ids are strictly validated to a safe charset so
/// a request can never escape the root via `..` or a path separator.
pub struct NodeStore {
    root: PathBuf,
    /// The node's Ed25519 signing key, loaded when serving (used to sign the
    /// ref-log and capability tokens). `None` for read-only uses like
    /// `aura node list`.
    key: Option<SigningKey>,
    /// When true, gate git requests behind a valid capability token (P2b).
    require_auth: bool,
    /// With `require_auth`, still allow anonymous clone/fetch (gate push only).
    public_read: bool,
}

impl NodeStore {
    pub fn new(root: PathBuf) -> std::io::Result<Self> {
        std::fs::create_dir_all(&root)?;
        Ok(Self {
            root,
            key: None,
            require_auth: false,
            public_read: false,
        })
    }

    /// Set the capability-token auth policy for a serving node.
    pub fn set_auth(&mut self, require_auth: bool, public_read: bool) {
        self.require_auth = require_auth;
        self.public_read = public_read;
    }

    pub fn require_auth(&self) -> bool {
        self.require_auth
    }

    pub fn public_read(&self) -> bool {
        self.public_read
    }

    pub fn root(&self) -> &std::path::Path {
        &self.root
    }

    /// Path of the node's identity key file, kept in the data root. It is a
    /// plain file, so it is never mistaken for a hosted `<id>.git` repo dir.
    fn key_path(&self) -> PathBuf {
        self.root.join(".node-key")
    }

    /// Load-or-create the node signing key, retain it on the store, and return
    /// its `did:aura:key/…` id for display. Called once at serve start.
    pub fn load_key(&mut self) -> Result<String, String> {
        let key = aura_attestation::load_or_create(&self.key_path())
            .map_err(|e| format!("node identity key: {e}"))?;
        let id = key.key_id();
        self.key = Some(key);
        Ok(id)
    }

    /// The node signing key — the retained one if present, else load-or-create
    /// from disk. Used when appending to a repo's ref-log after a push, and to
    /// mint/verify capability tokens.
    pub fn node_signing_key(&self) -> Result<SigningKey, String> {
        if let Some(k) = &self.key {
            return Ok(k.clone());
        }
        aura_attestation::load_or_create(&self.key_path())
            .map_err(|e| format!("node identity key: {e}"))
    }

    /// The node's public verifying key, used to verify capability tokens on
    /// incoming git requests.
    pub fn node_verifying_key(&self) -> Result<VerifyingKey, String> {
        if let Some(k) = &self.key {
            return Ok(k.verifying_key());
        }
        Ok(self.node_signing_key()?.verifying_key())
    }

    /// Snapshot every `refs/…` → oid currently in a hosted repo. Diffing this
    /// before and after a push tells us exactly which refs moved.
    pub fn snapshot_refs(&self, id: &str) -> Result<BTreeMap<String, String>, String> {
        let path = self
            .repo_path(id)
            .ok_or_else(|| format!("invalid repo id '{id}'"))?;
        let repo = git2::Repository::open_bare(&path)
            .map_err(|e| format!("open {}: {e}", path.display()))?;
        let mut out = BTreeMap::new();
        let refs = repo.references().map_err(|e| format!("references: {e}"))?;
        for r in refs.flatten() {
            let Some(name) = r.name() else { continue };
            if !name.starts_with("refs/") {
                continue;
            }
            if let Some(oid) = r.target() {
                out.insert(name.to_string(), oid.to_string());
            }
        }
        Ok(out)
    }

    /// Diff two ref snapshots into the set of changes (create / update / delete),
    /// sorted by ref name for a stable ref-log order.
    pub fn diff_ref_snapshots(
        before: &BTreeMap<String, String>,
        after: &BTreeMap<String, String>,
    ) -> Vec<RefChange> {
        let mut out = Vec::new();
        for (name, new_oid) in after {
            match before.get(name) {
                Some(old) if old == new_oid => {}
                Some(old) => out.push(RefChange {
                    reference: name.clone(),
                    old: old.clone(),
                    new: new_oid.clone(),
                }),
                None => out.push(RefChange {
                    reference: name.clone(),
                    old: ZERO_OID.to_string(),
                    new: new_oid.clone(),
                }),
            }
        }
        for (name, old_oid) in before {
            if !after.contains_key(name) {
                out.push(RefChange {
                    reference: name.clone(),
                    old: old_oid.clone(),
                    new: ZERO_OID.to_string(),
                });
            }
        }
        out.sort_by(|a, b| a.reference.cmp(&b.reference));
        out
    }

    /// A repo id is safe iff it is non-empty, bounded, and only ascii
    /// alphanumerics + `-`/`_` (matches the room-id charset). This is the sole
    /// guard against path traversal — no `.`, `/`, or `\` can appear.
    pub fn is_valid_id(id: &str) -> bool {
        !id.is_empty()
            && id.len() <= 128
            && id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    }

    /// Absolute path of a repo's bare directory, or `None` if the id is unsafe.
    pub fn repo_path(&self, id: &str) -> Option<PathBuf> {
        if Self::is_valid_id(id) {
            Some(self.root.join(format!("{id}.git")))
        } else {
            None
        }
    }

    pub fn exists(&self, id: &str) -> bool {
        self.repo_path(id).map(|p| p.is_dir()).unwrap_or(false)
    }

    /// Ensure a bare repo exists for `id`, initializing it on first use. Used
    /// on push so a repo is created the first time someone pushes to its id.
    pub fn open_or_init(&self, id: &str) -> Result<PathBuf, String> {
        let path = self
            .repo_path(id)
            .ok_or_else(|| format!("invalid repo id '{id}'"))?;
        if !path.exists() {
            let repo = git2::Repository::init_bare(&path)
                .map_err(|e| format!("init bare repo {}: {e}", path.display()))?;
            // `git http-backend` only serves receive-pack (push) when the repo
            // opts in, so enable it on the repos this node hosts.
            repo.config()
                .and_then(|mut c| c.set_bool("http.receivepack", true))
                .map_err(|e| format!("enable http.receivepack on {}: {e}", path.display()))?;
        }
        Ok(path)
    }

    /// After a push, make sure the repo's `HEAD` points at a branch that
    /// actually exists, so a subsequent `git clone` can check something out.
    /// A freshly `init_bare` repo defaults `HEAD` to `refs/heads/master`; if the
    /// first push created `main` instead, that symref dangles. Mirror what a
    /// real host does: prefer `main`, then `master`, else the first branch.
    pub fn fixup_head(&self, id: &str) -> Result<(), String> {
        let path = self
            .repo_path(id)
            .ok_or_else(|| format!("invalid repo id '{id}'"))?;
        let repo =
            git2::Repository::open_bare(&path).map_err(|e| format!("open {}: {e}", path.display()))?;
        // If HEAD already resolves to a real commit, nothing to do.
        if repo.head().is_ok() {
            return Ok(());
        }
        let mut target: Option<String> = None;
        for name in ["main", "master"] {
            if repo
                .find_reference(&format!("refs/heads/{name}"))
                .is_ok()
            {
                target = Some(name.to_string());
                break;
            }
        }
        if target.is_none() {
            if let Ok(branches) = repo.branches(Some(git2::BranchType::Local)) {
                for b in branches.flatten() {
                    if let Ok(Some(name)) = b.0.name() {
                        target = Some(name.to_string());
                        break;
                    }
                }
            }
        }
        if let Some(name) = target {
            repo.set_head(&format!("refs/heads/{name}"))
                .map_err(|e| format!("set HEAD to {name}: {e}"))?;
        }
        Ok(())
    }

    /// The ids of all hosted repos (directory names with the `.git` suffix
    /// stripped), sorted.
    pub fn list(&self) -> Vec<String> {
        let mut out = Vec::new();
        if let Ok(entries) = std::fs::read_dir(&self.root) {
            for e in entries.flatten() {
                if e.path().is_dir() {
                    if let Some(name) = e.file_name().to_str() {
                        if let Some(id) = name.strip_suffix(".git") {
                            out.push(id.to_string());
                        }
                    }
                }
            }
        }
        out.sort();
        out
    }
}
