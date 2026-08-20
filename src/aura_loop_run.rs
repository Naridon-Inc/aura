//! `aura loop run` — the autonomous loop runner + harness.
//!
//! This is the native equivalent of hew's "Ralph" loop. It drains the
//! ready set produced by [`aura_loop::ready_view`]: for each ready
//! node it claims a lease, dispatches the node's work to a coding agent
//! through the same `aura_agents` registry the Manager fan-out uses,
//! records the commit the agent produced, runs an optional verify gate,
//! and marks the node completed or failed.
//!
//! Crash recovery is free: a runner that dies mid-node leaves a lease that
//! expires, and the next iteration's `reclaim_stale()` returns the node to
//! the ready set so another runner (or the next pass) picks it up.

use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::Duration;

use aura_agents::{AgentProvider, InvokeMode, InvokeRequest, registry};
use colored::Colorize;

use aura_loop::run_log::{RunLedger, RunNode, RunRecord};
use aura_loop::{self, LoopGraph, LoopTask, RunScope};

use crate::loop_accept;
use crate::loop_stranded;
use crate::loop_worktree::{self, LoopWorktree};

/// Wall-clock seconds since the epoch — the stamp the run ledger records.
fn ledger_now() -> i64 {
    chrono::Utc::now().timestamp()
}

/// Options for a single `aura loop run` invocation.
#[derive(Clone)]
pub struct RunOpts {
    /// Default agent for nodes that don't name their own `agent_kind`.
    pub agent: String,
    /// Lease duration in seconds (crash-recovery window).
    pub lease_secs: i64,
    /// Stop after this many nodes reach a terminal state (0 = drain).
    pub max: usize,
    /// Optional shell command run after each node; non-zero fails the node.
    pub verify: Option<String>,
    /// Print the plan without spawning any agent.
    pub dry_run: bool,
    /// Keep polling for newly-ready nodes instead of exiting when drained.
    pub watch: bool,
    /// Emit machine-readable JSON instead of the human log.
    pub json: bool,
    /// How many nodes to work at once. 1 = the classic sequential loop;
    /// >1 runs each node in its own throwaway git worktree and merges the
    /// good ones back, so independent tasks build in parallel without
    /// branch-switch churn.
    pub jobs: usize,
    /// When a node's work fails the acceptance gate (verify command or goal
    /// proof), revert its commit instead of leaving broken code on the branch.
    /// In `--jobs` mode rollback is automatic (the bad work dies with the
    /// worktree); this flag governs the sequential path that commits in place.
    pub rollback: bool,
    /// Drain only the nodes tagged `goal:<this>` — run one goal on its own.
    pub goal: Option<String>,
    /// Drain only this crew's nodes — run one crew while another works.
    pub crew: Option<String>,
    /// Which machine this process is — `local` or `cloud`. Nodes placed on the
    /// other machine stay in the graph untouched; see `scoped_ready`.
    pub place: String,
}

impl RunOpts {
    /// The slice of the graph this run drains. Unscoped = the whole board.
    fn scope(&self) -> RunScope {
        RunScope {
            goal: self.goal.clone(),
            crew: self.crew.clone(),
        }
    }
}

/// The ready set narrowed to a run's scope AND to what this machine may run.
///
/// Readiness (dependency satisfaction) is always computed over the WHOLE graph
/// — a node's deps may live in another goal/crew, or on the other machine — then
/// filtered down. A cloud-placed node blocking a local one still counts as a
/// dependency here; it just isn't ours to claim.
fn scoped_ready(graph: &LoopGraph, scope: &RunScope, place: &str) -> Vec<LoopTask> {
    let ready = aura_loop::ready_set(&graph.list());
    let scoped = if scope.is_unscoped() { ready } else { scope.filter(&ready) };
    scoped
        .into_iter()
        .filter(|t| aura_loop::runs_here(t, place))
        .collect()
}

/// Ready nodes this machine is deliberately leaving alone. The count is worth
/// printing: a laptop that drains four of six nodes and says nothing looks like
/// it silently dropped two. Naming them as waiting-for-the-box is the
/// difference between a split run and a broken one.
fn deferred_elsewhere(graph: &LoopGraph, scope: &RunScope, place: &str) -> Vec<LoopTask> {
    let ready = aura_loop::ready_set(&graph.list());
    let scoped = if scope.is_unscoped() { ready } else { scope.filter(&ready) };
    scoped
        .into_iter()
        .filter(|t| !aura_loop::runs_here(t, place))
        .collect()
}

enum Outcome {
    Completed { commit: Option<String> },
    Failed { reason: String },
}

