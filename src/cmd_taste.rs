// `aura taste` CLI surface.
//
// Phase 0:
//   status, observe (hidden)
// Phase 1:
//   list, mine, approve, reject, off, explain, sync-claude-md
//
// All subcommands operate on the repo discovered from `.` (so they
// work the same from a hook, a manager session, or a teammate's
// shell).

use clap::Subcommand;
use colored::Colorize;
use git2::Repository;
use std::path::{Path, PathBuf};

use crate::taste;
use crate::taste::aggregate::{Rule, RuleStatus};

#[derive(Subcommand)]
pub enum TasteSubcommands {
    /// Print observation counts grouped by template + language.
    Status {
        #[arg(long)]
        json: bool,
    },
    /// List distilled rules. Filter by status: active|provisional|candidate|deprecated.
    List {
        #[arg(long)]
        status: Option<String>,
        #[arg(long)]
        json: bool,
    },
    /// Re-aggregate observations into rules. Idempotent.
    Mine {
        #[arg(long)]
        json: bool,
    },
    /// Approve a rule by id — makes it `user_approved` and pins it
    /// into the CLAUDE.md taste block on next sync.
    Approve { id: String },
    /// Reject a rule — flips to deprecated and drops it from CLAUDE.md.
    Reject { id: String },
    /// Same as `reject`, but kept as a separate verb for chat UX
    /// ("/taste off rule_xxx" reads more naturally than "reject").
    Off { id: String },
    /// Show a single rule including its backing observations.
    Explain {
        id: String,
        #[arg(long)]
        json: bool,
    },
    /// Re-render the `## Project Taste` block inside CLAUDE.md.
    /// Idempotent — skips if already current.
    SyncClaudeMd {
        /// Force a re-write even if the rule set hasn't changed.
        #[arg(long)]
        force: bool,
    },
    /// Return rules scoped to a file path (for the Story-pane chip).
    /// Always JSON — this surface is consumed by the shell.
    Rules {
        /// File path to score (relative to repo root or absolute).
        #[arg(long)]
        file: String,
        /// Cap on returned rules; default 20.
        #[arg(long, default_value_t = 20)]
        limit: usize,
    },
    /// Check a commit's (or staged index's) diff for taste violations
    /// against active rules. Used by `aura pr-review` (Phase 2) and the
    /// strict-mode pre-commit hook (Phase 3). Exits non-zero when
    /// violations are present.
    Check {
        /// Commit ref to scan. Defaults to HEAD (the just-made commit).
        /// Ignored when --staged is set.
        #[arg(long, default_value = "HEAD")]
        r#ref: String,
        /// Scan the staged index (HEAD vs `git write-tree`) instead of a
        /// commit. Mirrors what the strict-mode pre-commit hook does.
        #[arg(long)]
        staged: bool,
        /// Confidence floor — rules with confidence below this are skipped.
        /// 0.70 catches active rules; raise to 0.85 for strict gating.
        #[arg(long, default_value_t = 0.70)]
        threshold: f64,
        #[arg(long)]
        json: bool,
    },
    /// Push the local rule set to the mothership so teammates can pull
    /// it. Stored as a `kind: taste_rules` entry in cloud project_memory.
    /// Phase 3 (v3) — opt-in. Requires `aura cloud login`.
    Push {
        /// Optional repo handle (org/name). Defaults to the git remote.
        #[arg(long)]
        repo_full_name: Option<String>,
        /// Only push active + provisional rules (the recommended default).
        /// Set --all to include candidates and deprecated.
        #[arg(long)]
        all: bool,
        #[arg(long)]
        json: bool,
    },
    /// Pull the team's rule set from the mothership and merge into
    /// `.aura/taste/rules.json`. Local `user_approved` decisions are
    /// preserved; conflicting rules pick the side with higher confidence.
    Pull {
        /// Optional repo handle (org/name). Defaults to the git remote.
        #[arg(long)]
        repo_full_name: Option<String>,
        /// Print the merge result but don't write to disk.
        #[arg(long)]
        dry_run: bool,
        #[arg(long)]
        json: bool,
    },
    /// (Internal) Observe a single commit. Called from the post-commit
    /// path; safe to invoke manually for replay/debugging.
    #[command(hide = true)]
    Observe {
        sha: String,
        #[arg(long, default_value = "human")]
        agent: String,
        #[arg(long)]
        intent_id: Option<String>,
    },
    /// (Internal) Record a negative-signal observation. Called from
    /// the post-tool-use hook (`--kind edit_on_top`) and the rewind
    /// handler (`--kind rewind`). Always operates on HEAD unless
    /// --commit-sha is given.
    #[command(hide = true)]
    Signal {
        #[arg(long)]
        kind: String,
        #[arg(long)]
        file: String,
        #[arg(long)]
        commit_sha: Option<String>,
        #[arg(long, default_value = "human")]
        agent: String,
    },
}

