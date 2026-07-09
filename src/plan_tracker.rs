//! Plan Tracker — parse Claude Code transcripts to give visibility into
//! Pro/Max plan usage across all projects on this machine.
//!
//! Data sources:
//!   ~/.claude/projects/<project>/<session>.jsonl  — per-message token usage
//!   ~/.claude/history.jsonl                       — session timestamps + project paths

use colored::Colorize;
use serde::Deserialize;
use std::collections::HashMap;
use std::path::PathBuf;

// ── Transcript parsing structures ───────────────────────────────────────────

#[derive(Deserialize)]
struct TranscriptLine {
    #[serde(rename = "type")]
    msg_type: Option<String>,
    message: Option<TranscriptMessage>,
    #[serde(rename = "costUSD")]
    cost_usd: Option<f64>,
    timestamp: Option<serde_json::Value>, // can be string or number
}

#[derive(Deserialize)]
struct TranscriptMessage {
    model: Option<String>,
    usage: Option<TranscriptUsage>,
}

#[derive(Deserialize)]
struct TranscriptUsage {
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    cache_read_input_tokens: Option<u64>,
    cache_creation_input_tokens: Option<u64>,
}

#[derive(Deserialize)]
struct HistoryEntry {
    timestamp: Option<u64>,
    project: Option<String>,
    #[serde(rename = "sessionId")]
    session_id: Option<String>,
}

// ── Report structures ───────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct PlanReport {
    pub total_messages: u64,
    pub total_input_tokens: u64,
    pub total_output_tokens: u64,
    pub total_cache_read: u64,
    pub total_cache_create: u64,
    pub estimated_cost_usd: f64,
    pub by_project: Vec<ProjectTokens>,
    pub by_model: Vec<ModelTokens>,
    pub by_hour: [u32; 24],
    pub by_weekday: [u32; 7], // 0=Mon .. 6=Sun
    pub by_day: Vec<DayTokens>,
    pub period_label: String,
    /// Messages sent during Claude's peak hours (weekdays 5am-11am PT = 12:00-18:00 UTC)
    pub peak_hour_messages: u64,
    /// Messages sent outside peak hours
    pub offpeak_messages: u64,
    /// Output tokens during peak hours
    pub peak_hour_tokens: u64,
    /// Output tokens off-peak
    pub offpeak_tokens: u64,
}

#[derive(Debug, Clone)]
pub struct ProjectTokens {
    pub name: String,
    pub messages: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub estimated_cost: f64,
}

#[derive(Debug, Clone)]
pub struct ModelTokens {
    pub model: String,
    pub messages: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
}

#[derive(Debug, Clone)]
pub struct DayTokens {
    pub date: String, // YYYY-MM-DD
    pub messages: u64,
    pub output_tokens: u64,
    pub estimated_cost: f64,
}

// ── Pricing (per 1K tokens, matches cost_reporter.rs) ───────────────────────

fn model_cost_per_1k(model: &str) -> (f64, f64) {
    match model {
        m if m.contains("opus") => (0.015, 0.075),
        m if m.contains("sonnet") => (0.003, 0.015),
        m if m.contains("haiku") => (0.00025, 0.00125),
        _ => (0.003, 0.015), // default sonnet-class
    }
}

// ── Core parsing ────────────────────────────────────────────────────────────

fn claude_projects_dir() -> Option<PathBuf> {
    let home = std::env::var("HOME").ok()?;
    let dir = PathBuf::from(home).join(".claude").join("projects");
    if dir.is_dir() { Some(dir) } else { None }
}

fn project_name_from_dir(dirname: &str) -> String {
    // Convert "-Users-you-Documents-New-Git" → "New Git"
    // The dirname uses single dashes for path separators AND within folder names.
    // Strategy: strip the known home prefix, then take the last path component.

    let cleaned = dirname.trim_start_matches('-');

    // Split on what looks like path components by finding the home dir prefix
    // Common patterns: "Users-<user>-Documents-<project>" or "Users-<user>-<project>"
    let segments: Vec<&str> = cleaned.splitn(4, '-').collect();

    if segments.len() >= 3 && segments[0] == "Users" {
        // "Users" - <username> - "Documents" - <rest>
        // or "Users" - <username> - <rest>
        // We need to find the prefix dynamically since username varies
        let rest = {
            let after_users_user = format!("{}-{}-", segments[0], segments[1]);
            let remainder = cleaned.strip_prefix(&after_users_user).unwrap_or(cleaned);
            // Strip "Documents-" if present
            if remainder.starts_with("Documents-") {
                remainder.strip_prefix("Documents-").unwrap_or(remainder)
            } else {
                remainder
            }
        };

        // Now rest might be "New-Git" or "Naridon-Mono--claude-worktrees-..."
        // Take up to first "--" (which indicates subdirectory)
        let project_part = rest.split("--").next().unwrap_or(rest);

        // Convert remaining dashes to spaces for display
        project_part.replace('-', " ")
    } else if cleaned.is_empty() || cleaned == "-" {
        "(root)".to_string()
    } else {
        cleaned.replace('-', " ")
    }
}

