use crate::config::ConfigManager;
use crate::plugins::cost_reporter::{breakdown_for, calculate_session_cost};
use crate::session::{AgentSession, SessionManager, SessionPhase};
use colored::Colorize;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

// ── Budget configuration ────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct BudgetConfig {
    /// Daily spend cap in USD (0 = unlimited)
    pub daily_cap_usd: f64,
    /// Weekly spend cap in USD (0 = unlimited)
    pub weekly_cap_usd: f64,
    /// Per-session spend cap in USD (0 = unlimited)
    pub session_cap_usd: f64,
    /// Warn at this percentage of the cap (e.g. 0.8 = 80%)
    pub warn_at_pct: f64,
}

impl Default for BudgetConfig {
    fn default() -> Self {
        Self {
            daily_cap_usd: 0.0,
            weekly_cap_usd: 0.0,
            session_cap_usd: 0.0,
            warn_at_pct: 0.8,
        }
    }
}

// ── Aggregated usage report ─────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct UsageReport {
    pub period_label: String,
    pub sessions: Vec<SessionCost>,
    pub total_input_tokens: u64,
    pub total_output_tokens: u64,
    pub total_cache_read: u64,
    pub total_cost: f64,
    pub by_model: HashMap<String, ModelUsage>,
    pub by_day: Vec<DayUsage>,
    pub by_project: Vec<ProjectUsage>,
    /// Measured provider usage in this window that the sessions above do not
    /// account for: work done outside an Aura session, before any session
    /// started in that checkout, or under a session too old to be listed here.
    ///
    /// It is the measured total minus what this report shows, so the two
    /// always add up to what the provider actually recorded. Carried so the
    /// report can name what it could not attribute rather than quietly
    /// understating the machine's spend by exactly that much.
    pub unattributed_input_tokens: u64,
    pub unattributed_output_tokens: u64,
    /// Tokens written into the cache in this window.
    pub total_cache_creation: u64,
    /// What the cache traffic above cost. Part of `total_cost`, carried
    /// separately because "the cache is most of your bill" is the single
    /// most useful thing this report can tell someone.
    pub total_cache_cost: f64,
    /// Priced from [`crate::usage_attrib`]'s per-model measured totals:
    /// everything the provider recorded on this machine in the window,
    /// whether or not a session claimed it.
    pub measured_cost_usd: f64,
    /// `measured_cost_usd` minus what the sessions above account for.
    ///
    /// The token counts beside it said *how much* went unclaimed but
    /// never what it cost, which left the one number the reader came for
    /// missing from the only line that admitted the report is partial.
    pub unattributed_cost_usd: f64,
    /// Whether this report covers one project or every project on the
    /// machine. The reader cannot tell a small bill from a narrow window
    /// without it.
    pub project_scoped: bool,
}

/// Everything the total does and does not include, in the order a reader
/// needs it.
///
/// The report printed a dollar figure and left every one of these to be
/// guessed at: whether it is an invoice (it is not), whose machine it
/// covers (this one), and which tools it can see (the ones that write a
/// Claude Code transcript). A cost report that does not say what it
/// measured is not being read, it is being trusted — and it was wrong in
/// at least three directions at once.
pub fn measurement_notes(report: &UsageReport) -> Vec<String> {
    let mut notes = Vec::new();
    notes.push(format!(
        "Counts every Claude Code turn recorded on this machine{}, priced at published list rates.",
        if report.project_scoped {
            " for this project"
        } else {
            ""
        }
    ));
    notes.push(
        "Not a bill: a subscription plan, credits or negotiated rates charge differently."
            .to_string(),
    );
    notes.push(
        "Cannot see: other machines, other coding tools, or a turn no transcript recorded."
            .to_string(),
    );
    if report.unattributed_cost_usd > 0.0 {
        notes.push(format!(
            "{} of the measured {} belongs to no session listed here.",
            format_money(report.unattributed_cost_usd),
            format_money(report.measured_cost_usd),
        ));
    }
    notes
}

/// Money, rounded to where it stops being noise. Sub-cent figures keep
/// four places so a cheap session does not read as free.
fn format_money(usd: f64) -> String {
    if usd > 0.0 && usd < 0.01 {
        format!("${:.4}", usd)
    } else {
        format!("${:.2}", usd)
    }
}

