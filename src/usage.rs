use crate::config::ConfigManager;
use crate::plugins::cost_reporter::{calculate_session_cost, cost_per_model, CostBreakdown};
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
    pub cost_usd: f64,
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
    let (input_rate, output_rate) = cost_per_model(&model);

    let (input_tokens, output_tokens, api_calls, cache_read) = s
        .token_usage
        .as_ref()
        .map(|u| {
            (
                u.input_tokens,
                u.output_tokens,
                u.api_call_count,
                u.cache_read_tokens,
            )
        })
        .unwrap_or((0, 0, 0, 0));

    let cost_usd =
        (input_tokens as f64 / 1000.0) * input_rate + (output_tokens as f64 / 1000.0) * output_rate;

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
        cost_usd,
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
    let sessions = if project_only {
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
    let mut total_cost = 0.0f64;
    let mut session_costs = Vec::new();

    for s in &filtered {
        let sc = session_to_cost(s);

        total_input += sc.input_tokens;
        total_output += sc.output_tokens;
        total_cost += sc.cost_usd;
        if let Some(u) = s.token_usage.as_ref() {
            total_cache += u.cache_read_tokens;
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
    }
}

/// Check budget alerts for the current session and daily/weekly totals
pub fn check_budget(budget: &BudgetConfig) -> Vec<BudgetAlert> {
    let mut alerts = Vec::new();

    // Daily check
    if budget.daily_cap_usd > 0.0 {
        let daily = build_report(86400, "today");
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
    if report.total_cache_read > 0 {
        let total_reads = report.total_input_tokens + report.total_cache_read;
        let cache_pct = if total_reads > 0 {
            (report.total_cache_read as f64 / total_reads as f64) * 100.0
        } else {
            0.0
        };
        println!(
            "  {} {} tokens from cache ({:.0}% hit rate)",
            "Cache:".bold(),
            report.total_cache_read.to_string().green(),
            cache_pct,
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
            "sessions": report.sessions.len(),
        },
        "by_model": models_json,
        "by_day": days_json,
        "by_project": projects_json,
        "sessions": sessions_json,
    })
}
