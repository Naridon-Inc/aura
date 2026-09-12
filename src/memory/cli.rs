// CLI surface for the local project memory store (.aura/memory.json):
//
//   aura memory add <content> [--section S] [--tags a,b] [--symbol path#ident]
//   aura memory search <query> [--json] [--all]
//   aura memory why <id> [--json]
//   aura memory consolidate [--section S] [--json]
//
// `add` writes a W2 provenance-stamped entry through the W3 reconcile
// pipeline (dedup → ADD/UPDATE/DELETE/NOOP → supersede-never-delete).
// `search` is the W1 hybrid ranked recall (file anchor + BM25 + embeddings
// + recency, RRF-fused) with read-time staleness flags, W4 retention-blended scores
// and reinforcement; `--all` includes superseded audit rows and
// decayed-out entries. `why` prints one fact's full provenance chain
// (incl. the W3 supersession lineage) and a live check against the code
// it was learned from. `consolidate` runs the W4 consolidation pass by
// hand — the exact code path the aura-daemon 30-minute loop executes.

use clap::Subcommand;
use colored::Colorize;

use crate::memory::{provenance, MemoryManager};

#[derive(Subcommand)]
pub enum MemoryAction {
    /// Add a provenance-stamped entry to local project memory. The entry is
    /// auto-stamped with the HEAD short sha, the latest intent-log row and
    /// the write time; --symbol additionally anchors it to a code symbol
    /// whose text is fingerprinted so recall can flag drift.
    Add {
        /// The memory content (≤1000 chars; truncated beyond that).
        content: String,
        /// Section: convention | gotcha | context | active_work.
        #[arg(long, default_value = "context")]
        section: String,
        /// Comma-separated tags for searchability.
        #[arg(long)]
        tags: Option<String>,
        /// Code anchor: `<repo-relative-path>#<identifier>`, e.g.
        /// `src/auth.rs#verify_token`. The symbol's current text is sha256
        /// fingerprinted; future reads flag the memory stale when the code
        /// changes or disappears.
        #[arg(long)]
        symbol: Option<String>,
        /// Print a structured JSON result (the reconcile outcome + the
        /// entry as it landed) instead of prose. This is the IPC contract
        /// the desktop app parses — keep it stable.
        #[arg(long)]
        json: bool,
    },
    /// Edit one live entry by id: the old row's validity window closes and
    /// a fresh provenance-stamped, signed successor (with a `supersedes`
    /// back-pointer) lands in the same section — supersede, never delete,
    /// so `aura memory why` keeps the full lineage.
    Edit {
        /// Memory entry id, e.g. mem-a1b2c3d4.
        id: String,
        /// The corrected content (≤1000 chars; truncated beyond that).
        content: String,
        /// Comma-separated replacement tags. Omit to keep the old tags.
        #[arg(long)]
        tags: Option<String>,
        /// Print a structured JSON result instead of prose.
        #[arg(long)]
        json: bool,
    },
    /// Forget one entry by id. Default is SOFT: the entry leaves default
    /// recall but stays on disk as audit trail (same shape as a reconcile
    /// DELETE). --hard erases the row entirely — the privacy path for
    /// content that must not remain on disk at all.
    Forget {
        /// Memory entry id, e.g. mem-a1b2c3d4.
        id: String,
        /// Erase the row entirely instead of closing its window.
        #[arg(long)]
        hard: bool,
        /// Print a structured JSON result instead of prose.
        #[arg(long)]
        json: bool,
    },
    /// Hybrid ranked search: BM25 + embedding-cosine (when an API key is
    /// configured) + recency, fused with Reciprocal Rank Fusion. Results
    /// bound to a code symbol carry a live staleness check. Superseded
    /// entries (replaced by a later write) are excluded unless --all.
    Search {
        /// What to look for.
        query: String,
        /// Print raw JSON results instead of the table.
        #[arg(long)]
        json: bool,
        /// Include superseded (audit-trail) and decayed-out entries.
        #[arg(long)]
        all: bool,
    },
    /// Show one memory's provenance: source commit, the intent it was
    /// written under, signer key, validity window, supersession lineage,
    /// and whether the code it was learned from has changed since.
    Why {
        /// Memory entry id, e.g. mem-a1b2c3d4.
        id: String,
        /// Print the structured JSON report instead of prose.
        #[arg(long)]
        json: bool,
    },
    /// Run one consolidation pass: every section with 10+ live entries is
    /// AI-compressed to at most 5 dense entries (superseded audit rows are
    /// preserved untouched). The same code path the aura-daemon 30-minute
    /// loop runs; with no AI key configured, sections are skipped silently
    /// until the next cycle.
    Consolidate {
        /// Limit the pass to one section: convention | gotcha | context.
        #[arg(long)]
        section: Option<String>,
        /// Print the structured JSON report instead of prose.
        #[arg(long)]
        json: bool,
    },
    /// Import another agent's per-fact project memory into Aura's memory.
    /// Today this reads Claude Code's memory directory for the current repo
    /// (one Markdown file per fact, YAML frontmatter + body) and folds each
    /// fact through the W3 reconcile pipeline — so re-running is idempotent
    /// (exact duplicates NOOP, restatements supersede). Project instruction
    /// files (CLAUDE.md / AGENTS.md / GEMINI.md) are NOT shredded into facts;
    /// only the per-fact memory dir is imported.
    ImportClaudeCode {
        /// Override the source directory. Defaults to
        /// `~/.claude/projects/<encoded-cwd>/memory` for the current repo.
        #[arg(long)]
        source_dir: Option<String>,
        /// Which agent's memory to import. Only `claude` is supported today;
        /// any other value prints a plain "not yet supported" line.
        #[arg(long, default_value = "claude")]
        agent: String,
        /// Report what WOULD import without writing anything.
        #[arg(long)]
        dry_run: bool,
        /// Print the structured JSON report instead of prose.
        #[arg(long)]
        json: bool,
    },
    /// W5 sleep-time reflection: scan the episodic record (intent log +
    /// pre-edit snapshots) for durable patterns — recurring bug-fixes on
    /// one file, sustained multi-day focus, short-window churn — and
    /// promote them as provenance-stamped semantic memory entries through
    /// the same reconcile pipeline as every other write. Deterministic
    /// (three auditable evidence rules, no model call); a watermark makes
    /// re-runs no-ops until new history arrives. The aura-daemon 30-minute
    /// loop runs this exact verb.
    Reflect {
        /// How far back to read episodic signals (default 720h = 30 days).
        #[arg(long)]
        window_hours: Option<u64>,
        /// Report the candidate patterns without writing anything.
        #[arg(long)]
        dry_run: bool,
        /// Print the structured JSON report instead of prose.
        #[arg(long)]
        json: bool,
    },
}