#[derive(Debug, Clone)]
pub struct SessionCost {
    pub session_id: String,
    pub agent_id: String,
    pub model: String,
    pub project: String,
    pub started_at: u64,
    pub duration_secs: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub api_calls: u32,
    /// Everything this session cost, cache traffic included.
    pub cost_usd: f64,
    /// The part of `cost_usd` that is cache reads and writes.
    pub cache_cost_usd: f64,
    pub cache_read_tokens: u64,
    pub files_touched: usize,
    pub phase: String,
}

#[derive(Debug, Clone)]
pub struct ProjectUsage {
    pub project: String,
    pub cost_usd: f64,
    pub sessions: u32,
    pub tokens: u64,
}

#[derive(Debug, Clone, Default)]
pub struct ModelUsage {
    pub model: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cost_usd: f64,
    pub session_count: u32,
}

#[derive(Debug, Clone)]
pub struct DayUsage {
    pub date: String, // YYYY-MM-DD
    pub cost_usd: f64,
    pub sessions: u32,
    pub tokens: u64,
}

// ── Budget alert ────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct BudgetAlert {
    pub scope: String,     // "daily", "weekly", "session"
    pub spent: f64,
    pub cap: f64,
    pub is_exceeded: bool, // over the cap
    pub is_warning: bool,  // over warn threshold
}

// ── Core logic ──────────────────────────────────────────────────────────────

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

pub(crate) fn secs_to_date(ts: u64) -> String {
    // Simple date without chrono dependency: YYYY-MM-DD
    // We use the same approach as session.rs
    let days_since_epoch = ts / 86400;
    // Approximate — good enough for grouping
    let mut y = 1970i64;
    let mut remaining = days_since_epoch as i64;
    loop {
        let days_in_year = if y % 4 == 0 && (y % 100 != 0 || y % 400 == 0) {
            366
        } else {
            365
        };
        if remaining < days_in_year {
            break;
        }
        remaining -= days_in_year;
        y += 1;
    }
    let leap = y % 4 == 0 && (y % 100 != 0 || y % 400 == 0);
    let month_days = [
        31,
        if leap { 29 } else { 28 },
        31, 30, 31, 30, 31, 31, 30, 31, 30, 31,
    ];
    let mut m = 0usize;
    for (i, &days) in month_days.iter().enumerate() {
        if remaining < days as i64 {
            m = i;
            break;
        }
        remaining -= days as i64;
    }
    format!("{:04}-{:02}-{:02}", y, m + 1, remaining + 1)
}

fn session_to_cost(s: &AgentSession) -> SessionCost {
    let model = s
        .model_name
        .as_deref()
        .unwrap_or("claude-sonnet")
        .to_string();

    let (input_tokens, output_tokens, api_calls, cache_read, cache_created) = s
        .token_usage
        .as_ref()
        .map(|u| {
            (
                u.input_tokens,
                u.output_tokens,
                u.api_call_count,
                u.cache_read_tokens,
                u.cache_creation_tokens,
            )
        })
        .unwrap_or((0, 0, 0, 0, 0));

    // Priced by the same function that prices a single session on screen,
    // rather than by a second copy of the arithmetic that sat here and had
    // already drifted: this one charges for cache traffic, and the copy it
    // replaces did not. A session whose every token came from cache — most
    // of a long one — was reported as costing exactly nothing.
    let breakdown = breakdown_for(&model, input_tokens, output_tokens, cache_read, cache_created);

    let duration_secs = if s.last_activity > s.started_at {
        s.last_activity - s.started_at
    } else {
        0
    };

    let phase = match s.phase {
        SessionPhase::Active => "active",
        SessionPhase::Idle => "idle",
        SessionPhase::Ended => "ended",
    };

    // Derive project name: prefer explicit field, fall back to worktree path
    let project = s.project.clone().unwrap_or_else(|| {
        s.worktree
            .as_deref()
            .and_then(|w| std::path::Path::new(w).file_name())
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "unknown".to_string())
    });

    SessionCost {
        session_id: s.session_id.clone(),
        agent_id: s.agent_id.clone(),
        model,
        project,
        started_at: s.started_at,
        duration_secs,
        input_tokens,
        output_tokens,
        api_calls,
        cost_usd: breakdown.total_cost,
        cache_cost_usd: breakdown.cache_cost,
        cache_read_tokens: cache_read,
        files_touched: s.files_touched.len(),
        phase: phase.to_string(),
    }
}

