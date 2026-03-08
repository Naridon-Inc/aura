use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{self, BufRead, Write};
use crate::checkpoint::{CheckpointStore, SnapshotStore};
use crate::session::SessionManager;
use git2::Repository;
use std::path::Path;

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
                            },
                            {
                                "name": "aura_handover",
                                "description": "Generate a dense, token-optimized XML context block containing the full semantic state of the codebase. Use this to hand off context to another AI agent (Claude, Gemini, Cursor) without losing architectural understanding. Saves ~90% of tokens vs re-reading files.",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {
                                        "agent": { "type": "string", "description": "Target agent name (e.g., 'claude', 'gemini', 'cursor')." }
                                    },
                                    "required": ["agent"]
                                }
                            },
                            {
                                "name": "aura_prove",
                                "description": "Mathematically verify if the codebase supports a specific behavioral goal by tracing logic paths in the AST Merkle-Graph. Returns a proof report showing which logic nodes exist, which connections are wired, and whether the goal is provably met.",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {
                                        "goal": { "type": "string", "description": "The behavioral goal to prove (e.g., 'User can login via OAuth')." }
                                    },
                                    "required": ["goal"]
                                }
                            },
                            {
                                "name": "aura_rewind",
                                "description": "Surgically revert a specific function or class to a previous safe state from snapshots or git history, WITHOUT touching the rest of the file. Use this when an AI hallucination corrupted a single function.",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {
                                        "identifier": { "type": "string", "description": "Name of the function/class/struct to rewind (e.g., 'handle_login')." },
                                        "file_path": { "type": "string", "description": "Path to the file containing the identifier." }
                                    },
                                    "required": ["identifier", "file_path"]
                                }
                            },
                            {
                                "name": "aura_plan_discover",
                                "description": "Analyze a complex objective and generate a structured wave-based execution plan. Identifies 'Gray Areas' (architectural decisions that need human input) and breaks the work into atomic waves that can be executed independently.",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {
                                        "objective": { "type": "string", "description": "The architectural objective to plan (e.g., 'Implement RBAC with policy engine')." }
                                    },
                                    "required": ["objective"]
                                }
                            },
                            {
                                "name": "aura_plan_lock",
                                "description": "Lock the current active plan after reviewing gray areas. Once locked, the plan becomes executable via aura_plan_next.",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {}
                                }
                            },
                            {
                                "name": "aura_plan_next",
                                "description": "Execute the next wave in the currently locked plan. Each wave is an atomic unit of work. Returns the wave's tasks and constraints.",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {}
                                }
                            },
                            {
                                "name": "aura_orchestrate_status",
                                "description": "Check the status of multi-agent orchestration sessions. Shows active Duo Mode sessions (Claude + Gemini parallel execution), their progress, and any conflicts detected.",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {}
                                }
                            },
                            {
                                "name": "aura_gemini_skim",
                                "description": "Quick AI-powered analysis of a file or screenshot using Gemini Vision. Returns a concise summary of the content — ideal for understanding unfamiliar code, screenshots, or design references without reading every line.",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {
                                        "file_path": { "type": "string", "description": "Absolute path to the file or image to analyze." },
                                        "question": { "type": "string", "description": "Optional: specific question to answer about the content." }
                                    },
                                    "required": ["file_path"]
                                }
                            },
                            {
                                "name": "aura_gemini_read",
                                "description": "Deep AI-powered analysis of a file using Gemini. Returns detailed architectural breakdown including functions, dependencies, potential issues, and design patterns. More thorough than skim.",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {
                                        "file_path": { "type": "string", "description": "Absolute path to the file to analyze in depth." },
                                        "focus": { "type": "string", "description": "Optional: specific aspect to focus on (e.g., 'security', 'performance', 'architecture')." }
                                    },
                                    "required": ["file_path"]
                                }
                            },
                            {
                                "name": "aura_gemini_batch",
                                "description": "Batch process multiple files through Gemini Vision for bulk analysis. Returns a summary of each file. Useful for understanding an entire module or directory at once.",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {
                                        "file_paths": { "type": "string", "description": "Comma-separated list of absolute file paths to analyze." },
                                        "question": { "type": "string", "description": "Question to answer about the batch of files." }
                                    },
                                    "required": ["file_paths", "question"]
                                }
                            },
                            {
                                "name": "aura_context_budget",
                                "description": "Check the current token/context budget usage for the active session. Shows how many files are tracked, estimated token count, and recommendations for context optimization (e.g., when to run aura_handover).",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {}
                                }
                            },
                            {
                                "name": "aura_suggest_edit",
                                "description": "AI-powered edit suggestion. Given a file and an intent, returns the exact code changes needed — including which functions to modify and how. Uses the AST Merkle-Graph to understand dependencies before suggesting.",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {
                                        "file_path": { "type": "string", "description": "Path to the file to suggest edits for." },
                                        "intent": { "type": "string", "description": "What you want to achieve (e.g., 'add rate limiting to this endpoint')." }
                                    },
                                    "required": ["file_path", "intent"]
                                }
                            },
                            {
                                "name": "aura_session_resume",
                                "description": "Find previous AI sessions on a specific branch and show their context, prompts, and summaries. Use this when resuming work on a feature branch to understand what was done before.",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {
                                        "branch": { "type": "string", "description": "Branch name to find sessions for (e.g., 'feat/auth')." }
                                    },
                                    "required": ["branch"]
                                }
                            },
                            {
                                "name": "aura_doctor",
                                "description": "Diagnose repository health: find stuck sessions, orphaned snapshots, missing hooks, and shadow branch issues. Returns a health report with actionable fixes.",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {}
                                }
                            },
                            {
                                "name": "aura_session_summarize",
                                "description": "Generate an AI-powered summary of a specific session, including intent, outcome, learnings, and open items. Uses Gemini to analyze the session transcript.",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {
                                        "session_id": { "type": "string", "description": "Session ID to summarize (e.g., '2026-03-09-abc12345')." }
                                    },
                                    "required": ["session_id"]
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
                    "aura_handover" => Self::tool_handover(args),
                    "aura_prove" => Self::tool_prove(args),
                    "aura_rewind" => Self::tool_rewind(args),
                    "aura_plan_discover" => Self::tool_plan_discover(args),
                    "aura_plan_lock" => Self::tool_plan_lock(args),
                    "aura_plan_next" => Self::tool_plan_next(args),
                    "aura_orchestrate_status" => Self::tool_orchestrate_status(args),
                    "aura_gemini_skim" => Self::tool_gemini_skim(args),
                    "aura_gemini_read" => Self::tool_gemini_read(args),
                    "aura_gemini_batch" => Self::tool_gemini_batch(args),
                    "aura_context_budget" => Self::tool_context_budget(args),
                    "aura_suggest_edit" => Self::tool_suggest_edit(args),
                    "aura_session_resume" => Self::tool_session_resume(args),
                    "aura_doctor" => Self::tool_doctor(args),
                    "aura_session_summarize" => Self::tool_session_summarize(args),
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

    fn tool_handover(args: Value) -> Value {
        let agent = args["agent"].as_str().unwrap_or("claude");
        let repo = match Repository::open(".") {
            Ok(r) => r,
            Err(_) => return json!({ "isError": true, "content": [{ "type": "text", "text": "Not a git repository." }] }),
        };

        let results = match CheckpointStore::get_all_checkpoints(&repo) {
            Ok(r) => r,
            Err(e) => return json!({ "isError": true, "content": [{ "type": "text", "text": format!("Failed to load checkpoints: {}", e) }] }),
        };

        let mut xml_payload = String::from("<aura_semantic_context>\n");
        for data in results.iter().take(3) {
            xml_payload.push_str(&format!("  <checkpoint id=\"{}\" agent=\"{}\">\n", data.id, data.agent_id));
            xml_payload.push_str(&format!("    <intent>{}</intent>\n", data.intent.replace('\n', " ")));
            xml_payload.push_str("    <modified_nodes>\n");
            for node in &data.ast_nodes {
                let ident = node.identifier.clone().unwrap_or_else(|| "anonymous".to_string());
                xml_payload.push_str(&format!("      <node type=\"{}\" name=\"{}\"", node.kind, ident));
                if !node.dependencies.is_empty() {
                    let deps: Vec<String> = node.dependencies.iter().map(|d| {
                        if let Some(ref uri) = d.uri {
                            format!("{}={}", d.name, uri)
                        } else {
                            d.name.clone()
                        }
                    }).collect();
                    xml_payload.push_str(&format!(" calls=\"{}\"", deps.join(",")));
                }
                xml_payload.push_str("/>\n");
            }
            xml_payload.push_str("    </modified_nodes>\n  </checkpoint>\n");
        }
        xml_payload.push_str("</aura_semantic_context>");

        json!({ "content": [{ "type": "text", "text": format!("Handover context for {}:\n\n{}", agent, xml_payload) }] })
    }

    fn tool_prove(args: Value) -> Value {
        let goal = match args["goal"].as_str() {
            Some(g) => g.to_string(),
            None => return json!({ "isError": true, "content": [{ "type": "text", "text": "goal is required." }] }),
        };

        // Capture stdout from prove_goal (it uses println!)
        let output = Self::capture_stdout(|| {
            crate::gsd::GsdEngine::prove_goal(&goal);
        });

        json!({ "content": [{ "type": "text", "text": output }] })
    }

    fn tool_rewind(args: Value) -> Value {
        let identifier = match args["identifier"].as_str() {
            Some(i) => i.to_string(),
            None => return json!({ "isError": true, "content": [{ "type": "text", "text": "identifier is required." }] }),
        };
        let file_path = match args["file_path"].as_str() {
            Some(f) => f.to_string(),
            None => return json!({ "isError": true, "content": [{ "type": "text", "text": "file_path is required." }] }),
        };

        let repo = match Repository::open(".") {
            Ok(r) => r,
            Err(_) => return json!({ "isError": true, "content": [{ "type": "text", "text": "Not a git repository." }] }),
        };

        let mut parser = match crate::parser::SemanticParser::new() {
            Ok(p) => p,
            Err(e) => return json!({ "isError": true, "content": [{ "type": "text", "text": format!("Parser init failed: {}", e) }] }),
        };

        let ext = Self::detect_ext(&file_path);
        if ext.is_empty() {
            return json!({ "isError": true, "content": [{ "type": "text", "text": "Unsupported file extension." }] });
        }

        let current_source = match std::fs::read_to_string(&file_path) {
            Ok(s) => s,
            Err(e) => return json!({ "isError": true, "content": [{ "type": "text", "text": format!("Cannot read file: {}", e) }] }),
        };

        let current_range = match parser.retrieve_node_source(&current_source, &ext, &identifier) {
            Ok(Some((_, range))) => range,
            Ok(None) => return json!({ "isError": true, "content": [{ "type": "text", "text": format!("Cannot find '{}' in current file.", identifier) }] }),
            Err(e) => return json!({ "isError": true, "content": [{ "type": "text", "text": format!("Parse error: {}", e) }] }),
        };

        // Search snapshots first, then git history
        let mut past_source: Option<String> = None;

        // Strategy A: Durable snapshots
        let snapshots = SnapshotStore::get_snapshots_for_file(&file_path);
        for snap in &snapshots {
            if let Ok(Some((src, _))) = parser.retrieve_node_source(&snap.content, &ext, &identifier) {
                if let Ok(Some((current_src, _))) = parser.retrieve_node_source(&current_source, &ext, &identifier) {
                    if src != current_src {
                        past_source = Some(src);
                        break;
                    }
                }
            }
        }

        // Strategy B: Git history (up to 50 commits)
        if past_source.is_none() {
            if let Ok(head) = repo.head().and_then(|r| r.peel_to_commit()) {
                let mut commit = head;
                for _ in 0..50 {
                    let parent = match commit.parent(0) {
                        Ok(p) => p,
                        Err(_) => break,
                    };
                    if let Ok(tree) = parent.tree() {
                        if let Ok(entry) = tree.get_path(Path::new(&file_path)) {
                            if let Ok(obj) = entry.to_object(&repo) {
                                if let Some(blob) = obj.as_blob() {
                                    if let Ok(past_file) = std::str::from_utf8(blob.content()) {
                                        if let Ok(Some((src, _))) = parser.retrieve_node_source(past_file, &ext, &identifier) {
                                            if let Ok(Some((current_src, _))) = parser.retrieve_node_source(&current_source, &ext, &identifier) {
                                                if src != current_src {
                                                    past_source = Some(src);
                                                    break;
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                    commit = parent;
                }
            }
        }

        match past_source {
            Some(old_src) => {
                // Snapshot current file before rewriting
                let _ = SnapshotStore::snapshot_file(&file_path, "pre_rewind", "MCP Agent");

                // Surgical replacement
                let mut new_file = current_source.clone();
                new_file.replace_range(current_range, &old_src);
                match std::fs::write(&file_path, &new_file) {
                    Ok(_) => json!({ "content": [{ "type": "text", "text": format!("Successfully rewound '{}' in {}. Previous version restored surgically.", identifier, file_path) }] }),
                    Err(e) => json!({ "isError": true, "content": [{ "type": "text", "text": format!("Write failed: {}", e) }] }),
                }
            }
            None => {
                json!({ "isError": true, "content": [{ "type": "text", "text": format!("No previous version of '{}' found in snapshots or git history.", identifier) }] })
            }
        }
    }

    fn tool_plan_discover(args: Value) -> Value {
        let objective = match args["objective"].as_str() {
            Some(o) => o.to_string(),
            None => return json!({ "isError": true, "content": [{ "type": "text", "text": "objective is required." }] }),
        };

        let output = Self::capture_stdout(|| {
            crate::gsd::GsdEngine::plan_milestone(&objective);
        });

        // Also read the generated plan file if it exists
        let plan_content = std::fs::read_to_string(".aura/plans/ACTIVE_MILESTONE.xml").unwrap_or_default();
        let combined = if plan_content.is_empty() {
            output
        } else {
            format!("{}\n\n--- ACTIVE PLAN ---\n{}", output, plan_content)
        };

        json!({ "content": [{ "type": "text", "text": combined }] })
    }

    fn tool_plan_lock(_args: Value) -> Value {
        if Path::new(".aura/plans/ACTIVE_MILESTONE.xml").exists() {
            json!({ "content": [{ "type": "text", "text": "Plan locked. Run aura_plan_next to execute the first wave." }] })
        } else {
            json!({ "isError": true, "content": [{ "type": "text", "text": "No active plan found. Run aura_plan_discover first." }] })
        }
    }

    fn tool_plan_next(_args: Value) -> Value {
        let output = Self::capture_stdout(|| {
            crate::gsd::GsdEngine::execute_wave();
        });

        json!({ "content": [{ "type": "text", "text": output }] })
    }

    fn tool_orchestrate_status(_args: Value) -> Value {
        match crate::orchestrate::get_status_summary() {
            Ok(summary) => json!({ "content": [{ "type": "text", "text": summary }] }),
            Err(e) => json!({ "content": [{ "type": "text", "text": format!("No active orchestration session. {}", e) }] }),
        }
    }

    // --- Helper functions ---

    /// Capture stdout from functions that use println! instead of returning values
    fn capture_stdout<F: FnOnce()>(f: F) -> String {
        use std::process::Command;
        // Since we can't easily redirect Rust's println! in-process,
        // run the aura CLI as a subprocess to capture output
        // For now, call the function directly and return a status message
        f();
        // The function printed to stdout directly which goes to the MCP pipe.
        // This is a limitation — ideally these functions should return strings.
        "Command executed. Check .aura/plans/ for generated artifacts.".to_string()
    }

    fn detect_ext(file_path: &str) -> String {
        Path::new(file_path)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_string()
    }

    fn tool_gemini_skim(args: Value) -> Value {
        let file_path = match args["file_path"].as_str() {
            Some(p) => p,
            None => return json!({ "isError": true, "content": [{ "type": "text", "text": "file_path is required." }] }),
        };

        // Resolve absolute path
        let abs_path = if Path::new(file_path).is_absolute() {
            file_path.to_string()
        } else {
            match std::env::current_dir() {
                Ok(cwd) => cwd.join(file_path).to_string_lossy().to_string(),
                Err(_) => file_path.to_string(),
            }
        };

        let content = match std::fs::read_to_string(&abs_path) {
            Ok(c) => c,
            Err(e) => return json!({ "isError": true, "content": [{ "type": "text", "text": format!("Cannot read {}: {}", abs_path, e) }] }),
        };

        let question = args["question"].as_str().unwrap_or("Provide a concise summary of this code: what it does, key functions, and notable patterns.");

        // Truncate to ~8K chars to stay within token limits
        let truncated = if content.len() > 8000 { &content[..8000] } else { &content };

        let system_prompt = "You are the Aura Semantic Analyzer. Provide concise, structured analysis of code files. Focus on architecture, not line-by-line explanation. Use bullet points.";
        let user_prompt = format!("File: {}\nQuestion: {}\n\n```\n{}\n```", abs_path, question, truncated);

        match crate::gsd::GsdEngine::generate_content(system_prompt, &user_prompt, 0.2, crate::gsd::CognitiveLabor::Auditor) {
            Some(response) => {
                let data = json!({ "file": abs_path, "analysis": response });
                let toon_text = crate::toon::encode(&data);
                json!({ "content": [{ "type": "text", "text": toon_text }] })
            }
            None => json!({ "isError": true, "content": [{ "type": "text", "text": "AI analysis failed. Check API key configuration with `aura config`." }] }),
        }
    }

    fn tool_gemini_read(args: Value) -> Value {
        let file_path = match args["file_path"].as_str() {
            Some(p) => p,
            None => return json!({ "isError": true, "content": [{ "type": "text", "text": "file_path is required." }] }),
        };

        let abs_path = if Path::new(file_path).is_absolute() {
            file_path.to_string()
        } else {
            match std::env::current_dir() {
                Ok(cwd) => cwd.join(file_path).to_string_lossy().to_string(),
                Err(_) => file_path.to_string(),
            }
        };

        let content = match std::fs::read_to_string(&abs_path) {
            Ok(c) => c,
            Err(e) => return json!({ "isError": true, "content": [{ "type": "text", "text": format!("Cannot read {}: {}", abs_path, e) }] }),
        };

        let focus = args["focus"].as_str().unwrap_or("architecture");

        let system_prompt = "You are the Aura Deep Semantic Analyzer. Provide thorough architectural analysis:\n\
            1. **Purpose**: What this file/module does in the system\n\
            2. **Key Functions**: List each with signature and responsibility\n\
            3. **Dependencies**: What it imports and calls externally\n\
            4. **Design Patterns**: Architectural patterns used\n\
            5. **Potential Issues**: Security, performance, or correctness concerns\n\
            6. **Blast Radius**: What breaks if this file changes\n\
            Be specific and reference actual function/struct names.";

        let user_prompt = format!("File: {}\nFocus: {}\nFull content ({} lines):\n\n```\n{}\n```",
            abs_path, focus, content.lines().count(), content);

        match crate::gsd::GsdEngine::generate_content(system_prompt, &user_prompt, 0.1, crate::gsd::CognitiveLabor::Auditor) {
            Some(response) => {
                let data = json!({ "file": abs_path, "focus": focus, "deep_analysis": response });
                let toon_text = crate::toon::encode(&data);
                json!({ "content": [{ "type": "text", "text": toon_text }] })
            }
            None => json!({ "isError": true, "content": [{ "type": "text", "text": "Deep analysis failed. Check API key configuration." }] }),
        }
    }

    fn tool_gemini_batch(args: Value) -> Value {
        let file_paths_str = match args["file_paths"].as_str() {
            Some(p) => p,
            None => return json!({ "isError": true, "content": [{ "type": "text", "text": "file_paths is required (comma-separated)." }] }),
        };
        let question = match args["question"].as_str() {
            Some(q) => q,
            None => return json!({ "isError": true, "content": [{ "type": "text", "text": "question is required." }] }),
        };

        let paths: Vec<&str> = file_paths_str.split(',').map(|s| s.trim()).collect();
        let mut combined_content = String::new();

        for path in &paths {
            let abs_path = if Path::new(path).is_absolute() {
                path.to_string()
            } else {
                match std::env::current_dir() {
                    Ok(cwd) => cwd.join(path).to_string_lossy().to_string(),
                    Err(_) => path.to_string(),
                }
            };

            match std::fs::read_to_string(&abs_path) {
                Ok(content) => {
                    // Limit each file to 4K chars in batch mode
                    let truncated = if content.len() > 4000 { &content[..4000] } else { &content };
                    combined_content.push_str(&format!("\n=== FILE: {} ===\n```\n{}\n```\n", abs_path, truncated));
                }
                Err(e) => {
                    combined_content.push_str(&format!("\n=== FILE: {} === ERROR: {}\n", abs_path, e));
                }
            }
        }

        let system_prompt = "You are the Aura Batch Analyzer. Analyze multiple files together and answer the user's question by cross-referencing them. Focus on how they interact, shared patterns, and architectural relationships.";
        let user_prompt = format!("Question: {}\n\nFiles ({} total):\n{}", question, paths.len(), combined_content);

        match crate::gsd::GsdEngine::generate_content(system_prompt, &user_prompt, 0.2, crate::gsd::CognitiveLabor::Auditor) {
            Some(response) => {
                let data = json!({ "files_analyzed": paths.len(), "question": question, "analysis": response });
                let toon_text = crate::toon::encode(&data);
                json!({ "content": [{ "type": "text", "text": toon_text }] })
            }
            None => json!({ "isError": true, "content": [{ "type": "text", "text": "Batch analysis failed. Check API key configuration." }] }),
        }
    }

    fn tool_context_budget(_args: Value) -> Value {
        let repo = match Repository::open(".") {
            Ok(r) => r,
            Err(_) => return json!({ "isError": true, "content": [{ "type": "text", "text": "Not a git repository." }] }),
        };

        let checkpoints = CheckpointStore::get_all_checkpoints(&repo).unwrap_or_default();
        let snapshots = SnapshotStore::get_all_snapshots();

        // Estimate token usage from tracked files
        let mut total_chars: usize = 0;
        let mut tracked_files: Vec<String> = Vec::new();

        // Walk tracked files from git status instead of AST nodes
        if let Ok(statuses) = repo.statuses(None) {
            for entry in statuses.iter() {
                if let Some(path) = entry.path() {
                    if !tracked_files.contains(&path.to_string()) {
                        tracked_files.push(path.to_string());
                        if let Ok(content) = std::fs::read_to_string(path) {
                            total_chars += content.len();
                        }
                    }
                }
            }
        }

        let estimated_tokens = total_chars / 4; // rough chars-to-tokens ratio
        let handover_recommended = estimated_tokens > 50_000;

        let budget = json!({
            "tracked_files": tracked_files.len(),
            "total_checkpoints": checkpoints.len(),
            "active_snapshots": snapshots.len(),
            "estimated_chars": total_chars,
            "estimated_tokens": estimated_tokens,
            "handover_recommended": handover_recommended,
            "recommendation": if handover_recommended {
                "Context is large. Run aura_handover to generate a compressed XML payload and start a fresh context window."
            } else {
                "Context budget is healthy. Continue working."
            }
        });

        let toon_text = crate::toon::encode(&budget);
        json!({ "content": [{ "type": "text", "text": toon_text }] })
    }

    fn tool_suggest_edit(args: Value) -> Value {
        let file_path = match args["file_path"].as_str() {
            Some(p) => p,
            None => return json!({ "isError": true, "content": [{ "type": "text", "text": "file_path is required." }] }),
        };
        let intent = match args["intent"].as_str() {
            Some(i) => i,
            None => return json!({ "isError": true, "content": [{ "type": "text", "text": "intent is required." }] }),
        };

        let content = match std::fs::read_to_string(file_path) {
            Ok(c) => c,
            Err(e) => return json!({ "isError": true, "content": [{ "type": "text", "text": format!("Cannot read {}: {}", file_path, e) }] }),
        };

        // Get AST context for better suggestions
        let repo = Repository::open(".").ok();
        let mut ast_context = String::new();
        if let Some(ref repo) = repo {
            if let Ok(checkpoints) = CheckpointStore::get_all_checkpoints(repo) {
                if let Some(latest) = checkpoints.first() {
                    // Filter nodes by identifier prefix matching the file
                    let relevant_nodes: Vec<&crate::models::AstNode> = latest.ast_nodes.iter()
                        .take(50) // limit to avoid huge output
                        .collect();
                    for node in &relevant_nodes {
                        let ident = node.identifier.as_deref().unwrap_or("anon");
                        let deps: Vec<String> = node.dependencies.iter().map(|d| d.name.clone()).collect();
                        ast_context.push_str(&format!("  {} {} (calls: {})\n", node.kind, ident, deps.join(", ")));
                    }
                }
            }
        }

        let system_prompt = "You are the Aura Edit Advisor. Given a file and an intent, suggest the MINIMAL exact code changes needed.\n\
            Format your response as:\n\
            1. **Target**: Which function/struct to modify\n\
            2. **Change**: What to add/modify/remove\n\
            3. **Code**: The exact new code (just the changed function, not the whole file)\n\
            4. **Blast Radius**: What else might need updating\n\
            Be surgical — suggest the smallest change that achieves the intent.";

        let user_prompt = format!(
            "File: {}\nIntent: {}\n\nAST Context (functions in this file):\n{}\n\nFull source:\n```\n{}\n```",
            file_path, intent, if ast_context.is_empty() { "  (no AST data available)\n".to_string() } else { ast_context }, content
        );

        match crate::gsd::GsdEngine::generate_content(system_prompt, &user_prompt, 0.1, crate::gsd::CognitiveLabor::Architect) {
            Some(response) => {
                let data = json!({ "file": file_path, "intent": intent, "suggestion": response });
                let toon_text = crate::toon::encode(&data);
                json!({ "content": [{ "type": "text", "text": toon_text }] })
            }
            None => json!({ "isError": true, "content": [{ "type": "text", "text": "Edit suggestion failed. Check API key configuration." }] }),
        }
    }

    fn tool_session_resume(args: Value) -> Value {
        let branch = match args["branch"].as_str() {
            Some(b) => b,
            None => return json!({ "isError": true, "content": [{ "type": "text", "text": "branch is required." }] }),
        };

        let sessions = SessionManager::resume_branch(branch);
        if sessions.is_empty() {
            return json!({ "content": [{ "type": "text", "text": format!("No previous sessions found on branch '{}'. Starting fresh.", branch) }] });
        }

        let mut output = format!("Found {} session(s) on branch '{}':\n\n", sessions.len(), branch);
        for sess in &sessions {
            output.push_str(&format!("Session: {} ({})\n", sess.session_id, sess.agent_id));
            output.push_str(&format!("  Files: {}, Checkpoints: {}\n", sess.files_touched.len(), sess.checkpoint_count));
            if let Some(ref model) = sess.model_name {
                output.push_str(&format!("  Model: {}\n", model));
            }
            if let Some(ref prompt) = sess.first_prompt {
                output.push_str(&format!("  Prompt: \"{}\"\n", prompt));
            }
            if let Some(ref usage) = sess.token_usage {
                if usage.total() > 0 {
                    output.push_str(&format!("  Tokens: {}k in / {}k out\n", usage.input_tokens / 1000, usage.output_tokens / 1000));
                }
            }
            if let Some(ref summary) = sess.summary {
                output.push_str(&format!("  Intent: {}\n  Outcome: {}\n", summary.intent, summary.outcome));
                if !summary.open_items.is_empty() {
                    output.push_str("  Open items:\n");
                    for item in &summary.open_items {
                        output.push_str(&format!("    - {}\n", item));
                    }
                }
            }

            // Include condensed transcript from last session
            let transcript = SessionManager::condense_transcript(&sess.session_id);
            if !transcript.is_empty() {
                output.push_str("\n  Recent context:\n");
                for line in transcript.lines().take(10) {
                    output.push_str(&format!("    {}\n", line));
                }
            }
            output.push('\n');
        }

        json!({ "content": [{ "type": "text", "text": output }] })
    }

    fn tool_doctor(args: Value) -> Value {
        let _ = args;
        let mut report = String::from("Aura Doctor Report:\n\n");
        let mut issues = 0;

        // 1. Stuck sessions
        let stuck = SessionManager::find_stuck_sessions();
        if stuck.is_empty() {
            report.push_str("✓ No stuck sessions\n");
        } else {
            for (sess, reason) in &stuck {
                report.push_str(&format!("⚠ Stuck: {} — {}\n", sess.session_id, reason));
                issues += 1;
            }
            // Auto-fix stuck sessions
            for (sess, _) in &stuck {
                SessionManager::force_end_session(&sess.session_id);
                report.push_str(&format!("  → Fixed: force-ended {}\n", sess.session_id));
            }
        }

        // 2. Orphaned snapshots
        let snapshots = SnapshotStore::get_all_snapshots();
        let orphaned: usize = snapshots.iter()
            .filter(|s| !Path::new(&s.file_path).exists())
            .count();
        if orphaned > 0 {
            report.push_str(&format!("⚠ {} orphaned snapshots (deleted files)\n", orphaned));
            issues += orphaned;
        } else {
            report.push_str("✓ No orphaned snapshots\n");
        }

        // 3. Snapshot disk usage
        report.push_str(&format!("ℹ {} total snapshots\n", snapshots.len()));
        if snapshots.len() > 400 {
            SnapshotStore::prune_global();
            report.push_str("  → Pruned excess snapshots\n");
        }

        // 4. Git hooks
        let hooks_ok = Path::new(".git/hooks/pre-commit").exists();
        if hooks_ok {
            report.push_str("✓ Git hooks installed\n");
        } else {
            report.push_str("⚠ Git hooks not installed — run `aura init`\n");
            issues += 1;
        }

        // 5. Shadow branch
        if let Ok(repo) = Repository::open(".") {
            if repo.find_reference("refs/heads/aura/checkpoints").is_ok() {
                let count = CheckpointStore::get_shadow_checkpoints(&repo)
                    .map(|c| c.len()).unwrap_or(0);
                report.push_str(&format!("✓ Shadow branch healthy ({} checkpoints)\n", count));
            } else {
                report.push_str("ℹ Shadow branch not yet created\n");
            }
        }

        // 6. Stale cleanup
        let cleaned = SessionManager::cleanup_stale(7);
        if cleaned > 0 {
            report.push_str(&format!("🧹 Cleaned {} stale sessions\n", cleaned));
        }

        report.push_str(&format!("\nTotal issues: {}", issues));

        json!({ "content": [{ "type": "text", "text": report }] })
    }

    fn tool_session_summarize(args: Value) -> Value {
        let session_id = match args["session_id"].as_str() {
            Some(s) => s,
            None => return json!({ "isError": true, "content": [{ "type": "text", "text": "session_id is required." }] }),
        };

        match SessionManager::summarize_session(session_id) {
            Some(summary) => {
                let output = format!(
                    "Session Summary for {}:\n\n\
                    Intent: {}\n\
                    Outcome: {}\n\
                    Files: {}\n\
                    Learnings: {}\n\
                    Open Items: {}",
                    session_id,
                    summary.intent,
                    summary.outcome,
                    summary.files_changed.join(", "),
                    if summary.learnings.is_empty() { "none".to_string() }
                    else { summary.learnings.join("; ") },
                    if summary.open_items.is_empty() { "none".to_string() }
                    else { summary.open_items.join("; ") },
                );
                json!({ "content": [{ "type": "text", "text": output }] })
            }
            None => json!({ "content": [{ "type": "text", "text": format!("No transcript found for session '{}'.", session_id) }] }),
        }
    }
}

