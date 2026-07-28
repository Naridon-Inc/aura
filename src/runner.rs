//! `aura runner` — turn any always-on box into a cloud-visible Aura runner.
//!
//! The problem this solves: you start work, then close the laptop. Locally
//! that stops the crew loop. A *runner* is a machine you leave on (a cheap
//! VPS, a home box, or — later — one Aura provisions for you) that keeps
//! draining your crew backlog and reports its liveness to the cloud so you
//! can watch and steer it from the phone.
//!
//! This is deliberately thin: the work loop is the exact same `aura crew`
//! pipeline the desktop and CI already run, invoked here as subprocesses of
//! the very binary you're in (`aura crew cloud-sync` → `aura crew run` →
//! `aura crew cloud-sync --push`). What `runner` adds on top is the missing
//! piece the audit called out — a client for the cloud runner registry
//! (`/api/v2/runners`): register once to mint a scoped runner token, then
//! heartbeat each cycle so the box shows up as online/busy with its current
//! task in the app and on mobile.
//!
//! Registry calls are best-effort: if the cloud doesn't have the runners
//! feature deployed yet (404), or no `AURA_RUNNER_TOKEN` is set, the runner
//! logs once and keeps working unregistered. Cloud visibility is a nicety;
//! draining the backlog is the job.
//!
//! Token model: `register` uses your human cloud token (TokenAuth) to mint a
//! `aura_runner_…` token. `serve`/`status` use THAT runner token (RunnerAuth)
//! via `AURA_RUNNER_TOKEN`. The two are distinct principals by design — a
//! runner token can only heartbeat itself, never act as you.

use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use colored::Colorize;
use serde_json::json;

use crate::{cloud_http_client, recall_cloud_creds, recall_get, recall_post};

/// Env var carrying the runner's own (RunnerAuth) token.
const RUNNER_TOKEN_ENV: &str = "AURA_RUNNER_TOKEN";

/// Options for `aura runner serve` — the supervise loop.
pub struct ServeOpts {
    /// Display name used in logs (the registry name comes from `self`).
    pub name: Option<String>,
    /// Default agent for nodes that don't name their own kind.
    pub agent: String,
    /// Optional `owner/name` repo filter for the cloud task pull. Omitted =
    /// the pull auto-detects the git remote (org-wide if non-GitHub).
    pub repo: Option<String>,
    /// Lease seconds handed to `crew run` (crash-recovery window).
    pub lease_secs: i64,
    /// Seconds to sleep between cycles when the backlog is drained.
    pub poll_secs: u64,
    /// Run exactly one cycle and exit (for testing / cron-driven runners).
    pub once: bool,
    /// Also sync the task graph over git each cycle (`crew sync`) — pull peers'
    /// graph before draining, push the graph after. Off by default so a manual
    /// runner never rebases underfoot; on for clean containerized runners.
    pub git_sync: bool,
    /// Multi-project mode: instead of draining one checked-out repo, discover
    /// *every* project in your org that has pending cloud work and drain each in
    /// its own lazily-cloned workspace. This is what makes one always-on box run
    /// all of your projects, not just the one it was pointed at. Ignored when
    /// `repo` is set (an explicit `--repo` still pins the box to one project).
    pub all_projects: bool,
    /// Where per-project workspaces live in multi-project mode. Defaults to a
    /// `workspaces/` dir beside the runner's own checkout (override with
    /// `--workspaces-root` or `AURA_RUNNER_WORKSPACES`).
    pub workspaces_root: Option<String>,
}

/// Options for `aura runner register`.
pub struct RegisterOpts {
    pub name: String,
    /// Optional `owner/name` — resolved to the org's repo id to scope the
    /// runner to one repo. Omitted mints an org-wide runner.
    pub repo: Option<String>,
    /// Agent CLIs this box can run (e.g. `["claude"]`).
    pub agent_kinds: Vec<String>,
}

/// Cloud base URL, trailing slash trimmed. Falls back to the public cloud so
/// `serve` can run even before `aura cloud login` (heartbeat just no-ops
/// without a runner token).
fn cloud_base() -> String {
    let url = recall_cloud_creds()
        .map(|(u, _)| u)
        .or_else(|_| std::env::var("AURA_CLOUD_URL"))
        .unwrap_or_else(|_| "https://api.auravcs.com".to_string());
    url.trim_end_matches('/').to_string()
}

fn runner_token() -> Option<String> {
    std::env::var(RUNNER_TOKEN_ENV).ok().filter(|s| !s.trim().is_empty())
}

/// The runner's identity as learned from the cloud registry.
struct SelfIdentity {
    id: String,
    name: String,
}

