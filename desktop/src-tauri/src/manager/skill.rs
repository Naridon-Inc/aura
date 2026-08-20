//! Cross-project Agent Skill Ledger.
//!
//! One row per closed Manager subagent task. Captures 5 signals
//! (exit/duration, user thumbs, pr-review pass, token cost, brain
//! self-eval grade) tagged across 4 taxonomy lenses (coarse_category,
//! fine_language, fine_layer, fine_intent + free tags + file paths +
//! file extensions) so the next plan in the same cell can auto-route
//! to the historically best provider.
//!
//! Storage is dual-write: cloud Postgres primary, local
//! `~/.aura/agent_skills.json` fallback. The local file is the source
//! of truth when offline; a 30s ticker reconciles dirty rows with the
//! cloud once it's reachable. See `flush_cloud()`.

use serde::{Deserialize, Serialize};

/// Coarse 6-category bucket. Matches the CHECK constraint in
/// `migrations/029_agent_skill_outcomes.sql`. Kebab-case on the wire so
/// the cloud `coarse_category` text column round-trips losslessly.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CoarseCategory {
    Frontend,
    Backend,
    Infra,
    Refactor,
    SecurityReview,
    ArchitectureReview,
}

impl CoarseCategory {
    pub fn as_str(&self) -> &'static str {
        match self {
            CoarseCategory::Frontend => "frontend",
            CoarseCategory::Backend => "backend",
            CoarseCategory::Infra => "infra",
            CoarseCategory::Refactor => "refactor",
            CoarseCategory::SecurityReview => "security-review",
            CoarseCategory::ArchitectureReview => "architecture-review",
        }
    }
}

impl Default for CoarseCategory {
    fn default() -> Self { CoarseCategory::Backend }
}

/// 4-lens taxonomy attached to every `SkillOutcome`. Free-form tags are
/// capped at 3 by callers (`derive_taxonomy`) so the GIN index stays
/// tight.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TaskTaxonomy {
    pub coarse_category: CoarseCategory,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fine_language: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fine_layer: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fine_intent: Option<String>,
    #[serde(default)]
    pub free_tags: Vec<String>,
    #[serde(default)]
    pub file_paths: Vec<String>,
    #[serde(default)]
    pub file_extensions: Vec<String>,
}

/// A single specialist's structured output, parsed from the closing
/// fenced JSON block. See `scout::parse_specialist_output`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScoutFinding {
    pub specialist: String,
    pub severity: Severity,
    pub title: String,
    pub body: String,
    #[serde(default)]
    pub file_refs: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Severity {
    Info,
    Warn,
    Block,
}

/// Auto-routing recommendation surfaced on a PendingPlanTodo when the
/// (user, taxonomy-cell) has ≥10 historical samples. PlanCard renders
/// it as a click-to-override badge.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillSuggestion {
    pub provider_id: String,
    pub score: f64,
    pub sample_count: u32,
}

/// Mid-flight skill outcome. Built incrementally as signals arrive:
/// exit/duration land at finalize_task; thumbs from TaskCard; pr-review
/// from a follow-up tokio::spawn; brain grade from the self-eval
/// grader. When all required signals are filled (or a per-signal
/// timeout fires) `into_complete` produces a `SkillOutcome`.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PartialSkillOutcome {
    pub provider_id: String,
    pub manager_session_id: String,
    pub manager_task_id: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub a2a_task_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    /// -1 thumbs-down, 0 unset, +1 thumbs-up. None = not yet rated.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_rating: Option<i8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pr_review_pass: Option<bool>,
    #[serde(default)]
    pub token_input: u64,
    #[serde(default)]
    pub token_output: u64,
    #[serde(default)]
    pub cost_usd: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub brain_quality_grade: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub brain_quality_reason: Option<String>,
    #[serde(default)]
    pub taxonomy: TaskTaxonomy,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scout_run_id: Option<String>,
    /// `owner/repo` slug for the repo this task ran in. Cloud best-effort
    /// resolves it to a `repo_id` for per-repo leaderboards; `None` =>
    /// NULL there. Captured from the git remote at finalize time.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repo: Option<String>,
    #[serde(default)]
    pub started_at: u64,
}

