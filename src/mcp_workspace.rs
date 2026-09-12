//! MCP tools for cloud workspaces — `aura_workspace_*` (AURA-1295).
//!
//! The same nine verbs as `aura workspace …`, over the same
//! [`crate::workspace_api::client`], so an agent inside Claude Code / Codex /
//! Gemini can spin up a second workspace for a sub-task, prompt it, and read
//! its replies without shelling out. `mcp.rs` lists [`tool_definitions`] in
//! `tools/list` and routes every `aura_workspace_*` call to [`call`].
//!
//! Every tool returns the raw API JSON as its text content, or `isError` with
//! the one-line reason the CLI would print.

use std::time::Duration;

use serde_json::{json, Value};

use crate::workspace_api::client::{ApiError, Client, CreateRequest};
use crate::workspace_api::cmd::wait_for_reply;

/// Longest a single `aura_workspace_messages` call may block. An MCP client
/// times out a tool call eventually; this keeps us inside that.
const MAX_WAIT_SECS: u64 = 300;

/// The tool-list entries, in the shape `tools/list` returns.
pub fn tool_definitions() -> Vec<Value> {
    let id = |what: &str| json!({ "type": "string", "description": what });
    vec![
        json!({
            "name": "aura_workspace_create",
            "description": "Start a second Aura cloud workspace to work on a sub-task in parallel (e.g. hand the mobile half of a feature to another agent while you keep the server half). Returns its `id`; use it with aura_workspace_prompt / aura_workspace_messages. ALWAYS pass `intent` — the board records why this workspace exists and who asked, which is how a reviewer later tells a deliberate fan-out from a stray one. Pass `prompt` to enqueue the first message in the same call. Needs AURA_API_KEY or a signed-in `aura connect` token.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "repo": id("`owner/name` or the repo id the workspace attaches to."),
                    "intent": id("WHY this workspace exists, one sentence. Recorded on the workspace and as its first board note."),
                    "intent_type": id("One of FeatureAdd, BugFix, Refactor, Revert, Performance, Docs, Deps."),
                    "title": id("Short title (the workspace's objective)."),
                    "branch": id("Base branch to start from."),
                    "prompt": id("First message to send right away."),
                    "model": id("Model id the runner should use — see aura_workspace_models."),
                    "agent": id("Your agent label (e.g. 'claude@cursor') so the intent is attributed to you.")
                },
                "required": ["repo", "intent"]
            },
            "annotations": {
                "title": "Create Cloud Workspace",
                "readOnlyHint": false, "destructiveHint": false, "idempotentHint": false, "openWorldHint": true,
                "auraCapability": "auto"
            }
        }),
        json!({
            "name": "aura_workspace_prompt",
            "description": "Send a message to a cloud workspace you created (or one a teammate shared). Use it to hand a sub-task its instructions, answer a question the other agent asked, or steer it. A sleeping workspace wakes; an archived one refuses. Follow with aura_workspace_messages (pass `wait`) to read the reply.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": id("Workspace id from aura_workspace_create / aura_workspace_list."),
                    "message": id("What to send."),
                    "model": id("Model override for this one turn.")
                },
                "required": ["id", "message"]
            },
            "annotations": {
                "title": "Prompt Cloud Workspace",
                "readOnlyHint": false, "destructiveHint": false, "idempotentHint": false, "openWorldHint": true,
                "auraCapability": "auto"
            }
        }),
        json!({
            "name": "aura_workspace_messages",
            "description": "Read a cloud workspace's message log (prompts and the other agent's replies), oldest first. Pass `since` (the `created_at` of the last turn you saw) to read only what is new, and `wait` (seconds, max 300) to block until a reply lands — that is how you monitor a workspace you delegated to without polling in a loop yourself.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": id("Workspace id."),
                    "since": id("RFC3339 cursor: only turns newer than this."),
                    "wait": { "type": "integer", "description": "Seconds to wait for a non-user reply before returning what arrived (0 = return immediately)." },
                    "limit": { "type": "integer", "description": "Page size (default 200, max 500)." }
                },
                "required": ["id"]
            },
            "annotations": {
                "title": "Read Cloud Workspace Messages",
                "readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": true,
                "auraCapability": "auto"
            }
        }),
        json!({
            "name": "aura_workspace_list",
            "description": "List the cloud workspaces this key can see, newest activity first, each with its status and the intent it was created with. Call it to find a workspace another agent started for you, or to check what is still running before you create another one.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "status": id("Keep only this status: running, sleeping, archived, ended.")
                }
            },
            "annotations": {
                "title": "List Cloud Workspaces",
                "readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": true,
                "auraCapability": "auto"
            }
        }),
        json!({
            "name": "aura_workspace_get",
            "description": "One cloud workspace: status, title, branch, model, and the intent + agent that created it. Use it to check whether a delegated workspace is still running or has been slept/archived.",
            "inputSchema": {
                "type": "object",
                "properties": { "id": id("Workspace id.") },
                "required": ["id"]
            },
            "annotations": {
                "title": "Get Cloud Workspace",
                "readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": true,
                "auraCapability": "auto"
            }
        }),
        json!({
            "name": "aura_workspace_sleep",
            "description": "Park a cloud workspace you are done with for now — it stops counting as live work on the board and is never auto-ended, and the next aura_workspace_prompt wakes it. Use it instead of archive when you expect to come back.",
            "inputSchema": {
                "type": "object",
                "properties": { "id": id("Workspace id.") },
                "required": ["id"]
            },
            "annotations": {
                "title": "Sleep Cloud Workspace",
                "readOnlyHint": false, "destructiveHint": false, "idempotentHint": true, "openWorldHint": true,
                "auraCapability": "auto"
            }
        }),
        json!({
            "name": "aura_workspace_archive",
            "description": "Close a cloud workspace for good once its sub-task is merged or abandoned. The log stays readable; prompts are refused from then on. Not reversible — sleep it if in doubt.",
            "inputSchema": {
                "type": "object",
                "properties": { "id": id("Workspace id.") },
                "required": ["id"]
            },
            "annotations": {
                "title": "Archive Cloud Workspace",
                "readOnlyHint": false, "destructiveHint": true, "idempotentHint": true, "openWorldHint": true,
                "auraCapability": "auto"
            }
        }),
        json!({
            "name": "aura_workspace_models",
            "description": "The model ids the Aura cloud can route a workspace to, with whether this org has a key for each provider. Call it before passing `model` to aura_workspace_create so you name one that will actually run.",
            "inputSchema": { "type": "object", "properties": {} },
            "annotations": {
                "title": "List Routable Models",
                "readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": true,
                "auraCapability": "auto"
            }
        }),
        json!({
            "name": "aura_workspace_whoami",
            "description": "Who the current cloud credential is: the user it acts as, the org it is scoped to, and the key's scopes. Call it once at the start of a session that will create workspaces, so a wrong org or a key without `places:run` is a one-line answer rather than a 403 later.",
            "inputSchema": { "type": "object", "properties": {} },
            "annotations": {
                "title": "Cloud Credential Identity",
                "readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": true,
                "auraCapability": "auto"
            }
        }),
    ]
}

