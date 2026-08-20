//! pi's RPC shapes, and the translation into Aura's own chunks.
//!
//! Pure — no process, no policy, no I/O. Every fixture below is a line
//! captured from `pi --mode rpc` or copied verbatim from its `docs/rpc.md`,
//! so a protocol change breaks a test here rather than a conversation.
//!
//! Three jobs:
//!
//! 1. **Streaming.** pi wraps its deltas twice: an event of `type:
//!    "message_update"` carries an `assistantMessageEvent` whose own `type`
//!    is the delta. Text, thinking and tool-call fragments all arrive that
//!    way; tool *execution* is separate (`tool_execution_start` / `_end`).
//! 2. **Tool classification.** pi runs its own tools, so Aura cannot serve
//!    them the way it serves ACP's `fs/write_text_file` — it can only
//!    decide, before each one runs, whether it may. [`tool_effect`] is that
//!    decision, and it is a table rather than a guess: an unrecognised tool
//!    is treated as the most dangerous thing it could be.
//! 3. **The gate handshake.** The Aura extension asks its questions through
//!    pi's extension-UI protocol. [`GateAsk`] is what one of those questions
//!    looks like once parsed.

use serde_json::{Value, json};

use crate::manager::brain::types::{ChatChunk, ChatMessage};

/// The command that puts pi into line-delimited RPC mode.
pub const RPC_ARGS: &[&str] = &["--mode", "rpc"];

/// Event `type`s we act on. pi emits a couple of dozen; the rest are
/// progress the transcript doesn't need.
pub mod event {
    pub const MESSAGE_UPDATE: &str = "message_update";
    pub const TOOL_EXECUTION_START: &str = "tool_execution_start";
    pub const TOOL_EXECUTION_END: &str = "tool_execution_end";
    /// The whole run settled — no retry, no compaction, no queued
    /// follow-up left. This, not `agent_end`, is the end of a turn.
    pub const AGENT_SETTLED: &str = "agent_settled";
    pub const EXTENSION_UI_REQUEST: &str = "extension_ui_request";
    pub const EXTENSION_ERROR: &str = "extension_error";
}

/// Commands we send.
pub mod command {
    pub const PROMPT: &str = "prompt";
    pub const ABORT: &str = "abort";
    pub const GET_AVAILABLE_MODELS: &str = "get_available_models";
    pub const SET_MODEL: &str = "set_model";
}

/// Build one RPC command line. pi correlates on `id` exactly like the
/// JSON-RPC side does, it just spells the envelope differently.
pub fn rpc_command(id: &str, command: &str, extra: Value) -> Value {
    let mut line = json!({ "id": id, "type": command });
    if let (Some(obj), Some(extra)) = (line.as_object_mut(), extra.as_object()) {
        for (k, v) in extra {
            obj.insert(k.clone(), v.clone());
        }
    }
    line
}

/// Read the outcome of a `{"type":"response"}` envelope. pi reports
/// failure in-band (`success: false` plus `error`) rather than with a
/// JSON-RPC error object.
pub fn response_result(body: &Value) -> Result<Value, String> {
    if body.get("success").and_then(Value::as_bool) == Some(true) {
        return Ok(body.get("data").cloned().unwrap_or_else(|| json!({})));
    }
    Err(body
        .get("error")
        .and_then(Value::as_str)
        .unwrap_or("the command failed and pi gave no reason")
        .to_string())
}

/// Where the cursor is in the assistant's block sequence. pi numbers its
/// own content blocks per message (`contentIndex`), which restarts at 0
/// on every message; Aura's block index runs for the whole turn. This
/// keeps the mapping between them.
#[derive(Debug, Default)]
pub struct BlockCursor {
    /// Aura block index for the block currently being streamed.
    idx: usize,
    /// pi's `contentIndex` for that block, so a new one is noticed.
    content_idx: Option<i64>,
}

impl BlockCursor {
    /// The Aura block index for pi's `contentIndex`, advancing when pi
    /// moves to a block we haven't seen.
    fn at(&mut self, content_idx: i64) -> usize {
        if self.content_idx != Some(content_idx) {
            if self.content_idx.is_some() {
                self.idx += 1;
            }
            self.content_idx = Some(content_idx);
        }
        self.idx
    }

