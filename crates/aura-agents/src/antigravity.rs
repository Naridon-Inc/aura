//! Antigravity provider — Google's `agy` agent CLI.
//!
//! Argv shapes (verified against `agy --help`, v1.1.5):
//!   * OneShot / StreamJson: `agy --model <m> --effort <e> --print <prompt>`
//!     `--print` (alias `--prompt`, short `-p`) "runs a single prompt
//!     non-interactively and prints the response" — it takes the prompt as
//!     its value and waits for the turn (`--print-timeout`, default 5m).
//!   * PtyRepl: `agy` (bare interactive REPL — the terminal-tab launch).
//!
//! `agy` doesn't emit Anthropic-style stream-json, so the caller renders its
//! stdout as a single `AssistantText` block, same as codex and gemini.
//!
//! `agy models` lists the reasoning tier baked into each id
//! (`gemini-3.6-flash-high`, `gemini-3.6-flash-medium`, …). The picker instead
//! shows ONE row per *base* model (`gemini-3.6-flash`) and lets the shared
//! Level chip (Low/Medium/High) pick the tier — same control every other CLI
//! gets. `build_invocation` re-attaches the tier here, composing a real id from
//! agy's own list (`<base>-<tier>`), clamped to the tiers that base actually
//! offers (e.g. `gemini-3.1-pro` has no medium). Models with no reasoning tier
//! (`claude-sonnet-4-6`, `claude-opus-4-6-thinking`) pass through as-is and take
//! the effort via the separate `--effort` knob so the Level chip still bites.

use crate::{
    AgentProvider, Capabilities, CostPer1k, InvokeMode, InvokeRequest, Invocation, ReasoningEffort,
};

pub struct Antigravity;

impl Antigravity {
    /// Map the cross-agent effort onto `agy --effort` (low|medium|high).
    /// `fast` collapses to the floor; `Max` caps at `high` (agy's ceiling).
    /// Used only for the base models that take `--effort` directly (the ones
    /// with no id-baked tier); tiered bases compose the tier into `--model`.
    fn effort_value(effort: Option<ReasoningEffort>, fast: bool) -> Option<&'static str> {
        if fast {
            return Some("low");
        }
        match effort? {
            ReasoningEffort::Low => Some("low"),
            ReasoningEffort::Medium => Some("medium"),
            ReasoningEffort::High | ReasoningEffort::Max => Some("high"),
        }
    }

    /// The reasoning tiers a base model exposes, ascending, or `None` when the
    /// base takes no id-baked tier (its id is already complete). Kept in lockstep
    /// with `agy models` — the source of truth for which `<base>-<tier>` ids exist.
    fn agy_tiers(base: &str) -> Option<&'static [&'static str]> {
        match base {
            "gemini-3.6-flash" | "gemini-3.5-flash" => Some(&["low", "medium", "high"]),
            "gemini-3.1-pro" => Some(&["low", "high"]), // no medium tier
            "gpt-oss-120b" => Some(&["medium"]),        // only a medium tier ships
            _ => None, // claude-sonnet-4-6, claude-opus-4-6-thinking, unknown → as-is
        }
    }

    /// Rank the requested effort as 0=low, 1=medium, 2=high. `Auto` (None) lands
    /// on a balanced middle; `fast` floors to low; `Max` caps at high.
    fn effort_rank(effort: Option<ReasoningEffort>, fast: bool) -> usize {
        if fast {
            return 0;
        }
        match effort {
            None => 1, // Auto → balanced
            Some(ReasoningEffort::Low) => 0,
            Some(ReasoningEffort::Medium) => 1,
            Some(ReasoningEffort::High) | Some(ReasoningEffort::Max) => 2,
        }
    }

    /// Pick the available tier closest to the requested effort. Ties break toward
    /// the higher tier (e.g. `gemini-3.1-pro` on Medium → `high`, since it has no
    /// medium). A base with a single tier (`gpt-oss-120b`) always returns it.
    fn pick_tier(
        tiers: &[&'static str],
        effort: Option<ReasoningEffort>,
        fast: bool,
    ) -> &'static str {
        let want = Self::effort_rank(effort, fast) as i64;
        let rank = |t: &str| -> i64 {
            match t {
                "low" => 0,
                "medium" => 1,
                "high" => 2,
                _ => 1,
            }
        };
        tiers
            .iter()
            .copied()
            .min_by_key(|t| {
                let r = rank(t);
                ((r - want).abs(), -r) // closest; tie → higher tier
            })
            .unwrap_or("medium")
    }

    /// Resolve the picker's base model + effort chip into the concrete `--model`
    /// value and any separate `--effort` flag. Returns `(model, effort)` where
    /// `effort` is `Some` only for bases that carry no id-baked tier.
    fn resolve_model(
        model: Option<&str>,
        effort: Option<ReasoningEffort>,
        fast: bool,
    ) -> (Option<String>, Option<&'static str>) {
        match model {
            Some(base) => match Self::agy_tiers(base) {
                // Tiered base → bake the tier into the id (an id from agy's own
                // list); the `--effort` flag would be redundant, so drop it.
                Some(tiers) => (
                    Some(format!("{base}-{}", Self::pick_tier(tiers, effort, fast))),
                    None,
                ),
                // No id-baked tier (or an already-complete id, e.g. a resumed
                // `gemini-3.6-flash-high`) → pass through and let `--effort` carry
                // the chip.
                None => (Some(base.to_string()), Self::effort_value(effort, fast)),
            },
            // No model picked → stay on agy's default, effort still applies.
            None => (None, Self::effort_value(effort, fast)),
        }
    }
}