pub fn run(sub: &TasteSubcommands) -> Result<(), Box<dyn std::error::Error>> {
    match sub {
        TasteSubcommands::Status { json } => status(*json),
        TasteSubcommands::List { status, json } => list(status.as_deref(), *json),
        TasteSubcommands::Mine { json } => mine(*json),
        TasteSubcommands::Approve { id } => decide(id, true),
        TasteSubcommands::Reject { id } => decide(id, false),
        TasteSubcommands::Off { id } => decide(id, false),
        TasteSubcommands::Explain { id, json } => explain(id, *json),
        TasteSubcommands::SyncClaudeMd { force } => sync_claude_md(*force),
        TasteSubcommands::Rules { file, limit } => rules_for_file(file, *limit),
        TasteSubcommands::Check { r#ref, staged, threshold, json } => {
            check(r#ref, *staged, *threshold, *json)
        }
        TasteSubcommands::Push { repo_full_name, all, json } => {
            push(repo_full_name.as_deref(), *all, *json)
        }
        TasteSubcommands::Pull { repo_full_name, dry_run, json } => {
            pull(repo_full_name.as_deref(), *dry_run, *json)
        }
        TasteSubcommands::Observe { sha, agent, intent_id } => {
            observe(sha, agent, intent_id.as_deref())
        }
        TasteSubcommands::Signal { kind, file, commit_sha, agent } => {
            signal(kind, file, commit_sha.as_deref(), agent)
        }
    }
}

fn repo_root() -> Result<PathBuf, Box<dyn std::error::Error>> {
    let repo = Repository::discover(".")?;
    let root = repo.workdir().ok_or("bare repo")?.to_path_buf();
    Ok(root)
}

fn status(json: bool) -> Result<(), Box<dyn std::error::Error>> {
    let root = repo_root()?;
    let (total, by_template, by_language, last_ts) = taste::status_counts(&root);
    let rules = taste::aggregate::load_rules(&root);
    let by_status = rule_counts_by_status(&rules.rules);

    if json {
        let payload = serde_json::json!({
            "total": total,
            "by_template": by_template.iter().map(|(k, v)| serde_json::json!({"template": k, "count": v})).collect::<Vec<_>>(),
            "by_language": by_language.iter().map(|(k, v)| serde_json::json!({"language": k, "count": v})).collect::<Vec<_>>(),
            "last_ts": last_ts,
            "rules": {
                "total": rules.rules.len(),
                "active": by_status.active,
                "provisional": by_status.provisional,
                "candidate": by_status.candidate,
                "deprecated": by_status.deprecated,
                "updated_at": rules.updated_at,
            },
            "log_path": taste::observations_path(&root).to_string_lossy(),
            "rules_path": taste::aggregate::rules_path(&root).to_string_lossy(),
        });
        println!("{}", serde_json::to_string_pretty(&payload)?);
        return Ok(());
    }

    println!("\n{} {}", "🧪".bold(), "Taste Observations".bold().magenta());
    println!("  {} {}", "log:".dimmed(), taste::observations_path(&root).to_string_lossy());
    println!("  {} {}", "total:".dimmed(), total);
    if last_ts > 0 {
        println!("  {} {}", "last_ts:".dimmed(), last_ts);
    }

    if total == 0 {
        println!("\n  {} No observations yet.", "ℹ️".blue());
        println!("  Make a few commits and Aura will start mining patterns.");
        return Ok(());
    }

    println!("\n  {}", "by template".cyan().bold());
    for (k, v) in &by_template {
        println!("    {:32} {}", k, v);
    }
    println!("\n  {}", "by language".cyan().bold());
    for (k, v) in &by_language {
        println!("    {:12} {}", k, v);
    }

    println!("\n  {}", "rules".cyan().bold());
    println!("    active       {}", by_status.active);
    println!("    provisional  {}", by_status.provisional);
    println!("    candidate    {}", by_status.candidate);
    println!("    deprecated   {}", by_status.deprecated);
    if rules.updated_at > 0 {
        println!("    updated_at   {}", rules.updated_at);
    }
    println!();
    Ok(())
}

#[derive(Default)]
struct StatusCounts {
    active: usize,
    provisional: usize,
    candidate: usize,
    deprecated: usize,
}

fn rule_counts_by_status(rules: &[Rule]) -> StatusCounts {
    let mut c = StatusCounts::default();
    for r in rules {
        match r.status {
            RuleStatus::Active => c.active += 1,
            RuleStatus::Provisional => c.provisional += 1,
            RuleStatus::Candidate => c.candidate += 1,
            RuleStatus::Deprecated => c.deprecated += 1,
        }
    }
    c
}

fn list(status_filter: Option<&str>, json: bool) -> Result<(), Box<dyn std::error::Error>> {
    let root = repo_root()?;
    let set = taste::aggregate::load_rules(&root);

    let want = status_filter.map(|s| s.to_lowercase());
    let filtered: Vec<&Rule> = set
        .rules
        .iter()
        .filter(|r| match want.as_deref() {
            None => true,
            Some("active") => matches!(r.status, RuleStatus::Active),
            Some("provisional") => matches!(r.status, RuleStatus::Provisional),
            Some("candidate") => matches!(r.status, RuleStatus::Candidate),
            Some("deprecated") => matches!(r.status, RuleStatus::Deprecated),
            Some(_) => true,
        })
        .collect();

    if json {
        println!("{}", serde_json::to_string_pretty(&filtered)?);
        return Ok(());
    }

    if filtered.is_empty() {
        println!("\n{} {}", "🧪".bold(), "Taste Rules".bold().magenta());
        println!("  {} No rules match.", "ℹ️".blue());
        if set.rules.is_empty() {
            println!("  Run `aura taste mine` to aggregate observations into rules.");
        }
        return Ok(());
    }

    println!("\n{} {}", "🧪".bold(), "Taste Rules".bold().magenta());
    for r in filtered {
        let badge = match r.status {
            RuleStatus::Active => "active".green().bold(),
            RuleStatus::Provisional => "provisional".yellow().bold(),
            RuleStatus::Candidate => "candidate".cyan().bold(),
            RuleStatus::Deprecated => "deprecated".dimmed().bold(),
        };
        let approved = if r.user_approved { "✓".green().to_string() } else { "·".dimmed().to_string() };
        println!(
            "\n  {} {}  {}  conf {:.2}  pos {:.1}  neg {:.1}  {}",
            approved,
            badge,
            format!("{} ({}, {})", r.template, r.language, r.layer).dimmed(),
            r.confidence,
            r.positive_weight,
            r.negative_weight,
            r.id.dimmed(),
        );
        println!("    {}", r.statement);
    }
    println!();
    Ok(())
}

fn mine(json: bool) -> Result<(), Box<dyn std::error::Error>> {
    let root = repo_root()?;
    let set = taste::aggregate::aggregate(&root)?;
    if json {
        let counts = rule_counts_by_status(&set.rules);
        let payload = serde_json::json!({
            "total": set.rules.len(),
            "active": counts.active,
            "provisional": counts.provisional,
            "candidate": counts.candidate,
            "deprecated": counts.deprecated,
            "updated_at": set.updated_at,
        });
        println!("{}", serde_json::to_string_pretty(&payload)?);
    } else {
        let counts = rule_counts_by_status(&set.rules);
        println!(
            "{} mined {} rule(s): {} active, {} provisional, {} candidate, {} deprecated",
            "✓".green().bold(),
            set.rules.len(),
            counts.active,
            counts.provisional,
            counts.candidate,
            counts.deprecated,
        );
    }
    Ok(())
}

fn decide(id: &str, approved: bool) -> Result<(), Box<dyn std::error::Error>> {
    let root = repo_root()?;
    let hit = taste::aggregate::set_user_decision(&root, id, approved)?;
    if !hit {
        eprintln!("{} no rule with id {}", "✗".red().bold(), id);
        std::process::exit(1);
    }
    let verb = if approved { "approved" } else { "rejected" };
    println!("{} {} {}", "✓".green().bold(), verb, id);
    // Re-sync CLAUDE.md so the active block reflects the decision.
    let _ = sync_claude_md_inner(&root, true);
    Ok(())
}

fn explain(id: &str, json: bool) -> Result<(), Box<dyn std::error::Error>> {
    let root = repo_root()?;
    let set = taste::aggregate::load_rules(&root);
    let Some(rule) = set.rules.into_iter().find(|r| r.id == id) else {
        eprintln!("{} no rule with id {}", "✗".red().bold(), id);
        std::process::exit(1);
    };

    // Pull the supporting observations off the log.
    let log_path = taste::observations_path(&root);
    let mut backing: Vec<serde_json::Value> = Vec::new();
    if let Ok(file) = std::fs::File::open(&log_path) {
        use std::io::{BufRead, BufReader};
        for line in BufReader::new(file).lines().flatten() {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
                if v.get("rule_template").and_then(|s| s.as_str()) == Some(rule.template.as_str())
                    && v.get("language").and_then(|s| s.as_str()) == Some(rule.language.as_str())
                    && v.get("layer").and_then(|s| s.as_str()) == Some(rule.layer.as_str())
                {
                    backing.push(v);
                }
            }
        }
    }

    if json {
        let payload = serde_json::json!({ "rule": rule, "observations": backing });
        println!("{}", serde_json::to_string_pretty(&payload)?);
        return Ok(());
    }

    println!("\n{} {}", "🧪".bold(), rule.statement.bold());
    println!(
        "  {} {} ({}, {})  conf {:.2}",
        "id:".dimmed(),
        rule.id,
        rule.language,
        rule.layer,
        rule.confidence,
    );
    println!("  {} pos {:.1}, neg {:.1}", "weights:".dimmed(), rule.positive_weight, rule.negative_weight);
    println!("  {} {} observation(s)", "backed by:".dimmed(), backing.len());
    for ex in rule.examples.iter().take(5) {
        println!("    · commit {}", &ex[..8.min(ex.len())]);
    }
    println!();
    Ok(())
}