/// Read sessions from the global ~/.aura/usage/ directory (cross-project)
fn list_global_sessions() -> Vec<AgentSession> {
    let home = match std::env::var("HOME") {
        Ok(h) => h,
        Err(_) => return Vec::new(),
    };
    let global_dir = format!("{}/.aura/usage", home);
    let mut sessions = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&global_dir) {
        for entry in entries.flatten() {
            if entry.path().extension().map(|x| x == "json").unwrap_or(false) {
                if let Ok(content) = std::fs::read_to_string(entry.path()) {
                    if let Ok(session) = serde_json::from_str::<AgentSession>(&content) {
                        sessions.push(session);
                    }
                }
            }
        }
    }
    sessions.sort_by(|a, b| b.started_at.cmp(&a.started_at));
    sessions
}

/// Build a usage report for sessions within a time window.
/// If `project_only` is true, reads from local .aura/sessions/ (current repo).
/// If false, reads from ~/.aura/usage/ (all projects on this machine).
pub fn build_report(since_secs: u64, label: &str) -> UsageReport {
    build_report_scoped(since_secs, label, false)
}

pub fn build_report_project(since_secs: u64, label: &str) -> UsageReport {
    build_report_scoped(since_secs, label, true)
}

fn build_report_scoped(since_secs: u64, label: &str, project_only: bool) -> UsageReport {
    let mut sessions = if project_only {
        SessionManager::list_sessions()
    } else {
        let global = list_global_sessions();
        if global.is_empty() {
            // Fallback: if no global data yet, use local
            SessionManager::list_sessions()
        } else {
            global
        }
    };
    let cutoff = now_secs().saturating_sub(since_secs);

    // Sessions record everything about themselves except what they spent. The
    // provider's own per-turn counts are on disk beside them and were never
    // read, so this report answered `$0.00` for a machine spending real money.
    // Join them on before anything is totalled — see [`crate::usage_attrib`].
    let attribution = crate::usage_attrib::fill(&mut sessions, cutoff);

    let filtered: Vec<&AgentSession> = sessions
        .iter()
        .filter(|s| s.started_at >= cutoff)
        .collect();

    let mut by_model: HashMap<String, ModelUsage> = HashMap::new();
    let mut by_day_map: HashMap<String, DayUsage> = HashMap::new();
    let mut by_project_map: HashMap<String, ProjectUsage> = HashMap::new();
    let mut total_input = 0u64;
    let mut total_output = 0u64;
    let mut total_cache = 0u64;
    let mut total_cache_created = 0u64;
    let mut total_cache_cost = 0.0f64;
    let mut total_cost = 0.0f64;
    let mut session_costs = Vec::new();

    for s in &filtered {
        let sc = session_to_cost(s);

        total_input += sc.input_tokens;
        total_output += sc.output_tokens;
        total_cost += sc.cost_usd;
        total_cache_cost += sc.cache_cost_usd;
        if let Some(u) = s.token_usage.as_ref() {
            total_cache += u.cache_read_tokens;
            total_cache_created += u.cache_creation_tokens;
        }

        // Aggregate by model
        let entry = by_model
            .entry(sc.model.clone())
            .or_insert_with(|| ModelUsage {
                model: sc.model.clone(),
                ..Default::default()
            });
        entry.input_tokens += sc.input_tokens;
        entry.output_tokens += sc.output_tokens;
        entry.cost_usd += sc.cost_usd;
        entry.session_count += 1;

        // Aggregate by day
        let date = secs_to_date(s.started_at);
        let day = by_day_map.entry(date.clone()).or_insert_with(|| DayUsage {
            date,
            cost_usd: 0.0,
            sessions: 0,
            tokens: 0,
        });
        day.cost_usd += sc.cost_usd;
        day.sessions += 1;
        day.tokens += sc.input_tokens + sc.output_tokens;

        // Aggregate by project
        let proj = by_project_map
            .entry(sc.project.clone())
            .or_insert_with(|| ProjectUsage {
                project: sc.project.clone(),
                cost_usd: 0.0,
                sessions: 0,
                tokens: 0,
            });
        proj.cost_usd += sc.cost_usd;
        proj.sessions += 1;
        proj.tokens += sc.input_tokens + sc.output_tokens;

        session_costs.push(sc);
    }

    let mut by_day: Vec<DayUsage> = by_day_map.into_values().collect();
    by_day.sort_by(|a, b| a.date.cmp(&b.date));

    let mut by_project: Vec<ProjectUsage> = by_project_map.into_values().collect();
    by_project.sort_by(|a, b| b.cost_usd.partial_cmp(&a.cost_usd).unwrap_or(std::cmp::Ordering::Equal));

    // What the provider recorded in this window, priced per model. The
    // split matters: totalling everything and pricing it at one rate would
    // be wrong by up to 5x depending on the day's mix.
    let measured_cost_usd = price_by_model(&attribution.measured_by_model);

    UsageReport {
        period_label: label.to_string(),
        sessions: session_costs,
        total_input_tokens: total_input,
        total_output_tokens: total_output,
        total_cache_read: total_cache,
        total_cost,
        by_model,
        by_day,
        by_project,
        unattributed_input_tokens: attribution
            .measured
            .input_tokens
            .saturating_sub(total_input),
        unattributed_output_tokens: attribution
            .measured
            .output_tokens
            .saturating_sub(total_output),
        total_cache_creation: total_cache_created,
        total_cache_cost,
        measured_cost_usd,
        // Clamped rather than signed. The two halves are priced from
        // different records — the sessions from what each recorded about
        // itself, the measured total from the transcripts — so a session
        // carrying a model name the transcripts spell differently can put
        // the subtraction slightly the wrong way. A negative gap would
        // read as a refund, which it is not; zero says "nothing missing",
        // which is the honest reading of a difference that small.
        unattributed_cost_usd: (measured_cost_usd - total_cost).max(0.0),
        project_scoped: project_only,
    }
}

