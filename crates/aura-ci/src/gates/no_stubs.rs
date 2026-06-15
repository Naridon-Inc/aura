//! `no-stubs` gate — wraps the `AstNode::is_stub` flag the parser already sets
//! (TODO / `todo!()` / `unimplemented!()` / empty bodies, see
//! `aura-cli/src/parser.rs` ≈322). Half-finished code is the #1 thing a
//! non-engineer fears the AI left behind, so this is blocking on pre-commit by
//! default. It reads the already-parsed staged/diff nodes — no re-scan.

use crate::gates::{gate_result, Gate, GateContext, GateOpts};
use crate::model::{Status, StepResult};

pub struct NoStubsGate;

impl Gate for NoStubsGate {
    fn id(&self) -> &'static str {
        "no-stubs"
    }

    fn default_blocking(&self) -> bool {
        true
    }

    fn default_name(&self) -> &'static str {
        "No half-finished code"
    }

    fn evaluate(&self, name: &str, ctx: &GateContext, opts: GateOpts) -> StepResult {
        let stubs: Vec<&crate::gates::CiNode> = ctx.nodes.iter().filter(|n| n.is_stub).collect();

        if stubs.is_empty() {
            return gate_result(
                name,
                self.id(),
                Status::Pass,
                opts.blocking,
                "No half-finished code — nothing was left as a placeholder.".to_string(),
                None,
                0,
            );
        }

        let summary = if stubs.len() == 1 {
            "1 piece of code looks half-finished (a placeholder, not real logic).".to_string()
        } else {
            format!(
                "{} pieces of code look half-finished (placeholders, not real logic).",
                stubs.len()
            )
        };

        let mut lines = Vec::new();
        for n in stubs.iter().take(15) {
            let ident = n.identifier.as_deref().unwrap_or("(anonymous)");
            match (&n.file_path, n.start_line) {
                (Some(f), Some(l)) => lines.push(format!("• {} — {}:{}", ident, f, l)),
                (Some(f), None) => lines.push(format!("• {} — {}", ident, f)),
                _ => lines.push(format!("• {}", ident)),
            }
        }
        if stubs.len() > 15 {
            lines.push(format!("• … and {} more", stubs.len() - 15));
        }
        let detail = format!("Placeholders found:\n{}", lines.join("\n"));

        gate_result(
            name,
            self.id(),
            Status::Fail,
            opts.blocking,
            summary,
            Some(detail),
            0,
        )
    }
}
