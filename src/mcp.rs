use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{self, BufRead, Write};
use crate::checkpoint::{CheckpointStore, SnapshotStore};
use crate::session::SessionManager;
use git2::Repository;
use std::path::Path;
use std::sync::Mutex;

/// The connecting client's canonical agent id, captured from the MCP
/// `initialize` handshake's `clientInfo.name`. The server is always driven by
/// a real CLI agent (Claude Code, Gemini CLI, Codex, Cursor…); historically we
/// stamped a generic "MCP Agent" on every logged intent, which made the Trace
/// UI unable to tell who actually did the work. We capture the client once and
/// attribute every subsequent intent/session to it.
static MCP_CLIENT_AGENT: Mutex<Option<String>> = Mutex::new(None);

/// Canonicalize an MCP client name (clientInfo.name, or the AURA_AGENT env
/// override) into one of Aura's known agent ids. An unrecognised-but-real
/// client keeps its reported name rather than being discarded; an empty name
/// yields None so the caller can fall back to the historical label.
fn canonical_agent_from_client(name: &str) -> Option<String> {
    let s = name.trim().to_lowercase();
    if s.is_empty() {
        return None;
    }
    if s.contains("claude") {
        return Some("claude".to_string());
    }
    if s.contains("gemini") || s.contains("google") {
        return Some("gemini".to_string());
    }
    if s.contains("cursor") {
        return Some("cursor".to_string());
    }
    if s.contains("codex") || s.contains("openai") || s.contains("gpt") {
        return Some("codex".to_string());
    }
    Some(name.trim().to_string())
}

/// The agent id to stamp on intents/sessions for the current MCP client.
/// Prefers the clientInfo captured at `initialize`, then an `AURA_AGENT` env
/// override, and falls back to the historical "MCP Agent" label only when the
/// client never identified itself.
fn caller_agent_id() -> String {
    if let Ok(guard) = MCP_CLIENT_AGENT.lock() {
        if let Some(a) = guard.as_ref() {
            if !a.is_empty() {
                return a.clone();
            }
        }
    }
    if let Ok(env) = std::env::var("AURA_AGENT") {
        if let Some(a) = canonical_agent_from_client(&env) {
            return a;
        }
    }
    "MCP Agent".to_string()
}

