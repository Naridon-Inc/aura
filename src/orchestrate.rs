use aura_agents::{InvokeMode, InvokeRequest, registry};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

/// Stable id under which an `AgentType` is looked up in the
/// `aura-agents` registry. Saved orchestration JSON keeps using the
/// snake_case enum names for back-compat — this maps those to the
/// runtime registry keys.
fn agent_provider_id(agent: &AgentType) -> &'static str {
    match agent {
        AgentType::ClaudeCode => "claude",
        AgentType::GeminiCli => "gemini",
    }
}

// ─── Data Structures ────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum AgentType {
    ClaudeCode,
    GeminiCli,
}

impl std::fmt::Display for AgentType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AgentType::ClaudeCode => write!(f, "Claude Code"),
            AgentType::GeminiCli => write!(f, "Gemini CLI"),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AssignmentStrategy {
    RoundRobin,
    Smart,
    Manual(Vec<AgentType>),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum WaveStatus {
    Pending,
    Running,
    Validating,
    Passed,
    Failed,
    Retrying,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum OrchestrationStatus {
    Planning,
    Running,
    Paused,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrchestrateWave {
    pub id: usize,
    pub action: String,
    pub files: Vec<String>,
    pub functions: Vec<String>,
    pub verify: String,
    pub assigned_agent: AgentType,
    pub status: WaveStatus,
    pub logs: String,
    pub review_summary: Option<String>,
    pub risk_score: Option<f64>,
    pub started_at: Option<u64>,
    pub completed_at: Option<u64>,
    pub retry_count: u32,
    pub git_ref_before: Option<String>,
    #[serde(default)]
    pub usage: Option<TokenUsage>,
}

// ─── Token Usage Tracking ───────────────────────────────────────────────────

// Pricing per 1M tokens (March 2026)
const CLAUDE_INPUT_COST_PER_M: f64 = 3.0;
const CLAUDE_OUTPUT_COST_PER_M: f64 = 15.0;
const GEMINI_INPUT_COST_PER_M: f64 = 1.25;
const GEMINI_OUTPUT_COST_PER_M: f64 = 10.0;

fn estimate_tokens(text: &str) -> u64 {
    // ~3.5 chars per token for code (more accurate than naive /4)
    ((text.len() as f64) / 3.5).ceil() as u64
}

fn calculate_cost(agent: &AgentType, input_tokens: u64, output_tokens: u64) -> f64 {
    // Look up cost in the provider registry first; fall back to the
    // legacy hardcoded constants if the provider doesn't declare a
    // price (or registers as None — then we treat it as zero, since
    // the Cursor agent runs against a flat-fee subscription).
    let (input_per_m, output_per_m) = match registry().get(agent_provider_id(agent)) {
        Some(p) => match p.cost_per_1k() {
            Some(c) => (c.input_usd * 1000.0, c.output_usd * 1000.0),
            None => (0.0, 0.0),
        },
        None => match agent {
            AgentType::ClaudeCode => (CLAUDE_INPUT_COST_PER_M, CLAUDE_OUTPUT_COST_PER_M),
            AgentType::GeminiCli => (GEMINI_INPUT_COST_PER_M, GEMINI_OUTPUT_COST_PER_M),
        },
    };
    (input_tokens as f64 / 1_000_000.0) * input_per_m
        + (output_tokens as f64 / 1_000_000.0) * output_per_m
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TokenUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub total_tokens: u64,
    pub cost_usd: f64,
    #[serde(default)]
    pub saved_by_handover: u64,
    #[serde(default)]
    pub saved_by_resume: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SessionTokenStats {
    pub total_input: u64,
    pub total_output: u64,
    pub total_tokens: u64,
    pub total_cost_usd: f64,
    pub gemini_tokens: u64,
    pub gemini_cost_usd: f64,
    pub claude_tokens: u64,
    pub claude_cost_usd: f64,
    pub tokens_saved_handover: u64,
    pub tokens_saved_resume: u64,
    pub estimated_without_aura: u64,
    pub estimated_cost_without_aura: f64,
    pub savings_pct: f64,
}

/// Estimate the full context size without handover (raw file reading)
fn estimate_full_context_tokens() -> u64 {
    // Count all source files in the repo and estimate their total token size
    let extensions = ["rs", "py", "ts", "tsx", "js", "jsx", "go", "java", "rb", "cpp", "c", "h"];
    let mut total_bytes: u64 = 0;
    let mut file_count: u64 = 0;

    fn walk_dir(dir: &std::path::Path, extensions: &[&str], total: &mut u64, count: &mut u64) {
        if let Ok(entries) = fs::read_dir(dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
                    if !name.starts_with('.') && name != "node_modules" && name != "target" && name != "dist" && name != "build" {
                        walk_dir(&path, extensions, total, count);
                    }
                } else if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                    if extensions.contains(&ext) {
                        if let Ok(meta) = path.metadata() {
                            *total += meta.len();
                            *count += 1;
                        }
                    }
                }
            }
        }
    }

    walk_dir(std::path::Path::new("."), &extensions, &mut total_bytes, &mut file_count);
    // Estimate: each invocation an agent would read ~30-60% of files
    let read_pct = 0.4;
    let estimated_bytes = (total_bytes as f64 * read_pct) as u64;
    estimated_bytes / 4 // bytes to tokens
}

fn print_token_summary(stats: &SessionTokenStats) {
    eprintln!("\n📊 Token Usage Summary:");
    eprintln!("  Input:  {:>8} tokens    Output: {:>8} tokens    Total: {:>8} tokens",
        format_num(stats.total_input), format_num(stats.total_output), format_num(stats.total_tokens));
    eprintln!("  Claude: {:>8} tokens (${:.4})    Gemini: {:>8} tokens (${:.4})",
        format_num(stats.claude_tokens), stats.claude_cost_usd,
        format_num(stats.gemini_tokens), stats.gemini_cost_usd);
    eprintln!("  Total cost: ${:.4}", stats.total_cost_usd);
    eprintln!();
    eprintln!("  Savings:");
    if stats.tokens_saved_handover > 0 {
        let handover_pct = if stats.estimated_without_aura > 0 {
            (stats.tokens_saved_handover as f64 / stats.estimated_without_aura as f64 * 100.0) as u64
        } else { 0 };
        eprintln!("    Handover compression:  -{} tokens saved ({}% reduction)",
            format_num(stats.tokens_saved_handover), handover_pct);
    }
    if stats.tokens_saved_resume > 0 {
        eprintln!("    Session resumption:    -{} tokens saved", format_num(stats.tokens_saved_resume));
    }
    if stats.gemini_tokens > 0 {
        let gemini_as_claude_cost = calculate_cost(&AgentType::ClaudeCode,
            stats.gemini_tokens * 60 / 100, stats.gemini_tokens * 40 / 100);
        let saved = gemini_as_claude_cost - stats.gemini_cost_usd;
        if saved > 0.0 {
            eprintln!("    Gemini routing:        -${:.4} saved (vs all-Claude)", saved);
        }
    }
    eprintln!();
    eprintln!("  Without Aura: ~${:.4}    With Aura: ${:.4}    Saved: {:.0}%",
        stats.estimated_cost_without_aura, stats.total_cost_usd, stats.savings_pct);
}

fn format_num(n: u64) -> String {
    if n >= 1_000_000 {
        format!("{:.1}M", n as f64 / 1_000_000.0)
    } else if n >= 1_000 {
        format!("{:.1}k", n as f64 / 1_000.0)
    } else {
        n.to_string()
    }
}

// ─── Duo Mode Structures ────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum OrchestrateMode {
    Wave,
    Duo,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Pending,
    Running,
    Done,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum RelayType {
    Output,
    Question,
    Answer,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DuoTask {
    pub id: usize,
    pub action: String,
    pub agent: AgentType,
    pub depends_on: Vec<usize>,
    pub status: TaskStatus,
    pub output: String,
    pub relay_summary: Option<String>,
    pub started_at: Option<u64>,
    pub completed_at: Option<u64>,
    pub retry_count: u32,
    #[serde(default)]
    pub usage: Option<TokenUsage>,
    /// Manager-mode short summary (~200 tokens) of this task's output.
    /// Populated post-completion via `aura summarize-task`; consumed by
    /// downstream tasks' prompt builders as relay context.
    #[serde(default)]
    pub summary: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DuoRound {
    pub id: usize,
    pub task_ids: Vec<usize>,
    pub relay_context: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RelayMessage {
    pub from: AgentType,
    pub to: AgentType,
    pub content: String,
    pub round_id: usize,
    pub msg_type: RelayType,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrchestrationSession {
    pub id: String,
    pub objective: String,
    pub strategy: AssignmentStrategy,
    pub status: OrchestrationStatus,
    pub waves: Vec<OrchestrateWave>,
    pub current_wave: usize,
    pub created_at: u64,
    pub updated_at: u64,
    pub agents_available: Vec<AgentType>,
    // Duo mode fields
    #[serde(default = "default_mode")]
    pub mode: OrchestrateMode,
    #[serde(default)]
    pub tasks: Vec<DuoTask>,
    #[serde(default)]
    pub rounds: Vec<DuoRound>,
    #[serde(default)]
    pub relay_log: Vec<RelayMessage>,
    #[serde(default)]
    pub token_stats: Option<SessionTokenStats>,
}

fn default_mode() -> OrchestrateMode { OrchestrateMode::Wave }

// ─── Agent Availability ─────────────────────────────────────────────────────

fn is_agent_available(agent: &AgentType) -> bool {
    registry()
        .get(agent_provider_id(agent))
        .map(|p| p.is_available())
        .unwrap_or(false)
}

fn get_agent_version(agent: &AgentType) -> Option<String> {
    registry().get(agent_provider_id(agent)).and_then(|p| p.version())
}

pub fn report_agent_availability() -> Result<Vec<AgentType>, String> {
    eprintln!("\nAgent Detection:");
    let mut agents = Vec::new();

    // Check Claude
    if is_agent_available(&AgentType::ClaudeCode) {
        let ver = get_agent_version(&AgentType::ClaudeCode).unwrap_or_else(|| "unknown".into());
        eprintln!("  ✓ Claude Code {} — available", ver);
        agents.push(AgentType::ClaudeCode);
    } else {
        eprintln!("  ✗ Claude Code — not found (install: npm i -g @anthropic-ai/claude-code)");
    }

    // Check Gemini
    if is_agent_available(&AgentType::GeminiCli) {
        let ver = get_agent_version(&AgentType::GeminiCli).unwrap_or_else(|| "unknown".into());
        eprintln!("  ✓ Gemini CLI {} — available", ver);
        agents.push(AgentType::GeminiCli);
    } else {
        eprintln!("  ✗ Gemini CLI — not found (install: npm i -g @anthropic/gemini-cli or npx @anthropic/gemini-cli)");
    }

    if agents.is_empty() {
        eprintln!("  → No agents found. Install at least one to use orchestration.\n");
        return Err("No agents available. Install 'claude' (npm i -g @anthropic-ai/claude-code) or 'gemini' CLI.".to_string());
    } else if agents.len() == 1 {
        eprintln!("  → Single-agent mode ({})\n", agents[0]);
    } else {
        eprintln!("  → Dual-agent mode — both available\n");
    }

    Ok(agents)
}

// ─── Smart Assignment ───────────────────────────────────────────────────────

// Scored preference system: both agents can implement.
// Claude gets complex refactors/migrations; Gemini gets everything else (free).
// Ties go to Gemini.
const CLAUDE_PREFS: &[(&str, i32)] = &[
    ("refactor", 3), ("migrate", 3), ("rewrite", 3), ("complex logic", 3),
    ("fix bug", 2), ("debug", 2), ("architect", 2),
];

const GEMINI_PREFS: &[(&str, i32)] = &[
    ("research", 3), ("test", 3), ("document", 3), ("analyze", 2), ("review", 2),
    ("implement", 1), ("add endpoint", 1), ("add feature", 1), ("write code", 1),
    ("build", 1), ("create", 1), ("add", 1), ("set up", 1), ("configure", 1),
];

fn classify_action(action: &str) -> AgentType {
    let lower = action.to_lowercase();

    let claude_score: i32 = CLAUDE_PREFS.iter()
        .filter(|(kw, _)| lower.contains(kw))
        .map(|(_, s)| s).sum();
    let gemini_score: i32 = GEMINI_PREFS.iter()
        .filter(|(kw, _)| lower.contains(kw))
        .map(|(_, s)| s).sum();

    // Gemini-first: ties go to Gemini (it's free)
    if claude_score > gemini_score {
        AgentType::ClaudeCode
    } else {
        AgentType::GeminiCli
    }
}

fn assign_agents(
    waves: &[(&str, Vec<String>, Vec<String>, &str)],
    strategy: &AssignmentStrategy,
    available: &[AgentType],
) -> Vec<AgentType> {
    match strategy {
        AssignmentStrategy::Manual(agents) => agents.clone(),
        AssignmentStrategy::RoundRobin => {
            waves.iter().enumerate().map(|(i, _)| available[i % available.len()].clone()).collect()
        }
        AssignmentStrategy::Smart => {
            waves.iter().map(|(action, _, _, _)| {
                let preferred = classify_action(action);
                if available.contains(&preferred) {
                    preferred
                } else {
                    available[0].clone()
                }
            }).collect()
        }
    }
}

// ─── Session Persistence ────────────────────────────────────────────────────

fn orchestrate_dir() -> PathBuf {
    PathBuf::from(".aura/orchestrate")
}

pub fn save_session(session: &OrchestrationSession) -> Result<(), String> {
    let dir = orchestrate_dir();
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create orchestrate dir: {}", e))?;
    let path = dir.join(format!("{}.json", session.id));
    let json = serde_json::to_string_pretty(session).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| format!("Failed to write session: {}", e))?;
    // Update active session pointer
    fs::write(dir.join("ACTIVE_SESSION"), &session.id)
        .map_err(|e| format!("Failed to write active pointer: {}", e))?;
    Ok(())
}

pub fn load_session(id: &str) -> Result<OrchestrationSession, String> {
    let path = orchestrate_dir().join(format!("{}.json", id));
    let data = fs::read_to_string(&path).map_err(|e| format!("Session not found: {}", e))?;
    serde_json::from_str(&data).map_err(|e| format!("Invalid session JSON: {}", e))
}

pub fn get_active_session() -> Result<Option<OrchestrationSession>, String> {
    let pointer = orchestrate_dir().join("ACTIVE_SESSION");
    if !pointer.exists() {
        return Ok(None);
    }
    let id = fs::read_to_string(&pointer).map_err(|e| e.to_string())?.trim().to_string();
    if id.is_empty() {
        return Ok(None);
    }
    load_session(&id).map(Some)
}

pub fn list_sessions() -> Result<Vec<OrchestrationSession>, String> {
    let dir = orchestrate_dir();
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut sessions = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) == Some("json") {
            if let Ok(data) = fs::read_to_string(&path) {
                if let Ok(session) = serde_json::from_str::<OrchestrationSession>(&data) {
                    sessions.push(session);
                }
            }
        }
    }
    sessions.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(sessions)
}

fn clear_active_pointer() {
    let _ = fs::remove_file(orchestrate_dir().join("ACTIVE_SESSION"));
}

// ─── Agent Invocation ───────────────────────────────────────────────────────

pub fn get_repo_root() -> Result<PathBuf, String> {
    let output = Command::new("git")
        .args(["rev-parse", "--show-toplevel"])
        .output()
        .map_err(|e| format!("git error: {}", e))?;
    if !output.status.success() {
        return Err("Not in a git repository".to_string());
    }
    Ok(PathBuf::from(String::from_utf8_lossy(&output.stdout).trim()))
}

fn get_git_head() -> Result<String, String> {
    let output = Command::new("git")
        .args(["rev-parse", "HEAD"])
        .output()
        .map_err(|e| format!("git error: {}", e))?;
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn git_reset_hard(ref_str: &str) -> Result<(), String> {
    let status = Command::new("git")
        .args(["reset", "--hard", ref_str])
        .output()
        .map_err(|e| format!("git reset error: {}", e))?;
    if !status.status.success() {
        return Err(format!("git reset --hard {} failed", ref_str));
    }
    Ok(())
}

fn build_agent_prompt(
    session: &OrchestrationSession,
    wave: &OrchestrateWave,
    handover_context: &str,
) -> String {
    format!(
        r#"<aura_orchestrate>
  <session>{session_id}</session>
  <wave>{wave_id} of {total}</wave>
  <objective>{objective}</objective>
</aura_orchestrate>

<aura_semantic_context>
{handover}
</aura_semantic_context>

<wave_instructions>
  ACTION: {action}
  FILES: {files}
  FUNCTIONS: {functions}
  VERIFY: {verify}
</wave_instructions>

<constraints>
  - Focus ONLY on this wave's action. Do not modify unrelated files.
  - Ensure all files compile/build after your changes.
  - Do NOT run aura commands — Aura validates your work separately.
</constraints>"#,
        session_id = session.id,
        wave_id = wave.id,
        total = session.waves.len(),
        objective = session.objective,
        handover = handover_context,
        action = wave.action,
        files = wave.files.join(", "),
        functions = wave.functions.join(", "),
        verify = wave.verify,
    )
}

fn generate_handover() -> String {
    let output = Command::new("aura")
        .args(["handover", "orchestrator"])
        .output();
    match output {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).to_string(),
        _ => String::from("<handover>Context generation failed — proceeding without semantic context.</handover>"),
    }
}

/// Invoke an agent CLI as a subprocess.
/// Returns (output_text, Option<claude_session_id>, TokenUsage).
pub fn invoke_agent(
    agent: &AgentType,
    prompt: &str,
    timeout_secs: u64,
    claude_session_id: Option<&str>,
) -> Result<(String, Option<String>, TokenUsage), String> {
    let repo_root = get_repo_root()?;

    // Build the invocation through the provider registry. Adding a
    // new agent CLI is a one-liner in `aura-agents` — no patches to
    // this dispatch path.
    let reg = registry();
    let provider_id = agent_provider_id(agent);
    let provider = reg
        .get(provider_id)
        .ok_or_else(|| format!("agent '{}' not in registry", provider_id))?;
    let inv = provider
        .build_invocation(&InvokeRequest {
            prompt,
            mode: InvokeMode::OneShot,
            resume_session_id: claude_session_id,
            attachments_via_stdin: false,
            effort: None,
            fast: false,
            model: None,
            approval: None,
        })
        .map_err(|e| format!("build invocation for {provider_id}: {e}"))?;

    let mut cmd = Command::new(&inv.bin);
    cmd.args(&inv.args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .current_dir(&repo_root);
    for (k, v) in &inv.env {
        cmd.env(k, v);
    }
    // Claude-specific guard: prevent the spawned `claude` from picking
    // up its own runtime breadcrumb and recursing. Not modeled in the
    // provider trait because it's a CLI-side quirk that doesn't apply
    // to the desktop shell's spawn path.
    if provider_id == "claude" {
        cmd.env_remove("CLAUDECODE");
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn {}: {e}", provider.label()))?;

    // Wait with timeout — poll every 500ms
    let timeout = std::time::Duration::from_secs(timeout_secs);
    let start = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_status)) => break,
            Ok(None) => {
                if start.elapsed() > timeout {
                    let _ = child.kill();
                    return Err(format!("Agent {} timed out after {}s", agent, timeout_secs));
                }
                std::thread::sleep(std::time::Duration::from_millis(500));
            }
            Err(e) => {
                return Err(format!("Error waiting for agent: {}", e));
            }
        }
    }

    let output = child.wait_with_output().map_err(|e| format!("Failed to get agent output: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if !output.status.success() {
        return Err(format!("Agent {} exited with error.\nStdout: {}\nStderr: {}", agent, stdout, stderr));
    }

    // Try to extract Claude session ID from stderr for session resumption.
    // Claude Code prints session info to stderr; look for a UUID pattern after "session"
    let mut extracted_session_id = None;
    if *agent == AgentType::ClaudeCode {
        // Claude --resume returns/uses the same session ID
        if let Some(sid) = claude_session_id {
            extracted_session_id = Some(sid.to_string());
        } else {
            // Try to find a session UUID in the output
            let uuid_re = regex::Regex::new(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}").ok();
            if let Some(re) = uuid_re {
                if let Some(m) = re.find(&stderr) {
                    extracted_session_id = Some(m.as_str().to_string());
                }
            }
        }
    }

    let combined = format!("{}\n{}", stdout, stderr);
    let input_tokens = estimate_tokens(prompt);
    let output_tokens = estimate_tokens(&combined);
    let is_resumed = claude_session_id.is_some() && *agent == AgentType::ClaudeCode;
    let saved_resume = if is_resumed { input_tokens / 2 } else { 0 }; // resumed sessions skip re-sending context

    let usage = TokenUsage {
        input_tokens,
        output_tokens,
        total_tokens: input_tokens + output_tokens,
        cost_usd: calculate_cost(agent, input_tokens, output_tokens),
        saved_by_handover: 0, // calculated at session level
        saved_by_resume: saved_resume,
    };

    Ok((combined, extracted_session_id, usage))
}

// ─── Validation ─────────────────────────────────────────────────────────────

fn validate_wave(base: &str) -> Result<(f64, Vec<String>, String), String> {
    let output = Command::new("aura")
        .args(["pr-review", "--base", base, "--json"])
        .output()
        .map_err(|e| format!("pr-review failed: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();

    // Try to parse the JSON review output
    if let Ok(review) = serde_json::from_str::<serde_json::Value>(&stdout) {
        let risk_score = review["risk_score"].as_f64().unwrap_or(0.0);
        let violations: Vec<String> = review["invariant_violations"]
            .as_array()
            .map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect())
            .unwrap_or_default();
        let summary = format!(
            "Risk: {:.0}/100 | Violations: {} | Changes: {}",
            risk_score,
            violations.len(),
            review["total_changes"].as_u64().unwrap_or(0)
        );
        Ok((risk_score, violations, summary))
    } else {
        // If JSON parse fails, treat as passed with warning
        Ok((0.0, Vec::new(), format!("Review output (non-JSON): {}", &stdout[..stdout.len().min(200)])))
    }
}

fn run_aura_fix(base: &str) -> Result<String, String> {
    let output = Command::new("aura")
        .args(["fix", "--base", base])
        .output()
        .map_err(|e| format!("aura fix failed: {}", e))?;
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

// ─── Failure Handling ───────────────────────────────────────────────────────

fn alternate_agent(current: &AgentType, available: &[AgentType]) -> Option<AgentType> {
    available.iter().find(|a| *a != current).cloned()
}

fn handle_failure(
    session: &mut OrchestrationSession,
    wave_idx: usize,
    base: &str,
) -> Result<bool, String> {
    let retry_count = session.waves[wave_idx].retry_count;
    let git_ref = session.waves[wave_idx].git_ref_before.clone();

    match retry_count {
        0 => {
            // 1st fail: run aura fix, retry same agent
            eprintln!("  [retry 1/3] Running aura fix...");
            if let Some(ref r) = git_ref {
                let _ = git_reset_hard(r);
            }
            let fix_output = run_aura_fix(base)?;
            session.waves[wave_idx].logs.push_str(&format!("\n--- AURA FIX ---\n{}", fix_output));
            session.waves[wave_idx].status = WaveStatus::Retrying;
            session.waves[wave_idx].retry_count = 1;
            save_session(session)?;
            Ok(true) // should retry
        }
        1 => {
            // 2nd fail: switch agent, retry
            if let Some(alt) = alternate_agent(&session.waves[wave_idx].assigned_agent, &session.agents_available) {
                eprintln!("  [retry 2/3] Switching agent to {}...", alt);
                if let Some(ref r) = git_ref {
                    let _ = git_reset_hard(r);
                }
                session.waves[wave_idx].assigned_agent = alt;
                session.waves[wave_idx].status = WaveStatus::Retrying;
                session.waves[wave_idx].retry_count = 2;
                save_session(session)?;
                Ok(true)
            } else {
                // Only one agent available, pause
                session.waves[wave_idx].status = WaveStatus::Failed;
                session.status = OrchestrationStatus::Paused;
                save_session(session)?;
                Ok(false)
            }
        }
        _ => {
            // 3rd fail: pause session
            eprintln!("  [fail] Wave {} failed after 3 attempts. Pausing session.", wave_idx + 1);
            if let Some(ref r) = git_ref {
                let _ = git_reset_hard(r);
            }
            session.waves[wave_idx].status = WaveStatus::Failed;
            session.status = OrchestrationStatus::Paused;
            save_session(session)?;
            Ok(false)
        }
    }
}

// ─── Plan Decomposition ─────────────────────────────────────────────────────

fn decompose_objective(objective: &str) -> Vec<(String, Vec<String>, Vec<String>, String)> {
    // Use aura plan to decompose, falling back to a single wave
    let output = Command::new("aura")
        .args(["plan", objective])
        .output();

    if let Ok(o) = output {
        if o.status.success() {
            // Try to read the generated plan
            if let Ok(plan_data) = fs::read_to_string(".aura/plans/ACTIVE_PLAN.json") {
                if let Ok(plan) = serde_json::from_str::<serde_json::Value>(&plan_data) {
                    if let Some(waves) = plan["waves"].as_array() {
                        let result: Vec<_> = waves.iter().map(|w| {
                            let action = w["action"].as_str().unwrap_or("").to_string();
                            let files: Vec<String> = w["files"].as_array()
                                .map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect())
                                .unwrap_or_default();
                            let functions: Vec<String> = w["functions"].as_array()
                                .map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect())
                                .unwrap_or_default();
                            let verify = w["verify"].as_str().unwrap_or("cargo build").to_string();
                            (action, files, functions, verify)
                        }).collect();
                        if !result.is_empty() {
                            return result;
                        }
                    }
                }
            }
        }
    }

    // Fallback: single wave with the full objective
    vec![(objective.to_string(), Vec::new(), Vec::new(), "cargo build".to_string())]
}

// ─── Main Orchestration Loop ────────────────────────────────────────────────

fn now_ts() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()
}

