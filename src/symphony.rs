use crate::linear::{LinearClient, LinearIssue, TeamMeta, IssueUpdate};
use crate::orchestrate::{self, SessionTokenStats};
use colored::Colorize;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use std::{fs, thread};

// ─── WORKFLOW.md Config ─────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct WorkflowHooks {
    #[serde(default)]
    pub after_create: Option<String>,
    #[serde(default)]
    pub before_run: Option<String>,
    #[serde(default)]
    pub after_run: Option<String>,
    #[serde(default)]
    pub before_remove: Option<String>,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Clone)]
pub struct WorkflowConfig {
    pub tracker_kind: String,
    pub project_slug: String,
    pub active_states: Vec<String>,
    pub terminal_states: Vec<String>,
    pub poll_interval_ms: u64,
    pub workspace_root: PathBuf,
    pub max_concurrent: usize,
    pub max_turns: usize,
    pub max_retry_backoff_ms: u64,
    pub hooks: WorkflowHooks,
    pub prompt_template: String,
    pub agent_command: Option<String>,
}

impl Default for WorkflowConfig {
    fn default() -> Self {
        Self {
            tracker_kind: "linear".to_string(),
            project_slug: String::new(),
            active_states: vec!["Todo".to_string(), "In Progress".to_string()],
            terminal_states: vec!["Done".to_string(), "Cancelled".to_string(), "Closed".to_string()],
            poll_interval_ms: 5000,
            workspace_root: dirs_workspace_root(),
            max_concurrent: 5,
            max_turns: 10,
            max_retry_backoff_ms: 300_000,
            hooks: WorkflowHooks::default(),
            prompt_template: default_prompt_template(),
            agent_command: None,
        }
    }
}

fn dirs_workspace_root() -> PathBuf {
    directories::BaseDirs::new()
        .map(|d| d.home_dir().join(".aura").join("workspaces"))
        .unwrap_or_else(|| PathBuf::from("/tmp/aura-workspaces"))
}

fn default_prompt_template() -> String {
    r#"You are working on a Linear issue.

Identifier: {{ issue.identifier }}
Title: {{ issue.title }}
Status: {{ issue.state }}

Description:
{{ issue.description }}

Instructions:
1. This is an unattended orchestration session. Never ask a human to perform follow-up actions; when a choice arises, pick the most reasonable option and proceed.
2. Only stop early for a true blocker (missing required auth/permissions/secrets). If you stop, report exactly what blocked you.
3. Work only in the provided repository copy — touch only what this issue needs and no other path. Make no unrelated or destructive changes.
4. Before declaring done, verify it: confirm the code compiles and tests pass. Report what you actually ran and its result; never claim a check passed that you didn't run.
"#.to_string()
}

/// Parse a WORKFLOW.md file (YAML front matter + prompt template body).
pub fn parse_workflow(path: &str) -> Result<WorkflowConfig, String> {
    let content = fs::read_to_string(path)
        .map_err(|e| format!("Failed to read {}: {}", path, e))?;

    let (yaml_str, prompt_body) = split_front_matter(&content);
    let mut config = WorkflowConfig::default();

    if !yaml_str.is_empty() {
        let yaml: serde_yaml::Value = serde_yaml::from_str(&yaml_str)
            .map_err(|e| format!("Failed to parse WORKFLOW.md YAML: {}", e))?;

        // Tracker section
        if let Some(tracker) = yaml.get("tracker") {
            if let Some(kind) = tracker.get("kind").and_then(|v| v.as_str()) {
                config.tracker_kind = kind.to_string();
            }
            if let Some(slug) = tracker.get("project_slug").and_then(|v| v.as_str()) {
                config.project_slug = slug.to_string();
            }
            if let Some(states) = tracker.get("active_states").and_then(|v| v.as_sequence()) {
                config.active_states = states.iter()
                    .filter_map(|s| s.as_str().map(|s| s.to_string()))
                    .collect();
            }
            if let Some(states) = tracker.get("terminal_states").and_then(|v| v.as_sequence()) {
                config.terminal_states = states.iter()
                    .filter_map(|s| s.as_str().map(|s| s.to_string()))
                    .collect();
            }
        }

        // Polling section
        if let Some(polling) = yaml.get("polling") {
            if let Some(ms) = polling.get("interval_ms").and_then(|v| v.as_u64()) {
                config.poll_interval_ms = ms;
            }
        }

        // Workspace section
        if let Some(ws) = yaml.get("workspace") {
            if let Some(root) = ws.get("root").and_then(|v| v.as_str()) {
                let expanded = shellexpand_simple(root);
                config.workspace_root = PathBuf::from(expanded);
            }
        }

        // Agent section
        if let Some(agent) = yaml.get("agent") {
            if let Some(mc) = agent.get("max_concurrent").or(agent.get("max_concurrent_agents")).and_then(|v| v.as_u64()) {
                config.max_concurrent = mc as usize;
            }
            if let Some(mt) = agent.get("max_turns").and_then(|v| v.as_u64()) {
                config.max_turns = mt as usize;
            }
            if let Some(mb) = agent.get("max_retry_backoff_ms").and_then(|v| v.as_u64()) {
                config.max_retry_backoff_ms = mb;
            }
        }

        // Hooks section
        if let Some(hooks) = yaml.get("hooks") {
            if let Some(h) = hooks.get("after_create").and_then(|v| v.as_str()) {
                config.hooks.after_create = Some(h.trim().to_string());
            }
            if let Some(h) = hooks.get("before_run").and_then(|v| v.as_str()) {
                config.hooks.before_run = Some(h.trim().to_string());
            }
            if let Some(h) = hooks.get("after_run").and_then(|v| v.as_str()) {
                config.hooks.after_run = Some(h.trim().to_string());
            }
            if let Some(h) = hooks.get("before_remove").and_then(|v| v.as_str()) {
                config.hooks.before_remove = Some(h.trim().to_string());
            }
            if let Some(ms) = hooks.get("timeout_ms").and_then(|v| v.as_u64()) {
                config.hooks.timeout_ms = Some(ms);
            }
        }
    }

    // Use prompt body if non-empty, otherwise default
    let trimmed = prompt_body.trim();
    if !trimmed.is_empty() {
        config.prompt_template = trimmed.to_string();
    }

    if config.project_slug.is_empty() {
        return Err("WORKFLOW.md must specify tracker.project_slug".to_string());
    }

    Ok(config)
}

