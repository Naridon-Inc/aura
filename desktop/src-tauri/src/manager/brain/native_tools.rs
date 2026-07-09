//! Built-in board tools for the native brain chat loop.
//!
//! This is the "native chat" half of #256 — the sibling of the aura-vcs
//! MCP tools that CLI agents (Claude Code et al.) get. Where the MCP
//! server (`aura-cli/src/mcp.rs`) re-implements a light read/write layer
//! over `.aura/tasks/tasks.json` + `.aura/notes/` because it can't depend
//! on aura-shell, here we are *inside* aura-shell, so we reuse the real
//! domain commands (`cmd_tasks` / `cmd_notes`) verbatim. This module is a
//! thin application-layer adapter: it shapes the model's tool input into
//! the command structs, calls the command, and projects the result back
//! into a compact JSON the model can read.
//!
//! Wired into `cmd_brain_chat::stream_one_brain` — when the active brain
//! is Anthropic-shaped (`aura_pro` / `anthropic_native`) and the caller
//! didn't supply its own tool set, these schemas are injected and the
//! server-side loop executes any `tool_use` the model emits, feeding the
//! results back as `tool_result` blocks until the model stops calling
//! tools. That loop is what lets the in-app Aura chat actually pick a
//! task off the board or read/write a Page, not just stream prose.

use serde::Deserialize;
use serde_json::{Value, json};

use crate::cli_bridge::{PlanPhasePayload, PlanSubtask, PlanTodo, ProposePlanPayload};
use crate::cmd_notes::{NoteListInput, NoteReadInput, NoteWriteInput};
use crate::cmd_tasks::{CreateTaskInput, Task, UpdateTaskInput};
use crate::cmd_tasks_relations::TaskRelation;
use crate::manager::QuestionKind;

/// Provider ids of the two Anthropic-shaped brains. Kept as literals (not
/// `aura_pro::PROVIDER_ID` / the private `anthropic_native` const) so this
/// module stays compilable regardless of which `brain_*` cargo features
/// are enabled — the tool loop simply never fires for a provider that
/// isn't built in.
const AURA_PRO_ID: &str = "aura_pro";
const ANTHROPIC_NATIVE_ID: &str = "anthropic_native";
/// The Gemini (Generative Language API) native brain. It doesn't speak the
/// Anthropic wire shape, but its `Brain` impl translates this module's
/// Anthropic-format tool schemas into Gemini `functionDeclarations` and maps
/// `functionCall`/`functionResponse` back onto the same `ChatChunk::ToolUse`
/// / `tool_result` contract the native loop drives — so it gets the SAME
/// board/page/interactive tools, letting a mid-task Claude→Gemini handoff
/// keep building, not just read.
const GEMINI_NATIVE_ID: &str = "gemini_native";

/// Author handle stamped on Pages the in-app chat writes. The orchestrator
/// is surfaced as "Aura" in the UI; the board author field is free-form so
/// a stable lowercase slug keeps it greppable next to git handles.
pub const CHAT_AUTHOR: &str = "aura";

/// Cap on a single tool result fed back to the model (and shown on the
/// tool card). A full board can be large; this keeps one round bounded
/// without losing the leading rows the model actually reasons over.
const MAX_RESULT_CHARS: usize = 16_000;

/// The tool names this module owns. Used both to build the schema list and
/// to gate execution so a stray `tool_use` for some other tool name isn't
/// silently dispatched here.
pub const TOOL_NAMES: [&str; 10] = [
    "aura_tasks_list",
    "aura_tasks_ready",
    "aura_task_get",
    "aura_task_create",
    "aura_task_update",
    "aura_pages_list",
    "aura_page_read",
    "aura_page_write",
    // Code-understanding tools — the grep/whole-file-read replacements. These
    // are the "our things instead of grep" half: the model reaches for the
    // codebase MAP and Q&A rather than scanning files, which is both faster and
    // far cheaper in tokens (the saving the chat surfaces per turn).
    "aura_atlas",
    "aura_ask",
];

/// Whether a brain can drive the native tool loop. The two Anthropic-shaped
/// brains (`aura_pro` proxies to Anthropic; `anthropic_native` is direct)
/// take this module's tool schemas verbatim. The Gemini native brain
/// (`gemini_native`) also qualifies: it doesn't speak the Anthropic wire
/// shape, but its `Brain` impl translates the same Anthropic-format `tools`
/// into Gemini `functionDeclarations` and maps `functionCall` /
/// `functionResponse` back onto the loop's `ChatChunk::ToolUse` /
/// `tool_result` contract — so a Claude→Gemini handoff keeps the SAME board,
/// page, and interactive tools instead of going tool-free.
///
/// Everything else (OpenAI, CLI wrappers, OpenAI-compat) keeps its existing
/// no-tool behaviour so the request stays byte-identical for those providers.
pub fn supports(provider_id: &str) -> bool {
    provider_id == AURA_PRO_ID
        || provider_id == ANTHROPIC_NATIVE_ID
        || provider_id == GEMINI_NATIVE_ID
}

/// True when `name` is one of the built-in board tools.
pub fn is_board_tool(name: &str) -> bool {
    TOOL_NAMES.contains(&name)
}

/// Anthropic-format tool schemas for the board tools. Field names are
/// chosen to deserialize straight into the `cmd_tasks` / `cmd_notes` input
/// structs (`status`, `priority`, `assignee`, `scope`, `bucket`, `body`,
/// …) so the executor is a thin `from_value` + call.
pub fn board_tool_schemas() -> Vec<Value> {
    vec![
        json!({
            "name": "aura_tasks_list",
            "description": "List tasks from this project's Tasks board — the same board the user sees in the app. Optionally filter by status and cap the count.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "status": {
                        "type": "string",
                        "description": "Filter by status/state, e.g. backlog, in_progress, in_review, done, completed, started, unstarted. Omit to list all."
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Max number of tasks to return (default 50)."
                    }
                },
                "required": []
            }
        }),
        json!({
            "name": "aura_tasks_ready",
            "description": "List the tasks that are READY to work on right now — actionable tasks whose every dependency and blocker is already done. This is the unblocked work frontier: prefer picking the top of THIS list over scanning the whole board, because anything here can be started immediately without waiting on other work. Results are ordered by priority then sequence. Optionally filter to a single agent and cap the count.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "agent": {
                        "type": "string",
                        "description": "Only ready tasks owned by this agent (claude, gemini, codex, aura). Omit to include every agent and unassigned tasks."
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Max number of ready tasks to return (default 20)."
                    }
                },
                "required": []
            }
        }),
        json!({
            "name": "aura_task_get",
            "description": "Get one task's full detail — identify it by its reference (e.g. 'AURA-42'), its sequence number, or its internal id.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "id": {
                        "type": "string",
                        "description": "Task reference 'AURA-{n}', bare sequence number, or internal id."
                    }
                },
                "required": ["id"]
            }
        }),
        json!({
            "name": "aura_task_create",
            "description": "Create a NEW task on the board — the same board the user sees in the app. Use this to turn a plan into real, trackable work: mint one task per step. Only `title` is required; everything else is optional. To capture order, pass the tasks an item depends on in `dependencies` (each an existing 'AURA-{n}', sequence number, or internal id) — a task only becomes ready to work once every dependency is done. Hand a task to an agent with `agent_assignee` (claude, gemini, codex, aura). Group a body of work under a parent by setting `parent_id`, or mark this task itself the umbrella with `is_epic`. Returns the created task with its new AURA-ref so you can reference it when creating dependents.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "title": { "type": "string", "description": "Short imperative title, e.g. 'Add OAuth callback route'." },
                    "description": { "type": "string", "description": "Fuller spec / acceptance notes for whoever picks it up." },
                    "priority": { "type": "string", "enum": ["urgent", "high", "medium", "low", "none"], "description": "Defaults to none." },
                    "status": { "type": "string", "description": "Initial status, e.g. backlog (default), in_progress." },
                    "agent_assignee": { "type": "string", "description": "AI agent to own this task (claude, gemini, codex, aura)." },
                    "assignee": { "type": "string", "description": "Human git handle to assign." },
                    "labels": { "type": "array", "items": { "type": "string" }, "description": "Free-form label strings." },
                    "parent_id": { "type": "string", "description": "Make this a sub-task of an existing task (AURA-ref, sequence, or internal id)." },
                    "is_epic": { "type": "boolean", "description": "Mark this task as an epic — the umbrella others hang under." },
                    "objective": { "type": "string", "description": "The user-facing goal this task delivers, in one plain sentence." },
                    "dependencies": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "Existing tasks that must finish before this one can start. Each an 'AURA-{n}', sequence number, or internal id."
                    }
                },
                "required": ["title"]
            }
        }),
        json!({
            "name": "aura_task_update",
            "description": "Update a task on the board. Identify it with `id` (AURA-ref, sequence, or internal id) and supply only the fields to change. Use this to pick up a task (set status to in_progress / assign yourself) or mark it done.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "AURA-ref, sequence number, or internal id." },
                    "status": { "type": "string", "description": "New status: backlog, in_progress, in_review, done." },
                    "state_id": { "type": "string", "description": "Canonical state id, if you know it (overrides status)." },
                    "priority": { "type": "string", "enum": ["urgent", "high", "medium", "low", "none"] },
                    "assignee": { "type": "string", "description": "Git handle to assign. Empty string clears the assignee." },
                    "agent_assignee": { "type": "string", "description": "AI agent to own this task (claude, gemini, codex, aura). Empty string clears it." },
                    "title": { "type": "string" },
                    "description": { "type": "string" },
                    "due_date": { "type": "string", "description": "YYYY-MM-DD." },
                    "labels": { "type": "array", "items": { "type": "string" } }
                },
                "required": ["id"]
            }
        }),
        json!({
            "name": "aura_pages_list",
            "description": "List Pages (team docs) in this project. Optionally scope to team, a channel, or a member.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "scope": { "type": "string", "enum": ["team", "channel", "member"], "description": "Page scope. Omit to list every scope." },
                    "bucket": { "type": "string", "description": "Channel id (for channel scope) or member handle (for member scope)." }
                },
                "required": []
            }
        }),
        json!({
            "name": "aura_page_read",
            "description": "Read one Page's full markdown body plus its metadata (title, tags, visibility).",
            "input_schema": {
                "type": "object",
                "properties": {
                    "scope": { "type": "string", "enum": ["team", "channel", "member"] },
                    "bucket": { "type": "string", "description": "Channel id / member handle. Empty for team scope." },
                    "id": { "type": "string", "description": "Page id." }
                },
                "required": ["scope", "id"]
            }
        }),
        json!({
            "name": "aura_page_write",
            "description": "Create or update a Page (team doc). Omit `id` to create a new page; pass an existing `id` to overwrite it. `scope` and `body` are required.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "scope": { "type": "string", "enum": ["team", "channel", "member"] },
                    "bucket": { "type": "string", "description": "Channel id (channel scope) or member handle (member scope). Empty for team." },
                    "id": { "type": "string", "description": "Existing page id to overwrite. Omit to create a new page." },
                    "title": { "type": "string" },
                    "body": { "type": "string", "description": "Markdown body." },
                    "tags": { "type": "array", "items": { "type": "string" } },
                    "visibility": { "type": "string", "enum": ["private", "shared"] }
                },
                "required": ["scope", "body"]
            }
        }),
        json!({
            "name": "aura_atlas",
            "description": "Look up the project's CODE MAP — Aura's plain-English directory of what every notable symbol (function, component, route, command) IS and DOES, with its file and line. PREFER THIS over grep/ripgrep or reading whole files when you need to understand the codebase: where something lives, what a function is for, what the moving parts are. It returns focused one-line summaries instead of raw file bytes, so it answers 'where/what is X' in a fraction of the tokens. Pass `query` to filter to a topic, symbol, or file substring; omit it for the top of the map. Returns rows of {name, title, role, layer, file, line, summary}.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Filter to symbols whose name, title, summary, or file path contains this (case-insensitive). Omit for the highest-level entries." },
                    "limit": { "type": "integer", "description": "Max rows to return (default 40)." }
                },
                "required": []
            }
        }),
        json!({
            "name": "aura_ask",
            "description": "Ask a natural-language question ABOUT THIS CODEBASE and get an answer synthesized from Aura's rationale graph (per-function WHY explanations) with citations to the exact code. PREFER THIS over opening and reading several files to figure out 'why does X do Y', 'what handles Z', or 'how does A connect to B' — it reads the graph for you and hands back the answer, not a pile of file contents. Use a focused question.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "question": { "type": "string", "description": "A focused question about how this codebase works, in plain language." }
                },
                "required": ["question"]
            }
        }),
    ]
}

