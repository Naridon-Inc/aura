//! ACP (Agent Client Protocol) server — S1-P sub-task 5.
//!
//! Aura-as-agent: any ACP-speaking editor (Zed, Kiro, Superset's IDE
//! panel) can spawn `aura acp-serve` as a subprocess and invoke Aura's
//! semantic layer through the standard ACP prompt interface. The three
//! tools exposed match the plan doc's milestone:
//!
//!   - `prove <goal>`    → runs `crate::gsd::GsdEngine::prove_goal`
//!   - `review [base]`   → runs `crate::pr::PrReviewEngine::run_review`
//!   - `impacts`         → runs `crate::live_sync::fetch_impacts_json`
//!
//! The prompt router is deliberately simple: we match the user's prompt
//! against a small set of verbs. This is not a free-form LLM router —
//! Aura's ACP surface is a *tool provider*, not a conversational agent.
//! That keeps the server deterministic (useful for editor integration
//! tests) and guarantees the editor gets structured output.
//!
//! Wire format: newline-delimited JSON-RPC 2.0 over stdin/stdout. The
//! client sends `initialize` → `session/new` → `session/prompt`; we stream
//! text chunks back as `session/update` notifications and close with a
//! `session/prompt` response carrying `stopReason: "end_turn"`.

use serde_json::{json, Value};
use std::io::{self, BufRead, Write};

pub struct AcpServer;

impl AcpServer {
    pub fn serve() {
        let stdin = io::stdin();
        let mut stdout = io::stdout();
        let mut session_id: Option<String> = None;

        for line in stdin.lock().lines() {
            let line = match line {
                Ok(l) => l,
                Err(_) => break,
            };
            if line.trim().is_empty() {
                continue;
            }

            let req: Value = match serde_json::from_str(&line) {
                Ok(v) => v,
                Err(_) => continue,
            };

            let method = req.get("method").and_then(|m| m.as_str()).unwrap_or("");
            let id = req.get("id").cloned();

            // ACP notifications (no id) aren't expected for the small
            // surface we implement; ignore them cleanly.
            if id.is_none() {
                continue;
            }
            let id = id.unwrap();

            let response = match method {
                "initialize" => json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": {
                        "protocolVersion": 1,
                        "agentCapabilities": {
                            "promptCapabilities": { "text": true }
                        },
                        "agentInfo": {
                            "name": "aura-semantic-agent",
                            "version": "1.0.0"
                        }
                    }
                }),

                "session/new" => {
                    let sid = format!("aura-acp-{}", uuid::Uuid::new_v4());
                    session_id = Some(sid.clone());
                    json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "result": { "sessionId": sid }
                    })
                }

                "session/prompt" => {
                    let sid = session_id.clone().unwrap_or_default();
                    let prompt_text = extract_prompt_text(&req);
                    Self::handle_prompt(&mut stdout, &sid, &prompt_text);
                    json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "result": { "stopReason": "end_turn" }
                    })
                }

                "session/cancel" => json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": null
                }),

                _ => json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "error": {
                        "code": -32601,
                        "message": format!("method not supported: {}", method)
                    }
                }),
            };

            if let Ok(s) = serde_json::to_string(&response) {
                let _ = writeln!(stdout, "{}", s);
                let _ = stdout.flush();
            }
        }
    }

    /// Parse `prompt_text` for a verb (`prove`, `review`, `impacts`),
    /// dispatch to the corresponding Aura tool, and stream its output
    /// back to the client as one or more `session/update` notifications.
    fn handle_prompt(stdout: &mut io::Stdout, session_id: &str, prompt_text: &str) {
        let trimmed = prompt_text.trim();
        let (verb, rest) = split_verb(trimmed);

        let result = match verb.as_str() {
            "prove" => {
                if rest.is_empty() {
                    error_chunk("prove requires a goal — e.g. `prove User can log in`")
                } else {
                    let args = json!({ "goal": rest });
                    crate::mcp::McpServer::tool_prove(args)
                }
            }
            "review" => {
                let base = if rest.is_empty() { "main" } else { rest.as_str() };
                let args = json!({ "base": base });
                crate::mcp::McpServer::tool_pr_review(args)
            }
            "impacts" => {
                crate::mcp::McpServer::tool_live_impacts(json!({}))
            }
            "help" | "" => help_chunk(),
            _ => error_chunk(&format!(
                "unknown command `{}`. Supported: prove, review, impacts, help",
                verb
            )),
        };

        // Convert MCP tool result ({content:[{type:text,text:...}]}) into
        // one or more ACP agent_message_chunk updates.
        if let Some(items) = result.get("content").and_then(|c| c.as_array()) {
            for item in items {
                if let Some(text) = item.get("text").and_then(|t| t.as_str()) {
                    emit_chunk(stdout, session_id, text);
                }
            }
        }
    }
}

fn extract_prompt_text(req: &Value) -> String {
    // ACP session/prompt.params.prompt is an array of ContentBlocks;
    // we collect every `{type:"text", text:"..."}` entry.
    req.get("params")
        .and_then(|p| p.get("prompt"))
        .and_then(|p| p.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|item| {
                    if item.get("type").and_then(|t| t.as_str()) == Some("text") {
                        item.get("text").and_then(|t| t.as_str()).map(str::to_owned)
                    } else {
                        None
                    }
                })
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

fn split_verb(text: &str) -> (String, String) {
    let mut parts = text.splitn(2, char::is_whitespace);
    let verb = parts.next().unwrap_or("").to_ascii_lowercase();
    let rest = parts.next().unwrap_or("").trim().to_string();
    (verb, rest)
}

fn emit_chunk(stdout: &mut io::Stdout, session_id: &str, text: &str) {
    let frame = json!({
        "jsonrpc": "2.0",
        "method": "session/update",
        "params": {
            "sessionId": session_id,
            "update": {
                "sessionUpdate": "agent_message_chunk",
                "content": {"type": "text", "text": text}
            }
        }
    });
    if let Ok(s) = serde_json::to_string(&frame) {
        let _ = writeln!(stdout, "{}", s);
        let _ = stdout.flush();
    }
}

fn error_chunk(msg: &str) -> Value {
    json!({
        "isError": true,
        "content": [{"type": "text", "text": msg}]
    })
}

fn help_chunk() -> Value {
    let text = "Aura ACP agent. Supported verbs:\n\
                • prove <goal>           — semantic verification of a user-facing behavior\n\
                • review [base_branch]   — AST-level PR review vs base (default: main)\n\
                • impacts                — unresolved cross-branch impact alerts\n\
                • help                   — this message";
    json!({ "content": [{"type": "text", "text": text}] })
}
