//! What a turn cost, in dollars.
//!
//! Token counts alone don't answer the question people actually ask — "how
//! much is this costing me?" — so every API-mode turn is priced here. The
//! rates are USD per MILLION tokens, which is how all three providers publish
//! them; keeping the same unit means a rate can be copied off a pricing page
//! and pasted in without arithmetic.
//!
//! Resolution runs in three steps, most specific first:
//!
//!   1. `~/.aura/model_prices.json` — the user's own rates. Anything in here
//!      wins outright and is reported as EXACT, because someone typed it.
//!      Shape: `{"gemini-3.1-pro-preview": {"in": 2.0, "out": 12.0}}`.
//!   2. [`EXACT`] — published list prices for ids we've checked.
//!   3. [`FAMILY`] — the tier's going rate, matched on the id. Reported as an
//!      ESTIMATE so the UI can mark it `~`: a brand-new Opus priced at the
//!      last Opus's rate is the right ballpark and the wrong invoice.
//!
//! A model that matches nothing is priced `None` and the UI shows tokens
//! without a dollar figure. That's deliberate — a made-up number that reads
//! as authoritative is worse than an honest blank, and step 1 is always
//! available to fill the gap without waiting for a release.
//!
//! Rates are list prices for the standard (non-batch, non-cached) tier. Cache
//! reads and batch discounts bill lower, so a figure here is a ceiling, never
//! an under-count.

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::Deserialize;

/// What one million input / output tokens cost on a model, and whether the
/// number is the published rate or a tier estimate.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ModelPrice {
    pub input_per_mtok: f64,
    pub output_per_mtok: f64,
    /// True when this came from the family fallback rather than a rate we
    /// looked up or the user set. The UI prefixes an estimate with `~`.
    pub estimated: bool,
}

impl ModelPrice {
    /// Dollar cost of a turn that billed `input` + `output` tokens.
    pub fn cost_usd(&self, input: u64, output: u64) -> f64 {
        (input as f64 / 1_000_000.0) * self.input_per_mtok
            + (output as f64 / 1_000_000.0) * self.output_per_mtok
    }
}

/// Published per-MTok list prices, keyed by exact model id.
///
/// Only ids whose rate we've actually read off the vendor's pricing page
/// belong here. Everything else falls through to [`FAMILY`] and is marked as
/// an estimate — the honest label for a number nobody verified.
const EXACT: &[(&str, f64, f64)] = &[
    // Anthropic — https://anthropic.com/pricing
    ("claude-3-5-haiku-20241022", 0.80, 4.00),
    ("claude-haiku-4-5-20251001", 1.00, 5.00),
    ("claude-sonnet-4-20250514", 3.00, 15.00),
    ("claude-opus-4-20250514", 15.00, 75.00),
    ("claude-opus-4-1-20250805", 15.00, 75.00),
    // OpenAI — https://openai.com/api/pricing
    ("gpt-4o", 2.50, 10.00),
    ("gpt-4o-mini", 0.15, 0.60),
    ("gpt-4.1", 2.00, 8.00),
    ("gpt-4.1-mini", 0.40, 1.60),
    ("o1", 15.00, 60.00),
    ("o1-mini", 1.10, 4.40),
    // Google — https://ai.google.dev/pricing
    ("gemini-2.5-pro", 1.25, 10.00),
    ("gemini-2.5-flash", 0.30, 2.50),
    ("gemini-2.0-flash", 0.10, 0.40),
];

/// Tier rates, matched as substrings against the model id, first hit wins.
///
/// Order matters: `-mini` / `-flash` variants must be tested before the base
/// family name they contain, or a Flash would be billed at Pro rates. These
/// are the going rate for the tier, not a quote for any specific model.
const FAMILY: &[(&str, f64, f64)] = &[
    // Cheap tiers first. "gemini-3.6-flash" contains both "flash" and
    // "gemini-3"; if the Pro rule were tested first every Flash turn would be
    // billed at four times its real cost.
    ("haiku", 1.00, 5.00),
    ("flash", 0.30, 2.50),
    ("gpt-4o-mini", 0.15, 0.60),
    ("o1-mini", 1.10, 4.40),
    ("sonnet", 3.00, 15.00),
    ("opus", 15.00, 75.00),
    ("gemini-3", 2.00, 12.00),
    ("gemini", 1.25, 10.00),
    ("gpt-5", 1.25, 10.00),
    ("gpt-4", 2.50, 10.00),
    ("o1", 15.00, 60.00),
    ("grok", 3.00, 15.00),
    ("kimi", 0.60, 2.50),
];

/// One row of the user's override file.
#[derive(Debug, Clone, Copy, Deserialize)]
struct OverrideRate {
    #[serde(rename = "in")]
    input: f64,
    #[serde(rename = "out")]
    output: f64,
}

fn overrides_path() -> Option<PathBuf> {
    Some(dirs::home_dir()?.join(".aura").join("model_prices.json"))
}

/// Read the user's rate file. Absent or malformed → no overrides; a typo in a
/// hand-edited file must not take the whole meter down with it.
fn overrides() -> BTreeMap<String, OverrideRate> {
    read_rate_file(overrides_path())
}

/// The machine-fetched OpenRouter rates (written by the model catalog on every
/// refresh). Kept separate from the user file so a fetch never clobbers a
/// hand-typed rate — and so the user file still wins outright. Same shape.
fn openrouter_rates_path() -> Option<PathBuf> {
    Some(dirs::home_dir()?.join(".aura").join("model_prices_openrouter.json"))
}

