//! ACP wire shapes, and the translation from an agent's `session/update`
//! stream into Aura's `ChatChunk`s.
//!
//! Everything here is pure: JSON in, chunks out. That is deliberate — it
//! means the mapping is tested against wire bodies captured from a real
//! `opencode acp` process rather than against a mock of our own beliefs,
//! and a protocol change shows up as a failing test instead of a silent
//! blank bubble.
//!
//! Vocabulary confirmed against OpenCode 1.18.11's own ACP implementation:
//! the update kinds are `user_message_chunk`, `agent_message_chunk`,
//! `agent_thought_chunk`, `tool_call`, `tool_call_update`, `plan`,
//! `available_commands_update`, `current_mode_update`.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::manager::brain::types::{AgentCommand, AgentPlanEntry, ChatChunk};

/// ACP methods, spelled once. Confirmed against the agent's own method
/// table — `session/set_config_option` in particular is easy to guess
/// wrong as `session/setConfigOption`.
pub mod method {
    pub const INITIALIZE: &str = "initialize";
    pub const AUTHENTICATE: &str = "authenticate";
    pub const SESSION_NEW: &str = "session/new";
    pub const SESSION_LOAD: &str = "session/load";
    pub const SESSION_PROMPT: &str = "session/prompt";
    pub const SESSION_CANCEL: &str = "session/cancel";
    pub const SESSION_SET_MODE: &str = "session/set_mode";
    pub const SESSION_SET_CONFIG_OPTION: &str = "session/set_config_option";
    pub const SESSION_UPDATE: &str = "session/update";
    /// Agent → client. The three that make Aura a gate rather than a viewer.
    pub const SESSION_REQUEST_PERMISSION: &str = "session/request_permission";
    pub const FS_READ_TEXT_FILE: &str = "fs/read_text_file";
    pub const FS_WRITE_TEXT_FILE: &str = "fs/write_text_file";
    pub const TERMINAL_CREATE: &str = "terminal/create";
    pub const TERMINAL_OUTPUT: &str = "terminal/output";
    pub const TERMINAL_KILL: &str = "terminal/kill";
    pub const TERMINAL_RELEASE: &str = "terminal/release";
    pub const TERMINAL_WAIT_FOR_EXIT: &str = "terminal/wait_for_exit";
}

/// The protocol revision we implement.
pub const PROTOCOL_VERSION: u32 = 1;

/// What we tell the agent we can do for it. Every `true` here is a promise
/// the host layer has to keep — claiming `writeTextFile` and then not
/// serving `fs/write_text_file` makes the agent hang, not fail.
///
/// All three are served: reads and writes by [`super::host`], commands by
/// [`super::terminal`]. There is no switch here because there is no
/// configuration in which Aura would rather the agent ran its own shell —
/// an unhosted command is one Aura cannot gate, root, or stop.
pub fn client_capabilities() -> Value {
    json!({
        "fs": { "readTextFile": true, "writeTextFile": true },
        "terminal": true,
    })
}

/// A model/mode choice the agent advertises for a session. OpenCode
/// returns these inline from `session/new`, which is why Aura needs no
/// hardcoded model table for it — the list, the display names and the
/// current selection all come from the engine.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ConfigOption {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub category: Option<String>,
    #[serde(rename = "type", default)]
    pub kind: Option<String>,
    #[serde(rename = "currentValue", default)]
    pub current_value: Option<Value>,
    #[serde(default)]
    pub options: Vec<ConfigChoice>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ConfigChoice {
    pub value: Value,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
}

/// One permission choice the agent is offering. `kind` is what lets Aura
/// render "Always allow" differently from "Allow once" without string
/// matching on the label.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PermissionOption {
    #[serde(rename = "optionId")]
    pub option_id: String,
    pub name: String,
    #[serde(default)]
    pub kind: Option<String>,
}

