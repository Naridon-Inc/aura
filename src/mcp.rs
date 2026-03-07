use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{self, BufRead, Write};
use crate::checkpoint::{CheckpointStore, SnapshotStore};
use crate::session::SessionManager;
use git2::Repository;

/// Basic JSON-RPC 2.0 structures for the Model Context Protocol (MCP)
#[derive(Deserialize, Debug)]
#[allow(dead_code)]
struct RpcRequest {
    jsonrpc: String,
    id: Value,
    method: String,
    params: Option<Value>,
}

#[derive(Serialize)]
#[allow(dead_code)]
struct RpcResponse {
    jsonrpc: String,
    id: Value,
    result: Value,
}

#[derive(Serialize)]
#[allow(dead_code)]
struct RpcErrorResponse {
    jsonrpc: String,
    id: Value,
    error: Value,
}

pub struct McpServer;

impl McpServer {
    /// Starts the stdio-based MCP Server loop
    pub fn serve() {
        let stdin = io::stdin();
        let mut stdout = io::stdout();

        for line in stdin.lock().lines() {
            let line = match line {
                Ok(l) => l,
                Err(_) => break,
            };

            if line.trim().is_empty() {
                continue;
            }

            if let Ok(req) = serde_json::from_str::<RpcRequest>(&line) {
                let response = Self::handle_request(req);
                let res_json = serde_json::to_string(&response).unwrap();
                writeln!(stdout, "{}", res_json).unwrap();
                stdout.flush().unwrap();
            } else {
                let err_res = json!({
                    "jsonrpc": "2.0",
                    "id": null,
                    "error": { "code": -32700, "message": "Parse error" }
                });
                writeln!(stdout, "{}", err_res).unwrap();
                stdout.flush().unwrap();
            }
        }
    }

