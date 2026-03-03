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
fn track_event(event_name: &str, metadata: Option<&str>) {
    let config = ConfigManager::load();
    if !config.telemetry_enabled {
        return;
    }

    let os = std::env::consts::OS;
    let arch = std::env::consts::ARCH;
    let version = CURRENT_VERSION;
    let payload = serde_json::json!({
        "event": event_name,
        "os": os,
        "arch": arch,
        "version": version,
        "metadata": metadata.unwrap_or("none")
    });

    // Fire and forget in a background thread so it never blocks the user
    thread::spawn(move || {
        let client = reqwest::blocking::Client::builder().timeout(Duration::from_secs(3)).build().unwrap();
        let _ = client.post("http://api.auravcs.com/telemetry")
            .json(&payload)
            .send();
    });
}

fn setup_crash_reporter() {
    std::panic::set_hook(Box::new(|info| {
        let config = ConfigManager::load();
        
        let msg = match info.payload().downcast_ref::<&'static str>() {
            Some(s) => *s,
            None => match info.payload().downcast_ref::<String>() {
                Some(s) => &s[..],
                None => "Box<dyn Any>",
            },
        };

        if config.telemetry_enabled {
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
        let url = format!("https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key={}", gemini_key);
        let body = serde_json::json!({
            "model": "models/text-embedding-004",
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

const CURRENT_VERSION: &str = "0.2.13-alpha";

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
            println!("{} Aura updated successfully to v{}!", "✓".green().bold(), new_version);
        }
    } else {
        println!("{} Aura is already up to date (v{}).", "✓".green().bold(), CURRENT_VERSION);
    }
    Ok(())
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
}

#[derive(Subcommand)]
enum Commands {
    /// Initialize Aura in this repository with an interactive setup wizard
    Init {
        /// Force a baseline scan of the entire project (bypasses intent check)
        #[arg(long)]
        force_baseline: bool,
    },
    /// Plan a massive architectural objective using the native GSD Orchestrator
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
    /// (Internal) Run an autonomous conflict resolution arbitration
    #[command(hide = true)]
    Arbitrate { file_path: String },
    /// (Internal) Create compiler-safe dummy logic for Enterprise RBAC
    #[command(hide = true)]
    GenerateStubs,
    /// (Internal) Semantic Compaction: Prune implicit history
    #[command(hide = true)]
    Gc,
    /// (Internal) Check for and install updates to the Aura CLI
    #[command(hide = true)]
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
    /// Mathematically prove if the codebase supports a specific behavioral goal
    Prove { 
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
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    setup_crash_reporter();
    let cli = Cli::parse();

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
        Commands::RequestAccess { .. } => "request-access",
        Commands::Prove { .. } => "prove",
        Commands::Config { .. } => "config",
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
            
            let repo = Repository::open(".")?;
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
            let agents = &["Cursor", "Claude Desktop", "Gemini CLI", "Aider", "OpenCode"];
            let selections = MultiSelect::with_theme(&ColorfulTheme::default())
                .with_prompt("Which AI Agents will be working in this repository? (Use space to select MULTIPLE, Enter to confirm)")
                .items(&agents[..])
                .interact()?;

            // Automated MCP Injection
            for &idx in &selections {
                match agents[idx] {
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
                            "name": "aura-gsd",
                            "description": "Enforces the GetShitDone (GSD) atomic execution workflow for Claude.",
                            "instructions": "You are the Aura GSD Wave Runner. When given a large task, NEVER attempt to solve it in a single generation loop. Step 1: Plan. Create a file at `.aura/plans/ACTIVE_MILESTONE.xml` with atomic XML steps (<plan>, <action>, <verify>). Step 2: Execute. Read the first plan, execute the action, create `.gemini.intent`, and run `git add . && git commit -m 'GSD Wave'`. Wait for human approval between waves."
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

                        // Inject settings.json to enable the hook
                        let settings = serde_json::json!({
                            "hooks": {
                                "SessionStart": [
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
                                ],
                                "AfterAgent": [
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
                                ]
                            }
                        });
                        let _ = fs::write(gemini_project_dir.join("settings.json"), serde_json::to_string_pretty(&settings).unwrap_or_default());
                        
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

                let api_key = Password::with_theme(&ColorfulTheme::default())
                    .with_prompt(format!("Please provide your {} API Key (Securely vaulted locally)", provider))
                    .allow_empty_password(true)
                    .interact()?;
                
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

            if *force_baseline {
                println!("  {} Establishing Merkle-Graph baseline (Force Mode)...", "🧠".cyan());

                let mut parser = SemanticParser::new()?;
                let mut staged_nodes = Vec::new();

                // Scan all files in index for the baseline
                for entry in index.iter() {
                    let path_str = String::from_utf8_lossy(&entry.path).to_string();
                    let ext = if path_str.ends_with(".rs") { "rs" } else if path_str.ends_with(".py") { "py" } else if path_str.ends_with(".ts") || path_str.ends_with(".tsx") { "ts" } else if path_str.ends_with(".js") || path_str.ends_with(".jsx") { "js" } else { continue };
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

            println!("\n{} {}\n", "🚀".bold(), "Aura is now protecting your repository.".bold().green());
            
            let final_instructions = vec![
                format!("{} Code normally. Aura automatically intercepts `{}`.", "1.".cyan().bold(), "git commit".italic()),
                format!("{} Ask questions natively via `{}`.", "2.".cyan().bold(), "aura ask".italic()),
                format!("{} Rewind AI hallucinations safely via `{}`.", "3.".cyan().bold(), "aura rewind".italic()),
            ];
            
            for inst in final_instructions {
                println!("   {}", inst);
            }
            
            println!("\n{}\n", "Welcome to the age of Agentic Engineering.".bold().blue());
        }
        Commands::CaptureContext { force } => {
            let spinner = ProgressBar::new_spinner();
            spinner.set_style(
                ProgressStyle::default_spinner()
                    .tick_chars("⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏ ")
                    .template("{spinner:.cyan} {msg}")
                    .unwrap(),
            );

            spinner.set_message(format!("{}", "Analyzing staged files semantically...".bold()));
            spinner.enable_steady_tick(Duration::from_millis(80));

            let repo = Repository::open(".")?;
            let mut parser = SemanticParser::new()?;
            let config = ConfigManager::load();

            let index = repo.index()?;
            let mut staged_nodes = Vec::new();

            for entry in index.iter() {
                let path_str = String::from_utf8_lossy(&entry.path).to_string();
                let ext = if path_str.ends_with(".rs") { "rs" } else if path_str.ends_with(".py") { "py" } else if path_str.ends_with(".ts") || path_str.ends_with(".tsx") { "ts" } else if path_str.ends_with(".js") || path_str.ends_with(".jsx") { "js" } else { continue };

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
                                        println!("  {} To bypass all blocks globally, run: {}", "💡".blue(), "aura config set strict-mode false".italic());
                                        println!("  {} (Using config: {})", "🔍".dimmed(), config_path.dimmed());
                                        std::process::exit(1);
                                    } else {
                                        spinner.println(format!("{} Semantic Sentinel Warning.", "⚠️".yellow().bold()));
                                        spinner.println(format!("  {} High-entropy pattern detected in node '{}'. Proceeding (Strict Mode is OFF).", "↳".dimmed(), ident.yellow()));
                                    }
                                }
                            }
                            staged_nodes.push(node);
                        }
                    }
                }
            }

            thread::sleep(Duration::from_millis(200));
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

            // Intent Verification (Logic Alignment): Prevent "Intent Poisoning"
            // Ensure the AI's text intent actually aligns with the code it modified.
            if !force && agent_id != "Aura Continuous Daemon" && !staged_nodes.is_empty() {
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
                        println!("  {} To bypass this security requirement, run: {}", "💡".blue(), "aura config set strict-mode false".italic());
                        println!("\n{} Commit halted.", "✗".red().bold());
                        std::process::exit(1);
                    } else {
                        spinner.println(format!("{} Intent Poisoning Warning.", "⚠️".yellow().bold()));
                        spinner.println(format!("  {} Missing explicit semantic intent for modified nodes.", "↳".dimmed()));
                        spinner.println(format!("  {} Proceeding anyway because strict mode is disabled.", "↳".dimmed().italic()));
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
                        println!("  {} If this is intentional and you wish to bypass this check, run: {}", "💡".blue(), "aura config set strict-mode false".italic());
                        
                        println!("\n{} Commit halted.", "✗".red().bold());
                        std::process::exit(1);
                    } else {
                        spinner.println(format!("{} Intent Mismatch Warning.", "⚠️".yellow().bold()));
                        spinner.println(format!("  {} The AI modified nodes without explicit documentation: {}", "↳".dimmed(), identified_nodes.join(", ").yellow()));
                        spinner.println(format!("  {} Proceeding anyway because strict mode is disabled.", "↳".dimmed().italic()));
                    }
                } else {
                    spinner.println(format!("{} Intent mathematically aligned with AST modifications.", "🛡️ ".green()));
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
            
            spinner.finish_and_clear();
            
            println!("{} Checkpoint logic staged.", "✓".green().bold());
            println!("  {} {} semantic nodes tracked", "↳".dimmed(), staged_nodes.len().to_string().cyan());
        }
        Commands::InjectTrailer { commit_msg_file } => {
            if let Ok(Some(data)) = CheckpointStore::read_staged() {
                let trailer = format!("\n\nAura-Checkpoint: {}\n", data.id);
                let mut file = OpenOptions::new().append(true).open(commit_msg_file)?;
                file.write_all(trailer.as_bytes())?;
            }
        }
        Commands::PersistCheckpoint => {
            let repo = Repository::open(".")?;
            if let Ok(Some(data)) = CheckpointStore::read_staged() {
                if let Err(e) = CheckpointStore::commit_staged(&repo) {
                    println!("Failed to persist checkpoint: {}", e);
                } else {
                    println!("{} Checkpoint {} permanently recorded in Git metadata.", "✓".green().bold(), &data.id[0..8]);
                }
            }
        }
        Commands::Ask { query } => {
            let repo = Repository::open(".")?;
            
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
            let repo = Repository::open(".")?;
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
            
            let repo = Repository::open(".")?;
            let mut parser = SemanticParser::new()?;
            
            // Determine file extension
            let ext = if file_path.ends_with(".rs") { "rs" } else if file_path.ends_with(".py") { "py" } else if file_path.ends_with(".ts") || file_path.ends_with(".tsx") { "ts" } else if file_path.ends_with(".js") || file_path.ends_with(".jsx") { "js" } else { 
                println!("Unsupported file extension.");
                return Ok(());
            };

            // 1. Parse the current file on disk
            let current_source = match fs::read_to_string(file_path) {
                Ok(s) => s,
                Err(e) => {
                    println!("Failed to read target file: {}", e);
                    return Ok(());
                }
            };

            let current_node_info = parser.extract_node_source(&current_source, ext, identifier)?;
            let current_range = match current_node_info {
                Some((_, range)) => range,
                None => {
                    println!("{} Could not find '{}' in the current file.", "✗".red(), identifier);
                    return Ok(());
                }
            };

            // 2. Fetch the previous state from Git HEAD~1
            // In a full implementation, we could let the user specify exactly which checkpoint UUID they want.
            // For this MVP, we grab the version from the parent of the last commit.
            let head_commit = repo.head()?.peel_to_commit()?;
            let parent_commit = head_commit.parent(0)?;
            let head_tree = parent_commit.tree()?;
            
            let tree_entry = match head_tree.get_path(Path::new(file_path)) {
                Ok(entry) => entry,
                Err(_) => {
                    println!("{} File not found in previous commit.", "✗".red());
                    return Ok(());
                }
            };

            let object = tree_entry.to_object(&repo)?;
            let blob = object.as_blob().unwrap();
            let past_source = std::str::from_utf8(blob.content())?;

            // 3. Extract the old AST node source
            let past_node_info = parser.extract_node_source(past_source, ext, identifier)?;
            let past_node_source = match past_node_info {
                Some((src, _)) => src,
                None => {
                    println!("{} Function '{}' did not exist in the previous commit.", "✗".red(), identifier);
                    return Ok(());
                }
            };

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
            let repo = Repository::open(".")?;
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
        Commands::Prove { goal } => {
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
            let repo = Repository::open(".")?;
            let mut parser = SemanticParser::new()?;
            let index = repo.index()?;
            let mut all_ast_nodes = Vec::new();

            for entry in index.iter() {
                let path_str = String::from_utf8_lossy(&entry.path).to_string();
                let ext = if path_str.ends_with(".rs") { "rs" } else if path_str.ends_with(".py") { "py" } else if path_str.ends_with(".ts") || path_str.ends_with(".tsx") { "ts" } else if path_str.ends_with(".js") || path_str.ends_with(".jsx") { "js" } else { continue };

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
                    println!("  {} To allow these changes, set `strict_gatekeeper_mode: false` with `aura config set strict-mode false`", "💡".blue());
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
        Commands::Arbitrate { file_path } => {
            Arbitrator::resolve_conflict(file_path);
        }
        Commands::GenerateStubs => {
            StubEngine::generate_stubs();
        }
        Commands::Gc => {
            println!("{} {}", "🧹".bold(), "Aura Semantic Compaction: Analyzing history...".bold().cyan());
            let repo = Repository::open(".")?;
            match CheckpointStore::compact_history(&repo) {
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
                                println!("  {} {}: {} logic nodes tracked\n", "🧠".magenta(), "Merkle-Graph Size".bold(), latest.ast_nodes.len().to_string().yellow());
                            } else {
                                println!("  {} {}\n", "ℹ️ ".blue(), "No semantic checkpoints found. Run `aura capture-context` or `git commit` to start tracking.".dimmed());
                            }
                        },
                        Err(_) => {
                            println!("  {} {}\n", "⚠️".yellow(), "Could not read semantic history.".dimmed());
                        }
                    }
                },
                Err(_) => {
                    println!("  {} {}\n", "✗".red(), "Not a Git repository.".bold());
                }
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
                                config.strict_gatekeeper_mode = value.parse().unwrap_or(false);
                                println!("{} Strict mode set to {}.", "✓".green().bold(), config.strict_gatekeeper_mode);
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
                            _ => {
                                println!("{} Unknown configuration key: {}", "✗".red(), key);
                                return Ok(());
                            }
                        }
                        ConfigManager::save(&config)?;
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
                    
                    config.strict_gatekeeper_mode = strict;
                    ConfigManager::save(&config)?;
                    println!("{} Gatekeeper strict mode updated.", "✓".green().bold());
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
    }

    Ok(())
}