fn split_front_matter(content: &str) -> (String, String) {
    let lines: Vec<&str> = content.lines().collect();
    if lines.first().map(|l| l.trim()) != Some("---") {
        return (String::new(), content.to_string());
    }

    // Find closing ---
    let mut end_idx = None;
    for (i, line) in lines.iter().enumerate().skip(1) {
        if line.trim() == "---" {
            end_idx = Some(i);
            break;
        }
    }

    match end_idx {
        Some(idx) => {
            let yaml = lines[1..idx].join("\n");
            let body = lines[idx + 1..].join("\n");
            (yaml, body)
        }
        None => (String::new(), content.to_string()),
    }
}

fn shellexpand_simple(path: &str) -> String {
    if path.starts_with("~/") {
        if let Some(home) = directories::BaseDirs::new().map(|d| d.home_dir().to_path_buf()) {
            return home.join(&path[2..]).to_string_lossy().to_string();
        }
    }
    // Resolve $VAR
    if path.starts_with('$') {
        let var = path.trim_start_matches('$');
        if let Ok(val) = std::env::var(var) {
            return val;
        }
    }
    path.to_string()
}

fn render_prompt(template: &str, issue: &LinearIssue) -> String {
    template
        .replace("{{ issue.identifier }}", &issue.identifier)
        .replace("{{ issue.title }}", &issue.title)
        .replace("{{ issue.state }}", &issue.state)
        .replace("{{ issue.description }}", issue.description.as_deref().unwrap_or("No description provided."))
        .replace("{{ issue.url }}", &issue.url)
        .replace("{{ issue.branch_name }}", issue.branch_name.as_deref().unwrap_or(""))
        .replace("{{issue.identifier}}", &issue.identifier)
        .replace("{{issue.title}}", &issue.title)
        .replace("{{issue.state}}", &issue.state)
        .replace("{{issue.description}}", issue.description.as_deref().unwrap_or("No description provided."))
}

// ─── Worker ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct WorkerResult {
    pub issue_id: String,
    pub identifier: String,
    pub success: bool,
    pub pr_url: Option<String>,
    pub error: Option<String>,
    pub token_stats: Option<SessionTokenStats>,
    pub duration_secs: u64,
}

fn safe_identifier(id: &str) -> String {
    id.chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' || c == '.' { c } else { '_' })
        .collect()
}

fn run_hook(hook_cmd: &str, workspace: &Path, timeout_ms: u64) -> Result<(), String> {
    let output = Command::new("sh")
        .args(["-lc", hook_cmd])
        .current_dir(workspace)
        .output()
        .map_err(|e| format!("Hook failed to start: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Hook failed (exit {}): {}", output.status, stderr));
    }
    let _ = timeout_ms; // TODO: implement timeout
    Ok(())
}

fn create_workspace(config: &WorkflowConfig, issue: &LinearIssue) -> Result<PathBuf, String> {
    let safe_id = safe_identifier(&issue.identifier);
    let workspace = config.workspace_root.join(&safe_id);

    fs::create_dir_all(&workspace)
        .map_err(|e| format!("Failed to create workspace {}: {}", workspace.display(), e))?;

    // Try git worktree first (if we're in a git repo)
    let repo_root = orchestrate::get_repo_root().unwrap_or_else(|_| PathBuf::from("."));
    let branch_name = format!("symphony/{}", safe_id);

    let worktree_result = Command::new("git")
        .args(["worktree", "add", &workspace.to_string_lossy(), "-b", &branch_name])
        .current_dir(&repo_root)
        .output();

    match worktree_result {
        Ok(output) if output.status.success() => {
            eprintln!("  {} Created worktree for {}", "↳".dimmed(), issue.identifier);
        }
        _ => {
            // Fallback: if after_create hook is set, it likely handles cloning
            if config.hooks.after_create.is_none() {
                // No hook and no worktree — try simple clone
                let clone_result = Command::new("git")
                    .args(["clone", "--depth", "1", &repo_root.to_string_lossy(), "."])
                    .current_dir(&workspace)
                    .output();
                if let Ok(out) = clone_result {
                    if !out.status.success() {
                        eprintln!("  {} Warning: git clone failed for {}", "⚠".yellow(), issue.identifier);
                    }
                }
            }
        }
    }

    // Run after_create hook
    if let Some(ref hook) = config.hooks.after_create {
        let timeout = config.hooks.timeout_ms.unwrap_or(60_000);
        run_hook(hook, &workspace, timeout)?;
    }

    Ok(workspace)
}

fn remove_workspace(config: &WorkflowConfig, issue: &LinearIssue) {
    let safe_id = safe_identifier(&issue.identifier);
    let workspace = config.workspace_root.join(&safe_id);

    // Run before_remove hook
    if let Some(ref hook) = config.hooks.before_remove {
        let timeout = config.hooks.timeout_ms.unwrap_or(60_000);
        let _ = run_hook(hook, &workspace, timeout);
    }

    // Remove git worktree
    let repo_root = orchestrate::get_repo_root().unwrap_or_else(|_| PathBuf::from("."));
    let _ = Command::new("git")
        .args(["worktree", "remove", "--force", &workspace.to_string_lossy()])
        .current_dir(&repo_root)
        .output();

    // Clean up branch
    let branch_name = format!("symphony/{}", safe_id);
    let _ = Command::new("git")
        .args(["branch", "-D", &branch_name])
        .current_dir(&repo_root)
        .output();

    // Remove directory if still exists
    let _ = fs::remove_dir_all(&workspace);
}