fn timestamp_to_date(ts_secs: u64) -> String {
    // Simple date conversion without chrono
    let days_since_epoch = ts_secs / 86400;
    let mut y = 1970i64;
    let mut remaining = days_since_epoch as i64;
    loop {
        let days_in_year = if y % 4 == 0 && (y % 100 != 0 || y % 400 == 0) { 366 } else { 365 };
        if remaining < days_in_year { break; }
        remaining -= days_in_year;
        y += 1;
    }
    let leap = y % 4 == 0 && (y % 100 != 0 || y % 400 == 0);
    let month_days = [31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let mut m = 0usize;
    for (i, &days) in month_days.iter().enumerate() {
        if remaining < days as i64 { m = i; break; }
        remaining -= days as i64;
    }
    format!("{:04}-{:02}-{:02}", y, m + 1, remaining + 1)
}

fn timestamp_to_hour(ts_secs: u64) -> usize {
    ((ts_secs % 86400) / 3600) as usize
}

fn timestamp_to_weekday(ts_secs: u64) -> usize {
    // 1970-01-01 was Thursday (3)
    let days = ts_secs / 86400;
    ((days + 3) % 7) as usize // 0=Mon
}

/// Check if a UTC timestamp falls within Claude's peak hours.
/// Peak hours: weekdays 5am-11am PT = 12:00-18:00 UTC (PDT, UTC-7)
/// During PST (UTC-8), peak is 13:00-19:00 UTC, but we use PDT as the
/// conservative estimate since that's when most usage occurs.
fn is_claude_peak_hour(ts_secs: u64) -> bool {
    let weekday = timestamp_to_weekday(ts_secs); // 0=Mon .. 6=Sun
    if weekday >= 5 { return false; } // Weekend = never peak
    let utc_hour = timestamp_to_hour(ts_secs);
    // 5am-11am PT = 12:00-18:00 UTC (PDT)
    (12..18).contains(&utc_hour)
}

/// Parse a single .jsonl transcript file and extract token usage per message
fn parse_transcript(
    path: &std::path::Path,
    cutoff_secs: u64,
) -> Vec<(u64, String, u64, u64, u64, u64)> {
    // Returns: (timestamp_secs, model, input, output, cache_read, cache_create)
    let mut results = Vec::new();

    let file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return results,
    };

    use std::io::BufRead;
    let reader = std::io::BufReader::new(file);

    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => continue,
        };
        if line.is_empty() { continue; }

        let entry: TranscriptLine = match serde_json::from_str(&line) {
            Ok(e) => e,
            Err(_) => continue,
        };

        if entry.msg_type.as_deref() != Some("assistant") { continue; }

        let msg = match entry.message {
            Some(m) => m,
            None => continue,
        };

        let usage = match msg.usage {
            Some(u) => u,
            None => continue,
        };

        // Extract timestamp from the entry or estimate from file mod time
        let ts_secs = match &entry.timestamp {
            Some(serde_json::Value::String(s)) => {
                // ISO-8601
                s.parse::<chrono_lite::DateTime>().map(|d| d.timestamp as u64).unwrap_or(0)
            }
            Some(serde_json::Value::Number(n)) => {
                let v = n.as_u64().unwrap_or(0);
                if v > 1_000_000_000_000 { v / 1000 } else { v }
            }
            _ => 0,
        };

        if ts_secs > 0 && ts_secs < cutoff_secs { continue; }

        let model = msg.model.unwrap_or_default();
        let input = usage.input_tokens.unwrap_or(0);
        let output = usage.output_tokens.unwrap_or(0);
        let cache_read = usage.cache_read_input_tokens.unwrap_or(0);
        let cache_create = usage.cache_creation_input_tokens.unwrap_or(0);

        results.push((ts_secs, model, input, output, cache_read, cache_create));
    }

    results
}