/// Drive the loop to completion (or to `max`, or forever under `--watch`).
pub fn run(repo_root: &Path, opts: &RunOpts) -> Result<(), Box<dyn std::error::Error>> {
    let graph = LoopGraph::at(repo_root);

    // Dry-run: show the whole current ready set + the prompt each node would
    // get, then return without touching any state.
    if opts.dry_run {
        // Preview the SAME slice a live run would drain — honor --crew/--goal
        // instead of printing the whole board (which misled scoped previews).
        let ready = scoped_ready(&graph, &opts.scope(), &opts.place);
        if opts.json {
            let plan: Vec<serde_json::Value> = ready
                .iter()
                .map(|t| {
                    serde_json::json!({
                        "id": t.id,
                        "title": t.title,
                        "agent": agent_for(t, opts),
                        "prompt": build_prompt(t),
                    })
                })
                .collect();
            println!("{}", serde_json::to_string(&plan)?);
        } else {
            if ready.is_empty() {
                println!("{}", "Ready set is empty — nothing to dispatch.".dimmed());
            } else {
                println!("{} ({}) — dispatch plan", "DRY RUN".magenta().bold(), ready.len());
                for t in &ready {
                    println!(
                        "\n{} {} → {}",
                        t.short_id().yellow().bold(),
                        t.title.bold(),
                        agent_for(t, opts).cyan(),
                    );
                    println!("{}", indent(&build_prompt(t)));
                }
            }
            // A preview that shows three of five ready nodes and says nothing
            // about the other two is the exact confusion placement exists to
            // remove. Name them here for the same reason the live summary does.
            let waiting = deferred_elsewhere(&graph, &opts.scope(), &opts.place);
            if !waiting.is_empty() {
                let whose = if opts.place == aura_loop::PLACE_LOCAL {
                    "a machine in the cloud"
                } else {
                    "a machine someone is sitting at"
                };
                println!("\n{} {} node(s) for {}:", "⇢".cyan().bold(), waiting.len(), whose);
                for t in &waiting {
                    println!("  {} {}", t.short_id().yellow(), t.title.dimmed());
                }
            }
        }
        return Ok(());
    }

    let runner = runner_id();
    if !opts.json {
        eprintln!("{} runner {}", "▶".green().bold(), runner.dimmed());
    }

    let scope = opts.scope();

    // Parallel path: each ready node builds in its own throwaway git worktree,
    // and only work that passes the acceptance gate gets merged back. The
    // classic sequential loop below handles jobs <= 1 unchanged.
    if opts.jobs > 1 {
        return run_parallel(repo_root, opts, &graph, &runner, &scope);
    }

    let mut done = 0usize;
    let mut log: Vec<serde_json::Value> = Vec::new();
    let mut record = RunRecord::begin(
        runner.clone(),
        opts.crew.clone(),
        opts.goal.clone(),
        opts.jobs,
        ledger_now(),
    );

    loop {
        // 1. Recover any node whose runner died (expired lease). Scoped to this
        // run — another crew's node is another runner's business, and its lease
        // says nothing about whether that runner is still alive.
        let reclaimed = graph.reclaim_stale_in(&scope);
        if !reclaimed.is_empty() && !opts.json {
            eprintln!("{} reclaimed {} stale node(s)", "↻".yellow(), reclaimed.len());
        }

        // 2. Take the highest-priority ready node within this run's scope.
        let Some(task) = scoped_ready(&graph, &scope, &opts.place).into_iter().next() else {
            if opts.watch {
                if !opts.json {
                    eprintln!("{}", "ready set empty — watching (Ctrl-C to stop)…".dimmed());
                }
                std::thread::sleep(Duration::from_secs(5));
                continue;
            }
            break;
        };

        // 3. Claim it (lease). If a concurrent runner grabbed it first, skip.
        let claimed = match graph.claim(&task.id, &runner, opts.lease_secs) {
            Ok(t) => t,
            Err(_) => continue,
        };
        if !opts.json {
            eprintln!(
                "{} {} {}",
                "→".green().bold(),
                claimed.short_id().yellow().bold(),
                claimed.title.bold(),
            );
        }

        // 4. Dispatch through the harness.
        let outcome = dispatch(repo_root, &claimed, opts);
        let entry = match outcome {
            Outcome::Completed { commit } => {
                graph
                    .complete(&claimed.id, commit.clone(), None)
                    .map_err(|e| -> Box<dyn std::error::Error> { e.into() })?;
                if !opts.json {
                    let c = commit.as_deref().unwrap_or("(no new commit)");
                    eprintln!("  {} {}", "✓ completed".green(), c.dimmed());
                }
                record.push(RunNode {
                    id: claimed.id.clone(),
                    title: claimed.title.clone(),
                    outcome: "completed".into(),
                    commit: commit.clone(),
                    detail: None,
                });
                serde_json::json!({"id": claimed.id, "status": "completed", "commit": commit})
            }
            Outcome::Failed { reason } => {
                graph
                    .fail(&claimed.id, reason.clone())
                    .map_err(|e| -> Box<dyn std::error::Error> { e.into() })?;
                if !opts.json {
                    eprintln!("  {} {}", "✗ failed".red(), reason.dimmed());
                }
                // With --rollback the failed node's commit was reverted in
                // place, so the branch is clean — record it as such.
                let outcome = if opts.rollback { "rolled-back" } else { "failed" };
                record.push(RunNode {
                    id: claimed.id.clone(),
                    title: claimed.title.clone(),
                    outcome: outcome.into(),
                    commit: None,
                    detail: Some(reason.clone()),
                });
                serde_json::json!({"id": claimed.id, "status": "failed", "error": reason})
            }
        };
        log.push(entry);
        done += 1;
        if opts.max > 0 && done >= opts.max {
            break;
        }
    }

    record_run(repo_root, &mut record);

    if opts.json {
        println!("{}", serde_json::to_string(&log)?);
    } else {
        print_run_summary(&graph, &scope, opts, done);
    }
    Ok(())
}

