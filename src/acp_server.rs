//! ACP (Agent Client Protocol) server — Aura as the agent.
//!
//! Any ACP-speaking editor (Zed, Kiro, Superset's IDE panel) can spawn
//! `aura acp-serve` as a subprocess and invoke Aura's semantic layer
//! through the standard ACP prompt interface. Three verbs are exposed:
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
//!
//! Stdio is the only transport, on purpose. ACP is a subprocess protocol —
//! the client spawns the agent and owns its pipes — so there is no client
//! that would go looking for an agent on a socket. [`AcpSession::handle`]
//! is nonetheless kept free of I/O: [`AcpServer::serve`] only reads lines
//! and writes frames, so what the agent actually *answers* is a pure
//! function of the request, and can be tested without a subprocess.

use serde_json::{json, Value};
use std::io::{self, BufRead, Write};

/// Everything one request produces: the `session/update` notifications to
/// stream first, then the response — `None` for a notification, which by
/// JSON-RPC rule is never answered.
pub struct Reply {
    pub updates: Vec<Value>,
    pub response: Option<Value>,
}

impl Reply {
    fn silent() -> Self {
        Self { updates: Vec::new(), response: None }
    }

    fn answer(response: Value) -> Self {
        Self { updates: Vec::new(), response: Some(response) }
    }
}

/// One ACP conversation. The session id handed out by `session/new` is the
/// whole of it — every verb is answered from the repository on disk, not
/// from anything the client said earlier, so there is no history to keep.
#[derive(Default)]
pub struct AcpSession {
    id: Option<String>,
}

impl AcpSession {
    /// Answer one JSON-RPC request. No I/O: the caller writes whatever
    /// comes back.
    pub fn handle(&mut self, req: &Value) -> Reply {
        let method = req.get("method").and_then(Value::as_str).unwrap_or("");
        let Some(id) = req.get("id").cloned() else {
            // A notification. The only one ACP defines for us is
            // `session/cancel`, and there is nothing for it to interrupt:
            // a verb runs to completion inside this call, so by the time
            // the cancel is read the turn it named is already over.
            return Reply::silent();
        };

        match method {
            "initialize" => Reply::answer(json!({
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
            })),

            "session/new" => {
                let sid = format!("aura-acp-{}", uuid::Uuid::new_v4());
                self.id = Some(sid.clone());
                Reply::answer(json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": { "sessionId": sid }
                }))
            }

            "session/prompt" => {
                // The prompt names its own session. Prefer it over the one
                // we minted: a client driving two sessions down one pipe
                // would otherwise see both streams tagged with whichever
                // it opened last.
                let sid = req
                    .get("params")
                    .and_then(|p| p.get("sessionId"))
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .or_else(|| self.id.clone())
                    .unwrap_or_default();

                let updates = answer_prompt(&sid, &extract_prompt_text(req));
                Reply {
                    updates,
                    response: Some(json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "result": { "stopReason": "end_turn" }
                    })),
                }
            }

            "session/cancel" => Reply::answer(json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": null
            })),

            _ => Reply::answer(json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": {
                    "code": -32601,
                    "message": format!("method not supported: {}", method)
                }
            })),
        }
    }
}

pub struct AcpServer;

impl AcpServer {
    /// Read requests off stdin, write frames to stdout. Transport only —
    /// the answers come from [`AcpSession::handle`].
    pub fn serve() {
        let stdin = io::stdin();
        let mut stdout = io::stdout();
        let mut session = AcpSession::default();

        for line in stdin.lock().lines() {
            let Ok(line) = line else { break };
            if line.trim().is_empty() {
                continue;
            }
            let Ok(req) = serde_json::from_str::<Value>(&line) else {
                continue;
            };

            let reply = session.handle(&req);
            // Updates first: a client that reads the response as the end
            // of the turn must already have every chunk of it.
            for frame in &reply.updates {
                write_frame(&mut stdout, frame);
            }
            if let Some(response) = &reply.response {
                write_frame(&mut stdout, response);
            }
        }
    }
}

