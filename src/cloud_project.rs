//! `aura project` — the repo a workspace belongs to (AURA-1437, item 9).
//!
//! An agent has to name a project to open a workspace, and until now the only
//! way to learn which projects it could name was to already know one. Three
//! reads, all of them safe to poll:
//!
//! - `aura project list` — the projects this key can reach.
//! - `aura project get <id>` — one of them, by id or by `owner/name`.
//! - `aura project workspaces <id>` — what is open in it.
//!
//! There is no `project create`. A project comes into being when a workspace
//! is opened in it, which is already a command; a second way to make one would
//! be a second set of rules about who may.
//!
//! All three paginate: `--limit` (default 25, capped at 100) and `--offset`,
//! and the plain-text output says when more rows are waiting so a reader does
//! not mistake a page for the whole list.

use clap::Subcommand;

use crate::cloud_contract::ExitCode;
use crate::workspace_api::client::Client;
use crate::workspace_api::output;
// The `--limit`/`--offset` rules live next to the client that sends them, so
// `aura workspace list` reads them the same way this does.
use crate::workspace_api::paging::{check_page, next_cmd};

#[derive(Subcommand, Debug)]
pub enum ProjectCmd {
    /// List the projects this key can reach, busiest first.
    // `allow_negative_numbers` so `--offset -1` reaches the check below and is
    // answered with what is wrong, instead of clap reading `-1` as a flag it
    // does not have and saying "unexpected argument".
    #[command(allow_negative_numbers = true)]
    List {
        /// Rows per page (default 25, capped at 100).
        #[arg(long)]
        limit: Option<i64>,
        /// Rows to skip.
        #[arg(long)]
        offset: Option<i64>,
        #[arg(long)]
        json: bool,
    },
    /// One project, by id or by `owner/name`.
    Get {
        id: String,
        #[arg(long)]
        json: bool,
    },
    /// The workspaces in one project.
    #[command(alias = "workspace", allow_negative_numbers = true)]
    Workspaces {
        id: String,
        /// Keep only workspaces in this state (`running`, `sleeping`,
        /// `archived`, …). Applied by the server before the page is cut, so a
        /// filtered page is not a filtered *page*.
        #[arg(long)]
        status: Option<String>,
        #[arg(long)]
        limit: Option<i64>,
        #[arg(long)]
        offset: Option<i64>,
        #[arg(long)]
        json: bool,
    },
}

pub fn run(cmd: &ProjectCmd) -> i32 {
    match execute(cmd) {
        Ok(code) => code,
        Err(e) => {
            output::print_error(&e);
            e.exit_code()
        }
    }
}

fn execute(cmd: &ProjectCmd) -> Result<i32, crate::workspace_api::client::ApiError> {
    match cmd {
        ProjectCmd::List { limit, offset, json } => {
            if let Some(why) = check_page(*limit, *offset) {
                eprintln!("  ✗ {why}");
                return Ok(ExitCode::Usage.code());
            }
            let c = Client::from_env()?;
            let v = c.projects(*limit, *offset)?;
            let next = next_cmd("aura project list", None, *limit);
            output::emit(*json, &v, |v| output::render_projects(v, &next));
            Ok(0)
        }
        ProjectCmd::Get { id, json } => {
            let c = Client::from_env()?;
            let v = c.project(id)?;
            output::emit(*json, &v, output::render_project);
            Ok(0)
        }
        ProjectCmd::Workspaces {
            id,
            status,
            limit,
            offset,
            json,
        } => {
            if let Some(why) = check_page(*limit, *offset) {
                eprintln!("  ✗ {why}");
                return Ok(ExitCode::Usage.code());
            }
            let c = Client::from_env()?;
            let v = c.project_workspaces(id, status.as_deref(), *limit, *offset)?;
            let next = next_cmd(
                &format!("aura project workspaces {id}"),
                status.as_deref(),
                *limit,
            );
            output::emit(*json, &v, |v| output::render_paged_workspaces(v, &next));
            Ok(0)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_project_listing_hints_its_own_command_back() {
        // The window rules themselves now live in
        // `workspace_api::paging`, with their tests. What is still this
        // module's to get right is which command the footer names: a page of
        // one project's workspaces that hinted `aura project list` would send
        // the reader to a different listing for the rest of their rows.
        assert_eq!(
            next_cmd("aura project list", None, Some(10)),
            "aura project list --limit 10"
        );
        assert_eq!(
            next_cmd("aura project workspaces acme/app", Some("archived"), Some(2)),
            "aura project workspaces acme/app --status archived --limit 2"
        );
    }
}
