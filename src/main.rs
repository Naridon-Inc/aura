#![recursion_limit = "512"]
mod models;
mod parser;
mod hook;
mod checkpoint;
mod watcher;
mod server;
mod mcp;
mod arbitrator;
mod stub;
pub mod config;
mod ecosystem;
mod lsp;
mod gsd;
mod pr;
mod toon;
pub mod orchestrate;
mod symphony;
mod linear;
mod exporter;
mod redact;
mod security;
mod sync;
mod session;
mod plugin;
mod plugins;
mod live_events;
mod live_sync;
mod agents;
mod sentinel;
mod memory;
mod usage;
mod plan_tracker;
mod host;
mod host_db;

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

fn setup_crash_reporter() {
    std::panic::set_hook(Box::new(|info| {
        let msg = match info.payload().downcast_ref::<&'static str>() {
            Some(s) => *s,
            None => match info.payload().downcast_ref::<String>() {
                Some(s) => &s[..],
                None => "Box<dyn Any>",
            },
        };

        if is_telemetry_enabled() {
            // Synchronous block to ensure it sends before the process dies
            let os = std::env::consts::OS;
            let payload = serde_json::json!({
                "event": "crash",
                "os": os,
                "version": CURRENT_VERSION,
                "metadata": msg
            });
            let client = reqwest::blocking::Client::builder().timeout(Duration::from_secs(2)).build().unwrap();
            let _ = client.post("http://api.auravcs.com/telemetry").json(&payload).send();
        }

        println!("\n{} {} {}", "💥".bold(), "Aura encountered a fatal anomaly:".bold().red(), msg);
        println!("  {} If this persists, please report it at https://github.com/Naridon-Inc/aura/issues", "↳".dimmed());
    }));
}

// Real Vector Embeddings via Gemini API or OpenAI API
// Generates a true mathematical vector representing the semantic meaning.
fn generate_embedding(text: &str) -> Option<Vec<f32>> {
    let client = reqwest::blocking::Client::new();

    // Try OpenAI First (if configured)
    if let Some(openai_key) = ConfigManager::get_api_key("openai") {
        let body = serde_json::json!({
            "model": "text-embedding-3-small",
            "input": text
        });

        if let Ok(res) = client.post("https://api.openai.com/v1/embeddings")
            .bearer_auth(openai_key)
            .header("content-type", "application/json")
            .json(&body)
            .send() 
        {
            if let Ok(json) = res.json::<serde_json::Value>() {
                if let Some(data) = json["data"].as_array() {
                    if let Some(embedding) = data.get(0).and_then(|d| d["embedding"].as_array()) {
                        let vec: Vec<f32> = embedding.iter().filter_map(|v| v.as_f64().map(|f| f as f32)).collect();
                        if !vec.is_empty() {
                            return Some(vec);
                        }
                    }
                }
            }
        }
    }

    // Fallback to Gemini
    if let Some(gemini_key) = ConfigManager::get_api_key("gemini") {
        let url = format!("https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key={}", gemini_key);
        let body = serde_json::json!({
            "model": "models/gemini-embedding-001",
            "content": {
                "parts": [{ "text": text }]
            }
        });

        if let Ok(res) = client.post(&url).json(&body).send() {
            if let Ok(json) = res.json::<serde_json::Value>() {
                if let Some(values) = json["embedding"]["values"].as_array() {
                    let vec: Vec<f32> = values.iter().filter_map(|v| v.as_f64().map(|f| f as f32)).collect();
                    if !vec.is_empty() {
                        return Some(vec);
                    }
                }
            }
        }
    }

    None
}

fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    let dot: f32 = a.iter().zip(b.iter()).map(|(x, y)| x * y).sum();
    let norm_a: f32 = a.iter().map(|x| x * x).sum::<f32>().sqrt();
    let norm_b: f32 = b.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm_a == 0.0 || norm_b == 0.0 { 0.0 } else { dot / (norm_a * norm_b) }
}

fn capture_env_fingerprint() -> Option<String> {
    ecosystem::Ecosystem::fingerprint()
}

const CURRENT_VERSION: &str = "0.11.3";