impl PermissionOption {
    /// Whether choosing this option lets the tool run.
    pub fn is_allow(&self) -> bool {
        matches!(self.kind.as_deref(), Some("allow_once" | "allow_always"))
    }

    /// Whether choosing this option remembers the answer.
    pub fn is_persistent(&self) -> bool {
        matches!(self.kind.as_deref(), Some("allow_always" | "reject_always"))
    }
}

/// What `session/new` (or `session/load`) told us about a session.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SessionInfo {
    pub session_id: String,
    pub config_options: Vec<ConfigOption>,
}

impl SessionInfo {
    pub fn parse(result: &Value) -> Option<Self> {
        let session_id = result.get("sessionId")?.as_str()?.to_string();
        let config_options = result
            .get("configOptions")
            .and_then(|v| serde_json::from_value::<Vec<ConfigOption>>(v.clone()).ok())
            .unwrap_or_default();
        Some(Self {
            session_id,
            config_options,
        })
    }

    /// The `model` config option, if the agent exposes one. This is the
    /// real model picker: ids, display names, and what's selected now.
    pub fn model_option(&self) -> Option<&ConfigOption> {
        self.config_options
            .iter()
            .find(|o| o.id == "model" || o.category.as_deref() == Some("model"))
    }

    /// The `mode` config option — the same shape as the model picker, and
    /// arriving in the same reply. OpenCode's `build` and `plan` live here,
    /// which is how Aura learns both the list and the current selection
    /// without a table of its own.
    pub fn mode_option(&self) -> Option<&ConfigOption> {
        self.config_options
            .iter()
            .find(|o| o.id == "mode" || o.category.as_deref() == Some("mode"))
    }
}

/// What one `session/update` meant. Most become chat chunks; a few are
/// session metadata the chat surface wants but the transcript does not.
#[derive(Debug, Clone, PartialEq)]
pub enum AcpEvent {
    Chunk(ChatChunk),
    /// The agent's slash commands — its skills and custom commands. These
    /// belong in Aura's command palette, not in the transcript.
    Commands(Vec<AgentCommand>),
    /// The agent switched mode (OpenCode: `build` ↔ `plan`).
    ModeChanged(String),
    /// The agent published a plan — the steps it intends to take, restated
    /// in full every time one of them changes state.
    Plan(Vec<AgentPlanEntry>),
    /// Understood and deliberately not shown (our own echoed input, or an
    /// update kind this build doesn't render).
    Ignored,
}

/// Running position in the assistant's message, so text and tool cards
/// interleave in the order they actually happened.
#[derive(Debug, Default, Clone, Copy)]
pub struct BlockCursor {
    pub idx: usize,
}

impl BlockCursor {
    fn bump(&mut self) -> usize {
        self.idx += 1;
        self.idx
    }
}

/// Pull display text out of an ACP content block, or a list of them.
///
/// Non-text blocks are named rather than dropped: an agent that answers
/// with an image and nothing else should not render as an empty bubble.
pub fn content_text(content: &Value) -> String {
    content_text_with(content, &NoTerminals)
}

/// Where the text of a hosted terminal comes from.
///
/// An agent that runs commands through the client sends a tool card whose
/// only content is a terminal id — it does not repeat the output back,
/// because the client is the one holding it. Without a lookup the card
/// would render as `[terminal term-1]` and the human would see less than
/// they did when the agent ran its own shell.
pub trait TerminalText {
    fn text_of(&self, terminal_id: &str) -> Option<String>;
}

/// The lookup for a client that hosts no terminals — the pure mapping the
/// tests exercise, and the honest answer when `terminal: false`.
pub struct NoTerminals;

impl TerminalText for NoTerminals {
    fn text_of(&self, _: &str) -> Option<String> {
        None
    }
}