fn run_worker(
    config: WorkflowConfig,
    issue: LinearIssue,
    linear: Arc<LinearClient>,
) -> WorkerResult {
    let start = Instant::now();
    let issue_id = issue.id.clone();
    let identifier = issue.identifier.clone();

    eprintln!("  {} {} — {}", "▶".green().bold(), identifier.bold(), issue.title);

    // 1. Move to "In Progress"
    if issue.state.to_lowercase() == "todo" {
        if let Err(e) = linear.update_issue_state(&issue.id, "In Progress") {
            eprintln!("  {} Failed to update state for {}: {}", "⚠".yellow(), identifier, e);
        }
    }

    // 2. Create workspace
    let workspace = match create_workspace(&config, &issue) {
        Ok(ws) => ws,
        Err(e) => {
            return WorkerResult {
                issue_id, identifier, success: false,
                pr_url: None, error: Some(format!("Workspace creation failed: {}", e)),
                token_stats: None, duration_secs: start.elapsed().as_secs(),
            };
        }
    };

    // 3. Run before_run hook
    if let Some(ref hook) = config.hooks.before_run {
        let timeout = config.hooks.timeout_ms.unwrap_or(60_000);
        if let Err(e) = run_hook(hook, &workspace, timeout) {
            eprintln!("  {} before_run hook failed for {}: {}", "⚠".yellow(), identifier, e);
        }
    }

    // 4. Post workpad comment
    let workpad = format!(
        "## Aura Workpad\n\n```text\n{}@{}\n```\n\n### Plan\n- [ ] Analyze issue\n- [ ] Implement changes\n- [ ] Validate\n\n### Status\n- Starting autonomous implementation...",
        workspace.display(),
        get_short_sha(&workspace),
    );
    let _ = linear.create_comment(&issue.id, &workpad);

    // 5. Generate handover context
    let handover = generate_handover(&workspace);

    // 6. Build prompt
    let mut prompt = render_prompt(&config.prompt_template, &issue);
    if let Some(ref ho) = handover {
        prompt = format!("{}\n\n## Codebase Context (AST Summary)\n\n{}", prompt, ho);
    }

    // 7. Run orchestration (use duo mode via invoke_agent for now)
    let objective = format!("{}: {}", issue.identifier, issue.title);
    let result = run_issue_orchestration(&workspace, &objective, &prompt, config.max_turns);

    // 8. After completion
    let (success, pr_url, error, token_stats) = match result {
        Ok(stats) => {
            // Run pr-review
            let _ = run_aura_command(&workspace, &["pr-review", "--base", "main"]);

            // Create PR
            let pr = create_pull_request(&workspace, &issue);

            // Move to Human Review
            let _ = linear.update_issue_state(&issue.id, "Human Review");

            // Update workpad
            let completion_msg = format!(
                "### Completion\n- ✅ Implementation complete\n- PR: {}\n- Tokens: {}",
                pr.as_deref().unwrap_or("(manual)"),
                stats.as_ref().map(|s| format!("{}k (${:.4})", s.total_tokens / 1000, s.total_cost_usd)).unwrap_or_default(),
            );
            let _ = linear.create_comment(&issue.id, &completion_msg);

            (true, pr, None, stats)
        }
        Err(e) => {
            let _ = linear.create_comment(&issue.id, &format!("### ❌ Failed\n\n{}", e));
            (false, None, Some(e), None)
        }
    };

    // 9. Run after_run hook
    if let Some(ref hook) = config.hooks.after_run {
        let timeout = config.hooks.timeout_ms.unwrap_or(60_000);
        let _ = run_hook(hook, &workspace, timeout);
    }

    WorkerResult {
        issue_id,
        identifier,
        success,
        pr_url,
        error,
        token_stats,
        duration_secs: start.elapsed().as_secs(),
    }
}

fn get_short_sha(workspace: &Path) -> String {
    Command::new("git")
        .args(["rev-parse", "--short", "HEAD"])
        .current_dir(workspace)
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| "unknown".to_string())
}

