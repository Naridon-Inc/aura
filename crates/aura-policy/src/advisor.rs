//! PolicyAdvisor — the LLM-allowed layer.
//!
//! Position in the pipeline:
//!
//! ```text
//!     propose → evaluate (deterministic) → verdict → [supervisor acts]
//!                                               ↓
//!                                           advise (non-binding)
//!                                               ↓
//!                                    suggestion block in sidebar
//! ```
//!
//! The advisor NEVER alters the verdict. It observes the decision, optionally
//! observes historical approvals/denials, and emits [`AdvisorSuggestion`]s that
//! surface in the sidebar as Messages. Humans act on them by opening a
//! rule-edit PR.
//!
//! This module is a stub. The first implementation is a simple frequency
//! counter ("you approved this pattern 10 times in 7 days; suggest rule?").
//! LLM-backed implementations come later and plug in via the [`PolicyAdvisor`]
//! trait.

use aura_blocks::{AgentRef, CapabilityGrade, PolicyDecision};
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;

/// What an advisor can emit. Always surfaces as a `Message`-kind block in the
/// sidebar; never a [`PolicyDecision`].
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdvisorSuggestion {
    pub suggested_at: OffsetDateTime,
    pub for_actor: AgentRef,
    pub kind: SuggestionKind,
    pub body_markdown: String,
    /// Optional proposed rule diff, ready to copy into a PR.
    pub proposed_rule_toml: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SuggestionKind {
    /// "You've approved this pattern N times. Want to auto-approve?"
    AutoRuleFromFrequency,
    /// "Your rule X has never fired in 30 days. Still needed?"
    StaleRule,
    /// "Two rules contradict. Here's the diff that would reconcile."
    RuleConflict,
    /// "Unusual approval pattern for this actor/time." — anomaly flag.
    Anomaly,
}

/// The advisor trait. First impl is a frequency counter; later impls can use
/// an LLM. Either way, output is a suggestion, never a verdict.
pub trait PolicyAdvisor: Send + Sync {
    fn observe(&mut self, decision: &PolicyDecision, approved_by_human: Option<bool>);
    fn suggestions(&self) -> Vec<AdvisorSuggestion>;
}

/// Frequency-based stub advisor. Counts approvals per (actor, reason). After
/// threshold approvals inside a window, emits `AutoRuleFromFrequency`.
pub struct FrequencyAdvisor {
    threshold: u32,
    window: time::Duration,
    // (actor, reason_hash) → approvals timestamps. Implementation detail.
    approvals: std::collections::HashMap<(String, String), Vec<OffsetDateTime>>,
    suggestions: Vec<AdvisorSuggestion>,
}

impl FrequencyAdvisor {
    pub fn new(threshold: u32, window_days: u32) -> Self {
        Self {
            threshold,
            window: time::Duration::days(window_days as i64),
            approvals: Default::default(),
            suggestions: Default::default(),
        }
    }
}

impl PolicyAdvisor for FrequencyAdvisor {
    fn observe(&mut self, decision: &PolicyDecision, approved_by_human: Option<bool>) {
        if decision.verdict != CapabilityGrade::Gate {
            return;
        }
        if approved_by_human != Some(true) {
            return;
        }
        let key = (decision.decided_by.0.clone(), decision.rules_fired.join(","));
        let v = self.approvals.entry(key.clone()).or_default();
        v.push(decision.decided_at);
        let cutoff = decision.decided_at - self.window;
        v.retain(|t| *t >= cutoff);
        if v.len() as u32 >= self.threshold {
            self.suggestions.push(AdvisorSuggestion {
                suggested_at: decision.decided_at,
                for_actor: decision.decided_by.clone(),
                kind: SuggestionKind::AutoRuleFromFrequency,
                body_markdown: format!(
                    "Approved {} times in the last {} days under rules [{}]. \
                     Consider adding an auto-rule.",
                    v.len(),
                    self.window.whole_days(),
                    decision.rules_fired.join(", "),
                ),
                proposed_rule_toml: None, // real impl drafts the TOML
            });
            v.clear(); // don't re-fire immediately
        }
    }

    fn suggestions(&self) -> Vec<AdvisorSuggestion> {
        self.suggestions.clone()
    }
}