impl PartialSkillOutcome {
    /// True when every signal that should be captured has been. Brain
    /// grade is allowed to be `None` — the grader has its own timeout
    /// and we don't want to block on a degraded path.
    pub fn ready_for_write(&self) -> bool {
        self.exit_code.is_some() && self.duration_ms.is_some()
    }

    pub fn into_complete(self) -> SkillOutcome {
        SkillOutcome {
            provider_id: self.provider_id,
            manager_session_id: self.manager_session_id,
            manager_task_id: self.manager_task_id,
            a2a_task_id: self.a2a_task_id,
            exit_code: self.exit_code,
            duration_ms: self.duration_ms.unwrap_or(0),
            user_rating: self.user_rating.unwrap_or(0),
            pr_review_pass: self.pr_review_pass,
            token_input: self.token_input,
            token_output: self.token_output,
            cost_usd: self.cost_usd,
            brain_quality_grade: self.brain_quality_grade,
            brain_quality_reason: self.brain_quality_reason,
            taxonomy: self.taxonomy,
            scout_run_id: self.scout_run_id,
            repo: self.repo,
            created_at: now_ms(),
        }
    }
}

/// Wire-shape of a single ledger row. Mirrors the migration columns,
/// minus org_id / user_id / repo_id which the cloud handler resolves
/// from the auth token + repo binding at insert time. `created_at` is
/// captured locally so an offline write keeps its true timestamp once
/// flushed.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillOutcome {
    pub provider_id: String,
    pub manager_session_id: String,
    pub manager_task_id: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub a2a_task_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    pub duration_ms: u64,
    pub user_rating: i8,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pr_review_pass: Option<bool>,
    pub token_input: u64,
    pub token_output: u64,
    pub cost_usd: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub brain_quality_grade: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub brain_quality_reason: Option<String>,
    pub taxonomy: TaskTaxonomy,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scout_run_id: Option<String>,
    /// `owner/repo` slug for per-repo leaderboards; see
    /// `PartialSkillOutcome::repo`. Omitted from the wire when `None`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repo: Option<String>,
    /// Epoch ms.
    pub created_at: u64,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// -- Local fallback storage ----------------------------------------------

/// On-disk shape for `~/.aura/agent_skills.json`. `dirty` carries
/// indices into `outcomes` that haven't yet been confirmed by the
/// cloud. The 30s ticker reads this list, retries each row, and
/// removes the index on success.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct LocalSkillStore {
    #[serde(default)]
    pub outcomes: Vec<SkillOutcome>,
    #[serde(default)]
    pub dirty: Vec<usize>,
}