// ── interactive tools (ask_user / propose_plan) ─────────────────────────
//
// The two tools that drive a *card* rather than a board mutation. They are
// the native-loop twins of what a CLI brain reaches by shelling out to
// `aura ask-user` / `aura propose-plan`: instead of a subprocess writing
// the socket envelope, the native loop calls `ask_user_blocking` /
// `propose_plan_blocking` directly (see `cmd_permission_socket`). Both
// register a `BridgeRegistry` waiter and project a `pending_question` /
// `pending_plan` onto the Manager session, so the existing QuestionCard /
// PlanCard render the surface and `manager_answer_question` /
// `manager_decide_plan` resolve them — zero frontend work, and a plan's
// Build mints the same dependency-ordered a2a tasks the Crew runs.

/// Anthropic-format schemas for the interactive tools. Field names mirror
/// the `aura propose-plan` envelope (`title`/`summary`/`objective`/
/// `baseline`/`phases`/`deliverables`/`tests`/`todos`) so the model that
/// already knows that envelope from the CLI doctrine emits the same shape.
pub fn interactive_tool_schemas() -> Vec<Value> {
    vec![
        json!({
            "name": "ask_user",
            "description": "Ask the user a clarifying question — and BLOCK until they answer — when a decision would change the shape of the work (which approach, scope, where it lives). Use this, not a prose question buried in your reply. You may ask ONE question (top-level `question`/`kind`/`options`), OR batch a small RELATED set of up to 4 via `questions` so they surface together as one card the user answers in a single pass — use the set only when a few decisions naturally cluster, and never pad it (ask only what you genuinely need). After they answer, you may call this AGAIN with another set if their answers open a new decision. Prefer `options` when the choices are known so the user can click rather than type. Returns the user's answer(s) as text.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "question": {
                        "type": "string",
                        "description": "A single question to put to the user, in plain language. Use this OR `questions` (not both)."
                    },
                    "kind": {
                        "type": "string",
                        "enum": ["choice", "multi_choice", "text"],
                        "description": "For the single-question form: choice = pick one of `options`; multi_choice = pick any of `options`; text = free-form answer. Default text."
                    },
                    "options": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "Selectable answers for choice/multi_choice. Omit for a text question."
                    },
                    "questions": {
                        "type": "array",
                        "description": "A clubbed set of 1–4 related questions to ask together as one card. Use instead of `question` when several decisions cluster. Each is answered independently; the user can also type a custom answer to any of them.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "question": {
                                    "type": "string",
                                    "description": "This question, in plain language."
                                },
                                "header": {
                                    "type": "string",
                                    "description": "A 1–3 word label for this question, shown as a chip above it (e.g. \"Database\", \"Auth\")."
                                },
                                "kind": {
                                    "type": "string",
                                    "enum": ["choice", "multi_choice", "text"],
                                    "description": "choice = pick one of `options`; multi_choice = pick any; text = free-form. Default: choice when `options` given, else text."
                                },
                                "options": {
                                    "type": "array",
                                    "items": { "type": "string" },
                                    "description": "Selectable answers for choice/multi_choice. Omit for a text question."
                                }
                            },
                            "required": ["question"]
                        }
                    }
                }
            }
        }),
        json!({
            "name": "propose_plan",
            "description": "Present a plan to the user as a plan card and BLOCK until they press Build or Cancel. Use this for any non-trivial work — a multi-file change, a new feature, a refactor — instead of dumping a bullet list in chat or quietly scattering tasks onto the board. On Build, Aura mints one dependency-ordered task per `todos` entry onto the board and the Crew works them in order, so you do NOT separately call aura_task_create for a plan you proposed. On Cancel, STOP — do not create tasks or start work the user didn't approve.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "title": { "type": "string", "description": "Short plan title for the card header." },
                    "summary": { "type": "string", "description": "One-line synopsis shown on the card." },
                    "objective": { "type": "string", "description": "What the user is asking for and why (a paragraph). Recommended for plans touching 3+ files." },
                    "baseline": { "type": "string", "description": "Markdown describing the CURRENT state — files, integrations, gaps. The 'before' picture." },
                    "architecture_mermaid": { "type": "string", "description": "Optional raw mermaid (flowchart/sequenceDiagram). Keep node ids alphanumeric. Rendered inline as an SVG." },
                    "phases": {
                        "type": "array",
                        "description": "3–7 ordered phases the work moves through. Recommended for plans touching 3+ files.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "title": { "type": "string" },
                                "body": { "type": "string", "description": "Short markdown (a paragraph, not a tutorial)." },
                                "file_refs": { "type": "array", "items": { "type": "string" }, "description": "Repo-relative paths this phase touches." }
                            },
                            "required": ["title"]
                        }
                    },
                    "deliverables": { "type": "array", "items": { "type": "string" }, "description": "Concrete outcomes the user can check off." },
                    "tests": { "type": "array", "items": { "type": "string" }, "description": "How the work is verified (manual or automated checks)." },
                    "todos": {
                        "type": "array",
                        "description": "One entry per step. Each becomes a board task on Build, in this order, with earlier todos as dependencies of later ones so the Crew works them in sequence. Give each step a real `goal` and `acceptance` plan — bare titles produce thin tasks the Crew can't verify. Break a step into `subtasks` only when it genuinely splits into independently-runnable pieces; a leaf step needs none.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "description": { "type": "string", "description": "What this step does." },
                                "agent": { "type": "string", "description": "Agent best suited to it: claude / gemini / codex / aura." },
                                "file_refs": { "type": "array", "items": { "type": "string" }, "description": "Repo-relative paths this step touches." },
                                "assignee": { "type": "string", "description": "Teammate email/username to hand this step to, when the user named one. Omit for solo work." },
                                "goal": { "type": "string", "description": "What 'done' looks like for this step in plain language — the outcome the Crew can later prove (e.g. 'Users can sign in with Google and land on the dashboard'). Becomes a real linked goal in the ledger." },
                                "acceptance": { "type": "array", "items": { "type": "string" }, "description": "The verify plan: 2–5 concrete checks that confirm the goal is met ('Build succeeds', 'Sign-in returns a session token', 'Logout clears it'). A human or the Crew ticks these off." },
                                "subtasks": {
                                    "type": "array",
                                    "description": "Optional. Split this step into independently-runnable sub-steps ONLY when it really decomposes; the step then becomes a grouping the Crew does not run directly, and each sub-step becomes its own task. Omit for a leaf step.",
                                    "items": {
                                        "type": "object",
                                        "properties": {
                                            "description": { "type": "string", "description": "What this sub-step does." },
                                            "agent": { "type": "string", "description": "Agent best suited to it: claude / gemini / codex / aura." },
                                            "goal": { "type": "string", "description": "What 'done' looks like for this sub-step." },
                                            "acceptance": { "type": "array", "items": { "type": "string" }, "description": "The verify plan for this sub-step's goal." }
                                        },
                                        "required": ["description"]
                                    }
                                }
                            },
                            "required": ["description"]
                        }
                    }
                },
                "required": ["title", "todos"]
            }
        }),
    ]
}

/// Every tool the native loop offers: the board tools plus the two
/// interactive (card-driving) tools. This is what `stream_one_brain`
/// injects into the request for an Anthropic-shaped brain.
pub fn all_tool_schemas() -> Vec<Value> {
    let mut v = board_tool_schemas();
    v.extend(interactive_tool_schemas());
    v
}

/// Fold a tool name to a comparison key: lowercase, hyphens/underscores
/// stripped. Lets a single match arm accept the model's training-baked
/// PascalCase aliases (`AskUserQuestion`, `ExitPlanMode`) alongside our
/// declared snake_case names.
fn normalize_tool_name(name: &str) -> String {
    name.to_ascii_lowercase().replace(['-', '_'], "")
}

/// True when `name` is an interactive (card-driving) tool — `ask_user` or
/// `propose_plan`, plus the SDK aliases the model may reach for from
/// training (`AskUserQuestion`, `ExitPlanMode`). These do NOT route through
/// `execute_board_tool`; the loop runs them via `run_interactive_tool`.
pub fn is_interactive_tool(name: &str) -> bool {
    matches!(
        normalize_tool_name(name).as_str(),
        "askuser" | "askuserquestion" | "ask" | "proposeplan" | "exitplanmode"
    )
}

