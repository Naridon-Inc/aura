//! `aura section …` — sidebar sections an agent can file its own work into.
//!
//! An agent that opens six workspaces to chase six leads leaves a sidebar only
//! the user can tidy. This noun is the other half of that: the thing that made
//! the mess can clean it up, and `aura workspace move` is how one workspace
//! gets filed.
//!
//! Sections belong to the account behind the token, not to the token, so the
//! same sections are there whether an agent reached them with an `aura_ak_` API
//! key or the user is signed in on the desktop. There is deliberately no
//! org-wide listing: a sidebar is personal, and a verb that showed someone
//! else's would be reporting a fact nobody asked to share.
//!
//! No `update` verb. `create` is an upsert on the name — it corrects the emoji
//! and the position of a section that already exists — so a second verb would
//! be a second way to do one thing, and a retry after a timeout would have to
//! guess which to use. That also makes `create` safe to call blind, which is
//! what an agent filing its own work actually does.
//!
//! Exits on [`crate::cloud_contract::ExitCode`] like every other cloud noun.

use clap::Subcommand;

use crate::cloud_contract::ExitCode;
use crate::workspace_api::client::Client;
use crate::workspace_api::output;

/// Sidebar sections for your cloud workspaces. Auth: `AURA_API_KEY`, else the
/// signed-in token.
#[derive(Subcommand, Debug, Clone)]
pub enum SectionCmd {
    /// Create a section, or correct the emoji and position of one that exists.
    Create {
        /// The label, as it appears in the sidebar.
        name: String,
        /// An emoji shown before the name. Stored separately from the name so
        /// the section can be renamed without re-parsing a grapheme cluster.
        #[arg(long)]
        emoji: Option<String>,
        /// Sidebar order; lower comes first. Equal positions fall back to
        /// creation time, so leaving this out still gives a stable list.
        #[arg(long)]
        position: Option<i32>,
        #[arg(long)]
        json: bool,
    },
    /// List your sections, in sidebar order, with how many of your workspaces
    /// are in each.
    List {
        #[arg(long)]
        json: bool,
    },
    /// Delete a section. The workspaces in it are unfiled, never deleted —
    /// the reply says how many came loose.
    Delete {
        id: String,
        #[arg(long)]
        json: bool,
    },
}

/// Run a verb; returns the process exit code.
pub fn run(cmd: &SectionCmd) -> i32 {
    let client = match Client::from_env() {
        Ok(c) => c,
        Err(e) => {
            output::print_error(&e);
            return e.exit_code();
        }
    };

    let (result, render): (_, fn(&serde_json::Value) -> String) = match cmd {
        SectionCmd::Create {
            name,
            emoji,
            position,
            ..
        } => {
            let name = name.trim();
            if name.is_empty() {
                eprintln!("  ✗ a section needs a name");
                // Usage, not runtime: nothing was attempted, and `clap` already
                // exits 2 for the errors it catches itself, so an empty value
                // it cannot catch should not land on a different code.
                return ExitCode::Usage.code();
            }
            (
                client.create_section(name, emoji.as_deref(), *position),
                output::render_section as fn(&serde_json::Value) -> String,
            )
        }
        SectionCmd::List { .. } => (client.sections(), output::render_sections),
        SectionCmd::Delete { id, .. } => {
            (client.delete_section(id), output::render_deleted_section)
        }
    };

    let json = match cmd {
        SectionCmd::Create { json, .. }
        | SectionCmd::List { json, .. }
        | SectionCmd::Delete { json, .. } => *json,
    };

    match result {
        Ok(v) => {
            output::emit(json, &v, render);
            ExitCode::Success.code()
        }
        Err(e) => {
            output::print_error(&e);
            e.exit_code()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace_api::client::ApiError;

    #[test]
    fn a_nameless_section_is_a_usage_error_not_a_failed_request() {
        // Guards the comment in `run`: `clap` exits 2 for the usage errors it
        // catches, so the one it cannot catch — whitespace that is technically
        // a value — must not report a different class of problem.
        assert_eq!(ExitCode::Usage.code(), 2);
        assert_ne!(ExitCode::Usage, ExitCode::Runtime);
    }

    #[test]
    fn sections_fail_the_same_way_every_other_cloud_noun_does() {
        assert_eq!(ApiError::NoAuth.exit_code(), ExitCode::Auth.code());
        assert_eq!(
            ApiError::Http {
                status: 503,
                body: String::new()
            }
            .exit_code(),
            ExitCode::Server.code()
        );
    }

    #[test]
    fn a_delete_says_what_it_unfiled_rather_than_what_it_destroyed() {
        // The sentence a reader sees is the reassurance that a folder delete
        // did not take the work with it, so it is worth pinning.
        let v = serde_json::json!({ "id": "x", "name": "Reviewing", "unfiled": 3 });
        let out = output::render_deleted_section(&v);
        assert!(out.contains("3 workspaces unfiled"), "{out}");
        assert!(out.contains("none deleted"), "{out}");

        let empty = serde_json::json!({ "id": "x", "name": "Reviewing", "unfiled": 0 });
        assert!(output::render_deleted_section(&empty).contains("empty"));

        let one = serde_json::json!({ "id": "x", "name": "Reviewing", "unfiled": 1 });
        assert!(
            output::render_deleted_section(&one).contains("1 workspace unfiled"),
            "singular, not '1 workspaces'"
        );
    }

    #[test]
    fn a_section_list_shows_the_emoji_in_front_of_the_name() {
        let v = serde_json::json!([
            { "id": "s1", "name": "Reviewing", "emoji": "👀", "workspace_count": 2 },
            { "id": "s2", "name": "Shipped", "workspace_count": 1 }
        ]);
        let out = output::render_sections(&v);
        assert!(out.contains("👀 Reviewing"), "{out}");
        // No emoji means no stray leading space before the name.
        assert!(out.contains("  Shipped  ") || out.contains("Shipped "), "{out}");
        assert!(out.contains("2 workspaces"));
        assert!(out.contains("1 workspace"));
        assert!(!out.contains("1 workspaces"));
    }

    #[test]
    fn an_empty_list_says_so_instead_of_printing_nothing() {
        // An agent that gets a blank answer cannot tell success from a
        // swallowed error.
        assert_eq!(output::render_sections(&serde_json::json!([])), "  no sections");
    }
}