/// Close out a run: how many nodes it processed, and — the part that matters
/// for a split crew — what it deliberately did not touch.
///
/// A laptop that drains four of six ready nodes and prints "4 processed" looks
/// like it dropped two. Naming the other two as the box's work is what makes a
/// split run legible instead of lossy.
fn print_run_summary(graph: &LoopGraph, scope: &RunScope, opts: &RunOpts, done: usize) {
    eprintln!("{} {} node(s) processed", "■".green().bold(), done);
    let waiting = deferred_elsewhere(graph, scope, &opts.place);
    if waiting.is_empty() {
        return;
    }
    let (whose, next) = if opts.place == aura_loop::PLACE_LOCAL {
        (
            "a machine in the cloud",
            "`aura crew cloud-sync` hands them to your connected boxes",
        )
    } else {
        (
            "a machine someone is sitting at",
            "they run on the next local `aura crew run`",
        )
    };
    eprintln!(
        "{} {} ready node(s) left for {} — {}",
        "⇢".cyan().bold(),
        waiting.len(),
        whose,
        next.dimmed()
    );
    for t in waiting.iter().take(5) {
        eprintln!("  {} {}", t.short_id().yellow(), t.title.dimmed());
    }
    if waiting.len() > 5 {
        eprintln!("  {}", format!("… and {} more", waiting.len() - 5).dimmed());
    }
}

/// Stamp the end time and append the run to `.aura/crew/runs.jsonl`. A run that
/// touched no nodes is not worth a ledger line (it found nothing to do), so
/// empty runs are skipped. Ledger I/O never fails the run — the live truth is
/// always the graph itself.
fn record_run(repo_root: &Path, record: &mut RunRecord) {
    if record.attempted == 0 {
        return;
    }
    record.finish(ledger_now());
    let _ = RunLedger::at(repo_root).append(record);
}

// ── parallel runner (--jobs N) ──────────────────────────────────────────────

/// One finished worker handed back to the main thread for git surgery.
/// `task` and `wt` travel out to the worker and back so the main thread —
/// the only place that touches the repo index — can merge or discard.
struct WorkerResult {
    task: LoopTask,
    wt: LoopWorktree,
    outcome: Outcome,
}