/// Build a plan usage report by scanning ALL Claude Code transcripts
pub fn build_plan_report(since_secs: u64, label: &str) -> Option<PlanReport> {
    let projects_dir = claude_projects_dir()?;

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let cutoff = now.saturating_sub(since_secs);

    let mut total_messages = 0u64;
    let mut total_input = 0u64;
    let mut total_output = 0u64;
    let mut total_cache_read = 0u64;
    let mut total_cache_create = 0u64;
    let mut total_cost = 0.0f64;

    let mut project_map: HashMap<String, ProjectTokens> = HashMap::new();
    let mut model_map: HashMap<String, ModelTokens> = HashMap::new();
    let mut day_map: HashMap<String, DayTokens> = HashMap::new();
    let mut by_hour = [0u32; 24];
    let mut by_weekday = [0u32; 7];
    let mut peak_msgs = 0u64;
    let mut offpeak_msgs = 0u64;
    let mut peak_tokens = 0u64;
    let mut offpeak_tokens = 0u64;

    let entries = match std::fs::read_dir(&projects_dir) {
        Ok(e) => e,
        Err(_) => return None,
    };

    for proj_entry in entries.flatten() {
        let proj_path = proj_entry.path();
        if !proj_path.is_dir() { continue; }

        let dirname = proj_path.file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        let proj_name = project_name_from_dir(&dirname);

        let jsonl_files: Vec<_> = match std::fs::read_dir(&proj_path) {
            Ok(entries) => entries
                .flatten()
                .filter(|e| e.path().extension().map(|x| x == "jsonl").unwrap_or(false))
                .collect(),
            Err(_) => continue,
        };

        for jsonl_entry in jsonl_files {
            let records = parse_transcript(&jsonl_entry.path(), cutoff);

            for (ts, model, input, output, cache_read, cache_create) in records {
                total_messages += 1;
                total_input += input;
                total_output += output;
                total_cache_read += cache_read;
                total_cache_create += cache_create;

                let (in_rate, out_rate) = model_cost_per_1k(&model);
                let msg_cost = (input as f64 / 1000.0) * in_rate
                    + (output as f64 / 1000.0) * out_rate;
                total_cost += msg_cost;

                // By project
                let proj = project_map.entry(proj_name.clone()).or_insert_with(|| ProjectTokens {
                    name: proj_name.clone(),
                    messages: 0,
                    input_tokens: 0,
                    output_tokens: 0,
                    estimated_cost: 0.0,
                });
                proj.messages += 1;
                proj.input_tokens += input;
                proj.output_tokens += output;
                proj.estimated_cost += msg_cost;

                // By model
                let mdl = model_map.entry(model.clone()).or_insert_with(|| ModelTokens {
                    model: model.clone(),
                    messages: 0,
                    input_tokens: 0,
                    output_tokens: 0,
                });
                mdl.messages += 1;
                mdl.input_tokens += input;
                mdl.output_tokens += output;

                // By time
                if ts > 0 {
                    let hour = timestamp_to_hour(ts);
                    if hour < 24 { by_hour[hour] += 1; }
                    let weekday = timestamp_to_weekday(ts);
                    if weekday < 7 { by_weekday[weekday] += 1; }

                    let date = timestamp_to_date(ts);
                    let day = day_map.entry(date.clone()).or_insert_with(|| DayTokens {
                        date,
                        messages: 0,
                        output_tokens: 0,
                        estimated_cost: 0.0,
                    });
                    day.messages += 1;
                    day.output_tokens += output;
                    day.estimated_cost += msg_cost;

                    // Track peak vs off-peak (Claude's peak = weekdays 5am-11am PT)
                    if is_claude_peak_hour(ts) {
                        peak_msgs += 1;
                        peak_tokens += output;
                    } else {
                        offpeak_msgs += 1;
                        offpeak_tokens += output;
                    }
                }
            }
        }
    }

    let mut by_project: Vec<ProjectTokens> = project_map.into_values().collect();
    by_project.sort_by(|a, b| b.output_tokens.partial_cmp(&a.output_tokens).unwrap());

    let mut by_model: Vec<ModelTokens> = model_map.into_values().collect();
    by_model.sort_by(|a, b| b.output_tokens.cmp(&a.output_tokens));

    let mut by_day: Vec<DayTokens> = day_map.into_values().collect();
    by_day.sort_by(|a, b| a.date.cmp(&b.date));

    Some(PlanReport {
        total_messages,
        total_input_tokens: total_input,
        total_output_tokens: total_output,
        total_cache_read,
        total_cache_create,
        estimated_cost_usd: total_cost,
        by_project,
        by_model,
        by_hour,
        by_weekday,
        by_day,
        period_label: label.to_string(),
        peak_hour_messages: peak_msgs,
        offpeak_messages: offpeak_msgs,
        peak_hour_tokens: peak_tokens,
        offpeak_tokens: offpeak_tokens,
    })
}