fn sync_claude_md(force: bool) -> Result<(), Box<dyn std::error::Error>> {
    let root = repo_root()?;
    let n = sync_claude_md_inner(&root, force)?;
    println!("{} CLAUDE.md taste block synced ({} rule(s) injected).", "✓".green().bold(), n);
    Ok(())
}

/// Re-render `## Project Taste (learned)` inside the AURA_START/END
/// guard block in CLAUDE.md. Returns the number of rules written.
/// Phase 1 caps at 30 rules sorted by confidence.
fn sync_claude_md_inner(repo_root: &Path, _force: bool) -> std::io::Result<usize> {
    let set = taste::aggregate::load_rules(repo_root);
    let active: Vec<&Rule> = set
        .rules
        .iter()
        .filter(|r| matches!(r.status, RuleStatus::Active | RuleStatus::Provisional))
        .take(30)
        .collect();

    let claude_md = repo_root.join("CLAUDE.md");
    let original = std::fs::read_to_string(&claude_md).unwrap_or_default();

    // Build the taste section (kept tight — Claude has a budget).
    let mut section = String::new();
    section.push_str("\n## Project Taste (learned)\n\n");
    if active.is_empty() {
        section.push_str("_No taste rules learned yet — make a few commits and run `aura taste mine`._\n");
    } else {
        for r in &active {
            let approved = if r.user_approved { " ✓" } else { "" };
            let weight = r.positive_weight as i64;
            section.push_str(&format!(
                "- {} ({}, {} accepts){}\n",
                r.statement, r.language, weight, approved,
            ));
        }
    }

    // Replace any prior `## Project Taste (learned)` block, or append.
    let updated = if let Some(start) = original.find("\n## Project Taste (learned)") {
        // Find the next top-level header or end-of-file.
        let after = &original[start + 1..];
        let end_offset = after
            .find("\n## ")
            .map(|o| start + 1 + o)
            .unwrap_or(original.len());
        let mut s = String::new();
        s.push_str(&original[..start]);
        s.push_str(section.trim_end());
        s.push('\n');
        s.push_str(&original[end_offset..]);
        s
    } else {
        let mut s = original.clone();
        if !s.ends_with('\n') {
            s.push('\n');
        }
        s.push_str(&section);
        s
    };

    if updated != original {
        std::fs::write(&claude_md, updated)?;
    }
    Ok(active.len())
}