    /// Claim a block index for something that isn't part of the streamed
    /// text run — a tool card. The next text delta starts a fresh block.
    fn standalone(&mut self) -> usize {
        if self.content_idx.is_some() {
            self.idx += 1;
        }
        self.content_idx = None;
        let idx = self.idx;
        self.idx += 1;
        idx
    }
}

/// What one inbound pi line means to us.
#[derive(Debug, PartialEq)]
pub enum PiEvent {
    /// Goes into the transcript.
    Chunk(ChatChunk),
    /// The turn is over.
    Settled,
    /// The Aura extension is asking whether a tool may run.
    Gate(GateAsk),
    /// A dialog we didn't put there. Answering blind would let an
    /// unrelated extension drive Aura's UI, so the brain dismisses it.
    ForeignDialog { id: String },
    /// Nothing the caller has to do.
    Ignored,
}

/// One "may this tool run?" question from the Aura extension, already
/// parsed out of pi's extension-UI envelope.
#[derive(Debug, Clone, PartialEq)]
pub struct GateAsk {
    /// Correlates the answer we write back.
    pub id: String,
    pub tool: String,
    /// The tool's arguments, as pi is about to run them.
    pub input: Value,
}

/// The `title` the Aura extension stamps on its gate questions. Namespaced
/// so a dialog from someone else's extension is never mistaken for one of
/// ours — and so ours is never mistaken for a message meant for a human.
pub const GATE_TITLE: &str = "aura.gate";

/// The answer that lets a tool run. Anything else the extension receives
/// is a refusal, and the string itself is the reason it shows the model —
/// which is why the gate asks through `input` rather than `confirm`: a
/// boolean cannot explain that the snapshot failed.
pub const GATE_ALLOW: &str = "allow";

/// Translate one inbound line.
pub fn map_event(value: &Value, cursor: &mut BlockCursor) -> PiEvent {
    match value.get("type").and_then(Value::as_str).unwrap_or_default() {
        event::MESSAGE_UPDATE => map_message_update(value, cursor),
        event::TOOL_EXECUTION_START => map_tool_start(value, cursor),
        event::TOOL_EXECUTION_END => map_tool_end(value),
        event::AGENT_SETTLED => PiEvent::Settled,
        event::EXTENSION_UI_REQUEST => map_ui_request(value),
        // An extension threw. It is not the model's answer, but it is the
        // reason the answer is missing, so it belongs in the transcript.
        event::EXTENSION_ERROR => {
            let msg = value
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("an extension failed");
            PiEvent::Chunk(ChatChunk::Error {
                message: format!("pi extension error: {msg}"),
            })
        }
        _ => PiEvent::Ignored,
    }
}

fn map_message_update(value: &Value, cursor: &mut BlockCursor) -> PiEvent {
    let Some(ev) = value.get("assistantMessageEvent") else {
        return PiEvent::Ignored;
    };
    let content_idx = ev.get("contentIndex").and_then(Value::as_i64).unwrap_or(0);
    let delta = ev.get("delta").and_then(Value::as_str).unwrap_or_default();

    match ev.get("type").and_then(Value::as_str).unwrap_or_default() {
        "text_delta" if !delta.is_empty() => PiEvent::Chunk(ChatChunk::Text {
            block_idx: cursor.at(content_idx),
            text: delta.to_string(),
        }),
        "thinking_delta" if !delta.is_empty() => PiEvent::Chunk(ChatChunk::Reasoning {
            block_idx: cursor.at(content_idx),
            text: delta.to_string(),
        }),
        // `toolcall_delta` streams half-built JSON arguments. The card is
        // drawn from `tool_execution_start`, which carries them whole.
        _ => PiEvent::Ignored,
    }
}

fn map_tool_start(value: &Value, cursor: &mut BlockCursor) -> PiEvent {
    let Some(id) = value.get("toolCallId").and_then(Value::as_str) else {
        return PiEvent::Ignored;
    };
    let name = value
        .get("toolName")
        .and_then(Value::as_str)
        .unwrap_or("tool");
    PiEvent::Chunk(ChatChunk::ToolUse {
        block_idx: cursor.standalone(),
        tool_use_id: id.to_string(),
        name: name.to_string(),
        input: value.get("args").cloned().unwrap_or_else(|| json!({})),
        signature: None,
    })
}