/// Parse `prompt_text` for a verb (`prove`, `review`, `impacts`), dispatch
/// to the corresponding Aura tool, and return its output as one or more
/// `session/update` notification frames.
fn answer_prompt(session_id: &str, prompt_text: &str) -> Vec<Value> {
    let (verb, rest) = split_verb(prompt_text.trim());

    let result = match verb.as_str() {
        "prove" => {
            if rest.is_empty() {
                error_chunk("prove requires a goal — e.g. `prove User can log in`")
            } else {
                crate::mcp::McpServer::tool_prove(json!({ "goal": rest }))
            }
        }
        "review" => {
            let base = if rest.is_empty() { "main" } else { rest.as_str() };
            crate::mcp::McpServer::tool_pr_review(json!({ "base": base }))
        }
        "impacts" => crate::mcp::McpServer::tool_live_impacts(json!({})),
        "help" | "" => help_chunk(),
        _ => error_chunk(&format!(
            "unknown command `{}`. Supported: prove, review, impacts, help",
            verb
        )),
    };

    // MCP tool results ({content:[{type:text,text:...}]}) become one
    // agent_message_chunk each.
    result
        .get("content")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.get("text").and_then(Value::as_str))
                .map(|text| chunk_frame(session_id, text))
                .collect()
        })
        .unwrap_or_default()
}