fn rules_for_file(file: &str, limit: usize) -> Result<(), Box<dyn std::error::Error>> {
    let root = repo_root()?;
    let rules = taste::aggregate::rules_for_path(&root, file);
    // We surface active + provisional + user-approved candidates so a
    // freshly approved rule appears in the chip immediately.
    let scoped: Vec<&Rule> = rules
        .iter()
        .filter(|r| {
            matches!(r.status, RuleStatus::Active | RuleStatus::Provisional)
                || (r.user_approved && matches!(r.status, RuleStatus::Candidate))
        })
        .take(limit)
        .collect();
    let payload = serde_json::json!({
        "file": file,
        "language": taste::extract::detect_language(file),
        "layer": taste::extract::detect_layer(file),
        "rules": scoped.iter().map(|r| serde_json::json!({
            "id": r.id,
            "statement": r.statement,
            "template": r.template,
            "language": r.language,
            "layer": r.layer,
            "confidence": r.confidence,
            "status": match r.status {
                RuleStatus::Active => "active",
                RuleStatus::Provisional => "provisional",
                RuleStatus::Candidate => "candidate",
                RuleStatus::Deprecated => "deprecated",
            },
            "user_approved": r.user_approved,
        })).collect::<Vec<_>>(),
    });
    println!("{}", serde_json::to_string_pretty(&payload)?);
    Ok(())
}