/// Build an HTTP client that respects accept_self_signed for mothership TLS.
fn cloud_http_client() -> reqwest::blocking::Client {
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
            
            let mut file = fs::File::create(&tmp_exe)?;
            std::io::copy(&mut response, &mut file)?;
            
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mut perms = fs::metadata(&tmp_exe)?.permissions();
                perms.set_mode(0o755);
                fs::set_permissions(&tmp_exe, perms)?;
            }
            
            fs::rename(&tmp_exe, &current_exe)?;

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
fn ensure_aura_gitignore() {
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
    },
    /// View current gatekeeper status, semantic checkpoints, and configuration
    Status,
    /// Audit the Git history for unsanctioned code pushed without AI intent verification
    Audit,
    /// Explain the intent behind code — trace a function back to the AI conversation that created it
    Explain {
        /// Function or identifier name to explain
        identifier: String,
        /// File path containing the identifier
        file: String,
    },
    /// List and manage agent sessions
    Sessions,
    /// Resume a previous session by switching to its branch and showing context
    Resume {
        /// Branch name to resume (e.g., "feat/auth")
        branch: String,
    },
    /// Diagnose and repair stuck sessions, orphaned data, and other issues
    Doctor,
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
    /// Trace logic paths to verify if the codebase supports a behavioral goal (experimental)
    #[command(name = "goal-trace", alias = "prove")]
    GoalTrace {
        /// The goal to verify (e.g., "users can log in via Google")
        #[arg(short, long)]
        goal: String
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
    /// Connect to a self-hosted Aura Server for team collaboration
    Server {
        #[command(subcommand)]
        sub: ServerSubcommands,
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
    /// Connect to a team mothership for P2P collaboration (advanced — use `aura join` instead)
    Connect {
        /// Mothership URL (e.g., https://192.168.1.50:7700)
        url: String,
        /// Invite code from the mothership host
        #[arg(long)]
        code: String,
        /// Your username
        #[arg(long)]
        username: String,
        /// Your password
        #[arg(long)]
        password: String,
        /// Expected TLS fingerprint (SHA-256) — verify against what the mothership shows
        #[arg(long)]
        fingerprint: Option<String>,
        /// Accept self-signed TLS certificates without fingerprint verification (less secure)
        #[arg(long)]
        accept_self_signed: bool,
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
    },
    /// Generate an invite code for teammates to join
    Invite {
        /// Max number of times this code can be used (default: 5)
        #[arg(long, default_value = "5")]
        max_uses: i32,
        /// Hours until the code expires (default: 168 = 7 days)
        #[arg(long, default_value = "168")]
        expires_hours: i64,
    },
    /// Show mothership status — connected peers, registered users, repos
    Status,
    /// Stop the running mothership process
    Stop,
}

#[derive(Subcommand)]
enum LiveSubcommands {
    /// Start streaming function-level changes to Aura Cloud in real-time
    Start,
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
    },
    /// Show sync status: pending changes, active pushers, synced functions
    Status,
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
        /// The name of the pack (e.g., 'security', 'payments', 'web-app')
        pack_name: String,
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

fn main() -> Result<(), Box<dyn std::error::Error>> {
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
        Commands::Plan { .. } => "plan",
        Commands::Execute => "execute",
        Commands::Rewind { .. } => "rewind",
        Commands::Handover { .. } => "handover",
        Commands::Status => "status",
        Commands::Audit => "audit",
        Commands::Explain { .. } => "explain",
        Commands::Sessions => "sessions",
        Commands::Resume { .. } => "resume",
        Commands::Doctor => "doctor",
        Commands::Completions { .. } => "completions",
        Commands::RequestAccess { .. } => "request-access",
        Commands::GoalTrace { .. } => "goal-trace",
        Commands::Config { .. } => "config",
        Commands::Live { .. } => "live",
        Commands::Server { .. } => "server",
        Commands::Host { .. } => "host",
        Commands::Ping => "ping",
        Commands::Join { .. } => "join",
        Commands::Connect { .. } => "connect",
        Commands::Usage { .. } => "usage",
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

                // Scan all files in index for the baseline
                for entry in index.iter() {
                    let path_str = String::from_utf8_lossy(&entry.path).to_string();
                    let ext = detect_lang_ext(&path_str); if ext.is_empty() { continue }; let ext = ext.as_str();
                    if let Ok(source_code) = fs::read_to_string(&path_str) {
                        if let Ok(ast_nodes) = parser.parse_file(&source_code, ext) {
                            staged_nodes.extend(ast_nodes);
                        }
                    }
                }

                let id = Uuid::new_v4().to_string().replace("-", "");
                let checkpoint = CheckpointData {
                    id: id.clone(),
                    timestamp: SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs(),
                    agent_id: "Aura Initializer".to_string(),
                    intent: "[Aura Baseline] Initialized Merkle-Graph for existing codebase.".to_string(),
                    ast_nodes: staged_nodes,
                    intent_vector: None,
                    env_fingerprint: capture_env_fingerprint(),
                };

                CheckpointStore::stage_checkpoint(&checkpoint)?;
                CheckpointStore::commit_staged(&repo)?;
                println!("    {} Baseline established successfully (ID: {}).", "✓".green(), id.cyan());            }

            // Auto-start the watcher daemon in the background
            println!("  {} Starting Aura watcher daemon...", "⚙️ ".cyan());
            match std::process::Command::new("aura")
                .arg("daemon")
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
            {
                Ok(child) => {
                    println!("    {} Watcher daemon running (PID: {}). Every file save is now tracked.", "✓".green(), child.id());
                    println!("    {} Snapshots stored in {}. Rewind will work even without commits.", "↳".dimmed(), ".aura/snapshots/".cyan());
                }
                Err(_) => {
                    println!("    {} Could not auto-start daemon. Run {} manually in a separate terminal.", "⚠️".yellow(), "aura daemon".cyan());
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
                        for node in ast_nodes {
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
                                        let should_continue = dialoguer::Confirm::with_theme(&ColorfulTheme::default())
                                            .with_prompt("Continue with commit?")
                                            .default(true)
                                            .interact()
                                            .unwrap_or(true);
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
                }
            }

            thread::sleep(Duration::from_millis(200));
            spinner.set_message(format!("{}", "Scanning for deleted logic nodes...".bold()));

            // ── DELETION GUARD: Detect when AI agents silently remove working code ──
            // Compare staged AST nodes against the latest checkpoint to find deletions.
            // This is the core protection against "AI overwrites good code while building new features."
            {
                let deletion_check_checkpoints = CheckpointStore::get_all_checkpoints(&repo).unwrap_or_default();
                if let Some(latest_checkpoint) = deletion_check_checkpoints.first() {
                    let staged_identifiers: std::collections::HashSet<String> = staged_nodes.iter()
                        .filter_map(|n| n.identifier.clone())
                        .collect();

                    let mut deleted_nodes: Vec<String> = Vec::new();
                    for prev_node in &latest_checkpoint.ast_nodes {
                        if let Some(ref ident) = prev_node.identifier {
                            // Skip anonymous/generated identifiers
                            if ident.is_empty() || ident == "anonymous" || ident.starts_with("__") {
                                continue;
                            }
                            // If a named node existed in the last checkpoint but is missing now, it was deleted
                            if !staged_identifiers.contains(ident) {
                                deleted_nodes.push(ident.clone());
                            }
                        }
                    }

                    if !deleted_nodes.is_empty() {
                        spinner.finish_and_clear();

                        // Check if intent mentions the deletion
                        let intent_text = fs::read_to_string(".gemini.intent").unwrap_or_default();
                        let intent_log = fs::read_to_string(".aura/intent_log.jsonl").unwrap_or_default();
                        let combined_intent = format!("{} {}", intent_text, intent_log).to_lowercase();

                        let intent_mentions_deletion = combined_intent.contains("remov")
                            || combined_intent.contains("delet")
                            || combined_intent.contains("deprecat")
                            || combined_intent.contains("drop")
                            || combined_intent.contains("strip")
                            || combined_intent.contains("clean")
                            || combined_intent.contains("refactor");

                        // Check if any deleted node names are mentioned in the intent
                        let intent_mentions_specific = deleted_nodes.iter()
                            .any(|name| combined_intent.contains(&name.to_lowercase()));

                        // Also check if intent mentions the deleted file/directory paths
                        // (for bulk directory deletions, listing every node name is unreasonable)
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
                        let intent_mentions_deleted_paths = deleted_file_paths.iter()
                            .any(|path| {
                                // Check if intent mentions the file path or its parent directory
                                let parts: Vec<&str> = path.split('/').collect();
                                parts.iter().any(|part| !part.is_empty() && part.len() > 2 && combined_intent.contains(*part))
                            });

                        let is_likely_intentional = intent_mentions_deletion
                            && (intent_mentions_specific || intent_mentions_deleted_paths);

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

                            if config.strict_gatekeeper_mode {
                                println!("\n  {} {}", "How to Fix:".bold().green(), "If this deletion is intentional, log your intent:");
                                println!("    {} aura log-intent \"Removed <directory/file> because <reason>\"", "$".dimmed());
                                println!("  {} Mention the deleted file/directory names and a deletion keyword (removed, deleted, cleaned, etc.)", "↳".dimmed());
                                println!("\n{} Commit halted. {} logic nodes would be lost.", "✗".red().bold(), deleted_nodes.len());
                                println!("  {} Safety snapshots saved to .aura/snapshots/", "✓".green());
                                std::process::exit(1);
                            } else {
                                println!("\n  {} Strict mode is OFF. Proceeding with warning.", "⚠️".yellow());
                                println!("  {} To block mass deletions, run: {}", "💡".blue(), "aura config set strict-mode true".italic());
                                let should_continue = dialoguer::Confirm::with_theme(&ColorfulTheme::default())
                                    .with_prompt(format!("Continue? {} logic nodes will be removed", deleted_nodes.len()))
                                    .default(false)
                                    .interact()
                                    .unwrap_or(false);
                                if !should_continue {
                                    println!("{} Commit cancelled. Review the deletions above.", "✗".red().bold());
                                    std::process::exit(1);
                                }
                            }
                        }
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

            // Clean up the intent session marker
            let _ = fs::remove_file(".aura/.intent_logged");

            // ── Session lifecycle: link this commit to an agent session ──
            let sess = session::SessionManager::start_session(&agent_id);
            // Track all staged files in the session (from git index)
            for entry in index.iter() {
                let path_str = String::from_utf8_lossy(&entry.path).to_string();
                if detect_lang_ext(&path_str).is_empty() { continue; }
                session::SessionManager::touch_file(&path_str);
            }
            // Capture full Claude Code transcript into session storage
            session::capture_full_transcript();

            // Intent Verification (Logic Alignment): Prevent "Intent Poisoning"
            // Ensure the AI's text intent actually aligns with the code it modified.
            if !force && agent_id != "Aura Continuous Daemon" && !staged_nodes.is_empty() {
                // Check if aura_log_intent was actually called (marker file must exist)
                let intent_was_logged = std::path::Path::new(".aura/.intent_logged").exists();

                // Block if intent was never logged via aura_log_intent
                // Always block — intent logging is mandatory for all commits with logic changes
                if !intent_was_logged {
                    spinner.finish_and_clear();
                    println!("{} Intent Not Logged: You must call {} before committing.", "🚨".red().bold(), "aura_log_intent".cyan().bold());
                    println!("  {} {} logic nodes were modified but no intent was logged via the MCP tool.", "↳".dimmed(), staged_nodes.len());
                    println!("\n  {} {}", "How to Fix:".bold().green(), "Call aura_log_intent with a description of your changes:");
                    println!("    {} aura_log_intent(\"<describe what you changed and why>\")", "→".dimmed());
                    println!("\n{} Commit halted.", "✗".red().bold());
                    std::process::exit(1);
                }

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
                        let should_continue = dialoguer::Confirm::with_theme(&ColorfulTheme::default())
                            .with_prompt("Continue with commit?")
                            .default(true)
                            .interact()
                            .unwrap_or(true);
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
                        let should_continue = dialoguer::Confirm::with_theme(&ColorfulTheme::default())
                            .with_prompt("Continue with commit?")
                            .default(true)
                            .interact()
                            .unwrap_or(true);
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
            if let Ok(checkpoints) = CheckpointStore::get_all_checkpoints(&repo) {
                if let Some(latest) = checkpoints.first() {
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
            }

            spinner.set_message(format!("{}", "Generating Neural Embeddings (Gemini API)...".bold()));
            let intent_vector = generate_embedding(&intent);

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
                env_fingerprint,
            };

            CheckpointStore::stage_checkpoint(&checkpoint)?;

            // Increment session checkpoint count
            session::SessionManager::increment_checkpoint();

            spinner.finish_and_clear();

            println!("{} Checkpoint logic staged.", "✓".green().bold());
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
                
                let query_vector = generate_embedding(&query);

                if let Some(qv) = query_vector {
                    results.sort_by(|a, b| {
                        let score_a = if let Some(ref av) = a.intent_vector { cosine_similarity(&av, &qv) } else { 0.0 };
                        let score_b = if let Some(ref bv) = b.intent_vector { cosine_similarity(&bv, &qv) } else { 0.0 };
                        // Sort descending by score
                        score_b.partial_cmp(&score_a).unwrap_or(std::cmp::Ordering::Equal)
                    });
                    
                    // Filter out low relevance using cosine similarity threshold
                    results.retain(|r| {
                        if let Some(ref rv) = r.intent_vector {
                            cosine_similarity(&rv, &qv) > 0.3 // Standard threshold
                        } else {
                            false
                        }
                    });
                } else {
                    println!("{} Failed to initialize embedding model.", "✗".red());
                    println!("  {} {}", "ℹ️ ".blue(), "Required: API Key (Gemini or OpenAI)".bold());
                    println!("    To use semantic search, Aura needs an API key to generate vector embeddings.");
                    println!("    1. Export it: `export GEMINI_API_KEY=...` or `export OPENAI_API_KEY=...`");
                    println!("    2. Or set it via the CLI: `aura config` -> `Update API Keys`\n");
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
        Commands::Handover { agent } => {
            let repo = open_repo()?;
            let results = CheckpointStore::get_all_checkpoints(&repo)?;
            
            println!("{} Generating dense XML context payload for {}...", "🔄".cyan(), agent.bold());
            
            let mut xml_payload = String::from("<aura_semantic_context>\n");
            for data in results.iter().take(3) {
                xml_payload.push_str(&format!("  <checkpoint id=\"{}\" agent=\"{}\">\n", data.id, data.agent_id));
                xml_payload.push_str(&format!("    <intent>{}</intent>\n", data.intent.replace("\n", " ")));
                xml_payload.push_str("    <modified_nodes>\n");
                for node in &data.ast_nodes {
                    let ident = node.identifier.clone().unwrap_or_else(|| "anonymous".to_string());
                    xml_payload.push_str(&format!("      <node type=\"{}\" name=\"{}\"", node.kind, ident));
                    if !node.dependencies.is_empty() {
                        let deps: Vec<String> = node.dependencies.iter().map(|d| {
                            if let Some(ref uri) = d.uri {
                                format!("{}={}", d.name, uri)
                            } else {
                                d.name.clone()
                            }
                        }).collect();
                        xml_payload.push_str(&format!(" calls=\"{}\"", deps.join(",")));
                    }
                    xml_payload.push_str("/>\n");
                }
                xml_payload.push_str("    </modified_nodes>\n  </checkpoint>\n");
            }
            xml_payload.push_str("</aura_semantic_context>");
            
            // In a real product, we would pipe this into pbcopy or directly into the target agent's config file
            println!("\n{}", xml_payload.dimmed());
            println!("\n{} Handover block ready. Paste this into {}'s prompt or system rules.", "✓".green().bold(), agent);
        }
        Commands::Rewind { identifier, file_path, amnesia } => {
            println!("\n{} {} {}", "⏪".bold(), "Aura Semantic Time Machine: Rewinding".bold().cyan(), identifier.bold().yellow());

            let repo = open_repo()?;
            let mut parser = SemanticParser::new()?;

            // Determine file extension
            let ext = detect_lang_ext(&file_path);
            if ext.is_empty() {
                println!("Unsupported file extension.");
                return Ok(());
            }
            let ext = ext.as_str();

            // 1. Parse the current file on disk
            let current_source = match fs::read_to_string(file_path) {
                Ok(s) => s,
                Err(e) => {
                    println!("Failed to read target file: {}", e);
                    return Ok(());
                }
            };

            let current_node_info = parser.retrieve_node_source(&current_source, ext, identifier)?;
            let current_range = match current_node_info {
                Some((_, range)) => range,
                None => {
                    println!("{} Could not find '{}' in the current file.", "✗".red(), identifier);
                    return Ok(());
                }
            };

            // 2. Search for previous state — try THREE sources in order:
            //    a) Durable file snapshots (.aura/snapshots/) — survives even without commits
            //    b) Full git history (walk ALL commits, not just HEAD~1)
            //    c) Fall back to HEAD~1 as last resort

            let mut past_node_source: Option<String> = None;

            // Strategy A: Check durable snapshots first
            println!("  {} Searching durable snapshots...", "↳".dimmed());
            let snapshots = checkpoint::SnapshotStore::get_snapshots_for_file(file_path);
            for snap in &snapshots {
                if let Ok(Some((src, _))) = parser.retrieve_node_source(&snap.content, ext, identifier) {
                    // Make sure it's actually different from current
                    if let Some((current_src, _)) = parser.retrieve_node_source(&current_source, ext, identifier)? {
                        if src != current_src {
                            println!("  {} Found in snapshot from {} (trigger: {})",
                                "✓".green(), snap.timestamp, snap.trigger);
                            past_node_source = Some(src);
                            break;
                        }
                    }
                }
            }

            // Strategy B: Walk full git history (up to 50 commits back)
            if past_node_source.is_none() {
                println!("  {} Searching git history (up to 50 commits)...", "↳".dimmed());
                let mut commit = match repo.head().and_then(|r| r.peel_to_commit()) {
                    Ok(c) => c,
                    Err(_) => {
                        println!("{} No git history available.", "✗".red());
                        return Ok(());
                    }
                };

                for depth in 0..50 {
                    let parent = match commit.parent(0) {
                        Ok(p) => p,
                        Err(_) => break,
                    };

                    let tree = parent.tree()?;
                    if let Ok(entry) = tree.get_path(Path::new(file_path)) {
                        let obj = entry.to_object(&repo)?;
                        if let Some(blob) = obj.as_blob() {
                            if let Ok(past_source) = std::str::from_utf8(blob.content()) {
                                if let Ok(Some((src, _))) = parser.retrieve_node_source(past_source, ext, identifier) {
                                    // Make sure it's different from current
                                    if let Some((current_src, _)) = parser.retrieve_node_source(&current_source, ext, identifier)? {
                                        if src != current_src {
                                            println!("  {} Found in commit ~{} ({})",
                                                "✓".green(), depth + 1, &parent.id().to_string()[..8]);
                                            past_node_source = Some(src);
                                            break;
                                        }
                                    }
                                }
                            }
                        }
                    }

                    commit = parent;
                }
            }

            let past_node_source = match past_node_source {
                Some(s) => s,
                None => {
                    println!("{} No previous version of '{}' found in snapshots or git history.", "✗".red(), identifier);
                    println!("  {} Tip: Aura auto-snapshots files before AI edits. If no snapshot exists,", "↳".dimmed());
                    println!("  {} the function may have been created in this session without a prior state.", "↳".dimmed());
                    return Ok(());
                }
            };

            // Snapshot the current state BEFORE we rewind (safety net)
            if let Err(e) = checkpoint::SnapshotStore::snapshot_file(file_path, "pre_rewind", "aura-rewind") {
                eprintln!("  {} Warning: Could not snapshot current state: {}", "⚠️".yellow(), e);
            }

            // 4. Perform the Semantic Surgery
            let mut new_source = current_source.clone();
            new_source.replace_range(current_range, &past_node_source);

            // 5. Save the file
            let mut file = OpenOptions::new().write(true).truncate(true).open(file_path)?;
            file.write_all(new_source.as_bytes())?;

            println!("{} Surgically reverted '{}' to its previous logic state.", "✓".green().bold(), identifier);
            println!("  {} The rest of {} remains untouched.", "↳".dimmed(), file_path);

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
            let results = CheckpointStore::get_all_checkpoints(&repo)?;
            
            if let Some(latest) = results.first() {
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
        Commands::GoalTrace { goal } => {
            crate::gsd::GsdEngine::prove_goal(goal);
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
                    match CheckpointStore::get_all_checkpoints(&repo) {
                        Ok(checkpoints) => {
                            if let Some(latest) = checkpoints.first() {
                                println!("  {} {}: {}", "📍".blue(), "Latest Checkpoint".bold(), latest.id[0..8].to_string().cyan());
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

            println!();
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
        Commands::Resume { branch } => {
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
        Commands::Doctor => {
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

            // 4. Check git hooks are installed
            let hooks_ok = Path::new(".git/hooks/pre-commit").exists();
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
            }
        }
        Commands::Orchestrate { sub } => {
            match sub {
                OrchestrateSubcommands::Run { objective, strategy, base, duo } => {
                    let strat = match strategy.as_str() {
                        "round-robin" => orchestrate::AssignmentStrategy::RoundRobin,
                        "smart" | _ => orchestrate::AssignmentStrategy::Smart,
                    };
                    if *duo {
                        orchestrate::run_duo(&objective, &base)?;
                    } else {
                        orchestrate::run(&objective, strat, &base)?;
                    }
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
        Commands::Live { sub } => {
            match sub {
                LiveSubcommands::Start => {
                    use colored::Colorize;
                    use std::sync::atomic::{AtomicBool, Ordering};
                    use std::sync::Arc;

                    println!("{}", "🔴 Aura Live — Real-time Collaborative Code Awareness".bold());
                    println!();
                    println!("  {} {}", "User:".dimmed(), live_events::git_user().cyan());
                    println!("  {} {}", "Branch:".dimmed(), live_events::current_branch().cyan());
                    println!("  {} {}", "Repo:".dimmed(), live_events::repo_name().cyan());
                    live_sync::print_sync_status();
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
                            .unwrap_or_else(|| "https://auravcs.com".to_string());
                        let url = format!("{}/api/v1/live/presence?repo={}",
                            cloud_url.trim_end_matches('/'), repo);

                        let client = reqwest::blocking::Client::builder()
                            .timeout(std::time::Duration::from_secs(5))
                            .build()
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
                            .unwrap_or_else(|| "https://auravcs.com".to_string());
                        let url = format!("{}/api/v1/live/impacts?repo={}",
                            cloud_url.trim_end_matches('/'), repo);

                        println!("  {} Checking impacts on branch {}...", "↳".dimmed(), branch.cyan());
                        println!();

                        let client = reqwest::blocking::Client::builder()
                            .timeout(std::time::Duration::from_secs(5))
                            .build()
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
                        SyncSubcommands::Pull { dry_run } => {
                            use colored::Colorize;
                            println!("{}", "🔄 Aura Sync — Pull".bold());
                            println!();

                            let branch = live_events::current_branch();
                            println!("  {} Pulling changes on branch {}...",
                                "↳".dimmed(), branch.cyan());

                            match live_sync::pull_function_bodies() {
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
        Commands::Host { sub } => {
            match sub {
                HostSubcommands::Start { port, tunnel, no_tls } => {
                    let rt = tokio::runtime::Runtime::new().unwrap();
                    rt.block_on(async {
                        if let Err(e) = host::start_mothership(*port, *tunnel, *no_tls).await {
                            eprintln!("{} Mothership failed: {}", "✗".red().bold(), e);
                        }
                    });
                }
                HostSubcommands::Invite { max_uses, expires_hours } => {
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

                                match host_db::create_invite_code(&conn, &org.id, &creator, *max_uses, *expires_hours) {
                                    Ok(invite) => {
                                        // Build join token
                                        let config = ConfigManager::load();
                                        let local_ip = host::JoinToken::decode("").map(|_| "localhost".to_string())
                                            .unwrap_or_else(|| "localhost".to_string());
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
                    let db_path = format!("{}/.aura/mothership.db", std::env::var("HOME").unwrap_or_else(|_| ".".to_string()));
                    if !std::path::Path::new(&db_path).exists() {
                        println!("{} Mothership has never been started. Run: aura host start", "ℹ".blue());
                        return Ok(());
                    }
                    match host_db::init_db(&db_path) {
                        Ok(conn) => {
                            let users = host_db::count_users(&conn).unwrap_or(0);
                            let repos = host_db::count_repos(&conn).unwrap_or(0);
                            let active: i64 = conn.query_row(
                                "SELECT COUNT(*) FROM live_sessions WHERE last_heartbeat > datetime('now', '-2 minutes')",
                                [], |row| row.get(0)
                            ).unwrap_or(0);

                            println!("\n  {} Aura Mothership Status", "🖥".bold());
                            println!("  {} Database: {}", "•".dimmed(), db_path);
                            println!("  {} Registered users: {}", "•".dimmed(), format!("{}", users).cyan());
                            println!("  {} Tracked repos: {}", "•".dimmed(), format!("{}", repos).cyan());
                            println!("  {} Active peers (2m): {}", "•".dimmed(), format!("{}", active).green());
                            println!();
                        }
                        Err(e) => eprintln!("{} Cannot read database: {}", "✗".red().bold(), e),
                    }
                }
                HostSubcommands::Stop => {
                    // Kill any running mothership process
                    let _ = std::process::Command::new("pkill").args(["-f", "aura host start"]).status();
                    println!("{} Mothership stopped", "✓".green().bold());
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
        Commands::Connect { url, code, username, password, fingerprint, accept_self_signed } => {
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
        Commands::Usage { period, json, project, plan, budget_daily, budget_weekly, budget_session, export } => {
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

                if *json {
                    println!("{}", serde_json::to_string_pretty(&usage::report_to_json(&report)).unwrap_or_default());
                } else {
                    usage::print_report(&report);

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
    }

    Ok(())
}

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
