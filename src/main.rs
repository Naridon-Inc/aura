#![recursion_limit = "512"]
mod models;
mod parser;
mod hook;
mod enable;
mod checkpoint;
mod watcher;
mod server;
mod mcp;
mod arbitrator;
mod task;
mod aura_loop_run;
mod loop_accept;
mod loop_stranded;
mod loop_worktree;
mod runner;
mod runner_creds;
mod runner_limits;
mod runner_service;
mod env_cmd;
mod egress_cmd;
mod work;
mod worktree_scripts;
mod repo_settings;
mod board;
mod goals;
mod activity;
mod stub;
pub mod config;
mod ecosystem;
mod lsp;
mod gsd;
mod pr;
pub mod orchestrate;
mod symphony;
mod linear;
mod exporter;
mod security;
mod sync;
mod session;
mod plugin;
mod plugins;
mod cmd_plugin_dev;
mod cmd_plugin_marketplace;
mod live_events;
mod live_sync;
mod live_conflicts;
mod agents;
mod awareness;
mod worktree;

/// Shared serial lock for tests that mutate the process-global current
/// directory (the CRDT and conflict stores are cwd-relative). Tests in
/// different modules must lock the *same* mutex or they race on cwd.
#[cfg(test)]
pub(crate) static TEST_CWD_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
mod sentinel;
mod embeddings;
mod memory;
mod usage;
mod usage_by_dev;
mod plan_tracker;
mod host;
mod host_db;
mod responder;
mod build_verify;
mod cloud_connect;
mod cloud_join;
mod cloud_zones;
mod crdt;
mod crdt_daemon;
mod crdt_kind;
mod live_transport;
mod crypto;
mod daemon_install;
mod keys_cmd;
mod live_ws;
mod outbox;
mod pr_cmd;
mod resolve;
mod callgraph;
mod entrypoints;
mod impact;
mod change_note;
mod atlas;
mod distill;
mod acp_client;
mod acp_server;
mod manifest_sig;
mod rekor;
mod intent_block;
mod intent_reconcile;
mod deletion_guard;
// Keeps the pre-commit gates from wedging a commit: prompts that never block
// when nobody can answer, and a time ceiling that works without `timeout(1)`.
mod hook_guard;
// `team_keys` now lives in the shared `aura-attestation` crate so non-CLI
// binaries (the desktop shell) can verify registry self-signatures too.
// Re-exported at the old path so every `crate::team_keys::…` call site here
// keeps working unchanged.
pub use aura_attestation::team_keys;
mod block_adapter;
mod episodic;
mod recall_narrate;
mod intent_query;
mod intent_vs_actual;
// Staged intent verification — the approved contract recorded BEFORE the agent
// runs, compared against the git index while the work is still staged. This is
// the gate `ci.rs` cannot be: its intent fact needs a commit that does not
// exist yet at pre-commit time.
mod verify_intent;
mod subagent;
mod ask_user;
mod propose_plan;
mod taste;
mod cmd_taste;
// Semantic CI — gathers the GateContext (staged AstNodes, goal/intent/taste
// facts, the build_verify runner) and drives the aura-ci pipeline engine.
mod ci;
mod validate_tool;
mod skill_rank;
mod skills;
mod replay;
mod review;
mod doctor;
mod continuity;
mod meta_refs;
mod node;
mod git_remote_aura_helper;
mod push_credential;
mod repo_identity;
mod meta_bundle;
mod refs_sign;
mod merge_driver;
mod text;

use clap::{Parser, Subcommand};
use parser::SemanticParser;
use hook::HookInstaller;
use checkpoint::{CheckpointStore, CheckpointData};
use watcher::ContinuousTracker;
use mcp::McpServer;
use arbitrator::Arbitrator;
use stub::StubEngine;
use git2::Repository;
use std::fs::{self, OpenOptions};
use std::path::Path;
use std::io::Write;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use uuid::Uuid;

use colored::Colorize;
use indicatif::{ProgressBar, ProgressStyle};
use textwrap;
use dialoguer::{theme::ColorfulTheme, MultiSelect, Password, Confirm};
use config::ConfigManager;

// Anonymous Telemetry & Crash Reporting
// Respects: config.telemetry_enabled, AURA_TELEMETRY_OPTOUT env var, DO_NOT_TRACK env var
fn is_telemetry_enabled() -> bool {
    // Environment variable opt-out takes highest priority (industry standard)
    if std::env::var("AURA_TELEMETRY_OPTOUT").is_ok() {
        return false;
    }
    // Respect the universal DO_NOT_TRACK convention
    if std::env::var("DO_NOT_TRACK").ok().as_deref() == Some("1") {
        return false;
    }
    let config = ConfigManager::load();
    config.telemetry_enabled
}

/// Generate an anonymous, stable machine ID (hashed, not PII)
fn anonymous_machine_id() -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let mut hasher = DefaultHasher::new();

    // Use hostname + username as machine fingerprint (hashed for privacy)
    if let Ok(hostname) = std::env::var("HOSTNAME")
        .or_else(|_| std::env::var("COMPUTERNAME"))
        .or_else(|_| {
            std::process::Command::new("hostname")
                .output()
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        })
    {
        hostname.hash(&mut hasher);
    }
    if let Ok(user) = std::env::var("USER").or_else(|_| std::env::var("USERNAME")) {
        user.hash(&mut hasher);
    }

    format!("anon_{:016x}", hasher.finish())
}

fn track_event(event_name: &str, metadata: Option<&str>) {
    if !is_telemetry_enabled() {
        return;
    }

    let os = std::env::consts::OS;
    let arch = std::env::consts::ARCH;
    let version = CURRENT_VERSION;
    let machine_id = anonymous_machine_id();
    let payload = serde_json::json!({
        "event": event_name,
        "os": os,
        "arch": arch,
        "version": version,
        "machine_id": machine_id,
        "metadata": metadata.unwrap_or("none")
    });

    // Fire and forget in a detached background thread so it never blocks the user
    thread::spawn(move || {
        let client = reqwest::blocking::Client::builder().timeout(Duration::from_secs(3)).build().unwrap();
        let _ = client.post("http://api.auravcs.com/telemetry")
            .json(&payload)
            .send();
    });
}

// PostHog EU crash ingestion — mirrors aura-shell/src-tauri/src/telemetry.rs so
// the desktop app and its bundled CLI report crashes into the *same* project,
// under the same anonymous person, instead of the CLI's old homegrown endpoint.
// The token is a public, write-only capture key: safe to bake into the shipped
// binary, never committed to source. Runtime env wins (dev), else the value
// baked at build time via `option_env!` (release builds export it from
// ~/.aura-posthog.env). Absent → a silent no-op (contributors can still build).
fn posthog_key() -> Option<String> {
    if let Ok(k) = std::env::var("AURA_POSTHOG_KEY") {
        let k = k.trim().to_string();
        if !k.is_empty() {
            return Some(k);
        }
    }
    option_env!("AURA_POSTHOG_KEY")
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn posthog_host() -> String {
    if let Ok(h) = std::env::var("AURA_POSTHOG_HOST") {
        let h = h.trim().to_string();
        if !h.is_empty() {
            return h;
        }
    }
    option_env!("AURA_POSTHOG_HOST")
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "https://eu.i.posthog.com".to_string())
}

/// The PostHog `distinct_id` for crash events. Reuses the desktop app's device
/// id (`~/.aura/device.json`) when present so a user's CLI and app crashes land
/// on the same PostHog person; falls back to the hashed machine fingerprint.
/// Fully panic-safe — every fallible step degrades to the fallback.
fn posthog_distinct_id() -> String {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_default();
    if !home.is_empty() {
        let path = std::path::Path::new(&home).join(".aura").join("device.json");
        if let Ok(raw) = std::fs::read_to_string(&path) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
                if let Some(id) = v.get("device_id").and_then(|x| x.as_str()) {
                    let id = id.trim();
                    if !id.is_empty() {
                        return id.to_string();
                    }
                }
            }
        }
    }
    anonymous_machine_id()
}

/// Best-effort crash report to PostHog EU. Called from *inside* the panic hook,
/// so it must NEVER itself panic: consent-gated, and every fallible step
/// early-returns rather than unwrapping. A silent no-op without consent or a
/// baked key.
fn report_crash_to_posthog(message: &str) {
    if !is_telemetry_enabled() {
        return;
    }
    let Some(key) = posthog_key() else {
        return;
    };
    let host = posthog_host();
    let payload = serde_json::json!({
        "api_key": key,
        "event": "crash",
        "distinct_id": posthog_distinct_id(),
        "properties": {
            "source": "cli",
            "os": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
            "cli_version": CURRENT_VERSION,
            "message": message,
        }
    });
    let Ok(client) = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
    else {
        return;
    };
    let _ = client.post(format!("{host}/capture/")).json(&payload).send();
}

fn setup_crash_reporter() {
    std::panic::set_hook(Box::new(|info| {
        let msg = match info.payload().downcast_ref::<&'static str>() {
            Some(s) => *s,
            None => match info.payload().downcast_ref::<String>() {
                Some(s) => &s[..],
                None => "Box<dyn Any>",
            },
        };

        // Report the crash to PostHog EU (consent-gated, panic-safe). This used
        // to POST the old `api.auravcs.com/telemetry` endpoint — which now just
        // 301-redirects HTTP→HTTPS and silently drops the body, so CLI crashes
        // vanished and never reached our analytics. PostHog is where every other
        // Aura event already lands, so they're finally visible alongside them.
        // (The old path also `.unwrap()`ed the client builder — itself a panic
        // inside the panic hook; `report_crash_to_posthog` early-returns instead.)
        report_crash_to_posthog(msg);

        // The panic hook must never itself panic. `println!` writes to stdout and
        // panics on a broken pipe (EPIPE) — and a parent that captured our stdout
        // then exited is exactly when we land here. A second panic inside the hook
        // is fatal: std aborts ("panicked while panicking") → SIGABRT → a macOS
        // crash report. Write the notice to stderr through a fallible `writeln!`
        // whose error we deliberately swallow, so a dead pipe can never abort us.
        use std::io::Write as _;
        let mut err = std::io::stderr();
        let _ = writeln!(err, "\n{} {} {}", "💥".bold(), "Aura encountered a fatal anomaly:".bold().red(), msg);
        let _ = writeln!(err, "  {} If this persists, please report it at https://github.com/Naridon-Inc/aura/issues", "↳".dimmed());
    }));
}

fn capture_env_fingerprint() -> Option<String> {
    ecosystem::Ecosystem::fingerprint()
}

// Single source of truth: the crate version in Cargo.toml. Bump it (and
// every other component) with `scripts/set-version.sh <ver>` so `aura
// --version`, the self-update check, and the desktop bundle never drift.
const CURRENT_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Build an HTTP client that respects accept_self_signed for mothership TLS.
pub(crate) fn cloud_http_client() -> reqwest::blocking::Client {
    let config = ConfigManager::load();
    let mut builder = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(10));
    if config.accept_self_signed {
        builder = builder.danger_accept_invalid_certs(true);
    }
    builder.build().unwrap_or_else(|_| reqwest::blocking::Client::new())
}

fn check_for_updates() -> Option<String> {
    let client = reqwest::blocking::Client::builder()
        .user_agent("aura-cli-updater")
        .build().ok()?;

    let res = client.get("https://api.github.com/repos/Naridon-Inc/aura/releases/latest")
        .send().ok()?;    
    let json: serde_json::Value = res.json().ok()?;
    let latest_version = json["tag_name"].as_str()?.trim_start_matches('v').to_string();
    
    if latest_version != CURRENT_VERSION {
        Some(latest_version)
    } else {
        None
    }
}

fn run_passive_update_check() {
    let mut config = ConfigManager::load();
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    
    // Check every 24 hours (86400 seconds)
    if now - config.last_update_check > 86400 {
        config.last_update_check = now;
        let _ = ConfigManager::save(&config);
        
        // Spawn a background thread to check so we don't block the user
        thread::spawn(|| {
            if let Some(new_version) = check_for_updates() {
                println!("\n{} A new version of Aura ({}) is available!", "ℹ️ ".blue().bold(), new_version.cyan());
                println!("   Run {} to upgrade instantly.\n", "aura update".italic().bold());
            }
        });
    }
}

fn perform_update() -> Result<(), Box<dyn std::error::Error>> {
    println!("{} Checking for latest release...", "📡".bold());
    
    if let Some(new_version) = check_for_updates() {
        println!("{} Update available: {} -> {}", "🚀".bold(), CURRENT_VERSION.yellow(), new_version.green());
        
        let confirm = Confirm::with_theme(&ColorfulTheme::default())
            .with_prompt("Do you want to download and install the update?")
            .interact()?;
            
        if confirm {
            let asset_os = if cfg!(target_os = "linux") { "linux" } 
                          else if cfg!(target_os = "macos") { "darwin" } 
                          else if cfg!(target_os = "windows") { "windows" } 
                          else { return Err("Unsupported OS".into()) };
            
            let asset_arch = if cfg!(target_arch = "x86_64") { "amd64" }
                            else if cfg!(target_arch = "aarch64") { "arm64" }
                            else { return Err("Unsupported architecture".into()) };
            
            let bin_ext = if cfg!(target_os = "windows") { ".exe" } else { "" };
            let asset_name = format!("aura-{}-{}{}", asset_os, asset_arch, bin_ext);
            let download_url = format!("https://github.com/Naridon-Inc/aura/releases/download/v{}/{}", new_version, asset_name);
            
            println!("{} Downloading binary from {}...", "⬇️ ".bold(), download_url.dimmed());
            
            let client = reqwest::blocking::Client::new();
            let mut response = client.get(&download_url).send()?;
            
            if !response.status().is_success() {
                return Err(format!("Failed to download update: HTTP {}", response.status()).into());
            }
            
            let current_exe = std::env::current_exe()?;
            let tmp_exe = current_exe.with_extension("tmp");

            // EPERM here almost always means the binary lives in a
            // root-owned path (/usr/local/bin, /opt/homebrew/bin). Give
            // a useful hint instead of raw `Os { code: 13 }`.
            let mut file = fs::File::create(&tmp_exe).map_err(|e| {
                if e.kind() == std::io::ErrorKind::PermissionDenied {
                    format!(
                        "Cannot write to {} — the aura binary is in a root-owned directory.\n   Re-run with: sudo aura update",
                        tmp_exe.display()
                    )
                } else {
                    format!("Failed to create temp file {}: {}", tmp_exe.display(), e)
                }
            })?;
            std::io::copy(&mut response, &mut file)?;

            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mut perms = fs::metadata(&tmp_exe)?.permissions();
                perms.set_mode(0o755);
                fs::set_permissions(&tmp_exe, perms)?;
            }

            fs::rename(&tmp_exe, &current_exe).map_err(|e| {
                if e.kind() == std::io::ErrorKind::PermissionDenied {
                    let _ = fs::remove_file(&tmp_exe);
                    format!(
                        "Cannot replace {} — the aura binary is in a root-owned directory.\n   Re-run with: sudo aura update",
                        current_exe.display()
                    )
                } else {
                    format!("Failed to install new binary: {}", e)
                }
            })?;

            // Re-sign on macOS to prevent SIGKILL from invalid adhoc signature
            #[cfg(target_os = "macos")]
            {
                let _ = std::process::Command::new("codesign")
                    .args(["--force", "--sign", "-"])
                    .arg(&current_exe)
                    .output();
            }

            println!("{} Aura updated successfully to v{}!", "✓".green().bold(), new_version);

            // Refresh integrations (CLAUDE.md, hooks) in current repo
            refresh_integrations();
            // Install/update status line on every update
            install_claude_statusline();
        }
    } else {
        println!("{} Aura is already up to date (v{}).", "✓".green().bold(), CURRENT_VERSION);

        // Still refresh integrations in case the template changed
        refresh_integrations();
        install_claude_statusline();
    }
    Ok(())
}

/// Refresh CLAUDE.md and other integration files with the latest Aura block.
/// Called after `aura update` and can be called standalone.
fn refresh_integrations() {
    let claude_md_path = std::path::Path::new("CLAUDE.md");
    let aura_block = include_str!("../integrations/claude-md-block.md");

    if claude_md_path.exists() {
        if let Ok(existing) = fs::read_to_string(claude_md_path) {
            // Replace existing AURA block if present
            if existing.contains("<!-- AURA_START -->") && existing.contains("<!-- AURA_END -->") {
                if let (Some(start), Some(end)) = (
                    existing.find("<!-- AURA_START -->"),
                    existing.find("<!-- AURA_END -->"),
                ) {
                    let end = end + "<!-- AURA_END -->".len();
                    // Check if there's a trailing newline after the end marker
                    let end = if existing[end..].starts_with('\n') { end + 1 } else { end };
                    let updated = format!("{}{}{}", &existing[..start], aura_block, &existing[end..]);
                    let _ = fs::write(claude_md_path, updated);
                    println!("{} CLAUDE.md refreshed with latest Aura tools.", "✓".green().bold());
                }
            } else if !existing.contains("aura_log_intent") {
                // No Aura block at all — append
                let updated = format!("{}\n\n{}", existing, aura_block);
                let _ = fs::write(claude_md_path, updated);
                println!("{} Aura instructions appended to CLAUDE.md.", "✓".green().bold());
            } else {
                println!("{} CLAUDE.md already has Aura instructions (no markers found to auto-update).", "ℹ".blue());
            }
        }
    }

    // Refresh .gemini and other agent instruction files if they exist
    let gemini_md_path = std::path::Path::new("GEMINI.md");
    if gemini_md_path.exists() {
        if let Ok(existing) = fs::read_to_string(gemini_md_path) {
            if existing.contains("<!-- AURA_START -->") && existing.contains("<!-- AURA_END -->") {
                if let (Some(start), Some(end)) = (
                    existing.find("<!-- AURA_START -->"),
                    existing.find("<!-- AURA_END -->"),
                ) {
                    let end = end + "<!-- AURA_END -->".len();
                    let end = if existing[end..].starts_with('\n') { end + 1 } else { end };
                    let updated = format!("{}{}{}", &existing[..start], aura_block, &existing[end..]);
                    let _ = fs::write(gemini_md_path, updated);
                    println!("{} GEMINI.md refreshed with latest Aura tools.", "✓".green().bold());
                }
            }
        }
    }

    // Ensure .aura/.gitignore exists — keep intents + memory in git, ignore runtime state
    ensure_aura_gitignore();
}

/// Create .aura/.gitignore to track only intents and memory in git.
/// Everything else (snapshots, sessions, sentinel, transcripts) is local runtime state.
pub(crate) fn ensure_aura_gitignore() {
    let aura_dir = std::path::Path::new(".aura");
    if !aura_dir.exists() {
        return;
    }

    let gitignore_path = aura_dir.join(".gitignore");
    let desired = "\
# Aura: track intents + project memory in git, ignore local runtime state
#
# TRACKED (committed to git for team context):
#   .gitignore        — so all devs share the same ignore rules
#   intent_log.jsonl  — why changes were made (links to git commits)
#   memory.json       — project knowledge (architecture, decisions, gotchas)
#
# IGNORED (local per-machine state):
snapshots/
sessions/
transcripts/
sentinel/
tracker/
reviews/
plans/
orchestrate/
worktrees/
live/
.intent_logged
last_review.json
";

    // Write if missing or outdated
    let needs_update = if let Ok(existing) = fs::read_to_string(&gitignore_path) {
        !existing.contains("orchestrate/")  // old version without orchestrate
    } else {
        true
    };

    if needs_update {
        let _ = fs::write(&gitignore_path, desired);
    }
}

/// Install Aura status line script for Claude Code.
/// Writes ~/.claude/aura-statusline.sh and adds statusLine to ~/.claude/settings.json
fn install_claude_statusline() {
    let home = match std::env::var("HOME") {
        Ok(h) => h,
        Err(_) => return,
    };

    let script_path = format!("{}/.claude/aura-statusline.sh", home);
    let settings_path = format!("{}/.claude/settings.json", home);

    // Write the status line script
    let script = include_str!("../integrations/aura-statusline.sh");
    let _ = fs::write(&script_path, script);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&script_path, fs::Permissions::from_mode(0o755));
    }

    // Always set statusLine to Aura's script — create settings.json if needed
    let content = fs::read_to_string(&settings_path).unwrap_or_else(|_| "{}".to_string());
    let mut settings = serde_json::from_str::<serde_json::Value>(&content)
        .unwrap_or_else(|_| serde_json::json!({}));

    let aura_cmd = "bash $HOME/.claude/aura-statusline.sh";
    let current_cmd = settings.get("statusLine")
        .and_then(|s| s.get("command"))
        .and_then(|c| c.as_str())
        .unwrap_or("");

    if current_cmd == aura_cmd {
        // Already pointing to our script — just updated the file above
        println!("    {} Aura status line updated.", "✓".green());
        return;
    }

    // Log what we're replacing so users can debug
    if !current_cmd.is_empty() {
        println!("    {} Replacing existing status line: {}", "ℹ".blue(), current_cmd.dimmed());
    }

    // Overwrite whatever was there — our script is the status line
    settings["statusLine"] = serde_json::json!({
        "type": "command",
        "command": aura_cmd
    });
    if let Ok(updated) = serde_json::to_string_pretty(&settings) {
        let claude_dir = format!("{}/.claude", home);
        let _ = fs::create_dir_all(&claude_dir);
        let _ = fs::write(&settings_path, updated);
        println!("    {} Aura status line installed for Claude Code.", "✓".green());
        return;
    }
}

#[derive(Parser)]
#[command(
    name = "aura",
    about = "🌌 Aura: The Semantic Time Machine for AI-Native Engineering

    Aura tracks mathematical logic instead of textual lines, allowing you to mathematically
    verify AI intent, surgically rewind hallucinations, and coordinate massive code generation.",
    version = CURRENT_VERSION,    styles = clap::builder::Styles::styled()
        .header(clap::builder::styling::AnsiColor::Cyan.on_default().bold())
        .usage(clap::builder::styling::AnsiColor::Cyan.on_default().bold())
        .literal(clap::builder::styling::AnsiColor::Blue.on_default().bold())
        .placeholder(clap::builder::styling::AnsiColor::Cyan.on_default())
)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
    /// Enable accessible output mode (no emojis, no colors, screen-reader-friendly)
    #[arg(long, global = true)]
    accessible: bool,
}

#[derive(Subcommand)]
enum Commands {
    /// Initialize Aura in this repository with an interactive setup wizard
    Init {
        /// Force a baseline scan of the entire project (bypasses intent check)
        #[arg(long)]
        force_baseline: bool,
    },
    /// Turn on passive semantic capture — the no-MCP, no-wizard drop-in.
    /// Installs Aura's git hooks so every commit records a semantic
    /// checkpoint (what changed, why, by which agent), working with whatever
    /// coding agent you already use. Idempotent; `aura init` is the full setup.
    Enable {
        /// Install silently (for scripts / CI) — skip the summary output.
        #[arg(long)]
        quiet: bool,
    },
    /// Turn off passive capture — removes Aura's git hooks. Non-destructive:
    /// your semantic history stays in git; run `aura enable` to resume.
    Disable,
    /// Plan an architectural objective and decompose into atomic waves
    Plan {
        /// The architectural objective to break down
        prompt: String,
    },
    /// Execute the currently planned milestone in atomic, AST-verified waves
    Execute,
    /// Surgically revert a specific function or class to a previous safe state
    Rewind {
        /// The name of the function or class to revert (e.g., "calculate_tax")
        identifier: String,
        /// The file containing the logic block
        file_path: String,
        /// Wipe the local AI chat history of this hallucination
        #[arg(long)]
        amnesia: bool,
    },
    /// Generate a dense, token-optimized XML context block to pass to another AI agent
    Handover {
        /// The target agent (e.g., "cursor", "aider")
        agent: String,
        /// Bucket M5 — Manager session id whose anchored + working
        /// chat should be embedded in the handover. Reads
        /// `~/.aura/manager-sessions/<id>.json` produced by the shell.
        /// When set, the XML carries `<manager_continuum>` so the next
        /// agent (claude → gemini, gemini → kimi) inherits identical
        /// memory: anchored turns + last K=24 working turns.
        #[arg(long, value_name = "ID")]
        manager_session: Option<String>,
    },
    /// View current gatekeeper status, semantic checkpoints, and configuration
    Status,
    /// Semantic CI — run, list, and export the declarative .aura/pipelines that
    /// orchestrate Aura's gates (secrets, half-finished code, goal-aligned,
    /// build). The same pipeline drives your local git hooks and the GitHub
    /// Action `aura ci export` generates.
    Ci {
        #[command(subcommand)]
        cmd: CiCmd,
    },
    /// Audit the Git history for unsanctioned code pushed without AI intent verification
    Audit,
    /// Explain the intent behind code — trace a function back to the AI conversation that created it
    Explain {
        /// Function or identifier name to explain
        identifier: String,
        /// File path containing the identifier
        file: String,
    },
    /// Spawn or list coding-agent subagents (used by the Aura Manager
    /// CLI brain to fan out via Bash). See `aura subagent --help`.
    Subagent {
        #[command(subcommand)]
        cmd: SubagentCmd,
    },
    /// (Bridge) Ask the user a question via the aura-shell QuestionCard
    /// UI. Used by the Aura Manager CLI brain so it can pause mid-turn
    /// for a real interactive answer instead of dumping a markdown bullet
    /// list. Requires AURA_MANAGER_SESSION_ID + an open shell socket.
    #[command(name = "ask-user")]
    AskUser {
        /// The question to render. Quote it.
        question: String,
        /// `choice` (single pick) | `multi_choice` (toggle several) | `text` (free input).
        #[arg(long, default_value = "choice")]
        kind: String,
        /// Comma-separated options (required unless --kind text).
        #[arg(long)]
        options: Option<String>,
    },
    /// (Bridge) Render an interactive PlanCard in aura-shell so the user
    /// can approve / cancel a multi-step plan before the Manager fans
    /// out subagents. Prints `build` or `cancel` on stdout for the
    /// brain's bash tool to read.
    #[command(name = "propose-plan")]
    ProposePlan {
        /// Full plan as a JSON object: `{ "title": "...", "summary": "...", "todos": [...] }`.
        /// Use `--json -` to read the envelope from stdin.
        #[arg(long, conflicts_with_all = ["title", "summary", "file"])]
        json: Option<String>,
        /// Path to a file containing the plan JSON envelope. Preferred when the
        /// envelope is large — sidesteps shell quoting / heredoc rejection by
        /// AI bash sandboxes that flag brace-with-quote patterns as expansion
        /// obfuscation.
        #[arg(long, conflicts_with_all = ["title", "summary", "json"])]
        file: Option<String>,
        /// Short-form: plan title.
        #[arg(long)]
        title: Option<String>,
        /// Short-form: plan summary (one paragraph).
        #[arg(long)]
        summary: Option<String>,
        /// Short-form: a single todo, format `description::agent` (agent optional).
        /// Pass `--todo` once per todo.
        #[arg(long = "todo", value_name = "DESCRIPTION[::AGENT]")]
        todos: Vec<String>,
    },
    /// List and manage agent sessions
    Sessions,
    /// Resume work. With a branch: switch to it and show its session
    /// context. With no branch: consume a cross-agent carryover that a
    /// previous brain injected into this repo's context file (the Track-A
    /// handoff `aura carryover --inject` wrote).
    Resume {
        /// Branch to resume (e.g., "feat/auth"). Omit to instead consume
        /// an injected `AURA:RESUME` carryover from the current repo.
        branch: Option<String>,
        /// No-branch mode only: print the injected carryover but leave it
        /// in place. Default consumes it so a one-shot handoff never
        /// lingers and re-triggers on the next launch.
        #[arg(long)]
        keep: bool,
    },
    /// Assemble a cross-agent carryover from Aura's semantic record (signed
    /// intent log, AST checkpoints, session, working tree) so a *different*
    /// brain (claude → gemini → kimi) resumes the work at the exact point.
    /// Shelled by the shell brain-swap (`--json`) and used for portable
    /// CLI handoff (`--inject --agent gemini` writes the target's context file).
    Carryover {
        /// Repo root to describe. Defaults to the current directory.
        #[arg(long, default_value = ".")]
        repo: String,
        /// How much conversation rides along: `full` (verbatim tail) or
        /// `semantic` (compact Aura-native reconstruction, short tail).
        #[arg(long, default_value = "semantic")]
        mode: String,
        /// The agent being handed to (gemini, kimi, cursor, …). Required
        /// for `--inject`; otherwise only sets the rendered header.
        #[arg(long)]
        agent: Option<String>,
        /// Intent-log lookback window in hours (≤0 disables the cutoff).
        #[arg(long, default_value_t = 48)]
        since_hours: i64,
        /// Emit the carryover as JSON (the shell-bridge IPC contract).
        #[arg(long)]
        json: bool,
        /// Write the carryover into the target agent's startup-context file
        /// (CLAUDE.md / GEMINI.md / KIMI.md / AGENTS.md) inside an idempotent
        /// AURA:RESUME marker section. Requires `--agent`.
        #[arg(long)]
        inject: bool,
        /// Skip secret redaction. LOCAL-ONLY escape hatch — only use when
        /// the carryover never leaves this machine (in-app brain-swap). By
        /// default credentials, private keys, and public IPs are scrubbed
        /// before the payload is emitted, since it may be handed to an
        /// external agent.
        #[arg(long)]
        no_redact: bool,
    },
    /// Diagnose and repair stuck sessions, orphaned data, and other issues
    Doctor {
        /// Emit a read-only structured JSON report instead of the
        /// interactive text output. JSON mode performs NO repairs
        /// (no force-end, no prune, no stale cleanup) — it only reports.
        #[arg(long)]
        json: bool,
    },
    /// Launch the Aura desktop shell (aura-shell — Tauri 2 superset of aura-term)
    Ui {
        /// Path to the aura-shell binary. Defaults to discovery via PATH then
        /// `<workspace>/aura-shell/src-tauri/target/release/aura-shell`.
        #[arg(long)]
        binary: Option<String>,
        /// Override the project directory the shell should open. Defaults to cwd.
        #[arg(long)]
        cwd: Option<String>,
    },
    /// Generate shell completions for bash, zsh, or fish
    Completions {
        /// Shell to generate completions for
        #[arg(value_enum)]
        shell: clap_complete::Shell,
    },
    /// Whitelist a specific logic node (e.g. Auth headers) for high-entropy secrets
    RequestAccess {
        /// The name of the function/class to exempt from Gatekeeper scrutiny
        identifier: String,
    },
    /// Manage global Aura configuration (telemetry, api keys)
    Config {
        #[command(subcommand)]
        sub: Option<ConfigSubcommands>,
    },
    /// Perform a high-fidelity semantic review of code changes against a base branch
    PrReview {
        /// The base branch to compare against (e.g., "main", "master")
        #[arg(short, long, default_value = "master")]
        base: String,
        /// Output the review report as a machine-readable JSON string
        #[arg(long)]
        json: bool,
        /// Show the full list of undocumented nodes instead of bucketing them
        #[arg(long)]
        verbose: bool,
    },
    /// Generate patch suggestions for architectural invariant violations (experimental)
    #[command(name = "suggest-fix", alias = "fix")]
    SuggestFix {
        /// The base branch to review against to find the violations
        #[arg(short, long, default_value = "master")]
        base: String,
    },
    /// Manage Architectural Invariant Policy Packs
    Policy {
        #[command(subcommand)]
        sub: PolicySubcommands,
    },
    /// Team task tickets — create, claim, assign, comment, close
    Task {
        #[command(subcommand)]
        sub: TaskSubcommands,
    },
    /// Crew — hand a stack of work to your agents and they do it on their own,
    /// in dependency order. `aura crew ready` is the Beads-grade "what can I
    /// work on now"; `aura crew add/dep` build the DAG; `aura crew run` is the
    /// autonomous runner. The legacy `aura loop ...` name still works as a
    /// hidden alias so nothing breaks.
    #[command(name = "crew", alias = "loop")]
    Loop {
        #[command(subcommand)]
        sub: LoopSubcommands,
    },
    /// Runner — turn an always-on box (a VPS, a home server) into a
    /// cloud-visible worker that keeps draining your crew backlog after you
    /// close the laptop. `aura runner register` mints its token; `aura runner
    /// serve` runs the supervise loop and heartbeats to the app.
    Runner {
        #[command(subcommand)]
        sub: RunnerSubcommands,
    },
    /// Git's credential helper, answering with a short-lived token minted for
    /// the member this box is acting for (`AURA_ACTING_MEMBER`) from the org's
    /// own GitHub App — scoped to the one repository being pushed, and never
    /// written to disk. Git invokes this; you rarely will.
    #[command(name = "git-credential", hide = true)]
    GitCredential {
        /// get | store | erase — git's own verbs. `store` is deliberately a
        /// no-op: keeping the token is what made it the box's credential
        /// instead of the member's.
        action: String,
    },
    /// Open isolated worktrees for parallel coding sessions (a second Claude
    /// Code, Codex, or your own hands), then merge each back AST-aware and
    /// recorded in the intent log — no branch-switching, no lost work.
    #[command(name = "work", alias = "wt")]
    Work {
        #[command(subcommand)]
        sub: work::WorkSubcommands,
    },
    /// Team activity feed — recent events emitted by the engine and tools
    Activity {
        #[command(subcommand)]
        sub: ActivitySubcommands,
    },
    /// Team Radar — live awareness of who (human or agent) is building what,
    /// why, and what it impacts, BEFORE a commit/PR. Bare `aura radar` shows the
    /// feed; `aura radar emit ...` announces in-flight work (used by agents).
    Radar {
        #[command(subcommand)]
        sub: Option<RadarSubcommands>,
        /// Only show events touching this path fragment or symbol.
        #[arg(long)]
        focus: Option<String>,
        /// Max events to show.
        #[arg(long)]
        limit: Option<usize>,
        #[arg(long)]
        json: bool,
    },
    /// Cross-worktree control plane — every checkout of this repo, which agent
    /// is in it, what each is holding, and where two of them are converging on
    /// the same symbol. Bare `aura worktrees` shows the board.
    Worktrees {
        #[command(subcommand)]
        sub: Option<WorktreeSubcommands>,
        #[arg(long)]
        json: bool,
        /// Skip the per-checkout working-tree read (dirty count, drift from
        /// trunk).
        #[arg(long)]
        no_git_status: bool,
        /// Include checkouts that are clean and have nobody working in them.
        #[arg(long)]
        all: bool,
    },
    /// Show the repo-local Ed25519 identity (`did:aura:key/...`) that signs your
    /// awareness events so they can't be spoofed by another actor.
    Identity {
        #[arg(long)]
        json: bool,
    },
    /// PR review inbox — list/show prior `pr-review --json` reports
    Review {
        #[command(subcommand)]
        sub: ReviewSubcommands,
    },
    /// Intent Inspector — compare a commit's stated intent against its
    /// actual AST delta. Powers the IntentInspector pane in aura-shell.
    IntentVsActual {
        #[command(subcommand)]
        sub: IntentVsActualSubcommands,
    },
    /// The approved intent contract — what an agent is authorised to change,
    /// recorded before it starts. approve / show / amend.
    IntentContract {
        #[command(subcommand)]
        sub: IntentContractSubcommands,
    },
    /// Verify the STAGED change against the approved intent contract. Exits
    /// non-zero when a protected or exported symbol was removed without
    /// approval — this is what blocks the commit.
    VerifyIntent {
        /// Compare against the git index (the default, and the only mode that
        /// can gate a commit that does not exist yet).
        #[arg(long, default_value_t = true)]
        staged: bool,
        #[arg(long)]
        json: bool,
    },
    /// Put one deleted symbol back from the approved baseline, stage it, and
    /// re-run verification. Leaves every other change the agent made intact.
    RestoreSymbol {
        /// The function/class name to restore.
        symbol: String,
        #[arg(long)]
        json: bool,
    },
    /// Meaning plane over the wire — mirror the intent log onto standard
    /// git notes (refs/notes/aura-intent) so WHO/WHY round-trips through
    /// any git host alongside the code. push / pull / log.
    Meta {
        #[command(subcommand)]
        sub: meta_refs::MetaSubcommands,
    },
    /// Signed canonical refs — endorse a branch tip with your repo-local
    /// Ed25519 identity and verify endorsements cryptographically, carried
    /// as standard git notes (refs/notes/aura-sigs). sign / verify / push / pull.
    Refs {
        #[command(subcommand)]
        sub: refs_sign::RefsSubcommands,
    },
    /// Aura-native repo identity — mint a stable, self-signed UUID for this
    /// repo (written to `.aura/repo.json`) so its cloud identity is anchored
    /// to Aura, not the GitHub name. Survives renames, org moves, mirrors, and
    /// forge-less self-hosting. init / show.
    #[command(name = "repo-id")]
    RepoId {
        #[command(subcommand)]
        sub: repo_identity::RepoIdSubcommands,
    },
    /// Self-hostable Aura git node — host repos over git smart-HTTP keyed by
    /// Aura repo id, so `git clone` / `git push` work with no GitHub. The
    /// substrate half of the sovereign-git track. serve / list.
    Node {
        #[command(subcommand)]
        sub: node::NodeSubcommands,
    },
    /// Portable signed meaning bundle — pack intent + goals + commit provenance
    /// into one JSON file that imports into any clone, verifiable offline.
    /// export / import.
    Bundle {
        #[command(subcommand)]
        sub: meta_bundle::BundleSubcommands,
    },
    /// Change Notes — per-file "what / why / where it affects" for a commit,
    /// derived from the AST diff + reverse call graph. No AI tokens. Powers the
    /// per-file change cards in aura-shell's Changes view.
    ChangeNote {
        /// Anything `git revparse` understands: full sha, short sha, HEAD,
        /// HEAD~1, branch name. Defaults to HEAD.
        #[arg(default_value = "HEAD")]
        sha: String,
        #[arg(long)]
        json: bool,
    },
    /// Blast radius for one symbol — who depends on it and which user-facing
    /// features ride on it, from the reverse call graph. No AI tokens. Powers
    /// the "N things depend on this" pre-flight before a surgical Rewind, so
    /// you see the fallout *before* you restore.
    Impact {
        /// The symbol (function / class name) you're about to change or revert.
        symbol: String,
        /// The file that declares it. Repo-relative or absolute.
        file: String,
        #[arg(long)]
        json: bool,
    },
    /// Taste Engine — observe and recall the project's coding patterns
    /// (named exports vs default, error_handling style, indent, etc.).
    Taste {
        #[command(subcommand)]
        sub: cmd_taste::TasteSubcommands,
    },

    /// Plugin marketplace — list / enable / disable installed plugins,
    /// skills, and MCP servers under `~/.aura/plugins/`. Mirrors the
    /// shell's Plugins panel and shares the same `.state.json` file.
    Plugin {
        #[command(subcommand)]
        sub: cmd_plugin_marketplace::PluginSubcommands,
    },

    // --- Internal / Hidden Commands ---
    
    /// (Internal) Extract AST metadata and stage AI chat history
    #[command(hide = true)]
    CaptureContext {
        /// Bypass all intent verification checks for this capture
        #[arg(long)]
        force: bool,
    },
    /// (Internal) Injects the Aura-Checkpoint Trailer into the commit message
    #[command(hide = true)]
    InjectTrailer { commit_msg_file: String },
    /// (Internal) Persists the checkpoint permanently into the hidden branch
    #[command(hide = true)]
    PersistCheckpoint,
    /// (Internal) Start the continuous semantic tracker daemon
    #[command(hide = true)]
    Daemon,
    /// (Internal) Query the Local Brain to understand why past agents wrote code
    #[command(hide = true)]
    Ask { #[arg(default_value = "recent")] query: String },
    /// (Internal) Start the local Web Dashboard
    #[command(hide = true)]
    Dashboard,
    /// (Internal) Visualize the Semantic Logic Graph
    #[command(hide = true)]
    Map,
    /// (Internal) Generate merge conflict resolution suggestions
    #[command(hide = true, name = "suggest-merge", alias = "arbitrate")]
    SuggestMerge { file_path: String },
    /// (Internal) Create compiler-safe dummy logic for Enterprise RBAC
    #[command(hide = true)]
    GenerateStubs,
    /// (Internal) Semantic Compaction: Prune implicit history
    #[command(hide = true)]
    Gc,
    /// Check for and install updates to the Aura CLI
    Update,
    /// (Internal) Start MCP server
    #[command(hide = true)]
    Mcp,
    /// (Internal) Take project snapshot
    #[command(hide = true)]
    Snapshot { description: String },
    /// (Internal) Restore project snapshot
    #[command(hide = true)]
    Restore { snapshot_id: String },
    /// (Internal) Take a durable file-level snapshot. Bucket L1 — used
    /// by aura-shell's Manager dispatch path to capture each zone file
    /// before fan-out so `aura rewind --task <id>` can revert cleanly.
    /// Idempotent on missing files (skipped, exits 0). Prints the
    /// snapshot id for each successful snapshot, one per line.
    #[command(hide = true, name = "snapshot-file")]
    SnapshotFile {
        /// Path(s) to snapshot. Multiple paths process sequentially;
        /// missing files emit `skip:<path>` and don't fail the run.
        #[arg(required = true)]
        paths: Vec<String>,
        /// Trigger label baked into the snapshot record. Default
        /// `manual`. Common values: `pre_dispatch_guard`, `pre_rewind`,
        /// `mcp_pre_edit`, `merge_conflict`.
        #[arg(long, default_value = "manual")]
        trigger: String,
        /// Agent id baked into the snapshot record. Default
        /// `aura-cli`. Manager dispatch uses `manager-<sid>#<task_id>`.
        #[arg(long, default_value = "aura-cli")]
        agent: String,
    },
    /// Trace logic paths to verify if the codebase supports a behavioral goal (experimental)
    #[command(name = "goal-trace", alias = "prove")]
    GoalTrace {
        /// The goal to verify (e.g., "users can log in via Google")
        #[arg(short, long)]
        goal: String,
        /// Emit the proof as structured JSON on stdout (verdict, per-check
        /// reasons) instead of the human report. Backs the desktop Goals
        /// surface and any script that wants the verdict without regex.
        #[arg(long)]
        json: bool,
        /// Anchor the proof to a specific commit — read the code as it was at
        /// that commit (or the nearest checkpoint around it), not the checked-out
        /// branch. Lets a session's goals prove against the code that session
        /// produced even when it lives on a branch that isn't checked out.
        #[arg(long)]
        at: Option<String>,
    },
    /// Declare this project's environment — toolchains, packages, services —
    /// seal it, and bring this machine to it.
    Env {
        #[command(subcommand)]
        sub: env_cmd::EnvSubcommands,
    },
    /// The agent phase's allowlist — hold it while a run is confined, or read
    /// back what a run was refused.
    Egress {
        #[command(subcommand)]
        sub: egress_cmd::EgressSubcommands,
    },
    /// (Internal) Verify semantic safety
    #[command(hide = true)]
    VerifyEnv {
        #[arg(short, long)] target: Option<String>,
        #[arg(trailing_var_arg = true)] pos_target: Vec<String>,
    },
    /// Run multi-agent orchestration (Duo Mode) — Claude Code + Gemini CLI in parallel
    Orchestrate {
        #[command(subcommand)]
        sub: OrchestrateSubcommands,
    },
    /// Run Linear-driven development workflows with AI agents
    Symphony {
        #[command(subcommand)]
        sub: SymphonySubcommands,
    },
    /// Real-time collaborative code awareness — see what your team is changing at the function level
    Live {
        #[command(subcommand)]
        sub: LiveSubcommands,
    },
    /// Send and receive messages between team members and AI agents
    Msg {
        #[command(subcommand)]
        sub: MsgSubcommands,
    },
    /// Keep what you build tied to the goal it serves — and prove it in the code
    Goals {
        #[command(subcommand)]
        sub: GoalsSubcommands,
    },
    /// Connect to a self-hosted Aura Server for team collaboration
    Server {
        #[command(subcommand)]
        sub: ServerSubcommands,
    },
    /// Save your work — snapshot + intent + git commit + auto-push to team (one command)
    Save {
        /// What you changed and why (commit message + intent)
        message: String,
        /// Skip git commit (snapshot + push to team only)
        #[arg(long)]
        no_git: bool,
    },
    /// Append a single intent row to `.aura/intent_log.jsonl` (fire-and-forget;
    /// called by the on-post-tool-use hook to capture autonomous agent work).
    #[command(name = "log-intent")]
    LogIntent {
        /// What was changed and why (the intent text)
        text: String,
        /// File the intent is about (optional)
        #[arg(long)]
        file: Option<String>,
        /// Tool that produced the change, e.g. "Edit" (optional)
        #[arg(long)]
        tool: Option<String>,
        /// Originating session id (optional)
        #[arg(long)]
        session: Option<String>,
        /// Source of the intent (default: "hook_auto")
        #[arg(long)]
        source: Option<String>,
        /// Canonical intent type, e.g. "BugFix" (optional)
        #[arg(long = "type")]
        intent_type: Option<String>,
    },
    /// Seal an intent into a signed block WITHOUT writing a JSONL row.
    ///
    /// The shared signing primitive behind every capture surface: the MCP
    /// `aura_log_intent` tool signs inline, and the desktop app (native
    /// Aura-chat brain) shells out to this so both produce byte-identical
    /// signed attestations — same block shape, same `.aura/attest/` mirror,
    /// same key registry. Prints `{"signed_block_id":..,"key_id":..}` on
    /// success (or `{}` when no signing key is available). The caller owns
    /// the JSONL row and stamps these ids into it, so there is exactly one
    /// intent row per capture no matter which surface sealed it.
    #[command(name = "sign-intent")]
    SignIntent {
        /// The intent text to seal (what changed and why).
        text: String,
        /// Repo-relative paths this change declares it will touch. Repeat the
        /// flag or pass a comma-separated list. Persisted into the block's
        /// declared_impacts so the commit-time reconciler can flag any file
        /// touched beyond them. Empty ⇒ no scope claim (divergence stays dormant).
        #[arg(long)]
        writes: Vec<String>,
        /// Coding agent to attribute the sealed block to (default "aura-shell").
        #[arg(long)]
        agent: Option<String>,
        /// Canonical intent type, e.g. "BugFix" (optional).
        #[arg(long = "type")]
        intent_type: Option<String>,
    },
    /// Classify a pending agent tool call (JSON on STDIN) and emit an
    /// allow/ask/deny gate verdict (JSON on STDOUT).
    #[command(name = "validate-tool")]
    ValidateTool,
    /// Inspect the local block substrate (S0.3+ spike surface).
    Blocks {
        #[command(subcommand)]
        sub: BlocksSubcommands,
    },
    /// Push all locally changed functions to the team immediately
    Share,
    /// Pull teammate changes and apply at function level
    Pull {
        /// Show what would change without applying
        #[arg(long)]
        dry_run: bool,
        /// Include functions their author flagged as a red build
        #[arg(long)]
        allow_red: bool,
    },
    /// Semantic diff — function-level changes, not line-level
    Diff {
        /// File to diff (defaults to all changed files)
        file: Option<String>,
    },
    /// Semantic history — who changed what function, when, and why
    History {
        /// Filter to a specific file
        #[arg(long)]
        file: Option<String>,
        /// Max entries
        #[arg(long, default_value = "20")]
        limit: usize,
    },
    /// Merge another branch into yours at the function level — smarter than git merge
    Merge {
        /// Source branch to merge from (e.g., "feature/auth")
        branch: String,
        /// Show what would change without applying
        #[arg(long)]
        dry_run: bool,
        /// Auto-accept all non-conflicting changes without prompting
        #[arg(long)]
        auto: bool,
    },
    /// Trace a function — who changed it, every version, with intent
    Trace {
        /// Function name to trace
        function: String,
    },
    /// Manage team-linked repos — control which projects sync through the mothership
    Team {
        #[command(subcommand)]
        sub: TeamSubcommands,
    },
    /// Run a mothership server — your machine becomes the team's collaboration hub (P2P, no cloud)
    Host {
        #[command(subcommand)]
        sub: HostSubcommands,
    },
    /// Join a team mothership with a single token (simplest way)
    Join {
        /// The join token from the mothership (base64 string printed by `aura host start`)
        token: String,
        /// Your username
        #[arg(long)]
        username: Option<String>,
        /// Your password
        #[arg(long)]
        password: Option<String>,
    },
    /// Check connection to mothership — latency, TLS status, online peers
    Ping,
    /// Connect this CLI to Aura Cloud (browser approval), or to a team mothership (if --code)
    Connect {
        /// Mothership URL (e.g., https://192.168.1.50:7700). Omit for Aura Cloud login.
        url: Option<String>,
        /// Mothership invite code (triggers mothership mode)
        #[arg(long)]
        code: Option<String>,
        /// Mothership username
        #[arg(long)]
        username: Option<String>,
        /// Mothership password
        #[arg(long)]
        password: Option<String>,
        /// Expected TLS fingerprint (SHA-256) for mothership
        #[arg(long)]
        fingerprint: Option<String>,
        /// Accept self-signed TLS certificates (mothership, less secure)
        #[arg(long)]
        accept_self_signed: bool,
        /// Cloud mode: don't open a browser — print the approve URL instead
        #[arg(long)]
        no_browser: bool,
    },
    /// Join a cloud-routed team by org slug (zero-config; requires `aura connect`)
    JoinTeam {
        /// Org slug on Aura Cloud (e.g. "naridon")
        org_slug: String,
        /// Override the repo full name (default: derived from `git remote origin`)
        #[arg(long)]
        repo: Option<String>,
    },
    /// Inspect CRDT doc state (cloud-routed teams)
    Crdt {
        #[command(subcommand)]
        action: CrdtAction,
    },
    /// Manage end-to-end encryption keys (W6)
    Keys {
        #[command(subcommand)]
        action: KeysAction,
    },
    /// Verify signed Block attestations from `.aura/blocks/` (S1 sigstore-live).
    Attest {
        #[command(subcommand)]
        action: AttestAction,
    },
    /// Trigger Aura's AI-synthesized PR reviews (W7)
    Pr {
        #[command(subcommand)]
        action: PrAction,
    },
    /// Drain open function-body conflicts (cloud-routed teams)
    Resolve {
        /// List open conflicts and exit (no prompts)
        #[arg(long)]
        list: bool,
        /// Walk each conflict and prompt for a winner
        #[arg(long)]
        interactive: bool,
    },
    /// Build a human-readable directory of every symbol — features, components,
    /// atoms, and recurring patterns — written to .aura/atlas.json + atlas.md
    Atlas {
        /// Layer LLM-polished one-line summaries on top of the structural ones
        #[arg(long)]
        ai: bool,
        /// Emit the JSON registry to stdout instead of the terminal story
        #[arg(long)]
        json: bool,
    },
    /// Distill the dirty working tree into clean, intent-grouped semantic
    /// commits — WHAT from the AST diff, WHY from .aura/intent_log.jsonl
    Distill {
        /// Print the plan without committing anything
        #[arg(long)]
        dry_run: bool,
        /// Emit the plan as stable JSON (plan only — nothing is committed)
        #[arg(long)]
        json: bool,
        /// Also distill untracked files (default: tracked changes only)
        #[arg(long)]
        include_untracked: bool,
        /// Maximum number of commits; overflow merges into the nearest group
        #[arg(long, default_value_t = 8)]
        max_groups: usize,
    },
    /// Track AI token usage, costs, and budgets across all your agent sessions
    Usage {
        /// Time period: "today", "week", "month", "all" (default: today)
        #[arg(default_value = "today")]
        period: String,
        /// Output raw JSON instead of formatted display
        #[arg(long)]
        json: bool,
        /// Only show usage for the current project (default: all projects)
        #[arg(long)]
        project: bool,
        /// Show Claude Pro/Max plan usage — parses Claude Code transcripts for real token data,
        /// peak hours, per-project quota burn, and burn rate predictions
        #[arg(long)]
        plan: bool,
        /// Set daily budget cap in USD (e.g. --budget-daily 5.00)
        #[arg(long)]
        budget_daily: Option<f64>,
        /// Set weekly budget cap in USD (e.g. --budget-weekly 25.00)
        #[arg(long)]
        budget_weekly: Option<f64>,
        /// Set per-session budget cap in USD (e.g. --budget-session 2.00)
        #[arg(long)]
        budget_session: Option<f64>,
        /// Export usage data as CSV to a file (e.g. --export usage.csv)
        #[arg(long)]
        export: Option<String>,
        /// Break usage down per developer (team view — reads + refreshes
        /// the git-shared .aura/usage_by_dev.jsonl aggregate)
        #[arg(long)]
        by_dev: bool,
    },
    /// Internal: record one completed agent turn's token usage into a
    /// repo-local session so the team usage surface lights up without a
    /// cloud account. Driven by the desktop app at end-of-turn — not meant
    /// for humans. Project-scoped by construction (writes `.aura/sessions`).
    #[command(hide = true)]
    UsageRecord {
        /// Stable id for the chat/agent session (accumulates across turns).
        #[arg(long)]
        session: String,
        /// Which AI drove the turn: "aura", "claude", "gemini", "codex", …
        #[arg(long)]
        agent: String,
        /// Model name (for cost lookup), if known.
        #[arg(long)]
        model: Option<String>,
        /// Input (prompt) tokens this turn.
        #[arg(long, default_value_t = 0)]
        input: u64,
        /// Output (completion) tokens this turn.
        #[arg(long, default_value_t = 0)]
        output: u64,
        /// Cache-read tokens this turn, if the provider reported them.
        #[arg(long, default_value_t = 0)]
        cache: u64,
    },
    /// Show the current cloud identity (user + org) for the stored token
    Whoami,
    /// Clear the stored cloud token from ~/.aura/config
    Disconnect,
    /// Serve Aura's semantic layer as a Zed ACP agent over stdio
    AcpServe,
    /// Run an external agent (claude, gemini, ...) over the Zed ACP protocol
    AcpRun {
        /// Binary to launch as an ACP agent (e.g. "claude-code", "gemini")
        #[arg(long)]
        cmd: String,
        /// Extra args to pass to the agent binary (repeatable)
        #[arg(long = "arg")]
        args: Vec<String>,
        /// User prompt to send once the session is live
        #[arg(long)]
        prompt: String,
        /// Overall timeout in seconds (covers handshake + session + prompt)
        #[arg(long, default_value_t = 120)]
        timeout: u64,
        /// Print session/update payloads as JSON lines (default: text only)
        #[arg(long)]
        json: bool,
    },
    /// Live WebSocket diagnostics — observe server frames or AG-UI events
    Ws {
        #[command(subcommand)]
        action: WsAction,
    },
    /// Episodic recall — query the cloud's event timeline (events / arc
    /// / multi-arc) or summarize a window of local Block envelopes
    /// (narrate-blocks). Cloud subcommands need a token from
    /// `~/.aura/config` or `AURA_CLOUD_TOKEN`; narrate-blocks reads
    /// `.aura/blocks/*.json` directly.
    Recall {
        #[command(subcommand)]
        action: RecallAction,
    },
    /// Typed-intent surface (S2-TI / doc 16). Reads only the local
    /// `.aura/intent_log.jsonl` — air-gapped, no cloud roundtrip. Wraps
    /// the same helpers as the `aura_intent_query` MCP tool so the CLI
    /// and MCP outputs agree.
    Intents {
        #[command(subcommand)]
        action: IntentsAction,
    },
    /// S2-HCL: cloud handover ledger CLI mirror of
    /// aura_handover_cloud_list / aura_handover_cloud_push MCP tools.
    /// Wraps GET/POST /api/v2/handovers — the cross-machine pickup
    /// queue another agent can resume work from. Local
    /// `aura handover <agent>` produces the payload; this surface
    /// publishes the summary to a queue another machine can read.
    HandoverCloud {
        #[command(subcommand)]
        action: HandoverCloudAction,
    },
    /// Local project memory (.aura/memory.json) — provenance-stamped
    /// facts with hybrid ranked recall. `add` stamps every entry with
    /// the HEAD commit, the latest signed intent and an optional code
    /// symbol fingerprint; `search` ranks with BM25 + embeddings +
    /// recency (RRF-fused) and flags entries whose source code has
    /// drifted; `why` shows where a fact came from and whether it is
    /// still true of the code. Sibling to `memory-cloud` (the org-wide
    /// store) — this one is the per-repo file the MCP `aura_memory_*`
    /// tools read and write.
    Memory {
        #[command(subcommand)]
        action: memory::cli::MemoryAction,
    },
    /// S2-MCL: cloud project_memory store CLI mirror of
    /// aura_memory_cloud_list / aura_memory_cloud_push MCP tools.
    /// Wraps GET/POST /api/v2/memory — the org-wide durable memory
    /// for design decisions, conventions, gotchas. Sibling to the
    /// per-machine `aura_memory_*` MCP tools (which read/write a
    /// local memory file); this surface is the team-shared
    /// counterpart.
    MemoryCloud {
        #[command(subcommand)]
        action: MemoryCloudAction,
    },
    /// S2-AT: A2A v1.2 task lifecycle CLI mirror of
    /// aura_a2a_task_create / get / list / patch MCP tools. Wraps
    /// POST/GET/PATCH /api/v2/a2a/tasks for fire-and-poll work
    /// (cross-repo refactor, multi-step review) where the one-shot
    /// `/a2a/messages` endpoint is not enough. Lifecycle states per
    /// A2A v1.2 §4: submitted | working | input-required |
    /// completed | failed | canceled | rejected | auth-required.
    /// Terminal states are sticky cloud-side.
    A2aTask {
        #[command(subcommand)]
        action: A2aTaskAction,
    },
    /// Cross-project agent-skill ledger. `record` writes one outcome
    /// row (5 signals × 4 taxonomy lenses) to the cloud; `stats`
    /// returns aggregated per-provider rows used for auto-routing.
    /// See aura-cloud/migrations/029_agent_skill_outcomes.sql.
    Skill {
        #[command(subcommand)]
        action: SkillAction,
    },
    /// Portable SKILL.md bundles (plural — distinct from `skill`, the
    /// routing ledger). Package Aura's capabilities as installable skill
    /// files any agent (Claude Code / Codex / Gemini / Cursor) can
    /// discover and shell to. `list` shows the seed set; `emit` renders
    /// SKILL.md files to a directory; `install <agent>` drops them into
    /// that agent's skills directory.
    Skills {
        #[command(subcommand)]
        action: skills::SkillsAction,
    },
    /// Replay Lab — re-run a logged objective across N coding agents in
    /// isolated git worktrees, then rank the results by semantic
    /// correctness (per-result `aura pr-review` risk), not just exit code.
    /// `run` executes a replay; `report` shows a saved one. Each run is
    /// fed back into the skill ledger so replaying improves auto-routing.
    Replay {
        #[command(subcommand)]
        action: replay::ReplayAction,
    },
    /// S2-WH: webhook configs CLI mirror of the cloud /api/v1/webhooks*
    /// endpoints. Operators who don't want to drive the dashboard can
    /// list / create / delete / toggle Slack/Discord webhook configs
    /// (impact_alert + live_event + presence channels) from the
    /// terminal. Org-scoped via the cloud token.
    Webhooks {
        #[command(subcommand)]
        action: WebhooksAction,
    },
    /// S2-AC: A2A v1.2 Agent Card discovery. Fetches the
    /// unauthenticated `/.well-known/agent-card.json` from the
    /// configured cloud (or from `--cloud <url>`) and renders the
    /// advertised skills, capabilities, and the `/api/v2/a2a/messages`
    /// endpoint URL. Useful for: (a) confirming a new deployment
    /// advertises the skills you expect, (b) sanity-checking a
    /// teammate's cloud before sending an A2A message, (c) capturing
    /// the card into a fixture without curl + jq.
    AgentCard {
        /// Override the Host header sent to the cloud. The cloud
        /// derives the advertised endpoint scheme + base URL from this,
        /// so passing e.g. `--host cloud.example.com` returns the card
        /// the public deployment would emit even when hitting a
        /// loopback proxy.
        #[arg(long)]
        host: Option<String>,
        /// Override the cloud base URL (defaults to the configured
        /// cloud_url, then AURA_CLOUD_URL, then https://api.auravcs.com).
        /// Unauthenticated — no token required.
        #[arg(long)]
        cloud: Option<String>,
        #[arg(long)]
        json: bool,
    },
    /// AST-aware git merge driver (AURA-44): parallel agents editing
    /// DIFFERENT functions in the SAME file merge cleanly instead of
    /// producing textual conflicts. Run `--install` once per clone, then
    /// git invokes the driver automatically for *.rs/*.ts/*.tsx/*.py/*.go.
    /// On any doubt (parse failure, unsupported language) it falls back to
    /// `git merge-file` — never worse than stock git.
    #[command(name = "merge-driver")]
    MergeDriver {
        /// %O — common-ancestor version (temp file written by git)
        #[arg(value_name = "BASE", required_unless_present_any = ["install", "uninstall", "status"])]
        base: Option<std::path::PathBuf>,
        /// %A — current-branch version (temp file); the merged result is
        /// written back into this file
        #[arg(value_name = "OURS", required_unless_present_any = ["install", "uninstall", "status"])]
        ours: Option<std::path::PathBuf>,
        /// %B — other-branch version (temp file)
        #[arg(value_name = "THEIRS", required_unless_present_any = ["install", "uninstall", "status"])]
        theirs: Option<std::path::PathBuf>,
        /// %P — real repo-relative path of the file being merged; its
        /// extension selects the language grammar (the temp files have none)
        #[arg(long)]
        path: Option<String>,
        /// %L — conflict marker length
        #[arg(long, default_value_t = 7)]
        marker_size: usize,
        /// Configure this repository: writes [merge "aura"] to .git/config and
        /// appends *.rs/*.ts/*.tsx/*.py/*.go patterns to .git/info/attributes
        /// (repo-local, not a committed .gitattributes). Idempotent.
        #[arg(long, conflicts_with = "uninstall")]
        install: bool,
        /// Remove the [merge "aura"] config section and the attribute
        /// patterns --install added. Idempotent.
        #[arg(long)]
        uninstall: bool,
        /// Report this repository's driver state: [merge "aura"] config line,
        /// merge=aura attribute patterns, and whether `aura` resolves on
        /// PATH. Read-only; exits 0 whether or not the driver is installed.
        #[arg(long, conflicts_with_all = ["install", "uninstall"])]
        status: bool,
        /// With --status: emit one JSON object instead of the text report.
        #[arg(long, requires = "status")]
        json: bool,
    },
}

/// `aura ci <…>` — Semantic CI subcommands.
#[derive(Subcommand)]
enum CiCmd {
    /// Run the pipeline for a trigger and print the verdict. Exits non-zero
    /// when a blocking step fails (so a git hook / CI job fails the build).
    Run {
        /// Which event to run for: pre-commit | pre-push | pr | manual.
        #[arg(long, default_value = "manual")]
        trigger: String,
        /// Base ref for the `pr` trigger's diff + intent score.
        #[arg(long, default_value = "HEAD")]
        base: String,
        /// Emit the PipelineRun(s) as JSON (for the desktop Checks surface).
        #[arg(long)]
        json: bool,
    },
    /// Show the declared pipelines (or the built-in default when none).
    List {
        #[arg(long)]
        json: bool,
    },
    /// Quick verdict against the staged work (the pre-commit checks).
    Status,
    /// Write a GitHub Actions workflow that runs the SAME pipeline in the
    /// cloud on every PR — single source of truth with your local hooks.
    Export {
        /// Output path for the workflow file.
        #[arg(long, default_value = ".github/workflows/aura-checks.yml")]
        out: String,
    },
}

#[derive(Subcommand)]
enum SubagentCmd {
    /// Spawn a coding-agent subagent synchronously. Streams its output to
    /// stdout, exits with the subagent's exit code. Used by the Aura
    /// Manager CLI brain to fan work out via Bash.
    Spawn {
        /// Provider id (claude, gemini, codex, cursor, kimi, or any
        /// id declared in `~/.aura/agents.toml`).
        provider: String,
        /// Prompt for the subagent. Quote it; it can be multi-paragraph.
        prompt: String,
        /// Comma-separated file globs the subagent will write to. Recorded
        /// on the ManagerTask so the UI shows zone scope and (when the
        /// worktree feature lands) the dispatch can claim them.
        #[arg(long, value_delimiter = ',')]
        zones: Vec<String>,
        /// Comma-separated upstream task ids this dispatch depends on.
        /// Cosmetic for now (CLI fan-out is naturally serial via
        /// blocking spawn) but populated on the DAG so the UI can draw
        /// edges.
        #[arg(long = "depends-on", value_delimiter = ',')]
        depends_on: Vec<usize>,
        /// A2A v1.2 task id to attach to this dispatch. Set when the
        /// brain is fanning out from a propose-plan Build that minted
        /// remote a2a tasks — the local DAG row gets the remote id so
        /// the UI can link them. Recorded on `ManagerTask.a2a_task_id`.
        #[arg(long = "a2a-task-id")]
        a2a_task_id: Option<String>,
    },
    /// Spawn a subagent in the background. Prints `task_id=<n>` to stdout
    /// and returns immediately so the brain can fire multiple in
    /// parallel and `wait` for them later.
    SpawnBg {
        provider: String,
        prompt: String,
        #[arg(long, value_delimiter = ',')]
        zones: Vec<String>,
        #[arg(long = "depends-on", value_delimiter = ',')]
        depends_on: Vec<usize>,
        #[arg(long = "a2a-task-id")]
        a2a_task_id: Option<String>,
    },
    /// Block until a `spawn-bg`'d task reaches a terminal status. Prints
    /// the task's captured output + a one-line summary, exits with the
    /// subagent's exit code.
    Wait {
        /// Task id printed by `spawn-bg`.
        task_id: usize,
        /// Max seconds to wait. Default 1800 (30 min).
        #[arg(long, default_value_t = 1800)]
        timeout: u64,
    },
    /// Internal: re-enter as the detached child of `spawn-bg`. Hidden
    /// from --help; not intended for direct invocation.
    #[command(hide = true)]
    RunDetached {
        task_id: usize,
        provider: String,
        prompt: String,
    },
    /// List available subagent providers + their availability + version.
    List,
    /// Bucket O — Tail the most recent stdout/stderr lines from a live
    /// or completed Manager subagent. Reads the dedicated tail file at
    /// `~/.aura/manager-sessions/<sid>-<tid>.tail` written by the
    /// shell as the subagent streams. Defaults to the last 200 lines;
    /// pair with `--since` to skip ahead. Designed for the Manager
    /// brain to call via Bash when a fan-out has been running >2 min
    /// and the brain wants to know if it's progressing or stuck.
    Monitor {
        /// Manager session id.
        session_id: String,
        /// Task id within the session.
        task_id: usize,
        /// Max lines to print (newest last). Default 200.
        #[arg(long, default_value_t = 200)]
        tail: usize,
    },
}

#[derive(Subcommand)]
enum WebhooksAction {
    /// List the org's webhook configs.
    /// GET /api/v1/webhooks
    List {
        #[arg(long)]
        json: bool,
    },
    /// Create a new webhook config.
    /// POST /api/v1/webhooks
    Create {
        /// Webhook destination kind ("slack" | "discord").
        #[arg(long)]
        webhook_type: String,
        /// Inbound webhook URL (e.g. https://hooks.slack.com/services/…).
        #[arg(long)]
        webhook_url: String,
        /// Comma-separated event subscriptions (e.g.
        /// "impact_alert,live_event,presence"). Defaults to
        /// "impact_alert" when omitted.
        #[arg(long)]
        events: Option<String>,
        #[arg(long)]
        json: bool,
    },
    /// Delete a webhook config by id.
    /// DELETE /api/v1/webhooks/{id}
    Delete {
        id: String,
        #[arg(long)]
        json: bool,
    },
    /// Enable or disable a webhook config.
    /// POST /api/v1/webhooks/{id}/toggle
    Toggle {
        id: String,
        /// `true` enables the webhook; `false` disables it. Required —
        /// uses ArgAction::Set so clap reads the literal `true` /
        /// `false` value (a bare `--enabled` would be ambiguous).
        #[arg(long, action = clap::ArgAction::Set)]
        enabled: bool,
        #[arg(long)]
        json: bool,
    },
}

#[derive(Subcommand)]
enum WsAction {
    /// Connect to /api/v2/live/ws and print received frames as JSON lines
    Listen {
        /// Maximum seconds to listen before disconnecting
        #[arg(long, default_value_t = 30)]
        seconds: u64,
        /// Stop after N non-heartbeat frames (0 = no limit)
        #[arg(long, default_value_t = 0)]
        stop_after: usize,
        /// Require at least N non-heartbeat frames; exit non-zero otherwise
        #[arg(long, default_value_t = 0)]
        expect_min: usize,
        /// Server-side stream format. Omit for native ServerFrame; "ag-ui"
        /// requests CopilotKit AG-UI event shapes.
        #[arg(long)]
        format: Option<String>,
    },
}

#[derive(Subcommand)]
enum RecallAction {
    /// Filterable event timeline. Wraps GET /api/v2/episodic/recall.
    /// All filters are optional — with no filters the cloud returns the
    /// unfiltered window.
    Events {
        /// Filter by event_type (e.g. "block.signed", "snapshot.created").
        #[arg(long = "event-type")]
        event_type: Option<String>,
        /// Filter by agent_id.
        #[arg(long = "agent")]
        agent: Option<String>,
        /// Filter by focus_fn (function name in event metadata).
        #[arg(long = "focus-fn")]
        focus_fn: Option<String>,
        /// Filter by focus_file (file path in event metadata).
        #[arg(long = "focus-file")]
        focus_file: Option<String>,
        /// Filter by repo (defaults to cloud's view of all repos).
        #[arg(long)]
        repo: Option<String>,
        /// S2-TICRE: filter by canonical intent_type. Mirrors --type on
        /// `aura recall narrate-blocks` (S2-TINF) and the cloud recall's
        /// `intent_type=` query param (S2-TICR/D). Untyped events are
        /// dropped from the result when set. One of FeatureAdd, BugFix,
        /// Refactor, Revert, Performance, Docs, Deps.
        #[arg(long = "type")]
        intent_type: Option<String>,
        /// Lookback window in hours.
        #[arg(long = "window-hours")]
        window_hours: Option<i64>,
        /// Cap returned rows.
        #[arg(long)]
        limit: Option<i64>,
        /// Print raw JSON instead of a human-readable table.
        #[arg(long)]
        json: bool,
    },
    /// Per-agent session arc. Wraps GET /api/v2/episodic/session-arc.
    /// Segments events into sessions whenever there's a gap larger than
    /// `--gap-minutes` between consecutive events.
    Arc {
        /// Required. agent_id whose arc to compute.
        #[arg(long = "agent")]
        agent: String,
        /// Lookback window in hours.
        #[arg(long = "window-hours")]
        window_hours: Option<i64>,
        /// Inactivity threshold (minutes) that splits one session from the next.
        #[arg(long = "gap-minutes")]
        gap_minutes: Option<i64>,
        /// Filter by repo.
        #[arg(long)]
        repo: Option<String>,
        /// Cap returned segments.
        #[arg(long)]
        limit: Option<i64>,
        /// Print raw JSON instead of a human-readable table.
        #[arg(long)]
        json: bool,
    },
    /// Local Block-range narration. Reads `.aura/blocks/*.json`,
    /// filters by recency (`--since-hours`) and optional kind/actor
    /// filters, then prints a deterministic prose summary suitable for
    /// agent handover. Uses no LLM — the text is reproducible from the
    /// same set of blocks.
    NarrateBlocks {
        /// Lookback window in hours. Defaults to 24.
        #[arg(long = "since-hours", default_value_t = 24)]
        since_hours: i64,
        /// Optional kind filter (e.g. "command", "message", "sentinel_event").
        /// Matches the on-wire snake_case discriminator. Repeatable.
        #[arg(long)]
        kind: Vec<String>,
        /// Optional actor filter (matches AgentRef.id substring).
        #[arg(long)]
        actor: Option<String>,
        /// Optional canonical intent_type filter (S2-TINF). One of
        /// FeatureAdd, BugFix, Refactor, Revert, Performance, Docs, Deps.
        /// Untyped blocks are dropped from the matched set when set.
        #[arg(long = "type")]
        intent_type: Option<String>,
        /// Cap the number of blocks rendered in the per-block list
        /// (the totals/aggregates always reflect every matched block).
        #[arg(long, default_value_t = 10)]
        list_limit: usize,
        /// Print raw JSON (the structured summary) instead of prose.
        #[arg(long)]
        json: bool,
    },
    /// Per-function timeline materialized view. Wraps
    /// GET /api/v2/episodic/timeline?function_name=X.
    /// Returns the events slice plus by_day buckets,
    /// counts_by_type, counts_by_intent_type, and agents_seen — the
    /// "what happened to function X" answer the agent_card advertises
    /// as the `episodic-timeline` skill. CLI surface mirrors the
    /// `episodic_timeline_url` on the agent card so a teammate or
    /// follow-up agent can pull the same view via either path.
    Timeline {
        /// Required. Function name to look up.
        #[arg(long = "function-name")]
        function_name: String,
        /// Lookback window in hours. Cloud default 168 (7 days).
        #[arg(long = "window-hours")]
        window_hours: Option<i64>,
        /// Filter by repo.
        #[arg(long)]
        repo: Option<String>,
        /// Cap returned events. Cloud default 50, max 500.
        #[arg(long)]
        limit: Option<i64>,
        /// Print raw JSON (the structured response with by_day +
        /// counts_by_type + counts_by_intent_type + agents_seen)
        /// instead of a human-readable table.
        #[arg(long)]
        json: bool,
    },
    /// Cloud-side compressed narration of an episodic-event window.
    /// Wraps POST /api/v2/episodic/narrate. With an org LLM key
    /// configured the cloud calls the chosen tier; without one it
    /// returns a deterministic synthesized digest. Same filter shape
    /// as `events` minus the agent filter (cloud narrate doesn't
    /// scope by agent_id). Sibling to `narrate-blocks` (which reads
    /// only local `.aura/blocks/*.json` and never calls an LLM).
    NarrateCloud {
        /// Lookback window in hours. Cloud default 168 (7 days).
        #[arg(long = "window-hours")]
        window_hours: Option<i64>,
        /// Filter by event_type (e.g. "intent", "sentinel", "handover").
        #[arg(long = "event-type")]
        event_type: Option<String>,
        /// Filter by focus_file (file path in event metadata).
        #[arg(long = "focus-file")]
        focus_file: Option<String>,
        /// Filter by focus_fn (function name in event metadata).
        #[arg(long = "focus-fn")]
        focus_fn: Option<String>,
        /// Filter by repo.
        #[arg(long)]
        repo: Option<String>,
        /// LLM tier: "shallow" (cheap, default) or "deep" (more
        /// capable). Ignored on the synthetic fallback path.
        #[arg(long)]
        tier: Option<String>,
        /// Max events the narrator considers. Cloud default 100, max 500.
        #[arg(long)]
        limit: Option<i64>,
        /// Print raw JSON (window_hours + event_count + counts_by_type
        /// + counts_by_intent_type + narration + model_used) instead
        /// of a human-readable digest.
        #[arg(long)]
        json: bool,
    },
    /// Per-agent digest materialized view. Wraps
    /// GET /api/v2/episodic/agent-digest?agent_id=X.
    /// Same shape as the timeline view plus `top_functions` and
    /// `top_files` rankings (deterministically ordered count desc,
    /// name asc) — the "what has agent X been touching" answer.
    /// CLI surface mirrors `episodic_agent_digest_url` on the
    /// agent_card so a teammate or follow-up agent can pull the same
    /// view via either path.
    AgentDigest {
        /// Required. agent_id whose digest to compute.
        #[arg(long = "agent")]
        agent: String,
        /// Lookback window in hours. Cloud default 168 (7 days).
        #[arg(long = "window-hours")]
        window_hours: Option<i64>,
        /// Filter by repo.
        #[arg(long)]
        repo: Option<String>,
        /// Cap returned events. Cloud default 50, max 500.
        #[arg(long)]
        limit: Option<i64>,
        /// Print raw JSON (the structured response with top_functions
        /// + top_files + by_day + counts_by_intent_type) instead of a
        /// human-readable table.
        #[arg(long)]
        json: bool,
    },
    /// Multi-agent merged arc. Wraps GET /api/v2/episodic/multi-session-arc.
    /// Computes the per-session arc for each agent and merges segments
    /// into one timeline ordered by start_ts.
    MultiArc {
        /// Required. Comma-separated agent_ids (up to 16).
        #[arg(long = "agents")]
        agents: String,
        /// Lookback window in hours.
        #[arg(long = "window-hours")]
        window_hours: Option<i64>,
        /// Inactivity threshold (minutes) that splits one session from the next.
        #[arg(long = "gap-minutes")]
        gap_minutes: Option<i64>,
        /// Filter by repo.
        #[arg(long)]
        repo: Option<String>,
        /// Cap returned segments.
        #[arg(long)]
        limit: Option<i64>,
        /// Print raw JSON instead of a human-readable table.
        #[arg(long)]
        json: bool,
    },
}

#[derive(Subcommand)]
enum IntentsAction {
    /// Filter the local intent log by canonical type and/or window.
    /// Mirrors the `aura_intent_query` MCP tool's behavior so CLI and
    /// MCP outputs agree.
    Query {
        /// Canonical type filter. One of: FeatureAdd, BugFix, Refactor,
        /// Revert, Performance, Docs, Deps. Omit for all types.
        #[arg(long = "type")]
        intent_type: Option<String>,
        /// Lookback window in hours. Default 168 (7 days). Set 0 to
        /// disable the cutoff and return the entire log.
        #[arg(long = "since-hours", default_value_t = 168)]
        since_hours: i64,
        /// Cap returned entries (newest first). Capped at 500 server-side
        /// — total_matches reports the unbounded count.
        #[arg(long, default_value_t = 50)]
        limit: usize,
        /// Print the raw JSON envelope instead of a human-readable table.
        #[arg(long)]
        json: bool,
    },
    /// Print the deterministic typed-intent prose summary that the
    /// handover XML embeds (S2-TIH). Same source-of-truth helper, so
    /// the CLI output is byte-identical to what receiving agents see.
    Summary {
        /// Lookback window in hours. Default 24 (matches handover).
        #[arg(long = "since-hours", default_value_t = 24)]
        since_hours: i64,
        /// Newest sample intents per type. 0 omits samples (counts only).
        #[arg(long = "sample-per-type", default_value_t = 1)]
        sample_per_type: usize,
        /// Print the structured envelope (typed_total / untyped /
        /// buckets[]) as pretty JSON instead of the prose form.
        /// Same source-of-truth, just a different renderer.
        #[arg(long)]
        json: bool,
    },
}

/// S2-HCL: cloud handover ledger CLI mirror of
/// aura_handover_cloud_list / aura_handover_cloud_push MCP tools.
#[derive(Subcommand)]
enum HandoverCloudAction {
    /// List handovers in the cloud handover ledger (newest first).
    /// Wraps GET /api/v2/handovers — returns paginated rows with
    /// (id, session_id, agent_name, summary, token_count, created_at).
    List {
        /// 1-based page number. Default 1.
        #[arg(long)]
        page: Option<i64>,
        /// Max rows per page. Cloud default 50, max 200.
        #[arg(long)]
        limit: Option<i64>,
        /// Print raw JSON envelope instead of a human-readable table.
        #[arg(long)]
        json: bool,
    },
    /// Push a handover summary to the cloud ledger so an agent on
    /// another machine can discover and resume the work. Wraps
    /// POST /api/v2/handovers. The local `aura handover <agent>`
    /// command produces the dense XML payload; this surface persists
    /// the summary line a receiving agent uses to pick which session
    /// to resume.
    Push {
        /// Required. Session identifier the receiving agent will resume against.
        #[arg(long = "session-id")]
        session_id: String,
        /// Required. Source agent name, e.g. 'claude', 'cursor', 'gemini'.
        #[arg(long = "agent-name")]
        agent_name: String,
        /// Required. One-paragraph human-readable summary of where
        /// the session was when the handover was generated.
        #[arg(long)]
        summary: String,
        /// Optional: token count of the source session at handover
        /// time, for downstream sizing.
        #[arg(long = "token-count")]
        token_count: Option<i64>,
        /// Print the raw JSON response instead of a status line.
        #[arg(long)]
        json: bool,
    },
}

/// S2-MCL: cloud project_memory store CLI mirror of
/// aura_memory_cloud_list / aura_memory_cloud_push MCP tools.
#[derive(Subcommand)]
enum MemoryCloudAction {
    /// List entries in the cloud project_memory store (newest first).
    /// Wraps GET /api/v2/memory — returns paginated rows with
    /// (id, kind, title, body, created_at).
    List {
        /// 1-based page number. Default 1.
        #[arg(long)]
        page: Option<i64>,
        /// Max rows per page. Cloud default 100, max 500.
        #[arg(long)]
        limit: Option<i64>,
        /// Print raw JSON envelope instead of a human-readable table.
        #[arg(long)]
        json: bool,
    },
    /// Insert a project_memory entry org-wide. Wraps POST /api/v2/memory.
    /// Use when you've learned something durable the team should
    /// see — design decisions, conventions, gotchas. Repo scope is
    /// optional and resolves by github_full_name.
    Push {
        /// Required. Memory body (Markdown).
        #[arg(long)]
        body: String,
        /// Optional short title for indexing.
        #[arg(long)]
        title: Option<String>,
        /// Optional kind tag, e.g. 'decision', 'convention',
        /// 'gotcha'. Defaults to 'project' server-side when omitted.
        #[arg(long)]
        kind: Option<String>,
        /// Optional GitHub full_name (org/name) to scope the entry
        /// to one repo.
        #[arg(long = "repo-full-name")]
        repo_full_name: Option<String>,
        /// Print the raw JSON response instead of a status line.
        #[arg(long)]
        json: bool,
    },
}

/// S2-AT: A2A v1.2 task lifecycle CLI mirror of aura_a2a_task_*
/// MCP tools. Each subcommand wraps one of the four endpoints
/// under /api/v2/a2a/tasks.
#[derive(Subcommand)]
enum A2aTaskAction {
    /// Create a new A2A v1.2 task. Returns the row in 'submitted'
    /// state with a stable id the caller can poll via `aura
    /// a2a-task get`. Wraps POST /api/v2/a2a/tasks.
    Create {
        /// Required. Agent kind label, e.g. 'aura-pr-review',
        /// 'aura-cross-repo-refactor'. Server validates non-empty.
        #[arg(long = "agent-kind")]
        agent_kind: String,
        /// Required. Free-form input the assigned worker will
        /// process. Server validates non-empty.
        #[arg(long)]
        input: String,
        /// Optional repo scope. Resolved by github_full_name;
        /// unknown repo => HTTP 404.
        #[arg(long)]
        repo: Option<String>,
        /// Optional context_id for grouping related tasks.
        #[arg(long = "context-id")]
        context_id: Option<String>,
        /// Optional metadata as a JSON object string. Forwarded
        /// verbatim into the input_metadata column.
        #[arg(long = "metadata-json")]
        metadata_json: Option<String>,
        /// Bucket K1 — hierarchy parent. The brain sets this when
        /// minting a wave under its plan, a task under its wave, or a
        /// subtask under its task.
        #[arg(long = "parent")]
        parent: Option<String>,
        /// Bucket K1 — `plan | wave | task | subtask`. Defaults to
        /// `task` when omitted (server-side default).
        #[arg(long = "kind")]
        kind: Option<String>,
        /// Bucket K1 — required (non-empty) when --kind is plan|wave|task.
        /// What `aura prove` ultimately verifies.
        #[arg(long = "acceptance-criteria")]
        acceptance_criteria: Option<String>,
        /// Bucket K1 — git branch the task is created on. Defaults to
        /// the current branch (auto-detected via `git rev-parse
        /// --abbrev-ref HEAD`) if --branch is omitted and we're inside
        /// a git work tree.
        #[arg(long = "branch")]
        branch: Option<String>,
        /// Bucket K1 — discovery tags. Repeat `--tag foo --tag bar` to
        /// attach multiple. Server stores in `tags TEXT[]` (GIN-indexed).
        #[arg(long = "tag")]
        tag: Vec<String>,
        /// Bucket K1 — assignee user UUID. Validated cross-org server-side.
        #[arg(long = "assignee")]
        assignee: Option<String>,
        /// Print the full JSON envelope instead of a status line.
        #[arg(long)]
        json: bool,
    },
    /// Read one task by id. Wraps GET /api/v2/a2a/tasks/{id}.
    /// 404 surfaces as a CLI error so a polling loop can decide
    /// whether to retry.
    Get {
        /// Required. Task UUID returned by `aura a2a-task create`.
        id: String,
        /// Print the full JSON envelope instead of a status line.
        #[arg(long)]
        json: bool,
    },
    /// List tasks. Wraps GET /api/v2/a2a/tasks. Read-only;
    /// idempotent. Filters compose: --status + --repo narrow the
    /// returned set.
    List {
        /// Filter by status. One of submitted | working |
        /// input-required | completed | failed | canceled |
        /// rejected | auth-required.
        #[arg(long)]
        status: Option<String>,
        /// Filter by repo (github_full_name).
        #[arg(long)]
        repo: Option<String>,
        /// Cap returned rows. Cloud default 100, max 500.
        #[arg(long)]
        limit: Option<i64>,
        /// Print raw JSON envelope instead of a human-readable table.
        #[arg(long)]
        json: bool,
    },
    /// Patch a task's status (and optionally result + error_message).
    /// Wraps PATCH /api/v2/a2a/tasks/{id}. Terminal states (completed
    /// | failed | canceled | rejected) are sticky cloud-side — re-
    /// patching a terminal task surfaces as HTTP 409.
    Patch {
        /// Required. Task UUID returned by `aura a2a-task create`
        /// or seen in `aura a2a-task list`.
        id: String,
        /// Required. New status. One of submitted | working |
        /// input-required | completed | failed | canceled |
        /// rejected | auth-required.
        #[arg(long)]
        status: String,
        /// Optional result payload as a JSON object string. Most
        /// commonly set on transition into `completed`.
        #[arg(long = "result-json")]
        result_json: Option<String>,
        /// Optional error_message. Most commonly set on transition
        /// into `failed`.
        #[arg(long = "error-message")]
        error_message: Option<String>,
        /// Print the full JSON envelope instead of a status line.
        #[arg(long)]
        json: bool,
    },
}

#[derive(Subcommand)]
enum PrAction {
    /// Print the cloud install URL for a platform (github | gitlab)
    Connect { platform: String },
    /// Generate (and optionally post) an AI-synthesized review
    Review {
        #[arg(long)]
        pr: i32,
        #[arg(long)]
        dry_run: bool,
        #[arg(long)]
        base: Option<String>,
    },
    /// List recent PR review events for the current repo
    Status,
    /// Record feedback on a review event
    Feedback {
        event_id: String,
        verdict: String,
        #[arg(long)]
        note: Option<String>,
    },
    /// S2-PCR: per-commit AI review surface (list / get / generate).
    /// Mirrors the 3 cloud /api/v2/pr/commit-reviews* endpoints so
    /// the per-commit picture is operable from the terminal.
    CommitReview {
        #[command(subcommand)]
        action: PrCommitReviewAction,
    },
}

/// Cross-project agent-skill ledger CLI mirror. `record` POSTs one
/// outcome to /api/v1/skill/outcomes; `stats` GETs aggregated rows
/// per-provider for routing decisions. The Manager session writes
/// each closed task's outcome via `aura skill record`; PlanCard reads
/// /skill/stats via the same client to render the auto-routing badge.
#[derive(Subcommand)]
enum SkillAction {
    /// POST /api/v1/skill/outcomes — JSON body is a `SkillOutcome`
    /// struct. Falls back to writing into `~/.aura/agent_skills.json`
    /// (with the dirty-row marker) when the cloud is unreachable.
    Record {
        /// Full SkillOutcome as a JSON object. Pass via `--json '<...>'`
        /// or pipe `cat outcome.json | aura skill record --json -`.
        #[arg(long)]
        json: String,
    },
    /// GET /api/v1/skill/stats — returns one row per provider for the
    /// requested taxonomy cell (filtered by user via the auth token).
    Stats {
        /// Coarse category filter — frontend|backend|infra|refactor|
        /// security-review|architecture-review.
        #[arg(long)]
        category: String,
        /// Optional fine_language filter.
        #[arg(long)]
        language: Option<String>,
        /// Optional fine_layer filter — ui|api|db|cli.
        #[arg(long)]
        layer: Option<String>,
    },
    /// Rank the providers for a taxonomy cell and print the single best
    /// one. This is the canonical routing decision — `aura skill stats`
    /// returns the raw rollup, `suggest` applies the
    /// `score = q·pr/(1+cost)`, n≥10 formula (see `skill_rank`) and
    /// names a winner. aura-shell's dispatcher shells out to this so the
    /// CLI and the in-app manager share exactly one ranker; any external
    /// agent can ask "best brain for this kind of task?" the same way.
    Suggest {
        /// Coarse category — frontend|backend|infra|refactor|
        /// security-review|architecture-review.
        #[arg(long)]
        category: String,
        /// Optional fine_language filter.
        #[arg(long)]
        language: Option<String>,
        /// Optional fine_layer filter — ui|api|db|cli.
        #[arg(long)]
        layer: Option<String>,
        /// Emit the suggestion as a JSON object (`{provider_id, score,
        /// sample_count}`) or `null` when no provider clears the sample
        /// threshold. Without this, a human-readable line is printed.
        #[arg(long)]
        json: bool,
    },
}

#[derive(Subcommand)]
enum PrCommitReviewAction {
    /// List per-commit AI review rows for one PR.
    /// GET /api/v2/pr/commit-reviews?repo=…&platform=…&pr_number=…
    List {
        #[arg(long)]
        repo: String,
        #[arg(long)]
        platform: String,
        #[arg(long)]
        pr_number: i32,
        /// Optional canonical intent_type filter (FeatureAdd | BugFix |
        /// Refactor | Revert | Performance | Docs | Deps). The
        /// counts_by_intent_type histogram still spans the whole PR.
        #[arg(long)]
        intent_type: Option<String>,
        #[arg(long)]
        limit: Option<i64>,
        #[arg(long)]
        json: bool,
    },
    /// Fetch a single per-commit review row by commit SHA.
    /// GET /api/v2/pr/commit-reviews/{commit_sha}?repo=…&platform=…&pr_number=…
    /// (Cloud requires the PR scope on the query — the SHA alone is
    /// not unique across repos/PRs, so the row resolution needs all
    /// three.)
    Get {
        commit_sha: String,
        #[arg(long)]
        repo: String,
        #[arg(long)]
        platform: String,
        #[arg(long)]
        pr_number: i32,
        #[arg(long)]
        json: bool,
    },
    /// Run the per-commit AI review pipeline over a list of commits.
    /// POST /api/v2/pr/commit-review-generate. Commits come from a
    /// JSON file shaped as the GenerateRequest.commits array.
    Generate {
        #[arg(long)]
        repo: String,
        #[arg(long)]
        platform: String,
        #[arg(long)]
        pr_number: i32,
        /// Path to a JSON file containing the `commits` array
        /// (CommitInput[]). Use `-` to read from stdin.
        #[arg(long)]
        commits_json_file: String,
        /// Optional umbrella PR review event UUID to link the rows to.
        #[arg(long)]
        pr_review_event_id: Option<String>,
        #[arg(long)]
        json: bool,
    },
}

#[derive(Subcommand)]
enum KeysAction {
    /// Generate an X25519 identity keypair, encrypt it with a passphrase,
    /// upload the public key, and cache it locally.
    Init {
        /// Passphrase used to encrypt the private key at rest.
        #[arg(long)]
        passphrase: String,
    },
    /// Show the local identity public key (base64).
    Show,
    /// Fetch the wrapped org content key, unwrap it locally with your
    /// passphrase, cache it, and mark it active. After this, every
    /// `aura save` seals bodies and every `aura pull` decrypts them
    /// automatically. Non-E2E orgs never need to call this.
    Unlock {
        /// Org slug whose content key to unlock.
        org_slug: String,
        /// Passphrase used when you ran `aura keys init`.
        #[arg(long)]
        passphrase: String,
    },
    /// Rotate the org content key (admin only).
    Rotate {
        #[arg(long)]
        org_slug: String,
    },
    /// Export the encrypted identity file (portable across machines).
    Export {
        #[arg(long)]
        out: String,
    },
    /// Import an encrypted identity file previously exported.
    Import {
        #[arg(long)]
        file: String,
    },
    /// Verify a signed `aura/manifest` envelope (JCS RFC 8785 + ed25519).
    ///
    /// Reads a manifest JSON file, re-canonicalizes with `signature: null`,
    /// and verifies the ed25519 signature. If `--pubkey-b64` is omitted the
    /// local default signing key's public half is used.
    SigstoreVerify {
        /// Path to the signed manifest JSON file.
        manifest: String,
        /// Optional: base64-encoded ed25519 public key (32 bytes).
        /// Defaults to the local identity's verifying key.
        #[arg(long = "pubkey-b64")]
        pubkey_b64: Option<String>,
    },
    /// Sign an unsigned `aura/manifest` envelope in place.
    ///
    /// Reads a manifest JSON file (any shape that has or lacks a
    /// `signature` field), runs `manifest_sig::sign_manifest` with the
    /// local default signing key, and writes the signed manifest back to
    /// the same path (or to `--out` if specified).
    SigstoreSign {
        /// Path to the manifest JSON file to sign.
        manifest: String,
        /// Optional output path. Defaults to in-place rewrite.
        #[arg(long)]
        out: Option<String>,
    },
    /// Publish a signed `aura/manifest` to a Rekor transparency log.
    ///
    /// Reads the signed manifest, computes the canonical hash, POSTs a
    /// hashedrekord v0.0.1 entry to Rekor, and writes the returned UUID +
    /// log index to a sidecar file (`<manifest>.rekor.json` by default).
    /// Requires the manifest to be already signed (call `aura keys
    /// sigstore-sign` first — coming separately).
    RekorPublish {
        /// Path to the signed manifest JSON file.
        manifest: String,
        /// Rekor base URL. Defaults to public sigstore Rekor.
        #[arg(long = "rekor-url", default_value = "https://rekor.sigstore.dev")]
        rekor_url: String,
        /// Where to write the returned RekorEntryRef sidecar.
        /// Defaults to `<manifest>.rekor.json`.
        #[arg(long)]
        out: Option<String>,
    },
    /// Verify a manifest's Rekor entry by fetching it back and checking
    /// that the logged hash + signature match the local manifest.
    ///
    /// Reads the manifest + its `<manifest>.rekor.json` sidecar, fetches
    /// the entry from Rekor by UUID, and asserts no drift.
    RekorVerify {
        /// Path to the signed manifest JSON file.
        manifest: String,
        /// Path to the RekorEntryRef sidecar.
        /// Defaults to `<manifest>.rekor.json`.
        #[arg(long)]
        sidecar: Option<String>,
    },
    /// Rotate the local sigstore signing key. Generates a fresh ed25519
    /// keypair, replaces the keyfile atomically, and persists a
    /// `key_rotation` SentinelEvent block signed by the OLD key so a
    /// verifier can chain a future intent (signed by the NEW key) back
    /// to the prior identity.
    SigstoreRotate {
        /// Output as structured JSON envelope instead of text.
        #[arg(long)]
        json: bool,
    },
    /// Pull the rotation chain from the cloud mirror and materialize
    /// each block under `.aura/blocks/<id>.json`. Lets a fresh machine
    /// recover historical pubkeys that the chain-walk verifier needs to
    /// validate intents signed by rotated-out keys. Idempotent.
    SigstorePull {
        /// Output as structured JSON envelope instead of text.
        #[arg(long)]
        json: bool,
    },
    /// Read-only health probe for the local sigstore signing key.
    /// Mirrors the MCP `aura_status.signing` block and the `aura doctor`
    /// "Signing key" line — same single-source helper, so all three
    /// surfaces report the same diagnosis. Never mints a key as a
    /// side-effect (use `aura keys sigstore-rotate` to mint/rotate).
    /// Exits 0 on `ok`, 1 on `missing`/`unreadable`/`no_path`.
    SigstoreStatus {
        /// Output as structured JSON envelope instead of text.
        #[arg(long)]
        json: bool,
    },
}

#[derive(Subcommand)]
enum CrdtAction {
    /// Show cached CRDT cursor state + doc-path mappings
    Status,
    /// Force-pull latest ops for the current branch
    Pull,
}

#[derive(Subcommand)]
enum AttestAction {
    /// Verify a signed intent block by ID.
    ///
    /// Reads `.aura/blocks/<block_id>.json`, checks the ed25519 signature
    /// against the local signing key's public half, and — when the block
    /// carries `attestations.rekor` — also fetches the Rekor entry and
    /// asserts no drift (uuid, log_index, hash, signature).
    Verify {
        /// The block ID (UUID hex). Resolved against `.aura/blocks/`.
        block_id: String,
        /// Skip the Rekor inclusion check even if `attestations.rekor` is present.
        #[arg(long = "no-rekor")]
        no_rekor: bool,
        /// Emit the verification report as JSON instead of human-readable
        /// text. Mirrors the response shape of the aura_attest_verify
        /// MCP tool, so a shell script can parse it without regex.
        #[arg(long)]
        json: bool,
    },
    /// List signed intent blocks under `.aura/blocks/`.
    ///
    /// Prints one row per block (id, kind, created_at, sig?, rekor?,
    /// intent_type) so a user can quickly see which intents have
    /// signatures + transparency log entries + canonical type tags
    /// without opening each JSON file by hand.
    List {
        /// Output the listing as JSON (one object per row) instead of text.
        #[arg(long)]
        json: bool,
        /// Filter to blocks signed for a specific human DID. Accepts
        /// either the raw env value (e.g. "ashiq@naridon") or the
        /// canonical DID form (e.g. "did:aura:human/ashiq-naridon") —
        /// matched case-sensitive against either slot in the block.
        #[arg(long)]
        human: Option<String>,
        /// S2-TIL filter: restrict to blocks whose canonical intent_type
        /// matches. One of FeatureAdd, BugFix, Refactor, Revert,
        /// Performance, Docs, Deps. Validated CLI-side; invalid values
        /// fail with the canonical list. Untyped blocks are excluded
        /// when this filter is present.
        #[arg(long = "type")]
        intent_type: Option<String>,
    },
    /// Make your AI-work records checkable by your teammates.
    ///
    /// Two things happen, both written into files your team already
    /// shares through git:
    ///   1. Your verification key is published to `.aura/team/keys.jsonl`
    ///      (just the public half — your teammates need it to re-check
    ///      your work; the secret half never leaves your machine).
    ///   2. Every signed record you've made is copied into `.aura/attest/`
    ///      so teammates have the proof itself, not only a reference to it.
    ///
    /// After you commit + push, anyone on the team can run
    /// `aura attest verify <id>` and independently confirm the record is
    /// genuine — on their own machine, without trusting yours.
    Share {
        /// Emit the report as JSON instead of human-readable text.
        #[arg(long)]
        json: bool,
    },
}

#[derive(Subcommand)]
enum BlocksSubcommands {
    /// List recent blocks from the local store, newest first.
    List {
        /// Filter to a specific kind (e.g. command, message, proposal).
        #[arg(long)]
        kind: Option<String>,
        /// Max blocks to show.
        #[arg(long, default_value = "20")]
        limit: u32,
        /// Output the raw JSON envelopes instead of the digest.
        #[arg(long)]
        json: bool,
    },
}

#[derive(Subcommand)]
enum MsgSubcommands {
    /// Send a message to the team or a specific developer
    Send {
        /// The message text
        message: String,
        /// Optional: send to a specific user (DM) instead of the whole team
        #[arg(long)]
        to: Option<String>,
    },
    /// List recent messages for this repository
    List {
        /// Max messages to show (default: 20)
        #[arg(long, default_value = "20")]
        limit: usize,
        /// Output raw JSON
        #[arg(long)]
        json: bool,
    },
}

#[derive(Subcommand)]
enum GoalsSubcommands {
    /// Check whether the code actually delivers a goal — and remember the result
    Prove {
        /// What you're building, in plain words ("users can sign in via Google")
        text: String,
        /// Optionally tie this goal to a board task (e.g. AURA-42)
        #[arg(long)]
        task: Option<String>,
        /// Output raw JSON
        #[arg(long)]
        json: bool,
    },
    /// List every tracked goal with whether the code backs it up
    List {
        /// Output raw JSON
        #[arg(long)]
        json: bool,
    },
    /// Show one goal: what it needs, and what's in place
    Show {
        /// Goal id (goal_…) or its text
        goal: String,
        /// Output raw JSON
        #[arg(long)]
        json: bool,
    },
    /// Re-check a goal against the code right now and explain how we know
    Why {
        /// Goal id (goal_…) or its text
        goal: String,
        /// Output raw JSON
        #[arg(long)]
        json: bool,
    },
    /// Tie an existing goal to a board task
    Link {
        /// Goal id (goal_…) or its text
        goal: String,
        /// Board task ref (e.g. AURA-42)
        task: String,
    },
    /// Attach a goal to a task with a plain-language verify plan (no proving)
    Add {
        /// What "done" looks like, in plain words ("users can sign in via Google")
        text: String,
        /// Tie this goal to a board task (e.g. AURA-42)
        #[arg(long)]
        task: Option<String>,
        /// A check to verify the goal is met — repeat for each (--check "…" --check "…")
        #[arg(long = "check")]
        check: Vec<String>,
        /// Output raw JSON
        #[arg(long)]
        json: bool,
    },
}

#[derive(Subcommand)]
enum ServerSubcommands {
    /// Register a new account on a self-hosted Aura Server
    Register {
        /// Server URL (e.g., http://localhost:3001)
        #[arg(long)]
        url: String,
        /// Username
        #[arg(long)]
        username: String,
        /// Password
        #[arg(long)]
        password: String,
    },
    /// Log in to a self-hosted Aura Server
    Login {
        /// Server URL (e.g., http://localhost:3001)
        #[arg(long)]
        url: String,
        /// Username
        #[arg(long)]
        username: String,
        /// Password
        #[arg(long)]
        password: String,
    },
    /// Register a repository with the connected Aura Server
    AddRepo {
        /// Repository name in owner/repo format
        repo_name: String,
    },
    /// Check connection to the configured Aura Server
    Status,
}

#[derive(Subcommand)]
enum HostSubcommands {
    /// Start the mothership server — your machine becomes the team hub
    Start {
        /// Port to listen on (default: 7700)
        #[arg(long, default_value = "7700")]
        port: u16,
        /// Open a tunnel for internet access (auto-detects bore or cloudflared)
        #[arg(long)]
        tunnel: bool,
        /// Disable TLS (plain HTTP — only for local testing)
        #[arg(long)]
        no_tls: bool,
        /// Run in foreground (blocking) — used by daemon and LaunchAgent internally
        #[arg(long)]
        foreground: bool,
        /// Install as macOS LaunchAgent so it auto-starts on login
        #[arg(long)]
        install: bool,
    },
    /// Generate an invite code for teammates to join
    Invite {
        /// Lock this invite to a specific username (only they can use it)
        #[arg(long, alias = "for")]
        for_user: Option<String>,
        /// Max number of times this code can be used (default: 1)
        #[arg(long, default_value = "1")]
        max_uses: i32,
        /// Hours until the code expires (default: 168 = 7 days)
        #[arg(long, default_value = "168")]
        expires_hours: i64,
    },
    /// List all registered users on the mothership
    Users,
    /// Remove a user from the mothership
    Kick {
        /// Username to remove
        username: String,
    },
    /// Show mothership status — connected peers, registered users, repos
    Status,
    /// Stop the running mothership process
    Stop,
    /// Remove the macOS LaunchAgent (stops auto-start on login)
    Uninstall,
}

#[derive(Subcommand)]
enum TeamSubcommands {
    /// Link the current repo to the team mothership — syncs through the team hub
    Link,
    /// Unlink the current repo from the team — stops syncing, keeps local data
    Unlink,
    /// Show which repos are team-managed
    Status,
    /// Shared team knowledge base — ask what the team has learned
    Knowledge {
        #[command(subcommand)]
        sub: KnowledgeSubcommands,
    },
    /// Manage sentinel zones — claim files/dirs so the team knows who owns what
    Zones {
        #[command(subcommand)]
        sub: ZoneSubcommands,
    },
    /// Auto-responder: spawn a background `claude -p` when team messages arrive
    Responder {
        #[command(subcommand)]
        sub: ResponderSubcommands,
    },
}

#[derive(Subcommand)]
enum ResponderSubcommands {
    /// Turn the auto-responder ON for this machine
    Enable {
        /// Binary to spawn (default: claude)
        #[arg(long, default_value = "claude")]
        command: String,
        /// Minimum seconds between spawns (default: 30)
        #[arg(long, default_value = "30")]
        cooldown: u64,
        /// Max spawns per UTC day (default: 50)
        #[arg(long, default_value = "50")]
        daily_cap: u32,
        /// Optional dedicated bot session id to --resume
        #[arg(long)]
        resume_session: Option<String>,
    },
    /// Turn the auto-responder OFF
    Disable,
    /// Show responder status, cooldown, daily count
    Status,
}

#[derive(Subcommand)]
enum KnowledgeSubcommands {
    /// Store a piece of knowledge for the team
    Store {
        /// The question/topic (e.g., "How does retry logic work?")
        #[arg(long)]
        question: String,
        /// The answer/insight
        #[arg(long)]
        answer: String,
        /// Category (general, bug, pattern, decision, etc.)
        #[arg(long, default_value = "general")]
        category: String,
        /// Tags for searchability
        #[arg(long, value_delimiter = ',')]
        tags: Vec<String>,
    },
    /// Query the team knowledge base
    Query {
        /// Search text
        search: Option<String>,
        /// Filter by category
        #[arg(long)]
        category: Option<String>,
        /// Max results
        #[arg(long, default_value = "10")]
        limit: usize,
        /// Emit JSON instead of human-formatted output (for shell consumers).
        #[arg(long)]
        json: bool,
    },
    /// Upvote a knowledge entry (pass the ID)
    Upvote {
        id: String,
    },
}

#[derive(Subcommand)]
enum ZoneSubcommands {
    /// Claim a file pattern as yours (e.g., "src/auth/**")
    Claim {
        /// Glob patterns to claim (e.g., "src/auth/**")
        #[arg(required = true)]
        patterns: Vec<String>,
        /// Mode: warn (default) or block
        #[arg(long, default_value = "warn")]
        mode: String,
        /// Label for this zone claim
        #[arg(long)]
        label: Option<String>,
    },
    /// List all zone claims for this repo
    List {
        /// Emit JSON (the remote zones array) instead of the human table,
        /// for shell consumers like the desktop `/zones` card.
        #[arg(long)]
        json: bool,
    },
    /// Release a zone claim
    Release {
        /// Zone ID to release
        zone_id: String,
    },
    /// Check if a file is in someone else's zone
    Check {
        /// File path to check
        file_path: String,
    },
}

#[derive(Subcommand)]
enum LiveSubcommands {
    /// Start streaming function-level changes to Aura Cloud in real-time
    Start {
        /// Go Live with whole-file CRDT collaboration: the entire working tree
        /// syncs conflict-free (not just function bodies), with the CRDT daemon
        /// as the sole disk writer for this repo. Persists until `live stop`.
        #[arg(long)]
        collab: bool,
    },
    /// Stop live streaming
    Stop,
    /// Show current team presence and what functions are being worked on
    Status,
    /// List unresolved cross-branch dependency impacts on your code
    Impacts {
        /// Output raw JSON instead of pretty-printed table
        #[arg(long)]
        json: bool,
    },
    /// Function-level code sync — push/pull function bodies across the team
    Sync {
        #[command(subcommand)]
        sub: SyncSubcommands,
    },
    /// Fast notification check — reads local markers, no network. For use in hooks.
    Check {
        /// Optional file path to check zone ownership
        #[arg(long)]
        file: Option<String>,
    },
}

#[derive(Subcommand)]
enum SyncSubcommands {
    /// Push current file's function bodies to the cloud for teammates to pull
    Push {
        /// File path to push (pushes all tracked functions in the file)
        file: String,
    },
    /// Pull function changes from teammates and apply them to your local files
    Pull {
        /// Dry run — show what would change without applying
        #[arg(long)]
        dry_run: bool,
        /// Include functions their author flagged as a red (broken) build.
        /// Default is to skip them so your tree stays green.
        #[arg(long)]
        allow_red: bool,
    },
    /// Show sync status: pending changes, active pushers, synced functions
    Status,
    /// Backfill existing local .aura/snapshots/*.json to the cloud dashboard
    Backfill,
}

#[derive(Subcommand)]
enum ConfigSubcommands {
    /// Set a configuration value non-interactively
    Set {
        /// The key to set (e.g., "strict-mode", "api-key")
        key: String,
        /// The value to set
        value: String,
    },
    /// Reset or change the strict-mode passcode
    ResetPasscode {
        /// Force-reset: disables strict mode and clears passcode without verifying the old one
        #[arg(long)]
        force: bool,
    },
}

#[derive(Subcommand)]
enum PolicySubcommands {
    /// Add a standard architectural policy pack to your production.aura.json
    Add {
        /// The name of the pack (e.g., 'security', 'payments', 'web-app', 'owasp', 'airbnb-js', 'google-style', 'pep-python')
        pack_name: String,
    },
    /// List all available policy packs (with --json for machine output)
    List {
        /// Emit JSON instead of a pretty table
        #[arg(long)]
        json: bool,
    },
}

#[derive(Subcommand)]
enum LoopSubcommands {
    /// Mint a node into the dependency graph (`.aura/a2a/`).
    Add {
        /// Short title for the work item.
        title: String,
        /// The work spec / prompt the runner hands the agent.
        #[arg(short, long, default_value = "")]
        input: String,
        /// Priority: low | medium | high | critical.
        #[arg(short, long, default_value = "medium")]
        priority: String,
        /// Kind: plan | wave | task | subtask.
        #[arg(short, long, default_value = "task")]
        kind: String,
        /// Depends-on ids (repeatable). The node stays blocked until each
        /// is completed.
        #[arg(long = "dep")]
        deps: Vec<String>,
        /// Acceptance criteria the verify gate proves against.
        #[arg(long)]
        ac: Option<String>,
        /// Agent to dispatch for this node (e.g. claude | aura | codex).
        #[arg(long)]
        agent: Option<String>,
        /// Which machine should run it: `cloud` sends it to a connected box (it
        /// is offered to the board on the next sync and your laptop leaves it
        /// alone), `local` pins it to a machine you're sitting at. Omit and any
        /// machine may take it.
        #[arg(long)]
        place: Option<String>,
        /// Comma-separated tags.
        #[arg(long, default_value = "")]
        tags: String,
        #[arg(long)]
        json: bool,
    },
    /// Add or remove a dependency edge between two nodes.
    Dep {
        /// The dependent node (the one that waits).
        id: String,
        /// The node it depends on (must complete first).
        on: String,
        /// Remove the edge instead of adding it.
        #[arg(long)]
        rm: bool,
        #[arg(long)]
        json: bool,
    },
    /// Print the READY SET — nodes whose dependencies are all completed
    /// and which aren't done or in flight. This is `bd ready`, native.
    Ready {
        #[arg(long)]
        json: bool,
    },
    /// List every node grouped by ready / blocked / working / done.
    List {
        #[arg(long)]
        json: bool,
    },
    /// Show one node's full detail (deps, status, lease, acceptance).
    Show {
        id: String,
        #[arg(long)]
        json: bool,
    },
    /// One-line counts: ready / blocked / working / done / other.
    Status {
        #[arg(long)]
        json: bool,
    },
    /// Set a node's status directly (submitted | working | completed |
    /// failed | canceled | rejected | input-required | auth-required | paused).
    Set {
        id: String,
        status: String,
        #[arg(long)]
        json: bool,
    },
    /// Pause work: hold nodes back from the ready set without losing them.
    /// Give a node id, or scope a whole goal (`--goal`) or crew (`--crew`) so
    /// every submitted/working node under it parks at once. Paused nodes resume
    /// to `submitted` — nothing is canceled.
    Pause {
        /// A single node id to pause (omit when using --goal/--crew).
        id: Option<String>,
        /// Pause every node tagged `goal:<this>`.
        #[arg(long)]
        goal: Option<String>,
        /// Pause every node in this crew.
        #[arg(long)]
        crew: Option<String>,
        #[arg(long)]
        json: bool,
    },
    /// Resume paused work back into the ready set. Mirrors `pause`: a node id,
    /// or a `--goal` / `--crew` scope to un-park a whole slice at once.
    Resume {
        /// A single node id to resume (omit when using --goal/--crew).
        id: Option<String>,
        /// Resume every paused node tagged `goal:<this>`.
        #[arg(long)]
        goal: Option<String>,
        /// Resume every paused node in this crew.
        #[arg(long)]
        crew: Option<String>,
        #[arg(long)]
        json: bool,
    },
    /// Show the run history — every `aura loop run`, newest first, with its
    /// scope (whole graph / one goal / one crew), node count, outcome tallies
    /// and per-node commits. Reads `.aura/crew/runs.jsonl`.
    Runs {
        /// Cap how many runs to print (0 = all).
        #[arg(long, default_value_t = 20)]
        limit: usize,
        #[arg(long)]
        json: bool,
    },
    /// List the crews in this project — the default "main" crew plus any
    /// spawned ones, each with its live lifecycle counts. Many crews can run
    /// in parallel, each draining its own slice of the graph.
    Crews {
        #[arg(long)]
        json: bool,
    },
    /// Stand up a second crew to run in parallel — mint a named crew and,
    /// optionally, move existing nodes into it so it has work right away.
    Spawn {
        /// Human name for the crew (slugged into a stable crew id).
        title: String,
        /// Optional one-line purpose.
        #[arg(long)]
        description: Option<String>,
        /// Node ids to move into the new crew (repeatable).
        #[arg(long = "task")]
        tasks: Vec<String>,
        #[arg(long)]
        json: bool,
    },
    /// Run the autonomous loop: claim the ready set, dispatch each node to
    /// its agent through the harness, record the commit + verify, repeat
    /// until nothing is ready. This is the native `hew`/Ralph loop.
    Run {
        /// Default agent for nodes that don't name their own.
        #[arg(long, default_value = "claude")]
        agent: String,
        /// Lease duration (seconds). A crashed runner's node is reclaimed
        /// after this elapses.
        #[arg(long, default_value_t = 1800)]
        lease_secs: i64,
        /// Stop after this many nodes (0 = until the ready set drains).
        #[arg(long, default_value_t = 0)]
        max: usize,
        /// Verify command run in the repo after each node; non-zero fails
        /// the node (e.g. "cargo check" or "bun run tsc").
        #[arg(long)]
        verify: Option<String>,
        /// Print what would be dispatched without spawning any agent.
        #[arg(long)]
        dry_run: bool,
        /// Keep polling for newly-ready nodes instead of exiting when the
        /// ready set drains (Ctrl-C to stop).
        #[arg(long)]
        watch: bool,
        /// How many nodes to work at once. 1 (default) is the classic
        /// sequential loop; >1 runs each ready node in its own throwaway git
        /// worktree and merges the good ones back — independent tasks build in
        /// parallel without branch-switch churn.
        #[arg(long, default_value_t = 1)]
        jobs: usize,
        /// On a failed acceptance gate (verify command or goal proof), revert
        /// the node's commit instead of leaving broken code on the branch. In
        /// `--jobs` mode rollback is automatic (the bad work dies with its
        /// worktree); this flag governs the sequential, commit-in-place path.
        #[arg(long)]
        rollback: bool,
        /// Drain only the nodes tagged `goal:<this>` — start one goal on its own
        /// while the rest of the board waits.
        #[arg(long)]
        goal: Option<String>,
        /// Drain only this crew's nodes — run one crew while another is working.
        #[arg(long)]
        crew: Option<String>,
        /// Which machine this process is. `local` (the default) runs the nodes
        /// meant for a machine you're sitting at and leaves the cloud-placed
        /// ones for a runner; `cloud` is the inverse and is what `aura runner
        /// serve` passes. Nodes with no placement run under both.
        #[arg(long, default_value = "local")]
        place: String,
        #[arg(long)]
        json: bool,
    },
    /// Seed the graph from an existing plan file — each wave becomes a node
    /// and waves chain via dependency edges (brownfield bootstrap).
    Seed {
        /// Path to a plan markdown/XML file (defaults to
        /// .aura/plans/PLAN.md).
        #[arg(long)]
        from: Option<String>,
        /// Default agent for the seeded nodes.
        #[arg(long, default_value = "claude")]
        agent: String,
        #[arg(long)]
        json: bool,
    },
    /// Read the ORDERLESS pile bucketed into focused chunks (epic → sprint →
    /// batch) so a big board can be planned in FULL — prints JSON a planner
    /// agent reasons over, then writes back with `loop plan-apply`. This is the
    /// same context Aura's desktop "plan an order" uses; here the agent is the
    /// planner.
    PlanContext {
        #[arg(long)]
        json: bool,
    },
    /// Apply a planned order from JSON ({ "edges": [{task,depends_on}],
    /// "goals": [{goal,tasks}], "objectives": [{objective,goals}] }) read from
    /// --file or stdin. Wires cycle-checked dependency edges and stamps
    /// goal:/objective: tags — the same graph the desktop builds.
    PlanApply {
        /// Path to a plan JSON file. Reads stdin when omitted.
        #[arg(long)]
        file: Option<String>,
        #[arg(long)]
        json: bool,
    },
    /// Reality-check the pile BEFORE planning: flag tasks that are already
    /// finished (a finished task shares the name, or recent commits delivered
    /// it), duplicates of another pending task, or empty stubs. Honest signals
    /// only — it never guesses the code is done. The planner (or a human) drops
    /// or keeps each. `--commits N` widens the finished-work evidence window.
    Review {
        /// How many recent commit subjects to treat as finished-work evidence.
        #[arg(long, default_value_t = 40)]
        commits: usize,
        #[arg(long)]
        json: bool,
    },
    /// List existing goals on the board that NEW tasks could attach to instead
    /// of starting a disconnected island — each with the tail steps to hang the
    /// new work after. Empty when nothing's grouped under a goal yet.
    AttachTargets {
        #[arg(long)]
        json: bool,
    },
    /// Sync the task graph over git so tasks flow between machines: commit any
    /// local `.aura/a2a/` graph changes, pull peers' updates (rebase), then
    /// push. Run it after `loop add` to send a task to a remote runner, or let
    /// the runner call it each cycle. Ephemeral leases (`*.lease.json`,
    /// gitignored) never travel — only the durable graph.
    Sync {
        /// Pull only — fetch peers' task-graph updates without committing or
        /// pushing local changes.
        #[arg(long)]
        pull_only: bool,
        /// Push only — commit and push local graph changes without pulling.
        #[arg(long)]
        push_only: bool,
        /// Remote to sync against.
        #[arg(long, default_value = "origin")]
        remote: String,
        #[arg(long)]
        json: bool,
    },
    /// Bridge the task graph to the cloud A2A board so work initiated from
    /// anywhere (the mobile app, the web console, another agent) reaches this
    /// runner without a git client. `--pull` mints ready cloud tasks into the
    /// local graph (claiming each so no peer double-runs it); `--push` reports
    /// finished nodes back to the cloud with their commit + result. With
    /// neither flag it does both. This is the no-git delivery plane that pairs
    /// with `loop sync` (the git one).
    CloudSync {
        /// Pull ready cloud tasks into the local graph (skip the push-back).
        #[arg(long)]
        pull: bool,
        /// Push finished local nodes back to the cloud (skip the pull).
        #[arg(long)]
        push: bool,
        /// Repo to scope cloud tasks to (github `owner/repo`). Defaults to the
        /// current git remote; pass explicitly when they differ.
        #[arg(long)]
        repo: Option<String>,
        /// Agent to dispatch for pulled tasks that don't name one themselves.
        #[arg(long, default_value = "claude")]
        agent: String,
        /// Max tasks to pull per call.
        #[arg(long, default_value_t = 50)]
        limit: i64,
        #[arg(long)]
        json: bool,
    },
}

#[derive(Subcommand)]
enum RunnerSubcommands {
    /// Register this account as a cloud runner and mint its token (shown
    /// once). Uses your cloud login; the printed token is what the runner
    /// box exports as AURA_RUNNER_TOKEN.
    Register {
        /// Display name for the runner (e.g. "home-server", "ci-box").
        #[arg(long)]
        name: String,
        /// Scope the runner to one repo (owner/name). Omit for org-wide.
        #[arg(long)]
        repo: Option<String>,
        /// Agent CLIs this box can run, comma-separated (e.g. "claude").
        #[arg(long, default_value = "claude")]
        agents: String,
    },
    /// Run the supervise loop: pull cloud crew tasks, drain the ready set,
    /// push status + commits, heartbeat, repeat. This is what you leave
    /// running on the always-on box.
    Serve {
        /// Display name used in logs (defaults to the registry name / host).
        #[arg(long)]
        name: Option<String>,
        /// Default agent for tasks that don't name their own kind.
        ///
        /// Falls back to `AURA_RUNNER_AGENT`, so a box that carries its tuning
        /// in `runner.env` keeps it even when the unit passes no flags.
        #[arg(long, env = "AURA_RUNNER_AGENT", default_value = "claude")]
        agent: String,
        /// Restrict the cloud task pull to one repo (owner/name).
        #[arg(long)]
        repo: Option<String>,
        /// Lease window (seconds) handed to each claimed task.
        #[arg(long, env = "AURA_RUNNER_LEASE_SECS", default_value_t = 1800)]
        lease_secs: i64,
        /// Seconds to sleep between cycles when the backlog is empty.
        #[arg(long, env = "AURA_RUNNER_POLL_SECS", default_value_t = 20)]
        poll_secs: u64,
        /// Run one cycle and exit (for testing or cron-driven runners).
        #[arg(long)]
        once: bool,
        /// Also sync the task graph over git each cycle (pull peers' graph
        /// before draining, push it after). Use on a clean containerized
        /// runner; leave off for a manual run to avoid rebasing underfoot.
        #[arg(long)]
        git_sync: bool,
        /// Drain EVERY project in your org that has pending cloud work, each in
        /// its own auto-cloned workspace — so one always-on box runs all of your
        /// projects, not just one. Ignored if `--repo` is set (which pins the
        /// box to a single project).
        #[arg(long)]
        all_projects: bool,
        /// Where per-project workspaces are cloned in `--all-projects` mode.
        /// Defaults to a `workspaces/` dir beside this box's checkout (or set
        /// AURA_RUNNER_WORKSPACES).
        #[arg(long)]
        workspaces_root: Option<String>,
    },
    /// Print this box's runner record from the cloud (needs AURA_RUNNER_TOKEN).
    Status,
    /// Install the runner as a systemd service so it survives logout and
    /// reboot. Without this a runner started by hand dies with its shell.
    Install {
        /// Install under your own user (no root) and enable lingering so it
        /// still starts at boot. This is the right choice on a box shared by
        /// several people — each gets their own runner, credentials and limits.
        #[arg(long)]
        user: bool,
        /// Runner display name (defaults to this box's hostname).
        #[arg(long)]
        name: Option<String>,
        /// Pin the runner to one repo (owner/name). Omit to drain every project.
        #[arg(long)]
        repo: Option<String>,
        /// Default agent for tasks that don't name their own.
        #[arg(long)]
        agent: Option<String>,
        /// Path to the file holding AURA_RUNNER_TOKEN. Omit to look in the
        /// usual places (~/.config/aura/runner.env, /etc/aura-runner/runner.env).
        #[arg(long)]
        env_file: Option<String>,
        /// Cap CPU, systemd syntax — "400%" is four cores. "auto" lets the box
        /// work out one member's share from its own core count, leaving a core
        /// for the machine itself. Omit for no CPU limit at all.
        #[arg(long)]
        cpu_quota: Option<String>,
        /// Cap memory, systemd syntax — e.g. "8G", or "auto" for this box's own
        /// share arithmetic. The memory the kernel and sshd need is always left
        /// outside the cap, which is what keeps a box under a runaway build one
        /// you can still log into.
        #[arg(long)]
        memory_max: Option<String>,
        /// Cap swap, systemd syntax, or "auto". Added to --memory-max rather
        /// than taken out of it. This is the give under the ceiling: with swap,
        /// a build that reaches its limit gets slow; without it, it gets killed.
        #[arg(long)]
        memory_swap_max: Option<String>,
        /// How many people share this box, for "auto" to divide by. Omit and
        /// the box counts its own accounts.
        #[arg(long)]
        members: Option<u32>,
    },
    /// Stop, disable and remove the runner's systemd service.
    Uninstall {
        /// Target the per-user unit rather than the system one.
        #[arg(long)]
        user: bool,
    },
    /// Show `systemctl status` for the installed runner service.
    Service {
        /// Target the per-user unit rather than the system one.
        #[arg(long)]
        user: bool,
    },
    /// Manage the API keys this box runs agents with — the unattended
    /// alternative to signing in through a browser.
    Creds {
        #[command(subcommand)]
        cmd: CredsSubcommands,
    },
}

#[derive(Subcommand)]
enum CredsSubcommands {
    /// Store an API key for one agent (written 0600, never printed back).
    Set {
        /// Agent name: claude, codex or gemini.
        #[arg(long)]
        agent: String,
        /// The key itself. Prefer piping it in via --key-stdin so it doesn't
        /// land in your shell history.
        #[arg(long, conflicts_with = "key_stdin")]
        key: Option<String>,
        /// Read the key from stdin instead of the command line.
        #[arg(long)]
        key_stdin: bool,
    },
    /// List which agents this box can authenticate (keys shown masked).
    List,
    /// Forget one agent's key.
    Clear {
        #[arg(long)]
        agent: String,
    },
}

#[derive(Subcommand)]
enum TaskSubcommands {
    /// Create a new task
    New {
        /// Task title
        title: String,
        /// Optional body / description
        #[arg(short, long, default_value = "")]
        body: String,
        /// Priority: low | medium | high | critical
        #[arg(short, long, default_value = "medium")]
        priority: String,
        /// Comma-separated labels
        #[arg(short, long, default_value = "")]
        labels: String,
        /// Author (defaults to git config user.name / "anon")
        #[arg(long)]
        author: Option<String>,
        /// Emit JSON
        #[arg(long)]
        json: bool,
    },
    /// List tasks
    List {
        /// Filter by status: open | in_progress | blocked | done | cancelled
        #[arg(short, long)]
        status: Option<String>,
        /// Filter by assignee
        #[arg(short, long)]
        assignee: Option<String>,
        /// Filter by claimed_by
        #[arg(long)]
        claimed_by: Option<String>,
        /// Emit JSON
        #[arg(long)]
        json: bool,
    },
    /// Show full task detail
    Show {
        id: String,
        #[arg(long)]
        json: bool,
    },
    /// Claim a task (assigns to current user/agent and marks in_progress)
    Claim {
        id: String,
        /// Override claimer name (defaults to git config user.name / "anon")
        #[arg(long)]
        as_who: Option<String>,
        #[arg(long)]
        json: bool,
    },
    /// Release claim on a task
    Unclaim {
        id: String,
        #[arg(long)]
        json: bool,
    },
    /// Assign a task to someone (without claiming)
    Assign {
        id: String,
        /// Assignee name; pass "none" to clear
        who: String,
        #[arg(long)]
        json: bool,
    },
    /// Add a comment to a task
    Comment {
        id: String,
        body: String,
        /// Override author name
        #[arg(long)]
        as_who: Option<String>,
        #[arg(long)]
        json: bool,
    },
    /// Mark task done
    Close {
        id: String,
        #[arg(long)]
        json: bool,
    },
    /// Reopen a closed task
    Reopen {
        id: String,
        #[arg(long)]
        json: bool,
    },
    /// Update task status manually (open|in_progress|blocked|done|cancelled)
    Status {
        id: String,
        status: String,
        #[arg(long)]
        json: bool,
    },
    /// Link a task to a PR or branch
    Link {
        id: String,
        /// PR identifier (e.g. "#123" or URL)
        #[arg(long)]
        pr: Option<String>,
        /// Branch name
        #[arg(long)]
        branch: Option<String>,
        #[arg(long)]
        json: bool,
    },
}

#[derive(Subcommand)]
enum ActivitySubcommands {
    /// Show recent activity (newest first)
    Tail {
        /// Number of events to show
        #[arg(short, long, default_value = "30")]
        n: usize,
        #[arg(long)]
        json: bool,
    },
    /// Manually emit an activity event (used by hooks / agents)
    Emit {
        /// Verb (e.g. "snapshot", "intent", "review")
        verb: String,
        /// Target (task id, file path, etc)
        target: String,
        /// Optional summary
        #[arg(short, long)]
        summary: Option<String>,
        /// Override actor
        #[arg(long)]
        actor: Option<String>,
        #[arg(long)]
        json: bool,
    },
}

#[derive(Subcommand)]
enum WorktreeSubcommands {
    /// The board: every checkout, who is working in it, and what is contended.
    /// Same as bare `aura worktrees`.
    List {
        #[arg(long)]
        json: bool,
        /// Skip the per-checkout working-tree read (dirty count, drift from
        /// trunk). Two git invocations per checkout, so worth dropping on a
        /// repo with many trees when you only want the roster.
        #[arg(long)]
        no_git_status: bool,
        /// Include checkouts that are clean and have nobody working in them.
        /// They're summarised as a count by default so the busy ones lead.
        #[arg(long)]
        all: bool,
    },
    /// Which checkout am I in, and where does my state land? Prints the shared
    /// plane and the private one, which is the whole design in two lines.
    Whoami {
        #[arg(long)]
        json: bool,
    },
    /// Say something to another checkout. `--to <name>` addresses one (use
    /// `main` for the main checkout); omitted, it reaches every agent.
    Say {
        /// The message.
        message: String,
        /// Who to address: a checkout (`auckland`, `main`), an agent
        /// (`codex`), or one agent in one checkout (`codex@auckland`).
        /// Omitted, the message reaches every agent in every checkout.
        #[arg(long)]
        to: Option<String>,
        #[arg(long)]
        json: bool,
    },
    /// Read what other checkouts have said to this one.
    Inbox {
        #[arg(short, long, default_value = "20")]
        limit: usize,
        /// Collect mail addressed to this agent by name, e.g. `codex`. A
        /// session that has already claimed work is recognised without it.
        #[arg(long)]
        agent: Option<String>,
        #[arg(long)]
        json: bool,
    },
    /// Hand a board task to an agent in another checkout — "codex, in
    /// auckland, take AURA-42". Writes the address onto the task AND tells
    /// the agent, so the assignment survives everyone logging off.
    Assign {
        /// The task: a uuid, `AURA-42`, or a bare `42`.
        task: String,
        /// Agent to give it to, e.g. `codex`, `claude`, `gemini`.
        #[arg(long)]
        to: Option<String>,
        /// Checkout the work is to happen in, e.g. `auckland` or `main`.
        #[arg(long = "in")]
        in_worktree: Option<String>,
        #[arg(long)]
        json: bool,
    },
    /// What has been assigned to me here — the board rows addressed to this
    /// checkout, and to this agent or to nobody in particular.
    Mine {
        /// Answer as this agent rather than the session's own identity.
        #[arg(long)]
        agent: Option<String>,
        #[arg(short, long, default_value = "20")]
        limit: usize,
        #[arg(long)]
        json: bool,
    },
}

#[derive(Subcommand)]
enum RadarSubcommands {
    /// Show the team awareness feed (newest first). Same as bare `aura radar`.
    Show {
        /// Only show events touching this path fragment or symbol.
        #[arg(long)]
        focus: Option<String>,
        /// Max events to show. [default: 20]
        #[arg(short, long)]
        limit: Option<usize>,
        #[arg(long)]
        json: bool,
    },
    /// The reasoned layer: show ONLY genuine/possible collisions against your
    /// own current work (dirty files + symbols you've announced). Quiet by
    /// design — random edits to unrelated files never surface here.
    Conflicts {
        /// Treat this agent label as "me" too, so your own events are skipped
        /// (e.g. `--as claude@cursor`).
        #[arg(long = "as")]
        as_actor: Option<String>,
        /// Include weaker (possible) signals as well as direct/likely ones.
        #[arg(long)]
        all: bool,
        #[arg(long)]
        json: bool,
    },
    /// Announce in-flight work so teammates and other agents are aware before a
    /// commit/PR. Any agent can shell out to this.
    Emit {
        /// What kind: started|editing|intent|impact|zone|paused|abandoned|committed
        #[arg(default_value = "editing")]
        kind: String,
        /// File being touched.
        #[arg(long)]
        file: Option<String>,
        /// AST symbol (function/class) being touched.
        #[arg(long)]
        symbol: Option<String>,
        /// The *why* — a short human-readable intent.
        #[arg(long)]
        intent: Option<String>,
        /// Projected blast-radius summary.
        #[arg(long)]
        impact: Option<String>,
        /// Emit as an AI agent under this label (e.g. `claude@cursor`). When
        /// omitted, the human git user is the actor.
        #[arg(long)]
        agent: Option<String>,
        #[arg(long)]
        json: bool,
    },
    /// Wire `aura validate-tool` into Claude Code's PreToolUse hook (project
    /// `.claude/settings.json`) so edits emit live `editing` events on the
    /// radar — and destructive ops hit the safety gate — with ZERO MCP. Git
    /// hooks already cover `committed`; this is the live half.
    Wire {
        /// Remove Aura's PreToolUse hook instead of installing it.
        #[arg(long)]
        undo: bool,
        /// Suppress success output (for scripted/`aura enable` use).
        #[arg(long)]
        quiet: bool,
    },
    /// Report whether the awareness plane is live WITHOUT MCP: signing
    /// identity, git hooks (`committed`), Claude Code PreToolUse (`editing`),
    /// and event volume — naming the fix for any missing piece.
    Status {
        #[arg(long)]
        json: bool,
    },
    /// Show or set this repo's broadcast privacy: off | intent-only |
    /// symbols (default) | diffs. Below `diffs`, Live function-body sync is
    /// blocked; `off` makes the repo fully dark (no push, no pull).
    Privacy {
        /// New level. Omit to show the current policy.
        level: Option<String>,
        #[arg(long)]
        json: bool,
    },
    /// Push pending local events to the team relay and pull teammates' in,
    /// through the active LiveTransport. Runs detached after each emit; call
    /// it directly to force a round now.
    Sync {
        #[arg(long)]
        json: bool,
        /// Suppress all output (used by the detached auto-sync).
        #[arg(long)]
        quiet: bool,
    },
}

#[derive(Subcommand)]
enum ReviewSubcommands {
    /// List persisted reviews (newest first)
    List {
        #[arg(long)]
        json: bool,
    },
    /// Show a single persisted review by unix timestamp
    Show {
        ts: i64,
        #[arg(long)]
        json: bool,
    },
    /// Configure reviewer/fixer roles for this repo (.aura/review_roles.json)
    Setup {
        /// Reviewer agents, comma-separated (e.g. claude,gemini,codex)
        #[arg(long)]
        reviewers: Option<String>,
        /// Fixer agent applied by `aura review fix`
        #[arg(long)]
        fixer: Option<String>,
        /// Base branch to diff reviews against
        #[arg(long)]
        base: Option<String>,
        #[arg(long)]
        json: bool,
    },
    /// Show the configured review roles
    Roles {
        #[arg(long)]
        json: bool,
    },
    /// Run role-driven review: Aura engine + a multi-agent specialist panel
    /// over the diff, adversarially verified
    Run {
        /// Override the configured reviewer agents (comma-separated)
        #[arg(long)]
        reviewers: Option<String>,
        /// Override the configured fixer agent
        #[arg(long)]
        fixer: Option<String>,
        /// Override the base branch
        #[arg(long)]
        base: Option<String>,
        /// How wide the specialist panel runs: low | medium | high | max
        /// (low = security+correctness; max = every dimension incl. readability)
        #[arg(long, default_value = "medium")]
        depth: String,
        /// Skip the adversarial verify pass (faster, but keeps false positives)
        #[arg(long)]
        no_verify: bool,
        /// Per-reviewer timeout in seconds
        #[arg(long, default_value = "900")]
        timeout_secs: u64,
        #[arg(long)]
        json: bool,
    },
    /// Pick findings from the last review and apply them via the fixer
    Fix {
        /// Override the base branch
        #[arg(long)]
        base: Option<String>,
        /// Override the fixer agent
        #[arg(long)]
        fixer: Option<String>,
        /// Apply all findings without prompting (CI-friendly)
        #[arg(long)]
        yes: bool,
        #[arg(long)]
        json: bool,
    },
    /// Post the last review's findings to a GitHub PR as line-anchored
    /// inline comments (one PR review, via `gh`)
    Post {
        /// PR number to post to (default: the PR for the current branch)
        #[arg(long)]
        pr: Option<u64>,
        /// Override the base branch (used only for the standalone Aura pass
        /// when there is no prior `aura review run`)
        #[arg(long)]
        base: Option<String>,
        /// Build and print the exact review payload without contacting GitHub
        #[arg(long)]
        dry_run: bool,
        #[arg(long)]
        json: bool,
    },
}

#[derive(Subcommand)]
enum IntentContractSubcommands {
    /// Record what the agent is authorised to change, before it runs.
    Approve {
        /// The goal in one line, in the requester's own words.
        #[arg(long)]
        goal: String,
        /// A symbol the agent may change. Repeatable.
        #[arg(long = "allow")]
        allow: Vec<String>,
        /// A symbol that must survive intact. Repeatable.
        #[arg(long = "protect")]
        protect: Vec<String>,
        /// A path prefix the work is scoped to. Repeatable.
        #[arg(long = "path")]
        path: Vec<String>,
        #[arg(long, default_value = "")]
        agent: String,
        #[arg(long, default_value = "")]
        session: String,
        #[arg(long, default_value = "")]
        worktree: String,
        /// Baseline tree to approve against (defaults to HEAD).
        #[arg(long)]
        baseline: Option<String>,
        /// Record the contract but leave the pre-commit gate uninstalled.
        #[arg(long)]
        no_hook: bool,
        #[arg(long)]
        json: bool,
    },
    /// Print the approved contract.
    Show {
        #[arg(long)]
        json: bool,
    },
    /// Widen the contract deliberately — the honest alternative to a bypass.
    Amend {
        /// Approve removing this symbol after all. Repeatable.
        #[arg(long = "approve-removal")]
        approve_removal: Vec<String>,
        #[arg(long)]
        json: bool,
    },
}

#[derive(Subcommand)]
enum IntentVsActualSubcommands {
    /// List recent commits with their commit-time intent counts (cheap)
    List {
        /// How many commits to walk back (default 50)
        #[arg(short, long, default_value = "50")]
        n: usize,
        #[arg(long)]
        json: bool,
    },
    /// Score a single commit — full AST diff + intent alignment
    Show {
        /// Anything `git revparse` understands: full sha, short sha,
        /// HEAD, HEAD~1, branch name.
        sha: String,
        #[arg(long)]
        json: bool,
    },
}

#[derive(Subcommand)]
enum OrchestrateSubcommands {
    /// Start a new orchestration session with an objective
    Run {
        /// The objective to accomplish (e.g., "add user authentication")
        objective: String,
        /// Assignment strategy: smart, round-robin, or manual
        #[arg(short, long, default_value = "smart")]
        strategy: String,
        /// Base branch for validation
        #[arg(short, long, default_value = "master")]
        base: String,
        /// Use Duo Mode (parallel multi-agent relay) instead of sequential waves
        #[arg(long)]
        duo: bool,
    },
    /// Show status of the active orchestration session
    Status,
    /// Pause the active orchestration session
    Pause,
    /// Resume a paused orchestration session
    Resume {
        #[arg(short, long, default_value = "master")]
        base: String,
    },
    /// Cancel the active orchestration session
    Cancel,
    /// List all orchestration sessions
    List,
}

#[derive(Subcommand)]
enum SymphonySubcommands {
    /// Start a Symphony run — pull Linear issues and execute with AI agents
    Run {
        /// Linear team key (e.g., "ENG")
        #[arg(short, long)]
        team: String,
        /// Maximum number of issues to process
        #[arg(short, long, default_value = "5")]
        limit: usize,
        /// Only process issues with this label
        #[arg(short = 'L', long)]
        label: Option<String>,
        /// Base branch for validation
        #[arg(short, long, default_value = "master")]
        base: String,
    },
    /// Show Symphony configuration and status
    Status,
}

/// Maps file path to tree-sitter language extension. Returns empty string if unsupported.
fn detect_lang_ext(path: &str) -> String {
    if path.ends_with(".rs") { "rs" }
    else if path.ends_with(".py") { "py" }
    else if path.ends_with(".ts") { "ts" }
    else if path.ends_with(".tsx") { "tsx" }
    else if path.ends_with(".js") { "js" }
    else if path.ends_with(".jsx") { "jsx" }
    else if path.ends_with(".go") { "go" }
    else if path.ends_with(".java") { "java" }
    else if path.ends_with(".cs") { "cs" }
    else if path.ends_with(".rb") { "rb" }
    else if path.ends_with(".cpp") || path.ends_with(".cc") || path.ends_with(".cxx") { "cpp" }
    else if path.ends_with(".hpp") { "hpp" }
    else if path.ends_with(".c") { "c" }
    else if path.ends_with(".h") { "h" }
    else if path.ends_with(".php") { "php" }
    else if path.ends_with(".swift") { "swift" }
    else if path.ends_with(".kt") || path.ends_with(".kts") { "kt" }
    else { "" }
    .to_string()
}

fn open_repo() -> Result<Repository, Box<dyn std::error::Error>> {
    Repository::open(".").map_err(|_| {
        format!(
            "{} Not a Git repository. Run {} first, or use {} to set one up.",
            "error:".red().bold(),
            "git init".cyan(),
            "aura init".cyan()
        ).into()
    })
}

/// Check if accessible mode is enabled (no emojis, no colors, screen-reader-friendly)
fn is_accessible() -> bool {
    std::env::var("AURA_ACCESSIBLE").map(|v| v == "1" || v == "true").unwrap_or(false)
}

/// Format label for accessible mode — strips emojis, uses text labels
/// Detect if stdout is connected to a TTY (interactive terminal)
fn atty_detect() -> bool {
    use std::io::IsTerminal;
    std::io::stdout().is_terminal() && std::io::stdin().is_terminal()
}

fn a11y_label(emoji: &str, text_label: &str) -> String {
    if is_accessible() {
        format!("[{}]", text_label)
    } else {
        emoji.to_string()
    }
}

/// True when argv[0]'s basename is `git-remote-aura` (with or without a
/// platform executable suffix), i.e. git invoked us as its remote helper via a
/// multi-call symlink rather than as the `aura` CLI.
fn invoked_as_git_remote_aura() -> bool {
    std::env::args_os()
        .next()
        .map(std::path::PathBuf::from)
        .and_then(|p| {
            p.file_name()
                .and_then(|s| s.to_str())
                .map(|s| s.trim_end_matches(".exe") == "git-remote-aura")
        })
        .unwrap_or(false)
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Die quietly when our reader goes away. Rust's runtime sets SIGPIPE to
    // SIG_IGN, so writing to a closed pipe returns EPIPE — which `println!`
    // turns into a panic. The desktop app spawns us (e.g. `aura ci run`),
    // captures stdout, then often drops that pipe; our very next print would
    // panic, the crash hook would print again and panic-while-panicking, and
    // macOS would file a crash report — on a loop. Restoring the default
    // disposition makes a broken pipe a clean termination, exactly like any
    // Unix tool in a `… | head` pipeline.
    unsafe {
        libc::signal(libc::SIGPIPE, libc::SIG_DFL);
    }

    // Multi-call dispatch: when this binary is invoked under the name
    // `git-remote-aura` (a symlink installed by `aura node install-helper`),
    // act as the git remote helper instead of the `aura` CLI. Git calls the
    // helper as `git-remote-aura <remote> <url>`, which clap would reject — so
    // we branch here, before `Cli::parse`, and hand off to the shared helper.
    // `cargo install` also ships a real standalone `git-remote-aura` binary; the
    // symlink path exists for installs that ship only `aura` (e.g. the app
    // bundle). Both routes run the exact same code (git_remote_aura_helper).
    if invoked_as_git_remote_aura() {
        git_remote_aura_helper::run(); // never returns
    }

    setup_crash_reporter();
    let cli = Cli::parse();

    // Set accessible mode environment variable so all output respects it
    if cli.accessible {
        // Safety: we set these before spawning any threads
        unsafe {
            std::env::set_var("AURA_ACCESSIBLE", "1");
            // Disable colors when in accessible mode
            std::env::set_var("NO_COLOR", "1");
        }
    }

    // KILL SHOT FIX: Passive Update Detection
    // Check for updates in the background once every 24 hours
    run_passive_update_check();

    // Log telemetry (non-blocking)
    let cmd_name = match &cli.command {
        Commands::Init { .. } => "init",
        Commands::Enable { .. } => "enable",
        Commands::Disable => "disable",
        Commands::Plan { .. } => "plan",
        Commands::Execute => "execute",
        Commands::Rewind { .. } => "rewind",
        Commands::Handover { .. } => "handover",
        Commands::Status => "status",
        Commands::Ci { .. } => "ci",
        Commands::Audit => "audit",
        Commands::Explain { .. } => "explain",
        Commands::Sessions => "sessions",
        Commands::Subagent { .. } => "subagent",
        Commands::AskUser { .. } => "ask-user",
        Commands::ProposePlan { .. } => "propose-plan",
        Commands::Resume { .. } => "resume",
        Commands::Carryover { .. } => "carryover",
        Commands::Doctor { .. } => "doctor",
        Commands::Ui { .. } => "ui",
        Commands::Completions { .. } => "completions",
        Commands::RequestAccess { .. } => "request-access",
        Commands::GoalTrace { .. } => "goal-trace",
        Commands::Config { .. } => "config",
        Commands::Egress { .. } => "egress",
        Commands::Live { .. } => "live",
        Commands::Server { .. } => "server",
        Commands::Save { .. } => "save",
        Commands::LogIntent { .. } => "log-intent",
        Commands::SignIntent { .. } => "sign-intent",
        Commands::ValidateTool => "validate-tool",
        Commands::Blocks { .. } => "blocks",
        Commands::Share => "share",
        Commands::Pull { .. } => "pull",
        Commands::Merge { .. } => "merge",
        Commands::Diff { .. } => "diff",
        Commands::History { .. } => "history",
        Commands::Trace { .. } => "trace",
        Commands::Team { .. } => "team",
        Commands::Host { .. } => "host",
        Commands::Ping => "ping",
        Commands::Join { .. } => "join",
        Commands::Connect { .. } => "connect",
        Commands::JoinTeam { .. } => "join-team",
        Commands::Crdt { .. } => "crdt",
        Commands::Keys { .. } => "keys",
        Commands::Attest { .. } => "attest",
        Commands::Pr { .. } => "pr",
        Commands::Resolve { .. } => "resolve",
        Commands::Atlas { .. } => "atlas",
        Commands::Goals { .. } => "goals",
        Commands::ChangeNote { .. } => "change-note",
        Commands::Impact { .. } => "impact",
        Commands::Whoami => "whoami",
        Commands::Disconnect => "disconnect",
        Commands::Usage { .. } => "usage",
        Commands::AcpServe => "acp-serve",
        Commands::AcpRun { .. } => "acp-run",
        Commands::Ws { .. } => "ws",
        Commands::Recall { .. } => "recall",
        Commands::Intents { .. } => "intents",
        Commands::HandoverCloud { .. } => "handover-cloud",
        Commands::Memory { .. } => "memory",
        Commands::MemoryCloud { .. } => "memory-cloud",
        Commands::A2aTask { .. } => "a2a-task",
        Commands::Skill { .. } => "skill",
        Commands::Skills { .. } => "skills",
        Commands::Replay { .. } => "replay",
        Commands::Webhooks { .. } => "webhooks",
        Commands::AgentCard { .. } => "agent-card",
        Commands::MergeDriver { .. } => "merge-driver",
        Commands::RepoId { .. } => "repo-id",
        Commands::Node { .. } => "node",
        _ => "internal_command"
    };
    track_event("cli_execution", Some(cmd_name));

    match &cli.command {        Commands::Daemon => {
            println!("Initializing Aura (Agentic VCS) Core Engine...\n");
            
            let parser = SemanticParser::new()?;
            println!("✓ Semantic AST Engine loaded.");
            
            let tracker = ContinuousTracker::new(parser);
            tracker.watch(".")?;
        }
        Commands::Update => {
            perform_update()?;
        }
        Commands::Enable { quiet } => {
            enable::run(*quiet)?;
        }
        Commands::Disable => {
            enable::disable()?;
        }
        Commands::Init { force_baseline } => {
            println!("{}", r#"
      █████        ███      ███  ███████████         █████      
     ███░░███     ░███     ░███ ░░███░░░░░███       ███░░███     
    ███  ░░███    ░███     ░███  ░███    ░███      ███  ░░███    
   ███    ░░███   ░███     ░███  ░██████████      ███    ░░███   
  █████████████   ░███     ░███  ░███░░░░░███    █████████████  
 ░███░░░░░░░███   ░███     ░███  ░███    ░███   ░███░░░░░░░███  
 ░███      ░███   ░░██████████   █████   █████  ░███      ░███  
 ░░░       ░░░     ░░░░░░░░░░   ░░░░░   ░░░░░   ░░░       ░░░   

      S O V E R E I G N   S E M A N T I C   V A U L T"#.cyan().bold());

            println!("\n{} {}\n", "✨".bold(), "AI-Native Semantic Version Control".bold().cyan());
            
            let repo = match Repository::open(".") {
                Ok(r) => r,
                Err(_) => {
                    println!("{} {}", "⚠️".yellow().bold(), "No Git repository found in this directory.".bold());
                    println!("  {} Aura requires a Git repository to operate.\n", "↳".dimmed());

                    let should_init = dialoguer::Confirm::with_theme(&ColorfulTheme::default())
                        .with_prompt("Would you like to initialize a Git repository here?")
                        .default(true)
                        .interact()
                        .unwrap_or(false);

                    if should_init {
                        Repository::init(".")?;
                        println!("  {} Git repository initialized.\n", "✓".green().bold());
                        Repository::open(".")?
                    } else {
                        println!("\n  {} Run {} inside a Git repository, or let Aura create one.", "💡".blue(), "aura init".cyan());
                        return Ok(());
                    }
                }
            };
            let index = repo.index()?;
            let file_count = index.len();

            if file_count > 1000 && !*force_baseline {
                println!("{} {}", "⚠️".yellow().bold(), "Large repository detected!".bold());
                println!("  {} Your project has {} files. Initializing Aura may trigger", "↳".dimmed(), file_count);
                println!("  {} 'Intent Poisoning' on your next commit as it baselines the logic.", "↳".dimmed());
                println!("  {} Recommendation: Run {} to baseline without blocks.", "↳".dimmed(), "aura init --force-baseline".cyan().italic());
                println!();
            }

            let intro_text = textwrap::fill(
                "Aura is a parasitic engine that wraps standard Git. It tracks the mathematical logic of your codebase (ASTs) rather than text diffs, allowing you to intercept, secure, and semantically rewind AI agent decisions.",
                80
            );
            println!("{}\n", intro_text.dimmed());
            println!("  {} Core Engine: Apache 2.0 (Open Source)", "↳".dimmed());
            println!("  {} Enterprise Features: Business Source License (BSL)\n", "↳".dimmed());

            println!("{:-^80}\n", " INITIALIZATION WIZARD ".bold().blue());

            // 1. Agent Selection
            // Detect non-interactive terminal — use sensible defaults if no TTY
            let is_tty = atty_detect();
            let agents = &["Claude Code", "VS Code", "Gemini CLI", "Cursor", "Claude Desktop", "Aider", "OpenCode"];
            let selections = if is_tty {
                MultiSelect::with_theme(&ColorfulTheme::default())
                    .with_prompt("Which AI Agents will be working in this repository? (Use space to select MULTIPLE, Enter to confirm)")
                    .items(&agents[..])
                    .interact()
                    .unwrap_or_else(|_| vec![0]) // Default to Claude Code on error
            } else {
                println!("  {} Non-interactive mode: auto-selecting Claude Code + Gemini CLI", "ℹ".blue());
                vec![0, 2] // Claude Code + Gemini CLI
            };

            // Automated MCP Injection
            for &idx in &selections {
                match agents[idx] {
                    "Claude Code" => {
                        println!("  {} Auto-configuring Claude Code MCP server...", "⚙️ ".cyan());

                        // Claude Code uses .mcp.json in the project root for MCP servers
                        let mcp_config_path = std::path::Path::new(".mcp.json");
                        let mut mcp_config: serde_json::Value = if mcp_config_path.exists() {
                            fs::read_to_string(mcp_config_path).ok()
                                .and_then(|s| serde_json::from_str(&s).ok())
                                .unwrap_or_else(|| serde_json::json!({"mcpServers": {}}))
                        } else {
                            serde_json::json!({"mcpServers": {}})
                        };

                        if mcp_config.get("mcpServers").is_none() {
                            mcp_config["mcpServers"] = serde_json::json!({});
                        }
                        mcp_config["mcpServers"]["aura-vcs"] = serde_json::json!({
                            "command": "aura",
                            "args": ["mcp"]
                        });
                        if fs::write(mcp_config_path, serde_json::to_string_pretty(&mcp_config).unwrap_or_default()).is_ok() {
                            println!("    {} Aura MCP server registered in .mcp.json for Claude Code.", "✓".green());
                        }

                        // Also inject CLAUDE.md with Aura instructions
                        let claude_md_path = std::path::Path::new("CLAUDE.md");
                        let aura_block = include_str!("../integrations/claude-md-block.md");
                        if claude_md_path.exists() {
                            // Append if not already present
                            if let Ok(existing) = fs::read_to_string(claude_md_path) {
                                if !existing.contains("AURA_START") {
                                    let updated = format!("{}\n\n{}", existing, aura_block);
                                    let _ = fs::write(claude_md_path, updated);
                                    println!("    {} Aura instructions appended to CLAUDE.md.", "✓".green());
                                } else {
                                    println!("    {} CLAUDE.md already has Aura instructions.", "✓".green());
                                }
                            }
                        } else {
                            let _ = fs::write(claude_md_path, aura_block);
                            println!("    {} Created CLAUDE.md with Aura instructions.", "✓".green());
                        }
                        // Install Aura status line for Claude Code
                        install_claude_statusline();
                    },
                    "VS Code" => {
                        println!("  {} Auto-configuring VS Code MCP server...", "⚙️ ".cyan());

                        // VS Code uses .vscode/mcp.json for MCP server registration (built-in since v1.99)
                        let vscode_dir = std::path::Path::new(".vscode");
                        let _ = fs::create_dir_all(vscode_dir);
                        let vscode_mcp_path = vscode_dir.join("mcp.json");

                        let mut mcp_config: serde_json::Value = if vscode_mcp_path.exists() {
                            fs::read_to_string(&vscode_mcp_path).ok()
                                .and_then(|s| serde_json::from_str(&s).ok())
                                .unwrap_or_else(|| serde_json::json!({"servers": {}}))
                        } else {
                            serde_json::json!({"servers": {}})
                        };

                        if mcp_config.get("servers").is_none() {
                            mcp_config["servers"] = serde_json::json!({});
                        }
                        mcp_config["servers"]["aura-vcs"] = serde_json::json!({
                            "command": "aura",
                            "args": ["mcp"],
                            "type": "stdio"
                        });
                        if fs::write(&vscode_mcp_path, serde_json::to_string_pretty(&mcp_config).unwrap_or_default()).is_ok() {
                            println!("    {} Aura MCP server registered in .vscode/mcp.json", "✓".green());
                        }

                        // Also add recommended extensions
                        let extensions_path = vscode_dir.join("extensions.json");
                        let mut extensions: serde_json::Value = if extensions_path.exists() {
                            fs::read_to_string(&extensions_path).ok()
                                .and_then(|s| serde_json::from_str(&s).ok())
                                .unwrap_or_else(|| serde_json::json!({"recommendations": []}))
                        } else {
                            serde_json::json!({"recommendations": []})
                        };

                        if let Some(recs) = extensions.get_mut("recommendations").and_then(|r| r.as_array_mut()) {
                            let copilot = serde_json::json!("github.copilot");
                            let copilot_chat = serde_json::json!("github.copilot-chat");
                            if !recs.contains(&copilot) { recs.push(copilot); }
                            if !recs.contains(&copilot_chat) { recs.push(copilot_chat); }
                            let _ = fs::write(&extensions_path, serde_json::to_string_pretty(&extensions).unwrap_or_default());
                            println!("    {} Recommended GitHub Copilot extensions in .vscode/extensions.json", "✓".green());
                        }

                        // Add VS Code task to auto-start the Aura watcher daemon
                        let tasks_path = vscode_dir.join("tasks.json");
                        let mut tasks: serde_json::Value = if tasks_path.exists() {
                            fs::read_to_string(&tasks_path).ok()
                                .and_then(|s| serde_json::from_str(&s).ok())
                                .unwrap_or_else(|| serde_json::json!({"version": "2.0.0", "tasks": []}))
                        } else {
                            serde_json::json!({"version": "2.0.0", "tasks": []})
                        };

                        if let Some(task_list) = tasks.get_mut("tasks").and_then(|t| t.as_array_mut()) {
                            // Only add if not already present
                            let already_exists = task_list.iter().any(|t| {
                                t.get("label").and_then(|l| l.as_str()) == Some("Aura Semantic Watcher")
                            });
                            if !already_exists {
                                task_list.push(serde_json::json!({
                                    "label": "Aura Semantic Watcher",
                                    "type": "shell",
                                    "command": "aura daemon",
                                    "isBackground": true,
                                    "problemMatcher": [],
                                    "runOptions": { "runOn": "folderOpen" },
                                    "presentation": {
                                        "reveal": "silent",
                                        "panel": "dedicated",
                                        "close": true
                                    }
                                }));
                                let _ = fs::write(&tasks_path, serde_json::to_string_pretty(&tasks).unwrap_or_default());
                                println!("    {} Aura watcher daemon will auto-start when VS Code opens this project.", "✓".green());
                            }
                        }

                        println!("    {} Aura Semantic Engine is now available in VS Code via MCP.", "✓".green());
                        println!("    {} Use Copilot Chat (Agent mode) to access Aura tools.", "💡".blue());
                    },
                    "Claude Desktop" => {
                        println!("  {} Auto-configuring Claude Desktop MCP server...", "⚙️ ".cyan());
                        let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
                        let claude_config_path = std::path::Path::new(&home).join("Library/Application Support/Claude/claude_desktop_config.json");
                        
                        if claude_config_path.exists() {
                            if let Ok(config_str) = fs::read_to_string(&claude_config_path) {
                                if let Ok(mut json) = serde_json::from_str::<serde_json::Value>(&config_str) {
                                    if let Some(mcp_servers) = json.get_mut("mcpServers").and_then(|m| m.as_object_mut()) {
                                        mcp_servers.insert("aura-vcs".to_string(), serde_json::json!({
                                            "command": "aura",
                                            "args": ["mcp"]
                                        }));
                                        if fs::write(&claude_config_path, serde_json::to_string_pretty(&json).unwrap_or_default()).is_ok() {
                                            println!("    {} Successfully injected Aura MCP into Claude Desktop.", "✓".green());
                                        }
                                    }
                                }
                            }
                        } else {
                            println!("    {} Claude Desktop config not found. Skipping auto-inject.", "⚠️".yellow());
                        }

                        // Inject GSD Custom Prompt for Claude
                        println!("  {} Injecting Aura GSD Wave Runner instructions for Claude...", "🌊".cyan());
                        let claude_project_dir = std::path::Path::new(".claude");
                        if !claude_project_dir.exists() {
                            let _ = fs::create_dir_all(claude_project_dir);
                        }
                        let gsd_prompt = serde_json::json!({
                            "name": "aura-semantic-engine",
                            "description": "Aura Semantic Engine v0.11.0 — AI-native version control with Mothership Mode, multi-agent orchestration, semantic PR review, surgical rewind, and durable snapshots.",
                            "instructions": "You have access to the Aura Semantic Engine. Key commands: (1) `aura snapshot \"desc\"` — ALWAYS run before large edits for safety. (2) `aura rewind <func> <file>` — surgically revert a function. (3) `aura pr-review --base main` — check for violations before committing. (4) `aura plan \"objective\"` then `aura execute` — decompose large tasks into atomic waves. (5) `aura prove --goal \"description\"` — mathematically verify a behavioral goal. (6) `aura orchestrate run \"objective\" --duo` — run Claude + Gemini in parallel. (7) `aura fix --base main` — auto-fix violations. (8) `aura handover cursor` — compressed context for agent relay. Before committing, log intent to `.gemini.intent` and run `aura pr-review`. Never use --no-verify."
                        });
                        let _ = fs::write(".claude/aura-gsd.json", serde_json::to_string_pretty(&gsd_prompt).unwrap_or_default());
                        println!("    {} Successfully seeded Claude with GSD logic.", "✓".green());
                    },
                    "Cursor" => {
                        println!("  {} Auto-configuring Cursor MCP server...", "⚙️ ".cyan());
                        // Cursor reads MCP configs from a global user workspace settings file
                        let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
                        let cursor_mcp_path = std::path::Path::new(&home).join("Library/Application Support/Cursor/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json");
                        
                        if let Some(parent) = cursor_mcp_path.parent() {
                            let _ = fs::create_dir_all(parent);
                        }
                        
                        let mut mcp_config = serde_json::json!({ "mcpServers": {} });
                        if cursor_mcp_path.exists() {
                            if let Ok(existing) = fs::read_to_string(&cursor_mcp_path) {
                                if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&existing) {
                                    mcp_config = parsed;
                                }
                            }
                        }
                        
                        if let Some(mcp_servers) = mcp_config.get_mut("mcpServers").and_then(|m| m.as_object_mut()) {
                            mcp_servers.insert("aura-vcs".to_string(), serde_json::json!({
                                "command": "aura",
                                "args": ["mcp"]
                            }));
                            if fs::write(&cursor_mcp_path, serde_json::to_string_pretty(&mcp_config).unwrap_or_default()).is_ok() {
                                println!("    {} Successfully injected Aura MCP into Cursor.", "✓".green());
                            }
                        }

                        // Safely inject GSD instructions into .cursorrules without destroying existing rules
                        println!("  {} Injecting Aura GSD orchestration rules into Cursor...", "🌊".cyan());
                        let cursor_rules_path = std::path::Path::new(".cursorrules");
                        let gsd_rules = include_str!("../integrations/cursor-rules/gsd.mdc");
                        
                        let formatted_rules = format!("\n\n{}\n", gsd_rules);
                        if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(cursor_rules_path) {
                            if file.write_all(formatted_rules.as_bytes()).is_ok() {
                                println!("    {} Successfully appended GSD protocol to .cursorrules.", "✓".green());
                            }
                        }
                    },
                    "Gemini CLI" => {
                        println!("  {} Injecting Aura GSD Wave Runner skill for Gemini CLI...", "🌊".cyan());
                        let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
                        let gemini_skills_dir = std::path::Path::new(&home).join(".gemini").join("skills");
                        
                        if let Err(e) = fs::create_dir_all(&gemini_skills_dir) {
                            println!("    {} Failed to create Gemini skills directory: {}", "✗".red(), e);
                            continue;
                        }

                        // Write the global skill
                        let skill_content = include_str!("../integrations/aura-gsd.skill");
                        if fs::write(gemini_skills_dir.join("aura-gsd.md"), skill_content).is_ok() {
                            println!("    {} Successfully injected Aura GSD skill into Gemini CLI.", "✓".green());
                        }

                        // Project-Level Integration (Hooks & Settings)
                        println!("  {} Scaffolding native Gemini CLI hooks...", "⚙️ ".cyan());
                        let gemini_project_dir = std::path::Path::new(".gemini");
                        let hooks_dir = gemini_project_dir.join("hooks");
                        let _ = fs::create_dir_all(&hooks_dir);

                        // Inject the Intent Capture Hook
                        let hook_js = include_str!("../assets/gemini-hooks/aura-intent.js");
                        let _ = fs::write(hooks_dir.join("aura-intent.js"), hook_js);

                        // Register MCP server in GLOBAL ~/.gemini/settings.json
                        // Gemini CLI reads MCP servers from the global config, not project-level
                        let global_gemini_settings_path = std::path::Path::new(&home).join(".gemini").join("settings.json");
                        let mut global_settings: serde_json::Value = if global_gemini_settings_path.exists() {
                            fs::read_to_string(&global_gemini_settings_path).ok()
                                .and_then(|s| serde_json::from_str(&s).ok())
                                .unwrap_or_else(|| serde_json::json!({}))
                        } else {
                            serde_json::json!({})
                        };

                        if global_settings.get("mcpServers").is_none() {
                            global_settings["mcpServers"] = serde_json::json!({});
                        }
                        global_settings["mcpServers"]["aura-vcs"] = serde_json::json!({
                            "command": "aura",
                            "args": ["mcp"]
                        });
                        let _ = fs::write(&global_gemini_settings_path, serde_json::to_string_pretty(&global_settings).unwrap_or_default());
                        println!("    {} Aura MCP server registered in ~/.gemini/settings.json (global).", "✓".green());

                        // Project-level .gemini/settings.json — hooks only
                        let settings_path = gemini_project_dir.join("settings.json");
                        let mut settings: serde_json::Value = if settings_path.exists() {
                            fs::read_to_string(&settings_path).ok()
                                .and_then(|s| serde_json::from_str(&s).ok())
                                .unwrap_or_else(|| serde_json::json!({}))
                        } else {
                            serde_json::json!({})
                        };

                        // Also add MCP to project-level as fallback
                        if settings.get("mcpServers").is_none() {
                            settings["mcpServers"] = serde_json::json!({});
                        }
                        settings["mcpServers"]["aura-vcs"] = serde_json::json!({
                            "command": "aura",
                            "args": ["mcp"]
                        });

                        // Inject hooks (preserve existing ones)
                        if settings.get("hooks").is_none() {
                            settings["hooks"] = serde_json::json!({});
                        }
                        settings["hooks"]["SessionStart"] = serde_json::json!([
                            {
                                "matcher": "*",
                                "hooks": [
                                    {
                                        "name": "Aura Status",
                                        "type": "command",
                                        "command": "node .gemini/hooks/aura-intent.js"
                                    }
                                ]
                            }
                        ]);
                        settings["hooks"]["AfterAgent"] = serde_json::json!([
                            {
                                "matcher": "*",
                                "hooks": [
                                    {
                                        "name": "Aura Intent Capture",
                                        "type": "command",
                                        "command": "node .gemini/hooks/aura-intent.js"
                                    }
                                ]
                            }
                        ]);

                        let _ = fs::write(&settings_path, serde_json::to_string_pretty(&settings).unwrap_or_default());
                        println!("    {} Project hooks registered in .gemini/settings.json.", "✓".green());

                        // Inject GEMINI.md with Aura instructions
                        let gemini_md_path = std::path::Path::new("GEMINI.md");
                        let gemini_block = include_str!("../integrations/gemini-md-block.md");
                        if gemini_md_path.exists() {
                            if let Ok(existing) = fs::read_to_string(gemini_md_path) {
                                if !existing.contains("AURA_START") {
                                    let updated = format!("{}\n\n{}", existing, gemini_block);
                                    let _ = fs::write(gemini_md_path, updated);
                                    println!("    {} Aura instructions appended to GEMINI.md.", "✓".green());
                                } else {
                                    println!("    {} GEMINI.md already has Aura instructions.", "✓".green());
                                }
                            }
                        } else {
                            let _ = fs::write(gemini_md_path, gemini_block);
                            println!("    {} Created GEMINI.md with Aura instructions.", "✓".green());
                        }

                        println!("    {} Aura Semantic Engine is now natively powering your Gemini sessions.", "✓".green());
                    },
                    _ => {}
                }
            }

            // 2. Global AI Provider & API Key Vault
            let mut current_config = ConfigManager::load();
            let provider = ConfigManager::get_active_provider();
            
            if ConfigManager::get_api_key(&provider).is_none() {
                println!("\n{} Aura requires an LLM backend for planning and arbitration.", "ℹ️ ".blue());
                println!("  {} Current Provider: {}", "↳".dimmed(), provider.yellow());

                let api_key = if is_tty {
                    Password::with_theme(&ColorfulTheme::default())
                        .with_prompt(format!("Please provide your {} API Key (Securely vaulted locally)", provider))
                        .allow_empty_password(true)
                        .interact()
                        .unwrap_or_default()
                } else {
                    println!("  {} Non-interactive: skipping API key prompt. Set via: aura config", "ℹ".blue());
                    String::new()
                };
                
                if !api_key.is_empty() {
                    match provider.as_str() {
                        "anthropic" => current_config.anthropic_api_key = Some(api_key),
                        "openai" => current_config.openai_api_key = Some(api_key),
                        "mercury" => current_config.mercury_api_key = Some(api_key),
                        _ => current_config.gemini_api_key = Some(api_key),
                    }
                    ConfigManager::save(&current_config)?;
                    println!("{} Key securely vaulted.", "✓".green().bold());
                }
            }

            // 3. Install Hooks
            println!("\n{:-^80}\n", " SECURING REPOSITORY ".bold().blue());

            // Husky Detection
            if std::path::Path::new(".husky").exists() {
                println!("{} {}", "⚠️".yellow().bold(), "Husky detected in this project.".bold());
                println!("  {} Husky overrides standard Git hooks. To enable Aura protection, manually add", "↳".dimmed());
                println!("  {} the following line to your {} file:", "↳".dimmed(), ".husky/pre-commit".cyan());
                println!("\n    {}\n", "aura capture-context".green().italic());
            }

            println!("  {} Installing Semantic Git Hooks...", "⚙️ ".cyan());
            if let Err(e) = HookInstaller::enable() {
                println!("  {} {}", "✗".red().bold(), e);
                return Ok(());
            }

            // Always install/update the status line for Claude Code
            install_claude_statusline();

            if *force_baseline {
                println!("  {} Establishing Merkle-Graph baseline (Force Mode)...", "🧠".cyan());

                let mut parser = SemanticParser::new()?;
                let mut staged_nodes = Vec::new();
                let mut file_oids: std::collections::HashMap<String, String> =
                    std::collections::HashMap::new();

                // Scan all files in index for the baseline. This is the one place
                // a full-repo parse is genuinely the job, so it stays a full
                // parse — but it records each file's content address as it goes,
                // which is what lets the *first* commit after `aura init` reuse
                // this work instead of parsing the whole tree over again.
                for entry in index.iter() {
                    let path_str = String::from_utf8_lossy(&entry.path).to_string();
                    let ext = detect_lang_ext(&path_str); if ext.is_empty() { continue }; let ext = ext.as_str();
                    if let Ok(source_code) = fs::read_to_string(&path_str) {
                        // Hash what was actually read, not the index entry: at
                        // init the worktree may well differ from the index, and
                        // the cache key must describe the bytes these nodes came
                        // from or a later capture would trust a stale AST.
                        let Ok(oid) = git2::Oid::hash_object(
                            git2::ObjectType::Blob,
                            source_code.as_bytes(),
                        ) else { continue };
                        // `parse_file_with_path`, not `parse_file`: the nodes need
                        // to know which file they came from for the cache above to
                        // be able to hand them back per file.
                        if let Ok(ast_nodes) = parser.parse_file_with_path(&source_code, ext, &path_str) {
                            staged_nodes.extend(ast_nodes);
                            file_oids.insert(path_str, CheckpointStore::content_key(&oid.to_string()));
                        }
                    }
                }

                let id = Uuid::new_v4().to_string().replace("-", "");
                let checkpoint = CheckpointData {
                    id: id.clone(),
                    // Milliseconds, like every other checkpoint writer. This
                    // one used to stamp seconds, which reads as a checkpoint
                    // written in 1970 and made "how old is this graph" answer
                    // zero forever.
                    timestamp: SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis() as u64,
                    agent_id: "Aura Initializer".to_string(),
                    intent: "[Aura Baseline] Initialized Merkle-Graph for existing codebase.".to_string(),
                    ast_nodes: staged_nodes,
                    intent_vector: None,
                    intent_vector_model: None,
                    env_fingerprint: capture_env_fingerprint(),
                    file_oids,
                };

                CheckpointStore::stage_checkpoint(&checkpoint)?;
                CheckpointStore::commit_staged(&repo)?;
                println!("    {} Baseline established successfully (ID: {}).", "✓".green(), id.cyan());            }

            // Auto-start the watcher daemon in the background — unless this
            // tree already has one. `init` is safe to re-run, so without this
            // check every re-run adds another watcher over the same files;
            // each carries its own parser and AST cache, and they accumulate
            // for as long as the machine is up.
            if !watcher::autostart_allowed() {
                println!("  {} Watcher daemon not started — {} is set.", "⚙️ ".cyan(), watcher::NO_DAEMON_ENV.cyan());
                println!("    {} Run {} yourself when you want save-by-save snapshots.", "↳".dimmed(), "aura daemon".cyan());
            } else {
                match watcher::daemon_watching(Path::new(".")) {
                    Some(pid) => {
                        println!("  {} Aura watcher daemon already running here (PID: {}) — leaving it alone.", "⚙️ ".cyan(), pid);
                        println!("    {} Snapshots stored in {}. Rewind will work even without commits.", "↳".dimmed(), ".aura/snapshots/".cyan());
                    }
                    None => {
                        println!("  {} Starting Aura watcher daemon...", "⚙️ ".cyan());
                        // Start *this* binary, not whatever `aura` is first on
                        // PATH. That is not a hypothetical difference: the
                        // daemon is what keeps running, so an older copy on
                        // PATH means its bugs outlive every upgrade of the
                        // binary actually invoked — including the fix that
                        // makes a watcher stop when the tree it was pointed at
                        // is deleted.
                        let exe = std::env::current_exe()
                            .unwrap_or_else(|_| std::path::PathBuf::from("aura"));
                        match std::process::Command::new(exe)
                            .arg("daemon")
                            .stdin(std::process::Stdio::null())
                            .stdout(std::process::Stdio::null())
                            .stderr(std::process::Stdio::null())
                            .spawn()
                        {
                            Ok(child) => {
                                println!("    {} Watcher daemon started (PID: {}). Every file save is now tracked.", "✓".green(), child.id());
                                println!("    {} Snapshots stored in {}. Rewind will work even without commits.", "↳".dimmed(), ".aura/snapshots/".cyan());
                            }
                            Err(_) => {
                                println!("    {} Could not auto-start daemon. Run {} manually in a separate terminal.", "⚠️".yellow(), "aura daemon".cyan());
                            }
                        }
                    }
                }
            }

            println!("\n{} {}\n", "🚀".bold(), "Aura is now protecting your repository.".bold().green());

            let final_instructions = vec![
                format!("{} Code normally. Aura automatically intercepts `{}`.", "1.".cyan().bold(), "git commit".italic()),
                format!("{} Every file save is tracked by the watcher daemon for `{}`.", "2.".cyan().bold(), "aura rewind".italic()),
                format!("{} Run `{}` to verify semantic integrity before pushing.", "3.".cyan().bold(), "aura pr-review --base main".italic()),
            ];

            for inst in final_instructions {
                println!("   {}", inst);
            }

            println!("\n{}\n", "Welcome to the age of Agentic Engineering.".bold().blue());
        }
        Commands::CaptureContext { force } => {
            // This command runs as `pre-commit`, so nothing it does may outlive
            // the user's patience for pressing Commit. Under a GUI client there
            // is nobody to see a spinner or press Ctrl-C, so a ceiling goes on
            // here — in the binary, where it reaches people whose hook file was
            // written months ago and is never rewritten, and where it works on
            // macOS, which has no `timeout(1)` for the old hook's guard to use.
            hook_guard::arm_time_budget();

            // Detect rebase/pull and migrate shadow branch if needed
            if let Ok(repo) = Repository::open(".") {
                if let Ok(true) = CheckpointStore::migrate_shadow_if_needed(&repo) {
                    eprintln!("Aura: HEAD changed (rebase/pull detected). Shadow checkpoints migrated.");
                }
            }

            let spinner = ProgressBar::new_spinner();
            spinner.set_style(
                ProgressStyle::default_spinner()
                    .tick_chars("⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏ ")
                    .template("{spinner:.cyan} {msg}")
                    .unwrap(),
            );

            spinner.set_message(format!("{}", "Analyzing staged files semantically...".bold()));
            spinner.enable_steady_tick(Duration::from_millis(80));

            let repo = open_repo()?;
            let mut parser = SemanticParser::new()?;
            let config = ConfigManager::load();

            let index = repo.index()?;
            let mut staged_nodes = Vec::new();

            // The previous checkpoint, read ONCE and as a single git note.
            //
            // Three places below want the same thing — "what did the last
            // snapshot look like": the parse cache here, the deletion guard, and
            // the blast-radius scan. Each used to call
            // `get_all_checkpoints(..).first()`, which deserializes *every*
            // checkpoint in history to look at one. Since a checkpoint holds the
            // whole repo's AST, that is megabytes per note — on this repo, 517
            // notes totalling 10.4 GB, read two or three times over on every
            // single commit, and growing by another full AST each time. That is
            // what made the pre-commit hook get slower forever and, on a machine
            // with a slow disk or little memory, stop reading as slow and start
            // reading as a hang.
            // A read failure here means "can't tell", never "nothing was
            // there" — the guards below simply skip rather than report an
            // empty history as a wholesale deletion.
            let previous_checkpoint = CheckpointStore::latest_checkpoint(&repo).ok().flatten();

            // The previous checkpoint's nodes, grouped by the file they came
            // from, so an unchanged file can hand back its AST instead of being
            // parsed again. Borrowed, not cloned — only the nodes actually reused
            // get copied.
            let previous_by_file: std::collections::HashMap<&str, Vec<&crate::models::AstNode>> = {
                let mut map: std::collections::HashMap<&str, Vec<&crate::models::AstNode>> =
                    std::collections::HashMap::new();
                if let Some(prev) = previous_checkpoint.as_ref() {
                    for node in &prev.ast_nodes {
                        if let Some(path) = node.file_path.as_deref() {
                            map.entry(path).or_default().push(node);
                        }
                    }
                }
                map
            };

            // Which tracked files differ between the index and the worktree.
            //
            // Git answers this from stat data for anything untouched, so it costs
            // far less than opening the files — and for every path NOT in here
            // the index entry's own OID already *is* the content hash, so those
            // files can be recognised as unchanged without a single read.
            let dirty_in_worktree: std::collections::HashSet<String> = {
                let mut set = std::collections::HashSet::new();
                let mut opts = git2::DiffOptions::new();
                opts.include_untracked(false);
                if let Ok(diff) = repo.diff_index_to_workdir(Some(&index), Some(&mut opts)) {
                    for delta in diff.deltas() {
                        for path in [delta.old_file().path(), delta.new_file().path()] {
                            if let Some(p) = path {
                                set.insert(p.to_string_lossy().to_string());
                            }
                        }
                    }
                }
                set
            };

            // Content address of everything captured, stored on the new
            // checkpoint so the *next* commit can do the same trick.
            let mut file_oids: std::collections::HashMap<String, String> =
                std::collections::HashMap::new();
            let mut reused_files = 0usize;
            let mut parsed_files = 0usize;

            for entry in index.iter() {
                let path_str = String::from_utf8_lossy(&entry.path).to_string();

                // Skip build artifacts, dependencies, and generated files
                if path_str.contains("node_modules/") || path_str.contains(".next/")
                    || path_str.contains("target/") || path_str.contains("dist/")
                    || path_str.contains("build/") || path_str.contains(".cache/")
                    || path_str.contains("__pycache__/") || path_str.contains(".aura/")
                    || path_str.contains(".git/") || path_str.contains("vendor/")
                    || path_str.contains(".turbo/") || path_str.contains(".vercel/")
                    || path_str.contains("coverage/") || path_str.contains(".output/") {
                    continue;
                }

                let ext = detect_lang_ext(&path_str); if ext.is_empty() { continue }; let ext = ext.as_str();

                // The content key, and the source only if we had to read it.
                // Clean against the worktree → git already hashed these bytes and
                // the file is never opened. Dirty → read once and hash what we
                // read, which is the same read the parse would have needed.
                let (content_key, source): (String, Option<String>) =
                    if dirty_in_worktree.contains(&path_str) {
                        let Ok(source_code) = fs::read_to_string(&path_str) else { continue };
                        let oid = git2::Oid::hash_object(
                            git2::ObjectType::Blob,
                            source_code.as_bytes(),
                        );
                        let Ok(oid) = oid else { continue };
                        (CheckpointStore::content_key(&oid.to_string()), Some(source_code))
                    } else {
                        (CheckpointStore::content_key(&entry.id.to_string()), None)
                    };

                // Same bytes as last checkpoint, same parser version → the AST is
                // the same by construction, so re-deriving it would be pure cost.
                // The old code re-parsed all 1692 parseable files on every commit
                // no matter how few were staged; a typical commit now parses the
                // handful it actually touched.
                let unchanged = previous_checkpoint
                    .as_ref()
                    .and_then(|prev| prev.file_oids.get(&path_str))
                    .is_some_and(|stored| *stored == content_key);

                let nodes: Vec<crate::models::AstNode> = if unchanged {
                    reused_files += 1;
                    // An absent entry is not a miss: a file that parsed to no
                    // nodes last time still recorded its key, and reproduces as
                    // the empty set.
                    previous_by_file
                        .get(path_str.as_str())
                        .map(|prev| prev.iter().map(|n| (*n).clone()).collect())
                        .unwrap_or_default()
                } else {
                    let source_code = match source {
                        Some(s) => s,
                        None => match fs::read_to_string(&path_str) {
                            Ok(s) => s,
                            Err(_) => continue,
                        },
                    };
                    match parser.parse_file_with_path(&source_code, ext, &path_str) {
                        Ok(parsed) => {
                            parsed_files += 1;
                            parsed
                        }
                        // Unparseable: record nothing for it, exactly as before,
                        // so a later capture retries rather than caching a gap.
                        Err(_) => continue,
                    }
                };

                file_oids.insert(path_str.clone(), content_key);

                for node in nodes {
                    if node.contains_secret {
                        let ident = node.identifier.clone().unwrap_or_else(|| "Anonymous".to_string());

                        // KILL SHOT FIX: Check allowlist and Dev Mode bypass
                        let is_allowed = config.secret_allowlist.contains(&ident) || config.dev_mode || *force;

                        if !is_allowed {
                            if config.strict_gatekeeper_mode {
                                spinner.finish_and_clear();
                                let config_path = ConfigManager::get_config_path().map(|p| p.to_string_lossy().to_string()).unwrap_or_else(|| "unknown".to_string());
                                println!("{} Semantic Sentinel: High-Entropy Secret detected in {} (Hash: {}). Commit halted!", "🚨".red().bold(), ident.yellow(), node.content_hash[0..8].to_string());
                                println!("  {} If this is legitimate, run: {} {} {}", "↳".dimmed(), "aura request-access".cyan(), ident, "to allowlist this node.");
                                if ConfigManager::is_strict_mode_locked(&config) {
                                    println!("  {} Strict mode is passcode-locked (human must unlock from terminal).", "💡".blue());
                                } else {
                                    println!("  {} To bypass all blocks globally, run: {}", "💡".blue(), "aura config set strict-mode false".italic());
                                }
                                println!("  {} (Using config: {})", "🔍".dimmed(), config_path.dimmed());
                                std::process::exit(1);
                            } else {
                                spinner.finish_and_clear();
                                println!("{} Semantic Sentinel Warning.", "⚠️".yellow().bold());
                                println!("  {} High-entropy pattern detected in node '{}'.", "↳".dimmed(), ident.yellow());
                                println!("  {} Strict mode is OFF. You can enable it with: {}", "💡".blue(), "aura config set strict-mode true".italic());
                                let should_continue = hook_guard::confirm(
                                    "Continue with commit?",
                                    true,
                                    true,
                                    "continuing, because strict mode is off and this branch is a warning, not a gate",
                                );
                                if !should_continue {
                                    println!("{} Commit cancelled. Review and fix the flagged node, then try again.", "✗".red().bold());
                                    std::process::exit(1);
                                }
                            }
                        }
                    }
                    staged_nodes.push(node);
                }
            }

            // Say what the cache actually did. A pre-commit hook that people
            // suspect of hanging should be legible about where its time went,
            // and this is the line that shows the parse work collapsing to the
            // files a commit really touched.
            if reused_files > 0 {
                spinner.set_message(format!(
                    "Parsed {parsed_files} changed file(s); reused {reused_files} unchanged"
                ));
            }

            thread::sleep(Duration::from_millis(200));
            spinner.set_message(format!("{}", "Scanning for deleted logic nodes...".bold()));

            // ── DELETION GUARD: Detect when AI agents silently remove working code ──
            // Compare staged AST nodes against the latest checkpoint to find deletions.
            // This is the core protection against "AI overwrites good code while building new features."
            {
                if let Some(latest_checkpoint) = previous_checkpoint.as_ref() {
                    let staged_identifiers: std::collections::HashSet<String> = staged_nodes.iter()
                        .filter_map(|n| n.identifier.clone())
                        .collect();

                    // Which named nodes existed in the last checkpoint but are
                    // gone from the staged tree? The pure decision logic lives in
                    // `deletion_guard` so it is unit-tested and shared, not buried
                    // inline in this 7k-line command arm.
                    let deleted_nodes: Vec<String> = deletion_guard::detect_deleted_nodes(
                        latest_checkpoint.ast_nodes.iter().map(|n| n.identifier.as_deref()),
                        &staged_identifiers,
                    );

                    if !deleted_nodes.is_empty() {
                        spinner.finish_and_clear();

                        // Union of the stated intent (MCP handshake file) + the
                        // logged-intent JSONL — the same haystack the alignment
                        // matcher uses. `is_deletion_accounted` lowercases it, so
                        // pass it through as-is.
                        let intent_text = fs::read_to_string(".gemini.intent").unwrap_or_default();
                        let intent_log = fs::read_to_string(".aura/intent_log.jsonl").unwrap_or_default();
                        let combined_intent = format!("{} {}", intent_text, intent_log);

                        // Deleted file/directory paths — for bulk directory
                        // removals, naming a path is accountable enough without
                        // enumerating every symbol inside it.
                        let deleted_file_paths: Vec<String> = {
                            let mut paths = Vec::new();
                            let head = repo.head().ok().and_then(|h| h.peel_to_tree().ok());
                            if let Some(head_tree) = &head {
                                let mut diff_opts = git2::DiffOptions::new();
                                if let Ok(diff) = repo.diff_tree_to_index(Some(head_tree), Some(&index), Some(&mut diff_opts)) {
                                    for delta in diff.deltas() {
                                        if delta.status() == git2::Delta::Deleted {
                                            if let Some(path) = delta.old_file().path() {
                                                paths.push(path.to_string_lossy().to_lowercase());
                                            }
                                        }
                                    }
                                }
                            }
                            paths
                        };

                        // Did the agent account for these removals — a removal
                        // keyword AND a specific node or path? Pure, tested logic.
                        let is_likely_intentional = deletion_guard::is_deletion_accounted(
                            &deleted_nodes,
                            &deleted_file_paths,
                            &combined_intent,
                        );

                        if !deleted_nodes.is_empty() && !is_likely_intentional && !*force {
                            // Any deletion without intent is suspicious in strict mode
                            println!("\n{} Logic Node Deletion Guard: {} logic nodes REMOVED", "🛡️".red().bold(), deleted_nodes.len().to_string().red().bold());
                            println!("  {} This often happens when an AI agent rewrites a file and accidentally", "↳".dimmed());
                            println!("  {} removes working features while building new ones.", "↳".dimmed());
                            println!("\n  {} Deleted nodes (showing first 15):", "Missing:".bold().red());
                            for (i, name) in deleted_nodes.iter().take(15).enumerate() {
                                println!("    {} {}. {}", "✗".red(), i + 1, name.yellow());
                            }
                            if deleted_nodes.len() > 15 {
                                println!("    {} ... and {} more", "↳".dimmed(), deleted_nodes.len() - 15);
                            }

                            // Auto-snapshot all modified files before potentially blocking
                            for entry in index.iter() {
                                let path_str = String::from_utf8_lossy(&entry.path).to_string();
                                if !detect_lang_ext(&path_str).is_empty() {
                                    let _ = checkpoint::SnapshotStore::snapshot_file(&path_str, "pre_deletion_guard", "Aura Deletion Guard");
                                }
                            }

                            // The exact, ready-to-run command that makes THESE
                            // specific removals accountable. It already names the
                            // removed nodes and opens with a removal keyword, so an
                            // agent that fills in the reason and runs it verbatim
                            // clears this gate on the next commit — a fix, not a wall.
                            let fix_cmd = deletion_guard::rejection_instruction(&deleted_nodes);

                            if config.strict_gatekeeper_mode {
                                println!("\n  {} {}", "How to Fix:".bold().green(), "This removal is not accounted for. To proceed, log an intent that owns it — run:");
                                println!("    {} {}", "$".dimmed(), fix_cmd.cyan());
                                println!("  {} Fill in the real reason, then commit again. Aura clears the gate once the intent names what was removed and why.", "↳".dimmed());
                                println!("\n{} Commit halted. {} logic node(s) would be lost with no reason on record.", "✗".red().bold(), deleted_nodes.len());
                                println!("  {} Safety snapshots saved to .aura/snapshots/ — recover a file with {}.", "✓".green(), "aura rewind".italic());
                                std::process::exit(1);
                            } else {
                                println!("\n  {} {}", "How to Fix:".bold().green(), "This removal is not accounted for. Log an intent that owns it — run:");
                                println!("    {} {}", "$".dimmed(), fix_cmd.cyan());
                                println!("  {} Strict mode is OFF, so this is not enforced. Make it a hard gate with: {}", "💡".blue(), "aura config set strict-mode true".italic());
                                // Enter means "stop" for a person who can read the
                                // list above; with nobody there it continues, because
                                // strict mode is off and turning an advisory warning
                                // into a hard block just for running under a GUI
                                // client would be its own bug. The removals stay
                                // printed either way, and `strict-mode true` is the
                                // switch that makes this branch block for real.
                                let should_continue = hook_guard::confirm(
                                    &format!("Continue? {} logic node(s) will be removed", deleted_nodes.len()),
                                    false,
                                    true,
                                    "continuing, because strict mode is off; run `aura config set strict-mode true` to make unaccounted removals block the commit",
                                );
                                if !should_continue {
                                    println!("{} Commit cancelled — the removal was left unaccounted.", "✗".red().bold());
                                    println!("  {} Run the command above to log intent for the removal, then commit again.", "↳".dimmed());
                                    std::process::exit(1);
                                }
                            }
                        }
                    }
                }
            }

            // ── INTENT-SCOPE RECONCILIATION: did the agent stay inside what it declared? ──
            // The newest signed intent block may carry a declared write scope —
            // the files the agent said (via aura_log_intent's `writes`) it would
            // touch. Stamp the real staged writes into that block's actual_impacts
            // (the half that was never computed, which is exactly why the
            // intent-divergence gate never fired) and flag anything touched beyond
            // the declared scope. Skipped entirely when --force.
            if !*force {
                // Real staged writes = added/modified/renamed/typechanged paths in
                // the tree→index diff. Deletions are the deletion guard's job above.
                let actual_writes: Vec<String> = {
                    let mut paths = Vec::new();
                    let head_tree = repo.head().ok().and_then(|h| h.peel_to_tree().ok());
                    let mut diff_opts = git2::DiffOptions::new();
                    if let Ok(diff) = repo.diff_tree_to_index(head_tree.as_ref(), Some(&index), Some(&mut diff_opts)) {
                        for delta in diff.deltas() {
                            use git2::Delta::{Added, Copied, Modified, Renamed, Typechange};
                            if matches!(delta.status(), Added | Modified | Renamed | Copied | Typechange) {
                                if let Some(p) = delta.new_file().path() {
                                    let s = p.to_string_lossy().to_string();
                                    // Aura's own bookkeeping is never a "write" the agent must
                                    // declare. Besides the `.aura/` and `.git/` trees, the
                                    // per-agent intent handshake files live at the repo root
                                    // (`.gemini.intent`, `.claude.intent`) — the pre-commit hook
                                    // writes them, so counting them would flag Aura's own control
                                    // file as an undeclared write on every commit.
                                    let name = p
                                        .file_name()
                                        .map(|n| n.to_string_lossy().to_string())
                                        .unwrap_or_default();
                                    let is_aura_control = s.contains(".aura/")
                                        || s.contains(".git/")
                                        || name == ".gemini.intent"
                                        || name == ".claude.intent"
                                        || name == ".aura.intent";
                                    if !is_aura_control {
                                        paths.push(s);
                                    }
                                }
                            }
                        }
                    }
                    paths
                };

                if let Some(recon) = intent_reconcile::reconcile_commit(Path::new(".aura/blocks"), &actual_writes) {
                    if recon.diverged() {
                        spinner.finish_and_clear();
                        println!("\n{} Intent Scope Divergence: the change went beyond what was declared.", "🛡️".red().bold());
                        println!("  {} You said (intent): {}", "↳".dimmed(), recon.intent_summary.yellow());
                        println!("  {} Declared {} file(s); commit also touched {} undeclared file(s):",
                            "↳".dimmed(), recon.declared.len(), recon.undeclared.len().to_string().red().bold());
                        for (i, f) in recon.undeclared.iter().take(15).enumerate() {
                            println!("    {} {}. {}", "✗".red(), i + 1, f.yellow());
                        }
                        if recon.undeclared.len() > 15 {
                            println!("    {} ... and {} more", "↳".dimmed(), recon.undeclared.len() - 15);
                        }
                        if config.strict_gatekeeper_mode {
                            println!("\n  {} {}", "How to Fix:".bold().green(), "Either narrow the change to the files you declared, or re-log intent listing the fuller scope.");
                            println!("    {} aura log-intent \"…\"  (or split the commit)", "$".dimmed());
                            println!("\n{} Commit halted — undeclared writes in strict mode.", "✗".red().bold());
                            std::process::exit(1);
                        } else {
                            println!("\n  {} Strict mode is OFF — recording the divergence and proceeding.", "⚠️".yellow());
                            println!("  {} To block undeclared writes, run: {}", "💡".blue(), "aura config set strict-mode true".italic());
                            // Re-arm the spinner so downstream steps still render.
                            spinner.set_message(format!("{}", "Continuing…".bold()));
                            spinner.enable_steady_tick(Duration::from_millis(80));
                        }
                    } else {
                        spinner.println(format!(
                            "{} Intent scope honored — all {} changed file(s) were declared.",
                            "🛡️ ".green(),
                            recon.actual.len()
                        ));
                    }
                }
            }

            spinner.set_message(format!("{}", "Extracting AST logic signatures...".bold()));

            // Determine Agent Context intelligently based on environment signatures
            let mut agent_id = std::env::var("AURA_AGENT").unwrap_or_else(|_| {
                // Heuristic Agent Detection
                if std::env::var("CLAUDE_VERSION").is_ok() || std::env::var("CLAUDE_CONFIG_DIR").is_ok() {
                    return "Claude Code (CLI)".to_string();
                }
                if std::env::var("GEMINI_CLI").is_ok() {
                    return "Gemini CLI".to_string();
                }
                if std::env::var("VSCODE_INJECTION").is_ok() {
                    return "VS Code / Cursor".to_string();
                }
                if std::env::var("AIDER_MODEL").is_ok() {
                    return "Aider".to_string();
                }
                
                let user = std::env::var("USER").unwrap_or_else(|_| "Unknown".to_string());
                format!("{} (Local Terminal)", user)
            });

            let mut intent = std::env::var("AURA_INTENT").unwrap_or_else(|_| {
                if staged_nodes.is_empty() {
                    "No semantic logic changes detected in staged files.".to_string()
                } else {
                    format!("Automatically tracked {} semantic logic node(s) across staged files.", staged_nodes.len())
                }
            });

            // MCP Native Integration (Standard API)
            // Agents use the MCP server to write to this standard intent file
            if let Ok(mcp_intent) = fs::read_to_string(".gemini.intent") {
                agent_id = "MCP Connected Agent".to_string();
                intent = format!("[MCP Standard Protocol]\n{}", mcp_intent.trim());
                spinner.println(format!("{} Intercepted native MCP intent payload", "⚡".blue()));
                let _ = fs::remove_file(".gemini.intent");
            }

            // Scrape context (Claude Code)
            // Claude Code stores its transcripts in ~/.claude/projects/<sanitized_path>/<id>.jsonl
            let home_dir = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
            let current_dir = std::env::current_dir().unwrap_or_default();
            let dir_name = current_dir.to_string_lossy().into_owned();
            let re = regex::Regex::new(r"[^a-zA-Z0-9]").unwrap();
            let safe_name = re.replace_all(&dir_name.trim_start_matches('/'), "-").to_string();
            
            let claude_dir = Path::new(&home_dir).join(".claude").join("projects").join(&safe_name);
            if let Ok(entries) = fs::read_dir(claude_dir) {
                let mut latest_file = None;
                let mut latest_time = SystemTime::UNIX_EPOCH;
                for entry in entries.flatten() {
                    if let Ok(meta) = entry.metadata() {
                        if let Ok(time) = meta.modified() {
                            if time > latest_time && entry.path().extension().unwrap_or_default() == "jsonl" {
                                latest_time = time;
                                latest_file = Some(entry.path());
                            }
                        }
                    }
                }
                if let Some(path) = latest_file {
                    if let Ok(content) = fs::read_to_string(&path) {
                        if let Some(last_line) = content.lines().last() {
                            if let Ok(json) = serde_json::from_str::<serde_json::Value>(last_line) {
                                if let Some(text) = json.get("text").and_then(|t| t.as_str()) {
                                    agent_id = "Claude Code (Anthropic CLI)".to_string();
                                    intent = format!("[Scraped from Claude JSONL]\n{}", text);
                                    spinner.println(format!("{} Intercepted Claude Code transcript", "⚡".purple()));
                                }
                            }
                        }
                    }
                }
            }

            // Scrape context (OpenCode)
            // OpenCode uses an .opencode/transcripts directory locally
            if let Ok(entries) = fs::read_dir(".opencode/transcripts") {
                let mut latest_file = None;
                let mut latest_time = SystemTime::UNIX_EPOCH;
                for entry in entries.flatten() {
                    if let Ok(meta) = entry.metadata() {
                        if let Ok(time) = meta.modified() {
                            if time > latest_time && entry.path().extension().unwrap_or_default() == "md" {
                                latest_time = time;
                                latest_file = Some(entry.path());
                            }
                        }
                    }
                }
                if let Some(path) = latest_file {
                    if let Ok(content) = fs::read_to_string(&path) {
                        agent_id = "OpenCode (Terminal Agent)".to_string();
                        intent = format!("[Scraped from OpenCode Transcript]\n{}", content.lines().last().unwrap_or(""));
                        spinner.println(format!("{} Intercepted OpenCode session", "⚡".green()));
                    }
                }
            }

            // Fallback: Use git commit message as intent if no agent provided one
            // This covers VS Code, Cursor, and any agent that doesn't call aura_log_intent
            if intent.starts_with("Automatically tracked") || intent == "No semantic logic changes detected in staged files." {
                // Try to read the commit message from MERGE_MSG or COMMIT_EDITMSG
                let commit_msg = fs::read_to_string(".git/COMMIT_EDITMSG")
                    .or_else(|_| fs::read_to_string(".git/MERGE_MSG"))
                    .ok();
                if let Some(msg) = commit_msg {
                    let clean_msg = msg.lines()
                        .filter(|l| !l.starts_with('#'))
                        .collect::<Vec<_>>()
                        .join(" ")
                        .trim()
                        .to_string();
                    if !clean_msg.is_empty() {
                        intent = format!("[From commit message] {}", clean_msg);
                        spinner.println(format!("{} Using commit message as intent fallback", "📝".blue()));
                    }
                }

                // Also check the intent log JSONL for recent entries (from watcher or MCP)
                if intent.starts_with("Automatically tracked") {
                    if let Ok(log) = fs::read_to_string(".aura/intent_log.jsonl") {
                        if let Some(last_line) = log.lines().last() {
                            if let Ok(entry) = serde_json::from_str::<serde_json::Value>(last_line) {
                                if let Some(logged_intent) = entry["intent"].as_str() {
                                    let agent = entry["agent_id"].as_str().unwrap_or("unknown");
                                    intent = format!("[From intent log — {}] {}", agent, logged_intent);
                                    agent_id = agent.to_string();
                                    spinner.println(format!("{} Recovered intent from Aura intent log", "⚡".cyan()));
                                }
                            }
                        }
                    }
                }
            }

            // ── Session lifecycle: link this commit to an agent session ──
            let sess = session::SessionManager::start_session(&agent_id);
            // Record the staged files against this session — the ones actually
            // going into the commit, which is what this block always meant to
            // do. It used to walk the whole index instead, so every tracked
            // source file in the repo was filed as "touched" by every session,
            // and each one cost a full read of the session store. One batched
            // write now, over the real staged set.
            {
                let head_tree = repo
                    .head()
                    .ok()
                    .and_then(|h| h.peel_to_tree().ok());
                let staged: Vec<String> = repo
                    .diff_tree_to_index(head_tree.as_ref(), Some(&index), None)
                    .map(|diff| {
                        let mut paths = Vec::new();
                        for delta in diff.deltas() {
                            if let Some(p) = delta.new_file().path().or_else(|| delta.old_file().path()) {
                                let path_str = p.to_string_lossy().to_string();
                                if !detect_lang_ext(&path_str).is_empty() {
                                    paths.push(path_str);
                                }
                            }
                        }
                        paths
                    })
                    .unwrap_or_default();
                session::SessionManager::touch_files(&staged);
            }
            // Capture full Claude Code transcript into session storage
            session::capture_full_transcript();

            // Intent Verification (Logic Alignment): Prevent "Intent Poisoning"
            // Ensure the AI's text intent actually aligns with the code it modified.
            if !force && agent_id != "Aura Continuous Daemon" && !staged_nodes.is_empty() {
                // Check if aura_log_intent was actually called (marker file must exist)
                let intent_was_logged = std::path::Path::new(".aura/.intent_logged").exists();

                // Intent logging is ENFORCED only in strict gatekeeper mode.
                // In the default passive / warn-only mode — which is the whole
                // no-MCP `aura enable` drop-in path — a missing marker must
                // NEVER block the commit: capture is meant to be invisible and
                // frictionless (Entire-parity). The marker is only ever written
                // by the MCP tool `aura_log_intent` / CLI `aura log-intent`, so
                // a plain `git commit` with no MCP server attached legitimately
                // has no marker. Warn once and proceed so the checkpoint still
                // records. Strict mode keeps the hard block for teams that opt
                // into mandatory reasoning trails.
                if !intent_was_logged {
                    if config.strict_gatekeeper_mode {
                        spinner.finish_and_clear();
                        println!("{} Intent Not Logged: You must call {} before committing.", "🚨".red().bold(), "aura_log_intent".cyan().bold());
                        println!("  {} {} logic nodes were modified but no intent was logged via the MCP tool.", "↳".dimmed(), staged_nodes.len());
                        println!("\n  {} {}", "How to Fix:".bold().green(), "Call aura_log_intent with a description of your changes:");
                        println!("    {} aura_log_intent(\"<describe what you changed and why>\")", "→".dimmed());
                        println!("\n{} Commit halted.", "✗".red().bold());
                        std::process::exit(1);
                    }
                    // Warn-only (default): record the checkpoint without an
                    // explicit intent rather than halting the commit.
                    spinner.println(format!(
                        "{} {} logic node(s) changed without a logged intent — capturing anyway (warn-only mode).",
                        "ℹ".blue(),
                        staged_nodes.len()
                    ));
                    spinner.println(format!(
                        "  {} For an explicit reasoning trail run {}, or enforce it with {}.",
                        "↳".dimmed(),
                        "aura log-intent \"…\"".cyan(),
                        "aura config set strict-mode true".italic()
                    ));
                }

                // Intent was logged — consume the marker so it isn't reused for a later commit
                let _ = fs::remove_file(".aura/.intent_logged");

                // Reject the default fallback string explicitly
                if intent.starts_with("Automatically tracked") || intent == "No semantic logic changes detected in staged files." {
                    let config = ConfigManager::load();
                    
                    if config.strict_gatekeeper_mode {
                        spinner.finish_and_clear();
                        println!("{} Intent Poisoning Detected: Missing Explicit Intent.", "🚨".red().bold());
                        println!("  {} {}", "Why:".bold(), "The AI agent modified logic nodes but failed to provide an explicit semantic explanation.");
                        println!("  {} Aura requires all logic changes to be explicitly acknowledged to maintain the Merkle-Graph integrity.", "↳".dimmed());
                        
                        let mut identified_nodes = Vec::new();
                        for node in &staged_nodes {
                            if let Some(ref ident) = node.identifier {
                                identified_nodes.push(ident.clone());
                            }
                        }
                        println!("  {} Identified modified nodes: {}", "↳".dimmed(), identified_nodes.join(", ").yellow().bold());
                        println!("\n  {} {}", "How to Fix:".bold().green(), "Update your commit message to explain WHY you changed these nodes.");
                        if ConfigManager::is_strict_mode_locked(&config) {
                            println!("  {} Strict mode is passcode-locked (human must unlock from terminal).", "💡".blue());
                        } else {
                            println!("  {} To bypass this security requirement, run: {}", "💡".blue(), "aura config set strict-mode false".italic());
                        }
                        println!("\n{} Commit halted.", "✗".red().bold());
                        std::process::exit(1);
                    } else {
                        spinner.finish_and_clear();
                        println!("{} Intent Poisoning Warning.", "⚠️".yellow().bold());
                        println!("  {} Missing explicit semantic intent for modified nodes.", "↳".dimmed());
                        println!("  {} Strict mode is OFF. You can enable it with: {}", "💡".blue(), "aura config set strict-mode true".italic());
                        let should_continue = hook_guard::confirm(
                            "Continue with commit?",
                            true,
                            true,
                            "continuing, because strict mode is off and a missing explicit intent is a warning here, not a gate",
                        );
                        if !should_continue {
                            println!("{} Commit cancelled. Add semantic intent to your commit message and try again.", "✗".red().bold());
                            std::process::exit(1);
                        }
                    }
                }

                let intent_lower = intent.to_lowercase();
                let mut aligned = false;
                let mut identified_nodes = Vec::new();

                for node in &staged_nodes {
                    if let Some(ref ident) = node.identifier {
                        identified_nodes.push(ident.clone());
                        
                        // Strict Word Boundary Matching to prevent false positives (e.g. 's' or 'a')
                        let pattern = format!(r"\b{}\b", regex::escape(&ident.to_lowercase()));
                        if let Ok(re) = regex::Regex::new(&pattern) {
                            if re.is_match(&intent_lower) {
                                aligned = true;
                            }
                        }
                    }
                }

                let config = ConfigManager::load();

                if !aligned {
                    if config.strict_gatekeeper_mode {
                        spinner.finish_and_clear();
                        println!("{} Intent Poisoning Detected: Logic Mismatch.", "🚨".red().bold());
                        println!("  {} {}", "Why:".bold(), "The semantic intent (commit message or agent history) does not mathematically align with the AST nodes you modified.");
                        println!("  {} Aura requires all logic changes to be explicitly acknowledged to maintain the Merkle-Graph integrity.", "↳".dimmed());
                        println!("  {} Identified modified nodes: {}", "↳".dimmed(), identified_nodes.join(", ").yellow().bold());
                        
                        println!("\n  {} {}", "How to Fix:".bold().green(), "Update your commit message to include the EXACT names of the functions or classes listed above.");
                        println!("  {} Example: {} 'Refactored {}'", "↳".dimmed(), "git commit -m".cyan(), identified_nodes.first().unwrap_or(&"logic".to_string()));
                        if ConfigManager::is_strict_mode_locked(&config) {
                            println!("  {} Strict mode is passcode-locked (human must unlock from terminal).", "💡".blue());
                        } else {
                            println!("  {} If this is intentional and you wish to bypass this check, run: {}", "💡".blue(), "aura config set strict-mode false".italic());
                        }
                        
                        println!("\n{} Commit halted.", "✗".red().bold());
                        std::process::exit(1);
                    } else {
                        spinner.finish_and_clear();
                        println!("{} Intent Mismatch Warning.", "⚠️".yellow().bold());
                        println!("  {} The AI modified nodes without explicit documentation: {}", "↳".dimmed(), identified_nodes.join(", ").yellow());
                        println!("  {} Strict mode is OFF. You can enable it with: {}", "💡".blue(), "aura config set strict-mode true".italic());
                        // The most frequently reached prompt in the whole hook: it
                        // fires whenever a commit message doesn't happen to name
                        // the symbols that changed, which is most commits. Under a
                        // GUI client that made every such commit hang.
                        let should_continue = hook_guard::confirm(
                            "Continue with commit?",
                            true,
                            true,
                            "continuing, because strict mode is off and an unnamed symbol is a warning here, not a gate",
                        );
                        if !should_continue {
                            println!("{} Commit cancelled. Update your commit message to reference the modified nodes.", "✗".red().bold());
                            std::process::exit(1);
                        }
                    }
                } else {
                    spinner.println(format!("{} Intent mathematically aligned with AST modifications.", "🛡️ ".green()));
                }
            }

            // Check for pending live impacts (non-blocking warning)
            {
                let marker_path = Path::new(".aura/live/impacts_pending");
                if marker_path.exists() {
                    if let Ok(contents) = fs::read_to_string(marker_path) {
                        if let Ok(count) = contents.trim().parse::<u64>() {
                            if count > 0 {
                                println!("{} {} unresolved cross-branch impact alert{}. Run {} to review.",
                                    "⚠️".yellow().bold(),
                                    count.to_string().yellow().bold(),
                                    if count == 1 { "" } else { "s" },
                                    "aura live impacts".cyan());
                            }
                        }
                    }
                }
            }

            // Proactive Blast Radius Detection
            if let Some(latest) = previous_checkpoint.as_ref() {
                let mut modified_identifiers = Vec::new();
                for current_node in &staged_nodes {
                    let mut is_modified = true;
                    for past_node in &latest.ast_nodes {
                        if past_node.identifier == current_node.identifier && past_node.content_hash == current_node.content_hash {
                            is_modified = false;
                            break;
                        }
                    }
                    if is_modified {
                        if let Some(ref ident) = current_node.identifier {
                            modified_identifiers.push(ident.clone());
                        }
                    }
                }

                let mut tainted_downstream = Vec::new();
                for past_node in &latest.ast_nodes {
                    for dep in &past_node.dependencies {
                        if modified_identifiers.contains(&dep.name) {
                            if let Some(ref past_ident) = past_node.identifier {
                                if !tainted_downstream.contains(past_ident) {
                                    tainted_downstream.push(past_ident.clone());
                                }
                            }
                        }
                    }
                }

                if !tainted_downstream.is_empty() {
                    spinner.println(format!("{} Proactive Blast Radius: The following downstream logic blocks may be tainted by this change:", "⚠️".yellow().bold()));
                    for tainted in tainted_downstream {
                        spinner.println(format!("  {} {}", "↳".dimmed(), tainted.yellow()));
                    }
                    spinner.println(format!("  {} Run `aura map` to view the affected Merkle-Graph edges.", "↳".dimmed()));
                }
            }

            spinner.set_message(format!("{}", "Generating Neural Embeddings...".bold()));
            let (intent_vector, intent_vector_model) = match embeddings::embed(&intent) {
                Some((v, m)) => (Some(v), Some(m)),
                None => (None, None),
            };

            // Generate UUID and save temporary checkpoint
            let id = Uuid::new_v4().to_string();
            let timestamp = SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis() as u64;
            
            spinner.set_message(format!("{}", "Capturing Environment Fingerprint...".bold()));
            let env_fingerprint = capture_env_fingerprint();

            let checkpoint = CheckpointData {
                id: id.clone(),
                agent_id,
                intent,
                ast_nodes: staged_nodes.clone(),
                timestamp,
                intent_vector,
                intent_vector_model,
                env_fingerprint,
                file_oids,
            };

            CheckpointStore::stage_checkpoint(&checkpoint)?;

            // Increment session checkpoint count
            session::SessionManager::increment_checkpoint();

            spinner.finish_and_clear();

            // Taste Engine — Phase 3 strict-mode gate. Block the commit
            // when:
            //   1. strict_gatekeeper_mode is on (parent strict toggle), AND
            //   2. taste_strict is on (taste-specific opt-in), AND
            //   3. the staged diff violates any rule at the configured
            //      confidence threshold.
            // Otherwise: surface a warning. `--force` (and Dev Mode)
            // skip the check entirely so a power-user override still
            // works through the same channel as the secret guard above.
            if !*force && !config.dev_mode {
                if let Ok(report) = crate::taste::check::check_staged(&repo, config.taste_strict_threshold) {
                    if !report.violations.is_empty() {
                        let blocking = config.strict_gatekeeper_mode && config.taste_strict;
                        if blocking {
                            println!("\n{} {} taste violation(s) at confidence ≥ {:.2}. Commit halted.",
                                "🚨".red().bold(),
                                report.violations.len(),
                                config.taste_strict_threshold,
                            );
                            for v in report.violations.iter().take(8) {
                                println!("  {} {}", "•".red(), v.file_path.bold());
                                println!("    rule: {}", v.rule_statement);
                                println!("    issue: {}", v.reason.yellow());
                            }
                            if report.violations.len() > 8 {
                                println!("  {} ...and {} more", "↳".dimmed(), report.violations.len() - 8);
                            }
                            println!("  {} Either fix the diff or commit with {} to bypass.", "💡".blue(), "aura capture-context --force".italic());
                            std::process::exit(1);
                        } else {
                            println!("{} {} taste finding(s) (advisory).",
                                "🧪".yellow().bold(),
                                report.violations.len(),
                            );
                            for v in report.violations.iter().take(3) {
                                println!("  {} {}: {}", "•".yellow(), v.file_path.dimmed(), v.reason);
                            }
                            if report.violations.len() > 3 {
                                println!("  {} `aura taste check` for the full list.", "↳".dimmed());
                            }
                        }
                    }
                }
            }

            // ── Semantic CI (additive) ───────────────────────────────────
            // The inline gates above already enforced blocking with their exact
            // strict/dev-mode semantics. Run the declared .aura/pipelines
            // pipeline ALONGSIDE them — reusing the AstNodes we just parsed — so
            // the commit is now a named Semantic CI run (the pipeline IS the
            // gate). Additive by design: it records + summarizes, it does NOT
            // re-block (no double-flagging). Best-effort; never affects commit.
            if let Some(root) = repo.workdir() {
                let _ = ci::run_pre_commit_additive(&repo, root, &staged_nodes);
            }

            // ── Awareness: announce committed symbols (M3c) ──────────────
            // A successful checkpoint means these symbols just landed. Emit a
            // `committed` awareness event per distinct named definition so a
            // teammate editing the same function sees "landed under you" (a
            // likely-rebase collision) instead of silence. Best-effort, silent,
            // capped, deduped — attribution is the git user (`agent: None`) and
            // the awareness store is self-bounded, so this can't firehose.
            {
                let mut seen: std::collections::HashSet<&str> = std::collections::HashSet::new();
                for node in &staged_nodes {
                    if seen.len() >= 25 {
                        break;
                    }
                    let Some(ident) = node.identifier.as_deref() else { continue };
                    if ident.is_empty() || ident.eq_ignore_ascii_case("anonymous") || ident.starts_with("__") {
                        continue;
                    }
                    if !node.top_level {
                        continue;
                    }
                    // Definitions only — not call-sites, locals, or expressions.
                    let k = node.kind.as_str();
                    let is_def = k.contains("function")
                        || k.contains("method")
                        || k.contains("class")
                        || k.contains("struct")
                        || k.contains("interface")
                        || k.contains("enum")
                        || k.contains("trait");
                    if !is_def || !seen.insert(ident) {
                        continue;
                    }
                    let _ = awareness::emit::emit(awareness::emit::EmitInput {
                        kind: awareness::AwarenessKind::Committed,
                        file: node.file_path.clone(),
                        symbol: Some(ident.to_string()),
                        intent: None,
                        impact: None,
                        agent: None,
                    });
                }
            }

            // Promote the staged checkpoint into a durable Git Note when we are
            // the only writer that will. `stage_checkpoint` above only wrote
            // `.git/AURA_CTX.json`; that file is promoted onto HEAD by the
            // post-commit hook (`aura persist-checkpoint` → `commit_staged`).
            // But when `capture-context` is invoked directly from a terminal —
            // or the commit lands with `git commit --no-verify`, bypassing the
            // hook — nothing ever promotes it, so `status`, `prove`, and
            // `goal-trace` (which read committed Notes via `get_all_checkpoints`)
            // report "no checkpoints" despite the ✓ here. Git exports
            // `GIT_INDEX_FILE` only while running a hook, so its absence means we
            // are a direct invocation and must persist the Note ourselves.
            let in_git_hook = std::env::var_os("GIT_INDEX_FILE").is_some();
            let head_exists = repo.head().and_then(|r| r.peel_to_commit()).is_ok();
            let mut promoted = false;
            if !in_git_hook && head_exists {
                match CheckpointStore::commit_staged(&repo) {
                    Ok(()) => promoted = true,
                    Err(e) => eprintln!(
                        "  {} staged, but could not persist the checkpoint Git note: {e}",
                        "⚠".yellow()
                    ),
                }
            }

            if promoted {
                println!("{} Checkpoint saved.", "✓".green().bold());
            } else {
                // Hook context (post-commit will promote) or an empty repo with
                // no HEAD to attach to — the staged file is the durable record.
                println!("{} Checkpoint logic staged.", "✓".green().bold());
            }
            println!("  {} {} semantic nodes tracked", "↳".dimmed(), staged_nodes.len().to_string().cyan());
            println!("  {} Session: {}", "↳".dimmed(), sess.session_id.dimmed());
        }
        Commands::InjectTrailer { commit_msg_file } => {
            if let Ok(Some(data)) = CheckpointStore::read_staged() {
                let trailer = format!("\n\nAura-Checkpoint: {}\n", data.id);
                let mut file = OpenOptions::new().append(true).open(commit_msg_file)?;
                file.write_all(trailer.as_bytes())?;
            }
        }
        Commands::PersistCheckpoint => {
            let repo = open_repo()?;
            if let Ok(Some(data)) = CheckpointStore::read_staged() {
                // Persist to git notes (primary)
                if let Err(e) = CheckpointStore::commit_staged(&repo) {
                    println!("Failed to persist checkpoint: {}", e);
                } else {
                    println!("{} Checkpoint {} permanently recorded in Git metadata.", "✓".green().bold(), &data.id[0..8]);
                }

                // Condense to shadow branch (rebase-proof backup)
                let session_json = session::SessionManager::get_active_session()
                    .and_then(|s| serde_json::to_string_pretty(&s).ok());
                if let Err(e) = CheckpointStore::condense_to_shadow(
                    &repo, &data, session_json.as_deref()
                ) {
                    // Non-fatal — notes are the primary store
                    eprintln!("Shadow branch write skipped: {}", e);
                }

                // Track base commit for migration detection
                let _ = CheckpointStore::migrate_shadow_if_needed(&repo);

                // Backfill the commit-keyed rationale store: replace any
                // "pending" SHAs written pre-commit (live path) with the real
                // HEAD SHA now that the commit exists. Best-effort, no-op when
                // the store is absent or has nothing pending.
                if let Ok(head_oid) = repo.head().and_then(|r| r.peel_to_commit().map(|c| c.id())) {
                    crate::live_events::backfill_commit_shas(&head_oid.to_string());
                }

                // Taste Engine — observe the new HEAD commit. Idempotent
                // (skips if the sha is already in observations.jsonl) and
                // non-fatal so a template bug never blocks a commit.
                if let Ok(head_oid) = repo.head().and_then(|r| r.peel_to_commit().map(|c| c.id())) {
                    let agent_id = session::SessionManager::get_active_session()
                        .map(|s| s.agent_id)
                        .unwrap_or_else(|| "human".to_string());
                    // intent_id binding lives in Phase 1 (via intent_vs_actual);
                    // Phase 0 leaves it None — observations still aggregate fine.
                    if let Err(e) = taste::observe_commit(
                        &repo,
                        &head_oid.to_string(),
                        &agent_id,
                        None,
                    ) {
                        eprintln!("Taste observation skipped: {}", e);
                    }
                }

                // Goal-alignment spine — keep the work tied to the goal it
                // serves and prove it against the just-committed code. Resolves
                // the active task, makes sure it has a goal (born from the task
                // if needed), decomposes once from the live reasons, then
                // re-proves (AST-only) and records the result against this sha.
                // Fully non-blocking: the commit already happened.
                if let Ok(head_oid) = repo.head().and_then(|r| r.peel_to_commit().map(|c| c.id())) {
                    if let Some(root) = repo.workdir() {
                        let proofs = goals::build::prove_active_on_commit(root, &head_oid.to_string());
                        for p in &proofs {
                            let (glyph, word) = match p.verdict {
                                goals::Verdict::Verified => ("✓".green(), "built and checked"),
                                goals::Verdict::Partial => ("◐".yellow(), "almost there"),
                                goals::Verdict::NotWired => ("○".red(), "not started yet"),
                                goals::Verdict::Unknown => ("·".dimmed(), "noted"),
                            };
                            let lead = if p.freshly_decomposed { "Goal" } else { "Goal re-checked" };
                            println!(
                                "{} {} — {} ({} of {} parts)",
                                glyph,
                                format!("{}: {}", lead, p.goal_text).dimmed(),
                                word,
                                p.ok,
                                p.total
                            );
                        }
                        // Record those same proofs as the named `goal-aligned`
                        // Semantic CI step — the post-commit goal check is now a
                        // pipeline step result, not a one-off print. Additive,
                        // best-effort; reuses the proofs (no re-prove).
                        let _ = ci::record_goal_aligned_post_commit(&proofs);
                    }
                }

                // End session on commit — capture final state first
                let final_session = session::SessionManager::get_active_session();
                session::SessionManager::end_session();

                // Cloud sync (if configured)
                // PRIVACY: Only sync structured metadata — never raw messages/transcripts.
                // Transcripts stay local (on disk + shadow branch). Cloud gets:
                // session metadata, token counts, file list, model name, summary.
                let config = crate::config::ConfigManager::load();
                if config.sync_enabled && config.cloud_api_token.is_some() {
                    let session_payload = final_session.map(|sess| {
                        serde_json::json!({
                            "session_id": sess.session_id,
                            "agent_id": sess.agent_id,
                            "phase": "Ended",
                            "started_at": sess.started_at,
                            "last_activity": sess.last_activity,
                            "files_touched": sess.files_touched,
                            "checkpoint_count": sess.checkpoint_count,
                            "base_commit": sess.base_commit,
                            "branch": sess.branch,
                            "model_name": sess.model_name,
                            "token_usage": sess.token_usage,
                            "subagent_count": sess.subagents.len(),
                            "summary": sess.summary,
                            // No transcript, no first_prompt, no raw messages
                        })
                    });

                    if let Ok(remote) = repo.find_remote("origin")
                        .and_then(|r| Ok(r.url().unwrap_or("").to_string()))
                    {
                        if !remote.is_empty() {
                            std::thread::spawn(move || {
                                crate::sync::GlobalSync::sync_checkpoints(&remote);
                                // Sync session with transcript to cloud
                                if let Some(payload) = session_payload {
                                    crate::sync::GlobalSync::sync_session(&remote, &payload);
                                }
                            });
                        }
                    }
                }
            }
        }
        Commands::Ask { query } => {
            let repo = open_repo()?;
            
            println!("\n{} {}\n", "🧠".bold(), "Aura Semantic Brain: Searching Git Context Branch...".bold().magenta());

            let mut results = CheckpointStore::get_all_checkpoints(&repo)?;
            
            // Vector Logic Search MVP
            if query != "recent" {
                println!("{} Generating embedding for query: \"{}\"\n", "🔍".cyan(), query.italic());
                
                let query_embedding = embeddings::embed(&query);

                if let Some((qv, qmodel)) = query_embedding {
                    // Vectors from different models live in different spaces —
                    // only compare same-model. Legacy checkpoints carry no
                    // stamp; cosine_similarity's length guard (→ 0.0 on dim
                    // mismatch) keeps cross-space noise out for those.
                    let score = |cp: &CheckpointData| -> f32 {
                        match (&cp.intent_vector, &cp.intent_vector_model) {
                            (Some(v), Some(m)) if *m == qmodel => {
                                embeddings::cosine_similarity(v, &qv)
                            }
                            (Some(v), None) => embeddings::cosine_similarity(v, &qv),
                            _ => 0.0,
                        }
                    };
                    results.sort_by(|a, b| {
                        // Sort descending by score
                        score(b).partial_cmp(&score(a)).unwrap_or(std::cmp::Ordering::Equal)
                    });

                    // Filter out low relevance using cosine similarity threshold
                    results.retain(|r| score(r) > 0.3); // Standard threshold
                } else {
                    println!("{} Empty query — nothing to search.", "✗".red());
                    return Ok(());
                }
            }

            if results.is_empty() {
                println!("{} {}", "✗".red().bold(), "No agent context found matching the query.".red());
                println!("\n  {} {}", "ℹ️ ".blue(), "Why is this empty?".bold());
                println!("    Aura tracks AI reasoning via `git commit` or the `aura daemon`.");
                println!("    Since this repository was just initialized, there is no semantic history yet.\n");
                println!("  {} {}", "🛠️  ".green(), "How to build the graph:".bold());
                println!("    1. Write some code (or have an AI write it).");
                println!("    2. Run `git commit -m \"My message\"`.");
                println!("    3. Aura will automatically intercept the commit and log the logic.\n");
                println!("  {} To record every keystroke automatically, run `{}` in a separate terminal.", "↳".dimmed(), "aura daemon".cyan());
            } else {
                println!("╭─────────────────────────┬─────────────────────────────────────────────────────────────╮");
                println!("│ {}    │ {}                                 │", "Agent / Orchestrator".cyan().bold(), "Semantic Reasoning (Intent)".green().bold());
                println!("├─────────────────────────┼─────────────────────────────────────────────────────────────┤");

                for data in results.iter().take(5) { // Show top 5
                    let agent_padded = format!("{:width$}", data.agent_id, width = 23);
                    let mut intent_display = data.intent.clone();
                    if let Some(ref fp) = data.env_fingerprint {
                        intent_display.push_str(&format!("\n[Env Fingerprint: {}]", &fp[0..12]));
                    }
                    let wrapped_intent = textwrap::wrap(&intent_display, 59);
                    
                    for (i, line) in wrapped_intent.iter().enumerate() {
                        if i == 0 {
                            println!("│ {} │ {} │", agent_padded.bright_blue(), format!("{:width$}", line, width = 59).white());
                        } else {
                            println!("│ {} │ {} │", format!("{:width$}", "", width = 23), format!("{:width$}", line, width = 59).dimmed());
                        }
                    }
                    println!("├─────────────────────────┼─────────────────────────────────────────────────────────────┤");
                }
                println!("  {} Read {} checkpoints from `aura/checkpoints/v1`\n", "↳".dimmed(), results.len().to_string().dimmed());
            }
        }
        Commands::Handover { agent, manager_session } => {
            let repo = open_repo()?;

            println!("{} Generating dense XML context payload for {}...", "🔄".cyan(), agent.bold());

            // Carryover is the core. `aura handover` is now a thin XML
            // renderer over the one assembler the in-app brain-swap and
            // the portable CLI handoff both share — no hand-rolled
            // checkpoint walk. We get the strict superset the old block
            // never had: signed intents, function-level intent on each
            // touched node (with is_stub flagging unfinished work), the
            // working-tree diff, the session digest, project memory and
            // the transcript tail. Full mode (200 turns) because a
            // handover paste-block wants maximum fidelity; redaction
            // runs unconditionally since the payload leaves the box.
            let opts = continuity::AssembleOpts::for_mode(
                continuity::CarryoverMode::Full,
                Some(agent.clone()),
                0,
            );
            let mut carryover = continuity::assemble::assemble(&opts);
            continuity::redact::redact_carryover(&mut carryover);
            let mut xml_payload = continuity::render::to_xml(&carryover);

            // Bucket M5 — Manager Continuum tier (anchored + working
            // window) rendered as a top-level sibling so the next agent
            // inherits identical manager memory. Read straight from the
            // persisted session JSON; the shell flushes via persist::save
            // on every chat push. Lives outside <aura_semantic_context>
            // because it's manager-loop chat state, not the semantic
            // record the carryover assembles.
            if let Some(sid) = &manager_session {
                if let Some(home) = std::env::var_os("HOME") {
                    let mut path = std::path::PathBuf::from(home);
                    path.push(".aura");
                    path.push("manager-sessions");
                    path.push(format!("{sid}.json"));
                    match std::fs::read_to_string(&path) {
                        Ok(raw) => {
                            match serde_json::from_str::<serde_json::Value>(&raw) {
                                Ok(session) => {
                                    let chat = session.get("chat")
                                        .and_then(|c| c.as_array())
                                        .cloned()
                                        .unwrap_or_default();
                                    const HOT: usize = 24;
                                    let split = chat.len().saturating_sub(HOT);
                                    let (older, working) = chat.split_at(split);
                                    let anchored: Vec<&serde_json::Value> = older.iter()
                                        .filter(|t| t.get("anchor").map(|a| !a.is_null()).unwrap_or(false))
                                        .collect();
                                    xml_payload.push_str(&format!(
                                        "<manager_continuum session=\"{}\">\n",
                                        sid.replace('"', "&quot;")
                                    ));
                                    xml_payload.push_str("  <anchored>\n");
                                    for t in &anchored {
                                        let role = t.get("role").and_then(|r| r.as_str()).unwrap_or("user");
                                        let text = t.get("text").and_then(|s| s.as_str()).unwrap_or("");
                                        let anchor = t.get("anchor").and_then(|a| a.as_str()).unwrap_or("user_pin");
                                        xml_payload.push_str(&format!(
                                            "    <turn role=\"{}\" anchor=\"{}\">{}</turn>\n",
                                            role,
                                            anchor,
                                            text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
                                        ));
                                    }
                                    xml_payload.push_str("  </anchored>\n  <working>\n");
                                    for t in working {
                                        let role = t.get("role").and_then(|r| r.as_str()).unwrap_or("user");
                                        let text = t.get("text").and_then(|s| s.as_str()).unwrap_or("");
                                        xml_payload.push_str(&format!(
                                            "    <turn role=\"{}\">{}</turn>\n",
                                            role,
                                            text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
                                        ));
                                    }
                                    xml_payload.push_str("  </working>\n");
                                    xml_payload.push_str("</manager_continuum>\n");
                                }
                                Err(e) => eprintln!("warn: parse manager session {sid}: {e}"),
                            }
                        }
                        Err(e) => eprintln!("warn: read manager session {sid}: {e}"),
                    }
                }
            }

            // Taste Engine — inject the learned coding patterns alongside
            // the semantic context. Cheap (file read) and bounded to the
            // top 20 active rules so the handover stays compact. Block
            // is emitted unconditionally — empty rules still render a
            // self-explaining stub so the receiving agent sees the
            // surface and doesn't ask "what taste?".
            {
                let repo_root = repo.workdir().map(|w| w.to_path_buf());
                if let Some(root) = repo_root {
                    let set = taste::aggregate::load_rules(&root);
                    let active: Vec<&taste::aggregate::Rule> = set
                        .rules
                        .iter()
                        .filter(|r| matches!(
                            r.status,
                            taste::aggregate::RuleStatus::Active
                                | taste::aggregate::RuleStatus::Provisional
                        ))
                        .take(20)
                        .collect();
                    xml_payload.push_str("\n<learned_taste>\n");
                    if active.is_empty() {
                        xml_payload.push_str("  <!-- No taste rules learned yet. Make a few commits and rerun handover. -->\n");
                    } else {
                        for r in &active {
                            xml_payload.push_str(&format!(
                                "  <rule id=\"{}\" template=\"{}\" language=\"{}\" confidence=\"{:.2}\">{}</rule>\n",
                                r.id,
                                r.template,
                                r.language,
                                r.confidence,
                                r.statement.replace('<', "&lt;").replace('>', "&gt;"),
                            ));
                        }
                    }
                    xml_payload.push_str("</learned_taste>\n");
                }
            }

            // In a real product, we would pipe this into pbcopy or directly into the target agent's config file
            println!("\n{}", xml_payload.dimmed());
            println!("\n{} Handover block ready. Paste this into {}'s prompt or system rules.", "✓".green().bold(), agent);

            let config = crate::config::ConfigManager::load();
            if config.sync_enabled && config.cloud_api_token.is_some() {
                let session_id = session::SessionManager::get_active_session().map(|s| s.session_id);
                let token_count = xml_payload.len() as u64 / 4;
                const MAX_PUSH: usize = 256 * 1024;
                let summary_push = if xml_payload.len() > MAX_PUSH {
                    let mut end = MAX_PUSH;
                    while !xml_payload.is_char_boundary(end) { end -= 1; }
                    format!("{}\n<!-- truncated: original {} bytes -->", &xml_payload[..end], xml_payload.len())
                } else {
                    xml_payload.clone()
                };
                crate::sync::GlobalSync::push_handover(
                    session_id.as_deref(),
                    agent,
                    &summary_push,
                    token_count,
                );
            }
        }
        Commands::Rewind { identifier, file_path, amnesia } => {
            println!("\n{} {} {}", "⏪".bold(), "Aura Semantic Time Machine: Rewinding".bold().cyan(), identifier.bold().yellow());

            let repo = open_repo()?;
            let mut parser = SemanticParser::new()?;

            // Determine file extension
            let ext = detect_lang_ext(&file_path);
            if ext.is_empty() {
                // Honest failure: nothing was brought back, so exit non-zero.
                // A caller that reports "success" on exit 0 (the desktop
                // "Bring this back" button) must not paint a false green here.
                eprintln!("Aura can't bring back this kind of file yet ({}).", file_path);
                std::process::exit(1);
            }
            let ext = ext.as_str();

            // 1. Parse the current file on disk
            let current_source = match fs::read_to_string(file_path) {
                Ok(s) => s,
                Err(e) => {
                    eprintln!("Couldn't open {} to bring it back: {}", file_path, e);
                    std::process::exit(1);
                }
            };

            // A deleted piece has no current range. That used to end the command
            // right here — backwards, because deletion is the case a pre-edit
            // snapshot is taken for, and the one the deletion guard halts a
            // commit over. Carry the absence through instead: the searches below
            // are what find the old version, and it gets spliced back in rather
            // than replaced.
            let current_node_info = parser.retrieve_node_source(&current_source, ext, identifier)?;
            let was_deleted = current_node_info.is_none();
            let (current_node_source, current_range) = match current_node_info {
                Some((src, range)) => (Some(src), Some(range)),
                None => {
                    println!("  {} '{}' isn't in {} any more — looking for the version that was saved before it went.", "↳".dimmed(), identifier, file_path);
                    (None, None)
                }
            };

            // 2. Search for previous state — try THREE sources in order:
            //    a) Durable file snapshots (.aura/snapshots/) — survives even without commits
            //    b) Full git history (walk ALL commits, not just HEAD~1)
            //    c) Fall back to HEAD~1 as last resort

            let mut past_node_source: Option<String> = None;
            // The whole file the old version came from, kept so a deleted piece
            // can be placed by its neighbours instead of a stale byte offset.
            let mut past_file_source: Option<String> = None;

            // Strategy A: Check durable snapshots first
            println!("  {} Searching durable snapshots...", "↳".dimmed());
            let snapshots = checkpoint::SnapshotStore::get_snapshots_for_file(file_path);
            for snap in &snapshots {
                if let Ok(Some((src, _))) = parser.retrieve_node_source(&snap.content, ext, identifier) {
                    // Anything found is a real recovery when the piece is gone;
                    // otherwise it has to actually differ from what's on disk.
                    if current_node_source.as_deref() != Some(src.as_str()) {
                        println!("  {} Found in snapshot from {} (trigger: {})",
                            "✓".green(), snap.timestamp, snap.trigger);
                        past_node_source = Some(src);
                        past_file_source = Some(snap.content.clone());
                        break;
                    }
                }
            }

            // Strategy B: Walk git history (HEAD + up to 49 ancestors).
            // Read each commit's tree at the top of the loop so HEAD
            // itself is searched — the "uncommitted local edit, HEAD
            // is clean" case (most common AI-hallucination recovery
            // shape) was being silently skipped because the previous
            // loop walked to commit.parent(0) before ever reading a
            // tree.
            if past_node_source.is_none() {
                println!("  {} Searching git history (HEAD + up to 49 ancestors)...", "↳".dimmed());
                let mut commit = match repo.head().and_then(|r| r.peel_to_commit()) {
                    Ok(c) => c,
                    Err(_) => {
                        // Nothing was brought back, so this cannot exit 0 — the
                        // desktop "Bring this back" button reads the status and
                        // would otherwise report a recovery that never happened.
                        eprintln!("There are no commits yet to look through for an earlier version of '{}'.", identifier);
                        std::process::exit(1);
                    }
                };

                for depth in 0..50 {
                    let tree = commit.tree()?;
                    if let Ok(entry) = tree.get_path(Path::new(file_path)) {
                        let obj = entry.to_object(&repo)?;
                        if let Some(blob) = obj.as_blob() {
                            if let Ok(past_source) = std::str::from_utf8(blob.content()) {
                                if let Ok(Some((src, _))) = parser.retrieve_node_source(past_source, ext, identifier) {
                                    // Same rule as the snapshot pass: a missing
                                    // piece makes any hit a recovery.
                                    if current_node_source.as_deref() != Some(src.as_str()) {
                                        let label = if depth == 0 {
                                            "HEAD".to_string()
                                        } else {
                                            format!("HEAD~{}", depth)
                                        };
                                        println!("  {} Found in commit {} ({})",
                                            "✓".green(), label, &commit.id().to_string()[..8]);
                                        past_node_source = Some(src);
                                        past_file_source = Some(past_source.to_string());
                                        break;
                                    }
                                }
                            }
                        }
                    }
                    match commit.parent(0) {
                        Ok(p) => commit = p,
                        Err(_) => break,
                    }
                }
            }

            let past_node_source = match past_node_source {
                Some(s) => s,
                None => {
                    // No snapshot and no differing version in git history: there
                    // is genuinely nothing to restore. Exit non-zero so the
                    // desktop button reports an honest "couldn't bring it back"
                    // instead of a fabricated success.
                    if was_deleted {
                        eprintln!(
                            "'{}' is gone from {}, and Aura has no saved copy of it — no snapshot, and it isn't in the last 50 commits either.",
                            identifier, file_path
                        );
                    } else {
                        eprintln!(
                            "There's no earlier saved version of '{}' to bring back — it may have been created here, with no prior version to return to.",
                            identifier
                        );
                    }
                    std::process::exit(1);
                }
            };

            // Snapshot the current state BEFORE we rewind (safety net)
            if let Err(e) = checkpoint::SnapshotStore::snapshot_file(file_path, "pre_rewind", "aura-rewind") {
                eprintln!("  {} Warning: Could not snapshot current state: {}", "⚠️".yellow(), e);
            }

            // 4. Perform the Semantic Surgery — replace the piece if it is still
            //    there, splice it back beside its old neighbours if it isn't.
            let new_source = match current_range {
                Some(range) => {
                    let mut s = current_source.clone();
                    s.replace_range(range, &past_node_source);
                    s
                }
                None => {
                    let past_file = past_file_source.unwrap_or_default();
                    match parser.splice_node_back(&current_source, &past_file, ext, identifier)? {
                        Some(s) => s,
                        None => {
                            eprintln!("Couldn't work out where '{}' belongs in {}.", identifier, file_path);
                            std::process::exit(1);
                        }
                    }
                }
            };

            // 5. Save the file
            let mut file = OpenOptions::new().write(true).truncate(true).open(file_path)?;
            file.write_all(new_source.as_bytes())?;

            if was_deleted {
                println!("{} Put '{}' back where it was, from its last saved version.", "✓".green().bold(), identifier);
            } else {
                println!("{} Surgically reverted '{}' to its previous logic state.", "✓".green().bold(), identifier);
            }
            println!("  {} The rest of {} remains untouched.", "↳".dimmed(), file_path);

            // Taste Engine — rewind is the strongest negative signal
            // we capture (weight -3.0 via signal_weight). Apply it to
            // every rule scoping to this file's language+layer so the
            // aggregator can decay confidence on the next mine.
            if let Some(root) = repo.workdir() {
                let head_sha = repo
                    .head()
                    .and_then(|r| r.peel_to_commit().map(|c| c.id().to_string()))
                    .unwrap_or_default();
                if !head_sha.is_empty() {
                    let _ = taste::record_negative_signal(
                        &root.to_path_buf(),
                        &head_sha,
                        file_path,
                        "rewind",
                        "human",
                    );
                }
            }

            if *amnesia {
                println!("  {} Executing Amnesia Protocol: Wiping AI hallucination context...", "↳".dimmed().magenta());
                let override_msg = format!("\n> [SYSTEM: AURA OVERRIDE]\n> The human architect has mathematically reverted the '{}' logic node to a previous safe state via the Semantic Scalpel.\n> You MUST forget your previous implementation attempts for this node. Read the current file state and await new instructions.\n", identifier);
                
                // Attempt to inject into Aider
                if let Ok(mut file) = OpenOptions::new().append(true).open(".aider.chat.history.md") {
                    let _ = file.write_all(override_msg.as_bytes());
                    println!("    {} Injected System Override into Aider chat history.", "✓".green());
                }

                // Attempt to inject into Gemini CLI session (just create a system note)
                let _ = fs::create_dir_all(".aura");
                let _ = fs::write(".aura/amnesia_override.md", &override_msg);
                println!("    {} System Override generated. AI Agents should read .aura/amnesia_override.md before proceeding.", "✓".green());
            }
        }
        Commands::Dashboard => {
            tokio::runtime::Runtime::new().unwrap().block_on(server::start_dashboard());
        }
        Commands::Map => {
            println!("\n{} {}\n", "🕸️".bold(), "Aura Semantic Merkle-Graph (Latest State)".bold().cyan());
            let repo = open_repo()?;
            let latest = CheckpointStore::latest_checkpoint(&repo)?;
            
            if let Some(latest) = latest.as_ref() {
                use petgraph::Graph;
                use petgraph::dot::{Dot, Config};
                use std::collections::HashMap;

                let mut graph = Graph::<String, &str>::new();
                let mut node_indices = HashMap::new();

                // Add all nodes
                for node in &latest.ast_nodes {
                    let name = node.identifier.clone().unwrap_or_else(|| "Anonymous".to_string());
                    let idx = graph.add_node(format!("{} ({})", name, node.kind));
                    node_indices.insert(name.clone(), idx);
                }

                // Add edges based on dependencies
                for node in &latest.ast_nodes {
                    let name = node.identifier.clone().unwrap_or_else(|| "Anonymous".to_string());
                    if let Some(&from_idx) = node_indices.get(&name) {
                        for dep in &node.dependencies {
                            if let Some(&to_idx) = node_indices.get(&dep.name) {
                                graph.add_edge(from_idx, to_idx, "calls");
                            } else if let Some(ref uri) = dep.uri {
                                // Add external URI nodes
                                let ext_idx = graph.add_node(format!("{} (External: {})", dep.name, uri));
                                graph.add_edge(from_idx, ext_idx, "calls_external");
                            }
                        }
                    }
                }

                println!("{}", Dot::with_config(&graph, &[Config::EdgeNoLabel]));
                println!("\n  {} Paste this DOT output into Graphviz or WebGraphviz to visualize the architecture.\n", "↳".dimmed());
            } else {
                println!("{} No semantic history found.", "✗".red());
            }
        }
        Commands::Mcp => {
            McpServer::serve();
        }
        Commands::Snapshot { description } => {
            println!("{} {} {}", "📸".bold(), "Aura Hybrid Engine: Creating Safety Snapshot...".bold().cyan(), description.italic().dimmed());
            let timestamp = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
            let branch_name = format!("aura/snapshot/{}", timestamp);
            
            use std::process::Command;
            
            // Stash current changes to preserve uncommitted work
            let stash_status = Command::new("git").arg("stash").arg("create").output()?;
            let stash_hash = String::from_utf8_lossy(&stash_status.stdout).trim().to_string();

            // Create the hidden snapshot branch
            Command::new("git").args(["branch", &branch_name]).output()?;

            println!("{} Project-wide snapshot created: {}", "✓".green().bold(), branch_name.yellow());
            if !stash_hash.is_empty() {
                println!("  {} Uncommitted work preserved in stash hash: {}", "↳".dimmed(), stash_hash.dimmed());
            }
            println!("  {} If the AI hallucinated, run: {} {}", "↳".dimmed(), "aura restore".cyan(), timestamp.to_string().cyan());
        }
        Commands::Restore { snapshot_id } => {
            let branch_name = format!("aura/snapshot/{}", snapshot_id);
            println!("{} {} {}", "⏪".bold(), "Aura Hybrid Engine: Sledgehammer Restore to".bold().red(), branch_name.yellow());

            use std::process::Command;

            let status = Command::new("git").args(["reset", "--hard", &branch_name]).output()?;
            if status.status.success() {
                println!("{} Project fully restored to safety snapshot.", "✓".green().bold());
                println!("  {} (Note: Uncommitted work has been nuked)", "↳".dimmed());
            } else {
                println!("{} Failed to find snapshot {}.", "✗".red(), snapshot_id);
            }
        }
        Commands::SnapshotFile { paths, trigger, agent } => {
            // Bucket L1 — durable file-level snapshot. Wraps the same
            // `SnapshotStore::snapshot_file` the MCP tool + watcher
            // already use; this CLI surface lets aura-shell's Manager
            // dispatch path snapshot zones via process spawn (it
            // doesn't depend on the `aura` library directly).
            //
            // Missing files emit `skip:<path>` and exit 0 — pre-dispatch
            // zone globs may include not-yet-created files (the subagent's
            // job is to create them); skipping is the intended behaviour.
            let mut had_failure = false;
            for path in paths {
                if !std::path::Path::new(path).exists() {
                    println!("skip:{path}");
                    continue;
                }
                match checkpoint::SnapshotStore::snapshot_file(path, trigger, agent) {
                    Ok(snap_id) => println!("ok:{path}:{snap_id}"),
                    Err(e) => {
                        eprintln!("snapshot {path} failed: {e}");
                        had_failure = true;
                    }
                }
            }
            if had_failure {
                std::process::exit(2);
            }
        }
        Commands::GoalTrace { goal, json, at } => {
            match (at.as_deref(), *json) {
                (Some(sha), true) => crate::gsd::GsdEngine::prove_goal_json_at(goal, sha),
                (Some(sha), false) => crate::gsd::GsdEngine::prove_goal_at(goal, sha),
                (None, true) => crate::gsd::GsdEngine::prove_goal_json(goal),
                (None, false) => crate::gsd::GsdEngine::prove_goal(goal),
            }
        }
        Commands::VerifyEnv { target, pos_target } => {            let env_target = target.clone().unwrap_or_else(|| {
                pos_target.first().cloned().unwrap_or_else(|| "production".to_string())
            });

            println!("{} {} {}", "🛡️ ".bold(), "Aura Production Gatekeeper: Simulating Deployment to".bold().cyan(), env_target.bold().yellow());
            
            // 1. Load the mock environment constraint file
            let constraint_file = format!("{}.aura.json", env_target);
            let schema_content = match fs::read_to_string(&constraint_file) {
                Ok(c) => c,
                Err(_) => {
                    println!("{} No constraint schema found at {}. Deployment allowed.", "✓".green(), constraint_file);
                    return Ok(());
                }
            };

            let schema: serde_json::Value = serde_json::from_str(&schema_content)?;
            let forbidden = schema["forbidden_dependencies"].as_array().unwrap_or(&vec![]).iter()
                                .filter_map(|v| v.as_str()).map(|s| s.to_string()).collect::<Vec<String>>();

            // 2. Parse the AST of the current project
            let repo = open_repo()?;
            let mut parser = SemanticParser::new()?;
            let index = repo.index()?;
            let mut all_ast_nodes = Vec::new();

            for entry in index.iter() {
                let path_str = String::from_utf8_lossy(&entry.path).to_string();

                // Skip build artifacts, dependencies, and generated files
                if path_str.contains("node_modules/") || path_str.contains(".next/")
                    || path_str.contains("target/") || path_str.contains("dist/")
                    || path_str.contains("build/") || path_str.contains(".cache/")
                    || path_str.contains("__pycache__/") || path_str.contains(".aura/")
                    || path_str.contains(".git/") || path_str.contains("vendor/")
                    || path_str.contains(".turbo/") || path_str.contains(".vercel/")
                    || path_str.contains("coverage/") || path_str.contains(".output/") {
                    continue;
                }

                let ext = detect_lang_ext(&path_str); if ext.is_empty() { continue }; let ext = ext.as_str();

                if let Ok(source_code) = fs::read_to_string(&path_str) {
                    if let Ok(ast_nodes) = parser.parse_file(&source_code, ext) {
                        all_ast_nodes.extend(ast_nodes);
                    }
                }
            }

            // 3. Project the AST against the target schema
            let mut violations = Vec::new();
            for node in &all_ast_nodes {
                for dep in &node.dependencies {
                    // Deep AST Traversal: Check explicit mathematical dependencies (calls/imports)
                    // against the forbidden list. This ignores comments and strings automatically.
                    for forbidden_word in &forbidden {
                        if dep.name.contains(forbidden_word) {
                            violations.push((node.identifier.clone().unwrap_or_else(|| "Unknown Function".to_string()), dep.name.clone()));
                        }
                    }
                }
            }

            if !violations.is_empty() {
                let config = ConfigManager::load();
                if config.strict_gatekeeper_mode {
                    println!("{} Deployment Gatekeeper: Violation detected in Strict Mode. Commit blocked.", "🚨".red().bold());
                    for (func, dep) in &violations {
                        println!("  {} {} calls forbidden dependency: {}", "↳".dimmed(), func.yellow(), dep.red());
                    }
                    if ConfigManager::is_strict_mode_locked(&config) {
                        println!("  {} Strict mode is passcode-locked (human must unlock from terminal).", "💡".blue());
                    } else {
                        println!("  {} To allow these changes, set `strict_gatekeeper_mode: false` with `aura config set strict-mode false`", "💡".blue());
                    }
                    std::process::exit(1);
                } else {
                    println!("{} Deployment Gatekeeper: The AI logic contains forbidden calls for production.", "⚠️".yellow().bold());
                    for (func, dep) in &violations {
                        println!("  {} {} calls forbidden dependency: {}", "↳".dimmed(), func.yellow(), dep.red());
                    }
                    println!("  {} This is a policy warning. The commit will proceed.", "↳".dimmed().italic());
                }
            } else {
                println!("{} AST logic perfectly conforms to {} constraints. Safe to deploy.", "✓".green().bold(), env_target);
            }
        }
        Commands::SuggestMerge { file_path } => {
            Arbitrator::resolve_conflict(file_path);
        }
        Commands::GenerateStubs => {
            StubEngine::generate_stubs();
        }
        Commands::Gc => {
            println!("{} {}", "🧹".bold(), "Aura Semantic Compaction: Analyzing history...".bold().cyan());
            let repo = open_repo()?;
            match CheckpointStore::compact_history(&repo, 50) {
                Ok(count) => {
                    if count > 0 {
                        println!("{} Garbage Collection Complete.", "✓".green().bold());
                        println!("  {} Pruned {} implicit micro-checkpoints.", "↳".dimmed(), count.to_string().yellow());
                        println!("  {} Repository size optimized.", "↳".dimmed());
                    } else {
                        println!("{} Repository is already clean. No pruneable nodes found.", "✓".green().bold());
                    }
                },
                Err(e) => println!("{} GC Failed: {}", "✗".red(), e),
            }
        }
        Commands::Plan { prompt } => {
            gsd::GsdEngine::plan_milestone(prompt);
            let config = crate::config::ConfigManager::load();
            if config.sync_enabled && config.cloud_api_token.is_some() {
                let plan_path = ".aura/plans/ACTIVE_MILESTONE.xml";
                let waves = std::fs::read_to_string(plan_path)
                    .map(|s| serde_json::json!({ "xml": s }))
                    .unwrap_or_else(|_| serde_json::json!([]));
                let repo_full = git2::Repository::open(".").ok()
                    .and_then(|r| r.find_remote("origin").ok().and_then(|rem| rem.url().map(String::from)));
                crate::sync::GlobalSync::push_plan(prompt, waves, "active", repo_full.as_deref());
            }
        }
        Commands::Execute => {
            gsd::GsdEngine::execute_wave();
        }
        Commands::Status => {
            println!("\n{} {}", "🔍".bold(), "Aura Semantic Status".bold().cyan());
            let config = ConfigManager::load();
            println!("  {} {}: {}", "⚙️ ".cyan(), "Gatekeeper Strict Mode".bold(), if config.strict_gatekeeper_mode { "ON (Blocking)".red() } else { "OFF (Warn-Only)".green() });
            println!("  {} {}: {}", "⚡".yellow(), "Dev Mode (Fast Init)".bold(), if config.dev_mode { "Active".green() } else { "Inactive (Enterprise)".dimmed() });

            match Repository::open(".") {
                Ok(repo) => {
                    match CheckpointStore::latest_checkpoint(&repo) {
                        Ok(checkpoint) => {
                            if let Some(latest) = checkpoint {
                                println!("  {} {}: {}", "📍".blue(), "Latest Checkpoint".bold(), crate::text::clip(&latest.id, 8).to_string().cyan());
                                println!("  {} {}: {} logic nodes tracked", "🧠".magenta(), "Merkle-Graph Size".bold(), latest.ast_nodes.len().to_string().yellow());
                            } else {
                                println!("  {} {}", "ℹ️ ".blue(), "No semantic checkpoints found. Run `aura capture-context` or `git commit` to start tracking.".dimmed());
                            }
                        },
                        Err(_) => {
                            println!("  {} {}", "⚠️".yellow(), "Could not read semantic history.".dimmed());
                        }
                    }
                },
                Err(_) => {
                    println!("  {} {}", "✗".red(), "Not a Git repository.".bold());
                }
            }

            // Session & Turn-level tracking
            if let Some(session) = session::SessionManager::get_active_session() {
                println!("\n  {} {}", "📊".bold(), "Active Session".bold().cyan());
                println!("    {} Session: {}", "↳".dimmed(), session.session_id.cyan());
                println!("    {} Agent: {}", "↳".dimmed(), session.agent_id.green());

                let turns = session::SessionManager::turn_count(&session.session_id);
                println!("    {} Turns: {}", "↳".dimmed(), turns.to_string().yellow());

                let (sub_count, sub_types) = session::SessionManager::subagent_summary(&session.session_id);
                if sub_count > 0 {
                    println!("    {} Subagents: {} ({})", "↳".dimmed(),
                        sub_count.to_string().yellow(),
                        sub_types.join(", ").dimmed());
                }

                if let Some(ref usage) = session.token_usage {
                    println!("    {} Tokens: {} in / {} out ({} API calls)", "↳".dimmed(),
                        usage.input_tokens.to_string().yellow(),
                        usage.output_tokens.to_string().yellow(),
                        usage.api_call_count);
                    if usage.cache_read_tokens > 0 {
                        println!("    {} Cache: {} read / {} created", "↳".dimmed(),
                            usage.cache_read_tokens.to_string().dimmed(),
                            usage.cache_creation_tokens.to_string().dimmed());
                    }
                }

                // Cost estimate
                if let Some(cost) = plugins::cost_reporter::calculate_session_cost(Some(&session.session_id)) {
                    println!("    {} Cost: {}", "↳".dimmed(), cost.format_compact().yellow());
                }
            }

            // Plugin info
            let plugin_config = plugin::load_plugin_config();
            let registry = plugin::PluginRegistry::load_from_config(&plugin_config);
            if registry.count() > 0 {
                println!("\n  {} {} plugin(s) loaded:", "🔌".bold(), registry.count());
                for (name, version) in registry.list() {
                    println!("    {} {} v{}", "↳".dimmed(), name.cyan(), version);
                }
            }

            // OpenCode detection
            if let Some(info) = agents::opencode::detect_opencode() {
                println!("\n  {} OpenCode detected (via {})", "🔗".bold(), info.detection_method.cyan());
            }

            // Team & Mothership status
            {
                let config_t = ConfigManager::load();
                let current_repo = live_sync::repo_name_from_cwd();
                let is_team = config_t.team_repos.contains(&current_repo);
                let has_cloud = config_t.cloud_url.is_some() && (config_t.cloud_api_token.is_some() || std::env::var("AURA_CLOUD_TOKEN").is_ok());

                if has_cloud || is_team {
                    println!("\n  {} {}", "Team".bold(), "Collaboration".bold().cyan());
                    if is_team {
                        println!("  {} Repo: {} ({})", "•".dimmed(), current_repo.cyan(), "team-managed".green());
                    } else if !current_repo.is_empty() {
                        println!("  {} Repo: {} ({})", "•".dimmed(), current_repo.cyan(), "personal".yellow());
                    }
                    // Cached: everything above this line lands in ~5ms, and a
                    // live presence probe was measured at 1517ms of a 1550ms
                    // `aura status`. `aura live status` still measures.
                    live_sync::print_mothership_status_line_cached();
                }
            }

            // S1-SHN: signing-key health one-liner. Same single-source helper
            // as MCP aura_status.signing, MCP aura_doctor, CLI aura doctor,
            // CLI aura keys sigstore-status. Read-only — never mints a key.
            {
                let sh = manifest_sig::signing_health();
                match sh.get("status").and_then(|s| s.as_str()).unwrap_or("") {
                    "ok" => {
                        let key_id = sh.get("key_id").and_then(|s| s.as_str()).unwrap_or("");
                        println!(
                            "  {} {}: {} ({})",
                            "🔑".bold(),
                            "Signing Key".bold(),
                            "healthy".green(),
                            key_id.dimmed(),
                        );
                    }
                    "missing" => {
                        println!(
                            "  {} {}: {} ({})",
                            "🔑".bold(),
                            "Signing Key".bold(),
                            "not yet minted".dimmed(),
                            "next sign-bearing op auto-creates".dimmed(),
                        );
                    }
                    "unreadable" => {
                        let err = sh.get("error").and_then(|s| s.as_str()).unwrap_or("?");
                        println!(
                            "  {} {}: {} — {}",
                            "🔑".bold(),
                            "Signing Key".bold(),
                            "UNREADABLE".red().bold(),
                            err.yellow(),
                        );
                    }
                    "no_path" => {
                        println!(
                            "  {} {}: {}",
                            "🔑".bold(),
                            "Signing Key".bold(),
                            "PATH UNRESOLVED — set $HOME".red().bold(),
                        );
                    }
                    _ => {}
                }
            }

            println!();
        }
        Commands::Ci { cmd } => {
            // Semantic CI — gather facts here, run the aura-ci pipeline engine.
            // The handlers return a process exit code: non-zero when a blocking
            // step failed, so a git hook / CI job fails the build.
            let code = match cmd {
                CiCmd::Run { trigger, base, json } => ci::cmd_run(trigger, base, *json),
                CiCmd::List { json } => ci::cmd_list(*json),
                CiCmd::Status => ci::cmd_status(),
                CiCmd::Export { out } => ci::cmd_export(out),
            };
            if code != 0 {
                std::process::exit(code);
            }
        }
        Commands::Audit => {
            println!("\n{} {}", "🕵️ ".bold(), "Aura Semantic Audit: Scanning Git History for Bypasses...".bold().magenta());
            
            let repo = match Repository::open(".") {
                Ok(r) => r,
                Err(_) => {
                    println!("{} Not a valid Git repository.", "✗".red());
                    return Ok(());
                }
            };

            let mut revwalk = repo.revwalk()?;
            revwalk.push_head()?;
            
            let mut total_scanned = 0;
            let mut bypass_count = 0;

            for oid in revwalk.take(50) { // Scan last 50 commits for performance
                let oid = oid?;
                let commit = repo.find_commit(oid)?;
                total_scanned += 1;

                if let Some(message) = commit.message() {
                    // Check if this commit was made by Aura itself (the Continuous Tracker)
                    let is_daemon = message.contains("[Aura Daemon]");
                    
                    // Check for the cryptographically verified trailer
                    let has_trailer = message.contains("Aura-Checkpoint:");

                    if !is_daemon && !has_trailer {
                        bypass_count += 1;
                        let author = commit.author();
                        let author_name = author.name().unwrap_or("Unknown");
                        let short_id = &oid.to_string()[0..7];
                        let title = message.lines().next().unwrap_or("No commit message");

                        if bypass_count == 1 {
                            println!("{} {}", "🚨".red().bold(), "UNVERIFIED COMMITS DETECTED".red().bold().underline());
                            println!("  These commits bypassed the Aura Gatekeeper (`--no-verify`) and lack a semantic graph:\n");
                        }
                        println!("  {} {} by {} - \"{}\"", "✗".red(), short_id.yellow(), author_name.cyan(), title.dimmed());
                    }
                }
            }

            if bypass_count == 0 {
                println!("{} Verified {} commits. 100% Semantic Sovereignty achieved. No bypasses detected.", "✓".green().bold(), total_scanned.to_string().cyan());
            } else {
                println!("\n{} Found {} unverified commits out of the last {}.", "⚠️".yellow().bold(), bypass_count.to_string().red(), total_scanned.to_string().cyan());
                println!("  {} Action Required: Run `aura snapshot \"Pre-Audit\"` to secure the baseline before proceeding.", "↳".dimmed());
            }
        }
        Commands::Explain { identifier, file } => {
            println!("\n{} {}\n", "🔍".bold(), "Aura Explain: Tracing code provenance...".bold().cyan());

            match session::SessionManager::explain_code(&file, &identifier) {
                Some((sess, transcript)) => {
                    println!("  {} {}: {}", "Agent".bold(), sess.agent_id.cyan(), sess.session_id.dimmed());
                    if let Some(ref bc) = sess.base_commit {
                        println!("  {} Commit: {}", "↳".dimmed(), bc.yellow());
                    }
                    println!("  {} Files touched: {}", "↳".dimmed(), sess.files_touched.join(", ").dimmed());
                    println!("  {} Checkpoints: {}\n", "↳".dimmed(), sess.checkpoint_count);

                    if transcript.is_empty() {
                        println!("  {} No conversation transcript found for this session.", "⚠️".yellow());
                        println!("  {} The code was tracked via checkpoint but the full conversation was not captured.", "↳".dimmed());
                    } else {
                        println!("  {} Conversation transcript ({} entries):\n", "💬".bold(), transcript.len());
                        for entry in transcript.iter().take(20) {
                            let role_label = match entry.role.as_str() {
                                "user" => "  YOU".green().bold().to_string(),
                                "assistant" => "  AI ".blue().bold().to_string(),
                                "intent" => "  INTENT".cyan().bold().to_string(),
                                _ => format!("  {}", entry.role.to_uppercase()),
                            };
                            let content = if entry.content.len() > 300 {
                                format!("{}...", &entry.content[..300])
                            } else {
                                entry.content.clone()
                            };
                            println!("  {} {}", role_label, content);
                        }
                        if transcript.len() > 20 {
                            println!("\n  {} ... and {} more entries", "↳".dimmed(), transcript.len() - 20);
                        }
                    }
                }
                None => {
                    println!("  {} Could not trace '{}' in '{}'.", "⚠️".yellow(), identifier.cyan(), file.dimmed());
                    println!("  {} Possible reasons:", "↳".dimmed());
                    println!("    - The code was written before Aura was initialized");
                    println!("    - The file is not tracked by git");
                    println!("    - No checkpoint exists for the commit that introduced this code");
                    println!("\n  {} Try: {}", "💡".blue(), format!("git log -S \"{}\" --oneline {}", identifier, file).cyan());
                }
            }
        }
        Commands::Subagent { cmd } => {
            let code = match cmd {
                SubagentCmd::Spawn { provider, prompt, zones, depends_on, a2a_task_id } => {
                    subagent::spawn(&provider, &prompt, &zones, &depends_on, a2a_task_id.as_deref())
                }
                SubagentCmd::SpawnBg { provider, prompt, zones, depends_on, a2a_task_id } => {
                    subagent::spawn_bg(&provider, &prompt, &zones, &depends_on, a2a_task_id.as_deref())
                }
                SubagentCmd::Wait { task_id, timeout } => subagent::wait(*task_id, *timeout),
                SubagentCmd::RunDetached { task_id, provider, prompt } => {
                    subagent::run_detached(*task_id, provider, prompt)
                }
                SubagentCmd::List => subagent::list(),
                SubagentCmd::Monitor { session_id, task_id, tail } => {
                    subagent::monitor(&session_id, *task_id, *tail)
                }
            };
            std::process::exit(code);
        }
        Commands::AskUser { question, kind, options } => {
            let code = ask_user::run(&question, &kind, options.as_deref());
            std::process::exit(code);
        }
        Commands::ProposePlan { json, file, title, summary, todos } => {
            let code = propose_plan::run(
                json.as_deref(),
                file.as_deref(),
                title.as_deref(),
                summary.as_deref(),
                &todos,
            );
            std::process::exit(code);
        }
        Commands::Sessions => {
            println!("\n{} {}\n", a11y_label("📋", "SESSIONS"), "Aura Agent Sessions".bold().cyan());

            // Auto-cleanup stale sessions (>7 days old, ended)
            let cleaned = session::SessionManager::cleanup_stale(7);
            if cleaned > 0 {
                println!("  {} Cleaned up {} stale sessions.\n", "🧹".dimmed(), cleaned);
            }

            let sessions = session::SessionManager::list_sessions();
            if sessions.is_empty() {
                println!("  {} No sessions recorded yet.", "↳".dimmed());
                println!("  {} Sessions are created when AI agents work in this repository.", "↳".dimmed());
            } else {
                for sess in sessions.iter().take(20) {
                    let phase_str = match sess.phase {
                        session::SessionPhase::Active => "ACTIVE".green().bold().to_string(),
                        session::SessionPhase::Idle => "IDLE".yellow().to_string(),
                        session::SessionPhase::Ended => "ENDED".dimmed().to_string(),
                    };
                    let branch_str = sess.branch.as_deref().unwrap_or("?");
                    let model_str = sess.model_name.as_deref().unwrap_or("");
                    let token_str = if let Some(ref usage) = sess.token_usage {
                        if usage.total() > 0 {
                            format!(" | {}k tokens", usage.total() / 1000)
                        } else {
                            String::new()
                        }
                    } else {
                        String::new()
                    };

                    println!("  {} {} [{}] — {} on {} ({} files, {} checkpoints{})",
                        "●".cyan(),
                        sess.session_id.bold(),
                        phase_str,
                        sess.agent_id.cyan(),
                        branch_str.yellow(),
                        sess.files_touched.len(),
                        sess.checkpoint_count,
                        token_str.dimmed(),
                    );
                    if !model_str.is_empty() {
                        println!("    {} model: {}", "↳".dimmed(), model_str.dimmed());
                    }
                    if let Some(ref prompt) = sess.first_prompt {
                        let display = if prompt.len() > 80 { &prompt[..80] } else { prompt };
                        println!("    {} prompt: \"{}\"", "↳".dimmed(), display.italic().dimmed());
                    }
                    if let Some(ref summary) = sess.summary {
                        println!("    {} {}", "↳".dimmed(), summary.outcome.dimmed());
                    }
                    if !sess.subagents.is_empty() {
                        println!("    {} subagents: {}", "↳".dimmed(),
                            sess.subagents.iter()
                                .map(|s| format!("{}({})", s.agent_type, if s.ended_at.is_some() { "done" } else { "running" }))
                                .collect::<Vec<_>>()
                                .join(", ")
                                .dimmed()
                        );
                    }
                }
            }
        }
        Commands::Resume { branch: Some(branch), .. } => {
            println!("\n{} {}\n", "🔄".bold(), format!("Resuming work on branch: {}", branch).bold().cyan());

            // Check for uncommitted changes
            let repo = open_repo()?;
            let statuses = repo.statuses(None)?;
            let dirty = statuses.iter().any(|s| {
                s.status() != git2::Status::CURRENT && s.status() != git2::Status::IGNORED
            });
            if dirty {
                println!("  {} You have uncommitted changes. Commit or stash them first.", "⚠".yellow().bold());
                println!("  {} Run: {} or {}", "↳".dimmed(), "git stash".cyan(), "git commit".cyan());
                return Ok(());
            }

            // Switch branch
            let current_branch = repo.head()
                .ok()
                .and_then(|h| h.shorthand().map(|s| s.to_string()));

            if current_branch.as_deref() != Some(&branch) {
                println!("  {} Switching to branch {}...", "↳".dimmed(), branch.cyan());
                let obj = repo.revparse_single(&format!("refs/heads/{}", branch))
                    .map_err(|_| format!("Branch '{}' not found. Check with: git branch -a", branch))?;
                repo.checkout_tree(&obj, None)?;
                repo.set_head(&format!("refs/heads/{}", branch))?;
                println!("  {} Switched to {}", "✓".green().bold(), branch.cyan());
            }

            // Check for squash-merge history
            if let Some(merge_msg) = session::SessionManager::detect_squash_merge(&branch) {
                let first_line = merge_msg.lines().next().unwrap_or("(no message)");
                println!("  {} Branch '{}' was previously squash-merged:", "ℹ".blue().bold(), branch.cyan());
                println!("    {} \"{}\"", "↳".dimmed(), first_line.dimmed());
                println!("    {} This session will be linked to the previous merge.\n", "↳".dimmed());
            }

            // Find sessions on this branch
            let sessions = session::SessionManager::resume_branch(&branch);
            if sessions.is_empty() {
                println!("\n  {} No previous sessions found on this branch.", "↳".dimmed());
                println!("  {} Starting fresh. Use your AI agent normally — Aura will track it.", "↳".dimmed());
            } else {
                println!("\n  {} Found {} previous session(s) on this branch:\n", "📋".bold(), sessions.len());
                for sess in &sessions {
                    let agent = &sess.agent_id;
                    let prompt = sess.first_prompt.as_deref().unwrap_or("(no prompt recorded)");
                    let files = sess.files_touched.len();
                    let checkpoints = sess.checkpoint_count;

                    println!("    {} {} — {} ({} files, {} checkpoints)",
                        "●".cyan(), sess.session_id.bold(), agent.cyan(), files, checkpoints);
                    println!("      {} \"{}\"", "↳".dimmed(), prompt.italic());

                    if let Some(ref summary) = sess.summary {
                        println!("      {} Intent: {}", "↳".dimmed(), summary.intent);
                        println!("      {} Outcome: {}", "↳".dimmed(), summary.outcome);
                        if !summary.open_items.is_empty() {
                            println!("      {} Open items:", "↳".dimmed());
                            for item in &summary.open_items {
                                println!("        - {}", item);
                            }
                        }
                    }
                    println!();
                }

                // Generate handover context from the last session
                let last = &sessions[0];
                let transcript = session::SessionManager::condense_transcript(&last.session_id);
                if !transcript.is_empty() {
                    println!("  {} Last session context (condensed):\n", "📝".bold());
                    for line in transcript.lines().take(15) {
                        println!("    {}", line.dimmed());
                    }
                    if transcript.lines().count() > 15 {
                        println!("    {} ... ({} more lines)", "↳".dimmed(), transcript.lines().count() - 15);
                    }
                }
            }
        }
        Commands::Resume { branch: None, keep } => {
            // WW-A2 — consume an injected cross-agent carryover. The
            // previous brain ran `aura carryover --inject --agent <name>`,
            // writing an AURA:RESUME block into this repo's context file;
            // here the resuming brain pulls it out and (by default) clears
            // it so the one-shot handoff never lingers and re-triggers.
            let repo_root = std::env::current_dir()?;
            let blocks = continuity::render::find_resume_blocks(&repo_root);
            let basename = |p: &str| {
                std::path::Path::new(p)
                    .file_name()
                    .and_then(|f| f.to_str())
                    .unwrap_or(p)
                    .to_string()
            };

            if blocks.is_empty() {
                println!("\n{} No injected carryover found in this repo.", "↳".dimmed());
                println!(
                    "  {} A previous brain leaves one with: {}",
                    "↳".dimmed(),
                    "aura carryover --inject --agent <name>".cyan()
                );
                println!(
                    "  {} Or resume a branch's session with: {}",
                    "↳".dimmed(),
                    "aura resume <branch>".cyan()
                );
                return Ok(());
            }

            let block = &blocks[0];
            let file = basename(&block.path);
            println!(
                "\n{} {}\n",
                "🔄".bold(),
                format!("Resuming carryover injected for {}", block.agent).bold().cyan()
            );
            if blocks.len() > 1 {
                println!(
                    "  {} {} context files carry a carryover; using the freshest ({}).\n",
                    "ℹ".blue().bold(),
                    blocks.len(),
                    file.cyan()
                );
            }

            // Surface the carryover so the resuming brain (and the user)
            // reads the exact handoff state.
            println!("{}", block.body);

            if *keep {
                println!(
                    "\n{} Left the AURA:RESUME block in {} (--keep).",
                    "✓".green().bold(),
                    file.cyan()
                );
            } else {
                match continuity::render::consume(std::path::Path::new(&block.path)) {
                    Ok(_) => println!(
                        "\n{} Consumed — cleared the carryover from {} so it won't re-trigger.",
                        "✓".green().bold(),
                        file.cyan()
                    ),
                    Err(e) => eprintln!("warn: could not clear carryover from {file}: {e}"),
                }
            }
        }
        Commands::Carryover { repo, mode, agent, since_hours, json, inject, no_redact } => {
            continuity::run_carryover(repo, mode, agent.clone(), *since_hours, *json, *inject, *no_redact)?;
        }
        Commands::Doctor { json } => {
            // Read-only structured report path (opt-in). JSON mode is a
            // pure probe: it computes the same checks the text path does
            // but performs NONE of the side-effects (no force-end of
            // stuck sessions, no snapshot prune, no stale cleanup, no
            // replay-orphan removal). Powers the desktop shell's
            // `/doctor` slash card via `aura_doctor_json`.
            if *json {
                let report = doctor::collect_report()?;
                println!("{}", serde_json::to_string_pretty(&report)?);
                return Ok(());
            }

            println!("\n{} {}\n", a11y_label("🩺", "DOCTOR"), "Aura Doctor: Diagnosing repository health...".bold().cyan());

            let mut issues_found = 0;

            // 1. Check for stuck sessions
            let stuck = session::SessionManager::find_stuck_sessions();
            if stuck.is_empty() {
                println!("  {} No stuck sessions found.", "✓".green().bold());
            } else {
                println!("  {} Found {} stuck session(s):\n", "⚠".yellow().bold(), stuck.len());
                for (sess, reason) in &stuck {
                    println!("    {} {} — {}", "●".red(), sess.session_id.bold(), reason.yellow());
                    println!("      {} Agent: {}, Files: {}", "↳".dimmed(), sess.agent_id, sess.files_touched.len());
                    issues_found += 1;
                }

                let fix = dialoguer::Confirm::with_theme(&ColorfulTheme::default())
                    .with_prompt("  Force-end all stuck sessions?")
                    .default(true)
                    .interact()
                    .unwrap_or(false);

                if fix {
                    for (sess, _) in &stuck {
                        session::SessionManager::force_end_session(&sess.session_id);
                        println!("    {} Ended session {}", "✓".green(), sess.session_id);
                    }
                }
            }

            // 2. Check for orphaned snapshots (files that no longer exist)
            let snapshots = checkpoint::SnapshotStore::get_all_snapshots();
            let mut orphaned = 0;
            for snap in &snapshots {
                if !Path::new(&snap.file_path).exists() {
                    orphaned += 1;
                }
            }
            if orphaned > 0 {
                println!("\n  {} {} orphaned snapshots (files no longer exist).", "⚠".yellow().bold(), orphaned);
                issues_found += orphaned;
            } else {
                println!("  {} No orphaned snapshots.", "✓".green().bold());
            }

            // 3. Check snapshot disk usage
            let snap_count = snapshots.len();
            let snap_bytes: u64 = snapshots.iter()
                .map(|s| s.content.len() as u64 + 200) // ~200 bytes metadata overhead
                .sum();
            println!("  {} {} snapshots using ~{} KB on disk.",
                if snap_count > 400 { "⚠".yellow().bold() } else { "✓".green().bold() },
                snap_count,
                snap_bytes / 1024
            );
            if snap_count > 400 {
                println!("    {} Consider running global prune.", "↳".dimmed());
                checkpoint::SnapshotStore::prune_global();
                println!("    {} Pruned to {} snapshots.", "✓".green(), checkpoint::SnapshotStore::get_all_snapshots().len());
            }

            // 4. Check git hooks are installed. Ask git for the hooks directory
            // rather than assuming `.git/hooks` — a linked worktree keeps a
            // `.git` file, and `core.hooksPath` moves hooks elsewhere. Guessing
            // made doctor say "not installed" in every worktree no matter how
            // many times the suggested fix was run.
            let hooks_ok = HookInstaller::hooks_dir().join("pre-commit").exists();
            if hooks_ok {
                println!("  {} Git hooks installed.", "✓".green().bold());
            } else {
                println!("  {} Git hooks not installed. Run {} to fix.", "⚠".yellow().bold(), "aura init".cyan());
                issues_found += 1;
            }

            // 5. Check shadow branch health
            let repo = open_repo()?;
            let shadow_ok = repo.find_reference("refs/heads/aura/checkpoints").is_ok();
            if shadow_ok {
                let shadow_cps = CheckpointStore::get_shadow_checkpoints(&repo).unwrap_or_default();
                println!("  {} Shadow branch healthy ({} checkpoints archived).", "✓".green().bold(), shadow_cps.len());
            } else {
                println!("  {} Shadow branch not yet created (will be created on first commit).", "ℹ".blue());
            }

            // 6. Stale session cleanup
            let cleaned = session::SessionManager::cleanup_stale(7);
            if cleaned > 0 {
                println!("  {} Cleaned {} stale sessions (>7 days old).", "🧹".green(), cleaned);
            }

            // 7. Cost summary for active session
            if let Some(cost) = plugins::cost_reporter::calculate_session_cost(None) {
                println!("  {} Active session cost: {}", "💰".green(), cost.format_compact());
            }

            // 8. Plugin status
            let plugin_config = plugin::load_plugin_config();
            let registry = plugin::PluginRegistry::load_from_config(&plugin_config);
            println!("  {} {} plugin(s) loaded.", "✓".green().bold(), registry.count());

            // 9. Status line health check
            {
                let home = std::env::var("HOME").unwrap_or_default();
                let script_path = format!("{}/.claude/aura-statusline.sh", home);
                let settings_path = format!("{}/.claude/settings.json", home);

                let script_exists = Path::new(&script_path).exists();
                let script_executable = script_exists && {
                    #[cfg(unix)]
                    { std::os::unix::fs::PermissionsExt::mode(&fs::metadata(&script_path).unwrap().permissions()) & 0o111 != 0 }
                    #[cfg(not(unix))]
                    { true }
                };

                let (settings_ok, current_cmd) = if let Ok(content) = fs::read_to_string(&settings_path) {
                    if let Ok(settings) = serde_json::from_str::<serde_json::Value>(&content) {
                        let cmd = settings.get("statusLine")
                            .and_then(|s| s.get("command"))
                            .and_then(|c| c.as_str())
                            .unwrap_or("")
                            .to_string();
                        (!cmd.is_empty(), cmd)
                    } else { (false, String::new()) }
                } else { (false, String::new()) };

                let points_to_aura = current_cmd.contains("aura-statusline");
                let jq_installed = std::process::Command::new("jq").arg("--version").output().is_ok();

                if script_exists && script_executable && points_to_aura && jq_installed {
                    println!("  {} Claude Code status line: healthy", "✓".green().bold());
                } else {
                    println!("  {} Claude Code status line: issues detected", "⚠".yellow().bold());
                    if !script_exists {
                        println!("    {} Script missing: {}", "✗".red(), script_path.dimmed());
                        println!("      Fix: run {} to install", "aura init".cyan());
                        issues_found += 1;
                    } else if !script_executable {
                        println!("    {} Script not executable: {}", "✗".red(), script_path.dimmed());
                        println!("      Fix: {}", format!("chmod +x {}", script_path).cyan());
                        issues_found += 1;
                    }
                    if !settings_ok {
                        println!("    {} ~/.claude/settings.json missing or has no statusLine", "✗".red());
                        println!("      Fix: run {} to install", "aura init".cyan());
                        issues_found += 1;
                    } else if !points_to_aura {
                        println!("    {} statusLine points to: {}", "⚠".yellow(), current_cmd.dimmed());
                        println!("      Fix: run {} to switch to Aura's status line", "aura init".cyan());
                        issues_found += 1;
                    }
                    if !jq_installed {
                        println!("    {} jq not found — required for status line", "✗".red());
                        println!("      Fix: {}", "brew install jq".cyan());
                        issues_found += 1;
                    }
                }
            }

            // ────────────────────────────────────────────────
            // Check 10: signing-key health (S1-SHD)
            // ────────────────────────────────────────────────
            // Reads `manifest_sig::signing_health` — the same read-only
            // probe the MCP `aura_status.signing` block and `aura keys
            // sigstore-status` CLI use. Doctor never mints a key as a
            // side-effect (load_signing_key, NOT load_or_create). `missing`
            // is informational, not an error — first sign-bearing op
            // auto-mints.
            println!("\n  {} Signing key", "▸".cyan().bold());
            let sh = manifest_sig::signing_health();
            let sh_status = sh.get("status").and_then(|s| s.as_str()).unwrap_or("");
            let sh_path = sh.get("key_path").and_then(|s| s.as_str()).unwrap_or("");
            match sh_status {
                "ok" => {
                    let key_id = sh.get("key_id").and_then(|s| s.as_str()).unwrap_or("");
                    println!(
                        "  {} Signing key healthy ({})",
                        "✓".green().bold(),
                        key_id.dimmed(),
                    );
                }
                "missing" => {
                    println!(
                        "  {} No signing key on disk yet ({})",
                        "ℹ".blue(),
                        sh_path.dimmed(),
                    );
                    println!(
                        "    {} First {} or manifest sign will mint one automatically.",
                        "↳".dimmed(),
                        "aura_log_intent".cyan(),
                    );
                }
                "unreadable" => {
                    let err = sh.get("error").and_then(|s| s.as_str()).unwrap_or("?");
                    println!(
                        "  {} Signing key unreadable at {}: {}",
                        "✗".red().bold(),
                        sh_path.dimmed(),
                        err.yellow(),
                    );
                    println!(
                        "    {} Inspect permissions or rotate via {}",
                        "↳".dimmed(),
                        "aura keys sigstore-rotate".cyan(),
                    );
                    issues_found += 1;
                }
                "no_path" => {
                    let err = sh.get("error").and_then(|s| s.as_str()).unwrap_or("?");
                    println!(
                        "  {} Signing key path unresolved: {}",
                        "✗".red().bold(),
                        err.dimmed(),
                    );
                    println!("    {} Set $HOME or pass --key-path to sign-bearing commands.", "↳".dimmed());
                    issues_found += 1;
                }
                other => {
                    println!(
                        "  {} Signing key: unexpected status '{}' from signing_health",
                        "✗".red().bold(),
                        other.dimmed(),
                    );
                    issues_found += 1;
                }
            }

            // ────────────────────────────────────────────────
            // Check 11: cloud rotation-chain drift (S1-CS-D)
            // ────────────────────────────────────────────────
            // Compares the local rotation-block set under .aura/blocks/
            // against the cloud's rotation mirror. Drift = a teammate
            // pushed a rotation we haven't pulled, or a local rotation
            // hasn't reached the cloud. Read-only — never mutates disk.
            println!("\n  {} Cloud rotation-chain", "▸".cyan().bold());
            let drift = intent_block::cloud_rotation_chain_drift("MCP Agent");
            match drift.get("status").and_then(|s| s.as_str()) {
                Some("ok") => {
                    let local_count = drift.get("local_count").and_then(|x| x.as_u64()).unwrap_or(0);
                    let cloud_count = drift.get("cloud_count").and_then(|x| x.as_u64()).unwrap_or(0);
                    let local_only = drift.get("local_only").and_then(|x| x.as_array()).cloned().unwrap_or_default();
                    let cloud_only = drift.get("cloud_only").and_then(|x| x.as_array()).cloned().unwrap_or_default();
                    if local_only.is_empty() && cloud_only.is_empty() {
                        println!(
                            "  {} Cloud rotation chain in sync ({} local, {} cloud)",
                            "✓".green().bold(),
                            local_count,
                            cloud_count,
                        );
                    } else {
                        println!(
                            "  {} Cloud rotation chain drift detected",
                            "⚠".yellow().bold(),
                        );
                        if !cloud_only.is_empty() {
                            println!(
                                "    {} {} rotation(s) in cloud not pulled locally",
                                "✗".red(),
                                cloud_only.len(),
                            );
                            for id in cloud_only.iter().take(3) {
                                if let Some(s) = id.as_str() {
                                    println!("      • {}", s.dimmed());
                                }
                            }
                            if cloud_only.len() > 3 {
                                println!("      • … and {} more", cloud_only.len() - 3);
                            }
                            println!("      Fix: run {}", "aura keys sigstore-pull".cyan());
                            issues_found += 1;
                        }
                        if !local_only.is_empty() {
                            println!(
                                "    {} {} local rotation(s) not mirrored in cloud",
                                "⚠".yellow(),
                                local_only.len(),
                            );
                            for id in local_only.iter().take(3) {
                                if let Some(s) = id.as_str() {
                                    println!("      • {}", s.dimmed());
                                }
                            }
                            if local_only.len() > 3 {
                                println!("      • … and {} more", local_only.len() - 3);
                            }
                            println!(
                                "      Fix: re-rotate with {} (push retries on rotate)",
                                "aura keys sigstore-rotate".cyan(),
                            );
                            issues_found += 1;
                        }
                    }
                }
                Some("skipped") => {
                    let reason = drift.get("reason").and_then(|x| x.as_str()).unwrap_or("");
                    println!(
                        "  {} Cloud rotation chain: skipped ({})",
                        "○".dimmed(),
                        reason,
                    );
                }
                Some("error") => {
                    let err = drift.get("error").and_then(|x| x.as_str()).unwrap_or("?");
                    println!(
                        "  {} Cloud rotation chain: error — {}",
                        "✗".red(),
                        err,
                    );
                    issues_found += 1;
                }
                _ => {
                    println!(
                        "  {} Cloud rotation chain: unexpected response shape",
                        "✗".red(),
                    );
                    issues_found += 1;
                }
            }

            // ────────────────────────────────────────────────
            // Check 12: skill-ledger health (UU-W1)
            // ────────────────────────────────────────────────
            // Read-only probe of the local Agent Skill Ledger
            // (`~/.aura/agent_skills.json`, written by the shell's
            // `manager::skill`). Reports the dirty-flush backlog (rows
            // recorded locally but not yet POSTed to the cloud), whether
            // a stuck backlog can ever drain (cloud sign-in), and how
            // many taxonomy cells are still below the n≥10 auto-routing
            // threshold. Parsed as untyped JSON so the CLI stays
            // decoupled from the shell's struct definitions. Mirrors
            // entire's doctor mirror-staleness check.
            println!("\n  {} Skill ledger", "▸".cyan().bold());
            let ledger_path = {
                let home = std::env::var("HOME").unwrap_or_default();
                Path::new(&home).join(".aura").join("agent_skills.json")
            };
            match fs::read_to_string(&ledger_path) {
                Err(_) => {
                    println!(
                        "  {} No local skill ledger yet — routing falls back to the active brain until tasks accrue.",
                        "ℹ".blue(),
                    );
                }
                Ok(raw) => match skill_rank::ledger_health(&raw) {
                    None => {
                        println!(
                            "  {} Skill ledger file present but unreadable — routing falls back to the active brain.",
                            "ℹ".blue(),
                        );
                    }
                    Some(h) => {
                        // Dirty-flush backlog.
                        if h.dirty == 0 {
                            println!(
                                "  {} Ledger flushed — no rows pending cloud sync ({} recorded).",
                                "✓".green().bold(),
                                h.recorded,
                            );
                        } else {
                            println!(
                                "  {} {} outcome row(s) pending cloud flush.",
                                "⚠".yellow().bold(),
                                h.dirty,
                            );
                            if recall_cloud_creds().is_ok() {
                                println!(
                                    "    {} The app retries the flush every 30s; running a Manager task also triggers one.",
                                    "↳".dimmed(),
                                );
                            } else {
                                println!(
                                    "    {} Not signed in to cloud — the backlog can't drain. Fix: run {}",
                                    "✗".red(),
                                    "aura login".cyan(),
                                );
                                issues_found += 1;
                            }
                        }

                        // n<10 cells — locally observed sample counts per
                        // taxonomy cell. Informational: a young ledger is
                        // expected to have immature cells, so this never
                        // bumps `issues_found`.
                        if h.total_cells > 0 {
                            let mature = h.total_cells - h.immature_cells.len();
                            if h.immature_cells.is_empty() {
                                println!(
                                    "  {} All {} routing cell(s) have ≥{} samples — auto-routing fully active.",
                                    "✓".green().bold(),
                                    h.total_cells,
                                    skill_rank::MIN_SAMPLES,
                                );
                            } else {
                                println!(
                                    "  {} {} of {} routing cell(s) below the {}-sample threshold (won't auto-route yet):",
                                    "ℹ".blue(),
                                    h.immature_cells.len(),
                                    h.total_cells,
                                    skill_rank::MIN_SAMPLES,
                                );
                                for (cell, n) in h.immature_cells.iter().take(5) {
                                    println!(
                                        "    {} {} ({}/{})",
                                        "·".dimmed(),
                                        cell.dimmed(),
                                        n,
                                        skill_rank::MIN_SAMPLES,
                                    );
                                }
                                if h.immature_cells.len() > 5 {
                                    println!(
                                        "    {} … and {} more",
                                        "·".dimmed(),
                                        h.immature_cells.len() - 5,
                                    );
                                }
                                if mature > 0 {
                                    println!("    {} {} cell(s) already mature.", "↳".dimmed(), mature);
                                }
                            }
                        }
                    }
                },
            }

            // Check 13: orphaned Replay-Lab worktrees (UU-W3). Each
            // `aura replay` run isolates an agent in a temp worktree that
            // is removed on completion; a crash mid-run can leak one.
            // Folds entire's Checkpoints-v1.1 clean/orphan parity.
            println!("\n  {} Replay worktrees", "▸".cyan().bold());
            let replay_orphans = replay::worktree::list_orphans(Path::new("."));
            if replay_orphans.is_empty() {
                println!("  {} No orphaned replay worktrees.", "✓".green().bold());
            } else {
                println!(
                    "  {} {} orphaned replay worktree(s) left by an interrupted run:",
                    "⚠".yellow().bold(),
                    replay_orphans.len(),
                );
                for o in replay_orphans.iter().take(5) {
                    println!("    {} {} ({})", "·".dimmed(), o.branch.dimmed(), o.path);
                }
                let removed = replay::worktree::prune_orphans(Path::new("."));
                println!(
                    "    {} cleaned {} worktree(s).",
                    "↳".dimmed(),
                    removed.len()
                );
            }

            println!("\n  {} Doctor complete. {} issue(s) found.\n",
                if issues_found == 0 { "✓".green().bold() } else { "⚠".yellow().bold() },
                issues_found
            );
        }
        Commands::Completions { shell } => {
            use clap::CommandFactory;
            clap_complete::generate(
                *shell,
                &mut Cli::command(),
                "aura",
                &mut std::io::stdout(),
            );
        }
        Commands::Ui { binary, cwd } => {
            // Locate the aura-shell binary. Resolution order:
            //   1. --binary if explicitly passed
            //   2. PATH lookup
            //   3. Workspace fallback at aura-shell/src-tauri/target/release/
            //
            // The shell reads its working directory via std::env::current_dir
            // on launch, so we set the child's cwd to the requested project
            // root (or our own cwd as default) before spawning.
            use std::process::Command;

            // Best-effort PATH lookup without the `which` crate.
            fn find_in_path(name: &str) -> Option<std::path::PathBuf> {
                let path_var = std::env::var_os("PATH")?;
                for dir in std::env::split_paths(&path_var) {
                    let candidate = dir.join(name);
                    if candidate.is_file() {
                        return Some(candidate);
                    }
                }
                None
            }

            let resolved = if let Some(p) = binary {
                std::path::PathBuf::from(p)
            } else if let Some(p) = find_in_path("aura-shell") {
                p
            } else {
                // Walk up from the current cwd looking for the workspace root.
                let mut here = std::env::current_dir().unwrap_or_else(|_| ".".into());
                let mut found: Option<std::path::PathBuf> = None;
                for _ in 0..6 {
                    let candidate = here
                        .join("aura-shell/src-tauri/target/release/aura-shell");
                    if candidate.exists() {
                        found = Some(candidate);
                        break;
                    }
                    if !here.pop() {
                        break;
                    }
                }
                found.unwrap_or_else(|| {
                    eprintln!(
                        "{} aura-shell binary not found. Build it with:\n    cd aura-shell && bun install && bun run tauri build",
                        "⚠".yellow()
                    );
                    std::process::exit(1);
                })
            };

            let target_cwd = cwd
                .clone()
                .map(std::path::PathBuf::from)
                .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| ".".into()));

            println!(
                "{} Launching {} in {}",
                "▶".cyan(),
                resolved.display(),
                target_cwd.display()
            );

            let status = Command::new(&resolved)
                .current_dir(&target_cwd)
                .status();

            match status {
                Ok(s) if s.success() => {}
                Ok(s) => {
                    eprintln!("{} aura-shell exited with status {:?}", "⚠".yellow(), s.code());
                    std::process::exit(s.code().unwrap_or(1));
                }
                Err(e) => {
                    eprintln!("{} failed to spawn aura-shell: {}", "✗".red(), e);
                    std::process::exit(1);
                }
            }
        }
        Commands::RequestAccess { identifier } => {
            println!("\n{} {}", "🗝️ ".bold(), "Aura Access Protocol: Requesting Sentinel Override...".bold().cyan());
            let mut config = ConfigManager::load();
            
            if config.secret_allowlist.contains(&identifier) {
                println!("{} Node '{}' is already on the Sovereign Allowlist.", "✓".green(), identifier);
            } else {
                config.secret_allowlist.push(identifier.clone());
                ConfigManager::save(&config)?;
                println!("{} Access Granted. Node '{}' added to the Sovereign Allowlist.", "✓".green().bold(), identifier);
                println!("  {} The Semantic Sentinel will now ignore high-entropy patterns within this specific logic node.", "↳".dimmed());
            }
        }
        Commands::Config { sub } => {
            let mut config = ConfigManager::load();

            if let Some(subcommand) = sub {
                match subcommand {
                    ConfigSubcommands::Set { key, value } => {
                        match key.as_str() {
                            "strict-mode" => {
                                let want_enable: bool = value.parse().unwrap_or(false);
                                if want_enable {
                                    // Enabling strict mode — require interactive TTY for passcode
                                    if !ConfigManager::is_interactive_tty() {
                                        println!("{} Strict mode can only be enabled from an interactive terminal.", "✗".red().bold());
                                        return Ok(());
                                    }
                                    let passcode = Password::with_theme(&ColorfulTheme::default())
                                        .with_prompt("Set a passcode to lock strict mode (min 4 chars)")
                                        .with_confirmation("Confirm passcode", "Passcodes do not match")
                                        .interact()?;
                                    if passcode.len() < 4 {
                                        println!("{} Passcode must be at least 4 characters.", "✗".red().bold());
                                        return Ok(());
                                    }
                                    let salt = ConfigManager::generate_salt();
                                    let hash = ConfigManager::hash_passcode(&passcode, &salt);
                                    config.strict_gatekeeper_mode = true;
                                    config.strict_mode_passcode_hash = Some(hash);
                                    config.strict_mode_passcode_salt = Some(salt);
                                    println!("{} Strict mode ENABLED and LOCKED with passcode.", "✓".green().bold());
                                } else {
                                    // Disabling strict mode — enforce passcode if locked
                                    if ConfigManager::is_strict_mode_locked(&config) {
                                        if !ConfigManager::is_interactive_tty() {
                                            println!("{} Strict mode is passcode-locked. It can only be disabled from an interactive terminal.", "✗".red().bold());
                                            return Ok(());
                                        }
                                        if ConfigManager::is_ai_agent() {
                                            println!("{} Strict mode is passcode-locked. AI agents cannot disable it. A human must unlock from a terminal.", "✗".red().bold());
                                            return Ok(());
                                        }
                                        let attempt = Password::with_theme(&ColorfulTheme::default())
                                            .with_prompt("Enter passcode to unlock strict mode")
                                            .interact()?;
                                        if !ConfigManager::verify_passcode(&config, &attempt) {
                                            println!("{} Incorrect passcode. Strict mode remains locked.", "✗".red().bold());
                                            return Ok(());
                                        }
                                        config.strict_gatekeeper_mode = false;
                                        config.strict_mode_passcode_hash = None;
                                        config.strict_mode_passcode_salt = None;
                                        println!("{} Strict mode DISABLED and unlocked.", "✓".green().bold());
                                    } else {
                                        config.strict_gatekeeper_mode = false;
                                        println!("{} Strict mode set to false.", "✓".green().bold());
                                    }
                                }
                            },
                            "api-key" => {
                                config.gemini_api_key = Some(value.to_string());
                                println!("{} Gemini API Key updated.", "✓".green().bold());
                            },
                            "local-embeddings" => {
                                config.use_local_embeddings = value.parse().unwrap_or(false);
                                println!("{} Local embeddings set to {}.", "✓".green().bold(), config.use_local_embeddings);
                            },
                            "dev-mode" => {
                                config.dev_mode = value.parse().unwrap_or(false);
                                println!("{} Development Mode (Fast Init) set to {}.", "✓".green().bold(), config.dev_mode);
                            },
                            "telemetry" => {
                                config.telemetry_enabled = value.parse().unwrap_or(true);
                                println!("{} Anonymous Telemetry set to {}.", "✓".green().bold(), config.telemetry_enabled);
                            },
                            "cloud-token" => {
                                config.cloud_api_token = Some(value.to_string());
                                println!("{} Cloud API token updated.", "✓".green().bold());
                            },
                            "cloud-url" => {
                                config.cloud_url = Some(value.to_string());
                                println!("{} Cloud URL set to {}.", "✓".green().bold(), value);
                            },
                            _ => {
                                println!("{} Unknown configuration key: {}", "✗".red(), key);
                                return Ok(());
                            }
                        }
                        ConfigManager::save(&config)?;
                        return Ok(());
                    }
                    ConfigSubcommands::ResetPasscode { force } => {
                        if !ConfigManager::is_interactive_tty() {
                            println!("{} Passcode reset requires an interactive terminal.", "✗".red().bold());
                            return Ok(());
                        }
                        if !ConfigManager::is_strict_mode_locked(&config) {
                            println!("{} Strict mode is not passcode-locked. Nothing to reset.", "ℹ️".blue());
                            return Ok(());
                        }
                        if *force {
                            let confirm = Confirm::with_theme(&ColorfulTheme::default())
                                .with_prompt("⚠️  Force reset will DISABLE strict mode and clear the passcode. Continue?")
                                .default(false)
                                .interact()?;
                            if !confirm {
                                println!("{} Cancelled.", "ℹ️".blue());
                                return Ok(());
                            }
                            config.strict_gatekeeper_mode = false;
                            config.strict_mode_passcode_hash = None;
                            config.strict_mode_passcode_salt = None;
                            ConfigManager::save(&config)?;
                            println!("{} Strict mode DISABLED and passcode cleared (force reset).", "✓".green().bold());
                        } else {
                            let attempt = Password::with_theme(&ColorfulTheme::default())
                                .with_prompt("Enter current passcode")
                                .interact()?;
                            if !ConfigManager::verify_passcode(&config, &attempt) {
                                println!("{} Incorrect passcode.", "✗".red().bold());
                                return Ok(());
                            }
                            let new_passcode = Password::with_theme(&ColorfulTheme::default())
                                .with_prompt("Set new passcode (min 4 chars)")
                                .with_confirmation("Confirm new passcode", "Passcodes do not match")
                                .interact()?;
                            if new_passcode.len() < 4 {
                                println!("{} Passcode must be at least 4 characters.", "✗".red().bold());
                                return Ok(());
                            }
                            let salt = ConfigManager::generate_salt();
                            let hash = ConfigManager::hash_passcode(&new_passcode, &salt);
                            config.strict_mode_passcode_hash = Some(hash);
                            config.strict_mode_passcode_salt = Some(salt);
                            ConfigManager::save(&config)?;
                            println!("{} Passcode updated successfully.", "✓".green().bold());
                        }
                        return Ok(());
                    }
                }
            }

            println!("\n{} {}\n", "⚙️".bold(), "Aura Global Configuration".bold().cyan());
            
            use dialoguer::{Select, Confirm};
            
            let options = vec![
                format!("Gatekeeper Strict Mode (Currently: {})", if config.strict_gatekeeper_mode { "ON (Blocking)".red() } else { "OFF (Warn-Only)".green() }),
                format!("Embeddings Engine (Currently: {})", if config.use_local_embeddings { "Local (Offline)".green() } else { "Cloud (API)".blue() }),
                format!("Development Mode (Fast Init) (Currently: {})", if config.dev_mode { "ON".green() } else { "OFF (Enterprise)".blue() }),
                format!("Anonymous Telemetry (Currently: {})", if config.telemetry_enabled { "ON".green() } else { "OFF (Opt-Out)".blue() }),
                format!("Active AI Provider (Currently: {})", config.ai_provider.clone().unwrap_or_else(|| "gemini".to_string()).yellow()),
                "Update API Keys".to_string(),
                "Exit".to_string(),
            ];

            let selection = Select::with_theme(&ColorfulTheme::default())
                .with_prompt("Select a setting to modify (Use j/k or arrows)")
                .default(0)
                .items(&options)
                .interact()?;

            match selection {
                0 => {
                    let strict = Confirm::with_theme(&ColorfulTheme::default())
                        .with_prompt("Enable Strict Mode? (If enabled, Aura will hard-block commits containing forbidden dependencies instead of just warning)")
                        .default(config.strict_gatekeeper_mode)
                        .interact()?;

                    if strict && !config.strict_gatekeeper_mode {
                        // Enabling — set passcode
                        let passcode = Password::with_theme(&ColorfulTheme::default())
                            .with_prompt("Set a passcode to lock strict mode (min 4 chars)")
                            .with_confirmation("Confirm passcode", "Passcodes do not match")
                            .interact()?;
                        if passcode.len() < 4 {
                            println!("{} Passcode must be at least 4 characters.", "✗".red().bold());
                        } else {
                            let salt = ConfigManager::generate_salt();
                            let hash = ConfigManager::hash_passcode(&passcode, &salt);
                            config.strict_gatekeeper_mode = true;
                            config.strict_mode_passcode_hash = Some(hash);
                            config.strict_mode_passcode_salt = Some(salt);
                            ConfigManager::save(&config)?;
                            println!("{} Strict mode ENABLED and LOCKED with passcode.", "✓".green().bold());
                        }
                    } else if !strict && config.strict_gatekeeper_mode {
                        // Disabling — check passcode if locked
                        if ConfigManager::is_strict_mode_locked(&config) {
                            let attempt = Password::with_theme(&ColorfulTheme::default())
                                .with_prompt("Enter passcode to unlock strict mode")
                                .interact()?;
                            if !ConfigManager::verify_passcode(&config, &attempt) {
                                println!("{} Incorrect passcode. Strict mode remains locked.", "✗".red().bold());
                            } else {
                                config.strict_gatekeeper_mode = false;
                                config.strict_mode_passcode_hash = None;
                                config.strict_mode_passcode_salt = None;
                                ConfigManager::save(&config)?;
                                println!("{} Strict mode DISABLED and unlocked.", "✓".green().bold());
                            }
                        } else {
                            config.strict_gatekeeper_mode = false;
                            ConfigManager::save(&config)?;
                            println!("{} Gatekeeper strict mode updated.", "✓".green().bold());
                        }
                    } else {
                        println!("{} No change.", "ℹ️".blue());
                    }
                }
                1 => {
                    let local_embed = Confirm::with_theme(&ColorfulTheme::default())
                        .with_prompt("Enable Local Embeddings? (If enabled, Aura will never send AI intents to external cloud APIs for vectorization, ensuring 100% Sovereign Privacy)")
                        .default(config.use_local_embeddings)
                        .interact()?;
                    
                    config.use_local_embeddings = local_embed;
                    ConfigManager::save(&config)?;
                    println!("{} Embeddings Engine updated.", "✓".green().bold());
                }
                2 => {
                    let dev = Confirm::with_theme(&ColorfulTheme::default())
                        .with_prompt("Enable Development Mode? (If enabled, 'aura secure-init' skips the massive 2-of-3 Multi-Sig protocols and creates a fast local AES key)")
                        .default(config.dev_mode)
                        .interact()?;
                    
                    config.dev_mode = dev;
                    ConfigManager::save(&config)?;
                    println!("{} Development Mode updated.", "✓".green().bold());
                }
                3 => {
                    let telemetry = Confirm::with_theme(&ColorfulTheme::default())
                        .with_prompt("Enable Anonymous Telemetry? (Helps us understand CLI usage without tracking your code or PII)")
                        .default(config.telemetry_enabled)
                        .interact()?;
                    
                    config.telemetry_enabled = telemetry;
                    ConfigManager::save(&config)?;
                    println!("{} Telemetry settings updated.", "✓".green().bold());
                }
                4 => {
                    let providers = vec!["gemini", "anthropic", "openai", "mercury"];
                    let prov_sel = Select::with_theme(&ColorfulTheme::default())
                        .with_prompt("Select your preferred AI Provider")
                        .default(0)
                        .items(&providers)
                        .interact()?;
                    
                    config.ai_provider = Some(providers[prov_sel].to_string());
                    ConfigManager::save(&config)?;
                    println!("{} AI Provider set to {}.", "✓".green().bold(), providers[prov_sel].cyan());
                }
                5 => {
                    let providers = vec!["Gemini API Key", "Anthropic API Key", "OpenAI API Key", "Mercury API Key"];
                    let prov_sel = Select::with_theme(&ColorfulTheme::default())
                        .with_prompt("Which API Key do you want to update?")
                        .default(0)
                        .items(&providers)
                        .interact()?;
                    
                    let new_key = Password::with_theme(&ColorfulTheme::default())
                        .with_prompt(format!("Enter your {}", providers[prov_sel]))
                        .allow_empty_password(false)
                        .interact()?;
                        
                    if !new_key.is_empty() {
                        match prov_sel {
                            0 => config.gemini_api_key = Some(new_key),
                            1 => config.anthropic_api_key = Some(new_key),
                            2 => config.openai_api_key = Some(new_key),
                            3 => config.mercury_api_key = Some(new_key),
                            _ => {}
                        }
                        ConfigManager::save(&config)?;
                        println!("{} API Key updated.", "✓".green().bold());
                    }
                }
                _ => {
                    println!("Exiting configuration.");
                }
            }
        }
        Commands::PrReview { base, json, verbose } => {
            let result = crate::pr::PrReviewEngine::run_review(base, *json, *verbose)?;

            if *json {
                if let Some(ref json_str) = result {
                    println!("{}", json_str);
                }
            }

            // Cloud sync review result (if configured)
            if let Some(ref json_str) = result {
                let config = crate::config::ConfigManager::load();
                if config.sync_enabled && config.cloud_api_token.is_some() {
                    if let Ok(review_val) = serde_json::from_str::<serde_json::Value>(json_str) {
                        if let Ok(repo) = git2::Repository::open(".") {
                            if let Ok(remote) = repo.find_remote("origin") {
                                let remote_url = remote.url().unwrap_or("").to_string();
                                if !remote_url.is_empty() {
                                    let review_data = serde_json::json!({
                                        "base_branch": review_val["base_branch"],
                                        "risk_score": review_val["risk_score"],
                                        "risk_label": review_val["risk_label"],
                                        "violations": review_val["invariant_violations"],
                                        "summary": format!("PR review: {} changes, risk {}",
                                            review_val["total_changes"].as_u64().unwrap_or(0),
                                            review_val["risk_label"].as_str().unwrap_or("Unknown")),
                                    });
                                    std::thread::spawn(move || {
                                        crate::sync::GlobalSync::sync_review(&remote_url, &review_data);
                                    });
                                }
                            }
                        }
                    }
                }
            }
        }
        Commands::SuggestFix { base } => {
            Arbitrator::auto_fix_violations(base)?;
        }
        Commands::Policy { sub } => {
            match sub {
                PolicySubcommands::Add { pack_name } => {
                    crate::pr::PrReviewEngine::add_policy_pack(&pack_name)?;
                }
                PolicySubcommands::List { json } => {
                    let packs = crate::pr::PrReviewEngine::list_policy_packs();
                    if *json {
                        println!("{}", serde_json::to_string(&packs)?);
                    } else {
                        use colored::Colorize;
                        println!("\n{}", "Available policy packs".bold().cyan());
                        for p in &packs {
                            println!("  {} {} {}",
                                p.id.yellow().bold(),
                                format!("[{}]", p.category).dimmed(),
                                format!("({} rules)", p.rule_count).dimmed());
                            println!("    {} {}", "↳".dimmed(), p.description);
                        }
                        println!("\n{} {}", "↳".dimmed(), format!("Install with: aura policy add <id>").italic());
                    }
                }
            }
        }
        Commands::Task { sub } => {
            handle_task_command(sub)?;
        }
        Commands::Loop { sub } => {
            handle_loop_command(sub)?;
        }
        Commands::Runner { sub } => {
            handle_runner_command(sub)?;
        }
        Commands::GitCredential { action } => {
            push_credential::run(action)?;
        }
        Commands::Work { sub } => {
            work::handle(sub)?;
        }
        Commands::Activity { sub } => {
            handle_activity_command(sub)?;
        }
        Commands::Radar {
            sub,
            focus: bare_focus,
            limit: bare_limit,
            json: bare_json,
        } => match sub {
            // Bare `aura radar` IS `aura radar show`, so it has to answer to the
            // same flags — otherwise `--json` on the documented default form is
            // an error message instead of an answer. A flag typed before the
            // subcommand lands here too, so fold it in rather than dropping it.
            None => awareness::cmd::run_show(
                bare_focus.as_deref(),
                bare_limit.unwrap_or(20),
                *bare_json,
            ),
            Some(RadarSubcommands::Show { focus, limit, json }) => {
                awareness::cmd::run_show(
                    focus.as_deref().or(bare_focus.as_deref()),
                    limit.or(*bare_limit).unwrap_or(20),
                    *json || *bare_json,
                );
            }
            Some(RadarSubcommands::Conflicts { as_actor, all, json }) => {
                awareness::cmd::run_conflicts(as_actor.as_deref(), *all, *json || *bare_json);
            }
            Some(RadarSubcommands::Emit {
                kind,
                file,
                symbol,
                intent,
                impact,
                agent,
                json,
            }) => {
                awareness::cmd::run_emit(
                    kind,
                    file.as_deref(),
                    symbol.as_deref(),
                    intent.as_deref(),
                    impact.as_deref(),
                    agent.as_deref(),
                    *json,
                );
            }
            Some(RadarSubcommands::Wire { undo, quiet }) => {
                awareness::cmd::run_wire(*undo, *quiet);
            }
            Some(RadarSubcommands::Status { json }) => {
                awareness::cmd::run_status(*json);
            }
            Some(RadarSubcommands::Privacy { level, json }) => {
                awareness::cmd::run_privacy(level.as_deref(), *json);
            }
            Some(RadarSubcommands::Sync { json, quiet }) => {
                awareness::cmd::run_sync(*json, *quiet);
            }
        },
        Commands::Worktrees {
            sub,
            json: bare_json,
            no_git_status: bare_no_git_status,
            all: bare_all,
        } => match sub {
            // Same contract as the radar: bare `aura worktrees` is `... list`,
            // so it answers to list's flags too.
            None => worktree::cmd::run_list(*bare_json, *bare_no_git_status, *bare_all),
            Some(WorktreeSubcommands::List {
                json,
                no_git_status,
                all,
            }) => {
                worktree::cmd::run_list(
                    *json || *bare_json,
                    *no_git_status || *bare_no_git_status,
                    *all || *bare_all,
                );
            }
            Some(WorktreeSubcommands::Whoami { json }) => {
                worktree::cmd::run_whoami(*json);
            }
            Some(WorktreeSubcommands::Say { message, to, json }) => {
                worktree::cmd::run_say(message, to.as_deref(), *json);
            }
            Some(WorktreeSubcommands::Inbox { limit, agent, json }) => {
                worktree::cmd::run_inbox(*limit, agent.as_deref(), *json);
            }
            Some(WorktreeSubcommands::Assign {
                task,
                to,
                in_worktree,
                json,
            }) => {
                worktree::cmd::run_assign(task, to.as_deref(), in_worktree.as_deref(), *json);
            }
            Some(WorktreeSubcommands::Mine { agent, limit, json }) => {
                worktree::cmd::run_mine(agent.as_deref(), *limit, *json);
            }
        },
        Commands::Identity { json } => {
            awareness::identity::run_show(*json);
        }
        Commands::Review { sub } => {
            handle_review_command(sub)?;
        }
        Commands::IntentContract { sub } => match sub {
            IntentContractSubcommands::Approve {
                goal,
                allow,
                protect,
                path,
                agent,
                session,
                worktree,
                baseline,
                no_hook,
                json,
            } => {
                let code = verify_intent::run_approve(
                    goal,
                    allow,
                    protect,
                    path,
                    agent,
                    session,
                    worktree,
                    baseline.as_deref(),
                    *no_hook,
                    *json,
                );
                std::process::exit(code);
            }
            IntentContractSubcommands::Show { json } => {
                std::process::exit(verify_intent::run_show(*json));
            }
            IntentContractSubcommands::Amend { approve_removal, json } => {
                std::process::exit(verify_intent::run_amend(approve_removal, *json));
            }
        },
        Commands::VerifyIntent { staged: _, json } => {
            // `--staged` is the only mode: a gate that runs after the commit
            // exists is a report, not a gate.
            std::process::exit(verify_intent::run_verify(*json));
        }
        Commands::RestoreSymbol { symbol, json } => {
            std::process::exit(verify_intent::run_restore(symbol, *json));
        }
        Commands::IntentVsActual { sub } => {
            handle_intent_vs_actual_command(sub)?;
        }
        Commands::Meta { sub } => {
            meta_refs::run(sub)?;
        }
        Commands::Refs { sub } => {
            refs_sign::run(sub)?;
        }
        Commands::RepoId { sub } => {
            repo_identity::run(sub)?;
        }
        Commands::Node { sub } => {
            node::run(sub)?;
        }
        Commands::Bundle { sub } => {
            meta_bundle::run(sub)?;
        }
        Commands::Taste { sub } => {
            cmd_taste::run(sub)?;
        }
        Commands::Plugin { sub } => {
            cmd_plugin_marketplace::run(sub)?;
        }
        Commands::Env { sub } => {
            env_cmd::handle(sub)?;
        }
        Commands::Egress { sub } => {
            egress_cmd::handle(sub)?;
        }
        Commands::Orchestrate { sub } => {
            match sub {
                OrchestrateSubcommands::Run { objective, strategy, base, duo } => {
                    let strat = match strategy.as_str() {
                        "round-robin" => orchestrate::AssignmentStrategy::RoundRobin,
                        "smart" | _ => orchestrate::AssignmentStrategy::Smart,
                    };
                    let config = crate::config::ConfigManager::load();
                    let push_enabled = config.sync_enabled && config.cloud_api_token.is_some();
                    let mode = if *duo { "duo" } else { "symphony" };
                    let session_id_hint = format!("{}-{}", mode, std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_millis()).unwrap_or(0));
                    if push_enabled {
                        crate::sync::GlobalSync::push_orchestration(
                            mode,
                            serde_json::json!({ "objective": objective, "strategy": strategy, "base": base }),
                            "running",
                            Some(&session_id_hint),
                            false,
                        );
                    }
                    let result = if *duo {
                        orchestrate::run_duo(&objective, &base)
                    } else {
                        orchestrate::run(&objective, strat, &base)
                    };
                    if push_enabled {
                        let status = if result.is_ok() { "completed" } else { "failed" };
                        crate::sync::GlobalSync::push_orchestration(
                            mode,
                            serde_json::json!({}),
                            status,
                            Some(&session_id_hint),
                            true,
                        );
                    }
                    result?;
                }
                OrchestrateSubcommands::Status => {
                    let summary = orchestrate::get_status_summary()?;
                    println!("{}", summary);
                }
                OrchestrateSubcommands::Pause => {
                    let session = orchestrate::pause_session()?;
                    println!("Paused session {}", &session.id[..8]);
                }
                OrchestrateSubcommands::Resume { base } => {
                    orchestrate::resume_session(&base)?;
                }
                OrchestrateSubcommands::Cancel => {
                    let session = orchestrate::cancel_session()?;
                    println!("Cancelled session {}", &session.id[..8]);
                }
                OrchestrateSubcommands::List => {
                    let sessions = orchestrate::list_sessions()?;
                    if sessions.is_empty() {
                        println!("No orchestration sessions found.");
                    } else {
                        for s in &sessions {
                            let passed = s.waves.iter().filter(|w| w.status == orchestrate::WaveStatus::Passed).count();
                            println!("{} | {:?} | {}/{} waves | {}",
                                &s.id[..8], s.status, passed, s.waves.len(), s.objective);
                        }
                    }
                }
            }
        }
        Commands::Symphony { sub } => {
            match sub {
                SymphonySubcommands::Run { team: _, limit: _, label: _, base: _ } => {
                    // Symphony reads config from WORKFLOW.md
                    let workflow_path = ".aura/WORKFLOW.md";
                    if !Path::new(workflow_path).exists() {
                        eprintln!("No WORKFLOW.md found. Create .aura/WORKFLOW.md to configure Symphony.");
                        eprintln!("See: aura symphony status");
                    } else {
                        symphony::start(workflow_path)?;
                    }
                }
                SymphonySubcommands::Status => {
                    symphony::status()?;
                }
            }
        }
        Commands::Msg { sub } => {
            match sub {
                MsgSubcommands::Send { message, to } => {
                    match live_sync::send_team_message(message, to.as_deref()) {
                        Ok(resp) => {
                            let msg_id = resp["id"].as_str().unwrap_or("?");
                            if let Some(recipient) = to {
                                println!("{} Message sent to {} ({})", "✓".green().bold(), recipient.cyan(), msg_id);
                            } else {
                                println!("{} Message broadcast to team ({})", "✓".green().bold(), msg_id);
                            }
                        }
                        Err(e) => {
                            println!("{} Failed to send message: {}", "✗".red().bold(), e);
                        }
                    }
                    // S0.4 spike: also emit a Message block envelope into
                    // the per-repo block store. Independent of cloud send
                    // success — the block is the local truth.
                    let channel = live_events::current_branch();
                    match block_adapter::emit_message_block(message, to.as_deref(), Some(&channel)) {
                        Ok(id) => println!("  {} Block recorded: {}", "✓".green().bold(), format!("{:?}", id).dimmed()),
                        Err(e) => println!("  {} Block store skipped: {}", "•".dimmed(), e.dimmed()),
                    }
                }
                MsgSubcommands::List { limit, json } => {
                    match live_sync::fetch_team_messages(*limit) {
                        Ok(data) => {
                            if *json {
                                println!("{}", serde_json::to_string_pretty(&data).unwrap_or_else(|_| "{}".to_string()));
                            } else {
                                let messages = data["messages"].as_array();
                                let total = data["total"].as_u64().unwrap_or(0);

                                if total == 0 {
                                    println!("{} No messages in this repository.", "ℹ️".blue());
                                } else {
                                    println!("{} {} message{}\n", "💬".bold(),
                                        total.to_string().cyan().bold(),
                                        if total == 1 { "" } else { "s" });

                                    if let Some(msgs) = messages {
                                        for msg in msgs {
                                            let user = msg["from"].as_str().unwrap_or("?");
                                            let branch = msg["branch"].as_str().unwrap_or("?");
                                            let text = msg["message"].as_str().unwrap_or("");
                                            let time = msg["created_at"].as_str().unwrap_or("");
                                            let to_user = msg["to"].as_str();
                                            let is_agent = msg["is_agent"].as_bool().unwrap_or(false);

                                            let sender_label = if is_agent {
                                                format!("{} {}", "🤖", user.cyan())
                                            } else {
                                                format!("{}", user.cyan())
                                            };

                                            if let Some(recipient) = to_user {
                                                println!("  {} {} → {} on {} {}", "│".dimmed(),
                                                    sender_label, recipient.yellow(), branch.green(),
                                                    time.dimmed());
                                            } else {
                                                println!("  {} {} on {} {}", "│".dimmed(),
                                                    sender_label, branch.green(), time.dimmed());
                                            }
                                            println!("  {}   {}", "│".dimmed(), text);
                                            println!("  {}", "│".dimmed());
                                        }
                                    }
                                }
                            }

                            // Clear unread marker
                            let marker = std::path::Path::new(".aura/live/unread_messages");
                            if marker.exists() {
                                let _ = fs::remove_file(marker);
                            }
                        }
                        Err(e) => {
                            println!("{} Failed to fetch messages: {}", "✗".red().bold(), e);
                        }
                    }
                }
            }
        }
        Commands::Goals { sub } => {
            let res = match sub {
                GoalsSubcommands::Prove { text, task, json } => {
                    goals::cli::prove(text, task.as_deref(), *json)
                }
                GoalsSubcommands::List { json } => goals::cli::list(*json),
                GoalsSubcommands::Show { goal, json } => goals::cli::show(goal, *json),
                GoalsSubcommands::Why { goal, json } => goals::cli::why(goal, *json),
                GoalsSubcommands::Link { goal, task } => goals::cli::link(goal, task),
                GoalsSubcommands::Add { text, task, check, json } => {
                    goals::cli::add(text, task.as_deref(), check, *json)
                }
            };
            if let Err(e) = res {
                println!("{} {}", "✗".red().bold(), e);
                std::process::exit(1);
            }
        }
        Commands::Live { sub } => {
            match sub {
                LiveSubcommands::Start { collab } => {
                    use colored::Colorize;
                    use std::sync::atomic::{AtomicBool, Ordering};
                    use std::sync::Arc;

                    // Go Live: enable whole-file CRDT before the worker starts so
                    // `LiveSyncWorker::start` sees `live_crdt_enabled()` and spawns
                    // the CRDT daemon (sole disk writer). Persisted via marker.
                    if *collab {
                        crate::crdt_daemon::set_crdt_enabled(true);
                    }

                    println!("{}", "🔴 Aura Live — Real-time Collaborative Code Awareness".bold());
                    println!();
                    println!("  {} {}", "User:".dimmed(), live_events::git_user().cyan());
                    println!("  {} {}", "Branch:".dimmed(), live_events::current_branch().cyan());
                    println!("  {} {}", "Repo:".dimmed(), live_events::repo_name().cyan());
                    if crate::crdt_daemon::live_crdt_enabled() {
                        println!(
                            "  {} {}",
                            "Collab:".dimmed(),
                            "whole-file CRDT — entire tree syncs conflict-free".green()
                        );
                    }
                    live_sync::print_sync_status();
                    live_sync::print_mothership_status_line();
                    println!();
                    println!("  Streaming function-level diffs...");
                    println!("  Your team can see what you're working on in real-time.");
                    println!("  Press {} to stop.\n", "Ctrl+C".bold());

                    // Start cloud sync worker in background (if token configured)
                    let running = Arc::new(AtomicBool::new(true));
                    let sync_handle = live_sync::LiveSyncWorker::new(running.clone())
                        .map(|worker| {
                            println!("  {} Cloud sync worker started (every 5s)", "☁".cyan());
                            worker.start()
                        });

                    // Register Ctrl+C handler to gracefully stop sync
                    let running_ctrlc = running.clone();
                    let _ = ctrlc::set_handler(move || {
                        println!("\n{} Shutting down Aura Live...", "⏹".bold());
                        running_ctrlc.store(false, Ordering::Relaxed);
                        // Give sync worker time to flush
                        std::thread::sleep(std::time::Duration::from_secs(2));
                        std::process::exit(0);
                    });

                    let parser = SemanticParser::new()?;
                    let tracker = ContinuousTracker::with_live_mode(parser);
                    tracker.watch(".")?;

                    // Cleanup (reached if watcher exits)
                    running.store(false, Ordering::Relaxed);
                    if let Some(handle) = sync_handle {
                        let _ = handle.join();
                    }
                }
                LiveSubcommands::Stop => {
                    use colored::Colorize;
                    // Go Live → off: clear the explicit whole-file CRDT marker so
                    // a later restart won't respawn the daemon (cloud-routed repos
                    // stay CRDT-enabled by their routing; this only undoes the
                    // additive Go Live opt-in).
                    crate::crdt_daemon::set_crdt_enabled(false);
                    // Kill any running aura live/daemon process
                    let _ = std::process::Command::new("pkill")
                        .args(["-f", "aura live start"])
                        .output();
                    let _ = std::process::Command::new("pkill")
                        .args(["-f", "aura daemon"])
                        .output();
                    println!("{} Aura Live stopped.", "✓".green().bold());

                    let count = live_events::LiveEventBuffer::count();
                    if count > 0 {
                        println!("  {} {} unsent events in buffer.", "↳".dimmed(), count);
                    }
                }
                LiveSubcommands::Status => {
                    use colored::Colorize;
                    println!("{}", "🔴 Aura Live — Team Status".bold());
                    println!();
                    live_sync::print_mothership_status_line();
                    println!();

                    let user = live_events::git_user();
                    let branch = live_events::current_branch();
                    let repo = live_events::repo_name();
                    let buffered = live_events::LiveEventBuffer::count();

                    println!("  {} {} on {} ({})", "You:".bold(), user.cyan(), branch.green(), repo.dimmed());
                    println!("  {} {} events buffered locally", "Buffer:".dimmed(), buffered);
                    println!();

                    // Show local activity
                    let events_path = ".aura/live/events.jsonl";
                    if let Ok(content) = std::fs::read_to_string(events_path) {
                        let recent: Vec<live_events::LiveEvent> = content
                            .lines()
                            .rev()
                            .take(10)
                            .filter_map(|l| serde_json::from_str(l).ok())
                            .collect();

                        if !recent.is_empty() {
                            println!("  {} Recent local activity:", "Activity:".bold());
                            for event in recent.iter().rev() {
                                let changes: Vec<String> = event.changes.iter().map(|c| {
                                    let sym = match c.change_type {
                                        live_events::ChangeType::Added => "+".green().to_string(),
                                        live_events::ChangeType::Modified => "~".yellow().to_string(),
                                        live_events::ChangeType::Deleted => "-".red().to_string(),
                                    };
                                    format!("{}{}", sym, c.name)
                                }).collect();
                                println!("    {} {} → {}", "•".dimmed(), event.file_path.dimmed(), changes.join(", "));
                            }
                        }
                    }

                    // Fetch team presence from cloud
                    let config = config::ConfigManager::load();
                    let token = config.cloud_api_token
                        .or_else(|| std::env::var("AURA_CLOUD_TOKEN").ok());

                    if let Some(token) = token {
                        let cloud_url = config.cloud_url
                            .unwrap_or_else(|| "https://api.auravcs.com".to_string());
                        let url = format!("{}/api/v1/live/presence?repo={}",
                            cloud_url.trim_end_matches('/'), repo);

                        let mut pbuilder = reqwest::blocking::Client::builder()
                            .timeout(std::time::Duration::from_secs(5));
                        if config.accept_self_signed {
                            pbuilder = pbuilder.danger_accept_invalid_certs(true);
                        }
                        let client = pbuilder.build()
                            .unwrap_or_else(|_| reqwest::blocking::Client::new());

                        match client.get(&url)
                            .header("Authorization", format!("Bearer {}", token))
                            .send()
                        {
                            Ok(resp) if resp.status().is_success() => {
                                if let Ok(data) = resp.json::<serde_json::Value>() {
                                    let devs = data["developers"].as_array();
                                    let total = data["total_active"].as_u64().unwrap_or(0);

                                    println!();
                                    println!("  {} {} active developer{}", "Team:".bold(),
                                        total.to_string().cyan(),
                                        if total == 1 { "" } else { "s" });

                                    if let Some(devs) = devs {
                                        for dev in devs {
                                            let name = dev["username"].as_str().unwrap_or("?");
                                            let dev_branch = dev["branch"].as_str().unwrap_or("?");
                                            let fns = dev["active_functions"].as_array()
                                                .map(|arr| arr.iter()
                                                    .filter_map(|f| f["name"].as_str())
                                                    .collect::<Vec<_>>()
                                                    .join(", "))
                                                .unwrap_or_default();

                                            let is_you = name == user;
                                            let name_display = if is_you {
                                                format!("{} (you)", name).cyan().to_string()
                                            } else {
                                                name.yellow().to_string()
                                            };

                                            println!("    {} {} on {} → {}",
                                                "•".dimmed(), name_display,
                                                dev_branch.green(),
                                                if fns.is_empty() { "idle".dimmed().to_string() } else { fns });
                                        }
                                    }
                                }
                            }
                            Ok(resp) => {
                                println!("\n  {} Cloud returned {}", "⚠️".yellow(), resp.status());
                            }
                            Err(_) => {
                                println!("\n  {} Cloud unreachable, showing local data only", "⚠️".yellow());
                            }
                        }
                    } else {
                        println!();
                        println!("  {} Team presence requires Aura Cloud connection.", "ℹ️ ".blue());
                        println!("  {} Configure with: {}", "↳".dimmed(), "aura config set cloud-token <token>".cyan());
                    }
                }
                LiveSubcommands::Impacts { json } => {
                    if *json {
                        match live_sync::fetch_impacts_json() {
                            Ok(data) => {
                                println!("{}", serde_json::to_string_pretty(&data).unwrap_or_else(|_| "{}".to_string()));
                            }
                            Err(e) => {
                                let err = serde_json::json!({"error": e});
                                println!("{}", serde_json::to_string_pretty(&err).unwrap_or_else(|_| "{}".to_string()));
                            }
                        }
                        return Ok(());
                    }

                    use colored::Colorize;
                    println!("{}", "⚠️  Aura Live — Cross-Branch Impacts".bold());
                    println!();

                    let branch = live_events::current_branch();
                    let repo = live_events::repo_name();

                    let config = config::ConfigManager::load();
                    let token = config.cloud_api_token
                        .or_else(|| std::env::var("AURA_CLOUD_TOKEN").ok());

                    if let Some(token) = token {
                        let cloud_url = config.cloud_url
                            .unwrap_or_else(|| "https://api.auravcs.com".to_string());
                        let url = format!("{}/api/v1/live/impacts?repo={}",
                            cloud_url.trim_end_matches('/'), repo);

                        println!("  {} Checking impacts on branch {}...", "↳".dimmed(), branch.cyan());
                        println!();

                        let mut cbuilder = reqwest::blocking::Client::builder()
                            .timeout(std::time::Duration::from_secs(5));
                        if config.accept_self_signed {
                            cbuilder = cbuilder.danger_accept_invalid_certs(true);
                        }
                        let client = cbuilder.build()
                            .unwrap_or_else(|_| reqwest::blocking::Client::new());

                        match client.get(&url)
                            .header("Authorization", format!("Bearer {}", token))
                            .send()
                        {
                            Ok(resp) if resp.status().is_success() => {
                                if let Ok(data) = resp.json::<serde_json::Value>() {
                                    let alerts = data["alerts"].as_array();
                                    let total = data["total"].as_u64().unwrap_or(0);

                                    if total == 0 {
                                        println!("  {} No impacts detected on your branch.", "✓".green().bold());
                                        println!("  {} Your dependencies are safe across all active branches.", "↳".dimmed());
                                    } else {
                                        println!("  {} {} impact{} detected!", "⚠️".yellow().bold(),
                                            total.to_string().red().bold(),
                                            if total == 1 { "" } else { "s" });
                                        println!();

                                        if let Some(alerts) = alerts {
                                            for alert in alerts {
                                                let src_user = alert["source_user"].as_str().unwrap_or("?");
                                                let src_branch = alert["source_branch"].as_str().unwrap_or("?");
                                                let src_fn = alert["source_function"].as_str().unwrap_or("?");
                                                let impact_type = alert["impact_type"].as_str().unwrap_or("modified");
                                                let affected = alert["affected_functions"].as_array();

                                                let type_label = match impact_type {
                                                    "deleted" => "DELETED".red().bold().to_string(),
                                                    "modified" => "MODIFIED".yellow().bold().to_string(),
                                                    _ => impact_type.to_uppercase(),
                                                };

                                                println!("  {} {} {} {} on {}",
                                                    "│".dimmed(), type_label,
                                                    src_fn.cyan().bold(),
                                                    format!("by {}", src_user).dimmed(),
                                                    src_branch.green());

                                                if let Some(fns) = affected {
                                                    for f in fns {
                                                        let name = f["name"].as_str().unwrap_or("?");
                                                        let dep = f["depends_on"].as_str().unwrap_or("?");
                                                        println!("  {}   {} your {} depends on {}",
                                                            "│".dimmed(), "→".yellow(),
                                                            name.cyan(), dep.yellow());
                                                    }
                                                }
                                                println!("  {}", "│".dimmed());
                                            }
                                        }

                                        println!("  {} Review these changes before merging to avoid runtime conflicts.", "💡".blue());
                                    }
                                }
                            }
                            Ok(resp) => {
                                println!("  {} Cloud returned {}", "⚠️".yellow(), resp.status());
                            }
                            Err(e) => {
                                println!("  {} Cloud unreachable: {}", "⚠️".yellow(), e);
                            }
                        }
                    } else {
                        println!("  {} Connect to Aura Cloud to enable cross-branch impact detection.", "⚠️".yellow());
                        println!("  {} Run: {}", "↳".dimmed(), "aura config set cloud-token <your-token>".cyan());
                    }
                }
                LiveSubcommands::Check { file } => {
                    // Ultra-fast local marker check — no network calls
                    // Designed to run as a Claude Code hook on Edit/Write/Read
                    let mut alerts = Vec::new();

                    // 1. Unread team messages
                    let msg_marker = std::path::Path::new(".aura/live/unread_messages");
                    if msg_marker.exists() {
                        if let Ok(c) = std::fs::read_to_string(msg_marker) {
                            if let Ok(n) = c.trim().parse::<u64>() {
                                if n > 0 {
                                    alerts.push(format!("TEAM: {} unread message{}. Run: aura msg list", n, if n == 1 { "" } else { "s" }));
                                }
                            }
                        }
                    }

                    // 2. Pending sync from teammates
                    let sync_marker = std::path::Path::new(".aura/live/sync_pending");
                    if sync_marker.exists() {
                        if let Ok(c) = std::fs::read_to_string(sync_marker) {
                            if let Ok(n) = c.trim().parse::<u64>() {
                                if n > 0 {
                                    alerts.push(format!("SYNC: {} function update{} from teammates. Run: aura live sync pull", n, if n == 1 { "" } else { "s" }));
                                }
                            }
                        }
                    }

                    // 3. Pending impact alerts
                    let impact_marker = std::path::Path::new(".aura/live/impacts_pending");
                    if impact_marker.exists() {
                        if let Ok(c) = std::fs::read_to_string(impact_marker) {
                            if let Ok(n) = c.trim().parse::<u64>() {
                                if n > 0 {
                                    alerts.push(format!("IMPACT: {} cross-branch conflict{}. Run: aura live impacts", n, if n == 1 { "" } else { "s" }));
                                }
                            }
                        }
                    }

                    // 4. Sentinel collisions
                    let collision_marker_path = crate::worktree::paths::shared_aura_path("sentinel/collisions_pending");
                    let collision_marker = std::path::Path::new(&collision_marker_path);
                    if collision_marker.exists() {
                        if let Ok(c) = std::fs::read_to_string(collision_marker) {
                            if let Ok(n) = c.trim().parse::<u64>() {
                                if n > 0 {
                                    alerts.push(format!("COLLISION: {} function{} being edited by another agent", n, if n == 1 { "" } else { "s" }));
                                }
                            }
                        }
                    }

                    // 5. Remote zone check (only if file specified — quick network call)
                    if let Some(fp) = file {
                        if let Ok(resp) = live_sync::check_remote_zone(fp) {
                            if let Some(conflicts) = resp["conflicts"].as_array() {
                                for c in conflicts {
                                    let user = c["username"].as_str().unwrap_or("?");
                                    let mode = c["mode"].as_str().unwrap_or("warn");
                                    alerts.push(format!("ZONE {}: {} claimed by {}", mode.to_uppercase(), fp, user));
                                }
                            }
                        }
                    }

                    if alerts.is_empty() {
                        // Silent — no output means no alerts
                    } else {
                        for a in &alerts {
                            println!("[aura] {}", a);
                        }
                    }
                }
                LiveSubcommands::Sync { sub } => {
                    match sub {
                        SyncSubcommands::Push { file } => {
                            use colored::Colorize;
                            println!("{}", "🔄 Aura Sync — Push".bold());
                            println!();

                            let path = std::path::Path::new(file.as_str());
                            if !path.exists() {
                                println!("  {} File not found: {}", "✗".red(), file);
                                return Ok(());
                            }

                            // Parse the file to extract function bodies
                            let source = match std::fs::read_to_string(path) {
                                Ok(s) => s,
                                Err(e) => {
                                    println!("  {} Could not read file: {}", "✗".red(), e);
                                    return Ok(());
                                }
                            };

                            let ext = path.extension()
                                .and_then(|e| e.to_str())
                                .unwrap_or("");

                            let mut parser = match crate::parser::SemanticParser::new() {
                                Ok(p) => p,
                                Err(e) => {
                                    println!("  {} Parser init failed: {}", "✗".red(), e);
                                    return Ok(());
                                }
                            };

                            let nodes = match parser.parse_file(&source, ext) {
                                Ok(n) => n,
                                Err(e) => {
                                    println!("  {} Parse failed: {}", "✗".red(), e);
                                    return Ok(());
                                }
                            };

                            if nodes.is_empty() {
                                println!("  {} No functions/structs found in {}", "⚠".yellow(), file);
                                return Ok(());
                            }

                            // Extract function bodies using splice logic to find each function's text
                            let mut payloads = Vec::new();
                            for node in &nodes {
                                if let Some(ref ident) = node.identifier {
                                    // Use the splice finder to extract the function body from source
                                    if let Some(body) = live_sync::extract_function_body(&source, ident) {
                                        payloads.push(live_sync::SyncFunctionPayload {
                                            file_path: file.clone(),
                                            function_name: ident.clone(),
                                            function_kind: node.kind.clone(),
                                            content_hash: node.content_hash.clone(),
                                            body,
                                            parent_hash: None,
                                            ..Default::default()
                                        });
                                    }
                                }
                            }

                            if payloads.is_empty() {
                                println!("  {} No identifiable functions to push", "⚠".yellow());
                                return Ok(());
                            }

                            println!("  {} Pushing {} functions from {}...",
                                "↳".dimmed(), payloads.len().to_string().cyan(), file.cyan());

                            match live_sync::push_function_bodies(&payloads) {
                                Ok(resp) => {
                                    let pushed = resp["pushed"].as_u64().unwrap_or(0);
                                    println!("  {} {} functions pushed to Aura Cloud",
                                        "✓".green().bold(), pushed);
                                }
                                Err(e) => {
                                    println!("  {} Push failed: {}", "✗".red(), e);
                                }
                            }
                        }
                        SyncSubcommands::Pull { dry_run, allow_red } => {
                            use colored::Colorize;
                            println!("{}", "🔄 Aura Sync — Pull".bold());
                            println!();

                            let branch = live_events::current_branch();
                            println!("  {} Pulling changes on branch {}...",
                                "↳".dimmed(), branch.cyan());

                            match live_sync::pull_function_bodies_opts(*allow_red) {
                                Ok(data) => {
                                    let functions = data["functions"].as_array();
                                    let total = data["total"].as_u64().unwrap_or(0);

                                    if total == 0 {
                                        println!("  {} No new changes from teammates.", "✓".green().bold());
                                        return Ok(());
                                    }

                                    println!("  {} {} function update{} available",
                                        "📥".blue(), total.to_string().cyan().bold(),
                                        if total == 1 { "" } else { "s" });
                                    println!();

                                    if let Some(funcs) = functions {
                                        for f in funcs {
                                            let file_path = f["file_path"].as_str().unwrap_or("?");
                                            let fn_name = f["function_name"].as_str().unwrap_or("?");
                                            let pushed_by = f["pushed_by"].as_str().unwrap_or("?");
                                            println!("  {} {}::{} from {}",
                                                "│".dimmed(),
                                                file_path.dimmed(),
                                                fn_name.cyan(),
                                                pushed_by.green());
                                        }
                                        println!();

                                        if *dry_run {
                                            println!("  {} Dry run — no files modified. Remove --dry-run to apply.",
                                                "ℹ".blue());
                                        } else {
                                            let (applied, skipped, conflicts) =
                                                live_sync::apply_pulled_functions(funcs);

                                            println!("  {} {} applied, {} skipped",
                                                "✓".green().bold(),
                                                applied.to_string().green(),
                                                skipped.to_string().yellow());

                                            if !conflicts.is_empty() {
                                                println!();
                                                println!("  {} {} conflict{}:",
                                                    "⚠".yellow().bold(),
                                                    conflicts.len(),
                                                    if conflicts.len() == 1 { "" } else { "s" });
                                                for c in &conflicts {
                                                    println!("    {} {}", "→".yellow(), c);
                                                }
                                            }
                                        }
                                    }
                                }
                                Err(e) => {
                                    println!("  {} Pull failed: {}", "✗".red(), e);
                                }
                            }
                        }
                        SyncSubcommands::Status => {
                            use colored::Colorize;
                            println!("{}", "🔄 Aura Sync — Status".bold());
                            println!();

                            let branch = live_events::current_branch();
                            let repo = live_events::repo_name();
                            println!("  {} {} on {}", "↳".dimmed(), repo.cyan(), branch.green());

                            match live_sync::fetch_sync_status() {
                                Ok(data) => {
                                    let pending = data["pending_changes"].as_u64().unwrap_or(0);
                                    let total = data["total_synced_functions"].as_u64().unwrap_or(0);
                                    let active = data["active_pushers"].as_u64().unwrap_or(0);

                                    println!();
                                    println!("  {} synced functions: {}", "•".dimmed(), total.to_string().cyan());
                                    println!("  {} pending from others: {}",
                                        "•".dimmed(),
                                        if pending > 0 { pending.to_string().yellow().bold().to_string() }
                                        else { "0".green().to_string() });
                                    println!("  {} active pushers (5m): {}", "•".dimmed(), active.to_string().cyan());

                                    if pending > 0 {
                                        println!();
                                        println!("  {} Run {} to apply teammate changes",
                                            "💡".blue(), "aura live sync pull".cyan());
                                    }
                                }
                                Err(e) => {
                                    println!("  {} Could not fetch sync status: {}", "⚠".yellow(), e);
                                }
                            }
                        }
                        SyncSubcommands::Backfill => {
                            use colored::Colorize;
                            println!("{}", "🔄 Aura Sync — Backfill Snapshots".bold());
                            let repo_full = git2::Repository::open(".").ok()
                                .and_then(|r| r.find_remote("origin").ok().and_then(|rem| rem.url().map(String::from)));
                            let n = crate::sync::GlobalSync::backfill_snapshots(repo_full.as_deref());
                            println!("  {} Pushed {} snapshot{} to cloud",
                                "✓".green().bold(),
                                n.to_string().cyan(),
                                if n == 1 { "" } else { "s" });
                        }
                    }
                }
            }
        }
        Commands::Server { sub } => {
            match sub {
                ServerSubcommands::Register { url, username, password } => {
                    println!("{} Registering on {}...", "🔐".bold(), url.cyan());

                    let client = cloud_http_client();
                    let resp = client.post(format!("{}/auth/register", url))
                        .json(&serde_json::json!({
                            "username": username,
                            "password": password,
                        }))
                        .send();

                    match resp {
                        Ok(r) if r.status().is_success() => {
                            let data: serde_json::Value = r.json().unwrap_or_default();
                            let jwt = data["jwt"].as_str().unwrap_or("");
                            let api_token = data["api_token"].as_str().unwrap_or("");
                            let org_slug = data["org_slug"].as_str().unwrap_or("");

                            // Store credentials
                            let cred_dir = directories::ProjectDirs::from("com", "naridon", "aura")
                                .map(|d| d.config_dir().to_path_buf())
                                .unwrap_or_else(|| {
                                    std::path::PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| ".".to_string())).join(".aura")
                                });
                            let _ = fs::create_dir_all(&cred_dir);
                            let creds = serde_json::json!({
                                "cloud_url": url,
                                "jwt": jwt,
                                "api_token": api_token,
                                "org_slug": org_slug,
                                "username": username,
                            });
                            let cred_path = cred_dir.join("credentials.json");
                            let _ = fs::write(&cred_path, serde_json::to_string_pretty(&creds).unwrap_or_default());

                            // Also set cloud-url in config
                            let mut config = ConfigManager::load();
                            config.cloud_url = Some(url.clone());
                            config.cloud_api_token = Some(api_token.to_string());
                            let _ = ConfigManager::save(&config);

                            println!("{} Registered as {} on {}", "✓".green().bold(), username.cyan(), url);
                            println!("  {} Org: {}", "•".dimmed(), org_slug.cyan());
                            println!("  {} API token stored — all aura commands will use this server", "•".dimmed());
                        }
                        Ok(r) if r.status() == 409 => {
                            println!("{} Username '{}' already exists on this server", "✗".red().bold(), username);
                        }
                        Ok(r) => {
                            println!("{} Registration failed ({})", "✗".red().bold(), r.status());
                        }
                        Err(e) => {
                            println!("{} Could not connect to {}: {}", "✗".red().bold(), url, e);
                        }
                    }
                }
                ServerSubcommands::Login { url, username, password } => {
                    println!("{} Logging in to {}...", "🔐".bold(), url.cyan());

                    let client = cloud_http_client();
                    let resp = client.post(format!("{}/auth/login", url))
                        .json(&serde_json::json!({
                            "username": username,
                            "password": password,
                        }))
                        .send();

                    match resp {
                        Ok(r) if r.status().is_success() => {
                            let data: serde_json::Value = r.json().unwrap_or_default();
                            let jwt = data["jwt"].as_str().unwrap_or("");

                            let cred_dir = directories::ProjectDirs::from("com", "naridon", "aura")
                                .map(|d| d.config_dir().to_path_buf())
                                .unwrap_or_else(|| {
                                    std::path::PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| ".".to_string())).join(".aura")
                                });
                            let _ = fs::create_dir_all(&cred_dir);
                            let cred_path = cred_dir.join("credentials.json");

                            // Merge with existing creds if any
                            let mut creds: serde_json::Value = if cred_path.exists() {
                                serde_json::from_str(&fs::read_to_string(&cred_path).unwrap_or_default()).unwrap_or_default()
                            } else {
                                serde_json::json!({})
                            };
                            creds["cloud_url"] = serde_json::json!(url);
                            creds["jwt"] = serde_json::json!(jwt);
                            creds["username"] = serde_json::json!(username);
                            let _ = fs::write(&cred_path, serde_json::to_string_pretty(&creds).unwrap_or_default());

                            let mut config = ConfigManager::load();
                            config.cloud_url = Some(url.clone());
                            let _ = ConfigManager::save(&config);

                            println!("{} Logged in as {} on {}", "✓".green().bold(), username.cyan(), url);
                        }
                        Ok(r) if r.status() == 401 => {
                            println!("{} Invalid username or password", "✗".red().bold());
                        }
                        Ok(r) => {
                            println!("{} Login failed ({})", "✗".red().bold(), r.status());
                        }
                        Err(e) => {
                            println!("{} Could not connect to {}: {}", "✗".red().bold(), url, e);
                        }
                    }
                }
                ServerSubcommands::AddRepo { repo_name } => {
                    let config = ConfigManager::load();
                    let cloud_url = config.cloud_url.as_deref().unwrap_or("");
                    let cloud_token = config.cloud_api_token.as_deref().unwrap_or("");

                    if cloud_url.is_empty() || cloud_token.is_empty() {
                        println!("{} Not connected to a server. Run {} first.",
                            "✗".red().bold(), "aura server register".cyan());
                        return Ok(());
                    }

                    // Read org_slug from credentials
                    let cred_dir = directories::ProjectDirs::from("com", "naridon", "aura")
                        .map(|d| d.config_dir().to_path_buf())
                        .unwrap_or_else(|| std::path::PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| ".".to_string())).join(".aura"));
                    let cred_path = cred_dir.join("credentials.json");
                    let creds: serde_json::Value = if cred_path.exists() {
                        serde_json::from_str(&fs::read_to_string(&cred_path).unwrap_or_default()).unwrap_or_default()
                    } else {
                        serde_json::json!({})
                    };
                    let org_slug = creds["org_slug"].as_str().unwrap_or("");

                    if org_slug.is_empty() {
                        println!("{} No org configured. Run {} first.",
                            "✗".red().bold(), "aura server register".cyan());
                        return Ok(());
                    }

                    let client = cloud_http_client();
                    let resp = client.post(format!("{}/api/v1/orgs/{}/repos", cloud_url, org_slug))
                        .bearer_auth(cloud_token)
                        .json(&serde_json::json!({ "repo_name": repo_name }))
                        .send();

                    match resp {
                        Ok(r) if r.status().is_success() => {
                            println!("{} Repository '{}' registered on server", "✓".green().bold(), repo_name.cyan());
                        }
                        Ok(r) => {
                            println!("{} Failed to register repo ({})", "✗".red().bold(), r.status());
                        }
                        Err(e) => {
                            println!("{} Could not connect: {}", "✗".red().bold(), e);
                        }
                    }
                }
                ServerSubcommands::Status => {
                    let config = ConfigManager::load();
                    let cloud_url = config.cloud_url.as_deref().unwrap_or("");

                    if cloud_url.is_empty() {
                        println!("{} Not connected to any server. Run {} first.",
                            "ℹ️".blue(), "aura server register".cyan());
                        return Ok(());
                    }

                    println!("{} Checking connection to {}...", "🔍".bold(), cloud_url.cyan());

                    let client = cloud_http_client();

                    match client.get(format!("{}/health", cloud_url)).send() {
                        Ok(r) if r.status().is_success() => {
                            println!("{} Server is online", "✓".green().bold());
                            println!("  {} URL: {}", "•".dimmed(), cloud_url.cyan());

                            // Show credentials info
                            let cred_dir = directories::ProjectDirs::from("com", "naridon", "aura")
                                .map(|d| d.config_dir().to_path_buf())
                                .unwrap_or_else(|| std::path::PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| ".".to_string())).join(".aura"));
                            let cred_path = cred_dir.join("credentials.json");
                            if cred_path.exists() {
                                let creds: serde_json::Value = serde_json::from_str(
                                    &fs::read_to_string(&cred_path).unwrap_or_default()
                                ).unwrap_or_default();
                                if let Some(user) = creds["username"].as_str() {
                                    println!("  {} User: {}", "•".dimmed(), user.cyan());
                                }
                                if let Some(org) = creds["org_slug"].as_str() {
                                    println!("  {} Org: {}", "•".dimmed(), org.cyan());
                                }
                            }
                        }
                        Ok(r) => {
                            println!("{} Server responded with status {}", "⚠".yellow(), r.status());
                        }
                        Err(e) => {
                            println!("{} Cannot reach server: {}", "✗".red().bold(), e);
                        }
                    }
                }
            }
        }
        Commands::Ping => {
            let config = ConfigManager::load();
            let cloud_url = config.cloud_url.as_deref().unwrap_or("");

            if cloud_url.is_empty() {
                println!("{} Not connected to any mothership or server.", "✗".red().bold());
                println!("  Run {} to join a team, or {} to start hosting.", "aura join <token>".cyan(), "aura host start".cyan());
                return Ok(());
            }

            let mut client_builder = reqwest::blocking::Client::builder()
                .timeout(std::time::Duration::from_secs(5));
            if config.accept_self_signed {
                client_builder = client_builder.danger_accept_invalid_certs(true);
            }
            let client = client_builder.build().unwrap_or_else(|_| reqwest::blocking::Client::new());

            // Ping health endpoint with timing
            let start = std::time::Instant::now();
            match client.get(format!("{}/health", cloud_url)).send() {
                Ok(r) if r.status().is_success() => {
                    let latency = start.elapsed();
                    let tls = if cloud_url.starts_with("https://") { "TLS" } else { "HTTP" };

                    println!("\n  {} Mothership is reachable", "✓".green().bold());
                    println!("  {} URL:     {}", "•".dimmed(), cloud_url.cyan());
                    println!("  {} Latency: {}ms", "•".dimmed(), format!("{}", latency.as_millis()).green());
                    println!("  {} Mode:    {}", "•".dimmed(), tls.cyan());

                    // Get credentials for authenticated requests
                    let token = config.cloud_api_token.as_deref().unwrap_or("");
                    if !token.is_empty() {
                        // Fetch presence — who's online
                        if let Ok(resp) = client.get(format!("{}/api/v1/live/presence", cloud_url))
                            .bearer_auth(token)
                            .send()
                        {
                            if let Ok(data) = resp.json::<serde_json::Value>() {
                                let devs = data["developers"].as_array();
                                let total = data["total_active"].as_u64().unwrap_or(0);

                                println!("  {} Online:  {} peer(s)", "•".dimmed(), format!("{}", total).green().bold());

                                if let Some(devs) = devs {
                                    for dev in devs {
                                        let name = dev["username"].as_str().unwrap_or("?");
                                        let branch = dev["branch"].as_str().unwrap_or("?");
                                        let repo = dev["repo"].as_str().unwrap_or("?");
                                        println!("    {} {} on {} ({})", "↳".dimmed(), name.cyan(), branch.yellow(), repo.dimmed());
                                    }
                                }
                            }
                        }

                        // Fetch heartbeat stats
                        let repo_name = live_events::repo_name();
                        let branch = live_events::current_branch();
                        if let Ok(resp) = client.post(format!("{}/api/v1/live/heartbeat", cloud_url))
                            .bearer_auth(token)
                            .json(&serde_json::json!({
                                "repo_full_name": repo_name,
                                "branch": branch,
                            }))
                            .send()
                        {
                            if let Ok(data) = resp.json::<serde_json::Value>() {
                                let impacts = data["pending_impacts"].as_i64().unwrap_or(0);
                                let msgs = data["unread_messages"].as_i64().unwrap_or(0);
                                let sync = data["sync_pending"].as_i64().unwrap_or(0);

                                if impacts > 0 || msgs > 0 || sync > 0 {
                                    println!("\n  {} Pending:", "📬".bold());
                                    if impacts > 0 { println!("    {} {} impact alert(s)", "↳".dimmed(), format!("{}", impacts).red()); }
                                    if msgs > 0 { println!("    {} {} unread message(s)", "↳".dimmed(), format!("{}", msgs).yellow()); }
                                    if sync > 0 { println!("    {} {} function(s) to pull", "↳".dimmed(), format!("{}", sync).blue()); }
                                }
                            }
                        }
                    }
                    println!();
                }
                Ok(r) => {
                    println!("{} Mothership responded with {}", "⚠".yellow(), r.status());
                    println!("  {} URL: {}", "•".dimmed(), cloud_url);
                }
                Err(e) => {
                    let latency = start.elapsed();
                    println!("\n  {} Mothership unreachable ({}ms)", "✗".red().bold(), latency.as_millis());
                    println!("  {} URL: {}", "•".dimmed(), cloud_url);
                    println!("  {} Error: {}\n", "•".dimmed(), format!("{}", e).red());
                }
            }
        }
        Commands::Save { message, no_git } => {
            use colored::Colorize;
            println!("{}", "💾 Aura Save".bold());
            println!();

            // 1. Find modified files
            let modified_files: Vec<String> = if let Ok(repo) = Repository::open(".") {
                let diff = repo.diff_index_to_workdir(None, None)
                    .or_else(|_| {
                        let head = repo.head().ok().and_then(|h| h.peel_to_tree().ok());
                        repo.diff_tree_to_workdir(head.as_ref(), None)
                    });
                match diff {
                    Ok(d) => {
                        let mut files = Vec::new();
                        d.foreach(&mut |delta, _| {
                            if let Some(p) = delta.new_file().path() {
                                files.push(p.to_string_lossy().to_string());
                            }
                            true
                        }, None, None, None).ok();
                        files
                    }
                    Err(_) => vec![],
                }
            } else {
                vec![]
            };

            if modified_files.is_empty() {
                println!("  {} No modified files to save", "ℹ".blue());
                return Ok(());
            }

            // 2. Snapshot each modified file
            for f in &modified_files {
                if std::path::Path::new(f).exists() {
                    let _ = checkpoint::SnapshotStore::snapshot_file(f, "save", "user");
                }
            }
            println!("  {} Snapshotted {} file{}", "✓".green().bold(), modified_files.len(), if modified_files.len() == 1 { "" } else { "s" });

            // 3. Log intent
            let _ = std::fs::create_dir_all(".aura");
            let mut log_entry = serde_json::json!({
                "agent_id": "user",
                "intent": message,
                "timestamp": SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()
            });
            // Stamp the developer (git identity) so the row attributes
            // per-teammate in the Trace team overview.
            let identity = usage_by_dev::dev_identity();
            if !identity.email.is_empty() {
                log_entry["developer"] = serde_json::json!(identity.email);
                log_entry["developer_handle"] = serde_json::json!(identity.handle);
            }
            if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(".aura/intent_log.jsonl") {
                let _ = writeln!(file, "{}", log_entry.to_string());
            }
            let _ = std::fs::write(".gemini.intent", &message);
            let _ = std::fs::write(".aura/.intent_logged", "1");
            println!("  {} Intent logged: {}", "✓".green().bold(), message.dimmed());

            // 4. Git commit (unless --no-git)
            if !*no_git {
                if let Ok(_repo) = Repository::open(".") {
                    let add = std::process::Command::new("git").args(["add", "-A"]).status();
                    if add.map(|s| s.success()).unwrap_or(false) {
                        let commit = std::process::Command::new("git")
                            .args(["commit", "-m", &message])
                            .status();
                        match commit {
                            Ok(s) if s.success() => println!("  {} Git commit created", "✓".green().bold()),
                            _ => println!("  {} Git commit failed (pre-commit hook?)", "⚠".yellow()),
                        }
                    }
                }
            } else {
                println!("  {} Skipped git commit (--no-git)", "•".dimmed());
            }

            // 4b. S0.3 spike — record this save as a Command block in the
            // local block substrate. Best-effort: a store write failure
            // never aborts a save (the rest of the pipeline already
            // succeeded). Visible via `aura blocks list`.
            match block_adapter::emit_save_command(message, &modified_files) {
                Ok(id) => println!("  {} Block recorded: {}", "✓".green().bold(), format!("{:?}", id).dimmed()),
                Err(e) => println!("  {} Block store skipped: {}", "•".dimmed(), e.dimmed()),
            }

            // 5. Auto-push changed functions to mothership
            let mut total_pushed: u64 = 0;
            for file_path in &modified_files {
                if std::path::Path::new(file_path).exists() {
                    if let Ok(source) = std::fs::read_to_string(file_path) {
                        let ext = std::path::Path::new(file_path)
                            .extension().and_then(|e| e.to_str()).unwrap_or("");
                        if let Ok(mut parser) = SemanticParser::new() {
                            if let Ok(nodes) = parser.parse_file(&source, ext) {
                                let payloads: Vec<live_sync::SyncFunctionPayload> = nodes.iter()
                                    .filter_map(|n| {
                                        let ident = n.identifier.as_ref()?;
                                        let body = live_sync::extract_function_body(&source, ident)?;
                                        Some(live_sync::SyncFunctionPayload {
                                            file_path: file_path.clone(),
                                            function_name: ident.clone(),
                                            function_kind: n.kind.clone(),
                                            content_hash: n.content_hash.clone(),
                                            body,
                                            parent_hash: None,
                                            ..Default::default()
                                        })
                                    }).collect();
                                if !payloads.is_empty() {
                                    if let Ok(resp) = live_sync::push_function_bodies(&payloads) {
                                        total_pushed += resp["pushed"].as_u64().unwrap_or(0);
                                    }
                                }
                            }
                        }
                    }
                }
            }
            if total_pushed > 0 {
                println!("  {} Pushed {} functions to team", "🔄".cyan(), total_pushed);
            }

            // 6. Push scaffolds for non-code files (JSON, YAML, text, etc) + code scaffolds
            let mut scaffold_payloads = Vec::new();
            for file_path in &modified_files {
                if std::path::Path::new(file_path.as_str()).exists() {
                    let ft = aura_merge::detect_file_type(file_path);
                    match ft {
                        aura_merge::FileType::Json | aura_merge::FileType::Yaml
                        | aura_merge::FileType::Toml | aura_merge::FileType::Text
                        | aura_merge::FileType::Env => {
                            // Non-code: push entire file as scaffold
                            if let Ok(content) = std::fs::read_to_string(file_path) {
                                use sha2::{Digest, Sha256};
                                let hash = hex::encode(Sha256::digest(content.as_bytes()));
                                scaffold_payloads.push(live_sync::ScaffoldPushPayload {
                                    file_path: file_path.clone(),
                                    content_hash: hash,
                                    content,
                                    file_type: format!("{:?}", ft).to_lowercase(),
                                });
                            }
                        }
                        aura_merge::FileType::Code => {
                            // Code: extract scaffold (non-function parts)
                            if let Ok(source) = std::fs::read_to_string(file_path) {
                                let ext = std::path::Path::new(file_path.as_str())
                                    .extension().and_then(|e| e.to_str()).unwrap_or("");
                                if let Ok(mut parser) = SemanticParser::new() {
                                    if let Ok(nodes) = parser.parse_file(&source, ext) {
                                        let fn_bodies: Vec<(String, String)> = nodes.iter()
                                            .filter_map(|n| {
                                                let ident = n.identifier.as_ref()?;
                                                let body = live_sync::extract_function_body(&source, ident)?;
                                                Some((ident.clone(), body))
                                            }).collect();
                                        let scaffold = aura_merge::extract_scaffold(&source, &fn_bodies);
                                        use sha2::{Digest, Sha256};
                                        let hash = hex::encode(Sha256::digest(scaffold.as_bytes()));
                                        scaffold_payloads.push(live_sync::ScaffoldPushPayload {
                                            file_path: file_path.clone(),
                                            content_hash: hash,
                                            content: scaffold,
                                            file_type: "code".to_string(),
                                        });
                                    }
                                }
                            }
                        }
                        _ => {} // Binary/Ignored — skip
                    }
                }
            }
            if !scaffold_payloads.is_empty() {
                if let Ok(resp) = live_sync::push_scaffolds(&scaffold_payloads) {
                    let pushed = resp["pushed"].as_u64().unwrap_or(0);
                    if pushed > 0 {
                        println!("  {} Pushed {} scaffold{} (imports, config, text files)", "📄".cyan(), pushed, if pushed == 1 { "" } else { "s" });
                    }
                }
            }

            println!();
        }
        Commands::LogIntent { text, file, tool, session, source, intent_type } => {
            // Fire-and-forget intent capture. Called by the post-tool-use hook:
            //   aura log-intent "..." >/dev/null 2>&1 &
            // Appends ONE row to <repo>/.aura/intent_log.jsonl matching the
            // shape `aura save` / the shell's aura_log_intent write, drops the
            // `.aura/.intent_logged` marker, and ALWAYS exits 0. Prints nothing
            // on success; warnings go to stderr only.
            let trimmed = text.trim();
            if trimmed.is_empty() {
                eprintln!("aura log-intent: empty intent, nothing logged");
                return Ok(());
            }

            // Resolve the repo root the way the rest of the CLI does: discover
            // upward from cwd; fall back to "." so the hook never hard-fails.
            let repo_root = Repository::discover(".")
                .ok()
                .and_then(|r| r.workdir().map(|w| w.to_path_buf()))
                .unwrap_or_else(|| std::path::PathBuf::from("."));

            let aura_dir = repo_root.join(".aura");
            if let Err(e) = fs::create_dir_all(&aura_dir) {
                eprintln!("aura log-intent: could not create .aura: {}", e);
                return Ok(());
            }

            let ts = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);

            // Match the existing row shape: {agent_id, intent, timestamp} as
            // the minimum, plus `source` (default "hook_auto") and the optional
            // file/tool/session_id/intent_type fields when supplied. agent_id
            // honours AURA_AGENT if the hook set it, else defaults to
            // "hook_auto" to mark autonomous capture.
            let agent_id = std::env::var("AURA_AGENT")
                .ok()
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "hook_auto".to_string());
            let src = source.clone().unwrap_or_else(|| "hook_auto".to_string());

            let mut entry = serde_json::json!({
                "agent_id": agent_id,
                "intent": trimmed,
                "timestamp": ts,
                "source": src,
            });
            if let Some(f) = file {
                entry["file"] = serde_json::json!(f);
            }
            if let Some(t) = tool {
                entry["tool"] = serde_json::json!(t);
            }
            if let Some(s) = session {
                entry["session_id"] = serde_json::json!(s);
            }
            if let Some(it) = intent_type {
                entry["intent_type"] = serde_json::json!(it);
            }
            // Stamp the developer (git identity) — matches the `aura save`
            // row shape so per-teammate attribution covers hook captures too.
            let identity = usage_by_dev::dev_identity();
            if !identity.email.is_empty() {
                entry["developer"] = serde_json::json!(identity.email);
                entry["developer_handle"] = serde_json::json!(identity.handle);
            }

            let log_path = aura_dir.join("intent_log.jsonl");
            match OpenOptions::new().create(true).append(true).open(&log_path) {
                Ok(mut f) => {
                    if let Err(e) = writeln!(f, "{}", entry) {
                        eprintln!("aura log-intent: write failed: {}", e);
                        return Ok(());
                    }
                }
                Err(e) => {
                    eprintln!("aura log-intent: open {} failed: {}", log_path.display(), e);
                    return Ok(());
                }
            }

            // Drop the marker the pre-commit hook checks, exactly as `aura save`
            // does. Best-effort — a marker write failure is non-fatal.
            let _ = fs::write(aura_dir.join(".intent_logged"), "1");
            // Exit 0, silent on success.
        }
        Commands::SignIntent { text, writes, agent, intent_type } => {
            // Signing-only sibling of `log-intent`: seals the intent into a
            // signed block (+ `.aura/attest/` mirror + key registry) and prints
            // the ids, but writes NO JSONL row. The desktop app shells out here
            // so a native Aura-chat turn seals its intent through the exact same
            // path the MCP `aura_log_intent` tool uses — one signing surface,
            // every capture. Prints `{}` (never errors) when no key is present,
            // so the caller falls back to its unsigned row without breaking.
            let trimmed = text.trim();
            if trimmed.is_empty() {
                println!("{{}}");
                return Ok(());
            }
            // Flatten `--writes a,b --writes c` into one declared-scope list.
            let declared: Vec<String> = writes
                .iter()
                .flat_map(|w| w.split(','))
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect();
            let agent_label = agent
                .as_deref()
                .filter(|s| !s.trim().is_empty())
                .unwrap_or("aura-shell");
            let out = match mcp::sign_intent_best_effort(
                trimmed,
                intent_type.as_deref(),
                &declared,
                agent_label,
            ) {
                Some((block_id, key_id)) => serde_json::json!({
                    "signed_block_id": block_id,
                    "key_id": key_id,
                }),
                None => serde_json::json!({}),
            };
            println!("{}", out);
        }
        Commands::ValidateTool => {
            // Reads a tool-call JSON object from STDIN and prints a single-line
            // gate verdict to STDOUT. All logic (classification, policy
            // evaluation, intent coverage, strict-mode escalation) lives in the
            // validate_tool module so the dispatch stays thin.
            validate_tool::run()?;
        }
        Commands::Blocks { sub } => {
            use colored::Colorize;
            match sub {
                BlocksSubcommands::List { kind, limit, json } => {
                    let kind_filter = kind.as_deref().and_then(|k| {
                        // BlockKind is internally tagged as {"kind": "<wire>"},
                        // so wrap the user's string before deserializing.
                        serde_json::from_value::<aura_blocks::BlockKind>(
                            serde_json::json!({"kind": k}),
                        )
                        .ok()
                    });
                    if kind.is_some() && kind_filter.is_none() {
                        eprintln!("Unknown --kind '{}'. See `aura-blocks::BlockKind`.", kind.as_ref().unwrap());
                        std::process::exit(2);
                    }
                    let blocks = match block_adapter::list_recent(kind_filter, *limit) {
                        Ok(b) => b,
                        Err(e) => {
                            eprintln!("list blocks: {}", e);
                            std::process::exit(1);
                        }
                    };
                    if *json {
                        println!("{}", serde_json::to_string_pretty(&blocks).unwrap_or_else(|_| "[]".into()));
                    } else if blocks.is_empty() {
                        println!("{}", "(no blocks recorded yet — try `aura save \"...\"`)".dimmed());
                    } else {
                        println!("{} {} block{}", "📦".cyan(), blocks.len(), if blocks.len() == 1 { "" } else { "s" });
                        for b in &blocks {
                            println!(
                                "  {} {:?}  {}  {}",
                                format!("{:?}", b.kind).cyan(),
                                b.id,
                                b.intent.summary.dimmed(),
                                format!("@ {}", b.created_at).dimmed(),
                            );
                        }
                    }
                }
            }
        }
        Commands::Share => {
            use colored::Colorize;
            println!("{}", "🔄 Aura Share".bold());
            println!();

            // Find modified files via git diff
            let modified_files: Vec<String> = if let Ok(repo) = Repository::open(".") {
                let diff = repo.diff_index_to_workdir(None, None)
                    .or_else(|_| {
                        let head = repo.head().ok().and_then(|h| h.peel_to_tree().ok());
                        repo.diff_tree_to_workdir(head.as_ref(), None)
                    });
                match diff {
                    Ok(d) => {
                        let mut files = Vec::new();
                        d.foreach(&mut |delta, _| {
                            if let Some(p) = delta.new_file().path() {
                                files.push(p.to_string_lossy().to_string());
                            }
                            true
                        }, None, None, None).ok();
                        files
                    }
                    Err(_) => vec![],
                }
            } else {
                vec![]
            };

            let mut total_pushed: u64 = 0;
            for file_path in &modified_files {
                if std::path::Path::new(file_path).exists() {
                    if let Ok(source) = std::fs::read_to_string(file_path) {
                        let ext = std::path::Path::new(file_path)
                            .extension().and_then(|e| e.to_str()).unwrap_or("");
                        if let Ok(mut parser) = SemanticParser::new() {
                            if let Ok(nodes) = parser.parse_file(&source, ext) {
                                let payloads: Vec<live_sync::SyncFunctionPayload> = nodes.iter()
                                    .filter_map(|n| {
                                        let ident = n.identifier.as_ref()?;
                                        let body = live_sync::extract_function_body(&source, ident)?;
                                        Some(live_sync::SyncFunctionPayload {
                                            file_path: file_path.clone(),
                                            function_name: ident.clone(),
                                            function_kind: n.kind.clone(),
                                            content_hash: n.content_hash.clone(),
                                            body,
                                            parent_hash: None,
                                            ..Default::default()
                                        })
                                    }).collect();
                                if !payloads.is_empty() {
                                    match live_sync::push_function_bodies(&payloads) {
                                        Ok(resp) => {
                                            total_pushed += resp["pushed"].as_u64().unwrap_or(0);
                                        }
                                        Err(e) => {
                                            eprintln!("  {} Push failed for {}: {}",
                                                "✗".red().bold(), file_path, e);
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            if total_pushed > 0 {
                println!("  {} Shared {} functions with team", "✓".green().bold(), total_pushed);
            } else {
                println!("  {} No modified functions to share", "ℹ".blue());
            }
            println!();
        }
        Commands::Pull { dry_run, allow_red } => {
            use colored::Colorize;
            println!("{}", "🔄 Aura Pull".bold());
            println!();

            match live_sync::pull_function_bodies_opts(allow_red.clone()) {
                Ok(resp) => {
                    let functions = resp["functions"].as_array();
                    let total = functions.map(|a| a.len()).unwrap_or(0);

                    if total == 0 {
                        println!("  {} Already up to date — no new changes from teammates", "✓".green().bold());
                        return Ok(());
                    }

                    println!("  {} {} function{} from teammates", "↳".dimmed(), total, if total == 1 { "" } else { "s" });

                    if let Some(funcs) = functions {
                        for f in funcs {
                            let name = f["function_name"].as_str().unwrap_or("?");
                            let file = f["file_path"].as_str().unwrap_or("?");
                            let by = f["pushed_by"].as_str().unwrap_or("?");
                            println!("    {} {}::{} (by {})", "•".dimmed(), file.cyan(), name, by.dimmed());
                        }
                    }

                    if *dry_run {
                        println!("\n  {} Dry run — no files modified", "ℹ".blue());
                    } else {
                        let funcs = resp["functions"].as_array().unwrap();
                        let (applied, skipped, conflicts) = live_sync::apply_pulled_functions(funcs);
                        println!("\n  {} Applied: {}, Skipped: {}, Conflicts: {}",
                            "✓".green().bold(), applied.to_string().green(), skipped, conflicts.len());
                        for c in &conflicts {
                            println!("    {} {}", "⚠".yellow(), c);
                        }
                    }
                }
                Err(e) => eprintln!("  {} Pull failed: {}", "✗".red().bold(), e),
            }
            println!();
        }
        Commands::Merge { branch, dry_run, auto } => {
            use colored::Colorize;
            println!("{} ← {}", "🔀 Aura Merge".bold(), branch.cyan().bold());
            println!();

            // 1. Pull all functions from source branch
            let resp = match live_sync::pull_branch_for_merge(branch) {
                Ok(r) => r,
                Err(e) => {
                    eprintln!("  {} Failed to fetch branch: {}", "✗".red().bold(), e);
                    return Ok(());
                }
            };

            let functions = match resp["functions"].as_array() {
                Some(f) if !f.is_empty() => f.clone(),
                _ => {
                    println!("  {} No functions found on branch '{}'. Has anyone pushed to it?", "ℹ".blue(), branch);
                    return Ok(());
                }
            };

            println!("  {} Found {} function{} on '{}'", "↳".dimmed(), functions.len(), if functions.len() == 1 { "" } else { "s" }, branch.cyan());
            println!();

            // 2. Classify each function
            let actions = live_sync::classify_merge(&functions);

            let adds: Vec<_> = actions.iter().filter(|a| matches!(a, live_sync::MergeAction::Add { .. })).collect();
            let conflicts: Vec<_> = actions.iter().filter(|a| matches!(a, live_sync::MergeAction::Conflict { .. })).collect();
            let identical: Vec<_> = actions.iter().filter(|a| matches!(a, live_sync::MergeAction::Identical { .. })).collect();

            println!("  {} {} new, {} conflicts, {} identical",
                "Summary:".bold(),
                adds.len().to_string().green(),
                conflicts.len().to_string().red(),
                identical.len().to_string().dimmed());
            println!();

            // 3. Show new functions
            if !adds.is_empty() {
                println!("  {} New functions (will be added):", "➕".green());
                for a in &adds {
                    if let live_sync::MergeAction::Add { file_path, function_name, pushed_by, .. } = a {
                        println!("    {} {}::{} (by {})", "•".green(), file_path.cyan(), function_name, pushed_by.dimmed());
                    }
                }
                println!();
            }

            // 4. Show conflicts
            if !conflicts.is_empty() {
                println!("  {} Conflicts (needs resolution):", "⚠".yellow());
                for c in &conflicts {
                    if let live_sync::MergeAction::Conflict { file_path, function_name, pushed_by, .. } = c {
                        println!("    {} {}::{} (by {})", "•".red(), file_path.cyan(), function_name, pushed_by.dimmed());
                    }
                }
                println!();
            }

            if *dry_run {
                println!("  {} Dry run — no files modified", "ℹ".blue());
                return Ok(());
            }

            // 5. Apply new functions (auto)
            let mut applied = 0;
            for a in &adds {
                if let live_sync::MergeAction::Add { file_path, function_name, body, .. } = a {
                    // Snapshot before modifying
                    if std::path::Path::new(file_path.as_str()).exists() {
                        let _ = checkpoint::SnapshotStore::snapshot_file(file_path, "merge", "aura-merge");
                        if let Ok(source) = std::fs::read_to_string(file_path) {
                            match live_sync::splice_function_public(&source, function_name, body) {
                                Ok(new_content) => {
                                    let _ = std::fs::write(file_path, new_content);
                                    applied += 1;
                                }
                                Err(_) => {
                                    // Append if splice can't find it (truly new)
                                    let mut content = std::fs::read_to_string(file_path).unwrap_or_default();
                                    content.push_str("\n\n");
                                    content.push_str(body);
                                    content.push('\n');
                                    let _ = std::fs::write(file_path, content);
                                    applied += 1;
                                }
                            }
                        }
                    } else {
                        // New file
                        if let Some(parent) = std::path::Path::new(file_path.as_str()).parent() {
                            let _ = std::fs::create_dir_all(parent);
                        }
                        let _ = std::fs::write(file_path, format!("{}\n", body));
                        applied += 1;
                    }
                }
            }

            // 6. Resolve conflicts interactively
            let mut resolved = 0;
            for c in &conflicts {
                if let live_sync::MergeAction::Conflict { file_path, function_name, local_body, remote_body, pushed_by } = c {
                    if *auto {
                        // Auto mode: keep local (safe default)
                        println!("    {} {}::{} — kept local (auto mode)", "•".dimmed(), file_path, function_name);
                        resolved += 1;
                        continue;
                    }

                    println!("\n  {} {}::{}", "CONFLICT".red().bold(), file_path.cyan(), function_name.bold());
                    println!("  {} Local (yours):", "─".dimmed());
                    for line in local_body.lines().take(8) {
                        println!("    {}", line.green());
                    }
                    if local_body.lines().count() > 8 {
                        println!("    {} ... ({} more lines)", "".dimmed(), local_body.lines().count() - 8);
                    }
                    println!("  {} Remote ({} on {}):", "─".dimmed(), pushed_by.cyan(), branch.cyan());
                    for line in remote_body.lines().take(8) {
                        println!("    {}", line.red());
                    }
                    if remote_body.lines().count() > 8 {
                        println!("    {} ... ({} more lines)", "".dimmed(), remote_body.lines().count() - 8);
                    }

                    // Interactive choice
                    let choice = dialoguer::Select::with_theme(&dialoguer::theme::ColorfulTheme::default())
                        .with_prompt("  Resolution")
                        .items(&["Keep local (yours)", "Accept remote (theirs)", "Keep both (side by side)"])
                        .default(0)
                        .interact()
                        .unwrap_or(0);

                    match choice {
                        0 => {
                            println!("    {} Kept local", "✓".green());
                        }
                        1 => {
                            // Accept remote — splice it in
                            let _ = checkpoint::SnapshotStore::snapshot_file(file_path, "merge_conflict", "aura-merge");
                            if let Ok(source) = std::fs::read_to_string(file_path) {
                                if let Ok(new_content) = live_sync::splice_function_public(&source, function_name, remote_body) {
                                    let _ = std::fs::write(file_path, new_content);
                                }
                            }
                            println!("    {} Accepted remote", "✓".green());
                        }
                        2 => {
                            // Keep both — add remote as a commented alternative
                            let _ = checkpoint::SnapshotStore::snapshot_file(file_path, "merge_both", "aura-merge");
                            if let Ok(mut source) = std::fs::read_to_string(file_path) {
                                source.push_str(&format!(
                                    "\n\n// ─── MERGE CONFLICT: {} (from branch '{}' by {}) ───\n// Uncomment to use the remote version:\n",
                                    function_name, branch, pushed_by
                                ));
                                for line in remote_body.lines() {
                                    source.push_str(&format!("// {}\n", line));
                                }
                                let _ = std::fs::write(file_path, source);
                            }
                            println!("    {} Kept both (remote commented out)", "✓".green());
                        }
                        _ => {}
                    }
                    resolved += 1;
                }
            }

            // 7. Merge scaffolds (non-code files: JSON, YAML, text, etc)
            let mut scaffold_merged = 0;
            let mut scaffold_conflicts = 0;
            if let Some(scaffolds) = resp["scaffolds"].as_array() {
                for s in scaffolds {
                    let file_path = s["file_path"].as_str().unwrap_or("");
                    let remote_content = s["content"].as_str().unwrap_or("");
                    let file_type = s["file_type"].as_str().unwrap_or("text");
                    let pushed_by = s["pushed_by"].as_str().unwrap_or("?");

                    if file_path.is_empty() || remote_content.is_empty() { continue; }
                    if *dry_run {
                        println!("    {} {} ({}, by {})", "📄".dimmed(), file_path.cyan(), file_type, pushed_by.dimmed());
                        scaffold_merged += 1;
                        continue;
                    }

                    let local_content = std::fs::read_to_string(file_path).unwrap_or_default();
                    if local_content.is_empty() {
                        // New file from source branch
                        if let Some(parent) = std::path::Path::new(file_path).parent() {
                            let _ = std::fs::create_dir_all(parent);
                        }
                        let _ = std::fs::write(file_path, remote_content);
                        scaffold_merged += 1;
                        continue;
                    }

                    // Use merge engine
                    match aura_merge::merge_file(file_path, &local_content, remote_content, None) {
                        aura_merge::MergeResult::Merged(result) => {
                            let _ = checkpoint::SnapshotStore::snapshot_file(file_path, "merge", "aura-merge");
                            let _ = std::fs::write(file_path, result);
                            println!("    {} {} — merged cleanly", "✓".green(), file_path.cyan());
                            scaffold_merged += 1;
                        }
                        aura_merge::MergeResult::Conflicts { merged, conflict_count, conflict_details } => {
                            let _ = checkpoint::SnapshotStore::snapshot_file(file_path, "merge_conflict", "aura-merge");
                            let _ = std::fs::write(file_path, &merged);
                            println!("    {} {} — {} conflict{} (markers inserted)", "⚠".yellow(), file_path.cyan(), conflict_count, if conflict_count == 1 { "" } else { "s" });
                            for cd in &conflict_details {
                                println!("      {} at {}", "↳".dimmed(), cd.location);
                            }
                            scaffold_conflicts += conflict_count;
                        }
                        aura_merge::MergeResult::Identical => {
                            // Skip
                        }
                        aura_merge::MergeResult::CannotMerge(reason) => {
                            println!("    {} {} — {}", "⚠".yellow(), file_path.cyan(), reason);
                        }
                    }
                }
            }

            println!("\n  {} Merge complete:", "✓".green().bold());
            println!("    Functions: {} applied, {} conflicts resolved, {} identical",
                applied.to_string().green(), resolved, identical.len());
            if scaffold_merged > 0 || scaffold_conflicts > 0 {
                println!("    Files: {} merged, {} conflicts",
                    scaffold_merged.to_string().green(), scaffold_conflicts);
            }
            println!();
        }
        Commands::Diff { file } => {
            use colored::Colorize;
            println!("{}", "🔍 Aura Diff — Semantic Changes".bold());
            println!();

            // Get files to diff
            let files_to_diff: Vec<String> = if let Some(f) = file {
                vec![f.clone()]
            } else if let Ok(repo) = Repository::open(".") {
                let diff = repo.diff_index_to_workdir(None, None)
                    .or_else(|_| {
                        let head = repo.head().ok().and_then(|h| h.peel_to_tree().ok());
                        repo.diff_tree_to_workdir(head.as_ref(), None)
                    });
                match diff {
                    Ok(d) => {
                        let mut files = Vec::new();
                        d.foreach(&mut |delta, _| {
                            if let Some(p) = delta.new_file().path() {
                                files.push(p.to_string_lossy().to_string());
                            }
                            true
                        }, None, None, None).ok();
                        files
                    }
                    Err(_) => vec![],
                }
            } else {
                vec![]
            };

            if files_to_diff.is_empty() {
                println!("  {} No modified files", "✓".green().bold());
                return Ok(());
            }

            let mut total_changes = 0;
            for file_path in &files_to_diff {
                if !std::path::Path::new(file_path).exists() { continue; }
                let ext = std::path::Path::new(file_path)
                    .extension().and_then(|e| e.to_str()).unwrap_or("");
                let source = match std::fs::read_to_string(file_path) {
                    Ok(s) => s,
                    Err(_) => continue,
                };

                if let Ok(mut parser) = SemanticParser::new() {
                    if let Ok(nodes) = parser.parse_file(&source, ext) {
                        // Baseline to diff against: prefer the most recent durable
                        // snapshot; if there is none (e.g. a repo adopted mid-stream
                        // where commits bypassed Aura), fall back to the file's
                        // committed state at git HEAD. Only when BOTH are absent is
                        // the file genuinely new/untracked.
                        let snapshots = checkpoint::SnapshotStore::get_snapshots_for_file(file_path);
                        let baseline: Option<String> = snapshots
                            .first()
                            .map(|snap| snap.content.clone())
                            .or_else(|| {
                                let repo = Repository::open(".").ok()?;
                                let head_tree = repo.head().ok()?.peel_to_tree().ok()?;
                                let entry = head_tree
                                    .get_path(std::path::Path::new(file_path))
                                    .ok()?;
                                let obj = entry.to_object(&repo).ok()?;
                                let blob = obj.as_blob()?;
                                std::str::from_utf8(blob.content()).ok().map(String::from)
                            });
                        if let Some(old_source) = baseline {
                            if let Ok(old_nodes) = parser.parse_file(&old_source, ext) {
                                // Compare
                                let mut cache = live_events::AstStateCache::new();
                                cache.mark_initial_scan_done();
                                let _ = cache.diff_and_update(file_path, &old_nodes);
                                let changes = cache.diff_and_update(file_path, &nodes);

                                if !changes.is_empty() {
                                    println!("  {} {}", "📄".bold(), file_path.cyan());
                                    for c in &changes {
                                        let symbol = match c.change_type {
                                            live_events::ChangeType::Added => "+".green().to_string(),
                                            live_events::ChangeType::Modified => "~".yellow().to_string(),
                                            live_events::ChangeType::Deleted => "-".red().to_string(),
                                        };
                                        println!("    {} {} {} ({})", symbol, c.kind, c.name.bold(), format!("{:?}", c.change_type).dimmed());
                                        total_changes += 1;
                                    }
                                    println!();
                                }
                            }
                        } else {
                            // No baseline (no snapshot AND not present at git HEAD)
                            // — this file is genuinely new/untracked.
                            println!("  {} {} (new file — {} functions)", "📄".bold(), file_path.cyan(), nodes.len());
                            total_changes += nodes.len();
                        }
                    }
                }
            }
            if total_changes == 0 {
                println!("  {} No semantic changes detected", "✓".green().bold());
            } else {
                println!("  {} {} function-level change{}", "Summary:".bold(), total_changes, if total_changes == 1 { "" } else { "s" });
            }
            println!();
        }
        Commands::History { file, limit } => {
            use colored::Colorize;
            println!("{}", "📜 Aura History — Semantic Timeline".bold());
            println!();

            // Read local intent log
            let intent_path = ".aura/intent_log.jsonl";
            if let Ok(content) = std::fs::read_to_string(intent_path) {
                let mut entries: Vec<serde_json::Value> = content.lines()
                    .filter_map(|line| serde_json::from_str(line).ok())
                    .collect();
                entries.reverse(); // newest first
                entries.truncate(*limit);

                if entries.is_empty() {
                    println!("  {} No history yet. Use `aura save` to start tracking.", "ℹ".blue());
                } else {
                    for entry in &entries {
                        let agent = entry["agent_id"].as_str().unwrap_or("?");
                        let intent = entry["intent"].as_str().unwrap_or("?");
                        let ts = entry["timestamp"].as_u64().unwrap_or(0);
                        let date = chrono::DateTime::from_timestamp(ts as i64, 0)
                            .map(|d| d.format("%Y-%m-%d %H:%M").to_string())
                            .unwrap_or_else(|| "?".to_string());
                        println!("  {} {} by {}", date.dimmed(), intent, agent.cyan());
                    }
                }
            } else {
                println!("  {} No intent history found", "ℹ".blue());
            }

            // Also try mothership history if connected
            if let Ok(resp) = live_sync::query_team_knowledge(None, None, 0) {
                // Will be replaced with proper history route in Phase 3
                let _ = resp;
            }

            let _ = file; // Will be used for filtering in Phase 3
            println!();
        }
        Commands::Trace { function } => {
            use colored::Colorize;
            println!("{} {}", "🔎 Aura Trace —".bold(), function.cyan().bold());
            println!();

            // Search local intent log for mentions of this function
            let intent_path = ".aura/intent_log.jsonl";
            let mut found = 0;
            if let Ok(content) = std::fs::read_to_string(intent_path) {
                let entries: Vec<serde_json::Value> = content.lines()
                    .filter_map(|line| serde_json::from_str(line).ok())
                    .collect();
                for entry in entries.iter().rev() {
                    let intent = entry["intent"].as_str().unwrap_or("");
                    if intent.to_lowercase().contains(&function.to_lowercase()) {
                        let agent = entry["agent_id"].as_str().unwrap_or("?");
                        let ts = entry["timestamp"].as_u64().unwrap_or(0);
                        let date = chrono::DateTime::from_timestamp(ts as i64, 0)
                            .map(|d| d.format("%Y-%m-%d %H:%M").to_string())
                            .unwrap_or_else(|| "?".to_string());
                        println!("  {} {} — {}", date.dimmed(), agent.cyan(), intent);
                        found += 1;
                    }
                }
            }

            // Search snapshots for this function
            let snapshots = checkpoint::SnapshotStore::get_all_snapshots();
            let mut fn_snapshots = 0;
            for snap in &snapshots {
                if snap.content.contains(&*function) {
                    fn_snapshots += 1;
                }
            }

            if found == 0 && fn_snapshots == 0 {
                println!("  {} No trace found for '{}'. Full team trace available in v0.14 (mothership history).", "ℹ".blue(), function);
            } else {
                if fn_snapshots > 0 {
                    println!("\n  {} Found in {} snapshot{}", "•".dimmed(), fn_snapshots, if fn_snapshots == 1 { "" } else { "s" });
                }
                println!("  {} Full team trace with mothership history coming in Phase 3", "•".dimmed());
            }
            println!();
        }
        Commands::Team { sub } => {
            match sub {
                TeamSubcommands::Link => {
                    let repo = live_sync::repo_name_from_cwd();
                    if repo.is_empty() {
                        eprintln!("{} Not inside a git repo", "✗".red().bold());
                    } else {
                        let mut config = ConfigManager::load();
                        if !config.team_repos.contains(&repo) {
                            config.team_repos.push(repo.clone());
                            let _ = ConfigManager::save(&config);
                        }
                        println!("{} Repo '{}' is now team-managed", "✓".green().bold(), repo.cyan());

                        // Also register the repo on the mothership so msg/sync routes don't 404
                        let cloud_url = config.cloud_url.clone().unwrap_or_default();
                        let cloud_token = config.cloud_api_token.clone().unwrap_or_default();
                        if !cloud_url.is_empty() && !cloud_token.is_empty() {
                            let cred_dir = directories::ProjectDirs::from("com", "naridon", "aura")
                                .map(|d| d.config_dir().to_path_buf())
                                .unwrap_or_else(|| std::path::PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| ".".to_string())).join(".aura"));
                            let creds: serde_json::Value = fs::read_to_string(cred_dir.join("credentials.json"))
                                .ok()
                                .and_then(|s| serde_json::from_str(&s).ok())
                                .unwrap_or_default();
                            let org_slug = creds["org_slug"].as_str().unwrap_or("");
                            if !org_slug.is_empty() {
                                let client = cloud_http_client();
                                let resp = client.post(format!("{}/api/v1/orgs/{}/repos", cloud_url, org_slug))
                                    .bearer_auth(&cloud_token)
                                    .json(&serde_json::json!({ "repo_name": repo }))
                                    .send();
                                match resp {
                                    Ok(r) if r.status().is_success() => {
                                        println!("  {} Registered on mothership", "✓".green());
                                    }
                                    Ok(r) => {
                                        println!("  {} Mothership register returned {}", "⚠".yellow(), r.status());
                                    }
                                    Err(e) => {
                                        println!("  {} Could not reach mothership: {}", "⚠".yellow(), e);
                                    }
                                }
                            }
                        }

                        println!("  {} It will sync through the mothership", "•".dimmed());
                    }
                }
                TeamSubcommands::Unlink => {
                    let repo = live_sync::repo_name_from_cwd();
                    if repo.is_empty() {
                        eprintln!("{} Not inside a git repo", "✗".red().bold());
                    } else {
                        let mut config = ConfigManager::load();
                        config.team_repos.retain(|r| r != &repo);
                        let _ = ConfigManager::save(&config);
                        println!("{} Repo '{}' unlinked from team", "✓".green().bold(), repo.cyan());
                    }
                }
                TeamSubcommands::Status => {
                    let config = ConfigManager::load();
                    let current_repo = live_sync::repo_name_from_cwd();
                    let is_team = config.team_repos.contains(&current_repo);

                    println!("\n  {} {}", "🤝", "Team Status".bold());

                    if !current_repo.is_empty() {
                        if is_team {
                            println!("  {} Current repo: {} ({})", "●".green(), current_repo.cyan(), "team-managed".green());
                        } else {
                            println!("  {} Current repo: {} ({})", "●".yellow(), current_repo.cyan(), "personal".yellow());
                        }
                    }

                    live_sync::print_mothership_status_line();

                    if config.team_repos.is_empty() {
                        println!("  {} No team-managed repos. Use {} to link.", "•".dimmed(), "aura team link".cyan());
                    } else {
                        println!("  {} Team repos ({}):", "•".dimmed(), config.team_repos.len());
                        for r in &config.team_repos {
                            let marker = if r == &current_repo { " ← here" } else { "" };
                            println!("    {} {}{}", "•".dimmed(), r.cyan(), marker.dimmed());
                        }
                    }
                    println!();
                }
                TeamSubcommands::Knowledge { sub: ksub } => {
                    match ksub {
                        KnowledgeSubcommands::Store { question, answer, category, tags } => {
                            match live_sync::store_team_knowledge(question, answer, Some(category), tags, "human") {
                                Ok(resp) => {
                                    let id = resp["id"].as_str().unwrap_or("?");
                                    println!("{} Knowledge stored (id: {})", "✓".green().bold(), id.dimmed());
                                }
                                Err(e) => eprintln!("{} Failed: {}", "✗".red().bold(), e),
                            }
                            let cfg = crate::config::ConfigManager::load();
                            if cfg.sync_enabled && cfg.cloud_api_token.is_some() {
                                crate::sync::GlobalSync::push_memory_entry(
                                    category,
                                    Some(question),
                                    answer,
                                    None,
                                );
                            }
                        }
                        KnowledgeSubcommands::Query { search, category, limit, json } => {
                            match live_sync::query_team_knowledge(search.as_deref(), category.as_deref(), *limit) {
                                Ok(resp) => {
                                    if *json {
                                        println!("{}", serde_json::to_string(&resp).unwrap_or_else(|_| "{}".to_string()));
                                    } else {
                                        let results = resp["results"].as_array();
                                        let total = results.map(|a| a.len()).unwrap_or(0);
                                        println!("\n  {} Team Knowledge ({} result{})", "Knowledge".bold(), total, if total == 1 { "" } else { "s" });
                                        if let Some(items) = results {
                                            for item in items {
                                                let q = item["question"].as_str().unwrap_or("?");
                                                let a = item["answer"].as_str().unwrap_or("");
                                                let by = item["username"].as_str().unwrap_or("?");
                                                let cat = item["category"].as_str().unwrap_or("");
                                                let up = item["upvotes"].as_i64().unwrap_or(0);
                                                let id = item["id"].as_str().unwrap_or("");
                                                println!("  {} [{}] {} (by {}, {} upvotes)", "Q:".cyan().bold(), cat.dimmed(), q, by.dimmed(), up);
                                                println!("  {} {}", "A:".green().bold(), a);
                                                println!("     {}", format!("id: {}", id).dimmed());
                                                println!();
                                            }
                                        }
                                    }
                                }
                                Err(e) => eprintln!("{} Failed: {}", "✗".red().bold(), e),
                            }
                        }
                        KnowledgeSubcommands::Upvote { id } => {
                            match live_sync::upvote_team_knowledge(id) {
                                Ok(_) => println!("{} Upvoted", "✓".green().bold()),
                                Err(e) => eprintln!("{} Failed: {}", "✗".red().bold(), e),
                            }
                        }
                    }
                }
                TeamSubcommands::Zones { sub: zsub } => {
                    match zsub {
                        ZoneSubcommands::Claim { patterns, mode, label } => {
                            // Claim locally first. The local sentinel is what
                            // stops the next `aura snapshot`, so a claim that
                            // only reached the mothership protected nothing on
                            // the machine doing the editing — and on a cloud
                            // without the zones endpoint it protected nothing
                            // anywhere.
                            let session_id = session::SessionManager::get_active_session()
                                .map(|s| s.session_id)
                                .unwrap_or_else(crate::sentinel::SentinelManager::cli_session_id);
                            let zone_mode = if mode == "block" {
                                crate::sentinel::ZoneMode::Block
                            } else {
                                crate::sentinel::ZoneMode::Warn
                            };
                            let local = crate::sentinel::SentinelManager::create_zone(
                                &session_id, patterns.clone(), zone_mode,
                            );
                            println!("{} Zone claimed (id: {})", "✓".green().bold(), local.zone_id.dimmed());
                            for p in patterns {
                                println!("  {} {} ({})", "•".dimmed(), p.cyan(), mode);
                            }
                            // A zone lasts as long as this session does. Saying
                            // so here is the difference between a claim people
                            // trust and one they re-take "just in case".
                            println!("  {} held while this session is alive · {} to drop it",
                                "•".dimmed(),
                                format!("aura team zones release {}", local.zone_id).cyan());
                            if let Err(e) = live_sync::create_remote_zone(patterns, mode, label.as_deref()) {
                                println!("  {} not shared with the team: {}", "•".dimmed(), e.dimmed());
                            }
                            let cfg = crate::config::ConfigManager::load();
                            if cfg.sync_enabled && cfg.cloud_api_token.is_some() {
                                for p in patterns {
                                    crate::sync::GlobalSync::push_zone(p, mode);
                                }
                            }
                        }
                        ZoneSubcommands::List { json } => {
                            // Local first, because local is what enforces. This
                            // command used to ask the mothership only — and on
                            // a cloud without that endpoint it answered
                            // "Invalid response: error decoding response body"
                            // while a local zone was actively warning on every
                            // snapshot. A list you can't get is how a zone
                            // becomes un-releasable.
                            let views = crate::sentinel::SentinelManager::list_zone_views();
                            let remote = live_sync::fetch_remote_zones();

                            if *json {
                                let local = views.iter().map(|v| serde_json::json!({
                                    "zone_id": v.zone.zone_id,
                                    "session_id": v.zone.session_id,
                                    "patterns": v.zone.patterns,
                                    "mode": format!("{:?}", v.zone.mode).to_lowercase(),
                                    "worktree": v.zone.worktree,
                                    "enforced": v.live,
                                    "age_secs": v.age_secs,
                                    "owner_alive": v.owner_alive,
                                })).collect::<Vec<_>>();
                                println!("{}", serde_json::to_string_pretty(&serde_json::json!({
                                    "zones": local,
                                    "remote": remote.as_ref().ok(),
                                    "remote_error": remote.as_ref().err(),
                                }))?);
                                return Ok(());
                            }

                            let live = views.iter().filter(|v| v.live).count();
                            println!("\n  {} ({} in force, {} total)", "Sentinel Zones".bold(), live, views.len());
                            if views.is_empty() {
                                println!("  {} Nothing claimed. {} to claim one.",
                                    "•".dimmed(), "aura team zones claim <pattern>".cyan());
                            }
                            for v in &views {
                                let mode = format!("{:?}", v.zone.mode).to_lowercase();
                                let mode_display = if mode == "block" { mode.red().to_string() } else { mode.yellow().to_string() };
                                let who = v.zone.worktree.clone()
                                    .or_else(|| v.owner_worktree.clone())
                                    .unwrap_or_else(|| "main".to_string());
                                let state = if v.live {
                                    "in force".green().to_string()
                                } else {
                                    // Say which of the two ways it lapsed, so
                                    // the answer to "why did this stop?" isn't
                                    // a guess.
                                    match v.owner_alive {
                                        Some(false) => "expired — session gone".dimmed().to_string(),
                                        _ => "expired — idle too long".dimmed().to_string(),
                                    }
                                };
                                println!("  {} {} [{}] {} — {}",
                                    "•".dimmed(), who.cyan(), mode_display,
                                    v.zone.patterns.join(", "), state);
                                println!("     {}", format!(
                                    "id: {} · session {} · claimed {}",
                                    v.zone.zone_id, v.zone.session_id, human_age(v.age_secs)
                                ).dimmed());
                            }
                            if let Err(e) = &remote {
                                println!("  {} team-wide zones unavailable: {}", "•".dimmed(), e.dimmed());
                            }
                            println!();
                        }
                        ZoneSubcommands::Release { zone_id } => {
                            // Release where it binds. The remote copy is worth
                            // clearing too, but a release that only reached the
                            // mothership left the warning firing locally and
                            // reported success — which is the version of this
                            // command that made zones feel unfixable.
                            let local = crate::sentinel::SentinelManager::release_zone(zone_id);
                            let remote = live_sync::delete_remote_zone(zone_id);
                            match (local, remote.is_ok()) {
                                (true, _) => println!("{} Zone {} released", "✓".green().bold(), zone_id.dimmed()),
                                (false, true) => println!("{} Zone {} released on the team board (nothing local by that id)",
                                    "✓".green().bold(), zone_id.dimmed()),
                                (false, false) => eprintln!("{} No zone {} here. {} to see what is claimed.",
                                    "✗".red().bold(), zone_id, "aura team zones list".cyan()),
                            }
                        }
                        ZoneSubcommands::Check { file_path } => {
                            // The local answer is the one that will actually
                            // stop you, so give it first and unconditionally.
                            let session_id = session::SessionManager::get_active_session()
                                .map(|s| s.session_id)
                                .unwrap_or_else(crate::sentinel::SentinelManager::cli_session_id);
                            match crate::sentinel::SentinelManager::check_zone(&session_id, file_path) {
                                Some(z) => {
                                    let mode = format!("{:?}", z.mode).to_lowercase();
                                    println!("  {} claimed by {} [{}] — {}",
                                        "⚠".yellow(),
                                        z.worktree.clone().unwrap_or_else(|| "main".into()).cyan(),
                                        if mode == "block" { mode.red().to_string() } else { mode.yellow().to_string() },
                                        z.patterns.join(", "));
                                    println!("     {}", format!("id: {} · session {}", z.zone_id, z.session_id).dimmed());
                                }
                                // `check_zone` skips your own zones, which is
                                // right for enforcement and confusing to read
                                // straight after claiming one. Say which of the
                                // two "no" answers this is.
                                None => {
                                    match crate::sentinel::SentinelManager::own_zone(&session_id, file_path) {
                                        Some(z) => println!("{} {} is in your own zone {} — nobody else may touch it",
                                            "✓".green().bold(), file_path.cyan(), z.zone_id.dimmed()),
                                        None => println!("{} No zone holds {} here", "✓".green().bold(), file_path.cyan()),
                                    }
                                }
                            }
                            match live_sync::check_remote_zone(file_path) {
                                Ok(resp) => {
                                    let blocked = resp["blocked"].as_bool().unwrap_or(false);
                                    let conflicts = resp["conflicts"].as_array();
                                    if let Some(items) = conflicts {
                                        if items.is_empty() {
                                            println!("{} No zone conflicts for {}", "✓".green().bold(), file_path.cyan());
                                        } else {
                                            for c in items {
                                                let user = c["username"].as_str().unwrap_or("?");
                                                let mode = c["mode"].as_str().unwrap_or("warn");
                                                println!("  {} {} has claimed this area [{}]", "⚠".yellow(), user.cyan(), mode);
                                            }
                                            if blocked {
                                                println!("  {} Editing this file is {}", "✗".red().bold(), "blocked".red().bold());
                                            }
                                        }
                                    }
                                }
                                // Not a failure of the command — the local
                                // answer above already stands on its own.
                                Err(e) => println!("  {} team-wide zones unavailable: {}", "•".dimmed(), e.dimmed()),
                            }
                        }
                    }
                }
                TeamSubcommands::Responder { sub: rsub } => {
                    match rsub {
                        ResponderSubcommands::Enable { command, cooldown, daily_cap, resume_session } => {
                            let mut config = ConfigManager::load();
                            config.auto_responder = Some(config::AutoResponderConfig {
                                enabled: true,
                                command: command.clone(),
                                cooldown_secs: *cooldown,
                                daily_cap: *daily_cap,
                                resume_session: resume_session.clone(),
                            });
                            let _ = ConfigManager::save(&config);
                            println!("{} Auto-responder enabled", "✓".green().bold());
                            println!("  {} Command:    {}", "•".dimmed(), command.cyan());
                            println!("  {} Cooldown:   {}s", "•".dimmed(), cooldown);
                            println!("  {} Daily cap:  {}", "•".dimmed(), daily_cap);
                            if let Some(s) = resume_session {
                                println!("  {} Resume:     {}", "•".dimmed(), s.cyan());
                            }
                            println!("\n  {} Background `{}` will spawn when team messages arrive.", "ℹ".blue(), command);
                            println!("  {} Make sure `aura live start` is running.", "ℹ".blue());
                        }
                        ResponderSubcommands::Disable => {
                            let mut config = ConfigManager::load();
                            if let Some(r) = config.auto_responder.as_mut() {
                                r.enabled = false;
                            }
                            let _ = ConfigManager::save(&config);
                            println!("{} Auto-responder disabled", "✓".green().bold());
                        }
                        ResponderSubcommands::Status => {
                            let config = ConfigManager::load();
                            println!("\n  {} Auto-Responder", "Responder".bold());
                            match config.auto_responder.as_ref() {
                                Some(r) if r.enabled => {
                                    println!("  {} Status:    {}", "●".green(), "enabled".green());
                                    println!("  {} Command:   {}", "•".dimmed(), r.command.cyan());
                                    println!("  {} Cooldown:  {}s", "•".dimmed(), r.cooldown_secs);
                                    println!("  {} Daily cap: {}", "•".dimmed(), r.daily_cap);
                                    if let Some(s) = r.resume_session.as_ref() {
                                        println!("  {} Resume:    {}", "•".dimmed(), s.cyan());
                                    }
                                }
                                _ => {
                                    println!("  {} Status:    {}", "●".yellow(), "disabled".yellow());
                                    println!("  {} Enable with: {}", "•".dimmed(), "aura team responder enable".cyan());
                                }
                            }
                            // Show today's spawn count if state file exists
                            if let Ok(s) = std::fs::read_to_string(".aura/live/responder_state.json") {
                                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&s) {
                                    let count = v["daily_count"].as_u64().unwrap_or(0);
                                    let last = v["last_spawn_at"].as_u64().unwrap_or(0);
                                    println!("  {} Today:     {} spawn(s)", "•".dimmed(), count);
                                    if last > 0 {
                                        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
                                        println!("  {} Last:      {}s ago", "•".dimmed(), now.saturating_sub(last));
                                    }
                                }
                            }
                            println!();
                        }
                    }
                }
            }
        }
        Commands::Host { sub } => {
            match sub {
                HostSubcommands::Start { port, tunnel, no_tls, foreground, install } => {
                    if *install {
                        // Install macOS LaunchAgent for auto-start on login
                        if let Err(e) = host::install_launchagent(*port, *no_tls) {
                            eprintln!("{} Failed to install LaunchAgent: {}", "✗".red().bold(), e);
                        }
                    } else if *foreground {
                        // Foreground (blocking) mode — used by daemon child + LaunchAgent
                        let rt = tokio::runtime::Runtime::new().unwrap();
                        rt.block_on(async {
                            if let Err(e) = host::start_mothership(*port, *tunnel, *no_tls).await {
                                eprintln!("{} Mothership failed: {}", "✗".red().bold(), e);
                            }
                        });
                    } else {
                        // Default: daemon mode — fork to background
                        if let Err(e) = host::daemonize(*port, *tunnel, *no_tls) {
                            eprintln!("{} Failed to start daemon: {}", "✗".red().bold(), e);
                        }
                    }
                }
                HostSubcommands::Invite { for_user, max_uses, expires_hours } => {
                    let db_path = format!("{}/.aura/mothership.db", std::env::var("HOME").unwrap_or_else(|_| ".".to_string()));
                    match host_db::init_db(&db_path) {
                        Ok(conn) => {
                            // Get first org (mothership admin's org)
                            let orgs: Vec<host_db::Organization> = {
                                let mut stmt = conn.prepare("SELECT id, slug, name, created_at, updated_at FROM organizations LIMIT 1").unwrap();
                                stmt.query_map([], |row| {
                                    Ok(host_db::Organization {
                                        id: row.get(0)?, slug: row.get(1)?, name: row.get(2)?,
                                        created_at: row.get(3)?, updated_at: row.get(4)?,
                                    })
                                }).unwrap().filter_map(|r| r.ok()).collect()
                            };

                            if let Some(org) = orgs.first() {
                                // Get first user as creator
                                let creator: String = conn.query_row(
                                    "SELECT id FROM users LIMIT 1", [], |row| row.get(0)
                                ).unwrap_or_else(|_| "unknown".to_string());

                                match host_db::create_invite_code(&conn, &org.id, &creator, *max_uses, *expires_hours, for_user.as_deref()) {
                                    Ok(invite) => {
                                        // Detect IP
                                        let ip = {
                                            if let Ok(socket) = std::net::UdpSocket::bind("0.0.0.0:0") {
                                                if socket.connect("8.8.8.8:80").is_ok() {
                                                    if let Ok(addr) = socket.local_addr() {
                                                        addr.ip().to_string()
                                                    } else { "localhost".to_string() }
                                                } else { "localhost".to_string() }
                                            } else { "localhost".to_string() }
                                        };
                                        let fp = std::fs::read_to_string(
                                            format!("{}/.aura/mothership_fingerprint", std::env::var("HOME").unwrap_or_default())
                                        ).unwrap_or_default().trim().to_string();
                                        let scheme = if fp.is_empty() { "http" } else { "https" };
                                        let url = format!("{}://{}:7700", scheme, ip);
                                        let token = host::JoinToken { url, code: invite.code.clone(), fp };

                                        println!("\n  {} Join token generated", "✓".green().bold());
                                        if let Some(ref name) = invite.for_username {
                                            println!("  {} Locked to: {}", "🔒".bold(), name.cyan());
                                        }
                                        println!("  {} Uses: {}/{}", "•".dimmed(), invite.uses, invite.max_uses);
                                        println!("  {} Expires: {}", "•".dimmed(), invite.expires_at);
                                        println!("\n  Send this to your teammate:\n");
                                        println!("    aura join {}\n", token.encode());
                                    }
                                    Err(e) => eprintln!("{} Failed to create invite: {}", "✗".red().bold(), e),
                                }
                            } else {
                                eprintln!("{} No organization found. Start the mothership first with: aura host start", "✗".red().bold());
                            }
                        }
                        Err(e) => eprintln!("{} Cannot open mothership database: {}", "✗".red().bold(), e),
                    }
                }
                HostSubcommands::Status => {
                    println!("\n  {} Aura Mothership Status", "Mothership".bold());
                    host::daemon_status();

                    let db_path = format!("{}/.aura/mothership.db", std::env::var("HOME").unwrap_or_else(|_| ".".to_string()));
                    if !std::path::Path::new(&db_path).exists() {
                        println!("  {} Database not found. Run: aura host start", "ℹ".blue());
                    } else if let Ok(conn) = host_db::init_db(&db_path) {
                        let users = host_db::count_users(&conn).unwrap_or(0);
                        let repos = host_db::count_repos(&conn).unwrap_or(0);
                        let active: i64 = conn.query_row(
                            "SELECT COUNT(*) FROM live_sessions WHERE last_heartbeat > datetime('now', '-2 minutes')",
                            [], |row| row.get(0)
                        ).unwrap_or(0);

                        println!("  {} Database: {}", "•".dimmed(), db_path);
                        println!("  {} Registered users: {}", "•".dimmed(), format!("{}", users).cyan());
                        println!("  {} Tracked repos: {}", "•".dimmed(), format!("{}", repos).cyan());
                        println!("  {} Active peers (2m): {}", "•".dimmed(), format!("{}", active).green());
                    }
                    println!();
                }
                HostSubcommands::Stop => {
                    host::stop_daemon();
                }
                HostSubcommands::Uninstall => {
                    if let Err(e) = host::uninstall_launchagent() {
                        eprintln!("{} Failed to uninstall: {}", "✗".red().bold(), e);
                    }
                }
                HostSubcommands::Users => {
                    let db_path = format!("{}/.aura/mothership.db", std::env::var("HOME").unwrap_or_else(|_| ".".to_string()));
                    match host_db::init_db(&db_path) {
                        Ok(conn) => {
                            let mut stmt = conn.prepare("SELECT username, created_at FROM users ORDER BY created_at").unwrap();
                            let users: Vec<(String, String)> = stmt.query_map([], |row| {
                                Ok((row.get(0)?, row.get(1)?))
                            }).unwrap().filter_map(|r| r.ok()).collect();

                            println!("\n  {} Registered users ({})", "👥".bold(), users.len());
                            for (name, created) in &users {
                                let date = created.split('T').next().unwrap_or(created);
                                println!("    {} {} (joined {})", "•".dimmed(), name.cyan(), date.dimmed());
                            }
                            println!();
                        }
                        Err(e) => eprintln!("{} Cannot open database: {}", "✗".red().bold(), e),
                    }
                }
                HostSubcommands::Kick { username } => {
                    let db_path = format!("{}/.aura/mothership.db", std::env::var("HOME").unwrap_or_else(|_| ".".to_string()));
                    match host_db::init_db(&db_path) {
                        Ok(conn) => {
                            let user = host_db::get_user_by_username(&conn, username);
                            match user {
                                Ok(Some(u)) => {
                                    let _ = conn.execute("DELETE FROM api_tokens WHERE user_id = ?1", rusqlite::params![u.id]);
                                    let _ = conn.execute("DELETE FROM org_members WHERE user_id = ?1", rusqlite::params![u.id]);
                                    let _ = conn.execute("DELETE FROM live_sessions WHERE user_id = ?1", rusqlite::params![u.id]);
                                    let _ = conn.execute("DELETE FROM users WHERE id = ?1", rusqlite::params![u.id]);
                                    println!("{} User '{}' removed from mothership", "✓".green().bold(), username);
                                }
                                _ => println!("{} User '{}' not found", "✗".red().bold(), username),
                            }
                        }
                        Err(e) => eprintln!("{} Cannot open database: {}", "✗".red().bold(), e),
                    }
                }
            }
        }
        Commands::Join { token, username, password } => {
            // Decode the join token
            let join_info = match host::JoinToken::decode(token) {
                Some(t) => t,
                None => {
                    eprintln!("{} Invalid join token. Get a new one from the mothership operator.", "✗".red().bold());
                    return Ok(());
                }
            };

            println!("{} Joining mothership at {}...", "🔗".bold(), join_info.url.cyan());

            // Prompt for username/password if not provided
            let username = match username {
                Some(u) => u.clone(),
                None => {
                    use dialoguer::Input;
                    Input::new().with_prompt("Username").interact_text().unwrap_or_else(|_| "peer".to_string())
                }
            };
            let password = match password {
                Some(p) => p.clone(),
                None => {
                    use dialoguer::Password;
                    Password::new().with_prompt("Password").interact().unwrap_or_else(|_| "password".to_string())
                }
            };

            // Build client — accept self-signed if fingerprint is in token
            let mut client_builder = reqwest::blocking::Client::builder();
            if join_info.url.starts_with("https://") {
                client_builder = client_builder.danger_accept_invalid_certs(true);
            }
            let client = client_builder.build().unwrap_or_else(|_| reqwest::blocking::Client::new());

            // Verify fingerprint if provided
            if !join_info.fp.is_empty() {
                match client.get(format!("{}/fingerprint", join_info.url)).send() {
                    Ok(r) if r.status().is_success() => {
                        let data: serde_json::Value = r.json().unwrap_or_default();
                        let server_fp = data["fingerprint"].as_str().unwrap_or("");
                        if server_fp != join_info.fp {
                            println!("{} TLS fingerprint MISMATCH — possible attack!", "✗".red().bold());
                            println!("  Expected: {}", join_info.fp.cyan());
                            println!("  Got:      {}", server_fp.red());
                            return Ok(());
                        }
                        println!("  {} TLS fingerprint verified", "✓".green().bold());
                    }
                    _ => {
                        println!("{} Could not reach mothership at {}", "✗".red().bold(), join_info.url);
                        return Ok(());
                    }
                }
            }

            // Join
            let resp = client.post(format!("{}/auth/join", join_info.url))
                .json(&serde_json::json!({
                    "code": join_info.code,
                    "username": username,
                    "password": password,
                }))
                .send();

            match resp {
                Ok(r) if r.status().is_success() => {
                    let data: serde_json::Value = r.json().unwrap_or_default();
                    let api_token = data["api_token"].as_str().unwrap_or("");
                    let org_slug = data["org_slug"].as_str().unwrap_or("");

                    // Store credentials
                    let cred_dir = directories::ProjectDirs::from("com", "naridon", "aura")
                        .map(|d| d.config_dir().to_path_buf())
                        .unwrap_or_else(|| {
                            std::path::PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| ".".to_string())).join(".aura")
                        });
                    let _ = fs::create_dir_all(&cred_dir);
                    let creds = serde_json::json!({
                        "cloud_url": join_info.url,
                        "jwt": data["jwt"].as_str().unwrap_or(""),
                        "api_token": api_token,
                        "org_slug": org_slug,
                        "username": username,
                    });
                    let _ = fs::write(cred_dir.join("credentials.json"), serde_json::to_string_pretty(&creds).unwrap_or_default());

                    let mut config = ConfigManager::load();
                    config.cloud_url = Some(join_info.url.clone());
                    config.cloud_api_token = Some(api_token.to_string());
                    if join_info.url.starts_with("https://") {
                        config.accept_self_signed = true;
                    }
                    let _ = ConfigManager::save(&config);

                    println!("\n  {} Joined mothership!", "✓".green().bold());
                    println!("  {} User: {}", "•".dimmed(), username.cyan());
                    println!("  {} Team: {}", "•".dimmed(), org_slug.cyan());
                    println!("  {} URL:  {}", "•".dimmed(), join_info.url.cyan());
                    println!("\n  All {} and {} commands now sync through this mothership.\n", "aura live".cyan(), "aura msg".cyan());
                }
                Ok(r) if r.status().as_u16() == 404 => {
                    println!("{} Invite code expired or invalid. Ask for a new join token.", "✗".red().bold());
                }
                Ok(r) if r.status().as_u16() == 401 => {
                    println!("{} Wrong password for existing user '{}'", "✗".red().bold(), username);
                }
                Ok(r) => {
                    println!("{} Join failed ({})", "✗".red().bold(), r.status());
                }
                Err(e) => {
                    println!("{} Could not reach mothership: {}", "✗".red().bold(), e);
                }
            }
        }
        Commands::Connect { url, code, username, password, fingerprint, accept_self_signed, no_browser } => {
            // Cloud mode: no URL or URL looks like app.auravcs.com / auravcs.com and no invite code.
            let is_mothership = code.is_some() || username.is_some() || password.is_some();
            if !is_mothership {
                let cloud_url = url.clone();
                if let Err(e) = cloud_connect::connect(cloud_url, *no_browser) {
                    println!("{} {}", "✗".red().bold(), e);
                    std::process::exit(1);
                }
                return Ok(());
            }
            let url = url.clone().expect("--code requires a mothership URL");
            let code = code.clone().expect("mothership connect requires --code");
            let username = username.clone().expect("mothership connect requires --username");
            let password = password.clone().expect("mothership connect requires --password");
            let url = &url;
            let code = &code;
            let username = &username;
            let password = &password;
            println!("{} Joining mothership at {}...", "🔗".bold(), url.cyan());

            // Build client that can handle self-signed certs
            let mut client_builder = reqwest::blocking::Client::builder();
            if url.starts_with("https://") {
                if *accept_self_signed || fingerprint.is_some() {
                    // Accept self-signed certs (we verify fingerprint separately)
                    client_builder = client_builder.danger_accept_invalid_certs(true);
                }
            }
            let client = client_builder.build().unwrap_or_else(|_| reqwest::blocking::Client::new());

            // If fingerprint provided, verify it against the mothership
            if let Some(expected_fp) = fingerprint {
                println!("  {} Verifying TLS fingerprint...", "🔒".bold());
                match client.get(format!("{}/fingerprint", url)).send() {
                    Ok(r) if r.status().is_success() => {
                        let data: serde_json::Value = r.json().unwrap_or_default();
                        let server_fp = data["fingerprint"].as_str().unwrap_or("");
                        if server_fp != expected_fp.as_str() {
                            println!("{} TLS fingerprint MISMATCH!", "✗".red().bold());
                            println!("  Expected: {}", expected_fp.cyan());
                            println!("  Got:      {}", server_fp.red());
                            println!("\n  This could indicate a man-in-the-middle attack.");
                            println!("  Verify the fingerprint with the mothership operator.");
                            return Ok(());
                        }
                        println!("  {} Fingerprint verified", "✓".green().bold());
                    }
                    _ => {
                        println!("{} Could not verify fingerprint — connection failed", "✗".red().bold());
                        return Ok(());
                    }
                }
            } else if url.starts_with("https://") && !*accept_self_signed {
                // For HTTPS without fingerprint or --accept-self-signed, warn
                println!("  {} Self-signed cert detected. Use {} or {} to connect securely.",
                    "⚠".yellow(),
                    "--fingerprint <fp>".cyan(),
                    "--accept-self-signed".cyan());
            }

            let resp = client.post(format!("{}/auth/join", url))
                .json(&serde_json::json!({
                    "code": code,
                    "username": username,
                    "password": password,
                }))
                .send();

            match resp {
                Ok(r) if r.status().is_success() => {
                    let data: serde_json::Value = r.json().unwrap_or_default();
                    let jwt = data["jwt"].as_str().unwrap_or("");
                    let api_token = data["api_token"].as_str().unwrap_or("");
                    let org_slug = data["org_slug"].as_str().unwrap_or("");

                    // Store credentials
                    let cred_dir = directories::ProjectDirs::from("com", "naridon", "aura")
                        .map(|d| d.config_dir().to_path_buf())
                        .unwrap_or_else(|| {
                            std::path::PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| ".".to_string())).join(".aura")
                        });
                    let _ = fs::create_dir_all(&cred_dir);
                    let creds = serde_json::json!({
                        "cloud_url": url,
                        "jwt": jwt,
                        "api_token": api_token,
                        "org_slug": org_slug,
                        "username": username,
                    });
                    let cred_path = cred_dir.join("credentials.json");
                    let _ = fs::write(&cred_path, serde_json::to_string_pretty(&creds).unwrap_or_default());

                    // Set cloud config so all live/msg/sync commands work
                    let mut config = ConfigManager::load();
                    config.cloud_url = Some(url.clone());
                    config.cloud_api_token = Some(api_token.to_string());
                    // If connecting to a mothership with self-signed cert, remember for future requests
                    if *accept_self_signed || fingerprint.is_some() {
                        config.accept_self_signed = true;
                    }
                    let _ = ConfigManager::save(&config);

                    println!("{} Connected to mothership!", "✓".green().bold());
                    println!("  {} URL: {}", "•".dimmed(), url.cyan());
                    println!("  {} User: {}", "•".dimmed(), username.cyan());
                    println!("  {} Org: {}", "•".dimmed(), org_slug.cyan());
                    println!("\n  All {} and {} commands now go through this mothership.", "aura live".cyan(), "aura msg".cyan());
                }
                Ok(r) if r.status().as_u16() == 404 => {
                    println!("{} Invalid or expired invite code", "✗".red().bold());
                }
                Ok(r) if r.status().as_u16() == 401 => {
                    println!("{} Wrong password for existing user '{}'", "✗".red().bold(), username);
                }
                Ok(r) => {
                    println!("{} Join failed ({})", "✗".red().bold(), r.status());
                }
                Err(e) => {
                    println!("{} Could not connect to {}: {}", "✗".red().bold(), url, e);
                }
            }
        }
        Commands::JoinTeam { org_slug, repo } => {
            if let Err(e) = cloud_join::join_team(org_slug, repo.as_deref()) {
                println!("{} {}", "✗".red().bold(), e);
                std::process::exit(1);
            }
        }
        Commands::Resolve { list, interactive } => {
            let interactive = *interactive || !*list;
            if let Err(e) = resolve::run(*list, interactive) {
                println!("{} {}", "✗".red().bold(), e);
                std::process::exit(1);
            }
        }
        Commands::Atlas { ai, json } => {
            let code = atlas::run(*ai, *json);
            if code != 0 {
                std::process::exit(code);
            }
        }
        Commands::Distill { dry_run, json, include_untracked, max_groups } => {
            let code = distill::run(*dry_run, *json, *include_untracked, *max_groups);
            if code != 0 {
                std::process::exit(code);
            }
        }
        Commands::MergeDriver {
            base,
            ours,
            theirs,
            path,
            marker_size,
            install,
            uninstall,
            status,
            json,
        } => {
            let code = merge_driver::run(
                base.as_deref(),
                ours.as_deref(),
                theirs.as_deref(),
                path.as_deref(),
                *marker_size,
                *install,
                *uninstall,
                *status,
                *json,
            );
            if code != 0 {
                std::process::exit(code);
            }
        }
        Commands::ChangeNote { sha, json } => {
            handle_change_note_command(sha, *json)?;
        }
        Commands::Impact { symbol, file, json } => {
            handle_impact_command(symbol, file, *json)?;
        }
        Commands::Pr { action } => {
            let res = match action {
                PrAction::Connect { platform } => pr_cmd::connect(platform),
                PrAction::Review { pr, dry_run, base } => {
                    pr_cmd::review(*pr, *dry_run, base.as_deref())
                }
                PrAction::Status => pr_cmd::status(),
                PrAction::Feedback { event_id, verdict, note } => {
                    pr_cmd::feedback(event_id, verdict, note.as_deref())
                }
                PrAction::CommitReview { action } => run_pr_commit_review(action),
            };
            if let Err(e) = res {
                println!("{} {}", "✗".red().bold(), e);
                std::process::exit(1);
            }
        }
        Commands::Keys { action } => {
            let res = match action {
                KeysAction::Init { passphrase } => keys_cmd::init(passphrase),
                KeysAction::Show => keys_cmd::show(),
                KeysAction::Unlock { org_slug, passphrase } => keys_cmd::unlock(org_slug, passphrase),
                KeysAction::Rotate { org_slug } => keys_cmd::rotate(org_slug),
                KeysAction::Export { out } => keys_cmd::export(out),
                KeysAction::Import { file } => keys_cmd::import(file),
                KeysAction::SigstoreVerify { manifest, pubkey_b64 } => {
                    keys_cmd::sigstore_verify(manifest, pubkey_b64.as_deref())
                }
                KeysAction::SigstoreSign { manifest, out } => {
                    keys_cmd::sigstore_sign(manifest, out.as_deref())
                }
                KeysAction::RekorPublish { manifest, rekor_url, out } => {
                    keys_cmd::rekor_publish(manifest, rekor_url, out.as_deref())
                }
                KeysAction::RekorVerify { manifest, sidecar } => {
                    keys_cmd::rekor_verify(manifest, sidecar.as_deref())
                }
                KeysAction::SigstoreRotate { json } => {
                    intent_block::rotate_signing_key_cli(*json)
                }
                KeysAction::SigstorePull { json } => {
                    intent_block::pull_rotation_chain_cli(*json)
                }
                KeysAction::SigstoreStatus { json } => {
                    manifest_sig::signing_status_cli(*json)
                }
            };
            if let Err(e) = res {
                println!("{} {}", "✗".red().bold(), e);
                std::process::exit(1);
            }
        }
        Commands::Attest { action } => {
            let res = match action {
                AttestAction::Verify { block_id, no_rekor, json } => {
                    intent_block::verify_block_cli(block_id, *no_rekor, *json)
                }
                AttestAction::List { json, human, intent_type } => {
                    // S2-TIL: validate --type at the CLI boundary so a
                    // typo fails fast with the canonical list rather
                    // than returning an empty filtered set.
                    if let Some(t) = intent_type.as_deref() {
                        if !intent_query::is_canonical_intent_type(t) {
                            println!(
                                "{} Invalid --type '{}'. Must be one of: {}",
                                "✗".red().bold(),
                                t,
                                intent_query::CANONICAL_INTENT_TYPES.join(", "),
                            );
                            std::process::exit(1);
                        }
                    }
                    intent_block::list_blocks_cli(*json, human.as_deref(), intent_type.as_deref())
                }
                AttestAction::Share { json } => {
                    intent_block::share_attestations_cli(*json)
                }
            };
            if let Err(e) = res {
                println!("{} {}", "✗".red().bold(), e);
                std::process::exit(1);
            }
        }
        Commands::Crdt { action } => match action {
            CrdtAction::Status => {
                let cursors = crdt::load_cursors();
                println!("{}", serde_json::to_string_pretty(&cursors).unwrap_or_default());
            }
            CrdtAction::Pull => {
                let branch = std::process::Command::new("git")
                    .args(["rev-parse", "--abbrev-ref", "HEAD"])
                    .output()
                    .ok()
                    .and_then(|o| String::from_utf8(o.stdout).ok())
                    .map(|s| s.trim().to_string())
                    .unwrap_or_else(|| "main".to_string());
                let mut cursors = crdt::load_cursors();
                let since = *cursors.by_branch.get(&branch).unwrap_or(&0);
                match crdt::pull_ops(&branch, since) {
                    Ok((ops, cursor)) => {
                        println!("pulled {} op(s), cursor {} → {}", ops.len(), since, cursor);
                        cursors.by_branch.insert(branch, cursor);
                        crdt::save_cursors(&cursors);
                    }
                    Err(e) => {
                        println!("{} {}", "✗".red().bold(), e);
                        std::process::exit(1);
                    }
                }
            }
        },
        Commands::Whoami => {
            if let Err(e) = cloud_connect::whoami() {
                println!("{} {}", "✗".red().bold(), e);
                std::process::exit(1);
            }
        }
        Commands::Disconnect => {
            if let Err(e) = cloud_connect::disconnect() {
                println!("{} {}", "✗".red().bold(), e);
                std::process::exit(1);
            }
        }
        Commands::Usage { period, json, project, plan, budget_daily, budget_weekly, budget_session, export, by_dev } => {
            // If any budget flags were passed, save them to config
            if budget_daily.is_some() || budget_weekly.is_some() || budget_session.is_some() {
                let mut config = ConfigManager::load();
                let mut budget = config.budget.clone().unwrap_or_default();
                if let Some(v) = budget_daily { budget.daily_cap_usd = *v; }
                if let Some(v) = budget_weekly { budget.weekly_cap_usd = *v; }
                if let Some(v) = budget_session { budget.session_cap_usd = *v; }
                config.budget = Some(budget.clone());
                let _ = ConfigManager::save(&config);
                println!("  {} Budget updated:", "✓".green().bold());
                if budget.daily_cap_usd > 0.0 {
                    println!("    {} Daily cap:   ${:.2}", "↳".dimmed(), budget.daily_cap_usd);
                }
                if budget.weekly_cap_usd > 0.0 {
                    println!("    {} Weekly cap:  ${:.2}", "↳".dimmed(), budget.weekly_cap_usd);
                }
                if budget.session_cap_usd > 0.0 {
                    println!("    {} Session cap: ${:.2}", "↳".dimmed(), budget.session_cap_usd);
                }
                println!();
            }

            let since_secs = match period.as_str() {
                "today" | "day" => 86400u64,
                "week" => 604800,
                "month" => 2592000,
                "all" => u64::MAX,
                _ => {
                    eprintln!("{} Unknown period '{}'. Use: today, week, month, all", "✗".red(), period);
                    std::process::exit(1);
                }
            };

            if *plan {
                // Parse Claude Code transcripts for real usage data
                match plan_tracker::build_plan_report(since_secs, period) {
                    Some(report) => {
                        if *json {
                            println!("{}", serde_json::to_string_pretty(&plan_tracker::plan_report_to_json(&report)).unwrap_or_default());
                        } else {
                            plan_tracker::print_plan_report(&report);
                        }
                    }
                    None => {
                        eprintln!("{} No Claude Code transcripts found at ~/.claude/projects/", "✗".red());
                        eprintln!("  This feature parses Claude Code session data to show plan usage.");
                    }
                }
            } else {
                let report = if *project {
                    usage::build_report_project(since_secs, period)
                } else {
                    usage::build_report(since_secs, period)
                };

                // Refresh the git-shared per-developer aggregate
                // (.aura/usage_by_dev.jsonl) on every run — idempotent,
                // atomic, and a no-op outside a repo with .aura. Window the
                // rows to the requested period (month granularity).
                let dev_rows = usage_by_dev::refresh();
                let cutoff_ts = if since_secs == u64::MAX {
                    None
                } else {
                    Some(
                        SystemTime::now()
                            .duration_since(UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_secs()
                            .saturating_sub(since_secs),
                    )
                };
                let windowed = usage_by_dev::rows_in_window(&dev_rows, cutoff_ts);

                if *json {
                    let mut out = usage::report_to_json(&report);
                    out["by_developer"] = usage_by_dev::rows_to_json(&windowed);
                    // Mark which row is "you" so the desktop surface can show
                    // your own project usage as the hero and gate the
                    // per-person breakdown to admins.
                    out["self_developer"] =
                        serde_json::json!(usage_by_dev::dev_identity().email);
                    println!("{}", serde_json::to_string_pretty(&out).unwrap_or_default());
                } else {
                    usage::print_report(&report);
                    if *by_dev {
                        usage_by_dev::print_by_dev(&windowed);
                    }

                    // Check budget alerts
                    let config = ConfigManager::load();
                    if let Some(ref budget) = config.budget {
                        let alerts = usage::check_budget(budget);
                        if !alerts.is_empty() {
                            usage::print_budget_alerts(&alerts);
                        }
                    }
                }
            }

            // Export to CSV if requested
            if let Some(path) = export {
                if *plan {
                    if let Some(report) = plan_tracker::build_plan_report(since_secs, period) {
                        export_plan_csv(path, &report);
                    }
                } else {
                    let report = if *project {
                        usage::build_report_project(since_secs, period)
                    } else {
                        usage::build_report(since_secs, period)
                    };
                    export_usage_csv(path, &report);
                }
            }
        }
        Commands::UsageRecord { session, agent, model, input, output, cache } => {
            // Cheap, silent, fired per turn by the desktop app. Only write
            // when there's something to record — `record_turn_usage` upserts a
            // repo-local session, and the next `aura usage` read rolls it into
            // the git-shared per-developer aggregate (project-scoped only).
            if *input > 0 || *output > 0 || *cache > 0 {
                session::SessionManager::record_turn_usage(
                    session,
                    agent,
                    model.as_deref(),
                    *input,
                    *output,
                    *cache,
                );
            }
        }
        Commands::AcpServe => {
            acp_server::AcpServer::serve();
        }
        Commands::AcpRun { cmd, args, prompt, timeout, json } => {
            use colored::Colorize;
            let timeout_dur = std::time::Duration::from_secs(*timeout);
            let mut session = match acp_client::spawn(cmd, args) {
                Ok(s) => s,
                Err(e) => {
                    eprintln!("{} failed to spawn `{}`: {}", "✗".red().bold(), cmd, e);
                    std::process::exit(1);
                }
            };
            if let Err(e) = session.initialize(timeout_dur) {
                eprintln!("{} initialize failed: {}", "✗".red().bold(), e);
                std::process::exit(1);
            }
            let sid = match session.session_new(timeout_dur) {
                Ok(s) => s,
                Err(e) => {
                    eprintln!("{} session/new failed: {}", "✗".red().bold(), e);
                    std::process::exit(1);
                }
            };
            if *json {
                println!("{}", serde_json::json!({"event":"session_started","sessionId":sid}));
            } else {
                println!("{} session {}", "▶".cyan().bold(), sid.dimmed());
            }
            let json_mode = *json;
            let result = session.prompt(prompt, timeout_dur, |update| {
                if json_mode {
                    if let Ok(s) = serde_json::to_string(&update) {
                        println!("{}", s);
                    }
                } else if let Some(text) = update
                    .get("params")
                    .and_then(|p| p.get("update"))
                    .and_then(|u| u.get("content"))
                    .and_then(|c| c.get("text"))
                    .and_then(|t| t.as_str())
                {
                    print!("{}", text);
                    let _ = std::io::Write::flush(&mut std::io::stdout());
                }
            });
            if !json_mode {
                println!();
            }
            match result {
                Ok(_) => {
                    let _ = session.shutdown(std::time::Duration::from_secs(2));
                }
                Err(e) => {
                    eprintln!("{} prompt failed: {}", "✗".red().bold(), e);
                    let _ = session.shutdown(std::time::Duration::from_secs(2));
                    std::process::exit(1);
                }
            }
        }
        Commands::Recall { action } => {
            if let Err(e) = run_recall(action) {
                eprintln!("{} {}", "✗".red().bold(), e);
                std::process::exit(1);
            }
        }
        Commands::Intents { action } => {
            if let Err(e) = run_intents(action) {
                eprintln!("{} {}", "✗".red().bold(), e);
                std::process::exit(1);
            }
        }
        Commands::HandoverCloud { action } => {
            if let Err(e) = run_handover_cloud(action) {
                eprintln!("{} {}", "✗".red().bold(), e);
                std::process::exit(1);
            }
        }
        Commands::Memory { action } => {
            if let Err(e) = memory::cli::run(action) {
                eprintln!("{} {}", "✗".red().bold(), e);
                std::process::exit(1);
            }
        }
        Commands::MemoryCloud { action } => {
            if let Err(e) = run_memory_cloud(action) {
                eprintln!("{} {}", "✗".red().bold(), e);
                std::process::exit(1);
            }
        }
        Commands::A2aTask { action } => {
            if let Err(e) = run_a2a_task(action) {
                eprintln!("{} {}", "✗".red().bold(), e);
                std::process::exit(1);
            }
        }
        Commands::Skill { action } => {
            if let Err(e) = run_skill(action) {
                eprintln!("{} {}", "✗".red().bold(), e);
                std::process::exit(1);
            }
        }
        Commands::Skills { action } => {
            if let Err(e) = skills::run(action) {
                eprintln!("{} {}", "✗".red().bold(), e);
                std::process::exit(1);
            }
        }
        Commands::Replay { action } => {
            if let Err(e) = replay::run(action) {
                eprintln!("{} {}", "✗".red().bold(), e);
                std::process::exit(1);
            }
        }
        Commands::Webhooks { action } => {
            if let Err(e) = run_webhooks(action) {
                eprintln!("{} {}", "✗".red().bold(), e);
                std::process::exit(1);
            }
        }
        Commands::AgentCard { host, cloud, json } => {
            if let Err(e) = run_agent_card(host.as_deref(), cloud.as_deref(), *json) {
                eprintln!("{} {}", "✗".red().bold(), e);
                std::process::exit(1);
            }
        }
        Commands::Ws { action } => {
            match action {
                WsAction::Listen { seconds, stop_after, expect_min, format } => {
                    let config = ConfigManager::load();
                    let cloud_url = config
                        .cloud_url
                        .clone()
                        .or_else(|| std::env::var("AURA_CLOUD_URL").ok())
                        .unwrap_or_else(|| "http://127.0.0.1:3001".to_string());
                    let token = config
                        .cloud_api_token
                        .clone()
                        .or_else(|| std::env::var("AURA_CLOUD_TOKEN").ok())
                        .unwrap_or_default();
                    let report = match live_ws::listen_blocking(
                        &cloud_url,
                        &token,
                        *seconds,
                        *stop_after,
                        format.as_deref(),
                    ) {
                        Ok(r) => r,
                        Err(e) => {
                            eprintln!("✗ ws listen: {}", e);
                            std::process::exit(1);
                        }
                    };
                    for frame in &report.frames {
                        println!("{}", frame);
                    }
                    let payload_count = report
                        .frames
                        .iter()
                        .filter(|s| {
                            !s.contains("\"type\":\"heartbeat\"")
                                && !s.contains("\"type\":\"pong\"")
                                && !s.contains("\"type\":\"RAW\"")
                                && !s.contains("\"type\":\"ready\"")
                                && !s.contains("\"type\":\"RUN_STARTED\"")
                        })
                        .count();
                    if *expect_min > 0 && payload_count < *expect_min {
                        eprintln!(
                            "✗ ws listen: expected ≥{} payload frames, got {}",
                            expect_min, payload_count
                        );
                        std::process::exit(1);
                    }
                }
            }
        }
    }

    Ok(())
}

// ── `aura recall` — thin human surface over the cloud's episodic v2 endpoints. ──
//
// Mirrors the three MCP cloud tools (aura_episodic_recall_cloud /
// _session_arc / _multi_session_arc) so a developer at a terminal can
// inspect their own (or a teammate's) cloud event history without an
// MCP client. Read-only; reuses the same cloud-token resolution as the
// rest of the CLI (config first, then `AURA_CLOUD_TOKEN` env).
fn run_recall(action: &RecallAction) -> Result<(), String> {
    // narrate-blocks is local-only and never touches the cloud — service
    // it BEFORE we demand a cloud token (which would block users on
    // air-gapped boxes from running handover narration).
    if let RecallAction::NarrateBlocks {
        since_hours,
        kind,
        actor,
        intent_type,
        list_limit,
        json,
    } = action
    {
        // Validate --type against the canonical set so a typo bubbles
        // up immediately instead of returning a silent zero-match
        // narration. Mirrors `aura intents query --type` behavior.
        if let Some(t) = intent_type.as_deref() {
            if !intent_query::is_canonical_intent_type(t) {
                println!(
                    "{} Invalid --type '{}'. Must be one of: {}",
                    "✗".red().bold(),
                    t,
                    intent_query::CANONICAL_INTENT_TYPES.join(", "),
                );
                std::process::exit(1);
            }
        }
        let blocks = read_blocks_dir(std::path::Path::new(".aura/blocks"))?;
        let summaries = collect_block_summaries(&blocks);
        let now_ms = current_unix_ms();
        let report = recall_narrate::build_block_narration_typed(
            &summaries,
            now_ms,
            *since_hours,
            kind,
            actor.as_deref(),
            intent_type.as_deref(),
            *list_limit,
        );
        if *json {
            println!(
                "{}",
                serde_json::to_string_pretty(&report.to_json())
                    .unwrap_or_else(|_| "{}".to_string())
            );
        } else {
            println!("{}", report.to_prose());
        }
        return Ok(());
    }
    let (cloud_url, token) = recall_cloud_creds()?;
    let client = cloud_http_client();
    match action {
        RecallAction::Events {
            event_type,
            agent,
            focus_fn,
            focus_file,
            repo,
            intent_type,
            window_hours,
            limit,
            json,
        } => {
            // S2-TICRE: validate at the CLI boundary before issuing the
            // cloud request so a typo'd --type fails fast and locally,
            // not after a 400 round-trip. Mirrors `aura intents query
            // --type` and `aura recall narrate-blocks --type`.
            if let Some(t) = intent_type.as_deref() {
                if !intent_query::is_canonical_intent_type(t) {
                    return Err(format!(
                        "Invalid --type '{}'. Must be one of: {}",
                        t,
                        intent_query::CANONICAL_INTENT_TYPES.join(", "),
                    ));
                }
            }
            let mut url = format!("{}/api/v2/episodic/recall", cloud_url.trim_end_matches('/'));
            let mut sep = '?';
            recall_push_str(&mut url, &mut sep, "event_type", event_type.as_deref());
            recall_push_str(&mut url, &mut sep, "agent_id", agent.as_deref());
            recall_push_str(&mut url, &mut sep, "focus_fn", focus_fn.as_deref());
            recall_push_str(&mut url, &mut sep, "focus_file", focus_file.as_deref());
            recall_push_str(&mut url, &mut sep, "repo", repo.as_deref());
            recall_push_str(&mut url, &mut sep, "intent_type", intent_type.as_deref());
            recall_push_i64(&mut url, &mut sep, "window_hours", *window_hours);
            recall_push_i64(&mut url, &mut sep, "limit", *limit);
            let body = recall_get(&client, &url, &token)?;
            if *json {
                println!("{}", serde_json::to_string_pretty(&body).unwrap_or_else(|_| body.to_string()));
            } else {
                println!("{}", format_recall_events_table(&body));
            }
            Ok(())
        }
        RecallAction::Arc {
            agent,
            window_hours,
            gap_minutes,
            repo,
            limit,
            json,
        } => {
            if agent.trim().is_empty() {
                return Err("--agent is required".to_string());
            }
            let mut url = format!(
                "{}/api/v2/episodic/session-arc?agent_id={}",
                cloud_url.trim_end_matches('/'),
                mcp::percent_encode_unreserved(agent)
            );
            let mut sep = '&';
            recall_push_i64(&mut url, &mut sep, "window_hours", *window_hours);
            recall_push_i64(&mut url, &mut sep, "gap_minutes", *gap_minutes);
            recall_push_str(&mut url, &mut sep, "repo", repo.as_deref());
            recall_push_i64(&mut url, &mut sep, "limit", *limit);
            let body = recall_get(&client, &url, &token)?;
            if *json {
                println!("{}", serde_json::to_string_pretty(&body).unwrap_or_else(|_| body.to_string()));
            } else {
                println!("{}", format_arc_segments_table(&body, false));
            }
            Ok(())
        }
        RecallAction::NarrateBlocks { .. } => unreachable!("handled above"),
        RecallAction::Timeline {
            function_name,
            window_hours,
            repo,
            limit,
            json,
        } => {
            if function_name.trim().is_empty() {
                return Err("--function-name is required".to_string());
            }
            let mut url = format!(
                "{}/api/v2/episodic/timeline?function_name={}",
                cloud_url.trim_end_matches('/'),
                mcp::percent_encode_unreserved(function_name)
            );
            let mut sep = '&';
            recall_push_i64(&mut url, &mut sep, "window_hours", *window_hours);
            recall_push_str(&mut url, &mut sep, "repo", repo.as_deref());
            recall_push_i64(&mut url, &mut sep, "limit", *limit);
            let body = recall_get(&client, &url, &token)?;
            if *json {
                println!("{}", serde_json::to_string_pretty(&body).unwrap_or_else(|_| body.to_string()));
            } else {
                println!("{}", format_timeline_table(&body));
            }
            Ok(())
        }
        RecallAction::NarrateCloud {
            window_hours,
            event_type,
            focus_file,
            focus_fn,
            repo,
            tier,
            limit,
            json,
        } => {
            let url = format!(
                "{}/api/v2/episodic/narrate",
                cloud_url.trim_end_matches('/')
            );
            let mut body_obj = serde_json::Map::new();
            if let Some(v) = window_hours { body_obj.insert("window_hours".into(), serde_json::json!(v)); }
            if let Some(v) = event_type { body_obj.insert("event_type".into(), serde_json::json!(v)); }
            if let Some(v) = focus_file { body_obj.insert("focus_file".into(), serde_json::json!(v)); }
            if let Some(v) = focus_fn { body_obj.insert("focus_fn".into(), serde_json::json!(v)); }
            if let Some(v) = repo { body_obj.insert("repo".into(), serde_json::json!(v)); }
            if let Some(v) = tier { body_obj.insert("tier".into(), serde_json::json!(v)); }
            if let Some(v) = limit { body_obj.insert("limit".into(), serde_json::json!(v)); }
            let req_body = serde_json::Value::Object(body_obj);
            let body = recall_post(&client, &url, &token, &req_body)?;
            if *json {
                println!("{}", serde_json::to_string_pretty(&body).unwrap_or_else(|_| body.to_string()));
            } else {
                println!("{}", format_narrate_cloud(&body));
            }
            Ok(())
        }
        RecallAction::AgentDigest {
            agent,
            window_hours,
            repo,
            limit,
            json,
        } => {
            if agent.trim().is_empty() {
                return Err("--agent is required".to_string());
            }
            let mut url = format!(
                "{}/api/v2/episodic/agent-digest?agent_id={}",
                cloud_url.trim_end_matches('/'),
                mcp::percent_encode_unreserved(agent)
            );
            let mut sep = '&';
            recall_push_i64(&mut url, &mut sep, "window_hours", *window_hours);
            recall_push_str(&mut url, &mut sep, "repo", repo.as_deref());
            recall_push_i64(&mut url, &mut sep, "limit", *limit);
            let body = recall_get(&client, &url, &token)?;
            if *json {
                println!("{}", serde_json::to_string_pretty(&body).unwrap_or_else(|_| body.to_string()));
            } else {
                println!("{}", format_agent_digest_table(&body));
            }
            Ok(())
        }
        RecallAction::MultiArc {
            agents,
            window_hours,
            gap_minutes,
            repo,
            limit,
            json,
        } => {
            if agents.trim().is_empty() {
                return Err("--agents is required (comma-separated list)".to_string());
            }
            let mut url = format!(
                "{}/api/v2/episodic/multi-session-arc?agent_ids={}",
                cloud_url.trim_end_matches('/'),
                mcp::percent_encode_unreserved(agents)
            );
            let mut sep = '&';
            recall_push_i64(&mut url, &mut sep, "window_hours", *window_hours);
            recall_push_i64(&mut url, &mut sep, "gap_minutes", *gap_minutes);
            recall_push_str(&mut url, &mut sep, "repo", repo.as_deref());
            recall_push_i64(&mut url, &mut sep, "limit", *limit);
            let body = recall_get(&client, &url, &token)?;
            if *json {
                println!("{}", serde_json::to_string_pretty(&body).unwrap_or_else(|_| body.to_string()));
            } else {
                println!("{}", format_arc_segments_table(&body, true));
            }
            Ok(())
        }
    }
}

/// S2-HCL: dispatch arm for cloud handover ledger CLI. Both
/// subcommands require a cloud token (handover ledger is server-
/// side, not local). Reuses recall_get / recall_post + the existing
/// creds + http client helpers so the request/error shape matches
/// every other cloud-touching CLI surface.
fn run_handover_cloud(action: &HandoverCloudAction) -> Result<(), String> {
    let (cloud_url, token) = recall_cloud_creds()?;
    let client = cloud_http_client();
    match action {
        HandoverCloudAction::List { page, limit, json } => {
            let mut url = format!("{}/api/v2/handovers", cloud_url.trim_end_matches('/'));
            let mut sep = '?';
            recall_push_i64(&mut url, &mut sep, "page", *page);
            recall_push_i64(&mut url, &mut sep, "limit", *limit);
            let body = recall_get(&client, &url, &token)?;
            if *json {
                println!("{}", serde_json::to_string_pretty(&body).unwrap_or_else(|_| body.to_string()));
            } else {
                println!("{}", format_handover_cloud_list(&body));
            }
            Ok(())
        }
        HandoverCloudAction::Push {
            session_id,
            agent_name,
            summary,
            token_count,
            json,
        } => {
            if session_id.trim().is_empty() {
                return Err("--session-id is required".to_string());
            }
            if agent_name.trim().is_empty() {
                return Err("--agent-name is required".to_string());
            }
            if summary.trim().is_empty() {
                return Err("--summary is required".to_string());
            }
            let url = format!("{}/api/v2/handovers", cloud_url.trim_end_matches('/'));
            let mut body_obj = serde_json::Map::new();
            body_obj.insert("session_id".into(), serde_json::json!(session_id));
            body_obj.insert("agent_name".into(), serde_json::json!(agent_name));
            body_obj.insert("summary".into(), serde_json::json!(summary));
            if let Some(v) = token_count {
                body_obj.insert("token_count".into(), serde_json::json!(v));
            }
            let req_body = serde_json::Value::Object(body_obj);
            let resp = recall_post(&client, &url, &token, &req_body)?;
            if *json {
                println!("{}", serde_json::to_string_pretty(&resp).unwrap_or_else(|_| resp.to_string()));
            } else {
                let id = resp.get("id").and_then(|v| v.as_str()).unwrap_or("?");
                let status = resp.get("status").and_then(|v| v.as_str()).unwrap_or("ok");
                println!("✓ handover-cloud push {} id={}", status, id);
            }
            Ok(())
        }
    }
}

/// S2-HCL: render the cloud handover ledger as a per-row table.
/// Header line names total. Per-row: created_at, agent_name,
/// session_id (truncated), summary (truncated). Empty list falls
/// back to "(no handovers)".
fn format_handover_cloud_list(body: &serde_json::Value) -> String {
    let total = body.get("total").and_then(|v| v.as_i64()).unwrap_or(0);
    let rows = match body.get("handovers").and_then(|v| v.as_array()) {
        Some(arr) => arr,
        None => {
            return format!("Cloud handover ledger — total={}\n  (malformed response — missing 'handovers' field)\n", total);
        }
    };
    let mut out = String::new();
    out.push_str(&format!(
        "Cloud handover ledger — total={} returned={}\n",
        total,
        rows.len(),
    ));
    if rows.is_empty() {
        out.push_str("  (no handovers)\n");
        return out;
    }
    out.push_str(&format!(
        "  {:<24}  {:<14}  {:<22}  {:>6}  {}\n",
        "created_at", "agent_name", "session_id", "tokens", "summary"
    ));
    for row in rows {
        let created = row.get("created_at").and_then(|v| v.as_str()).unwrap_or("?");
        let agent = row.get("agent_name").and_then(|v| v.as_str()).unwrap_or("-");
        let session = row.get("session_id").and_then(|v| v.as_str()).unwrap_or("-");
        let tokens = row.get("token_count").and_then(|v| v.as_i64()).unwrap_or(0);
        let summary = row.get("summary").and_then(|v| v.as_str()).unwrap_or("-");
        out.push_str(&format!(
            "  {:<24}  {:<14}  {:<22}  {:>6}  {}\n",
            truncate(created, 24),
            truncate(agent, 14),
            truncate(session, 22),
            tokens,
            truncate(summary, 60),
        ));
    }
    out
}

/// S2-MCL: dispatch arm for cloud project_memory CLI. Sibling to
/// run_handover_cloud — same template, different endpoint and body
/// shape. Reuses the recall_get / recall_post / recall_cloud_creds
/// helpers for auth + error symmetry.
fn run_memory_cloud(action: &MemoryCloudAction) -> Result<(), String> {
    let (cloud_url, token) = recall_cloud_creds()?;
    let client = cloud_http_client();
    match action {
        MemoryCloudAction::List { page, limit, json } => {
            let mut url = format!("{}/api/v2/memory", cloud_url.trim_end_matches('/'));
            let mut sep = '?';
            recall_push_i64(&mut url, &mut sep, "page", *page);
            recall_push_i64(&mut url, &mut sep, "limit", *limit);
            let body = recall_get(&client, &url, &token)?;
            if *json {
                println!("{}", serde_json::to_string_pretty(&body).unwrap_or_else(|_| body.to_string()));
            } else {
                println!("{}", format_memory_cloud_list(&body));
            }
            Ok(())
        }
        MemoryCloudAction::Push {
            body,
            title,
            kind,
            repo_full_name,
            json,
        } => {
            if body.trim().is_empty() {
                return Err("--body is required and must be non-empty".to_string());
            }
            let url = format!("{}/api/v2/memory", cloud_url.trim_end_matches('/'));
            let mut body_obj = serde_json::Map::new();
            body_obj.insert("body".into(), serde_json::json!(body));
            if let Some(v) = title { body_obj.insert("title".into(), serde_json::json!(v)); }
            if let Some(v) = kind { body_obj.insert("kind".into(), serde_json::json!(v)); }
            if let Some(v) = repo_full_name {
                body_obj.insert("repo_full_name".into(), serde_json::json!(v));
            }
            let req_body = serde_json::Value::Object(body_obj);
            let resp = recall_post(&client, &url, &token, &req_body)?;
            if *json {
                println!("{}", serde_json::to_string_pretty(&resp).unwrap_or_else(|_| resp.to_string()));
            } else {
                let id = resp.get("id").and_then(|v| v.as_str()).unwrap_or("?");
                let status = resp.get("status").and_then(|v| v.as_str()).unwrap_or("ok");
                println!("✓ memory-cloud push {} id={}", status, id);
            }
            Ok(())
        }
    }
}

/// S2-MCL: render the cloud project_memory list as a per-row table.
/// Cloud response carries both `memory` (legacy) and `entries` (new)
/// keys with the same content for back-compat — prefer `entries`,
/// fall back to `memory`. Empty list falls back to "(no entries)".
/// Body is shown as a 60-char preview; full text is in --json mode.
fn format_memory_cloud_list(body: &serde_json::Value) -> String {
    let total = body.get("total").and_then(|v| v.as_i64()).unwrap_or(0);
    let rows = body
        .get("entries")
        .and_then(|v| v.as_array())
        .or_else(|| body.get("memory").and_then(|v| v.as_array()));
    let rows = match rows {
        Some(arr) => arr,
        None => {
            return format!(
                "Cloud project memory — total={}\n  (malformed response — missing 'entries' / 'memory' field)\n",
                total,
            );
        }
    };
    let mut out = String::new();
    out.push_str(&format!(
        "Cloud project memory — total={} returned={}\n",
        total,
        rows.len(),
    ));
    if rows.is_empty() {
        out.push_str("  (no entries)\n");
        return out;
    }
    out.push_str(&format!(
        "  {:<24}  {:<12}  {:<22}  {}\n",
        "created_at", "kind", "title", "body"
    ));
    for row in rows {
        let created = row.get("created_at").and_then(|v| v.as_str()).unwrap_or("?");
        let kind = row.get("kind").and_then(|v| v.as_str()).unwrap_or("-");
        let title = row.get("title").and_then(|v| v.as_str()).unwrap_or("-");
        let body_text = row.get("body").and_then(|v| v.as_str()).unwrap_or("-");
        out.push_str(&format!(
            "  {:<24}  {:<12}  {:<22}  {}\n",
            truncate(created, 24),
            truncate(kind, 12),
            truncate(title, 22),
            truncate(body_text, 60),
        ));
    }
    out
}

/// S2-AT: PATCH sibling of recall_get / recall_post for endpoints
/// that take a JSON body via PATCH (currently the A2A task patch
/// route). Same auth + error shape so the dispatch stays symmetric.
fn recall_patch(
    client: &reqwest::blocking::Client,
    url: &str,
    token: &str,
    body: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let resp = client
        .patch(url)
        .header("Authorization", format!("Bearer {}", token))
        .json(body)
        .send()
        .map_err(|e| format!("request failed: {}", e))?;
    recall_decode(resp)
}

/// S2-AT: filter task ids to the URL-safe ascii subset before
/// stitching them into the path segment. UUIDs are URL-safe so the
/// happy path is a no-op; this is defense-in-depth so a malformed
/// id can't escape the path. Empty result is rejected at the
/// dispatch level.
fn a2a_safe_id(id: &str) -> String {
    id.chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
        .collect()
}

/// Bucket K1 — auto-detect the current branch for `aura a2a-task
/// create` when --branch isn't passed. Errors propagate up so the
/// caller can decide to omit the field; success None covers
/// detached HEAD.
fn detect_current_branch_for_a2a() -> Result<Option<String>, ()> {
    let out = std::process::Command::new("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .output()
        .map_err(|_| ())?;
    if !out.status.success() {
        return Ok(None);
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() || s == "HEAD" {
        Ok(None)
    } else {
        Ok(Some(s))
    }
}

/// S2-AT: dispatch arm for A2A v1.2 task lifecycle. All four
/// subcommands require a cloud token. Reuses recall_get /
/// recall_post / recall_patch + recall_cloud_creds + cloud_http_client
/// so the request/error shape matches every other cloud-touching CLI
/// surface.
fn run_a2a_task(action: &A2aTaskAction) -> Result<(), String> {
    let (cloud_url, token) = recall_cloud_creds()?;
    let client = cloud_http_client();
    match action {
        A2aTaskAction::Create {
            agent_kind,
            input,
            repo,
            context_id,
            metadata_json,
            parent,
            kind,
            acceptance_criteria,
            branch,
            tag,
            assignee,
            json,
        } => {
            if agent_kind.trim().is_empty() {
                return Err("--agent-kind is required".to_string());
            }
            if input.trim().is_empty() {
                return Err("--input is required".to_string());
            }
            // Bucket K8 — kind/AC pairing validation client-side too so
            // the user gets a fast `exit 4` without a network round-trip.
            const KINDS_REQUIRING_AC: &[&str] = &["plan", "wave", "task"];
            if let Some(k) = kind.as_deref() {
                if !matches!(k, "plan" | "wave" | "task" | "subtask") {
                    return Err(format!(
                        "--kind must be one of plan|wave|task|subtask, got '{k}'"
                    ));
                }
                if KINDS_REQUIRING_AC.contains(&k)
                    && acceptance_criteria
                        .as_deref()
                        .map(|s| s.trim().is_empty())
                        .unwrap_or(true)
                {
                    return Err(format!(
                        "--acceptance-criteria is required (non-empty) when --kind={k}"
                    ));
                }
            }
            let url = format!("{}/api/v2/a2a/tasks", cloud_url.trim_end_matches('/'));
            let mut body_obj = serde_json::Map::new();
            body_obj.insert("agent_kind".into(), serde_json::json!(agent_kind));
            body_obj.insert("input".into(), serde_json::json!(input));
            if let Some(v) = repo { body_obj.insert("repo".into(), serde_json::json!(v)); }
            if let Some(v) = context_id { body_obj.insert("context_id".into(), serde_json::json!(v)); }
            if let Some(raw) = metadata_json {
                let parsed: serde_json::Value = serde_json::from_str(raw)
                    .map_err(|e| format!("--metadata-json is not valid JSON: {}", e))?;
                body_obj.insert("metadata".into(), parsed);
            }
            if let Some(v) = parent {
                body_obj.insert("parent_task_id".into(), serde_json::json!(v));
            }
            match kind {
                Some(v) => {
                    body_obj.insert("task_kind".into(), serde_json::json!(v));
                }
                None => {
                    // No explicit --kind. If the caller also gave no acceptance
                    // criteria, default to `subtask` — a leaf that needs no AC —
                    // so a bare `aura a2a-task create` succeeds instead of the
                    // server defaulting to `task` and rejecting it for a missing
                    // acceptance_criteria (400).
                    let has_ac = acceptance_criteria
                        .as_deref()
                        .map(|s| !s.trim().is_empty())
                        .unwrap_or(false);
                    if !has_ac {
                        body_obj.insert("task_kind".into(), serde_json::json!("subtask"));
                    }
                }
            }
            if let Some(v) = acceptance_criteria {
                body_obj.insert("acceptance_criteria".into(), serde_json::json!(v));
            }
            // Branch defaults to current HEAD when omitted and we're in
            // a git work tree.
            let resolved_branch = branch
                .clone()
                .or_else(|| detect_current_branch_for_a2a().ok().flatten());
            if let Some(v) = resolved_branch {
                body_obj.insert("branch".into(), serde_json::json!(v));
            }
            if !tag.is_empty() {
                body_obj.insert("tags".into(), serde_json::json!(tag));
            }
            if let Some(v) = assignee {
                body_obj.insert("assignee_user_id".into(), serde_json::json!(v));
            }
            let req_body = serde_json::Value::Object(body_obj);
            let resp = recall_post(&client, &url, &token, &req_body)?;
            if *json {
                println!("{}", serde_json::to_string_pretty(&resp).unwrap_or_else(|_| resp.to_string()));
            } else {
                let id = resp.get("id").and_then(|v| v.as_str()).unwrap_or("?");
                let status = resp.get("status").and_then(|v| v.as_str()).unwrap_or("?");
                println!("✓ a2a-task create id={} status={}", id, status);
            }
            Ok(())
        }
        A2aTaskAction::Get { id, json } => {
            let safe_id = a2a_safe_id(id);
            if safe_id.is_empty() {
                return Err("id contains no url-safe characters".to_string());
            }
            let url = format!(
                "{}/api/v2/a2a/tasks/{}",
                cloud_url.trim_end_matches('/'),
                safe_id
            );
            let body = recall_get(&client, &url, &token)?;
            if *json {
                println!("{}", serde_json::to_string_pretty(&body).unwrap_or_else(|_| body.to_string()));
            } else {
                println!("{}", format_a2a_task_one(&body));
            }
            Ok(())
        }
        A2aTaskAction::List {
            status,
            repo,
            limit,
            json,
        } => {
            let mut url = format!("{}/api/v2/a2a/tasks", cloud_url.trim_end_matches('/'));
            let mut sep = '?';
            recall_push_str(&mut url, &mut sep, "status", status.as_deref());
            recall_push_str(&mut url, &mut sep, "repo", repo.as_deref());
            recall_push_i64(&mut url, &mut sep, "limit", *limit);
            let body = recall_get(&client, &url, &token)?;
            if *json {
                println!("{}", serde_json::to_string_pretty(&body).unwrap_or_else(|_| body.to_string()));
            } else {
                println!("{}", format_a2a_task_list(&body));
            }
            Ok(())
        }
        A2aTaskAction::Patch {
            id,
            status,
            result_json,
            error_message,
            json,
        } => {
            let safe_id = a2a_safe_id(id);
            if safe_id.is_empty() {
                return Err("id contains no url-safe characters".to_string());
            }
            if status.trim().is_empty() {
                return Err("--status is required".to_string());
            }
            let url = format!(
                "{}/api/v2/a2a/tasks/{}",
                cloud_url.trim_end_matches('/'),
                safe_id
            );
            let mut body_obj = serde_json::Map::new();
            body_obj.insert("status".into(), serde_json::json!(status));
            if let Some(raw) = result_json {
                let parsed: serde_json::Value = serde_json::from_str(raw)
                    .map_err(|e| format!("--result-json is not valid JSON: {}", e))?;
                body_obj.insert("result".into(), parsed);
            }
            if let Some(v) = error_message {
                body_obj.insert("error_message".into(), serde_json::json!(v));
            }
            let req_body = serde_json::Value::Object(body_obj);
            let resp = recall_patch(&client, &url, &token, &req_body)?;
            if *json {
                println!("{}", serde_json::to_string_pretty(&resp).unwrap_or_else(|_| resp.to_string()));
            } else {
                let new_status = resp.get("status").and_then(|v| v.as_str()).unwrap_or("?");
                println!("✓ a2a-task patch id={} status={}", safe_id, new_status);
            }
            Ok(())
        }
    }
}

/// Bucket E4 — `aura skill record` / `aura skill stats`.
///
/// `record` POSTs a SkillOutcome JSON to the cloud. The local-fallback
/// dirty-row store lives in `manager::skill::append_local`; this CLI
/// just does the round-trip and propagates the cloud's status so
/// `flush_cloud()` (in aura-shell) can decide whether to keep the row
/// dirty.
///
/// `stats` GETs the per-provider rollup for an auto-routing taxonomy
/// cell (filtered by user via the auth token) and pretty-prints the
/// JSON so callers (PlanCard suggest_provider) can parse without an
/// extra schema layer.
fn run_skill(action: &SkillAction) -> Result<(), String> {
    let (cloud_url, token) = recall_cloud_creds()?;
    let client = cloud_http_client();
    match action {
        SkillAction::Record { json } => {
            if json.trim().is_empty() {
                return Err("--json is required".to_string());
            }
            let body: serde_json::Value = serde_json::from_str(json)
                .map_err(|e| format!("--json is not valid JSON: {}", e))?;
            let url = format!(
                "{}/api/v2/skill/outcomes",
                cloud_url.trim_end_matches('/')
            );
            let resp = recall_post(&client, &url, &token, &body)?;
            println!(
                "{}",
                serde_json::to_string(&resp).unwrap_or_else(|_| resp.to_string())
            );
            Ok(())
        }
        SkillAction::Stats {
            category,
            language,
            layer,
        } => {
            if category.trim().is_empty() {
                return Err("--category is required".to_string());
            }
            let mut url = format!(
                "{}/api/v2/skill/stats",
                cloud_url.trim_end_matches('/')
            );
            let mut sep = '?';
            recall_push_str(&mut url, &mut sep, "category", Some(category.as_str()));
            recall_push_str(&mut url, &mut sep, "language", language.as_deref());
            recall_push_str(&mut url, &mut sep, "layer", layer.as_deref());
            let resp = recall_get(&client, &url, &token)?;
            println!(
                "{}",
                serde_json::to_string(&resp).unwrap_or_else(|_| resp.to_string())
            );
            Ok(())
        }
        SkillAction::Suggest {
            category,
            language,
            layer,
            json,
        } => {
            if category.trim().is_empty() {
                return Err("--category is required".to_string());
            }
            let mut url = format!(
                "{}/api/v2/skill/stats",
                cloud_url.trim_end_matches('/')
            );
            let mut sep = '?';
            recall_push_str(&mut url, &mut sep, "category", Some(category.as_str()));
            recall_push_str(&mut url, &mut sep, "language", language.as_deref());
            recall_push_str(&mut url, &mut sep, "layer", layer.as_deref());
            let resp = recall_get(&client, &url, &token)?;
            let rows = skill_rank::parse_stats_rows(&resp);
            let best = skill_rank::best(&rows);
            if *json {
                // `null` when no provider clears the threshold — callers
                // (aura-shell suggest_provider) treat that as "no
                // suggestion, fall back to the active brain".
                let payload = match &best {
                    Some(b) => serde_json::to_value(b).unwrap_or(serde_json::Value::Null),
                    None => serde_json::Value::Null,
                };
                println!("{}", serde_json::to_string(&payload).unwrap_or_else(|_| "null".into()));
            } else {
                match &best {
                    Some(b) => {
                        let cell = describe_cell(category, language.as_deref(), layer.as_deref());
                        println!(
                            "{} {} (score {:.3}, {} samples) for {}",
                            "→".green(),
                            b.provider_id.bold(),
                            b.score,
                            b.sample_count,
                            cell,
                        );
                    }
                    None => {
                        println!(
                            "{} no provider has ≥{} samples in this cell yet — routing falls back to the active brain",
                            "·".dimmed(),
                            skill_rank::MIN_SAMPLES,
                        );
                    }
                }
            }
            Ok(())
        }
    }
}

/// Human label for a taxonomy cell — `backend/rust/api`, dropping the
/// `None` fine dimensions so the line reads cleanly.
fn describe_cell(category: &str, language: Option<&str>, layer: Option<&str>) -> String {
    let mut parts = vec![category.to_string()];
    if let Some(l) = language {
        parts.push(l.to_string());
    }
    if let Some(y) = layer {
        parts.push(y.to_string());
    }
    parts.join("/")
}

fn run_pr_commit_review(action: &PrCommitReviewAction) -> Result<(), String> {
    let (cloud_url, token) = recall_cloud_creds()?;
    let client = cloud_http_client();
    match action {
        PrCommitReviewAction::List {
            repo,
            platform,
            pr_number,
            intent_type,
            limit,
            json,
        } => {
            if repo.trim().is_empty() {
                return Err("--repo is required".to_string());
            }
            if platform.trim().is_empty() {
                return Err("--platform is required".to_string());
            }
            let mut url = format!(
                "{}/api/v2/pr/commit-reviews?repo={}&platform={}&pr_number={}",
                cloud_url.trim_end_matches('/'),
                mcp::percent_encode_unreserved(repo),
                mcp::percent_encode_unreserved(platform),
                pr_number,
            );
            let mut sep = '&';
            recall_push_str(&mut url, &mut sep, "intent_type", intent_type.as_deref());
            recall_push_i64(&mut url, &mut sep, "limit", *limit);
            let body = recall_get(&client, &url, &token)?;
            if *json {
                println!("{}", serde_json::to_string_pretty(&body).unwrap_or_else(|_| body.to_string()));
            } else {
                println!("{}", format_pr_commit_review_list(&body));
            }
            Ok(())
        }
        PrCommitReviewAction::Get {
            commit_sha,
            repo,
            platform,
            pr_number,
            json,
        } => {
            if repo.trim().is_empty() {
                return Err("--repo is required".to_string());
            }
            if platform.trim().is_empty() {
                return Err("--platform is required".to_string());
            }
            let safe_sha: String = commit_sha
                .chars()
                .filter(|c| c.is_ascii_alphanumeric())
                .collect();
            if safe_sha.is_empty() {
                return Err("commit_sha contains no url-safe characters".to_string());
            }
            let url = format!(
                "{}/api/v2/pr/commit-reviews/{}?repo={}&platform={}&pr_number={}",
                cloud_url.trim_end_matches('/'),
                safe_sha,
                mcp::percent_encode_unreserved(repo),
                mcp::percent_encode_unreserved(platform),
                pr_number,
            );
            let body = recall_get(&client, &url, &token)?;
            if *json {
                println!("{}", serde_json::to_string_pretty(&body).unwrap_or_else(|_| body.to_string()));
            } else {
                println!("{}", format_pr_commit_review_one(&body));
            }
            Ok(())
        }
        PrCommitReviewAction::Generate {
            repo,
            platform,
            pr_number,
            commits_json_file,
            pr_review_event_id,
            json,
        } => {
            if repo.trim().is_empty() {
                return Err("--repo is required".to_string());
            }
            if platform.trim().is_empty() {
                return Err("--platform is required".to_string());
            }
            if commits_json_file.trim().is_empty() {
                return Err("--commits-json-file is required".to_string());
            }
            let raw = if commits_json_file == "-" {
                let mut buf = String::new();
                std::io::Read::read_to_string(&mut std::io::stdin(), &mut buf)
                    .map_err(|e| format!("failed to read --commits-json-file from stdin: {}", e))?;
                buf
            } else {
                std::fs::read_to_string(commits_json_file)
                    .map_err(|e| format!("failed to read {}: {}", commits_json_file, e))?
            };
            let commits: serde_json::Value = serde_json::from_str(&raw)
                .map_err(|e| format!("--commits-json-file is not valid JSON: {}", e))?;
            if !commits.is_array() {
                return Err("--commits-json-file must contain a JSON array (CommitInput[])".to_string());
            }
            let url = format!("{}/api/v2/pr/commit-review-generate", cloud_url.trim_end_matches('/'));
            let mut body_obj = serde_json::Map::new();
            body_obj.insert("repo".into(), serde_json::json!(repo));
            body_obj.insert("platform".into(), serde_json::json!(platform));
            body_obj.insert("pr_number".into(), serde_json::json!(pr_number));
            if let Some(v) = pr_review_event_id {
                body_obj.insert("pr_review_event_id".into(), serde_json::json!(v));
            }
            body_obj.insert("commits".into(), commits);
            let req_body = serde_json::Value::Object(body_obj);
            let resp = recall_post(&client, &url, &token, &req_body)?;
            if *json {
                println!("{}", serde_json::to_string_pretty(&resp).unwrap_or_else(|_| resp.to_string()));
            } else {
                println!("{}", format_pr_commit_review_generate(&resp));
            }
            Ok(())
        }
    }
}

/// S2-PCR: render a per-commit-review GET (single row) as a labeled
/// block. Skips functions_modified/deleted/impacts payloads (they can
/// be large) — the user can pass --json for the full row.
fn format_pr_commit_review_one(body: &serde_json::Value) -> String {
    let sha = body.get("commit_sha").and_then(|v| v.as_str()).unwrap_or("?");
    let parent = body.get("parent_sha").and_then(|v| v.as_str()).unwrap_or("-");
    let pr = body.get("pr_number").and_then(|v| v.as_i64()).unwrap_or(0);
    let platform = body.get("platform").and_then(|v| v.as_str()).unwrap_or("-");
    let author = body.get("author_login").and_then(|v| v.as_str()).unwrap_or("-");
    let intent_summary = body.get("intent_summary").and_then(|v| v.as_str()).unwrap_or("-");
    let ai_summary = body.get("ai_summary").and_then(|v| v.as_str()).unwrap_or("-");
    let intent_type = body.get("intent_type").and_then(|v| v.as_str()).unwrap_or("untyped");
    let risk_score = body.get("risk_score").and_then(|v| v.as_i64()).unwrap_or(0);
    let risk_label = body.get("risk_label").and_then(|v| v.as_str()).unwrap_or("?");
    let model = body.get("model_used").and_then(|v| v.as_str()).unwrap_or("-");
    let files = body.get("files_touched").and_then(|v| v.as_i64()).unwrap_or(0);
    let generated = body.get("generated_at").and_then(|v| v.as_str()).unwrap_or("?");
    let mods_n = body.get("functions_modified").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0);
    let dels_n = body.get("functions_deleted").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0);
    let mut out = String::new();
    out.push_str(&format!("Commit {} (parent {})\n", &sha[..sha.len().min(12)], &parent[..parent.len().min(12)]));
    out.push_str(&format!("  pr:           {} ({})\n", pr, platform));
    out.push_str(&format!("  author:       {}\n", author));
    out.push_str(&format!("  intent_type:  {}\n", intent_type));
    out.push_str(&format!("  risk:         {} ({}/200)\n", risk_label, risk_score));
    out.push_str(&format!("  files:        {} touched, {} fn modified, {} fn deleted\n", files, mods_n, dels_n));
    out.push_str(&format!("  model:        {}\n", model));
    out.push_str(&format!("  generated_at: {}\n", generated));
    out.push_str(&format!("  intent:       {}\n", truncate(intent_summary, 200)));
    out.push_str(&format!("  ai_summary:   {}\n", truncate(ai_summary, 400)));
    out
}

/// S2-PCR: render a per-commit-review LIST as a header line + table.
/// Mirrors the `aura recall narrate-blocks` shape (header tells you
/// total/returned/max_risk, then per-row table).
fn format_pr_commit_review_list(body: &serde_json::Value) -> String {
    let repo = body.get("repo").and_then(|v| v.as_str()).unwrap_or("?");
    let platform = body.get("platform").and_then(|v| v.as_str()).unwrap_or("?");
    let pr = body.get("pr_number").and_then(|v| v.as_i64()).unwrap_or(0);
    let total = body.get("total").and_then(|v| v.as_i64()).unwrap_or(0);
    let returned = body.get("returned").and_then(|v| v.as_i64()).unwrap_or(0);
    let max_risk = body.get("max_risk_score").and_then(|v| v.as_i64());
    let mut out = String::new();
    out.push_str(&format!(
        "PR commit reviews — {} / {} #{} — total={} returned={} max_risk={}\n",
        repo,
        platform,
        pr,
        total,
        returned,
        max_risk.map(|n| n.to_string()).unwrap_or_else(|| "-".to_string()),
    ));
    if let Some(buckets) = body.get("counts_by_intent_type").and_then(|v| v.as_object()) {
        if !buckets.is_empty() {
            let mut parts: Vec<String> = buckets
                .iter()
                .map(|(k, v)| format!("{}={}", k, v.as_i64().unwrap_or(0)))
                .collect();
            parts.sort();
            out.push_str(&format!("  intent_type buckets: {}\n", parts.join(", ")));
        }
    }
    let rows = match body.get("commits").and_then(|v| v.as_array()) {
        Some(arr) => arr,
        None => {
            out.push_str("  (malformed response — missing 'commits' field)\n");
            return out;
        }
    };
    if rows.is_empty() {
        out.push_str("  (no commits)\n");
        return out;
    }
    out.push_str(&format!(
        "  {:<12}  {:<8}  {:<6}  {:<14}  {}\n",
        "sha", "risk", "score", "intent_type", "ai_summary",
    ));
    for row in rows {
        let sha = row.get("commit_sha").and_then(|v| v.as_str()).unwrap_or("?");
        let label = row.get("risk_label").and_then(|v| v.as_str()).unwrap_or("-");
        let score = row.get("risk_score").and_then(|v| v.as_i64()).unwrap_or(0);
        let it = row.get("intent_type").and_then(|v| v.as_str()).unwrap_or("untyped");
        let ai = row.get("ai_summary").and_then(|v| v.as_str()).unwrap_or("-");
        out.push_str(&format!(
            "  {:<12}  {:<8}  {:<6}  {:<14}  {}\n",
            &sha[..sha.len().min(12)],
            truncate(label, 8),
            score,
            truncate(it, 14),
            truncate(ai, 80),
        ));
    }
    out
}

/// S2-PCR: render a generate response — header + per-commit short row.
fn format_pr_commit_review_generate(body: &serde_json::Value) -> String {
    let repo = body.get("repo").and_then(|v| v.as_str()).unwrap_or("?");
    let platform = body.get("platform").and_then(|v| v.as_str()).unwrap_or("?");
    let pr = body.get("pr_number").and_then(|v| v.as_i64()).unwrap_or(0);
    let generated = body.get("generated").and_then(|v| v.as_i64()).unwrap_or(0);
    let max_risk = body.get("max_risk_score").and_then(|v| v.as_i64());
    let mut out = String::new();
    out.push_str(&format!(
        "Generated {} commit review(s) for {} / {} #{} — max_risk={}\n",
        generated,
        repo,
        platform,
        pr,
        max_risk.map(|n| n.to_string()).unwrap_or_else(|| "-".to_string()),
    ));
    if let Some(rows) = body.get("commits").and_then(|v| v.as_array()) {
        if rows.is_empty() {
            out.push_str("  (no commits returned)\n");
            return out;
        }
        out.push_str(&format!(
            "  {:<12}  {:<8}  {:<6}  {:<36}  {}\n",
            "sha", "risk", "score", "id", "model",
        ));
        for row in rows {
            let sha = row.get("commit_sha").and_then(|v| v.as_str()).unwrap_or("?");
            let label = row.get("risk_label").and_then(|v| v.as_str()).unwrap_or("-");
            let score = row.get("risk_score").and_then(|v| v.as_i64()).unwrap_or(0);
            let id = row.get("id").and_then(|v| v.as_str()).unwrap_or("?");
            let model = row.get("model_used").and_then(|v| v.as_str()).unwrap_or("-");
            out.push_str(&format!(
                "  {:<12}  {:<8}  {:<6}  {:<36}  {}\n",
                &sha[..sha.len().min(12)],
                truncate(label, 8),
                score,
                id,
                truncate(model, 40),
            ));
        }
    }
    out
}

fn run_webhooks(action: &WebhooksAction) -> Result<(), String> {
    let (cloud_url, token) = recall_cloud_creds()?;
    let client = cloud_http_client();
    match action {
        WebhooksAction::List { json } => {
            let url = format!("{}/api/v1/webhooks", cloud_url.trim_end_matches('/'));
            let body = recall_get(&client, &url, &token)?;
            if *json {
                println!("{}", serde_json::to_string_pretty(&body).unwrap_or_else(|_| body.to_string()));
            } else {
                println!("{}", format_webhooks_list(&body));
            }
            Ok(())
        }
        WebhooksAction::Create {
            webhook_type,
            webhook_url,
            events,
            json,
        } => {
            if webhook_type.trim().is_empty() {
                return Err("--webhook-type is required (e.g. 'slack' or 'discord')".to_string());
            }
            if webhook_url.trim().is_empty() {
                return Err("--webhook-url is required".to_string());
            }
            let events_vec: Vec<String> = events
                .as_deref()
                .map(|s| {
                    s.split(',')
                        .map(|e| e.trim().to_string())
                        .filter(|e| !e.is_empty())
                        .collect()
                })
                .unwrap_or_else(|| vec!["impact_alert".to_string()]);
            let url = format!("{}/api/v1/webhooks", cloud_url.trim_end_matches('/'));
            let req_body = serde_json::json!({
                "webhook_type": webhook_type,
                "webhook_url": webhook_url,
                "events": events_vec,
            });
            let resp = recall_post(&client, &url, &token, &req_body)?;
            if *json {
                println!("{}", serde_json::to_string_pretty(&resp).unwrap_or_else(|_| resp.to_string()));
            } else {
                println!("{}", format_webhook_one(&resp));
            }
            Ok(())
        }
        WebhooksAction::Delete { id, json } => {
            let safe_id = a2a_safe_id(id);
            if safe_id.is_empty() {
                return Err("id contains no url-safe characters".to_string());
            }
            let url = format!(
                "{}/api/v1/webhooks/{}",
                cloud_url.trim_end_matches('/'),
                safe_id
            );
            let resp = recall_delete(&client, &url, &token)?;
            if *json {
                println!("{}", serde_json::to_string_pretty(&resp).unwrap_or_else(|_| resp.to_string()));
            } else {
                println!("✓ webhook deleted id={}", safe_id);
            }
            Ok(())
        }
        WebhooksAction::Toggle { id, enabled, json } => {
            let safe_id = a2a_safe_id(id);
            if safe_id.is_empty() {
                return Err("id contains no url-safe characters".to_string());
            }
            let url = format!(
                "{}/api/v1/webhooks/{}/toggle",
                cloud_url.trim_end_matches('/'),
                safe_id
            );
            let req_body = serde_json::json!({ "enabled": enabled });
            let resp = recall_post(&client, &url, &token, &req_body)?;
            if *json {
                println!("{}", serde_json::to_string_pretty(&resp).unwrap_or_else(|_| resp.to_string()));
            } else {
                let new_enabled = resp
                    .get("enabled")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(*enabled);
                println!("✓ webhook toggle id={} enabled={}", safe_id, new_enabled);
            }
            Ok(())
        }
    }
}

/// S2-WH: render one webhook config as a labeled block. Used by `create`
/// (and `toggle` via --json bypass). Surfaces every load-bearing field
/// in a stable order so an operator can copy-paste id/url quickly.
fn format_webhook_one(body: &serde_json::Value) -> String {
    let inner = body.get("webhook").unwrap_or(body);
    let id = inner.get("id").and_then(|v| v.as_str()).unwrap_or("?");
    let kind = inner.get("webhook_type").and_then(|v| v.as_str()).unwrap_or("-");
    let url = inner.get("webhook_url").and_then(|v| v.as_str()).unwrap_or("-");
    let enabled = inner.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false);
    let events = inner
        .get("events")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|e| e.as_str())
                .collect::<Vec<_>>()
                .join(",")
        })
        .unwrap_or_else(|| "-".to_string());
    let mut out = String::new();
    out.push_str(&format!("Webhook {}\n", id));
    out.push_str(&format!("  type:    {}\n", kind));
    out.push_str(&format!("  url:     {}\n", url));
    out.push_str(&format!("  events:  {}\n", events));
    out.push_str(&format!("  enabled: {}\n", enabled));
    out
}

/// S2-WH: render a webhooks-list response — header line with the
/// count, then one row per config. Empty list falls back to a
/// "(no webhooks configured)" placeholder so an operator can tell
/// the difference between "the cloud sent zero rows" and "the
/// renderer is broken".
fn format_webhooks_list(body: &serde_json::Value) -> String {
    let total = body.get("total").and_then(|v| v.as_i64()).unwrap_or(0);
    let rows = match body.get("webhooks").and_then(|v| v.as_array()) {
        Some(arr) => arr,
        None => {
            return format!(
                "Webhooks — total={}\n  (malformed response — missing 'webhooks' field)\n",
                total,
            );
        }
    };
    let mut out = String::new();
    out.push_str(&format!("Webhooks — total={}\n", total));
    if rows.is_empty() {
        out.push_str("  (no webhooks configured)\n");
        return out;
    }
    out.push_str(&format!(
        "  {:<36}  {:<10}  {:<7}  {:<30}  {}\n",
        "id", "type", "enabled", "events", "url",
    ));
    for row in rows {
        let id = row.get("id").and_then(|v| v.as_str()).unwrap_or("?");
        let kind = row.get("webhook_type").and_then(|v| v.as_str()).unwrap_or("-");
        let enabled = row.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false);
        let url = row.get("webhook_url").and_then(|v| v.as_str()).unwrap_or("-");
        let events = row
            .get("events")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|e| e.as_str())
                    .collect::<Vec<_>>()
                    .join(",")
            })
            .unwrap_or_else(|| "-".to_string());
        out.push_str(&format!(
            "  {:<36}  {:<10}  {:<7}  {:<30}  {}\n",
            id,
            truncate(kind, 10),
            if enabled { "true" } else { "false" },
            truncate(&events, 30),
            truncate(url, 60),
        ));
    }
    out
}

/// S2-WH: DELETE sibling of recall_get/recall_post/recall_patch.
/// Same auth + error shape so the dispatch handlers stay symmetric.
/// Some cloud DELETE handlers answer 2xx with an empty body;
/// `recall_decode` reads that as `{}` so the caller can print "deleted"
/// instead of a confusing parse failure.
fn recall_delete(
    client: &reqwest::blocking::Client,
    url: &str,
    token: &str,
) -> Result<serde_json::Value, String> {
    let resp = client
        .delete(url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .map_err(|e| format!("request failed: {}", e))?;
    recall_decode(resp)
}

/// S2-AC: dispatch for `aura agent-card`. Hits the unauthenticated
/// `/.well-known/agent-card.json` on the configured cloud (or the
/// `--cloud` override) and renders the card. Skips the cloud token
/// path entirely — the route is unauthenticated by A2A v1.2 spec so
/// any external runtime can discover capabilities. The optional
/// `--host` arg is forwarded as the HTTP `Host` header so the card
/// the cloud builds reflects the public hostname even when the
/// caller is hitting a loopback or proxy.
fn run_agent_card(
    host: Option<&str>,
    cloud: Option<&str>,
    json: bool,
) -> Result<(), String> {
    let cloud_url = cloud
        .map(|s| s.to_string())
        .or_else(|| ConfigManager::load().cloud_url)
        .or_else(|| std::env::var("AURA_CLOUD_URL").ok())
        .unwrap_or_else(|| "https://api.auravcs.com".to_string());
    let trimmed = cloud_url.trim_end_matches('/');
    let url = format!("{}/.well-known/agent-card.json", trimmed);
    let client = cloud_http_client();
    let mut req = client.get(&url);
    if let Some(h) = host {
        let h = h.trim();
        if h.is_empty() {
            return Err("--host cannot be empty".to_string());
        }
        req = req.header("host", h);
    }
    let resp = req.send().map_err(|e| format!("request failed: {}", e))?;
    let body = recall_decode(resp)?;
    if json {
        println!("{}", serde_json::to_string_pretty(&body).unwrap_or_default());
    } else {
        print!("{}", format_agent_card(&body));
    }
    Ok(())
}

/// S2-AC: render the Agent Card as a CLI digest. Header line names
/// the agent + version + protocolVersion + endpoint URL. Capabilities
/// row mirrors the spec's three booleans (streaming, pushNotifications,
/// stateTransitionHistory). Aura-specific extended capabilities are
/// pulled from `metadata.aura.capabilities_extended` when present so
/// operators can confirm flags like `typed-intent` or
/// `signing-health-readonly` are advertised. Skills are listed
/// id+name with truncated descriptions; pass `--json` for the full
/// payload.
fn format_agent_card(body: &serde_json::Value) -> String {
    let mut out = String::new();
    let name = body.get("name").and_then(|v| v.as_str()).unwrap_or("?");
    let version = body.get("version").and_then(|v| v.as_str()).unwrap_or("?");
    let protocol = body
        .get("protocolVersion")
        .and_then(|v| v.as_str())
        .unwrap_or("?");
    let url = body.get("url").and_then(|v| v.as_str()).unwrap_or("?");
    out.push_str(&format!(
        "Agent Card — {} v{} (A2A protocol {})\n",
        name, version, protocol,
    ));
    out.push_str(&format!("  endpoint: {}\n", url));
    if let Some(desc) = body.get("description").and_then(|v| v.as_str()) {
        out.push_str(&format!("  description: {}\n", truncate(desc, 200)));
    }
    if let Some(caps) = body.get("capabilities") {
        let streaming = caps.get("streaming").and_then(|v| v.as_bool()).unwrap_or(false);
        let push = caps
            .get("pushNotifications")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let history = caps
            .get("stateTransitionHistory")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        out.push_str(&format!(
            "  capabilities: streaming={} pushNotifications={} stateTransitionHistory={}\n",
            streaming, push, history,
        ));
    }
    if let Some(ext) = body
        .get("metadata")
        .and_then(|m| m.get("aura"))
        .and_then(|a| a.get("capabilities_extended"))
        .and_then(|c| c.as_array())
    {
        let joined = ext
            .iter()
            .filter_map(|v| v.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        if !joined.is_empty() {
            out.push_str(&format!("  capabilities_extended: {}\n", joined));
        }
    }
    let skills = body
        .get("skills")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    out.push_str(&format!("  skills: {}\n", skills.len()));
    if skills.is_empty() {
        out.push_str("    (none advertised)\n");
    } else {
        for skill in &skills {
            let id = skill.get("id").and_then(|v| v.as_str()).unwrap_or("?");
            let sname = skill.get("name").and_then(|v| v.as_str()).unwrap_or("?");
            let sdesc = skill
                .get("description")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            out.push_str(&format!("    - {} ({})\n", id, sname));
            if !sdesc.is_empty() {
                out.push_str(&format!("        {}\n", truncate(sdesc, 140)));
            }
        }
    }
    out
}

/// S2-AT: render one task as a labeled block. Used by the `get`
/// subcommand. Surfaces every load-bearing field without dumping
/// the result blob (which can be large) — for the full payload use
/// --json.
fn format_a2a_task_one(body: &serde_json::Value) -> String {
    let id = body.get("id").and_then(|v| v.as_str()).unwrap_or("?");
    let status = body.get("status").and_then(|v| v.as_str()).unwrap_or("?");
    let kind = body.get("agent_kind").and_then(|v| v.as_str()).unwrap_or("-");
    let created = body.get("created_at").and_then(|v| v.as_str()).unwrap_or("?");
    let updated = body.get("updated_at").and_then(|v| v.as_str()).unwrap_or("?");
    let input_text = body.get("input_text").and_then(|v| v.as_str()).unwrap_or("-");
    let context = body.get("context_id").and_then(|v| v.as_str()).unwrap_or("-");
    let mut out = String::new();
    out.push_str(&format!("Task {}\n", id));
    out.push_str(&format!("  status:     {}\n", status));
    out.push_str(&format!("  agent_kind: {}\n", kind));
    out.push_str(&format!("  context_id: {}\n", context));
    out.push_str(&format!("  created_at: {}\n", created));
    out.push_str(&format!("  updated_at: {}\n", updated));
    out.push_str(&format!("  input:      {}\n", truncate(input_text, 200)));
    if let Some(err) = body.get("error_message").and_then(|v| v.as_str()) {
        out.push_str(&format!("  error:      {}\n", err));
    }
    if body.get("result").map(|v| !v.is_null()).unwrap_or(false) {
        out.push_str("  result:     (set — use --json for full payload)\n");
    }
    out
}

/// S2-AT: render a ListResponse as a table. The cloud envelope
/// carries `returned` + `tasks[]`; keep alignment via fixed column
/// widths and truncate long input_text. Empty list falls back to
/// "(no tasks)".
fn format_a2a_task_list(body: &serde_json::Value) -> String {
    let returned = body.get("returned").and_then(|v| v.as_i64()).unwrap_or(0);
    let rows = match body.get("tasks").and_then(|v| v.as_array()) {
        Some(arr) => arr,
        None => {
            return format!(
                "A2A tasks — returned={}\n  (malformed response — missing 'tasks' field)\n",
                returned,
            );
        }
    };
    let mut out = String::new();
    out.push_str(&format!("A2A tasks — returned={}\n", returned));
    if rows.is_empty() {
        out.push_str("  (no tasks)\n");
        return out;
    }
    out.push_str(&format!(
        "  {:<24}  {:<14}  {:<22}  {:<36}  {}\n",
        "created_at", "status", "agent_kind", "id", "input"
    ));
    for row in rows {
        let created = row.get("created_at").and_then(|v| v.as_str()).unwrap_or("?");
        let status = row.get("status").and_then(|v| v.as_str()).unwrap_or("-");
        let kind = row.get("agent_kind").and_then(|v| v.as_str()).unwrap_or("-");
        let id = row.get("id").and_then(|v| v.as_str()).unwrap_or("?");
        let input_text = row.get("input_text").and_then(|v| v.as_str()).unwrap_or("-");
        out.push_str(&format!(
            "  {:<24}  {:<14}  {:<22}  {:<36}  {}\n",
            truncate(created, 24),
            truncate(status, 14),
            truncate(kind, 22),
            id, // UUID width is exactly 36 — no truncation
            truncate(input_text, 60),
        ));
    }
    out
}

/// S2-TIC: terminal surface for the typed-intent helpers. Pure CLI
/// plumbing — every byte of behavior lives in `intent_query` so the
/// MCP and CLI outputs stay in lockstep. Reads only the local JSONL,
/// no cloud roundtrip, no token required.
fn run_intents(action: &IntentsAction) -> Result<(), String> {
    let path = std::path::Path::new(".aura/intent_log.jsonl");
    match action {
        IntentsAction::Query {
            intent_type,
            since_hours,
            limit,
            json,
        } => {
            // Validate at the CLI boundary before reading anything from
            // disk so a typo'd --type fails fast with the canonical list.
            if let Some(t) = intent_type.as_deref() {
                if !intent_query::is_canonical_intent_type(t) {
                    return Err(format!(
                        "Invalid --type '{}'. Must be one of: {}",
                        t,
                        intent_query::CANONICAL_INTENT_TYPES.join(", "),
                    ));
                }
            }
            let rows = intent_query::read_all_rows(path);
            let now_unix_secs = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let result = intent_query::query_rows(
                rows,
                intent_type.as_deref(),
                *since_hours,
                (*limit).min(500),
                now_unix_secs,
            );
            if *json {
                let body = result.to_json();
                println!(
                    "{}",
                    serde_json::to_string_pretty(&body).unwrap_or_else(|_| body.to_string())
                );
            } else {
                let scope = match &result.intent_type {
                    Some(t) => format!("type={}", t),
                    None => "all types".to_string(),
                };
                println!(
                    "Intent log query: {} (since_hours={}) — {} match(es), showing {}.",
                    scope, result.since_hours, result.total_matches, result.entries.len(),
                );
                if result.entries.is_empty() {
                    println!("  (no entries)");
                } else {
                    for r in &result.entries {
                        let ttag = r
                            .intent_type
                            .as_deref()
                            .map(|t| format!(" [{}]", t))
                            .unwrap_or_default();
                        let preview = if r.intent.len() > 100 {
                            let mut s = r.intent.clone();
                            s.truncate(97);
                            s.push_str("...");
                            s
                        } else {
                            r.intent.clone()
                        };
                        println!(
                            "  ts={} agent={}{} :: {}",
                            r.timestamp, r.agent_id, ttag, preview,
                        );
                    }
                }
            }
            Ok(())
        }
        IntentsAction::Summary {
            since_hours,
            sample_per_type,
            json,
        } => {
            if *json {
                // Structured envelope mirrors the prose form's bucketing.
                // Empty case: emit a deterministic "nothing to say" object
                // (status=empty) instead of a None — tooling consumers
                // shouldn't have to special-case missing-output vs empty.
                let v = match intent_query::build_typed_intent_summary(
                    path,
                    *since_hours,
                    *sample_per_type,
                ) {
                    Some(s) => s.to_json(),
                    None => serde_json::json!({
                        "status": "empty",
                        "since_hours": since_hours,
                        "typed_total": 0,
                        "untyped": 0,
                        "type_count": 0,
                        "buckets": [],
                    }),
                };
                println!(
                    "{}",
                    serde_json::to_string_pretty(&v).unwrap_or_else(|_| "{}".into())
                );
                return Ok(());
            }
            match intent_query::narrate_typed_intents_prose(path, *since_hours, *sample_per_type) {
                Some(prose) => {
                    print!("{}", prose);
                    Ok(())
                }
                None => {
                    println!(
                        "(no typed intents in the last {}h — log missing, empty, or all entries untyped)",
                        since_hours
                    );
                    Ok(())
                }
            }
        }
    }
}

pub(crate) fn recall_cloud_creds() -> Result<(String, String), String> {
    let config = ConfigManager::load();
    let token = config
        .cloud_api_token
        .clone()
        .or_else(|| std::env::var("AURA_CLOUD_TOKEN").ok())
        .ok_or_else(|| {
            "No cloud token configured. Run `aura cloud login` or set AURA_CLOUD_TOKEN.".to_string()
        })?;
    let cloud_url = config
        .cloud_url
        .clone()
        .or_else(|| std::env::var("AURA_CLOUD_URL").ok())
        .unwrap_or_else(|| "https://api.auravcs.com".to_string());
    Ok((cloud_url, token))
}

fn recall_push_str(url: &mut String, sep: &mut char, key: &str, value: Option<&str>) {
    if let Some(v) = value {
        if v.trim().is_empty() {
            return;
        }
        url.push(*sep);
        url.push_str(key);
        url.push('=');
        url.push_str(&mcp::percent_encode_unreserved(v));
        *sep = '&';
    }
}

fn recall_push_i64(url: &mut String, sep: &mut char, key: &str, value: Option<i64>) {
    if let Some(v) = value {
        url.push(*sep);
        url.push_str(&format!("{key}={v}"));
        *sep = '&';
    }
}

/// Turn a finished cloud response into either its JSON body or a sentence that
/// says what actually went wrong.
///
/// The order of the two checks is the whole point. These helpers used to call
/// `.json()` first and look at the status afterwards, so a 404 whose body was
/// an error page — exactly what the cloud returns for a repo it has never heard
/// of — came out as `response parse failed (HTTP 404 Not Found): error decoding
/// response body`. That reads like the CLI is broken, and it buries the one
/// fact the user needed. The status was there the whole time; it just never got
/// to speak first.
pub(crate) fn recall_decode(
    resp: reqwest::blocking::Response,
) -> Result<serde_json::Value, String> {
    let status = resp.status();
    let text = resp
        .text()
        .map_err(|e| format!("HTTP {}: reply could not be read: {}", status, e))?;
    if !status.is_success() {
        return Err(match recall_error_detail(&text) {
            Some(detail) => format!("HTTP {}: {}", status, detail),
            None => format!("HTTP {}", status),
        });
    }
    if text.trim().is_empty() {
        // A 2xx with no body is a success with nothing to say — some DELETE
        // handlers answer this way. `{}` lets the caller report it as done
        // instead of inventing a parse failure.
        return Ok(serde_json::Value::Object(Default::default()));
    }
    serde_json::from_str(&text).map_err(|e| {
        format!(
            "HTTP {}: reply was not JSON: {} — body: {}",
            status,
            e,
            truncate(text.trim(), 200)
        )
    })
}

/// The most useful sentence inside an error body.
///
/// A JSON `error`/`message`/`detail` field if the cloud sent one, else the raw
/// body trimmed. HTML error pages carry nothing worth quoting, so they yield
/// nothing and the caller prints the bare status rather than a wall of markup.
fn recall_error_detail(text: &str) -> Option<String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(trimmed) {
        for key in ["error", "message", "detail"] {
            if let Some(s) = v.get(key).and_then(|x| x.as_str()) {
                if !s.trim().is_empty() {
                    return Some(s.trim().to_string());
                }
            }
        }
        return Some(truncate(trimmed, 200));
    }
    if trimmed.starts_with('<') {
        return None;
    }
    Some(truncate(trimmed, 200))
}

pub(crate) fn recall_get(
    client: &reqwest::blocking::Client,
    url: &str,
    token: &str,
) -> Result<serde_json::Value, String> {
    let resp = client
        .get(url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .map_err(|e| format!("request failed: {}", e))?;
    recall_decode(resp)
}

/// S2-RNC: POST sibling of recall_get for endpoints that take a JSON
/// body (currently /api/v2/episodic/narrate). Same auth + error
/// shape so the dispatch handlers stay symmetric.
pub(crate) fn recall_post(
    client: &reqwest::blocking::Client,
    url: &str,
    token: &str,
    body: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let resp = client
        .post(url)
        .header("Authorization", format!("Bearer {}", token))
        .json(body)
        .send()
        .map_err(|e| format!("request failed: {}", e))?;
    recall_decode(resp)
}

/// S2-RNC: render a NarrateResponse as a CLI-friendly digest. Header
/// line names the window + event_count + model_used (so the user can
/// tell at a glance whether the cloud actually called an LLM or fell
/// back to the synthetic digest), histogram below it, then the
/// narration paragraph. Empty narration falls back to a placeholder
/// rather than printing nothing.
fn format_narrate_cloud(body: &serde_json::Value) -> String {
    let window = body
        .get("window_hours")
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    let event_count = body
        .get("event_count")
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    let model_used = body
        .get("model_used")
        .and_then(|v| v.as_str())
        .unwrap_or("?");
    let narration = body
        .get("narration")
        .and_then(|v| v.as_str())
        .unwrap_or("(empty narration)");
    let mut out = String::new();
    out.push_str(&format!(
        "Episodic narrate — window_hours={} event_count={} model_used={}\n",
        window, event_count, model_used,
    ));
    if let Some(line) = format_intent_histogram(body.get("counts_by_intent_type")) {
        out.push_str(&format!("  {}\n", line));
    }
    out.push('\n');
    out.push_str(narration);
    if !narration.ends_with('\n') {
        out.push('\n');
    }
    out
}

fn format_recall_events_table(body: &serde_json::Value) -> String {
    let total = body.get("total").and_then(|v| v.as_i64()).unwrap_or(0);
    let returned = body.get("returned").and_then(|v| v.as_i64()).unwrap_or(0);
    let mut out = String::new();
    out.push_str(&format!(
        "Episodic recall — total={} returned={}\n",
        total, returned
    ));
    // S2-TICRE: surface the typed-intent histogram from the cloud
    // response right under the totals so a CLI user sees the typed
    // breakdown at a glance, not just per-row tags. Suppressed when
    // the bucket is empty or absent (older cloud build, or all rows
    // untyped on a brand-new corpus). Shared helper with arc table.
    if let Some(line) = format_intent_histogram(body.get("counts_by_intent_type")) {
        out.push_str(&format!("  {}\n", line));
    }
    let events = match body.get("events").and_then(|v| v.as_array()) {
        Some(arr) if !arr.is_empty() => arr,
        _ => {
            out.push_str("  (no events)\n");
            return out;
        }
    };
    // S2-TICRE: include an intent_type column. "-" for untyped rows so
    // the column lines up — an absent JSON field is the cloud's signal
    // for untyped (per the EpisodicEvent skip_serializing_if contract).
    out.push_str(&format!(
        "  {:<24}  {:<22}  {:<18}  {:<11}  {}\n",
        "ts", "event_type", "agent_id", "intent_type", "focus"
    ));
    for ev in events {
        let ts = ev.get("ts").and_then(|v| v.as_str()).unwrap_or("?");
        let et = ev.get("event_type").and_then(|v| v.as_str()).unwrap_or("?");
        let ag = ev.get("agent_id").and_then(|v| v.as_str()).unwrap_or("-");
        let it = ev.get("intent_type").and_then(|v| v.as_str()).unwrap_or("-");
        let focus_fn = ev.get("focus_fn").and_then(|v| v.as_str()).unwrap_or("");
        let focus_file = ev.get("focus_file").and_then(|v| v.as_str()).unwrap_or("");
        let focus = match (focus_fn.is_empty(), focus_file.is_empty()) {
            (true, true) => "-".to_string(),
            (false, true) => focus_fn.to_string(),
            (true, false) => focus_file.to_string(),
            (false, false) => format!("{}@{}", focus_fn, focus_file),
        };
        out.push_str(&format!(
            "  {:<24}  {:<22}  {:<18}  {:<11}  {}\n",
            truncate(ts, 24),
            truncate(et, 22),
            truncate(ag, 18),
            truncate(it, 11),
            truncate(&focus, 60)
        ));
    }
    out
}

fn format_arc_segments_table(body: &serde_json::Value, multi: bool) -> String {
    let total_events = body
        .get("total_events")
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    let segment_count = body
        .get("segment_count")
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    let window = body
        .get("window_hours")
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    let gap = body
        .get("gap_minutes")
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    let mut out = String::new();
    if multi {
        let agent_ids = body
            .get("agent_ids")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str())
                    .collect::<Vec<_>>()
                    .join(",")
            })
            .unwrap_or_default();
        out.push_str(&format!(
            "Multi-agent arc — agents=[{}] window_hours={} gap_minutes={} segments={} events={}\n",
            agent_ids, window, gap, segment_count, total_events
        ));
    } else {
        let agent_id = body
            .get("agent_id")
            .and_then(|v| v.as_str())
            .unwrap_or("?");
        out.push_str(&format!(
            "Session arc — agent={} window_hours={} gap_minutes={} segments={} events={}\n",
            agent_id, window, gap, segment_count, total_events
        ));
    }
    // S2-TICRAH: symmetric to recall events — surface the cross-arc
    // typed-intent histogram right under the totals so a CLI user
    // sees the typed shape without inspecting per-segment buckets.
    // Suppressed when absent or fully untyped.
    if let Some(line) = format_intent_histogram(body.get("counts_by_intent_type")) {
        out.push_str(&format!("  {}\n", line));
    }
    let segments = match body.get("segments").and_then(|v| v.as_array()) {
        Some(arr) if !arr.is_empty() => arr,
        _ => {
            out.push_str("  (no segments)\n");
            return out;
        }
    };
    if multi {
        out.push_str(&format!(
            "  {:<22}  {:<24}  {:<24}  {:>5}  {:<28}  {}\n",
            "agent_id", "start_ts", "end_ts", "evts", "intent_types", "top_refs"
        ));
    } else {
        out.push_str(&format!(
            "  {:<24}  {:<24}  {:>5}  {:<28}  {}\n",
            "start_ts", "end_ts", "evts", "intent_types", "top_refs"
        ));
    }
    for seg in segments {
        let start = seg.get("start_ts").and_then(|v| v.as_str()).unwrap_or("?");
        let end = seg.get("end_ts").and_then(|v| v.as_str()).unwrap_or("?");
        let evts = seg.get("event_count").and_then(|v| v.as_i64()).unwrap_or(0);
        let refs = seg
            .get("top_refs")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str())
                    .collect::<Vec<_>>()
                    .join(",")
            })
            .unwrap_or_default();
        // S2-TICRAH: per-segment typed-intent bucket compressed into a
        // single column. "-" when the segment is fully untyped or the
        // bucket is absent — keeps the column lined up.
        let seg_intents = format_intent_histogram_inline(seg.get("counts_by_intent_type"))
            .unwrap_or_else(|| "-".to_string());
        if multi {
            let ag = seg.get("agent_id").and_then(|v| v.as_str()).unwrap_or("-");
            out.push_str(&format!(
                "  {:<22}  {:<24}  {:<24}  {:>5}  {:<28}  {}\n",
                truncate(ag, 22),
                truncate(start, 24),
                truncate(end, 24),
                evts,
                truncate(&seg_intents, 28),
                truncate(&refs, 60)
            ));
        } else {
            out.push_str(&format!(
                "  {:<24}  {:<24}  {:>5}  {:<28}  {}\n",
                truncate(start, 24),
                truncate(end, 24),
                evts,
                truncate(&seg_intents, 28),
                truncate(&refs, 60)
            ));
        }
    }
    out
}

/// S2-RT: render a TimelineResponse as a per-function timeline table.
/// Mirrors the shape of format_recall_events_table but leads with a
/// header naming the function + window, and includes a by_day bucket
/// list right under the histograms so a CLI user sees the temporal
/// distribution at a glance. Falls back to "(no events)" when the
/// timeline window is empty for the function.
fn format_timeline_table(body: &serde_json::Value) -> String {
    let function_name = body
        .get("function_name")
        .and_then(|v| v.as_str())
        .unwrap_or("?");
    let window = body
        .get("window_hours")
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    let total = body
        .get("total_events")
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    let returned = body
        .get("returned")
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    let mut out = String::new();
    out.push_str(&format!(
        "Per-function timeline — function={} window_hours={} total={} returned={}\n",
        function_name, window, total, returned,
    ));
    if let Some(line) = format_intent_histogram(body.get("counts_by_intent_type")) {
        out.push_str(&format!("  {}\n", line));
    }
    // by_day buckets: temporal shape over the window, oldest → newest.
    if let Some(days) = body.get("by_day").and_then(|v| v.as_array()) {
        if !days.is_empty() {
            let pretty = days
                .iter()
                .filter_map(|d| {
                    let day = d.get("day").and_then(|v| v.as_str())?;
                    let count = d.get("count").and_then(|v| v.as_i64()).unwrap_or(0);
                    Some(format!("{}={}", day, count))
                })
                .collect::<Vec<_>>()
                .join(", ");
            if !pretty.is_empty() {
                out.push_str(&format!("  by_day: {}\n", pretty));
            }
        }
    }
    if let Some(agents) = body.get("agents_seen").and_then(|v| v.as_array()) {
        let names = agents
            .iter()
            .filter_map(|x| x.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        if !names.is_empty() {
            out.push_str(&format!("  agents_seen: {}\n", names));
        }
    }
    let events = match body.get("events").and_then(|v| v.as_array()) {
        Some(arr) if !arr.is_empty() => arr,
        _ => {
            out.push_str("  (no events)\n");
            return out;
        }
    };
    out.push_str(&format!(
        "  {:<24}  {:<22}  {:<18}  {:<11}  {}\n",
        "ts", "event_type", "agent_id", "intent_type", "summary"
    ));
    for ev in events {
        let ts = ev.get("ts").and_then(|v| v.as_str()).unwrap_or("?");
        let et = ev.get("event_type").and_then(|v| v.as_str()).unwrap_or("?");
        let ag = ev.get("agent_id").and_then(|v| v.as_str()).unwrap_or("-");
        let it = ev.get("intent_type").and_then(|v| v.as_str()).unwrap_or("-");
        let summary = ev.get("summary").and_then(|v| v.as_str()).unwrap_or("-");
        out.push_str(&format!(
            "  {:<24}  {:<22}  {:<18}  {:<11}  {}\n",
            truncate(ts, 24),
            truncate(et, 22),
            truncate(ag, 18),
            truncate(it, 11),
            truncate(summary, 60),
        ));
    }
    out
}

/// S2-RAD: render an AgentDigestResponse as a per-agent digest table.
/// Same layout as format_timeline_table but leads with agent= header
/// and surfaces the digest-specific top_functions / top_files
/// rankings (already sorted server-side count desc, name asc) right
/// under the histograms — they're the whole point of the digest view
/// over the bare event list.
fn format_agent_digest_table(body: &serde_json::Value) -> String {
    let agent_id = body
        .get("agent_id")
        .and_then(|v| v.as_str())
        .unwrap_or("?");
    let window = body
        .get("window_hours")
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    let total = body
        .get("total_events")
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    let returned = body
        .get("returned")
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    let mut out = String::new();
    out.push_str(&format!(
        "Per-agent digest — agent={} window_hours={} total={} returned={}\n",
        agent_id, window, total, returned,
    ));
    if let Some(line) = format_intent_histogram(body.get("counts_by_intent_type")) {
        out.push_str(&format!("  {}\n", line));
    }
    if let Some(days) = body.get("by_day").and_then(|v| v.as_array()) {
        if !days.is_empty() {
            let pretty = days
                .iter()
                .filter_map(|d| {
                    let day = d.get("day").and_then(|v| v.as_str())?;
                    let count = d.get("count").and_then(|v| v.as_i64()).unwrap_or(0);
                    Some(format!("{}={}", day, count))
                })
                .collect::<Vec<_>>()
                .join(", ");
            if !pretty.is_empty() {
                out.push_str(&format!("  by_day: {}\n", pretty));
            }
        }
    }
    if let Some(line) = format_ref_count_line("top_functions", body.get("top_functions")) {
        out.push_str(&format!("  {}\n", line));
    }
    if let Some(line) = format_ref_count_line("top_files", body.get("top_files")) {
        out.push_str(&format!("  {}\n", line));
    }
    let events = match body.get("events").and_then(|v| v.as_array()) {
        Some(arr) if !arr.is_empty() => arr,
        _ => {
            out.push_str("  (no events)\n");
            return out;
        }
    };
    out.push_str(&format!(
        "  {:<24}  {:<22}  {:<11}  {}\n",
        "ts", "event_type", "intent_type", "summary"
    ));
    for ev in events {
        let ts = ev.get("ts").and_then(|v| v.as_str()).unwrap_or("?");
        let et = ev.get("event_type").and_then(|v| v.as_str()).unwrap_or("?");
        let it = ev.get("intent_type").and_then(|v| v.as_str()).unwrap_or("-");
        let summary = ev.get("summary").and_then(|v| v.as_str()).unwrap_or("-");
        out.push_str(&format!(
            "  {:<24}  {:<22}  {:<11}  {}\n",
            truncate(ts, 24),
            truncate(et, 22),
            truncate(it, 11),
            truncate(summary, 60),
        ));
    }
    out
}

/// S2-RAD: pretty-print top_functions / top_files RefCount arrays as
/// a one-liner like "top_functions: apply_limiter=3, retry_loop=2".
/// Returns None when the array is missing or empty so the caller can
/// suppress the line entirely (avoids printing "top_functions: " with
/// no payload on agents whose events carry no refs_fn / refs_file).
fn format_ref_count_line(label: &str, v: Option<&serde_json::Value>) -> Option<String> {
    let arr = v.and_then(|val| val.as_array())?;
    if arr.is_empty() {
        return None;
    }
    let pretty = arr
        .iter()
        .filter_map(|x| {
            let name = x.get("name").and_then(|v| v.as_str())?;
            let count = x.get("count").and_then(|v| v.as_i64()).unwrap_or(0);
            Some(format!("{}={}", name, count))
        })
        .collect::<Vec<_>>()
        .join(", ");
    if pretty.is_empty() {
        None
    } else {
        Some(format!("{}: {}", label, pretty))
    }
}

/// S2-TICRAH/TICRE shared helper. Collect a counts_by_intent_type
/// JSON object into a (name, count) Vec sorted count desc, name asc
/// (matches the ordering used in recall_narrate). Returns None when
/// the value is missing, not an object, or has no positive bucket —
/// caller decides what to print in that case (suppress entirely on
/// top-level, "-" placeholder per-segment).
fn collect_intent_histogram(v: Option<&serde_json::Value>) -> Option<Vec<(String, i64)>> {
    let buckets = v.and_then(|val| val.as_object())?;
    let mut pairs: Vec<(String, i64)> = buckets
        .iter()
        .filter_map(|(k, v)| v.as_i64().map(|n| (k.clone(), n)))
        .filter(|(_, n)| *n > 0)
        .collect();
    if pairs.is_empty() {
        return None;
    }
    pairs.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    Some(pairs)
}

/// Top-level header form: `intent_types: Refactor=2, BugFix=1`.
/// Comma-space separator since the line gets the full terminal width.
fn format_intent_histogram(v: Option<&serde_json::Value>) -> Option<String> {
    let pairs = collect_intent_histogram(v)?;
    let pretty = pairs
        .iter()
        .map(|(k, n)| format!("{}={}", k, n))
        .collect::<Vec<_>>()
        .join(", ");
    Some(format!("intent_types: {}", pretty))
}

/// Inline per-cell form: `Refactor=2,BugFix=1`. Comma-only since the
/// per-segment column is narrow and we'd lose pairs to truncation.
fn format_intent_histogram_inline(v: Option<&serde_json::Value>) -> Option<String> {
    let pairs = collect_intent_histogram(v)?;
    Some(
        pairs
            .iter()
            .map(|(k, n)| format!("{}={}", k, n))
            .collect::<Vec<_>>()
            .join(","),
    )
}

fn truncate(s: &str, max: usize) -> String {
    recall_narrate::truncate(s, max)
}

// Block-range narration helpers moved to `crate::recall_narrate` so the
// MCP wrapper (`aura_handover`) can embed the same prose without
// duplicating the implementation. Re-export the names that
// `run_recall` needs so the local match arm reads naturally.
use crate::recall_narrate::{
    build_block_narration, collect_block_summaries, current_unix_ms,
    parse_block_summary, parse_iso8601_to_ms, read_blocks_dir, top_count_pairs,
    BlockSummary,
};

fn export_usage_csv(path: &str, report: &usage::UsageReport) {
    let mut csv = String::from("session_id,agent,model,project,started_at,duration_secs,input_tokens,output_tokens,api_calls,cost_usd,files_touched,phase\n");
    for s in &report.sessions {
        csv.push_str(&format!(
            "{},{},{},{},{},{},{},{},{},{:.4},{},{}\n",
            s.session_id, s.agent_id, s.model, s.project,
            s.started_at, s.duration_secs, s.input_tokens, s.output_tokens,
            s.api_calls, s.cost_usd, s.files_touched, s.phase,
        ));
    }
    match fs::write(path, &csv) {
        Ok(_) => println!("  {} Exported {} sessions to {}", "✓".green().bold(), report.sessions.len(), path.cyan()),
        Err(e) => eprintln!("  {} Failed to write {}: {}", "✗".red(), path, e),
    }
}

fn export_plan_csv(path: &str, report: &plan_tracker::PlanReport) {
    let mut csv = String::from("date,messages,output_tokens,estimated_cost_usd\n");
    for d in &report.by_day {
        csv.push_str(&format!(
            "{},{},{},{:.2}\n",
            d.date, d.messages, d.output_tokens, d.estimated_cost,
        ));
    }
    csv.push_str("\n\nproject,messages,input_tokens,output_tokens,estimated_cost_usd\n");
    for p in &report.by_project {
        csv.push_str(&format!(
            "{},{},{},{},{:.2}\n",
            p.name, p.messages, p.input_tokens, p.output_tokens, p.estimated_cost,
        ));
    }
    match fs::write(path, &csv) {
        Ok(_) => println!("  {} Exported plan usage to {}", "✓".green().bold(), path.cyan()),
        Err(e) => eprintln!("  {} Failed to write {}: {}", "✗".red(), path, e),
    }
}

/// Color a lifecycle status for terminal output.
fn loop_status_color(status: &str) -> colored::ColoredString {
    match status {
        aura_loop::STATE_COMPLETED => status.green().bold(),
        aura_loop::STATE_WORKING => status.cyan().bold(),
        aura_loop::STATE_SUBMITTED => status.normal(),
        aura_loop::STATE_FAILED | aura_loop::STATE_REJECTED => status.red().bold(),
        aura_loop::STATE_CANCELED => status.dimmed(),
        _ => status.yellow(),
    }
}

fn print_loop_task(t: &aura_loop::LoopTask) {
    let prio = match t.priority.as_str() {
        "critical" => "critical".red().bold(),
        "high" => "high".yellow(),
        "medium" => "medium".normal(),
        _ => "low".dimmed(),
    };
    // Where a node runs is the other half of what `crew add` was told, so it
    // belongs on the row: asking for `--place cloud` and being shown a line
    // identical to a local one gives you no way to know it took.
    let place = match t.place.as_deref().and_then(aura_loop::normalize_place) {
        Some(aura_loop::PLACE_CLOUD) => format!("  {} cloud", "☁").cyan().to_string(),
        Some(aura_loop::PLACE_LOCAL) => format!("  {} local", "▪").dimmed().to_string(),
        _ => String::new(),
    };
    println!(
        "  {}  {}  [{}] {}{}",
        t.short_id().yellow().bold(),
        t.title.bold(),
        loop_status_color(&t.status),
        prio,
        place,
    );
    if !t.depends_on.is_empty() {
        let deps: Vec<String> = t
            .depends_on
            .iter()
            .map(|d| d.strip_prefix("t-").unwrap_or(d).to_string())
            .collect();
        println!("       {} {}", "depends on:".dimmed(), deps.join(", ").dimmed());
    }
}

fn handle_runner_command(sub: &RunnerSubcommands) -> Result<(), Box<dyn std::error::Error>> {
    match sub {
        RunnerSubcommands::Register { name, repo, agents } => {
            let agent_kinds = agents
                .split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>();
            runner::register(&runner::RegisterOpts {
                name: name.clone(),
                repo: repo.clone(),
                agent_kinds,
            })
        }
        RunnerSubcommands::Serve {
            name,
            agent,
            repo,
            lease_secs,
            poll_secs,
            once,
            git_sync,
            all_projects,
            workspaces_root,
        } => {
            let repo_root = std::env::current_dir()?;
            runner::serve(
                &repo_root,
                &runner::ServeOpts {
                    name: name.clone(),
                    agent: agent.clone(),
                    repo: repo.clone(),
                    lease_secs: *lease_secs,
                    poll_secs: *poll_secs,
                    once: *once,
                    git_sync: *git_sync,
                    all_projects: *all_projects,
                    workspaces_root: workspaces_root.clone(),
                },
            )
        }
        RunnerSubcommands::Status => runner::status(),
        RunnerSubcommands::Install {
            user,
            name,
            repo,
            agent,
            env_file,
            cpu_quota,
            memory_max,
            memory_swap_max,
            members,
        } => {
            let done = runner_service::install(runner_service::InstallOpts {
                user_scope: *user,
                name: name.clone(),
                repo: repo.clone(),
                agent: agent.clone(),
                env_file: env_file.clone(),
                cpu_quota: cpu_quota.clone(),
                memory_max: memory_max.clone(),
                memory_swap_max: memory_swap_max.clone(),
                members: *members,
            })?;
            println!("{} runner service installed", "✓".green());
            println!("  unit    {}", done.path.display().to_string().dimmed());
            println!(
                "  logs    {}",
                format!(
                    "journalctl {}-u {} -f",
                    if *user { "--user " } else { "" },
                    runner_service::UNIT_NAME
                )
                .dimmed()
            );
            // What the box decided about itself, printed because "one member
            // cannot wedge this machine" is a claim, and a claim nobody can see
            // the numbers behind is a slogan. It also lands in the wizard's
            // `~/aura-runner.log`, which is what the setup panel tails.
            if let Some(l) = done.limits.as_ref() {
                println!(
                    "  share   {}",
                    format!(
                        "cpu {} · memory {} · swap {}",
                        l.cpu_quota, l.memory_max, l.memory_swap_max
                    )
                    .dimmed()
                );
            }
            if done.swapless {
                println!(
                    "  {} {}",
                    "!".yellow(),
                    "This box has no swap, so a build that reaches its memory limit is killed \
                     rather than slowed. Add a swap file and it degrades instead."
                        .dimmed()
                );
            }
            println!(
                "  {}",
                "It now starts on boot and restarts if it falls over.".dimmed()
            );
            Ok(())
        }
        RunnerSubcommands::Uninstall { user } => {
            runner_service::uninstall(*user)?;
            println!("{} runner service removed", "✓".green());
            Ok(())
        }
        RunnerSubcommands::Service { user } => {
            println!("{}", runner_service::service_status(*user)?);
            Ok(())
        }
        RunnerSubcommands::Creds { cmd } => handle_runner_creds(cmd),
    }
}

fn handle_runner_creds(sub: &CredsSubcommands) -> Result<(), Box<dyn std::error::Error>> {
    match sub {
        CredsSubcommands::Set {
            agent,
            key,
            key_stdin,
        } => {
            let key = if *key_stdin {
                let mut buf = String::new();
                std::io::Read::read_to_string(&mut std::io::stdin(), &mut buf)?;
                buf
            } else {
                key.clone().ok_or("pass --key <key> or --key-stdin")?
            };
            let path = runner_creds::set(agent, &key)?;
            // Deliberately no echo of the key, not even masked — the one place
            // it could leak into a terminal recording is right here.
            println!("{} {} key stored", "✓".green(), agent);
            println!("  {}", path.display().to_string().dimmed());
            println!(
                "  {}",
                "Restart the runner to pick it up: aura runner install (or systemctl restart)."
                    .dimmed()
            );
            Ok(())
        }
        CredsSubcommands::List => {
            let creds = runner_creds::list()?;
            if creds.is_empty() {
                println!(
                    "No agent keys on this box. It can still run an agent you signed in \
                     interactively (`claude setup-token`)."
                );
                return Ok(());
            }
            for c in creds {
                println!("{} {:<8} {}  {}", "●".green(), c.agent, c.var, c.tail.dimmed());
            }
            Ok(())
        }
        CredsSubcommands::Clear { agent } => {
            if runner_creds::clear(agent)? {
                println!("{} {} key removed", "✓".green(), agent);
            } else {
                println!("No key was stored for {agent}.");
            }
            Ok(())
        }
    }
}

fn handle_loop_command(sub: &LoopSubcommands) -> Result<(), Box<dyn std::error::Error>> {
    let repo_root = std::env::current_dir()?;
    let graph = aura_loop::LoopGraph::at(&repo_root);

    match sub {
        LoopSubcommands::Add {
            title,
            input,
            priority,
            kind,
            deps,
            ac,
            agent,
            place,
            tags,
            json,
        } => {
            let tags_vec = tags
                .split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>();
            // Validate every declared dep exists before minting so the
            // graph never holds a dangling edge from `add`.
            let idx = graph.index();
            for d in deps {
                if !idx.contains_key(d) {
                    return Err(format!("dependency {d} not found").into());
                }
            }
            // Reject an unusable placement here rather than minting a node
            // that silently ignores it. `--place` is the user saying where
            // this should run; quietly dropping that would put the work on
            // the wrong machine and look like it worked.
            let placement = match place {
                Some(raw) => match aura_loop::normalize_place(raw) {
                    Some(p) => Some(p.to_string()),
                    None => {
                        return Err(format!(
                            "--place must be 'local' or 'cloud', got '{raw}'"
                        )
                        .into())
                    }
                },
                None => None,
            };
            let body = if input.is_empty() { title.clone() } else { input.clone() };
            let mut task = graph.create(
                title.clone(),
                body,
                priority.clone(),
                kind.clone(),
                deps.clone(),
                ac.clone(),
                agent.clone(),
                tags_vec,
            )?;
            if placement.is_some() {
                task.place = placement;
                graph.save(&task)?;
            }
            if *json {
                println!("{}", serde_json::to_string(&task)?);
            } else {
                println!("{} minted", task.short_id().green().bold());
                print_loop_task(&task);
            }
        }
        LoopSubcommands::Dep { id, on, rm, json } => {
            let task = if *rm {
                graph.rm_dep(id, on).map_err(|e| -> Box<dyn std::error::Error> { e.into() })?
            } else {
                graph.add_dep(id, on).map_err(|e| -> Box<dyn std::error::Error> { e.into() })?
            };
            if *json {
                println!("{}", serde_json::to_string(&task)?);
            } else {
                let verb = if *rm { "removed" } else { "added" };
                println!("edge {verb}: {} → {}", id.yellow(), on.yellow());
                print_loop_task(&task);
            }
        }
        LoopSubcommands::Ready { json } => {
            let ready = aura_loop::ready_set(&graph.list());
            if *json {
                println!("{}", serde_json::to_string(&ready)?);
            } else if ready.is_empty() {
                println!("{}", "Ready set is empty — nothing unblocked to work on.".dimmed());
            } else {
                println!("{} ({})", "READY".green().bold(), ready.len());
                for t in &ready {
                    print_loop_task(t);
                }
            }
        }
        LoopSubcommands::List { json } => {
            let view = aura_loop::ready_view(&graph.list());
            if *json {
                let all = graph.list();
                println!("{}", serde_json::to_string(&all)?);
            } else {
                let section = |label: colored::ColoredString, items: &[aura_loop::LoopTask]| {
                    if !items.is_empty() {
                        println!("\n{} ({})", label, items.len());
                        for t in items {
                            print_loop_task(t);
                        }
                    }
                };
                section("READY".green().bold(), &view.ready);
                section("WORKING".cyan().bold(), &view.working);
                if !view.blocked.is_empty() {
                    println!("\n{} ({})", "BLOCKED".yellow().bold(), view.blocked.len());
                    for (t, unmet) in &view.blocked {
                        print_loop_task(t);
                        let u: Vec<String> = unmet
                            .iter()
                            .map(|d| d.strip_prefix("t-").unwrap_or(d).to_string())
                            .collect();
                        println!("       {} {}", "waiting on:".red().dimmed(), u.join(", ").red().dimmed());
                    }
                }
                section("DONE".dimmed(), &view.done);
                section("OTHER".yellow(), &view.other);
                if graph.list().is_empty() {
                    println!("{}", "Graph is empty. `aura loop add <title>` to mint a node.".dimmed());
                }
            }
        }
        LoopSubcommands::Show { id, json } => {
            let task = graph
                .get(id)
                .ok_or_else(|| -> Box<dyn std::error::Error> { format!("node {id} not found").into() })?;
            if *json {
                println!("{}", serde_json::to_string_pretty(&task)?);
            } else {
                print_loop_task(&task);
                if let Some(ac) = &task.acceptance_criteria {
                    println!("       {} {}", "accept:".dimmed(), ac);
                }
                if let Some(agent) = &task.agent_kind {
                    println!("       {} {}", "agent:".dimmed(), agent);
                }
                if let Some(sha) = &task.commit_sha {
                    println!("       {} {}", "commit:".dimmed(), sha);
                }
                if let Some(lease) = &task.lease {
                    println!("       {} held by {} until {}", "lease:".dimmed(), lease.holder, lease.expires_at);
                }
                if let Some(err) = &task.error_message {
                    println!("       {} {}", "error:".red().dimmed(), err);
                }
            }
        }
        LoopSubcommands::Status { json } => {
            let view = aura_loop::ready_view(&graph.list());
            if *json {
                let obj = serde_json::json!({
                    "ready": view.ready.len(),
                    "blocked": view.blocked.len(),
                    "working": view.working.len(),
                    "done": view.done.len(),
                    "other": view.other.len(),
                });
                println!("{}", serde_json::to_string(&obj)?);
            } else {
                println!(
                    "{} ready · {} blocked · {} working · {} done · {} other",
                    view.ready.len().to_string().green().bold(),
                    view.blocked.len().to_string().yellow(),
                    view.working.len().to_string().cyan(),
                    view.done.len().to_string().dimmed(),
                    view.other.len().to_string().dimmed(),
                );
            }
        }
        LoopSubcommands::Set { id, status, json } => {
            if !aura_loop::TERMINAL_STATES.contains(&status.as_str())
                && ![
                    aura_loop::STATE_SUBMITTED,
                    aura_loop::STATE_WORKING,
                    aura_loop::STATE_INPUT_REQUIRED,
                    aura_loop::STATE_AUTH_REQUIRED,
                    aura_loop::STATE_PAUSED,
                ]
                .contains(&status.as_str())
            {
                return Err(format!("invalid status '{status}'").into());
            }
            let task = graph
                .set_status(id, status)
                .map_err(|e| -> Box<dyn std::error::Error> { e.into() })?;
            if *json {
                println!("{}", serde_json::to_string(&task)?);
            } else {
                println!("{} → {}", task.short_id().yellow().bold(), loop_status_color(&task.status));
            }
        }
        LoopSubcommands::Pause { id, goal, crew, json } => {
            // Single node, or a whole goal/crew scope — never both.
            if id.is_some() && (goal.is_some() || crew.is_some()) {
                return Err("give a node id OR a --goal/--crew scope, not both".into());
            }
            if let Some(id) = id {
                let task = graph
                    .pause(id)
                    .map_err(|e| -> Box<dyn std::error::Error> { e.into() })?;
                if *json {
                    println!("{}", serde_json::to_string(&task)?);
                } else {
                    println!("{} → {}", task.short_id().yellow().bold(), loop_status_color(&task.status));
                }
            } else {
                let scope = aura_loop::RunScope { goal: goal.clone(), crew: crew.clone() };
                if scope.is_unscoped() {
                    return Err("nothing to pause — pass a node id, --goal, or --crew".into());
                }
                let paused = graph.pause_scope(&scope);
                if *json {
                    println!("{}", serde_json::to_string(&paused)?);
                } else {
                    println!("{} paused {} task(s)", "⏸".yellow().bold(), paused.len());
                }
            }
        }
        LoopSubcommands::Resume { id, goal, crew, json } => {
            if id.is_some() && (goal.is_some() || crew.is_some()) {
                return Err("give a node id OR a --goal/--crew scope, not both".into());
            }
            if let Some(id) = id {
                let task = graph
                    .resume(id)
                    .map_err(|e| -> Box<dyn std::error::Error> { e.into() })?;
                if *json {
                    println!("{}", serde_json::to_string(&task)?);
                } else {
                    println!("{} → {}", task.short_id().yellow().bold(), loop_status_color(&task.status));
                }
            } else {
                let scope = aura_loop::RunScope { goal: goal.clone(), crew: crew.clone() };
                if scope.is_unscoped() {
                    return Err("nothing to resume — pass a node id, --goal, or --crew".into());
                }
                let resumed = graph.resume_scope(&scope);
                if *json {
                    println!("{}", serde_json::to_string(&resumed)?);
                } else {
                    println!("{} resumed {} task(s)", "▶".green().bold(), resumed.len());
                }
            }
        }
        LoopSubcommands::Runs { limit, json } => {
            let mut runs = aura_loop::run_log::RunLedger::at(&repo_root).list();
            if *limit > 0 && runs.len() > *limit {
                runs.truncate(*limit);
            }
            if *json {
                println!("{}", serde_json::to_string(&runs)?);
            } else if runs.is_empty() {
                println!("{}", "No runs yet — `aura loop run` records each run here.".dimmed());
            } else {
                for r in &runs {
                    let scope = match (&r.goal, &r.crew) {
                        (Some(g), _) => format!("goal:{g}"),
                        (None, Some(c)) => format!("crew:{c}"),
                        (None, None) => "whole graph".to_string(),
                    };
                    let dur = r
                        .duration_secs()
                        .map(|s| format!("{s}s"))
                        .unwrap_or_else(|| "—".to_string());
                    println!(
                        "{}  {}  {} ✓ {} ✗  ·  {} node(s)  ·  {}  ·  {}",
                        r.id.cyan().bold(),
                        scope.dimmed(),
                        r.completed.to_string().green(),
                        r.failed.to_string().red(),
                        r.attempted,
                        dur.dimmed(),
                        r.runner.dimmed(),
                    );
                }
            }
        }
        LoopSubcommands::Crews { json } => {
            let registry = aura_loop::crew::CrewRegistry::at(&repo_root);
            let metas = registry.list();
            let all = graph.list();
            let summaries = aura_loop::crews_summary(&all);
            if *json {
                // Pair each registered crew with its live summary (or zeros).
                let rows: Vec<serde_json::Value> = metas
                    .iter()
                    .map(|m| {
                        let s = summaries.iter().find(|c| c.crew == m.id);
                        serde_json::json!({
                            "id": m.id,
                            "title": m.title,
                            "description": m.description,
                            "total": s.map(|s| s.total).unwrap_or(0),
                            "ready": s.map(|s| s.ready).unwrap_or(0),
                            "working": s.map(|s| s.working).unwrap_or(0),
                            "done": s.map(|s| s.done).unwrap_or(0),
                            "failed": s.map(|s| s.failed).unwrap_or(0),
                        })
                    })
                    .collect();
                println!("{}", serde_json::to_string(&rows)?);
            } else {
                for m in &metas {
                    let s = summaries.iter().find(|c| c.crew == m.id);
                    let total = s.map(|s| s.total).unwrap_or(0);
                    let working = s.map(|s| s.working).unwrap_or(0);
                    let done = s.map(|s| s.done).unwrap_or(0);
                    println!(
                        "{}  {}  ·  {} task(s)  ·  {} working  ·  {} done",
                        m.id.cyan().bold(),
                        m.title.dimmed(),
                        total,
                        working.to_string().yellow(),
                        done.to_string().green(),
                    );
                }
            }
        }
        LoopSubcommands::Spawn {
            title,
            description,
            tasks,
            json,
        } => {
            let registry = aura_loop::crew::CrewRegistry::at(&repo_root);
            let now = chrono::Utc::now().timestamp();
            let meta = registry.spawn(title.clone(), description.clone(), now)?;
            let mut moved: Vec<String> = Vec::new();
            for id in tasks {
                if graph.set_crew(id, Some(meta.id.clone())).is_ok() {
                    moved.push(id.clone());
                }
            }
            if *json {
                println!(
                    "{}",
                    serde_json::json!({ "id": meta.id, "title": meta.title, "moved": moved })
                );
            } else {
                println!(
                    "{} {} ({})",
                    "Spawned crew".green().bold(),
                    meta.title,
                    meta.id.cyan(),
                );
                if !moved.is_empty() {
                    println!("  moved {} task(s) in", moved.len());
                }
                println!(
                    "  run it with: {}",
                    format!("aura loop run --crew {}", meta.id).dimmed()
                );
            }
        }
        LoopSubcommands::Run {
            agent,
            lease_secs,
            max,
            verify,
            dry_run,
            watch,
            jobs,
            rollback,
            goal,
            crew,
            place,
            json,
        } => {
            let here = aura_loop::normalize_place(place).ok_or_else(|| {
                format!("--place must be 'local' or 'cloud', got '{place}'")
            })?;
            let opts = aura_loop_run::RunOpts {
                agent: agent.clone(),
                lease_secs: *lease_secs,
                max: *max,
                verify: verify.clone(),
                dry_run: *dry_run,
                watch: *watch,
                jobs: *jobs,
                rollback: *rollback,
                goal: goal.clone(),
                crew: crew.clone(),
                place: here.to_string(),
                json: *json,
            };
            aura_loop_run::run(&repo_root, &opts)?;
        }
        LoopSubcommands::Sync {
            pull_only,
            push_only,
            remote,
            json,
        } => {
            let git = |args: &[&str]| -> std::io::Result<std::process::Output> {
                std::process::Command::new("git")
                    .args(args)
                    .current_dir(&repo_root)
                    .output()
            };
            let branch = {
                let out = git(&["rev-parse", "--abbrev-ref", "HEAD"])?;
                String::from_utf8_lossy(&out.stdout).trim().to_string()
            };
            if branch.is_empty() || branch == "HEAD" {
                return Err("not on a branch — cannot sync the task graph".into());
            }

            let do_push = !*pull_only;
            let do_pull = !*push_only;
            let mut committed = false;
            let mut pulled = false;
            let mut pushed = false;
            let mut notes: Vec<String> = Vec::new();

            // 1. Stage + commit local graph changes. Only the durable graph is
            //    tracked; lease sidecars are gitignored, so they never travel.
            //    --no-verify: this is bookkeeping, not semantic code work.
            if do_push && repo_root.join(".aura").join("a2a").exists() {
                let _ = git(&["add", ".aura/a2a"])?;
                // `--quiet` exits non-zero when there IS a staged diff.
                let staged = git(&["diff", "--cached", "--quiet", "--", ".aura/a2a"])?;
                if !staged.status.success() {
                    let out = git(&[
                        "commit",
                        "--no-verify",
                        "-m",
                        "aura: sync task graph",
                        "--",
                        ".aura/a2a",
                    ])?;
                    if out.status.success() {
                        committed = true;
                    } else {
                        notes.push(format!("commit: {}", String::from_utf8_lossy(&out.stderr).trim()));
                    }
                }
            }

            // 2. Pull peers' graph updates. --rebase keeps graph history linear;
            //    --autostash tolerates a dirty tree (e.g. an agent mid-edit).
            if do_pull {
                let out = git(&["pull", "--rebase", "--autostash", remote.as_str(), branch.as_str()])?;
                if out.status.success() {
                    pulled = true;
                } else {
                    notes.push(format!("pull: {}", String::from_utf8_lossy(&out.stderr).trim()));
                }
            }

            // 3. Push if we have commits the remote lacks (graph and/or the
            //    agent's code commits from this cycle).
            if do_push {
                let range = format!("{remote}/{branch}..HEAD");
                let ahead = git(&["rev-list", "--count", range.as_str()])?;
                let ahead_n: i64 = String::from_utf8_lossy(&ahead.stdout).trim().parse().unwrap_or(-1);
                if ahead_n != 0 {
                    let out = git(&["push", remote.as_str(), branch.as_str()])?;
                    if out.status.success() {
                        pushed = true;
                    } else {
                        notes.push(format!("push: {}", String::from_utf8_lossy(&out.stderr).trim()));
                    }
                }
            }

            if *json {
                println!(
                    "{}",
                    serde_json::json!({
                        "branch": branch,
                        "remote": remote,
                        "committed": committed,
                        "pulled": pulled,
                        "pushed": pushed,
                        "notes": notes,
                    })
                );
            } else {
                let mut parts: Vec<String> = Vec::new();
                if committed {
                    parts.push("committed graph".into());
                }
                if pulled {
                    parts.push("pulled".into());
                }
                if pushed {
                    parts.push("pushed".into());
                }
                if parts.is_empty() {
                    parts.push("nothing to sync".into());
                }
                println!("{} {} ({})", "↕".cyan().bold(), parts.join(" · "), branch);
                for n in &notes {
                    println!("  {} {}", "!".yellow(), n);
                }
            }
        }
        LoopSubcommands::CloudSync {
            pull,
            push,
            repo,
            agent,
            limit,
            json,
        } => {
            let (cloud_url, token) = recall_cloud_creds()?;
            let client = cloud_http_client();
            let base = cloud_url.trim_end_matches('/').to_string();

            // Scope to the current git remote (owner/repo) unless overridden. A
            // non-github remote means "org-wide" — no repo filter.
            let repo_slug = repo.clone().or_else(|| {
                let r = crate::live_events::repo_name();
                if r.contains('/') {
                    Some(r)
                } else {
                    None
                }
            });

            // Neither flag → do both legs (the runner's normal cycle).
            let do_pull = *pull || !*push;
            let do_push = *push || !*pull;

            let mut pulled = 0usize;
            let mut pushed = 0usize;
            let mut notes: Vec<String> = Vec::new();
            // Set when the board could not be read at all. A count of zero then
            // means "we never saw the list", not "the list was empty", and the
            // summary line has to say which — a runner pointed at a repo the
            // cloud has never heard of otherwise reports a clean idle cycle
            // forever.
            let mut pull_error: Option<String> = None;

            // PULL — ready cloud tasks become local graph nodes. Each is claimed
            // on the cloud (→ working) so a second runner won't also pull it.
            if do_pull {
                let mut url = format!("{}/api/v2/a2a/tasks", base);
                let mut sep = '?';
                recall_push_str(&mut url, &mut sep, "status", Some("submitted"));
                recall_push_str(&mut url, &mut sep, "repo", repo_slug.as_deref());
                recall_push_i64(&mut url, &mut sep, "limit", Some(*limit));
                match recall_get(&client, &url, &token) {
                    Ok(body) => {
                        let already: std::collections::HashSet<String> =
                            graph.list().into_iter().filter_map(|t| t.remote_id).collect();
                        let tasks = body
                            .get("tasks")
                            .and_then(|v| v.as_array())
                            .cloned()
                            .unwrap_or_default();
                        for ct in tasks {
                            let cid = match ct.get("id").and_then(|v| v.as_str()) {
                                Some(s) => s.to_string(),
                                None => continue,
                            };
                            if already.contains(&cid) {
                                continue; // already mirrored locally
                            }
                            let input = ct
                                .get("input_text")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string();
                            let title: String = input
                                .lines()
                                .next()
                                .unwrap_or("(cloud task)")
                                .chars()
                                .take(120)
                                .collect();
                            let kind = ct
                                .get("task_kind")
                                .and_then(|v| v.as_str())
                                .unwrap_or("task")
                                .to_string();
                            let ac = ct
                                .get("acceptance_criteria")
                                .and_then(|v| v.as_str())
                                .map(|s| s.to_string());
                            // Cloud agent_kind is namespaced ("a2a:claude"); the
                            // runner dispatches the bare provider id.
                            let task_agent = ct
                                .get("agent_kind")
                                .and_then(|v| v.as_str())
                                .map(|s| s.trim_start_matches("a2a:").to_string())
                                .filter(|s| !s.is_empty())
                                .unwrap_or_else(|| agent.clone());
                            let tags: Vec<String> = ct
                                .get("tags")
                                .and_then(|v| v.as_array())
                                .map(|a| {
                                    a.iter()
                                        .filter_map(|t| t.as_str().map(|s| s.to_string()))
                                        .collect()
                                })
                                .unwrap_or_default();
                            let mut node = match graph.create(
                                title,
                                input,
                                "medium".to_string(),
                                kind,
                                vec![],
                                ac,
                                Some(task_agent),
                                tags,
                            ) {
                                Ok(n) => n,
                                Err(e) => {
                                    notes.push(format!("create {cid}: {e}"));
                                    continue;
                                }
                            };
                            node.remote_id = Some(cid.clone());
                            node.branch = ct
                                .get("branch")
                                .and_then(|v| v.as_str())
                                .map(|s| s.to_string());
                            if let Err(e) = graph.save(&node) {
                                notes.push(format!("save {cid}: {e}"));
                                continue;
                            }
                            let purl =
                                format!("{}/api/v2/a2a/tasks/{}", base, a2a_safe_id(&cid));
                            let pbody = serde_json::json!({ "status": "working" });
                            if let Err(e) = recall_patch(&client, &purl, &token, &pbody) {
                                notes.push(format!("claim {cid}: {e}"));
                            }
                            pulled += 1;
                        }
                    }
                    Err(e) => {
                        notes.push(format!("pull: {e}"));
                        pull_error = Some(e);
                    }
                }
            }

            // OFFER — local nodes placed `cloud` that the board has never seen
            // get minted onto it, so a runner can claim them.
            //
            // This is the leg that was missing. `--pull` brought cloud-born work
            // down and `--push` reported it back up, but work born HERE — the
            // node you just added while looking at your own worktree — had no
            // way to reach a box. "Move this to the cloud" was a sentence the
            // system could not act on. Now placement is the instruction and this
            // is what carries it out.
            let mut offered = 0usize;
            if do_push {
                for mut node in graph.list() {
                    if node.place.as_deref().and_then(aura_loop::normalize_place)
                        != Some(aura_loop::PLACE_CLOUD)
                    {
                        continue;
                    }
                    // Already on the board, or already finished here.
                    if node.remote_id.is_some() || node.is_terminal() {
                        continue;
                    }
                    let mut b = serde_json::Map::new();
                    let kind_agent = node.agent_kind.clone().unwrap_or_else(|| agent.clone());
                    b.insert("agent_kind".into(), serde_json::json!(kind_agent));
                    b.insert("input".into(), serde_json::json!(node.input));
                    if let Some(r) = &repo_slug {
                        b.insert("repo".into(), serde_json::json!(r));
                    }
                    // The server requires acceptance criteria for plan/wave/task
                    // but not for a leaf. A node with no AC is offered as a
                    // subtask rather than rejected — the placement instruction
                    // matters more than the taxonomy, and refusing here would
                    // strand the work on the laptop with no explanation.
                    match &node.acceptance_criteria {
                        Some(ac) if !ac.trim().is_empty() => {
                            b.insert("task_kind".into(), serde_json::json!(node.task_kind));
                            b.insert("acceptance_criteria".into(), serde_json::json!(ac));
                        }
                        _ => {
                            b.insert("task_kind".into(), serde_json::json!("subtask"));
                        }
                    }
                    // Carry the branch so the desktop's placement badge can put
                    // the cloud mark on the right worktree row.
                    if let Some(br) = node
                        .branch
                        .clone()
                        .or_else(|| detect_current_branch_for_a2a().ok().flatten())
                    {
                        b.insert("branch".into(), serde_json::json!(br));
                    }
                    if !node.tags.is_empty() {
                        b.insert("tags".into(), serde_json::json!(node.tags));
                    }
                    let curl = format!("{}/api/v2/a2a/tasks", base);
                    match recall_post(&client, &curl, &token, &serde_json::Value::Object(b)) {
                        Ok(resp) => match resp.get("id").and_then(|v| v.as_str()) {
                            Some(cid) => {
                                node.remote_id = Some(cid.to_string());
                                if let Err(e) = graph.save(&node) {
                                    // The board now holds work whose local node
                                    // doesn't know its id. Say so loudly — the
                                    // alternative is a task that runs on the box
                                    // and never reports home.
                                    notes.push(format!(
                                        "offered {} as {cid} but could not record the id locally: {e}",
                                        node.short_id()
                                    ));
                                } else {
                                    offered += 1;
                                }
                            }
                            None => notes.push(format!(
                                "offer {}: the board accepted it but returned no id",
                                node.short_id()
                            )),
                        },
                        Err(e) => notes.push(format!("offer {}: {e}", node.short_id())),
                    }
                }
            }

            // RECONCILE — adopt the cloud's answer for work we sent away.
            //
            // Only nodes this machine offered (`place: cloud` + a remote id +
            // not yet finished). A runner's own pulled nodes carry no placement,
            // so it skips this entirely instead of re-reading its own board.
            let mut adopted = 0usize;
            if do_pull {
                const PUSHED_TAG: &str = "cloud:pushed";
                for mut node in graph.list() {
                    if node.place.as_deref().and_then(aura_loop::normalize_place)
                        != Some(aura_loop::PLACE_CLOUD)
                    {
                        continue;
                    }
                    if node.is_terminal() {
                        continue;
                    }
                    let rid = match &node.remote_id {
                        Some(r) => r.clone(),
                        None => continue, // not offered yet
                    };
                    let gurl = format!("{}/api/v2/a2a/tasks/{}", base, a2a_safe_id(&rid));
                    let row = match recall_get(&client, &gurl, &token) {
                        Ok(v) => v,
                        Err(e) => {
                            notes.push(format!("reconcile {}: {e}", node.short_id()));
                            continue;
                        }
                    };
                    let remote_status = match row.get("status").and_then(|v| v.as_str()) {
                        Some(s) if !s.is_empty() => s.to_string(),
                        _ => continue,
                    };
                    if remote_status == node.status {
                        continue;
                    }
                    let became_terminal = aura_loop::is_terminal(&remote_status);
                    node.status = remote_status;
                    if let Some(sha) = row.get("commit_sha").and_then(|v| v.as_str()) {
                        node.commit_sha = Some(sha.to_string());
                    }
                    if let Some(err) = row.get("error_message").and_then(|v| v.as_str()) {
                        node.error_message = Some(err.to_string());
                    }
                    if let Some(res) = row.get("result") {
                        if !res.is_null() {
                            node.result = Some(res.clone());
                        }
                    }
                    // This outcome came FROM the cloud, so the push leg must not
                    // send it back — terminal states are sticky server-side and
                    // re-PATCHing one answers 409. Reusing the push leg's own
                    // tag is the honest way to say "already reported".
                    if became_terminal && !node.tags.iter().any(|t| t == PUSHED_TAG) {
                        node.tags.push(PUSHED_TAG.to_string());
                    }
                    match graph.save(&node) {
                        Ok(_) => adopted += 1,
                        Err(e) => notes.push(format!("reconcile save {}: {e}", node.short_id())),
                    }
                }
            }

            // PUSH — finished local nodes report back to the cloud once. The
            // `cloud:pushed` tag keeps later cycles from re-PATCHing.
            if do_push {
                const PUSHED_TAG: &str = "cloud:pushed";
                for mut node in graph.list() {
                    let rid = match &node.remote_id {
                        Some(r) => r.clone(),
                        None => continue,
                    };
                    if !node.is_terminal() {
                        continue;
                    }
                    if node.tags.iter().any(|t| t == PUSHED_TAG) {
                        continue;
                    }
                    let purl = format!("{}/api/v2/a2a/tasks/{}", base, a2a_safe_id(&rid));
                    let mut pb = serde_json::Map::new();
                    pb.insert("status".into(), serde_json::json!(node.status));
                    if let Some(sha) = &node.commit_sha {
                        pb.insert("commit_sha".into(), serde_json::json!(sha));
                    }
                    if let Some(res) = &node.result {
                        pb.insert("result".into(), res.clone());
                    }
                    if let Some(err) = &node.error_message {
                        pb.insert("error_message".into(), serde_json::json!(err));
                    }
                    match recall_patch(&client, &purl, &token, &serde_json::Value::Object(pb)) {
                        Ok(_) => {
                            node.tags.push(PUSHED_TAG.to_string());
                            let _ = graph.save(&node);
                            pushed += 1;
                        }
                        Err(e) => notes.push(format!("push {rid}: {e}")),
                    }
                }
            }

            if *json {
                println!(
                    "{}",
                    serde_json::json!({
                        "repo": repo_slug,
                        "pulled": pulled,
                        "pushed": pushed,
                        // Local work handed to the board this cycle, and cloud
                        // outcomes adopted back onto local nodes. Separate from
                        // pulled/pushed because they move work the other way.
                        "offered": offered,
                        "adopted": adopted,
                        // Present only when the board could not be read, so a
                        // caller can tell an idle cycle from a broken one
                        // without string-matching the notes.
                        "pull_error": pull_error,
                        "notes": notes,
                    })
                );
            } else {
                let mut parts: Vec<String> = Vec::new();
                if do_pull {
                    parts.push(match &pull_error {
                        Some(_) => "could not read the board".to_string(),
                        None => format!("pulled {pulled}"),
                    });
                    if adopted > 0 {
                        parts.push(format!("heard back on {adopted}"));
                    }
                }
                if do_push {
                    if offered > 0 {
                        parts.push(format!("sent {offered}"));
                    }
                    parts.push(format!("pushed {pushed}"));
                }
                let scope = repo_slug.as_deref().unwrap_or("org-wide");
                println!("{} cloud {} ({})", "☁".cyan().bold(), parts.join(" · "), scope);
                for n in &notes {
                    println!("  {} {}", "!".yellow(), n);
                }
            }
        }
        LoopSubcommands::Seed { from, agent, json } => {
            let plan_path = match from {
                Some(p) => std::path::PathBuf::from(p),
                None => repo_root.join(".aura").join("plans").join("PLAN.md"),
            };
            let ids = aura_loop_run::seed_from_plan(&repo_root, &plan_path, agent)?;
            if *json {
                println!("{}", serde_json::to_string(&ids)?);
            } else {
                println!(
                    "{} seeded {} wave node(s) from {}",
                    "✓".green().bold(),
                    ids.len(),
                    plan_path.display()
                );
                let graph = aura_loop::LoopGraph::at(&repo_root);
                for id in &ids {
                    if let Some(t) = graph.get(id) {
                        print_loop_task(&t);
                    }
                }
            }
        }
        LoopSubcommands::PlanContext { json } => {
            // The orderless pile, chunked exactly as the desktop planner sees
            // it (`aura_loop::planning`). An agent reads this, reasons the real
            // dependencies, then writes them back with `loop plan-apply`.
            let all = graph.list();
            let ctx = aura_loop::planning::plan_context(&all);
            let chunks: Vec<serde_json::Value> = ctx
                .chunks
                .iter()
                .map(|c| {
                    let tasks: Vec<serde_json::Value> = c
                        .node_ids
                        .iter()
                        .map(|id| {
                            let (title, detail) = graph
                                .get(id)
                                .map(|t| (t.title, t.input))
                                .unwrap_or_default();
                            serde_json::json!({ "id": id, "title": title, "detail": detail })
                        })
                        .collect();
                    serde_json::json!({ "label": c.label, "seed_goal": c.seed_goal, "tasks": tasks })
                })
                .collect();
            let payload = serde_json::json!({
                "considered": ctx.considered,
                "deferred": ctx.deferred,
                "chunk_count": chunks.len(),
                "chunks": chunks,
                "how_to_apply": "Within each chunk, work out the REAL dependencies (only where one task needs another's output), name the goal each connected group adds up to, group goals under a few larger objectives, then pipe { \"edges\": [{task,depends_on}], \"goals\": [{goal,tasks}], \"objectives\": [{objective,goals}] } into `aura loop plan-apply`.",
            });
            if *json {
                println!("{}", serde_json::to_string(&payload)?);
            } else {
                println!("{}", serde_json::to_string_pretty(&payload)?);
            }
        }
        LoopSubcommands::PlanApply { file, json } => {
            let raw = match file {
                Some(p) => std::fs::read_to_string(p)?,
                None => {
                    use std::io::Read;
                    let mut s = String::new();
                    std::io::stdin().read_to_string(&mut s)?;
                    s
                }
            };
            let doc: serde_json::Value = serde_json::from_str(raw.trim())
                .map_err(|e| -> Box<dyn std::error::Error> { format!("plan JSON: {e}").into() })?;
            let take = |key: &str| -> serde_json::Value {
                doc.get(key).cloned().unwrap_or_else(|| serde_json::json!([]))
            };
            let edges: Vec<aura_loop::planning::PlanEdge> = serde_json::from_value(take("edges"))?;
            let goals: Vec<aura_loop::planning::PlanGoal> = serde_json::from_value(take("goals"))?;
            let objectives: Vec<aura_loop::planning::PlanObjective> =
                serde_json::from_value(take("objectives"))?;
            if edges.is_empty() && goals.is_empty() && objectives.is_empty() {
                return Err("nothing to apply — provide at least one of edges, goals, objectives".into());
            }
            let report = aura_loop::planning::apply_plan(&graph, &edges, &goals, &objectives);
            if *json {
                println!("{}", serde_json::to_string(&report)?);
            } else {
                println!(
                    "{} wired {} edge(s){}, {} task(s) connected, {} goal(s), {} objective(s)",
                    "✓".green().bold(),
                    report.edges,
                    if report.skipped_edges > 0 {
                        format!(" ({} skipped)", report.skipped_edges)
                    } else {
                        String::new()
                    },
                    report.connected,
                    report.goals,
                    report.objectives
                );
            }
        }
        LoopSubcommands::Review { commits, json } => {
            // Reality-check before planning. Finished-work evidence = recent
            // commit subjects (cheap, honest); the engine also folds in the
            // graph's own terminal nodes. We never claim code is done — only
            // that a name collides with finished work or another pending task.
            let all = graph.list();
            let done_titles = recent_commit_subjects(*commits);
            let flags = aura_loop::planning::review_tasks(&all, &done_titles);
            if *json {
                println!("{}", serde_json::to_string(&flags)?);
            } else if flags.is_empty() {
                println!(
                    "{} Nothing to drop — every task looks like real, unfinished work.",
                    "✓".green().bold()
                );
            } else {
                use aura_loop::planning::FlagKind;
                let label = |k: FlagKind| match k {
                    FlagKind::AlreadyDone => "already done".yellow().bold(),
                    FlagKind::Duplicate => "duplicate".yellow().bold(),
                    FlagKind::Thin => "empty stub".yellow().bold(),
                };
                println!(
                    "{} {} task(s) worth a second look before you run them:\n",
                    "⚑".yellow().bold(),
                    flags.len()
                );
                for f in &flags {
                    println!("  [{}] {}", label(f.kind), f.title.bold());
                    println!("      {}", f.reason.dimmed());
                    if let Some(ev) = &f.evidence {
                        println!("      {} {}", "↔".dimmed(), ev.dimmed());
                    }
                }
            }
        }
        LoopSubcommands::AttachTargets { json } => {
            // Offer existing goals new work can hang off, so adding tasks +
            // Plan can extend a flow instead of always starting an island.
            let all = graph.list();
            let targets = aura_loop::planning::attach_targets(&all);
            if *json {
                let payload: Vec<serde_json::Value> = targets
                    .iter()
                    .map(|t| {
                        let tails: Vec<serde_json::Value> = t
                            .tail_ids
                            .iter()
                            .map(|id| {
                                let title = graph.get(id).map(|n| n.title).unwrap_or_default();
                                serde_json::json!({ "id": id, "title": title })
                            })
                            .collect();
                        serde_json::json!({ "goal": t.goal, "size": t.size, "tails": tails })
                    })
                    .collect();
                println!("{}", serde_json::to_string(&payload)?);
            } else if targets.is_empty() {
                println!(
                    "{} No existing goals yet — new tasks start their own flow.",
                    "·".dimmed()
                );
            } else {
                println!("Goals you can attach new work to:\n");
                for t in &targets {
                    println!(
                        "  {} {}",
                        t.goal.bold(),
                        format!("({} step{})", t.size, if t.size == 1 { "" } else { "s" }).dimmed()
                    );
                    for id in &t.tail_ids {
                        let title = graph.get(id).map(|n| n.title).unwrap_or_default();
                        println!("      {} {}", "↳ after".dimmed(), title);
                    }
                }
            }
        }
    }
    Ok(())
}

/// Recent commit subjects (HEAD-first), used as finished-work evidence for
/// `aura loop review` so "already done" catches work finished outside the
/// graph. Best-effort: an empty vec when git isn't readable.
fn recent_commit_subjects(n: usize) -> Vec<String> {
    let out = std::process::Command::new("git")
        .args(["log", &format!("-{n}"), "--pretty=format:%s"])
        .output();
    match out {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout)
            .lines()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect(),
        _ => Vec::new(),
    }
}

fn current_actor() -> String {
    if let Ok(out) = std::process::Command::new("git")
        .args(["config", "user.name"])
        .output()
    {
        if out.status.success() {
            let name = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !name.is_empty() {
                return name;
            }
        }
    }
    std::env::var("USER").unwrap_or_else(|_| "anon".to_string())
}

fn handle_task_command(sub: &TaskSubcommands) -> Result<(), Box<dyn std::error::Error>> {
    use crate::activity::ActivityStore;
    use crate::task::{TaskStatus, TaskStore};
    use colored::Colorize;
    let repo_root = std::env::current_dir()?;
    let store = TaskStore::at(&repo_root);
    let activity = ActivityStore::at(&repo_root);
    let actor = current_actor();

    fn print_task_pretty(t: &task::Task) {
        let status_label = t.status().label();
        let claim = t
            .claimed_by
            .clone()
            .unwrap_or_else(|| "—".to_string());
        let assign = t
            .assignee
            .clone()
            .unwrap_or_else(|| "—".to_string());
        println!(
            "{} {}  {}  by:{}  claim:{}  assign:{}",
            t.id.yellow().bold(),
            format!("[{}]", t.priority).dimmed(),
            t.title,
            t.author.dimmed(),
            claim.cyan(),
            assign.cyan(),
        );
        println!(
            "   {} {}  {}",
            "status:".dimmed(),
            status_label,
            if t.labels.is_empty() {
                String::new()
            } else {
                format!("labels: {}", t.labels.join(", "))
            }
            .dimmed()
        );
    }

    match sub {
        TaskSubcommands::New {
            title,
            body,
            priority,
            labels,
            author,
            json,
        } => {
            let labels_vec = labels
                .split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>();
            let task_author = author.clone().unwrap_or_else(|| actor.clone());
            let task = store.create(
                title.clone(),
                body.clone(),
                priority.clone(),
                task_author.clone(),
                labels_vec,
            )?;
            activity.quick(&task_author, "created", &task.id, Some(&task.title));
            if *json {
                println!("{}", serde_json::to_string(&task)?);
            } else {
                println!("{} created", task.id.green().bold());
                print_task_pretty(&task);
            }
        }
        TaskSubcommands::List {
            status,
            assignee,
            claimed_by,
            json,
        } => {
            let mut tasks = store.list();
            if let Some(s) = status {
                if let Some(want) = TaskStatus::parse(s) {
                    tasks.retain(|t| t.status() == want);
                }
            }
            if let Some(a) = assignee {
                tasks.retain(|t| t.assignee.as_deref() == Some(a.as_str()));
            }
            if let Some(c) = claimed_by {
                tasks.retain(|t| t.claimed_by.as_deref() == Some(c.as_str()));
            }
            if *json {
                println!("{}", serde_json::to_string(&tasks)?);
            } else if tasks.is_empty() {
                println!("{}", "No tasks.".dimmed());
            } else {
                for t in &tasks {
                    print_task_pretty(t);
                }
            }
        }
        TaskSubcommands::Show { id, json } => {
            let task = store
                .get(id)
                .ok_or_else(|| format!("task {} not found", id))?;
            if *json {
                println!("{}", serde_json::to_string(&task)?);
            } else {
                print_task_pretty(&task);
                if !task.body.is_empty() {
                    println!("\n{}", task.body);
                }
                if !task.comments.is_empty() {
                    println!("\n{}", "Comments".bold());
                    for c in &task.comments {
                        println!("  {} {}: {}", c.author.cyan(), c.at.to_string().dimmed(), c.body);
                    }
                }
            }
        }
        TaskSubcommands::Claim { id, as_who, json } => {
            let who = as_who.clone().unwrap_or_else(|| actor.clone());
            let task = store.claim(id, who.clone())?;
            activity.quick(&who, "claimed", &task.id, Some(&task.title));
            if *json {
                println!("{}", serde_json::to_string(&task)?);
            } else {
                println!("{} claimed by {}", task.id.green().bold(), task.claimed_by.as_deref().unwrap_or("?"));
            }
        }
        TaskSubcommands::Unclaim { id, json } => {
            let task = store.unclaim(id)?;
            activity.quick(&actor, "unclaimed", &task.id, Some(&task.title));
            if *json {
                println!("{}", serde_json::to_string(&task)?);
            } else {
                println!("{} unclaimed", task.id.green().bold());
            }
        }
        TaskSubcommands::Assign { id, who, json } => {
            let assignee = if who.eq_ignore_ascii_case("none") || who.is_empty() {
                None
            } else {
                Some(who.clone())
            };
            let task = store.assign(id, assignee)?;
            let summary = match &task.assignee {
                Some(a) => format!("{} → {}", task.title, a),
                None => format!("{} (cleared)", task.title),
            };
            activity.quick(&actor, "assigned", &task.id, Some(&summary));
            if *json {
                println!("{}", serde_json::to_string(&task)?);
            } else {
                println!(
                    "{} assigned to {}",
                    task.id.green().bold(),
                    task.assignee.as_deref().unwrap_or("(none)")
                );
            }
        }
        TaskSubcommands::Comment { id, body, as_who, json } => {
            let author = as_who.clone().unwrap_or_else(|| actor.clone());
            let task = store.comment(id, author.clone(), body.clone())?;
            let preview: String = body.chars().take(80).collect();
            activity.quick(&author, "commented", &task.id, Some(&preview));
            if *json {
                println!("{}", serde_json::to_string(&task)?);
            } else {
                println!("{} +1 comment", task.id.green().bold());
            }
        }
        TaskSubcommands::Close { id, json } => {
            let task = store.set_status(id, TaskStatus::Done)?;
            activity.quick(&actor, "closed", &task.id, Some(&task.title));
            if *json {
                println!("{}", serde_json::to_string(&task)?);
            } else {
                println!("{} done", task.id.green().bold());
            }
        }
        TaskSubcommands::Reopen { id, json } => {
            let task = store.set_status(id, TaskStatus::Open)?;
            activity.quick(&actor, "reopened", &task.id, Some(&task.title));
            if *json {
                println!("{}", serde_json::to_string(&task)?);
            } else {
                println!("{} reopened", task.id.green().bold());
            }
        }
        TaskSubcommands::Status { id, status, json } => {
            let parsed = TaskStatus::parse(status)
                .ok_or_else(|| format!("unknown status: {} (open|in_progress|blocked|done|cancelled)", status))?;
            let task = store.set_status(id, parsed)?;
            if *json {
                println!("{}", serde_json::to_string(&task)?);
            } else {
                println!("{} {}", task.id.green().bold(), task.status().label());
            }
        }
        TaskSubcommands::Link { id, pr, branch, json } => {
            let task = store.link(id, pr.clone(), branch.clone())?;
            if *json {
                println!("{}", serde_json::to_string(&task)?);
            } else {
                println!(
                    "{} linked → pr:{} branch:{}",
                    task.id.green().bold(),
                    task.linked_pr.as_deref().unwrap_or("—"),
                    task.linked_branch.as_deref().unwrap_or("—")
                );
            }
        }
    }
    Ok(())
}

fn handle_activity_command(sub: &ActivitySubcommands) -> Result<(), Box<dyn std::error::Error>> {
    use crate::activity::ActivityStore;
    use colored::Colorize;
    let repo_root = std::env::current_dir()?;
    let store = ActivityStore::at(&repo_root);

    match sub {
        ActivitySubcommands::Tail { n, json } => {
            let events = store.tail(*n);
            if *json {
                println!("{}", serde_json::to_string(&events)?);
            } else if events.is_empty() {
                println!("{}", "No activity yet.".dimmed());
            } else {
                for ev in &events {
                    let when = format_relative_seconds(ev.at);
                    let summary = ev.summary.as_deref().unwrap_or("");
                    println!(
                        "  {} {} {} {} {}",
                        when.dimmed(),
                        ev.actor.cyan(),
                        ev.verb.yellow(),
                        ev.target.bold(),
                        summary.dimmed()
                    );
                }
            }
        }
        ActivitySubcommands::Emit {
            verb,
            target,
            summary,
            actor: actor_override,
            json,
        } => {
            let actor = actor_override.clone().unwrap_or_else(current_actor);
            let event = crate::activity::ActivityEvent {
                at: chrono::Utc::now().timestamp(),
                actor: actor.clone(),
                verb: verb.clone(),
                target: target.clone(),
                summary: summary.clone(),
                link: None,
            };
            store.emit(event.clone())?;
            if *json {
                println!("{}", serde_json::to_string(&event)?);
            } else {
                println!("{} emitted", "✓".green());
            }
        }
    }
    Ok(())
}

fn handle_review_command(sub: &ReviewSubcommands) -> Result<(), Box<dyn std::error::Error>> {
    use colored::Colorize;
    match sub {
        ReviewSubcommands::List { json } => {
            let items = pr::list_review_summaries()?;
            if *json {
                println!("{}", serde_json::to_string(&items)?);
            } else if items.is_empty() {
                println!("{}", "No persisted reviews. Run `aura pr-review --base main --json`.".dimmed());
            } else {
                println!("\n{}", "PR Review Inbox".bold().cyan());
                for item in &items {
                    let when = format_relative_seconds(item.ts);
                    let badge = match item.risk_label.as_str() {
                        "CRITICAL" => item.risk_label.red().bold(),
                        "MODERATE" => item.risk_label.yellow().bold(),
                        _ => item.risk_label.green().bold(),
                    };
                    println!(
                        "  {} {} {} score={} changes={} viol={} blast={} omni={} base={}",
                        when.dimmed(),
                        item.ts.to_string().dimmed(),
                        badge,
                        item.risk_score,
                        item.total_changes,
                        item.invariant_violations,
                        item.blast_radius,
                        item.omni_graph_impact,
                        item.base_branch.cyan(),
                    );
                }
            }
        }
        ReviewSubcommands::Show { ts, json } => {
            let v = pr::read_review(*ts)?;
            if *json {
                println!("{}", serde_json::to_string_pretty(&v)?);
            } else {
                println!("{}", serde_json::to_string_pretty(&v)?);
            }
        }
        ReviewSubcommands::Setup { reviewers, fixer, base, json } => {
            review::run_setup(reviewers.as_deref(), fixer.as_deref(), base.as_deref(), *json)
                .map_err(|e| -> Box<dyn std::error::Error> { e.into() })?;
        }
        ReviewSubcommands::Roles { json } => {
            review::show_roles(*json).map_err(|e| -> Box<dyn std::error::Error> { e.into() })?;
        }
        ReviewSubcommands::Run { reviewers, fixer, base, depth, no_verify, timeout_secs, json } => {
            review::run_roles_review(
                reviewers.as_deref(),
                fixer.as_deref(),
                base.as_deref(),
                Some(depth.as_str()),
                *no_verify,
                *timeout_secs,
                *json,
            )
            .map_err(|e| -> Box<dyn std::error::Error> { e.into() })?;
        }
        ReviewSubcommands::Fix { base, fixer, yes, json } => {
            review::run_fix(base.as_deref(), fixer.as_deref(), *yes, *json)
                .map_err(|e| -> Box<dyn std::error::Error> { e.into() })?;
        }
        ReviewSubcommands::Post { pr, base, dry_run, json } => {
            review::run_post(*pr, base.as_deref(), *dry_run, *json)
                .map_err(|e| -> Box<dyn std::error::Error> { e.into() })?;
        }
    }
    Ok(())
}

fn handle_intent_vs_actual_command(
    sub: &IntentVsActualSubcommands,
) -> Result<(), Box<dyn std::error::Error>> {
    use colored::Colorize;
    match sub {
        IntentVsActualSubcommands::List { n, json } => {
            let entries = intent_vs_actual::list_commits(*n)?;
            if *json {
                println!("{}", serde_json::to_string(&entries)?);
            } else if entries.is_empty() {
                println!("{}", "No commits in this repo.".dimmed());
            } else {
                println!("\n{}", "Recent commits".bold().cyan());
                for e in &entries {
                    let when = format_relative_seconds(e.commit_time);
                    let line = e
                        .commit_message
                        .lines()
                        .next()
                        .unwrap_or("(no message)")
                        .chars()
                        .take(60)
                        .collect::<String>();
                    let intent_chip = if e.stated_count == 0 {
                        "no intent".red().to_string()
                    } else {
                        format!("{} intent{}", e.stated_count, if e.stated_count == 1 { "" } else { "s" })
                            .green()
                            .to_string()
                    };
                    println!(
                        "  {} {} {} {} {}",
                        when.dimmed(),
                        e.commit_short.yellow(),
                        e.author.cyan(),
                        line.white(),
                        intent_chip,
                    );
                }
            }
        }
        IntentVsActualSubcommands::Show { sha, json } => {
            let report = intent_vs_actual::run(sha)?;
            if *json {
                println!("{}", serde_json::to_string_pretty(&report)?);
            } else {
                let banner_text = match report.banner {
                    "aligned" => "✓ ALIGNED".green().bold(),
                    "drift" => "⚠ DRIFT".yellow().bold(),
                    _ => "✗ DIVERGED".red().bold(),
                };
                println!(
                    "\n{}  {}  {}",
                    banner_text,
                    report.commit_short.yellow(),
                    report.commit_message.lines().next().unwrap_or("").bold()
                );
                println!(
                    "  alignment_score = {:.2}  ({} aligned / {} mismatched)",
                    report.alignment_score,
                    report.aligned_nodes.len(),
                    report.mismatched_nodes.len()
                );
                if !report.stated.is_empty() {
                    println!("\n  {}", "Stated:".bold());
                    for s in &report.stated {
                        println!("    {} {} {}", "↳".dimmed(), s.agent_id.cyan(), s.intent.white());
                    }
                }
                if !report.mismatched_nodes.is_empty() {
                    println!("\n  {} {}", "Mismatched:".bold().red(), report.mismatched_nodes.join(", "));
                }
            }
        }
    }
    Ok(())
}

fn handle_change_note_command(
    sha: &str,
    json: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    use colored::Colorize;
    let report = change_note::run(sha)?;
    if json {
        println!("{}", serde_json::to_string_pretty(&report)?);
        return Ok(());
    }

    println!(
        "\n{}  {}  {}",
        "Change notes".bold().cyan(),
        report.commit_short.yellow(),
        report
            .commit_message
            .lines()
            .next()
            .unwrap_or("")
            .bold()
    );
    if report.files.is_empty() {
        println!("  {}", "No code symbols changed in this commit.".dimmed());
    }
    for f in &report.files {
        println!("\n  {}", f.file.white().bold());
        println!("    {}", f.note.dimmed());
        for s in &f.symbols {
            let verb = match s.change.as_str() {
                "added" => "+".green().to_string(),
                "deleted" => "−".red().to_string(),
                _ => "~".yellow().to_string(),
            };
            let line = format!("      {} {} {}", verb, s.identifier.cyan(), s.kind.dimmed());
            match &s.rationale {
                Some(r) if !r.is_empty() => println!("{line}  {}", format!("— {r}").dimmed()),
                _ => println!("{line}"),
            }
        }
        if !f.features.is_empty() {
            let names: Vec<String> = f.features.iter().map(|x| x.name.clone()).collect();
            println!("    {} {}", "affects:".dimmed(), names.join(", ").white());
        } else if f.leaf {
            println!("    {}", "affects: nothing else calls it".dimmed());
        }
    }
    if !report.other_files.is_empty() {
        println!(
            "\n  {} {}",
            "Other files:".dimmed(),
            report.other_files.join(", ").dimmed()
        );
    }
    Ok(())
}

fn handle_impact_command(
    symbol: &str,
    file: &str,
    json: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    use colored::Colorize;

    let repo_root = validate_tool::resolve_repo_root(None);
    // `analyze_deletion` keys the graph on repo-relative paths (same as the
    // delete-guard feeds it). Accept an absolute path from callers (e.g. the
    // desktop app) and fold it back to repo-relative.
    let rel_file = {
        let p = std::path::Path::new(file);
        if p.is_absolute() {
            p.strip_prefix(&repo_root)
                .map(|r| r.to_string_lossy().to_string())
                .unwrap_or_else(|_| file.to_string())
        } else {
            file.to_string()
        }
    };

    let impact = impact::analyze_deletion(&repo_root, &rel_file, &[symbol.to_string()]);

    if json {
        println!("{}", serde_json::to_string_pretty(&impact::to_json(&impact))?);
        return Ok(());
    }

    println!(
        "\n{}  {} {}",
        "Blast radius".bold().cyan(),
        symbol.cyan(),
        format!("in {rel_file}").dimmed()
    );
    println!("  {}", impact.summary.white().bold());

    if impact.direct_callers.is_empty() {
        println!("  {}", "Nothing calls it directly.".dimmed());
    } else {
        println!(
            "\n  {} ({})",
            "Depends on this — re-check before you touch it:".dimmed(),
            impact.direct_callers.len()
        );
        for c in &impact.direct_callers {
            let loc = c.file.as_deref().unwrap_or("?");
            println!(
                "    {} {}",
                c.symbol.cyan(),
                format!("{loc} · {}", c.kind).dimmed()
            );
        }
        if impact.transitive_caller_count > impact.direct_callers.len() {
            println!(
                "    {}",
                format!(
                    "… and {} more further out",
                    impact.transitive_caller_count - impact.direct_callers.len()
                )
                .dimmed()
            );
        }
    }

    if !impact.features.is_empty() {
        println!("\n  {}", "User-facing features that ride on it:".dimmed());
        for f in &impact.features {
            println!(
                "    {} {}",
                f.name.white(),
                format!("({} hop{})", f.hops, if f.hops == 1 { "" } else { "s" }).dimmed()
            );
        }
    }

    println!("\n  {}", impact.hedge.dimmed());
    Ok(())
}

fn format_relative_seconds(unix: i64) -> String {
    let now = chrono::Utc::now().timestamp();
    let diff = now - unix;
    if diff < 60 {
        "just now".to_string()
    } else if diff < 3600 {
        format!("{}m", diff / 60)
    } else if diff < 86400 {
        format!("{}h", diff / 3600)
    } else if diff < 86400 * 30 {
        format!("{}d", diff / 86400)
    } else {
        let dt = chrono::DateTime::<chrono::Utc>::from_timestamp(unix, 0)
            .unwrap_or_else(|| chrono::Utc::now());
        dt.format("%Y-%m-%d").to_string()
    }
}

/// A duration as "3 minutes ago" rather than a count of seconds. Used where
/// the age is the point — a zone claimed 4 minutes ago and one claimed in May
/// are different situations, and a raw second count doesn't say which is which.
fn human_age(secs: u64) -> String {
    match secs {
        0..=59 => "moments ago".to_string(),
        60..=3599 => format!("{}m ago", secs / 60),
        3600..=86399 => format!("{}h ago", secs / 3600),
        _ => format!("{}d ago", secs / 86400),
    }
}

#[cfg(test)]
mod recall_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn truncate_under_limit_passthrough() {
        assert_eq!(truncate("hello", 10), "hello");
    }

    #[test]
    fn truncate_over_limit_appends_ellipsis() {
        let out = truncate("abcdefghijk", 5);
        assert_eq!(out.chars().count(), 5);
        assert!(out.ends_with('…'));
    }

    /// Build a blocking Response with a chosen status and body, so the decode
    /// order can be tested for real rather than by inspection.
    fn reply(status: u16, body: &str) -> reqwest::blocking::Response {
        let raw = http::Response::builder()
            .status(status)
            .body(body.to_string())
            .expect("response");
        reqwest::blocking::Response::from(raw)
    }

    /// The defect this whole helper exists to kill. The cloud answers 404 with
    /// an error page for a repo it has never heard of; the old code parsed
    /// first, so the user was told the *reply was malformed* instead of that
    /// the repo was unknown.
    #[test]
    fn an_unknown_repo_reports_its_status_not_a_parse_failure() {
        let err = recall_decode(reply(404, "<html><body>404 Not Found</body></html>"))
            .expect_err("404 is not a success");
        assert!(err.starts_with("HTTP 404"), "leads with the status: {err}");
        assert!(
            !err.contains("parse"),
            "must not blame the parser for a routing answer: {err}"
        );
        assert!(
            !err.contains("<html"),
            "an error page carries nothing worth quoting: {err}"
        );
    }

    #[test]
    fn a_json_error_body_is_quoted_in_the_servers_own_words() {
        let err = recall_decode(reply(403, r#"{"error":"repo not in your org"}"#))
            .expect_err("403 is not a success");
        assert_eq!(err, "HTTP 403 Forbidden: repo not in your org");
    }

    #[test]
    fn a_success_still_returns_its_body() {
        let v = recall_decode(reply(200, r#"{"tasks":[]}"#)).expect("200 decodes");
        assert!(v["tasks"].is_array());
    }

    /// Some DELETE handlers answer 204 with nothing. That is a success, and
    /// reporting it as a parse failure was the second half of the same bug.
    #[test]
    fn an_empty_success_is_a_success() {
        let v = recall_decode(reply(204, "")).expect("204 decodes");
        assert!(v.is_object());
    }

    /// A 2xx that really is malformed is still worth saying so — the fix moved
    /// the parse check, it did not delete it.
    #[test]
    fn a_malformed_success_body_is_still_reported() {
        let err = recall_decode(reply(200, "not json at all")).expect_err("garbage 200");
        assert!(err.contains("not JSON"), "{err}");
    }

    #[test]
    fn format_agent_card_renders_core_digest() {
        let card = json!({
            "name": "aura-semantic-vcs",
            "version": "0.2.1",
            "protocolVersion": "1.2",
            "url": "https://cloud.example.com/api/v2/a2a/messages",
            "description": "Aura card",
            "capabilities": {
                "streaming": false,
                "pushNotifications": false,
                "stateTransitionHistory": true
            },
            "metadata": {
                "aura": {
                    "capabilities_extended": [
                        "typed-intent",
                        "signing-health-readonly"
                    ]
                }
            },
            "skills": [
                {
                    "id": "task-lifecycle",
                    "name": "A2A v1.2 task lifecycle",
                    "description": "Create and poll tasks."
                }
            ]
        });

        let out = format_agent_card(&card);
        assert!(out.contains("Agent Card"));
        assert!(out.contains("aura-semantic-vcs v0.2.1"));
        assert!(out.contains("A2A protocol 1.2"));
        assert!(out.contains("endpoint: https://cloud.example.com/api/v2/a2a/messages"));
        assert!(out.contains("stateTransitionHistory=true"));
        assert!(out.contains("capabilities_extended: typed-intent, signing-health-readonly"));
        assert!(out.contains("- task-lifecycle (A2A v1.2 task lifecycle)"));
    }

    #[test]
    fn recall_push_str_skips_empty_and_advances_sep() {
        let mut url = String::from("http://x/y");
        let mut sep = '?';
        recall_push_str(&mut url, &mut sep, "agent_id", Some(""));
        assert_eq!(url, "http://x/y");
        assert_eq!(sep, '?');
        recall_push_str(&mut url, &mut sep, "agent_id", Some("claude-1"));
        assert_eq!(url, "http://x/y?agent_id=claude-1");
        assert_eq!(sep, '&');
        recall_push_str(&mut url, &mut sep, "repo", Some("aura/main"));
        assert_eq!(url, "http://x/y?agent_id=claude-1&repo=aura%2Fmain");
    }

    #[test]
    fn recall_push_i64_appends_and_advances_sep() {
        let mut url = String::from("http://x/y");
        let mut sep = '?';
        recall_push_i64(&mut url, &mut sep, "window_hours", None);
        assert_eq!(url, "http://x/y");
        recall_push_i64(&mut url, &mut sep, "window_hours", Some(24));
        assert_eq!(url, "http://x/y?window_hours=24");
        assert_eq!(sep, '&');
        recall_push_i64(&mut url, &mut sep, "limit", Some(50));
        assert_eq!(url, "http://x/y?window_hours=24&limit=50");
    }

    #[test]
    fn format_recall_events_table_renders_focus_combination() {
        let body = json!({
            "total": 3,
            "returned": 2,
            "events": [
                {
                    "ts": "2026-04-27T10:00:00Z",
                    "event_type": "block.signed",
                    "agent_id": "claude-1",
                    "focus_fn": "apply_limiter",
                    "focus_file": "lib.rs"
                },
                {
                    "ts": "2026-04-27T10:01:00Z",
                    "event_type": "snapshot.created",
                    "agent_id": "gemini-1",
                    "focus_fn": null,
                    "focus_file": "main.rs"
                }
            ]
        });
        let rendered = format_recall_events_table(&body);
        assert!(rendered.contains("total=3 returned=2"));
        assert!(rendered.contains("apply_limiter@lib.rs"));
        assert!(rendered.contains("main.rs"));
        assert!(rendered.contains("claude-1"));
        assert!(rendered.contains("gemini-1"));
    }

    #[test]
    fn format_recall_events_table_handles_empty() {
        let body = json!({"total": 0, "returned": 0, "events": []});
        let rendered = format_recall_events_table(&body);
        assert!(rendered.contains("(no events)"));
    }

    #[test]
    fn format_recall_events_table_surfaces_typed_intent_columns() {
        // S2-TICRE: when the cloud response carries counts_by_intent_type
        // the header line shows the histogram (count desc, name asc) and
        // each event row shows its intent_type column. Untyped rows
        // render "-" so the column lines up. Suppressed when the bucket
        // is absent or empty.
        let body = json!({
            "total": 3,
            "returned": 3,
            "counts_by_intent_type": { "Refactor": 2, "BugFix": 1 },
            "events": [
                {
                    "ts": "2026-04-27T10:00:00Z",
                    "event_type": "intent",
                    "agent_id": "claude-ticre",
                    "intent_type": "Refactor",
                    "focus_fn": "apply_limiter"
                },
                {
                    "ts": "2026-04-27T10:01:00Z",
                    "event_type": "intent",
                    "agent_id": "claude-ticre",
                    "intent_type": "BugFix"
                },
                {
                    "ts": "2026-04-27T10:02:00Z",
                    "event_type": "intent",
                    "agent_id": "claude-ticre"
                    // untyped — no intent_type key (matches cloud's
                    // skip_serializing_if contract)
                }
            ]
        });
        let rendered = format_recall_events_table(&body);
        assert!(rendered.contains("intent_types: Refactor=2, BugFix=1"));
        // Header column present.
        assert!(rendered.contains("intent_type"));
        // Typed rows render the value.
        assert!(rendered.contains("Refactor"));
        assert!(rendered.contains("BugFix"));
        // Untyped row renders "-" placeholder, not the literal "untyped".
        assert!(!rendered.contains("untyped"));
    }

    #[test]
    fn format_recall_events_table_omits_intent_header_when_empty() {
        // When the cloud bucket is absent (older builds) or fully zero,
        // the header histogram line is suppressed — keeps the output
        // clean for repos that haven't started typing intents yet.
        let body = json!({
            "total": 1,
            "returned": 1,
            "counts_by_intent_type": {},
            "events": [{
                "ts": "2026-04-27T10:00:00Z",
                "event_type": "snapshot.created",
                "agent_id": "claude-1"
            }]
        });
        let rendered = format_recall_events_table(&body);
        assert!(!rendered.contains("intent_types:"));
    }

    #[test]
    fn format_arc_segments_table_single_omits_agent_column() {
        let body = json!({
            "agent_id": "claude-1",
            "window_hours": 24,
            "gap_minutes": 30,
            "total_events": 4,
            "segment_count": 1,
            "segments": [{
                "start_ts": "2026-04-27T10:00:00Z",
                "end_ts": "2026-04-27T10:05:00Z",
                "event_count": 4,
                "top_refs": ["apply_limiter", "parse_token"]
            }]
        });
        let rendered = format_arc_segments_table(&body, false);
        assert!(rendered.contains("Session arc — agent=claude-1"));
        assert!(rendered.contains("apply_limiter,parse_token"));
        // Header row in single-arc mode does not include the agent_id column.
        assert!(!rendered.lines().nth(1).unwrap_or("").contains("agent_id"));
    }

    #[test]
    fn format_arc_segments_table_multi_includes_agent_column() {
        let body = json!({
            "agent_ids": ["claude-1", "gemini-1"],
            "window_hours": 24,
            "gap_minutes": 30,
            "total_events": 5,
            "segment_count": 2,
            "segments": [
                {
                    "agent_id": "claude-1",
                    "start_ts": "2026-04-27T10:00:00Z",
                    "end_ts": "2026-04-27T10:05:00Z",
                    "event_count": 4,
                    "top_refs": ["apply_limiter"]
                },
                {
                    "agent_id": "gemini-1",
                    "start_ts": "2026-04-27T10:06:00Z",
                    "end_ts": "2026-04-27T10:07:00Z",
                    "event_count": 1,
                    "top_refs": ["parse_token"]
                }
            ]
        });
        let rendered = format_arc_segments_table(&body, true);
        assert!(rendered.contains("Multi-agent arc — agents=[claude-1,gemini-1]"));
        assert!(rendered.lines().nth(1).unwrap_or("").contains("agent_id"));
        assert!(rendered.contains("claude-1"));
        assert!(rendered.contains("gemini-1"));
    }

    #[test]
    fn format_arc_segments_table_handles_empty() {
        let body = json!({
            "agent_id": "x",
            "window_hours": 24,
            "gap_minutes": 30,
            "total_events": 0,
            "segment_count": 0,
            "segments": []
        });
        let rendered = format_arc_segments_table(&body, false);
        assert!(rendered.contains("(no segments)"));
    }

    #[test]
    fn format_arc_segments_table_surfaces_typed_intent() {
        // S2-TICRAH: arc table renders both the top-level
        // counts_by_intent_type histogram (under the summary line)
        // and a per-segment intent_types column. Typed segments
        // show their bucket; fully-untyped segments show "-".
        let body = json!({
            "agent_id": "claude-ticra",
            "window_hours": 24,
            "gap_minutes": 30,
            "total_events": 3,
            "segment_count": 2,
            "counts_by_intent_type": { "Refactor": 2, "BugFix": 1 },
            "segments": [
                {
                    "start_ts": "2026-04-27T10:00:00Z",
                    "end_ts": "2026-04-27T10:05:00Z",
                    "event_count": 2,
                    "counts_by_intent_type": { "Refactor": 1, "BugFix": 1 },
                    "top_refs": ["apply_limiter"]
                },
                {
                    "start_ts": "2026-04-27T11:00:00Z",
                    "end_ts": "2026-04-27T11:01:00Z",
                    "event_count": 1,
                    "counts_by_intent_type": { "Refactor": 1 },
                    "top_refs": ["parse_token"]
                }
            ]
        });
        let rendered = format_arc_segments_table(&body, false);
        // Top-level histogram (count desc, name asc, comma-space).
        // Refactor=2 wins on count; BugFix=1 second.
        assert!(rendered.contains("intent_types: Refactor=2, BugFix=1"));
        // First segment: Refactor=1 and BugFix=1 tie on count, so
        // name asc → BugFix first. Comma-only separator (narrow col).
        assert!(rendered.contains("BugFix=1,Refactor=1"));
        // Second segment: just Refactor=1.
        assert!(rendered.contains("Refactor=1 "));
        // Header column present (line index 2: summary, top-level
        // histogram, then header row).
        let header = rendered.lines().nth(2).unwrap_or("");
        assert!(header.contains("intent_types"), "header was: {}", header);
    }

    #[test]
    fn format_arc_segments_table_segment_renders_dash_when_untyped() {
        // A segment with no counts_by_intent_type bucket renders "-"
        // in the column so the table stays aligned. Top-level header
        // still suppressed when its own bucket is absent.
        let body = json!({
            "agent_id": "claude-1",
            "window_hours": 24,
            "gap_minutes": 30,
            "total_events": 1,
            "segment_count": 1,
            "segments": [{
                "start_ts": "2026-04-27T10:00:00Z",
                "end_ts": "2026-04-27T10:01:00Z",
                "event_count": 1,
                "top_refs": ["x"]
            }]
        });
        let rendered = format_arc_segments_table(&body, false);
        // No top-level histogram line — bucket absent.
        assert!(!rendered.contains("intent_types:"));
        // Per-segment row carries "-" placeholder somewhere on the row.
        let row = rendered.lines().last().unwrap_or("");
        assert!(row.contains(" - "), "row was: {}", row);
    }

    // ── narrate-blocks helpers (S2-NB) ──

    fn make_block(
        id: &str,
        kind: &str,
        state: &str,
        intent: &str,
        actor: &str,
        anchor_kind: &str,
        anchor_id: &str,
        created_at: &str,
        signed: bool,
    ) -> serde_json::Value {
        let mut prov = serde_json::json!({
            "actor": { "id": actor, "kind": "agent" },
            "origin_host": "host"
        });
        if signed {
            prov["signature"] = json!({
                "algo": "ed25519",
                "key_id": "did:aura:key/test",
                "sig_b64": "AAAA"
            });
        }
        json!({
            "id": id,
            "kind": kind,
            "state": state,
            "intent": { "summary": intent },
            "anchor": { "kind": anchor_kind, "id": anchor_id },
            "provenance": prov,
            "created_at": created_at
        })
    }

    #[test]
    fn parse_iso8601_round_trip_basic() {
        let ms = parse_iso8601_to_ms("2026-04-27T10:00:00Z").expect("parse");
        // Sanity bounds: 2026-04-27 in unix-ms must sit in this decade.
        assert!(ms > 1_700_000_000_000);
        assert!(ms < 2_000_000_000_000);
        assert!(parse_iso8601_to_ms("not-a-date").is_none());
        assert!(parse_iso8601_to_ms("").is_none());
    }

    #[test]
    fn parse_block_summary_extracts_all_fields() {
        let v = make_block(
            "blk1",
            "command",
            "completed",
            "ran cargo test",
            "did:aura:agent/claude",
            "function",
            "apply_limiter",
            "2026-04-27T10:00:00Z",
            true,
        );
        let s = parse_block_summary(&v).expect("summary");
        assert_eq!(s.id, "blk1");
        assert_eq!(s.kind, "command");
        assert_eq!(s.state, "completed");
        assert_eq!(s.intent_summary, "ran cargo test");
        assert_eq!(s.actor, "did:aura:agent/claude");
        assert_eq!(s.anchor, "function:apply_limiter");
        assert!(s.has_signature);
        assert!(s.created_at_ms.is_some());
    }

    #[test]
    fn parse_block_summary_handles_anchor_none_and_missing_intent() {
        let v = json!({
            "id": "blk2",
            "kind": "message",
            "state": "completed",
            "anchor": { "kind": "none" },
            "provenance": { "actor": { "id": "did:x", "kind": "agent" }, "origin_host": "h" },
            "created_at": "2026-04-27T11:00:00Z"
        });
        let s = parse_block_summary(&v).expect("summary");
        assert_eq!(s.anchor, "none");
        assert_eq!(s.intent_summary, "");
        assert!(!s.has_signature);
    }

    #[test]
    fn top_count_pairs_orders_by_count_then_key() {
        let items = vec!["a", "a", "b", "c", "c", "c"]
            .into_iter()
            .map(String::from);
        let pairs = top_count_pairs(items, 5);
        assert_eq!(
            pairs,
            vec![
                ("c".to_string(), 3),
                ("a".to_string(), 2),
                ("b".to_string(), 1),
            ]
        );
        // top_n caps the list.
        let many = (0..10)
            .map(|i| format!("k{}", i))
            .collect::<Vec<_>>();
        let pairs = top_count_pairs(many.into_iter(), 3);
        assert_eq!(pairs.len(), 3);
    }

    #[test]
    fn build_block_narration_filters_by_recency() {
        // Cutoff = now - 24h. Old block (now - 48h) drops; recent stays.
        let now_ms: i64 = 1_750_000_000_000;
        let recent = make_block(
            "r",
            "command",
            "completed",
            "recent",
            "did:a",
            "function",
            "f1",
            "",
            false,
        );
        let mut recent_summary = parse_block_summary(&recent).expect("s");
        recent_summary.created_at_ms = Some(now_ms - 1_000); // 1s ago
        let mut old_summary = recent_summary.clone();
        old_summary.id = "o".to_string();
        old_summary.created_at_ms = Some(now_ms - 48 * 3_600_000); // 48h ago
        let report = build_block_narration(
            &[recent_summary.clone(), old_summary],
            now_ms,
            24,
            &[],
            None,
            10,
        );
        assert_eq!(report.matched, 1);
        assert_eq!(report.listed.len(), 1);
        assert_eq!(report.listed[0].id, "r");
    }

    #[test]
    fn build_block_narration_filters_by_kind_and_actor() {
        let now_ms: i64 = 1_750_000_000_000;
        let mut a = parse_block_summary(&make_block(
            "a", "command", "completed", "i", "did:agent/claude", "none", "", "", false,
        ))
        .unwrap();
        a.created_at_ms = Some(now_ms - 100);
        let mut b = a.clone();
        b.id = "b".into();
        b.kind = "message".into();
        let mut c = a.clone();
        c.id = "c".into();
        c.actor = "did:agent/gemini".into();
        let summaries = vec![a, b, c];

        let only_command = build_block_narration(
            &summaries,
            now_ms,
            24,
            &["command".to_string()],
            None,
            10,
        );
        assert_eq!(only_command.matched, 2);
        assert!(only_command.listed.iter().all(|s| s.kind == "command"));

        let only_claude = build_block_narration(
            &summaries,
            now_ms,
            24,
            &[],
            Some("claude"),
            10,
        );
        assert_eq!(only_claude.matched, 2);
        assert!(only_claude
            .listed
            .iter()
            .all(|s| s.actor.contains("claude")));
    }

    #[test]
    fn build_block_narration_collects_failed_separately() {
        let now_ms: i64 = 1_750_000_000_000;
        let mut ok = parse_block_summary(&make_block(
            "ok", "command", "completed", "good", "did:a", "none", "", "", false,
        ))
        .unwrap();
        ok.created_at_ms = Some(now_ms - 100);
        let mut bad = ok.clone();
        bad.id = "bad".into();
        bad.state = "failed".into();
        let mut rb = ok.clone();
        rb.id = "rb".into();
        rb.state = "rolled_back".into();
        let report =
            build_block_narration(&[ok, bad, rb], now_ms, 24, &[], None, 10);
        assert_eq!(report.matched, 3);
        assert_eq!(report.failed.len(), 2);
        let failed_ids: Vec<&str> = report.failed.iter().map(|s| s.id.as_str()).collect();
        assert!(failed_ids.contains(&"bad"));
        assert!(failed_ids.contains(&"rb"));
    }

    #[test]
    fn build_block_narration_lists_newest_first_capped() {
        let now_ms: i64 = 1_750_000_000_000;
        let mut summaries = Vec::new();
        for i in 0..5 {
            let mut s = parse_block_summary(&make_block(
                &format!("b{}", i),
                "command",
                "completed",
                &format!("intent {}", i),
                "did:a",
                "none",
                "",
                "",
                false,
            ))
            .unwrap();
            s.created_at_ms = Some(now_ms - (i as i64) * 1_000);
            summaries.push(s);
        }
        let report = build_block_narration(&summaries, now_ms, 24, &[], None, 3);
        assert_eq!(report.matched, 5);
        assert_eq!(report.listed.len(), 3);
        // Newest-first → b0 (oldest offset=0 from now), b1, b2.
        assert_eq!(report.listed[0].id, "b0");
        assert_eq!(report.listed[1].id, "b1");
        assert_eq!(report.listed[2].id, "b2");
    }

    #[test]
    fn block_narration_empty_prose_is_explicit() {
        let report = build_block_narration(&[], 1_750_000_000_000, 24, &[], None, 10);
        let prose = report.to_prose();
        assert!(prose.contains("no blocks matched"));
    }

    #[test]
    fn block_narration_prose_summarizes_kinds_and_actors() {
        let now_ms: i64 = 1_750_000_000_000;
        let mut a = parse_block_summary(&make_block(
            "a", "command", "completed", "ran tests", "did:a", "function", "f1", "", true,
        ))
        .unwrap();
        a.created_at_ms = Some(now_ms - 100);
        let mut b = a.clone();
        b.id = "b".into();
        b.kind = "message".into();
        b.intent_summary = "left a note".into();
        let report = build_block_narration(&[a, b], now_ms, 24, &[], None, 10);
        let prose = report.to_prose();
        assert!(prose.contains("2 blocks across 1 actor, 2 signed"));
        assert!(prose.contains("Kinds: "));
        assert!(prose.contains("command (1)"));
        assert!(prose.contains("message (1)"));
        assert!(prose.contains("Recent intents"));
    }

    #[test]
    fn read_blocks_dir_handles_missing_and_returns_json() {
        // Missing dir returns Ok(empty), not Err.
        let nonexistent = std::path::Path::new("/tmp/aura_recall_nb_nope_xyz");
        let blocks = read_blocks_dir(nonexistent).expect("missing dir is ok");
        assert!(blocks.is_empty());

        // Real tempdir with one valid block + one non-json file → returns 1.
        let tmp =
            std::env::temp_dir().join(format!("aura_nb_test_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(
            tmp.join("a.json"),
            serde_json::to_string(&make_block(
                "x",
                "command",
                "completed",
                "i",
                "did:a",
                "none",
                "",
                "2026-04-27T10:00:00Z",
                false,
            ))
            .unwrap(),
        )
        .unwrap();
        std::fs::write(tmp.join("ignore.txt"), "not json").unwrap();
        let blocks = read_blocks_dir(&tmp).unwrap();
        assert_eq!(blocks.len(), 1);
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