pub fn run(objective: &str, strategy: AssignmentStrategy, base: &str) -> Result<OrchestrationSession, String> {
    let available = report_agent_availability()?;

    eprintln!("Phase 1: Planning — decomposing objective...");
    let raw_waves = decompose_objective(objective);

    eprintln!("Phase 2: Assigning {} waves to agents...", raw_waves.len());
    let wave_refs: Vec<(&str, Vec<String>, Vec<String>, &str)> = raw_waves.iter()
        .map(|(a, f, fn_, v)| (a.as_str(), f.clone(), fn_.clone(), v.as_str()))
        .collect();
    let assignments = assign_agents(&wave_refs, &strategy, &available);

    let waves: Vec<OrchestrateWave> = raw_waves.iter().enumerate().map(|(i, (action, files, functions, verify))| {
        OrchestrateWave {
            id: i + 1,
            action: action.clone(),
            files: files.clone(),
            functions: functions.clone(),
            verify: verify.clone(),
            assigned_agent: assignments.get(i).cloned().unwrap_or(AgentType::ClaudeCode),
            status: WaveStatus::Pending,
            logs: String::new(),
            review_summary: None,
            risk_score: None,
            started_at: None,
            completed_at: None,
            retry_count: 0,
            git_ref_before: None,
            usage: None,
        }
    }).collect();

    let mut session = OrchestrationSession {
        id: Uuid::new_v4().to_string(),
        objective: objective.to_string(),
        strategy,
        status: OrchestrationStatus::Running,
        waves,
        current_wave: 0,
        created_at: now_ts(),
        updated_at: now_ts(),
        agents_available: available,
        mode: OrchestrateMode::Wave,
        tasks: Vec::new(),
        rounds: Vec::new(),
        relay_log: Vec::new(),
        token_stats: None,
    };

    save_session(&session)?;

    eprintln!("Phase 3: Executing {} waves...\n", session.waves.len());
    for (desc, agent) in session.waves.iter().map(|w| (w.action.clone(), w.assigned_agent.clone())) {
        eprintln!("  Wave {}: {} → {}", session.current_wave + 1, desc, agent);
    }
    eprintln!();

    // Track Claude session ID for --resume across consecutive Claude waves
    // This saves tokens by continuing the conversation instead of cold-starting
    let mut claude_sid: Option<String> = None;

    // Execute loop
    while session.current_wave < session.waves.len() {
        // Check if paused/cancelled
        if session.status == OrchestrationStatus::Paused || session.status == OrchestrationStatus::Cancelled {
            break;
        }

        let idx = session.current_wave;
        let wave_id = session.waves[idx].id;
        let agent = session.waves[idx].assigned_agent.clone();
        let action = session.waves[idx].action.clone();

        // Reset Claude session if we're switching away from Claude
        if agent != AgentType::ClaudeCode {
            claude_sid = None;
        }

        let is_resumed = agent == AgentType::ClaudeCode && claude_sid.is_some();
        let mode_label = if is_resumed { " (resumed)" } else { "" };
        eprintln!("━━━ Wave {}/{} ━━━ {} ━━━ Agent: {}{} ━━━", wave_id, session.waves.len(), action, agent, mode_label);

        // Record git ref for safety rollback
        session.waves[idx].git_ref_before = get_git_head().ok();
        session.waves[idx].status = WaveStatus::Running;
        session.waves[idx].started_at = Some(now_ts());
        session.updated_at = now_ts();
        save_session(&session)?;

        // Only generate full handover on first wave or after an agent switch.
        // Resumed Claude sessions already have the context.
        let prompt = if is_resumed {
            // Minimal prompt — Claude already has the full context from the prior wave
            format!(
                "Continue with Wave {} of {}.\n\nACTION: {}\nFILES: {}\nFUNCTIONS: {}\nVERIFY: {}\n\nFocus ONLY on this wave. Do not modify unrelated files.",
                wave_id, session.waves.len(), session.waves[idx].action,
                session.waves[idx].files.join(", "), session.waves[idx].functions.join(", "),
                session.waves[idx].verify
            )
        } else {
            let handover = generate_handover();
            build_agent_prompt(&session, &session.waves[idx].clone(), &handover)
        };

        // Invoke agent — pass Claude session ID for resumption
        let result = invoke_agent(&agent, &prompt, 900, claude_sid.as_deref());

        match result {
            Ok((output, new_sid, usage)) => {
                // Capture Claude session ID for next wave
                if agent == AgentType::ClaudeCode {
                    if let Some(sid) = new_sid {
                        claude_sid = Some(sid);
                    }
                }
                session.waves[idx].logs = output;
                session.waves[idx].usage = Some(usage);
                session.waves[idx].status = WaveStatus::Validating;
                session.updated_at = now_ts();
                save_session(&session)?;

                // Validate
                eprintln!("  Validating wave {}...", wave_id);
                match validate_wave(base) {
                    Ok((risk, violations, summary)) => {
                        session.waves[idx].risk_score = Some(risk);
                        session.waves[idx].review_summary = Some(summary.clone());

                        if violations.is_empty() || risk < 70.0 {
                            // Passed
                            session.waves[idx].status = WaveStatus::Passed;
                            session.waves[idx].completed_at = Some(now_ts());
                            eprintln!("  PASSED (risk: {:.0}/100)", risk);
                        } else {
                            // Failed validation
                            eprintln!("  FAILED validation (risk: {:.0}, {} violations)", risk, violations.len());
                            let should_retry = handle_failure(&mut session, idx, base)?;
                            if should_retry {
                                continue; // retry same wave
                            } else {
                                break;
                            }
                        }
                    }
                    Err(e) => {
                        eprintln!("  Validation error: {} — treating as passed", e);
                        session.waves[idx].status = WaveStatus::Passed;
                        session.waves[idx].completed_at = Some(now_ts());
                    }
                }
            }
            Err(e) => {
                eprintln!("  Agent invocation failed: {}", e);
                session.waves[idx].logs = e;
                let should_retry = handle_failure(&mut session, idx, base)?;
                if should_retry {
                    continue;
                } else {
                    break;
                }
            }
        }

        session.current_wave += 1;
        session.updated_at = now_ts();
        save_session(&session)?;
    }

    // Finalize
    if session.current_wave >= session.waves.len() && session.status == OrchestrationStatus::Running {
        session.status = OrchestrationStatus::Completed;
        eprintln!("\nOrchestration complete — all {} waves passed.", session.waves.len());
    }

    if session.status == OrchestrationStatus::Completed || session.status == OrchestrationStatus::Cancelled {
        clear_active_pointer();
    }

    session.updated_at = now_ts();
    save_session(&session)?;

    Ok(session)
}

