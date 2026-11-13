//! `session/update` notifications. The raw update travels on untouched (the
//! desktop renderer and the cloud relay both want ACP verbatim); this module
//! classifies it and pulls out the fields Rust-side consumers act on.

use agent_client_protocol_schema::v1 as schema;
use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UpdateKind {
    UserMessageChunk,
    AgentMessageChunk,
    AgentThoughtChunk,
    ToolCall,
    ToolCallUpdate,
    Plan,
    AvailableCommands,
    CurrentMode,
    ConfigOptions,
    SessionInfo,
    Usage,
    Notice,
    /// A kind newer than v1 stable, kept so it can be passed through.
    Other(String),
}

impl UpdateKind {
    pub fn from_wire(s: &str) -> Self {
        match s {
            "user_message_chunk" => Self::UserMessageChunk,
            "agent_message_chunk" => Self::AgentMessageChunk,
            "agent_thought_chunk" => Self::AgentThoughtChunk,
            "tool_call" => Self::ToolCall,
            "tool_call_update" => Self::ToolCallUpdate,
            "plan" => Self::Plan,
            "available_commands_update" => Self::AvailableCommands,
            "current_mode_update" => Self::CurrentMode,
            "config_option_update" => Self::ConfigOptions,
            "session_info_update" => Self::SessionInfo,
            "usage_update" => Self::Usage,
            "notice" => Self::Notice,
            other => Self::Other(other.to_string()),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Update {
    pub session_id: String,
    pub kind: UpdateKind,
    /// The `update` object exactly as the agent sent it.
    pub raw: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ContextUsage {
    pub used: u64,
    pub size: u64,
    pub cost: Option<(f64, String)>,
}

impl Update {
    /// Parse `session/update` params (`{sessionId, update}`).
    pub fn parse(params: &Value) -> Option<Update> {
        let raw = params.get("update")?.clone();
        let kind = UpdateKind::from_wire(raw.get("sessionUpdate")?.as_str()?);
        Some(Update { session_id: params.get("sessionId").and_then(Value::as_str).unwrap_or_default().to_string(), kind, raw })
    }

    /// The spec-typed view. Fails for kinds newer than the schema crate.
    pub fn typed(&self) -> Result<schema::SessionUpdate, serde_json::Error> {
        serde_json::from_value(self.raw.clone())
    }

    pub fn message_id(&self) -> Option<&str> {
        self.raw.get("messageId").and_then(Value::as_str)
    }

    /// Text of a message or thought chunk (text and resource-link blocks).
    pub fn chunk_text(&self) -> Option<String> {
        match self.kind {
            UpdateKind::AgentMessageChunk | UpdateKind::AgentThoughtChunk | UpdateKind::UserMessageChunk => {
                content_text(self.raw.get("content")?)
            }
            _ => None,
        }
    }

    pub fn tool_call_id(&self) -> Option<&str> {
        self.raw.get("toolCallId").and_then(Value::as_str)
    }

    pub fn tool_kind(&self) -> Option<&str> {
        self.raw.get("kind").and_then(Value::as_str)
    }

    pub fn tool_status(&self) -> Option<&str> {
        self.raw.get("status").and_then(Value::as_str)
    }

    /// Paths a tool call touches: its `locations` plus diff targets.
    pub fn tool_paths(&self) -> Vec<String> {
        let mut out: Vec<String> = self
            .raw
            .get("locations")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|l| l.get("path").and_then(Value::as_str).map(str::to_string))
            .collect();
        for c in self.raw.get("content").and_then(Value::as_array).into_iter().flatten() {
            if c.get("type").and_then(Value::as_str) == Some("diff") {
                if let Some(p) = c.get("path").and_then(Value::as_str) {
                    if !out.iter().any(|o| o == p) {
                        out.push(p.to_string());
                    }
                }
            }
        }
        out
    }

    pub fn usage(&self) -> Option<ContextUsage> {
        if self.kind != UpdateKind::Usage {
            return None;
        }
        Some(ContextUsage {
            used: self.raw.get("used")?.as_u64()?,
            size: self.raw.get("size")?.as_u64()?,
            cost: self.raw.get("cost").and_then(|c| {
                Some((c.get("amount")?.as_f64()?, c.get("currency")?.as_str()?.to_string()))
            }),
        })
    }

    /// `session_info_update` title. `Some(None)` = title cleared.
    pub fn title(&self) -> Option<Option<String>> {
        if self.kind != UpdateKind::SessionInfo {
            return None;
        }
        match self.raw.get("title") {
            None => None,
            Some(Value::Null) => Some(None),
            Some(v) => Some(v.as_str().map(str::to_string)),
        }
    }

    pub fn current_mode(&self) -> Option<&str> {
        if self.kind != UpdateKind::CurrentMode {
            return None;
        }
        self.raw.get("currentModeId").and_then(Value::as_str)
    }
}

/// Human text for a content block: text, a resource link's name/uri, or an
/// embedded text resource.
pub fn content_text(block: &Value) -> Option<String> {
    match block.get("type")?.as_str()? {
        "text" => block.get("text").and_then(Value::as_str).map(str::to_string),
        "resource_link" => block
            .get("title")
            .or_else(|| block.get("name"))
            .or_else(|| block.get("uri"))
            .and_then(Value::as_str)
            .map(str::to_string),
        "resource" => block.pointer("/resource/text").and_then(Value::as_str).map(str::to_string),
        _ => None,
    }
}