fn map_tool_end(value: &Value) -> PiEvent {
    let Some(id) = value.get("toolCallId").and_then(Value::as_str) else {
        return PiEvent::Ignored;
    };
    PiEvent::Chunk(ChatChunk::ToolResult {
        tool_use_id: id.to_string(),
        content: result_text(value.get("result")),
        is_error: value
            .get("isError")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    })
}

fn map_ui_request(value: &Value) -> PiEvent {
    let Some(id) = value.get("id").and_then(Value::as_str) else {
        return PiEvent::Ignored;
    };
    let is_dialog = matches!(
        value.get("method").and_then(Value::as_str).unwrap_or(""),
        "select" | "confirm" | "input" | "editor"
    );
    if !is_dialog {
        // notify / setStatus / setWidget — fire-and-forget. pi is not
        // waiting on us, and Aura has its own status surfaces.
        return PiEvent::Ignored;
    }
    if value.get("title").and_then(Value::as_str) != Some(GATE_TITLE) {
        return PiEvent::ForeignDialog { id: id.to_string() };
    }
    // `input`'s placeholder is the only free field that survives the trip,
    // so the extension packs the tool name and its arguments into it.
    let parsed: Option<Value> = value
        .get("placeholder")
        .and_then(Value::as_str)
        .and_then(|m| serde_json::from_str(m).ok());
    let Some(parsed) = parsed else {
        return PiEvent::ForeignDialog { id: id.to_string() };
    };
    PiEvent::Gate(GateAsk {
        id: id.to_string(),
        tool: parsed
            .get("tool")
            .and_then(Value::as_str)
            .unwrap_or("tool")
            .to_string(),
        input: parsed.get("input").cloned().unwrap_or_else(|| json!({})),
    })
}

/// The answer line for one gate question: [`GATE_ALLOW`], or the sentence
/// the model should be shown instead of the tool's output.
pub fn gate_answer(id: &str, verdict: &str) -> Value {
    json!({ "type": "extension_ui_response", "id": id, "value": verdict })
}

/// Dismiss a dialog we can't answer meaningfully.
pub fn dismiss_dialog(id: &str) -> Value {
    json!({ "type": "extension_ui_response", "id": id, "cancelled": true })
}