/// The author stamped on write paths: the active session's agent, else the
/// shell user, else "human".
fn resolve_author() -> String {
    crate::session::SessionManager::get_active_session()
        .map(|s| s.agent_id)
        .or_else(|| std::env::var("USER").ok())
        .unwrap_or_else(|| "human".to_string())
}

/// Split a `--tags a,b,c` value into clean tag list.
fn split_tags(tags: &str) -> Vec<String> {
    tags.split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

pub fn run(action: &MemoryAction) -> Result<(), String> {
    match action {
        MemoryAction::Add { content, section, tags, symbol, json } => {
            let tags: Vec<String> = split_tags(tags.as_deref().unwrap_or(""));
            let author = resolve_author();

            let outcome = MemoryManager::add_entry_reconciled(
                section,
                content,
                tags,
                &author,
                symbol.as_deref(),
            );

            if *json {
                // IPC contract (parsed by the desktop app): the reconcile
                // outcome plus the entry exactly as it landed on disk.
                let landed = MemoryManager::find_entry(&outcome.id);
                let v = serde_json::json!({
                    "op": match outcome.op {
                        crate::memory::reconcile::ReconcileOp::Added => "added",
                        crate::memory::reconcile::ReconcileOp::Updated => "updated",
                        crate::memory::reconcile::ReconcileOp::Deleted => "deleted",
                        crate::memory::reconcile::ReconcileOp::Noop => "noop",
                    },
                    "id": outcome.id,
                    "superseded": outcome.superseded,
                    "reason": outcome.reason,
                    "section": landed.as_ref().map(|(s, _)| *s),
                    // Strip the embedding vector: retrieval internals never
                    // belong in a user-facing record (AUDIT-CTX-05).
                    "entry": landed.as_ref().map(|(_, e)| {
                        let mut e = e.clone();
                        e.embedding = None;
                        serde_json::to_value(&e).unwrap_or_default()
                    }),
                });
                println!(
                    "{}",
                    serde_json::to_string_pretty(&v)
                        .map_err(|e| format!("serialize error: {}", e))?
                );
                return Ok(());
            }

            // W3 — surface what reconcile actually did.
            use crate::memory::reconcile::ReconcileOp;
            match outcome.op {
                ReconcileOp::Noop => {
                    println!(
                        "{} duplicate of {} — not added",
                        "≡".yellow().bold(),
                        outcome.id.cyan()
                    );
                    println!("  {} {}", "↳".dimmed(), outcome.reason.dimmed());
                    return Ok(());
                }
                ReconcileOp::Deleted => {
                    println!(
                        "{} {} superseded (window closed) — new fact invalidates it, nothing added",
                        "⊘".yellow().bold(),
                        outcome.id.cyan()
                    );
                    println!("  {} {}", "↳".dimmed(), outcome.reason.dimmed());
                    return Ok(());
                }
                ReconcileOp::Updated => {
                    println!(
                        "{} {} supersedes {}",
                        "✓".green().bold(),
                        outcome.id.cyan(),
                        outcome
                            .superseded
                            .as_deref()
                            .unwrap_or("?")
                            .yellow()
                    );
                }
                ReconcileOp::Added => {}
            }
            let id = outcome.id.clone();

            // Re-read what actually landed so the stamp shown is the truth
            // on disk (dedup may have returned a pre-existing entry).
            match MemoryManager::find_entry(&id) {
                Some((sec, e)) => {
                    println!(
                        "{} {} added to '{}'",
                        "✓".green().bold(),
                        id.cyan(),
                        sec
                    );
                    if let Some(c) = &e.source_commit {
                        println!("  {} commit {}", "↳".dimmed(), c);
                    }
                    if let Some(iid) = &e.intent_id {
                        let signer = e
                            .signer_key_id
                            .as_deref()
                            .map(|k| format!(", signed by {}", k))
                            .unwrap_or_default();
                        println!("  {} intent {}{}", "↳".dimmed(), iid, signer);
                    }
                    if let Some(s) = &e.source_symbol {
                        let fp = if e.source_symbol_hash.is_some() {
                            "fingerprinted".to_string()
                        } else {
                            "unresolved — not fingerprinted".yellow().to_string()
                        };
                        println!("  {} symbol {} ({})", "↳".dimmed(), s, fp);
                    }
                }
                None => println!("{} {} added", "✓".green().bold(), id.cyan()),
            }
            Ok(())
        }

        MemoryAction::Edit { id, content, tags, json } => {
            let author = resolve_author();
            let tags = tags.as_deref().map(split_tags);
            match MemoryManager::edit_entry(id, content, tags, &author) {
                Ok(successor) => {
                    if *json {
                        let mut e = successor.clone();
                        e.embedding = None;
                        let v = serde_json::json!({
                            "op": "edited",
                            "id": e.id,
                            "supersedes": id,
                            "entry": serde_json::to_value(&e).unwrap_or_default(),
                        });
                        println!(
                            "{}",
                            serde_json::to_string_pretty(&v)
                                .map_err(|e| format!("serialize error: {}", e))?
                        );
                    } else {
                        println!(
                            "{} {} supersedes {} — the old row stays as audit trail",
                            "✓".green().bold(),
                            successor.id.cyan(),
                            id.yellow()
                        );
                    }
                    Ok(())
                }
                Err(e) => {
                    if *json {
                        println!("{}", serde_json::json!({ "op": "error", "message": e }));
                        Ok(())
                    } else {
                        Err(e)
                    }
                }
            }
        }

        MemoryAction::Forget { id, hard, json } => {
            let removed = if *hard {
                MemoryManager::forget(id)
            } else {
                MemoryManager::forget_soft(id)
            };
            if *json {
                println!(
                    "{}",
                    serde_json::json!({
                        "op": "forgotten",
                        "id": id,
                        "hard": hard,
                        "removed": removed,
                    })
                );
                return Ok(());
            }
            if removed {
                if *hard {
                    println!("{} {} erased entirely", "✓".green().bold(), id.cyan());
                } else {
                    println!(
                        "{} {} forgotten — kept on disk as audit trail (--hard erases)",
                        "✓".green().bold(),
                        id.cyan()
                    );
                }
            } else {
                println!("{} no live entry with id {}", "–".dimmed(), id.cyan());
            }
            Ok(())
        }

        MemoryAction::Search { query, json, all } => {
            let results = if *all {
                MemoryManager::search_all(query)
            } else {
                MemoryManager::search(query)
            };
            if *json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&results)
                        .map_err(|e| format!("serialize error: {}", e))?
                );
                return Ok(());
            }
            if results.is_empty() {
                println!("No memories matching '{}'.", query);
                return Ok(());
            }
            println!(
                "{} {} result(s) for '{}' — ranked (file anchor + BM25 + embeddings + recency, RRF)\n",
                "🧠".bold(),
                results.len(),
                query
            );
            for (i, r) in results.iter().enumerate() {
                let section = r["section"].as_str().unwrap_or("?");
                let id = r["id"].as_str().unwrap_or("");
                let head = match r["score"].as_f64() {
                    Some(score) => format!("{:>2}. [{:.4}]", i + 1, score),
                    // identity/architecture/timeline legacy matches carry
                    // no score — rendered after the ranked block.
                    None => format!("{:>2}. [  —  ]", i + 1),
                };
                // CTX-04 — surface the evidence-based truth state; only a
                // quiet "supported" stays unflagged. Entries without a
                // truth_state (no anchor / legacy rows) render bare.
                let stale_flag = match r["truth_state"].as_str() {
                    Some("stale") => format!("  {}", "⚠ stale — code moved".yellow().bold()),
                    Some("contradicted") => {
                        format!("  {}", "✗ contradicted by the code".red().bold())
                    }
                    Some("unverified") => format!("  {}", "? unverified".dimmed()),
                    _ => String::new(),
                };
                let superseded_flag = if r["superseded"].as_bool() == Some(true) {
                    format!("  {}", "✗ superseded".dimmed())
                } else {
                    String::new()
                };
                // AURA-1372 — memory is local until somebody shares it, and
                // the promise is only worth something if you can see which
                // ones you shared.
                let shared_flag = match r["shared_at"].as_str() {
                    Some(_) => {
                        let sig = r["shared_signature"].as_str().unwrap_or("unsigned");
                        if sig == "signed" {
                            format!("  {}", "↗ shared with your team".cyan())
                        } else {
                            format!("  {}", format!("↗ shared with your team ({sig})").cyan())
                        }
                    }
                    // Withdrawn reads differently from never-shared: it
                    // was out there, and somebody may still hold a copy.
                    None => match r["shared_retracted_at"].as_str() {
                        Some(_) => format!("  {}", "↩ withdrawn from your team".dimmed()),
                        None => String::new(),
                    },
                };
                let content = r["content"]
                    .as_str()
                    .or_else(|| r["description"].as_str())
                    .or_else(|| r["title"].as_str())
                    .unwrap_or("");
                println!(
                    "{} {} {}{}{}{}",
                    head.dimmed(),
                    format!("({}{}{})", section, if id.is_empty() { "" } else { " " }, id).blue(),
                    content.white(),
                    stale_flag,
                    superseded_flag,
                    shared_flag
                );
                if let Some(reason) = r["stale_reason"]
                    .as_str()
                    .or_else(|| r["truth_reason"].as_str().filter(|_| !stale_flag.is_empty()))
                {
                    println!("      {}", reason.yellow());
                }
                if let Some(legs) = r["legs"].as_array() {
                    let legs: Vec<&str> = legs.iter().filter_map(|l| l.as_str()).collect();
                    println!("      {}", format!("legs: {}", legs.join("+")).dimmed());
                }
            }
            Ok(())
        }

        MemoryAction::Why { id, json } => {
            if *json {
                let v = provenance::why_json(id)?;
                println!(
                    "{}",
                    serde_json::to_string_pretty(&v)
                        .map_err(|e| format!("serialize error: {}", e))?
                );
            } else {
                print!("{}", provenance::why_report(id)?);
            }
            Ok(())
        }

        MemoryAction::Consolidate { section, json } => {
            use crate::memory::decay::SkipReason;
            let reports = MemoryManager::consolidate(section.as_deref())?;
            if *json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&reports)
                        .map_err(|e| format!("serialize error: {}", e))?
                );
                return Ok(());
            }
            for r in &reports {
                match &r.skipped {
                    None => println!(
                        "{} {}: {} live entries compacted away ({} → {})",
                        "✓".green().bold(),
                        r.section.cyan(),
                        r.compacted,
                        r.live_before,
                        r.live_before - r.compacted
                    ),
                    Some(SkipReason::BelowThreshold(n)) => println!(
                        "{} {}: {} live entries — below threshold ({}), skipped",
                        "–".dimmed(),
                        r.section.cyan(),
                        n,
                        crate::memory::decay::CONSOLIDATE_MIN_LIVE
                    ),
                    Some(SkipReason::ModelUnavailable(_)) => println!(
                        "{} {}: skipped — no AI model available this cycle",
                        "–".dimmed(),
                        r.section.cyan()
                    ),
                    Some(SkipReason::BadReply(e)) => println!(
                        "{} {}: skipped — {}",
                        "⚠".yellow().bold(),
                        r.section.cyan(),
                        e
                    ),
                }
            }
            Ok(())
        }

        MemoryAction::ImportClaudeCode { source_dir, agent, dry_run, json } => {
            use crate::memory::import;

            // Only Claude Code's memory dir is supported today. Other agents
            // are accepted on the flag but reported plainly — not an error.
            if agent.to_lowercase() != "claude" && agent.to_lowercase() != "claude-code" {
                if *json {
                    println!(
                        "{}",
                        serde_json::json!({
                            "supported": false,
                            "agent": agent,
                            "message": format!("Importing from '{}' is not yet supported — only Claude Code.", agent)
                        })
                    );
                } else {
                    println!(
                        "Importing from '{}' is not yet supported — only Claude Code for now.",
                        agent
                    );
                }
                return Ok(());
            }

            // Resolve the source dir: explicit override, else the encoded
            // Claude Code memory dir for the current repo.
            let dir = match source_dir {
                Some(s) => std::path::PathBuf::from(s),
                None => {
                    let cwd = std::env::current_dir()
                        .map_err(|e| format!("cannot read current dir: {}", e))?;
                    match import::default_source_dir(&cwd) {
                        Some(d) => d,
                        None => {
                            // Clean exit — not a crash. No memory to import.
                            if *json {
                                println!(
                                    "{}",
                                    serde_json::json!({
                                        "imported": 0,
                                        "deduped": 0,
                                        "updated": 0,
                                        "total": 0,
                                        "by_section": {},
                                        "dry_run": *dry_run,
                                        "source_dir": null,
                                        "found": false,
                                        "message": "No Claude Code memory found for this project."
                                    })
                                );
                            } else {
                                println!(
                                    "No Claude Code memory found for this project — nothing to import."
                                );
                            }
                            return Ok(());
                        }
                    }
                }
            };

            if !dir.is_dir() {
                if *json {
                    println!(
                        "{}",
                        serde_json::json!({
                            "imported": 0, "deduped": 0, "updated": 0, "total": 0,
                            "by_section": {}, "dry_run": *dry_run,
                            "source_dir": dir.to_string_lossy(),
                            "found": false,
                            "message": "Source directory does not exist."
                        })
                    );
                } else {
                    println!(
                        "No memory directory at {} — nothing to import.",
                        dir.display()
                    );
                }
                return Ok(());
            }

            let report = import::run_import(&dir, !*dry_run);

            if *json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&report)
                        .map_err(|e| format!("serialize error: {}", e))?
                );
                return Ok(());
            }

            // Human summary — plain language, no jargon.
            if report.total == 0 {
                println!("Claude Code's memory for this project is empty — nothing to import.");
                return Ok(());
            }
            if *dry_run {
                println!(
                    "{} Would bring in {} fact(s) Claude Code remembers about this project.",
                    "→".cyan().bold(),
                    report.imported
                );
                for (section, n) in &report.by_section {
                    println!("  {} {} → {}", "·".dimmed(), n, section);
                }
                println!(
                    "  {} {}",
                    "↳".dimmed(),
                    "Dry run — nothing was written. Re-run without --dry-run to import.".dimmed()
                );
            } else {
                println!(
                    "{} Brought in {} new fact(s) Claude Code remembered about this project.",
                    "✓".green().bold(),
                    report.imported
                );
                if report.updated > 0 {
                    println!(
                        "  {} {} updated an existing memory.",
                        "·".dimmed(),
                        report.updated
                    );
                }
                if report.deduped > 0 {
                    println!(
                        "  {} {} were already here.",
                        "·".dimmed(),
                        report.deduped
                    );
                }
                for (section, n) in &report.by_section {
                    println!("  {} {} → {}", "·".dimmed(), n, section);
                }
            }
            Ok(())
        }
        MemoryAction::Reflect {
            window_hours,
            dry_run,
            json,
        } => crate::memory::reflect::run(*window_hours, !*dry_run, *json),
    }
}