// ── Display ─────────────────────────────────────────────────────────────────

fn bar(value: u32, max: u32, width: usize) -> String {
    if max == 0 { return " ".repeat(width); }
    let filled = ((value as f64 / max as f64) * width as f64).min(width as f64) as usize;
    let empty = width.saturating_sub(filled);
    format!("{}{}", "█".repeat(filled).cyan(), "░".repeat(empty).dimmed())
}

fn cost_str(cost: f64) -> colored::ColoredString {
    let s = format!("${:.2}", cost);
    if cost > 10.0 { s.red().bold() }
    else if cost > 2.0 { s.yellow() }
    else { s.green() }
}

fn tokens_human(t: u64) -> String {
    if t >= 1_000_000_000 { format!("{:.1}B", t as f64 / 1e9) }
    else if t >= 1_000_000 { format!("{:.1}M", t as f64 / 1e6) }
    else if t >= 1_000 { format!("{:.0}K", t as f64 / 1e3) }
    else { format!("{}", t) }
}

pub fn print_plan_report(report: &PlanReport) {
    println!(
        "\n{} {} {}",
        "📊".bold(),
        "Claude Plan Usage Report".bold().cyan(),
        format!("({})", report.period_label).dimmed()
    );
    println!("{}", "═".repeat(62).dimmed());

    // ── Summary ──
    println!(
        "  {} {} messages  |  {} output tokens  |  est. {}",
        "Total:".bold(),
        report.total_messages.to_string().yellow().bold(),
        tokens_human(report.total_output_tokens).yellow(),
        cost_str(report.estimated_cost_usd),
    );
    let total_cache = report.total_cache_read + report.total_cache_create;
    if total_cache > 0 {
        println!(
            "  {} {} cache read / {} cache created",
            "Cache:".bold(),
            tokens_human(report.total_cache_read).green(),
            tokens_human(report.total_cache_create).dimmed(),
        );
    }

    // ── By Project ──
    if !report.by_project.is_empty() {
        println!(
            "\n  {} {}",
            "📁".bold(),
            "By Project (which project eats your quota)".bold()
        );
        let max_out = report.by_project.iter().map(|p| p.output_tokens).max().unwrap_or(1);
        for p in report.by_project.iter().take(15) {
            let pct = if report.total_output_tokens > 0 {
                (p.output_tokens as f64 / report.total_output_tokens as f64) * 100.0
            } else { 0.0 };
            println!(
                "    {:<22} {} {:>5.1}%  {} out  {} msgs  est. {}",
                p.name.cyan(),
                bar(p.output_tokens as u32, max_out as u32, 12),
                pct,
                tokens_human(p.output_tokens).yellow(),
                p.messages,
                cost_str(p.estimated_cost),
            );
        }
    }

    // ── By Model ──
    if !report.by_model.is_empty() {
        println!(
            "\n  {} {}",
            "🤖".bold(),
            "By Model".bold()
        );
        let max_out = report.by_model.iter().map(|m| m.output_tokens).max().unwrap_or(1);
        for m in &report.by_model {
            let pct = if report.total_output_tokens > 0 {
                (m.output_tokens as f64 / report.total_output_tokens as f64) * 100.0
            } else { 0.0 };
            let model_display = m.model.replace("claude-", "").replace("-20", " 20");
            println!(
                "    {:<22} {} {:>5.1}%  {} out  {} msgs",
                model_display.cyan(),
                bar(m.output_tokens as u32, max_out as u32, 12),
                pct,
                tokens_human(m.output_tokens).yellow(),
                m.messages,
            );
        }
    }

    // ── Claude Peak Hours Impact ──
    // Claude's peak hours: weekdays 5am-11am PT (12:00-18:00 UTC)
    // During peak, your 5-hour session quota drains FASTER
    let total_timed = report.peak_hour_messages + report.offpeak_messages;
    if total_timed > 0 {
        let peak_pct = (report.peak_hour_messages as f64 / total_timed as f64) * 100.0;
        let peak_tok_pct = if report.peak_hour_tokens + report.offpeak_tokens > 0 {
            (report.peak_hour_tokens as f64 / (report.peak_hour_tokens + report.offpeak_tokens) as f64) * 100.0
        } else { 0.0 };

        println!(
            "\n  {} {} {}",
            "⚡".bold(),
            "Claude Peak Hours Impact".bold(),
            "(weekdays 5am-11am PT — quota drains faster)".dimmed(),
        );
        println!(
            "    {} {} of your messages ({}) were during peak hours",
            "Peak:".red().bold(),
            format!("{:.0}%", peak_pct).red().bold(),
            format!("{} msgs, {} tokens", report.peak_hour_messages, tokens_human(report.peak_hour_tokens)).dimmed(),
        );
        println!(
            "    {} {} of your messages ({}) were off-peak",
            "Off-peak:".green().bold(),
            format!("{:.0}%", 100.0 - peak_pct).green(),
            format!("{} msgs, {} tokens", report.offpeak_messages, tokens_human(report.offpeak_tokens)).dimmed(),
        );

        if peak_pct > 50.0 {
            println!(
                "    {} Most of your usage is during peak hours — your quota drains faster!",
                "⚠️".bold(),
            );
            println!(
                "    {} Shifting heavy work to evenings/weekends would stretch your plan further.",
                "💡".bold(),
            );
        } else if peak_pct > 30.0 {
            println!(
                "    {} Moderate peak usage. Consider scheduling heavy tasks off-peak to save quota.",
                "ℹ️".bold(),
            );
        } else {
            println!(
                "    {} Great! Most of your usage is off-peak — you're getting maximum value from your plan.",
                "✓".green().bold(),
            );
        }
    }

    // ── Your Activity Pattern ──
    let max_hour = *report.by_hour.iter().max().unwrap_or(&1);
    if max_hour > 0 {
        println!(
            "\n  {} {}",
            "🕐".bold(),
            "Your Activity Pattern (UTC)".bold()
        );
        for block_start in (0..24).step_by(3) {
            let count: u32 = report.by_hour[block_start..block_start+3].iter().sum();
            let block_max: u32 = (0..24).step_by(3)
                .map(|s| report.by_hour[s..s+3].iter().sum::<u32>())
                .max().unwrap_or(1);
            let is_peak = (12..18).contains(&block_start) || (12..18).contains(&(block_start + 2));
            let label = if is_peak { " ← PEAK".red().to_string() } else { String::new() };
            println!(
                "    {:02}:00-{:02}:00  {} {}{}",
                block_start, block_start + 3,
                bar(count, block_max, 20),
                count.to_string().dimmed(),
                label,
            );
        }
    }

    // ── Weekday Pattern ──
    let max_wd = *report.by_weekday.iter().max().unwrap_or(&1);
    if max_wd > 0 {
        println!(
            "\n  {} {}",
            "📅".bold(),
            "By Day of Week".bold()
        );
        let day_names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
        for (i, name) in day_names.iter().enumerate() {
            println!(
                "    {}  {} {}",
                name.bold(),
                bar(report.by_weekday[i], max_wd, 25),
                report.by_weekday[i].to_string().dimmed(),
            );
        }
    }

    // ── Daily Trend (last 14 days) ──
    if report.by_day.len() > 1 {
        println!(
            "\n  {} {}",
            "📈".bold(),
            "Daily Output (last 14 days)".bold()
        );
        let max_day_out = report.by_day.iter().map(|d| d.output_tokens).max().unwrap_or(1);
        for d in report.by_day.iter().rev().take(14).collect::<Vec<_>>().into_iter().rev() {
            println!(
                "    {}  {} {} out  {} msgs  est. {}",
                d.date.bold(),
                bar(d.output_tokens as u32, max_day_out as u32, 15),
                tokens_human(d.output_tokens).yellow(),
                d.messages,
                cost_str(d.estimated_cost),
            );
        }
    }

    // ── Burn Rate & Prediction ──
    if report.by_day.len() >= 2 {
        let recent_days: Vec<&DayTokens> = report.by_day.iter().rev().take(7).collect();
        let avg_daily_out = recent_days.iter().map(|d| d.output_tokens).sum::<u64>() / recent_days.len() as u64;
        let avg_daily_cost = recent_days.iter().map(|d| d.estimated_cost).sum::<f64>() / recent_days.len() as f64;
        let avg_daily_msgs = recent_days.iter().map(|d| d.messages).sum::<u64>() / recent_days.len() as u64;

        println!("\n  {} {}", "🔥".bold(), "Burn Rate (7-day average)".bold());
        println!(
            "    {} messages/day  |  {} tokens/day  |  est. {}/day",
            avg_daily_msgs.to_string().yellow(),
            tokens_human(avg_daily_out).yellow(),
            cost_str(avg_daily_cost),
        );
        println!(
            "    Projected weekly: est. {}  |  Projected monthly: est. {}",
            cost_str(avg_daily_cost * 7.0),
            cost_str(avg_daily_cost * 30.0),
        );
    }

    println!("{}\n", "═".repeat(62).dimmed());
}

