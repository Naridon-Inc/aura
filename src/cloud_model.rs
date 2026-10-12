//! `aura model …` — which models the cloud can route to.
//!
//! The same question `aura workspace models` answers, at the top level where
//! an agent looks for it. A model is not a property of a workspace: it is
//! chosen *before* one exists (`workspace create --model`), so an agent that
//! has to name a model has to ask about it without having a workspace to ask
//! through. Nesting the only way to find out under the noun you need it for
//! first is the kind of ordering that makes an agent guess a model id.
//!
//! This is a surface, not an implementation: one call into
//! [`crate::workspace_api::client`] and the renderer that module already has.
//! Duplicating either would let `aura model list` and `aura workspace models`
//! disagree about what the server said, which is worse than the nesting.
//!
//! `aura workspace models` keeps working.

use clap::Subcommand;

use crate::cloud_contract::ExitCode;
use crate::workspace_api::client::Client;
use crate::workspace_api::output;

/// Models this cloud can route to. Auth: `AURA_API_KEY`, else the signed-in
/// token.
#[derive(Subcommand, Debug, Clone)]
pub enum ModelCmd {
    /// List the model ids, their provider and whether a key is configured.
    List {
        #[arg(long)]
        json: bool,
    },
}

/// Run a verb; returns the process exit code.
pub fn run(cmd: &ModelCmd) -> i32 {
    match cmd {
        ModelCmd::List { json } => {
            let client = match Client::from_env() {
                Ok(c) => c,
                Err(e) => {
                    output::print_error(&e);
                    return e.exit_code();
                }
            };
            match client.models() {
                Ok(v) => {
                    output::emit(*json, &v, output::render_models);
                    ExitCode::Success.code()
                }
                Err(e) => {
                    output::print_error(&e);
                    e.exit_code()
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace_api::client::ApiError;

    #[test]
    fn listing_models_fails_the_same_way_the_nested_verb_does() {
        // The point of this noun is to be the same call under a better name,
        // so a script must be able to treat the two spellings as one. These
        // are the codes `aura workspace models` exits with.
        assert_eq!(ApiError::NoAuth.exit_code(), ExitCode::Auth.code());
        assert_eq!(
            ApiError::Network("dns".into()).exit_code(),
            ExitCode::Runtime.code()
        );
        assert_eq!(
            ApiError::Http {
                status: 500,
                body: String::new()
            }
            .exit_code(),
            ExitCode::Server.code()
        );
    }

    #[test]
    fn a_model_list_renders_through_the_one_renderer() {
        // Guards the module's claim: no second rendering of the models
        // payload, so the two spellings cannot print different things.
        let v = serde_json::json!({
            "models": [
                { "id": "claude-opus-5-5", "provider": "anthropic", "tier": "deep", "available": true }
            ],
            "default_provider": "anthropic"
        });
        let out = output::render_models(&v);
        assert!(out.contains("claude-opus-5-5"));
        assert!(out.contains("key configured"));
        assert!(out.contains("default provider: anthropic"));
    }
}