// ─── Session Control ────────────────────────────────────────────────────────

pub fn pause_session() -> Result<OrchestrationSession, String> {
    let mut session = get_active_session()?.ok_or("No active orchestration session")?;
    if session.status != OrchestrationStatus::Running {
        return Err(format!("Session is not running (status: {:?})", session.status));
    }
    session.status = OrchestrationStatus::Paused;
    session.updated_at = now_ts();
    save_session(&session)?;
    Ok(session)
}

pub fn resume_session(base: &str) -> Result<OrchestrationSession, String> {
    let mut session = get_active_session()?.ok_or("No active orchestration session")?;
    if session.status != OrchestrationStatus::Paused {
        return Err(format!("Session is not paused (status: {:?})", session.status));
    }
    session.status = OrchestrationStatus::Running;
    session.updated_at = now_ts();
    save_session(&session)?;

    // Re-enter the execution loop from current_wave
    let mut claude_sid: Option<String> = None;
    while session.current_wave < session.waves.len() {
        if session.status != OrchestrationStatus::Running {
            break;
        }
        let idx = session.current_wave;
        let agent = session.waves[idx].assigned_agent.clone();

        if agent != AgentType::ClaudeCode {
            claude_sid = None;
        }

        session.waves[idx].git_ref_before = get_git_head().ok();
        session.waves[idx].status = WaveStatus::Running;
        session.waves[idx].started_at = Some(now_ts());
        session.updated_at = now_ts();
        save_session(&session)?;

        let handover = generate_handover();
        let prompt = build_agent_prompt(&session, &session.waves[idx].clone(), &handover);
        let result = invoke_agent(&agent, &prompt, 900, claude_sid.as_deref());

        match result {
            Ok((output, new_sid, usage)) => {
                if agent == AgentType::ClaudeCode {
                    if let Some(sid) = new_sid { claude_sid = Some(sid); }
                }
                session.waves[idx].logs = output;
                session.waves[idx].usage = Some(usage);
                session.waves[idx].status = WaveStatus::Validating;
                save_session(&session)?;

                match validate_wave(base) {
                    Ok((risk, violations, summary)) => {
                        session.waves[idx].risk_score = Some(risk);
                        session.waves[idx].review_summary = Some(summary);
                        if violations.is_empty() || risk < 70.0 {
                            session.waves[idx].status = WaveStatus::Passed;
                            session.waves[idx].completed_at = Some(now_ts());
                        } else {
                            let should_retry = handle_failure(&mut session, idx, base)?;
                            if should_retry { continue; } else { break; }
                        }
                    }
                    Err(_) => {
                        session.waves[idx].status = WaveStatus::Passed;
                        session.waves[idx].completed_at = Some(now_ts());
                    }
                }
            }
            Err(e) => {
                session.waves[idx].logs = e;
                let should_retry = handle_failure(&mut session, idx, base)?;
                if should_retry { continue; } else { break; }
            }
        }

        session.current_wave += 1;
        session.updated_at = now_ts();
        save_session(&session)?;
    }

    if session.current_wave >= session.waves.len() && session.status == OrchestrationStatus::Running {
        session.status = OrchestrationStatus::Completed;
        clear_active_pointer();
    }
    session.updated_at = now_ts();
    save_session(&session)?;
    Ok(session)
}