/// Basic JSON-RPC 2.0 structures for the Model Context Protocol (MCP)
#[derive(Deserialize, Debug)]
#[allow(dead_code)]
struct RpcRequest {
    jsonrpc: String,
    #[serde(default)]
    id: Option<Value>,
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
                // JSON-RPC notifications (no id) must not receive a response.
                if req.id.is_none() {
                    continue;
                }
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
                // Malformed / unparseable input — log and move on. We cannot
                // reply with a parse error lacking an id because some clients
                // (e.g. Claude Code's Zod schema) reject id:null responses.
                eprintln!("MCP: dropping unparseable line");
            }
        }
    }

    fn handle_request(req: RpcRequest) -> Value {
        // Capture the connecting client's identity from the initialize
        // handshake so every intent/session we log downstream is attributed to
        // the real coding agent instead of a generic "MCP Agent".
        if req.method == "initialize" {
            if let Some(params) = req.params.as_ref() {
                let name = params["clientInfo"]["name"].as_str().unwrap_or("");
                if let Some(agent) = canonical_agent_from_client(name) {
                    if let Ok(mut guard) = MCP_CLIENT_AGENT.lock() {
                        *guard = Some(agent);
                    }
                }
            }
        }
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
                                },
                                "annotations": {
                                    "title": "Read Semantic History",
                                    "readOnlyHint": true,
                                    "destructiveHint": false,
                                    "idempotentHint": true,
                                    "openWorldHint": false,
                                    "auraCapability": "auto"
                                }
                            },
                            {
                                "name": "aura_log_intent",
                                "description": "MANDATORY: You MUST call this tool after making code changes and BEFORE committing. Logs your architectural intent so Aura can link your reasoning to the AST changes. If you skip this, the pre-commit hook will detect 'Intent Poisoning' and may block the commit. Call this every time you finish a set of edits. Pass `writes` with the files you touched so Aura can verify at commit that you did exactly what you said — anything you touch beyond that list is flagged (and blocked in strict mode). Optionally pass `intent_type` to tag the entry — one of FeatureAdd, BugFix, Refactor, Revert, Performance, Docs, Deps. Tagged entries are queryable via aura_intent_query.",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {
                                        "intent": { "type": "string", "description": "1-2 sentence explanation of WHY you made these changes. Must reference the functions/classes you modified." },
                                        "writes": { "type": "array", "items": { "type": "string" }, "description": "The repo-relative paths this change touches (the files you edited/created). Aura records them as your declared scope and, at commit, flags any file you changed that isn't listed here — the 'did exactly what I said' check. List the files honestly; leave empty only if you truly can't scope the change." },
                                        "intent_type": { "type": "string", "description": "Optional canonical type for this intent. One of: FeatureAdd, BugFix, Refactor, Revert, Performance, Docs, Deps. Case-sensitive. Invalid values are rejected with isError." }
                                    },
                                    "required": ["intent"]
                                },
                                "annotations": {
                                    "title": "Log Architectural Intent",
                                    "readOnlyHint": false,
                                    "destructiveHint": false,
                                    "idempotentHint": false,
                                    "openWorldHint": true,
                                    "auraCapability": "gate"
                                }
                            },
                            {
                                "name": "aura_intent_query",
                                "description": "Query the local intent log (.aura/intent_log.jsonl) by canonical type and/or time window. Returns {since_hours, total_matches, returned, intent_type, entries[]}. Each entry carries timestamp, agent_id, intent text, intent_type (when set), and signed_block_id (when present). Use to answer 'show me all Refactor intents in the last 7 days' or 'how many BugFix intents this week'. Reads only the local file — air-gapped. Pair with aura_log_intent's intent_type arg to make new entries queryable.",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {
                                        "intent_type": { "type": "string", "description": "Filter by canonical type. One of: FeatureAdd, BugFix, Refactor, Revert, Performance, Docs, Deps. Omit for all types." },
                                        "since_hours": { "type": "integer", "description": "Lookback window in hours. Default 168 (7 days). Set 0 to disable the cutoff." },
                                        "limit": { "type": "integer", "description": "Max entries in the response slice (newest first). Default 50, capped at 500. The total_matches field reports the unbounded count." }
                                    }
                                },
                                "annotations": {
                                    "title": "Query Typed Intents",
                                    "readOnlyHint": true,
                                    "destructiveHint": false,
                                    "idempotentHint": true,
                                    "openWorldHint": false,
                                    "auraCapability": "auto"
                                }
                            },
                            {
                                "name": "aura_intent_summary",
                                "description": "Bucket recent typed intents from .aura/intent_log.jsonl into a structured envelope (typed_total, untyped, type_count, buckets[] each with intent_type/count/samples). Mirrors `aura intents summary --json` and the prose form embedded in handover XML — same source-of-truth helper, different rendering. Use when an agent needs the histogram (e.g. 'how many BugFix vs Refactor this week') without scraping prose. Empty case returns status=empty with zero counters so the schema is stable.",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {
                                        "since_hours": { "type": "integer", "description": "Lookback window in hours. Default 24 (matches handover XML)." },
                                        "sample_per_type": { "type": "integer", "description": "Newest sample intents to include per bucket. Default 1, set 0 for counts-only." }
                                    }
                                },
                                "annotations": {
                                    "title": "Typed Intent Summary",
                                    "readOnlyHint": true,
                                    "destructiveHint": false,
                                    "idempotentHint": true,
                                    "openWorldHint": false,
                                    "auraCapability": "auto"
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
                                },
                                "annotations": {
                                    "title": "Semantic PR Review",
                                    "readOnlyHint": true,
                                    "destructiveHint": false,
                                    "idempotentHint": true,
                                    "openWorldHint": true,
                                    "auraCapability": "auto"
                                }
                            },
                            {
                                "name": "aura_status",
                                "description": "Check the current semantic status of the repository, including active checkpoints, logic nodes tracked, and other active AI agent sessions (Sentinel). Call this at the start of every session.",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {}
                                },
                                "annotations": {
                                    "title": "Aura Status",
                                    "readOnlyHint": true,
                                    "destructiveHint": false,
                                    "idempotentHint": true,
                                    "openWorldHint": true,
                                    "auraCapability": "auto"
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
                                },
                                "annotations": {
                                    "title": "Snapshot File",
                                    "readOnlyHint": false,
                                    "destructiveHint": false,
                                    "idempotentHint": true,
                                    "openWorldHint": false,
                                    "auraCapability": "auto"
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
                                },
                                "annotations": {
                                    "title": "List Snapshots",
                                    "readOnlyHint": true,
                                    "destructiveHint": false,
                                    "idempotentHint": true,
                                    "openWorldHint": false,
                                    "auraCapability": "auto"
                                }
                            },
                            {
                                "name": "aura_attest_list",
                                "description": "List signed intent blocks under .aura/blocks/ as a JSON array. Each row carries id, kind, created_at, signature flag, rekor flag, human_id (DID form, when the block was signed with a dual-identity binding), and intent_type (when stamped at sign time per S2-TIB). Optional `human` arg filters to blocks signed for a specific identity (raw env value or DID form). Optional `intent_type` arg filters to one canonical type (FeatureAdd / BugFix / Refactor / Revert / Performance / Docs / Deps); untyped blocks are excluded when the filter is present. Pair with aura_attest_verify to enumerate-then-verify from a downstream agent without shelling out.",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {
                                        "human": { "type": "string", "description": "Filter to blocks signed for this human (raw env value e.g. 'ashiq@naridon' OR DID form e.g. 'did:aura:human/ashiq-naridon')." },
                                        "intent_type": { "type": "string", "description": "Filter to one canonical type. Invalid values rejected with isError." }
                                    }
                                },
                                "annotations": {
                                    "title": "List Signed Intent Blocks",
                                    "readOnlyHint": true,
                                    "destructiveHint": false,
                                    "idempotentHint": true,
                                    "openWorldHint": false,
                                    "auraCapability": "auto"
                                }
                            },
                            {
                                "name": "aura_attest_verify",
                                "description": "Verify a signed intent block by id. Checks the ed25519 signature against the local key; when the block was signed by a key that has since been rotated out, walks the on-disk rotation chain to recover the historical pubkey, and (if the local chain is incomplete) auto-pulls the cloud rotation mirror once and retries. When the block carries a Rekor stamp, re-fetches the transparency-log entry to detect drift. Returns structured fields (signature_verified, key_id, human_id when present, recovered_via_chain.{hops,hop_count,auto_pulled_from_cloud}, rekor.status) so an agent can branch on the result.",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {
                                        "block_id": { "type": "string", "description": "UUID of the signed block under .aura/blocks/." },
                                        "no_rekor": { "type": "boolean", "description": "Skip the Rekor inclusion check even if the block carries a stamp. Default false." }
                                    },
                                    "required": ["block_id"]
                                },
                                "annotations": {
                                    "title": "Verify Signed Intent Block",
                                    "readOnlyHint": true,
                                    "destructiveHint": false,
                                    "idempotentHint": true,
                                    "openWorldHint": true,
                                    "auraCapability": "auto"
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
                                },
                                "annotations": {
                                    "title": "Generate Handover Payload",
                                    "readOnlyHint": true,
                                    "destructiveHint": false,
                                    "idempotentHint": true,
                                    "openWorldHint": false,
                                    "auraCapability": "auto"
                                }
                            },
                            {
                                "name": "aura_ask",
                                "description": "Ask a natural-language question about the codebase. Answers are synthesized from the rationale graph (per-function WHY explanations) and returned with citations to AST nodes. Use for: 'why does X do Y', 'what handles Z', 'who changed function F recently'.",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {
                                        "question": { "type": "string", "description": "Natural-language question about the codebase." }
                                    },
                                    "required": ["question"]
                                },
                                "annotations": {
                                    "title": "Ask Codebase",
                                    "readOnlyHint": true,
                                    "destructiveHint": false,
                                    "idempotentHint": true,
                                    "openWorldHint": true,
                                    "auraCapability": "auto"
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
                                },
                                "annotations": {
                                    "title": "Prove Behavioral Goal",
                                    "readOnlyHint": true,
                                    "destructiveHint": false,
                                    "idempotentHint": true,
                                    "openWorldHint": false,
                                    "auraCapability": "auto"
                                }
                            },
                            {
                                "name": "aura_goals_prove",
                                "description": "Prove a goal against the code through the DURABLE goal ledger (.aura/goals.jsonl): break the goal into checkable parts ONCE (cached), check them against the latest code at the AST level, and record a lasting, commit-stamped run. Unlike aura_prove (a transient check), this remembers the result, ties it to a board task, and feeds the Goals surface — use it to keep your work provably aligned to its goal. Returns each part in plain language with the file:line where it lives.",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {
                                        "goal": { "type": "string", "description": "What you're building, in plain words (e.g., 'User can sign in via Google')." },
                                        "task": { "type": "string", "description": "Optional board task to tie this goal to (e.g., 'AURA-42'), so the verdict surfaces on that task." }
                                    },
                                    "required": ["goal"]
                                },
                                "annotations": {
                                    "title": "Prove Goal (durable)",
                                    "readOnlyHint": false,
                                    "destructiveHint": false,
                                    "idempotentHint": false,
                                    "openWorldHint": false,
                                    "auraCapability": "auto"
                                }
                            },
                            {
                                "name": "aura_goals_list",
                                "description": "List every tracked goal from the durable ledger (.aura/goals.jsonl) with whether the code backs it up: built and checked / almost there / not started yet, plus the linked board task. Read this to see how the work maps to its goals before proving or building.",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {},
                                    "required": []
                                },
                                "annotations": {
                                    "title": "List Goals",
                                    "readOnlyHint": true,
                                    "destructiveHint": false,
                                    "idempotentHint": true,
                                    "openWorldHint": false,
                                    "auraCapability": "auto"
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
                                },
                                "annotations": {
                                    "title": "Rewind Function",
                                    "readOnlyHint": false,
                                    "destructiveHint": true,
                                    "idempotentHint": false,
                                    "openWorldHint": false,
                                    "auraCapability": "gate"
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
                                },
                                "annotations": {
                                    "title": "Discover Plan",
                                    "readOnlyHint": false,
                                    "destructiveHint": false,
                                    "idempotentHint": false,
                                    "openWorldHint": true,
                                    "auraCapability": "auto"
                                }
                            },
                            {
                                "name": "aura_plan_lock",
                                "description": "Lock the current active plan after reviewing gray areas. Once locked, the plan becomes executable via aura_plan_next.",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {}
                                },
                                "annotations": {
                                    "title": "Lock Plan",
                                    "readOnlyHint": false,
                                    "destructiveHint": false,
                                    "idempotentHint": true,
                                    "openWorldHint": false,
                                    "auraCapability": "gate"
                                }
                            },
                            {
                                "name": "aura_plan_next",
                                "description": "Execute the next wave in the currently locked plan. Each wave is an atomic unit of work. Returns the wave's tasks and constraints.",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {}
                                },
                                "annotations": {
                                    "title": "Next Plan Wave",
                                    "readOnlyHint": false,
                                    "destructiveHint": false,
                                    "idempotentHint": false,
                                    "openWorldHint": false,
                                    "auraCapability": "gate"
                                }
                            },
                            {
                                "name": "aura_orchestrate_status",
                                "description": "Check the status of multi-agent orchestration sessions. Shows active Duo Mode sessions (Claude + Gemini parallel execution), their progress, and any conflicts detected.",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {}
                                },
                                "annotations": {
                                    "title": "Orchestrate Status",
                                    "readOnlyHint": true,
                                    "destructiveHint": false,
                                    "idempotentHint": true,
                                    "openWorldHint": true,
                                    "auraCapability": "auto"
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
                                },
                                "annotations": {
                                    "title": "Gemini Skim",
                                    "readOnlyHint": true,
                                    "destructiveHint": false,
                                    "idempotentHint": true,
                                    "openWorldHint": true,
                                    "auraCapability": "auto"
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
                                },
                                "annotations": {
                                    "title": "Gemini Read",
                                    "readOnlyHint": true,
                                    "destructiveHint": false,
                                    "idempotentHint": true,
                                    "openWorldHint": true,
                                    "auraCapability": "auto"
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
                                },
                                "annotations": {
                                    "title": "Gemini Batch",
                                    "readOnlyHint": true,
                                    "destructiveHint": false,
                                    "idempotentHint": true,
                                    "openWorldHint": true,
                                    "auraCapability": "auto"
                                }
                            },
                            {
                                "name": "aura_context_budget",
                                "description": "Check the current token/context budget usage for the active session. Shows how many files are tracked, estimated token count, and recommendations for context optimization (e.g., when to run aura_handover).",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {}
                                },
                                "annotations": {
                                    "title": "Context Budget",
                                    "readOnlyHint": true,
                                    "destructiveHint": false,
                                    "idempotentHint": true,
                                    "openWorldHint": false,
                                    "auraCapability": "auto"
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
                                },
                                "annotations": {
                                    "title": "Usage & Cost",
                                    "readOnlyHint": true,
                                    "destructiveHint": false,
                                    "idempotentHint": true,
                                    "openWorldHint": true,
                                    "auraCapability": "auto"
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
                                },
                                "annotations": {
                                    "title": "Suggest Edit",
                                    "readOnlyHint": true,
                                    "destructiveHint": false,
                                    "idempotentHint": false,
                                    "openWorldHint": true,
                                    "auraCapability": "auto"
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
                                },
                                "annotations": {
                                    "title": "Resume Session",
                                    "readOnlyHint": true,
                                    "destructiveHint": false,
                                    "idempotentHint": true,
                                    "openWorldHint": false,
                                    "auraCapability": "auto"
                                }
                            },
                            {
                                "name": "aura_doctor",
                                "description": "Diagnose repository health: find stuck sessions, orphaned snapshots, missing hooks, and shadow branch issues. Returns a health report with actionable fixes.",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {}
                                },
                                "annotations": {
                                    "title": "Doctor Diagnostic",
                                    "readOnlyHint": true,
                                    "destructiveHint": false,
                                    "idempotentHint": true,
                                    "openWorldHint": false,
                                    "auraCapability": "auto"
                                }
                            },
                            {
                                "name": "aura_subagent_monitor",
                                "description": "Bucket O — Tail the most recent stdout/stderr lines from a Manager subagent's PTY. Returns up to `tail` lines (default 200) plus the running line count. Call when a fan-out has been Running >2 minutes and you want to know whether it's progressing or stuck. Don't poll faster than every 30s. Use BEFORE deciding to kill or wait.",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {
                                        "session_id": { "type": "string", "description": "Manager session id (the one shown in the chat URL)." },
                                        "task_id": { "type": "integer", "description": "Task id within the session (the # shown on the DAG TaskCard)." },
                                        "tail": { "type": "integer", "description": "Max lines to return (newest last). Default 200." }
                                    },
                                    "required": ["session_id", "task_id"]
                                },
                                "annotations": {
                                    "title": "Monitor Subagent",
                                    "readOnlyHint": true,
                                    "destructiveHint": false,
                                    "idempotentHint": true,
                                    "openWorldHint": false,
                                    "auraCapability": "auto"
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
                                },
                                "annotations": {
                                    "title": "Summarize Session",
                                    "readOnlyHint": true,
                                    "destructiveHint": false,
                                    "idempotentHint": true,
                                    "openWorldHint": true,
                                    "auraCapability": "auto"
                                }
                            },
                            {
                                "name": "aura_live_impacts",
                                "description": "Fetch unresolved cross-branch impact alerts from Aura Cloud. Shows functions on other branches that were modified or deleted while your code depends on them. Call at session start and periodically during long sessions.",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {}
                                },
                                "annotations": {
                                    "title": "Live Impacts",
                                    "readOnlyHint": true,
                                    "destructiveHint": false,
                                    "idempotentHint": true,
                                    "openWorldHint": true,
                                    "auraCapability": "auto"
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
                                },
                                "annotations": {
                                    "title": "Resolve Impact Alert",
                                    "readOnlyHint": false,
                                    "destructiveHint": false,
                                    "idempotentHint": true,
                                    "openWorldHint": true,
                                    "auraCapability": "gate"
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
                                },
                                "annotations": {
                                    "title": "Send Team Message",
                                    "readOnlyHint": false,
                                    "destructiveHint": false,
                                    "idempotentHint": false,
                                    "openWorldHint": true,
                                    "auraCapability": "gate"
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
                                },
                                "annotations": {
                                    "title": "List Team Messages",
                                    "readOnlyHint": true,
                                    "destructiveHint": false,
                                    "idempotentHint": true,
                                    "openWorldHint": true,
                                    "auraCapability": "auto"
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
                                },
                                "annotations": {
                                    "title": "Push Function Sync",
                                    "readOnlyHint": false,
                                    "destructiveHint": false,
                                    "idempotentHint": false,
                                    "openWorldHint": true,
                                    "auraCapability": "gate"
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
                                },
                                "annotations": {
                                    "title": "Pull Function Sync",
                                    "readOnlyHint": false,
                                    "destructiveHint": true,
                                    "idempotentHint": false,
                                    "openWorldHint": true,
                                    "auraCapability": "gate"
                                }
                            },
                            {
                                "name": "aura_live_sync_status",
                                "description": "Check function-level sync status: pending changes from teammates, total synced functions, and active pushers.",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {}
                                },
                                "annotations": {
                                    "title": "Sync Status",
                                    "readOnlyHint": true,
                                    "destructiveHint": false,
                                    "idempotentHint": true,
                                    "openWorldHint": true,
                                    "auraCapability": "auto"
                                }
                            },
                            {
                                "name": "aura_sentinel_status",
                                "description": "Check local multi-agent collision status. Shows which functions are claimed by which sessions, active collisions, and zone ownership. Use to see if another AI agent is working on the same code.",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {}
                                },
                                "annotations": {
                                    "title": "Sentinel Status",
                                    "readOnlyHint": true,
                                    "destructiveHint": false,
                                    "idempotentHint": true,
                                    "openWorldHint": false,
                                    "auraCapability": "auto"
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
                                },
                                "annotations": {
                                    "title": "Claim Zone",
                                    "readOnlyHint": false,
                                    "destructiveHint": false,
                                    "idempotentHint": true,
                                    "openWorldHint": true,
                                    "auraCapability": "gate"
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
                                },
                                "annotations": {
                                    "title": "Release Sentinel Claims",
                                    "readOnlyHint": false,
                                    "destructiveHint": false,
                                    "idempotentHint": true,
                                    "openWorldHint": false,
                                    "auraCapability": "auto"
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
                                },
                                "annotations": {
                                    "title": "Send Sentinel Message",
                                    "readOnlyHint": false,
                                    "destructiveHint": false,
                                    "idempotentHint": false,
                                    "openWorldHint": false,
                                    "auraCapability": "auto"
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
                                },
                                "annotations": {
                                    "title": "Sentinel Inbox",
                                    "readOnlyHint": false,
                                    "destructiveHint": false,
                                    "idempotentHint": false,
                                    "openWorldHint": false,
                                    "auraCapability": "auto"
                                }
                            },
                            {
                                "name": "aura_sentinel_agents",
                                "description": "IMPORTANT: You MUST call this tool whenever the user asks about other agents, other Claude sessions, or who else is working on this repo. Lists all active AI agent sessions (Claude, Copilot, Gemini, Cursor, etc.) with their PID, files being worked on, and session ID for messaging. Never guess — always check.",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {}
                                },
                                "annotations": {
                                    "title": "List Active Agents",
                                    "readOnlyHint": true,
                                    "destructiveHint": false,
                                    "idempotentHint": true,
                                    "openWorldHint": false,
                                    "auraCapability": "auto"
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
                                        "stack": { "type": "string", "description": "Optional: comma-separated tech stack (only for 'identity' section)." },
                                        "symbol": { "type": "string", "description": "Optional code anchor for entry sections (convention/gotcha/context/active_work): '<repo-relative-path>#<identifier>', e.g. 'src/auth.rs#verify_token'. The symbol's current text is fingerprinted; future reads flag this memory stale when that code changes or disappears. Pass it whenever the fact is ABOUT a specific function/class." }
                                    },
                                    "required": ["section", "content"]
                                },
                                "annotations": {
                                    "title": "Write Memory",
                                    "readOnlyHint": false,
                                    "destructiveHint": false,
                                    "idempotentHint": false,
                                    "openWorldHint": false,
                                    "auraCapability": "gate"
                                }
                            },
                            {
                                "name": "aura_memory_read",
                                "description": "Read the project's permanent memory — architecture, decisions, conventions, gotchas, and context accumulated across all past sessions. Call this when starting work on an unfamiliar area, or when you need to understand why something was built a certain way. Use 'query' to search, or omit for the full project memory. Query results are RANKED (BM25 + embeddings + recency, RRF-fused; each carries score + matched legs) and provenance-bound entries are verified against the live code at read time: 'stale': true with a 'stale_reason' means the symbol the memory was learned from has changed or been removed since — re-verify before trusting it.",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {
                                        "query": { "type": "string", "description": "Optional: search keyword to filter memories. If omitted, returns the full project memory." }
                                    }
                                },
                                "annotations": {
                                    "title": "Read Memory",
                                    "readOnlyHint": true,
                                    "destructiveHint": false,
                                    "idempotentHint": true,
                                    "openWorldHint": false,
                                    "auraCapability": "auto"
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
                                },
                                "annotations": {
                                    "title": "Forget Memory Entry",
                                    "readOnlyHint": false,
                                    "destructiveHint": true,
                                    "idempotentHint": true,
                                    "openWorldHint": false,
                                    "auraCapability": "gate"
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
                                },
                                "annotations": {
                                    "title": "Compact Memory",
                                    "readOnlyHint": false,
                                    "destructiveHint": false,
                                    "idempotentHint": false,
                                    "openWorldHint": true,
                                    "auraCapability": "gate"
                                }
                            },
                            {
                                "name": "aura_taste_rules",
                                "description": "Return the project's learned taste rules — coding patterns Aura has distilled from accepted commits (named-vs-default exports, indent width, error-handling style, etc.). Call BEFORE editing a file so your output matches the codebase's existing taste. Optional file_path narrows the response to rules whose language/layer match. Phase 1 surface; rules are observation-derived (no LLM in the hot path) and updated on every commit.",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {
                                        "file_path": { "type": "string", "description": "Optional: a path you're about to edit. Filters to rules matching its language and layer." },
                                        "intent_type": { "type": "string", "description": "Optional: the kind of work (BugFix, Feature, Refactor, ...). Reserved for future scope-narrowing; ignored in Phase 1." },
                                        "limit": { "type": "integer", "description": "Max rules to return. Default 10." }
                                    }
                                },
                                "annotations": {
                                    "title": "Project Taste Rules",
                                    "readOnlyHint": true,
                                    "destructiveHint": false,
                                    "idempotentHint": true,
                                    "openWorldHint": false,
                                    "auraCapability": "auto"
                                }
                            },
                            {
                                "name": "aura_episodic_recall",
                                "description": "Recall recent episodic events — intent logs, agent-to-agent sentinel messages, and pre-edit snapshots — grouped by time window. Answers 'what happened here recently?' for swarm handover and resume workflows. Local-only preview of the Bet 1 cloud episodic store; the response shape is stable across the local→cloud migration.",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {
                                        "window_hours": { "type": "integer", "description": "Lookback window in hours. Default 168 (7 days)." },
                                        "focus_file": { "type": "string", "description": "Optional: filter events to those mentioning this file path or keyword." },
                                        "limit": { "type": "integer", "description": "Max events to return (most recent first). Default 25." }
                                    }
                                },
                                "annotations": {
                                    "title": "Recall Episodic Events",
                                    "readOnlyHint": true,
                                    "destructiveHint": false,
                                    "idempotentHint": true,
                                    "openWorldHint": false,
                                    "auraCapability": "auto"
                                }
                            },
                            {
                                "name": "aura_episodic_narrate",
                                "description": "Cloud-side compressed narration of an episodic-event window — one paragraph an agent can read instead of the raw rows. With an org LLM key configured the cloud calls a tier-shallow (default) or tier-deep model; without one it returns a deterministic 'Synthesized digest' fallback. Same filter shape as aura_episodic_recall. Use when context is tight and you only need the gist.",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {
                                        "window_hours": { "type": "integer", "description": "Lookback window in hours. Default 168 (7 days)." },
                                        "event_type": { "type": "string", "description": "Optional: only narrate events of this type (intent, sentinel, handover, …)." },
                                        "focus_file": { "type": "string", "description": "Optional: scope to events touching this file path." },
                                        "focus_fn": { "type": "string", "description": "Optional: scope to events touching this function name." },
                                        "repo": { "type": "string", "description": "Optional: scope to a single repo (github full_name)." },
                                        "tier": { "type": "string", "description": "'shallow' (cheap, default) or 'deep' (more capable). Ignored on the synthetic-fallback path." },
                                        "limit": { "type": "integer", "description": "Max events the narrator considers. Default 100." }
                                    }
                                },
                                "annotations": {
                                    "title": "Narrate Episodic Window",
                                    "readOnlyHint": true,
                                    "destructiveHint": false,
                                    "idempotentHint": true,
                                    "openWorldHint": true,
                                    "auraCapability": "auto"
                                }
                            },
                            {
                                "name": "aura_episodic_timeline",
                                "description": "Per-function materialized timeline view from cloud episodic events. For one function name returns: total_events, first/last seen, counts_by_type, by_day buckets, agents_seen, plus the events slice itself (newest first). Use BEFORE refactoring or removing a function to see who's been touching it and when. Single call replaces a recall+filter+group dance.",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {
                                        "function_name": { "type": "string", "description": "Function name to materialize a timeline for. Required." },
                                        "window_hours": { "type": "integer", "description": "Lookback window in hours. Default 168 (7 days)." },
                                        "repo": { "type": "string", "description": "Optional: scope to a single repo (github full_name)." },
                                        "limit": { "type": "integer", "description": "Max events in the response slice. Default 50, capped at 500. The total_events field reports the unbounded count." }
                                    },
                                    "required": ["function_name"]
                                },
                                "annotations": {
                                    "title": "Per-Function Episodic Timeline",
                                    "readOnlyHint": true,
                                    "destructiveHint": false,
                                    "idempotentHint": true,
                                    "openWorldHint": true,
                                    "auraCapability": "auto"
                                }
                            },
                            {
                                "name": "aura_episodic_agent_digest",
                                "description": "Per-agent materialized digest from cloud episodic events. For one agent_id returns: total_events, first/last seen, counts_by_type, by_day buckets, top_functions[] and top_files[] (count desc, name asc), plus the events slice itself (newest first). Use at session start to absorb what another agent has been doing without rereading the raw stream — the natural complement to aura_episodic_timeline (function-centric) and aura_episodic_recall (window query).",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {
                                        "agent_id": { "type": "string", "description": "Agent identifier to materialize a digest for. Required. Conventionally the producer's agent_id (e.g. 'claude', 'gemini', GitHub login, or a session id)." },
                                        "window_hours": { "type": "integer", "description": "Lookback window in hours. Default 168 (7 days)." },
                                        "repo": { "type": "string", "description": "Optional: scope to a single repo (github full_name)." },
                                        "limit": { "type": "integer", "description": "Max events in the response slice. Default 50, capped at 500. The total_events field reports the unbounded count." }
                                    },
                                    "required": ["agent_id"]
                                },
                                "annotations": {
                                    "title": "Per-Agent Episodic Digest",
                                    "readOnlyHint": true,
                                    "destructiveHint": false,
                                    "idempotentHint": true,
                                    "openWorldHint": true,
                                    "auraCapability": "auto"
                                }
                            },
                            {
                                "name": "aura_episodic_multi_session_arc",
                                "description": "Interleaved per-session arc across 2+ agent_ids. Computes the per-session arc for each agent (same shape as aura_episodic_session_arc) and merges the segments into a single timeline ordered by start_ts, with each merged segment carrying its source agent_id. Returns {agent_ids[], window_hours, gap_minutes, total_events, segment_count, per_agent_segment_counts[], counts_by_intent_type{} (typed-intent rollup across every agent's events; bucket sum = total_events; untyped events fall under \"untyped\"), segments[]}. Use to render a multi-agent activity timeline (e.g. claude vs gemini working concurrently) without stitching the per-agent responses client-side. Up to 16 agent_ids per call.",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {
                                        "agent_ids": { "type": "string", "description": "Comma-separated agent_ids. Up to 16, deduplicated, empty entries dropped." },
                                        "window_hours": { "type": "integer", "description": "Lookback window in hours. Default 168." },
                                        "gap_minutes": { "type": "integer", "description": "Inactivity gap that closes one segment and opens the next (per agent). Default 30." },
                                        "repo": { "type": "string", "description": "Optional: scope to a single repo (github full_name)." },
                                        "limit": { "type": "integer", "description": "Per-agent event cap. Default 500, max 1000." }
                                    },
                                    "required": ["agent_ids"]
                                },
                                "annotations": {
                                    "title": "Multi-Session Arc",
                                    "readOnlyHint": true,
                                    "destructiveHint": false,
                                    "idempotentHint": true,
                                    "openWorldHint": true,
                                    "auraCapability": "auto"
                                }
                            },
                            {
                                "name": "aura_episodic_session_arc",
                                "description": "Per-session arc materialized view from cloud episodic events. For one agent_id (which doubles as session_id) returns the events grouped into time-ordered segments separated by `gap_minutes` of inactivity. Each segment carries: index, start_ts, end_ts, duration_seconds, event_count, counts_by_type[] (count desc, name asc), counts_by_intent_type{} (per-segment typed-intent rollup; bucket sum = event_count; untyped under \"untyped\"), top_function, top_file, first_summary, last_summary. Top-level response also carries counts_by_intent_type{} aggregated across all segments (bucket sum = total_events). Use to render an arc visualization or to write a one-liner per work-burst without re-fetching events. Sibling to aura_episodic_agent_digest (top-N rankings, one row per agent) — same scoping, time-ordered output instead of collapsed.",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {
                                        "agent_id": { "type": "string", "description": "Agent identifier (or session id) to materialize an arc for. Required." },
                                        "window_hours": { "type": "integer", "description": "Lookback window in hours. Default 168 (7 days)." },
                                        "gap_minutes": { "type": "integer", "description": "Inactivity gap that closes one segment and opens the next. Default 30." },
                                        "repo": { "type": "string", "description": "Optional: scope to a single repo (github full_name)." },
                                        "limit": { "type": "integer", "description": "Cap on events the arc considers (newest-first). Default 500, max 1000." }
                                    },
                                    "required": ["agent_id"]
                                },
                                "annotations": {
                                    "title": "Per-Session Arc",
                                    "readOnlyHint": true,
                                    "destructiveHint": false,
                                    "idempotentHint": true,
                                    "openWorldHint": true,
                                    "auraCapability": "auto"
                                }
                            },
                            {
                                "name": "aura_episodic_recall_cloud",
                                "description": "Unified window query over cloud episodic events. Filter rows by any combination of agent_id, event_type, focus_fn, focus_file, repo, and a window_hours lookback. Returns {window_hours, total_events, returned, events[], counts_by_type, narration} — the same shape the cloud /recall route emits, with `narration` being a one-line deterministic digest. Sits between aura_episodic_timeline (function-only, day-bucketed) and aura_episodic_agent_digest (agent-only, top-N refs): use this when you want raw events with two or more axes narrowed at once. Cloud-backed sibling to aura_episodic_recall (which reads only the local .aura/* signals).",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {
                                        "window_hours": { "type": "integer", "description": "Lookback window in hours. Default 168 (7 days). Minimum 1." },
                                        "event_type": { "type": "string", "description": "Filter by event_type (e.g. 'intent', 'pr_review', 'suggest_edit')." },
                                        "agent_id": { "type": "string", "description": "Filter by agent_id (the producer's handle, e.g. 'claude-foo' or a session id)." },
                                        "focus_fn": { "type": "string", "description": "Filter by a function name in refs_fn (any event whose refs_fn array contains the value)." },
                                        "focus_file": { "type": "string", "description": "Filter by a file path in refs_file." },
                                        "repo": { "type": "string", "description": "Optional: scope to a single repo (github full_name)." },
                                        "intent_type": { "type": "string", "description": "S2-TICR: filter by canonical intent_type — one of FeatureAdd, BugFix, Refactor, Revert, Performance, Docs, Deps. Server returns 400 on a typo so a misspelled value never silently empties the result." },
                                        "limit": { "type": "integer", "description": "Max events in the response slice. Default 25, capped at 500. The total_events field reports the unbounded count." }
                                    }
                                },
                                "annotations": {
                                    "title": "Unified Episodic Recall",
                                    "readOnlyHint": true,
                                    "destructiveHint": false,
                                    "idempotentHint": true,
                                    "openWorldHint": true,
                                    "auraCapability": "auto"
                                }
                            },
                            {
                                "name": "aura_impacts_cross_repo",
                                "description": "Find every (repo, file_path) across the caller's org whose `function_bodies` row matches a given function name. Use BEFORE renaming or deleting a shared utility — answers 'do any sibling repos in this org have a function with the same name?'. Cross-repo, name-level (real symbol-graph caller resolution across repos is Phase D).",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {
                                        "function_name": { "type": "string", "description": "Function name to search for across the org." },
                                        "exclude_repo": { "type": "string", "description": "Optional: exclude this repo (typically your own) from results." },
                                        "branch": { "type": "string", "description": "Optional: scope to one branch name (e.g. 'main') across all repos." },
                                        "limit": { "type": "integer", "description": "Max matches to return. Default 100, capped at 500." }
                                    },
                                    "required": ["function_name"]
                                },
                                "annotations": {
                                    "title": "Cross-Repo Function Impact Lookup",
                                    "readOnlyHint": true,
                                    "destructiveHint": false,
                                    "idempotentHint": true,
                                    "openWorldHint": true,
                                    "auraCapability": "auto"
                                }
                            },
                            {
                                "name": "aura_pr_commit_review_generate",
                                "description": "Run the per-commit AI review pipeline over a list of commits in a PR. For each commit the cloud calls generate_ai_review (sharing the umbrella PR prompt + JSON schema), upserts the result into pr_commit_reviews, and returns the (id, risk_score, risk_label) tuple. On no-LLM-key the cloud falls back to a deterministic synthesized review (model_used='fallback::synthetic') so the row is still populated.",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {
                                        "repo": { "type": "string", "description": "GitHub full name, e.g. 'owner/name'." },
                                        "platform": { "type": "string", "description": "'github' or 'gitlab'." },
                                        "pr_number": { "type": "integer", "description": "PR / MR number." },
                                        "commits": {
                                            "type": "array",
                                            "description": "List of commits to review. Each item carries the sha, optional parent, intent_summary, and modified/deleted function lists.",
                                            "items": {
                                                "type": "object",
                                                "properties": {
                                                    "commit_sha": { "type": "string" },
                                                    "parent_sha": { "type": "string" },
                                                    "author_login": { "type": "string" },
                                                    "intent_summary": { "type": "string" },
                                                    "files_touched": { "type": "integer" },
                                                    "functions_modified": { "type": "array" },
                                                    "functions_deleted": { "type": "array" }
                                                },
                                                "required": ["commit_sha"]
                                            }
                                        }
                                    },
                                    "required": ["repo", "platform", "pr_number", "commits"]
                                },
                                "annotations": {
                                    "title": "Generate Per-Commit Reviews",
                                    "readOnlyHint": false,
                                    "destructiveHint": false,
                                    "idempotentHint": true,
                                    "openWorldHint": true,
                                    "auraCapability": "auto"
                                }
                            },
                            {
                                "name": "aura_a2a_task_create",
                                "description": "Create a long-running A2A v1.2 task in this org. Returns the task in 'submitted' state with a stable id the caller can poll via aura_a2a_task_get. Status follows A2A v1.2 §4: submitted | working | input-required | completed | failed | canceled | rejected | auth-required. Terminal states (completed/failed/canceled/rejected) are sticky. Use this for fire-and-poll work (cross-repo refactor, multi-step review) where message/send (one-shot) is not enough.",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {
                                        "agent_kind": { "type": "string", "description": "A2A actor kind, e.g. 'a2a:claude', 'a2a:cursor'. Mirrors sentinel_messages.from_agent_kind." },
                                        "input": { "type": "string", "description": "Task description / payload the worker will act on." },
                                        "repo": { "type": "string", "description": "Optional repo full-name (org/name) to scope the task." },
                                        "context_id": { "type": "string", "description": "Optional A2A context grouping (free-form)." },
                                        "task_kind": { "type": "string", "enum": ["plan", "wave", "task", "subtask"], "description": "Bucket-K hierarchy level. Defaults to 'subtask' (a leaf that needs no acceptance criteria) when omitted. plan/wave/task REQUIRE a non-empty acceptance_criteria." },
                                        "acceptance_criteria": { "type": "array", "items": { "type": "string" }, "description": "Concrete, checkable done-conditions. Required (non-empty) when task_kind is plan, wave, or task; optional for subtask." },
                                        "metadata": { "type": "object", "description": "Optional client-supplied metadata bag." }
                                    },
                                    "required": ["agent_kind", "input"]
                                },
                                "annotations": {
                                    "title": "Create A2A Task",
                                    "readOnlyHint": false,
                                    "destructiveHint": false,
                                    "idempotentHint": false,
                                    "openWorldHint": true,
                                    "auraCapability": "auto"
                                }
                            },
                            {
                                "name": "aura_a2a_task_get",
                                "description": "Read one A2A v1.2 task by id (org-scoped — wrong-org JWT returns 404). Returns the full Task object: agent_kind, input_text, input_metadata, status, result (once completed), error_message (on failed/rejected), created_at, updated_at.",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {
                                        "id": { "type": "string", "description": "Task UUID returned by aura_a2a_task_create." }
                                    },
                                    "required": ["id"]
                                },
                                "annotations": {
                                    "title": "Get A2A Task",
                                    "readOnlyHint": true,
                                    "destructiveHint": false,
                                    "idempotentHint": true,
                                    "openWorldHint": true,
                                    "auraCapability": "auto"
                                }
                            },
                            {
                                "name": "aura_memory_cloud_list",
                                "description": "List entries in the cloud project_memory store (kind/title/body), org-scoped, newest first. The local aura_memory_read and aura_memory_write tools operate on a per-machine memory file; this surface is the org-wide durable counterpart for cross-machine sharing. Useful for joining a session and learning what the team has decided.",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {
                                        "page": { "type": "integer", "description": "1-based page number. Default 1." },
                                        "limit": { "type": "integer", "description": "Max rows per page. Default 100, capped at 500." }
                                    }
                                },
                                "annotations": {
                                    "title": "List Cloud Memory",
                                    "readOnlyHint": true,
                                    "destructiveHint": false,
                                    "idempotentHint": true,
                                    "openWorldHint": true,
                                    "auraCapability": "auto"
                                }
                            },
                            {
                                "name": "aura_memory_cloud_push",
                                "description": "Insert a project_memory entry org-wide (kind defaults to 'project'). Use when you've learned something durable that the team should see — design decisions, conventions, gotchas. Repo scope is optional and resolves by github_full_name.",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {
                                        "body": { "type": "string", "description": "Memory body (Markdown). Required." },
                                        "title": { "type": "string", "description": "Optional short title for indexing." },
                                        "kind": { "type": "string", "description": "Optional kind tag, e.g. 'decision', 'convention', 'gotcha'. Defaults to 'project'." },
                                        "repo_full_name": { "type": "string", "description": "Optional GitHub full_name (org/name) to scope the entry to one repo." }
                                    },
                                    "required": ["body"]
                                },
                                "annotations": {
                                    "title": "Push Cloud Memory",
                                    "readOnlyHint": false,
                                    "destructiveHint": false,
                                    "idempotentHint": false,
                                    "openWorldHint": true,
                                    "auraCapability": "auto"
                                }
                            },
                            {
                                "name": "aura_handover_cloud_list",
                                "description": "List handovers stored in the cloud handover ledger (cross-machine pickup). Returns paginated rows with (id, session_id, agent_name, summary, token_count, created_at), newest first. Use this when joining a session another agent left mid-stream — the local `aura_handover` tool generates a payload, this lists what's already been pushed.",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {
                                        "page": { "type": "integer", "description": "1-based page number. Default 1." },
                                        "limit": { "type": "integer", "description": "Max rows per page. Default 50, capped at 200." }
                                    }
                                },
                                "annotations": {
                                    "title": "List Cloud Handovers",
                                    "readOnlyHint": true,
                                    "destructiveHint": false,
                                    "idempotentHint": true,
                                    "openWorldHint": true,
                                    "auraCapability": "auto"
                                }
                            },
                            {
                                "name": "aura_handover_cloud_push",
                                "description": "Push a handover record to the cloud handover ledger so another agent (on another machine, in another conversation) can discover and resume the work. The local `aura_handover` tool produces the payload; this tool persists a summary line so the receiving agent can find it.",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {
                                        "session_id": { "type": "string", "description": "Session identifier the receiving agent will resume against." },
                                        "agent_name": { "type": "string", "description": "Source agent name, e.g. 'claude', 'cursor', 'gemini'." },
                                        "summary": { "type": "string", "description": "One-paragraph human-readable summary of where the session was when the handover was generated." },
                                        "token_count": { "type": "integer", "description": "Optional: token count of the source session at handover time, for downstream sizing." }
                                    }
                                },
                                "annotations": {
                                    "title": "Push Cloud Handover",
                                    "readOnlyHint": false,
                                    "destructiveHint": false,
                                    "idempotentHint": false,
                                    "openWorldHint": true,
                                    "auraCapability": "auto"
                                }
                            },
                            {
                                "name": "aura_pr_commit_review_list",
                                "description": "List per-commit AI reviews for a PR. Returns the upserted rows in commit order with their (sha, parent_sha, ai_summary, risk_score, risk_label, model_used) — including any 'fallback::trivial-skip' fmt-only commits and 'fallback::synthetic' no-LLM-key entries. Top-level response also carries `counts_by_intent_type` — a histogram of canonical intent_type buckets across the FULL PR (untyped commits land under the 'untyped' key so the bucket sum equals total). Pass `intent_type` to filter the rows to a single canonical type (FeatureAdd | BugFix | Refactor | Revert | Performance | Docs | Deps); the histogram still reflects the unfiltered PR so dashboards can answer 'is this PR mostly Refactor or BugFix?'. Read after aura_pr_commit_review_generate (or after the cloud has ingested commit reviews from another path) to see the per-commit picture.",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {
                                        "repo": { "type": "string", "description": "GitHub full name, e.g. 'owner/name'." },
                                        "platform": { "type": "string", "description": "'github' or 'gitlab'." },
                                        "pr_number": { "type": "integer", "description": "PR / MR number." },
                                        "intent_type": { "type": "string", "description": "Optional canonical intent_type filter (FeatureAdd | BugFix | Refactor | Revert | Performance | Docs | Deps). A typo round-trips as an HTTP 400 isError so the caller doesn't mistake it for 'no matching commits'." }
                                    },
                                    "required": ["repo", "platform", "pr_number"]
                                },
                                "annotations": {
                                    "title": "List Per-Commit Reviews",
                                    "readOnlyHint": true,
                                    "destructiveHint": false,
                                    "idempotentHint": true,
                                    "openWorldHint": true,
                                    "auraCapability": "auto"
                                }
                            },
                            {
                                "name": "aura_pr_commit_review_get",
                                "description": "Read one per-commit AI review by (commit_sha + repo + platform + pr_number). The PR triplet is required because the same SHA can legitimately appear across forks/PRs in the org — cloud rejects without all three. Returns the full row with ai_summary, risk_score, risk_label, model_used, and the original commit metadata. 404 surfaces as an isError envelope so the caller can decide whether to trigger generate.",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {
                                        "commit_sha": { "type": "string", "description": "Full 40-char (or short) commit SHA." },
                                        "repo": { "type": "string", "description": "Github full_name (org/repo)." },
                                        "platform": { "type": "string", "description": "'github' or 'gitlab'." },
                                        "pr_number": { "type": "integer", "description": "PR number for this commit." }
                                    },
                                    "required": ["commit_sha", "repo", "platform", "pr_number"]
                                },
                                "annotations": {
                                    "title": "Get Per-Commit Review",
                                    "readOnlyHint": true,
                                    "destructiveHint": false,
                                    "idempotentHint": true,
                                    "openWorldHint": true,
                                    "auraCapability": "auto"
                                }
                            },
                            {
                                "name": "aura_a2a_task_list",
                                "description": "List A2A v1.2 tasks in this org, newest first. Filter by status (submitted | working | input-required | completed | failed | canceled | rejected | auth-required) or by repo full-name. Use this to discover tasks the worker should pick up next ('what's submitted to a2a:claude that I can work on?').",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {
                                        "status": { "type": "string", "description": "Optional A2A v1.2 status filter (lowercase canonical form)." },
                                        "repo": { "type": "string", "description": "Optional repo full-name (org/name)." },
                                        "limit": { "type": "integer", "description": "Max tasks to return. Default 50, server-side cap applies." }
                                    }
                                },
                                "annotations": {
                                    "title": "List A2A Tasks",
                                    "readOnlyHint": true,
                                    "destructiveHint": false,
                                    "idempotentHint": true,
                                    "openWorldHint": true,
                                    "auraCapability": "auto"
                                }
                            },
                            {
                                "name": "aura_a2a_task_patch",
                                "description": "Update an A2A v1.2 task's status, result, or error_message. Standard transitions: submitted→working→completed (with result) or submitted→working→failed (with error_message). Terminal states (completed/failed/canceled/rejected) are sticky — once set the cloud rejects further patches with HTTP 409. Use this from a worker agent after picking a task off the list to mark it 'working' and eventually 'completed' with the output payload.",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {
                                        "id": { "type": "string", "description": "Task UUID returned by aura_a2a_task_create or aura_a2a_task_list." },
                                        "status": { "type": "string", "description": "New A2A v1.2 status (lowercase canonical form). Optional if you're only attaching a result." },
                                        "result": { "type": "object", "description": "Optional output payload to attach (typically set when transitioning to 'completed')." },
                                        "error_message": { "type": "string", "description": "Optional human-readable error (typically set when transitioning to 'failed' or 'rejected')." }
                                    },
                                    "required": ["id"]
                                },
                                "annotations": {
                                    "title": "Patch A2A Task",
                                    "readOnlyHint": false,
                                    "destructiveHint": false,
                                    "idempotentHint": false,
                                    "openWorldHint": true,
                                    "auraCapability": "auto"
                                }
                            },
                            {
                                "name": "aura_loop_plan_context",
                                "description": "Read the autonomous work-loop's ORDERLESS pile — the .aura/a2a graph nodes that currently sit in no dependency order — bucketed into focused chunks along the seams already in the data (epic → sprint → batch), so a huge board (hundreds of tasks) can be planned in FULL, not skimmed. Returns per chunk: a label, an optional seed_goal (the epic/sprint name), and the tasks as {id,title,detail}; plus how_to_apply. Use this when the user asks to 'plan an order' or organise a big task board: pull this, reason the real dependencies inside each chunk, name the goal each connected group adds up to, group goals under a few larger objectives, then write it back with aura_loop_plan_apply. This is the SAME chunking Aura's desktop 'plan an order' uses — here YOU are the planner.",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {}
                                },
                                "annotations": {
                                    "title": "Read Loop Plan Context",
                                    "readOnlyHint": true,
                                    "destructiveHint": false,
                                    "idempotentHint": true,
                                    "openWorldHint": false,
                                    "auraCapability": "auto"
                                }
                            },
                            {
                                "name": "aura_loop_plan_apply",
                                "description": "Write a planned order back onto the work-loop graph (.aura/a2a): wire dependency edges (cycle-checked — self-edges, unknown ids, and cycles are refused and counted, never fabricated), name the goal each connected group of tasks adds up to (stamps a goal: tag the canvas draws a region from), and roll those goals up under larger objectives (stamps an objective: tag). Call after aura_loop_plan_context. These edges drive the loop's ready-set and the Crew board flow — identical to the graph the desktop 'plan an order' button builds. Returns a count of what was wired/named/skipped.",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {
                                        "edges": {
                                            "type": "array",
                                            "description": "Dependency edges. Add one ONLY where a task genuinely needs another's output.",
                                            "items": {
                                                "type": "object",
                                                "properties": {
                                                    "task": { "type": "string", "description": "Task id that must WAIT." },
                                                    "depends_on": { "type": "string", "description": "Task id that must finish FIRST." }
                                                },
                                                "required": ["task", "depends_on"]
                                            }
                                        },
                                        "goals": {
                                            "type": "array",
                                            "description": "Named goals. Each connected group of tasks adds up to one goal.",
                                            "items": {
                                                "type": "object",
                                                "properties": {
                                                    "goal": { "type": "string", "description": "Short outcome phrase." },
                                                    "tasks": { "type": "array", "items": { "type": "string" }, "description": "Task ids that make up this goal." }
                                                },
                                                "required": ["goal", "tasks"]
                                            }
                                        },
                                        "objectives": {
                                            "type": "array",
                                            "description": "Larger objectives the goals roll up to (2–6 for most projects).",
                                            "items": {
                                                "type": "object",
                                                "properties": {
                                                    "objective": { "type": "string", "description": "Short outcome phrase." },
                                                    "goals": { "type": "array", "items": { "type": "string" }, "description": "Goal NAMES (from `goals` above) under this objective." }
                                                },
                                                "required": ["objective", "goals"]
                                            }
                                        }
                                    }
                                },
                                "annotations": {
                                    "title": "Apply Loop Plan",
                                    "readOnlyHint": false,
                                    "destructiveHint": false,
                                    "idempotentHint": false,
                                    "openWorldHint": false,
                                    "auraCapability": "auto"
                                }
                            },
                            {
                                "name": "aura_crew_plan",
                                "description": "PREFER THIS over Beads/bd or any external issue tracker to organise multi-step work. Plan work into Aura's Crew — the native autonomous work-loop (a real dependency graph with leases, goal-proof and a run ledger, the thing a Beads + Ralph loop only approximates). Two modes in one tool: (1) call with NO plan body to READ the orderless pile chunked into focused groups (epic → sprint → batch) so even a huge board can be reasoned over in full; (2) call again WITH edges/goals/objectives to APPLY a real order. After applying, the crew is drainable: any coding agent calls aura_crew_ready → aura_crew_claim → aura_crew_complete to work it. Every response carries a live `crew` envelope (counts, who's working, what just landed with its proof, what's next). Use Crew for anything that's more than a single edit — it is the home for planned, trackable, provable work in this repo.",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {
                                        "edges": {
                                            "type": "array",
                                            "description": "Dependency edges. Add one ONLY where a task genuinely needs another's output.",
                                            "items": {
                                                "type": "object",
                                                "properties": {
                                                    "task": { "type": "string", "description": "Task id that must WAIT." },
                                                    "depends_on": { "type": "string", "description": "Task id that must finish FIRST." }
                                                },
                                                "required": ["task", "depends_on"]
                                            }
                                        },
                                        "goals": {
                                            "type": "array",
                                            "description": "Named goals — each connected group of tasks adds up to one outcome.",
                                            "items": {
                                                "type": "object",
                                                "properties": {
                                                    "goal": { "type": "string", "description": "Short outcome phrase." },
                                                    "tasks": { "type": "array", "items": { "type": "string" }, "description": "Task ids that make up this goal." }
                                                },
                                                "required": ["goal", "tasks"]
                                            }
                                        },
                                        "objectives": {
                                            "type": "array",
                                            "description": "Larger objectives the goals roll up to (2–6 for most projects).",
                                            "items": {
                                                "type": "object",
                                                "properties": {
                                                    "objective": { "type": "string", "description": "Short outcome phrase." },
                                                    "goals": { "type": "array", "items": { "type": "string" }, "description": "Goal NAMES (from `goals` above) under this objective." }
                                                },
                                                "required": ["objective", "goals"]
                                            }
                                        }
                                    }
                                },
                                "annotations": {
                                    "title": "Plan into Crew",
                                    "readOnlyHint": false,
                                    "destructiveHint": false,
                                    "idempotentHint": false,
                                    "openWorldHint": false,
                                    "auraCapability": "auto"
                                }
                            },
                            {
                                "name": "aura_crew_status",
                                "description": "Read the Crew's live state without touching it — counts by lifecycle (ready/working/blocked/paused/done/failed), who is working what (agent + elapsed), what just landed (commit + goal-proof verdict — the proof Beads can't show), what's next, and the goal/crew rollups. Call this to ground yourself before planning or claiming, and any time you want to know where the autonomous work-loop is at. Optional `crew` scopes to one crew.",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {
                                        "crew": { "type": "string", "description": "Optional crew id to scope to (default: the whole graph)." }
                                    }
                                },
                                "annotations": {
                                    "title": "Crew Status",
                                    "readOnlyHint": true,
                                    "destructiveHint": false,
                                    "idempotentHint": true,
                                    "openWorldHint": false,
                                    "auraCapability": "auto"
                                }
                            },
                            {
                                "name": "aura_crew_ready",
                                "description": "Get the Crew's ready set — the nodes whose dependencies are all met and that nobody is working yet — each with its FULL spec (what to build + acceptance criteria) so you can pick one and execute. This is how a coding agent BECOMES a worker draining the loop: call aura_crew_ready, choose a node, aura_crew_claim it, do the work, aura_crew_complete. Prefer this over inventing your own ad-hoc TODOs or pulling from Beads — the ready set already respects the real dependency order. Optional `crew` scopes to one crew.",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {
                                        "crew": { "type": "string", "description": "Optional crew id to scope to." }
                                    }
                                },
                                "annotations": {
                                    "title": "Crew Ready Set",
                                    "readOnlyHint": true,
                                    "destructiveHint": false,
                                    "idempotentHint": true,
                                    "openWorldHint": false,
                                    "auraCapability": "auto"
                                }
                            },
                            {
                                "name": "aura_crew_claim",
                                "description": "Lease a ready Crew node so no other agent grabs it, and get back its full spec to execute. Always claim before you start working a node — the lease is what keeps two agents (or two of you) off the same task while many run in parallel. Returns the spec; if someone else already holds it the call is refused (with the live envelope so you can pick another from `crew.next_up`). When done, call aura_crew_complete with the commit sha, or aura_crew_fail with an honest reason.",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {
                                        "id": { "type": "string", "description": "Node id from aura_crew_ready." },
                                        "agent": { "type": "string", "description": "Your agent name (e.g. 'claude') — becomes the lease holder so teammates see who's on it." },
                                        "lease_secs": { "type": "integer", "description": "How long the lease holds before it can be reclaimed as stale (default 1800)." }
                                    },
                                    "required": ["id"]
                                },
                                "annotations": {
                                    "title": "Claim Crew Node",
                                    "readOnlyHint": false,
                                    "destructiveHint": false,
                                    "idempotentHint": false,
                                    "openWorldHint": false,
                                    "auraCapability": "auto"
                                }
                            },
                            {
                                "name": "aura_crew_report",
                                "description": "Heartbeat on a Crew node you're working: refreshes your lease so a long task isn't reclaimed as stale, and carries an optional progress note. Call this periodically during work that runs longer than the lease window. Real, not a no-op — the lease clock is reset (only the same holder may refresh).",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {
                                        "id": { "type": "string", "description": "Node id you're working." },
                                        "agent": { "type": "string", "description": "Your agent name — must match the holder that claimed it." },
                                        "note": { "type": "string", "description": "Optional one-line progress note." },
                                        "lease_secs": { "type": "integer", "description": "New lease window in seconds (default 1800)." }
                                    },
                                    "required": ["id"]
                                },
                                "annotations": {
                                    "title": "Crew Heartbeat",
                                    "readOnlyHint": false,
                                    "destructiveHint": false,
                                    "idempotentHint": false,
                                    "openWorldHint": false,
                                    "auraCapability": "auto"
                                }
                            },
                            {
                                "name": "aura_crew_complete",
                                "description": "Mark a Crew node done with the commit its work landed in. The commit feeds Aura's goal-proof join, so the surface (and teammates) can see this node as PROVEN against the goal it served — not just 'done'. Always pass the real commit sha. After this, dependents that were waiting on this node may become ready; pick the next from `crew.next_up` or call aura_crew_ready.",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {
                                        "id": { "type": "string", "description": "Node id to complete." },
                                        "commit": { "type": "string", "description": "The git commit sha your work landed in (full or short)." }
                                    },
                                    "required": ["id"]
                                },
                                "annotations": {
                                    "title": "Complete Crew Node",
                                    "readOnlyHint": false,
                                    "destructiveHint": false,
                                    "idempotentHint": false,
                                    "openWorldHint": false,
                                    "auraCapability": "auto"
                                }
                            },
                            {
                                "name": "aura_crew_fail",
                                "description": "Mark a Crew node failed with an honest reason for what blocked it. The crew moves on and a human (or you, later) can retry it from the Crew surface. Use this instead of silently abandoning a node — the reason is what makes the loop's track record trustworthy.",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {
                                        "id": { "type": "string", "description": "Node id to fail." },
                                        "reason": { "type": "string", "description": "What blocked it — be specific and honest." }
                                    },
                                    "required": ["id", "reason"]
                                },
                                "annotations": {
                                    "title": "Fail Crew Node",
                                    "readOnlyHint": false,
                                    "destructiveHint": false,
                                    "idempotentHint": false,
                                    "openWorldHint": false,
                                    "auraCapability": "auto"
                                }
                            },
                            {
                                "name": "aura_crew_list",
                                "description": "List the crews in this project — the durable registry (always including the default 'main' crew) joined to each crew's LIVE lifecycle counts (ready/working/blocked/paused/done/failed) and the goals inside it. Call this to see what crews exist and where each is at before spawning another or routing work into one. Many crews can run in parallel, each draining its own slice of the graph.",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {}
                                },
                                "annotations": {
                                    "title": "List Crews",
                                    "readOnlyHint": true,
                                    "destructiveHint": false,
                                    "idempotentHint": true,
                                    "openWorldHint": false,
                                    "auraCapability": "auto"
                                }
                            },
                            {
                                "name": "aura_crew_spawn",
                                "description": "Stand up a SECOND crew to run in parallel with the first — this is how you add a new stream of autonomous work without waiting for the current crew to finish. Mints a named crew (idempotent by slug) and, optionally, moves a set of existing nodes into it via `task_ids` so it has work immediately. After spawning, run it independently with `aura loop run --crew <id>`, or drain it over MCP by passing `crew` to aura_crew_ready / aura_crew_status. Use this when the user wants two efforts going at once (e.g. a 'Perf crew' alongside the main build).",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {
                                        "title": { "type": "string", "description": "Human name for the crew (e.g. 'Perf crew'). Slugged into a stable crew id." },
                                        "description": { "type": "string", "description": "Optional one-line purpose." },
                                        "task_ids": {
                                            "type": "array",
                                            "items": { "type": "string" },
                                            "description": "Optional node ids to move into the new crew so it has work right away."
                                        }
                                    },
                                    "required": ["title"]
                                },
                                "annotations": {
                                    "title": "Spawn Crew",
                                    "readOnlyHint": false,
                                    "destructiveHint": false,
                                    "idempotentHint": false,
                                    "openWorldHint": false,
                                    "auraCapability": "auto"
                                }
                            },
                            {
                                "name": "aura_refs",
                                "description": "Find every site that references a symbol across an indexed file set, using a real cross-file stack-graph (not regex). Phase A surface for Python + TypeScript — the natural successor to grep/`aura_live_impacts`'s function-name heuristic. Returns sorted, deduplicated (caller_file, definition_file) tuples. Cross-repo resolution is Phase D (deferred).",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {
                                        "symbol": { "type": "string", "description": "Symbol name to resolve (function/class/variable identifier)." },
                                        "files": {
                                            "type": "array",
                                            "description": "Files to index. Each item: {path, source}. Extension drives language dispatch (.py / .ts / .tsx).",
                                            "items": {
                                                "type": "object",
                                                "properties": {
                                                    "path": { "type": "string" },
                                                    "source": { "type": "string" }
                                                },
                                                "required": ["path", "source"]
                                            }
                                        }
                                    },
                                    "required": ["symbol", "files"]
                                },
                                "annotations": {
                                    "title": "Find References",
                                    "readOnlyHint": true,
                                    "destructiveHint": false,
                                    "idempotentHint": true,
                                    "openWorldHint": false,
                                    "auraCapability": "auto"
                                }
                            },
                            {
                                "name": "aura_defs",
                                "description": "Find every definition site for a symbol across an indexed file set. Surfaces direct definitions AND import-as-local-binding sites (e.g. `from x import y` registers `y` in the importer). Use alongside `aura_refs` to disambiguate which definition a given reference resolves to.",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {
                                        "symbol": { "type": "string", "description": "Symbol name to look up." },
                                        "files": {
                                            "type": "array",
                                            "description": "Files to index. Each item: {path, source}.",
                                            "items": {
                                                "type": "object",
                                                "properties": {
                                                    "path": { "type": "string" },
                                                    "source": { "type": "string" }
                                                },
                                                "required": ["path", "source"]
                                            }
                                        }
                                    },
                                    "required": ["symbol", "files"]
                                },
                                "annotations": {
                                    "title": "Find Definitions",
                                    "readOnlyHint": true,
                                    "destructiveHint": false,
                                    "idempotentHint": true,
                                    "openWorldHint": false,
                                    "auraCapability": "auto"
                                }
                            },
                            {
                                "name": "aura_route_suggest",
                                "description": "Ask the cross-project Agent Skill Ledger which provider/brain is historically best for a kind of task, before you dispatch it. Aggregates closed-task outcomes for the taxonomy cell (category × language × layer) and applies the canonical score = quality·pr_pass / (1 + cost) ranking, requiring at least 10 samples before naming a winner. Returns the single best provider_id with its score and sample_count, or null when no provider has enough evidence yet (caller should fall back to the active brain). This is the same ranker `aura skill suggest` and the in-app manager use, so routing is consistent across the CLI, MCP, and the desktop app.",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {
                                        "category": { "type": "string", "description": "Coarse category — one of frontend|backend|infra|refactor|security-review|architecture-review." },
                                        "language": { "type": "string", "description": "Optional fine language filter (e.g. rust, typescript, python)." },
                                        "layer": { "type": "string", "description": "Optional fine layer filter — ui|api|db|cli." }
                                    },
                                    "required": ["category"]
                                },
                                "annotations": {
                                    "title": "Suggest Best Provider",
                                    "readOnlyHint": true,
                                    "destructiveHint": false,
                                    "idempotentHint": true,
                                    "openWorldHint": true,
                                    "auraCapability": "auto"
                                }
                            },
                            {
                                "name": "aura_tasks_list",
                                "description": "List tasks from the shared Aura Tasks board (the same kanban the human sees in the desktop app, backed by .aura/tasks/tasks.json). Returns compact summaries — id, AURA-{n} ref, title, status/state, priority, assignees, labels, due date — newest-updated first. Use this to find work to pick up; address a task in aura_task_get / aura_task_update by either its id or its AURA-{n} ref.",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {
                                        "status": { "type": "string", "description": "Optional filter: backlog | todo | in_progress | in_review | done | cancelled. Omit for all." },
                                        "limit": { "type": "integer", "description": "Max tasks to return (default 50, 0 = no cap)." }
                                    }
                                },
                                "annotations": {
                                    "title": "List Tasks",
                                    "readOnlyHint": true,
                                    "destructiveHint": false,
                                    "idempotentHint": true,
                                    "openWorldHint": false,
                                    "auraCapability": "auto"
                                }
                            },
                            {
                                "name": "aura_task_get",
                                "description": "Fetch one task from the Aura Tasks board in full (every field — description, sub-task links, cycle/module, dates, linked PR). Identify it by raw id or AURA-{n} ref (a bare number works too).",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {
                                        "id": { "type": "string", "description": "Task id or AURA-{n} ref (e.g. 'AURA-42' or '42')." }
                                    },
                                    "required": ["id"]
                                },
                                "annotations": {
                                    "title": "Get Task",
                                    "readOnlyHint": true,
                                    "destructiveHint": false,
                                    "idempotentHint": true,
                                    "openWorldHint": false,
                                    "auraCapability": "auto"
                                }
                            },
                            {
                                "name": "aura_task_update",
                                "description": "Update a task on the shared Aura Tasks board — move it across the kanban (status), set priority, (re)assign it, or claim it for an AI agent. Changes are written to the same file the desktop app reads, so the human sees them live. Only the named fields change; everything else is preserved. Status and state_id are mirrored exactly as the app heals them.",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {
                                        "id": { "type": "string", "description": "Task id or AURA-{n} ref." },
                                        "status": { "type": "string", "description": "New status: backlog | todo | in_progress | in_review | done | cancelled." },
                                        "priority": { "type": "string", "description": "New priority: urgent | high | medium | low | none." },
                                        "assignee": { "type": "string", "description": "Human handle to assign. Pass an empty string to unassign." },
                                        "agent_assignee": { "type": "string", "description": "AI agent to own this task (claude, codex, gemini, …). Empty string clears it." }
                                    },
                                    "required": ["id"]
                                },
                                "annotations": {
                                    "title": "Update Task",
                                    "readOnlyHint": false,
                                    "destructiveHint": false,
                                    "idempotentHint": false,
                                    "openWorldHint": false,
                                    "auraCapability": "auto"
                                }
                            },
                            {
                                "name": "aura_task_create",
                                "description": "Mint a new task on the shared Aura Tasks board (the same kanban the human sees, backed by .aura/tasks/tasks.json). The task lands on the board live with the next AURA-{n} handle. Use this to file follow-up work, break a request into trackable items, or hand yourself a TODO. Returns the full created task (including its id + AURA-{n} ref) so you can address it later with aura_task_update.",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {
                                        "title": { "type": "string", "description": "Short task title (required)." },
                                        "description": { "type": "string", "description": "Optional longer body / acceptance criteria. Markdown ok." },
                                        "status": { "type": "string", "description": "Starting column: backlog | todo | in_progress | in_review | done | cancelled. Default todo." },
                                        "priority": { "type": "string", "description": "urgent | high | medium | low | none. Default medium." },
                                        "agent_assignee": { "type": "string", "description": "Optional AI agent to own it (claude, codex, gemini, …)." }
                                    },
                                    "required": ["title"]
                                },
                                "annotations": {
                                    "title": "Create Task",
                                    "readOnlyHint": false,
                                    "destructiveHint": false,
                                    "idempotentHint": false,
                                    "openWorldHint": false,
                                    "auraCapability": "auto"
                                }
                            },
                            {
                                "name": "aura_pages_list",
                                "description": "List pages from the shared Aura Pages wiki (the team's Notion-style markdown docs under .aura/notes/, the same ones the desktop app's Pages surface shows). Returns summaries — id, scope, bucket, title, visibility, tags — newest-updated first. Scopes: team (shared), channel (per channel), member (per person).",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {
                                        "scope": { "type": "string", "description": "Filter to one scope: team | channel | member. Omit to list all." },
                                        "bucket": { "type": "string", "description": "For channel/member scope, narrow to one channel handle / member." }
                                    }
                                },
                                "annotations": {
                                    "title": "List Pages",
                                    "readOnlyHint": true,
                                    "destructiveHint": false,
                                    "idempotentHint": true,
                                    "openWorldHint": false,
                                    "auraCapability": "auto"
                                }
                            },
                            {
                                "name": "aura_page_read",
                                "description": "Read one page from the Aura Pages wiki in full — its frontmatter (title, tags, visibility), the markdown body, and the raw on-disk text. Identify it by scope + id (+ bucket for channel/member scope).",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {
                                        "scope": { "type": "string", "description": "team | channel | member." },
                                        "id": { "type": "string", "description": "Page id (the file stem, e.g. 'note_…')." },
                                        "bucket": { "type": "string", "description": "Channel handle / member, for channel|member scope. Empty for team." }
                                    },
                                    "required": ["scope", "id"]
                                },
                                "annotations": {
                                    "title": "Read Page",
                                    "readOnlyHint": true,
                                    "destructiveHint": false,
                                    "idempotentHint": true,
                                    "openWorldHint": false,
                                    "auraCapability": "auto"
                                }
                            },
                            {
                                "name": "aura_page_write",
                                "description": "Create or update a page in the shared Aura Pages wiki. Omit id to create a new page (a fresh id is returned); pass an existing id to update it in place (created_at and untouched frontmatter keys are preserved). Writes land in the same files the desktop app renders, so the team sees the doc immediately. Body is markdown.",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {
                                        "scope": { "type": "string", "description": "team | channel | member." },
                                        "bucket": { "type": "string", "description": "Channel handle / member, for channel|member scope. Empty/omit for team." },
                                        "id": { "type": "string", "description": "Existing page id to update. Omit to create a new page." },
                                        "title": { "type": "string", "description": "Page title (frontmatter)." },
                                        "body": { "type": "string", "description": "Markdown body of the page." },
                                        "tags": { "type": "array", "items": { "type": "string" }, "description": "Optional tags." },
                                        "visibility": { "type": "string", "description": "private | shared. Defaults: member→private, else shared." }
                                    },
                                    "required": ["scope", "body"]
                                },
                                "annotations": {
                                    "title": "Write Page",
                                    "readOnlyHint": false,
                                    "destructiveHint": false,
                                    "idempotentHint": false,
                                    "openWorldHint": false,
                                    "auraCapability": "auto"
                                }
                            },
                            {
                                "name": "aura_team_radar",
                                "description": "Team Awareness radar — realtime view of who (human or agent) is building what, why, and what it impacts, BEFORE anyone commits/pushes. Returns two things: `events` (the ambient feed, newest-first) and `conflicts` (the REASONED layer — only genuine/possible collisions between YOUR current work and other actors). Call this before you start editing or before a commit: if `conflicts` is non-empty, another human or agent is working where you are. Conflicts are computed against your git-dirty files + symbols you've announced via aura_radar_emit; random edits to unrelated files never surface here, so a non-empty result is always worth acting on.",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {
                                        "focus": { "type": "string", "description": "Optional: narrow the ambient feed to events touching this file path fragment or symbol name." },
                                        "as": { "type": "string", "description": "Your own actor label (e.g. 'claude@cursor') so YOUR events are excluded from conflicts. Defaults to the git user." },
                                        "limit": { "type": "integer", "description": "Max feed events to return (default 20)." }
                                    }
                                },
                                "annotations": {
                                    "title": "Team Radar",
                                    "readOnlyHint": true,
                                    "destructiveHint": false,
                                    "idempotentHint": true,
                                    "openWorldHint": false,
                                    "auraCapability": "auto"
                                }
                            },
                            {
                                "name": "aura_worktrees",
                                "description": "Cross-worktree control plane — the one view of EVERY checkout of this repository at once: which agent is in each, what symbols each holds, and where two checkouts are converging on the same code. A repo commonly has several worktrees live at the same time (one per agent, one per branch under review); before this, each could only see itself. Call it at session start and before editing a file you don't own: `summary.cross_worktree_symbols > 0` means another checkout holds a symbol you are about to touch, which merge will have to reconcile — coordinate with `aura_worktree_say` first. `stranded` lists agents whose checkout git no longer lists but whose claims are still held. Local-only; no network.",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {
                                        "no_git_status": { "type": "boolean", "description": "Skip the per-checkout working-tree read (uncommitted count, drift from trunk). Two git invocations per checkout, so worth setting on a repo with many worktrees when you only need the roster." },
                                        "whoami": { "type": "boolean", "description": "Instead of the board, return just which checkout THIS session is in and where its shared/private state resolves to." }
                                    }
                                },
                                "annotations": {
                                    "title": "Worktree Control Plane",
                                    "readOnlyHint": true,
                                    "destructiveHint": false,
                                    "idempotentHint": true,
                                    "openWorldHint": false,
                                    "auraCapability": "auto"
                                }
                            },
                            {
                                "name": "aura_worktree_say",
                                "description": "Message another CHECKOUT of this repo by name — 'whoever is working in barcelona' — rather than by session id, which you rarely know. This is the coordination step when `aura_worktrees` shows contention: tell the other checkout what you are about to change before you change it. Use `main` to address the main checkout. Omit `to` to reach every agent in every checkout. Returns how many sessions can actually hear it, so 'delivered to nobody' never looks like success.",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {
                                        "message": { "type": "string", "description": "What to say. Be concrete: the file/symbol and what you intend to do to it." },
                                        "to": { "type": "string", "description": "Checkout name to address, e.g. 'barcelona', or 'main' for the main checkout. Omit to broadcast to every checkout." },
                                        "to_session": { "type": "string", "description": "Optional: a specific session_id, when you do know it. Takes precedence over `to`." }
                                    },
                                    "required": ["message"]
                                },
                                "annotations": {
                                    "title": "Message a Checkout",
                                    "readOnlyHint": false,
                                    "destructiveHint": false,
                                    "idempotentHint": false,
                                    "openWorldHint": false,
                                    "auraCapability": "auto"
                                }
                            },
                            {
                                "name": "aura_worktree_inbox",
                                "description": "Read what other checkouts have said to this one. Each message names the checkout it came from, so you know which branch the sender is on. Marks them read. Call when a tool response reports unread sentinel messages, or before starting work in a repo with several live worktrees.",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {
                                        "limit": { "type": "integer", "description": "Max messages to return (default 20)." }
                                    }
                                },
                                "annotations": {
                                    "title": "Checkout Inbox",
                                    "readOnlyHint": false,
                                    "destructiveHint": false,
                                    "idempotentHint": false,
                                    "openWorldHint": false,
                                    "auraCapability": "auto"
                                }
                            },
                            {
                                "name": "aura_radar_emit",
                                "description": "Announce in-flight work onto the Team Awareness radar so teammates and other agents are aware of it BEFORE you commit/push. Emit when you start on a symbol/file, declare an intent (the why), or report a projected impact. Events are Ed25519-signed with the repo-local identity so they can't be spoofed. Keep it meaningful, not chatty — one event per real unit of work (the radar dedups and ages events out, but a per-keystroke firehose defeats the point). Pass `agent` with your label so you're attributed as an agent, not the human.",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {
                                        "kind": { "type": "string", "description": "started | editing | intent | impact | zone | paused | abandoned | committed. Default: editing." },
                                        "file": { "type": "string", "description": "File being touched (repo-relative)." },
                                        "symbol": { "type": "string", "description": "AST symbol (function/class) being touched — the strongest collision signal." },
                                        "intent": { "type": "string", "description": "The WHY — a short human-readable reason." },
                                        "impact": { "type": "string", "description": "Projected blast-radius summary (e.g. '3 callers: checkout, subscriptions, refunds')." },
                                        "agent": { "type": "string", "description": "Your agent label (e.g. 'claude@cursor'). Omit to emit as the human git user." }
                                    }
                                },
                                "annotations": {
                                    "title": "Radar Emit",
                                    "readOnlyHint": false,
                                    "destructiveHint": false,
                                    "idempotentHint": false,
                                    "openWorldHint": false,
                                    "auraCapability": "auto"
                                }
                            }
                        ]
                    }
                })
            }
            // S1-P/1: canonical manifest of the tool surface. External
            // agents (A2A callers, ACP clients) can pin
            // `canonical_hash_sha256` to detect tool-surface drift. The
            // `signature` field is reserved for S1-S — sigstore/Rekor wires
            // up identity-bound signing once cosign keyless is in place.
            // A null signature means "integrity-only, not identity-bound"
            // and clients expecting a signing root of trust should warn.
            "aura/manifest" => {
                let tools_req = RpcRequest {
                    jsonrpc: "2.0".to_string(),
                    id: Some(serde_json::Value::Null),
                    method: "tools/list".to_string(),
                    params: None,
                };
                let tools_list = Self::handle_request(tools_req);
                let tools = tools_list.get("result")
                    .and_then(|r| r.get("tools"))
                    .cloned()
                    .unwrap_or_else(|| serde_json::Value::Array(vec![]));
                let hash = Self::canonical_manifest_hash(&tools);
                let mut manifest = json!({
                    "protocolVersion": "2024-11-05",
                    "serverInfo": {
                        "name": "aura-semantic-vcs",
                        "version": "1.0.0"
                    },
                    "tools": tools,
                    "canonical_hash_sha256": hash,
                    "algorithm": "jcs-rfc8785-v1+ed25519",
                    "signature": serde_json::Value::Null,
                    "signingNote": "Signed under JCS RFC 8785 + ed25519. Verify the 4-field envelope {algo,key_id,sig_b64,canonicalization} against key_id's pubkey."
                });
                // Try to load/create the local signing key and sign the
                // manifest. If the key infrastructure is unavailable, leave
                // `signature: null` and fall back to hash-only integrity —
                // clients that require identity-bound trust should reject
                // null signatures.
                if let Ok(key_path) = crate::manifest_sig::default_signing_key_path() {
                    if let Ok(key) = aura_attestation::load_or_create(&key_path) {
                        match crate::manifest_sig::sign_manifest(manifest.clone(), &key) {
                            Ok(signed) => manifest = signed,
                            Err(_) => { /* leave signature: null */ }
                        }
                    }
                }
                json!({ "jsonrpc": "2.0", "id": req.id, "result": manifest })
            }
            // Execute a specific tool
            "tools/call" => {
                let params = req.params.unwrap_or_default();
                let name = params["name"].as_str().unwrap_or("");
                let args = params["arguments"].clone();

                let mut result = match name {
                    "aura_read_history" => Self::tool_read_history(args),
                    "aura_log_intent" => Self::tool_log_intent(args),
                    "aura_intent_query" => Self::tool_intent_query(args),
                    "aura_intent_summary" => Self::tool_intent_summary(args),
                    "aura_pr_review" => Self::tool_pr_review(args),
                    "aura_status" => Self::tool_status(args),
                    "aura_snapshot" => Self::tool_snapshot(args),
                    "aura_snapshot_list" => Self::tool_snapshot_list(args),
                    "aura_handover" => Self::tool_handover(args),
                    "aura_attest_verify" => Self::tool_attest_verify(args),
                    "aura_attest_list" => Self::tool_attest_list(args),
                    "aura_prove" => Self::tool_prove(args),
                    "aura_goals_prove" => Self::tool_goals_prove(args),
                    "aura_goals_list" => Self::tool_goals_list(args),
                    "aura_ask" => Self::tool_ask(args),
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
                    "aura_subagent_monitor" => Self::tool_subagent_monitor(args),
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
                    "aura_episodic_recall" => Self::tool_episodic_recall(args),
                    "aura_episodic_narrate" => Self::tool_episodic_narrate(args),
                    "aura_episodic_timeline" => Self::tool_episodic_timeline(args),
                    "aura_episodic_agent_digest" => Self::tool_episodic_agent_digest(args),
                    "aura_episodic_session_arc" => Self::tool_episodic_session_arc(args),
                    "aura_episodic_multi_session_arc" => Self::tool_episodic_multi_session_arc(args),
                    "aura_episodic_recall_cloud" => Self::tool_episodic_recall_cloud(args),
                    "aura_pr_commit_review_generate" => Self::tool_pr_commit_review_generate(args),
                    "aura_impacts_cross_repo" => Self::tool_impacts_cross_repo(args),
                    "aura_a2a_task_create" => Self::tool_a2a_task_create(args),
                    "aura_a2a_task_get" => Self::tool_a2a_task_get(args),
                    "aura_a2a_task_list" => Self::tool_a2a_task_list(args),
                    "aura_a2a_task_patch" => Self::tool_a2a_task_patch(args),
                    "aura_loop_plan_context" => Self::tool_loop_plan_context(args),
                    "aura_loop_plan_apply" => Self::tool_loop_plan_apply(args),
                    "aura_crew_plan" => Self::tool_crew_plan(args),
                    "aura_crew_status" => Self::tool_crew_status(args),
                    "aura_crew_ready" => Self::tool_crew_ready(args),
                    "aura_crew_claim" => Self::tool_crew_claim(args),
                    "aura_crew_report" => Self::tool_crew_report(args),
                    "aura_crew_complete" => Self::tool_crew_complete(args),
                    "aura_crew_fail" => Self::tool_crew_fail(args),
                    "aura_crew_list" => Self::tool_crew_list(args),
                    "aura_crew_spawn" => Self::tool_crew_spawn(args),
                    "aura_pr_commit_review_list" => Self::tool_pr_commit_review_list(args),
                    "aura_pr_commit_review_get" => Self::tool_pr_commit_review_get(args),
                    "aura_handover_cloud_list" => Self::tool_handover_cloud_list(args),
                    "aura_handover_cloud_push" => Self::tool_handover_cloud_push(args),
                    "aura_memory_cloud_list" => Self::tool_memory_cloud_list(args),
                    "aura_memory_cloud_push" => Self::tool_memory_cloud_push(args),
                    "aura_refs" => Self::tool_refs(args),
                    "aura_defs" => Self::tool_defs(args),
                    "aura_taste_rules" => Self::tool_taste_rules(args),
                    "aura_route_suggest" => Self::tool_route_suggest(args),
                    "aura_tasks_list" => Self::tool_tasks_list(args),
                    "aura_task_get" => Self::tool_task_get(args),
                    "aura_task_update" => Self::tool_task_update(args),
                    "aura_task_create" => Self::tool_task_create(args),
                    "aura_pages_list" => Self::tool_pages_list(args),
                    "aura_page_read" => Self::tool_page_read(args),
                    "aura_page_write" => Self::tool_page_write(args),
                    "aura_team_radar" => Self::tool_team_radar(args),
                    "aura_worktrees" => Self::tool_worktrees(args),
                    "aura_worktree_say" => Self::tool_worktree_say(args),
                    "aura_worktree_inbox" => Self::tool_worktree_inbox(args),
                    "aura_radar_emit" => Self::tool_radar_emit(args),
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

                // Push-based: aura-guard backfill ask. The shell-side
                // guard (aura-shell/src-tauri/src/agent_mutation_guard.rs)
                // writes .aura/agent_pending_backfill.json when it
                // auto-logs a stub intent for an unattributed mutation.
                // We prepend the queued note here so the agent sees it
                // in tool-result context — NOT via PTY stdin, which
                // used to land mid-keystroke in the user's prompt and
                // contaminate whatever they were typing.
                //
                // Self-clears after one read so the agent isn't
                // re-pinged forever for the same edit.
                if name != "aura_log_intent" {
                    let backfill_path = std::path::Path::new(".aura/agent_pending_backfill.json");
                    if backfill_path.exists() {
                        if let Ok(text) = std::fs::read_to_string(backfill_path) {
                            if let Ok(payload) = serde_json::from_str::<Value>(&text) {
                                if let Some(ask) = payload.get("ask").and_then(|v| v.as_str()) {
                                    if let Some(content) = result.get_mut("content").and_then(|c| c.as_array_mut()) {
                                        content.push(json!({
                                            "type": "text",
                                            "text": format!("\n📝 INTENT BACKFILL: {}", ask)
                                        }));
                                    }
                                }
                            }
                            // Clear the queue regardless of parse — we
                            // tried, don't loop on a malformed file.
                            let _ = std::fs::remove_file(backfill_path);
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
                    let sentinel_marker_path = crate::worktree::paths::shared_aura_path("sentinel/collisions_pending");
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

    /// SHA-256 over the tools array after round-tripping through
    /// `serde_json::Value`, whose `Map` uses BTreeMap ordering. This gives
    /// a deterministic digest independent of the key order the `json!`
    /// macro happens to emit. Not strictly RFC 8785 JCS (no unicode
    /// escape normalization), but sufficient for "is this the same tool
    /// surface?" integrity checks. When S1-S lands full signing we can
    /// switch to serde_jcs without changing the call sites.
    fn canonical_manifest_hash(tools: &Value) -> String {
        use sha2::{Digest, Sha256};
        // Re-parse through Value to normalize key order.
        let normalized = serde_json::to_string(tools)
            .ok()
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .and_then(|v| serde_json::to_string(&v).ok())
            .unwrap_or_default();
        let digest = Sha256::digest(normalized.as_bytes());
        format!("{:x}", digest)
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
                let toon_text = aura_toon::encode(&data);
                return json!({ "content": [{ "type": "text", "text": toon_text }] });
            }
        }

        json!({ "content": [{ "type": "text", "text": "No semantic history found." }] })
    }

    /// Trimmed, non-empty string arg, or `None`. Shared by the board/pages
    /// tools so an omitted-or-blank field reads as "leave it".
    fn arg_str(args: &Value, key: &str) -> Option<String> {
        args.get(key)
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    }

    /// Standard MCP error envelope for the board/pages tools.
    fn board_err(msg: &str) -> Value {
        json!({ "isError": true, "content": [{ "type": "text", "text": msg }] })
    }

    // ─── Tasks board — shared with the desktop app (.aura/tasks/tasks.json,
    //     see board.rs). Lets a CLI agent pick up and move work on the same
    //     kanban the human uses. ──────────────────────────────────────────

    fn tool_tasks_list(args: Value) -> Value {
        let status = Self::arg_str(&args, "status");
        let limit = args
            .get("limit")
            .and_then(|v| v.as_u64())
            .map(|n| n as usize)
            .unwrap_or(50);
        match crate::board::list_tasks(std::path::Path::new("."), status.as_deref(), limit) {
            Ok(list) => {
                let body =
                    serde_json::to_string_pretty(&json!({ "count": list.len(), "tasks": list }))
                        .unwrap_or_else(|_| "[]".into());
                json!({ "content": [{ "type": "text", "text": body }] })
            }
            Err(e) => Self::board_err(&e),
        }
    }

    // ─── Team Awareness radar — the cross-agent surface of the awareness plane
    //     (awareness/*). Lets any MCP client (Claude Code, Cursor, Codex,
    //     Gemini) and the desktop query "who's working where I am, right now"
    //     and announce their own in-flight work, BEFORE a commit/PR. ──────────

    fn tool_team_radar(args: Value) -> Value {
        let focus = Self::arg_str(&args, "focus");
        let as_actor = Self::arg_str(&args, "as");
        let limit = args
            .get("limit")
            .and_then(|v| v.as_u64())
            .map(|n| n as usize)
            .unwrap_or(20);
        let data = crate::awareness::api::radar(focus.as_deref(), limit, as_actor.as_deref());
        let body = serde_json::to_string_pretty(&data).unwrap_or_else(|_| "{}".into());
        json!({ "content": [{ "type": "text", "text": body }] })
    }

    fn tool_worktrees(args: Value) -> Value {
        let data = if args.get("whoami").and_then(|v| v.as_bool()).unwrap_or(false) {
            crate::worktree::api::whoami()
        } else {
            let skip = args
                .get("no_git_status")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            crate::worktree::api::plane(!skip)
        };
        let body = serde_json::to_string_pretty(&data).unwrap_or_else(|_| "{}".into());
        json!({ "content": [{ "type": "text", "text": body }] })
    }

    fn tool_worktree_say(args: Value) -> Value {
        let Some(message) = Self::arg_str(&args, "message") else {
            return Self::board_err("`message` is required.");
        };
        let to = Self::arg_str(&args, "to");
        let to_session = Self::arg_str(&args, "to_session");
        let data = crate::worktree::api::say(&message, to.as_deref(), to_session.as_deref());
        let body = serde_json::to_string_pretty(&data).unwrap_or_else(|_| "{}".into());
        json!({ "content": [{ "type": "text", "text": body }] })
    }

    fn tool_worktree_inbox(args: Value) -> Value {
        let limit = args
            .get("limit")
            .and_then(|v| v.as_u64())
            .map(|n| n as usize)
            .unwrap_or(20);
        let data = crate::worktree::api::inbox(limit);
        let body = serde_json::to_string_pretty(&data).unwrap_or_else(|_| "{}".into());
        json!({ "content": [{ "type": "text", "text": body }] })
    }

    fn tool_radar_emit(args: Value) -> Value {
        let kind_s = Self::arg_str(&args, "kind").unwrap_or_else(|| "editing".to_string());
        let Some(kind) = crate::awareness::model::AwarenessKind::parse(&kind_s) else {
            return Self::board_err(
                "unknown kind — use: started|editing|intent|impact|zone|paused|abandoned|committed",
            );
        };
        let data = crate::awareness::api::emit(crate::awareness::emit::EmitInput {
            kind,
            file: Self::arg_str(&args, "file"),
            symbol: Self::arg_str(&args, "symbol"),
            intent: Self::arg_str(&args, "intent"),
            impact: Self::arg_str(&args, "impact"),
            agent: Self::arg_str(&args, "agent"),
        });
        let body = serde_json::to_string_pretty(&data).unwrap_or_else(|_| "{}".into());
        json!({ "content": [{ "type": "text", "text": body }] })
    }

    fn tool_task_get(args: Value) -> Value {
        let id = match Self::arg_str(&args, "id") {
            Some(s) => s,
            None => return Self::board_err("`id` is required."),
        };
        match crate::board::get_task(std::path::Path::new("."), &id) {
            Ok(Some(t)) => json!({ "content": [{ "type": "text", "text": serde_json::to_string_pretty(&t).unwrap_or_default() }] }),
            Ok(None) => Self::board_err(&format!("No task matching '{id}'.")),
            Err(e) => Self::board_err(&e),
        }
    }

    fn tool_task_update(args: Value) -> Value {
        let id = match Self::arg_str(&args, "id") {
            Some(s) => s,
            None => return Self::board_err("`id` is required."),
        };
        // assignee / agent_assignee use the RAW arg (not arg_str): an explicit
        // empty string means "unassign", which arg_str would swallow.
        let unassignable = |key: &str| -> Option<Option<String>> {
            args.get(key).and_then(|v| v.as_str()).map(|v| {
                if v.trim().is_empty() {
                    None
                } else {
                    Some(v.trim().to_string())
                }
            })
        };
        let patch = crate::board::TaskPatch {
            status: Self::arg_str(&args, "status"),
            priority: Self::arg_str(&args, "priority"),
            assignee: unassignable("assignee"),
            agent_assignee: unassignable("agent_assignee"),
        };
        match crate::board::update_task(std::path::Path::new("."), &id, patch) {
            Ok(t) => json!({ "content": [{ "type": "text", "text": serde_json::to_string_pretty(&t).unwrap_or_default() }] }),
            Err(e) => Self::board_err(&e),
        }
    }

    fn tool_task_create(args: Value) -> Value {
        let title = match Self::arg_str(&args, "title") {
            Some(s) => s,
            None => return Self::board_err("`title` is required."),
        };
        let description = Self::arg_str(&args, "description");
        let status = Self::arg_str(&args, "status");
        let priority = Self::arg_str(&args, "priority");
        let agent_assignee = Self::arg_str(&args, "agent_assignee");
        match crate::board::create_task(
            std::path::Path::new("."),
            &title,
            description.as_deref(),
            status.as_deref(),
            priority.as_deref(),
            agent_assignee.as_deref(),
        ) {
            Ok(t) => json!({ "content": [{ "type": "text", "text": serde_json::to_string_pretty(&t).unwrap_or_default() }] }),
            Err(e) => Self::board_err(&e),
        }
    }

    // ─── Pages wiki — shared with the desktop app (.aura/notes/). Lets a CLI
    //     agent read and write the team's markdown docs. ──────────────────

    fn tool_pages_list(args: Value) -> Value {
        let scope = Self::arg_str(&args, "scope");
        let bucket = Self::arg_str(&args, "bucket");
        match crate::board::list_notes(
            std::path::Path::new("."),
            scope.as_deref(),
            bucket.as_deref(),
        ) {
            Ok(list) => {
                let body =
                    serde_json::to_string_pretty(&json!({ "count": list.len(), "pages": list }))
                        .unwrap_or_else(|_| "[]".into());
                json!({ "content": [{ "type": "text", "text": body }] })
            }
            Err(e) => Self::board_err(&e),
        }
    }

    fn tool_page_read(args: Value) -> Value {
        let scope = match Self::arg_str(&args, "scope") {
            Some(s) => s,
            None => return Self::board_err("`scope` is required."),
        };
        let id = match Self::arg_str(&args, "id") {
            Some(s) => s,
            None => return Self::board_err("`id` is required."),
        };
        let bucket = Self::arg_str(&args, "bucket").unwrap_or_default();
        match crate::board::read_note(std::path::Path::new("."), &scope, &bucket, &id) {
            Ok(Some(n)) => json!({ "content": [{ "type": "text", "text": serde_json::to_string_pretty(&n).unwrap_or_default() }] }),
            Ok(None) => Self::board_err(&format!("No page '{id}' in scope '{scope}'.")),
            Err(e) => Self::board_err(&e),
        }
    }

    fn tool_page_write(args: Value) -> Value {
        let scope = match Self::arg_str(&args, "scope") {
            Some(s) => s,
            None => return Self::board_err("`scope` is required."),
        };
        let body = match args.get("body").and_then(|v| v.as_str()) {
            Some(s) => s.to_string(),
            None => return Self::board_err("`body` is required."),
        };
        let bucket = Self::arg_str(&args, "bucket").unwrap_or_default();
        let id = Self::arg_str(&args, "id");
        let title = Self::arg_str(&args, "title");
        let visibility = Self::arg_str(&args, "visibility");
        let tags = args.get("tags").and_then(|v| v.as_array()).map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(String::from))
                .collect::<Vec<_>>()
        });
        let author = caller_agent_id();
        let w = crate::board::NoteWrite {
            scope: &scope,
            bucket: &bucket,
            id: id.as_deref(),
            title: title.as_deref(),
            body: &body,
            tags,
            visibility: visibility.as_deref(),
            author: &author,
        };
        match crate::board::write_note(std::path::Path::new("."), w) {
            Ok(summary) => json!({ "content": [{ "type": "text", "text": serde_json::to_string_pretty(&summary).unwrap_or_default() }] }),
            Err(e) => Self::board_err(&e),
        }
    }

    fn tool_log_intent(args: Value) -> Value {
        let intent = args["intent"].as_str().unwrap_or("No intent provided.").to_string();

        // Optional canonical type. Validate against the closed set BEFORE
        // touching any side-effecting state — invalid types are a hard
        // reject so a typo'd "BugFx" doesn't get persisted alongside real
        // typed entries and silently break aura_intent_query filters.
        let intent_type: Option<String> = match args.get("intent_type") {
            None | Some(Value::Null) => None,
            Some(Value::String(s)) if s.is_empty() => None,
            Some(Value::String(s)) => {
                if !crate::intent_query::is_canonical_intent_type(s) {
                    return json!({
                        "isError": true,
                        "content": [{
                            "type": "text",
                            "text": format!(
                                "Invalid intent_type '{}'. Must be one of: {}",
                                s,
                                crate::intent_query::CANONICAL_INTENT_TYPES.join(", "),
                            )
                        }]
                    });
                }
                Some(s.clone())
            }
            Some(other) => {
                return json!({
                    "isError": true,
                    "content": [{
                        "type": "text",
                        "text": format!("intent_type must be a string, got {}", other)
                    }]
                });
            }
        };

        // Optional declared write-scope: the repo-relative paths (or globs)
        // the agent says THIS change will touch. Persisted into the signed
        // block's declared_impacts so the pre-commit reconciler can flag any
        // file touched beyond them — the "did exactly what it said" check.
        // Absent / non-array ⇒ no scope claim, divergence gate stays dormant.
        let declared_writes: Vec<String> = match args.get("writes") {
            Some(Value::Array(a)) => a
                .iter()
                .filter_map(|v| v.as_str())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect(),
            _ => Vec::new(),
        };

        // The real coding agent driving this MCP session (captured at
        // initialize), used to attribute both the session and the intent row.
        let agent = caller_agent_id();

        // Start/resume session and log transcript
        let _sess = SessionManager::start_session(&agent);
        SessionManager::append_transcript("assistant", &intent);

        // 1. Write the handshake file for the pre-commit hook
        let _ = std::fs::write(".gemini.intent", &intent);

        // 2. S1 sigstore-live: build a signed Block alongside the JSONL
        //    entry so a third party can later prove this intent came from
        //    the local signing identity. Best-effort — if signing fails
        //    (no key, write error), we fall through to the JSONL-only
        //    path that's existed since v0.1. The block_id is stamped
        //    into the JSONL row so a verifier can find the signed file.
        let signed =
            sign_intent_best_effort(&intent, intent_type.as_deref(), &declared_writes, "MCP Agent");
        let signed_block_id: Option<String> = signed.as_ref().map(|(bid, _)| bid.clone());
        let signed_key_id: Option<String> = signed.as_ref().map(|(_, kid)| kid.clone());

        // 2b. S1-T sigstore-live (live tier): if AURA_REKOR_URL is set,
        //     publish the block hash + signature to a Rekor transparency
        //     log so a verifier can later prove inclusion. Off by default
        //     so the v0 user path stays hermetic.
        let rekor_entry: Option<crate::rekor::RekorEntryRef> = signed_block_id
            .as_deref()
            .and_then(publish_intent_to_rekor_best_effort);

        // 3. Also append to the durable intent log (JSONL) so the watcher daemon
        //    can link file snapshots to this intent context
        let _ = std::fs::create_dir_all(".aura");
        let mut log_entry = json!({
            "agent_id": agent,
            "intent": intent,
            "timestamp": std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs()
        });
        if let Some(bid) = &signed_block_id {
            log_entry["signed_block_id"] = json!(bid);
        }
        if let Some(kid) = &signed_key_id {
            log_entry["key_id"] = json!(kid);
        }
        if let Some(entry) = &rekor_entry {
            log_entry["rekor_uuid"] = json!(entry.uuid);
            log_entry["rekor_log_index"] = json!(entry.log_index);
            log_entry["rekor_url"] = json!(entry.rekor_url);
        }
        if let Some(t) = &intent_type {
            log_entry["intent_type"] = json!(t);
        }
        // Goal-alignment spine: stamp which task this reasoning served, so the
        // commit's "why" carries its goal link. Resolved from the active-task
        // marker / branch / board — best-effort, absent when there's no task.
        if let Some((task_uuid, task_seq)) =
            crate::goals::active::resolve(std::path::Path::new("."))
        {
            log_entry["task_id"] = json!(task_uuid);
            if let Some(seq) = task_seq {
                log_entry["task_seq"] = json!(seq);
            }
        }
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
                                                parent_hash: None,
                                                ..Default::default()
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

        let typed = intent_type.as_deref().map(|t| format!(" [type={}]", t)).unwrap_or_default();
        let msg = format!("Intent logged{}. Aura will bind this reasoning to your AST changes on the next commit.{}", typed, auto_push_msg);
        json!({ "content": [{ "type": "text", "text": msg }] })
    }

    /// S2-TI / doc 16 Phase B: typed-intent query over the local
    /// .aura/intent_log.jsonl. Reads only the local file — no cloud round
    /// trip — so this works on air-gapped boxes the same way
    /// aura_log_intent does. Validates intent_type against the canonical
    /// set so a typo bubbles up as isError instead of returning a silent
    /// empty result.
    fn tool_intent_query(args: Value) -> Value {
        let intent_type: Option<String> = match args.get("intent_type") {
            None | Some(Value::Null) => None,
            Some(Value::String(s)) if s.is_empty() => None,
            Some(Value::String(s)) => {
                if !crate::intent_query::is_canonical_intent_type(s) {
                    return json!({
                        "isError": true,
                        "content": [{
                            "type": "text",
                            "text": format!(
                                "Invalid intent_type '{}'. Must be one of: {}",
                                s,
                                crate::intent_query::CANONICAL_INTENT_TYPES.join(", "),
                            )
                        }]
                    });
                }
                Some(s.clone())
            }
            Some(other) => {
                return json!({
                    "isError": true,
                    "content": [{
                        "type": "text",
                        "text": format!("intent_type must be a string, got {}", other)
                    }]
                });
            }
        };

        let since_hours: i64 = args.get("since_hours")
            .and_then(|v| v.as_i64())
            .unwrap_or(168);

        // Cap limit at 500 (matches aura_episodic_recall_cloud) so a
        // misconfigured caller can't OOM us by asking for the whole log.
        let limit: usize = args.get("limit")
            .and_then(|v| v.as_u64())
            .map(|n| n as usize)
            .unwrap_or(50)
            .min(500);

        let path = std::path::Path::new(".aura/intent_log.jsonl");
        let rows = crate::intent_query::read_all_rows(path);
        let now_unix_secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);

        let result = crate::intent_query::query_rows(
            rows,
            intent_type.as_deref(),
            since_hours,
            limit,
            now_unix_secs,
        );

        let payload = result.to_json();
        json!({ "content": [{ "type": "text", "text": payload.to_string() }] })
    }

    /// S2-TIM: structured typed-intent histogram. Same envelope shape as
    /// `aura intents summary --json` so MCP and CLI consumers agree
    /// byte-for-byte. Empty case returns `status: "empty"` with zeroed
    /// counters so a downstream agent always parses one schema.
    fn tool_intent_summary(args: Value) -> Value {
        let since_hours: i64 = args.get("since_hours")
            .and_then(|v| v.as_i64())
            .unwrap_or(24);
        let sample_per_type: usize = args.get("sample_per_type")
            .and_then(|v| v.as_u64())
            .map(|n| n as usize)
            .unwrap_or(1)
            .min(20);
        let path = std::path::Path::new(".aura/intent_log.jsonl");
        let payload = match crate::intent_query::build_typed_intent_summary(
            path,
            since_hours,
            sample_per_type,
        ) {
            Some(s) => s.to_json(),
            None => json!({
                "status": "empty",
                "since_hours": since_hours,
                "typed_total": 0,
                "untyped": 0,
                "type_count": 0,
                "buckets": [],
            }),
        };
        json!({ "content": [{ "type": "text", "text": payload.to_string() }] })
    }

    pub(crate) fn tool_pr_review(args: Value) -> Value {
        let base = args["base"].as_str().unwrap_or("master");
        match crate::pr::PrReviewEngine::run_review(base, true, false) {
            Ok(Some(report_json)) => {
                // Try to parse the JSON report and re-encode as TOON for token savings
                if let Ok(parsed) = serde_json::from_str::<Value>(&report_json) {
                    let toon_text = aura_toon::encode(&parsed);
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

        // W3 conflicts + W5 peer build markers written by live_ws.
        {
            let conflicts_path = std::path::Path::new(".aura/live/conflicts_pending");
            if conflicts_path.exists() {
                if let Some(n) = std::fs::read_to_string(conflicts_path).ok()
                    .and_then(|s| s.trim().parse::<u64>().ok())
                    .filter(|&n| n > 0)
                {
                    status_data["conflicts"] = json!({
                        "pending": n,
                        "hint": "Run `aura resolve --interactive` to settle"
                    });
                }
            }

            let build_path = std::path::Path::new(".aura/live/peer_build");
            if build_path.exists() {
                if let Ok(raw) = std::fs::read_to_string(build_path) {
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
                        status_data["peer_build"] = v;
                    }
                }
            }
        }

        // S2-TIST: 24h typed-intent histogram. Attached only when at
        // least one typed entry exists in the local log so untouched
        // repos don't grow the status payload with empty buckets. Same
        // builder the CLI/MCP summary tools use, so the numbers always
        // agree.
        if let Some(summary) = crate::intent_query::build_typed_intent_summary(
            std::path::Path::new(".aura/intent_log.jsonl"),
            24,
            0,
        ) {
            let buckets: Vec<serde_json::Value> = summary
                .buckets
                .iter()
                .map(|b| json!({"intent_type": b.intent_type, "count": b.count}))
                .collect();
            status_data["typed_intents_24h"] = json!({
                "typed_total": summary.typed_total,
                "untyped": summary.untyped,
                "type_count": summary.buckets.len(),
                "buckets": buckets,
                "hint": "Call aura_intent_summary for samples, or aura_intent_query --type <T> to drill in.",
            });
        }

        // S1-SH: signing-key health. An agent reading aura_status before
        // any sign-bearing operation (aura_log_intent, manifest signing,
        // attest verify) can preflight here instead of round-tripping a
        // failed signature. Strictly read-only — uses `load_signing_key`
        // (NOT `load_or_create`) so a status call never side-effects a
        // key creation. The `key_id` mirrors the same did:aura:key/<b64>
        // form the signed envelopes carry, so a verifier can cross-check
        // "the key the agent thinks is in use" against "the key id stamped
        // on its last block".
        status_data["signing"] = Self::signing_health_payload();

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

        let toon_text = aura_toon::encode(&status_data);
        json!({ "content": [{ "type": "text", "text": toon_text }] })
    }

    /// S1-SH (Signing Health): inspect the local manifest-signing key
    /// without side effects. Thin shim over `manifest_sig::signing_health`
    /// — the read-only probe shared with the `aura doctor` "Signing key"
    /// line and the `aura keys sigstore-status` CLI subcommand, so all
    /// three surfaces report the same diagnosis from the same code.
    /// See `manifest_sig::signing_health` for the payload shape.
    fn signing_health_payload() -> Value {
        crate::manifest_sig::signing_health()
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
        let toon_text = aura_toon::encode(&data);

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

        // A checkpoint's `ast_nodes` is the FULL AST snapshot (tens of thousands
        // of nodes on a large repo), not a diff. Emitting all of it produced a
        // ~43 MB handover payload — useless as an agent-to-agent paste. So we
        // recover the *genuinely* modified nodes by diffing each checkpoint
        // against the next-older one (results is newest-first), and emit only
        // those — with a true `count` and a hard safety cap so a pathological
        // diff can never re-introduce a giant dump.
        const MAX_HANDOVER_NODES: usize = 60;
        let mut xml_payload = String::from("<aura_semantic_context>\n");
        for (i, data) in results.iter().take(3).enumerate() {
            xml_payload.push_str(&format!("  <checkpoint id=\"{}\" agent=\"{}\">\n", data.id, data.agent_id));
            xml_payload.push_str(&format!("    <intent>{}</intent>\n", data.intent.replace('\n', " ")));

            // Identifiers changed vs the next-older checkpoint. The oldest
            // checkpoint in the window has no baseline → empty (we don't dump
            // the whole graph as "modified").
            let changed: std::collections::HashSet<String> = match results.get(i + 1) {
                Some(prev) => crate::parser::SemanticParser::diff_nodes(&prev.ast_nodes, &data.ast_nodes)
                    .into_iter()
                    .map(|(ident, _action)| ident)
                    .collect(),
                None => std::collections::HashSet::new(),
            };
            let modified: Vec<_> = data
                .ast_nodes
                .iter()
                .filter(|n| {
                    n.identifier
                        .as_deref()
                        .map(|id| changed.contains(id))
                        .unwrap_or(false)
                })
                .collect();

            let total = modified.len();
            let shown_attr = if total > MAX_HANDOVER_NODES {
                format!(" shown=\"{}\"", MAX_HANDOVER_NODES)
            } else {
                String::new()
            };
            xml_payload.push_str(&format!(
                "    <modified_nodes count=\"{}\"{}>\n",
                total, shown_attr
            ));
            for node in modified.iter().take(MAX_HANDOVER_NODES) {
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
        // Append signed-intent provenance so a downstream agent can verify
        // the chain of recent intents on its own (S1 sigstore-live).
        // Pulls from .aura/blocks/ — silent no-op if directory missing or
        // contents unparseable (best-effort, never blocks handover).
        Self::append_signed_intents_xml(&mut xml_payload);
        // Append the deterministic Block-window prose summary (S2-NH).
        // Same `.aura/blocks/` source as signed_intents, but folded into
        // a window summary (counts by kind/state/actor + recent intents)
        // so the receiving agent reads a one-paragraph debrief in
        // English instead of re-deriving it from raw IDs. CDATA-wrapped
        // because the prose contains characters that would otherwise
        // need XML escaping.
        Self::append_block_window_summary_xml(&mut xml_payload, 24, 5);
        // S2-TIH — typed-intent breakdown sourced from
        // .aura/intent_log.jsonl (the JSONL is the source of truth for
        // intent_type per S2-TI). Different shape than block_window_summary
        // (which counts blocks, not the prose intents); both can co-exist
        // and the receiving agent reads them independently. Suppressed
        // when no rows in the window carry an intent_type so a brand-new
        // repo's handover stays terse.
        Self::append_typed_intents_summary_xml(&mut xml_payload, 24, 1);
        xml_payload.push_str("</aura_semantic_context>");

        json!({ "content": [{ "type": "text", "text": format!("Handover context for {}:\n\n{}", agent, xml_payload) }] })
    }

    /// Append a `<recent_signed_intents>` block listing the last 3 signed
    /// intent blocks under `.aura/blocks/`. Each entry carries enough
    /// material for a downstream agent to call `aura attest verify <id>`:
    /// the block id, the intent text, the signing key_id, and the Rekor
    /// stamps when present.
    fn append_signed_intents_xml(out: &mut String) {
        let dir = std::path::Path::new(".aura/blocks");
        if !dir.exists() {
            return;
        }
        let mut paths: Vec<std::path::PathBuf> = match std::fs::read_dir(dir) {
            Ok(rd) => rd
                .filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|p| p.extension().and_then(|s| s.to_str()) == Some("json"))
                .collect(),
            Err(_) => return,
        };
        paths.sort();
        // Newest-last in lex order is fine for UUID v4; a later iteration
        // can sort by created_at if needed. Take the last 3 so the agent
        // sees the freshest intents at the bottom.
        let tail: Vec<_> = paths.iter().rev().take(3).collect();
        if tail.is_empty() {
            return;
        }
        out.push_str("  <recent_signed_intents>\n");
        for path in tail.iter().rev() {
            let raw = match std::fs::read_to_string(path) {
                Ok(s) => s,
                Err(_) => continue,
            };
            let v: Value = match serde_json::from_str(&raw) {
                Ok(v) => v,
                Err(_) => continue,
            };
            let id = v.get("id").and_then(|x| x.as_str()).unwrap_or("?");
            let intent = v
                .pointer("/payload/body/intent")
                .and_then(|x| x.as_str())
                .unwrap_or("?");
            let key_id = v
                .pointer("/provenance/signature/key_id")
                .and_then(|x| x.as_str())
                .unwrap_or("?");
            // S1-W: surface dual identity. Read from payload first
            // (canonical source); fall back to provenance.on_behalf_of so
            // older blocks signed before payload-binding still render.
            let human_id = v
                .pointer("/payload/body/human_id")
                .and_then(|x| x.as_str())
                .or_else(|| {
                    v.pointer("/provenance/on_behalf_of")
                        .and_then(|x| x.as_str())
                });
            let rekor_uuid = v
                .pointer("/attestations/rekor/uuid")
                .and_then(|x| x.as_str());
            let rekor_log_index = v
                .pointer("/attestations/rekor/log_index")
                .and_then(|x| x.as_i64());
            out.push_str(&format!(
                "    <intent block_id=\"{}\" key_id=\"{}\"",
                xml_escape(id),
                xml_escape(key_id)
            ));
            if let Some(h) = human_id {
                out.push_str(&format!(" human_id=\"{}\"", xml_escape(h)));
            }
            if let (Some(u), Some(idx)) = (rekor_uuid, rekor_log_index) {
                out.push_str(&format!(
                    " rekor_uuid=\"{}\" rekor_log_index=\"{}\"",
                    xml_escape(u),
                    idx
                ));
            }
            out.push_str(&format!(">{}</intent>\n", xml_escape(intent)));
        }
        out.push_str("  </recent_signed_intents>\n");
    }

    /// S2-NH — append a `<block_window_summary>` section to the
    /// handover XML. Wraps `recall_narrate::narrate_recent_blocks_prose`
    /// and emits CDATA so the prose's punctuation/dashes don't need XML
    /// escaping. Best-effort: if the directory is missing, no blocks
    /// fall in the window, or the helper returns None, we simply skip
    /// the section (handover XML stays terse).
    fn append_block_window_summary_xml(
        out: &mut String,
        since_hours: i64,
        list_limit: usize,
    ) {
        let prose = match crate::recall_narrate::narrate_recent_blocks_prose(
            std::path::Path::new(".aura/blocks"),
            since_hours,
            list_limit,
        ) {
            Some(p) => p,
            None => return,
        };
        // Defend the CDATA section: a literal `]]>` inside would close
        // the CDATA early. Splitting into `]]]]><![CDATA[>` is the
        // standard escape — preserves the bytes the agent reads.
        let safe = prose.replace("]]>", "]]]]><![CDATA[>");
        out.push_str(&format!(
            "  <block_window_summary since_hours=\"{}\" list_limit=\"{}\"><![CDATA[\n{}]]></block_window_summary>\n",
            since_hours, list_limit, safe
        ));
    }

    /// S2-TIH — append a `<typed_intent_summary>` section sourced from
    /// `.aura/intent_log.jsonl` (the canonical home for intent_type per
    /// S2-TI). Suppresses entirely when the helper returns None (file
    /// missing, log empty, or no typed rows in window) so handovers from
    /// brand-new repos don't carry a meaningless empty section.
    fn append_typed_intents_summary_xml(
        out: &mut String,
        since_hours: i64,
        sample_per_type: usize,
    ) {
        let prose = match crate::intent_query::narrate_typed_intents_prose(
            std::path::Path::new(".aura/intent_log.jsonl"),
            since_hours,
            sample_per_type,
        ) {
            Some(p) => p,
            None => return,
        };
        // Same `]]>` defense as block_window_summary — keeps any prose
        // accidentally containing the CDATA terminator from breaking
        // the XML.
        let safe = prose.replace("]]>", "]]]]><![CDATA[>");
        out.push_str(&format!(
            "  <typed_intent_summary since_hours=\"{}\" sample_per_type=\"{}\"><![CDATA[\n{}]]></typed_intent_summary>\n",
            since_hours, sample_per_type, safe
        ));
    }

    /// MCP wrapper around `intent_block::verify_block_structured`.
    /// Returns a JSON-serialized verification report when the block
    /// passes both signature and (optional) Rekor checks; an isError
    /// MCP response otherwise. Lets a downstream agent that received
    /// an aura_handover XML payload verify each block_id without
    /// shelling out to `aura attest verify`.
    fn tool_attest_verify(args: Value) -> Value {
        let block_id = match args.get("block_id").and_then(|v| v.as_str()) {
            Some(s) if !s.is_empty() => s.to_string(),
            _ => return json!({
                "isError": true,
                "content": [{ "type": "text", "text": "block_id is required (non-empty string)." }]
            }),
        };
        let no_rekor = args.get("no_rekor").and_then(|v| v.as_bool()).unwrap_or(false);
        match crate::intent_block::verify_block_structured(&block_id, no_rekor) {
            Ok(report) => json!({
                "content": [{
                    "type": "text",
                    "text": serde_json::to_string_pretty(&report).unwrap_or_else(|_| "{}".into())
                }]
            }),
            Err(e) => json!({
                "isError": true,
                "content": [{
                    "type": "text",
                    "text": format!("verify failed: {}", e)
                }]
            }),
        }
    }

    /// MCP wrapper around `intent_block::list_blocks_structured`.
    /// Returns a JSON array (one row per signed block) inside the
    /// standard MCP content[0].text envelope. Symmetric pair to
    /// aura_attest_verify so an agent can enumerate-then-verify.
    /// S2-TIL: optional intent_type filter and a per-row intent_type
    /// field — same canonical-set validation as aura_intent_query so
    /// the two surfaces stay in lockstep.
    fn tool_attest_list(args: Value) -> Value {
        let human = args
            .get("human")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty());
        let intent_type = match args.get("intent_type") {
            None | Some(Value::Null) => None,
            Some(Value::String(s)) if s.is_empty() => None,
            Some(Value::String(s)) => {
                if !crate::intent_query::is_canonical_intent_type(s) {
                    return json!({
                        "isError": true,
                        "content": [{
                            "type": "text",
                            "text": format!(
                                "Invalid intent_type '{}'. Must be one of: {}",
                                s,
                                crate::intent_query::CANONICAL_INTENT_TYPES.join(", "),
                            )
                        }]
                    });
                }
                Some(s.as_str())
            }
            Some(other) => {
                return json!({
                    "isError": true,
                    "content": [{
                        "type": "text",
                        "text": format!("intent_type must be a string, got {}", other)
                    }]
                });
            }
        };
        match crate::intent_block::list_blocks_structured(human, intent_type) {
            Ok(rows) => json!({
                "content": [{
                    "type": "text",
                    "text": serde_json::to_string_pretty(&rows).unwrap_or_else(|_| "[]".into())
                }]
            }),
            Err(e) => json!({
                "isError": true,
                "content": [{
                    "type": "text",
                    "text": format!("attest list failed: {}", e)
                }]
            }),
        }
    }

    pub(crate) fn tool_prove(args: Value) -> Value {
        let goal = match args["goal"].as_str() {
            Some(g) if !g.trim().is_empty() => g.to_string(),
            _ => return json!({ "isError": true, "content": [{ "type": "text", "text": "goal is required." }] }),
        };

        // Prove against the current code via the structured API and reshape the
        // outcome here. We do NOT read the CLI report: `prove_goal` renders it
        // with `eprintln!` (stderr), so capturing stdout would come back empty.
        // We still run the call inside `capture_stdout` — not for its result, but
        // to swallow any stray stdout `decompose_goal` might emit, which would
        // otherwise corrupt the JSON-RPC pipe.
        let mut outcome = serde_json::Value::Null;
        let _ = Self::capture_stdout(|| {
            outcome = crate::gsd::GsdEngine::prove_goal_structured(&goal);
        });

        if let Some(err) = outcome["error"].as_str() {
            return json!({ "content": [{ "type": "text", "text": format!("Couldn't check \"{}\" yet: {}", goal, err) }] });
        }

        let passed = outcome["passed"].as_u64().unwrap_or(0);
        let total = outcome["total"].as_u64().unwrap_or(0);

        // A zero score is NOT automatically "not started". Nothing passing while
        // every part exists means the pieces are built and simply aren't wired
        // together — saying "not started yet" there contradicts the very lines
        // printed underneath it ("'createNote' is built but isn't connected").
        // Read the checks and say which of those three worlds this actually is.
        let checks = outcome["checks"].as_array().cloned().unwrap_or_default();
        let built = checks
            .iter()
            .filter(|c| {
                c["exists"].as_bool().unwrap_or(false) && !c["is_stub"].as_bool().unwrap_or(false)
            })
            .count() as u64;
        let existing = checks
            .iter()
            .filter(|c| c["exists"].as_bool().unwrap_or(false))
            .count() as u64;

        let headline = if total > 0 && passed == total {
            "built and checked"
        } else if passed > 0 {
            "almost there"
        } else if existing == 0 {
            "not started yet"
        } else if built == 0 {
            "only placeholders so far"
        } else {
            "built, but not connected up yet"
        };

        // Count what's honestly true: fully-in-place parts, and — when that
        // undersells it — how many are built but still waiting to be wired.
        let tally = if passed == 0 && built > 0 {
            format!("{} of {} parts built, none connected yet", built, total)
        } else {
            format!("{} of {} parts in place", passed, total)
        };

        let mut lines = vec![format!("{} — {} ({})", goal, headline, tally), String::new()];
        for check in &checks {
            let name = check["node_name"].as_str().unwrap_or("unknown");
            let exists = check["exists"].as_bool().unwrap_or(false);
            let is_stub = check["is_stub"].as_bool().unwrap_or(false);
            let must_call = check["must_call"].as_str().unwrap_or("");
            let line = if !exists {
                format!("  · '{}' isn't built yet", name)
            } else if is_stub {
                format!("  · '{}' is only a placeholder so far", name)
            } else {
                match check["wired"].as_bool() {
                    Some(true) => format!("  ✓ '{}' is built and connected to '{}'", name, must_call),
                    Some(false) => format!("  · '{}' is built but isn't connected to '{}' yet", name, must_call),
                    None => format!("  ✓ '{}' is built", name),
                }
            };
            lines.push(line);
        }

        json!({ "content": [{ "type": "text", "text": lines.join("\n") }] })
    }

    /// Prove a goal through the DURABLE ledger: decompose-once (cached), prove
    /// against the latest code, and record a lasting, commit-stamped run — the
    /// agent-facing half of the goal-alignment spine. Returns each part in plain
    /// language with the file:line where it lives, plus the verdict.
    pub(crate) fn tool_goals_prove(args: Value) -> Value {
        let goal = match args["goal"].as_str() {
            Some(g) if !g.trim().is_empty() => g.to_string(),
            _ => return json!({ "isError": true, "content": [{ "type": "text", "text": "goal is required." }] }),
        };
        let task = args["task"].as_str().map(|s| s.to_string());

        if crate::goals::discover_repo_root().is_none() {
            return json!({ "isError": true, "content": [{ "type": "text", "text": "Not in a project folder." }] });
        }

        // Run the durable prove (decompose-once + AST check + record run) and
        // capture the structured JSON it prints, so we can reshape it for an agent.
        let raw = Self::capture_stdout(|| {
            let _ = crate::goals::cli::prove(&goal, task.as_deref(), true);
        });
        let outcome: Value = serde_json::from_str(raw.trim()).unwrap_or_else(|_| json!({}));

        if let Some(err) = outcome["error"].as_str() {
            return json!({ "content": [{ "type": "text", "text": format!("Couldn't check \"{}\" yet: {}", goal, err) }] });
        }

        let verdict = outcome["verdict"].as_str().unwrap_or("unknown");
        let passed = outcome["passed"].as_u64().unwrap_or(0);
        let total = outcome["total"].as_u64().unwrap_or(0);

        // `not_wired` means the parts exist but aren't connected — reporting that
        // as "not started yet" contradicts the per-check lines right below it.
        // Separate the two: nothing built at all vs built-but-unwired.
        let goal_checks = outcome["checks"].as_array().cloned().unwrap_or_default();
        let built = goal_checks
            .iter()
            .filter(|c| {
                c["exists"].as_bool().unwrap_or(false) && !c["is_stub"].as_bool().unwrap_or(false)
            })
            .count() as u64;
        let existing = goal_checks
            .iter()
            .filter(|c| c["exists"].as_bool().unwrap_or(false))
            .count() as u64;

        let headline = match verdict {
            "verified" => "built and checked",
            "partial" => "almost there",
            "not_wired" if existing == 0 => "not started yet",
            "not_wired" if built == 0 => "only placeholders so far",
            "not_wired" => "built, but not connected up yet",
            _ => "not checked yet",
        };
        let tally = if passed == 0 && built > 0 {
            format!("{} of {} parts built, none connected yet", built, total)
        } else {
            format!("{} of {} parts in place", passed, total)
        };

        let mut lines = vec![format!("{} — {} ({})", goal, headline, tally), String::new()];
        for check in &goal_checks {
            let reason = check["reason"].as_str().unwrap_or("");
            let ok = check["passed"].as_bool().unwrap_or(false);
            let glyph = if ok { "✓" } else { "·" };
            let loc = match (check["file"].as_str(), check["line"].as_u64()) {
                (Some(f), Some(l)) if !f.is_empty() => format!("  ({}:{})", f, l),
                (Some(f), None) if !f.is_empty() => format!("  ({})", f),
                _ => String::new(),
            };
            lines.push(format!("  {} {}{}", glyph, reason, loc));
        }
        lines.push(String::new());
        lines.push("Recorded a durable run in .aura/goals.jsonl — it'll re-check itself for free on every build.".to_string());

        json!({ "content": [{ "type": "text", "text": lines.join("\n") }] })
    }

    /// List every tracked goal from the durable ledger, in plain language.
    pub(crate) fn tool_goals_list(_args: Value) -> Value {
        if crate::goals::discover_repo_root().is_none() {
            return json!({ "isError": true, "content": [{ "type": "text", "text": "Not in a project folder." }] });
        }
        let output = Self::capture_stdout(|| {
            let _ = crate::goals::cli::list(false);
        });
        let text = if output.trim().is_empty() {
            "No goals tracked yet. Prove one with aura_goals_prove to start the ledger.".to_string()
        } else {
            output
        };
        json!({ "content": [{ "type": "text", "text": text }] })
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

        // Strategy B: Git history (HEAD + up to 49 ancestors).
        // Read each commit's tree at the top of the loop so HEAD itself
        // is searched — the "uncommitted local edit, HEAD is clean"
        // case (most common AI-hallucination recovery shape) was being
        // silently skipped because the previous loop walked to
        // commit.parent(0) before ever reading a tree.
        if past_source.is_none() {
            if let Ok(head) = repo.head().and_then(|r| r.peel_to_commit()) {
                let mut commit = head;
                for _ in 0..50 {
                    if let Ok(tree) = commit.tree() {
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
                    match commit.parent(0) {
                        Ok(p) => commit = p,
                        Err(_) => break,
                    }
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

    /// Run `f` and return everything it prints to stdout.
    ///
    /// Several tool bodies call CLI routines that `println!` their result
    /// straight to stdout instead of returning it. Over MCP, stdout *is* the
    /// JSON-RPC pipe — so those prints were lost to the caller (and corrupting
    /// the protocol), and the tool returned a fixed "Command executed"
    /// placeholder instead. That's why `aura_goals_list` and the `aura_plan_*`
    /// tools looked like they returned the same canned boilerplate every call,
    /// regardless of input (and `aura_prove` too, before it moved to the
    /// structured API and stopped relying on capture for its result). Here we
    /// redirect fd 1 to a temp file for the duration of `f`, then read it back,
    /// so the real output reaches the tool result and never leaks onto the pipe.
    #[cfg(unix)]
    fn capture_stdout<F: FnOnce()>(f: F) -> String {
        use std::io::{Read, Seek, SeekFrom, Write};
        use std::os::unix::io::AsRawFd;

        // Push anything already buffered onto the real pipe before we divert it,
        // so prior output isn't swept into the capture file.
        let _ = std::io::stdout().flush();

        let mut tmp = match tempfile::tempfile() {
            Ok(t) => t,
            // Capture unavailable — still run the closure for its side effects;
            // a lost message beats a skipped action.
            Err(_) => {
                f();
                return String::new();
            }
        };

        let stdout_fd = libc::STDOUT_FILENO;
        let saved = unsafe { libc::dup(stdout_fd) };
        if saved < 0 {
            f();
            return String::new();
        }
        // Point fd 1 at the temp file for the length of the call.
        unsafe {
            libc::dup2(tmp.as_raw_fd(), stdout_fd);
        }

        f();

        // Flush the closure's output into the temp file, then restore stdout so
        // the MCP loop can write its JSON-RPC reply to the real pipe again.
        let _ = std::io::stdout().flush();
        unsafe {
            libc::dup2(saved, stdout_fd);
            libc::close(saved);
        }

        let _ = tmp.seek(SeekFrom::Start(0));
        let mut out = String::new();
        let _ = tmp.read_to_string(&mut out);
        out
    }

    /// Non-Unix fallback: in-process fd redirection isn't portable, so keep the
    /// prior placeholder behavior rather than break the build on those targets.
    #[cfg(not(unix))]
    fn capture_stdout<F: FnOnce()>(f: F) -> String {
        f();
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
                let toon_text = aura_toon::encode(&data);
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
                let toon_text = aura_toon::encode(&data);
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
                let toon_text = aura_toon::encode(&data);
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

        let toon_text = aura_toon::encode(&budget);
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

        let toon_text = aura_toon::encode(&report_json);
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
                let toon_text = aura_toon::encode(&data);
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

        // 7. Signing-key health (S1-SHM)
        // Same single-source helper as the MCP aura_status `signing` block,
        // the `aura doctor` "Signing key" line, and `aura keys
        // sigstore-status` — read-only, never load_or_create.
        let sh = crate::manifest_sig::signing_health();
        match sh.get("status").and_then(|s| s.as_str()).unwrap_or("") {
            "ok" => {
                let key_id = sh.get("key_id").and_then(|s| s.as_str()).unwrap_or("");
                report.push_str(&format!("✓ Signing key healthy ({})\n", key_id));
            }
            "missing" => {
                report.push_str("ℹ No signing key on disk yet — first sign-bearing op will mint one\n");
            }
            "unreadable" => {
                let err = sh.get("error").and_then(|s| s.as_str()).unwrap_or("?");
                report.push_str(&format!("⚠ Signing key unreadable — {}; rotate via `aura keys sigstore-rotate`\n", err));
                issues += 1;
            }
            "no_path" => {
                let err = sh.get("error").and_then(|s| s.as_str()).unwrap_or("?");
                report.push_str(&format!("⚠ Signing key path unresolved — {}; set $HOME or use --key-path\n", err));
                issues += 1;
            }
            other => {
                report.push_str(&format!("⚠ Signing key: unexpected status '{}'\n", other));
                issues += 1;
            }
        }

        // 8. Skill-ledger health (UU-W1) — same `skill_rank::ledger_health`
        // helper as the CLI `aura doctor` so the two surfaces never drift on
        // what they report. The dirty backlog is surfaced as a warning but
        // does NOT bump `issues` here: the MCP path can't tell whether the
        // caller is signed in (so the backlog may be about to drain), and a
        // false "needs attention" on a read-only probe is worse than a hint.
        let ledger_raw = std::env::var("HOME")
            .ok()
            .map(|h| Path::new(&h).join(".aura").join("agent_skills.json"))
            .and_then(|p| std::fs::read_to_string(p).ok());
        match ledger_raw.as_deref().and_then(crate::skill_rank::ledger_health) {
            None => {
                report.push_str(
                    "ℹ Skill ledger: none yet — routing falls back to the active brain\n",
                );
            }
            Some(h) => {
                if h.dirty == 0 {
                    report.push_str(&format!(
                        "✓ Skill ledger flushed ({} recorded)\n",
                        h.recorded,
                    ));
                } else {
                    report.push_str(&format!(
                        "⚠ Skill ledger: {} row(s) pending cloud flush — sign in to cloud to drain\n",
                        h.dirty,
                    ));
                }
                if h.total_cells > 0 {
                    if h.immature_cells.is_empty() {
                        report.push_str(&format!(
                            "✓ All {} routing cell(s) have ≥{} samples — auto-routing active\n",
                            h.total_cells,
                            crate::skill_rank::MIN_SAMPLES,
                        ));
                    } else {
                        report.push_str(&format!(
                            "ℹ {} of {} routing cell(s) below {} samples (won't auto-route yet)\n",
                            h.immature_cells.len(),
                            h.total_cells,
                            crate::skill_rank::MIN_SAMPLES,
                        ));
                    }
                }
            }
        }

        report.push_str(&format!("\nTotal issues: {}", issues));

        json!({ "content": [{ "type": "text", "text": report }] })
    }

    /// Bucket O — Tail the most recent stdout/stderr from a Manager
    /// subagent. Reads `~/.aura/manager-sessions/<sid>-<tid>.tail`
    /// written live by the shell as the subagent streams. Returns the
    /// last `tail` lines (default 200) plus the running line count
    /// from the persisted ManagerTask. Cross-process safe: no shared
    /// memory needed; the tail file is the contract.
    fn tool_subagent_monitor(args: Value) -> Value {
        let session_id = match args["session_id"].as_str() {
            Some(s) if !s.trim().is_empty() => s.to_string(),
            _ => {
                return json!({
                    "isError": true,
                    "content": [{ "type": "text", "text": "session_id is required." }]
                });
            }
        };
        let task_id = match args["task_id"].as_u64() {
            Some(n) => n as usize,
            None => {
                return json!({
                    "isError": true,
                    "content": [{ "type": "text", "text": "task_id is required (integer)." }]
                });
            }
        };
        let tail = args["tail"].as_u64().map(|n| n as usize).unwrap_or(200);

        let Some(home) = std::env::var_os("HOME") else {
            return json!({ "isError": true, "content": [{ "type": "text", "text": "HOME not set." }] });
        };
        let mut path = std::path::PathBuf::from(home.clone());
        path.push(".aura");
        path.push("manager-sessions");
        path.push(format!("{session_id}-{task_id}.tail"));
        let raw = match std::fs::read_to_string(&path) {
            Ok(s) => s,
            Err(_) => {
                return json!({
                    "content": [{
                        "type": "text",
                        "text": format!("No tail for session {session_id} task {task_id}. The task hasn't started, or the ids are wrong.")
                    }]
                });
            }
        };
        let lines: Vec<&str> = raw.lines().collect();
        let total = lines.len();
        let start = total.saturating_sub(tail.max(1));

        // Persisted line_count (monotonic — survives ring rotation) and
        // status come from the session JSON. Best-effort read.
        let mut line_count: u64 = total as u64;
        let mut status: String = "unknown".into();
        let mut session_path = std::path::PathBuf::from(home);
        session_path.push(".aura");
        session_path.push("manager-sessions");
        session_path.push(format!("{session_id}.json"));
        if let Ok(raw_s) = std::fs::read_to_string(&session_path) {
            if let Ok(v) = serde_json::from_str::<Value>(&raw_s) {
                if let Some(tasks) = v.get("tasks").and_then(|t| t.as_array()) {
                    for t in tasks {
                        if t.get("id").and_then(|n| n.as_u64()) == Some(task_id as u64) {
                            if let Some(c) = t.get("line_count").and_then(|n| n.as_u64()) {
                                line_count = c;
                            }
                            if let Some(s) = t.get("status").and_then(|s| s.as_str()) {
                                status = s.to_string();
                            }
                            break;
                        }
                    }
                }
            }
        }

        let body: String = lines[start..].join("\n");
        let header = format!(
            "task #{task_id} status={status} line_count={line_count} (showing last {} of {} buffered)",
            total - start,
            total
        );
        json!({
            "content": [{
                "type": "text",
                "text": format!("{header}\n\n{body}")
            }]
        })
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

    fn tool_ask(args: Value) -> Value {
        let question = match args["question"].as_str() {
            Some(s) if !s.trim().is_empty() => s.to_string(),
            _ => return json!({ "isError": true, "content": [{ "type": "text", "text": "question is required." }] }),
        };
        let config = crate::config::ConfigManager::load();
        let token = match config.cloud_api_token
            .or_else(|| std::env::var("AURA_CLOUD_TOKEN").ok())
        {
            Some(t) => t,
            None => return json!({ "isError": true, "content": [{ "type": "text", "text": "No cloud token configured. Run `aura cloud login`." }] }),
        };
        let cloud_url = config.cloud_url.unwrap_or_else(|| "https://auravcs.com".to_string());
        let url = format!("{}/api/v2/ask", cloud_url.trim_end_matches('/'));
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .unwrap_or_else(|_| reqwest::blocking::Client::new());
        match client.post(&url)
            .header("Authorization", format!("Bearer {}", token))
            .json(&json!({ "question": question }))
            .send()
        {
            Ok(resp) => match resp.json::<Value>() {
                Ok(v) => {
                    let answer = v["answer"].as_str().unwrap_or("(no answer)").to_string();
                    let citations = v["citations"].as_array().cloned().unwrap_or_default();
                    let cite_text: String = citations.iter().filter_map(|c| {
                        Some(format!("  [{}] {} — {}",
                            c["index"].as_i64()?,
                            c["node_name"].as_str()?,
                            c["rationale"].as_str().unwrap_or("")))
                    }).collect::<Vec<_>>().join("\n");
                    let text = if cite_text.is_empty() {
                        answer
                    } else {
                        format!("{}\n\nCitations:\n{}", answer, cite_text)
                    };
                    json!({ "content": [{ "type": "text", "text": text }] })
                }
                Err(e) => json!({ "isError": true, "content": [{ "type": "text", "text": format!("Failed to parse response: {}", e) }] }),
            },
            Err(e) => json!({ "isError": true, "content": [{ "type": "text", "text": format!("Request failed: {}", e) }] }),
        }
    }

    pub(crate) fn tool_live_impacts(_args: Value) -> Value {
        match crate::live_sync::fetch_impacts_json() {
            Ok(data) => {
                let toon_text = aura_toon::encode(&data);
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
                let toon_text = aura_toon::encode(&resp);
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
                let toon_text = aura_toon::encode(&data);
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
                        parent_hash: None,
                        ..Default::default()
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
                let toon_text = aura_toon::encode(&data);
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
        let toon_text = aura_toon::encode(&status);
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

        let claim_kind = match mode {
            crate::sentinel::ZoneMode::Block => "block",
            _ => "warn",
        };
        let zone = crate::sentinel::SentinelManager::create_zone(&session_id, patterns.clone(), mode);

        let mut cloud_note = String::new();
        if crate::cloud_zones::cloud_routed_for_current_repo() {
            let mut ok = 0usize;
            let mut errs: Vec<String> = Vec::new();
            for p in &patterns {
                match crate::cloud_zones::claim_zone(p, claim_kind) {
                    Ok(_) => ok += 1,
                    Err(e) => errs.push(e),
                }
            }
            cloud_note = if errs.is_empty() {
                format!(" Cloud: {}/{} claimed.", ok, patterns.len())
            } else {
                format!(" Cloud: {}/{} claimed ({} error(s), first: {}).", ok, patterns.len(), errs.len(), errs[0])
            };
        }

        json!({ "content": [{ "type": "text", "text": format!(
            "Zone '{}' created for session {}. Patterns: {:?}, Mode: {:?}.{}",
            zone.zone_id, zone.session_id, zone.patterns, zone.mode, cloud_note
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
                // W2: optional code anchor `<path>#<identifier>` — stamps a
                // content fingerprint so reads can flag the memory stale
                // when the symbol drifts.
                let symbol = args["symbol"].as_str();
                let id = crate::memory::MemoryManager::add_entry_with_symbol(
                    section, content, tags, &agent, symbol,
                );
                let anchored = match symbol {
                    Some(s) => format!(" (anchored to {})", s),
                    None => String::new(),
                };
                json!({ "content": [{ "type": "text", "text": format!("Memory '{}' added to '{}' section{}.", id, section, anchored) }] })
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
            let toon_text = aura_toon::encode(&data);
            json!({ "content": [{ "type": "text", "text": toon_text }] })
        } else {
            let full = crate::memory::MemoryManager::full_view();
            let toon_text = aura_toon::encode(&full);
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

    /// S1-G — `aura_refs(symbol, files)`. Builds a stack-graph over
    /// the supplied files and returns every reference that resolves
    /// to a definition for the given symbol. Caller passes the file
    /// set explicitly so the MCP surface stays stateless; later
    /// phases will swap to a SQLite-backed index that keys off repo
    /// + commit, at which point this signature simplifies to
    /// `(symbol, repo?, commit?)`.
    fn tool_refs(args: Value) -> Value {
        Self::tool_stackgraph_query(args, /*defs_only=*/ false)
    }

    /// S1-G — `aura_defs(symbol, files)`. Same indexing pipeline as
    /// `aura_refs`; returns definition sites instead of resolved
    /// reference tuples.
    fn tool_defs(args: Value) -> Value {
        Self::tool_stackgraph_query(args, /*defs_only=*/ true)
    }

    /// Phase 1 — surface the distilled Taste Engine rules to agents.
    /// Returns only Active + Provisional rules (plus user-approved
    /// candidates so a freshly approved rule appears immediately),
    /// optionally filtered by file_path scope. Output is plain JSON,
    /// not toon-encoded, because the receiver is usually another agent
    /// that will pattern-match on field names.
    fn tool_taste_rules(args: Value) -> Value {
        let limit = args.get("limit").and_then(|v| v.as_u64()).unwrap_or(10) as usize;

        let repo_root = match git2::Repository::discover(".") {
            Ok(r) => match r.workdir() {
                Some(w) => w.to_path_buf(),
                None => return json!({ "isError": true, "content": [{ "type": "text", "text": "bare repo — no workdir" }] }),
            },
            Err(e) => return json!({ "isError": true, "content": [{ "type": "text", "text": format!("not a git repo: {}", e) }] }),
        };

        let rules: Vec<crate::taste::aggregate::Rule> = if let Some(file_path) = args.get("file_path").and_then(|v| v.as_str()) {
            crate::taste::aggregate::rules_for_path(&repo_root, file_path)
        } else {
            crate::taste::aggregate::load_rules(&repo_root).rules
        };

        let payload: Vec<serde_json::Value> = rules
            .into_iter()
            .filter(|r| !matches!(r.status, crate::taste::aggregate::RuleStatus::Deprecated))
            .take(limit)
            .map(|r| serde_json::json!({
                "id": r.id,
                "statement": r.statement,
                "template": r.template,
                "language": r.language,
                "layer": r.layer,
                "confidence": r.confidence,
                "status": match r.status {
                    crate::taste::aggregate::RuleStatus::Active => "active",
                    crate::taste::aggregate::RuleStatus::Provisional => "provisional",
                    crate::taste::aggregate::RuleStatus::Candidate => "candidate",
                    crate::taste::aggregate::RuleStatus::Deprecated => "deprecated",
                },
                "user_approved": r.user_approved,
                "support": r.positive_weight,
            }))
            .collect();

        let text = if payload.is_empty() {
            "No taste rules learned yet. Make a few commits and the post-commit hook will start mining patterns.".to_string()
        } else {
            serde_json::to_string_pretty(&payload).unwrap_or_default()
        };
        json!({ "content": [{ "type": "text", "text": text }] })
    }

    fn tool_stackgraph_query(args: Value, defs_only: bool) -> Value {
        let symbol = match args.get("symbol").and_then(|v| v.as_str()) {
            Some(s) if !s.trim().is_empty() => s.to_string(),
            _ => {
                return json!({
                    "isError": true,
                    "content": [{ "type": "text", "text": "missing required `symbol` (non-empty string)" }]
                });
            }
        };
        let files_raw = match args.get("files").and_then(|v| v.as_array()) {
            Some(a) if !a.is_empty() => a.clone(),
            _ => {
                return json!({
                    "isError": true,
                    "content": [{ "type": "text", "text": "missing required `files` (non-empty array of {path, source})" }]
                });
            }
        };
        for entry in &files_raw {
            let path = entry.get("path").and_then(|v| v.as_str()).unwrap_or("");
            if path.is_empty() {
                return json!({
                    "isError": true,
                    "content": [{ "type": "text", "text": "each file entry must include a non-empty `path`" }]
                });
            }
        }
        // aura-stackgraph runs out-of-process: stack-graphs pins
        // tree-sitter 0.24 and our parser stack pins 0.26, which
        // collide on `links = "tree-sitter"`. The standalone binary
        // accepts `{symbol, kind, files}` on stdin and returns the
        // same `{symbol, kind, count, rows, indexed_files}` envelope
        // on stdout — same shape we'd build in-process.
        let kind = if defs_only { "defs" } else { "refs" };
        let request = json!({
            "symbol": symbol,
            "kind": kind,
            "files": files_raw,
        });
        let bin = std::env::var("AURA_STACKGRAPH_BIN")
            .unwrap_or_else(|_| "aura-stackgraph".to_string());
        let mut child = match std::process::Command::new(&bin)
            .arg("query")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
        {
            Ok(c) => c,
            Err(e) => {
                return json!({
                    "isError": true,
                    "content": [{ "type": "text", "text": format!(
                        "aura-stackgraph binary not found ({}). Install via `cargo install --path aura-stackgraph` or set AURA_STACKGRAPH_BIN. Underlying: {}",
                        bin, e
                    ) }]
                });
            }
        };
        if let Some(mut stdin) = child.stdin.take() {
            use std::io::Write;
            if let Err(e) = stdin.write_all(request.to_string().as_bytes()) {
                return json!({
                    "isError": true,
                    "content": [{ "type": "text", "text": format!("write to aura-stackgraph stdin failed: {}", e) }]
                });
            }
        }
        let output = match child.wait_with_output() {
            Ok(o) => o,
            Err(e) => {
                return json!({
                    "isError": true,
                    "content": [{ "type": "text", "text": format!("aura-stackgraph wait failed: {}", e) }]
                });
            }
        };
        if !output.status.success() {
            let err = String::from_utf8_lossy(&output.stderr);
            return json!({
                "isError": true,
                "content": [{ "type": "text", "text": format!("aura-stackgraph exited {}: {}", output.status, err) }]
            });
        }
        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        let parsed: serde_json::Value = serde_json::from_str(&stdout)
            .unwrap_or_else(|_| json!({ "raw": stdout }));
        let pretty = serde_json::to_string_pretty(&parsed).unwrap_or(stdout);
        json!({ "content": [{ "type": "text", "text": pretty }] })
    }

    /// Bet 1 Phase C — proxies POST /api/v2/episodic/narrate. Cloud-side
    /// because narration may call an LLM keyed at the org level, and the
    /// AI key never leaves the cloud. Returns the raw response so agents
    /// can read both the narration string and the per-type counts.
    fn tool_episodic_narrate(args: Value) -> Value {
        let config = crate::config::ConfigManager::load();
        let token = match config.cloud_api_token
            .clone()
            .or_else(|| std::env::var("AURA_CLOUD_TOKEN").ok())
        {
            Some(t) => t,
            None => return json!({ "isError": true, "content": [{ "type": "text", "text": "No cloud token configured. Run `aura cloud login`." }] }),
        };
        let cloud_url = config.cloud_url.unwrap_or_else(|| "https://auravcs.com".to_string());
        let url = format!("{}/api/v2/episodic/narrate", cloud_url.trim_end_matches('/'));
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .unwrap_or_else(|_| reqwest::blocking::Client::new());
        match client
            .post(&url)
            .header("Authorization", format!("Bearer {}", token))
            .json(&args)
            .send()
        {
            Ok(resp) => {
                let status = resp.status();
                match resp.json::<Value>() {
                    Ok(v) => {
                        if !status.is_success() {
                            return json!({ "isError": true, "content": [{ "type": "text", "text": format!("narrate HTTP {}: {}", status, v) }] });
                        }
                        let pretty = serde_json::to_string_pretty(&v).unwrap_or_else(|_| v.to_string());
                        json!({ "content": [{ "type": "text", "text": pretty }] })
                    }
                    Err(e) => json!({ "isError": true, "content": [{ "type": "text", "text": format!("narrate parse failed (HTTP {}): {}", status, e) }] }),
                }
            }
            Err(e) => json!({ "isError": true, "content": [{ "type": "text", "text": format!("narrate request failed: {}", e) }] }),
        }
    }

    /// Bet 1 Phase E — proxies GET /api/v2/episodic/timeline. Read-only
    /// per-function materialized view: counts_by_type, by_day buckets,
    /// agents_seen, plus the events slice. function_name is required.
    fn tool_episodic_timeline(args: Value) -> Value {
        let function_name = match args.get("function_name").and_then(|v| v.as_str()) {
            Some(s) if !s.trim().is_empty() => s.to_string(),
            _ => return json!({ "isError": true, "content": [{ "type": "text", "text": "function_name is required." }] }),
        };
        let config = crate::config::ConfigManager::load();
        let token = match config.cloud_api_token
            .clone()
            .or_else(|| std::env::var("AURA_CLOUD_TOKEN").ok())
        {
            Some(t) => t,
            None => return json!({ "isError": true, "content": [{ "type": "text", "text": "No cloud token configured. Run `aura cloud login`." }] }),
        };
        let cloud_url = config.cloud_url.unwrap_or_else(|| "https://auravcs.com".to_string());
        let mut url = format!(
            "{}/api/v2/episodic/timeline?function_name={}",
            cloud_url.trim_end_matches('/'),
            percent_encode_unreserved(&function_name)
        );
        if let Some(w) = args.get("window_hours").and_then(|v| v.as_i64()) {
            url.push_str(&format!("&window_hours={w}"));
        }
        if let Some(r) = args.get("repo").and_then(|v| v.as_str()) {
            if !r.trim().is_empty() {
                url.push_str(&format!("&repo={}", percent_encode_unreserved(r)));
            }
        }
        if let Some(l) = args.get("limit").and_then(|v| v.as_i64()) {
            url.push_str(&format!("&limit={l}"));
        }
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(20))
            .build()
            .unwrap_or_else(|_| reqwest::blocking::Client::new());
        match client
            .get(&url)
            .header("Authorization", format!("Bearer {}", token))
            .send()
        {
            Ok(resp) => {
                let status = resp.status();
                match resp.json::<Value>() {
                    Ok(v) => {
                        if !status.is_success() {
                            return json!({ "isError": true, "content": [{ "type": "text", "text": format!("timeline HTTP {}: {}", status, v) }] });
                        }
                        let pretty = serde_json::to_string_pretty(&v).unwrap_or_else(|_| v.to_string());
                        json!({ "content": [{ "type": "text", "text": pretty }] })
                    }
                    Err(e) => json!({ "isError": true, "content": [{ "type": "text", "text": format!("timeline parse failed (HTTP {}): {}", status, e) }] }),
                }
            }
            Err(e) => json!({ "isError": true, "content": [{ "type": "text", "text": format!("timeline request failed: {}", e) }] }),
        }
    }

    /// Bet 1 Phase G — proxies GET /api/v2/episodic/agent-digest. Same
    /// shape contract as `tool_episodic_timeline`: read-only,
    /// network-reaching, returns the cloud's structured response under
    /// MCP `content[0].text` so the caller can `JSON.parse` it.
    fn tool_episodic_agent_digest(args: Value) -> Value {
        let agent_id = match args.get("agent_id").and_then(|v| v.as_str()) {
            Some(s) if !s.trim().is_empty() => s.to_string(),
            _ => return json!({ "isError": true, "content": [{ "type": "text", "text": "agent_id is required." }] }),
        };
        let config = crate::config::ConfigManager::load();
        let token = match config.cloud_api_token
            .clone()
            .or_else(|| std::env::var("AURA_CLOUD_TOKEN").ok())
        {
            Some(t) => t,
            None => return json!({ "isError": true, "content": [{ "type": "text", "text": "No cloud token configured. Run `aura cloud login`." }] }),
        };
        let cloud_url = config.cloud_url.unwrap_or_else(|| "https://auravcs.com".to_string());
        let mut url = format!(
            "{}/api/v2/episodic/agent-digest?agent_id={}",
            cloud_url.trim_end_matches('/'),
            percent_encode_unreserved(&agent_id)
        );
        if let Some(w) = args.get("window_hours").and_then(|v| v.as_i64()) {
            url.push_str(&format!("&window_hours={w}"));
        }
        if let Some(r) = args.get("repo").and_then(|v| v.as_str()) {
            if !r.trim().is_empty() {
                url.push_str(&format!("&repo={}", percent_encode_unreserved(r)));
            }
        }
        if let Some(l) = args.get("limit").and_then(|v| v.as_i64()) {
            url.push_str(&format!("&limit={l}"));
        }
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(20))
            .build()
            .unwrap_or_else(|_| reqwest::blocking::Client::new());
        match client
            .get(&url)
            .header("Authorization", format!("Bearer {}", token))
            .send()
        {
            Ok(resp) => {
                let status = resp.status();
                match resp.json::<Value>() {
                    Ok(v) => {
                        if !status.is_success() {
                            return json!({ "isError": true, "content": [{ "type": "text", "text": format!("agent-digest HTTP {}: {}", status, v) }] });
                        }
                        let pretty = serde_json::to_string_pretty(&v).unwrap_or_else(|_| v.to_string());
                        json!({ "content": [{ "type": "text", "text": pretty }] })
                    }
                    Err(e) => json!({ "isError": true, "content": [{ "type": "text", "text": format!("agent-digest parse failed (HTTP {}): {}", status, e) }] }),
                }
            }
            Err(e) => json!({ "isError": true, "content": [{ "type": "text", "text": format!("agent-digest request failed: {}", e) }] }),
        }
    }

    /// S2-MS — proxies GET /api/v2/episodic/multi-session-arc. Same
    /// shape contract as `tool_episodic_session_arc` but takes a
    /// comma-separated agent_ids list and returns the merged timeline.
    fn tool_episodic_multi_session_arc(args: Value) -> Value {
        let agent_ids = match args.get("agent_ids").and_then(|v| v.as_str()) {
            Some(s) if !s.trim().is_empty() => s.to_string(),
            _ => return json!({ "isError": true, "content": [{ "type": "text", "text": "agent_ids is required (comma-separated list)." }] }),
        };
        let config = crate::config::ConfigManager::load();
        let token = match config.cloud_api_token
            .clone()
            .or_else(|| std::env::var("AURA_CLOUD_TOKEN").ok())
        {
            Some(t) => t,
            None => return json!({ "isError": true, "content": [{ "type": "text", "text": "No cloud token configured. Run `aura cloud login`." }] }),
        };
        let cloud_url = config.cloud_url.unwrap_or_else(|| "https://auravcs.com".to_string());
        let mut url = format!(
            "{}/api/v2/episodic/multi-session-arc?agent_ids={}",
            cloud_url.trim_end_matches('/'),
            percent_encode_unreserved(&agent_ids)
        );
        if let Some(w) = args.get("window_hours").and_then(|v| v.as_i64()) {
            url.push_str(&format!("&window_hours={w}"));
        }
        if let Some(g) = args.get("gap_minutes").and_then(|v| v.as_i64()) {
            url.push_str(&format!("&gap_minutes={g}"));
        }
        if let Some(r) = args.get("repo").and_then(|v| v.as_str()) {
            if !r.trim().is_empty() {
                url.push_str(&format!("&repo={}", percent_encode_unreserved(r)));
            }
        }
        if let Some(l) = args.get("limit").and_then(|v| v.as_i64()) {
            url.push_str(&format!("&limit={l}"));
        }
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(20))
            .build()
            .unwrap_or_else(|_| reqwest::blocking::Client::new());
        match client
            .get(&url)
            .header("Authorization", format!("Bearer {}", token))
            .send()
        {
            Ok(resp) => {
                let status = resp.status();
                match resp.json::<Value>() {
                    Ok(v) => {
                        if !status.is_success() {
                            return json!({ "isError": true, "content": [{ "type": "text", "text": format!("multi-session-arc HTTP {}: {}", status, v) }] });
                        }
                        let pretty = serde_json::to_string_pretty(&v).unwrap_or_else(|_| v.to_string());
                        json!({ "content": [{ "type": "text", "text": pretty }] })
                    }
                    Err(e) => json!({ "isError": true, "content": [{ "type": "text", "text": format!("multi-session-arc parse failed (HTTP {}): {}", status, e) }] }),
                }
            }
            Err(e) => json!({ "isError": true, "content": [{ "type": "text", "text": format!("multi-session-arc request failed: {}", e) }] }),
        }
    }

    /// S2-SA — proxies GET /api/v2/episodic/session-arc. Same shape
    /// contract as `tool_episodic_agent_digest`: read-only,
    /// network-reaching, returns the cloud's structured response under
    /// MCP `content[0].text`. Required arg: agent_id (which doubles as
    /// session id, matching the cloud schema's per-row identifier).
    fn tool_episodic_session_arc(args: Value) -> Value {
        let agent_id = match args.get("agent_id").and_then(|v| v.as_str()) {
            Some(s) if !s.trim().is_empty() => s.to_string(),
            _ => return json!({ "isError": true, "content": [{ "type": "text", "text": "agent_id is required." }] }),
        };
        let config = crate::config::ConfigManager::load();
        let token = match config.cloud_api_token
            .clone()
            .or_else(|| std::env::var("AURA_CLOUD_TOKEN").ok())
        {
            Some(t) => t,
            None => return json!({ "isError": true, "content": [{ "type": "text", "text": "No cloud token configured. Run `aura cloud login`." }] }),
        };
        let cloud_url = config.cloud_url.unwrap_or_else(|| "https://auravcs.com".to_string());
        let mut url = format!(
            "{}/api/v2/episodic/session-arc?agent_id={}",
            cloud_url.trim_end_matches('/'),
            percent_encode_unreserved(&agent_id)
        );
        if let Some(w) = args.get("window_hours").and_then(|v| v.as_i64()) {
            url.push_str(&format!("&window_hours={w}"));
        }
        if let Some(g) = args.get("gap_minutes").and_then(|v| v.as_i64()) {
            url.push_str(&format!("&gap_minutes={g}"));
        }
        if let Some(r) = args.get("repo").and_then(|v| v.as_str()) {
            if !r.trim().is_empty() {
                url.push_str(&format!("&repo={}", percent_encode_unreserved(r)));
            }
        }
        if let Some(l) = args.get("limit").and_then(|v| v.as_i64()) {
            url.push_str(&format!("&limit={l}"));
        }
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(20))
            .build()
            .unwrap_or_else(|_| reqwest::blocking::Client::new());
        match client
            .get(&url)
            .header("Authorization", format!("Bearer {}", token))
            .send()
        {
            Ok(resp) => {
                let status = resp.status();
                match resp.json::<Value>() {
                    Ok(v) => {
                        if !status.is_success() {
                            return json!({ "isError": true, "content": [{ "type": "text", "text": format!("session-arc HTTP {}: {}", status, v) }] });
                        }
                        let pretty = serde_json::to_string_pretty(&v).unwrap_or_else(|_| v.to_string());
                        json!({ "content": [{ "type": "text", "text": pretty }] })
                    }
                    Err(e) => json!({ "isError": true, "content": [{ "type": "text", "text": format!("session-arc parse failed (HTTP {}): {}", status, e) }] }),
                }
            }
            Err(e) => json!({ "isError": true, "content": [{ "type": "text", "text": format!("session-arc request failed: {}", e) }] }),
        }
    }

    /// S2-ER — proxies GET /api/v2/episodic/recall. Same shape contract
    /// as `tool_episodic_timeline` and `tool_episodic_agent_digest`:
    /// read-only, network-reaching, returns the cloud's structured
    /// response under MCP `content[0].text` so the caller can JSON.parse
    /// it. All filters are optional — when none are supplied the cloud
    /// returns the unfiltered window. Named `_cloud` to disambiguate
    /// from the older local-only `aura_episodic_recall` (which reads
    /// .aura/intent_log.jsonl + sentinel + snapshot metadata directly).
    fn tool_episodic_recall_cloud(args: Value) -> Value {
        let config = crate::config::ConfigManager::load();
        let token = match config.cloud_api_token
            .clone()
            .or_else(|| std::env::var("AURA_CLOUD_TOKEN").ok())
        {
            Some(t) => t,
            None => return json!({ "isError": true, "content": [{ "type": "text", "text": "No cloud token configured. Run `aura cloud login`." }] }),
        };
        let cloud_url = config.cloud_url.unwrap_or_else(|| "https://auravcs.com".to_string());
        let mut url = format!("{}/api/v2/episodic/recall", cloud_url.trim_end_matches('/'));
        let mut sep = '?';
        let mut push_str = |k: &str, v: &str, sep: &mut char| {
            if v.trim().is_empty() {
                return;
            }
            url.push(*sep);
            url.push_str(k);
            url.push('=');
            url.push_str(&percent_encode_unreserved(v));
            *sep = '&';
        };
        if let Some(s) = args.get("event_type").and_then(|v| v.as_str()) {
            push_str("event_type", s, &mut sep);
        }
        if let Some(s) = args.get("agent_id").and_then(|v| v.as_str()) {
            push_str("agent_id", s, &mut sep);
        }
        if let Some(s) = args.get("focus_fn").and_then(|v| v.as_str()) {
            push_str("focus_fn", s, &mut sep);
        }
        if let Some(s) = args.get("focus_file").and_then(|v| v.as_str()) {
            push_str("focus_file", s, &mut sep);
        }
        if let Some(s) = args.get("repo").and_then(|v| v.as_str()) {
            push_str("repo", s, &mut sep);
        }
        // S2-TICRD: forward the canonical intent_type filter so the
        // closed-vocabulary recall path (S2-TICR) is callable from MCP
        // without dropping back to raw HTTP. The cloud handler
        // validates against CANONICAL_INTENT_TYPES and returns 400 on a
        // typo, which the existing error path surfaces as `isError` —
        // no extra validation needed here.
        if let Some(s) = args.get("intent_type").and_then(|v| v.as_str()) {
            push_str("intent_type", s, &mut sep);
        }
        if let Some(w) = args.get("window_hours").and_then(|v| v.as_i64()) {
            url.push(sep);
            url.push_str(&format!("window_hours={w}"));
            sep = '&';
        }
        if let Some(l) = args.get("limit").and_then(|v| v.as_i64()) {
            url.push(sep);
            url.push_str(&format!("limit={l}"));
        }
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(20))
            .build()
            .unwrap_or_else(|_| reqwest::blocking::Client::new());
        match client
            .get(&url)
            .header("Authorization", format!("Bearer {}", token))
            .send()
        {
            Ok(resp) => {
                let status = resp.status();
                match resp.json::<Value>() {
                    Ok(v) => {
                        if !status.is_success() {
                            return json!({ "isError": true, "content": [{ "type": "text", "text": format!("recall HTTP {}: {}", status, v) }] });
                        }
                        let pretty = serde_json::to_string_pretty(&v).unwrap_or_else(|_| v.to_string());
                        json!({ "content": [{ "type": "text", "text": pretty }] })
                    }
                    Err(e) => json!({ "isError": true, "content": [{ "type": "text", "text": format!("recall parse failed (HTTP {}): {}", status, e) }] }),
                }
            }
            Err(e) => json!({ "isError": true, "content": [{ "type": "text", "text": format!("recall request failed: {}", e) }] }),
        }
    }

    /// Bet 4 Phase C — proxies GET /api/v2/impacts/cross-repo. Read-only
    /// lookup; no AI involved. Returns the raw cloud response so callers
    /// see {function_name, total_matches, returned, repos_touched, matches[]}.
    fn tool_impacts_cross_repo(args: Value) -> Value {
        let function_name = match args.get("function_name").and_then(|v| v.as_str()) {
            Some(s) if !s.trim().is_empty() => s.to_string(),
            _ => return json!({ "isError": true, "content": [{ "type": "text", "text": "function_name is required." }] }),
        };
        let config = crate::config::ConfigManager::load();
        let token = match config.cloud_api_token
            .clone()
            .or_else(|| std::env::var("AURA_CLOUD_TOKEN").ok())
        {
            Some(t) => t,
            None => return json!({ "isError": true, "content": [{ "type": "text", "text": "No cloud token configured. Run `aura cloud login`." }] }),
        };
        let cloud_url = config.cloud_url.unwrap_or_else(|| "https://auravcs.com".to_string());
        let mut url = format!(
            "{}/api/v2/impacts/cross-repo?function_name={}",
            cloud_url.trim_end_matches('/'),
            percent_encode_unreserved(&function_name)
        );
        if let Some(s) = args.get("exclude_repo").and_then(|v| v.as_str()) {
            url.push_str(&format!("&exclude_repo={}", percent_encode_unreserved(s)));
        }
        if let Some(s) = args.get("branch").and_then(|v| v.as_str()) {
            url.push_str(&format!("&branch={}", percent_encode_unreserved(s)));
        }
        if let Some(n) = args.get("limit").and_then(|v| v.as_i64()) {
            url.push_str(&format!("&limit={n}"));
        }
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(20))
            .build()
            .unwrap_or_else(|_| reqwest::blocking::Client::new());
        match client
            .get(&url)
            .header("Authorization", format!("Bearer {}", token))
            .send()
        {
            Ok(resp) => {
                let status = resp.status();
                match resp.json::<Value>() {
                    Ok(v) => {
                        if !status.is_success() {
                            return json!({ "isError": true, "content": [{ "type": "text", "text": format!("cross-repo HTTP {}: {}", status, v) }] });
                        }
                        let pretty = serde_json::to_string_pretty(&v).unwrap_or_else(|_| v.to_string());
                        json!({ "content": [{ "type": "text", "text": pretty }] })
                    }
                    Err(e) => json!({ "isError": true, "content": [{ "type": "text", "text": format!("cross-repo parse failed (HTTP {}): {}", status, e) }] }),
                }
            }
            Err(e) => json!({ "isError": true, "content": [{ "type": "text", "text": format!("cross-repo request failed: {}", e) }] }),
        }
    }

    /// Bet 2 Phase D — proxies POST /api/v2/a2a/tasks. Caller hands
    /// `{agent_kind, input, repo?, context_id?, metadata?}`; cloud
    /// stamps id + status="submitted". The id is what aura_a2a_task_get
    /// then polls.
    fn tool_a2a_task_create(args: Value) -> Value {
        let config = crate::config::ConfigManager::load();
        let token = match config.cloud_api_token
            .clone()
            .or_else(|| std::env::var("AURA_CLOUD_TOKEN").ok())
        {
            Some(t) => t,
            None => return json!({ "isError": true, "content": [{ "type": "text", "text": "No cloud token configured. Run `aura cloud login`." }] }),
        };
        let cloud_url = config.cloud_url.unwrap_or_else(|| "https://auravcs.com".to_string());
        let url = format!("{}/api/v2/a2a/tasks", cloud_url.trim_end_matches('/'));
        // Bucket-K default: the server rejects plan/wave/task without a
        // non-empty acceptance_criteria (400). Callers that pass neither a
        // task_kind nor acceptance_criteria mean "just run this" — mint a
        // `subtask` (a leaf, no AC required) so agents/CLI can create cloud
        // tasks without spelling out the hierarchy.
        let mut body = args;
        if let Some(obj) = body.as_object_mut() {
            let has_kind = obj
                .get("task_kind")
                .and_then(|v| v.as_str())
                .map(|s| !s.trim().is_empty())
                .unwrap_or(false);
            let has_ac = obj
                .get("acceptance_criteria")
                .and_then(|v| v.as_array())
                .map(|a| !a.is_empty())
                .unwrap_or(false);
            if !has_kind && !has_ac {
                obj.insert("task_kind".to_string(), json!("subtask"));
            }
        }
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(20))
            .build()
            .unwrap_or_else(|_| reqwest::blocking::Client::new());
        match client
            .post(&url)
            .header("Authorization", format!("Bearer {}", token))
            .json(&body)
            .send()
        {
            Ok(resp) => {
                let status = resp.status();
                // Read the raw body once, then try to parse. An error body may
                // be empty or plain text (not JSON) — reporting the text keeps
                // the real cause visible instead of a misleading parse error.
                let body_text = resp.text().unwrap_or_default();
                match serde_json::from_str::<Value>(&body_text) {
                    Ok(v) => {
                        if !status.is_success() {
                            return json!({ "isError": true, "content": [{ "type": "text", "text": format!("a2a-task-create HTTP {}: {}", status, v) }] });
                        }
                        let pretty = serde_json::to_string_pretty(&v).unwrap_or_else(|_| v.to_string());
                        json!({ "content": [{ "type": "text", "text": pretty }] })
                    }
                    Err(_) => json!({ "isError": true, "content": [{ "type": "text", "text": format!("a2a-task-create HTTP {}: {}", status, if body_text.trim().is_empty() { "(empty response body)" } else { body_text.trim() }) }] }),
                }
            }
            Err(e) => json!({ "isError": true, "content": [{ "type": "text", "text": format!("a2a-task-create request failed: {}", e) }] }),
        }
    }

    /// Bet 2 Phase D — proxies GET /api/v2/a2a/tasks/{id}. Read-only;
    /// idempotent. 404 cleanly surfaces as an isError envelope so a
    /// polling loop can decide whether to retry.
    fn tool_a2a_task_get(args: Value) -> Value {
        let id = match args.get("id").and_then(|v| v.as_str()) {
            Some(s) if !s.trim().is_empty() => s.to_string(),
            _ => return json!({ "isError": true, "content": [{ "type": "text", "text": "id is required." }] }),
        };
        let config = crate::config::ConfigManager::load();
        let token = match config.cloud_api_token
            .clone()
            .or_else(|| std::env::var("AURA_CLOUD_TOKEN").ok())
        {
            Some(t) => t,
            None => return json!({ "isError": true, "content": [{ "type": "text", "text": "No cloud token configured. Run `aura cloud login`." }] }),
        };
        let cloud_url = config.cloud_url.unwrap_or_else(|| "https://auravcs.com".to_string());
        // Path segment encoding — UUIDs are URL-safe, but a defensive
        // pass keeps the endpoint robust if a non-UUID id ever arrives.
        let safe_id: String = id
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
            .collect();
        if safe_id.is_empty() {
            return json!({ "isError": true, "content": [{ "type": "text", "text": "id contains no url-safe characters" }] });
        }
        let url = format!("{}/api/v2/a2a/tasks/{}", cloud_url.trim_end_matches('/'), safe_id);
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(20))
            .build()
            .unwrap_or_else(|_| reqwest::blocking::Client::new());
        match client
            .get(&url)
            .header("Authorization", format!("Bearer {}", token))
            .send()
        {
            Ok(resp) => {
                let status = resp.status();
                match resp.json::<Value>() {
                    Ok(v) => {
                        if !status.is_success() {
                            return json!({ "isError": true, "content": [{ "type": "text", "text": format!("a2a-task-get HTTP {}: {}", status, v) }] });
                        }
                        let pretty = serde_json::to_string_pretty(&v).unwrap_or_else(|_| v.to_string());
                        json!({ "content": [{ "type": "text", "text": pretty }] })
                    }
                    Err(e) => json!({ "isError": true, "content": [{ "type": "text", "text": format!("a2a-task-get parse failed (HTTP {}): {}", status, e) }] }),
                }
            }
            Err(e) => json!({ "isError": true, "content": [{ "type": "text", "text": format!("a2a-task-get request failed: {}", e) }] }),
        }
    }

    /// Bet 2 Phase D — proxies GET /api/v2/a2a/tasks. Filters: status,
    /// repo, limit. Read-only, idempotent.
    fn tool_a2a_task_list(args: Value) -> Value {
        let config = crate::config::ConfigManager::load();
        let token = match config.cloud_api_token
            .clone()
            .or_else(|| std::env::var("AURA_CLOUD_TOKEN").ok())
        {
            Some(t) => t,
            None => return json!({ "isError": true, "content": [{ "type": "text", "text": "No cloud token configured. Run `aura cloud login`." }] }),
        };
        let cloud_url = config.cloud_url.unwrap_or_else(|| "https://auravcs.com".to_string());
        let url = build_a2a_task_list_url(cloud_url.trim_end_matches('/'), &args);
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(20))
            .build()
            .unwrap_or_else(|_| reqwest::blocking::Client::new());
        match client
            .get(&url)
            .header("Authorization", format!("Bearer {}", token))
            .send()
        {
            Ok(resp) => {
                let status = resp.status();
                match resp.json::<Value>() {
                    Ok(v) => {
                        if !status.is_success() {
                            return json!({ "isError": true, "content": [{ "type": "text", "text": format!("a2a-task-list HTTP {}: {}", status, v) }] });
                        }
                        let pretty = serde_json::to_string_pretty(&v).unwrap_or_else(|_| v.to_string());
                        json!({ "content": [{ "type": "text", "text": pretty }] })
                    }
                    Err(e) => json!({ "isError": true, "content": [{ "type": "text", "text": format!("a2a-task-list parse failed (HTTP {}): {}", status, e) }] }),
                }
            }
            Err(e) => json!({ "isError": true, "content": [{ "type": "text", "text": format!("a2a-task-list request failed: {}", e) }] }),
        }
    }

    /// Bet 2 Phase D — proxies PATCH /api/v2/a2a/tasks/{id}. Body carries
    /// any subset of {status, result, error_message}. Terminal states are
    /// sticky cloud-side: re-patching a completed/failed/canceled/rejected
    /// task surfaces as HTTP 409 in an isError envelope.
    fn tool_a2a_task_patch(args: Value) -> Value {
        let id = match args.get("id").and_then(|v| v.as_str()) {
            Some(s) if !s.trim().is_empty() => s.to_string(),
            _ => return json!({ "isError": true, "content": [{ "type": "text", "text": "id is required." }] }),
        };
        let config = crate::config::ConfigManager::load();
        let token = match config.cloud_api_token
            .clone()
            .or_else(|| std::env::var("AURA_CLOUD_TOKEN").ok())
        {
            Some(t) => t,
            None => return json!({ "isError": true, "content": [{ "type": "text", "text": "No cloud token configured. Run `aura cloud login`." }] }),
        };
        let cloud_url = config.cloud_url.unwrap_or_else(|| "https://auravcs.com".to_string());
        let safe_id: String = id
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
            .collect();
        if safe_id.is_empty() {
            return json!({ "isError": true, "content": [{ "type": "text", "text": "id contains no url-safe characters" }] });
        }
        let url = format!("{}/api/v2/a2a/tasks/{}", cloud_url.trim_end_matches('/'), safe_id);
        let body = build_a2a_task_patch_body(&args);
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(20))
            .build()
            .unwrap_or_else(|_| reqwest::blocking::Client::new());
        match client
            .patch(&url)
            .header("Authorization", format!("Bearer {}", token))
            .json(&Value::Object(body))
            .send()
        {
            Ok(resp) => {
                let status = resp.status();
                match resp.json::<Value>() {
                    Ok(v) => {
                        if !status.is_success() {
                            return json!({ "isError": true, "content": [{ "type": "text", "text": format!("a2a-task-patch HTTP {}: {}", status, v) }] });
                        }
                        let pretty = serde_json::to_string_pretty(&v).unwrap_or_else(|_| v.to_string());
                        json!({ "content": [{ "type": "text", "text": pretty }] })
                    }
                    Err(e) => json!({ "isError": true, "content": [{ "type": "text", "text": format!("a2a-task-patch parse failed (HTTP {}): {}", status, e) }] }),
                }
            }
            Err(e) => json!({ "isError": true, "content": [{ "type": "text", "text": format!("a2a-task-patch request failed: {}", e) }] }),
        }
    }

    /// Read the work-loop's orderless pile, bucketed into focused chunks along
    /// the seams already in the data (epic → sprint → batch), so a huge board
    /// can be planned in FULL by the calling agent — who IS the planner here.
    /// Mirrors the desktop "plan an order" chunking via `aura_loop::planning`.
    pub(crate) fn tool_loop_plan_context(_args: Value) -> Value {
        let repo_root = match crate::goals::discover_repo_root()
            .or_else(|| std::env::current_dir().ok())
        {
            Some(p) => p,
            None => {
                return json!({ "isError": true, "content": [{ "type": "text", "text": "Not in a project folder." }] })
            }
        };
        let graph = aura_loop::LoopGraph::at(&repo_root);
        let all = graph.list();
        let ctx = aura_loop::planning::plan_context(&all);
        if ctx.chunks.is_empty() {
            return json!({ "content": [{ "type": "text", "text": format!(
                "{} orderless task(s) in the work graph — nothing to plan into a flow yet (you need at least two related tasks). Sync the board into the loop first if it looks empty.",
                ctx.considered
            ) }] });
        }
        // Resolve each chunk's ids to {id,title,detail} so the agent has the
        // full text to reason over — never just opaque ids.
        let chunks: Vec<Value> = ctx
            .chunks
            .iter()
            .map(|c| {
                let tasks: Vec<Value> = c
                    .node_ids
                    .iter()
                    .map(|id| {
                        let (title, detail) = graph
                            .get(id)
                            .map(|t| (t.title, t.input))
                            .unwrap_or_default();
                        json!({ "id": id, "title": title, "detail": detail })
                    })
                    .collect();
                json!({ "label": c.label, "seed_goal": c.seed_goal, "tasks": tasks })
            })
            .collect();
        let payload = json!({
            "considered": ctx.considered,
            "deferred": ctx.deferred,
            "chunk_count": chunks.len(),
            "chunks": chunks,
            "how_to_apply": "Within EACH chunk, work out the REAL dependencies — which task must finish before which others can start, only where one genuinely needs another's output (when in doubt, leave it independent). Name the goal each connected group of tasks adds up to, and group those goals under a few larger objectives (most projects have 2–6). Then call aura_loop_plan_apply with edges:[{task,depends_on}] using the task ids above, goals:[{goal,tasks:[ids]}], and objectives:[{objective,goals:[goal names]}]. You can apply once for everything or per chunk."
        });
        let text = serde_json::to_string_pretty(&payload).unwrap_or_else(|_| payload.to_string());
        json!({ "content": [{ "type": "text", "text": text }] })
    }

    /// Write a planned order back onto the work-loop graph: wire the edges
    /// (cycle-checked), name the goals, roll them up under objectives. The same
    /// graph the desktop "plan an order" button builds — applied by an agent.
    pub(crate) fn tool_loop_plan_apply(args: Value) -> Value {
        let repo_root = match crate::goals::discover_repo_root()
            .or_else(|| std::env::current_dir().ok())
        {
            Some(p) => p,
            None => {
                return json!({ "isError": true, "content": [{ "type": "text", "text": "Not in a project folder." }] })
            }
        };
        // Tolerant-but-honest parse: an absent field is empty; a malformed one
        // is reported, never silently dropped.
        let parse = |key: &str| -> Result<Value, String> {
            match args.get(key) {
                None | Some(Value::Null) => Ok(Value::Array(vec![])),
                Some(v) => Ok(v.clone()),
            }
            .and_then(|v| {
                if v.is_array() {
                    Ok(v)
                } else {
                    Err(format!("`{key}` must be an array"))
                }
            })
        };
        let edges_v = match parse("edges") {
            Ok(v) => v,
            Err(e) => return json!({ "isError": true, "content": [{ "type": "text", "text": e }] }),
        };
        let goals_v = match parse("goals") {
            Ok(v) => v,
            Err(e) => return json!({ "isError": true, "content": [{ "type": "text", "text": e }] }),
        };
        let objectives_v = match parse("objectives") {
            Ok(v) => v,
            Err(e) => return json!({ "isError": true, "content": [{ "type": "text", "text": e }] }),
        };
        let edges: Vec<aura_loop::planning::PlanEdge> = match serde_json::from_value(edges_v) {
            Ok(e) => e,
            Err(e) => return json!({ "isError": true, "content": [{ "type": "text", "text": format!("`edges` shape: {e}. Each edge is {{\"task\": id, \"depends_on\": id}}.") }] }),
        };
        let goals: Vec<aura_loop::planning::PlanGoal> = match serde_json::from_value(goals_v) {
            Ok(g) => g,
            Err(e) => return json!({ "isError": true, "content": [{ "type": "text", "text": format!("`goals` shape: {e}. Each goal is {{\"goal\": name, \"tasks\": [ids]}}.") }] }),
        };
        let objectives: Vec<aura_loop::planning::PlanObjective> = match serde_json::from_value(objectives_v) {
            Ok(o) => o,
            Err(e) => return json!({ "isError": true, "content": [{ "type": "text", "text": format!("`objectives` shape: {e}. Each objective is {{\"objective\": name, \"goals\": [goal names]}}.") }] }),
        };
        if edges.is_empty() && goals.is_empty() && objectives.is_empty() {
            return json!({ "isError": true, "content": [{ "type": "text", "text": "Nothing to apply — provide at least one of edges, goals, or objectives. Call aura_loop_plan_context first." }] });
        }
        let graph = aura_loop::LoopGraph::at(&repo_root);
        let report = aura_loop::planning::apply_plan(&graph, &edges, &goals, &objectives);
        let skipped = if report.skipped_edges > 0 {
            format!(" ({} skipped — self-edge, unknown id, or would form a cycle)", report.skipped_edges)
        } else {
            String::new()
        };
        let text = format!(
            "Plan applied to the work graph (.aura/a2a):\n\
             · {} dependency edge(s) wired{}\n\
             · {} task(s) now connected into a flow\n\
             · {} goal(s) named\n\
             · {} objective(s) rolled up\n\n\
             These edges drive the loop's ready-set and the Crew board flow — the same graph the desktop planner builds. Run `aura loop ready` (or open Crew) to see what's now ready to start.",
            report.edges, skipped, report.connected, report.goals, report.objectives
        );
        json!({ "content": [{ "type": "text", "text": text }] })
    }

    // ── Crew: the agent-facing work-loop surface ────────────────────────────
    //
    // These are the verbs a coding agent (Claude Code, etc.) uses to PLAN work
    // into Aura and to BE a worker draining it — the native answer to Beads +
    // a Ralph loop, but over a real dependency graph with leases, goal-proof and
    // a run ledger. Every crew response carries a live `crew` state envelope so
    // the agent always sees where the whole crew is at, not just the one node it
    // touched. See `crew_envelope`.

    /// Resolve the repo root for a crew tool, or the MCP "not in a project"
    /// error payload. Shared by every crew verb.
    fn crew_repo_root() -> Result<std::path::PathBuf, Value> {
        crate::goals::discover_repo_root()
            .or_else(|| std::env::current_dir().ok())
            .ok_or_else(|| json!({ "isError": true, "content": [{ "type": "text", "text": "Not in a project folder — open or cd into your repo first." }] }))
    }

    /// One graph node rendered for an agent: the full spec it needs to do the
    /// work, plus its place in the flow. Absent fields are omitted, never faked.
    fn crew_node_json(t: &aura_loop::LoopTask) -> Value {
        json!({
            "id": t.id,
            "title": t.title,
            "spec": t.input,
            "acceptance": t.acceptance_criteria,
            "priority": t.priority,
            "agent": t.agent_kind,
            "status": t.status,
            "waiting_on": t.depends_on,
            "goal": aura_loop::goal_of(t),
            "crew": aura_loop::crew_of(t),
        })
    }

    /// The live crew-state envelope attached to EVERY crew response: counts by
    /// lifecycle, who's working on what (agent + elapsed), what just landed
    /// (commit + goal-proof verdict — the thing Beads can't show), and what's
    /// next in the ready set. Scoped to one crew when `crew_filter` is given.
    fn crew_envelope(repo_root: &std::path::Path, crew_filter: Option<&str>) -> Value {
        let graph = aura_loop::LoopGraph::at(repo_root);
        let all = graph.list();
        let scope = aura_loop::RunScope { goal: None, crew: crew_filter.map(|s| s.to_string()) };
        let scoped: Vec<aura_loop::LoopTask> =
            if scope.is_unscoped() { all.clone() } else { scope.filter(&all) };
        let view = aura_loop::ready_view(&scoped);
        let failed = scoped.iter().filter(|t| t.status == aura_loop::STATE_FAILED).count();

        let now = chrono::Utc::now().timestamp();
        let working: Vec<Value> = view
            .working
            .iter()
            .map(|t| {
                let elapsed = t.lease.as_ref().map(|l| (now - l.acquired_at).max(0));
                json!({
                    "id": t.id,
                    "title": t.title,
                    "agent": t.agent_kind,
                    "holder": t.lease.as_ref().map(|l| l.holder.clone()),
                    "elapsed_secs": elapsed,
                })
            })
            .collect();

        // Just landed: the most-recently-completed nodes, joined to the goal
        // ledger by commit so each carries its proof verdict.
        let mut done_sorted = view.done.clone();
        done_sorted.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        let just_landed: Vec<Value> = done_sorted
            .iter()
            .take(5)
            .map(|t| {
                let proof = t.commit_sha.as_ref().and_then(|sha| {
                    let short = &sha[..sha.len().min(12)];
                    let recs = crate::goals::store::for_commit(repo_root, short);
                    recs.iter()
                        .flat_map(|g| g.runs.iter())
                        .find(|r| {
                            r.commit
                                .as_deref()
                                .map(|c| sha.starts_with(c) || c.starts_with(short))
                                .unwrap_or(false)
                        })
                        .map(|r| {
                            json!({
                                "verdict": serde_json::to_value(r.verdict).ok(),
                                "ok": r.ok,
                                "total": r.total,
                            })
                        })
                });
                json!({ "id": t.id, "title": t.title, "commit": t.commit_sha, "proof": proof })
            })
            .collect();

        let next_up: Vec<Value> = view
            .ready
            .iter()
            .take(5)
            .map(|t| json!({ "id": t.id, "title": t.title, "priority": t.priority }))
            .collect();

        json!({
            "counts": {
                "ready": view.ready.len(),
                "working": view.working.len(),
                "blocked": view.blocked.len(),
                "paused": view.paused.len(),
                "done": view.done.len(),
                "failed": failed,
            },
            "working": working,
            "just_landed": just_landed,
            "next_up": next_up,
            "goals": serde_json::to_value(aura_loop::goals_summary(&scoped)).unwrap_or(Value::Null),
            "crews": serde_json::to_value(aura_loop::crews_summary(&all)).unwrap_or(Value::Null),
        })
    }

    /// Wrap a crew result `body` with the live envelope and render as one MCP
    /// text payload. `headline` is the human one-liner; `body` is the verb's
    /// own data. Keeps every crew tool's return shape identical.
    fn crew_reply(repo_root: &std::path::Path, crew: Option<&str>, headline: &str, body: Value) -> Value {
        let payload = json!({
            "ok": true,
            "headline": headline,
            "result": body,
            "crew": Self::crew_envelope(repo_root, crew),
        });
        let text = serde_json::to_string_pretty(&payload).unwrap_or_else(|_| payload.to_string());
        json!({ "content": [{ "type": "text", "text": text }] })
    }

    /// `aura_crew_status` — read the whole crew's live state without touching it.
    fn tool_crew_status(args: Value) -> Value {
        let repo_root = match Self::crew_repo_root() {
            Ok(p) => p,
            Err(e) => return e,
        };
        let crew = args.get("crew").and_then(|v| v.as_str()).filter(|s| !s.trim().is_empty());
        Self::crew_reply(&repo_root, crew, "Crew status", json!({}))
    }

    /// `aura_crew_ready` — the ready set: nodes whose dependencies are all met
    /// and that nobody is working yet. Full specs so the agent can pick one and
    /// claim it.
    fn tool_crew_ready(args: Value) -> Value {
        let repo_root = match Self::crew_repo_root() {
            Ok(p) => p,
            Err(e) => return e,
        };
        let crew = args.get("crew").and_then(|v| v.as_str()).filter(|s| !s.trim().is_empty());
        let graph = aura_loop::LoopGraph::at(&repo_root);
        let all = graph.list();
        let ready = aura_loop::ready_set(&all);
        let scope = aura_loop::RunScope { goal: None, crew: crew.map(|s| s.to_string()) };
        let ready: Vec<aura_loop::LoopTask> =
            if scope.is_unscoped() { ready } else { scope.filter(&ready) };
        let nodes: Vec<Value> = ready.iter().map(Self::crew_node_json).collect();
        let headline = if nodes.is_empty() {
            "Nothing ready right now — everything is blocked, in flight, or done."
        } else {
            "Ready to claim — pick one, then call aura_crew_claim with its id."
        };
        Self::crew_reply(&repo_root, crew, headline, json!({ "ready": nodes }))
    }

    /// `aura_crew_claim` — lease a ready node so no other agent grabs it. Returns
    /// the node's full spec to execute. Refused (with the live envelope) if
    /// someone else already holds it.
    fn tool_crew_claim(args: Value) -> Value {
        let repo_root = match Self::crew_repo_root() {
            Ok(p) => p,
            Err(e) => return e,
        };
        let id = match args.get("id").and_then(|v| v.as_str()).filter(|s| !s.trim().is_empty()) {
            Some(s) => s.to_string(),
            None => return json!({ "isError": true, "content": [{ "type": "text", "text": "`id` is required — the node id from aura_crew_ready." }] }),
        };
        let holder = Self::crew_holder(&args);
        let lease_secs = args.get("lease_secs").and_then(|v| v.as_i64()).unwrap_or(1800);
        let graph = aura_loop::LoopGraph::at(&repo_root);
        match graph.claim(&id, &holder, lease_secs) {
            Ok(t) => Self::crew_reply(
                &repo_root,
                None,
                "Claimed — do the work, commit, then call aura_crew_complete with the commit sha (or aura_crew_fail with a reason).",
                json!({ "claimed": Self::crew_node_json(&t), "holder": holder, "lease_secs": lease_secs }),
            ),
            Err(e) => {
                let env = Self::crew_envelope(&repo_root, None);
                let payload = json!({
                    "ok": false,
                    "headline": format!("Couldn't claim {id}: {e}. Someone else may hold it — pick another from `crew.next_up`."),
                    "crew": env,
                });
                json!({ "isError": true, "content": [{ "type": "text", "text": serde_json::to_string_pretty(&payload).unwrap_or_else(|_| payload.to_string()) }] })
            }
        }
    }

    /// `aura_crew_report` — a worker heartbeat on a node it's working: refreshes
    /// the lease so a long task isn't reclaimed as stale, and carries an optional
    /// progress note back in the envelope. Real, not a no-op: the lease clock is
    /// reset.
    fn tool_crew_report(args: Value) -> Value {
        let repo_root = match Self::crew_repo_root() {
            Ok(p) => p,
            Err(e) => return e,
        };
        let id = match args.get("id").and_then(|v| v.as_str()).filter(|s| !s.trim().is_empty()) {
            Some(s) => s.to_string(),
            None => return json!({ "isError": true, "content": [{ "type": "text", "text": "`id` is required — the node you're working." }] }),
        };
        let holder = Self::crew_holder(&args);
        let lease_secs = args.get("lease_secs").and_then(|v| v.as_i64()).unwrap_or(1800);
        let note = args.get("note").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let graph = aura_loop::LoopGraph::at(&repo_root);
        // Re-claim by the SAME holder refreshes the lease (the graph only
        // refuses a *different* live holder), so this is a true heartbeat.
        match graph.claim(&id, &holder, lease_secs) {
            Ok(t) => Self::crew_reply(
                &repo_root,
                None,
                "Heartbeat recorded — lease refreshed, keep going.",
                json!({ "node": Self::crew_node_json(&t), "note": note, "lease_secs": lease_secs }),
            ),
            Err(e) => json!({ "isError": true, "content": [{ "type": "text", "text": format!("Couldn't refresh {id}: {e}. If another agent took it, re-claim a fresh node from aura_crew_ready.") }] }),
        }
    }

    /// `aura_crew_complete` — mark a node done with the commit its work landed in.
    /// The commit feeds the goal-proof join so the surface can show this node as
    /// proven, not just "done".
    fn tool_crew_complete(args: Value) -> Value {
        let repo_root = match Self::crew_repo_root() {
            Ok(p) => p,
            Err(e) => return e,
        };
        let id = match args.get("id").and_then(|v| v.as_str()).filter(|s| !s.trim().is_empty()) {
            Some(s) => s.to_string(),
            None => return json!({ "isError": true, "content": [{ "type": "text", "text": "`id` is required." }] }),
        };
        let commit = args.get("commit").and_then(|v| v.as_str()).filter(|s| !s.trim().is_empty()).map(|s| s.to_string());
        let graph = aura_loop::LoopGraph::at(&repo_root);
        match graph.complete(&id, commit.clone(), None) {
            Ok(t) => Self::crew_reply(
                &repo_root,
                None,
                "Marked complete. Pick the next from `crew.next_up`, or aura_crew_ready for the full set.",
                json!({ "completed": Self::crew_node_json(&t), "commit": commit }),
            ),
            Err(e) => json!({ "isError": true, "content": [{ "type": "text", "text": format!("Couldn't complete {id}: {e}") }] }),
        }
    }

    /// `aura_crew_fail` — mark a node failed with a reason. Frees it for a retry
    /// (a human can re-arm it from the surface).
    fn tool_crew_fail(args: Value) -> Value {
        let repo_root = match Self::crew_repo_root() {
            Ok(p) => p,
            Err(e) => return e,
        };
        let id = match args.get("id").and_then(|v| v.as_str()).filter(|s| !s.trim().is_empty()) {
            Some(s) => s.to_string(),
            None => return json!({ "isError": true, "content": [{ "type": "text", "text": "`id` is required." }] }),
        };
        let reason = match args.get("reason").and_then(|v| v.as_str()).filter(|s| !s.trim().is_empty()) {
            Some(s) => s.to_string(),
            None => return json!({ "isError": true, "content": [{ "type": "text", "text": "`reason` is required — say what blocked it, honestly." }] }),
        };
        let graph = aura_loop::LoopGraph::at(&repo_root);
        match graph.fail(&id, reason.clone()) {
            Ok(t) => Self::crew_reply(
                &repo_root,
                None,
                "Marked failed. The crew moves on; a human can retry it from the Crew surface.",
                json!({ "failed": Self::crew_node_json(&t), "reason": reason }),
            ),
            Err(e) => json!({ "isError": true, "content": [{ "type": "text", "text": format!("Couldn't fail {id}: {e}") }] }),
        }
    }

    /// `aura_crew_plan` — the planning front door. With no plan body it RETURNS
    /// the orderless pile chunked to reason over (same chunking the desktop
    /// planner uses); with edges/goals/objectives it APPLIES them onto the graph.
    /// Either way the live envelope rides along.
    fn tool_crew_plan(args: Value) -> Value {
        let repo_root = match Self::crew_repo_root() {
            Ok(p) => p,
            Err(e) => return e,
        };
        let has_plan = ["edges", "goals", "objectives"]
            .iter()
            .any(|k| args.get(*k).map(|v| v.is_array() && !v.as_array().map(|a| a.is_empty()).unwrap_or(true)).unwrap_or(false));
        if has_plan {
            // Delegate to the existing applier (cycle-checked), then attach the
            // envelope so the agent sees the new ready set immediately.
            let applied = Self::tool_loop_plan_apply(args);
            let report_text = applied
                .get("content")
                .and_then(|c| c.get(0))
                .and_then(|c| c.get("text"))
                .and_then(|t| t.as_str())
                .unwrap_or("Plan applied.")
                .to_string();
            // If the applier errored, surface that verbatim.
            if applied.get("isError").and_then(|v| v.as_bool()).unwrap_or(false) {
                return applied;
            }
            return Self::crew_reply(&repo_root, None, "Plan applied to the crew.", json!({ "report": report_text }));
        }
        // No plan body → return the pile to plan over.
        let graph = aura_loop::LoopGraph::at(&repo_root);
        let all = graph.list();
        let ctx = aura_loop::planning::plan_context(&all);
        let chunks: Vec<Value> = ctx
            .chunks
            .iter()
            .map(|c| {
                let tasks: Vec<Value> = c
                    .node_ids
                    .iter()
                    .map(|id| {
                        let (title, detail) = graph.get(id).map(|t| (t.title, t.input)).unwrap_or_default();
                        json!({ "id": id, "title": title, "detail": detail })
                    })
                    .collect();
                json!({ "label": c.label, "seed_goal": c.seed_goal, "tasks": tasks })
            })
            .collect();
        let headline = if chunks.is_empty() {
            "No loose work to order yet — add tasks (aura_a2a_task_create) or sync the board, then plan."
        } else {
            "Reason the real dependencies inside each chunk, name each goal, then call aura_crew_plan again with edges/goals/objectives to apply."
        };
        Self::crew_reply(
            &repo_root,
            None,
            headline,
            json!({
                "considered": ctx.considered,
                "deferred": ctx.deferred,
                "chunks": chunks,
                "how_to_apply": "Within EACH chunk work out which task must finish before which (only where one genuinely needs another's output). Then call aura_crew_plan with edges:[{task,depends_on}], goals:[{goal,tasks:[ids]}], objectives:[{objective,goals:[names]}]."
            }),
        )
    }

    /// `aura_crew_list` — the crews in this repo: the durable registry (always
    /// including "main") joined to each crew's LIVE lifecycle counts from the
    /// graph. This is how an agent or the surface sees "what crews exist and
    /// where each is at" before spawning another or routing work.
    fn tool_crew_list(_args: Value) -> Value {
        let repo_root = match Self::crew_repo_root() {
            Ok(p) => p,
            Err(e) => return e,
        };
        let registry = aura_loop::crew::CrewRegistry::at(&repo_root);
        let metas = registry.list();
        let graph = aura_loop::LoopGraph::at(&repo_root);
        let all = graph.list();
        let summaries = aura_loop::crews_summary(&all);
        // Index live counts by crew id so a registered-but-empty crew still
        // shows zeros rather than vanishing.
        let crews: Vec<Value> = metas
            .iter()
            .map(|m| {
                let s = summaries.iter().find(|c| c.crew == m.id);
                json!({
                    "id": m.id,
                    "title": m.title,
                    "description": m.description,
                    "created_at": m.created_at,
                    "counts": {
                        "total": s.map(|s| s.total).unwrap_or(0),
                        "ready": s.map(|s| s.ready).unwrap_or(0),
                        "working": s.map(|s| s.working).unwrap_or(0),
                        "blocked": s.map(|s| s.blocked).unwrap_or(0),
                        "paused": s.map(|s| s.paused).unwrap_or(0),
                        "done": s.map(|s| s.done).unwrap_or(0),
                        "failed": s.map(|s| s.failed).unwrap_or(0),
                    },
                    "goals": s.map(|s| s.goals.clone()).unwrap_or_default(),
                })
            })
            .collect();
        // Any crew id that appears on nodes but isn't registered (e.g. a raw
        // crew_id set directly) — surface it too so nothing is hidden.
        let known: std::collections::HashSet<&str> = metas.iter().map(|m| m.id.as_str()).collect();
        let unregistered: Vec<Value> = summaries
            .iter()
            .filter(|s| !known.contains(s.crew.as_str()))
            .map(|s| {
                json!({
                    "id": s.crew,
                    "title": s.crew,
                    "description": Value::Null,
                    "created_at": 0,
                    "counts": {
                        "total": s.total, "ready": s.ready, "working": s.working,
                        "blocked": s.blocked, "paused": s.paused, "done": s.done, "failed": s.failed,
                    },
                    "goals": s.goals,
                    "unregistered": true,
                })
            })
            .collect();
        let mut out = crews;
        out.extend(unregistered);
        Self::crew_reply(&repo_root, None, "Crews in this project", json!({ "crews": out }))
    }

    /// `aura_crew_spawn` — stand up a SECOND crew to run in parallel with the
    /// first. Mints a named crew in the registry (idempotent by slug) and,
    /// optionally, moves a set of existing nodes into it (`task_ids`) so the new
    /// crew has work immediately. Returns the new crew + an envelope scoped to
    /// it, so the agent can `aura_crew_ready` against it right away.
    fn tool_crew_spawn(args: Value) -> Value {
        let repo_root = match Self::crew_repo_root() {
            Ok(p) => p,
            Err(e) => return e,
        };
        let title = match args.get("title").and_then(|v| v.as_str()).filter(|s| !s.trim().is_empty()) {
            Some(s) => s.to_string(),
            None => return json!({ "isError": true, "content": [{ "type": "text", "text": "`title` is required — name the crew (e.g. 'Perf crew')." }] }),
        };
        let description = args.get("description").and_then(|v| v.as_str()).filter(|s| !s.trim().is_empty()).map(|s| s.to_string());
        let now = chrono::Utc::now().timestamp();
        let registry = aura_loop::crew::CrewRegistry::at(&repo_root);
        let meta = match registry.spawn(title, description, now) {
            Ok(m) => m,
            Err(e) => return json!({ "isError": true, "content": [{ "type": "text", "text": format!("Couldn't spawn crew: {e}") }] }),
        };
        // Optionally route a set of nodes into the new crew.
        let mut moved: Vec<String> = Vec::new();
        let mut move_errors: Vec<String> = Vec::new();
        if let Some(ids) = args.get("task_ids").and_then(|v| v.as_array()) {
            let graph = aura_loop::LoopGraph::at(&repo_root);
            for id in ids.iter().filter_map(|v| v.as_str()) {
                match graph.set_crew(id, Some(meta.id.clone())) {
                    Ok(_) => moved.push(id.to_string()),
                    Err(e) => move_errors.push(format!("{id}: {e}")),
                }
            }
        }
        let headline = format!(
            "Crew '{}' ready{}. Run it in parallel with `aura loop run --crew {}`, or drain it over MCP via aura_crew_ready (crew: \"{}\").",
            meta.title,
            if moved.is_empty() { String::new() } else { format!(" with {} task(s) moved in", moved.len()) },
            meta.id, meta.id,
        );
        Self::crew_reply(
            &repo_root,
            Some(&meta.id),
            &headline,
            json!({
                "crew": { "id": meta.id, "title": meta.title, "description": meta.description, "created_at": meta.created_at },
                "moved": moved,
                "move_errors": move_errors,
            }),
        )
    }

    /// Stable lease holder for a crew worker: `crew:<agent>` when the agent
    /// names itself, else `crew:mcp:<pid>` so concurrent MCP workers stay
    /// distinct.
    fn crew_holder(args: &Value) -> String {
        match args.get("agent").and_then(|v| v.as_str()).filter(|s| !s.trim().is_empty()) {
            Some(a) => format!("crew:{a}"),
            None => format!("crew:mcp:{}", std::process::id()),
        }
    }

    /// Bet 4 Phase B — proxies POST /api/v2/pr/commit-review-generate. Same
    /// rationale as narrate: the AI call lives server-side. Caller passes
    /// the commit list shape verbatim; cloud upserts each row and returns
    /// the per-commit (id, risk_score, risk_label, model_used) summary.
    fn tool_pr_commit_review_generate(args: Value) -> Value {
        let config = crate::config::ConfigManager::load();
        let token = match config.cloud_api_token
            .clone()
            .or_else(|| std::env::var("AURA_CLOUD_TOKEN").ok())
        {
            Some(t) => t,
            None => return json!({ "isError": true, "content": [{ "type": "text", "text": "No cloud token configured. Run `aura cloud login`." }] }),
        };
        let cloud_url = config.cloud_url.unwrap_or_else(|| "https://auravcs.com".to_string());
        let url = format!("{}/api/v2/pr/commit-review-generate", cloud_url.trim_end_matches('/'));
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(60))
            .build()
            .unwrap_or_else(|_| reqwest::blocking::Client::new());
        match client
            .post(&url)
            .header("Authorization", format!("Bearer {}", token))
            .json(&args)
            .send()
        {
            Ok(resp) => {
                let status = resp.status();
                match resp.json::<Value>() {
                    Ok(v) => {
                        if !status.is_success() {
                            return json!({ "isError": true, "content": [{ "type": "text", "text": format!("commit-review-generate HTTP {}: {}", status, v) }] });
                        }
                        let pretty = serde_json::to_string_pretty(&v).unwrap_or_else(|_| v.to_string());
                        json!({ "content": [{ "type": "text", "text": pretty }] })
                    }
                    Err(e) => json!({ "isError": true, "content": [{ "type": "text", "text": format!("commit-review-generate parse failed (HTTP {}): {}", status, e) }] }),
                }
            }
            Err(e) => json!({ "isError": true, "content": [{ "type": "text", "text": format!("commit-review-generate request failed: {}", e) }] }),
        }
    }

    /// Bet 4 Phase A — proxies GET /api/v2/pr/commit-reviews. Read-only
    /// list of per-commit AI review rows for one PR. The list endpoint
    /// requires repo + platform + pr_number; cloud-side it scopes by org
    /// from the JWT and returns rows in commit order.
    fn tool_pr_commit_review_list(args: Value) -> Value {
        let repo = match args.get("repo").and_then(|v| v.as_str()) {
            Some(s) if !s.trim().is_empty() => s.to_string(),
            _ => return json!({ "isError": true, "content": [{ "type": "text", "text": "repo is required (github full_name)." }] }),
        };
        let platform = match args.get("platform").and_then(|v| v.as_str()) {
            Some(s) if !s.trim().is_empty() => s.to_string(),
            _ => return json!({ "isError": true, "content": [{ "type": "text", "text": "platform is required ('github' or 'gitlab')." }] }),
        };
        let pr_number = match args.get("pr_number").and_then(|v| v.as_i64()) {
            Some(n) => n,
            _ => return json!({ "isError": true, "content": [{ "type": "text", "text": "pr_number is required (integer)." }] }),
        };
        // Bet 4F (S2-PCRTM): optional intent_type filter forwarded as a query
        // param. Validation lives cloud-side (Bet 4E) so a typo round-trips
        // back as an HTTP 400 isError envelope — keep this layer dumb.
        let intent_type = args
            .get("intent_type")
            .and_then(|v| v.as_str())
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string());
        let config = crate::config::ConfigManager::load();
        let token = match config.cloud_api_token
            .clone()
            .or_else(|| std::env::var("AURA_CLOUD_TOKEN").ok())
        {
            Some(t) => t,
            None => return json!({ "isError": true, "content": [{ "type": "text", "text": "No cloud token configured. Run `aura cloud login`." }] }),
        };
        let cloud_url = config.cloud_url.unwrap_or_else(|| "https://auravcs.com".to_string());
        let mut url = format!(
            "{}/api/v2/pr/commit-reviews?repo={}&platform={}&pr_number={}",
            cloud_url.trim_end_matches('/'),
            percent_encode_unreserved(&repo),
            percent_encode_unreserved(&platform),
            pr_number
        );
        if let Some(t) = intent_type.as_deref() {
            url.push_str("&intent_type=");
            url.push_str(&percent_encode_unreserved(t));
        }
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(20))
            .build()
            .unwrap_or_else(|_| reqwest::blocking::Client::new());
        match client
            .get(&url)
            .header("Authorization", format!("Bearer {}", token))
            .send()
        {
            Ok(resp) => {
                let status = resp.status();
                match resp.json::<Value>() {
                    Ok(v) => {
                        if !status.is_success() {
                            return json!({ "isError": true, "content": [{ "type": "text", "text": format!("commit-review-list HTTP {}: {}", status, v) }] });
                        }
                        let pretty = serde_json::to_string_pretty(&v).unwrap_or_else(|_| v.to_string());
                        json!({ "content": [{ "type": "text", "text": pretty }] })
                    }
                    Err(e) => json!({ "isError": true, "content": [{ "type": "text", "text": format!("commit-review-list parse failed (HTTP {}): {}", status, e) }] }),
                }
            }
            Err(e) => json!({ "isError": true, "content": [{ "type": "text", "text": format!("commit-review-list request failed: {}", e) }] }),
        }
    }

    /// Wave 1 (entire-parity) — routing decision over the Agent Skill
    /// Ledger. Proxies GET /api/v2/skill/stats for a taxonomy cell, then
    /// ranks the per-provider rollups with the canonical `skill_rank`
    /// formula and returns the single best provider (or null when no
    /// provider clears the sample threshold). Shares the exact ranker the
    /// CLI `aura skill suggest` and the in-app dispatcher use.
    fn tool_route_suggest(args: Value) -> Value {
        let category = match args.get("category").and_then(|v| v.as_str()) {
            Some(s) if !s.trim().is_empty() => s.to_string(),
            _ => return json!({ "isError": true, "content": [{ "type": "text", "text": "category is required (frontend|backend|infra|refactor|security-review|architecture-review)." }] }),
        };
        let language = args
            .get("language")
            .and_then(|v| v.as_str())
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string());
        let layer = args
            .get("layer")
            .and_then(|v| v.as_str())
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string());

        let config = crate::config::ConfigManager::load();
        let token = match config
            .cloud_api_token
            .clone()
            .or_else(|| std::env::var("AURA_CLOUD_TOKEN").ok())
        {
            Some(t) => t,
            None => return json!({ "isError": true, "content": [{ "type": "text", "text": "No cloud token configured. Run `aura cloud login`." }] }),
        };
        let cloud_url = config.cloud_url.unwrap_or_else(|| "https://auravcs.com".to_string());
        let mut url = format!(
            "{}/api/v2/skill/stats?category={}",
            cloud_url.trim_end_matches('/'),
            percent_encode_unreserved(&category),
        );
        if let Some(l) = language.as_deref() {
            url.push_str("&language=");
            url.push_str(&percent_encode_unreserved(l));
        }
        if let Some(y) = layer.as_deref() {
            url.push_str("&layer=");
            url.push_str(&percent_encode_unreserved(y));
        }
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(20))
            .build()
            .unwrap_or_else(|_| reqwest::blocking::Client::new());
        match client
            .get(&url)
            .header("Authorization", format!("Bearer {}", token))
            .send()
        {
            Ok(resp) => {
                let status = resp.status();
                match resp.json::<Value>() {
                    Ok(v) => {
                        if !status.is_success() {
                            return json!({ "isError": true, "content": [{ "type": "text", "text": format!("route-suggest HTTP {}: {}", status, v) }] });
                        }
                        let rows = crate::skill_rank::parse_stats_rows(&v);
                        let best = crate::skill_rank::best(&rows);
                        let suggestion = match &best {
                            Some(b) => serde_json::to_value(b).unwrap_or(Value::Null),
                            None => Value::Null,
                        };
                        let text = serde_json::to_string_pretty(&suggestion)
                            .unwrap_or_else(|_| "null".to_string());
                        json!({ "content": [{ "type": "text", "text": text }] })
                    }
                    Err(e) => json!({ "isError": true, "content": [{ "type": "text", "text": format!("route-suggest parse failed (HTTP {}): {}", status, e) }] }),
                }
            }
            Err(e) => json!({ "isError": true, "content": [{ "type": "text", "text": format!("route-suggest request failed: {}", e) }] }),
        }
    }

    /// Bet 4 Phase A — proxies GET /api/v2/pr/commit-reviews/{commit_sha}.
    /// Read-only single-row fetch. 404 surfaces as an isError envelope so a
    /// generate-then-poll loop can decide whether to trigger generate.
    fn tool_pr_commit_review_get(args: Value) -> Value {
        let commit_sha = match args.get("commit_sha").and_then(|v| v.as_str()) {
            Some(s) if !s.trim().is_empty() => s.to_string(),
            _ => return json!({ "isError": true, "content": [{ "type": "text", "text": "commit_sha is required." }] }),
        };
        // S2-PCR fix: cloud's /pr/commit-reviews/{sha} requires PR scope on
        // the query (axum query extraction would fail without them, returning
        // 400 — which used to surface as a confusing empty error). Pull the
        // same triplet the list path takes.
        let repo = match args.get("repo").and_then(|v| v.as_str()) {
            Some(s) if !s.trim().is_empty() => s.to_string(),
            _ => return json!({ "isError": true, "content": [{ "type": "text", "text": "repo is required (github full_name)." }] }),
        };
        let platform = match args.get("platform").and_then(|v| v.as_str()) {
            Some(s) if !s.trim().is_empty() => s.to_string(),
            _ => return json!({ "isError": true, "content": [{ "type": "text", "text": "platform is required ('github' or 'gitlab')." }] }),
        };
        let pr_number = match args.get("pr_number").and_then(|v| v.as_i64()) {
            Some(n) => n,
            _ => return json!({ "isError": true, "content": [{ "type": "text", "text": "pr_number is required (integer)." }] }),
        };
        let config = crate::config::ConfigManager::load();
        let token = match config.cloud_api_token
            .clone()
            .or_else(|| std::env::var("AURA_CLOUD_TOKEN").ok())
        {
            Some(t) => t,
            None => return json!({ "isError": true, "content": [{ "type": "text", "text": "No cloud token configured. Run `aura cloud login`." }] }),
        };
        let cloud_url = config.cloud_url.unwrap_or_else(|| "https://auravcs.com".to_string());
        // SHAs are hex; strip anything else defensively to keep the path
        // segment URL-safe even if a caller smuggles in junk.
        let safe_sha: String = commit_sha
            .chars()
            .filter(|c| c.is_ascii_alphanumeric())
            .collect();
        if safe_sha.is_empty() {
            return json!({ "isError": true, "content": [{ "type": "text", "text": "commit_sha contains no url-safe characters" }] });
        }
        let url = format!(
            "{}/api/v2/pr/commit-reviews/{}?repo={}&platform={}&pr_number={}",
            cloud_url.trim_end_matches('/'),
            safe_sha,
            percent_encode_unreserved(&repo),
            percent_encode_unreserved(&platform),
            pr_number,
        );
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(20))
            .build()
            .unwrap_or_else(|_| reqwest::blocking::Client::new());
        match client
            .get(&url)
            .header("Authorization", format!("Bearer {}", token))
            .send()
        {
            Ok(resp) => {
                let status = resp.status();
                match resp.json::<Value>() {
                    Ok(v) => {
                        if !status.is_success() {
                            return json!({ "isError": true, "content": [{ "type": "text", "text": format!("commit-review-get HTTP {}: {}", status, v) }] });
                        }
                        let pretty = serde_json::to_string_pretty(&v).unwrap_or_else(|_| v.to_string());
                        json!({ "content": [{ "type": "text", "text": pretty }] })
                    }
                    Err(e) => json!({ "isError": true, "content": [{ "type": "text", "text": format!("commit-review-get parse failed (HTTP {}): {}", status, e) }] }),
                }
            }
            Err(e) => json!({ "isError": true, "content": [{ "type": "text", "text": format!("commit-review-get request failed: {}", e) }] }),
        }
    }

    /// Cloud project_memory store — proxies GET /api/v2/memory. Read
    /// org-wide durable memory entries newest first. Distinct from the
    /// per-machine local memory file the local memory tools operate on.
    fn tool_memory_cloud_list(args: Value) -> Value {
        let config = crate::config::ConfigManager::load();
        let token = match config.cloud_api_token
            .clone()
            .or_else(|| std::env::var("AURA_CLOUD_TOKEN").ok())
        {
            Some(t) => t,
            None => return json!({ "isError": true, "content": [{ "type": "text", "text": "No cloud token configured. Run `aura cloud login`." }] }),
        };
        let cloud_url = config.cloud_url.unwrap_or_else(|| "https://auravcs.com".to_string());
        let mut url = format!("{}/api/v2/memory", cloud_url.trim_end_matches('/'));
        let mut sep = '?';
        if let Some(p) = args.get("page").and_then(|v| v.as_i64()) {
            url.push_str(&format!("{sep}page={p}"));
            sep = '&';
        }
        if let Some(l) = args.get("limit").and_then(|v| v.as_i64()) {
            url.push_str(&format!("{sep}limit={l}"));
        }
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(20))
            .build()
            .unwrap_or_else(|_| reqwest::blocking::Client::new());
        match client
            .get(&url)
            .header("Authorization", format!("Bearer {}", token))
            .send()
        {
            Ok(resp) => {
                let status = resp.status();
                match resp.json::<Value>() {
                    Ok(v) => {
                        if !status.is_success() {
                            return json!({ "isError": true, "content": [{ "type": "text", "text": format!("memory-cloud-list HTTP {}: {}", status, v) }] });
                        }
                        let pretty = serde_json::to_string_pretty(&v).unwrap_or_else(|_| v.to_string());
                        json!({ "content": [{ "type": "text", "text": pretty }] })
                    }
                    Err(e) => json!({ "isError": true, "content": [{ "type": "text", "text": format!("memory-cloud-list parse failed (HTTP {}): {}", status, e) }] }),
                }
            }
            Err(e) => json!({ "isError": true, "content": [{ "type": "text", "text": format!("memory-cloud-list request failed: {}", e) }] }),
        }
    }

    /// Cloud project_memory store — proxies POST /api/v2/memory. Insert
    /// a durable org-wide memory entry. Whitelists the documented body
    /// fields so callers can't smuggle unknown keys through the insert.
    fn tool_memory_cloud_push(args: Value) -> Value {
        let body = match args.get("body").and_then(|v| v.as_str()) {
            Some(s) if !s.trim().is_empty() => s.to_string(),
            _ => return json!({ "isError": true, "content": [{ "type": "text", "text": "body is required and must be non-empty." }] }),
        };
        let config = crate::config::ConfigManager::load();
        let token = match config.cloud_api_token
            .clone()
            .or_else(|| std::env::var("AURA_CLOUD_TOKEN").ok())
        {
            Some(t) => t,
            None => return json!({ "isError": true, "content": [{ "type": "text", "text": "No cloud token configured. Run `aura cloud login`." }] }),
        };
        let cloud_url = config.cloud_url.unwrap_or_else(|| "https://auravcs.com".to_string());
        let url = format!("{}/api/v2/memory", cloud_url.trim_end_matches('/'));
        let payload = build_memory_push_body(&body, &args);
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(20))
            .build()
            .unwrap_or_else(|_| reqwest::blocking::Client::new());
        match client
            .post(&url)
            .header("Authorization", format!("Bearer {}", token))
            .json(&Value::Object(payload))
            .send()
        {
            Ok(resp) => {
                let status = resp.status();
                match resp.json::<Value>() {
                    Ok(v) => {
                        if !status.is_success() {
                            return json!({ "isError": true, "content": [{ "type": "text", "text": format!("memory-cloud-push HTTP {}: {}", status, v) }] });
                        }
                        let pretty = serde_json::to_string_pretty(&v).unwrap_or_else(|_| v.to_string());
                        json!({ "content": [{ "type": "text", "text": pretty }] })
                    }
                    Err(e) => json!({ "isError": true, "content": [{ "type": "text", "text": format!("memory-cloud-push parse failed (HTTP {}): {}", status, e) }] }),
                }
            }
            Err(e) => json!({ "isError": true, "content": [{ "type": "text", "text": format!("memory-cloud-push request failed: {}", e) }] }),
        }
    }

    /// Cloud-side handover ledger — proxies GET /api/v2/handovers. Read
    /// the list of handover summaries pushed by other sessions so the
    /// joining agent can pick which one to resume.
    fn tool_handover_cloud_list(args: Value) -> Value {
        let config = crate::config::ConfigManager::load();
        let token = match config.cloud_api_token
            .clone()
            .or_else(|| std::env::var("AURA_CLOUD_TOKEN").ok())
        {
            Some(t) => t,
            None => return json!({ "isError": true, "content": [{ "type": "text", "text": "No cloud token configured. Run `aura cloud login`." }] }),
        };
        let cloud_url = config.cloud_url.unwrap_or_else(|| "https://auravcs.com".to_string());
        let mut url = format!("{}/api/v2/handovers", cloud_url.trim_end_matches('/'));
        let mut sep = '?';
        if let Some(p) = args.get("page").and_then(|v| v.as_i64()) {
            url.push_str(&format!("{sep}page={p}"));
            sep = '&';
        }
        if let Some(l) = args.get("limit").and_then(|v| v.as_i64()) {
            url.push_str(&format!("{sep}limit={l}"));
        }
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(20))
            .build()
            .unwrap_or_else(|_| reqwest::blocking::Client::new());
        match client
            .get(&url)
            .header("Authorization", format!("Bearer {}", token))
            .send()
        {
            Ok(resp) => {
                let status = resp.status();
                match resp.json::<Value>() {
                    Ok(v) => {
                        if !status.is_success() {
                            return json!({ "isError": true, "content": [{ "type": "text", "text": format!("handover-cloud-list HTTP {}: {}", status, v) }] });
                        }
                        let pretty = serde_json::to_string_pretty(&v).unwrap_or_else(|_| v.to_string());
                        json!({ "content": [{ "type": "text", "text": pretty }] })
                    }
                    Err(e) => json!({ "isError": true, "content": [{ "type": "text", "text": format!("handover-cloud-list parse failed (HTTP {}): {}", status, e) }] }),
                }
            }
            Err(e) => json!({ "isError": true, "content": [{ "type": "text", "text": format!("handover-cloud-list request failed: {}", e) }] }),
        }
    }

    /// Cloud-side handover ledger — proxies POST /api/v2/handovers. Push
    /// a summary so a joining agent on another machine can discover it.
    /// Forwards only the documented body fields.
    fn tool_handover_cloud_push(args: Value) -> Value {
        let config = crate::config::ConfigManager::load();
        let token = match config.cloud_api_token
            .clone()
            .or_else(|| std::env::var("AURA_CLOUD_TOKEN").ok())
        {
            Some(t) => t,
            None => return json!({ "isError": true, "content": [{ "type": "text", "text": "No cloud token configured. Run `aura cloud login`." }] }),
        };
        let cloud_url = config.cloud_url.unwrap_or_else(|| "https://auravcs.com".to_string());
        let url = format!("{}/api/v2/handovers", cloud_url.trim_end_matches('/'));
        let body = build_handover_push_body(&args);
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(20))
            .build()
            .unwrap_or_else(|_| reqwest::blocking::Client::new());
        match client
            .post(&url)
            .header("Authorization", format!("Bearer {}", token))
            .json(&Value::Object(body))
            .send()
        {
            Ok(resp) => {
                let status = resp.status();
                match resp.json::<Value>() {
                    Ok(v) => {
                        if !status.is_success() {
                            return json!({ "isError": true, "content": [{ "type": "text", "text": format!("handover-cloud-push HTTP {}: {}", status, v) }] });
                        }
                        let pretty = serde_json::to_string_pretty(&v).unwrap_or_else(|_| v.to_string());
                        json!({ "content": [{ "type": "text", "text": pretty }] })
                    }
                    Err(e) => json!({ "isError": true, "content": [{ "type": "text", "text": format!("handover-cloud-push parse failed (HTTP {}): {}", status, e) }] }),
                }
            }
            Err(e) => json!({ "isError": true, "content": [{ "type": "text", "text": format!("handover-cloud-push request failed: {}", e) }] }),
        }
    }

    /// Bet 1 Phase B — local episodic recall over intent log, sentinel
    /// inbox, and snapshot metadata. Returns both a narrated digest (for
    /// agents to paste into handovers) and the structured events array
    /// (so downstream tooling can filter / re-rank). Cloud-backed version
    /// will replace the storage layer but keep this response shape.
    fn tool_episodic_recall(args: Value) -> Value {
        let window_hours = args.get("window_hours").and_then(|v| v.as_u64());
        let focus_file = args.get("focus_file").and_then(|v| v.as_str());
        let limit = args
            .get("limit")
            .and_then(|v| v.as_u64())
            .map(|n| n as usize);
        let result = crate::episodic::recall(window_hours, focus_file, limit);
        let payload = match serde_json::to_value(&result) {
            Ok(v) => v,
            Err(e) => {
                return json!({
                    "isError": true,
                    "content": [{ "type": "text", "text": format!("episodic recall failed: {}", e) }]
                });
            }
        };
        let pretty = serde_json::to_string_pretty(&payload)
            .unwrap_or_else(|_| payload.to_string());
        json!({
            "content": [{ "type": "text", "text": pretty }]
        })
    }
}

