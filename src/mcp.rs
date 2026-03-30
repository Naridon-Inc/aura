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
                let res_json = match serde_json::to_string(&response) {
                    Ok(j) => j,
                    Err(e) => {
                        eprintln!("MCP serialize error: {}", e);
                        continue;
                    }
                };
                if let Err(e) = writeln!(stdout, "{}", res_json) {
                    eprintln!("MCP write error: {}", e);
                    return;
                }
                let _ = stdout.flush();
            } else {
                let err_res = json!({
                    "jsonrpc": "2.0",
                    "id": null,
                    "error": { "code": -32700, "message": "Parse error" }
                });
                if let Err(e) = writeln!(stdout, "{}", err_res) {
                    eprintln!("MCP write error: {}", e);
                    return;
                }
                let _ = stdout.flush();
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
                                "description": "Check the current semantic status of the repository, including active checkpoints, logic nodes tracked, and other active AI agent sessions (Sentinel). Call this at the start of every session.",
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
                                "name": "aura_usage",
                                "description": "Track AI token usage, costs, and budgets across all agent sessions. Shows per-session, per-model, and per-day cost breakdowns. Use this to monitor how much AI resources you're consuming and stay within budget. Call periodically during long sessions to self-monitor spend.",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {
                                        "period": {
                                            "type": "string",
                                            "description": "Time period: 'today', 'week', 'month', 'all'. Default: 'today'.",
                                            "default": "today"
                                        }
                                    }
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
                            },
                            {
                                "name": "aura_live_impacts",
                                "description": "Fetch unresolved cross-branch impact alerts from Aura Cloud. Shows functions on other branches that were modified or deleted while your code depends on them. Call at session start and periodically during long sessions.",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {}
                                }
                            },
                            {
                                "name": "aura_live_resolve",
                                "description": "Mark an impact alert as resolved after you have reviewed and fixed the dependency conflict. This dismisses the alert from future queries.",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {
                                        "alert_id": { "type": "string", "description": "The UUID of the impact alert to resolve." }
                                    },
                                    "required": ["alert_id"]
                                }
                            },
                            {
                                "name": "aura_msg_send",
                                "description": "Send a message to your team or a specific developer working in the same repository. Messages are delivered in real-time via Aura Cloud. Use this to coordinate with other developers or AI agents across branches.",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {
                                        "message": { "type": "string", "description": "The message to send to the team." },
                                        "to": { "type": "string", "description": "Optional: specific username to DM. If omitted, broadcasts to the whole repo team." }
                                    },
                                    "required": ["message"]
                                }
                            },
                            {
                                "name": "aura_msg_list",
                                "description": "Read recent team messages for this repository. Returns the latest messages from other developers and AI agents. Call this when you see an unread message notification.",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {
                                        "limit": { "type": "number", "description": "Max messages to return (default: 20)." }
                                    }
                                }
                            },
                            {
                                "name": "aura_live_sync_push",
                                "description": "Push function bodies from a file to Aura Cloud so teammates can pull them. Use after editing a file to share your changes at the function level — like Figma for code.",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {
                                        "file_path": { "type": "string", "description": "Path to the file whose functions to push." }
                                    },
                                    "required": ["file_path"]
                                }
                            },
                            {
                                "name": "aura_live_sync_pull",
                                "description": "Pull function-level changes from teammates and apply them to your local files. Shows what changed and applies updates at the AST level with automatic snapshots for safety.",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {
                                        "dry_run": { "type": "boolean", "description": "If true, show what would change without applying. Default: false." }
                                    }
                                }
                            },
                            {
                                "name": "aura_live_sync_status",
                                "description": "Check function-level sync status: pending changes from teammates, total synced functions, and active pushers.",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {}
                                }
                            },
                            {
                                "name": "aura_sentinel_status",
                                "description": "Check local multi-agent collision status. Shows which functions are claimed by which sessions, active collisions, and zone ownership. Use to see if another AI agent is working on the same code.",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {}
                                }
                            },
                            {
                                "name": "aura_zone_claim",
                                "description": "Claim an exclusive zone (directory/file pattern) for this session. Other sessions touching files in this zone will get a warning (mode: warn) or be blocked (mode: block).",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {
                                        "patterns": { "type": "string", "description": "Comma-separated file path patterns to claim (e.g., 'src/auth/,src/middleware/')." },
                                        "mode": { "type": "string", "description": "Zone mode: 'warn' (default) or 'block'." }
                                    },
                                    "required": ["patterns"]
                                }
                            },
                            {
                                "name": "aura_sentinel_release",
                                "description": "Manually release function claims for this session. Optionally release only claims for a specific file.",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {
                                        "file_path": { "type": "string", "description": "Optional: release claims only for this file. If omitted, releases all claims." }
                                    }
                                }
                            },
                            {
                                "name": "aura_sentinel_send",
                                "description": "Send a message to another agent session working in this repo. Use to coordinate, ask questions, delegate work, or share findings. Messages are delivered locally via file-based mailbox — works between ANY agents (Claude, Copilot, Gemini, Cursor, etc.).",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {
                                        "message": { "type": "string", "description": "The message to send." },
                                        "to": { "type": "string", "description": "Optional: target session_id for a direct message. If omitted, broadcasts to ALL active agent sessions." }
                                    },
                                    "required": ["message"]
                                }
                            },
                            {
                                "name": "aura_sentinel_inbox",
                                "description": "Read messages from other agent sessions. Shows unread messages first, then recent history. Messages are automatically marked as read.",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {
                                        "limit": { "type": "number", "description": "Max messages to return (default: 20)." }
                                    }
                                }
                            },
                            {
                                "name": "aura_sentinel_agents",
                                "description": "IMPORTANT: You MUST call this tool whenever the user asks about other agents, other Claude sessions, or who else is working on this repo. Lists all active AI agent sessions (Claude, Copilot, Gemini, Cursor, etc.) with their PID, files being worked on, and session ID for messaging. Never guess — always check.",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {}
                                }
                            },
                            {
                                "name": "aura_memory_write",
                                "description": "Write to the project's permanent memory. Use this to record architectural knowledge, decisions, conventions, gotchas, or context that future AI agents (or yourself in a future session) should know. This memory persists FOREVER across all sessions and all agents. Sections: 'identity' (set project purpose + stack), 'architecture' (add component), 'timeline' (record decision/milestone), 'convention', 'gotcha', 'context', 'active_work'.",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {
                                        "section": { "type": "string", "description": "Section to write to: 'identity', 'architecture', 'timeline', 'convention', 'gotcha', 'context', 'active_work'." },
                                        "content": { "type": "string", "description": "The memory content. For 'identity': project description. For 'architecture': JSON with name, kind, path, description, connects_to. For 'timeline': JSON with date, title, description, category. For others: plain text." },
                                        "tags": { "type": "string", "description": "Optional comma-separated tags for searchability." },
                                        "stack": { "type": "string", "description": "Optional: comma-separated tech stack (only for 'identity' section)." }
                                    },
                                    "required": ["section", "content"]
                                }
                            },
                            {
                                "name": "aura_memory_read",
                                "description": "Read the project's permanent memory — architecture, decisions, conventions, gotchas, and context accumulated across all past sessions. Call this when starting work on an unfamiliar area, or when you need to understand why something was built a certain way. Use 'query' to search, or omit for the full project memory.",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {
                                        "query": { "type": "string", "description": "Optional: search keyword to filter memories. If omitted, returns the full project memory." }
                                    }
                                }
                            },
                            {
                                "name": "aura_memory_forget",
                                "description": "Remove a memory entry by its ID. Use when information is outdated or wrong.",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {
                                        "id": { "type": "string", "description": "The memory entry ID to remove (e.g., 'mem-a1b2c3d4')." }
                                    },
                                    "required": ["id"]
                                }
                            },
                            {
                                "name": "aura_memory_compact",
                                "description": "AI-powered memory compaction. Uses Gemini (free) or Claude to compress many entries in a section into fewer, denser ones. Call when aura_status shows a compaction recommendation. No extra API key needed — uses existing Gemini CLI or Claude Code credentials.",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {
                                        "section": { "type": "string", "description": "Section to compact: 'convention', 'gotcha', or 'context'." }
                                    },
                                    "required": ["section"]
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
                    "aura_usage" => Self::tool_usage(args),
                    "aura_suggest_edit" => Self::tool_suggest_edit(args),
                    "aura_session_resume" => Self::tool_session_resume(args),
                    "aura_doctor" => Self::tool_doctor(args),
                    "aura_session_summarize" => Self::tool_session_summarize(args),
                    "aura_live_impacts" => Self::tool_live_impacts(args),
                    "aura_live_resolve" => Self::tool_live_resolve(args),
                    "aura_msg_send" => Self::tool_msg_send(args),
                    "aura_msg_list" => Self::tool_msg_list(args),
                    "aura_live_sync_push" => Self::tool_sync_push(args),
                    "aura_live_sync_pull" => Self::tool_sync_pull(args),
                    "aura_live_sync_status" => Self::tool_sync_status(args),
                    "aura_sentinel_status" => Self::tool_sentinel_status(args),
                    "aura_zone_claim" => Self::tool_zone_claim(args),
                    "aura_sentinel_release" => Self::tool_sentinel_release(args),
                    "aura_sentinel_send" => Self::tool_sentinel_send(args),
                    "aura_sentinel_inbox" => Self::tool_sentinel_inbox(args),
                    "aura_sentinel_agents" => Self::tool_sentinel_agents(args),
                    "aura_memory_write" => Self::tool_memory_write(args),
                    "aura_memory_read" => Self::tool_memory_read(args),
                    "aura_memory_forget" => Self::tool_memory_forget(args),
                    "aura_memory_compact" => Self::tool_memory_compact(args),
                    _ => json!({ "isError": true, "content": [{ "type": "text", "text": "Unknown tool" }] })
                };

                // Sentinel: register presence on EVERY tool call.
                // Ensure each MCP process gets its own session (PID-unique).
                {
                    let my_pid = std::process::id();
                    let session = SessionManager::get_active_session();
                    let session = match session {
                        Some(s) if s.pid == Some(my_pid) => s,
                        _ => {
                            // No session for this PID — create one
                            SessionManager::start_session("MCP Agent")
                        }
                    };
                    crate::sentinel::SentinelManager::claim_functions(
                        &session.session_id,
                        &session.agent_id,
                        my_pid,
                        "__presence__",
                        &[],
                    );
                    crate::sentinel::SentinelManager::update_heartbeat(&session.session_id);
                }

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

                // Push-based: Warn if files were modified without a snapshot
                // This is the "seatbelt" — catches edits that bypassed aura_snapshot
                if name != "aura_snapshot" && name != "aura_snapshot_list" {
                    // Get git-modified files (unstaged working tree changes)
                    let unsnapshotted: Option<Vec<String>> = (|| {
                        let output = std::process::Command::new("git")
                            .args(["diff", "--name-only"])
                            .output()
                            .ok()?;
                        let diff_text = String::from_utf8_lossy(&output.stdout);
                        let modified_files: Vec<String> = diff_text
                            .lines()
                            .filter(|l| !l.is_empty())
                            .map(|l| l.to_string())
                            .collect();

                        if modified_files.is_empty() {
                            return None;
                        }

                        // Check which modified files have NO snapshot on disk
                        let snap_dir = std::path::Path::new(".aura/snapshots");
                        let mut missing = Vec::new();
                        for file in &modified_files {
                            let safe_name = file.replace('/', "__").replace('\\', "__");
                            let has_snapshot = snap_dir.is_dir()
                                && std::fs::read_dir(snap_dir)
                                    .ok()
                                    .map(|entries| {
                                        entries.flatten().any(|e| {
                                            e.file_name()
                                                .to_string_lossy()
                                                .starts_with(&safe_name)
                                        })
                                    })
                                    .unwrap_or(false);
                            if !has_snapshot {
                                missing.push(file.clone());
                            }
                        }
                        if missing.is_empty() { None } else { Some(missing) }
                    })();

                    if let Some(files) = unsnapshotted {
                        let file_list = files.iter().take(5).cloned().collect::<Vec<_>>().join(", ");
                        let extra = if files.len() > 5 {
                            format!(" (+{} more)", files.len() - 5)
                        } else {
                            String::new()
                        };
                        if let Some(content) = result.get_mut("content").and_then(|c| c.as_array_mut()) {
                            content.push(json!({
                                "type": "text",
                                "text": format!(
                                    "\n🛡️ SNAPSHOT MISSING: {} modified file{} without a snapshot: {}{}. Call `aura_snapshot` on these files NOW — without a snapshot, `aura rewind` cannot recover them if something goes wrong.",
                                    files.len(),
                                    if files.len() == 1 { "" } else { "s" },
                                    file_list,
                                    extra
                                )
                            }));
                        }
                    }
                }

                // Push-based: Inject impact alerts into every tool response
                if name != "aura_live_impacts" && name != "aura_live_resolve" {
                    let marker_path = std::path::Path::new(".aura/live/impacts_pending");
                    if marker_path.exists() {
                        if let Ok(contents) = std::fs::read_to_string(marker_path) {
                            if let Ok(count) = contents.trim().parse::<u64>() {
                                if count > 0 {
                                    if let Some(content) = result.get_mut("content").and_then(|c| c.as_array_mut()) {
                                        content.push(json!({
                                            "type": "text",
                                            "text": format!(
                                                "\n🔴 CROSS-BRANCH ALERT: {} unresolved impact alert{}. Functions you depend on were modified or deleted on other branches. Call `aura_live_impacts` immediately to review.",
                                                count, if count == 1 { "" } else { "s" }
                                            )
                                        }));
                                    }
                                }
                            }
                        }
                    }
                }

                // Push-based: Inject sync pending alerts into every tool response
                if name != "aura_live_sync_pull" && name != "aura_live_sync_push" && name != "aura_live_sync_status" {
                    let sync_marker = std::path::Path::new(".aura/live/sync_pending");
                    if sync_marker.exists() {
                        if let Ok(contents) = std::fs::read_to_string(sync_marker) {
                            if let Ok(count) = contents.trim().parse::<u64>() {
                                if count > 0 {
                                    if let Some(content) = result.get_mut("content").and_then(|c| c.as_array_mut()) {
                                        content.push(json!({
                                            "type": "text",
                                            "text": format!(
                                                "\n🔄 SYNC: {} function update{} from teammates available. Call `aura_live_sync_pull` to apply.",
                                                count, if count == 1 { "" } else { "s" }
                                            )
                                        }));
                                    }
                                }
                            }
                        }
                    }
                }

                // Push-based: Inject sentinel unread message alerts
                if name != "aura_sentinel_inbox" && name != "aura_sentinel_send" {
                    if let Some(session) = SessionManager::get_active_session() {
                        let unread = crate::sentinel::SentinelManager::unread_count(&session.session_id);
                        if unread > 0 {
                            if let Some(content) = result.get_mut("content").and_then(|c| c.as_array_mut()) {
                                content.push(json!({
                                    "type": "text",
                                    "text": format!(
                                        "\n\u{1f4e8} SENTINEL: {} unread message{} from another AI agent working in this repo. You MUST call `aura_sentinel_inbox` to read and reply. Do NOT ignore — another agent is trying to coordinate with you.",
                                        unread,
                                        if unread == 1 { "" } else { "s" }
                                    )
                                }));
                            }
                        }
                    }
                }

                // Push-based: Inject sentinel collision alerts
                if name != "aura_sentinel_status" && name != "aura_sentinel_release" {
                    let sentinel_marker_path = crate::session::worktree_aura_path("sentinel/collisions_pending");
                    let sentinel_marker = std::path::Path::new(&sentinel_marker_path);
                    if sentinel_marker.exists() {
                        if let Ok(contents) = std::fs::read_to_string(sentinel_marker) {
                            if let Ok(count) = contents.trim().parse::<u64>() {
                                if count > 0 {
                                    if let Some(content) = result.get_mut("content").and_then(|c| c.as_array_mut()) {
                                        content.push(json!({
                                            "type": "text",
                                            "text": format!(
                                                "\n\u{26a0}\u{fe0f} SENTINEL: {} function collision{}! Another agent session is editing the same functions. Call `aura_sentinel_status` to see details.",
                                                count, if count == 1 { "" } else { "s" }
                                            )
                                        }));
                                    }
                                }
                            }
                        }
                    }
                }

                // Push-based: Inject unread team messages into every tool response
                {
                    let msg_marker = std::path::Path::new(".aura/live/unread_messages");
                    if msg_marker.exists() {
                        if let Ok(contents) = std::fs::read_to_string(msg_marker) {
                            if let Ok(count) = contents.trim().parse::<u64>() {
                                if count > 0 && name != "aura_msg_list" {
                                    if let Some(content) = result.get_mut("content").and_then(|c| c.as_array_mut()) {
                                        content.push(json!({
                                            "type": "text",
                                            "text": format!(
                                                "\n💬 TEAM: {} unread message{}. Call `aura_msg_list` to read.",
                                                count, if count == 1 { "" } else { "s" }
                                            )
                                        }));
                                    }
                                }
                            }
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

        // Auto-push modified function bodies to mothership for real-time team sync
        let mut auto_push_msg = String::new();
        if let Some(session) = SessionManager::get_active_session() {
            let touched = &session.files_touched;
            if !touched.is_empty() {
                let mut total_pushed: u64 = 0;
                for file_path in touched {
                    if std::path::Path::new(file_path).exists() {
                        if let Ok(source) = std::fs::read_to_string(file_path) {
                            let ext = std::path::Path::new(file_path)
                                .extension().and_then(|e| e.to_str()).unwrap_or("");
                            if let Ok(mut parser) = crate::parser::SemanticParser::new() {
                                if let Ok(nodes) = parser.parse_file(&source, ext) {
                                    let payloads: Vec<crate::live_sync::SyncFunctionPayload> = nodes.iter()
                                        .filter_map(|n| {
                                            let ident = n.identifier.as_ref()?;
                                            let body = crate::live_sync::extract_function_body(&source, ident)?;
                                            Some(crate::live_sync::SyncFunctionPayload {
                                                file_path: file_path.clone(),
                                                function_name: ident.clone(),
                                                function_kind: n.kind.clone(),
                                                content_hash: n.content_hash.clone(),
                                                body,
                                            })
                                        }).collect();
                                    if !payloads.is_empty() {
                                        if let Ok(resp) = crate::live_sync::push_function_bodies(&payloads) {
                                            total_pushed += resp["pushed"].as_u64().unwrap_or(0);
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                if total_pushed > 0 {
                    auto_push_msg = format!("\n🔄 AUTO-SYNC: Pushed {} function bodies to mothership. Teammates will see your changes in real-time.", total_pushed);
                }
            }
        }

        let msg = format!("Intent logged. Aura will bind this reasoning to your AST changes on the next commit.{}", auto_push_msg);
        json!({ "content": [{ "type": "text", "text": msg }] })
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

        // Session & turn-level tracking
        let mut session_data = json!(null);
        if let Some(session) = SessionManager::get_active_session() {
            let turns = SessionManager::turn_count(&session.session_id);
            let (sub_count, sub_types) = SessionManager::subagent_summary(&session.session_id);

            let mut sd = json!({
                "session_id": session.session_id,
                "agent_id": session.agent_id,
                "phase": format!("{:?}", session.phase),
                "turns": turns,
                "subagent_count": sub_count,
                "subagent_types": sub_types,
                "files_touched": session.files_touched.len(),
                "checkpoints": session.checkpoint_count,
            });

            if let Some(ref usage) = session.token_usage {
                sd["tokens"] = json!({
                    "input": usage.input_tokens,
                    "output": usage.output_tokens,
                    "cache_read": usage.cache_read_tokens,
                    "cache_creation": usage.cache_creation_tokens,
                    "api_calls": usage.api_call_count,
                });
            }

            if let Some(cost) = crate::plugins::cost_reporter::calculate_session_cost(Some(&session.session_id)) {
                sd["estimated_cost"] = json!({
                    "total": format!("${:.4}", cost.total_cost),
                    "model": cost.model,
                    "input_cost": format!("${:.4}", cost.input_cost),
                    "output_cost": format!("${:.4}", cost.output_cost),
                });
            }

            session_data = sd;
        }

        // Check for pending live impacts
        let live_impacts = {
            let marker_path = std::path::Path::new(".aura/live/impacts_pending");
            if marker_path.exists() {
                std::fs::read_to_string(marker_path)
                    .ok()
                    .and_then(|s| s.trim().parse::<u64>().ok())
                    .filter(|&n| n > 0)
            } else {
                None
            }
        };

        let mut status_data = json!({
            "strict_mode": config.strict_gatekeeper_mode,
            "strict_mode_locked": crate::config::ConfigManager::is_strict_mode_locked(&config),
            "dev_mode": config.dev_mode,
            "latest_checkpoint_id": checkpoints.first().map(|c| c.id.clone()),
            "logic_nodes_tracked": tracked_count,
            "total_checkpoints": checkpoints.len(),
            "session": session_data,
        });

        if let Some(count) = live_impacts {
            status_data["live_impacts"] = json!({
                "pending": count,
                "hint": "Call aura_live_impacts for details"
            });
        }

        // Sentinel: show other active agents (presence already registered by global hook)
        {
            crate::sentinel::SentinelManager::cleanup_stale();
            let agents = crate::sentinel::SentinelManager::list_agents();
            let other_count = if let Some(ref session) = SessionManager::get_active_session() {
                agents.iter().filter(|a| a["session_id"].as_str() != Some(&session.session_id)).count()
            } else {
                agents.len()
            };

            if other_count > 0 {
                let others: Vec<serde_json::Value> = agents.iter()
                    .filter(|a| {
                        SessionManager::get_active_session()
                            .map(|s| a["session_id"].as_str() != Some(&s.session_id))
                            .unwrap_or(true)
                    })
                    .cloned()
                    .collect();
                status_data["sentinel"] = json!({
                    "other_agents": other_count,
                    "agents": others,
                    "hint": "Other AI agents are active in this repo. Use `aura_sentinel_agents` to see details, `aura_sentinel_send` to communicate."
                });
            } else {
                status_data["sentinel"] = json!({
                    "other_agents": 0,
                    "status": "You are the only active agent"
                });
            }

            // Surface unread messages with full previews — BLOCKING instruction
            if let Some(ref session) = SessionManager::get_active_session() {
                let unread_msgs = crate::sentinel::SentinelManager::get_unread_messages(&session.session_id);
                if !unread_msgs.is_empty() {
                    let now = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_secs();
                    let previews: Vec<serde_json::Value> = unread_msgs.iter().map(|msg| {
                        let age_secs = now.saturating_sub(msg.timestamp);
                        let age_str = if age_secs < 60 {
                            format!("{}s ago", age_secs)
                        } else if age_secs < 3600 {
                            format!("{}m ago", age_secs / 60)
                        } else {
                            format!("{}h ago", age_secs / 3600)
                        };
                        let target = if msg.to_session.is_some() { "YOU (direct)" } else { "ALL agents (broadcast)" };
                        json!({
                            "id": msg.id,
                            "from_agent": msg.from_agent,
                            "to": target,
                            "age": age_str,
                            "preview": if msg.content.len() > 200 {
                                format!("{}...", &msg.content[..200])
                            } else {
                                msg.content.clone()
                            },
                        })
                    }).collect();
                    status_data["PENDING_MESSAGES"] = json!({
                        "BLOCKING": true,
                        "instruction": "You MUST read and reply to these messages BEFORE doing anything else. Call `aura_sentinel_inbox` to read full messages, then reply with `aura_sentinel_send`.",
                        "unread_count": unread_msgs.len(),
                        "messages": previews,
                    });
                }
            }
        }

        // Project memory: inject compact summary so agents get context instantly
        if let Some(memory_summary) = crate::memory::MemoryManager::compact_summary() {
            status_data["project_memory"] = memory_summary;
        }

        // Team sync: mothership connectivity + pending pulls + team knowledge
        {
            let (online, ms, peers) = crate::live_sync::check_mothership();
            if online {
                let mut team = json!({
                    "mothership": "online",
                    "latency_ms": ms,
                    "peers": peers,
                });
                // Check for pending sync
                if let Ok(sync) = crate::live_sync::fetch_sync_status() {
                    let pending = sync["pending_changes"].as_u64().unwrap_or(0);
                    if pending > 0 {
                        team["pending_pull"] = json!({
                            "count": pending,
                            "action": "IMPORTANT: Teammates have pushed function changes. Call `aura_live_sync_pull` to apply them BEFORE editing those files."
                        });
                    }
                }
                // Check config for team-managed repo
                let config_t = crate::config::ConfigManager::load();
                let repo_name = crate::live_sync::repo_name_from_cwd();
                team["is_team_repo"] = json!(config_t.team_repos.contains(&repo_name));
                status_data["team"] = team;
            }
        }

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
                let mut texts = vec![format!(
                    "Snapshot saved: {}. File '{}' can now be recovered with `aura rewind`.",
                    snap_id, file_path
                )];

                // Sentinel: claim functions in this file
                if let Some(session) = SessionManager::get_active_session() {
                    let pid = session.pid.unwrap_or(std::process::id());

                    // Try to parse for function names; fall back to file-level claim
                    let functions = Self::extract_function_names(file_path);

                    // Cleanup stale claims first
                    let stale = crate::sentinel::SentinelManager::cleanup_stale();
                    if stale > 0 {
                        texts.push(format!("Sentinel: cleaned {} stale session(s).", stale));
                    }

                    let collisions = crate::sentinel::SentinelManager::claim_functions(
                        &session.session_id,
                        &session.agent_id,
                        pid,
                        file_path,
                        &functions,
                    );

                    if !collisions.is_empty() {
                        let mut warn = String::from("\n\u{26a0}\u{fe0f} SENTINEL COLLISION: Another agent is editing the same functions:\n");
                        for c in &collisions {
                            warn.push_str(&format!(
                                "  - {}::{} (held by session {} / agent {})\n",
                                c.file_path, c.function_name, c.held_by_session, c.held_by_agent
                            ));
                        }
                        warn.push_str("Coordinate with the other session to avoid conflicts.");
                        texts.push(warn);
                    }

                    // Check zone ownership (local sentinel)
                    if let Some(zone) = crate::sentinel::SentinelManager::check_zone(&session.session_id, file_path) {
                        let severity = match zone.mode {
                            crate::sentinel::ZoneMode::Block => "BLOCKED",
                            crate::sentinel::ZoneMode::Warn => "WARNING",
                        };
                        texts.push(format!(
                            "\n\u{26a0}\u{fe0f} ZONE {}: File '{}' is in zone '{}' owned by session {}. Patterns: {:?}",
                            severity, file_path, zone.zone_id, zone.session_id, zone.patterns
                        ));
                    }

                    // Check remote zone ownership (mothership P2P)
                    if let Ok(resp) = crate::live_sync::check_remote_zone(file_path) {
                        let blocked = resp["blocked"].as_bool().unwrap_or(false);
                        if let Some(conflicts) = resp["conflicts"].as_array() {
                            if !conflicts.is_empty() {
                                let mut warn = format!("\n\u{1f6a8} TEAM ZONE {}: This file is claimed by a teammate on the mothership:\n",
                                    if blocked { "BLOCKED" } else { "WARNING" });
                                for c in conflicts {
                                    let user = c["username"].as_str().unwrap_or("?");
                                    let mode = c["mode"].as_str().unwrap_or("warn");
                                    let label = c["label"].as_str().unwrap_or("");
                                    warn.push_str(&format!("  - {} [{}] {}\n", user, mode, label));
                                }
                                if blocked {
                                    warn.push_str("You MUST NOT edit this file. Coordinate with the zone owner first via `aura_msg_send`.");
                                } else {
                                    warn.push_str("Proceed with caution — notify the zone owner via `aura_msg_send` before making changes.");
                                }
                                texts.push(warn);
                            }
                        }
                    }
                }

                let combined = texts.join("\n");
                json!({ "content": [{ "type": "text", "text": combined }] })
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

    fn tool_usage(args: Value) -> Value {
        let period = args["period"].as_str().unwrap_or("today");
        let since_secs = match period {
            "today" | "day" => 86400u64,
            "week" => 604800,
            "month" => 2592000,
            "all" => u64::MAX,
            _ => 86400,
        };

        let report = crate::usage::build_report(since_secs, period);
        let mut report_json = crate::usage::report_to_json(&report);

        // Include budget alerts if configured
        let config = crate::config::ConfigManager::load();
        if let Some(ref budget) = config.budget {
            let alerts = crate::usage::check_budget(budget);
            let alerts_json: Vec<Value> = alerts.iter().map(|a| {
                json!({
                    "scope": a.scope,
                    "spent": (a.spent * 10000.0).round() / 10000.0,
                    "cap": a.cap,
                    "is_exceeded": a.is_exceeded,
                    "is_warning": a.is_warning,
                })
            }).collect();
            report_json["budget_alerts"] = json!(alerts_json);
        }

        let toon_text = crate::toon::encode(&report_json);
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

    fn tool_live_impacts(_args: Value) -> Value {
        match crate::live_sync::fetch_impacts_json() {
            Ok(data) => {
                let toon_text = crate::toon::encode(&data);
                json!({ "content": [{ "type": "text", "text": toon_text }] })
            }
            Err(e) => {
                json!({ "isError": true, "content": [{ "type": "text", "text": format!("Failed to fetch impacts: {}", e) }] })
            }
        }
    }

    fn tool_live_resolve(args: Value) -> Value {
        let alert_id = match args["alert_id"].as_str() {
            Some(s) => s,
            None => return json!({ "isError": true, "content": [{ "type": "text", "text": "alert_id is required." }] }),
        };

        let config = crate::config::ConfigManager::load();
        let token = match config.cloud_api_token
            .or_else(|| std::env::var("AURA_CLOUD_TOKEN").ok())
        {
            Some(t) => t,
            None => return json!({ "isError": true, "content": [{ "type": "text", "text": "No cloud token configured." }] }),
        };

        let cloud_url = config.cloud_url
            .unwrap_or_else(|| "https://auravcs.com".to_string());
        let url = format!("{}/api/v1/live/impacts/resolve", cloud_url.trim_end_matches('/'));

        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(5))
            .build()
            .unwrap_or_else(|_| reqwest::blocking::Client::new());

        let payload = json!({ "alert_id": alert_id });

        match client.post(&url)
            .header("Authorization", format!("Bearer {}", token))
            .json(&payload)
            .send()
        {
            Ok(resp) if resp.status().is_success() => {
                json!({ "content": [{ "type": "text", "text": format!("Impact alert {} resolved.", alert_id) }] })
            }
            Ok(resp) => {
                json!({ "isError": true, "content": [{ "type": "text", "text": format!("Failed to resolve: HTTP {}", resp.status()) }] })
            }
            Err(e) => {
                json!({ "isError": true, "content": [{ "type": "text", "text": format!("Cloud unreachable: {}", e) }] })
            }
        }
    }

    fn tool_msg_send(args: Value) -> Value {
        let message = match args["message"].as_str() {
            Some(m) => m,
            None => return json!({ "isError": true, "content": [{ "type": "text", "text": "message is required." }] }),
        };
        let to = args["to"].as_str();

        match crate::live_sync::send_team_message(message, to) {
            Ok(resp) => {
                let toon_text = crate::toon::encode(&resp);
                json!({ "content": [{ "type": "text", "text": toon_text }] })
            }
            Err(e) => {
                json!({ "isError": true, "content": [{ "type": "text", "text": format!("Failed to send message: {}", e) }] })
            }
        }
    }

    fn tool_msg_list(args: Value) -> Value {
        let limit = args["limit"].as_u64().unwrap_or(20) as usize;

        match crate::live_sync::fetch_team_messages(limit) {
            Ok(data) => {
                // Mark messages as read by clearing the unread marker
                let marker = std::path::Path::new(".aura/live/unread_messages");
                if marker.exists() {
                    let _ = std::fs::remove_file(marker);
                }
                let toon_text = crate::toon::encode(&data);
                json!({ "content": [{ "type": "text", "text": toon_text }] })
            }
            Err(e) => {
                json!({ "isError": true, "content": [{ "type": "text", "text": format!("Failed to fetch messages: {}", e) }] })
            }
        }
    }

    fn tool_sync_push(args: Value) -> Value {
        let file_path = match args["file_path"].as_str() {
            Some(p) => p,
            None => return json!({ "isError": true, "content": [{ "type": "text", "text": "Missing required parameter: file_path" }] }),
        };

        let path = std::path::Path::new(file_path);
        if !path.exists() {
            return json!({ "isError": true, "content": [{ "type": "text", "text": format!("File not found: {}", file_path) }] });
        }

        let source = match std::fs::read_to_string(path) {
            Ok(s) => s,
            Err(e) => return json!({ "isError": true, "content": [{ "type": "text", "text": format!("Could not read file: {}", e) }] }),
        };

        let ext = path.extension()
            .and_then(|e| e.to_str())
            .unwrap_or("");

        let mut parser = match crate::parser::SemanticParser::new() {
            Ok(p) => p,
            Err(e) => return json!({ "isError": true, "content": [{ "type": "text", "text": format!("Parser init failed: {}", e) }] }),
        };

        let nodes = match parser.parse_file(&source, ext) {
            Ok(n) => n,
            Err(e) => return json!({ "isError": true, "content": [{ "type": "text", "text": format!("Parse failed: {}", e) }] }),
        };

        let mut payloads = Vec::new();
        for node in &nodes {
            if let Some(ref ident) = node.identifier {
                if let Some(body) = crate::live_sync::extract_function_body(&source, ident) {
                    payloads.push(crate::live_sync::SyncFunctionPayload {
                        file_path: file_path.to_string(),
                        function_name: ident.clone(),
                        function_kind: node.kind.clone(),
                        content_hash: node.content_hash.clone(),
                        body,
                    });
                }
            }
        }

        if payloads.is_empty() {
            return json!({ "content": [{ "type": "text", "text": "No identifiable functions found in file." }] });
        }

        match crate::live_sync::push_function_bodies(&payloads) {
            Ok(resp) => {
                let pushed = resp["pushed"].as_u64().unwrap_or(0);
                json!({ "content": [{ "type": "text", "text": format!("Pushed {} functions from {} to Aura Cloud for teammates to pull.", pushed, file_path) }] })
            }
            Err(e) => {
                json!({ "isError": true, "content": [{ "type": "text", "text": format!("Push failed: {}", e) }] })
            }
        }
    }

    fn tool_sync_pull(args: Value) -> Value {
        let dry_run = args["dry_run"].as_bool().unwrap_or(false);

        match crate::live_sync::pull_function_bodies() {
            Ok(data) => {
                let functions = data["functions"].as_array();
                let total = data["total"].as_u64().unwrap_or(0);

                if total == 0 {
                    return json!({ "content": [{ "type": "text", "text": "No new function changes from teammates." }] });
                }

                if dry_run {
                    let mut summary = format!("{} function update(s) available:\n", total);
                    if let Some(funcs) = functions {
                        for f in funcs {
                            let fp = f["file_path"].as_str().unwrap_or("?");
                            let fn_name = f["function_name"].as_str().unwrap_or("?");
                            let pushed_by = f["pushed_by"].as_str().unwrap_or("?");
                            summary.push_str(&format!("  {}::{} from {}\n", fp, fn_name, pushed_by));
                        }
                    }
                    summary.push_str("\nDry run — no files modified. Call again with dry_run: false to apply.");
                    return json!({ "content": [{ "type": "text", "text": summary }] });
                }

                if let Some(funcs) = functions {
                    let (applied, skipped, conflicts) =
                        crate::live_sync::apply_pulled_functions(funcs);

                    let mut summary = format!("Pulled {} function update(s): {} applied, {} skipped.\n", total, applied, skipped);

                    if !conflicts.is_empty() {
                        summary.push_str(&format!("\n{} conflict(s):\n", conflicts.len()));
                        for c in &conflicts {
                            summary.push_str(&format!("  - {}\n", c));
                        }
                    }

                    json!({ "content": [{ "type": "text", "text": summary }] })
                } else {
                    json!({ "content": [{ "type": "text", "text": format!("{} function update(s) available but no function data returned.", total) }] })
                }
            }
            Err(e) => {
                json!({ "isError": true, "content": [{ "type": "text", "text": format!("Pull failed: {}", e) }] })
            }
        }
    }

    fn tool_sync_status(_args: Value) -> Value {
        match crate::live_sync::fetch_sync_status() {
            Ok(data) => {
                let toon_text = crate::toon::encode(&data);
                json!({ "content": [{ "type": "text", "text": toon_text }] })
            }
            Err(e) => {
                json!({ "isError": true, "content": [{ "type": "text", "text": format!("Sync status failed: {}", e) }] })
            }
        }
    }

    // ── Sentinel tools ──

    fn tool_sentinel_status(_args: Value) -> Value {
        let session_id = SessionManager::get_active_session()
            .map(|s| s.session_id)
            .unwrap_or_else(|| "unknown".to_string());

        let status = crate::sentinel::SentinelManager::get_status(&session_id);
        let toon_text = crate::toon::encode(&status);
        json!({ "content": [{ "type": "text", "text": toon_text }] })
    }

    fn tool_zone_claim(args: Value) -> Value {
        let patterns_str = match args["patterns"].as_str() {
            Some(p) => p,
            None => return json!({ "isError": true, "content": [{ "type": "text", "text": "patterns is required." }] }),
        };

        let patterns: Vec<String> = patterns_str
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();

        let mode = match args["mode"].as_str().unwrap_or("warn") {
            "block" => crate::sentinel::ZoneMode::Block,
            _ => crate::sentinel::ZoneMode::Warn,
        };

        let session_id = SessionManager::get_active_session()
            .map(|s| s.session_id)
            .unwrap_or_else(|| "unknown".to_string());

        let zone = crate::sentinel::SentinelManager::create_zone(&session_id, patterns, mode);
        json!({ "content": [{ "type": "text", "text": format!(
            "Zone '{}' created for session {}. Patterns: {:?}, Mode: {:?}",
            zone.zone_id, zone.session_id, zone.patterns, zone.mode
        ) }] })
    }

    fn tool_sentinel_release(args: Value) -> Value {
        let session_id = SessionManager::get_active_session()
            .map(|s| s.session_id)
            .unwrap_or_else(|| "unknown".to_string());

        if let Some(file_path) = args["file_path"].as_str() {
            crate::sentinel::SentinelManager::release_file_claims(&session_id, file_path);
            json!({ "content": [{ "type": "text", "text": format!(
                "Released claims for file '{}' in session {}.", file_path, session_id
            ) }] })
        } else {
            crate::sentinel::SentinelManager::release_claims(&session_id);
            json!({ "content": [{ "type": "text", "text": format!(
                "Released all claims for session {}.", session_id
            ) }] })
        }
    }

    /// Extract function names from a file using the semantic parser.
    /// Falls back to a single file-level claim if parsing fails.
    fn extract_function_names(file_path: &str) -> Vec<String> {
        let ext = Path::new(file_path)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("");

        if ext.is_empty() {
            return vec![format!("__file__{}", file_path)];
        }

        let source = match std::fs::read_to_string(file_path) {
            Ok(s) => s,
            Err(_) => return vec![format!("__file__{}", file_path)],
        };

        let mut parser = match crate::parser::SemanticParser::new() {
            Ok(p) => p,
            Err(_) => return vec![format!("__file__{}", file_path)],
        };
        match parser.parse_file(&source, ext) {
            Ok(nodes) => {
                let names: Vec<String> = nodes
                    .iter()
                    .filter_map(|n| n.identifier.clone())
                    .collect();
                if names.is_empty() {
                    vec![format!("__file__{}", file_path)]
                } else {
                    names
                }
            }
            Err(_) => vec![format!("__file__{}", file_path)],
        }
    }

    fn tool_sentinel_send(args: Value) -> Value {
        let message = match args["message"].as_str() {
            Some(m) => m,
            None => return json!({ "isError": true, "content": [{ "type": "text", "text": "message is required." }] }),
        };
        let to = args["to"].as_str();

        let session = SessionManager::get_active_session();
        let session_id = session.as_ref().map(|s| s.session_id.as_str()).unwrap_or("unknown");
        let agent_id = session.as_ref().map(|s| s.agent_id.as_str()).unwrap_or("unknown");

        // Cleanup old messages opportunistically
        crate::sentinel::SentinelManager::cleanup_old_messages();

        let msg = crate::sentinel::SentinelManager::send_message(session_id, agent_id, to, message);

        let target = match to {
            Some(t) => format!("session {}", t),
            None => "all active agents".to_string(),
        };
        json!({ "content": [{ "type": "text", "text": format!(
            "Message sent to {} (id: {}). Other agents will see it on their next tool call.",
            target, msg.id
        ) }] })
    }

    fn tool_sentinel_inbox(args: Value) -> Value {
        let limit = args["limit"].as_u64().unwrap_or(20) as usize;

        let session_id = SessionManager::get_active_session()
            .map(|s| s.session_id)
            .unwrap_or_else(|| "unknown".to_string());

        let messages = crate::sentinel::SentinelManager::read_messages(&session_id, limit);

        if messages.is_empty() {
            return json!({ "content": [{ "type": "text", "text": "No messages. You're the only one here (or nobody has written yet)." }] });
        }

        let mut output = format!("{} message(s):\n\n", messages.len());
        let mut newly_read_from = None; // track if there's a NEW incoming message needing reply
        for (msg, was_newly_read) in &messages {
            let is_incoming = msg.from_session != session_id;
            let direction = if !is_incoming {
                "YOU \u{2192}".to_string()
            } else {
                format!("{} ({}) \u{2192}", msg.from_agent, &msg.from_session[..msg.from_session.len().min(12)])
            };
            let target = match &msg.to_session {
                Some(t) if t == &session_id => "YOU (DM)".to_string(),
                Some(t) => format!("{} (DM)", &t[..t.len().min(12)]),
                None => "ALL".to_string(),
            };
            let new_tag = if *was_newly_read && is_incoming { " [NEW]" } else { "" };
            // Only prompt reply for messages seen for the first time
            if *was_newly_read && is_incoming {
                newly_read_from = Some(msg.from_session.clone());
            }
            output.push_str(&format!(
                "[{}]{} {} {} {}\n  {}\n\n",
                msg.id,
                new_tag,
                direction,
                target,
                format_age(msg.timestamp),
                msg.content
            ));
        }

        // Only prompt reply for NEWLY READ incoming messages (not old ones already seen)
        if let Some(ref reply_to) = newly_read_from {
            output.push_str(&format!(
                "\n\u{26a0}\u{fe0f} ACTION REQUIRED: Another agent just sent you a NEW message. Reply using `aura_sentinel_send` with to=\"{}\" to answer their question or acknowledge. They are waiting for your response.",
                reply_to
            ));
        }

        json!({ "content": [{ "type": "text", "text": output }] })
    }

    fn tool_sentinel_agents(_args: Value) -> Value {
        let agents = crate::sentinel::SentinelManager::list_agents();

        if agents.is_empty() {
            return json!({ "content": [{ "type": "text", "text": "No active agent sessions detected. Use `aura_snapshot` on a file to register your presence." }] });
        }

        let session_id = SessionManager::get_active_session()
            .map(|s| s.session_id)
            .unwrap_or_default();

        let mut output = format!("{} active agent session(s):\n\n", agents.len());
        for agent in &agents {
            let is_me = agent["session_id"].as_str() == Some(&session_id);
            let label = if is_me { " (YOU)" } else { "" };
            output.push_str(&format!(
                "  {} {}{}\n    PID: {} | Claims: {} | Files: {}\n    Session: {}\n\n",
                agent["agent_id"].as_str().unwrap_or("unknown"),
                label,
                "",
                agent["pid"].as_u64().unwrap_or(0),
                agent["claim_count"].as_u64().unwrap_or(0),
                agent["files"].as_array().map(|f| {
                    f.iter().filter_map(|v| v.as_str()).collect::<Vec<_>>().join(", ")
                }).unwrap_or_else(|| "none".to_string()),
                agent["session_id"].as_str().unwrap_or("unknown"),
            ));
        }

        output.push_str("To message an agent, use `aura_sentinel_send` with their session_id in the `to` field.");

        json!({ "content": [{ "type": "text", "text": output }] })
    }

    // ── Memory tools ──

    fn tool_memory_write(args: Value) -> Value {
        let section = match args["section"].as_str() {
            Some(s) => s,
            None => return json!({ "isError": true, "content": [{ "type": "text", "text": "section is required." }] }),
        };
        let content = match args["content"].as_str() {
            Some(c) => c,
            None => return json!({ "isError": true, "content": [{ "type": "text", "text": "content is required." }] }),
        };

        let agent = SessionManager::get_active_session()
            .map(|s| s.agent_id)
            .unwrap_or_else(|| "unknown".to_string());

        match section {
            "identity" => {
                let stack: Vec<String> = args["stack"].as_str()
                    .unwrap_or("")
                    .split(',')
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect();
                crate::memory::MemoryManager::set_identity(content, stack);
                json!({ "content": [{ "type": "text", "text": format!("Project identity set: {}", content) }] })
            }
            "architecture" => {
                // Parse JSON component or use content as description
                let comp = if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(content) {
                    crate::memory::ArchComponent {
                        name: parsed["name"].as_str().unwrap_or("unnamed").to_string(),
                        kind: parsed["kind"].as_str().unwrap_or("module").to_string(),
                        path: parsed["path"].as_str().map(|s| s.to_string()),
                        description: parsed["description"].as_str().unwrap_or("").to_string(),
                        connects_to: parsed["connects_to"].as_array()
                            .map(|a| a.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect())
                            .unwrap_or_default(),
                    }
                } else {
                    // Plain text — use as description, generate name from first word
                    let name = content.split_whitespace().next().unwrap_or("component").to_string();
                    crate::memory::ArchComponent {
                        name,
                        kind: "module".to_string(),
                        path: None,
                        description: content.to_string(),
                        connects_to: Vec::new(),
                    }
                };
                let name = comp.name.clone();
                crate::memory::MemoryManager::add_component(comp);
                json!({ "content": [{ "type": "text", "text": format!("Architecture component '{}' added to project memory.", name) }] })
            }
            "timeline" => {
                let entry = if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(content) {
                    crate::memory::TimelineEntry {
                        date: parsed["date"].as_str().unwrap_or("unknown").to_string(),
                        title: parsed["title"].as_str().unwrap_or("").to_string(),
                        description: parsed["description"].as_str().unwrap_or("").to_string(),
                        category: parsed["category"].as_str().unwrap_or("decision").to_string(),
                        author: Some(agent),
                    }
                } else {
                    crate::memory::TimelineEntry {
                        date: "unknown".to_string(),
                        title: content.to_string(),
                        description: String::new(),
                        category: "decision".to_string(),
                        author: Some(agent),
                    }
                };
                let title = entry.title.clone();
                crate::memory::MemoryManager::add_timeline(entry);
                json!({ "content": [{ "type": "text", "text": format!("Timeline entry '{}' added to project memory.", title) }] })
            }
            _ => {
                let tags: Vec<String> = args["tags"].as_str()
                    .unwrap_or("")
                    .split(',')
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect();
                let id = crate::memory::MemoryManager::add_entry(section, content, tags, &agent);
                json!({ "content": [{ "type": "text", "text": format!("Memory '{}' added to '{}' section.", id, section) }] })
            }
        }
    }

    fn tool_memory_read(args: Value) -> Value {
        if let Some(query) = args["query"].as_str() {
            let results = crate::memory::MemoryManager::search(query);
            if results.is_empty() {
                return json!({ "content": [{ "type": "text", "text": format!("No memories matching '{}'.", query) }] });
            }
            let data = serde_json::json!({ "query": query, "results": results });
            let toon_text = crate::toon::encode(&data);
            json!({ "content": [{ "type": "text", "text": toon_text }] })
        } else {
            let full = crate::memory::MemoryManager::full_view();
            let toon_text = crate::toon::encode(&full);
            json!({ "content": [{ "type": "text", "text": toon_text }] })
        }
    }

    fn tool_memory_forget(args: Value) -> Value {
        let id = match args["id"].as_str() {
            Some(i) => i,
            None => return json!({ "isError": true, "content": [{ "type": "text", "text": "id is required." }] }),
        };

        if crate::memory::MemoryManager::forget(id) {
            json!({ "content": [{ "type": "text", "text": format!("Memory '{}' removed.", id) }] })
        } else {
            json!({ "content": [{ "type": "text", "text": format!("Memory '{}' not found.", id) }] })
        }
    }

    fn tool_memory_compact(args: Value) -> Value {
        let section = match args["section"].as_str() {
            Some(s) => s,
            None => return json!({ "isError": true, "content": [{ "type": "text", "text": "section is required." }] }),
        };

        match crate::memory::MemoryManager::compact_section(section) {
            Ok(0) => json!({ "content": [{ "type": "text", "text": format!("Section '{}' has fewer than 10 entries — no compaction needed.", section) }] }),
            Ok(n) => {
                let size = crate::memory::MemoryManager::file_size();
                json!({ "content": [{ "type": "text", "text": format!(
                    "Compacted '{}': removed {} redundant entries. Memory file now {}KB.",
                    section, n, size / 1024
                ) }] })
            }
            Err(e) => json!({ "isError": true, "content": [{ "type": "text", "text": format!("Compaction failed: {}", e) }] }),
        }
    }
}

fn format_age(timestamp: u64) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let age = now.saturating_sub(timestamp);
    if age < 60 {
        format!("{}s ago", age)
    } else if age < 3600 {
        format!("{}m ago", age / 60)
    } else {
        format!("{}h ago", age / 3600)
    }
}