/// Path to the local store. Created lazily.
pub fn local_store_path() -> std::path::PathBuf {
    let home = std::env::var("HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::path::PathBuf::from("."));
    home.join(".aura").join("agent_skills.json")
}

/// Load local store, returning `Default::default()` if absent or
/// unreadable. Same tolerance pattern as `manager/persist.rs`.
pub fn load_local() -> LocalSkillStore {
    let path = local_store_path();
    let raw = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(_) => return LocalSkillStore::default(),
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

/// Atomic-tempfile rename. Mirrors `manager/persist.rs:28`. Errors are
/// returned but typically logged-and-swallowed by the caller — losing a
/// telemetry row is preferable to crashing a Manager session.
pub fn save_local(store: &LocalSkillStore) -> std::io::Result<()> {
    let path = local_store_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let body = serde_json::to_string_pretty(store)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
    let tmp_name = format!(
        ".tmp-agent_skills-{}.json",
        std::process::id()
    );
    let tmp = path.with_file_name(tmp_name);
    std::fs::write(&tmp, body)?;
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

/// Append an outcome to the local store and mark it dirty so the
/// flush ticker picks it up.
pub fn append_local(outcome: SkillOutcome) -> std::io::Result<()> {
    let mut store = load_local();
    let idx = store.outcomes.len();
    store.outcomes.push(outcome);
    store.dirty.push(idx);
    save_local(&store)
}

/// Try to push every dirty row to the cloud via `aura skill record`.
/// On 200 OK, drop from `dirty`. Failures stay dirty for the next
/// flush. Bounded — caps at 50 attempts per tick to avoid stalling the
/// session loop on a long offline period.
pub fn flush_cloud() {
    let mut store = load_local();
    if store.dirty.is_empty() {
        return;
    }
    let dirty: Vec<usize> = store.dirty.iter().copied().take(50).collect();
    let mut still_dirty: Vec<usize> = store.dirty.iter().copied().skip(50).collect();
    for idx in dirty {
        let outcome = match store.outcomes.get(idx) {
            Some(o) => o.clone(),
            None => continue,
        };
        let body = match serde_json::to_string(&outcome) {
            Ok(s) => s,
            Err(_) => {
                still_dirty.push(idx);
                continue;
            }
        };
        let out = std::process::Command::new(crate::agent_event_listener::resolve_aura_bin())
            .args(["skill", "record", "--json", &body])
            .output();
        match out {
            Ok(o) if o.status.success() => {
                // dropped from dirty
            }
            _ => {
                still_dirty.push(idx);
            }
        }
    }
    store.dirty = still_dirty;
    let _ = save_local(&store);
}

// -- Todo annotation -----------------------------------------------------

/// Bucket G2 — annotate each todo in a list with its
/// `suggested_provider` based on the (description, file_refs)
/// taxonomy. Called from both the Scout finalize path and the direct
/// `set_pending_plan` path so the badge is consistent across both
/// flows. Below-threshold cells (n<10) leave `suggested_provider`
/// unset; the brain's original `agent` pick remains the dispatch
/// choice.
pub fn annotate_todos_with_suggestions(todos: &mut [crate::manager::PendingPlanTodo]) {
    for todo in todos {
        let taxonomy = derive_taxonomy(&todo.description, &todo.file_refs, &[]);
        if let Some(suggestion) = suggest_provider(&taxonomy) {
            todo.suggested_provider = Some(suggestion);
        }
    }
}

// -- Provider suggestion -------------------------------------------------

/// Shells `aura skill suggest --json` for the given taxonomy cell and
/// returns the historically best provider when the cloud has enough
/// evidence (n≥10), otherwise `None`.
///
/// The ranking formula (`score = q·pr / (1+cost)`, n≥10 threshold) lives
/// in **one** place now — `aura-cli/src/skill_rank.rs`, behind the
/// `aura skill suggest` subcommand. The shell used to carry its own copy
/// (`rank_providers` + a `stats`-shaped parse), which (a) drifted from
/// the CLI and (b) was outright broken: it parsed `aura skill stats`
/// stdout as a bare array, but the cloud emits `{ "rows": [ … ] }`, so
/// the parse always failed and the suggestion was always `None`. Shelling
/// the canonical ranker fixes both: identical scoring everywhere, and a
/// single `{provider_id,score,sample_count}` object (or `null`) to parse.
pub fn suggest_provider(taxonomy: &TaskTaxonomy) -> Option<SkillSuggestion> {
    let mut args: Vec<String> = vec![
        "skill".into(),
        "suggest".into(),
        "--category".into(),
        taxonomy.coarse_category.as_str().into(),
        "--json".into(),
    ];
    if let Some(lang) = &taxonomy.fine_language {
        args.push("--language".into());
        args.push(lang.clone());
    }
    if let Some(layer) = &taxonomy.fine_layer {
        args.push("--layer".into());
        args.push(layer.clone());
    }
    let out = std::process::Command::new(crate::agent_event_listener::resolve_aura_bin())
        .args(&args)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let trimmed = stdout.trim();
    // The CLI prints the literal `null` when no provider clears the
    // sample threshold; treat that (and an empty body) as "no suggestion".
    if trimmed.is_empty() || trimmed == "null" {
        return None;
    }
    serde_json::from_str::<SkillSuggestion>(trimmed).ok()
}

// -- Taxonomy derivation -------------------------------------------------

/// Map a file extension to a coarse language label. Only well-known
/// extensions are mapped; unknown extensions fall through to `None` so
/// the language column stays NULL rather than carrying noise.
fn extension_to_language(ext: &str) -> Option<&'static str> {
    match ext.to_ascii_lowercase().as_str() {
        "ts" | "tsx" => Some("typescript"),
        "js" | "jsx" | "mjs" | "cjs" => Some("javascript"),
        "rs" => Some("rust"),
        "py" => Some("python"),
        "go" => Some("go"),
        "sql" => Some("sql"),
        "css" | "scss" | "less" => Some("css"),
        "html" | "htm" => Some("html"),
        "json" => Some("json"),
        "toml" => Some("toml"),
        "yaml" | "yml" => Some("yaml"),
        "sh" | "bash" | "zsh" => Some("shell"),
        "swift" => Some("swift"),
        "kt" | "kts" => Some("kotlin"),
        "java" => Some("java"),
        "md" => Some("markdown"),
        _ => None,
    }
}

/// Path-prefix → layer mapping. Order matters: more specific prefixes
/// are checked before broad ones.
fn path_to_layer(path: &str) -> Option<&'static str> {
    if path.starts_with("aura-cloud/migrations/") || path.contains("/migrations/") || path.ends_with(".sql") {
        return Some("db");
    }
    if path.contains("/src/components/") || path.contains("aura-shell/src/") {
        return Some("ui");
    }
    if path.contains("aura-shell/src-tauri/src/cmd_") || path.contains("aura-cloud/src/") {
        return Some("api");
    }
    if path.starts_with("aura-cli/") || path.starts_with("aura/") {
        return Some("cli");
    }
    None
}

/// First imperative verb in the task description maps to fine_intent.
fn description_to_intent(desc: &str) -> Option<&'static str> {
    let lower = desc.trim().to_ascii_lowercase();
    let first_word = lower.split_whitespace().next().unwrap_or("");
    match first_word {
        "add" => Some("add"),
        "fix" => Some("fix"),
        "refactor" => Some("refactor"),
        "review" => Some("review"),
        "update" => Some("update"),
        "remove" | "delete" => Some("remove"),
        "test" => Some("test"),
        "doc" | "docs" | "document" => Some("docs"),
        _ => None,
    }
}