/// Parallel loop runner. Each ready node builds in its own throwaway git
/// worktree on branch `loop/<id>`; up to `opts.jobs` run at once. Only the
/// main thread ever claims/completes/fails nodes or touches the repo index —
/// worktree creation, merge-back, and discard are all serialized here — so the
/// agents run concurrently without racing on the git lock. Work that passes the
/// acceptance gate is merged back; work that fails dies with its worktree, which
/// is the automatic rollback `--jobs` mode provides (no `--rollback` needed).
///
/// Note: with multiple agents streaming at once the human log on stderr
/// interleaves; use `--json` for a clean machine-readable summary.
fn run_parallel(
    repo_root: &Path,
    opts: &RunOpts,
    graph: &LoopGraph,
    runner: &str,
    scope: &RunScope,
) -> Result<(), Box<dyn std::error::Error>> {
    if !opts.json {
        eprintln!("{} up to {} in parallel (worktrees)", "⥂".cyan().bold(), opts.jobs);
    }

    // Configure the AST merge driver in this repo before any worktree merges
    // back. With it installed, two agents that edit the same file at different
    // AST nodes reconcile cleanly instead of colliding on git's line merge —
    // the semantic substrate that makes N isolated agents mergeable. Idempotent
    // and best-effort: if it can't install, merges simply fall back to git's
    // line merge (a genuine conflict then fails the node, which is honest).
    if let Err(e) = crate::merge_driver::ensure_installed(repo_root) {
        if !opts.json {
            eprintln!(
                "{} couldn't set up semantic merge ({}); merges use git's line merge",
                "·".dimmed(),
                first_line(&e).dimmed()
            );
        }
    }

    // Read the project's worktree warm-up recipe once. Each fresh worktree runs
    // this (deps install, build prime) before its agent dispatches, so the
    // acceptance gate tests buildable state instead of a bare checkout. Absent
    // or empty → no-op, i.e. today's bare behaviour.
    let declared = crate::worktree_scripts::spec(repo_root);
    let warms = !declared.is_empty();
    if warms && !opts.json {
        eprintln!(
            "{} warm-up per worktree: {}",
            "·".dimmed(),
            format!(
                "spec v{} — {} toolchain(s), {} package(s), {} service(s)",
                declared.version,
                declared.toolchain.tools.len(),
                declared.packages.len(),
                declared.services.len()
            )
            .dimmed()
        );
    }

    let (tx, rx) = mpsc::channel::<WorkerResult>();
    let mut in_flight = 0usize;
    let mut done = 0usize;
    let mut log: Vec<serde_json::Value> = Vec::new();
    let mut record = RunRecord::begin(
        runner.to_string(),
        opts.crew.clone(),
        opts.goal.clone(),
        opts.jobs,
        ledger_now(),
    );

    loop {
        // Top up the pool with ready nodes, unless we've already scheduled
        // enough to reach `max`. Worktrees are created HERE, on the main
        // thread, so concurrent `git worktree add` never races the index lock.
        let hit_max = opts.max > 0 && (done + in_flight) >= opts.max;
        if !hit_max {
            while in_flight < opts.jobs && !(opts.max > 0 && (done + in_flight) >= opts.max) {
                let reclaimed = graph.reclaim_stale_in(scope);
                if !reclaimed.is_empty() && !opts.json {
                    eprintln!("{} reclaimed {} stale node(s)", "↻".yellow(), reclaimed.len());
                }

                // A node still claimed/working (one we just dispatched) is no
                // longer ready, so this never re-hands the same node out.
                let Some(task) = scoped_ready(graph, scope, &opts.place).into_iter().next() else {
                    break;
                };
                let claimed = match graph.claim(&task.id, runner, opts.lease_secs) {
                    Ok(t) => t,
                    Err(_) => continue,
                };

                // Branch the worktree off the repo's CURRENT head so it inherits
                // every node merged back so far (dependents build on their deps).
                let base = head_sha(repo_root);
                let wt = match loop_worktree::create(repo_root, &claimed.id, base.as_deref()) {
                    Ok(w) => w,
                    Err(e) => {
                        let reason = format!("couldn't set up an isolated workspace: {}", first_line(&e));
                        if !opts.json {
                            eprintln!("  {} {} {}", "✗".red(), claimed.short_id().yellow(), reason.dimmed());
                        }
                        graph
                            .fail(&claimed.id, reason.clone())
                            .map_err(|e| -> Box<dyn std::error::Error> { e.into() })?;
                        record.push(RunNode {
                            id: claimed.id.clone(),
                            title: claimed.title.clone(),
                            outcome: "failed".into(),
                            commit: None,
                            detail: Some(reason.clone()),
                        });
                        log.push(serde_json::json!({"id": claimed.id, "status": "failed", "error": reason}));
                        done += 1;
                        continue;
                    }
                };

                if !opts.json {
                    eprintln!(
                        "{} {} {} {}",
                        "→".green().bold(),
                        claimed.short_id().yellow().bold(),
                        claimed.title.bold(),
                        format!("[{}]", wt.branch).dimmed(),
                    );
                }

                let tx = tx.clone();
                let opts_for_worker = opts.clone();
                let root_for_worker = repo_root.to_path_buf();
                std::thread::spawn(move || {
                    // The worker only ever touches its own worktree dir — never
                    // the repo index — so this is safe to run off the main thread.
                    // Bring the worktree to the project's declared environment
                    // first, so the agent and the acceptance gate run against
                    // ready state rather than a bare checkout. A failed warm-up
                    // is non-fatal: the agent still runs and the gate decides
                    // honestly. Same spec, same plan, same order the human's
                    // `aura work` gets — a crew worktree is not a lesser place.
                    if warms {
                        let outcome = crate::worktree_scripts::bring_to_spec(
                            &root_for_worker,
                            &wt.path,
                            aura_env::Scope::Full,
                            opts_for_worker.json,
                            &[],
                            false,
                        );
                        let note = match &outcome {
                            Ok(r) if r.at_spec => None,
                            Ok(r) => Some(r.summary()),
                            Err(e) => Some(e.clone()),
                        };
                        if let (Some(note), false) = (note, opts_for_worker.json) {
                            eprintln!(
                                "  {} {} warm-up: {} (continuing)",
                                "·".dimmed(),
                                claimed.short_id().yellow(),
                                note.dimmed(),
                            );
                        }
                    }
                    let outcome = dispatch(&wt.path, &claimed, &opts_for_worker);
                    let _ = tx.send(WorkerResult { task: claimed, wt, outcome });
                });
                in_flight += 1;
            }
        }

        // Nothing running and we couldn't start more: drain done, or wait if
        // watching for new work, or exit.
        if in_flight == 0 {
            if !hit_max && opts.watch {
                if !opts.json {
                    eprintln!("{}", "ready set empty — watching (Ctrl-C to stop)…".dimmed());
                }
                std::thread::sleep(Duration::from_secs(5));
                continue;
            }
            break;
        }

        // Reap exactly one finished worker. Safe: in_flight > 0 means a worker
        // still holds a sender, and we hold `tx` for the whole run, so recv()
        // blocks until that worker reports rather than erroring.
        let Ok(res) = rx.recv() else { break };
        in_flight -= 1;
        let (entry, node) = finish_worker(repo_root, opts, graph, res)?;
        record.push(node);
        log.push(entry);
        done += 1;
    }

    record_run(repo_root, &mut record);

    if opts.json {
        println!("{}", serde_json::to_string(&log)?);
    } else {
        print_run_summary(graph, scope, opts, done);
    }
    Ok(())
}

