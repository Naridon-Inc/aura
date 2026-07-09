// `aura meta` — the meaning plane travels WITH the repo (M4a, AURA-22).
//
// push : attribute local intent-log rows to commits, write them as git
//        notes under refs/notes/aura-intent, push the ref to the remote.
// pull : fetch the remote's aura-intent notes into a staging ref and
//        union-merge them into the local ref (never clobbers).
// log  : walk HEAD and render WHO/WHY per noted commit.
//
// The repo stays 100% standard git: the only artifact is a plain notes
// ref any host (GitHub included) round-trips. Local note operations go
// through git2; the `git` binary is shelled out ONLY for transport
// (push/fetch of the ref).

use clap::Subcommand;
use colored::Colorize;
use git2::Repository;
use std::path::PathBuf;

// pub(crate): the PR review humanizer (pr::pr_humanize) reuses the
// note-reading/parsing fns for its notes-intent fallback.
#[path = "meta_refs_notes.rs"]
pub(crate) mod notes;

#[cfg(test)]
#[path = "meta_refs_tests.rs"]
mod tests;

pub use notes::{INCOMING_PROOF_REF, INCOMING_REF, NOTES_REF, PROOF_REF};

#[derive(Subcommand)]
pub enum MetaSubcommands {
    /// Attach intent-log rows to their commits as notes under
    /// refs/notes/aura-intent, then push the ref to the remote.
    Push {
        /// Remote to push the notes ref to.
        #[arg(long, default_value = "origin")]
        remote: String,
        /// Rev range to (re)note, e.g. `main..HEAD` or a single rev.
        /// Default: every commit on HEAD with no aura-intent note yet.
        #[arg(long)]
        range: Option<String>,
        /// Write/merge notes locally but skip the network push.
        #[arg(long)]
        no_push: bool,
        #[arg(long)]
        json: bool,
    },
    /// Fetch the remote's aura-intent notes and union-merge them into
    /// the local ref. Never overwrites — merge is a union of lines.
    Pull {
        /// Remote to fetch the notes ref from.
        #[arg(long, default_value = "origin")]
        remote: String,
        #[arg(long)]
        json: bool,
    },
    /// Show WHO/WHY per commit: walk HEAD and render each commit that
    /// carries an aura-intent note.
    Log {
        /// Maximum number of noted commits to show.
        #[arg(long, default_value_t = 20)]
        limit: usize,
        #[arg(long)]
        json: bool,
    },
    /// Audit the meaning + proof planes offline: per commit, does it carry
    /// intent, is it proven, and does its proof note bind to the right
    /// commit? Pure local — no server, no network.
    Verify {
        /// Rev range to verify, e.g. `main..HEAD`. Default: HEAD (capped).
        #[arg(long)]
        range: Option<String>,
        /// Fail (non-zero exit) if any commit in range lacks a proof note.
        #[arg(long)]
        strict: bool,
        #[arg(long)]
        json: bool,
    },
}

pub fn run(sub: &MetaSubcommands) -> Result<(), Box<dyn std::error::Error>> {
    match sub {
        MetaSubcommands::Push {
            remote,
            range,
            no_push,
            json,
        } => run_push(remote, range.as_deref(), *no_push, *json),
        MetaSubcommands::Pull { remote, json } => run_pull(remote, *json),
        MetaSubcommands::Log { limit, json } => run_log(*limit, *json),
        MetaSubcommands::Verify {
            range,
            strict,
            json,
        } => run_verify(range.as_deref(), *strict, *json),
    }
}

// pub(crate): refs_sign (signed canonical refs) reuses the repo/transport
// helpers so the two notes planes can never drift on how they shell out.
pub(crate) fn open_repo() -> Result<Repository, Box<dyn std::error::Error>> {
    Repository::discover(".").map_err(|e| {
        format!("not inside a git repository ({})", e.message()).into()
    })
}

pub(crate) fn repo_dir(repo: &Repository) -> PathBuf {
    repo.workdir()
        .map(|w| w.to_path_buf())
        .unwrap_or_else(|| repo.path().to_path_buf())
}

/// Transport-only shell-out. Everything else is git2.
pub(crate) fn git_transport(dir: &PathBuf, args: &[&str]) -> Result<String, String> {
    let out = std::process::Command::new("git")
        .args(args)
        .current_dir(dir)
        .output()
        .map_err(|e| format!("failed to spawn git: {}", e))?;
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    if out.status.success() {
        Ok(stderr)
    } else {
        Err(stderr)
    }
}