/// Derive a 4-lens taxonomy from the captured task data. Caller holds
/// the `description`, the list of `zones` (file paths the task claims
/// to touch), and any free-form tags inherited from the parent plan.
pub fn derive_taxonomy(
    description: &str,
    zones: &[String],
    parent_tags: &[String],
) -> TaskTaxonomy {
    let lower_desc = description.to_ascii_lowercase();
    let extensions: Vec<String> = zones
        .iter()
        .filter_map(|p| {
            std::path::Path::new(p)
                .extension()
                .and_then(|e| e.to_str())
                .map(|s| s.to_ascii_lowercase())
        })
        .collect();

    // coarse_category: explicit description verbs first, then file shape.
    let coarse_category = if lower_desc.starts_with("refactor") {
        CoarseCategory::Refactor
    } else if lower_desc.contains("security review") {
        CoarseCategory::SecurityReview
    } else if lower_desc.contains("architecture review") || lower_desc.contains("arch review") {
        CoarseCategory::ArchitectureReview
    } else if extensions.iter().any(|e| matches!(e.as_str(), "sql"))
        || zones.iter().any(|p| p.contains("/migrations/"))
    {
        CoarseCategory::Infra
    } else if extensions.iter().any(|e| matches!(e.as_str(), "tsx" | "jsx" | "css" | "scss"))
        || zones.iter().any(|p| p.contains("/src/components/"))
    {
        CoarseCategory::Frontend
    } else if extensions.iter().any(|e| matches!(e.as_str(), "rs" | "go" | "py" | "java"))
        || zones.iter().any(|p| p.contains("aura-cloud/src/") || p.contains("src-tauri/"))
    {
        CoarseCategory::Backend
    } else {
        CoarseCategory::Backend
    };

    // fine_language: mode of the extension histogram.
    let fine_language = mode_extension(&extensions)
        .and_then(|ext| extension_to_language(&ext))
        .map(|s| s.to_string());

    // fine_layer: first matching path prefix.
    let fine_layer = zones
        .iter()
        .find_map(|p| path_to_layer(p))
        .map(|s| s.to_string());

    let fine_intent = description_to_intent(description).map(|s| s.to_string());

    let mut free_tags: Vec<String> = parent_tags.iter().take(3).cloned().collect();
    free_tags.dedup();

    TaskTaxonomy {
        coarse_category,
        fine_language,
        fine_layer,
        fine_intent,
        free_tags,
        file_paths: zones.to_vec(),
        file_extensions: extensions,
    }
}