/// Main-thread git surgery for one finished worker: merge the good work back,
/// or discard the bad. Either way the worktree is torn down. This is the only
/// place a `--jobs` run touches the repo index, so it's inherently serialized.
fn finish_worker(
    repo_root: &Path,
    opts: &RunOpts,
    graph: &LoopGraph,
    res: WorkerResult,
) -> Result<(serde_json::Value, RunNode), Box<dyn std::error::Error>> {
    let WorkerResult { task, wt, outcome } = res;
    match outcome {
        Outcome::Completed { commit } => {
            // The agent's work passed its gate in the worktree — bring the
            // branch into the main line, then tear the worktree down.
            match loop_worktree::merge_back(repo_root, &wt) {
                Ok(()) => {
                    let _ = loop_worktree::discard(repo_root, &wt);
                    graph
                        .complete(&task.id, commit.clone(), None)
                        .map_err(|e| -> Box<dyn std::error::Error> { e.into() })?;
                    if !opts.json {
                        let c = commit.as_deref().unwrap_or("(no new commit)");
                        eprintln!("  {} {} {}", "✓ merged".green(), task.short_id().yellow(), c.dimmed());
                    }
                    let node = RunNode {
                        id: task.id.clone(),
                        title: task.title.clone(),
                        outcome: "merged".into(),
                        commit: commit.clone(),
                        detail: None,
                    };
                    Ok((serde_json::json!({"id": task.id, "status": "completed", "commit": commit}), node))
                }
                Err(e) => {
                    // Passed its own gate but won't merge cleanly — don't force
                    // it onto the branch. Drop it and let a human/retry redo it
                    // on the new base.
                    let _ = loop_worktree::discard(repo_root, &wt);
                    let reason = format!("work was good but it wouldn't merge back cleanly: {}", first_line(&e));
                    graph
                        .fail(&task.id, reason.clone())
                        .map_err(|e| -> Box<dyn std::error::Error> { e.into() })?;
                    if !opts.json {
                        eprintln!("  {} {} {}", "✗ merge".red(), task.short_id().yellow(), reason.dimmed());
                    }
                    let node = RunNode {
                        id: task.id.clone(),
                        title: task.title.clone(),
                        outcome: "failed".into(),
                        commit: None,
                        detail: Some(reason.clone()),
                    };
                    Ok((serde_json::json!({"id": task.id, "status": "failed", "error": reason}), node))
                }
            }
        }
        Outcome::Failed { reason } => {
            // Failed the gate: the bad commit lives only on the throwaway branch,
            // so discarding the worktree IS the rollback — nothing reaches main.
            let _ = loop_worktree::discard(repo_root, &wt);
            graph
                .fail(&task.id, reason.clone())
                .map_err(|e| -> Box<dyn std::error::Error> { e.into() })?;
            if !opts.json {
                eprintln!("  {} {} {}", "✗ failed".red(), task.short_id().yellow(), reason.dimmed());
            }
            let node = RunNode {
                id: task.id.clone(),
                title: task.title.clone(),
                // The bad work died with its worktree — that's the rollback.
                outcome: "rolled-back".into(),
                commit: None,
                detail: Some(reason.clone()),
            };
            Ok((serde_json::json!({"id": task.id, "status": "failed", "error": reason}), node))
        }
    }
}

/// First non-empty line of a (possibly multi-line) git/stderr blob, for tidy
/// one-line reasons. Falls back to the whole trimmed string.
fn first_line(s: &str) -> String {
    s.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or_else(|| s.trim()).to_string()
}

/// Resolve which agent a node runs under.
fn agent_for(task: &LoopTask, opts: &RunOpts) -> String {
    task.agent_kind
        .clone()
        .filter(|a| !a.is_empty())
        .unwrap_or_else(|| opts.agent.clone())
}

/// Pick the provider a node actually runs under, tolerating an assigned agent
/// that isn't installed here (no binary on PATH, lapsed subscription). The
/// board may assign `cursor` on a box where only `claude` is set up; rather than
/// fail the task we substitute an installed agent so the work still gets done.
///
/// Order: (1) the assigned agent, if available; (2) the run's default agent, if
/// different and available; (3) any installed agent in registry priority order.
/// Only when *nothing* is installed do we fail — with a message that names what
/// was asked for. Returns the chosen provider plus an optional plain-language
/// note (present only when a substitution happened) for the human log.
fn resolve_provider(
    requested: &str,
    opts: &RunOpts,
) -> Result<(Arc<dyn AgentProvider>, Option<String>), String> {
    let reg = registry();

    // 1. The assigned agent, if it's installed.
    if let Some(p) = reg.get(requested) {
        if p.is_available() {
            return Ok((p, None));
        }
    }

    let substituted = |p: Arc<dyn AgentProvider>| {
        let note = format!(
            "'{requested}' isn't available here — ran with '{}' instead",
            p.id()
        );
        Ok((p, Some(note)))
    };

    // 2. The run's default agent, if it differs and is installed.
    if opts.agent != requested {
        if let Some(p) = reg.get(&opts.agent) {
            if p.is_available() {
                return substituted(p);
            }
        }
    }

    // 3. Any installed agent, in registry priority order (claude, gemini, …).
    if let Some(p) = reg.iter().find(|p| p.is_available()).cloned() {
        return substituted(p);
    }

    // 4. Nothing is installed at all — now it's a real failure.
    Err(format!(
        "no coding agent is installed (looked for '{requested}'); install one of: claude, codex, gemini, cursor"
    ))
}

/// Name the agent a failure should be pinned on.
///
/// When one agent stands in for another (see [`resolve_provider`]), blaming the
/// *requested* one sends whoever reads the log off to debug a binary that was
/// never executed. The runner box did exactly that: it logged "'codex' isn't
/// available here — ran with 'claude' instead" and then, one line later,
/// "failed agent 'codex' exited 1: Not logged in" — while codex was not
/// installed and claude was the one that wasn't signed in.
///
/// Both names matter, so both are printed: the one that ran, and the one whose
/// work it took on.
fn who_ran(requested: &str, ran_as: &str) -> String {
    if requested == ran_as {
        format!("agent '{ran_as}'")
    } else {
        format!("agent '{ran_as}' (standing in for '{requested}')")
    }
}

