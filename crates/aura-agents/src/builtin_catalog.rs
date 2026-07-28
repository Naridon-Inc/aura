//! Compiled-in catalog of "extra" agent-CLI presets.
//!
//! These are well-known coding-agent CLIs Aura recognises and can launch
//! into the built-in terminal, even though it doesn't (yet) drive them
//! headlessly. They exist so the surface can offer them as one-tap presets
//! — the same convenience the first-party providers get — instead of the
//! user hand-writing a `~/.aura/agents.toml` block for each.
//!
//! Every entry here is *interactive-only*: no args template, which
//! `GenericCliProvider` reads as "spawn a bare REPL for PtyRepl, and tell
//! the caller it's a terminal CLI for the headless modes". That keeps us
//! honest — we don't fabricate a `--prompt`-style flag we haven't verified
//! against the real binary. When a vendor's non-interactive interface is
//! confirmed, promote it to a dedicated module (see `codex.rs`) or set
//! `args_oneshot` here.
//!
//! Users can still override any of these — a same-`id` `[[agent]]` in
//! `agents.toml` replaces the catalog entry (`Registry::push`), which is
//! the escape hatch for a custom bin path or a real headless flag.

use crate::generic_cli::GenericProviderConfig;

/// An interactive-terminal preset: known bin, no args template.
fn interactive(id: &str, label: &str, bin: &str) -> GenericProviderConfig {
    GenericProviderConfig {
        id: id.into(),
        label: label.into(),
        bin: bin.into(),
        args: vec![],
        args_oneshot: None,
        args_stream: None,
        args_pty: None,
        classifier_prefs: vec![],
        cost_per_1k_in: None,
        cost_per_1k_out: None,
        supports_stream: false,
        supports_pty: true,
        supports_resume: false,
        stdout_is_stream_json: false,
        env: std::collections::HashMap::new(),
    }
}

/// The extra presets seeded into every registry, in display order.
///
/// Antigravity used to live here as an interactive-only preset, but its
/// non-interactive `--print` interface is now confirmed, so it's a dedicated
/// headless provider (`antigravity.rs`) with real model + effort control.
pub fn extras() -> Vec<GenericProviderConfig> {
    vec![
        // Aider — the popular open-source pair-programmer CLI.
        interactive("aider", "Aider", "aider"),
        // Sourcegraph's Amp.
        interactive("amp", "Amp", "amp"),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{AgentProvider, InvokeMode, InvokeRequest, generic_cli::GenericCliProvider};

    fn req(mode: InvokeMode) -> InvokeRequest<'static> {
        InvokeRequest {
            prompt: "hi",
            mode,
            resume_session_id: None,
            attachments_via_stdin: false,
            effort: None,
            fast: false,
            model: None,
            approval: None,
        }
    }

    /// Every catalog entry must carry a non-empty id/label/bin and advertise
    /// PTY (they're terminal presets) — a typo here would ship a dead preset.
    #[test]
    fn extras_are_well_formed() {
        for cfg in extras() {
            assert!(!cfg.id.is_empty(), "empty id");
            assert!(!cfg.label.is_empty(), "empty label for {}", cfg.id);
            assert!(!cfg.bin.is_empty(), "empty bin for {}", cfg.id);
            assert!(cfg.supports_pty, "{} should support pty", cfg.id);
        }
    }

    /// Aider is reachable and launches its bin as a bare REPL (interactive
    /// preset — no verified headless flag).
    #[test]
    fn aider_launches_bare_repl() {
        let cfg = extras().into_iter().find(|c| c.id == "aider").unwrap();
        let p = GenericCliProvider::new(cfg);
        assert_eq!(p.bin_name(), "aider");
        let inv = p.build_invocation(&req(InvokeMode::PtyRepl)).unwrap();
        assert_eq!(inv.bin, "aider");
        assert!(inv.args.is_empty());
    }
}
