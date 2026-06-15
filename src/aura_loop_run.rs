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
use std::time::Duration;

use aura_agents::{InvokeMode, InvokeRequest, registry};
use colored::Colorize;

use aura_loop::{self, LoopGraph, LoopTask};

use crate::loop_accept;
use crate::loop_worktree::{self, LoopWorktree};

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
        let ready = aura_loop::ready_set(&graph.list());
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
        } else if ready.is_empty() {
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
        return Ok(());
    }

    let runner = runner_id();
    if !opts.json {
        eprintln!("{} runner {}", "▶".green().bold(), runner.dimmed());
    }

    // Parallel path: each ready node builds in its own throwaway git worktree,
    // and only work that passes the acceptance gate gets merged back. The
    // classic sequential loop below handles jobs <= 1 unchanged.
    if opts.jobs > 1 {
        return run_parallel(repo_root, opts, &graph, &runner);
    }

    let mut done = 0usize;
    let mut log: Vec<serde_json::Value> = Vec::new();

    loop {
        // 1. Recover any node whose runner died (expired lease).
        let reclaimed = graph.reclaim_stale();
        if !reclaimed.is_empty() && !opts.json {
            eprintln!("{} reclaimed {} stale node(s)", "↻".yellow(), reclaimed.len());
        }

        // 2. Take the highest-priority ready node.
        let Some(task) = aura_loop::ready_set(&graph.list()).into_iter().next() else {
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
                serde_json::json!({"id": claimed.id, "status": "completed", "commit": commit})
            }
            Outcome::Failed { reason } => {
                graph
                    .fail(&claimed.id, reason.clone())
                    .map_err(|e| -> Box<dyn std::error::Error> { e.into() })?;
                if !opts.json {
                    eprintln!("  {} {}", "✗ failed".red(), reason.dimmed());
                }
                serde_json::json!({"id": claimed.id, "status": "failed", "error": reason})
            }
        };
        log.push(entry);
        done += 1;
        if opts.max > 0 && done >= opts.max {
            break;
        }
    }

    if opts.json {
        println!("{}", serde_json::to_string(&log)?);
    } else {
        eprintln!("{} {} node(s) processed", "■".green().bold(), done);
    }
    Ok(())
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
) -> Result<(), Box<dyn std::error::Error>> {
    if !opts.json {
        eprintln!("{} up to {} in parallel (worktrees)", "⥂".cyan().bold(), opts.jobs);
    }

    let (tx, rx) = mpsc::channel::<WorkerResult>();
    let mut in_flight = 0usize;
    let mut done = 0usize;
    let mut log: Vec<serde_json::Value> = Vec::new();

    loop {
        // Top up the pool with ready nodes, unless we've already scheduled
        // enough to reach `max`. Worktrees are created HERE, on the main
        // thread, so concurrent `git worktree add` never races the index lock.
        let hit_max = opts.max > 0 && (done + in_flight) >= opts.max;
        if !hit_max {
            while in_flight < opts.jobs && !(opts.max > 0 && (done + in_flight) >= opts.max) {
                let reclaimed = graph.reclaim_stale();
                if !reclaimed.is_empty() && !opts.json {
                    eprintln!("{} reclaimed {} stale node(s)", "↻".yellow(), reclaimed.len());
                }

                // A node still claimed/working (one we just dispatched) is no
                // longer ready, so this never re-hands the same node out.
                let Some(task) = aura_loop::ready_set(&graph.list()).into_iter().next() else {
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
                std::thread::spawn(move || {
                    // The worker only ever touches its own worktree dir — never
                    // the repo index — so this is safe to run off the main thread.
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
        let entry = finish_worker(repo_root, opts, graph, res)?;
        log.push(entry);
        done += 1;
    }

    if opts.json {
        println!("{}", serde_json::to_string(&log)?);
    } else {
        eprintln!("{} {} node(s) processed", "■".green().bold(), done);
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
) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
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
                    Ok(serde_json::json!({"id": task.id, "status": "completed", "commit": commit}))
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
                    Ok(serde_json::json!({"id": task.id, "status": "failed", "error": reason}))
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
            Ok(serde_json::json!({"id": task.id, "status": "failed", "error": reason}))
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

    let provider = match registry().get(&agent_id) {
        Some(p) => p,
        None => {
            return Outcome::Failed {
                reason: format!("unknown agent '{agent_id}' (have claude, gemini, codex, cursor)"),
            };
        }
    };
    if !provider.is_available() {
        return Outcome::Failed {
            reason: format!("agent '{agent_id}' binary not found in PATH"),
        };
    }

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
    // human sees progress without polluting the --json stdout.
    if let Some(out) = child.stdout.take() {
        let mut reader = BufReader::new(out);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) => break,
                Ok(_) => {
                    if !opts.json {
                        let _ = std::io::stderr().write_all(line.as_bytes());
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
        let tail = stderr_buf.lines().rev().take(3).collect::<Vec<_>>();
        let mut tail = tail;
        tail.reverse();
        let detail = if tail.is_empty() {
            String::new()
        } else {
            format!(": {}", tail.join(" | "))
        };
        // If the agent committed something before it died, --rollback undoes it
        // so a half-finished change never lingers on the branch.
        if opts.rollback {
            if let Some(b) = &before {
                let _ = loop_accept::rollback(work_dir, b);
            }
        }
        return Outcome::Failed {
            reason: format!("agent '{agent_id}' exited {exit}{detail}"),
        };
    }

    // What commit did the agent produce (if any)?
    let after = head_sha(work_dir);
    let commit = match (&before, &after) {
        (b, Some(a)) if b.as_deref() != Some(a.as_str()) => Some(a.clone()),
        _ => None,
    };

    // Acceptance gate: the optional verify command AND the free goal proof.
    // A non-zero verify, or a proof that says nothing the goal needs was built
    // ("not wired"), fails the node. Absence of a goal never blocks. On a failed
    // gate, --rollback reverts the commit so the branch stays green.
    let head_for_proof = after.as_deref().or(before.as_deref()).unwrap_or("HEAD");
    let acc = loop_accept::check(work_dir, head_for_proof, opts.verify.as_deref());
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
        "\nWork autonomously to completion. When the task is done, COMMIT your changes with a \
         clear message. Do not ask for confirmation or stop early.\n",
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
        format!("{}…", &one[..119])
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
}