pub fn cancel_session() -> Result<OrchestrationSession, String> {
    let mut session = get_active_session()?.ok_or("No active orchestration session")?;
    session.status = OrchestrationStatus::Cancelled;
    session.updated_at = now_ts();
    save_session(&session)?;
    clear_active_pointer();
    Ok(session)
}

pub fn get_status_summary() -> Result<String, String> {
    match get_active_session()? {
        Some(session) => {
            let passed = session.waves.iter().filter(|w| w.status == WaveStatus::Passed).count();
            let total = session.waves.len();
            let pct = if total > 0 { (passed * 100) / total } else { 0 };
            let current = if session.current_wave < total {
                format!("Current: Wave {} — {}", session.current_wave + 1, session.waves[session.current_wave].action)
            } else {
                "All waves complete".to_string()
            };
            Ok(format!(
                "Session: {} | Status: {:?} | Progress: {}/{} waves ({}%) | {}",
                &session.id[..8], session.status, passed, total, pct, current
            ))
        }
        None => Ok("No active orchestration session.".to_string()),
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// DUO MODE: Parallel Multi-Agent Relay Engine
// ═══════════════════════════════════════════════════════════════════════════════

/// Parse a JSON array of tasks from agent planning output.
fn parse_agent_plan(output: &str) -> Vec<serde_json::Value> {
    // Find JSON array in output (may be surrounded by markdown or text)
    let trimmed = output.trim();
    // Try direct parse first
    if let Ok(arr) = serde_json::from_str::<Vec<serde_json::Value>>(trimmed) {
        return arr;
    }
    // Search for JSON array in the output
    if let Some(start) = trimmed.find('[') {
        // Find matching closing bracket
        let mut depth = 0;
        for (i, ch) in trimmed[start..].char_indices() {
            match ch {
                '[' => depth += 1,
                ']' => {
                    depth -= 1;
                    if depth == 0 {
                        let json_str = &trimmed[start..start + i + 1];
                        if let Ok(arr) = serde_json::from_str::<Vec<serde_json::Value>>(json_str) {
                            return arr;
                        }
                        break;
                    }
                }
                _ => {}
            }
        }
    }
    Vec::new()
}

/// Helper to create a DuoTask from parsed JSON
fn json_to_duo_task(val: &serde_json::Value, id: usize, default_agent: AgentType) -> DuoTask {
    let action = val["action"].as_str().unwrap_or("").to_string();
    let depends_on: Vec<usize> = val["depends_on"].as_array()
        .map(|arr| arr.iter().filter_map(|v| v.as_u64().map(|n| n as usize)).collect())
        .unwrap_or_default();

    DuoTask {
        id,
        action: action.clone(),
        agent: default_agent,
        depends_on,
        status: TaskStatus::Pending,
        output: String::new(),
        relay_summary: None,
        started_at: None,
        completed_at: None,
        retry_count: 0,
            usage: None,
            summary: None,
    }
}

/// Collaborative planning: both agents contribute to task decomposition.
/// If both agents are available, they plan in parallel and results are merged.
/// Falls back to aura plan + "and" splitting if collaborative planning fails.
fn collaborative_plan(objective: &str, available: &[AgentType], handover: &str) -> Vec<DuoTask> {
    let has_both = available.len() >= 2;

    if has_both {
        eprintln!("  Collaborative planning — both agents contributing...");

        let planning_prompt = format!(
            r#"<aura_context>
{handover}
</aura_context>

<objective>{objective}</objective>

<instructions>
You are a senior software architect planning this objective.
Break it into 2-6 concrete, actionable tasks. Return ONLY a valid JSON array:
[{{"action": "description of task", "files": ["file1.rs"], "depends_on": [], "complexity": 3}}]

Rules:
- Each task should be completable in one agent session (under 15 minutes)
- Tasks with no shared files can be independent (empty depends_on = parallel)
- Tasks modifying the same files must have dependency on the earlier task's index (0-based)
- Include a final "verify and test" task that depends on all others
- complexity: 1=trivial, 2=simple, 3=moderate, 4=complex, 5=very complex
- Return ONLY the JSON array, no markdown, no explanation
</instructions>"#,
            handover = handover,
            objective = objective,
        );

        let prompt_clone = planning_prompt.clone();

        // Spawn both agents for planning in parallel
        let gemini_handle = std::thread::spawn(move || {
            invoke_agent(&AgentType::GeminiCli, &prompt_clone, 120, None)
        });
        let claude_handle = std::thread::spawn(move || {
            invoke_agent(&AgentType::ClaudeCode, &planning_prompt, 120, None)
        });

        let gemini_plan = gemini_handle.join().ok().and_then(|r| r.ok())
            .map(|(out, _, _)| parse_agent_plan(&out)).unwrap_or_default();
        let claude_plan = claude_handle.join().ok().and_then(|r| r.ok())
            .map(|(out, _, _)| parse_agent_plan(&out)).unwrap_or_default();

        eprintln!("  Gemini proposed {} tasks, Claude proposed {} tasks",
            gemini_plan.len(), claude_plan.len());

        // Merge plans: take all unique tasks, assign to the agent that proposed them
        let mut tasks: Vec<DuoTask> = Vec::new();
        let mut seen_actions: Vec<String> = Vec::new();

        // Gemini tasks first (prioritize free agent)
        for val in &gemini_plan {
            let action = val["action"].as_str().unwrap_or("").to_lowercase();
            if !action.is_empty() && !seen_actions.iter().any(|s| actions_similar(s, &action)) {
                let mut task = json_to_duo_task(val, tasks.len() + 1, AgentType::GeminiCli);
                // Use classifier for final assignment (Gemini proposed → slight Gemini preference)
                let classified = classify_action(&task.action);
                if classified == AgentType::ClaudeCode {
                    // Only override to Claude if strongly preferred
                    let lower = task.action.to_lowercase();
                    let claude_score: i32 = CLAUDE_PREFS.iter()
                        .filter(|(kw, _)| lower.contains(kw))
                        .map(|(_, s)| s).sum();
                    if claude_score >= 3 {
                        task.agent = AgentType::ClaudeCode;
                    }
                }
                seen_actions.push(action);
                tasks.push(task);
            }
        }

        // Claude tasks — add any that aren't duplicates
        for val in &claude_plan {
            let action = val["action"].as_str().unwrap_or("").to_lowercase();
            if !action.is_empty() && !seen_actions.iter().any(|s| actions_similar(s, &action)) {
                let mut task = json_to_duo_task(val, tasks.len() + 1, AgentType::ClaudeCode);
                // Claude proposed → slight Claude preference
                let classified = classify_action(&task.action);
                if classified == AgentType::GeminiCli {
                    let lower = task.action.to_lowercase();
                    let gemini_score: i32 = GEMINI_PREFS.iter()
                        .filter(|(kw, _)| lower.contains(kw))
                        .map(|(_, s)| s).sum();
                    if gemini_score >= 3 {
                        task.agent = AgentType::GeminiCli;
                    }
                }
                seen_actions.push(action);
                tasks.push(task);
            }
        }

        // Validate: fix dependency indices (agents use 0-based, we use 1-based IDs)
        for task in &mut tasks {
            task.depends_on = task.depends_on.iter()
                .map(|d| d + 1) // convert 0-based to 1-based
                .filter(|d| *d < task.id && *d >= 1) // only valid earlier tasks
                .collect();
        }

        // Ensure parallelism: if all tasks are same agent, flip alternating ones
        if tasks.len() >= 2 {
            let all_same = tasks.iter().all(|t| t.agent == tasks[0].agent);
            if all_same {
                for i in (1..tasks.len()).step_by(2) {
                    tasks[i].agent = if tasks[0].agent == AgentType::ClaudeCode {
                        AgentType::GeminiCli
                    } else {
                        AgentType::ClaudeCode
                    };
                }
            }
        }

        if tasks.len() >= 2 {
            eprintln!("  Merged into {} tasks", tasks.len());
            return tasks;
        }
        // Fall through to fallback if merge produced < 2 tasks
        eprintln!("  Collaborative planning produced too few tasks, falling back...");
    }

    // Fallback: aura plan + "and" splitting
    fallback_decompose(objective, available)
}

/// Check if two action strings are similar enough to be considered duplicates
fn actions_similar(a: &str, b: &str) -> bool {
    // Simple word overlap check
    let a_words: std::collections::HashSet<&str> = a.split_whitespace().collect();
    let b_words: std::collections::HashSet<&str> = b.split_whitespace().collect();
    let intersection = a_words.intersection(&b_words).count();
    let union = a_words.union(&b_words).count();
    if union == 0 { return false; }
    (intersection as f64 / union as f64) > 0.6
}

/// Fallback decomposition: aura plan or "and" splitting
fn fallback_decompose(objective: &str, available: &[AgentType]) -> Vec<DuoTask> {
    let raw_waves = decompose_objective(objective);
    let has_both = available.len() >= 2;

    if raw_waves.len() <= 1 && has_both {
        // Try to split compound objectives on " and "
        let parts: Vec<&str> = objective.splitn(4, " and ").collect();
        if parts.len() >= 2 {
            let mut tasks = Vec::new();
            for (i, part) in parts.iter().enumerate() {
                let action = part.trim().to_string();
                tasks.push(DuoTask {
                    id: i + 1,
                    action: action.clone(),
                    agent: classify_action(&action),
                    depends_on: Vec::new(),
                    status: TaskStatus::Pending,
                    output: String::new(),
                    relay_summary: None,
                    started_at: None,
                    completed_at: None,
                    retry_count: 0,
                    usage: None,
                    summary: None,
                });
            }
            // Ensure at least one task per agent
            if tasks.len() >= 2 {
                let has_gemini = tasks.iter().any(|t| t.agent == AgentType::GeminiCli);
                let has_claude = tasks.iter().any(|t| t.agent == AgentType::ClaudeCode);
                if !has_gemini || !has_claude {
                    tasks[1].agent = if tasks[0].agent == AgentType::ClaudeCode {
                        AgentType::GeminiCli
                    } else {
                        AgentType::ClaudeCode
                    };
                }
            }
            return tasks;
        }
    }

    if raw_waves.len() <= 1 {
        return vec![DuoTask {
            id: 1,
            action: objective.to_string(),
            agent: if has_both { classify_action(objective) } else { available[0].clone() },
            depends_on: Vec::new(),
            status: TaskStatus::Pending,
            output: String::new(),
            relay_summary: None,
            started_at: None,
            completed_at: None,
            retry_count: 0,
            usage: None,
            summary: None,
        }];
    }

    // Multiple waves from aura plan
    let mut tasks: Vec<DuoTask> = Vec::new();
    for (i, (action, _files, _fns, _verify)) in raw_waves.iter().enumerate() {
        let depends_on = if i < 2 { Vec::new() } else { vec![i] };
        tasks.push(DuoTask {
            id: i + 1,
            action: action.clone(),
            agent: if has_both && i % 2 == 0 {
                classify_action(action)
            } else if has_both {
                let preferred = classify_action(action);
                available.iter().find(|a| **a != preferred).cloned().unwrap_or(preferred)
            } else {
                available[0].clone()
            },
            depends_on,
            status: TaskStatus::Pending,
            output: String::new(),
            relay_summary: None,
            started_at: None,
            completed_at: None,
            retry_count: 0,
            usage: None,
            summary: None,
        });
    }

    if tasks.len() >= 2 && has_both && tasks[0].agent == tasks[1].agent {
        let alt = available.iter().find(|a| **a != tasks[0].agent).cloned();
        if let Some(a) = alt { tasks[1].agent = a; }
    }

    tasks
}

/// Find all tasks whose dependencies are satisfied → next round.
fn schedule_next_round(tasks: &[DuoTask], round_id: usize) -> Option<DuoRound> {
    let done_ids: Vec<usize> = tasks.iter()
        .filter(|t| t.status == TaskStatus::Done)
        .map(|t| t.id)
        .collect();

    let ready: Vec<usize> = tasks.iter()
        .filter(|t| t.status == TaskStatus::Pending)
        .filter(|t| t.depends_on.iter().all(|dep| done_ids.contains(dep)))
        .map(|t| t.id)
        .collect();

    if ready.is_empty() {
        return None;
    }

    Some(DuoRound {
        id: round_id,
        task_ids: ready,
        relay_context: String::new(),
    })
}

/// Build relay context from completed tasks — compressed summaries of what each agent did.
fn build_relay_context(tasks: &[DuoTask], relay_log: &[RelayMessage]) -> String {
    let mut ctx = String::from("<aura_relay>\n");

    // Summarize latest outputs by agent
    for agent in &[AgentType::GeminiCli, AgentType::ClaudeCode] {
        let agent_outputs: Vec<&DuoTask> = tasks.iter()
            .filter(|t| t.status == TaskStatus::Done && t.agent == *agent)
            .collect();

        if !agent_outputs.is_empty() {
            let label = match agent {
                AgentType::GeminiCli => "gemini",
                AgentType::ClaudeCode => "claude",
            };
            ctx.push_str(&format!("  <partner_output agent=\"{}\">\n", label));
            for t in &agent_outputs {
                let summary = t.relay_summary.as_deref()
                    .unwrap_or_else(|| &t.output[..t.output.len().min(500)]);
                ctx.push_str(&format!("    [Task {}] {}: {}\n", t.id, t.action, summary));
            }
            ctx.push_str("  </partner_output>\n");
        }
    }

    // Include any pending questions
    let questions: Vec<&RelayMessage> = relay_log.iter()
        .filter(|m| m.msg_type == RelayType::Question)
        .collect();
    if !questions.is_empty() {
        ctx.push_str("  <questions>\n");
        for q in &questions {
            ctx.push_str(&format!("    <q from=\"{}\">{}</q>\n",
                match q.from { AgentType::GeminiCli => "gemini", AgentType::ClaudeCode => "claude" },
                q.content));
        }
        ctx.push_str("  </questions>\n");
    }

    ctx.push_str("</aura_relay>");
    ctx
}

/// Extract questions from agent output via heuristics.
fn extract_questions(output: &str) -> Vec<String> {
    let mut questions = Vec::new();
    for line in output.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() { continue; }
        // Lines ending with ? that look like real questions
        if trimmed.ends_with('?') && trimmed.len() > 15 {
            questions.push(trimmed.to_string());
        }
        // Explicit question patterns
        let lower = trimmed.to_lowercase();
        if (lower.contains("should i") || lower.contains("which approach") ||
            lower.contains("need clarification") || lower.contains("do you want") ||
            lower.contains("please confirm")) && !trimmed.ends_with('?') {
            questions.push(trimmed.to_string());
        }
    }
    // Limit to 3 most relevant
    questions.truncate(3);
    questions
}

/// Summarize output for relay (truncate intelligently)
fn summarize_output(output: &str) -> String {
    let lines: Vec<&str> = output.lines().collect();
    if lines.len() <= 10 {
        return output.to_string();
    }
    // Take first 3 and last 7 lines as summary
    let mut summary = lines[..3].join("\n");
    summary.push_str("\n...\n");
    summary.push_str(&lines[lines.len()-7..].join("\n"));
    summary
}

/// Extract AST node info from handover context for specific files
fn extract_ast_context(handover: &str, action: &str) -> String {
    // Parse the handover XML to find relevant nodes
    // Look for node entries that match keywords in the action
    let action_lower = action.to_lowercase();
    let keywords: Vec<&str> = action_lower.split_whitespace()
        .filter(|w| w.len() > 3 && !["the", "and", "for", "with", "from", "that", "this"].contains(w))
        .collect();

    if keywords.is_empty() { return String::new(); }

    let mut relevant_lines = Vec::new();
    for line in handover.lines() {
        let line_lower = line.to_lowercase();
        if keywords.iter().any(|kw| line_lower.contains(kw)) {
            if line.contains("node") || line.contains("function") || line.contains("class")
                || line.contains("type=") || line.contains("name=") || line.contains("calls=") {
                relevant_lines.push(line.trim().to_string());
            }
        }
    }

    if relevant_lines.is_empty() { return String::new(); }
    relevant_lines.truncate(15); // limit context

    format!(
        "\n<aura_ast_context>\n  <target_nodes>\n    {}\n  </target_nodes>\n</aura_ast_context>\n",
        relevant_lines.join("\n    ")
    )
}

/// Build the prompt for a duo task, including relay context and AST info.
fn build_duo_task_prompt(
    session: &OrchestrationSession,
    task: &DuoTask,
    relay_context: &str,
    handover: &str,
) -> String {
    let ast_context = extract_ast_context(handover, &task.action);

    format!(
        r#"<aura_orchestrate>
  <session>{session_id}</session>
  <mode>duo</mode>
  <objective>{objective}</objective>
</aura_orchestrate>

<aura_semantic_context>
{handover}
</aura_semantic_context>
{ast_ctx}
{relay}

<your_task>
  TASK {task_id}: {action}
</your_task>

<constraints>
  - Focus ONLY on your assigned task. Do not modify unrelated files.
  - Your partner agent is working on other tasks simultaneously.
  - If you have questions for your partner, state them clearly.
  - Ensure all files compile/build after your changes.
  - Do NOT run aura commands.
</constraints>"#,
        session_id = session.id,
        objective = session.objective,
        handover = handover,
        ast_ctx = ast_context,
        relay = relay_context,
        task_id = task.id,
        action = task.action,
    )
}

/// Run a round — execute Gemini and Claude tasks in parallel threads.
fn run_round_parallel(
    session: &mut OrchestrationSession,
    round: &DuoRound,
    handover: &str,
    claude_sid: &mut Option<String>,
) -> Result<(), String> {
    let gemini_task_ids: Vec<usize> = round.task_ids.iter()
        .filter(|id| session.tasks.iter().any(|t| t.id == **id && t.agent == AgentType::GeminiCli))
        .copied().collect();
    let claude_task_ids: Vec<usize> = round.task_ids.iter()
        .filter(|id| session.tasks.iter().any(|t| t.id == **id && t.agent == AgentType::ClaudeCode))
        .copied().collect();

    // Build prompts for each side
    let relay_ctx = build_relay_context(&session.tasks, &session.relay_log);

    let gemini_prompts: Vec<(usize, String)> = gemini_task_ids.iter().map(|id| {
        let task = session.tasks.iter().find(|t| t.id == *id).unwrap();
        (*id, build_duo_task_prompt(session, task, &relay_ctx, handover))
    }).collect();

    let claude_prompts: Vec<(usize, String)> = claude_task_ids.iter().map(|id| {
        let task = session.tasks.iter().find(|t| t.id == *id).unwrap();
        (*id, build_duo_task_prompt(session, task, &relay_ctx, handover))
    }).collect();

    // Mark all tasks as Running
    for id in &round.task_ids {
        if let Some(t) = session.tasks.iter_mut().find(|t| t.id == *id) {
            t.status = TaskStatus::Running;
            t.started_at = Some(now_ts());
        }
    }
    session.updated_at = now_ts();
    save_session(session)?;

    let is_parallel = !gemini_prompts.is_empty() && !claude_prompts.is_empty();
    if is_parallel {
        eprintln!("  [parallel] Gemini: {} task(s) | Claude: {} task(s)", gemini_prompts.len(), claude_prompts.len());
    }

    // Spawn both in parallel threads
    let c_sid = claude_sid.clone();
    let gemini_handle = if !gemini_prompts.is_empty() {
        Some(std::thread::spawn(move || -> Vec<(usize, Result<(String, Option<String>, TokenUsage), String>)> {
            gemini_prompts.iter().map(|(id, prompt)| {
                (*id, invoke_agent(&AgentType::GeminiCli, prompt, 900, None))
            }).collect()
        }))
    } else {
        None
    };

    let claude_handle = if !claude_prompts.is_empty() {
        Some(std::thread::spawn(move || -> Vec<(usize, Result<(String, Option<String>, TokenUsage), String>)> {
            claude_prompts.iter().map(|(id, prompt)| {
                (*id, invoke_agent(&AgentType::ClaudeCode, prompt, 900, c_sid.as_deref()))
            }).collect()
        }))
    } else {
        None
    };

    // Collect Gemini results
    if let Some(handle) = gemini_handle {
        match handle.join() {
            Ok(results) => {
                for (id, result) in results {
                    if let Some(t) = session.tasks.iter_mut().find(|t| t.id == id) {
                        match result {
                            Ok((output, _, usage)) => {
                                let questions = extract_questions(&output);
                                t.relay_summary = Some(summarize_output(&output));
                                t.output = output;
                                t.status = TaskStatus::Done;
                                t.completed_at = Some(now_ts());
                                t.usage = Some(usage);
                                for q in questions {
                                    session.relay_log.push(RelayMessage {
                                        from: AgentType::GeminiCli,
                                        to: AgentType::ClaudeCode,
                                        content: q,
                                        round_id: round.id,
                                        msg_type: RelayType::Question,
                                    });
                                }
                            }
                            Err(e) => {
                                t.output = e;
                                t.status = TaskStatus::Failed;
                                t.retry_count += 1;
                            }
                        }
                    }
                }
            }
            Err(_) => {
                eprintln!("  [error] Gemini thread panicked");
            }
        }
    }

    // Collect Claude results
    if let Some(handle) = claude_handle {
        match handle.join() {
            Ok(results) => {
                for (id, result) in results {
                    if let Some(t) = session.tasks.iter_mut().find(|t| t.id == id) {
                        match result {
                            Ok((output, new_sid, usage)) => {
                                if let Some(sid) = new_sid {
                                    *claude_sid = Some(sid);
                                }
                                let questions = extract_questions(&output);
                                t.relay_summary = Some(summarize_output(&output));
                                t.output = output;
                                t.status = TaskStatus::Done;
                                t.completed_at = Some(now_ts());
                                t.usage = Some(usage);
                                for q in questions {
                                    session.relay_log.push(RelayMessage {
                                        from: AgentType::ClaudeCode,
                                        to: AgentType::GeminiCli,
                                        content: q,
                                        round_id: round.id,
                                        msg_type: RelayType::Question,
                                    });
                                }
                            }
                            Err(e) => {
                                t.output = e;
                                t.status = TaskStatus::Failed;
                                t.retry_count += 1;
                            }
                        }
                    }
                }
            }
            Err(_) => {
                eprintln!("  [error] Claude thread panicked");
            }
        }
    }

    // Handle failed tasks — retry with alternate agent
    let failed_ids: Vec<usize> = session.tasks.iter()
        .filter(|t| round.task_ids.contains(&t.id) && t.status == TaskStatus::Failed && t.retry_count <= 2)
        .map(|t| t.id)
        .collect();

    for id in failed_ids {
        if let Some(t) = session.tasks.iter_mut().find(|t| t.id == id) {
            // Switch to alternate agent
            let alt = session.agents_available.iter()
                .find(|a| **a != t.agent)
                .cloned()
                .unwrap_or(t.agent.clone());
            eprintln!("  [retry] Task {} failed, switching to {}", id, alt);
            t.agent = alt;
            t.status = TaskStatus::Pending; // will be picked up in next round
        }
    }

    session.updated_at = now_ts();
    save_session(session)?;
    Ok(())
}

/// Parse violation text to extract identifier and file for surgical rewind.
fn parse_violation_target(violation: &str) -> Option<(String, String)> {
    // Patterns like "Forbidden Call: foo() in bar.rs" or "Layer Violation: module::func in src/lib.rs"
    let lower = violation.to_lowercase();
    // Look for "in <file>" pattern
    if let Some(in_idx) = lower.rfind(" in ") {
        let file_part = violation[in_idx + 4..].trim().to_string();
        // Extract identifier before "in"
        let before = violation[..in_idx].trim();
        // Take last word/identifier
        if let Some(ident) = before.split_whitespace().last() {
            let clean_ident = ident.trim_matches(|c: char| !c.is_alphanumeric() && c != '_');
            if !clean_ident.is_empty() && !file_part.is_empty() {
                return Some((clean_ident.to_string(), file_part));
            }
        }
    }
    None
}

/// Smart failure handling: try aura fix → surgical rewind → git reset
fn handle_duo_failure(base: &str, _git_ref: Option<&str>) -> bool {
    // Step 1: Try aura fix
    eprintln!("  [recovery] Running aura fix...");
    let _ = run_aura_fix(base);
    if let Ok((risk, violations, _)) = validate_wave(base) {
        if violations.is_empty() || risk < 70.0 {
            eprintln!("  [recovery] aura fix resolved the issues");
            return true;
        }

        // Step 2: Try surgical rewind on specific nodes
        eprintln!("  [recovery] Attempting surgical rewind...");
        let mut rewound = false;
        for violation in &violations {
            if let Some((ident, file)) = parse_violation_target(violation) {
                eprintln!("  [rewind] {} in {}", ident, file);
                let output = Command::new("aura")
                    .args(["rewind", &ident, &file])
                    .output();
                if let Ok(o) = output {
                    if o.status.success() { rewound = true; }
                }
            }
        }

        if rewound {
            if let Ok((risk2, violations2, _)) = validate_wave(base) {
                if violations2.is_empty() || risk2 < 70.0 {
                    eprintln!("  [recovery] Surgical rewind resolved the issues");
                    return true;
                }
            }
        }
    }

    // Step 3: Nuclear — git reset (handled by caller)
    false
}

/// Run `aura prove --goal` to verify the objective was achieved
fn prove_goal(objective: &str) -> Option<String> {
    eprintln!("  Proving goal: \"{}\"...", objective);
    let output = Command::new("aura")
        .args(["prove", "--goal", objective])
        .output();

    match output {
        Ok(o) if o.status.success() => {
            let result = String::from_utf8_lossy(&o.stdout).to_string();
            if result.to_lowercase().contains("not_proven") || result.to_lowercase().contains("not proven") {
                eprintln!("  ⚠ Goal not fully proven — manual verification recommended");
                Some("NOT_PROVEN".to_string())
            } else if result.to_lowercase().contains("partially") {
                eprintln!("  ~ Goal partially proven");
                Some("PARTIAL".to_string())
            } else {
                eprintln!("  ✓ Goal verified via AST proof");
                Some("PROVEN".to_string())
            }
        }
        Ok(o) => {
            let stderr = String::from_utf8_lossy(&o.stderr);
            eprintln!("  ⚠ Prove failed: {}", stderr.lines().next().unwrap_or("unknown error"));
            None
        }
        Err(e) => {
            eprintln!("  ⚠ Prove unavailable: {}", e);
            None
        }
    }
}

/// Main duo mode entry point.
pub fn run_duo(objective: &str, base: &str) -> Result<OrchestrationSession, String> {
    let available = report_agent_availability()?;

    let has_both = available.len() >= 2;

    // Phase 1: Generate initial handover context for planning
    eprintln!("Phase 1: Generating semantic context...");
    let handover = generate_handover();

    // Phase 2: Collaborative planning
    let agent_label = if has_both { "both agents".to_string() } else { available[0].to_string() };
    eprintln!("Phase 2: Planning — {} contributing...", agent_label);
    let tasks = collaborative_plan(objective, &available, &handover);

    eprintln!("  {} tasks planned, agents: {}", tasks.len(),
        available.iter().map(|a| a.to_string()).collect::<Vec<_>>().join(" + "));

    for t in &tasks {
        eprintln!("  Task {}: {} → {}{}", t.id, t.action, t.agent,
            if t.depends_on.is_empty() { String::new() } else { format!(" (after {:?})", t.depends_on) });
    }
    eprintln!();

    let mut session = OrchestrationSession {
        id: Uuid::new_v4().to_string(),
        objective: objective.to_string(),
        strategy: AssignmentStrategy::Smart,
        status: OrchestrationStatus::Running,
        waves: Vec::new(),
        current_wave: 0,
        created_at: now_ts(),
        updated_at: now_ts(),
        agents_available: available,
        mode: OrchestrateMode::Duo,
        tasks,
        rounds: Vec::new(),
        relay_log: Vec::new(),
        token_stats: None,
    };

    save_session(&session)?;

    let mut claude_sid: Option<String> = None;
    let mut round_id = 0;
    let max_rounds = 10;

    eprintln!("Phase 3: Executing rounds{}...\n",
        if has_both { " (parallel)" } else { "" });

    // Round-based execution loop
    loop {
        round_id += 1;
        if round_id > max_rounds {
            eprintln!("  Max rounds ({}) reached, stopping.", max_rounds);
            break;
        }

        // Refresh handover each round — AST graph changes between rounds
        let round_handover = if round_id == 1 {
            handover.clone()
        } else {
            eprintln!("  [context] Refreshing AST context...");
            generate_handover()
        };

        // Schedule next round
        let round = match schedule_next_round(&session.tasks, round_id) {
            Some(r) => r,
            None => break,
        };

        let task_count = round.task_ids.len();
        let agents_in_round: Vec<String> = round.task_ids.iter()
            .filter_map(|id| session.tasks.iter().find(|t| t.id == *id))
            .map(|t| t.agent.to_string())
            .collect::<std::collections::HashSet<_>>()
            .into_iter().collect();

        eprintln!("━━━ Round {} ━━━ {} task(s) ━━━ {} ━━━",
            round_id, task_count, agents_in_round.join(" + "));

        // Record git ref before round
        let _git_ref = get_git_head().ok();

        // Execute round (parallel)
        run_round_parallel(&mut session, &round, &round_handover, &mut claude_sid)?;

        // Store the round
        let completed_round = DuoRound {
            id: round_id,
            task_ids: round.task_ids.clone(),
            relay_context: build_relay_context(&session.tasks, &session.relay_log),
        };
        session.rounds.push(completed_round);

        // Report
        let done = session.tasks.iter().filter(|t| t.status == TaskStatus::Done).count();
        let total = session.tasks.len();
        let failed = session.tasks.iter().filter(|t| t.status == TaskStatus::Failed).count();
        eprintln!("  Round {} complete: {}/{} done, {} failed\n", round_id, done, total, failed);

        // If all tasks with retry_count > 2 have failed, bail
        let hard_fails = session.tasks.iter()
            .filter(|t| t.status == TaskStatus::Failed && t.retry_count > 2)
            .count();
        if hard_fails > 0 {
            eprintln!("  {} task(s) failed after retries, pausing.", hard_fails);
            session.status = OrchestrationStatus::Paused;
            break;
        }

        if session.status != OrchestrationStatus::Running {
            break;
        }
    }

    // Final validation with smart failure recovery
    if session.status == OrchestrationStatus::Running {
        eprintln!("Validating final state...");
        match validate_wave(base) {
            Ok((risk, violations, summary)) => {
                eprintln!("  {}", summary);
                if violations.is_empty() || risk < 70.0 {
                    session.status = OrchestrationStatus::Completed;
                } else {
                    // Try smart recovery before pausing
                    let git_ref = get_git_head().ok();
                    if handle_duo_failure(base, git_ref.as_deref()) {
                        session.status = OrchestrationStatus::Completed;
                    } else {
                        eprintln!("  Final validation failed — pausing for manual review.");
                        session.status = OrchestrationStatus::Paused;
                    }
                }
            }
            Err(e) => {
                eprintln!("  Validation error: {} — treating as complete", e);
                session.status = OrchestrationStatus::Completed;
            }
        }

        // Phase 4: Prove goal via AST
        if session.status == OrchestrationStatus::Completed {
            eprintln!("\nPhase 4: Verifying goal...");
            let _proof = prove_goal(objective);
        }
    }

    let done = session.tasks.iter().filter(|t| t.status == TaskStatus::Done).count();
    let total = session.tasks.len();
    eprintln!("\nOrchestration {:?} — {}/{} tasks done across {} rounds.",
        session.status, done, total, session.rounds.len());

    // Aggregate token stats
    let full_context_tokens = estimate_full_context_tokens();
    let handover_tokens = estimate_tokens(&handover);
    let mut stats = SessionTokenStats::default();

    for task in &session.tasks {
        if let Some(ref u) = task.usage {
            stats.total_input += u.input_tokens;
            stats.total_output += u.output_tokens;
            stats.total_tokens += u.total_tokens;
            stats.total_cost_usd += u.cost_usd;
            stats.tokens_saved_resume += u.saved_by_resume;
            match task.agent {
                AgentType::GeminiCli => {
                    stats.gemini_tokens += u.total_tokens;
                    stats.gemini_cost_usd += u.cost_usd;
                }
                AgentType::ClaudeCode => {
                    stats.claude_tokens += u.total_tokens;
                    stats.claude_cost_usd += u.cost_usd;
                }
            }
        }
    }

    // Calculate handover savings: per invocation, handover replaced full context
    let num_invocations = session.tasks.iter().filter(|t| t.usage.is_some()).count() as u64;
    if full_context_tokens > handover_tokens {
        stats.tokens_saved_handover = (full_context_tokens - handover_tokens) * num_invocations;
    }

    // Estimate without Aura: all tasks on Claude, no handover (full context each time)
    // Use the larger of: actual input tokens or full_context estimate per invocation
    let per_invocation_input = full_context_tokens.max(stats.total_input / num_invocations.max(1));
    stats.estimated_without_aura = per_invocation_input * num_invocations + stats.total_output;
    stats.estimated_cost_without_aura = calculate_cost(
        &AgentType::ClaudeCode,
        per_invocation_input * num_invocations,
        stats.total_output,
    );

    // Floor: at minimum, "without Aura" = same tokens but all at Claude pricing
    let all_claude_cost = calculate_cost(&AgentType::ClaudeCode, stats.total_input, stats.total_output);
    if stats.estimated_cost_without_aura < all_claude_cost {
        stats.estimated_cost_without_aura = all_claude_cost;
        stats.estimated_without_aura = stats.total_tokens;
    }

    if stats.estimated_cost_without_aura > 0.0 {
        stats.savings_pct = ((1.0 - stats.total_cost_usd / stats.estimated_cost_without_aura) * 100.0).max(0.0);
    }

    session.token_stats = Some(stats.clone());
    print_token_summary(&stats);

    if session.status == OrchestrationStatus::Completed || session.status == OrchestrationStatus::Cancelled {
        clear_active_pointer();
    }
    session.updated_at = now_ts();
    save_session(&session)?;
    Ok(session)
}
