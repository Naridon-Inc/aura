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
//!
//! On top of hosting, the node can say what it holds. [`read_api`] serves that
//! to an operator or a console over the node's own HTTP — repos, ref-log, token
//! metadata — behind a token in every configuration, and [`report`] sends the
//! same picture to the Aura cloud, signed, so the web console can show a node
//! you run yourself. Both read the same gatherers, so the two views cannot
//! drift apart. What travels is always a *verifiable copy*: the ref-log keeps
//! its per-entry signatures and chain links, and [`tokens`] is a ledger of
//! hashes and labels rather than of grants, so nothing replayable ever leaves
//! the box.

mod auth;
mod bridge;
mod mirror;
mod pins;
mod read_api;
mod reflog;
mod report;
mod smart_http;
mod tokens;

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
        /// Re-fetch every mirrored repo this often, in seconds. Off by default:
        /// a node that mirrors nothing should make no outbound requests, and an
        /// operator who wants a schedule usually already has one (cron, a timer
        /// unit) and would rather own it than inherit ours.
        #[arg(long)]
        mirror_interval: Option<u64>,
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
        /// What this token is for ("ci deploy", "laptop"). Recorded in the
        /// node's token ledger so the list is readable later; the token itself
        /// is never stored.
        #[arg(long)]
        label: Option<String>,
        #[arg(long)]
        data_dir: Option<String>,
        /// Mint against a live cloud grant instead of local flags: read the
        /// named agent's grant in this org and mint only what it still allows.
        /// A capability token is verified offline and cannot be revoked once
        /// out, so this is where revocation bites — a revoked or lapsed grant
        /// mints nothing, and the token's expiry is capped by the grant's.
        /// Requires --agent.
        #[arg(long)]
        org: Option<String>,
        /// The agent whose cloud grant backs this token (with --org).
        #[arg(long)]
        agent: Option<String>,
    },
    /// List the capability tokens this node has issued — metadata only (id,
    /// label, scope, lifetime, whether it has been revoked). The tokens
    /// themselves are not stored and cannot be shown again.
    Tokens {
        /// Include tokens that are revoked or past their expiry.
        #[arg(long)]
        all: bool,
        #[arg(long)]
        data_dir: Option<String>,
    },
    /// Revoke an issued token by its id (from `aura node tokens`). The node
    /// refuses it from that moment on, on git requests and on its read API.
    Revoke {
        /// Token id as shown by `aura node tokens`.
        id: String,
        #[arg(long)]
        data_dir: Option<String>,
    },
    /// Report what this node holds — its repos, its signed ref-log and its
    /// token metadata — to the Aura cloud, so the web console can show it.
    ///
    /// Signed with the node's own key and safe to run on a timer: the ref-log
    /// is sent incrementally from a high-water mark, and a re-run with nothing
    /// new sends nothing new.
    Report {
        /// Operator label for this node in the console. Remembered, so a
        /// scheduled run needs no flags.
        #[arg(long)]
        name: Option<String>,
        /// Public base URL clients use to reach this node. Also remembered.
        #[arg(long)]
        url: Option<String>,
        /// Cloud to report to. Defaults to the cloud this machine signed in to.
        #[arg(long)]
        cloud: Option<String>,
        /// Re-send the entire ref-log, ignoring the high-water mark.
        #[arg(long)]
        full: bool,
        /// Print the signed report instead of sending it.
        #[arg(long)]
        dry_run: bool,
        #[arg(long)]
        data_dir: Option<String>,
    },
    /// Mirror upstream repositories onto this node — a GitHub or GitLab repo
    /// so agents clone from hardware you own instead of rate-limited forge
    /// infrastructure, or another Aura node to replicate it.
    Mirror {
        #[command(subcommand)]
        cmd: mirror::MirrorSubcommands,
    },
    /// Bridge hosted repos to a downstream forge — every push accepted by
    /// this node is forwarded to GitHub/GitLab automatically, so the team
    /// can make `aura://` the primary remote without leaving GitHub behind.
    Bridge {
        #[command(subcommand)]
        cmd: bridge::BridgeSubcommands,
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
            mirror_interval,
        } => run_serve(
            addr,
            data_dir.as_deref(),
            ServeAuth {
                allow_remote: *allow_remote,
                require_auth: *require_auth,
                public_read: *public_read,
                allow_anonymous: *allow_anonymous,
            },
            *mirror_interval,
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
            label,
            data_dir,
            org,
            agent,
        } => run_token(
            id.as_deref(),
            *all_repos,
            *push,
            *read,
            *ttl,
            label.as_deref(),
            data_dir.as_deref(),
            org.as_deref(),
            agent.as_deref(),
        ),
        NodeSubcommands::Tokens { all, data_dir } => run_tokens(*all, data_dir.as_deref()),
        NodeSubcommands::Revoke { id, data_dir } => run_revoke(id, data_dir.as_deref()),
        NodeSubcommands::Report {
            name,
            url,
            cloud,
            full,
            dry_run,
            data_dir,
        } => report::run(
            data_dir.as_deref(),
            name.as_deref(),
            url.as_deref(),
            cloud.as_deref(),
            *full,
            *dry_run,
        ),
        NodeSubcommands::Mirror { cmd } => mirror::run(cmd, |d| resolve_data_dir(d)),
        NodeSubcommands::Bridge { cmd } => bridge::run(cmd, |d| resolve_data_dir(d)),
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
    mirror_interval: Option<u64>,
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
        let mirrors = mirror::all_mirrors(&store);
        println!("  {} {} repo(s) hosted:", "•".dimmed(), hosted.len());
        for id in &hosted {
            match mirrors.get(id) {
                Some(cfg) => println!(
                    "    {} {} {}",
                    "→".dimmed(),
                    id,
                    format!("· mirror of {}", cfg.upstream).dimmed()
                ),
                None => println!("    {} {}", "→".dimmed(), id),
            }
        }
    }

    let refresh = mirror_refresh_plan(&store, mirror_interval);
    if let Some(secs) = refresh {
        println!(
            "  {} mirrors refresh every {}",
            "•".dimmed(),
            format!("{secs}s").cyan()
        );
    }

    let rt = tokio::runtime::Runtime::new().map_err(|e| format!("tokio runtime: {e}"))?;
    rt.block_on(async move {
        if let Some(secs) = refresh {
            spawn_mirror_refresh(store.clone(), secs);
        }
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

/// Whether this serving node should refresh its mirrors on a timer, and how
/// often. `None` means it will not — either the operator asked for no schedule,
/// or there is nothing mirrored to refresh, in which case a timer would only
/// wake up to find no work.
fn mirror_refresh_plan(store: &NodeStore, requested: Option<u64>) -> Option<u64> {
    let secs = requested?;
    if secs == 0 {
        return None;
    }
    if mirror::all_mirrors(store).is_empty() {
        return None;
    }
    Some(secs)
}

/// Refresh every mirror on a timer, in the background, for as long as the node
/// serves. Sync runs on a blocking worker because it shells out to `git fetch`,
/// which must not occupy an async executor thread while it talks to a forge.
///
/// A failing upstream is reported and retried on the next tick rather than
/// stopping the timer: a node whose refresh loop dies on one bad credential
/// would silently stop updating every other mirror it holds.
fn spawn_mirror_refresh(store: Arc<NodeStore>, secs: u64) {
    tokio::spawn(async move {
        let period = std::time::Duration::from_secs(secs);
        loop {
            tokio::time::sleep(period).await;
            let store = store.clone();
            let results = match tokio::task::spawn_blocking(move || mirror::sync_all(&store)).await
            {
                Ok(r) => r,
                Err(e) => {
                    eprintln!("aura node: mirror refresh task failed: {e}");
                    continue;
                }
            };
            for (id, res) in results {
                match res {
                    Ok(outcome) if outcome.changes.is_empty() => {}
                    Ok(outcome) => println!(
                        "{} mirror {id} refreshed — {} ref change(s)",
                        "◆".cyan(),
                        outcome.changes.len()
                    ),
                    Err(e) => eprintln!("aura node: mirror {id} refresh failed: {e}"),
                }
            }
        }
    });
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
#[allow(clippy::too_many_arguments)]
fn run_token(
    id: Option<&str>,
    all_repos: bool,
    push: bool,
    read: bool,
    ttl: Option<i64>,
    label: Option<&str>,
    data_dir: Option<&str>,
    org: Option<&str>,
    agent: Option<&str>,
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

    // Default 30-day TTL; `--ttl 0` mints a non-expiring token.
    let requested_ttl = ttl.unwrap_or(30 * 24 * 3600);
    let now = chrono::Utc::now().timestamp();

    // Two ways to decide what the token may do. The local path trusts the
    // operator's `--push/--read`; the grant-backed path (`--org --agent`) reads
    // the agent's live cloud grant and mints only what it still allows, capping
    // expiry at the grant's own — the point where a revoked or lapsed grant
    // stops producing capabilities that the offline node could never take back.
    let (caps, ttl, backing) = match (org, agent) {
        (None, None) => {
            let caps = auth::normalize_caps(push, read);
            if caps.is_empty() {
                return Err("grant at least one capability: --push and/or --read \
                            (or --org/--agent to mint from a cloud grant)"
                    .into());
            }
            (caps, requested_ttl, None)
        }
        (Some(org), Some(agent)) => {
            let grant = fetch_active_grant(org, agent)?;
            let (gr, gp) = node_caps_from_scopes(&grant.scopes);
            if !gr && !gp {
                return Err(format!(
                    "the live grant for agent '{agent}' in org '{org}' carries no repo access \
                     (needs repo:read or repo:push) — a node token would grant nothing"
                )
                .into());
            }
            // If the operator also named caps, mint the intersection and refuse
            // to over-grant; otherwise mint everything the grant maps to.
            let (want_read, want_push) = if push || read {
                (read || push, push)
            } else {
                (gr, gp)
            };
            if want_push && !gp {
                return Err(format!(
                    "the grant for agent '{agent}' does not allow push (no repo:push)"
                )
                .into());
            }
            if want_read && !gr && !gp {
                return Err(format!(
                    "the grant for agent '{agent}' does not allow read (no repo:read)"
                )
                .into());
            }
            let caps = auth::normalize_caps(want_push, want_read);
            if caps.is_empty() {
                return Err("nothing to mint: the requested caps are not in the grant".into());
            }
            // Cap expiry at the grant's. A grant with no expiry leaves the
            // requested TTL alone; a grant that has already lapsed mints nothing
            // (which is also how a revoked grant reads once its wall passes).
            let capped_ttl = cap_ttl_to_grant(now, requested_ttl, grant.expires_at)?;
            (caps, capped_ttl, Some(grant))
        }
        _ => {
            return Err("--org and --agent go together — name both to mint from a cloud grant".into());
        }
    };

    let root = resolve_data_dir(data_dir);
    let store = NodeStore::new(root.clone())?;
    let key = store.node_signing_key()?;
    let issuer = key.key_id();
    let claims = auth::CapabilityToken::new(scope.clone(), caps.clone(), now, ttl);
    let token = claims.issue(&key)?;

    // Record what was minted so the operator can list and revoke it later. The
    // claims are re-read from the wire token rather than taken from the struct
    // above, because `issue` stamps the issuer as it signs — the ledger should
    // describe the token that exists, not the one we asked for.
    let recorded = auth::CapabilityToken::parse_and_verify(&token, &key.verifying_key())?;
    let token_id = tokens::record_issue(&root, &token, label.unwrap_or_default(), &recorded)?;

    let scope_display = if scope == auth::SCOPE_ALL {
        "* (every repo on this node)".to_string()
    } else {
        scope.clone()
    };
    println!("{} capability token minted", "◆".cyan().bold());
    println!("  {} id     {}", "•".dimmed(), token_id);
    if let Some(l) = label.map(str::trim).filter(|s| !s.is_empty()) {
        println!("  {} label  {}", "•".dimmed(), l);
    }
    println!("  {} repo   {}", "•".dimmed(), scope_display);
    println!("  {} caps   {}", "•".dimmed(), caps.join(", "));
    println!("  {} issuer {}", "•".dimmed(), issuer.dimmed());
    if let Some(g) = &backing {
        println!(
            "  {} from   {}",
            "•".dimmed(),
            format!("cloud grant {} (agent {})", g.id, g.agent).dimmed()
        );
    }
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
    println!();
    println!(
        "  {} this is the only time the token is shown — the node keeps its {}, not the token",
        "!".yellow().bold(),
        "id and label".bold()
    );
    println!(
        "      {}",
        format!("revoke it later with `aura node revoke {token_id}`").dimmed()
    );
    Ok(())
}

/// `aura node tokens` — what this node has handed out. Metadata only; the
/// tokens themselves were never stored and cannot be reprinted.
fn run_tokens(all: bool, data_dir: Option<&str>) -> Result<(), Box<dyn std::error::Error>> {
    let root = resolve_data_dir(data_dir);
    let ledger = tokens::load(&root)?;
    let now = chrono::Utc::now().timestamp();

    let shown: Vec<&tokens::TokenRecord> = ledger
        .tokens
        .iter()
        .filter(|t| {
            all || (!t.revoked && t.expires_at.map(|exp| exp > now).unwrap_or(true))
        })
        .collect();

    if ledger.tokens.is_empty() {
        println!(
            "{} this node has issued no capability tokens yet — mint one with {}",
            "•".yellow(),
            "aura node token".bold()
        );
        return Ok(());
    }
    if shown.is_empty() {
        println!(
            "{} no live tokens ({} revoked or expired) — {} to see them",
            "•".yellow(),
            ledger.tokens.len(),
            "--all".bold()
        );
        return Ok(());
    }

    println!("{} {} token(s):", "◆".cyan(), shown.len());
    for t in shown {
        let state = if t.revoked {
            "revoked".red().to_string()
        } else if t.expires_at.map(|exp| exp <= now).unwrap_or(false) {
            "expired".yellow().to_string()
        } else {
            "live".green().to_string()
        };
        let repo = t.repo.clone().unwrap_or_else(|| "* (node-wide)".to_string());
        let label = if t.label.is_empty() {
            "(no label)".dimmed().to_string()
        } else {
            t.label.clone()
        };
        println!(
            "  {} {}  {:<7} {:<6} {}  {}",
            "→".dimmed(),
            t.id,
            t.scope,
            state,
            repo,
            label
        );
        println!(
            "        {}",
            format!(
                "created {} · expires {} · last used {}",
                report::rfc3339(t.created_at),
                t.expires_at.map(report::rfc3339).unwrap_or_else(|| "never".to_string()),
                t.last_used_at.map(report::rfc3339).unwrap_or_else(|| "never".to_string()),
            )
            .dimmed()
        );
    }
    Ok(())
}

/// `aura node revoke <id>` — stop honouring one issued token.
fn run_revoke(id: &str, data_dir: Option<&str>) -> Result<(), Box<dyn std::error::Error>> {
    let root = resolve_data_dir(data_dir);
    let record = tokens::revoke(&root, id.trim())?;
    println!(
        "{} token {} revoked {}",
        "✓".green().bold(),
        record.id,
        format!(
            "· {} on {}",
            record.scope,
            record.repo.clone().unwrap_or_else(|| "* (node-wide)".to_string())
        )
        .dimmed()
    );
    println!(
        "  {} a serving node picks this up on its next request — no restart needed",
        "•".dimmed()
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
/// The slice of a cloud agent grant a node token cares about.
#[derive(Debug)]
struct GrantInfo {
    id: String,
    agent: String,
    scopes: Vec<String>,
    /// Grant expiry as a unix second, or `None` for "never".
    expires_at: Option<i64>,
}

/// Map the cloud scope vocabulary onto the node's two capabilities. Only the two
/// repo scopes cross the plane boundary — `intent:write`, `crew:claim` and the
/// rest are cloud-API powers a git token cannot express. `repo:push` implies
/// read, mirroring `normalize_caps`.
fn node_caps_from_scopes(scopes: &[String]) -> (bool, bool) {
    let mut read = false;
    let mut push = false;
    for s in scopes {
        match s.as_str() {
            "repo:read" => read = true,
            "repo:push" => {
                push = true;
                read = true;
            }
            _ => {}
        }
    }
    (read, push)
}

/// Cap a requested TTL by a grant's expiry. Returns the TTL (in seconds from
/// `now`) to mint with: `0` stays "never" only when the grant itself never
/// expires. A grant already past its expiry is refused — there is nothing left
/// to delegate, which is exactly how a revoked grant reads once its wall passes.
fn cap_ttl_to_grant(
    now: i64,
    requested_ttl: i64,
    grant_expires_at: Option<i64>,
) -> Result<i64, String> {
    // The instant the requested TTL would land on (None = never).
    let requested_exp = if requested_ttl <= 0 { None } else { Some(now + requested_ttl) };
    let effective_exp = match (requested_exp, grant_expires_at) {
        (None, None) => None,
        (Some(r), None) => Some(r),
        (None, Some(g)) => Some(g),
        (Some(r), Some(g)) => Some(r.min(g)),
    };
    match effective_exp {
        None => Ok(0),
        Some(exp) if exp <= now => Err(
            "the grant has already expired — nothing left to mint a token from".to_string(),
        ),
        Some(exp) => Ok(exp - now),
    }
}

/// Ask the cloud what this agent may actually do here, and refuse anything
/// that is not a live grant.
///
/// The question goes to `/scopes/effective` rather than to the grant *list*
/// for a reason worth stating: a list is keyed by agent name alone, so picking
/// the first row whose name matches would hand this member the scopes of a
/// grant minted for somebody else. The server resolves by agent *and* the
/// member the caller is acting as — the pair the uniqueness index is built on
/// — so there is exactly one answer and the client cannot pick the wrong one.
///
/// An expired grant comes back as `expired` rather than as an absent row, so
/// the message below can say which of the two happened instead of guessing.
fn fetch_active_grant(org: &str, agent: &str) -> Result<GrantInfo, String> {
    let (url, token) = crate::recall_cloud_creds()?;
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| format!("http client: {e}"))?;
    let resp = client
        .get(format!("{url}/api/v2/orgs/{org}/scopes/effective"))
        .query(&[("agent", agent)])
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .map_err(|e| format!("network: {e}"))?;
    let status = resp.status();
    let body: serde_json::Value = resp
        .json()
        .map_err(|e| format!("parse grant (HTTP {status}): {e}"))?;
    if !status.is_success() {
        let detail = body["detail"].as_str().unwrap_or_else(|| {
            body["error"].as_str().unwrap_or("")
        });
        return Err(format!("HTTP {status} reading the grant: {detail}"));
    }

    grant_from_effective(org, agent, &body)
}

/// Read the server's effective-scopes answer, refusing anything that is not a
/// live grant. Split from the request above so the three outcomes a human
/// actually meets — granted, lapsed, never granted — are testable without a
/// server, and so an unknown future status word refuses rather than mints.
fn grant_from_effective(
    org: &str,
    agent: &str,
    body: &serde_json::Value,
) -> Result<GrantInfo, String> {
    match body["status"].as_str().unwrap_or("none") {
        "active" => {}
        "expired" => {
            let when = body["expires_at"].as_str().unwrap_or("its expiry");
            return Err(format!(
                "the grant for agent '{agent}' lapsed at {when} — renew it with `aura access grant` before minting"
            ));
        }
        _ => {
            return Err(format!(
                "no grant for agent '{agent}' in org '{org}' acting as you — grant one with `aura access grant`"
            ));
        }
    }

    let scopes: Vec<String> = body["scopes"]
        .as_array()
        .map(|a| a.iter().filter_map(|s| s.as_str().map(String::from)).collect())
        .unwrap_or_default();
    // A grant carrying no scope delegates no power, so minting from it would
    // hand out a token that can do nothing while reading as authorisation.
    if scopes.is_empty() {
        return Err(format!(
            "the grant for agent '{agent}' carries no scopes — there is nothing to mint from"
        ));
    }
    let expires_at = body["expires_at"].as_str().and_then(|s| {
        chrono::DateTime::parse_from_rfc3339(s)
            .ok()
            .map(|dt| dt.timestamp())
    });
    Ok(GrantInfo {
        id: body["grant_id"].as_str().unwrap_or_default().to_string(),
        agent: body["agent"].as_str().unwrap_or(agent).to_string(),
        scopes,
        expires_at,
    })
}

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

#[cfg(test)]
mod grant_mint_tests {
    use super::{cap_ttl_to_grant, grant_from_effective, node_caps_from_scopes};
    use serde_json::json;

    #[test]
    fn a_live_grant_mints_with_the_scopes_the_server_resolved() {
        let g = grant_from_effective(
            "naridon",
            "claude",
            &json!({
                "agent": "claude",
                "status": "active",
                "grant_id": "11111111-1111-4111-8111-111111111111",
                "scopes": ["repo:read", "repo:push"],
                "expires_at": "2030-01-01T00:00:00Z",
            }),
        )
        .expect("a live grant must mint");
        assert_eq!(g.agent, "claude");
        assert_eq!(g.scopes, vec!["repo:read".to_string(), "repo:push".to_string()]);
        assert!(g.expires_at.is_some(), "the grant's wall must reach the mint");
    }

    #[test]
    fn a_lapsed_grant_says_so_instead_of_saying_it_never_existed() {
        let err = grant_from_effective(
            "naridon",
            "claude",
            &json!({ "status": "expired", "expires_at": "2020-01-01T00:00:00Z" }),
        )
        .expect_err("a lapsed grant must not mint");
        assert!(err.contains("lapsed"), "{err}");
        assert!(err.contains("2020-01-01"), "the human needs the date: {err}");
    }

    #[test]
    fn an_ungranted_agent_mints_nothing_and_is_told_how_to_get_one() {
        let err = grant_from_effective("naridon", "gemini", &json!({ "status": "none" }))
            .expect_err("an absent grant must not mint");
        assert!(err.contains("no grant for agent 'gemini'"), "{err}");
        assert!(err.contains("aura access grant"), "{err}");
    }

    #[test]
    fn an_unrecognised_status_refuses_rather_than_minting() {
        // A server that grows a fourth word must not be read as permission.
        assert!(grant_from_effective("naridon", "claude", &json!({ "status": "pending" })).is_err());
        assert!(grant_from_effective("naridon", "claude", &json!({})).is_err());
    }

    #[test]
    fn a_grant_with_no_scopes_is_not_authorisation() {
        let err = grant_from_effective(
            "naridon",
            "claude",
            &json!({ "status": "active", "scopes": [] }),
        )
        .expect_err("an empty grant must not mint");
        assert!(err.contains("no scopes"), "{err}");
    }

    #[test]
    fn only_repo_scopes_cross_the_plane() {
        // repo:push implies read.
        assert_eq!(node_caps_from_scopes(&["repo:push".into()]), (true, true));
        assert_eq!(node_caps_from_scopes(&["repo:read".into()]), (true, false));
        // Cloud-only powers map to nothing a git token can express.
        assert_eq!(
            node_caps_from_scopes(&["intent:write".into(), "crew:claim".into()]),
            (false, false)
        );
        assert_eq!(
            node_caps_from_scopes(&["repo:read".into(), "billing:read".into()]),
            (true, false)
        );
    }

    #[test]
    fn ttl_is_capped_by_the_grant() {
        let now = 1_000_000;
        // No grant expiry: the requested TTL stands; 0 stays "never".
        assert_eq!(cap_ttl_to_grant(now, 3600, None).unwrap(), 3600);
        assert_eq!(cap_ttl_to_grant(now, 0, None).unwrap(), 0);
        // Grant expires sooner than the request → capped to the grant.
        assert_eq!(cap_ttl_to_grant(now, 3600, Some(now + 600)).unwrap(), 600);
        // Grant expires later than the request → request stands.
        assert_eq!(cap_ttl_to_grant(now, 600, Some(now + 3600)).unwrap(), 600);
        // A "never" request against an expiring grant is bounded by the grant.
        assert_eq!(cap_ttl_to_grant(now, 0, Some(now + 900)).unwrap(), 900);
    }

    #[test]
    fn an_expired_grant_mints_nothing() {
        let now = 1_000_000;
        assert!(cap_ttl_to_grant(now, 3600, Some(now - 1)).is_err());
        assert!(cap_ttl_to_grant(now, 3600, Some(now)).is_err());
    }
}