/// Flatten a pi tool result into display text.
fn result_text(result: Option<&Value>) -> String {
    let Some(result) = result else {
        return String::new();
    };
    let Some(items) = result.get("content").and_then(Value::as_array) else {
        return String::new();
    };
    items
        .iter()
        .filter_map(|c| match c.get("type").and_then(Value::as_str) {
            Some("text") => c.get("text").and_then(Value::as_str).map(str::to_string),
            Some("image") => Some("[image]".to_string()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("")
}

/// What a tool does to the machine, which is what decides how hard Aura
/// looks at it before letting it run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolEffect {
    /// Looks at files. Confined to the session root, but not worth a card.
    Read,
    /// Changes a file. Snapshot first, then ask.
    Write,
    /// Runs something. Always ask — we cannot tell what a command does by
    /// reading it.
    Execute,
}

/// Classify one of pi's tools.
///
/// pi 0.83 advertises exactly four to the model — `read`, `bash`, `edit`,
/// `write` (read off a request pi made to a local endpoint, not off a doc).
/// The rest of the names below are ones adjacent engines use and pi may
/// grow; listing them early costs nothing and each one it does adopt then
/// gets the right treatment on day one instead of the strictest.
///
/// The unknown case is `Execute` on purpose. pi ships new tools and
/// extensions register their own; a tool this table hasn't met gets the
/// strictest treatment, so the failure mode of falling behind pi's
/// releases is an extra permission card rather than an ungated write.
pub fn tool_effect(name: &str) -> ToolEffect {
    match name {
        "read" | "list" | "glob" | "grep" | "tree" | "todo_read" => ToolEffect::Read,
        "write" | "edit" | "multi_edit" | "apply_patch" | "todo_write" => ToolEffect::Write,
        _ => ToolEffect::Execute,
    }
}

/// The file a tool is about to touch, if its arguments name one. pi's
/// own tools use `path`; extensions and older builds use `file_path`.
pub fn target_path(input: &Value) -> Option<&str> {
    input
        .get("path")
        .or_else(|| input.get("file_path"))
        .or_else(|| input.get("filePath"))
        .and_then(Value::as_str)
}

/// Turn one Aura message into pi's prompt text plus its images.
///
/// pi takes a single string, not content blocks, so a multi-block message
/// is joined. Images travel in their own field.
pub fn prompt_payload(messages: &[ChatMessage]) -> (String, Vec<Value>) {
    let mut text = Vec::new();
    let mut images = Vec::new();
    for m in messages {
        match &m.content {
            Value::String(s) if !s.is_empty() => text.push(s.clone()),
            Value::Array(blocks) => {
                for b in blocks {
                    match b.get("type").and_then(Value::as_str) {
                        Some("text") => {
                            if let Some(t) = b.get("text").and_then(Value::as_str) {
                                if !t.is_empty() {
                                    text.push(t.to_string());
                                }
                            }
                        }
                        Some("image") => {
                            let data = b
                                .get("source")
                                .and_then(|s| s.get("data"))
                                .or_else(|| b.get("data"))
                                .cloned();
                            let mime = b
                                .get("source")
                                .and_then(|s| s.get("media_type"))
                                .or_else(|| b.get("mimeType"))
                                .cloned();
                            if let (Some(data), Some(mime)) = (data, mime) {
                                images.push(
                                    json!({ "type": "image", "data": data, "mimeType": mime }),
                                );
                            }
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }
    (text.join("\n\n"), images)
}

/// One model pi says it can run.
#[derive(Debug, Clone, PartialEq)]
pub struct PiModel {
    /// `provider/id` — the pair `set_model` needs, joined so it can travel
    /// through Aura's single `model` string.
    pub id: String,
    pub label: String,
}

/// Split a picker id back into the `provider` / `modelId` pair pi wants.
pub fn split_model_id(id: &str) -> Option<(&str, &str)> {
    id.split_once('/')
}

/// Read `get_available_models`' answer.
///
/// An empty list is a real answer, not a failure: pi with no provider
/// configured genuinely can run nothing, and saying so beats inventing a
/// menu that errors on click.
pub fn parse_models(data: &Value) -> Vec<PiModel> {
    data.get("models")
        .and_then(Value::as_array)
        .map(|models| {
            models
                .iter()
                .filter_map(|m| {
                    let id = m.get("id").and_then(Value::as_str)?;
                    let provider = m.get("provider").and_then(Value::as_str).unwrap_or_default();
                    let label = m.get("name").and_then(Value::as_str).unwrap_or(id);
                    Some(PiModel {
                        id: if provider.is_empty() {
                            id.to_string()
                        } else {
                            format!("{provider}/{id}")
                        },
                        label: label.to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(line: &str) -> Value {
        serde_json::from_str(line).expect("fixture is valid JSON")
    }

    #[test]
    fn text_deltas_stream_into_one_block() {
        let mut c = BlockCursor::default();
        let a = map_event(
            &ev(r#"{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"Hello"}}"#),
            &mut c,
        );
        let b = map_event(
            &ev(r#"{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":" world"}}"#),
            &mut c,
        );
        assert_eq!(
            a,
            PiEvent::Chunk(ChatChunk::Text {
                block_idx: 0,
                text: "Hello".into()
            })
        );
        assert_eq!(
            b,
            PiEvent::Chunk(ChatChunk::Text {
                block_idx: 0,
                text: " world".into()
            })
        );
    }

    #[test]
    fn thinking_is_its_own_block_not_the_answer() {
        // Rendering pi's reasoning as prose would put its scratchpad in
        // the reply.
        let mut c = BlockCursor::default();
        let got = map_event(
            &ev(r#"{"type":"message_update","assistantMessageEvent":{"type":"thinking_delta","contentIndex":0,"delta":"hmm"}}"#),
            &mut c,
        );
        assert!(matches!(
            got,
            PiEvent::Chunk(ChatChunk::Reasoning { .. })
        ));
    }

    #[test]
    fn a_new_content_index_starts_a_new_block() {
        let mut c = BlockCursor::default();
        map_event(
            &ev(r#"{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"a"}}"#),
            &mut c,
        );
        let second = map_event(
            &ev(r#"{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":1,"delta":"b"}}"#),
            &mut c,
        );
        match second {
            PiEvent::Chunk(ChatChunk::Text { block_idx, .. }) => assert_eq!(block_idx, 1),
            other => panic!("expected text, got {other:?}"),
        }
    }

    #[test]
    fn a_tool_card_does_not_reuse_the_prose_block() {
        // Otherwise the card overwrites the sentence that introduced it.
        let mut c = BlockCursor::default();
        map_event(
            &ev(r#"{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"Listing…"}}"#),
            &mut c,
        );
        let card = map_event(
            &ev(r#"{"type":"tool_execution_start","toolCallId":"call_1","toolName":"bash","args":{"command":"ls -la"}}"#),
            &mut c,
        );
        match card {
            PiEvent::Chunk(ChatChunk::ToolUse {
                block_idx,
                tool_use_id,
                name,
                input,
                ..
            }) => {
                assert_eq!(block_idx, 1);
                assert_eq!(tool_use_id, "call_1");
                assert_eq!(name, "bash");
                assert_eq!(input["command"], "ls -la");
            }
            other => panic!("expected a tool card, got {other:?}"),
        }
        // …and prose after the card lands somewhere new again.
        let after = map_event(
            &ev(r#"{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":1,"delta":"done"}}"#),
            &mut c,
        );
        match after {
            PiEvent::Chunk(ChatChunk::Text { block_idx, .. }) => assert_eq!(block_idx, 2),
            other => panic!("expected text, got {other:?}"),
        }
    }

    #[test]
    fn a_tool_result_carries_its_text_and_its_failure() {
        let mut c = BlockCursor::default();
        let got = map_event(
            &ev(r#"{"type":"tool_execution_end","toolCallId":"call_1","toolName":"bash","result":{"content":[{"type":"text","text":"total 48"}]},"isError":true}"#),
            &mut c,
        );
        assert_eq!(
            got,
            PiEvent::Chunk(ChatChunk::ToolResult {
                tool_use_id: "call_1".into(),
                content: "total 48".into(),
                is_error: true,
            })
        );
    }

    #[test]
    fn the_turn_ends_when_the_run_settles_not_when_the_agent_pauses() {
        // `agent_end` fires before an automatic retry or a queued
        // follow-up; ending the stream there would truncate the answer.
        let mut c = BlockCursor::default();
        assert_eq!(
            map_event(&ev(r#"{"type":"agent_end","willRetry":true}"#), &mut c),
            PiEvent::Ignored
        );
        assert_eq!(
            map_event(&ev(r#"{"type":"agent_settled"}"#), &mut c),
            PiEvent::Settled
        );
    }

    #[test]
    fn our_gate_question_parses_into_a_tool_and_its_arguments() {
        let mut c = BlockCursor::default();
        let line = json!({
            "type": "extension_ui_request",
            "id": "uuid-2",
            "method": "input",
            "title": GATE_TITLE,
            "placeholder": json!({"tool":"write","input":{"path":"/repo/a.rs"}}).to_string(),
        });
        assert_eq!(
            map_event(&line, &mut c),
            PiEvent::Gate(GateAsk {
                id: "uuid-2".into(),
                tool: "write".into(),
                input: json!({"path": "/repo/a.rs"}),
            })
        );
    }

    #[test]
    fn a_refusal_travels_back_as_the_sentence_the_model_will_see() {
        assert_eq!(gate_answer("uuid-2", GATE_ALLOW)["value"], json!("allow"));
        let denied = gate_answer("uuid-2", "the snapshot failed");
        assert_eq!(denied["value"], json!("the snapshot failed"));
        assert_eq!(denied["id"], json!("uuid-2"));
    }

    #[test]
    fn someone_elses_dialog_is_dismissed_not_answered() {
        // A third-party extension's `confirm` must not be silently
        // approved by Aura's gate — nobody asked the user about it.
        let mut c = BlockCursor::default();
        let line = ev(
            r#"{"type":"extension_ui_request","id":"x","method":"confirm","title":"Clear session?","message":"All messages will be lost."}"#,
        );
        assert_eq!(map_event(&line, &mut c), PiEvent::ForeignDialog { id: "x".into() });
        assert_eq!(dismiss_dialog("x")["cancelled"], json!(true));
    }

    #[test]
    fn a_notification_needs_no_answer() {
        // Fire-and-forget: pi is not blocked on it, so replying would
        // desynchronise the dialog table.
        let mut c = BlockCursor::default();
        let line = ev(
            r#"{"type":"extension_ui_request","id":"n","method":"notify","message":"done"}"#,
        );
        assert_eq!(map_event(&line, &mut c), PiEvent::Ignored);
    }

    #[test]
    fn an_unknown_tool_is_treated_as_the_worst_case() {
        assert_eq!(tool_effect("read"), ToolEffect::Read);
        assert_eq!(tool_effect("edit"), ToolEffect::Write);
        assert_eq!(tool_effect("bash"), ToolEffect::Execute);
        assert_eq!(
            tool_effect("some_extension_tool"),
            ToolEffect::Execute,
            "a tool we don't recognise must not slip through as a read"
        );
    }

    #[test]
    fn the_target_path_is_found_however_the_tool_spells_it() {
        assert_eq!(target_path(&json!({"path":"/a"})), Some("/a"));
        assert_eq!(target_path(&json!({"file_path":"/b"})), Some("/b"));
        assert_eq!(target_path(&json!({"command":"ls"})), None);
    }

    #[test]
    fn a_failed_command_says_why() {
        let body = ev(
            r#"{"type":"response","command":"set_model","success":false,"error":"Model not found: invalid/model"}"#,
        );
        assert_eq!(
            response_result(&body).unwrap_err(),
            "Model not found: invalid/model"
        );
    }

    #[test]
    fn models_carry_the_provider_so_set_model_can_be_called() {
        // `set_model` needs {provider, modelId}; the picker only has one
        // string, so the pair has to survive the round trip.
        let data = ev(
            r#"{"models":[{"id":"claude-sonnet-4-20250514","name":"Claude Sonnet 4","provider":"anthropic"}]}"#,
        );
        let models = parse_models(&data);
        assert_eq!(
            models,
            vec![PiModel {
                id: "anthropic/claude-sonnet-4-20250514".into(),
                label: "Claude Sonnet 4".into(),
            }]
        );
        assert_eq!(
            split_model_id(&models[0].id),
            Some(("anthropic", "claude-sonnet-4-20250514"))
        );
    }

    #[test]
    fn a_pi_with_no_login_publishes_nothing_rather_than_a_guess() {
        // Captured from a real `pi --mode rpc` that has never been signed
        // in. The picker's job then is to show the honest default row.
        let body = ev(
            r#"{"id":"m","type":"response","command":"get_available_models","success":true,"data":{"models":[]}}"#,
        );
        let data = response_result(&body).unwrap();
        assert!(parse_models(&data).is_empty());
    }

    #[test]
    fn a_prompt_flattens_blocks_and_lifts_images_out() {
        let msgs = vec![ChatMessage {
            role: "user".into(),
            content: json!([
                {"type": "text", "text": "what is this"},
                {"type": "image", "source": {"data": "AAAA", "media_type": "image/png"}},
            ]),
        }];
        let (text, images) = prompt_payload(&msgs);
        assert_eq!(text, "what is this");
        assert_eq!(images.len(), 1);
        assert_eq!(images[0]["mimeType"], "image/png");
    }

    #[test]
    fn a_command_line_carries_its_id_and_its_arguments() {
        let line = rpc_command("7", command::SET_MODEL, json!({"provider":"anthropic","modelId":"x"}));
        assert_eq!(line["id"], "7");
        assert_eq!(line["type"], "set_model");
        assert_eq!(line["provider"], "anthropic");
    }
}