/// Every name [`tool_definitions`] declares — `mcp.rs` routes on the prefix,
/// and this keeps the two lists honest with each other in tests.
pub fn tool_names() -> Vec<String> {
    tool_definitions()
        .iter()
        .filter_map(|t| t.get("name").and_then(|n| n.as_str()).map(str::to_string))
        .collect()
}

/// Dispatch one `aura_workspace_*` call.
pub fn call(name: &str, args: Value) -> Value {
    match dispatch(name, &args) {
        Ok(v) => ok(&v),
        Err(e) => err(&e.message()),
    }
}

fn dispatch(name: &str, args: &Value) -> Result<Value, ApiError> {
    match name {
        "aura_workspace_create" => {
            let repo = required(args, "repo")?;
            let intent = required(args, "intent")?;
            let c = Client::from_env()?;
            c.create(&CreateRequest {
                repo: Some(repo),
                intent: Some(intent),
                intent_type: arg_str(args, "intent_type"),
                title: arg_str(args, "title"),
                branch: arg_str(args, "branch"),
                prompt: arg_str(args, "prompt"),
                model: arg_str(args, "model"),
                agent: arg_str(args, "agent"),
            })
        }
        "aura_workspace_prompt" => {
            let id = required(args, "id")?;
            let message = required(args, "message")?;
            let c = Client::from_env()?;
            c.prompt(&id, &message, arg_str(args, "model").as_deref())
        }
        "aura_workspace_messages" => {
            let id = required(args, "id")?;
            let since = arg_str(args, "since");
            let limit = args.get("limit").and_then(|l| l.as_u64()).map(|l| l as u32);
            let wait = args
                .get("wait")
                .and_then(|w| w.as_u64())
                .unwrap_or(0)
                .min(MAX_WAIT_SECS);
            let c = Client::from_env()?;
            if wait == 0 {
                c.messages(&id, since.as_deref(), limit)
            } else {
                let (turns, replied) =
                    wait_for_reply(&c, &id, since.as_deref(), limit, Duration::from_secs(wait))?;
                Ok(json!({ "replied": replied, "messages": turns }))
            }
        }
        "aura_workspace_list" => {
            let c = Client::from_env()?;
            c.list(arg_str(args, "status").as_deref())
        }
        "aura_workspace_get" => {
            let id = required(args, "id")?;
            Client::from_env()?.get(&id)
        }
        "aura_workspace_sleep" => {
            let id = required(args, "id")?;
            Client::from_env()?.sleep(&id)
        }
        "aura_workspace_archive" => {
            let id = required(args, "id")?;
            Client::from_env()?.archive(&id)
        }
        "aura_workspace_models" => Client::from_env()?.models(),
        "aura_workspace_whoami" => {
            let c = Client::from_env()?;
            let mut v = c.whoami()?;
            if let Value::Object(m) = &mut v {
                m.insert("token_source".into(), Value::String(c.auth().source.label().into()));
                m.insert("origin".into(), Value::String(c.auth().origin.clone()));
            }
            Ok(v)
        }
        other => Err(ApiError::Http {
            status: 0,
            body: format!(
                "unknown workspace tool `{other}` — one of: {}",
                tool_names().join(", ")
            ),
        }),
    }
}

