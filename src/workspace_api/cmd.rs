//! The `aura workspace` verbs.
//!
//! Each verb resolves credentials, makes one call, renders, and returns an
//! exit code from the shared contract — `0` ok, `1` runtime, `2` usage, `3`
//! auth, `4` server. See [`crate::cloud_contract::ExitCode`], which every
//! `aura` cloud noun exits by so a shell loop can read `$?` the same way after
//! any of them. `main.rs` turns a non-zero code into `process::exit` so the
//! functions here stay testable.

use std::thread;
use std::time::{Duration, Instant};

use clap::Subcommand;
use serde_json::Value;

use super::client::{self, ApiError, Client, CreateRequest};
use super::output;
use super::paging::{check_page, next_cmd};

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
        /// Your own key for this send. Send the same one again and nothing new
        /// is queued — the prompt you already sent is acknowledged instead. Use
        /// it when a timeout leaves you unable to tell whether the send landed.
        #[arg(long = "message-id")]
        message_id: Option<String>,
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
    // `allow_negative_numbers` so `--offset -1` reaches the window check and
    // is answered with what is wrong, instead of clap reading `-1` as a flag
    // it does not have and saying "unexpected argument".
    #[command(allow_negative_numbers = true)]
    List {
        /// Keep only this status: running, sleeping, archived, ended. Applied
        /// by the server before the page is cut, so a filtered page is not a
        /// filtered *page*.
        #[arg(long)]
        status: Option<String>,
        /// Rows per page. Left out, the server answers with its own default
        /// (200), which is also the most it will give.
        #[arg(long)]
        limit: Option<i64>,
        /// Rows to skip. Without it the 201st workspace is unreachable.
        #[arg(long)]
        offset: Option<i64>,
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
    /// File a workspace in one of your sidebar sections, or take it out of
    /// one. See `aura section list` for the ids.
    Move {
        id: String,
        /// The section to file it in — its name or its id, whichever you have.
        #[arg(long, conflicts_with = "no_section")]
        section: Option<String>,
        /// Take it out of whatever section it is in.
        #[arg(long = "no-section", conflicts_with = "section")]
        no_section: bool,
        #[arg(long)]
        json: bool,
    },
    /// Give a workspace a new name. The old one is kept on the transcript, so
    /// a link somebody remembers still reconciles with what the board shows.
    Rename {
        id: String,
        /// The new name.
        #[arg(long)]
        name: String,
        #[arg(long)]
        json: bool,
    },
    /// Whose turn is it — the one question a loop asks. Prints one of
    /// `working`, `waiting`, `quiet`, `sleeping`, `archived`, `ended`.
    ///
    /// `working` means your prompt is the newest thing in the transcript. It
    /// is not a liveness probe: read `active` alongside it to judge whether
    /// something has been working implausibly long.
    Status {
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
            message_id,
            json,
        } => {
            if let Some(k) = message_id {
                if k.trim().is_empty() {
                    eprintln!("  ✗ --message-id was empty — leave it out, or pass a key");
                    return Ok(crate::cloud_contract::ExitCode::Usage.code());
                }
            }
            let c = Client::from_env()?;
            let v = c.prompt(id, message, model.as_deref(), message_id.as_deref())?;
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
        WorkspaceCmd::List {
            status,
            limit,
            offset,
            json,
        } => {
            if let Some(why) = check_page(*limit, *offset) {
                eprintln!("  ✗ {why}");
                return Ok(crate::cloud_contract::ExitCode::Usage.code());
            }
            let c = Client::from_env()?;
            let v = c.list(status.as_deref(), *limit, *offset)?;
            let hint = next_cmd("aura workspace list", status.as_deref(), *limit);
            let page = limit.map(|n| output::AskedPage {
                limit: n,
                offset: offset.unwrap_or(0),
                next_hint: &hint,
            });
            output::emit(*json, &v, |v| output::render_workspace_list(v, page.as_ref()));
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
        WorkspaceCmd::Move {
            id,
            section,
            no_section,
            json,
        } => {
            let c = Client::from_env()?;
            // `--no-section` and `--section <id>` are `conflicts_with` each
            // other, so clap has already refused the pair; what is left is
            // "neither", which can only mean unfile. Naming `no_section` here
            // rather than relying on `section.is_none()` keeps the intent
            // readable: the flag is the one a caller passes on purpose.
            let target = if *no_section { None } else { section.as_deref() };
            // A name is accepted where an id belongs. An agent that just ran
            // `aura section create Reviewing` knows the name it chose and not
            // the uuid the server minted, and making it hold the second to use
            // the first would put a lookup call before every move.
            let resolved = match target {
                Some(t) if !looks_like_section_id(t) => {
                    let sections = c.sections()?;
                    match section_id_for_name(t, &sections) {
                        Some(found) => Some(found),
                        None => {
                            eprintln!("  ✗ {}", no_such_section(t, &sections));
                            return Ok(crate::cloud_contract::ExitCode::Usage.code());
                        }
                    }
                }
                other => other.map(str::to_string),
            };
            let v = c.move_workspace(id, resolved.as_deref())?;
            output::emit(*json, &v, output::render_moved_workspace);
            Ok(0)
        }
        WorkspaceCmd::Rename { id, name, json } => {
            let c = Client::from_env()?;
            // Caught here as well as on the server so a typo costs no round
            // trip and exits 2 like every other usage error, rather than
            // arriving as a 400 and exiting 1.
            if name.trim().is_empty() {
                eprintln!("  ✗ --name needs a name");
                return Ok(crate::cloud_contract::ExitCode::Usage.code());
            }
            let v = c.rename(id, name.trim())?;
            output::emit(*json, &v, output::render_workspace);
            Ok(0)
        }
        WorkspaceCmd::Status { id, json } => {
            let c = Client::from_env()?;
            let v = c.status(id)?;
            output::emit(*json, &v, output::render_workspace_status);
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
            // Where the bearer came from is a client-side fact the server
            // cannot know; `whoami_described` adds it so a wrong key is
            // diagnosable in one call, and so `aura auth status` — which
            // answers the same question under the name an agent reaches for
            // first — reports it identically.
            let v = c.whoami_described()?;
            output::emit(*json, &v, output::render_whoami);
            Ok(0)
        }
    }
}

/// Does this look like the uuid a section is keyed by, rather than its name?
///
/// Shape only — whether the id exists is the server's answer to give. A name
/// that happens to be uuid-shaped is sent as an id and comes back "section not
/// found", which is the same sentence a name nobody has would get.
pub fn looks_like_section_id(v: &str) -> bool {
    let b = v.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => *c == b'-',
            _ => c.is_ascii_hexdigit(),
        })
}