/// Resolve `GET /api/v2/runners/self` with the runner token. `Ok(None)` means
/// "no token / registry unavailable" — the caller keeps working unregistered.
fn resolve_self(
    client: &reqwest::blocking::Client,
    base: &str,
    token: &str,
) -> Result<SelfIdentity, String> {
    let body = recall_get(client, &format!("{base}/api/v2/runners/self"), token)?;
    let id = body
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "runners/self returned no id".to_string())?
        .to_string();
    let name = body
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("aura-runner")
        .to_string();
    Ok(SelfIdentity { id, name })
}

/// Best-effort heartbeat. Silent on any failure — the registry is optional.
fn heartbeat(
    client: &reqwest::blocking::Client,
    base: &str,
    id: &str,
    token: &str,
    status: &str,
    current_task: &str,
) {
    let url = format!("{base}/api/v2/runners/{id}/heartbeat");
    let body = json!({
        "status": status,
        "current_task": current_task,
        "version": env!("CARGO_PKG_VERSION"),
    });
    let _ = recall_post(client, &url, token, &body);
}

/// Run one `aura <args>` subprocess, streaming its output to our own
/// stdout/stderr so the runner's log carries the agent transcript. Failures
/// are logged, never fatal — one bad cycle shouldn't kill the supervisor.
fn run_sub(bin: &Path, cwd: &Path, args: &[&str]) {
    eprintln!("{} aura {}", "[runner]".dimmed(), args.join(" "));
    match Command::new(bin).args(args).current_dir(cwd).status() {
        Ok(s) if s.success() => {}
        Ok(s) => eprintln!(
            "{} `aura {}` exited with {} — continuing",
            "[runner]".yellow(),
            args.join(" "),
            s
        ),
        Err(e) => eprintln!(
            "{} could not spawn `aura {}`: {} — continuing",
            "[runner]".yellow(),
            args.join(" "),
            e
        ),
    }
}

/// One work cycle: pull cloud tasks → drain the ready set → push status back →
/// push commits. Each leg is the existing, battle-tested `aura crew` command.
fn work_cycle(bin: &Path, repo_root: &Path, opts: &ServeOpts) {
    let lease = opts.lease_secs.to_string();
    let git = opts.git_sync && git_has_remote(repo_root);

    // 0. Git delivery plane (opt-in): pull peers'/laptop's task-graph updates
    //    before draining, without pushing mid-cycle.
    if git {
        run_sub(bin, repo_root, &["crew", "sync", "--pull-only"]);
    }

    // 1. Pull ready cloud a2a tasks into the local graph (and claim them).
    let mut pull: Vec<&str> = vec!["crew", "cloud-sync", "--pull", "--agent", &opts.agent];
    if let Some(repo) = &opts.repo {
        pull.push("--repo");
        pull.push(repo);
    }
    run_sub(bin, repo_root, &pull);

    // 2. Drain the whole ready set (executes the agent, commits its work).
    run_sub(
        bin,
        repo_root,
        &["crew", "run", "--agent", &opts.agent, "--lease-secs", &lease, "--max", "0"],
    );

    // 3. Push task status back up so the cloud graph (and the phone) reflect it.
    run_sub(bin, repo_root, &["crew", "cloud-sync", "--push"]);

    // 4. Push the branch so the agent's commits are durable + visible off-box.
    //    With git-sync on, `crew sync --push-only` commits the task graph and
    //    pushes it alongside the branch; otherwise a plain best-effort push.
    //    Only when a remote exists — a local-only runner keeps work local
    //    without git's noisy fatal.
    if git {
        run_sub(bin, repo_root, &["crew", "sync", "--push-only"]);
    } else if git_has_remote(repo_root) {
        match Command::new("git").args(["push"]).current_dir(repo_root).status() {
            Ok(s) if s.success() => {}
            Ok(_) => eprintln!("{} git push skipped (no upstream/creds)", "[runner]".dimmed()),
            Err(_) => {}
        }
    }
}