/// True when `name` is specifically the plan tool (vs the question tool).
pub fn is_plan_tool(name: &str) -> bool {
    matches!(
        normalize_tool_name(name).as_str(),
        "proposeplan" | "exitplanmode"
    )
}

/// Normalize either `ask_user` shape into a `(question, options, kind)`
/// tuple. Ported from the legacy CLI brain so the native loop accepts the
/// same two forms: the Claude-SDK `AskUserQuestion` envelope (payload in
/// `questions[0]` with PascalCase `multiSelect` and `options:[{label}]`)
/// and our flat `{question, kind, options:[string]}`.
/// Parse an `ask_user` tool input into the FULL set of 1–4 questions the
/// brain asked. Accepts both forms: the Claude-SDK `AskUserQuestion`
/// envelope (`questions:[{question, header, options:[{label}|str], multiSelect}]`,
/// capped at 4 — past that it's an interrogation, not a clarifying set) and
/// our flat single-question shape (`{question, kind, options:[string]}` → a
/// 1-item set). Always returns at least one item.
pub fn parse_ask_user_set(input: &Value) -> Vec<crate::manager::QuestionItem> {
    use crate::manager::QuestionItem;
    if let Some(arr) = input.get("questions").and_then(|v| v.as_array()) {
        let items: Vec<QuestionItem> = arr
            .iter()
            .filter_map(|v| v.as_object())
            .take(4)
            .map(|obj| {
                let question = obj
                    .get("question")
                    .and_then(|s| s.as_str())
                    .or_else(|| obj.get("header").and_then(|s| s.as_str()))
                    .unwrap_or("(empty question)")
                    .to_string();
                // `header` is the SDK's short label — keep it only when it
                // adds something beyond the question text itself.
                let header = obj
                    .get("header")
                    .and_then(|s| s.as_str())
                    .map(|s| s.trim())
                    .filter(|h| !h.is_empty() && *h != question.as_str())
                    .map(|s| s.to_string());
                let options = parse_option_labels(obj.get("options"));
                // Honor an explicit `kind` (our vocabulary) when present, else
                // fall back to the SDK's `multiSelect` boolean / options shape.
                let kind = match obj.get("kind").and_then(|s| s.as_str()) {
                    Some("choice") => QuestionKind::Choice,
                    Some("multi_choice") => QuestionKind::MultiChoice,
                    Some("text") => QuestionKind::Text,
                    _ => {
                        let multi = obj
                            .get("multiSelect")
                            .and_then(|v| v.as_bool())
                            .unwrap_or(false);
                        if multi {
                            QuestionKind::MultiChoice
                        } else if !options.is_empty() {
                            QuestionKind::Choice
                        } else {
                            QuestionKind::Text
                        }
                    }
                };
                QuestionItem { question, options, kind, header }
            })
            .collect();
        if !items.is_empty() {
            return items;
        }
    }
    let question = input
        .get("question")
        .and_then(|s| s.as_str())
        .unwrap_or("(empty question)")
        .to_string();
    let options = parse_option_labels(input.get("options"));
    let kind = match input.get("kind").and_then(|s| s.as_str()).unwrap_or("text") {
        "choice" => QuestionKind::Choice,
        "multi_choice" => QuestionKind::MultiChoice,
        _ => QuestionKind::Text,
    };
    vec![QuestionItem { question, options, kind, header: None }]
}

/// Normalize an `options` value into a flat `Vec<String>`, accepting both a
/// plain `["a","b"]` array and the SDK's `[{label,description}]` objects.
fn parse_option_labels(v: Option<&Value>) -> Vec<String> {
    v.and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|opt| {
                    if let Some(s) = opt.as_str() {
                        Some(s.to_string())
                    } else if let Some(o) = opt.as_object() {
                        o.get("label").and_then(|s| s.as_str()).map(|s| s.to_string())
                    } else {
                        None
                    }
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Back-compat shim: the first question of the set as a `(question, options,
/// kind)` tuple. Single-question callers (the CLI socket bridge) + the unit
/// tests keep working unchanged.
pub fn parse_ask_user(input: &Value) -> (String, Vec<String>, QuestionKind) {
    let first = parse_ask_user_set(input)
        .into_iter()
        .next()
        .expect("parse_ask_user_set always returns at least one item");
    (first.question, first.options, first.kind)
}

/// Build a [`ProposePlanPayload`] from the model's `propose_plan` tool
/// input. Field names mirror the `aura propose-plan` envelope, so this is
/// mostly a defensive `from_value` with per-field fallbacks. Two extra
/// shapes are tolerated: the Claude-SDK `ExitPlanMode` form (a bare
/// markdown `plan` string with no structured todos — folded into
/// `objective` with a title derived from its first line), and a `todos`
/// entry that names the step `content` instead of `description`.
/// Collect a JSON array field into trimmed, non-empty strings. Works on any
/// nested value (unlike the input-keyed `str_vec` closure below), so it's the
/// helper the per-todo / per-subtask parse uses for `file_refs` + `acceptance`.
fn str_array(v: Option<&Value>) -> Vec<String> {
    v.and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
                .collect()
        })
        .unwrap_or_default()
}