// ── JSON output ─────────────────────────────────────────────────────────────

pub fn plan_report_to_json(report: &PlanReport) -> serde_json::Value {
    let projects: Vec<serde_json::Value> = report.by_project.iter().map(|p| {
        serde_json::json!({
            "project": p.name,
            "messages": p.messages,
            "input_tokens": p.input_tokens,
            "output_tokens": p.output_tokens,
            "estimated_cost_usd": (p.estimated_cost * 100.0).round() / 100.0,
            "pct_of_total": if report.total_output_tokens > 0 {
                ((p.output_tokens as f64 / report.total_output_tokens as f64) * 1000.0).round() / 10.0
            } else { 0.0 },
        })
    }).collect();

    let models: Vec<serde_json::Value> = report.by_model.iter().map(|m| {
        serde_json::json!({
            "model": m.model,
            "messages": m.messages,
            "input_tokens": m.input_tokens,
            "output_tokens": m.output_tokens,
        })
    }).collect();

    let days: Vec<serde_json::Value> = report.by_day.iter().map(|d| {
        serde_json::json!({
            "date": d.date,
            "messages": d.messages,
            "output_tokens": d.output_tokens,
            "estimated_cost_usd": (d.estimated_cost * 100.0).round() / 100.0,
        })
    }).collect();

    serde_json::json!({
        "period": report.period_label,
        "total": {
            "messages": report.total_messages,
            "input_tokens": report.total_input_tokens,
            "output_tokens": report.total_output_tokens,
            "cache_read_tokens": report.total_cache_read,
            "cache_create_tokens": report.total_cache_create,
            "estimated_cost_usd": (report.estimated_cost_usd * 100.0).round() / 100.0,
        },
        "by_project": projects,
        "by_model": models,
        "by_day": days,
        "peak_hours": report.by_hour,
        "by_weekday": report.by_weekday,
    })
}