fn run_push(
    remote: &str,
    range: Option<&str>,
    no_push: bool,
    json: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let repo = open_repo()?;
    let report = notes::write_notes_for_range(&repo, range)?;
    // The proof plane rides alongside intent: snapshot each commit's goal
    // verdict onto refs/notes/aura-proof (newest wins, force-replace).
    let proof_report = notes::write_proof_for_range(&repo, range)?;

    let ref_exists = repo.find_reference(NOTES_REF).is_ok();
    let proof_ref_exists = repo.find_reference(PROOF_REF).is_ok();
    let mut pushed = false;
    let mut proof_pushed = false;
    let mut push_error: Option<String> = None;
    if !no_push {
        let dir = repo_dir(&repo);
        if ref_exists {
            match git_transport(&dir, &["push", remote, NOTES_REF]) {
                Ok(_) => pushed = true,
                Err(e) => push_error = Some(e),
            }
        }
        // Push proof independently: a proof ref can exist even when no new
        // intent landed, and an intent push failure shouldn't strand proof.
        if proof_ref_exists && push_error.is_none() {
            match git_transport(&dir, &["push", remote, PROOF_REF]) {
                Ok(_) => proof_pushed = true,
                Err(e) => push_error = Some(e),
            }
        }
    }

    if json {
        let mut v = serde_json::to_value(&report)?;
        v["pushed"] = serde_json::json!(pushed);
        v["remote"] = serde_json::json!(remote);
        v["notes_ref"] = serde_json::json!(NOTES_REF);
        v["proof"] = serde_json::to_value(&proof_report)?;
        v["proof_pushed"] = serde_json::json!(proof_pushed);
        v["proof_ref"] = serde_json::json!(PROOF_REF);
        if let Some(e) = &push_error {
            v["push_error"] = serde_json::json!(e);
        }
        println!("{}", serde_json::to_string_pretty(&v)?);
    } else {
        println!(
            "{} {} commit(s) in range · {} noted · {} row(s) attached ({} windowed, {} unmatched→newest) · {} already noted",
            "meta push".bold(),
            report.commits_in_range,
            report.commits_noted,
            report.rows_attached,
            report.rows_windowed,
            report.rows_unmatched,
            report.rows_already_noted,
        );
        println!(
            "  {} proof: {} commit(s) proven · {} snapshot(s) written",
            "·".dimmed(),
            proof_report.commits_proven,
            proof_report.commits_changed,
        );
        if no_push {
            println!("  {} push skipped (--no-push)", "·".dimmed());
        } else {
            if pushed {
                println!("  {} pushed {} → {}", "✓".green(), NOTES_REF, remote);
            } else if !ref_exists {
                println!(
                    "  {} nothing to push — no {} ref yet",
                    "·".dimmed(),
                    NOTES_REF
                );
            }
            if proof_pushed {
                println!("  {} pushed {} → {}", "✓".green(), PROOF_REF, remote);
            } else if !proof_ref_exists {
                println!(
                    "  {} nothing to push — no {} ref yet",
                    "·".dimmed(),
                    PROOF_REF
                );
            }
        }
    }

    if let Some(e) = push_error {
        return Err(format!(
            "push of {} to '{}' failed: {}\nhint: run `aura meta pull --remote {}` to merge the remote's notes first, then push again",
            NOTES_REF, remote, e, remote
        )
        .into());
    }
    Ok(())
}

fn run_pull(remote: &str, json: bool) -> Result<(), Box<dyn std::error::Error>> {
    let repo = open_repo()?;
    let dir = repo_dir(&repo);

    // Force refspec into the staging ref: a rewritten remote ref must
    // still land so the union-merge can reconcile it.
    let refspec = format!("+{}:{}", NOTES_REF, INCOMING_REF);
    let mut remote_missing = false;
    if let Err(e) = git_transport(&dir, &["fetch", remote, &refspec]) {
        let lowered = e.to_lowercase();
        if lowered.contains("couldn't find remote ref")
            || lowered.contains("could not find remote ref")
        {
            remote_missing = true;
        } else {
            return Err(format!(
                "fetch of {} from '{}' failed: {}",
                NOTES_REF, remote, e
            )
            .into());
        }
    }

    let report = if remote_missing {
        notes::PullReport {
            incoming_present: false,
            commits_seen: 0,
            commits_updated: 0,
            lines_added: 0,
        }
    } else {
        notes::merge_incoming_notes(&repo)?
    };

    // Proof plane: fetch the parallel ref into its own staging ref and
    // resolve newest-wins. A missing remote proof ref is tolerated exactly
    // like the intent ref's missing-ref handling.
    let proof_refspec = format!("+{}:{}", PROOF_REF, INCOMING_PROOF_REF);
    let mut proof_remote_missing = false;
    if let Err(e) = git_transport(&dir, &["fetch", remote, &proof_refspec]) {
        let lowered = e.to_lowercase();
        if lowered.contains("couldn't find remote ref")
            || lowered.contains("could not find remote ref")
        {
            proof_remote_missing = true;
        } else {
            return Err(format!(
                "fetch of {} from '{}' failed: {}",
                PROOF_REF, remote, e
            )
            .into());
        }
    }
    let proof_report = if proof_remote_missing {
        notes::ProofPullReport {
            incoming_present: false,
            commits_seen: 0,
            commits_updated: 0,
        }
    } else {
        notes::merge_incoming_proof(&repo)?
    };

    if json {
        let mut v = serde_json::to_value(&report)?;
        v["remote"] = serde_json::json!(remote);
        v["notes_ref"] = serde_json::json!(NOTES_REF);
        v["proof"] = serde_json::to_value(&proof_report)?;
        v["proof_ref"] = serde_json::json!(PROOF_REF);
        println!("{}", serde_json::to_string_pretty(&v)?);
    } else {
        if !report.incoming_present {
            println!(
                "{} no {} on '{}' yet — nothing to merge",
                "meta pull".bold(),
                NOTES_REF,
                remote
            );
        } else {
            println!(
                "{} {} noted commit(s) fetched · {} updated · {} line(s) merged",
                "meta pull".bold(),
                report.commits_seen,
                report.commits_updated,
                report.lines_added,
            );
        }
        if !proof_report.incoming_present {
            println!("  {} no {} on '{}' yet", "·".dimmed(), PROOF_REF, remote);
        } else {
            println!(
                "  {} proof: {} commit(s) fetched · {} updated (newest wins)",
                "·".dimmed(),
                proof_report.commits_seen,
                proof_report.commits_updated,
            );
        }
    }
    Ok(())
}