/// The harness: spawn a coding agent for one node in `work_dir` (the repo
/// itself in sequential mode, or a throwaway worktree under `--jobs`), capture
/// its output, run the acceptance gate, and classify the result. On a failed
/// gate with `--rollback`, the node's commit is reverted in place.
fn dispatch(work_dir: &Path, task: &LoopTask, opts: &RunOpts) -> Outcome {
    let mut agent_id = agent_for(task, opts);
    // The native "aura" manager isn't a CLI provider; fall back to the
    // default coding agent for it so a node tagged `aura` still runs.
    if agent_id == "aura" || agent_id == "aura-manager" {
        agent_id = opts.agent.clone();
    }

    // The assigned agent may not be installed on this machine (no binary, no
    // subscription). Rather than fail the node, fall back to whatever coding
    // agent IS available — the task still gets done by someone.
    let provider = match resolve_provider(&agent_id, opts) {
        Ok((p, note)) => {
            if let Some(n) = note {
                if !opts.json {
                    eprintln!("  {} {}", "↪".yellow(), n.dimmed());
                }
            }
            p
        }
        Err(reason) => return Outcome::Failed { reason },
    };
    // Who actually runs, which is not always who was asked for. Everything
    // reported from here down must name this one — see the failure below.
    let ran_as = provider.id().to_string();

    let prompt = build_prompt(task);
    let invocation = match provider.build_invocation(&InvokeRequest {
        prompt: &prompt,
        mode: InvokeMode::OneShot,
        resume_session_id: None,
        attachments_via_stdin: false,
        effort: None,
        fast: false,
        model: None,
        approval: None,
    }) {
        Ok(i) => i,
        Err(e) => {
            return Outcome::Failed {
                reason: format!("build invocation failed: {e}"),
            };
        }
    };

    let before = head_sha(work_dir);
    // Snapshot what's already dirty/ignored BEFORE the agent runs, so the #1
    // stranded-output guard credits the agent only with paths it actually
    // touched — never pre-existing dirt from a shared working tree (#2).
    let stranded_baseline = loop_stranded::baseline(work_dir);

    let mut cmd = Command::new(&invocation.bin);
    cmd.args(&invocation.args)
        .current_dir(work_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (k, v) in &invocation.env {
        cmd.env(k, v);
    }
    // Let any sub-dispatch the agent does link back to this node, and keep
    // the agent out of an inherited Manager session.
    cmd.env("AURA_LOOP_TASK_ID", &task.id);
    cmd.env_remove("AURA_MANAGER_SESSION_ID");

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            return Outcome::Failed {
                reason: format!("spawn {} failed: {e}", invocation.bin),
            };
        }
    };

    // Stream stdout to our stderr (the human log channel) so a watching
    // human sees progress without polluting the --json stdout. Under `--jobs`
    // several workers stream at once, so each line is tagged `[<short_id>] ` —
    // the whole tagged line is written in ONE `write_all` (the process-global
    // stderr lock makes that atomic), so concurrent workers never interleave
    // mid-line and the desktop can demux each agent's output back to its lane.
    // Keep a bounded tail of the agent's stdout. Many CLIs (Claude included)
    // print their real failure to stdout, not stderr; in --json mode we don't
    // echo stdout at all, so without this a non-zero exit is reported as a bare
    // "exited 1" with no cause. The ring is capped so a chatty agent can't grow
    // it without bound.
    let mut stdout_tail: Vec<String> = Vec::new();
    const STDOUT_TAIL_MAX: usize = 8;
    if let Some(out) = child.stdout.take() {
        let mut reader = BufReader::new(out);
        let mut line = String::new();
        let prefix = if opts.jobs > 1 {
            Some(format!("[{}] ", task.short_id()))
        } else {
            None
        };
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) => break,
                Ok(_) => {
                    let trimmed = line.trim_end();
                    if !trimmed.is_empty() {
                        stdout_tail.push(trimmed.to_string());
                        if stdout_tail.len() > STDOUT_TAIL_MAX {
                            let overflow = stdout_tail.len() - STDOUT_TAIL_MAX;
                            stdout_tail.drain(0..overflow);
                        }
                    }
                    if !opts.json {
                        let buf = match &prefix {
                            Some(p) => format!("{p}{line}"),
                            None => line.clone(),
                        };
                        let _ = std::io::stderr().write_all(buf.as_bytes());
                        let _ = std::io::stderr().flush();
                    }
                }
                Err(_) => break,
            }
        }
    }
    let mut stderr_buf = String::new();
    if let Some(mut err) = child.stderr.take() {
        let _ = err.read_to_string(&mut stderr_buf);
    }

    let exit = child.wait().ok().and_then(|s| s.code()).unwrap_or(1);
    if exit != 0 {
        let mut tail = stderr_buf.lines().rev().take(3).collect::<Vec<_>>();
        tail.reverse();
        // Prefer stderr; fall back to the stdout tail when stderr is silent so
        // the failure carries the real cause (e.g. an auth/login error the
        // agent printed to stdout) instead of a bare "exited N".
        let detail = if !tail.is_empty() {
            format!(": {}", tail.join(" | "))
        } else if !stdout_tail.is_empty() {
            let start = stdout_tail.len().saturating_sub(3);
            format!(": {}", stdout_tail[start..].join(" | "))
        } else {
            String::new()
        };
        // If the agent committed something before it died, --rollback undoes it
        // so a half-finished change never lingers on the branch.
        if opts.rollback {
            if let Some(b) = &before {
                let _ = loop_accept::rollback(work_dir, b);
            }
        }
        return Outcome::Failed {
            reason: format!("{} exited {exit}{detail}", who_ran(&agent_id, &ran_as)),
        };
    }

    // What commit did the agent produce (if any)?
    let mut after = head_sha(work_dir);
    let mut commit = match (&before, &after) {
        (b, Some(a)) if b.as_deref() != Some(a.as_str()) => Some(a.clone()),
        _ => None,
    };

    // #0 — forgot-to-stage rescue. The most common "stranded output" is benign:
    // the agent wrote real, git-trackable source then ran `git commit` without
    // `git add` (or `git commit -am`, which skips NEW files). That work belongs
    // in the commit — carry it before the strand guard so a forgotten stage
    // becomes a clean success instead of a failed node. Genuinely *ignored*-path
    // source is left for the guard below (the ignore is intentional).
    let rescued = loop_stranded::rescue_uncommitted_source(work_dir, &stranded_baseline);
    if !rescued.is_empty() {
        if !opts.json {
            eprintln!(
                "  {} carried {} file(s) the agent left unstaged into the commit",
                "↪".yellow(),
                rescued.len()
            );
        }
        after = head_sha(work_dir);
        commit = match (&before, &after) {
            (b, Some(a)) if b.as_deref() != Some(a.as_str()) => Some(a.clone()),
            _ => commit,
        };
    }

    // #1 — gitignore-output blindness. The commit only captures git-tracked
    // files; an agent that wrote a real source file into a gitignored path (a
    // whole gitignored subproject, say) leaves it OUT of the commit, so a naive
    // "completed" would ship a commit missing its core files — and in worktree
    // mode the worktree's discard would delete that file with no git trace.
    // Scan for such stranded output, snapshot it to the MAIN repo (durable,
    // survives a worktree teardown), and refuse to claim a clean success when
    // source landed in a path git can't track.
    match loop_stranded::guard(repo_root_of(work_dir), work_dir, &stranded_baseline) {
        loop_stranded::Verdict::Clean => {}
        loop_stranded::Verdict::Stranded { reason } => {
            // The agent's committed work is broken-by-omission; fail honestly.
            // The recovery snapshots were already written by `guard`, so the
            // file content is recoverable even after a worktree discard.
            if opts.rollback {
                if let Some(b) = &before {
                    let _ = loop_accept::rollback(work_dir, b);
                }
            }
            return Outcome::Failed { reason };
        }
    }

    // Acceptance gate: the optional verify command AND the free goal proof.
    // A non-zero verify, or a proof that says nothing the goal needs was built
    // ("not wired"), fails the node — except for non-code nodes, whose
    // build-proof can't judge them (#4). Absence of a goal never blocks. On a
    // failed gate, --rollback reverts the commit so the branch stays green; the
    // reason line is worded for what actually happens (#5).
    let head_for_proof = after.as_deref().or(before.as_deref()).unwrap_or("HEAD");
    let proof_blocks = loop_accept::build_proof_blocks(&task.task_kind, &task.tags);
    // Record the proof into the durable MAIN repo (not this throwaway worktree,
    // whose `.aura/goals.jsonl` is discarded), keyed to THIS node's own goal —
    // so the commit lands with a real verdict instead of "Not checked".
    let ledger_root = repo_root_of(work_dir);
    let acc = loop_accept::check(
        work_dir,
        &ledger_root,
        head_for_proof,
        opts.verify.as_deref(),
        task.board_task_id.as_deref(),
        &task.title,
        proof_blocks,
        opts.rollback,
    );
    if !acc.passed {
        if opts.rollback {
            if let Some(b) = &before {
                let _ = loop_accept::rollback(work_dir, b);
            }
        }
        return Outcome::Failed { reason: acc.reason };
    }
    Outcome::Completed { commit }
}

