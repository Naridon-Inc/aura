//! `aura env` — declare an environment, seal it, and make a machine be it.
//!
//! The human end of the same spec `aura work`, the crew runner and the desktop
//! app all read. Five verbs, and the shape of them is the argument:
//!
//! ```text
//!   aura env show      what this project declares, and how far this box is from it
//!   aura env sign      seal it, so a machine can tell a reviewed spec from an edit
//!   aura env verify    check the seal, and say who it belongs to
//!   aura env apply     bring this checkout to it
//!   aura env down      take the declared services back down
//! ```
//!
//! `show` measures rather than recites. Printing back the TOML somebody just
//! wrote is worth nothing; running every check against the machine you are
//! standing on and saying which four things are missing is the whole point, and
//! it is safe to do at any time because an observing run never applies anything.
//!
//! `sign` publishes the signing key into `.aura/team/keys.jsonl` on the way
//! past, because a seal nobody can attribute is only half of the claim. That
//! registry is the same one signed intent blocks resolve through, so an
//! environment and an intent are vouched for by one identity rather than two.

use std::path::{Path, PathBuf};
use std::process::Command;

use colored::Colorize;
use serde_json::json;
use time::OffsetDateTime;

use crate::worktree_scripts;
use aura_env::{EnvReport, EnvSpec, Scope, StepState, TrustState};

#[derive(clap::Subcommand)]
pub enum EnvSubcommands {
    /// What this project declares, and how far this machine is from it.
    /// Runs every check; changes nothing.
    Show {
        /// Only the machine's own state — skip the project's `[worktree] setup`.
        #[arg(long)]
        no_deps: bool,
        #[arg(long)]
        json: bool,
    },
    /// Seal the declared environment into `.aura/env.lock.json` and publish the
    /// signing key, so teammates and machines can tell a reviewed spec from an
    /// edit. Commit both files.
    Sign {
        #[arg(long)]
        json: bool,
    },
    /// Check the seal against what `.aura/settings.toml` says now.
    /// Exits 1 when a place would refuse to apply it.
    Verify {
        #[arg(long)]
        json: bool,
    },
    /// Bring this checkout to the declared environment.
    Apply {
        /// Only the machine's own state — skip the project's `[worktree] setup`.
        #[arg(long)]
        no_deps: bool,
        /// Apply a spec whose seal is stale or broken. Read the diff first.
        #[arg(long)]
        force: bool,
        #[arg(long)]
        json: bool,
    },
    /// Stop the declared services, then run `[worktree] archive`.
    Down {
        #[arg(long)]
        json: bool,
    },
}

pub fn handle(sub: &EnvSubcommands) -> Result<(), Box<dyn std::error::Error>> {
    let root = repo_root()?;
    match sub {
        EnvSubcommands::Show { no_deps, json } => show(&root, scope(*no_deps), *json),
        EnvSubcommands::Sign { json } => sign(&root, *json),
        EnvSubcommands::Verify { json } => verify(&root, *json),
        EnvSubcommands::Apply {
            no_deps,
            force,
            json,
        } => apply(&root, scope(*no_deps), *force, *json),
        EnvSubcommands::Down { json } => down(&root, *json),
    }
}

fn scope(no_deps: bool) -> Scope {
    if no_deps {
        Scope::Environment
    } else {
        Scope::Full
    }
}

// ─── show ──────────────────────────────────────────────────────────────────

fn show(root: &Path, scope: Scope, json: bool) -> Result<(), Box<dyn std::error::Error>> {
    let (spec, trust) = worktree_scripts::declared(root)?;
    let report = worktree_scripts::observe(root, root, scope, &[])?;

    if json {
        println!(
            "{}",
            json!({
                "spec": spec,
                "digest": spec.digest()?,
                "trust": trust,
                "state": report,
            })
        );
        return Ok(());
    }

    println!();
    println!("  {}", "Declared environment".bold());
    println!("  {}", "─".repeat(52).dimmed());
    if spec.is_empty() {
        println!("  {}", "this project declares nothing yet".dimmed());
        println!();
        println!("  {}", "add an [env] table to .aura/settings.toml:".dimmed());
        println!("{}", EXAMPLE.dimmed());
        return Ok(());
    }
    println!(
        "  {}  {}",
        "spec  ".dimmed(),
        format!("v{}  {}", spec.version, short(&spec.digest()?)).bold()
    );
    println!("  {}  {}", "seal  ".dimmed(), trust_line(&trust));
    println!();
    print_report(&report);
    Ok(())
}