/// Whether an already-built report can answer the daily cap.
///
/// Only one that covers what the cap covers: the whole machine, today. A
/// project-scoped report would under-report against a machine-wide cap,
/// and a week-long one would blow through it on the first day.
fn reusable_daily(built: Option<&UsageReport>) -> Option<&UsageReport> {
    built.filter(|r| {
        !r.project_scoped && matches!(r.period_label.as_str(), "today" | "day")
    })
}

/// Price a per-model usage split at that model's own rates.
pub fn price_by_model(by_model: &HashMap<String, crate::session::TokenUsage>) -> f64 {
    by_model
        .iter()
        .map(|(model, u)| {
            breakdown_for(
                model,
                u.input_tokens,
                u.output_tokens,
                u.cache_read_tokens,
                u.cache_creation_tokens,
            )
            .total_cost
        })
        .sum()
}

/// Check budget alerts for the current session and daily/weekly totals
pub fn check_budget(budget: &BudgetConfig) -> Vec<BudgetAlert> {
    check_budget_with(budget, None)
}

/// As [`check_budget`], reusing a daily report the caller has already built.
///
/// `aura usage` printed a total and then, two lines down, a budget alert
/// quoting a *different* total for the same day — $177.3347 against
/// $177.5887 — because this rebuilt the report from scratch a moment
/// later and caught the turns that had landed in between. Both numbers
/// were right; one screen showing two answers to "what did today cost?"
/// is not. Given the report already on screen, the alert quotes it.
pub fn check_budget_with(budget: &BudgetConfig, built: Option<&UsageReport>) -> Vec<BudgetAlert> {
    let mut alerts = Vec::new();

    // Daily check
    if budget.daily_cap_usd > 0.0 {
        let rebuilt;
        let daily = match reusable_daily(built) {
            Some(r) => r,
            None => {
                rebuilt = build_report(86400, "today");
                &rebuilt
            }
        };
        let exceeded = daily.total_cost >= budget.daily_cap_usd;
        let warning = daily.total_cost >= budget.daily_cap_usd * budget.warn_at_pct;
        if warning || exceeded {
            alerts.push(BudgetAlert {
                scope: "daily".to_string(),
                spent: daily.total_cost,
                cap: budget.daily_cap_usd,
                is_exceeded: exceeded,
                is_warning: warning && !exceeded,
            });
        }
    }

    // Weekly check
    if budget.weekly_cap_usd > 0.0 {
        let weekly = build_report(604800, "week");
        let exceeded = weekly.total_cost >= budget.weekly_cap_usd;
        let warning = weekly.total_cost >= budget.weekly_cap_usd * budget.warn_at_pct;
        if warning || exceeded {
            alerts.push(BudgetAlert {
                scope: "weekly".to_string(),
                spent: weekly.total_cost,
                cap: budget.weekly_cap_usd,
                is_exceeded: exceeded,
                is_warning: warning && !exceeded,
            });
        }
    }

    // Active session check
    if budget.session_cap_usd > 0.0 {
        if let Some(cost) = calculate_session_cost(None) {
            let exceeded = cost.total_cost >= budget.session_cap_usd;
            let warning = cost.total_cost >= budget.session_cap_usd * budget.warn_at_pct;
            if warning || exceeded {
                alerts.push(BudgetAlert {
                    scope: "session".to_string(),
                    spent: cost.total_cost,
                    cap: budget.session_cap_usd,
                    is_exceeded: exceeded,
                    is_warning: warning && !exceeded,
                });
            }
        }
    }

    alerts
}