/// The main repo root for `work_dir`. In sequential mode `work_dir` IS the repo
/// root; under `--jobs` it's a throwaway worktree, and `git rev-parse
/// --path-format=absolute --git-common-dir` points at the shared `.git`, whose
/// parent is the real repo. Recovery snapshots must land there, not in the
/// worktree that's about to be discarded. Falls back to `work_dir` itself.
fn repo_root_of(work_dir: &Path) -> std::path::PathBuf {
    let out = Command::new("git")
        .args(["rev-parse", "--path-format=absolute", "--git-common-dir"])
        .current_dir(work_dir)
        .output();
    if let Ok(o) = out {
        if o.status.success() {
            let common = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if !common.is_empty() {
                let p = Path::new(&common);
                // `<repo>/.git` → `<repo>`; a bare/worktree `.git` dir → its parent.
                if let Some(parent) = p.parent() {
                    return parent.to_path_buf();
                }
            }
        }
    }
    work_dir.to_path_buf()
}

/// Build the agent prompt from a node's title, spec, and acceptance.
fn build_prompt(task: &LoopTask) -> String {
    let mut p = String::new();
    p.push_str(
        "You are an autonomous coding agent working one task from the Aura Loop dependency graph.\n\n",
    );
    p.push_str(&format!("TASK: {}\n", task.title));
    if !task.input.is_empty() && task.input != task.title {
        p.push_str(&format!("\nSPEC:\n{}\n", task.input));
    }
    if let Some(ac) = &task.acceptance_criteria {
        if !ac.is_empty() {
            p.push_str(&format!(
                "\nACCEPTANCE CRITERIA — your work must satisfy all of these:\n{ac}\n"
            ));
        }
    }
    p.push_str(
        "\nWork autonomously to completion. When a choice arises, pick the most reasonable \
         option and proceed — don't stall or ask for confirmation. Touch only what this task \
         needs; make no unrelated or destructive changes. Before declaring done, verify the \
         work: confirm it compiles and the acceptance criteria are actually met — don't claim \
         success you haven't checked. Then COMMIT your changes with a clear message. If you \
         hit a true blocker and cannot finish, stop and report exactly what failed and why.\n",
    );
    p
}