fn arg_str(args: &Value, key: &str) -> Option<String> {
    args.get(key)
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn required(args: &Value, key: &str) -> Result<String, ApiError> {
    arg_str(args, key).ok_or_else(|| ApiError::Http {
        status: 0,
        body: format!("`{key}` is required"),
    })
}

fn ok(v: &Value) -> Value {
    let body = serde_json::to_string_pretty(v).unwrap_or_else(|_| "null".into());
    json!({ "content": [{ "type": "text", "text": body }] })
}

fn err(msg: &str) -> Value {
    json!({ "isError": true, "content": [{ "type": "text", "text": msg }] })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_tool_is_namespaced_and_dispatchable() {
        let names = tool_names();
        assert_eq!(names.len(), 9);
        for n in &names {
            assert!(n.starts_with("aura_workspace_"), "{n}");
        }
        for expected in [
            "aura_workspace_create",
            "aura_workspace_prompt",
            "aura_workspace_messages",
            "aura_workspace_list",
            "aura_workspace_get",
            "aura_workspace_sleep",
            "aura_workspace_archive",
            "aura_workspace_models",
            "aura_workspace_whoami",
        ] {
            assert!(names.iter().any(|n| n == expected), "missing {expected}");
        }
    }

    #[test]
    fn every_tool_tells_the_agent_when_to_use_it() {
        for t in tool_definitions() {
            let d = t["description"].as_str().unwrap();
            assert!(d.len() > 80, "{} has a one-liner, not guidance", t["name"]);
            assert!(t["inputSchema"]["type"] == "object");
            assert!(t["annotations"]["title"].is_string());
        }
    }

    #[test]
    fn create_requires_repo_and_intent_before_touching_the_network() {
        let r = call("aura_workspace_create", json!({ "repo": "acme/shop" }));
        assert_eq!(r["isError"], true);
        assert!(r["content"][0]["text"].as_str().unwrap().contains("`intent` is required"));
        let r = call("aura_workspace_create", json!({ "intent": "why" }));
        assert!(r["content"][0]["text"].as_str().unwrap().contains("`repo` is required"));
    }

    #[test]
    fn unknown_tool_is_an_error_not_a_panic() {
        let r = call("aura_workspace_nope", json!({}));
        assert_eq!(r["isError"], true);
    }
}