    fn handle_request(req: RpcRequest) -> Value {
        match req.method.as_str() {
            // MCP Initialization Handshake
            "initialize" => {
                json!({
                    "jsonrpc": "2.0",
                    "id": req.id,
                    "result": {
                        "protocolVersion": "2024-11-05",
                        "serverInfo": {
                            "name": "aura-semantic-vcs",
                            "version": "1.0.0"
                        },
                        "capabilities": {
                            "tools": {}
                        }
                    }
                })
            }
            // List available tools to the Agent
            "tools/list" => {
                json!({
                    "jsonrpc": "2.0",
                    "id": req.id,
                    "result": {
                        "tools": [
                            {
                                "name": "aura_read_history",
                                "description": "Reads the semantic logic history of the codebase to understand why architectural decisions were made.",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {
                                        "query": { "type": "string", "description": "What to search for (e.g., 'race conditions')" }
                                    },
                                    "required": ["query"]
                                }
                            },
                            {
                                "name": "aura_log_intent",
                                "description": "MANDATORY: You MUST call this tool after making code changes and BEFORE committing. Logs your architectural intent so Aura can link your reasoning to the AST changes. If you skip this, the pre-commit hook will detect 'Intent Poisoning' and may block the commit. Call this every time you finish a set of edits.",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {
                                        "intent": { "type": "string", "description": "1-2 sentence explanation of WHY you made these changes. Must reference the functions/classes you modified." }
                                    },
                                    "required": ["intent"]
                                }
                            },
                            {
                                "name": "aura_pr_review",
                                "description": "Perform a high-fidelity semantic review of code changes against a base branch. Detects logical renames, layer violations, and cross-branch conflicts.",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {
                                        "base": { "type": "string", "description": "The base branch to compare against (default: master)." }
                                    }
                                }
                            },
                            {
                                "name": "aura_status",
                                "description": "Check the current semantic status of the repository, including active checkpoints and logic nodes tracked.",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {}
                                }
                            },
                            {
                                "name": "aura_snapshot",
                                "description": "IMPORTANT: Call this BEFORE modifying any file. Takes a durable snapshot of a file so it can be recovered with `aura rewind` even without a git commit. This is your safety net against AI hallucinations destroying work.",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {
                                        "file_path": { "type": "string", "description": "Path to the file to snapshot before editing." }
                                    },
                                    "required": ["file_path"]
                                }
                            },
                            {
                                "name": "aura_snapshot_list",
                                "description": "List all durable file snapshots. Shows files that have been snapshotted and can be recovered with `aura rewind`.",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {
                                        "file_path": { "type": "string", "description": "Optional: filter snapshots for a specific file." }
                                    }
                                }
                            }
                        ]
                    }
                })
            }
            // Execute a specific tool
            "tools/call" => {
                let params = req.params.unwrap_or_default();
                let name = params["name"].as_str().unwrap_or("");
                let args = params["arguments"].clone();

                let mut result = match name {
                    "aura_read_history" => Self::tool_read_history(args),
                    "aura_log_intent" => Self::tool_log_intent(args),
                    "aura_pr_review" => Self::tool_pr_review(args),
                    "aura_status" => Self::tool_status(args),
                    "aura_snapshot" => Self::tool_snapshot(args),
                    "aura_snapshot_list" => Self::tool_snapshot_list(args),
                    _ => json!({ "isError": true, "content": [{ "type": "text", "text": "Unknown tool" }] })
                };

                // Append intent reminder to non-intent tool responses if intent hasn't been logged
                if name != "aura_log_intent" && name != "aura_read_history" {
                    let intent_logged = std::path::Path::new(".aura/.intent_logged").exists();
                    if !intent_logged {
                        if let Some(content) = result.get_mut("content").and_then(|c| c.as_array_mut()) {
                            content.push(json!({
                                "type": "text",
                                "text": "\n⚠️ REMINDER: You have not logged your intent yet. Call `aura_log_intent` with a description of your changes BEFORE committing. Without intent, the pre-commit hook will flag Intent Poisoning."
                            }));
                        }
                    }
                }

                json!({
                    "jsonrpc": "2.0",
                    "id": req.id,
                    "result": result
                })
            }
            // Catch-all for unsupported methods (like ping)
            _ => {
                json!({
                    "jsonrpc": "2.0",
                    "id": req.id,
                    "error": { "code": -32601, "message": "Method not found" }
                })
            }
        }
    }

    fn tool_read_history(_args: Value) -> Value {
        let repo = match Repository::open(".") {
            Ok(r) => r,
            Err(_) => return json!({ "content": [{ "type": "text", "text": "Not a git repository." }] }),
        };

        if let Ok(checkpoints) = CheckpointStore::get_all_checkpoints(&repo) {
            if !checkpoints.is_empty() {
                // Build structured data, encode as TOON for token efficiency
                let entries: Vec<Value> = checkpoints.iter().take(10).map(|c| {
                    json!({
                        "id": &c.id[..8],
                        "agent": c.agent_id,
                        "intent": c.intent,
                        "nodes": c.ast_nodes.len(),
                        "ts": c.timestamp
                    })
                }).collect();
                let data = json!({ "history": entries });
                let toon_text = crate::toon::encode(&data);
                return json!({ "content": [{ "type": "text", "text": toon_text }] });
            }
        }

        json!({ "content": [{ "type": "text", "text": "No semantic history found." }] })
    }

    fn tool_log_intent(args: Value) -> Value {
        let intent = args["intent"].as_str().unwrap_or("No intent provided.").to_string();

        // Start/resume session and log transcript
        let _sess = SessionManager::start_session("MCP Agent");
        SessionManager::append_transcript("assistant", &intent);

        // 1. Write the handshake file for the pre-commit hook
        let _ = std::fs::write(".gemini.intent", &intent);

        // 2. Also append to the durable intent log (JSONL) so the watcher daemon
        //    can link file snapshots to this intent context
        let _ = std::fs::create_dir_all(".aura");
        let log_entry = json!({
            "agent_id": "MCP Agent",
            "intent": intent,
            "timestamp": std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs()
        });
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true).append(true).open(".aura/intent_log.jsonl")
        {
            use std::io::Write;
            let _ = writeln!(file, "{}", log_entry.to_string());
        }

        // Mark that intent has been logged for this session
        let _ = std::fs::write(".aura/.intent_logged", "1");

        json!({ "content": [{ "type": "text", "text": "Intent logged. Aura will bind this reasoning to your AST changes on the next commit." }] })
    }

    fn tool_pr_review(args: Value) -> Value {
        let base = args["base"].as_str().unwrap_or("master");
        match crate::pr::PrReviewEngine::run_review(base, true, false) {
            Ok(Some(report_json)) => {
                // Try to parse the JSON report and re-encode as TOON for token savings
                if let Ok(parsed) = serde_json::from_str::<Value>(&report_json) {
                    let toon_text = crate::toon::encode(&parsed);
                    json!({ "content": [{ "type": "text", "text": toon_text }] })
                } else {
                    json!({ "content": [{ "type": "text", "text": report_json }] })
                }
            }
            Ok(None) => {
                json!({ "content": [{ "type": "text", "text": "No changes detected." }] })
            }
            Err(e) => {
                json!({ "isError": true, "content": [{ "type": "text", "text": format!("PR Review failed: {}", e) }] })
            }
        }
    }

    fn tool_status(_args: Value) -> Value {
        let repo = match Repository::open(".") {
            Ok(r) => r,
            Err(_) => return json!({ "isError": true, "content": [{ "type": "text", "text": "Not a git repository." }] }),
        };

        let config = crate::config::ConfigManager::load();
        let checkpoints = CheckpointStore::get_all_checkpoints(&repo).unwrap_or_default();
        
        let mut tracked_count = 0;
        if let Some(latest) = checkpoints.first() {
            tracked_count = latest.ast_nodes.len();
        }

        let status_data = json!({
            "strict_mode": config.strict_gatekeeper_mode,
            "dev_mode": config.dev_mode,
            "latest_checkpoint_id": checkpoints.first().map(|c| c.id.clone()),
            "logic_nodes_tracked": tracked_count,
            "total_checkpoints": checkpoints.len()
        });

        let toon_text = crate::toon::encode(&status_data);
        json!({ "content": [{ "type": "text", "text": toon_text }] })
    }

    fn tool_snapshot(args: Value) -> Value {
        let file_path = match args["file_path"].as_str() {
            Some(p) => p,
            None => return json!({ "isError": true, "content": [{ "type": "text", "text": "file_path is required." }] }),
        };

        // Track this file in the active session
        SessionManager::touch_file(file_path);

        match SnapshotStore::snapshot_file(file_path, "mcp_pre_edit", "MCP Agent") {
            Ok(snap_id) => {
                json!({ "content": [{ "type": "text", "text": format!("Snapshot saved: {}. File '{}' can now be recovered with `aura rewind`.", snap_id, file_path) }] })
            }
            Err(e) => {
                json!({ "isError": true, "content": [{ "type": "text", "text": format!("Snapshot failed: {}", e) }] })
            }
        }
    }

    fn tool_snapshot_list(args: Value) -> Value {
        let snapshots = if let Some(file_path) = args["file_path"].as_str() {
            SnapshotStore::get_snapshots_for_file(file_path)
        } else {
            SnapshotStore::get_all_snapshots()
        };

        if snapshots.is_empty() {
            return json!({ "content": [{ "type": "text", "text": "No snapshots found. Use aura_snapshot before editing files." }] });
        }

        // TOON tabular format — massively fewer tokens than JSON for uniform arrays
        let entries: Vec<Value> = snapshots.iter().take(20).map(|s| {
            json!({
                "file": s.file_path,
                "trigger": s.trigger,
                "agent": s.agent_id,
                "ts": s.timestamp
            })
        }).collect();
        let data = json!({ "count": snapshots.len(), "snapshots": entries });
        let toon_text = crate::toon::encode(&data);

        json!({ "content": [{ "type": "text", "text": toon_text }] })
    }
}