/// Discover which of your projects have claimable cloud work right now.
///
/// One `serve` box has one working tree, so "drain everything" can't mean
/// "check out every repo up front". Instead we ask the cloud, over plain HTTP
/// (no checkout needed), which repos currently have `submitted` a2a tasks, then
/// route a workspace to each. Two reads, both against endpoints the CLI already
/// speaks: `/api/v2/a2a/tasks?status=submitted` gives the pending tasks (each
/// carries a `repo_id`), and `/api/v2/repos` maps that id back to `owner/name`.
///
/// Uses the human cloud token (the same principal `crew cloud-sync` pulls with)
/// — task visibility is scoped server-side to the repos you can access. Tasks
/// with a null `repo_id` are org-wide coordination items with no checkout to run
/// in, so they're left for the single-repo path; here we only surface repos.
fn pending_project_slugs(
    client: &reqwest::blocking::Client,
    base: &str,
    token: &str,
) -> Vec<String> {
    let mut repo_ids: BTreeSet<String> = BTreeSet::new();
    if let Ok(body) = recall_get(
        client,
        &format!("{base}/api/v2/a2a/tasks?status=submitted&limit=200"),
        token,
    ) {
        if let Some(tasks) = body.get("tasks").and_then(|v| v.as_array()) {
            for t in tasks {
                if let Some(rid) = t.get("repo_id").and_then(|v| v.as_str()) {
                    repo_ids.insert(rid.to_string());
                }
            }
        }
    }
    if repo_ids.is_empty() {
        return Vec::new();
    }

    let mut id_to_name: HashMap<String, String> = HashMap::new();
    if let Ok(body) = recall_get(client, &format!("{base}/api/v2/repos"), token) {
        if let Some(repos) = body.get("repos").and_then(|v| v.as_array()) {
            for r in repos {
                if let (Some(id), Some(name)) = (
                    r.get("id").and_then(|v| v.as_str()),
                    r.get("full_name").and_then(|v| v.as_str()),
                ) {
                    id_to_name.insert(id.to_string(), name.to_string());
                }
            }
        }
    }

    let mut slugs: Vec<String> = repo_ids
        .iter()
        .filter_map(|id| id_to_name.get(id).cloned())
        .collect();
    // A repo_id that maps to no `full_name` is one without a GitHub name we can
    // clone (Aura-native / self-hosted). Skip loudly so the gap is visible.
    let unmapped = repo_ids.len() - slugs.len();
    if unmapped > 0 {
        eprintln!(
            "{} {unmapped} project(s) with pending work have no GitHub name to clone — skipped",
            "[runner]".dimmed()
        );
    }
    slugs.sort();
    slugs.dedup();
    slugs
}

/// Ensure a workspace checkout exists for `owner/name` under `root`, returning
/// its path. Clones on first sight (full clone — the agent and Aura's AST/notes
/// want real history), otherwise fetches the latest. Always (re)asserts the
/// runner git identity and installs Aura capture hooks so the agent's commits in
/// this workspace carry intent + provenance, exactly like the single-repo box.
/// Returns `None` if the clone fails (a transient network/auth blip shouldn't
/// kill the whole multi-project cycle — the next cycle retries).
fn ensure_workspace(bin: &Path, root: &Path, full_name: &str) -> Option<PathBuf> {
    let dir = root.join(full_name.replace('/', "__"));

    if !dir.join(".git").exists() {
        // A leftover dir from a half-finished clone would make `git clone` fail
        // ("already exists and is not empty") on every future cycle — clear it.
        if dir.exists() {
            let _ = std::fs::remove_dir_all(&dir);
        }
        if let Some(parent) = dir.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let url = format!("https://github.com/{full_name}.git");
        eprintln!(
            "{} cloning {} → {}",
            "[runner]".dimmed(),
            full_name.cyan(),
            dir.display()
        );
        let ok = Command::new("git")
            .args(["clone", &url])
            .arg(&dir)
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if !ok {
            eprintln!(
                "{} clone of {full_name} failed — skipping this cycle, will retry",
                "[runner]".yellow()
            );
            return None;
        }
    } else {
        // Best-effort refresh of remote refs; the crew run checks out / creates
        // its own branch, so we never force the working tree here.
        let _ = Command::new("git")
            .args(["fetch", "--all", "--prune"])
            .current_dir(&dir)
            .status();
    }

    // Idempotent: identity + hooks. `git config` is a no-op if already set to
    // the same value; `aura enable` is safe to re-run.
    let _ = Command::new("git")
        .args(["config", "user.name", "Aura Runner"])
        .current_dir(&dir)
        .status();
    let _ = Command::new("git")
        .args(["config", "user.email", "runner@auravcs.com"])
        .current_dir(&dir)
        .status();
    let _ = Command::new(bin).args(["enable"]).current_dir(&dir).status();

    Some(dir)
}

