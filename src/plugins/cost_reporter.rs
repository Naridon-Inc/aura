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
                "  Cache:  {:>10} read / {} created  (saved ~${:.4})\n",
                self.cache_read_tokens, self.cache_creation_tokens, self.cache_savings
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

    let (input_rate, output_rate) = cost_per_model(model);

    let input_cost = (usage.input_tokens as f64 / 1000.0) * input_rate;
    let output_cost = (usage.output_tokens as f64 / 1000.0) * output_rate;

    // Cache reads are typically 90% cheaper than input tokens
    let cache_savings = (usage.cache_read_tokens as f64 / 1000.0) * input_rate * 0.9;

    let total_cost = input_cost + output_cost;

    Some(CostBreakdown {
        model: model.to_string(),
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        cache_read_tokens: usage.cache_read_tokens,
        cache_creation_tokens: usage.cache_creation_tokens,
        input_cost,
        output_cost,
        cache_savings,
        total_cost,
    })
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
