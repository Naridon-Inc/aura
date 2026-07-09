use serde_json::{json, Value};
use tracing::{info, error};
use tokio::sync::mpsc;
use aura_daemon_client::protocol::EventBody;
use crate::state::ServerState;

pub struct DaemonAcpServer;

impl DaemonAcpServer {
    /// Handle an incoming ACP prompt via daemon RPC and return an async stream of events
    pub fn handle_prompt(
        state: &ServerState,
        session_id: &str,
        payload: &str,
    ) -> Result<Vec<EventBody>, String> {
        let req: Value = serde_json::from_str(payload).map_err(|e| e.to_string())?;
        
        let method = req.get("method").and_then(|m| m.as_str()).unwrap_or("");
        let id = req.get("id").cloned();

        if id.is_none() {
            return Ok(vec![]);
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
                        "name": "aura-daemon-acp",
                        "version": "1.0.0"
                    }
                }
            }),

            "session/new" => {
                let sid = format!("aura-acp-{}", uuid::Uuid::new_v4());
                json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": { "sessionId": sid }
                })
            }

            "session/prompt" => {
                // Return an end_turn for now; chunks can be sent via events
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
            Ok(vec![EventBody::AcpMessage { payload: s }])
        } else {
            Ok(vec![])
        }
    }
}