/// Best-effort wrapper around `intent_block::sign_and_persist`. Returns
/// the persisted block_id (as a string) on success, `None` on any failure.
/// Failure modes intentionally swallowed so a missing signing key never
/// breaks the JSONL intent log path that's existed since v0.1.
///
/// Side effects: creates `.aura/blocks/` and writes one
/// `<block_id>.json` file per call. Touches no network.
/// Minimal XML attribute / text escape so user-supplied intent strings
/// don't break the handover XML payload. Only the five characters that
/// matter inside an attribute or element body — no namespace handling
/// because the handover payload has no namespaces.
pub(crate) fn xml_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            _ => out.push(c),
        }
    }
    out
}

/// Returns (block_id, key_id) so the caller (tool_log_intent) can
/// stamp both into the JSONL row. key_id is the same `did:aura:key/<b64>`
/// string the verifier prints.
///
/// `intent_type` (S2-TIB) — when present, gets stamped into
/// `payload.body.intent_type` so the on-disk Block envelope carries the
/// same canonical type as the JSONL row. Caller validates against the
/// canonical set BEFORE calling so this signing path stays a thin
/// builder over already-trusted input.
///
/// `agent_label` names the coding agent in the signed block's payload
/// (`did:aura:agent/<label>`). The MCP path passes "MCP Agent"; the CLI
/// `sign-intent` surface passes whatever brain drove the edit (e.g.
/// "aura-shell" for a native Aura-chat turn) so attribution is honest
/// regardless of which capture surface sealed the intent.
pub(crate) fn sign_intent_best_effort(
    intent: &str,
    intent_type: Option<&str>,
    declared_writes: &[String],
    agent_label: &str,
) -> Option<(String, String)> {
    let key_path = crate::manifest_sig::default_signing_key_path().ok()?;
    let sk = aura_attestation::load_or_create(&key_path).ok()?;
    let key_id = sk.verifying_key().key_id();
    let host = std::env::var("HOSTNAME")
        .or_else(|_| std::env::var("HOST"))
        .unwrap_or_else(|_| "unknown".into());
    // S1-D dual identity: bind the human operator into the signed
    // payload when AURA_HUMAN_ID is set. Resolution order favours the
    // explicit env var over implicit shell identity so an operator can
    // override per-session without changing global config. Empty value
    // is treated as unset.
    let human_id = std::env::var("AURA_HUMAN_ID")
        .ok()
        .filter(|s| !s.trim().is_empty());
    let now = time::OffsetDateTime::now_utc();
    let mut block = crate::intent_block::build_intent_block(
        intent,
        agent_label,
        human_id.as_deref(),
        &host,
        now,
        intent_type,
    );
    // Record the agent's declared write scope so the commit-time reconciler
    // (intent_reconcile) can catch any file it touches beyond what it said it
    // would. Empty ⇒ no scope claim, and the divergence gate stays dormant
    // for this intent. Set BEFORE signing — declared_impacts is part of the
    // signed canonical envelope (unlike actual_impacts, which is reconciled
    // in afterward).
    if !declared_writes.is_empty() {
        block.declared_impacts.writes_paths = declared_writes.to_vec();
    }
    let dir = std::path::Path::new(".aura/blocks");
    let (id, _path) = crate::intent_block::sign_and_persist(block, &sk, dir).ok()?;

    // Make this seal re-checkable by the whole team:
    //   1. Mirror the signed block into the git-tracked `.aura/attest/`
    //      dir (`.aura/blocks/` is gitignored, so it never travels). Now a
    //      teammate who pulls the repo HAS the signed payload to verify.
    //   2. Publish our pubkey into the git-tracked team key registry so the
    //      teammate also has the material — and the trusted binding — to
    //      run the math. Both are best-effort: a failure here must never
    //      break the intent-log path that's existed since v0.1.
    crate::intent_block::mirror_block_to_attest(&id.0.to_string());
    crate::intent_block::publish_self_to_registry(&sk, human_id.as_deref(), now.unix_timestamp());

    Some((id.0.to_string(), key_id))
}