fn extract_prompt_text(req: &Value) -> String {
    // ACP session/prompt.params.prompt is an array of ContentBlocks;
    // we collect every `{type:"text", text:"..."}` entry.
    req.get("params")
        .and_then(|p| p.get("prompt"))
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|item| {
                    if item.get("type").and_then(Value::as_str) == Some("text") {
                        item.get("text").and_then(Value::as_str).map(str::to_owned)
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

fn chunk_frame(session_id: &str, text: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "method": "session/update",
        "params": {
            "sessionId": session_id,
            "update": {
                "sessionUpdate": "agent_message_chunk",
                "content": {"type": "text", "text": text}
            }
        }
    })
}

fn write_frame(stdout: &mut io::Stdout, frame: &Value) {
    if let Ok(s) = serde_json::to_string(frame) {
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

#[cfg(test)]
mod tests {
    use super::*;

    /// The text of every chunk a reply streamed, joined — what the editor
    /// would render.
    fn streamed(reply: &Reply) -> String {
        reply
            .updates
            .iter()
            .filter_map(|f| f.pointer("/params/update/content/text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn session_of(frame: &Value) -> &str {
        frame.pointer("/params/sessionId").and_then(Value::as_str).unwrap_or("")
    }

    fn prompt(sid: Option<&str>, text: &str) -> Value {
        let mut params = json!({ "prompt": [{ "type": "text", "text": text }] });
        if let Some(sid) = sid {
            params["sessionId"] = json!(sid);
        }
        json!({ "jsonrpc": "2.0", "id": 9, "method": "session/prompt", "params": params })
    }

    #[test]
    fn initialize_advertises_a_text_prompt_agent() {
        let mut s = AcpSession::default();
        let reply = s.handle(&json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize" }));
        let r = reply.response.expect("initialize is a request, not a notification");
        assert_eq!(r.pointer("/result/protocolVersion"), Some(&json!(1)));
        assert_eq!(
            r.pointer("/result/agentCapabilities/promptCapabilities/text"),
            Some(&json!(true))
        );
        assert_eq!(r.pointer("/result/agentInfo/name"), Some(&json!("aura-semantic-agent")));
    }

    #[test]
    fn a_prompt_without_a_session_id_is_tagged_with_the_one_we_minted() {
        let mut s = AcpSession::default();
        let new = s.handle(&json!({ "jsonrpc": "2.0", "id": 1, "method": "session/new" }));
        let sid = new
            .response
            .as_ref()
            .and_then(|r| r.pointer("/result/sessionId"))
            .and_then(Value::as_str)
            .expect("session/new mints an id")
            .to_string();
        assert!(sid.starts_with("aura-acp-"));

        let reply = s.handle(&prompt(None, "help"));
        assert!(!reply.updates.is_empty(), "help says something");
        for frame in &reply.updates {
            assert_eq!(session_of(frame), sid);
        }
    }

    #[test]
    fn a_prompt_that_names_its_session_is_answered_on_that_session() {
        // A client driving two sessions down one pipe must not see both
        // streams tagged with whichever it opened last.
        let mut s = AcpSession::default();
        s.handle(&json!({ "jsonrpc": "2.0", "id": 1, "method": "session/new" }));

        let reply = s.handle(&prompt(Some("someone-elses-session"), "help"));
        assert!(!reply.updates.is_empty());
        for frame in &reply.updates {
            assert_eq!(session_of(frame), "someone-elses-session");
        }
    }

    #[test]
    fn help_names_every_verb_the_router_accepts() {
        let mut s = AcpSession::default();
        let text = streamed(&s.handle(&prompt(None, "help")));
        for verb in ["prove", "review", "impacts"] {
            assert!(text.contains(verb), "help omits `{verb}`: {text}");
        }
    }

    #[test]
    fn an_empty_prompt_is_answered_with_help_rather_than_silence() {
        let mut s = AcpSession::default();
        let reply = s.handle(&prompt(None, "   "));
        assert!(streamed(&reply).contains("Supported verbs"));
        assert_eq!(
            reply.response.and_then(|r| r.pointer("/result/stopReason").cloned()),
            Some(json!("end_turn"))
        );
    }

    #[test]
    fn an_unknown_verb_ends_the_turn_saying_what_is_supported() {
        // Not a JSON-RPC error: the request was well-formed, the *prompt*
        // was not, so it is answered in the transcript like any other turn.
        let mut s = AcpSession::default();
        let reply = s.handle(&prompt(None, "deploy to prod"));
        let text = streamed(&reply);
        assert!(text.contains("unknown command `deploy`"), "{text}");
        assert!(text.contains("prove, review, impacts, help"), "{text}");
        let r = reply.response.expect("a prompt is always answered");
        assert!(r.get("error").is_none(), "an unusable prompt is not a protocol error");
        assert_eq!(r.pointer("/result/stopReason"), Some(&json!("end_turn")));
    }

    #[test]
    fn prove_without_a_goal_asks_for_one_instead_of_proving_nothing() {
        let mut s = AcpSession::default();
        let text = streamed(&s.handle(&prompt(None, "prove")));
        assert!(text.contains("prove requires a goal"), "{text}");
    }

    #[test]
    fn a_verb_is_matched_case_insensitively_and_keeps_its_argument() {
        assert_eq!(
            split_verb("PROVE User can log in"),
            ("prove".to_string(), "User can log in".to_string())
        );
        assert_eq!(split_verb("review  feat/x  "), ("review".to_string(), "feat/x".to_string()));
        assert_eq!(split_verb(""), (String::new(), String::new()));
    }

    #[test]
    fn only_text_blocks_are_read_out_of_a_prompt() {
        let req = json!({
            "params": { "prompt": [
                { "type": "image", "data": "…" },
                { "type": "text", "text": "prove" },
                { "type": "text", "text": "User can log in" },
            ]}
        });
        assert_eq!(extract_prompt_text(&req), "prove\nUser can log in");
    }

    #[test]
    fn an_unsupported_method_is_a_protocol_error() {
        let mut s = AcpSession::default();
        let reply = s.handle(&json!({ "jsonrpc": "2.0", "id": 4, "method": "session/load" }));
        let r = reply.response.expect("a request is always answered");
        assert_eq!(r.pointer("/error/code"), Some(&json!(-32601)));
    }

    #[test]
    fn a_notification_is_never_answered() {
        // JSON-RPC forbids replying to a request with no id — a client
        // that got one would pair it with the wrong outstanding call.
        let mut s = AcpSession::default();
        let reply = s.handle(&json!({ "jsonrpc": "2.0", "method": "session/cancel" }));
        assert!(reply.response.is_none());
        assert!(reply.updates.is_empty());
    }
}