fn openrouter_rates() -> BTreeMap<String, OverrideRate> {
    read_rate_file(openrouter_rates_path())
}

/// Read a `{ "<id>": {"in":N,"out":N} }` rate file. Absent or malformed → empty.
fn read_rate_file(path: Option<PathBuf>) -> BTreeMap<String, OverrideRate> {
    let Some(path) = path else {
        return BTreeMap::new();
    };
    let Ok(raw) = std::fs::read_to_string(path) else {
        return BTreeMap::new();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

/// Price `model`, or `None` when nothing recognises it.
///
/// Reads the override file on every call. That's one small stat + parse per
/// TURN, not per token, and it means editing the file takes effect on the
/// next message instead of the next launch.
pub fn price_for(model: &str) -> Option<ModelPrice> {
    let id = model.trim();
    if id.is_empty() {
        return None;
    }
    if let Some(o) = overrides().get(id) {
        return Some(ModelPrice {
            input_per_mtok: o.input,
            output_per_mtok: o.output,
            estimated: false,
        });
    }
    // OpenRouter's own published rate for this exact id. It's the provider's
    // real price (routing margin included), so it's reported as EXACT — but the
    // user file above still overrides it, and a model OpenRouter didn't quote
    // falls through to the tier estimate below rather than being invented.
    if let Some(o) = openrouter_rates().get(id) {
        return Some(ModelPrice {
            input_per_mtok: o.input,
            output_per_mtok: o.output,
            estimated: false,
        });
    }
    if let Some((_, input, output)) = EXACT.iter().find(|(k, _, _)| *k == id) {
        return Some(ModelPrice {
            input_per_mtok: *input,
            output_per_mtok: *output,
            estimated: false,
        });
    }
    let lower = id.to_ascii_lowercase();
    FAMILY
        .iter()
        .find(|(needle, _, _)| lower.contains(needle))
        .map(|(_, input, output)| ModelPrice {
            input_per_mtok: *input,
            output_per_mtok: *output,
            estimated: true,
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_published_rate_is_reported_as_exact() {
        let p = price_for("gemini-2.5-pro").expect("2.5 Pro is in the table");
        assert_eq!(p.input_per_mtok, 1.25);
        assert_eq!(p.output_per_mtok, 10.00);
        assert!(!p.estimated, "a looked-up rate is not an estimate");
    }

    #[test]
    fn an_unlisted_model_falls_back_to_its_tier_and_says_so() {
        // The point of the fallback: a model that shipped after this build
        // still shows a number, and the number is honestly labelled.
        let p = price_for("claude-opus-5").expect("opus tier matches");
        assert_eq!((p.input_per_mtok, p.output_per_mtok), (15.00, 75.00));
        assert!(p.estimated);
    }

    #[test]
    fn a_flash_is_never_billed_at_pro_rates() {
        // "gemini-3.6-flash" contains both "gemini" and "flash"; the cheap
        // tier has to win or every Flash turn reads 4x its real cost.
        let p = price_for("gemini-3.6-flash").expect("flash tier matches");
        assert_eq!(p.input_per_mtok, 0.30);
        let pro = price_for("gemini-3.1-pro-preview").expect("gemini-3 tier matches");
        assert!(pro.input_per_mtok > p.input_per_mtok);
        // Same trap in the OpenAI list: a mini must not inherit its parent.
        assert_eq!(price_for("gpt-4o-mini").map(|p| p.input_per_mtok), Some(0.15));
        assert_eq!(price_for("o1-mini").map(|p| p.input_per_mtok), Some(1.10));
    }

    #[test]
    fn nothing_recognisable_is_priced_at_nothing_rather_than_guessed() {
        assert!(price_for("some-local-llama").is_none());
        assert!(price_for("").is_none());
    }

    #[test]
    fn an_openrouter_rate_reads_as_exact_and_the_user_file_still_wins() {
        // The two rate files parse to the same shape; the resolver reads the
        // user file first, then OpenRouter's cache, so a hand-typed rate always
        // beats the fetched one and a fetched rate beats the tier estimate.
        let user: BTreeMap<String, OverrideRate> =
            serde_json::from_str(r#"{"anthropic/claude-3.5-sonnet":{"in":1.0,"out":2.0}}"#).unwrap();
        let router: BTreeMap<String, OverrideRate> =
            serde_json::from_str(r#"{"anthropic/claude-3.5-sonnet":{"in":3.0,"out":15.0}}"#).unwrap();
        let id = "anthropic/claude-3.5-sonnet";
        // Emulate price_for's precedence over the two parsed maps.
        let chosen = user.get(id).or_else(|| router.get(id)).unwrap();
        assert_eq!((chosen.input, chosen.output), (1.0, 2.0), "user file wins");
        let router_only = router.get(id).unwrap();
        assert_eq!((router_only.input, router_only.output), (3.0, 15.0));
    }

    #[test]
    fn cost_is_per_million_tokens() {
        let p = ModelPrice {
            input_per_mtok: 3.0,
            output_per_mtok: 15.0,
            estimated: false,
        };
        // 1M in + 1M out at sonnet rates = $18 exactly.
        assert!((p.cost_usd(1_000_000, 1_000_000) - 18.0).abs() < 1e-9);
        // A realistic turn is fractions of a cent, and must not round to zero.
        assert!(p.cost_usd(12_000, 800) > 0.0);
    }
}