// ── Display formatting ──────────────────────────────────────────────────────

fn format_duration(secs: u64) -> String {
    if secs < 60 {
        format!("{}s", secs)
    } else if secs < 3600 {
        format!("{}m {}s", secs / 60, secs % 60)
    } else {
        format!("{}h {}m", secs / 3600, (secs % 3600) / 60)
    }
}

fn cost_color(cost: f64) -> colored::ColoredString {
    let s = format!("${:.4}", cost);
    if cost > 5.0 {
        s.red().bold()
    } else if cost > 1.0 {
        s.yellow()
    } else {
        s.green()
    }
}

fn bar_chart(value: f64, max: f64, width: usize) -> String {
    if max <= 0.0 {
        return " ".repeat(width);
    }
    let filled = ((value / max) * width as f64).min(width as f64) as usize;
    let empty = width.saturating_sub(filled);
    format!("{}{}", "█".repeat(filled).cyan(), "░".repeat(empty).dimmed())
}

pub fn print_report(report: &UsageReport) {
    println!(
        "\n{} {} {}",
        "💰".bold(),
        "Aura Usage Report".bold().cyan(),
        format!("({})", report.period_label).dimmed()
    );
    println!("{}", "─".repeat(60).dimmed());

    // ── Summary bar ──
    println!(
        "  {} {} across {} session{}  |  {} in / {} out",
        "Total:".bold(),
        cost_color(report.total_cost),
        report.sessions.len(),
        if report.sessions.len() == 1 { "" } else { "s" },
        report.total_input_tokens.to_string().yellow(),
        report.total_output_tokens.to_string().yellow(),
    );
    if report.total_cache_read > 0 || report.total_cache_creation > 0 {
        let total_reads = report.total_input_tokens + report.total_cache_read;
        let cache_pct = if total_reads > 0 {
            (report.total_cache_read as f64 / total_reads as f64) * 100.0
        } else {
            0.0
        };
        // The cache line used to stop at "100% hit rate", which reads as
        // good news and says nothing about money. On a cache-heavy day
        // this is most of the bill, so it carries its share of the total.
        println!(
            "  {} {} read / {} written — {} of the total ({:.0}% of what was read came from cache)",
            "Cache:".bold(),
            report.total_cache_read.to_string().green(),
            report.total_cache_creation.to_string().green(),
            format_money(report.total_cache_cost).green(),
            cache_pct,
        );
    }
    if report.unattributed_input_tokens + report.unattributed_output_tokens > 0 {
        println!(
            "  {} {} more measured in this window belongs to no session below ({} in / {} out)",
            "Not counted above:".bold(),
            format_money(report.unattributed_cost_usd).yellow(),
            report.unattributed_input_tokens.to_string().dimmed(),
            report.unattributed_output_tokens.to_string().dimmed(),
        );
    }

    // ── By model ──
    if !report.by_model.is_empty() {
        println!(
            "\n  {} {}",
            "🤖".bold(),
            "By Model".bold()
        );
        let max_cost = report
            .by_model
            .values()
            .map(|m| m.cost_usd)
            .fold(0.0f64, f64::max);
        let mut models: Vec<&ModelUsage> = report.by_model.values().collect();
        models.sort_by(|a, b| b.cost_usd.partial_cmp(&a.cost_usd).unwrap());
        for m in models {
            println!(
                "    {:<22} {}  {} ({} session{})",
                m.model.cyan(),
                bar_chart(m.cost_usd, max_cost, 15),
                cost_color(m.cost_usd),
                m.session_count,
                if m.session_count == 1 { "" } else { "s" },
            );
        }
    }

    // ── By day ──
    if report.by_day.len() > 1 {
        println!(
            "\n  {} {}",
            "📅".bold(),
            "By Day".bold()
        );
        let max_day = report
            .by_day
            .iter()
            .map(|d| d.cost_usd)
            .fold(0.0f64, f64::max);
        for d in &report.by_day {
            println!(
                "    {}  {}  {}  ({} session{}, {}k tok)",
                d.date.bold(),
                bar_chart(d.cost_usd, max_day, 12),
                cost_color(d.cost_usd),
                d.sessions,
                if d.sessions == 1 { "" } else { "s" },
                d.tokens / 1000,
            );
        }
    }

    // ── By project ──
    if report.by_project.len() > 1 {
        println!(
            "\n  {} {}",
            "📁".bold(),
            "By Project".bold()
        );
        let max_proj = report
            .by_project
            .iter()
            .map(|p| p.cost_usd)
            .fold(0.0f64, f64::max);
        for p in &report.by_project {
            println!(
                "    {:<22} {}  {}  ({} session{}, {}k tok)",
                p.project.cyan(),
                bar_chart(p.cost_usd, max_proj, 12),
                cost_color(p.cost_usd),
                p.sessions,
                if p.sessions == 1 { "" } else { "s" },
                p.tokens / 1000,
            );
        }
    }

    // ── Sessions (most recent 10) ──
    println!(
        "\n  {} {}",
        "📊".bold(),
        "Recent Sessions".bold()
    );
    let display_sessions: Vec<&SessionCost> = report.sessions.iter().take(10).collect();
    if display_sessions.is_empty() {
        println!("    {}", "No sessions in this period.".dimmed());
    }
    for sc in display_sessions {
        let phase_icon = match sc.phase.as_str() {
            "active" => "●".green(),
            "idle" => "◐".yellow(),
            _ => "○".dimmed(),
        };
        println!(
            "    {} {:<16} {:<18} {}  {}  {} files  {}",
            phase_icon,
            sc.session_id.chars().take(16).collect::<String>().cyan(),
            sc.model.dimmed(),
            cost_color(sc.cost_usd),
            format_duration(sc.duration_secs).dimmed(),
            sc.files_touched,
            format!("{}k tok", (sc.input_tokens + sc.output_tokens) / 1000).dimmed(),
        );
    }
    if report.sessions.len() > 10 {
        println!(
            "    {} +{} more sessions",
            "…".dimmed(),
            report.sessions.len() - 10
        );
    }

    // ── What the number above is ──
    println!("\n  {} {}", "🔎".bold(), "What this covers".bold());
    for note in measurement_notes(report) {
        println!("    {} {}", "↳".dimmed(), note.dimmed());
    }

    println!("{}\n", "─".repeat(60).dimmed());
}