/// Multi-project work cycle: find every project with pending cloud work and
/// drain each in its own workspace. The heavy lifting per project is the exact
/// same `work_cycle` the single-repo box runs — this just points it at the right
/// checkout and pins the pull to that project. Returns the number of projects
/// that had work this cycle (for the heartbeat detail line).
fn multi_work_cycle(
    bin: &Path,
    client: &reqwest::blocking::Client,
    base: &str,
    workspaces_root: &Path,
    opts: &ServeOpts,
) -> usize {
    let token = match recall_cloud_creds() {
        Ok((_, tok)) => tok,
        Err(_) => {
            eprintln!(
                "{} multi-project mode needs a cloud login (`aura cloud login`) to discover work — skipping cycle",
                "⚠".yellow()
            );
            return 0;
        }
    };

    let slugs = pending_project_slugs(client, base, &token);
    if slugs.is_empty() {
        return 0;
    }
    eprintln!(
        "{} {} project(s) with pending work: {}",
        "[runner]".cyan(),
        slugs.len(),
        slugs.join(", ")
    );

    for full_name in &slugs {
        let Some(dir) = ensure_workspace(bin, workspaces_root, full_name) else {
            continue;
        };
        // Per-project view of the same options: pin the pull to this repo, run a
        // single drain pass over its ready set. Loop-level fields (poll/once/
        // name) don't apply to an inner cycle.
        let per = ServeOpts {
            name: None,
            agent: opts.agent.clone(),
            repo: Some(full_name.clone()),
            lease_secs: opts.lease_secs,
            poll_secs: opts.poll_secs,
            once: true,
            git_sync: opts.git_sync,
            all_projects: false,
            workspaces_root: None,
        };
        work_cycle(bin, &dir, &per);
    }
    slugs.len()
}

/// True if the repo has at least one configured git remote.
fn git_has_remote(repo_root: &Path) -> bool {
    Command::new("git")
        .args(["remote"])
        .current_dir(repo_root)
        .output()
        .map(|o| o.status.success() && !o.stdout.is_empty())
        .unwrap_or(false)
}

/// `aura runner serve` — the supervise loop.
pub fn serve(repo_root: &Path, opts: &ServeOpts) -> Result<(), Box<dyn std::error::Error>> {
    let client = cloud_http_client();
    let base = cloud_base();
    let bin = std::env::current_exe()?;

    // Multi-project mode drains every project with pending work, each in its own
    // workspace. An explicit `--repo` always wins (pins the box to one project),
    // so `all_projects` only engages when no repo filter is set.
    let multi = opts.all_projects && opts.repo.is_none();
    let workspaces_root: PathBuf = if multi {
        let root = opts
            .workspaces_root
            .clone()
            .map(PathBuf::from)
            .or_else(|| std::env::var("AURA_RUNNER_WORKSPACES").ok().map(PathBuf::from))
            .unwrap_or_else(|| {
                repo_root
                    .parent()
                    .map(|p| p.join("workspaces"))
                    .unwrap_or_else(|| repo_root.join("workspaces"))
            });
        let _ = std::fs::create_dir_all(&root);
        root
    } else {
        repo_root.to_path_buf()
    };

    let display_name = opts
        .name
        .clone()
        .or_else(|| std::env::var("HOSTNAME").ok())
        .unwrap_or_else(|| "aura-runner".to_string());

    // Learn our registry identity (best-effort). Absence just means we run
    // unregistered — the backlog still drains.
    let token = runner_token();
    let identity: Option<SelfIdentity> = match &token {
        Some(tok) => match resolve_self(&client, &base, tok) {
            Ok(id) => {
                println!(
                    "{} runner {} online — {}",
                    "▶".green().bold(),
                    id.name.cyan(),
                    base.dimmed()
                );
                Some(id)
            }
            Err(e) => {
                eprintln!(
                    "{} runner registry unavailable ({}). Running unregistered — work still proceeds.",
                    "⚠".yellow(),
                    e
                );
                None
            }
        },
        None => {
            eprintln!(
                "{} no {} set — running unregistered (won't show in the app). `aura runner register` to get one.",
                "⚠".yellow(),
                RUNNER_TOKEN_ENV
            );
            None
        }
    };

    let hb = |status: &str, task: &str| {
        if let (Some(id), Some(tok)) = (&identity, &token) {
            heartbeat(&client, &base, &id.id, tok, status, task);
        }
    };

    println!(
        "{} serving {} · agent={} · poll={}s · {}{}",
        "•".cyan(),
        display_name.bold(),
        opts.agent,
        opts.poll_secs,
        if multi {
            format!("all projects → {}", workspaces_root.display()).green().to_string()
        } else {
            match &opts.repo {
                Some(r) => format!("repo={r}"),
                None => "repo=auto".to_string(),
            }
        },
        if opts.once { " · once" } else { "" }
    );

    // Ctrl-C finishes the current cycle rather than tearing out mid-task. A
    // container SIGTERM that isn't caught still leaves any in-flight task safe:
    // its lease expires and another cycle/runner reclaims it.
    let running = Arc::new(AtomicBool::new(true));
    {
        let r = running.clone();
        let _ = ctrlc::set_handler(move || {
            eprintln!("\n{} shutdown requested — finishing current cycle…", "⏹".bold());
            r.store(false, Ordering::SeqCst);
        });
    }

    loop {
        if multi {
            hb("busy", "scanning projects for work");
            let n = multi_work_cycle(&bin, &client, &base, &workspaces_root, opts);
            hb("idle", &format!("drained {n} project(s)"));
        } else {
            hb("busy", "draining crew backlog");
            work_cycle(&bin, repo_root, opts);
            hb("idle", "");
        }

        if opts.once || !running.load(Ordering::SeqCst) {
            break;
        }
        // Interruptible idle: wake early on a shutdown signal instead of
        // sleeping out the whole poll window.
        let mut slept = 0;
        while slept < opts.poll_secs.max(1) && running.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_secs(1));
            slept += 1;
        }
    }

    // Mark offline on graceful exit so the app doesn't wait out the freshness
    // window. (A hard-killed server decays to offline on its own via the gap.)
    hb("offline", "");
    Ok(())
}