fn check(reference: &str, staged: bool, threshold: f64, json: bool) -> Result<(), Box<dyn std::error::Error>> {
    let repo = Repository::discover(".")?;
    let (resolved, report) = if staged {
        let report = taste::check::check_staged(&repo, threshold)?;
        ("staged".to_string(), report)
    } else {
        let resolved = repo.revparse_single(reference)?.id().to_string();
        let report = taste::check::check_commit(&repo, &resolved, threshold)?;
        (resolved, report)
    };

    if json {
        println!("{}", serde_json::to_string_pretty(&report)?);
        // Non-zero exit when violations present — keeps the contract
        // simple for callers (pre-commit hook, PR review).
        if !report.violations.is_empty() {
            std::process::exit(2);
        }
        return Ok(());
    }

    println!("\n{} {}", "🧪".bold(), "Taste Check".bold().magenta());
    println!(
        "  {} {} (threshold {:.2})",
        "ref:".dimmed(),
        &resolved[..12.min(resolved.len())],
        threshold,
    );
    println!(
        "  {} {} file(s) scanned, {} violation(s), {} conformance(s)",
        "→".dimmed(),
        report.files_scanned,
        report.violations.len(),
        report.conformances.len(),
    );

    if report.violations.is_empty() {
        println!("\n  {} No taste violations.", "✓".green().bold());
        return Ok(());
    }

    println!("\n  {}", "violations".red().bold());
    for v in &report.violations {
        println!(
            "    {} {} ({}, {})",
            "•".red(),
            v.file_path.bold(),
            v.template.dimmed(),
            format!("conf {:.2}", v.confidence).dimmed(),
        );
        println!("      rule: {}", v.rule_statement);
        println!("      issue: {}", v.reason.yellow());
    }
    println!();
    std::process::exit(2);
}