fn mode_extension(extensions: &[String]) -> Option<String> {
    let mut counts: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();
    for e in extensions {
        *counts.entry(e.as_str()).or_default() += 1;
    }
    counts
        .into_iter()
        .max_by_key(|(_, n)| *n)
        .map(|(k, _)| k.to_string())
}

// -- Token usage trailer -------------------------------------------------

/// Parses the trailing `[usage] input=X output=Y cost=$Z` line that
/// `aura orchestrate` and the agent CLIs emit at the end of a run.
/// Returns `None` if no usage line was emitted (cell will record
/// zeros and dashboards will show "cost unknown").
pub fn parse_usage_trailer(captured: &str) -> Option<(u64, u64, f64)> {
    let last_usage_line = captured
        .lines()
        .rev()
        .find(|l| l.contains("[usage]") && l.contains("input=") && l.contains("output="))?;
    let input = parse_usage_field(last_usage_line, "input=")?;
    let output = parse_usage_field(last_usage_line, "output=")?;
    let cost = parse_cost_field(last_usage_line).unwrap_or(0.0);
    Some((input, output, cost))
}

fn parse_usage_field(line: &str, prefix: &str) -> Option<u64> {
    let idx = line.find(prefix)?;
    let tail = &line[idx + prefix.len()..];
    let num: String = tail.chars().take_while(|c| c.is_ascii_digit()).collect();
    num.parse().ok()
}

fn parse_cost_field(line: &str) -> Option<f64> {
    let idx = line.find("cost=$")?;
    let tail = &line[idx + "cost=$".len()..];
    let num: String = tail.chars().take_while(|c| c.is_ascii_digit() || *c == '.').collect();
    num.parse().ok()
}

// -- PR review pass (Bucket F3) -----------------------------------------

/// Best-effort: shell `aura pr-review --base <base> --json` inside a
/// task's worktree, parse the verdict, return `Some(pass)`. Pass is
/// defined as `risk_label == "LOW"` — anything moderate or critical
/// counts as a fail signal. Cap the wait at 60s so a long review can't
/// stall the skill commit forever; on timeout / spawn failure / parse
/// failure return `None` and the row will write `pr_review_pass: NULL`.
///
/// `worktree_path` is the cwd we run inside. `base_branch` is the
/// compare base — we let the caller decide because the brain knows
/// whether the task branched from `main`, `master`, or a feature
/// stack.
pub async fn pr_review_for_branch(
    worktree_path: &str,
    base_branch: &str,
) -> Option<bool> {
    let mut cmd = tokio::process::Command::new(crate::agent_event_listener::resolve_aura_bin());
    cmd.args(["pr-review", "--base", base_branch, "--json"])
        .current_dir(worktree_path)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let fut = async move { cmd.output().await };
    let output = match tokio::time::timeout(std::time::Duration::from_secs(60), fut).await {
        Ok(Ok(o)) => o,
        _ => return None,
    };
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let json: serde_json::Value = serde_json::from_str(stdout.trim()).ok()?;
    let label = json.get("risk_label").and_then(|v| v.as_str())?;
    Some(label.eq_ignore_ascii_case("LOW"))
}

// -- Brain self-eval grade (Bucket F5) ----------------------------------