pub fn print_budget_alerts(alerts: &[BudgetAlert]) {
    for alert in alerts {
        if alert.is_exceeded {
            eprintln!(
                "  {} {} budget EXCEEDED: {} / {} cap",
                "🚨".bold(),
                alert.scope.to_uppercase().red().bold(),
                cost_color(alert.spent),
                format!("${:.2}", alert.cap).red(),
            );
        } else if alert.is_warning {
            eprintln!(
                "  {} {} budget warning: {} / {} cap ({:.0}%)",
                "⚠️".bold(),
                alert.scope.to_uppercase().yellow().bold(),
                cost_color(alert.spent),
                format!("${:.2}", alert.cap).yellow(),
                (alert.spent / alert.cap) * 100.0,
            );
        }
    }
}

// ── JSON output for MCP / programmatic use ──────────────────────────────────

pub fn report_to_json(report: &UsageReport) -> serde_json::Value {
    let sessions_json: Vec<serde_json::Value> = report
        .sessions
        .iter()
        .map(|sc| {
            serde_json::json!({
                "session_id": sc.session_id,
                "agent_id": sc.agent_id,
                "model": sc.model,
                "started_at": sc.started_at,
                "duration_secs": sc.duration_secs,
                "input_tokens": sc.input_tokens,
                "output_tokens": sc.output_tokens,
                "api_calls": sc.api_calls,
                "cost_usd": (sc.cost_usd * 10000.0).round() / 10000.0,
                "cache_cost_usd": (sc.cache_cost_usd * 10000.0).round() / 10000.0,
                "cache_read_tokens": sc.cache_read_tokens,
                "files_touched": sc.files_touched,
                "project": sc.project,
                "phase": sc.phase,
            })
        })
        .collect();

    let models_json: Vec<serde_json::Value> = report
        .by_model
        .values()
        .map(|m| {
            serde_json::json!({
                "model": m.model,
                "input_tokens": m.input_tokens,
                "output_tokens": m.output_tokens,
                "cost_usd": (m.cost_usd * 10000.0).round() / 10000.0,
                "sessions": m.session_count,
            })
        })
        .collect();

    let days_json: Vec<serde_json::Value> = report
        .by_day
        .iter()
        .map(|d| {
            serde_json::json!({
                "date": d.date,
                "cost_usd": (d.cost_usd * 10000.0).round() / 10000.0,
                "sessions": d.sessions,
                "tokens": d.tokens,
            })
        })
        .collect();

    let projects_json: Vec<serde_json::Value> = report
        .by_project
        .iter()
        .map(|p| {
            serde_json::json!({
                "project": p.project,
                "cost_usd": (p.cost_usd * 10000.0).round() / 10000.0,
                "sessions": p.sessions,
                "tokens": p.tokens,
            })
        })
        .collect();

    serde_json::json!({
        "period": report.period_label,
        "total": {
            "cost_usd": (report.total_cost * 10000.0).round() / 10000.0,
            "input_tokens": report.total_input_tokens,
            "output_tokens": report.total_output_tokens,
            "cache_read_tokens": report.total_cache_read,
            "cache_creation_tokens": report.total_cache_creation,
            // Part of cost_usd above, not an addition to it.
            "cache_cost_usd": (report.total_cache_cost * 10000.0).round() / 10000.0,
            "sessions": report.sessions.len(),
        },
        // Everything the provider recorded on this machine in the window,
        // priced per model — the ceiling the total above sits under.
        "measured": {
            "cost_usd": (report.measured_cost_usd * 10000.0).round() / 10000.0,
        },
        "project_scoped": report.project_scoped,
        // Said in the same words the terminal says them, so a surface
        // rendering this JSON cannot invent its own account of what the
        // number means.
        "measurement_notes": measurement_notes(report),
        // What the provider recorded in this window that no session could claim.
        // Reported rather than dropped, so a consumer that adds these to the
        // totals above lands on the same number `aura usage --plan` reads off
        // the transcripts. Zero when every measured turn found an owner.
        "unattributed": {
            "input_tokens": report.unattributed_input_tokens,
            "output_tokens": report.unattributed_output_tokens,
            "cost_usd": (report.unattributed_cost_usd * 10000.0).round() / 10000.0,
        },
        "by_model": models_json,
        "by_day": days_json,
        "by_project": projects_json,
        "sessions": sessions_json,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::TokenUsage;

    fn report() -> UsageReport {
        UsageReport {
            period_label: "today".to_string(),
            sessions: Vec::new(),
            total_input_tokens: 0,
            total_output_tokens: 0,
            total_cache_read: 0,
            total_cost: 0.0,
            by_model: HashMap::new(),
            by_day: Vec::new(),
            by_project: Vec::new(),
            unattributed_input_tokens: 0,
            unattributed_output_tokens: 0,
            total_cache_creation: 0,
            total_cache_cost: 0.0,
            measured_cost_usd: 0.0,
            unattributed_cost_usd: 0.0,
            project_scoped: false,
        }
    }

    fn tokens(input: u64, output: u64, cache_read: u64) -> TokenUsage {
        TokenUsage {
            input_tokens: input,
            output_tokens: output,
            cache_read_tokens: cache_read,
            cache_creation_tokens: 0,
            api_call_count: 0,
        }
    }

    #[test]
    fn each_model_is_priced_at_its_own_rate() {
        // 10k opus input is five times 10k sonnet input. Pricing the sum
        // at either rate is wrong for half of it.
        let mut by_model = HashMap::new();
        by_model.insert("claude-opus-4".to_string(), tokens(10_000, 0, 0));
        by_model.insert("claude-sonnet-4".to_string(), tokens(10_000, 0, 0));

        let priced = price_by_model(&by_model);
        assert!((priced - (0.15 + 0.03)).abs() < 1e-9);
    }

    #[test]
    fn cache_reads_carry_a_price_into_the_measured_total() {
        let mut by_model = HashMap::new();
        by_model.insert("claude-sonnet-4".to_string(), tokens(0, 0, 1_000_000));

        // A million cached sonnet tokens: 1000 × .003 × .1.
        assert!((price_by_model(&by_model) - 0.3).abs() < 1e-9);
    }

    #[test]
    fn the_report_says_it_is_not_an_invoice_and_names_what_it_cannot_see() {
        let notes = measurement_notes(&report()).join(" ");
        assert!(notes.contains("this machine"));
        assert!(notes.contains("Not a bill"));
        assert!(notes.contains("other coding tools"));
    }

    #[test]
    fn a_whole_machine_report_does_not_claim_to_be_about_one_project() {
        let machine = measurement_notes(&report()).join(" ");
        assert!(!machine.contains("for this project"));

        let mut scoped = report();
        scoped.project_scoped = true;
        assert!(measurement_notes(&scoped)
            .join(" ")
            .contains("for this project"));
    }

    #[test]
    fn what_went_unattributed_is_stated_in_money_not_only_tokens() {
        let mut r = report();
        r.total_cost = 12.0;
        r.measured_cost_usd = 50.0;
        r.unattributed_cost_usd = 38.0;

        let notes = measurement_notes(&r).join(" ");
        assert!(notes.contains("$38.00"));
        assert!(notes.contains("$50.00"));
    }

    #[test]
    fn a_complete_report_does_not_apologise_for_a_gap_it_does_not_have() {
        // Every measured turn found an owner: no fourth note.
        let notes = measurement_notes(&report());
        assert_eq!(notes.len(), 3);
    }

    #[test]
    fn a_cheap_session_is_not_rounded_down_to_free() {
        // Two cents of a cent still reads as money, not as zero.
        assert_eq!(format_money(0.0002), "$0.0002");
        assert_eq!(format_money(0.0), "$0.00");
        assert_eq!(format_money(177.3347), "$177.33");
    }

    #[test]
    fn the_daily_alert_quotes_the_report_already_on_screen() {
        // Two totals for one day on one screen was the bug: the alert
        // rebuilt the report a moment after the header printed it.
        let budget = BudgetConfig {
            daily_cap_usd: 5.0,
            weekly_cap_usd: 0.0,
            session_cap_usd: 0.0,
            warn_at_pct: 0.8,
        };
        let mut daily = report();
        daily.total_cost = 177.3347;

        let alerts = check_budget_with(&budget, Some(&daily));
        assert_eq!(alerts.len(), 1);
        assert!((alerts[0].spent - 177.3347).abs() < 1e-9);
        assert!(alerts[0].is_exceeded);
    }

    #[test]
    fn a_project_report_is_never_compared_against_the_machine_wide_cap() {
        // One project's spend held against a cap covering every project
        // would under-report, so this one is not reused and the caller
        // builds the machine-wide report instead.
        let mut scoped = report();
        scoped.project_scoped = true;
        assert!(reusable_daily(Some(&scoped)).is_none());
    }

    #[test]
    fn a_week_long_report_is_not_quoted_at_the_daily_cap() {
        let mut weekly = report();
        weekly.period_label = "week".to_string();
        assert!(reusable_daily(Some(&weekly)).is_none());

        // "day" and "today" are the same window under two labels; both
        // are the right answer to a daily cap.
        let mut day = report();
        day.period_label = "day".to_string();
        assert!(reusable_daily(Some(&day)).is_some());
        assert!(reusable_daily(Some(&report())).is_some());
        assert!(reusable_daily(None).is_none());
    }
}