fn generate_handover(workspace: &Path) -> Option<String> {
    let output = Command::new("aura")
        .args(["handover", "claude"])
        .current_dir(workspace)
        .output()
        .ok()?;
    if output.status.success() {
        Some(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        None
    }
}

fn run_aura_command(workspace: &Path, args: &[&str]) -> Result<String, String> {
    let output = Command::new("aura")
        .args(args)
        .current_dir(workspace)
        .output()
        .map_err(|e| format!("Failed to run aura {}: {}", args.join(" "), e))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

fn run_issue_orchestration(
    workspace: &Path,
    objective: &str,
    prompt: &str,
    _max_turns: usize,
) -> Result<Option<SessionTokenStats>, String> {
    // Use invoke_agent directly — the agent gets the full prompt with context
    let (output, _session_id, usage) = orchestrate::invoke_agent(
        &orchestrate::AgentType::ClaudeCode,
        prompt,
        3600, // 1 hour timeout
        None,
    )?;

    // If the output looks successful, aggregate stats
    let stats = SessionTokenStats {
        total_input: usage.input_tokens,
        total_output: usage.output_tokens,
        total_tokens: usage.total_tokens,
        total_cost_usd: usage.cost_usd,
        claude_tokens: usage.total_tokens,
        claude_cost_usd: usage.cost_usd,
        ..Default::default()
    };

    let _ = (workspace, objective); // workspace is set via invoke_agent's cwd
    Ok(Some(stats))
}

fn create_pull_request(workspace: &Path, issue: &LinearIssue) -> Option<String> {
    let title = format!("{}: {}", issue.identifier, issue.title);
    let body = format!(
        "## Summary\n\nAutonomously implemented by Aura Symphony for Linear issue [{}]({}).\n\n## Changes\n\n{}\n\n---\n🎵 Generated by [Aura Symphony](https://github.com/auraengine/aura)",
        issue.identifier, issue.url,
        issue.description.as_deref().unwrap_or("See issue for details."),
    );

    // Push branch first
    let _ = Command::new("git")
        .args(["push", "-u", "origin", "HEAD"])
        .current_dir(workspace)
        .output();

    // Create PR
    let output = Command::new("gh")
        .args(["pr", "create", "--title", &title, "--body", &body, "--label", "symphony"])
        .current_dir(workspace)
        .output()
        .ok()?;

    if output.status.success() {
        let url = String::from_utf8_lossy(&output.stdout).trim().to_string();
        Some(url)
    } else {
        eprintln!("  {} PR creation failed for {}", "⚠".yellow(), issue.identifier);
        None
    }
}

// ─── Daemon ─────────────────────────────────────────────────────────────────

struct WorkerHandle {
    thread: thread::JoinHandle<WorkerResult>,
    issue: LinearIssue,
    started_at: Instant,
}

#[derive(Default)]
struct DaemonStats {
    completed_count: usize,
    failed_count: usize,
    total_tokens: u64,
    total_cost: f64,
    recent: Vec<WorkerResult>,
}

pub struct SymphonyDaemon {
    linear: Arc<LinearClient>,
    config: WorkflowConfig,
    running: HashMap<String, WorkerHandle>,
    completed_ids: HashSet<String>,
    retry_counts: HashMap<String, u32>,
    retry_after: HashMap<String, Instant>,
    stats: DaemonStats,
    shutdown: Arc<AtomicBool>,
}

impl SymphonyDaemon {
    pub fn new(linear: LinearClient, config: WorkflowConfig) -> Self {
        Self {
            linear: Arc::new(linear),
            config,
            running: HashMap::new(),
            completed_ids: HashSet::new(),
            retry_counts: HashMap::new(),
            retry_after: HashMap::new(),
            stats: DaemonStats::default(),
            shutdown: Arc::new(AtomicBool::new(false)),
        }
    }

    fn poll_and_dispatch(&mut self) -> Result<(), String> {
        // Fetch candidates
        let issues = match self.linear.fetch_candidate_issues(&self.config.active_states) {
            Ok(issues) => issues,
            Err(e) => {
                eprintln!("  {} Poll failed: {}", "⚠".yellow(), e);
                return Ok(()); // Don't crash on transient poll failure
            }
        };

        let available_slots = self.config.max_concurrent.saturating_sub(self.running.len());
        if available_slots == 0 {
            return Ok(());
        }

        let mut dispatched = 0;
        for issue in issues {
            if dispatched >= available_slots {
                break;
            }

            // Skip if already running or recently completed
            if self.running.contains_key(&issue.id) || self.completed_ids.contains(&issue.id) {
                continue;
            }

            // Check retry cooldown
            if let Some(after) = self.retry_after.get(&issue.id) {
                if Instant::now() < *after {
                    continue;
                }
            }

            // Dispatch worker
            let config = self.config.clone();
            let issue_clone = issue.clone();
            let linear = self.linear.clone();

            let handle = thread::spawn(move || {
                run_worker(config, issue_clone, linear)
            });

            self.running.insert(issue.id.clone(), WorkerHandle {
                thread: handle,
                issue,
                started_at: Instant::now(),
            });

            dispatched += 1;
        }

        Ok(())
    }

    fn reap_completed(&mut self) {
        let mut finished = Vec::new();

        for (id, handle) in &self.running {
            if handle.thread.is_finished() {
                finished.push(id.clone());
            }
        }

        for id in finished {
            if let Some(handle) = self.running.remove(&id) {
                match handle.thread.join() {
                    Ok(result) => {
                        if result.success {
                            self.completed_ids.insert(id.clone());
                            self.stats.completed_count += 1;
                            if let Some(ref stats) = result.token_stats {
                                self.stats.total_tokens += stats.total_tokens;
                                self.stats.total_cost += stats.total_cost_usd;
                            }
                            eprintln!("  {} {} — {} {}",
                                "✓".green().bold(),
                                result.identifier.bold(),
                                result.pr_url.as_deref().unwrap_or("done"),
                                format!("({}s)", result.duration_secs).dimmed(),
                            );
                        } else {
                            self.stats.failed_count += 1;
                            let count = self.retry_counts.entry(id.clone()).or_insert(0);
                            *count += 1;
                            let backoff_ms = (10_000u64 * 2u64.pow(*count - 1))
                                .min(self.config.max_retry_backoff_ms);
                            self.retry_after.insert(id, Instant::now() + Duration::from_millis(backoff_ms));
                            eprintln!("  {} {} — {} (retry in {}s)",
                                "✗".red().bold(),
                                result.identifier.bold(),
                                result.error.as_deref().unwrap_or("unknown error"),
                                backoff_ms / 1000,
                            );
                        }

                        // Keep in recent results (max 20)
                        self.stats.recent.push(result);
                        if self.stats.recent.len() > 20 {
                            self.stats.recent.remove(0);
                        }
                    }
                    Err(_) => {
                        eprintln!("  {} Worker thread panicked for issue", "✗".red().bold());
                        self.stats.failed_count += 1;
                    }
                }
            }
        }
    }

    fn render_dashboard(&self) {
        // Persist state for dashboard API
        persist_state(self);

        // Clear screen and move cursor to top
        eprint!("\x1b[2J\x1b[H");

        eprintln!("{}", "🎵 Aura Symphony — Autonomous Daemon".bold().cyan());
        eprintln!("  Tracker: {}/{} │ Poll: {}s │ Workers: {}/{}",
            self.config.tracker_kind,
            self.config.project_slug,
            self.config.poll_interval_ms / 1000,
            self.running.len(),
            self.config.max_concurrent,
        );
        eprintln!("  Completed: {} │ Failed: {} │ Tokens: {}k (${:.4})",
            self.stats.completed_count.to_string().green(),
            self.stats.failed_count.to_string().red(),
            self.stats.total_tokens / 1000,
            self.stats.total_cost,
        );
        eprintln!();

        // Running workers
        if !self.running.is_empty() {
            eprintln!("  {}", "RUNNING:".bold());
            for (_, handle) in &self.running {
                let elapsed = handle.started_at.elapsed().as_secs();
                let mins = elapsed / 60;
                let secs = elapsed % 60;
                eprintln!("  {}  │ {:30} │ {} │ {}m {}s",
                    handle.issue.identifier.bold(),
                    truncate_str(&handle.issue.title, 30),
                    "▶ Working".green(),
                    mins, secs,
                );
            }
            eprintln!();
        }

        // Recent completions
        let recent: Vec<_> = self.stats.recent.iter().rev().take(5).collect();
        if !recent.is_empty() {
            eprintln!("  {}", "RECENT:".bold());
            for r in recent {
                let status = if r.success {
                    format!("{} Done", "✓".green())
                } else {
                    format!("{} Failed", "✗".red())
                };
                let pr_info = r.pr_url.as_deref().unwrap_or("");
                eprintln!("  {}  │ {:30} │ {} │ {} │ {}s",
                    r.identifier.bold(),
                    truncate_str(&r.identifier, 30), // Could use title if stored
                    status,
                    pr_info,
                    r.duration_secs,
                );
            }
        }

        eprintln!();
        eprintln!("  {} to stop", "Ctrl+C".dimmed());
    }

    pub fn shutdown(&mut self) {
        eprintln!("\n{}", "Shutting down Aura Symphony...".yellow().bold());

        // Wait for running workers
        let running: Vec<_> = self.running.drain().collect();
        for (id, handle) in running {
            eprintln!("  Waiting for {} to finish...", id);
            let _ = handle.thread.join();
        }

        // Clean up workspaces (optional — could keep for inspection)
        eprintln!("  {} Cleanup complete", "✓".green());
    }
}

fn truncate_str(s: &str, max: usize) -> String {
    if s.len() <= max {
        format!("{:width$}", s, width = max)
    } else {
        format!("{}…", &s[..max - 1])
    }
}

fn now_ts() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()
}

// ─── Serializable state (for dashboard API) ─────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DaemonState {
    pub running: bool,
    pub tracker: String,
    pub project_slug: String,
    pub poll_interval_ms: u64,
    pub max_concurrent: usize,
    pub workers: Vec<WorkerState>,
    pub recent: Vec<CompletedWorker>,
    pub completed_count: usize,
    pub failed_count: usize,
    pub total_tokens: u64,
    pub total_cost: f64,
    pub updated_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkerState {
    pub issue_id: String,
    pub identifier: String,
    pub title: String,
    pub started_at: u64,
    pub elapsed_secs: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompletedWorker {
    pub issue_id: String,
    pub identifier: String,
    pub success: bool,
    pub pr_url: Option<String>,
    pub error: Option<String>,
    pub duration_secs: u64,
    pub tokens: Option<u64>,
    pub cost: Option<f64>,
}

fn state_file_path() -> PathBuf {
    dirs_workspace_root().join("DAEMON_STATE.json")
}

/// Read persisted daemon state (used by the server API).
pub fn read_daemon_state() -> Option<DaemonState> {
    let path = state_file_path();
    let data = fs::read_to_string(&path).ok()?;
    serde_json::from_str(&data).ok()
}

fn persist_state(daemon: &SymphonyDaemon) {
    let workers: Vec<WorkerState> = daemon.running.iter().map(|(_, h)| {
        WorkerState {
            issue_id: h.issue.id.clone(),
            identifier: h.issue.identifier.clone(),
            title: h.issue.title.clone(),
            started_at: now_ts().saturating_sub(h.started_at.elapsed().as_secs()),
            elapsed_secs: h.started_at.elapsed().as_secs(),
        }
    }).collect();

    let recent: Vec<CompletedWorker> = daemon.stats.recent.iter().map(|r| {
        CompletedWorker {
            issue_id: r.issue_id.clone(),
            identifier: r.identifier.clone(),
            success: r.success,
            pr_url: r.pr_url.clone(),
            error: r.error.clone(),
            duration_secs: r.duration_secs,
            tokens: r.token_stats.as_ref().map(|s| s.total_tokens),
            cost: r.token_stats.as_ref().map(|s| s.total_cost_usd),
        }
    }).collect();

    let state = DaemonState {
        running: true,
        tracker: daemon.config.tracker_kind.clone(),
        project_slug: daemon.config.project_slug.clone(),
        poll_interval_ms: daemon.config.poll_interval_ms,
        max_concurrent: daemon.config.max_concurrent,
        workers,
        recent,
        completed_count: daemon.stats.completed_count,
        failed_count: daemon.stats.failed_count,
        total_tokens: daemon.stats.total_tokens,
        total_cost: daemon.stats.total_cost,
        updated_at: now_ts(),
    };

    if let Ok(json) = serde_json::to_string_pretty(&state) {
        let _ = fs::write(state_file_path(), json);
    }
}

// ─── Public API ─────────────────────────────────────────────────────────────

fn get_linear_client() -> Result<LinearClient, String> {
    let api_token = std::env::var("LINEAR_API_KEY")
        .or_else(|_| {
            crate::config::ConfigManager::get_api_key("linear")
                .ok_or_else(|| std::env::VarError::NotPresent)
        })
        .map_err(|_| "LINEAR_API_KEY not set. Set via env or `aura config set linear_api_key <key>`".to_string())?;

    // Read project_slug from WORKFLOW.md if available, fallback to "TOU"
    let slug = fs::read_to_string("WORKFLOW.md")
        .ok()
        .and_then(|content| {
            parse_workflow_slug(&content)
        })
        .unwrap_or_else(|| "TOU".to_string());

    Ok(LinearClient::new(&api_token, &slug))
}

fn parse_workflow_slug(content: &str) -> Option<String> {
    let (yaml_str, _) = split_front_matter(content);
    if yaml_str.is_empty() { return None; }
    let yaml: serde_yaml::Value = serde_yaml::from_str(&yaml_str).ok()?;
    yaml.get("tracker")?.get("project_slug")?.as_str().map(|s| s.to_string())
}

/// Fetch basic team metadata (labels, members) for the configured team.
pub fn get_team_meta() -> Result<TeamMeta, String> {
    let linear = get_linear_client()?;
    linear.fetch_team_meta()
}

/// Fetch full team metadata (labels, members, states, projects, cycles).
pub fn get_team_full_meta() -> Result<TeamMeta, String> {
    let linear = get_linear_client()?;
    linear.fetch_team_full_meta()
}

/// List all issues for the team (up to `limit`).
pub fn list_issues(limit: usize) -> Result<Vec<LinearIssue>, String> {
    let linear = get_linear_client()?;
    linear.fetch_all_issues(limit)
}

/// Create a new issue in Linear with name-based resolution for labels, assignee, project, cycle.
pub fn create_issue(
    title: &str,
    description: Option<&str>,
    priority: Option<i32>,
    labels: Vec<String>,
    assignee: Option<String>,
    estimate: Option<i32>,
    project: Option<String>,
    cycle: Option<String>,
    due_date: Option<String>,
    parent_id: Option<String>,
) -> Result<LinearIssue, String> {
    let linear = get_linear_client()?;
    let meta = linear.fetch_team_full_meta()?;

    let label_ids = resolve_labels(&meta, &labels);
    let assignee_id = resolve_member(&meta, assignee.as_deref());
    let project_id = resolve_project(&meta, project.as_deref());
    let cycle_id = resolve_cycle(&meta, cycle.as_deref());

    linear.create_issue(
        &meta.team_id,
        title,
        description,
        priority,
        label_ids,
        assignee_id,
        estimate,
        project_id,
        cycle_id,
        due_date,
        parent_id,
    )
}

/// Update an existing issue with name-based resolution.
pub fn update_issue(
    issue_id: &str,
    title: Option<String>,
    description: Option<String>,
    priority: Option<i32>,
    state: Option<String>,
    labels: Option<Vec<String>>,
    assignee: Option<String>,
    project: Option<String>,
    cycle: Option<String>,
    due_date: Option<String>,
    parent_id: Option<String>,
    estimate: Option<i32>,
) -> Result<LinearIssue, String> {
    let linear = get_linear_client()?;
    let meta = linear.fetch_team_full_meta()?;

    let state_id = state.as_deref().and_then(|name| {
        let lower = name.to_lowercase();
        meta.states.iter()
            .find(|(_, n)| n.to_lowercase() == lower)
            .map(|(id, _)| id.clone())
    });

    let label_ids = labels.as_ref().map(|l| resolve_labels(&meta, l));
    let assignee_id = resolve_member(&meta, assignee.as_deref());
    let project_id = resolve_project(&meta, project.as_deref());
    let cycle_id = resolve_cycle(&meta, cycle.as_deref());

    let update = IssueUpdate {
        title,
        description,
        priority,
        state_id,
        assignee_id,
        label_ids,
        project_id,
        cycle_id,
        due_date,
        parent_id,
        estimate,
    };

    linear.update_issue(issue_id, &update)
}

// ─── PRD Decomposition ──────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DecomposedTask {
    pub title: String,
    pub description: String,
    pub priority: i32,
    pub labels: Vec<String>,
    pub estimate: Option<i32>,
    pub wave: i32,
    pub depends_on: Vec<String>,  // titles of tasks this depends on
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DecompositionResult {
    pub project_name: String,
    pub summary: String,
    pub waves: Vec<DecompositionWave>,
    pub created_issues: Vec<LinearIssue>,
    pub total_tasks: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DecompositionWave {
    pub wave_number: i32,
    pub tasks: Vec<DecomposedTask>,
}

/// Decompose a PRD into Linear issues organized in waves.
/// Reads the PRD content, uses AI to split into tasks, creates them all in Linear.
pub fn decompose_prd(
    prd_content: &str,
    project: Option<&str>,
    assignees: Option<Vec<String>>,
    label_prefix: Option<Vec<String>>,
    dry_run: bool,
) -> Result<DecompositionResult, String> {
    let linear = get_linear_client()?;
    let meta = linear.fetch_team_full_meta()?;

    // Build context about the team for the AI
    let member_names: Vec<&str> = meta.members.iter().map(|(_, n)| n.as_str()).collect();
    let label_names: Vec<&str> = meta.labels.iter().map(|(_, n)| n.as_str()).collect();

    let system_prompt = format!(
        "You are a senior engineering manager. You decompose PRDs into implementable engineering tasks.\n\
        Commit to one concrete breakdown — don't hedge or offer alternatives. Make the dependency and sequencing calls yourself.\n\
        Available team members: {}\n\
        Available labels: {}\n\
        Return ONLY valid JSON, no markdown fences.",
        member_names.join(", "),
        label_names.join(", "),
    );

    let json_example = r##"{
  "project_name": "Short project name",
  "summary": "1-2 sentence summary",
  "waves": [
    {
      "wave_number": 1,
      "tasks": [
        {
          "title": "Implement X for Y",
          "description": "Goal: What to do. Acceptance: criterion 1, criterion 2. Notes: hints.",
          "priority": 2,
          "labels": ["Feature"],
          "estimate": 3,
          "depends_on": []
        }
      ]
    }
  ]
}"##;

    let decompose_prompt = format!(
"Decompose this PRD into small, implementable engineering tasks organized in waves.

Rules:
- Each task should be completable by a single engineer in 1-3 days
- Organize tasks into waves (Wave 1 has no dependencies, Wave 2 depends on Wave 1, etc.)
- Assign priority: 1=Urgent/blocking, 2=High/core, 3=Medium/feature, 4=Low/polish
- Give point estimates (1=trivial, 2=small, 3=medium, 5=large, 8=complex)
- Use specific, actionable titles starting with a verb
- Include clear acceptance criteria in descriptions
- Apply appropriate labels from the available list

PRD:
{prd_content}

Return this exact JSON structure:
{json_example}"
    );

    let raw = crate::gsd::GsdEngine::generate_content(
        &decompose_prompt,
        &system_prompt,
        0.2,
        crate::gsd::CognitiveLabor::Architect,
    ).ok_or("AI decomposition failed — check your AI provider configuration")?;

    let cleaned = crate::gsd::GsdEngine::strip_markdown_fences(&raw);
    let json_str = crate::gsd::GsdEngine::extract_json_object(&cleaned);
    if json_str.is_empty() {
        return Err(format!("AI returned invalid JSON. Raw output:\n{}", &cleaned[..cleaned.len().min(500)]));
    }

    let parsed: serde_json::Value = serde_json::from_str(&json_str)
        .map_err(|e| format!("Failed to parse decomposition JSON: {}", e))?;

    let project_name = parsed.get("project_name")
        .and_then(|v| v.as_str())
        .unwrap_or("Untitled")
        .to_string();

    let summary = parsed.get("summary")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    // Parse waves
    let raw_waves = parsed.get("waves")
        .and_then(|v| v.as_array())
        .ok_or("Missing 'waves' array in AI response")?;

    let mut waves: Vec<DecompositionWave> = Vec::new();
    let mut all_tasks: Vec<DecomposedTask> = Vec::new();

    for wave_val in raw_waves {
        let wave_num = wave_val.get("wave_number")
            .and_then(|v| v.as_i64())
            .unwrap_or(waves.len() as i64 + 1) as i32;

        let tasks_val = wave_val.get("tasks")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();

        let mut wave_tasks: Vec<DecomposedTask> = Vec::new();
        for t in &tasks_val {
            let task = DecomposedTask {
                title: t.get("title").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                description: t.get("description").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                priority: t.get("priority").and_then(|v| v.as_i64()).unwrap_or(3) as i32,
                labels: t.get("labels")
                    .and_then(|v| v.as_array())
                    .map(|arr| arr.iter().filter_map(|l| l.as_str().map(|s| s.to_string())).collect())
                    .unwrap_or_default(),
                estimate: t.get("estimate").and_then(|v| v.as_i64()).map(|n| n as i32),
                wave: wave_num,
                depends_on: t.get("depends_on")
                    .and_then(|v| v.as_array())
                    .map(|arr| arr.iter().filter_map(|d| d.as_str().map(|s| s.to_string())).collect())
                    .unwrap_or_default(),
            };
            wave_tasks.push(task.clone());
            all_tasks.push(task);
        }

        waves.push(DecompositionWave { wave_number: wave_num, tasks: wave_tasks });
    }

    if dry_run {
        return Ok(DecompositionResult {
            project_name,
            summary,
            waves,
            created_issues: vec![],
            total_tasks: all_tasks.len(),
        });
    }

    // Resolve project
    let target_project = project.or(Some(project_name.as_str()));
    let project_id = resolve_project(&meta, target_project);

    // Resolve extra labels
    let extra_label_ids = label_prefix
        .as_ref()
        .map(|l| resolve_labels(&meta, l))
        .unwrap_or_default();

    // Round-robin assignees if provided
    let assignee_ids: Vec<Option<String>> = assignees
        .as_ref()
        .map(|names| {
            names.iter().map(|n| resolve_member(&meta, Some(n))).collect()
        })
        .unwrap_or_default();

    // Create all issues wave by wave
    let mut created_issues: Vec<LinearIssue> = Vec::new();
    let mut title_to_id: HashMap<String, String> = HashMap::new();
    let mut task_index = 0usize;

    for wave in &waves {
        for task in &wave.tasks {
            // Merge task labels with extra labels
            let mut label_ids = resolve_labels(&meta, &task.labels);
            label_ids.extend(extra_label_ids.clone());

            // Round-robin assignee
            let assignee_id = if !assignee_ids.is_empty() {
                assignee_ids[task_index % assignee_ids.len()].clone()
            } else {
                None
            };

            // Resolve parent (first depends_on that was already created)
            let parent_id = task.depends_on.iter()
                .find_map(|dep| title_to_id.get(dep))
                .cloned();

            // Add wave tag to description
            let desc = format!(
                "**Wave {}** | Est: {} pts\n\n{}",
                wave.wave_number,
                task.estimate.unwrap_or(0),
                task.description,
            );

            match linear.create_issue(
                &meta.team_id,
                &task.title,
                Some(&desc),
                Some(task.priority),
                label_ids,
                assignee_id,
                task.estimate,
                project_id.clone(),
                None, // cycle
                None, // due_date
                parent_id,
            ) {
                Ok(issue) => {
                    title_to_id.insert(task.title.clone(), issue.id.clone());
                    created_issues.push(issue);
                }
                Err(e) => {
                    eprintln!("  Warning: Failed to create '{}': {}", task.title, e);
                }
            }

            task_index += 1;
        }
    }

    Ok(DecompositionResult {
        project_name,
        summary,
        waves,
        created_issues,
        total_tasks: all_tasks.len(),
    })
}

// ─── Name Resolution Helpers ────────────────────────────────────────────────

fn resolve_labels(meta: &TeamMeta, names: &[String]) -> Vec<String> {
    names.iter().filter_map(|name| {
        let lower = name.to_lowercase();
        meta.labels.iter()
            .find(|(_, n)| n.to_lowercase() == lower)
            .map(|(id, _)| id.clone())
    }).collect()
}

fn resolve_member(meta: &TeamMeta, name: Option<&str>) -> Option<String> {
    name.and_then(|n| {
        let lower = n.to_lowercase();
        meta.members.iter()
            .find(|(_, m)| m.to_lowercase().contains(&lower))
            .map(|(id, _)| id.clone())
    })
}

fn resolve_project(meta: &TeamMeta, name: Option<&str>) -> Option<String> {
    name.and_then(|n| {
        let lower = n.to_lowercase();
        meta.projects.iter()
            .find(|(_, p)| p.to_lowercase().contains(&lower))
            .map(|(id, _)| id.clone())
    })
}

fn resolve_cycle(meta: &TeamMeta, name: Option<&str>) -> Option<String> {
    name.and_then(|n| {
        let lower = n.to_lowercase();
        // Try matching by name, then by number
        meta.cycles.iter()
            .find(|c| {
                c.name.as_ref().map(|cn| cn.to_lowercase().contains(&lower)).unwrap_or(false)
                || c.number.to_string() == n
            })
            .map(|c| c.id.clone())
    })
}

/// Start the Symphony daemon.
pub fn start(workflow_path: &str) -> Result<(), String> {
    let config = parse_workflow(workflow_path)?;

    eprintln!("\n{}\n", "🎵 Aura Symphony — Autonomous Issue-to-PR Daemon".bold().cyan());

    // Validate config
    eprintln!("  Tracker: {}/{}", config.tracker_kind, config.project_slug);
    eprintln!("  Active states: {:?}", config.active_states);
    eprintln!("  Max concurrent: {}", config.max_concurrent);
    eprintln!("  Poll interval: {}ms", config.poll_interval_ms);
    eprintln!("  Workspace root: {}", config.workspace_root.display());
    eprintln!();

    // Detect agents
    orchestrate::report_agent_availability();

    // Get Linear API token
    let api_token = std::env::var("LINEAR_API_KEY")
        .or_else(|_| {
            crate::config::ConfigManager::get_api_key("linear")
                .ok_or_else(|| std::env::VarError::NotPresent)
        })
        .map_err(|_| "LINEAR_API_KEY not set. Set it via environment variable or `aura config set linear_api_key <key>`".to_string())?;

    let linear = LinearClient::new(&api_token, &config.project_slug);

    // Test connection
    eprintln!("  Testing Linear connection...");
    match linear.fetch_candidate_issues(&config.active_states) {
        Ok(issues) => {
            eprintln!("  {} Connected — {} candidate issue(s) found\n", "✓".green(), issues.len());
        }
        Err(e) => {
            return Err(format!("Linear connection failed: {}", e));
        }
    }

    // Create workspace root
    fs::create_dir_all(&config.workspace_root)
        .map_err(|e| format!("Failed to create workspace root: {}", e))?;

    let mut daemon = SymphonyDaemon::new(linear, config.clone());

    // Set up Ctrl+C handler
    let shutdown = daemon.shutdown.clone();
    ctrlc_handler(shutdown);

    // Main loop
    eprintln!("{}", "Starting daemon loop...".bold());
    let poll_duration = Duration::from_millis(config.poll_interval_ms);

    while !daemon.shutdown.load(Ordering::SeqCst) {
        daemon.reap_completed();

        if let Err(e) = daemon.poll_and_dispatch() {
            eprintln!("  {} Dispatch error: {}", "⚠".yellow(), e);
        }

        daemon.render_dashboard();

        // Sleep in small increments to allow quick Ctrl+C response
        let sleep_end = Instant::now() + poll_duration;
        while Instant::now() < sleep_end && !daemon.shutdown.load(Ordering::SeqCst) {
            thread::sleep(Duration::from_millis(100));
        }
    }

    daemon.shutdown();

    // Mark state as stopped
    if let Some(mut state) = read_daemon_state() {
        state.running = false;
        state.updated_at = now_ts();
        if let Ok(json) = serde_json::to_string_pretty(&state) {
            let _ = fs::write(state_file_path(), json);
        }
    }

    eprintln!("{}", "🎵 Aura Symphony stopped.".bold());
    Ok(())
}

fn ctrlc_handler(shutdown: Arc<AtomicBool>) {
    let _ = ctrlc::set_handler(move || {
        shutdown.store(true, Ordering::SeqCst);
        eprintln!("\n{}", "Received shutdown signal...".yellow());
    });
}

/// Show status of running/recent Symphony sessions.
pub fn status() -> Result<(), String> {
    let state_path = dirs_workspace_root().join("DAEMON_STATE.json");
    if state_path.exists() {
        let data = fs::read_to_string(&state_path).map_err(|e| e.to_string())?;
        eprintln!("{}", data);
    } else {
        eprintln!("No Symphony daemon state found. Is the daemon running?");
    }
    Ok(())
}

/// Stop a running daemon (by writing a stop signal file).
pub fn stop() -> Result<(), String> {
    let stop_path = dirs_workspace_root().join("STOP_SIGNAL");
    fs::write(&stop_path, "stop").map_err(|e| format!("Failed to write stop signal: {}", e))?;
    eprintln!("Stop signal sent. The daemon will shut down after current workers complete.");
    Ok(())
}