const EXAMPLE: &str = r#"
      [env]
      version = 1

      [env.toolchain]
      manager = "mise"
      node    = "20.11.0"

      [[env.package]]
      manager = "cargo"
      name    = "cargo-nextest"

      [[env.service]]
      name  = "postgres"
      start = "docker compose up -d db"
      ready = "pg_isready -h 127.0.0.1"
      stop  = "docker compose down"
"#;

// ─── sign ──────────────────────────────────────────────────────────────────

fn sign(root: &Path, json: bool) -> Result<(), Box<dyn std::error::Error>> {
    let spec = aura_env::load_checked(root)?;
    if !spec.declares_environment() {
        return Err(
            "nothing to seal — this project declares no [env] toolchains, packages or services"
                .into(),
        );
    }

    let key_path = crate::manifest_sig::default_signing_key_path()?;
    let key = aura_attestation::load_or_create(&key_path)
        .map_err(|e| format!("load signing key: {e}"))?;
    let now = OffsetDateTime::now_utc().unix_timestamp();
    let lock = aura_env::sign_spec(&spec, &key, now)?;
    let path = aura_env::write_lock(root, &lock)?;

    // A seal nobody can attribute is half a claim, so the key goes into the
    // git-tracked registry on the way past — the same one intent blocks use.
    let published = crate::intent_block::publish_self_to_registry(&key, None, now);

    if json {
        println!(
            "{}",
            json!({
                "lock": path.display().to_string(),
                "digest": lock.digest,
                "version": lock.spec.version,
                "key_id": lock.signature.key_id,
                "key_published": published.is_some(),
            })
        );
        return Ok(());
    }

    println!();
    println!("{} {}", "✓ sealed".green().bold(), format!("v{}", spec.version).bold());
    println!("  {}  {}", "digest".dimmed(), short(&lock.digest));
    println!("  {}  {}", "key   ".dimmed(), lock.signature.key_id.dimmed());
    println!("  {}  {}", "lock  ".dimmed(), rel(root, &path).dimmed());
    println!();
    println!(
        "  {}",
        "commit .aura/env.lock.json and .aura/team/keys.jsonl so every place can verify it"
            .dimmed()
    );
    println!();
    Ok(())
}

// ─── verify ────────────────────────────────────────────────────────────────

fn verify(root: &Path, json: bool) -> Result<(), Box<dyn std::error::Error>> {
    let (spec, trust) = worktree_scripts::declared(root)?;
    if json {
        println!(
            "{}",
            json!({
                "trust": trust,
                "digest": spec.digest()?,
                "version": spec.version,
                "may_apply": trust.may_apply(),
            })
        );
    } else {
        println!();
        println!("  {}  {}", "seal".dimmed(), trust_line(&trust));
        println!();
    }
    if !trust.may_apply() {
        std::process::exit(1);
    }
    Ok(())
}

// ─── apply ─────────────────────────────────────────────────────────────────

fn apply(
    root: &Path,
    scope: Scope,
    force: bool,
    json: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let report = worktree_scripts::bring_to_spec(root, root, scope, json, &[], force)?;
    if json {
        println!("{}", serde_json::to_string(&report)?);
    } else {
        println!();
        print_report(&report);
    }
    if !report.at_spec {
        std::process::exit(1);
    }
    Ok(())
}

// ─── down ──────────────────────────────────────────────────────────────────

