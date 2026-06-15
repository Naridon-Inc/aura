//! `no-secrets` gate — wraps the Semantic Sentinel flag the parser already
//! sets on every node (`AstNode::contains_secret`, see `aura-cli/src/parser.rs`
//! ≈322). It does NOT re-scan: the CLI hands in the already-parsed nodes plus
//! the same `secret_allowlist` the inline pre-commit gate honors, so behavior
//! is identical. Blocking by default — a leaked credential must stop the commit.

use crate::gates::{gate_result, Gate, GateContext, GateOpts};
use crate::model::{Status, StepResult};

pub struct NoSecretsGate;

impl Gate for NoSecretsGate {
    fn id(&self) -> &'static str {
        "no-secrets"
    }

    fn default_blocking(&self) -> bool {
        true
    }

    fn default_name(&self) -> &'static str {
        "No leaked secrets"
    }

    fn evaluate(&self, name: &str, ctx: &GateContext, opts: GateOpts) -> StepResult {
        let flagged: Vec<&str> = ctx
            .nodes
            .iter()
            .filter(|n| n.contains_secret)
            .filter_map(|n| n.identifier.as_deref())
            .filter(|ident| !ctx.secret_allowlist.iter().any(|a| a == ident))
            .collect();

        if flagged.is_empty() {
            return gate_result(
                name,
                self.id(),
                Status::Pass,
                opts.blocking,
                "No secrets or credentials in the changed code.".to_string(),
                None,
                0,
            );
        }

        let summary = if flagged.len() == 1 {
            format!("A possible secret was found in `{}`.", flagged[0])
        } else {
            format!("{} possible secrets were found in the changed code.", flagged.len())
        };
        let detail = format!(
            "High-entropy values detected in: {}\nIf one is legitimate, allowlist it with `aura request-access <name>`.",
            flagged.join(", ")
        );
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