/// Best-effort publish of a freshly-signed intent block to a Rekor
/// transparency log. Returns `Some(entry)` only if both:
///   1. `AURA_REKOR_URL` is set (off-by-default keeps the v0 path hermetic)
///   2. The HTTP POST + canonicalization round-trip succeeds
///
/// All errors are swallowed — a Rekor outage must not break the MCP
/// `aura_log_intent` call. The signed block on disk is still durable; a
/// later `aura attest verify` can republish.
pub(crate) fn publish_intent_to_rekor_best_effort(
    block_id: &str,
) -> Option<crate::rekor::RekorEntryRef> {
    let rekor_url = std::env::var("AURA_REKOR_URL").ok()?;
    if rekor_url.is_empty() {
        return None;
    }
    let key_path = crate::manifest_sig::default_signing_key_path().ok()?;
    let sk = aura_attestation::load_or_create(&key_path).ok()?;
    let pubkey_raw: [u8; 32] = sk.verifying_key().to_bytes();
    let block_path =
        std::path::PathBuf::from(format!(".aura/blocks/{}.json", block_id));
    crate::intent_block::publish_signed_block_to_rekor(
        &block_path,
        &rekor_url,
        &pubkey_raw,
    )
    .ok()
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

// RFC 3986 unreserved-set percent-encoder for query/path components.
// Repo names contain "/", function names may contain ":" or "<", so a
// naive `format!` would produce invalid URLs. Single shared
// implementation — replaces four inlined copies that previously lived
// inside the cloud-wrapper handlers.
pub(crate) fn percent_encode_unreserved(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

// ── Body whitelisting for cloud-wrapper write tools. ──
// The push/patch handlers all forward only an explicit set of body keys
// to the cloud insert. An unknown caller-supplied key — `org_id`,
// `actor_id`, anything else — must NOT make it through. Extracted as
// pure helpers so the whitelist is unit-testable without standing up
// HTTP. Any key listed here is the surface; anything else is dropped.

pub(crate) fn build_a2a_task_patch_body(args: &Value) -> serde_json::Map<String, Value> {
    let mut body = serde_json::Map::new();
    for k in ["status", "result", "error_message"] {
        if let Some(v) = args.get(k) {
            body.insert(k.to_string(), v.clone());
        }
    }
    body
}

pub(crate) fn build_memory_push_body(body_text: &str, args: &Value) -> serde_json::Map<String, Value> {
    let mut payload = serde_json::Map::new();
    payload.insert("body".to_string(), Value::String(body_text.to_string()));
    for k in ["title", "kind", "repo_full_name"] {
        if let Some(v) = args.get(k) {
            payload.insert(k.to_string(), v.clone());
        }
    }
    payload
}

pub(crate) fn build_handover_push_body(args: &Value) -> serde_json::Map<String, Value> {
    let mut body = serde_json::Map::new();
    for k in ["session_id", "agent_name", "summary", "token_count"] {
        if let Some(v) = args.get(k) {
            body.insert(k.to_string(), v.clone());
        }
    }
    body
}

// ── URL builders for read-only cloud-wrapper tools (testable). ──
// Caller passes the trimmed cloud base (no trailing slash) and the raw
// JSON args. The builder is responsible for: applying the documented
// query-param whitelist, percent-encoding any string values, picking
// the correct ?/& separators, and dropping empty/missing values
// instead of emitting `&key=`. This is the security-relevant
// surface — anything not in the whitelist must NOT make it into the
// outgoing URL.

pub(crate) fn build_a2a_task_list_url(base: &str, args: &Value) -> String {
    let mut url = format!("{base}/api/v2/a2a/tasks");
    let mut sep = '?';
    if let Some(s) = args.get("status").and_then(|v| v.as_str()) {
        if !s.trim().is_empty() {
            url.push_str(&format!("{sep}status={}", percent_encode_unreserved(s)));
            sep = '&';
        }
    }
    if let Some(r) = args.get("repo").and_then(|v| v.as_str()) {
        if !r.trim().is_empty() {
            url.push_str(&format!("{sep}repo={}", percent_encode_unreserved(r)));
            sep = '&';
        }
    }
    if let Some(l) = args.get("limit").and_then(|v| v.as_i64()) {
        url.push_str(&format!("{sep}limit={l}"));
    }
    url
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a2a_patch_body_passes_only_whitelisted_keys() {
        let args = json!({
            "id": "task-123",
            "status": "completed",
            "result": {"ok": true},
            "error_message": null,
            "org_id": "smuggled-org",
            "actor_id": "smuggled-actor",
        });
        let body = build_a2a_task_patch_body(&args);
        assert_eq!(body.get("status").and_then(|v| v.as_str()), Some("completed"));
        assert!(body.get("result").is_some());
        assert!(body.get("error_message").is_some());
        assert!(body.get("id").is_none(), "id is in the URL path, must not appear in body");
        assert!(body.get("org_id").is_none(), "unknown key org_id must be dropped");
        assert!(body.get("actor_id").is_none(), "unknown key actor_id must be dropped");
    }

    #[test]
    fn a2a_patch_body_omits_missing_keys() {
        let args = json!({"id": "task-123", "status": "working"});
        let body = build_a2a_task_patch_body(&args);
        assert_eq!(body.len(), 1, "only the present whitelisted keys appear");
        assert_eq!(body.get("status").and_then(|v| v.as_str()), Some("working"));
        assert!(body.get("result").is_none());
        assert!(body.get("error_message").is_none());
    }

    #[test]
    fn memory_push_body_always_includes_body_text() {
        let body = build_memory_push_body("durable note", &json!({}));
        assert_eq!(body.get("body").and_then(|v| v.as_str()), Some("durable note"));
        assert_eq!(body.len(), 1);
    }

    #[test]
    fn memory_push_body_passes_only_whitelisted_optional_keys() {
        let args = json!({
            "title": "design decision",
            "kind": "project",
            "repo_full_name": "owner/repo",
            "actor_id": "smuggled-actor",
            "created_at": "smuggled-timestamp",
        });
        let body = build_memory_push_body("durable note", &args);
        assert_eq!(body.get("title").and_then(|v| v.as_str()), Some("design decision"));
        assert_eq!(body.get("kind").and_then(|v| v.as_str()), Some("project"));
        assert_eq!(body.get("repo_full_name").and_then(|v| v.as_str()), Some("owner/repo"));
        assert!(body.get("actor_id").is_none(), "unknown key actor_id must be dropped");
        assert!(body.get("created_at").is_none(), "unknown key created_at must be dropped");
    }

    #[test]
    fn handover_push_body_passes_only_whitelisted_keys() {
        let args = json!({
            "session_id": "s-abc",
            "agent_name": "claude",
            "summary": "did the thing",
            "token_count": 12345,
            "org_id": "smuggled-org",
            "private_payload": "smuggled",
        });
        let body = build_handover_push_body(&args);
        assert_eq!(body.get("session_id").and_then(|v| v.as_str()), Some("s-abc"));
        assert_eq!(body.get("agent_name").and_then(|v| v.as_str()), Some("claude"));
        assert_eq!(body.get("summary").and_then(|v| v.as_str()), Some("did the thing"));
        assert_eq!(body.get("token_count").and_then(|v| v.as_i64()), Some(12345));
        assert!(body.get("org_id").is_none(), "unknown key org_id must be dropped");
        assert!(body.get("private_payload").is_none(), "unknown key must be dropped");
    }

    #[test]
    fn handover_push_body_omits_missing_keys() {
        let body = build_handover_push_body(&json!({"agent_name": "claude"}));
        assert_eq!(body.len(), 1);
        assert!(body.get("session_id").is_none());
        assert!(body.get("summary").is_none());
        assert!(body.get("token_count").is_none());
    }

    #[test]
    fn percent_encode_passes_unreserved_unchanged() {
        // RFC 3986 unreserved set must round-trip byte-for-byte.
        assert_eq!(percent_encode_unreserved("apply_limiter"), "apply_limiter");
        assert_eq!(percent_encode_unreserved("Foo.Bar-Baz_qux~quux"), "Foo.Bar-Baz_qux~quux");
        assert_eq!(percent_encode_unreserved("0123456789"), "0123456789");
    }

    #[test]
    fn percent_encode_escapes_path_separators_and_query_metachars() {
        // Repo full names ("owner/repo") must not be left unencoded —
        // an unencoded "/" splits the URL path.
        assert_eq!(percent_encode_unreserved("owner/repo"), "owner%2Frepo");
        // Query metachars that would corrupt the parse.
        assert_eq!(percent_encode_unreserved("a&b=c"), "a%26b%3Dc");
        // Whitespace + symbols common in function generics.
        assert_eq!(percent_encode_unreserved("Foo<Bar>"), "Foo%3CBar%3E");
        assert_eq!(percent_encode_unreserved("a b"), "a%20b");
    }

    #[test]
    fn percent_encode_handles_multibyte_utf8() {
        // Multi-byte UTF-8 must percent-encode each byte separately.
        // "é" is 0xC3 0xA9 → "%C3%A9".
        assert_eq!(percent_encode_unreserved("é"), "%C3%A9");
    }

    #[test]
    fn a2a_list_url_no_args_is_bare() {
        let url = build_a2a_task_list_url("http://cloud:3001", &json!({}));
        assert_eq!(url, "http://cloud:3001/api/v2/a2a/tasks");
    }

    #[test]
    fn a2a_list_url_full_args_uses_correct_separators() {
        let url = build_a2a_task_list_url(
            "http://cloud:3001",
            &json!({"status": "submitted", "repo": "owner/repo", "limit": 25}),
        );
        // First param uses ?, subsequent use &. Repo slash is encoded.
        assert_eq!(
            url,
            "http://cloud:3001/api/v2/a2a/tasks?status=submitted&repo=owner%2Frepo&limit=25"
        );
    }

    #[test]
    fn a2a_list_url_drops_empty_strings_and_unknown_keys() {
        let url = build_a2a_task_list_url(
            "http://cloud:3001",
            &json!({"status": "  ", "repo": "", "actor_id": "smuggled", "limit": 10}),
        );
        // Empty/whitespace status + repo skipped; unknown actor_id never
        // forwarded; limit lands on `?` since it's the first emitted param.
        assert_eq!(url, "http://cloud:3001/api/v2/a2a/tasks?limit=10");
    }

    #[test]
    fn a2a_list_url_partial_args_stable_order() {
        let url = build_a2a_task_list_url(
            "http://cloud:3001",
            &json!({"repo": "owner/repo"}),
        );
        // Only repo present → it gets `?`.
        assert_eq!(url, "http://cloud:3001/api/v2/a2a/tasks?repo=owner%2Frepo");
    }
}
