//! CLI glue for `aura radar` — `emit` (announce) and `show` (feed). Kept thin:
//! parsing + delegation to [`emit`]/[`store`]/[`relevance`]/[`render`]. The
//! same core backs the MCP tools `aura_team_radar` / `aura_activity_emit`.

use colored::Colorize;

use std::path::Path;

use super::model::{AwarenessEvent, AwarenessKind};
use super::{agent_hook, api, broadcast, conflict, emit, identity, policy, relevance, render, store};
use crate::live_events;

/// `aura radar emit` — announce what a human or agent is building.
#[allow(clippy::too_many_arguments)]
pub fn run_emit(
    kind: &str,
    file: Option<&str>,
    symbol: Option<&str>,
    intent: Option<&str>,
    impact: Option<&str>,
    agent: Option<&str>,
    json: bool,
) {
    let Some(k) = AwarenessKind::parse(kind) else {
        eprintln!(
            "{} unknown kind '{}' — use: started|editing|intent|impact|zone|paused|abandoned|committed",
            "✗".red(),
            kind
        );
        return;
    };

    // Auto-fill the blast-radius when the caller didn't state one: an agent
    // announcing "editing removeNote" gets a real, checkpoint-derived ripple
    // ("affects listNotes, getNote") instead of a blank field — computed from
    // the reverse callgraph with zero AI tokens. Only when we have both a file
    // and a symbol to seed the walk; the explicit `--impact` always wins.
    let impact_owned: Option<String> = match (impact, file, symbol) {
        (Some(i), _, _) => Some(i.to_string()),
        (None, Some(f), Some(s)) => auto_impact(f, s),
        _ => None,
    };

    let ev = emit::emit(emit::EmitInput {
        kind: k,
        file: file.map(String::from),
        symbol: symbol.map(String::from),
        intent: intent.map(String::from),
        impact: impact_owned,
        agent: agent.map(String::from),
    });

    if json {
        println!("{}", serde_json::to_string(&ev).unwrap_or_default());
        return;
    }

    let who = if ev.is_agent {
        ev.actor.magenta()
    } else {
        ev.actor.cyan()
    };
    let signed = if ev.sig.is_some() {
        " 🔏 signed".green().to_string()
    } else {
        String::new()
    };
    println!(
        "{} {} by {}{}",
        "✦ emitted".green(),
        ev.kind.as_str().bold(),
        who,
        signed
    );
}

/// Compute a blast-radius one-liner for an emit that carried a `--symbol` but no
/// `--impact`. Reuses the checkpoint-backed reverse-callgraph engine that powers
/// `aura change-note` and the delete-guard — token-free, time-bounded, never
/// panics. Returns `None` when there's nothing worth saying so the field stays
/// empty rather than noisy.
fn auto_impact(file: &str, symbol: &str) -> Option<String> {
    let repo_root = crate::validate_tool::resolve_repo_root(None);
    // The graph keys on repo-relative paths; fold an absolute one back down.
    let rel = {
        let p = Path::new(file);
        if p.is_absolute() {
            p.strip_prefix(&repo_root)
                .map(|r| r.to_string_lossy().to_string())
                .unwrap_or_else(|_| file.to_string())
        } else {
            file.to_string()
        }
    };
    let (impacts, _src) =
        crate::impact::analyze_changes(&repo_root, &[(rel, vec![symbol.to_string()])]);
    summarize_impact(&impacts.into_iter().next()?)
}

/// Turn a [`crate::impact::FileImpact`] into the same "where it affects" phrasing
/// `change-note` uses: user-facing features first, else a dependent count, else
/// an honest "nothing else calls it".
fn summarize_impact(fi: &crate::impact::FileImpact) -> Option<String> {
    if !fi.features.is_empty() {
        let names: Vec<String> = fi.features.iter().take(2).map(|f| f.name.clone()).collect();
        let more = fi.features.len().saturating_sub(names.len());
        let tail = if more > 0 {
            format!(", +{more} more")
        } else {
            String::new()
        };
        let joined = match names.as_slice() {
            [a] => a.clone(),
            [a, b] => format!("{a} and {b}"),
            _ => names.join(", "),
        };
        return Some(format!("affects {joined}{tail}"));
    }
    if fi.transitive_caller_count > 0 {
        let n = fi.transitive_caller_count;
        // A tripped graph-walk budget makes the count a floor, not an exact.
        let floor = if fi.truncated { "+" } else { "" };
        return Some(format!(
            "{n}{floor} dependent{} to re-check",
            if n == 1 { "" } else { "s" }
        ));
    }
    if fi.leaf {
        return Some("nothing else calls it".to_string());
    }
    None
}