// ── Tiny datetime helper (avoids chrono dependency) ─────────────────────────

mod chrono_lite {
    pub struct DateTime {
        pub timestamp: i64,
    }

    impl std::str::FromStr for DateTime {
        type Err = ();
        fn from_str(s: &str) -> Result<Self, ()> {
            // Parse ISO-8601: "2026-03-29T12:34:56.789Z" or epoch millis
            if let Ok(epoch) = s.parse::<i64>() {
                let ts = if epoch > 1_000_000_000_000 { epoch / 1000 } else { epoch };
                return Ok(DateTime { timestamp: ts });
            }

            // Simple ISO parse: YYYY-MM-DDThh:mm:ss
            let s = s.trim_end_matches('Z').split('+').next().unwrap_or(s);
            let parts: Vec<&str> = s.split('T').collect();
            if parts.len() != 2 { return Err(()); }

            let date_parts: Vec<u32> = parts[0].split('-').filter_map(|p| p.parse().ok()).collect();
            let time_str = parts[1].split('.').next().unwrap_or(parts[1]);
            let time_parts: Vec<u32> = time_str.split(':').filter_map(|p| p.parse().ok()).collect();

            if date_parts.len() < 3 || time_parts.len() < 3 { return Err(()); }

            let (y, m, d) = (date_parts[0] as i64, date_parts[1] as i64, date_parts[2] as i64);
            let (hh, mm, ss) = (time_parts[0] as i64, time_parts[1] as i64, time_parts[2] as i64);

            // Days from epoch (simplified, good enough for 2020-2030)
            let mut days: i64 = 0;
            for yr in 1970..y {
                days += if yr % 4 == 0 && (yr % 100 != 0 || yr % 400 == 0) { 366 } else { 365 };
            }
            let leap = y % 4 == 0 && (y % 100 != 0 || y % 400 == 0);
            let month_days = [0, 31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
            for mi in 1..m {
                days += month_days[mi as usize] as i64;
            }
            days += d - 1;

            let timestamp = days * 86400 + hh * 3600 + mm * 60 + ss;
            Ok(DateTime { timestamp })
        }
    }
}