/// System prompt the grader sees. `claude -p` returns a fenced JSON
/// block; we parse only `{"grade": 1..5, "reason": "..."}`. Cost +
/// time aren't inputs to the grade — they're tracked separately.
const GRADER_SYSTEM_PROMPT: &str = r#"You are Aura's quality grader, and you are skeptical by default. You receive ONE completed subagent task:
description, claimed files, captured stdout, exit code, PR-review verdict.

Verifying is not approving. Judge the work against what the description actually asked for — not against whether it merely ran or claimed to finish. A confident-sounding log that doesn't deliver the requested change is a low grade. Make the evidence earn each point; do not rubber-stamp.

Grade the output 1-5:
  5 = Outstanding. Exactly what was asked, no over-reach, idiomatic, tests pass,
      no TODOs left, intent log entry matches diff.
  4 = Good. Done correctly; minor noise (stray prints, slightly verbose comments).
  3 = Acceptable. Done with caveats: missing edge case, one retry needed, or a
      non-load-bearing TODO planted.
  2 = Weak. Partial completion, lints failing, or churn from second-guessing.
  1 = Bad. Wrong file edited, deletion-guard tripped, exit non-zero without
      clear reason, or commit blocked.

Output ONLY a fenced ```json``` block:
  { "grade": <1-5>, "reason": "<one sentence, ≤200 chars>" }

Be ruthless. Give the honest grade, and make the reason point at the specific
evidence behind it, not a generic platitude. Cost and time are NOT inputs —
they're scored separately. Score the WORK itself."#;

/// Build the user-message payload for the grader. Captured output is
/// truncated to 8 KB from the tail (most recent → most decision-relevant
/// for whether the task closed cleanly).
pub fn build_grader_user_prompt(
    description: &str,
    zones: &[String],
    exit_code: Option<i32>,
    duration_ms: u64,
    pr_review_pass: Option<bool>,
    captured: &str,
) -> String {
    const CAPTURE_CAP: usize = 8 * 1024;
    let captured_tail: String = if captured.len() > CAPTURE_CAP {
        captured[captured.len() - CAPTURE_CAP..].to_string()
    } else {
        captured.to_string()
    };
    let exit_str = match exit_code {
        Some(c) => c.to_string(),
        None => "spawn-failed".into(),
    };
    let pr_str = match pr_review_pass {
        Some(true) => "pass",
        Some(false) => "fail",
        None => "n/a",
    };
    format!(
        "--- Description: {description}\n\
         --- Files claimed: {zones}\n\
         --- Exit code: {exit_str}    Duration: {duration_ms}ms    PR review: {pr_str}\n\
         --- Captured output (last 8KB):\n\
         {captured_tail}",
        description = description,
        zones = zones.join(", "),
        exit_str = exit_str,
        duration_ms = duration_ms,
        pr_str = pr_str,
        captured_tail = captured_tail,
    )
}

/// Spawn `claude -p` with a combined system+user prompt; 60s timeout;
/// parse the closing fenced ```json``` block for `{grade, reason}`.
/// Returns `None` on timeout / spawn failure / parse failure (the row
/// writes `brain_quality_grade: NULL` with reason `"grader timeout"`
/// at the call site so the column-level reason is preserved).
pub async fn grade_brain(
    description: &str,
    zones: &[String],
    exit_code: Option<i32>,
    duration_ms: u64,
    pr_review_pass: Option<bool>,
    captured: &str,
) -> Option<(u8, String)> {
    let user_prompt = build_grader_user_prompt(
        description,
        zones,
        exit_code,
        duration_ms,
        pr_review_pass,
        captured,
    );
    let combined = format!("{GRADER_SYSTEM_PROMPT}\n\n{user_prompt}");

    let mut cmd = tokio::process::Command::new("claude");
    cmd.args(["-p", &combined])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let fut = async move { cmd.output().await };
    let output = match tokio::time::timeout(std::time::Duration::from_secs(60), fut).await {
        Ok(Ok(o)) => o,
        _ => return None,
    };
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    parse_grader_output(&stdout)
}

