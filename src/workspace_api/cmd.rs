//! The `aura workspace` verbs.
//!
//! Each verb resolves credentials, makes one call, renders, and returns an
//! exit code: `0` ok, `2` no/invalid credentials, `3` not found, `1` other.
//! `main.rs` turns a non-zero code into `process::exit` so the functions
//! here stay testable.

use std::thread;
use std::time::{Duration, Instant};

use clap::Subcommand;
use serde_json::Value;

use super::client::{self, ApiError, Client, CreateRequest};
use super::output;

/// Cloud workspaces for agents — create one, prompt it, read its replies,
/// park or close it. Auth: `AURA_API_KEY`, else the signed-in token.
#[derive(Subcommand, Debug, Clone)]
pub enum WorkspaceCmd {
    /// Create a workspace on a repo. Pass `--intent` so the board records
    /// why it exists; `--prompt` enqueues the first message in the same call.
    Create {
        /// `owner/name` or the repo's id.
        #[arg(long)]
        repo: String,
        /// Base branch to start from.
        #[arg(long)]
        branch: Option<String>,
        /// Title (the workspace's objective).
        #[arg(long)]
        title: Option<String>,
        /// WHY this workspace exists — shown on the board as its first note.
        #[arg(long)]
        intent: Option<String>,
        /// One of FeatureAdd, BugFix, Refactor, Revert, Performance, Docs, Deps.
        #[arg(long = "intent-type")]
        intent_type: Option<String>,
        /// First message to send right away.
        #[arg(long)]
        prompt: Option<String>,
        /// Model id the runner should use (see `aura workspace models`).
        #[arg(long)]
        model: Option<String>,
        /// Agent label to attribute the intent to (e.g. `claude@cli`).
        #[arg(long)]
        agent: Option<String>,
        #[arg(long)]
        json: bool,
    },
    /// Send a message to a workspace. Wakes a sleeping one.
    Prompt {
        id: String,
        message: String,
        /// Model override for this turn.
        #[arg(long)]
        model: Option<String>,
        #[arg(long)]
        json: bool,
    },
    /// Read a workspace's message log, oldest first.
    Messages {
        id: String,
        /// Only turns newer than this RFC3339 cursor (the `created_at` of the
        /// last turn you saw).
        #[arg(long)]
        since: Option<String>,
        /// Long-poll: keep asking until a non-user reply lands or this many
        /// seconds pass. Exit 0 with the reply, 1 on timeout.
        #[arg(long)]
        wait: Option<u64>,
        /// Page size (default 200, max 500).
        #[arg(long)]
        limit: Option<u32>,
        #[arg(long)]
        json: bool,
    },
    /// List the caller's workspaces, newest activity first.
    List {
        /// Keep only this status: running, sleeping, archived, ended.
        #[arg(long)]
        status: Option<String>,
        #[arg(long)]
        json: bool,
    },
    /// Show one workspace, including the intent it was created with.
    Get {
        id: String,
        #[arg(long)]
        json: bool,
    },
    /// Park a workspace. The next prompt wakes it.
    Sleep {
        id: String,
        #[arg(long)]
        json: bool,
    },
    /// Close a workspace for good. Prompts are refused afterwards.
    Archive {
        id: String,
        #[arg(long)]
        json: bool,
    },
    /// Models the server can route to, and which have a key configured.
    Models {
        #[arg(long)]
        json: bool,
    },
    /// Who this key is: user, org and scopes. Run it first with a new key.
    Whoami {
        #[arg(long)]
        json: bool,
    },
}

/// How often `messages --wait` re-asks.
const WAIT_POLL: Duration = Duration::from_secs(2);

/// Run a verb; returns the process exit code.
pub fn run(cmd: &WorkspaceCmd) -> i32 {
    match execute(cmd) {
        Ok(code) => code,
        Err(e) => {
            output::print_error(&e);
            e.exit_code()
        }
    }
}