fn down(root: &Path, json: bool) -> Result<(), Box<dyn std::error::Error>> {
    let stopped = worktree_scripts::teardown(root, root, json, &[])?;
    if json {
        println!("{}", json!({ "stopped": stopped }));
    } else {
        println!("{} {} command(s)", "✓ down".green().bold(), stopped);
    }
    Ok(())
}

// ─── rendering ─────────────────────────────────────────────────────────────

/// One line per step, then the verdict. Shared with `aura work`, which warms a
/// fresh worktree through the same spec and should report it the same way — two
/// renderers would drift into two vocabularies for one thing.
pub(crate) fn print_report(report: &EnvReport) {
    for step in &report.steps {
        let (mark, note) = match step.state {
            StepState::AlreadyAtSpec => ("✓".green(), "already".dimmed().to_string()),
            StepState::Brought => ("✓".green(), "brought".cyan().to_string()),
            StepState::Unsatisfied => ("·".yellow(), step.detail.clone().yellow().to_string()),
            StepState::Failed => ("✗".red(), step.detail.clone().red().to_string()),
        };
        println!(
            "  {} {:<34} {:<10} {}",
            mark,
            step.title,
            step.kind.as_str().dimmed(),
            note
        );
    }
    println!();
    println!(
        "  {}",
        if report.at_spec {
            report.summary().green().to_string()
        } else {
            report.summary().yellow().to_string()
        }
    );
    println!();
}

fn trust_line(trust: &TrustState) -> String {
    match trust {
        TrustState::Verified { .. } => trust.describe().green().to_string(),
        TrustState::SelfSigned { .. } => trust.describe().cyan().to_string(),
        TrustState::Unsigned => trust.describe().dimmed().to_string(),
        TrustState::Stale { .. } | TrustState::Invalid { .. } => {
            trust.describe().red().bold().to_string()
        }
    }
}

fn short(digest: &str) -> String {
    digest
        .trim_start_matches("sha256:")
        .chars()
        .take(12)
        .collect()
}

fn rel(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .display()
        .to_string()
}

fn repo_root() -> Result<PathBuf, Box<dyn std::error::Error>> {
    let out = Command::new("git")
        .args(["rev-parse", "--show-toplevel"])
        .output()?;
    if !out.status.success() {
        return Err("not inside a git repository — run `git init` (or `aura init`) first".into());
    }
    Ok(PathBuf::from(
        String::from_utf8_lossy(&out.stdout).trim().to_string(),
    ))
}

/// Spec-shaped helper for callers that want the declared spec without a
/// verdict — the crew runner announcing what each worktree will be warmed to.
pub fn declared_spec(root: &Path) -> EnvSpec {
    worktree_scripts::spec(root)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scope_defaults_to_everything_and_narrows_on_request() {
        assert_eq!(scope(false), Scope::Full);
        assert_eq!(scope(true), Scope::Environment);
    }

    #[test]
    fn a_digest_is_shown_short_enough_to_read_aloud() {
        assert_eq!(short("sha256:0123456789abcdef00"), "0123456789ab");
    }

    #[test]
    fn every_verdict_renders_and_says_something_actionable() {
        for t in [
            TrustState::Unsigned,
            TrustState::SelfSigned {
                key_id: "did:aura:key/abc".into(),
            },
            TrustState::Verified {
                key_id: "did:aura:key/abc".into(),
                signer: Some("Ashiq".into()),
            },
            TrustState::Stale {
                sealed: "sha256:aa".into(),
                actual: "sha256:bb".into(),
            },
            TrustState::Invalid {
                detail: "bad".into(),
            },
        ] {
            assert!(!trust_line(&t).is_empty());
        }
    }

    #[test]
    fn sealing_a_project_that_declares_nothing_is_refused_with_a_reason() {
        let dir = std::env::temp_dir()
            .join(format!("aura-env-cmd-empty-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(".aura")).unwrap();
        std::fs::write(
            dir.join(".aura").join("settings.toml"),
            "[worktree]\nsetup = \"npm ci\"\n",
        )
        .unwrap();
        let err = sign(&dir, true).unwrap_err().to_string();
        assert!(err.contains("nothing to seal"), "{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