impl AgentProvider for Antigravity {
    fn id(&self) -> &str {
        "antigravity"
    }

    fn label(&self) -> &str {
        "Antigravity"
    }

    fn bin_name(&self) -> &str {
        "agy"
    }

    fn capabilities(&self) -> Capabilities {
        // Non-interactive `--print` gives us a real OneShot turn (rendered as
        // a single text block); it's not Anthropic stream-json, so `stream` is
        // false, same as codex/gemini. `resume` stays false until a desktop
        // handoff writes an `agy` conversation for `--conversation` to reopen.
        Capabilities {
            stream: false,
            pty: true,
            resume: false,
        }
    }

    fn cost_per_1k(&self) -> Option<CostPer1k> {
        // Cost varies by the backend the chosen `--model` routes to; the CLI
        // reports its own usage, so we don't guess a single rate here.
        None
    }

    fn build_invocation(&self, req: &InvokeRequest) -> Result<Invocation, String> {
        match req.mode {
            InvokeMode::OneShot | InvokeMode::StreamJson => {
                let mut args: Vec<String> = vec![];
                // Base model + Level chip → a concrete `agy --model <id>` (tier
                // baked for tiered bases) plus a `--effort` only where the id
                // carries no tier of its own.
                let (model, effort) = Self::resolve_model(req.model, req.effort, req.fast);
                if let Some(model) = model {
                    args.push("--model".into());
                    args.push(model);
                }
                if let Some(effort) = effort {
                    args.push("--effort".into());
                    args.push(effort.into());
                }
                // Cross-agent permission mode → agy's `--mode` /
                // `--dangerously-skip-permissions`. Empty when unset.
                if let Some(policy) = req.approval {
                    args.extend(policy.antigravity_args());
                }
                // `--print <prompt>` last so its value can't be mistaken for a
                // flag by the parser. Non-interactive: runs the turn, prints
                // the response, exits.
                args.push("--print".into());
                args.push(req.prompt.into());
                Ok(Invocation {
                    bin: "agy".into(),
                    args,
                    env: vec![],
                    stdout_is_stream_json: false,
                })
            }
            InvokeMode::PtyRepl => {
                // Bare interactive REPL — the terminal-tab launch, byte-identical
                // to the prior interactive-only preset.
                Ok(Invocation {
                    bin: "agy".into(),
                    args: vec![],
                    env: vec![],
                    stdout_is_stream_json: false,
                })
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ApprovalPolicy, InvokeMode, InvokeRequest};

    fn req(mode: InvokeMode, model: Option<&'static str>) -> InvokeRequest<'static> {
        InvokeRequest {
            prompt: "hello",
            mode,
            resume_session_id: None,
            attachments_via_stdin: false,
            effort: None,
            fast: false,
            model,
            approval: None,
        }
    }

    /// OneShot forwards the picked model as `--model <id>` and passes the
    /// prompt through `--print`.
    #[test]
    fn oneshot_forwards_model_and_print() {
        let inv = Antigravity
            .build_invocation(&req(InvokeMode::OneShot, Some("gemini-3.6-flash-high")))
            .unwrap();
        assert_eq!(inv.bin, "agy");
        assert_eq!(
            inv.args,
            vec!["--model", "gemini-3.6-flash-high", "--print", "hello"]
        );
        assert!(!inv.stdout_is_stream_json);
    }

    /// No model picked → no `--model` flag (stays on agy's own default).
    #[test]
    fn oneshot_without_model_omits_flag() {
        let inv = Antigravity
            .build_invocation(&req(InvokeMode::OneShot, None))
            .unwrap();
        assert_eq!(inv.args, vec!["--print", "hello"]);
    }

    /// A base tiered model + the High chip composes a real agy id and drops the
    /// now-redundant `--effort` (the tier lives in the `--model` value).
    #[test]
    fn base_model_bakes_tier_from_effort_chip() {
        let mut r = req(InvokeMode::OneShot, Some("gemini-3.6-flash"));
        r.effort = Some(ReasoningEffort::High);
        let inv = Antigravity.build_invocation(&r).unwrap();
        assert_eq!(
            inv.args,
            vec!["--model", "gemini-3.6-flash-high", "--print", "hello"]
        );
    }

    /// Auto (no effort) on a tiered base lands on the balanced middle tier.
    #[test]
    fn base_model_auto_picks_medium() {
        let inv = Antigravity
            .build_invocation(&req(InvokeMode::OneShot, Some("gemini-3.6-flash")))
            .unwrap();
        assert_eq!(
            inv.args,
            vec!["--model", "gemini-3.6-flash-medium", "--print", "hello"]
        );
    }

    /// A base with no medium tier snaps a Medium chip to the nearest (higher) one.
    #[test]
    fn base_without_medium_snaps_up() {
        let mut r = req(InvokeMode::OneShot, Some("gemini-3.1-pro"));
        r.effort = Some(ReasoningEffort::Medium);
        let inv = Antigravity.build_invocation(&r).unwrap();
        assert_eq!(
            inv.args,
            vec!["--model", "gemini-3.1-pro-high", "--print", "hello"]
        );
    }

    /// A single-tier base always resolves to its one id regardless of the chip.
    #[test]
    fn single_tier_base_ignores_chip() {
        let mut r = req(InvokeMode::OneShot, Some("gpt-oss-120b"));
        r.effort = Some(ReasoningEffort::Low);
        let inv = Antigravity.build_invocation(&r).unwrap();
        assert_eq!(
            inv.args,
            vec!["--model", "gpt-oss-120b-medium", "--print", "hello"]
        );
    }

    /// A base with no id-baked tier passes through and keeps `--effort`, so the
    /// Level chip still adjusts it.
    #[test]
    fn untiered_base_keeps_effort_flag() {
        let mut r = req(InvokeMode::OneShot, Some("claude-sonnet-4-6"));
        r.effort = Some(ReasoningEffort::High);
        let inv = Antigravity.build_invocation(&r).unwrap();
        assert_eq!(
            inv.args,
            vec!["--model", "claude-sonnet-4-6", "--effort", "high", "--print", "hello"]
        );
    }

    /// Fast floors a tiered base to its lowest tier.
    #[test]
    fn fast_floors_tier() {
        let mut r = req(InvokeMode::OneShot, Some("gemini-3.6-flash"));
        r.fast = true;
        let inv = Antigravity.build_invocation(&r).unwrap();
        assert_eq!(
            inv.args,
            vec!["--model", "gemini-3.6-flash-low", "--print", "hello"]
        );
    }

    /// Approval policy maps onto agy's real flags before `--print`.
    #[test]
    fn approval_plan_maps_to_mode_flag() {
        let mut r = req(InvokeMode::OneShot, None);
        r.approval = Some(ApprovalPolicy::Plan);
        let inv = Antigravity.build_invocation(&r).unwrap();
        assert_eq!(inv.args, vec!["--mode", "plan", "--print", "hello"]);
    }

    /// PtyRepl stays a bare `agy` REPL — the terminal-tab launch.
    #[test]
    fn pty_is_bare_repl() {
        let inv = Antigravity
            .build_invocation(&req(InvokeMode::PtyRepl, None))
            .unwrap();
        assert!(inv.args.is_empty());
    }
}
