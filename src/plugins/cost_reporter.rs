use crate::plugin::{AuraPlugin, PluginContext};
use crate::session::SessionManager;

/// Built-in plugin that calculates and displays estimated token costs
pub struct CostReporterPlugin;

/// Cost breakdown for a session
#[derive(Debug, Clone)]
pub struct CostBreakdown {
    pub model: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_creation_tokens: u64,
    pub input_cost: f64,
    pub output_cost: f64,
    /// What the cache traffic itself costs: reads at a tenth of the input
    /// rate, writes at a quarter above it. Charged, not free — see
    /// [`CACHE_READ_RATIO`].
    pub cache_cost: f64,
    /// What caching *saved*, against the counterfactual of sending every
    /// cached token as fresh input. Not a charge and not part of the
    /// total; it is the argument for caching, shown beside its price.
    pub cache_savings: f64,
    pub total_cost: f64,
}

impl CostBreakdown {
    pub fn format_display(&self) -> String {
        let mut out = String::new();
        out.push_str(&format!("  Model: {}\n", self.model));
        out.push_str(&format!(
            "  Input:  {:>10} tokens  ${:.4}\n",
            self.input_tokens, self.input_cost
        ));
        out.push_str(&format!(
            "  Output: {:>10} tokens  ${:.4}\n",
            self.output_tokens, self.output_cost
        ));
        if self.cache_read_tokens > 0 || self.cache_creation_tokens > 0 {
            out.push_str(&format!(
                "  Cache:  {:>10} read / {} created  ${:.4}  (saved ~${:.4})\n",
                self.cache_read_tokens,
                self.cache_creation_tokens,
                self.cache_cost,
                self.cache_savings
            ));
        }
        out.push_str(&format!("  Total:  ${:.4}\n", self.total_cost));
        out
    }

    pub fn format_compact(&self) -> String {
        format!(
            "~${:.4} ({} in/{} out tokens, {})",
            self.total_cost, self.input_tokens, self.output_tokens, self.model
        )
    }
}

/// A cached token still costs something to read — a tenth of what the
/// same token costs as fresh input.
///
/// It was priced at zero here, with a comment explaining that cache
/// reads are excluded from `input_tokens` upstream and so must not be
/// added again. The first half is true; the conclusion does not follow.
/// Excluding them from the input count stops a double charge; charging
/// nothing for them drops the charge entirely. On a day where this
/// machine read 436 million tokens from cache against ten thousand
/// fresh input tokens, that is not a rounding error — it is almost the
/// entire input side of the bill missing from a report whose one job is
/// to say what was spent.
pub const CACHE_READ_RATIO: f64 = 0.1;

/// Writing a token into the cache costs a quarter more than sending it
/// as input, which is what makes caching a bet rather than a free win.
pub const CACHE_WRITE_RATIO: f64 = 1.25;

/// Pricing per 1K tokens (input, output) for known models
pub fn cost_per_model(model: &str) -> (f64, f64) {
    match model {
        m if m.contains("opus") => (0.015, 0.075),
        m if m.contains("sonnet") => (0.003, 0.015),
        m if m.contains("haiku") => (0.00025, 0.00125),
        m if m.contains("gpt-4o") => (0.005, 0.015),
        m if m.contains("gpt-4") => (0.01, 0.03),
        m if m.contains("gpt-3.5") => (0.0005, 0.0015),
        m if m.contains("gemini-2.0-flash") => (0.0001, 0.0004),
        m if m.contains("gemini-2.5-pro") => (0.00125, 0.01),
        m if m.contains("gemini") => (0.00025, 0.001),
        _ => (0.003, 0.015), // default to sonnet-class pricing
    }
}

/// Pure cost arithmetic: token counts × per-model rates → breakdown.
pub fn breakdown_for(
    model: &str,
    input_tokens: u64,
    output_tokens: u64,
    cache_read_tokens: u64,
    cache_creation_tokens: u64,
) -> CostBreakdown {
    let (input_rate, output_rate) = cost_per_model(model);

    let input_cost = (input_tokens as f64 / 1000.0) * input_rate;
    let output_cost = (output_tokens as f64 / 1000.0) * output_rate;

    // The two cache ratios are Anthropic's published ones, applied to
    // every row because this table holds rate *pairs* and nothing else.
    // In practice every row is Anthropic: the measured numbers come from
    // Claude Code's own transcripts. A model priced from another
    // provider's table would carry that provider's cache ratios, and the
    // report says out loud that these are list rates rather than an
    // invoice.
    let cache_cost = (cache_read_tokens as f64 / 1000.0) * input_rate * CACHE_READ_RATIO
        + (cache_creation_tokens as f64 / 1000.0) * input_rate * CACHE_WRITE_RATIO;

    // What the reads would have cost at full input price, minus what they
    // did cost — the saving, which is not itself a charge.
    let cache_savings =
        (cache_read_tokens as f64 / 1000.0) * input_rate * (1.0 - CACHE_READ_RATIO);

    let total_cost = input_cost + output_cost + cache_cost;

    CostBreakdown {
        model: model.to_string(),
        input_tokens,
        output_tokens,
        cache_read_tokens,
        cache_creation_tokens,
        input_cost,
        output_cost,
        cache_cost,
        cache_savings,
        total_cost,
    }
}