fn run_log(limit: usize, json: bool) -> Result<(), Box<dyn std::error::Error>> {
    let repo = open_repo()?;
    let entries = notes::collect_log(&repo, limit)?;

    if json {
        println!("{}", serde_json::to_string_pretty(&entries)?);
        return Ok(());
    }

    if entries.is_empty() {
        println!(
            "no {} notes on HEAD — `aura meta push` to write them, `aura meta pull` to fetch a teammate's",
            NOTES_REF
        );
        return Ok(());
    }

    for entry in &entries {
        println!("{}  {}", entry.short.yellow(), entry.summary);
        for row in &entry.rows {
            let who = match &row.key_id {
                Some(k) => format!("{}/{}", row.agent_id, k),
                None => row.agent_id.clone(),
            };
            let kind = row.intent_type.as_deref().unwrap_or("untyped");
            println!(
                "         {} · {} · {}",
                who.bold(),
                row.intent,
                kind.dimmed(),
            );
        }
        if let Some(proof) = &entry.proof {
            let line = match proof.verdict.as_str() {
                "verified" => {
                    format!("✓ Proven {}/{}", proof.ok, proof.total).green().to_string()
                }
                "partial" => {
                    format!("◐ Almost {}/{}", proof.ok, proof.total).yellow().to_string()
                }
                _ => "· Not wired".dimmed().to_string(),
            };
            println!("         {}", line);
        }
    }
    Ok(())
}

fn run_verify(
    range: Option<&str>,
    strict: bool,
    json: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let repo = open_repo()?;
    let report = notes::verify_range(&repo, range)?;

    if json {
        println!("{}", serde_json::to_string_pretty(&report)?);
    } else {
        if report.per_commit.is_empty() {
            println!("no commits to verify in range");
        }
        for c in &report.per_commit {
            let intent_mark = if c.has_intent {
                "intent".green()
            } else {
                "no-intent".dimmed()
            };
            let proof_mark = match &c.proof {
                Some(p) if c.binding_ok => match p.verdict.as_str() {
                    "verified" => format!("✓ proven {}/{}", p.ok, p.total).green(),
                    "partial" => format!("◐ partial {}/{}", p.ok, p.total).yellow(),
                    _ => "· not wired".dimmed(),
                },
                Some(_) => "✗ proof mis-bound".red(),
                None => "· unproven".dimmed(),
            };
            println!(
                "{}  {}  {} · {}",
                c.short.yellow(),
                c.summary,
                intent_mark,
                proof_mark,
            );
        }
        for issue in &report.issues {
            println!("  {} {}", "✗".red(), issue);
        }
        println!(
            "{} {} commits · {} with intent · {} proven",
            "meta verify".bold(),
            report.commits,
            report.intent_covered,
            report.proven,
        );
        if !report.ok {
            println!("  {} binding issues found — see above", "✗".red());
        }
    }

    if !report.ok {
        return Err(format!(
            "verify failed: {} commit(s) carry a mis-bound proof note",
            report.issues.len()
        )
        .into());
    }
    if strict {
        let unproven = report.commits.saturating_sub(report.proven);
        if unproven > 0 {
            return Err(format!(
                "verify --strict: {} of {} commit(s) lack a proof note",
                unproven, report.commits
            )
            .into());
        }
    }
    Ok(())
}