pub fn parse_propose_plan(input: &Value, session_id: &str) -> ProposePlanPayload {
    // ExitPlanMode / bare-markdown fallback: no structured plan, just prose.
    if input.get("todos").is_none() && input.get("phases").is_none() {
        if let Some(plan_md) = input.get("plan").and_then(|v| v.as_str()) {
            return ProposePlanPayload {
                session_id: session_id.to_string(),
                title: first_line_title(plan_md),
                summary: String::new(),
                objective: Some(plan_md.to_string()),
                baseline: None,
                architecture_mermaid: None,
                phases: Vec::new(),
                deliverables: Vec::new(),
                tests: Vec::new(),
                todos: Vec::new(),
                force_skip_scout: false,
            };
        }
    }

    let str_field = |k: &str| {
        input
            .get(k)
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
    };
    let str_vec = |k: &str| -> Vec<String> {
        input
            .get(k)
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default()
    };

    let phases = input
        .get("phases")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|p| {
                    let o = p.as_object()?;
                    let title = o.get("title").and_then(|v| v.as_str()).unwrap_or("");
                    if title.is_empty() {
                        return None;
                    }
                    Some(PlanPhasePayload {
                        title: title.to_string(),
                        body: o
                            .get("body")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string(),
                        file_refs: o
                            .get("file_refs")
                            .and_then(|v| v.as_array())
                            .map(|a| {
                                a.iter()
                                    .filter_map(|x| x.as_str().map(|s| s.to_string()))
                                    .collect()
                            })
                            .unwrap_or_default(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    let todos = input
        .get("todos")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|t| {
                    let o = t.as_object()?;
                    let description = o
                        .get("description")
                        .and_then(|v| v.as_str())
                        .or_else(|| o.get("content").and_then(|v| v.as_str()))
                        .unwrap_or("")
                        .trim()
                        .to_string();
                    if description.is_empty() {
                        return None;
                    }
                    Some(PlanTodo {
                        description,
                        agent: o.get("agent").and_then(|v| v.as_str()).map(|s| s.to_string()),
                        file_refs: str_array(o.get("file_refs")),
                        assignee: o
                            .get("assignee")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string()),
                        goal: o
                            .get("goal")
                            .and_then(|v| v.as_str())
                            .map(str::trim)
                            .filter(|s| !s.is_empty())
                            .map(|s| s.to_string()),
                        acceptance: str_array(o.get("acceptance")),
                        subtasks: o
                            .get("subtasks")
                            .and_then(|v| v.as_array())
                            .map(|arr| {
                                arr.iter()
                                    .filter_map(|s| {
                                        let so = s.as_object()?;
                                        let description = so
                                            .get("description")
                                            .and_then(|v| v.as_str())
                                            .or_else(|| so.get("content").and_then(|v| v.as_str()))
                                            .unwrap_or("")
                                            .trim()
                                            .to_string();
                                        if description.is_empty() {
                                            return None;
                                        }
                                        Some(PlanSubtask {
                                            description,
                                            agent: so
                                                .get("agent")
                                                .and_then(|v| v.as_str())
                                                .map(|s| s.to_string()),
                                            goal: so
                                                .get("goal")
                                                .and_then(|v| v.as_str())
                                                .map(str::trim)
                                                .filter(|s| !s.is_empty())
                                                .map(|s| s.to_string()),
                                            acceptance: str_array(so.get("acceptance")),
                                        })
                                    })
                                    .collect()
                            })
                            .unwrap_or_default(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    ProposePlanPayload {
        session_id: session_id.to_string(),
        title: str_field("title").unwrap_or_else(|| "Proposed plan".to_string()),
        summary: str_field("summary").unwrap_or_default(),
        objective: str_field("objective"),
        baseline: str_field("baseline"),
        architecture_mermaid: str_field("architecture_mermaid"),
        phases,
        deliverables: str_vec("deliverables"),
        tests: str_vec("tests"),
        todos,
        force_skip_scout: false,
    }
}

/// Derive a short plan title from a markdown body's first non-empty line:
/// strip a leading `#`/`-`/`*` and cap the length. Used only for the
/// ExitPlanMode fallback, which carries no explicit title.
fn first_line_title(markdown: &str) -> String {
    let line = markdown
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("Proposed plan");
    let cleaned = line.trim_start_matches(['#', '-', '*', ' ']).trim();
    let cleaned = if cleaned.is_empty() { "Proposed plan" } else { cleaned };
    if cleaned.chars().count() > 80 {
        let head: String = cleaned.chars().take(80).collect();
        format!("{head}…")
    } else {
        cleaned.to_string()
    }
}

/// Tools blurb appended to every system prompt so the model knows the
/// board tools exist and when to reach for them. Byte-stable (no
/// per-turn interpolation) so it can sit inside the cached prompt
/// prefix.
const TOOLS_BLURB: &str = "\n\nYou can read and act on this project's Tasks board and Pages (team docs) \
directly through tools: aura_tasks_list / aura_tasks_ready / aura_task_get / aura_task_create / \
aura_task_update for the same Tasks board the user sees, and aura_pages_list / aura_page_read / \
aura_page_write for Pages. When the user asks about tasks or docs — to find work, pick up a task, check \
status, or read/write a doc — use these tools instead of guessing. To choose what to work on next, call \
aura_tasks_ready: it returns only the tasks whose dependencies and blockers are already done, so you \
never pick up work that's still blocked.\n\n\
UNDERSTANDING THE CODE. To learn the codebase — where something is defined, what a function \
does, how the pieces connect — reach for Aura's own tools instead of grepping or reading whole \
files: call aura_atlas for the code map (plain-English summary of each symbol with its file and \
line) and aura_ask to ask a question and get an answer with citations. They return a focused \
answer rather than raw file bytes, so they're faster and cost a fraction of the tokens. Read a \
full file only when you actually need its exact contents (to quote or edit it), not to go \
fishing for where something lives.\n\n\
PLANNING. For anything non-trivial — a multi-file change, a new feature, a refactor — do NOT dump a \
bullet list in chat and do NOT quietly scatter tasks onto the board. Instead:\n\
(1) If a single decision would change the shape of the work (which approach, scope, where it lives), \
call ask_user ONCE to settle it — one crisp question, with `options` when the choices are known. Ask \
only what you genuinely need; don't interrogate.\n\
(2) Present the plan with propose_plan. Give it a `title`, a one-line `summary`, and a `todos` list — \
one todo per step, each with a short `description`, the `agent` best suited to it (claude / gemini / \
codex / aura), and the `file_refs` it touches. For a plan touching 3+ files also fill `objective`, \
`baseline`, `phases`, `deliverables` and `tests` — the user weighs these before deciding. propose_plan \
shows a plan card and BLOCKS until the user presses Build or Cancel.\n\
(3) On Build, Aura mints one dependency-ordered task per todo onto the board and the Crew works them in \
order — so you do NOT separately call aura_task_create for a plan you proposed; Build already did. If \
the user Cancels, STOP — do not create tasks or start work they didn't approve.\n\n\
For a single, well-understood task with no open questions you may skip propose_plan and call \
aura_task_create directly — capture ordering by passing earlier steps' AURA-refs in a later step's \
`dependencies`, and hand a step to an agent with `agent_assignee`. After acting, briefly confirm what \
you changed.";

/// A short system-prompt addendum so the model knows the board tools exist
/// and when to reach for them, plus this project's *binding constraints*
/// (conventions / security / boundary rules read from `.aura/memory.json`)
/// rendered as hard rules. Appended to (not replacing) any existing system
/// prompt so the brain's own persona stays intact.
///
/// The whole addendum is derived only from on-disk project state, so it's
/// byte-stable across the turns of a session — which is exactly what lets
/// the caller cache the system+tools prefix (see the brains' `cache_control`
/// markers).
pub fn augment_system(existing: Option<&str>, repo_root: &str) -> String {
    let mut addendum = String::from(TOOLS_BLURB);
    if let Some(rules) = binding_constraints_block(repo_root) {
        addendum.push_str(&rules);
    }
    match existing {
        Some(s) if !s.trim().is_empty() => format!("{s}{addendum}"),
        _ => addendum.trim_start().to_string(),
    }
}

/// Cap on how many binding constraints we inline, and how long each line
/// may be. Keeps the system prefix bounded (and therefore cache-friendly)
/// even on a project with a sprawling memory file.
const MAX_BINDING_CONSTRAINTS: usize = 16;
const MAX_CONSTRAINT_CHARS: usize = 200;

/// Minimal read-only projection of `.aura/memory.json` — just the sections
/// that can carry a hard rule. Deliberately a local struct rather than a
/// dependency on the `aura` crate's `ProjectMemory`: we only need three
/// string-bearing arrays and want this module to stay compilable on its
/// own.
#[derive(Deserialize, Default)]
struct MemoryFile {
    #[serde(default)]
    conventions: Vec<MemoryItem>,
    #[serde(default)]
    gotchas: Vec<MemoryItem>,
    #[serde(default)]
    context: Vec<MemoryItem>,
}

#[derive(Deserialize)]
struct MemoryItem {
    #[serde(default)]
    content: String,
    #[serde(default)]
    tags: Vec<String>,
}

/// Build the "binding constraints" block from the project's memory file, or
/// `None` when there's nothing binding to say. Every `conventions` entry is
/// a CONVENTION rule; `gotchas`/`context` entries are included only when a
/// tag marks them as a SECURITY or BOUNDARY rule. Order follows the file so
/// the rendered block is deterministic (and the prefix stays cacheable).
fn binding_constraints_block(repo_root: &str) -> Option<String> {
    if repo_root.is_empty() {
        return None;
    }
    let path = std::path::Path::new(repo_root)
        .join(".aura")
        .join("memory.json");
    let raw = std::fs::read_to_string(&path).ok()?;
    let mem: MemoryFile = serde_json::from_str(&raw).ok()?;

    let mut rules: Vec<String> = Vec::new();
    for c in &mem.conventions {
        if let Some(line) = constraint_line("CONVENTION", &c.content) {
            rules.push(line);
        }
    }
    for item in mem.gotchas.iter().chain(mem.context.iter()) {
        if let Some(label) = binding_label(&item.tags) {
            if let Some(line) = constraint_line(label, &item.content) {
                rules.push(line);
            }
        }
    }
    if rules.is_empty() {
        return None;
    }
    rules.truncate(MAX_BINDING_CONSTRAINTS);

    let mut block = String::from(
        "\n\nProject binding constraints — treat these as HARD rules, not suggestions. \
Do not violate them; if a user request conflicts with one, say so and stop rather than break it:",
    );
    for r in &rules {
        block.push_str("\n- ");
        block.push_str(r);
    }
    Some(block)
}

/// Classify a gotcha/context entry into a binding bucket by its tags, or
/// `None` when no tag marks it as a hard rule. Conventions skip this — they
/// are always binding.
fn binding_label(tags: &[String]) -> Option<&'static str> {
    let has = |needles: &[&str]| {
        tags.iter().any(|t| {
            let l = t.trim().to_ascii_lowercase();
            needles.contains(&l.as_str())
        })
    };
    if has(&[
        "security",
        "secret",
        "secrets",
        "credential",
        "credentials",
        "auth",
        "token",
        "apikey",
        "api_key",
        "key",
    ]) {
        Some("SECURITY")
    } else if has(&[
        "boundary",
        "layer",
        "layers",
        "arch",
        "architecture",
        "forbidden",
        "never",
        "invariant",
        "rule",
        "constraint",
    ]) {
        Some("BOUNDARY")
    } else {
        None
    }
}

/// Render one constraint line: collapse internal whitespace to single
/// spaces (so a multi-line memory entry becomes one bullet), trim, cap the
/// length, and prefix the bucket label. `None` for an empty entry.
fn constraint_line(label: &str, content: &str) -> Option<String> {
    let flat = content.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.is_empty() {
        return None;
    }
    let body = if flat.chars().count() > MAX_CONSTRAINT_CHARS {
        let head: String = flat.chars().take(MAX_CONSTRAINT_CHARS).collect();
        format!("{head}…")
    } else {
        flat
    };
    Some(format!("[{label}] {body}"))
}

/// Dispatch one board tool call. Returns `(result_text, is_error)` — the
/// text is fed back to the model as a `tool_result` block and shown on the
/// tool card. Never panics: a bad argument or a missing record comes back
/// as `(message, true)` so the model can recover rather than the turn
/// dying.
pub async fn execute_board_tool(
    repo_root: &str,
    name: &str,
    input: &Value,
    author: &str,
) -> (String, bool, u32) {
    // The code-understanding tools report an estimate of the tokens they
    // saved (vs the brain reading the underlying files itself); the board
    // tools touch no source, so they save nothing.
    let (text, is_error, saved) = match name {
        "aura_atlas" => tool_atlas(repo_root, input).await,
        "aura_ask" => tool_ask(repo_root, input).await,
        _ => {
            let (text, is_error) = match name {
                "aura_tasks_list" => tool_tasks_list(repo_root, input).await,
                "aura_tasks_ready" => tool_tasks_ready(repo_root, input).await,
                "aura_task_get" => tool_task_get(repo_root, input).await,
                "aura_task_create" => tool_task_create(repo_root, input).await,
                "aura_task_update" => tool_task_update(repo_root, input).await,
                "aura_pages_list" => tool_pages_list(repo_root, input).await,
                "aura_page_read" => tool_page_read(repo_root, input).await,
                "aura_page_write" => tool_page_write(repo_root, input, author).await,
                other => (format!("unknown tool: {other}"), true),
            };
            (text, is_error, 0u32)
        }
    };
    (truncate(&text, MAX_RESULT_CHARS), is_error, saved)
}

// ── code-understanding tools (grep replacements) ───────────────────────
//
// These reach for Aura's semantic layer instead of raw file reads, and
// report a *conservative* estimate of the tokens they saved versus the
// brain opening the underlying files itself. We only ever credit bytes a
// tool actually touched (the files its answer drew from), never the whole
// repo, and the estimate is clamped at zero — a tool never reports a loss.

/// Rough token count for `bytes` of source — ~3.5 chars/token, matching
/// the manager's other estimators.
fn est_tokens_from_bytes(bytes: u64) -> u32 {
    ((bytes as f64) / 3.5).ceil() as u32
}

/// Savings = (what reading the source would have cost) − (what the focused
/// answer costs). Saturating, so it never underflows below zero.
fn estimate_saved(source_bytes: u64, result_text: &str) -> u32 {
    let baseline = est_tokens_from_bytes(source_bytes);
    let spent = est_tokens_from_bytes(result_text.len() as u64);
    baseline.saturating_sub(spent)
}

/// Sum the byte sizes of the distinct `paths` that exist as files under
/// `repo_root`. Missing paths contribute nothing — we never credit files we
/// can't actually see on disk.
fn sum_existing_file_bytes(
    repo_root: &str,
    paths: impl IntoIterator<Item = String>,
) -> u64 {
    let root = std::path::Path::new(repo_root);
    let mut seen = std::collections::HashSet::new();
    let mut total = 0u64;
    for rel in paths {
        if rel.is_empty() || !seen.insert(rel.clone()) {
            continue;
        }
        if let Ok(meta) = std::fs::metadata(root.join(&rel)) {
            if meta.is_file() {
                total += meta.len();
            }
        }
    }
    total
}

/// The code map: a plain-English directory of every tracked symbol with its
/// file and line. Reaching for this instead of grepping the tree returns a
/// focused answer and saves the tokens a raw search/read would have spent.
async fn tool_atlas(repo_root: &str, input: &Value) -> (String, bool, u32) {
    let query = input
        .get("query")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .unwrap_or("");
    let limit = input
        .get("limit")
        .and_then(|v| v.as_u64())
        .map(|n| n as usize)
        .unwrap_or(40)
        .clamp(1, 200);

    let hover = match crate::cmd_atlas::read_atlas(repo_root.to_string()).await {
        Ok(h) => h,
        Err(e) => return (format!("atlas unavailable: {e}"), true, 0),
    };
    if !hover.available {
        return (
            "No code map yet — run `aura atlas` to build one. Read the files \
             directly for this answer."
                .to_string(),
            true,
            0,
        );
    }

    let q = query.to_lowercase();
    let matched: Vec<&crate::cmd_atlas::AtlasHoverEntry> = hover
        .entries
        .iter()
        .filter(|e| {
            q.is_empty()
                || e.name.to_lowercase().contains(&q)
                || e.title.to_lowercase().contains(&q)
                || e.summary.to_lowercase().contains(&q)
                || e.file.as_deref().unwrap_or("").to_lowercase().contains(&q)
                || e
                    .feature
                    .as_deref()
                    .unwrap_or("")
                    .to_lowercase()
                    .contains(&q)
        })
        .take(limit)
        .collect();

    if matched.is_empty() {
        return (
            format!("No symbols in the code map match \"{query}\"."),
            false,
            0,
        );
    }

    let rows: Vec<Value> = matched
        .iter()
        .map(|e| {
            json!({
                "name": e.name,
                "title": e.title,
                "role": e.role,
                "layer": e.layer,
                "summary": e.summary,
                "file": e.file,
                "line": e.line,
                "feature": e.feature,
            })
        })
        .collect();
    let out = json!({
        "query": query,
        "matched": rows.len(),
        "symbols": rows,
    });
    let text = pretty(&out);

    // Credit the distinct files these symbols live in — the brain would
    // otherwise have opened them to learn what the atlas just summarised.
    let files = matched.iter().filter_map(|e| e.file.clone());
    let saved = estimate_saved(sum_existing_file_bytes(repo_root, files), &text);
    (text, false, saved)
}

/// Pull repo-relative file paths out of free-form answer text: any
/// whitespace-delimited token that, stripped of surrounding punctuation,
/// names a file that exists under `repo_root` (tolerating a trailing
/// `:line[:col]` anchor). Used to credit the savings of an answer that
/// cites its sources instead of pasting their contents.
fn cited_paths(repo_root: &str, text: &str) -> Vec<String> {
    let root = std::path::Path::new(repo_root);
    let trim: &[char] = &[
        ':', ';', ',', '.', '"', '\'', '`', '(', ')', '[', ']', '<', '>', '*', '!', '?',
    ];
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for raw in text.split_whitespace() {
        let tok = raw.trim_matches(trim);
        if tok.len() < 3 || tok.len() > 200 || !tok.contains('/') || !tok.contains('.') {
            continue;
        }
        // The token may carry a trailing `:line[:col]` location anchor —
        // try it whole first, then fall back to the part before the colon.
        let candidate = if root.join(tok).is_file() {
            tok.to_string()
        } else {
            tok.split(':').next().unwrap_or(tok).to_string()
        };
        if candidate.is_empty() || !seen.insert(candidate.clone()) {
            continue;
        }
        if root.join(&candidate).is_file() {
            out.push(candidate);
        }
    }
    out
}

/// Ask Aura a question about the codebase and get a cited answer back,
/// instead of the brain opening and reading several files to work it out.
/// Shells the bundled `aura ask` CLI — the engine and retrieval live there,
/// out of this process — and credits the savings from the files the answer
/// actually cites.
async fn tool_ask(repo_root: &str, input: &Value) -> (String, bool, u32) {
    let question = input
        .get("question")
        .or_else(|| input.get("query"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .unwrap_or("");
    if question.is_empty() {
        return ("aura_ask needs a `question`.".to_string(), true, 0);
    }
    let bin = crate::agent_event_listener::resolve_aura_bin();
    let root = repo_root.to_string();
    let q = question.to_string();
    let spawned = tokio::task::spawn_blocking(move || {
        std::process::Command::new(&bin)
            .arg("ask")
            .arg(&q)
            .current_dir(&root)
            .stdin(std::process::Stdio::null())
            .output()
    })
    .await;

    let output = match spawned {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => return (format!("could not run `aura ask`: {e}"), true, 0),
        Err(e) => return (format!("aura ask did not complete: {e}"), true, 0),
    };
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        let msg = if err.trim().is_empty() {
            "aura ask failed".to_string()
        } else {
            format!("aura ask failed: {}", err.trim())
        };
        return (msg, true, 0);
    }
    let answer = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if answer.is_empty() {
        return ("aura ask returned no answer.".to_string(), false, 0);
    }
    let saved = estimate_saved(
        sum_existing_file_bytes(repo_root, cited_paths(repo_root, &answer)),
        &answer,
    );
    (answer, false, saved)
}

// ── task tools ─────────────────────────────────────────────────────────

async fn tool_tasks_list(repo_root: &str, input: &Value) -> (String, bool) {
    let tasks = match crate::cmd_tasks::tasks_list(repo_root.to_string()).await {
        Ok(t) => t,
        Err(e) => return (e, true),
    };
    let status = input
        .get("status")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let limit = input
        .get("limit")
        .and_then(|v| v.as_u64())
        .map(|n| n as usize)
        .unwrap_or(50)
        .clamp(1, 500);
    let matched: Vec<&Task> = tasks
        .iter()
        .filter(|t| match status {
            Some(s) => status_matches(t, s),
            None => true,
        })
        .collect();
    let total = matched.len();
    let rows: Vec<Value> = matched.into_iter().take(limit).map(task_summary).collect();
    let out = json!({
        "total_matched": total,
        "returned": rows.len(),
        "tasks": rows,
    });
    (pretty(&out), false)
}

async fn tool_tasks_ready(repo_root: &str, input: &Value) -> (String, bool) {
    let tasks = match crate::cmd_tasks::tasks_list(repo_root.to_string()).await {
        Ok(t) => t,
        Err(e) => return (e, true),
    };
    // Typed blocked-by edges live in a sidecar file; a missing/garbled file
    // is non-fatal — we degrade to dependency-only readiness rather than
    // failing the whole tool.
    let relations =
        crate::cmd_tasks_relations::tasks_relations_list(repo_root.to_string(), None)
            .await
            .unwrap_or_default();

    let agent = input
        .get("agent")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_ascii_lowercase());
    let limit = input
        .get("limit")
        .and_then(|v| v.as_u64())
        .map(|n| n as usize)
        .unwrap_or(20)
        .clamp(1, 200);

    let mut ready = compute_ready_tasks(&tasks, &relations);
    if let Some(a) = agent.as_deref() {
        ready.retain(|t| {
            t.agent_assignee
                .as_deref()
                .map(|x| x.eq_ignore_ascii_case(a))
                .unwrap_or(false)
        });
    }
    let total_ready = ready.len();
    // Total still-open work, for the model to gauge how much of the board is
    // currently blocked behind unfinished dependencies.
    let open_total = tasks.iter().filter(|t| !is_terminal(t)).count();
    let blocked = open_total.saturating_sub(total_ready);

    let rows: Vec<Value> = ready.into_iter().take(limit).map(task_summary).collect();
    let out = json!({
        "ready_count": total_ready,
        "open_total": open_total,
        "blocked_count": blocked,
        "returned": rows.len(),
        "ready": rows,
        "note": "Each task here has all of its dependencies and blockers already done — pick from the top.",
    });
    (pretty(&out), false)
}

async fn tool_task_get(repo_root: &str, input: &Value) -> (String, bool) {
    let needle = match arg_str(input, "id") {
        Some(s) => s,
        None => return ("missing required 'id'".to_string(), true),
    };
    let tasks = match crate::cmd_tasks::tasks_list(repo_root.to_string()).await {
        Ok(t) => t,
        Err(e) => return (e, true),
    };
    match tasks.iter().find(|t| task_matches(t, &needle)) {
        Some(t) => (pretty(&task_detail(t)), false),
        None => (format!("no task matching '{needle}'"), true),
    }
}

async fn tool_task_create(repo_root: &str, input: &Value) -> (String, bool) {
    // Title is the one hard requirement; bail with a soft error the model
    // can recover from rather than letting `from_value` produce a less
    // legible message.
    if arg_str(input, "title").is_none() {
        return ("missing required 'title'".to_string(), true);
    }

    // Dependencies and parent are given in the model's own vocabulary —
    // 'AURA-{n}', a bare sequence, or an internal id. The store keys edges
    // by internal id, so resolve each reference against the live board
    // before handing it off. An unresolved reference is a soft error (the
    // model named work that doesn't exist) rather than a silently-dropped
    // edge that would let blocked work run early.
    let tasks = match crate::cmd_tasks::tasks_list(repo_root.to_string()).await {
        Ok(t) => t,
        Err(e) => return (e, true),
    };
    let resolve = |needle: &str| -> Result<String, String> {
        match tasks.iter().find(|t| task_matches(t, needle)) {
            Some(t) => Ok(t.id.clone()),
            None => Err(format!("no task matching '{needle}'")),
        }
    };

    let mut patch = input.clone();
    if let Some(obj) = patch.as_object_mut() {
        // Resolve each dependency reference to an internal id in place.
        if let Some(deps) = obj.get("dependencies").and_then(|v| v.as_array()).cloned() {
            let mut resolved = Vec::with_capacity(deps.len());
            for d in &deps {
                let Some(needle) = d.as_str().map(str::trim).filter(|s| !s.is_empty()) else {
                    continue;
                };
                match resolve(needle) {
                    Ok(id) => resolved.push(Value::String(id)),
                    Err(e) => return (e, true),
                }
            }
            obj.insert("dependencies".to_string(), Value::Array(resolved));
        }
        // Resolve a parent reference the same way.
        if let Some(p) = obj.get("parent_id").and_then(|v| v.as_str()).map(str::trim) {
            if p.is_empty() {
                obj.remove("parent_id");
            } else {
                match resolve(p) {
                    Ok(id) => {
                        obj.insert("parent_id".to_string(), Value::String(id));
                    }
                    Err(e) => return (e, true),
                }
            }
        }
    }

    let create: CreateTaskInput = match serde_json::from_value(patch) {
        Ok(c) => c,
        Err(e) => return (format!("bad create arguments: {e}"), true),
    };
    match crate::cmd_tasks::tasks_create(repo_root.to_string(), create).await {
        Ok(t) => (pretty(&task_summary(&t)), false),
        Err(e) => (e, true),
    }
}

async fn tool_task_update(repo_root: &str, input: &Value) -> (String, bool) {
    let needle = match arg_str(input, "id") {
        Some(s) => s,
        None => return ("missing required 'id'".to_string(), true),
    };
    // Resolve the human-facing ref (AURA-n / sequence) to the internal id
    // `tasks_update` expects.
    let tasks = match crate::cmd_tasks::tasks_list(repo_root.to_string()).await {
        Ok(t) => t,
        Err(e) => return (e, true),
    };
    let internal = match tasks.iter().find(|t| task_matches(t, &needle)) {
        Some(t) => t.id.clone(),
        None => return (format!("no task matching '{needle}'"), true),
    };

    // Shape the model's args into UpdateTaskInput. Replace `id` with the
    // resolved internal id; turn an explicit empty-string assignee /
    // agent_assignee into JSON null so it clears the field (Option<String>
    // null → None → cleared) rather than writing a literal "".
    let mut patch = input.clone();
    if let Some(obj) = patch.as_object_mut() {
        obj.insert("id".to_string(), json!(internal));
        for key in ["assignee", "agent_assignee"] {
            if obj.get(key).and_then(|v| v.as_str()) == Some("") {
                obj.insert(key.to_string(), Value::Null);
            }
        }
    }
    let upd: UpdateTaskInput = match serde_json::from_value(patch) {
        Ok(u) => u,
        Err(e) => return (format!("bad update arguments: {e}"), true),
    };
    match crate::cmd_tasks::tasks_update(repo_root.to_string(), upd).await {
        Ok(t) => (pretty(&task_summary(&t)), false),
        Err(e) => (e, true),
    }
}

// ── page tools ─────────────────────────────────────────────────────────

async fn tool_pages_list(repo_root: &str, input: &Value) -> (String, bool) {
    let mut q = json!({ "repo_root": repo_root });
    if let Some(s) = input.get("scope") {
        q["scope"] = s.clone();
    }
    if let Some(b) = input.get("bucket") {
        q["bucket"] = b.clone();
    }
    let req: NoteListInput = match serde_json::from_value(q) {
        Ok(r) => r,
        Err(e) => return (format!("bad arguments: {e}"), true),
    };
    match crate::cmd_notes::notes_list(req).await {
        Ok(notes) => {
            let rows: Vec<Value> = notes
                .iter()
                .map(|n| {
                    json!({
                        "id": n.id,
                        "scope": n.scope,
                        "bucket": n.bucket,
                        "title": n.title,
                        "visibility": n.visibility,
                        "tags": n.tags,
                        "updated_at": n.updated_at,
                    })
                })
                .collect();
            (pretty(&json!({ "count": rows.len(), "pages": rows })), false)
        }
        Err(e) => (e, true),
    }
}

async fn tool_page_read(repo_root: &str, input: &Value) -> (String, bool) {
    let mut q = json!({ "repo_root": repo_root });
    if let Some(obj) = q.as_object_mut() {
        for key in ["scope", "bucket", "id"] {
            if let Some(v) = input.get(key) {
                obj.insert(key.to_string(), v.clone());
            }
        }
    }
    let req: NoteReadInput = match serde_json::from_value(q) {
        Ok(r) => r,
        Err(e) => return (format!("bad arguments (need scope + id): {e}"), true),
    };
    match crate::cmd_notes::notes_read(req).await {
        Ok(note) => {
            let out = json!({
                "id": note.id,
                "scope": note.scope,
                "bucket": note.bucket,
                "title": note.frontmatter.title,
                "visibility": note.frontmatter.visibility,
                "tags": note.frontmatter.tags,
                "body": note.body,
            });
            (pretty(&out), false)
        }
        Err(e) => (e, true),
    }
}

async fn tool_page_write(repo_root: &str, input: &Value, author: &str) -> (String, bool) {
    let mut q = input.clone();
    if let Some(obj) = q.as_object_mut() {
        obj.insert("repo_root".to_string(), json!(repo_root));
        // Stamp the chat author unless the model supplied a non-empty one.
        let has_author = obj
            .get("author")
            .and_then(|v| v.as_str())
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false);
        if !has_author {
            obj.insert("author".to_string(), json!(author));
        }
    } else {
        return ("arguments must be an object".to_string(), true);
    }
    let req: NoteWriteInput = match serde_json::from_value(q) {
        Ok(r) => r,
        Err(e) => return (format!("bad arguments (need scope + body): {e}"), true),
    };
    match crate::cmd_notes::notes_write(req).await {
        Ok(note) => {
            let out = json!({
                "saved": true,
                "id": note.id,
                "scope": note.scope,
                "bucket": note.bucket,
                "title": note.frontmatter.title,
                "visibility": note.frontmatter.visibility,
            });
            (pretty(&out), false)
        }
        Err(e) => (e, true),
    }
}

// ── projections + helpers ──────────────────────────────────────────────

/// Compact one-line-per-task projection for list views.
fn task_summary(t: &Task) -> Value {
    json!({
        "id": t.id,
        "ref": format!("AURA-{}", t.sequence_id),
        "title": t.title,
        "status": display_status(t),
        "priority": t.priority,
        "assignees": t.assignee_ids,
        "agent": t.agent_assignee,
    })
}

/// Fuller projection for a single-task get.
fn task_detail(t: &Task) -> Value {
    json!({
        "id": t.id,
        "ref": format!("AURA-{}", t.sequence_id),
        "title": t.title,
        "description": t.description,
        "status": display_status(t),
        "state_id": t.state_id,
        "priority": t.priority,
        "assignees": t.assignee_ids,
        "agent": t.agent_assignee,
        "labels": t.labels,
        "parent_id": t.parent_id,
        "is_epic": t.is_epic,
        "dependencies": t.dependencies,
        "due_date": t.due_date,
        "created_at": t.created_at,
        "updated_at": t.updated_at,
    })
}

/// Prefer the canonical state id; fall back to the legacy status string
/// for rows written before the state catalog existed.
fn display_status(t: &Task) -> String {
    if t.state_id.is_empty() {
        t.status.clone()
    } else {
        t.state_id.clone()
    }
}

/// Whether a task matches a free-form status filter. Compares against both
/// the legacy `status` and canonical `state_id` (case-insensitive) and
/// honours the common legacy↔canonical synonyms so "done" finds
/// "completed" and "in_progress" finds "started".
fn status_matches(t: &Task, want: &str) -> bool {
    let w = want.trim().to_ascii_lowercase();
    let status = t.status.to_ascii_lowercase();
    let state = t.state_id.to_ascii_lowercase();
    if w == status || w == state {
        return true;
    }
    let synonyms: &[&str] = match w.as_str() {
        "done" | "completed" => &["done", "completed"],
        "in_progress" | "started" => &["in_progress", "started"],
        "in_review" | "review" => &["in_review", "review"],
        "todo" | "unstarted" => &["todo", "unstarted"],
        "backlog" => &["backlog"],
        "cancelled" | "canceled" => &["cancelled", "canceled"],
        _ => &[],
    };
    synonyms.contains(&status.as_str()) || synonyms.contains(&state.as_str())
}

/// A task is "terminal" — resolved and no longer actionable — when its
/// state is done/completed or cancelled. Reuses the synonym-aware
/// `status_matches` so legacy `status` rows and canonical `state_id` rows
/// are both recognised.
fn is_terminal(t: &Task) -> bool {
    status_matches(t, "done") || status_matches(t, "cancelled")
}

/// Sort key for the priority ladder — lower is more urgent so a plain
/// ascending sort puts urgent work first. Unknown values sort last.
fn priority_rank(p: &str) -> u8 {
    match p.trim().to_ascii_lowercase().as_str() {
        "urgent" => 0,
        "high" => 1,
        "medium" => 2,
        "low" => 3,
        "none" => 4,
        _ => 5,
    }
}

/// Compute the *ready frontier* of the board: the actionable tasks whose
/// every blocker is already resolved.
///
/// A task blocks `t` when it appears in `t.dependencies` (the inline
/// `Task` field) OR when a typed `blocked_by` relation names it as the
/// blocker (`source_id == t.id && kind == "blocked_by"` → `target_id` is
/// the blocker). A blocker is "cleared" when it is terminal
/// (done/cancelled) or when it points at a task id that no longer exists
/// (a dangling reference can't hold work hostage forever).
///
/// This is a single O(n + e) frontier pass over *direct* blockers — it
/// never recurses, so a dependency cycle simply yields "no ready tasks in
/// the cycle" instead of looping. Results are ordered by priority then
/// sequence id so the caller can take the top N.
pub fn compute_ready_tasks<'a>(
    tasks: &'a [Task],
    relations: &[TaskRelation],
) -> Vec<&'a Task> {
    use std::collections::HashMap;

    let by_id: HashMap<&str, &Task> =
        tasks.iter().map(|t| (t.id.as_str(), t)).collect();

    // A blocker id is cleared when the task it names is terminal or absent.
    let cleared = |id: &str| -> bool {
        match by_id.get(id) {
            Some(blocker) => is_terminal(blocker),
            None => true,
        }
    };

    // Extra blockers contributed by typed `blocked_by` relations, keyed by
    // the blocked task's id.
    let mut rel_blockers: HashMap<&str, Vec<&str>> = HashMap::new();
    for r in relations {
        if r.kind == "blocked_by" {
            rel_blockers
                .entry(r.source_id.as_str())
                .or_default()
                .push(r.target_id.as_str());
        }
    }

    let mut ready: Vec<&Task> = tasks
        .iter()
        .filter(|t| !is_terminal(t))
        .filter(|t| {
            let deps_clear = t.dependencies.iter().all(|d| cleared(d));
            let rels_clear = rel_blockers
                .get(t.id.as_str())
                .map(|bs| bs.iter().all(|b| cleared(b)))
                .unwrap_or(true);
            deps_clear && rels_clear
        })
        .collect();

    ready.sort_by(|a, b| {
        priority_rank(&a.priority)
            .cmp(&priority_rank(&b.priority))
            .then(a.sequence_id.cmp(&b.sequence_id))
    });
    ready
}

/// Whether a task is the one the model named — by internal id, by its
/// `AURA-{n}` reference, or by a bare sequence number.
fn task_matches(t: &Task, needle: &str) -> bool {
    let n = needle.trim();
    if t.id == n {
        return true;
    }
    let seq = t.sequence_id.to_string();
    n == seq || n.eq_ignore_ascii_case(&format!("AURA-{seq}"))
}

/// Read a trimmed, non-empty string argument.
fn arg_str(input: &Value, key: &str) -> Option<String> {
    input
        .get(key)
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn pretty(v: &Value) -> String {
    serde_json::to_string_pretty(v).unwrap_or_else(|_| v.to_string())
}

/// Truncate on a char boundary, appending an explicit marker so the model
/// knows the result was clipped rather than silently short.
fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n… [truncated, {} more chars]", &s[..end], s.len() - end)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task_from(value: Value) -> Task {
        serde_json::from_value(value).expect("valid task json")
    }

    #[test]
    fn schemas_match_tool_names() {
        let schemas = board_tool_schemas();
        assert_eq!(schemas.len(), TOOL_NAMES.len());
        for s in &schemas {
            let name = s["name"].as_str().expect("name");
            assert!(TOOL_NAMES.contains(&name), "unexpected tool {name}");
            assert_eq!(s["input_schema"]["type"], "object", "{name} schema");
            assert!(s["description"].is_string(), "{name} description");
        }
    }

    #[test]
    fn board_tool_membership() {
        assert!(is_board_tool("aura_task_update"));
        assert!(is_board_tool("aura_page_write"));
        assert!(!is_board_tool("bash"));
    }

    #[test]
    fn interactive_tool_classification() {
        // Declared names + the model's training-baked PascalCase aliases.
        assert!(is_interactive_tool("ask_user"));
        assert!(is_interactive_tool("AskUserQuestion"));
        assert!(is_interactive_tool("propose_plan"));
        assert!(is_interactive_tool("ExitPlanMode"));
        assert!(!is_interactive_tool("aura_task_create"));
        // Plan tools are the subset that drive the PlanCard.
        assert!(is_plan_tool("propose_plan"));
        assert!(is_plan_tool("ExitPlanMode"));
        assert!(!is_plan_tool("ask_user"));
        assert!(!is_plan_tool("AskUserQuestion"));
        // is_board_tool and is_interactive_tool never overlap — the loop's
        // execution branch depends on that partition.
        for s in all_tool_schemas() {
            let name = s["name"].as_str().expect("name");
            assert!(
                is_board_tool(name) ^ is_interactive_tool(name),
                "{name} must be exactly one of board/interactive"
            );
        }
    }

    #[test]
    fn all_tool_schemas_is_board_plus_interactive() {
        let all = all_tool_schemas();
        assert_eq!(all.len(), board_tool_schemas().len() + interactive_tool_schemas().len());
        let names: Vec<&str> = all.iter().filter_map(|s| s["name"].as_str()).collect();
        assert!(names.contains(&"ask_user"));
        assert!(names.contains(&"propose_plan"));
    }

    #[test]
    fn parse_ask_user_sdk_and_flat_shapes() {
        // Claude-SDK AskUserQuestion envelope: payload inside questions[0],
        // options as {label,…}, multiSelect drives the kind.
        let sdk = json!({
            "questions": [{
                "question": "Pick a database",
                "options": [{"label": "Postgres"}, {"label": "SQLite"}],
                "multiSelect": false
            }]
        });
        let (q, opts, kind) = parse_ask_user(&sdk);
        assert_eq!(q, "Pick a database");
        assert_eq!(opts, vec!["Postgres".to_string(), "SQLite".to_string()]);
        assert!(matches!(kind, QuestionKind::Choice));

        // Flat native shape with an explicit kind.
        let flat = json!({ "question": "Anything else?", "kind": "text" });
        let (q, opts, kind) = parse_ask_user(&flat);
        assert_eq!(q, "Anything else?");
        assert!(opts.is_empty());
        assert!(matches!(kind, QuestionKind::Text));
    }

    #[test]
    fn parse_ask_user_set_clubbed_questions() {
        // A clubbed set of up to 4 related questions, mixed kinds, with the
        // SDK `header` label and a custom-`kind` override. The card renders
        // all of them together; the brain may ask another set afterward.
        let set = json!({
            "questions": [
                {
                    "header": "Database",
                    "question": "Which database?",
                    "options": [{"label": "Postgres"}, {"label": "SQLite"}],
                    "multiSelect": false
                },
                {
                    "header": "Regions",
                    "question": "Which regions to deploy?",
                    "options": ["us-east", "eu-west"],
                    "multiSelect": true
                },
                {
                    // Explicit `kind` wins over the absent options/multiSelect.
                    "question": "Anything else we should know?",
                    "kind": "text"
                }
            ]
        });
        let items = parse_ask_user_set(&set);
        assert_eq!(items.len(), 3);
        // Item 0: choice, header kept (differs from question), options flattened.
        assert_eq!(items[0].header.as_deref(), Some("Database"));
        assert_eq!(items[0].question, "Which database?");
        assert!(matches!(items[0].kind, QuestionKind::Choice));
        assert_eq!(items[0].options, vec!["Postgres".to_string(), "SQLite".to_string()]);
        // Item 1: multiSelect → MultiChoice, plain string options.
        assert!(matches!(items[1].kind, QuestionKind::MultiChoice));
        assert_eq!(items[1].options, vec!["us-east".to_string(), "eu-west".to_string()]);
        // Item 2: explicit text kind, no options, no header.
        assert!(matches!(items[2].kind, QuestionKind::Text));
        assert!(items[2].options.is_empty());
        assert!(items[2].header.is_none());

        // The back-compat shim still returns the first question verbatim.
        let (q, opts, kind) = parse_ask_user(&set);
        assert_eq!(q, "Which database?");
        assert_eq!(opts, vec!["Postgres".to_string(), "SQLite".to_string()]);
        assert!(matches!(kind, QuestionKind::Choice));

        // A set cap: only the first 4 questions survive.
        let big = json!({
            "questions": [
                { "question": "q1" }, { "question": "q2" }, { "question": "q3" },
                { "question": "q4" }, { "question": "q5" }
            ]
        });
        assert_eq!(parse_ask_user_set(&big).len(), 4);
    }

    #[test]
    fn parse_propose_plan_rich_envelope() {
        let input = json!({
            "title": "Ship invites",
            "summary": "Add team invites",
            "objective": "Let admins invite teammates by email.",
            "phases": [
                { "title": "Backend", "body": "endpoint", "file_refs": ["api/invite.ts"] },
                { "title": "", "body": "dropped — no title" }
            ],
            "deliverables": ["working invite link"],
            "todos": [
                { "description": "Add invite endpoint", "agent": "claude", "file_refs": ["api/invite.ts"] },
                { "content": "Build invite UI", "assignee": "sam@x.com" },
                { "description": "  " }
            ]
        });
        let p = parse_propose_plan(&input, "sid-1");
        assert_eq!(p.session_id, "sid-1");
        assert_eq!(p.title, "Ship invites");
        assert!(!p.force_skip_scout);
        // Empty-title phase is dropped.
        assert_eq!(p.phases.len(), 1);
        assert_eq!(p.phases[0].title, "Backend");
        // `content` is accepted as a description alias; blank todo dropped.
        assert_eq!(p.todos.len(), 2);
        assert_eq!(p.todos[0].agent.as_deref(), Some("claude"));
        assert_eq!(p.todos[1].description, "Build invite UI");
        assert_eq!(p.todos[1].assignee.as_deref(), Some("sam@x.com"));
    }

    #[test]
    fn parse_propose_plan_exit_plan_mode_fallback() {
        // ExitPlanMode carries a bare markdown plan and no structured todos.
        let input = json!({ "plan": "# Refactor auth\n\nSplit the middleware…" });
        let p = parse_propose_plan(&input, "sid-2");
        assert_eq!(p.title, "Refactor auth");
        assert_eq!(p.objective.as_deref(), Some("# Refactor auth\n\nSplit the middleware…"));
        assert!(p.todos.is_empty());
    }

    #[test]
    fn supports_anthropic_shaped_and_gemini() {
        // The two Anthropic-shaped brains take the schemas verbatim.
        assert!(supports("aura_pro"));
        assert!(supports("anthropic_native"));
        // Gemini native now qualifies too — its Brain impl translates the
        // same Anthropic-format tools into Gemini functionDeclarations and
        // maps functionCall/functionResponse back onto the loop's contract,
        // so a Claude→Gemini handoff keeps the same tools.
        assert!(supports("gemini_native"));
        // Everything else stays tool-free so the request is byte-identical.
        assert!(!supports("openai_native"));
        assert!(!supports("cli_wrapper:claude_code"));
        assert!(!supports("openai_compat:groq"));
    }

    #[test]
    fn augment_system_appends_or_seeds() {
        // Empty repo_root → no memory file → just the tools blurb.
        let seeded = augment_system(None, "");
        assert!(seeded.contains("aura_tasks_list"));
        assert!(seeded.contains("aura_tasks_ready"));
        assert!(!seeded.starts_with('\n'));
        let appended = augment_system(Some("You are Aura."), "");
        assert!(appended.starts_with("You are Aura."));
        assert!(appended.contains("aura_page_write"));
        // Blank existing system is treated as absent.
        assert_eq!(augment_system(Some("   "), ""), seeded);
    }

    #[test]
    fn augment_system_injects_binding_constraints() {
        let tmp = temp_repo();
        let aura = tmp.path().join(".aura");
        std::fs::create_dir_all(&aura).unwrap();
        std::fs::write(
            aura.join("memory.json"),
            r#"{
                "conventions": [
                    {"content": "Indent rust files with 4 spaces", "tags": ["rust"]}
                ],
                "gotchas": [
                    {"content": "Never log API keys", "tags": ["security"]},
                    {"content": "presentation must not import infra", "tags": ["boundary"]},
                    {"content": "just a random note", "tags": ["misc"]}
                ],
                "context": []
            }"#,
        )
        .unwrap();
        let rr = tmp.path().to_str().unwrap();
        let out = augment_system(Some("You are Aura."), rr);
        assert!(out.contains("binding constraints"), "header missing: {out}");
        assert!(out.contains("[CONVENTION] Indent rust files with 4 spaces"));
        assert!(out.contains("[SECURITY] Never log API keys"));
        assert!(out.contains("[BOUNDARY] presentation must not import infra"));
        // Untagged gotcha is not a hard rule → excluded.
        assert!(!out.contains("just a random note"));
        // Byte-stable: same inputs, same output (so the prefix can be cached).
        assert_eq!(out, augment_system(Some("You are Aura."), rr));
    }

    fn ready_task(id: &str, seq: u64, status: &str, prio: &str, deps: &[&str]) -> Task {
        task_from(json!({
            "id": id,
            "title": id,
            "status": status,
            "priority": prio,
            "sequence_id": seq,
            "dependencies": deps,
            "created_at": "",
            "updated_at": "",
        }))
    }

    #[test]
    fn ready_frontier_respects_deps_relations_and_priority() {
        // t1 done; t2 depends on t1 (cleared) → ready; t3 depends on t4
        // (still open) → blocked; t4 open, no deps → ready; t5 done → excluded.
        let tasks = vec![
            ready_task("t1", 1, "done", "medium", &[]),
            ready_task("t2", 2, "backlog", "low", &["t1"]),
            ready_task("t3", 3, "backlog", "high", &["t4"]),
            ready_task("t4", 4, "backlog", "urgent", &[]),
            ready_task("t5", 5, "completed", "high", &[]),
        ];
        let ready = compute_ready_tasks(&tasks, &[]);
        let ids: Vec<&str> = ready.iter().map(|t| t.id.as_str()).collect();
        // t4 (urgent) before t2 (low); t3 blocked, t1/t5 terminal.
        assert_eq!(ids, vec!["t4", "t2"]);

        // Now add a typed blocked_by relation: t4 blocked_by t2 (t2 open) →
        // t4 drops out of the frontier even though its inline deps are empty.
        let rels = vec![TaskRelation {
            id: "r1".into(),
            source_id: "t4".into(),
            target_id: "t2".into(),
            kind: "blocked_by".into(),
            created_at: "".into(),
        }];
        let ready2 = compute_ready_tasks(&tasks, &rels);
        let ids2: Vec<&str> = ready2.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(ids2, vec!["t2"], "t4 should be blocked by open t2");
    }

    #[test]
    fn ready_frontier_is_cycle_safe() {
        // t1 ↔ t2 mutually depend (a cycle). Neither is terminal, so neither
        // is ready — the frontier pass must not loop, just return empty.
        let tasks = vec![
            ready_task("t1", 1, "backlog", "medium", &["t2"]),
            ready_task("t2", 2, "backlog", "medium", &["t1"]),
        ];
        let ready = compute_ready_tasks(&tasks, &[]);
        assert!(ready.is_empty(), "cycle should yield no ready tasks");
    }

    #[tokio::test]
    async fn executor_tasks_ready_filters_blocked() {
        let tmp = temp_repo();
        let root = tmp.path();
        let tasks_dir = root.join(".aura").join("tasks");
        std::fs::create_dir_all(&tasks_dir).unwrap();
        std::fs::write(
            tasks_dir.join("tasks.json"),
            r#"{"tasks":[
                {"id":"a","title":"Done dep","status":"done","priority":"medium","created_at":"","updated_at":""},
                {"id":"b","title":"Ready now","status":"backlog","priority":"high","dependencies":["a"],"created_at":"","updated_at":""},
                {"id":"c","title":"Still blocked","status":"backlog","priority":"high","dependencies":["b"],"created_at":"","updated_at":""}
            ]}"#,
        )
        .unwrap();
        let rr = root.to_str().unwrap();
        let (out, err, _) =
            execute_board_tool(rr, "aura_tasks_ready", &json!({}), CHAT_AUTHOR).await;
        assert!(!err, "ready error: {out}");
        assert!(out.contains("Ready now"), "ready task missing: {out}");
        assert!(!out.contains("Still blocked"), "blocked task leaked: {out}");
        assert!(!out.contains("Done dep"), "terminal task leaked: {out}");
    }

    #[test]
    fn status_filter_honors_synonyms() {
        let t = task_from(json!({
            "id": "x", "title": "t", "status": "in_progress",
            "sequence_id": 3, "created_at": "", "updated_at": ""
        }));
        assert!(status_matches(&t, "in_progress"));
        assert!(status_matches(&t, "started"));
        assert!(status_matches(&t, "IN_PROGRESS"));
        assert!(!status_matches(&t, "done"));
        let done = task_from(json!({
            "id": "y", "title": "t", "status": "done", "state_id": "completed",
            "sequence_id": 4, "created_at": "", "updated_at": ""
        }));
        assert!(status_matches(&done, "done"));
        assert!(status_matches(&done, "completed"));
    }

    #[test]
    fn task_ref_matching() {
        let t = task_from(json!({
            "id": "abc", "title": "t", "status": "backlog",
            "sequence_id": 42, "created_at": "", "updated_at": ""
        }));
        assert!(task_matches(&t, "abc"));
        assert!(task_matches(&t, "AURA-42"));
        assert!(task_matches(&t, "aura-42"));
        assert!(task_matches(&t, "42"));
        assert!(!task_matches(&t, "AURA-7"));
        assert!(!task_matches(&t, "7"));
    }

    #[test]
    fn truncate_marks_clip() {
        let long = "x".repeat(100);
        let out = truncate(&long, 10);
        assert!(out.contains("truncated"));
        assert_eq!(truncate("short", 10), "short");
    }

    fn temp_repo() -> tempfile::TempDir {
        tempfile::tempdir().expect("tempdir")
    }

    #[tokio::test]
    async fn executor_tasks_list_get_update() {
        let tmp = temp_repo();
        let root = tmp.path();
        let tasks_dir = root.join(".aura").join("tasks");
        std::fs::create_dir_all(&tasks_dir).unwrap();
        std::fs::write(
            tasks_dir.join("tasks.json"),
            r#"{"tasks":[{"id":"t1","title":"First task","status":"backlog","priority":"high","created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z"}]}"#,
        )
        .unwrap();
        let rr = root.to_str().unwrap();

        let (out, err, _) = execute_board_tool(rr, "aura_tasks_list", &json!({}), CHAT_AUTHOR).await;
        assert!(!err, "list error: {out}");
        assert!(out.contains("First task"), "list missing task: {out}");

        // Get by the internal id (ref-number depends on heal allocation).
        let (out, err, _) =
            execute_board_tool(rr, "aura_task_get", &json!({"id": "t1"}), CHAT_AUTHOR).await;
        assert!(!err, "get error: {out}");
        assert!(out.contains("First task"));

        // Update status → the legacy "in_progress" maps to state "started".
        let (out, err, _) = execute_board_tool(
            rr,
            "aura_task_update",
            &json!({"id": "t1", "status": "in_progress", "agent_assignee": "aura"}),
            CHAT_AUTHOR,
        )
        .await;
        assert!(!err, "update error: {out}");

        let (out, _err, _) =
            execute_board_tool(rr, "aura_task_get", &json!({"id": "t1"}), CHAT_AUTHOR).await;
        assert!(
            out.contains("started") || out.contains("in_progress"),
            "status not updated: {out}"
        );
        assert!(out.contains("aura"), "agent not set: {out}");
    }

    #[tokio::test]
    async fn executor_task_create_resolves_deps() {
        let tmp = temp_repo();
        let root = tmp.path();
        let tasks_dir = root.join(".aura").join("tasks");
        std::fs::create_dir_all(&tasks_dir).unwrap();
        // One existing task to depend on; its internal id is "a".
        std::fs::write(
            tasks_dir.join("tasks.json"),
            r#"{"tasks":[{"id":"a","title":"Prereq","status":"backlog","priority":"medium","created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z"}]}"#,
        )
        .unwrap();
        let rr = root.to_str().unwrap();

        // Create a dependent task, naming the prereq by its internal id. The
        // executor must resolve it and store the edge.
        let (out, err, _) = execute_board_tool(
            rr,
            "aura_task_create",
            &json!({
                "title": "Build feature",
                "priority": "high",
                "agent_assignee": "claude",
                "dependencies": ["a"]
            }),
            CHAT_AUTHOR,
        )
        .await;
        assert!(!err, "create error: {out}");
        let created: Value = serde_json::from_str(&out).unwrap();
        let new_id = created["id"].as_str().expect("new id").to_string();
        assert_ne!(new_id, "a", "created task should have its own id");

        // Read it back: the dependency must be present and resolved to "a".
        let (detail, err, _) =
            execute_board_tool(rr, "aura_task_get", &json!({"id": new_id}), CHAT_AUTHOR).await;
        assert!(!err, "get error: {detail}");
        assert!(detail.contains("Build feature"), "title missing: {detail}");
        assert!(detail.contains("\"a\""), "dependency not stored: {detail}");

        // A dependency that names no real task is a soft error, not a panic
        // and not a silently-dropped edge.
        let (out, err, _) = execute_board_tool(
            rr,
            "aura_task_create",
            &json!({"title": "Dangling", "dependencies": ["AURA-9999"]}),
            CHAT_AUTHOR,
        )
        .await;
        assert!(err, "unresolved dependency should error: {out}");
        assert!(out.contains("AURA-9999"), "error should name the bad ref: {out}");

        // Missing title → soft error.
        let (_o, err, _) =
            execute_board_tool(rr, "aura_task_create", &json!({}), CHAT_AUTHOR).await;
        assert!(err, "missing title should error");
    }

    #[tokio::test]
    async fn executor_pages_write_read_list() {
        let tmp = temp_repo();
        let rr = tmp.path().to_str().unwrap();

        let (out, err, _) = execute_board_tool(
            rr,
            "aura_page_write",
            &json!({"scope": "team", "title": "Sprint Plan", "body": "# Sprint Plan\n\nbody"}),
            CHAT_AUTHOR,
        )
        .await;
        assert!(!err, "write error: {out}");
        let v: Value = serde_json::from_str(&out).unwrap();
        let id = v["id"].as_str().expect("page id").to_string();

        let (out, err, _) = execute_board_tool(
            rr,
            "aura_page_read",
            &json!({"scope": "team", "id": id}),
            CHAT_AUTHOR,
        )
        .await;
        assert!(!err, "read error: {out}");
        assert!(out.contains("# Sprint Plan"), "body missing: {out}");

        let (out, err, _) = execute_board_tool(
            rr,
            "aura_pages_list",
            &json!({"scope": "team"}),
            CHAT_AUTHOR,
        )
        .await;
        assert!(!err, "list error: {out}");
        assert!(out.contains("Sprint Plan"), "page missing from list: {out}");
    }

    #[tokio::test]
    async fn executor_errors_are_soft() {
        let tmp = temp_repo();
        let rr = tmp.path().to_str().unwrap();
        // Missing required id → soft error, not a panic.
        let (_o, err, _) =
            execute_board_tool(rr, "aura_task_get", &json!({}), CHAT_AUTHOR).await;
        assert!(err);
        // Unknown tool name → soft error.
        let (_o, err, _) = execute_board_tool(rr, "nope", &json!({}), CHAT_AUTHOR).await;
        assert!(err);
    }
}