/// `aura radar` / `aura radar show` — print the team awareness feed.
pub fn run_show(focus: Option<&str>, limit: usize, json: bool) {
    if json {
        println!("{}", api::radar(focus, limit, None));
        return;
    }

    // Best-effort throttled pull, then the merged local+remote feed (AURA-15).
    let _ = broadcast::pull_remote(false);
    let all = broadcast::merged_events();
    let mut rows: Vec<&AwarenessEvent> = relevance::filter(&all, focus);
    rows.sort_by(|a, b| b.ts.cmp(&a.ts));
    rows.truncate(limit);

    // The ambient feed shows everyone; the banner only fires when something
    // genuinely touches the caller's own work.
    let my_focus = conflict::focus_from_repo(None);
    let collisions =
        conflict::detect(&my_focus, &all, live_events::now_ms(), api::CONFLICT_WINDOW_MS);
    render::print_feed(&rows, focus, &collisions);
}

/// `aura radar conflicts` — the reasoned layer: only genuine/possible collisions
/// against *your* current focus (dirty files + announced symbols). Quiet by
/// design; empty output is the common, healthy case.
pub fn run_conflicts(as_actor: Option<&str>, all_severities: bool, json: bool) {
    if json {
        println!("{}", api::conflicts(as_actor, all_severities));
        return;
    }

    let _ = broadcast::pull_remote(false);
    let events = broadcast::merged_events();
    // Ripple edges cost a full checkpoint-store read — only build them when the
    // Possible tier is actually going to be shown.
    let my_focus = conflict::focus_from_repo_opts(as_actor, all_severities);
    let mut collisions =
        conflict::detect(&my_focus, &events, live_events::now_ms(), api::CONFLICT_WINDOW_MS);
    if !all_severities {
        collisions.retain(|c| c.severity != conflict::Severity::Possible);
    }
    render::print_conflicts(&collisions);
}

/// `aura radar privacy [LEVEL]` — show or set the repo's broadcast policy
/// (AURA-15). No argument prints the current dial plus every level; with an
/// argument the policy is persisted to `.aura/privacy.json`.
pub fn run_privacy(level: Option<&str>, json: bool) {
    let Some(token) = level else {
        let current = policy::load();
        if json {
            println!(
                "{}",
                serde_json::json!({
                    "share": current.as_str(),
                    "description": current.describe(),
                    "allows_broadcast": current.allows_broadcast(),
                    "allows_code_sync": current.allows_code_sync(),
                })
            );
            return;
        }
        println!("  {}", "🔒 Broadcast privacy".bold());
        println!(
            "  {}",
            "──────────────────────────────────────────────────────────".dimmed()
        );
        for p in [
            policy::SharePolicy::Off,
            policy::SharePolicy::IntentOnly,
            policy::SharePolicy::Symbols,
            policy::SharePolicy::Diffs,
        ] {
            let marker = if p == current { "●".green() } else { "○".dimmed() };
            println!("  {} {:<12} {}", marker, p.as_str().bold(), p.describe().dimmed());
        }
        println!();
        println!(
            "  {} `aura radar privacy <off|intent-only|symbols|diffs>` to change",
            "→".blue()
        );
        return;
    };

    let Some(p) = policy::SharePolicy::parse(token) else {
        eprintln!(
            "{} unknown privacy level '{}' — use: off|intent-only|symbols|diffs",
            "✗".red(),
            token
        );
        return;
    };
    if let Err(e) = policy::save(p) {
        eprintln!("{} could not write .aura/privacy.json: {e}", "✗".red());
        return;
    }
    if json {
        println!(
            "{}",
            serde_json::json!({ "ok": true, "share": p.as_str(), "description": p.describe() })
        );
        return;
    }
    println!("{} privacy set to {} — {}", "✓".green(), p.as_str().bold(), p.describe());
    match p {
        policy::SharePolicy::Diffs => println!(
            "  {} Live function-body sync (`aura_live_sync_push`) is now allowed.",
            "↳".dimmed()
        ),
        policy::SharePolicy::Off => println!(
            "  {} This repo is fully dark — it neither pushes nor pulls awareness events.",
            "↳".dimmed()
        ),
        _ => println!(
            "  {} Live function-body (code) sync stays blocked below `diffs`.",
            "↳".dimmed()
        ),
    }
}