/// Calculate cost breakdown for the active session or a specific session
pub fn calculate_session_cost(session_id: Option<&str>) -> Option<CostBreakdown> {
    let session = if let Some(id) = session_id {
        SessionManager::list_sessions()
            .into_iter()
            .find(|s| s.session_id == id)
    } else {
        SessionManager::get_active_session()
    };

    let session = session?;
    let usage = session.token_usage.as_ref()?;
    let model = session
        .model_name
        .as_deref()
        .unwrap_or("claude-sonnet");

    Some(breakdown_for(
        model,
        usage.input_tokens,
        usage.output_tokens,
        usage.cache_read_tokens,
        usage.cache_creation_tokens,
    ))
}

impl AuraPlugin for CostReporterPlugin {
    fn name(&self) -> &str {
        "cost-reporter"
    }

    fn version(&self) -> &str {
        "1.0.0"
    }

    fn on_session_end(&self, ctx: &PluginContext) -> Result<(), Box<dyn std::error::Error>> {
        if let Some(ref session_id) = ctx.session_id {
            if let Some(breakdown) = calculate_session_cost(Some(session_id)) {
                eprintln!("\n  Cost Report ({}): {}", self.name(), breakdown.format_compact());
            }
        }
        Ok(())
    }

    fn on_checkpoint(&self, _ctx: &PluginContext) -> Result<(), Box<dyn std::error::Error>> {
        // Show running cost on each checkpoint
        if let Some(breakdown) = calculate_session_cost(None) {
            eprintln!("  Session cost so far: {}", breakdown.format_compact());
        }
        Ok(())
    }

    fn custom_command(
        &self,
        cmd: &str,
        _args: &[String],
    ) -> Result<Option<String>, Box<dyn std::error::Error>> {
        if cmd == "cost" || cmd == "cost-report" {
            if let Some(breakdown) = calculate_session_cost(None) {
                return Ok(Some(breakdown.format_display()));
            }
            return Ok(Some("No active session with token data.".to_string()));
        }
        Ok(None)
    }
}

#[cfg(test)]
mod cost_tests {
    use super::{breakdown_for, cost_per_model};

    #[test]
    fn cost_model_routing_respects_match_order() {
        // Longer prefixes must win over their substrings — a gpt-4o rate
        // billed at gpt-4 prices is a 2x overcharge.
        assert_eq!(cost_per_model("gpt-4o-mini"), (0.005, 0.015));
        assert_eq!(cost_per_model("gpt-4-turbo"), (0.01, 0.03));
        assert_eq!(cost_per_model("gpt-3.5-turbo"), (0.0005, 0.0015));
        assert_eq!(cost_per_model("gemini-2.0-flash-exp"), (0.0001, 0.0004));
        assert_eq!(cost_per_model("gemini-2.5-pro"), (0.00125, 0.01));
        assert_eq!(cost_per_model("gemini-1.5-flash"), (0.00025, 0.001));
        assert_eq!(cost_per_model("claude-opus-4"), (0.015, 0.075));
        assert_eq!(cost_per_model("claude-sonnet-4"), (0.003, 0.015));
        assert_eq!(cost_per_model("claude-haiku-3"), (0.00025, 0.00125));
        // Unknown models bill at sonnet-class rates, never zero.
        assert_eq!(cost_per_model("mystery-model"), (0.003, 0.015));
    }

    #[test]
    fn breakdown_arithmetic_is_exact_per_thousand() {
        // 10k in / 2k out on opus: 10 × .015 + 2 × .075.
        let b = breakdown_for("claude-opus-4", 10_000, 2_000, 0, 0);
        assert!((b.input_cost - 0.15).abs() < 1e-9);
        assert!((b.output_cost - 0.15).abs() < 1e-9);
        assert!((b.total_cost - 0.30).abs() < 1e-9);
        assert!((b.cache_savings - 0.0).abs() < 1e-9);
        assert_eq!(b.model, "claude-opus-4");
        assert_eq!((b.input_tokens, b.output_tokens), (10_000, 2_000));
    }

    #[test]
    fn cache_traffic_is_charged_and_still_reported_as_a_saving() {
        // 100k reads + 5k writes on sonnet: reads at a tenth of input
        // (100 × .003 × .1) plus writes at a quarter above it
        // (5 × .003 × 1.25), on top of 1k fresh input.
        let b = breakdown_for("claude-sonnet-4", 1_000, 0, 100_000, 5_000);
        assert!((b.cache_cost - 0.04875).abs() < 1e-9);
        assert!((b.total_cost - 0.05175).abs() < 1e-9);
        // The saving stands next to the charge instead of replacing it.
        assert!((b.cache_savings - 0.27).abs() < 1e-9);
        assert_eq!(b.cache_read_tokens, 100_000);
        assert_eq!(b.cache_creation_tokens, 5_000);
    }

    #[test]
    fn cache_heavy_day_is_not_reported_as_nearly_free() {
        // The shape of a real day on this machine: a few thousand fresh
        // input tokens against hundreds of millions read from cache. The
        // old arithmetic billed the cache at zero and called that the
        // total, so the report answered "what did today cost?" with a
        // number that left out almost all of the input side.
        let b = breakdown_for("claude-opus-4", 10_000, 2_000, 400_000_000, 0);
        let without_cache = b.input_cost + b.output_cost;
        assert!(b.total_cost > without_cache * 100.0);
    }

    #[test]
    fn display_hides_cache_line_only_when_no_cache_traffic() {
        let no_cache = breakdown_for("claude-sonnet-4", 1_000, 500, 0, 0);
        assert!(!no_cache.format_display().contains("Cache:"));
        let cached = breakdown_for("claude-sonnet-4", 1_000, 500, 10_000, 0);
        let shown = cached.format_display();
        assert!(shown.contains("Cache:"));
        assert!(shown.contains("Total:"));
        assert!(cached.format_compact().contains("claude-sonnet-4"));
    }
}
