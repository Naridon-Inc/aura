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

use crate::push_credential;
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

/// How a heartbeat says "this box can't sign its agent in".
///
/// The registry stores three things a runner reports — status, current task,
/// version — and none of them has room for "healthy but unable to work". Rather
/// than migrate the cloud for one flag, the note rides in on `current_task`
/// behind a lead phrase the desktop matches (`CloudRunnerPanel.blockedNote`).
/// Keep the two in step: the phrase is the whole contract.
const AUTH_NOTE_LEAD: &str = "Needs sign-in";

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
    //    `--place cloud` is this box declaring what it is: it takes the nodes
    //    marked for a machine in the cloud plus every unplaced one, and leaves
    //    anything pinned `local` for the laptop that pinned it. Without the
    //    flag a runner would happily claim work someone kept back because it
    //    needs their keychain or their eyes.
    run_sub(
        bin,
        repo_root,
        &[
            "crew", "run", "--agent", &opts.agent, "--lease-secs", &lease, "--max", "0",
            "--place", "cloud",
        ],
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
        // Report git's own reason. This used to print "skipped (no
        // upstream/creds)" for *every* non-zero exit, which is a guess — and on
        // the runner box it was the wrong one: the push was rejected as
        // non-fast-forward, and the log sent whoever read it off to check
        // credentials that were fine. A push that didn't happen is worth a line;
        // a line naming the wrong cause is worse than none.
        match Command::new("git").args(["push"]).current_dir(repo_root).output() {
            Ok(o) if o.status.success() => {}
            Ok(o) => {
                let why = String::from_utf8_lossy(&o.stderr);
                let line = why
                    .lines()
                    .map(str::trim)
                    .find(|l| {
                        !l.is_empty() && !l.starts_with("hint:") && !l.starts_with("To ")
                    })
                    .unwrap_or("git push failed");
                eprintln!("{} git push failed: {}", "[runner]".dimmed(), line.dimmed());
            }
            Err(e) => eprintln!("{} couldn't run git push: {e}", "[runner]".dimmed()),
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
    let url = format!("https://github.com/{full_name}.git");

    if !dir.join(".git").exists() {
        // A leftover dir from a half-finished clone would make `git clone` fail
        // ("already exists and is not empty") on every future cycle — clear it.
        if dir.exists() {
            let _ = std::fs::remove_dir_all(&dir);
        }
        if let Some(parent) = dir.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        eprintln!(
            "{} cloning {} → {}",
            "[runner]".dimmed(),
            full_name.cyan(),
            dir.display()
        );
        // The clone is the FIRST thing that needs a credential, and it used to
        // be the one git call that named none at all — inheriting whatever the
        // box happened to have. When this box knows which member it is acting
        // for, the clone spends that member's own short-lived token.
        let ok = Command::new("git")
            .args(member_git_args(bin))
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
            .args(member_git_args(bin))
            .args(["fetch", "--all", "--prune"])
            .current_dir(&dir)
            .status();
    }

    // Idempotent: identity, credential and hooks. `git config` is a no-op if
    // already set to the same value; `aura enable` is safe to re-run.
    attach_member_identity(&dir, bin, &url);
    let _ = Command::new(bin).args(["enable"]).current_dir(&dir).status();

    Some(dir)
}

/// The `-c` arguments that make one git invocation spend the acting member's
/// own credential, or nothing at all when this box has not been told who it is
/// acting for.
///
/// Empty rather than a fallback on purpose. Injecting the reset half of
/// [`push_credential::git_config_args`] with no member behind it would clear
/// whatever credential the box does have and break a push that works today.
fn member_git_args(bin: &Path) -> Vec<String> {
    if push_credential::acting_member().is_some() {
        push_credential::git_config_args(bin)
    } else {
        Vec::new()
    }
}

/// Give a checkout the acting member's credential and the acting member's
/// commit identity, or leave it on the old shared-box behaviour and say so.
///
/// The two travel together deliberately. A per-member token with a box-wide
/// author writes commits that push fine and belong to nobody, which is the
/// half-fix that made the original problem hard to see: the work was on GitHub,
/// under "Aura Runner", and no-one could tell whose it was.
fn attach_member_identity(dir: &Path, bin: &Path, remote: &str) {
    match push_credential::attach_to_checkout(dir, bin, remote) {
        push_credential::Attached::Member { login, email } => {
            eprintln!(
                "{} pushing as {} <{}> on a short-lived token minted for them",
                "[runner]".dimmed(),
                login.cyan(),
                email.dimmed()
            );
        }
        push_credential::Attached::NoMember => {
            legacy_shared_identity(dir);
        }
        push_credential::Attached::Refused(why) => {
            eprintln!(
                "{} no per-member push credential ({}) — commits will land under the shared runner identity",
                "⚠".yellow(),
                why
            );
            legacy_shared_identity(dir);
        }
    }
}

/// What every commit on a shared box used to be attributed to. Kept as the
/// fallback so a box that has not been told which member it serves keeps
/// working exactly as it did — it just stops being the default.
fn legacy_shared_identity(dir: &Path) {
    let _ = Command::new("git")
        .args(["config", "user.name", "Aura Runner"])
        .current_dir(dir)
        .status();
    let _ = Command::new("git")
        .args(["config", "user.email", "runner@auravcs.com"])
        .current_dir(dir)
        .status();
}

/// The `origin` URL of a checkout — what a credential gets scoped against.
fn origin_url(repo_root: &Path) -> Option<String> {
    let out = Command::new("git")
        .args(["remote", "get-url", "origin"])
        .current_dir(repo_root)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let url = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!url.is_empty()).then_some(url)
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
/// Where per-project workspaces go when nobody said.
///
/// The old answer was "beside the runner's own checkout", which is right when
/// the runner was started from one — but a systemd unit's working directory is
/// whatever the unit says, and if that isn't a checkout the `parent()` walk
/// lands somewhere arbitrary. It produced `/workspaces`, at the filesystem
/// root, and every clone then failed with a permission error that named git
/// rather than the real cause.
///
/// So: beside the checkout when there genuinely is one, and otherwise under the
/// home of the user the runner runs as — which exists and is writable by
/// construction.
fn default_workspaces_root(repo_root: &Path) -> PathBuf {
    if repo_root.join(".git").exists() {
        if let Some(parent) = repo_root.parent().filter(|p| !p.as_os_str().is_empty()) {
            return parent.join("workspaces");
        }
    }
    match std::env::var("HOME") {
        Ok(h) if !h.trim().is_empty() => PathBuf::from(h).join("aura-workspaces"),
        // No HOME at all is pathological, but falling back to the checkout is
        // still better than a path anchored at `/`.
        _ => repo_root.join("workspaces"),
    }
}

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
            .unwrap_or_else(|| default_workspaces_root(repo_root));
        // Naming the directory matters more than the errno: a runner that can't
        // create this fails every clone afterwards with "could not create
        // leading directories", which reads like a git problem.
        if let Err(e) = std::fs::create_dir_all(&root) {
            eprintln!(
                "[runner] can't use {} for project workspaces: {e}\n\
                 [runner] set AURA_RUNNER_WORKSPACES (or --workspaces-root) to a writable directory",
                root.display()
            );
        }
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

    // Single-repo mode never goes through `ensure_workspace`, so the one
    // checkout it drains would keep the shared credential and the shared author
    // while every auto-cloned workspace got the member's own. Same wiring, same
    // place in the cycle — a box must not push as two different people
    // depending on how it was started.
    if !multi {
        if push_credential::acting_member().is_some() {
            match origin_url(repo_root) {
                Some(remote) => attach_member_identity(repo_root, &bin, &remote),
                None => eprintln!(
                    "{} this checkout has no `origin`, so there is no remote to mint a \
                     per-member credential for",
                    "⚠".yellow()
                ),
            }
        }
    }

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

    // Can this box actually run the agent it just announced?
    //
    // An unauthenticated runner is the worst shape of broken: it registers, it
    // heartbeats `idle`, and then it fails every task it claims with "Not
    // logged in · Please run /login" — a sentence that lands on the task row
    // and nowhere else. The board shows a healthy machine above a growing pile
    // of failed work, and nothing on either screen connects the two.
    //
    // So ask once, before claiming anything, and put the answer in both places
    // that matter: the operator's log, with the exact commands that fix it, and
    // the heartbeat — which is the only channel the app reads, so it's the only
    // way "this machine can't run Claude" reaches the person looking at it.
    let auth_note: Option<String> = match crate::runner_creds::auth_for(&opts.agent) {
        crate::runner_creds::AgentAuth::Ready(how) => {
            println!("{} {} can sign in — {}", "✓".green(), opts.agent.bold(), how.dimmed());
            None
        }
        crate::runner_creds::AgentAuth::Undetermined(why) => {
            eprintln!("{} couldn't confirm {} can sign in: {}", "·".dimmed(), opts.agent, why.dimmed());
            None
        }
        crate::runner_creds::AgentAuth::Missing => {
            eprintln!(
                "\n{} this box has no credential for {} — every task it claims will fail with \"Not logged in\".\n{}\n",
                "⚠".yellow().bold(),
                opts.agent.bold(),
                crate::runner_creds::fix_hint(&opts.agent)
            );
            // Short, and in the words the app shows verbatim on the machine
            // row. The leading phrase is a contract, not a sentence we happened
            // to write: `CloudRunnerPanel.blockedNote` matches on it to decide
            // that this row's status is the problem rather than "Ready".
            Some(format!(
                "{AUTH_NOTE_LEAD} — this machine has no credential for {}",
                opts.agent
            ))
        }
    };

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
        // A machine that can't authenticate says so on every idle beat rather
        // than reporting the cycle it just went through the motions of. "Drained
        // 3 projects" is true and misleading when all three failed for one
        // reason the row could have named.
        if multi {
            hb("busy", "scanning projects for work");
            let n = multi_work_cycle(&bin, &client, &base, &workspaces_root, opts);
            let done = format!("drained {n} project(s)");
            hb("idle", auth_note.as_deref().unwrap_or(&done));
        } else {
            hb("busy", "draining crew backlog");
            work_cycle(&bin, repo_root, opts);
            hb("idle", auth_note.as_deref().unwrap_or(""));
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
            } else if e.contains("403") {
                // Registering mints a machine credential, so the server allows
                // it for org owners/admins only. Say that plainly — the raw
                // 403 body is empty and reads like a broken token.
                "Only an owner or admin of your org can register a runner. Ask one of them to run this, or to make you an admin.".into()
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

#[cfg(test)]
mod tests {
    use super::*;

    /// The regression this guards: a systemd unit whose WorkingDirectory is a
    /// plain home directory made the `parent()` walk produce `/workspaces`,
    /// and every clone afterwards failed with a permission error at the root
    /// of the filesystem.
    #[test]
    fn a_working_directory_that_is_not_a_checkout_never_anchors_workspaces_at_the_root() {
        let root = default_workspaces_root(Path::new("/home/ubuntu"));
        assert!(
            !root.starts_with("/workspaces"),
            "workspaces must not land at the filesystem root, got {}",
            root.display()
        );
        let home = PathBuf::from(std::env::var("HOME").expect("tests run with HOME set"));
        assert!(
            root.starts_with(&home),
            "expected the fallback under {}, got {}",
            home.display(),
            root.display()
        );
    }

    #[test]
    fn a_real_checkout_still_gets_its_workspaces_sibling() {
        // A hand-provisioned box runs from /opt/aura-runner/repo and expects
        // /opt/aura-runner/workspaces; that layout must keep working.
        let tmp = std::env::temp_dir().join("aura-ws-test-checkout");
        let repo = tmp.join("repo");
        std::fs::create_dir_all(repo.join(".git")).unwrap();
        assert_eq!(default_workspaces_root(&repo), tmp.join("workspaces"));
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