/// `aura radar sync` — force one push + pull round through the active
/// transport. Also what `maybe_spawn_sync` runs detached after each emit.
pub fn run_sync(json: bool, quiet: bool) {
    let pushed = broadcast::push_pending(true);
    let pulled = broadcast::pull_remote(true);

    if quiet {
        return;
    }
    if json {
        println!(
            "{}",
            serde_json::json!({
                "pushed": pushed.as_ref().copied().unwrap_or(0),
                "pulled": pulled.as_ref().copied().unwrap_or(0),
                "push_error": pushed.as_ref().err(),
                "pull_error": pulled.as_ref().err(),
            })
        );
        return;
    }
    match &pushed {
        Ok(n) => println!("{} pushed {} event{}", "✓".green(), n, if *n == 1 { "" } else { "s" }),
        Err(e) => eprintln!("{} push failed: {e}", "✗".red()),
    }
    match &pulled {
        Ok(n) => println!("{} pulled {} event{}", "✓".green(), n, if *n == 1 { "" } else { "s" }),
        Err(e) => eprintln!("{} pull failed: {e}", "✗".red()),
    }
    if !policy::load().allows_broadcast() {
        println!(
            "  {} policy is `off` — nothing crosses the wire. `aura radar privacy` to change.",
            "↳".dimmed()
        );
    }
}

/// `aura radar wire` — wire `aura validate-tool` into Claude Code's PreToolUse
/// hook so the radar gets live `editing` events (and the destructive-op gate)
/// with zero MCP. `--undo` strips it. This is the live half of the radar; git
/// hooks (`aura enable`) already cover the `committed` half.
pub fn run_wire(undo: bool, quiet: bool) {
    let dir = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));

    if undo {
        match agent_hook::remove(&dir) {
            Ok(true) if !quiet => println!(
                "{} Removed Aura's Claude Code PreToolUse hook.",
                "✓".green()
            ),
            Ok(false) if !quiet => println!(
                "{} No Aura PreToolUse hook was wired here — nothing to remove.",
                "ℹ".blue()
            ),
            Err(e) => eprintln!("{} could not edit .claude/settings.json: {e}", "✗".red()),
            _ => {}
        }
        return;
    }

    match agent_hook::ensure(&dir) {
        Ok(outcome) => {
            if quiet {
                return;
            }
            match outcome {
                agent_hook::Outcome::Installed => {
                    println!(
                        "{} Team Radar wired into Claude Code — edits now emit live `editing` events (no MCP).",
                        "✓".green()
                    );
                    println!(
                        "    {} {}",
                        "PreToolUse →".dimmed(),
                        "aura validate-tool".dimmed()
                    );
                }
                agent_hook::Outcome::Updated => println!(
                    "{} Refreshed Aura's Claude Code PreToolUse hook (tool set widened).",
                    "✓".green()
                ),
                agent_hook::Outcome::AlreadyPresent => println!(
                    "{} Team Radar already wired into Claude Code — nothing to do.",
                    "✓".green()
                ),
            }
        }
        Err(e) => eprintln!("{} could not edit .claude/settings.json: {e}", "✗".red()),
    }
}

/// The three legs that make the awareness plane run with ZERO MCP, plus a
/// snapshot of how much signal is flowing. Each leg is independently checkable
/// so `status` can name exactly what's missing and how to fix it.
struct Readiness {
    /// `.aura/awareness/identity.key` — without it events are unsigned.
    signing_key: Option<String>,
    /// Git pre-commit hook installed → `committed` events fire on commit.
    git_hooks: bool,
    /// Claude Code PreToolUse wired → live `editing` events fire on edit.
    pretooluse: bool,
    /// How many events are currently on the local radar.
    event_count: usize,
    /// How many peers' events the remote cache holds (AURA-15 broadcast).
    remote_count: usize,
    /// The repo's broadcast privacy dial.
    privacy: policy::SharePolicy,
}