/// Resolve an `owner/name` slug to the org's repo id via `/api/v2/repos`.
fn resolve_repo_id(
    client: &reqwest::blocking::Client,
    base: &str,
    token: &str,
    slug: &str,
) -> Option<String> {
    let body = recall_get(client, &format!("{base}/api/v2/repos"), token).ok()?;
    let repos = body.get("repos").and_then(|v| v.as_array())?;
    repos
        .iter()
        .find(|r| r.get("full_name").and_then(|v| v.as_str()) == Some(slug))
        .and_then(|r| r.get("id").and_then(|v| v.as_str()))
        .map(|s| s.to_string())
}

/// `aura runner register` — mint a runner + its one-time token.
pub fn register(opts: &RegisterOpts) -> Result<(), Box<dyn std::error::Error>> {
    let (cloud_url, token) = recall_cloud_creds()?;
    let base = cloud_url.trim_end_matches('/');
    let client = cloud_http_client();

    let mut body = json!({ "name": opts.name });
    if !opts.agent_kinds.is_empty() {
        body["agent_kinds"] = json!(opts.agent_kinds);
    }
    if let Some(slug) = &opts.repo {
        match resolve_repo_id(&client, base, &token, slug) {
            Some(id) => {
                body["repo_id"] = json!(id);
            }
            None => {
                return Err(format!(
                    "repo {slug} not found in your org — omit --repo for an org-wide runner"
                )
                .into());
            }
        }
    }

    let resp = recall_post(&client, &format!("{base}/api/v2/runners"), &token, &body).map_err(
        |e| -> Box<dyn std::error::Error> {
            if e.contains("404") {
                "The runner registry isn't deployed on this cloud yet (needs the `runners` feature). Ask an admin to deploy it, or run the crew loop directly with `aura crew run`.".into()
            } else {
                e.into()
            }
        },
    )?;

    let runner_tok = resp.get("token").and_then(|v| v.as_str()).unwrap_or("");
    let name = resp.get("name").and_then(|v| v.as_str()).unwrap_or(&opts.name);

    println!("{} runner {} registered", "✓".green().bold(), name.cyan());
    println!();
    println!("Save this token — it is shown only once:");
    println!("  {}", runner_tok.yellow());
    println!();
    println!("On the runner box, export it and start serving:");
    println!("  {}", format!("export {RUNNER_TOKEN_ENV}={runner_tok}").dimmed());
    println!("  {}", "aura runner serve".dimmed());
    Ok(())
}

/// `aura runner status` — print this box's registry record (RunnerAuth).
pub fn status() -> Result<(), Box<dyn std::error::Error>> {
    let token = runner_token().ok_or_else(|| {
        format!("no {RUNNER_TOKEN_ENV} set — run `aura runner register` on your account first")
    })?;
    let client = cloud_http_client();
    let base = cloud_base();
    let id = resolve_self(&client, &base, &token)?;
    let body = recall_get(&client, &format!("{base}/api/v2/runners/self"), &token)?;
    let online = body.get("online").and_then(|v| v.as_bool()).unwrap_or(false);
    let status = body.get("status").and_then(|v| v.as_str()).unwrap_or("unknown");
    let task = body.get("current_task").and_then(|v| v.as_str()).unwrap_or("");
    println!(
        "{} {} · {} · {}",
        if online { "●".green() } else { "○".red() },
        id.name.bold(),
        status,
        if task.is_empty() { "idle".dimmed().to_string() } else { task.to_string() }
    );
    Ok(())
}