/// Resolve the repo handle (e.g. "your-org/your-repo") from the
/// `origin` remote URL. Mothership push/pull keys on this so the same
/// repo across multiple clones lands on the same rule bundle.
fn detect_repo_full_name(repo: &Repository) -> Option<String> {
    let remote = repo.find_remote("origin").ok()?;
    let url = remote.url()?.to_string();
    // git@github.com:org/repo.git → org/repo
    // https://github.com/org/repo(.git)? → org/repo
    let stripped = url.trim_end_matches(".git");
    if let Some(idx) = stripped.find(':') {
        let tail = &stripped[idx + 1..];
        if tail.contains('/') {
            return Some(tail.to_string());
        }
    }
    if let Some(idx) = stripped.rfind("://") {
        let path = &stripped[idx + 3..];
        if let Some(slash) = path.find('/') {
            return Some(path[slash + 1..].to_string());
        }
    }
    None
}

fn push(repo_full_name: Option<&str>, all: bool, json: bool) -> Result<(), Box<dyn std::error::Error>> {
    let repo = Repository::discover(".")?;
    let root = repo.workdir().ok_or("bare repo")?.to_path_buf();
    let set = taste::aggregate::load_rules(&root);

    let rules: Vec<&Rule> = set
        .rules
        .iter()
        .filter(|r| {
            if all {
                true
            } else {
                matches!(r.status, RuleStatus::Active | RuleStatus::Provisional)
            }
        })
        .collect();

    if rules.is_empty() {
        eprintln!("{} no rules to push (mine some first?)", "✗".yellow().bold());
        std::process::exit(1);
    }

    let handle = repo_full_name
        .map(String::from)
        .or_else(|| detect_repo_full_name(&repo))
        .ok_or("could not detect --repo-full-name (no `origin` remote)")?;

    let payload = serde_json::json!({
        "version": set.version,
        "updated_at": set.updated_at,
        "repo_full_name": handle,
        "rules": rules,
    });
    let body_text = serde_json::to_string(&payload)?;

    let (cloud_url, token) = crate::recall_cloud_creds().map_err(|e| -> Box<dyn std::error::Error> { e.into() })?;
    let client = crate::cloud_http_client();
    let url = format!("{}/api/v2/memory", cloud_url.trim_end_matches('/'));
    let req = serde_json::json!({
        "body": body_text,
        "title": format!("taste-rules:{}", handle),
        "kind": "taste_rules",
        "repo_full_name": handle,
    });
    let resp = crate::recall_post(&client, &url, &token, &req).map_err(|e| -> Box<dyn std::error::Error> { e.into() })?;

    if json {
        println!("{}", serde_json::to_string_pretty(&resp)?);
    } else {
        let id = resp.get("id").and_then(|v| v.as_str()).unwrap_or("?");
        println!(
            "{} pushed {} rule(s) to mothership ({}) [{}]",
            "✓".green().bold(),
            rules.len(),
            handle.dimmed(),
            id.dimmed(),
        );
    }
    Ok(())
}