/// Resolve the real `pre-commit` hook path, honouring git worktrees (where
/// `.git` is a file pointing at a shared common dir) and `core.hooksPath`.
/// Falls back to the naive `<dir>/.git/hooks/pre-commit` if git isn't callable.
fn pre_commit_hook_path(dir: &Path) -> std::path::PathBuf {
    let out = std::process::Command::new("git")
        .args(["rev-parse", "--git-path", "hooks/pre-commit"])
        .current_dir(dir)
        .output();
    if let Ok(o) = out {
        if o.status.success() {
            let p = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if !p.is_empty() {
                let pb = std::path::PathBuf::from(&p);
                return if pb.is_absolute() { pb } else { dir.join(pb) };
            }
        }
    }
    dir.join(".git").join("hooks").join("pre-commit")
}

fn gather_readiness(dir: &Path) -> Readiness {
    // The git pre-commit hook is "ours" if it shells our capture-context step.
    let git_hooks = std::fs::read_to_string(pre_commit_hook_path(dir))
        .map(|s| s.contains("capture-context"))
        .unwrap_or(false);

    Readiness {
        signing_key: identity::key_id(),
        git_hooks,
        pretooluse: agent_hook::is_wired(dir),
        event_count: store::read_all().len(),
        remote_count: broadcast::read_remote().len(),
        privacy: policy::load(),
    }
}

/// `aura radar status` — report whether the awareness plane is live without MCP:
/// signing identity, git hooks (`committed`), Claude Code PreToolUse (`editing`),
/// and current event volume. Names the fix for any missing leg.
pub fn run_status(json: bool) {
    let dir = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
    let r = gather_readiness(&dir);

    if json {
        let out = serde_json::json!({
            "signing_key": r.signing_key,
            "git_hooks": r.git_hooks,
            "pretooluse": r.pretooluse,
            "event_count": r.event_count,
            "remote_count": r.remote_count,
            "privacy": r.privacy.as_str(),
            "ready_without_mcp": r.git_hooks && r.pretooluse,
        });
        println!("{}", out);
        return;
    }

    let mark = |ok: bool| if ok { "✓".green() } else { "✗".red() };

    println!("  {}   {}", "🛰  Awareness readiness".bold(), "(no MCP required)".dimmed());
    println!(
        "  {}",
        "──────────────────────────────────────────────────────────".dimmed()
    );

    match &r.signing_key {
        Some(kid) => println!("  {} signing identity   {}", mark(true), kid.dimmed()),
        None => {
            println!("  {} signing identity   {}", mark(false), "events would be unsigned".dimmed());
            println!("      {} emit once (e.g. `aura radar emit editing`) to mint a key", "↳".dimmed());
        }
    }

    if r.git_hooks {
        println!("  {} git hooks          {}", mark(true), "`committed` events fire on commit".dimmed());
    } else {
        println!("  {} git hooks          {}", mark(false), "no `committed` events".dimmed());
        println!("      {} run `aura enable`", "↳".dimmed());
    }

    if r.pretooluse {
        println!("  {} Claude PreToolUse  {}", mark(true), "live `editing` events fire on edit".dimmed());
    } else {
        println!("  {} Claude PreToolUse  {}", mark(false), "no live `editing` events".dimmed());
        println!("      {} run `aura radar wire`", "↳".dimmed());
    }

    println!(
        "  {} radar events       {} local · {} from teammates",
        mark(r.event_count > 0),
        r.event_count.to_string().bold(),
        r.remote_count.to_string().bold()
    );

    println!(
        "  {} privacy            {} — {}",
        if r.privacy.allows_broadcast() { "✓".green() } else { "●".yellow() },
        r.privacy.as_str().bold(),
        r.privacy.describe().dimmed()
    );

    println!();
    if r.git_hooks && r.pretooluse {
        println!("  {} Awareness plane is live without MCP.", "✓".green());
    } else {
        println!(
            "  {} Run the suggested command(s) above to complete the no-MCP setup.",
            "→".blue()
        );
    }
}