/// The id of the caller's section with this name, matched the way the server
/// matches it — ignoring case, because the unique index behind it does.
pub fn section_id_for_name(name: &str, sections: &Value) -> Option<String> {
    let want = name.trim().to_lowercase();
    sections.as_array()?.iter().find_map(|s| {
        let n = s.get("name").and_then(|n| n.as_str())?;
        if n.trim().to_lowercase() == want {
            s.get("id").and_then(|i| i.as_str()).map(str::to_string)
        } else {
            None
        }
    })
}

/// What to say when no section has that name. Names the ones that do exist,
/// because the next thing the reader needs is the right spelling, and a bare
/// "not found" would send them to a second command to get it.
pub fn no_such_section(name: &str, sections: &Value) -> String {
    let names: Vec<&str> = sections
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|s| s.get("name").and_then(|n| n.as_str()))
                .collect()
        })
        .unwrap_or_default();
    if names.is_empty() {
        return format!(
            "no section is called \"{name}\" — you have none yet; `aura section create {name}` makes it"
        );
    }
    format!("no section is called \"{name}\" — you have: {}", names.join(", "))
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sections() -> Value {
        json!([
            { "id": "964c2946-5b31-426f-8843-af431e08c715", "name": "Reviewing" },
            { "id": "c12b7535-4a50-46f8-a472-d2304a37b32c", "name": "Shipped" }
        ])
    }

    #[test]
    fn an_id_is_recognised_and_a_name_is_not() {
        assert!(looks_like_section_id("964c2946-5b31-426f-8843-af431e08c715"));
        assert!(!looks_like_section_id("Reviewing"));
        // Right length, right hyphens, not hex — still not an id.
        assert!(!looks_like_section_id("zzzzzzzz-5b31-426f-8843-af431e08c715"));
        // Right characters, wrong shape.
        assert!(!looks_like_section_id("964c29465b31426f8843af431e08c715"));
        assert!(!looks_like_section_id(""));
    }

    #[test]
    fn a_name_resolves_the_way_the_servers_index_matches_it() {
        // The unique index is on `lower(name)`, so the client must not be
        // stricter than the thing that decides what collides.
        assert_eq!(
            section_id_for_name("reviewing", &sections()).as_deref(),
            Some("964c2946-5b31-426f-8843-af431e08c715")
        );
        assert_eq!(
            section_id_for_name("  Shipped ", &sections()).as_deref(),
            Some("c12b7535-4a50-46f8-a472-d2304a37b32c")
        );
        assert_eq!(section_id_for_name("Archive", &sections()), None);
    }

    #[test]
    fn an_unknown_name_is_answered_with_the_names_that_exist() {
        let msg = no_such_section("Archive", &sections());
        assert!(msg.contains("Reviewing") && msg.contains("Shipped"), "{msg}");

        // With nothing to list, say so and name the command that fixes it,
        // rather than printing an empty "you have: ".
        let none = no_such_section("Archive", &json!([]));
        assert!(none.contains("none yet"), "{none}");
        assert!(none.contains("aura section create Archive"), "{none}");
        assert!(!none.contains("you have: "), "{none}");
    }
}