/// Current `git HEAD` sha (full), or None outside a repo / on error.
fn head_sha(repo_root: &Path) -> Option<String> {
    let out = Command::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(repo_root)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() { None } else { Some(s) }
}

/// Stable-per-process runner identity used as the lease holder.
fn runner_id() -> String {
    let user = std::env::var("USER").unwrap_or_else(|_| "anon".to_string());
    format!("loop-{user}-{}", std::process::id())
}

/// Indent a block for nested display under a node.
fn indent(s: &str) -> String {
    s.lines()
        .map(|l| format!("    {}", l.dimmed()))
        .collect::<Vec<_>>()
        .join("\n")
}

// ── Seed ───────────────────────────────────────────────────────────────

/// Seed the graph from a plan file — each "Wave N" section becomes a node,
/// and waves chain via dependency edges so the runner executes them in
/// order. Returns the ids minted.
pub fn seed_from_plan(
    repo_root: &Path,
    plan_path: &Path,
    agent: &str,
) -> Result<Vec<String>, Box<dyn std::error::Error>> {
    let text = std::fs::read_to_string(plan_path)
        .map_err(|e| format!("cannot read plan {}: {e}", plan_path.display()))?;
    let waves = parse_waves(&text);
    if waves.is_empty() {
        return Err(format!(
            "no waves found in {} — expected sections like `## Wave 1 — …` or `**Wave 1 …**`. \
             Use `aura loop add <title>` to mint nodes directly.",
            plan_path.display()
        )
        .into());
    }

    let graph = LoopGraph::at(repo_root);
    let mut ids = Vec::new();
    let mut prev: Option<String> = None;
    for (title, body) in waves {
        let deps = prev.iter().cloned().collect::<Vec<_>>();
        let task = graph.create(
            title.clone(),
            body,
            "medium".to_string(),
            aura_loop::KIND_WAVE.to_string(),
            deps,
            None,
            Some(agent.to_string()),
            vec!["seed".to_string()],
        )?;
        prev = Some(task.id.clone());
        ids.push(task.id);
    }
    Ok(ids)
}

/// Split plan text into (heading, body) pairs at each wave heading. A wave
/// heading is a line containing `Wave <n>` optionally wrapped in `#`/`*`.
fn parse_waves(text: &str) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    let mut cur: Option<(String, Vec<String>)> = None;
    for line in text.lines() {
        if is_wave_heading(line) {
            if let Some((h, body)) = cur.take() {
                out.push((h, body.join("\n").trim().to_string()));
            }
            cur = Some((clean_heading(line), Vec::new()));
        } else if let Some((_, body)) = cur.as_mut() {
            body.push(line.to_string());
        }
    }
    if let Some((h, body)) = cur.take() {
        out.push((h, body.join("\n").trim().to_string()));
    }
    out
}

fn is_wave_heading(line: &str) -> bool {
    let t = line.trim_start_matches(['#', '*', ' ', '-']);
    let lower = t.to_ascii_lowercase();
    if !lower.starts_with("wave ") {
        return false;
    }
    // The char after "wave " must start an identifier (digit/letter) so we
    // don't catch prose like "wave of changes".
    lower[5..].chars().next().map(|c| c.is_alphanumeric()).unwrap_or(false)
}

fn clean_heading(line: &str) -> String {
    let cleaned = line
        .trim()
        .trim_matches(|c| c == '#' || c == '*' || c == ' ')
        .trim_end_matches('.')
        .trim();
    // Collapse to a single line, cap length so titles stay tidy.
    let one = cleaned.replace('\n', " ");
    if one.len() > 120 {
        format!("{}…", crate::text::clip(&one, 119))
    } else {
        one
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_markdown_waves() {
        let plan = "intro\n\n**Wave 1 — Scaffold.** do the thing\nmore\n\n## Wave 2 — Lift\nbody two\n";
        let waves = parse_waves(plan);
        assert_eq!(waves.len(), 2);
        assert!(waves[0].0.starts_with("Wave 1"));
        assert!(waves[0].1.contains("more"));
        assert!(waves[1].0.starts_with("Wave 2"));
    }

    #[test]
    fn ignores_wave_in_prose() {
        assert!(!is_wave_heading("a wave of refactors swept in"));
        assert!(is_wave_heading("## Wave 3 — Responsive"));
        assert!(is_wave_heading("**Wave 10 final**"));
    }

    #[test]
    fn empty_plan_yields_no_waves() {
        assert!(parse_waves("just prose\nno headings here").is_empty());
    }

    /// The runner box printed "'codex' isn't available here — ran with 'claude'
    /// instead" and then "failed agent 'codex' exited 1: Not logged in". Codex
    /// was not installed; claude was the one lacking a login. A failure has to
    /// name the process that produced it.
    #[test]
    fn a_stand_in_failure_names_the_agent_that_actually_ran() {
        let msg = who_ran("codex", "claude");
        assert!(msg.contains("'claude'"), "the one that ran: {msg}");
        assert!(msg.contains("'codex'"), "and the one it stood in for: {msg}");
        assert!(
            msg.find("'claude'") < msg.find("'codex'"),
            "the agent that ran is the subject: {msg}"
        );
    }

    /// No substitution, no parenthetical — the ordinary case stays short.
    #[test]
    fn an_agent_that_ran_as_asked_is_named_once() {
        assert_eq!(who_ran("claude", "claude"), "agent 'claude'");
    }
}