/// Extracts the *last* fenced ```json``` block from `claude -p`
/// stdout — Claude often narrates above the block, so always pick the
/// trailing one. Returns `None` if no parseable block is found.
pub fn parse_grader_output(stdout: &str) -> Option<(u8, String)> {
    let last_open = stdout.rfind("```json")?;
    let after_open = &stdout[last_open + "```json".len()..];
    let close = after_open.find("```")?;
    let body = after_open[..close].trim();
    let v: serde_json::Value = serde_json::from_str(body).ok()?;
    let grade = v.get("grade").and_then(|g| g.as_i64()).filter(|g| (1..=5).contains(g))? as u8;
    let reason = v
        .get("reason")
        .and_then(|r| r.as_str())
        .unwrap_or("")
        .to_string();
    Some((grade, reason))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn taxonomy_frontend_typescript_ui_add() {
        let t = derive_taxonomy(
            "Add login button",
            &["aura-shell/src/components/Login.tsx".to_string()],
            &[],
        );
        assert_eq!(t.coarse_category, CoarseCategory::Frontend);
        assert_eq!(t.fine_language.as_deref(), Some("typescript"));
        assert_eq!(t.fine_layer.as_deref(), Some("ui"));
        assert_eq!(t.fine_intent.as_deref(), Some("add"));
    }

    #[test]
    fn taxonomy_backend_rust_api_refactor() {
        let t = derive_taxonomy(
            "Refactor command socket handler",
            &["aura-shell/src-tauri/src/cmd_manager.rs".to_string()],
            &["wave-a".to_string()],
        );
        assert_eq!(t.coarse_category, CoarseCategory::Refactor);
        assert_eq!(t.fine_language.as_deref(), Some("rust"));
        assert_eq!(t.fine_layer.as_deref(), Some("api"));
        assert_eq!(t.free_tags, vec!["wave-a".to_string()]);
    }

    #[test]
    fn taxonomy_infra_sql() {
        let t = derive_taxonomy(
            "Add migration for skill ledger",
            &["aura-cloud/migrations/029_agent_skill_outcomes.sql".to_string()],
            &[],
        );
        assert_eq!(t.coarse_category, CoarseCategory::Infra);
        assert_eq!(t.fine_layer.as_deref(), Some("db"));
        assert_eq!(t.fine_language.as_deref(), Some("sql"));
    }

    #[test]
    fn parse_usage_trailer_works() {
        let captured = "doing things\n[usage] input=1234 output=567 cost=$0.0234\nmore output\n";
        let (i, o, c) = parse_usage_trailer(captured).unwrap();
        assert_eq!(i, 1234);
        assert_eq!(o, 567);
        assert!((c - 0.0234).abs() < 1e-9);
    }

    #[test]
    fn parse_usage_trailer_missing_returns_none() {
        let captured = "no usage here at all\n";
        assert!(parse_usage_trailer(captured).is_none());
    }

    #[test]
    fn parse_grader_output_picks_last_block() {
        let stdout = r#"
Here's some narration.

```json
{ "grade": 2, "reason": "first attempt" }
```

Actually, on reflection:

```json
{ "grade": 4, "reason": "Looks idiomatic; one stray println but exit 0." }
```
"#;
        let (g, r) = parse_grader_output(stdout).unwrap();
        assert_eq!(g, 4);
        assert!(r.contains("idiomatic"));
    }

    #[test]
    fn parse_grader_output_rejects_out_of_range() {
        let stdout = "```json\n{\"grade\": 7, \"reason\": \"too high\"}\n```";
        assert!(parse_grader_output(stdout).is_none());
    }

    #[test]
    fn parse_grader_output_handles_no_block() {
        assert!(parse_grader_output("no json here").is_none());
    }

    #[test]
    fn build_grader_user_prompt_truncates_capture_tail() {
        let big = "x".repeat(20_000);
        let prompt = build_grader_user_prompt(
            "do thing",
            &["src/foo.rs".into()],
            Some(0),
            1234,
            Some(true),
            &big,
        );
        // The captured-output section should be capped at ~8KB plus the
        // header/labels prelude. Grow a little above 8192 to allow for
        // the prelude.
        assert!(prompt.len() < 9000, "prompt too large: {}", prompt.len());
        assert!(prompt.contains("PR review: pass"));
    }
}