/// [`content_text`], resolving terminal blocks through `terminals`.
pub fn content_text_with(content: &Value, terminals: &dyn TerminalText) -> String {
    match content {
        Value::Array(items) => items
            .iter()
            .map(|item| content_text_with(item, terminals))
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join(""),
        Value::Object(_) => match content.get("type").and_then(Value::as_str) {
            Some("text") => content
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            // A tool result wrapping a content block.
            Some("content") => content
                .get("content")
                .map(|inner| content_text_with(inner, terminals))
                .unwrap_or_default(),
            Some("image") => "[image]".to_string(),
            Some("audio") => "[audio]".to_string(),
            Some("resource_link") => content
                .get("uri")
                .and_then(Value::as_str)
                .map(|u| format!("[{u}]"))
                .unwrap_or_default(),
            Some("resource") => content
                .get("resource")
                .and_then(|r| r.get("text"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            // A diff the agent produced — summarise rather than dump both
            // sides into the tool card.
            Some("diff") => content
                .get("path")
                .and_then(Value::as_str)
                .map(|p| format!("edited {p}"))
                .unwrap_or_else(|| "edited".into()),
            // A command we ran for the agent. The id is a handle into our
            // own registry, so resolve it — an agent that hosts its own
            // shell reports the output in the card, and moving the command
            // into Aura must not cost the human that.
            Some("terminal") => content
                .get("terminalId")
                .and_then(Value::as_str)
                .map(|t| {
                    terminals
                        .text_of(t)
                        .unwrap_or_else(|| format!("[terminal {t}]"))
                })
                .unwrap_or_default(),
            _ => String::new(),
        },
        Value::String(s) => s.clone(),
        _ => String::new(),
    }
}

/// Translate one `session/update` payload (the `update` object itself)
/// into what Aura should do about it.
pub fn map_session_update(update: &Value, cursor: &mut BlockCursor) -> AcpEvent {
    map_session_update_with(update, cursor, &NoTerminals)
}

/// [`map_session_update`], resolving hosted terminals through `terminals`.
pub fn map_session_update_with(
    update: &Value,
    cursor: &mut BlockCursor,
    terminals: &dyn TerminalText,
) -> AcpEvent {
    let kind = update
        .get("sessionUpdate")
        .and_then(Value::as_str)
        .unwrap_or_default();

    match kind {
        "agent_message_chunk" => {
            let text = update
                .get("content")
                .map(|c| content_text_with(c, terminals))
                .unwrap_or_default();
            if text.is_empty() {
                return AcpEvent::Ignored;
            }
            AcpEvent::Chunk(ChatChunk::Text {
                block_idx: cursor.idx,
                text,
            })
        }
        "agent_thought_chunk" => {
            let text = update
                .get("content")
                .map(|c| content_text_with(c, terminals))
                .unwrap_or_default();
            if text.is_empty() {
                return AcpEvent::Ignored;
            }
            AcpEvent::Chunk(ChatChunk::Reasoning {
                block_idx: cursor.idx,
                text,
            })
        }
        // Our own prompt, echoed back so a second client could follow the
        // conversation. We already rendered it.
        "user_message_chunk" => AcpEvent::Ignored,
        "tool_call" => {
            let Some(tool_use_id) = update.get("toolCallId").and_then(Value::as_str) else {
                return AcpEvent::Ignored;
            };
            let name = tool_call_name(update);
            // `rawInput` is the agent's actual arguments; `title` is the
            // human sentence. Prefer the arguments and keep the sentence
            // alongside, so the card can show either.
            let mut input = update
                .get("rawInput")
                .cloned()
                .unwrap_or_else(|| json!({}));
            if let (Some(obj), Some(title)) = (
                input.as_object_mut(),
                update.get("title").and_then(Value::as_str),
            ) {
                obj.entry("_title")
                    .or_insert_with(|| json!(title));
            }
            if let Some(locations) = update.get("locations") {
                if let Some(obj) = input.as_object_mut() {
                    obj.entry("_locations")
                        .or_insert_with(|| locations.clone());
                }
            }
            let block_idx = cursor.bump();
            cursor.bump();
            AcpEvent::Chunk(ChatChunk::ToolUse {
                block_idx,
                tool_use_id: tool_use_id.to_string(),
                name,
                input,
                signature: None,
            })
        }
        "tool_call_update" => {
            let Some(tool_use_id) = update.get("toolCallId").and_then(Value::as_str) else {
                return AcpEvent::Ignored;
            };
            let status = update
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or_default();
            // Only a settled call closes the card. `pending`/`in_progress`
            // updates carry partial output we'd otherwise render as a
            // finished result.
            if !matches!(status, "completed" | "failed") {
                return AcpEvent::Ignored;
            }
            let content = update
                .get("content")
                .map(|c| content_text_with(c, terminals))
                .unwrap_or_default();
            AcpEvent::Chunk(ChatChunk::ToolResult {
                tool_use_id: tool_use_id.to_string(),
                content,
                is_error: status == "failed",
            })
        }
        "plan" => AcpEvent::Plan(
            update
                .get("entries")
                .and_then(|v| serde_json::from_value::<Vec<AgentPlanEntry>>(v.clone()).ok())
                .unwrap_or_default(),
        ),
        "available_commands_update" => {
            let commands = update
                .get("availableCommands")
                .and_then(|v| serde_json::from_value::<Vec<AgentCommand>>(v.clone()).ok())
                .unwrap_or_default();
            AcpEvent::Commands(commands)
        }
        "current_mode_update" => update
            .get("currentModeId")
            .or_else(|| update.get("modeId"))
            .and_then(Value::as_str)
            .map(|m| AcpEvent::ModeChanged(m.to_string()))
            .unwrap_or(AcpEvent::Ignored),
        _ => AcpEvent::Ignored,
    }
}

/// A stable tool name for the card. ACP's `kind` is a coarse category
/// (`read`, `edit`, `execute`…) while `title` is a whole sentence; the
/// card wants something in between, so prefer the raw tool name the agent
/// used and fall back to the category.
fn tool_call_name(update: &Value) -> String {
    for key in ["toolName", "name", "kind"] {
        if let Some(s) = update.get(key).and_then(Value::as_str) {
            if !s.is_empty() {
                return s.to_string();
            }
        }
    }
    "tool".to_string()
}

/// Did `session/prompt` end because the agent finished, or because it
/// wants another turn? ACP reports `end_turn`, `max_tokens`,
/// `max_turn_requests`, `refusal`, `cancelled`.
pub fn stop_reason(result: &Value) -> Option<String> {
    result
        .get("stopReason")
        .and_then(Value::as_str)
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_new_result_carries_the_model_picker() {
        // Captured verbatim from `opencode acp` answering `session/new`
        // (trimmed to two model choices).
        let result: Value = serde_json::from_str(
            r#"{"sessionId":"ses_038921995ffeJxln96fEra9lnK","configOptions":[
                {"id":"model","name":"Model","category":"model","type":"select",
                 "currentValue":"opencode/big-pickle",
                 "options":[{"value":"opencode/big-pickle","name":"OpenCode Zen/Big Pickle"},
                            {"value":"opencode/mimo-v2.5-free","name":"OpenCode Zen/MiMo V2.5 Free"}]},
                {"id":"mode","name":"Session Mode","category":"mode","type":"select",
                 "currentValue":"build",
                 "options":[{"value":"build","name":"build","description":"The default agent."},
                            {"value":"plan","name":"plan","description":"Plan mode. Disallows all edit tools."}]}]}"#,
        )
        .unwrap();

        let info = SessionInfo::parse(&result).expect("parses");
        assert_eq!(info.session_id, "ses_038921995ffeJxln96fEra9lnK");
        assert_eq!(info.config_options.len(), 2);

        let model = info.model_option().expect("a model option");
        assert_eq!(model.current_value, Some(json!("opencode/big-pickle")));
        assert_eq!(model.options.len(), 2);
        assert_eq!(model.options[1].name, "OpenCode Zen/MiMo V2.5 Free");
    }

    #[test]
    fn a_session_without_config_options_still_parses() {
        let info = SessionInfo::parse(&json!({"sessionId": "ses_1"})).expect("parses");
        assert!(info.config_options.is_empty());
        assert!(info.model_option().is_none());
    }

    #[test]
    fn message_chunks_become_text() {
        let mut c = BlockCursor::default();
        let ev = map_session_update(
            &json!({"sessionUpdate": "agent_message_chunk",
                    "content": {"type": "text", "text": "Hello"}}),
            &mut c,
        );
        assert_eq!(
            ev,
            AcpEvent::Chunk(ChatChunk::Text {
                block_idx: 0,
                text: "Hello".into()
            })
        );
    }

    #[test]
    fn thought_chunks_become_reasoning_not_prose() {
        // The distinction matters: thinking renders collapsed above the
        // answer. Folding it into Text would put the agent's scratchpad
        // in the reply.
        let mut c = BlockCursor::default();
        let ev = map_session_update(
            &json!({"sessionUpdate": "agent_thought_chunk",
                    "content": {"type": "text", "text": "let me check"}}),
            &mut c,
        );
        assert!(matches!(ev, AcpEvent::Chunk(ChatChunk::Reasoning { .. })));
    }

    #[test]
    fn our_own_echoed_prompt_is_not_rendered_twice() {
        let mut c = BlockCursor::default();
        let ev = map_session_update(
            &json!({"sessionUpdate": "user_message_chunk",
                    "content": {"type": "text", "text": "say hi"}}),
            &mut c,
        );
        assert_eq!(ev, AcpEvent::Ignored);
    }

    #[test]
    fn tool_call_opens_a_card_with_the_agents_real_arguments() {
        let mut c = BlockCursor::default();
        let ev = map_session_update(
            &json!({"sessionUpdate": "tool_call",
                    "toolCallId": "call_1",
                    "title": "Read src/main.rs",
                    "kind": "read",
                    "status": "pending",
                    "rawInput": {"filePath": "src/main.rs"},
                    "locations": [{"path": "src/main.rs", "line": 12}]}),
            &mut c,
        );
        match ev {
            AcpEvent::Chunk(ChatChunk::ToolUse {
                tool_use_id,
                name,
                input,
                block_idx,
                ..
            }) => {
                assert_eq!(tool_use_id, "call_1");
                assert_eq!(name, "read");
                assert_eq!(input["filePath"], "src/main.rs");
                assert_eq!(input["_title"], "Read src/main.rs");
                assert_eq!(input["_locations"][0]["line"], 12);
                assert_eq!(block_idx, 1);
            }
            other => panic!("expected a tool card, got {other:?}"),
        }
        // Text after a tool card lands in a later block, so the transcript
        // keeps the real order instead of collapsing onto the card.
        assert_eq!(c.idx, 2);
    }

    #[test]
    fn only_a_settled_tool_call_closes_the_card() {
        let mut c = BlockCursor::default();
        for status in ["pending", "in_progress"] {
            let ev = map_session_update(
                &json!({"sessionUpdate": "tool_call_update",
                        "toolCallId": "call_1", "status": status,
                        "content": [{"type": "content",
                                     "content": {"type": "text", "text": "partial"}}]}),
                &mut c,
            );
            assert_eq!(ev, AcpEvent::Ignored, "status {status} must not settle");
        }

        let ev = map_session_update(
            &json!({"sessionUpdate": "tool_call_update",
                    "toolCallId": "call_1", "status": "completed",
                    "content": [{"type": "content",
                                 "content": {"type": "text", "text": "fn main() {}"}}]}),
            &mut c,
        );
        assert_eq!(
            ev,
            AcpEvent::Chunk(ChatChunk::ToolResult {
                tool_use_id: "call_1".into(),
                content: "fn main() {}".into(),
                is_error: false,
            })
        );
    }

    #[test]
    fn a_failed_tool_call_is_marked_as_an_error() {
        let mut c = BlockCursor::default();
        let ev = map_session_update(
            &json!({"sessionUpdate": "tool_call_update",
                    "toolCallId": "call_2", "status": "failed",
                    "content": [{"type": "content",
                                 "content": {"type": "text", "text": "ENOENT"}}]}),
            &mut c,
        );
        match ev {
            AcpEvent::Chunk(ChatChunk::ToolResult { is_error, .. }) => assert!(is_error),
            other => panic!("expected an errored result, got {other:?}"),
        }
    }

    #[test]
    fn available_commands_are_lifted_out_of_the_transcript() {
        // Captured shape: OpenCode pushes this unprompted right after
        // `session/new`. It's palette content, not conversation.
        let mut c = BlockCursor::default();
        let ev = map_session_update(
            &json!({"sessionUpdate": "available_commands_update",
                    "availableCommands": [
                        {"name": "clone-website", "description": "Reverse-engineer a website"},
                        {"name": "customize-opencode"}]}),
            &mut c,
        );
        match ev {
            AcpEvent::Commands(cmds) => {
                assert_eq!(cmds.len(), 2);
                assert_eq!(cmds[0].name, "clone-website");
                assert_eq!(cmds[1].description, None);
            }
            other => panic!("expected commands, got {other:?}"),
        }
        assert_eq!(c.idx, 0, "palette updates must not consume a block");
    }

    #[test]
    fn mode_switches_are_reported() {
        let mut c = BlockCursor::default();
        let ev = map_session_update(
            &json!({"sessionUpdate": "current_mode_update", "currentModeId": "plan"}),
            &mut c,
        );
        assert_eq!(ev, AcpEvent::ModeChanged("plan".into()));
    }

    #[test]
    fn unknown_updates_are_survivable() {
        // A newer agent inventing an update kind must not break the turn.
        let mut c = BlockCursor::default();
        assert_eq!(
            map_session_update(&json!({"sessionUpdate": "something_new"}), &mut c),
            AcpEvent::Ignored
        );
        assert_eq!(map_session_update(&json!({}), &mut c), AcpEvent::Ignored);
    }

    #[test]
    fn content_blocks_of_every_kind_render_something() {
        assert_eq!(content_text(&json!({"type": "text", "text": "hi"})), "hi");
        assert_eq!(
            content_text(&json!({"type": "image", "data": "x", "mimeType": "image/png"})),
            "[image]"
        );
        assert_eq!(
            content_text(&json!({"type": "resource_link", "uri": "file:///a.rs"})),
            "[file:///a.rs]"
        );
        assert_eq!(
            content_text(&json!({"type": "diff", "path": "a.rs", "oldText": "", "newText": "x"})),
            "edited a.rs"
        );
        assert_eq!(
            content_text(&json!([{"type": "text", "text": "a"}, {"type": "text", "text": "b"}])),
            "ab"
        );
    }

    #[test]
    fn permission_options_classify_by_kind_not_label() {
        // Captured verbatim from OpenCode's ACP layer.
        let opts: Vec<PermissionOption> = serde_json::from_str(
            r#"[{"optionId":"once","kind":"allow_once","name":"Allow once"},
                {"optionId":"always","kind":"allow_always","name":"Always allow"},
                {"optionId":"reject","kind":"reject_once","name":"Reject"}]"#,
        )
        .unwrap();
        assert!(opts[0].is_allow() && !opts[0].is_persistent());
        assert!(opts[1].is_allow() && opts[1].is_persistent());
        assert!(!opts[2].is_allow() && !opts[2].is_persistent());
    }

    #[test]
    fn stop_reason_is_read_from_the_prompt_result() {
        assert_eq!(
            stop_reason(&json!({"stopReason": "end_turn"})).as_deref(),
            Some("end_turn")
        );
        assert_eq!(stop_reason(&json!({})), None);
    }
}