fn execute(cmd: &WorkspaceCmd) -> Result<i32, ApiError> {
    match cmd {
        WorkspaceCmd::Create {
            repo,
            branch,
            title,
            intent,
            intent_type,
            prompt,
            model,
            agent,
            json,
        } => {
            let c = Client::from_env()?;
            let req = CreateRequest {
                repo: Some(repo.clone()),
                branch: branch.clone(),
                title: title.clone(),
                intent: intent.clone(),
                intent_type: intent_type.clone(),
                agent: agent.clone(),
                prompt: prompt.clone(),
                model: model.clone(),
            };
            let v = c.create(&req)?;
            output::emit(*json, &v, output::render_workspace);
            Ok(0)
        }
        WorkspaceCmd::Prompt {
            id,
            message,
            model,
            json,
        } => {
            let c = Client::from_env()?;
            let v = c.prompt(id, message, model.as_deref())?;
            output::emit(*json, &v, output::render_prompt_ack);
            Ok(0)
        }
        WorkspaceCmd::Messages {
            id,
            since,
            wait,
            limit,
            json,
        } => {
            let c = Client::from_env()?;
            match wait {
                None => {
                    let v = c.messages(id, since.as_deref(), *limit)?;
                    output::emit(*json, &v, output::render_messages);
                    Ok(0)
                }
                Some(secs) => {
                    let (v, replied) = wait_for_reply(&c, id, since.as_deref(), *limit, Duration::from_secs(*secs))?;
                    output::emit(*json, &v, output::render_messages);
                    if replied {
                        Ok(0)
                    } else {
                        eprintln!("  timed out after {secs}s with no reply");
                        Ok(1)
                    }
                }
            }
        }
        WorkspaceCmd::List { status, json } => {
            let c = Client::from_env()?;
            let v = c.list(status.as_deref())?;
            output::emit(*json, &v, output::render_workspace_list);
            Ok(0)
        }
        WorkspaceCmd::Get { id, json } => {
            let c = Client::from_env()?;
            let v = c.get(id)?;
            output::emit(*json, &v, output::render_workspace);
            Ok(0)
        }
        WorkspaceCmd::Sleep { id, json } => {
            let c = Client::from_env()?;
            let v = c.sleep(id)?;
            output::emit(*json, &v, output::render_workspace);
            Ok(0)
        }
        WorkspaceCmd::Archive { id, json } => {
            let c = Client::from_env()?;
            let v = c.archive(id)?;
            output::emit(*json, &v, output::render_workspace);
            Ok(0)
        }
        WorkspaceCmd::Models { json } => {
            let c = Client::from_env()?;
            let v = c.models()?;
            output::emit(*json, &v, output::render_models);
            Ok(0)
        }
        WorkspaceCmd::Whoami { json } => {
            let c = Client::from_env()?;
            let mut v = c.whoami()?;
            // Where the bearer came from is a client-side fact the server
            // cannot know; add it so a wrong key is diagnosable in one call.
            if let Value::Object(m) = &mut v {
                m.insert("token_source".into(), Value::String(c.auth().source.label().into()));
                m.insert("origin".into(), Value::String(c.auth().origin.clone()));
            }
            output::emit(*json, &v, output::render_whoami);
            Ok(0)
        }
    }
}

/// Poll `messages` from `since` until a non-user turn appears or `budget`
/// runs out. Returns every turn seen after the cursor and whether a reply
/// was among them. Shared with the MCP tool.
pub fn wait_for_reply(
    c: &Client,
    id: &str,
    since: Option<&str>,
    limit: Option<u32>,
    budget: Duration,
) -> Result<(Value, bool), ApiError> {
    let started = Instant::now();
    let mut cursor: Option<String> = since.map(str::to_string);
    let mut seen: Vec<Value> = Vec::new();
    loop {
        let page = c.messages(id, cursor.as_deref(), limit)?;
        let replied = client::has_reply(&page);
        if let Some(rows) = page.as_array() {
            seen.extend(rows.iter().cloned());
        }
        if let Some(next) = client::latest_cursor(&page) {
            cursor = Some(next);
        }
        if replied {
            return Ok((Value::Array(seen), true));
        }
        if started.elapsed() >= budget {
            return Ok((Value::Array(seen), false));
        }
        let remaining = budget.saturating_sub(started.elapsed());
        thread::sleep(WAIT_POLL.min(remaining));
    }
}