fn pull(repo_full_name: Option<&str>, dry_run: bool, json: bool) -> Result<(), Box<dyn std::error::Error>> {
    let repo = Repository::discover(".")?;
    let root = repo.workdir().ok_or("bare repo")?.to_path_buf();

    let handle = repo_full_name
        .map(String::from)
        .or_else(|| detect_repo_full_name(&repo))
        .ok_or("could not detect --repo-full-name (no `origin` remote)")?;

    let (cloud_url, token) = crate::recall_cloud_creds().map_err(|e| -> Box<dyn std::error::Error> { e.into() })?;
    let client = crate::cloud_http_client();
    let url = format!(
        "{}/api/v2/memory?kind=taste_rules&limit=50",
        cloud_url.trim_end_matches('/'),
    );
    let body = crate::recall_get(&client, &url, &token).map_err(|e| -> Box<dyn std::error::Error> { e.into() })?;

    let entries = body
        .get("entries")
        .and_then(|v| v.as_array())
        .or_else(|| body.get("memory").and_then(|v| v.as_array()))
        .cloned()
        .unwrap_or_default();

    // Find the most recent entry tied to this repo.
    let mut newest: Option<(u64, String)> = None;
    for e in &entries {
        let entry_handle = e.get("repo_full_name").and_then(|v| v.as_str()).unwrap_or("");
        if entry_handle != handle {
            continue;
        }
        let ts = e.get("updated_at").and_then(|v| v.as_u64())
            .or_else(|| e.get("created_at").and_then(|v| v.as_u64()))
            .unwrap_or(0);
        let body_str = e.get("body").and_then(|v| v.as_str()).unwrap_or("").to_string();
        if newest.as_ref().map_or(true, |(t, _)| ts >= *t) {
            newest = Some((ts, body_str));
        }
    }

    let Some((_, body_str)) = newest else {
        eprintln!("{} no team rule bundle found for {}", "ℹ".blue().bold(), handle);
        return Ok(());
    };

    let team: serde_json::Value = serde_json::from_str(&body_str)?;
    let team_rules_raw = team
        .get("rules")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let team_rules: Vec<Rule> = team_rules_raw
        .into_iter()
        .filter_map(|v| serde_json::from_value::<Rule>(v).ok())
        .collect();

    // Merge: same (template, language, layer) tuple — keep the side
    // with higher confidence × pick max positive_weight; preserve
    // local `user_approved` decisions; promote to active if either
    // side is active.
    let mut local = taste::aggregate::load_rules(&root);
    let mut merged = local.rules.clone();
    let mut added = 0usize;
    let mut updated = 0usize;
    for tr in team_rules {
        if let Some(existing) = merged.iter_mut().find(|r| {
            r.template == tr.template && r.language == tr.language && r.layer == tr.layer
        }) {
            let preserve_approved = existing.user_approved;
            if tr.confidence > existing.confidence {
                existing.statement = tr.statement.clone();
                existing.confidence = tr.confidence;
            }
            existing.positive_weight = existing.positive_weight.max(tr.positive_weight);
            existing.negative_weight = existing.negative_weight.max(tr.negative_weight);
            // Promote when either side is active.
            if matches!(tr.status, RuleStatus::Active) {
                existing.status = RuleStatus::Active;
            } else if matches!(tr.status, RuleStatus::Provisional)
                && matches!(existing.status, RuleStatus::Candidate)
            {
                existing.status = RuleStatus::Provisional;
            }
            existing.user_approved = preserve_approved || tr.user_approved;
            existing.last_seen = existing.last_seen.max(tr.last_seen);
            updated += 1;
        } else {
            merged.push(tr);
            added += 1;
        }
    }

    local.rules = merged;
    local.updated_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    if !dry_run {
        taste::aggregate::save_rules(&root, &local)?;
        // Refresh CLAUDE.md so the team rules land in the agent prompt.
        let _ = sync_claude_md_inner(&root, true);
    }

    if json {
        let payload = serde_json::json!({
            "added": added,
            "updated": updated,
            "total": local.rules.len(),
            "dry_run": dry_run,
        });
        println!("{}", serde_json::to_string_pretty(&payload)?);
    } else {
        let verb = if dry_run { "would merge" } else { "merged" };
        println!(
            "{} {} team rules from {}: {} added, {} updated, {} total",
            "✓".green().bold(),
            verb,
            handle.dimmed(),
            added,
            updated,
            local.rules.len(),
        );
    }
    Ok(())
}

fn signal(kind: &str, file: &str, commit_sha: Option<&str>, agent: &str) -> Result<(), Box<dyn std::error::Error>> {
    let repo = Repository::discover(".")?;
    let root = repo.workdir().ok_or("bare repo")?.to_path_buf();
    let sha = match commit_sha {
        Some(s) => repo.revparse_single(s)?.id().to_string(),
        None => repo.head()?.peel_to_commit()?.id().to_string(),
    };
    let n = taste::record_negative_signal(&root, &sha, file, kind, agent)?;
    println!(
        "{} recorded {} signal for {} ({} observation{})",
        "✓".green().bold(),
        kind,
        file,
        n,
        if n == 1 { "" } else { "s" },
    );
    Ok(())
}

fn observe(sha: &str, agent: &str, intent_id: Option<&str>) -> Result<(), Box<dyn std::error::Error>> {
    let repo = Repository::discover(".")?;
    let resolved = repo.revparse_single(sha)?.id().to_string();
    let n = taste::observe_commit(&repo, &resolved, agent, intent_id)?;
    println!("{} observed commit {} ({} observation{})",
        "✓".green().bold(),
        &resolved[..8.min(resolved.len())],
        n,
        if n == 1 { "" } else { "s" },
    );
    Ok(())
}
