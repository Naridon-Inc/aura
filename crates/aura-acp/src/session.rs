//! The session driver: the v1 client lifecycle over one [`Connection`].
//!
//! The driver sends; it does not read. The caller owns the connection's
//! inbound receiver and services agent requests (permission, elicitation,
//! fs, terminal) concurrently with an in-flight `prompt`.

use crate::conn::Connection;
use crate::profile::{option_for, AgentProfile, AuthMethod, ClientCaps, ClientInfo, ConfigOption, PROTOCOL_VERSION};
use crate::rpc::RpcError;
use agent_client_protocol_schema::v1::AGENT_METHOD_NAMES as M;
use serde::Serialize;
use serde_json::{json, Value};
use std::fmt;

#[derive(Debug, Clone)]
pub enum AcpError {
    /// The agent wants a sign-in first. `methods` is what it advertised.
    AuthRequired { methods: Vec<AuthMethod>, detail: String },
    /// The agent lacks a capability this call needs.
    Unsupported(String),
    /// The body was not what the protocol promises.
    Protocol(String),
    Rpc(RpcError),
}

impl fmt::Display for AcpError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            AcpError::AuthRequired { detail, .. } => write!(f, "{detail}"),
            AcpError::Unsupported(s) | AcpError::Protocol(s) => write!(f, "{s}"),
            AcpError::Rpc(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for AcpError {}

impl From<RpcError> for AcpError {
    fn from(e: RpcError) -> Self {
        AcpError::Rpc(e)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Opened {
    New,
    Resumed,
    Loaded,
}

/// Modes as the pre-config-options API reported them (`modes`).
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct Modes {
    pub current: Option<String>,
    pub available: Vec<(String, String)>,
}

/// One open session.
#[derive(Debug, Clone, Serialize)]
pub struct Session {
    pub id: String,
    pub how: Opened,
    pub config: Vec<ConfigOption>,
    pub modes: Modes,
    /// Pre-config-options model list (`models.availableModels`), still
    /// emitted by some agents. Empty when the agent uses config options.
    pub legacy_models: Vec<String>,
    pub legacy_current_model: Option<String>,
}

impl Session {
    /// Parse a `session/new`, `session/load` or `session/resume` result.
    pub fn from_result(id: String, how: Opened, r: &Value) -> Self {
        let modes = Modes {
            current: r.pointer("/modes/currentModeId").and_then(Value::as_str).map(str::to_string),
            available: r
                .pointer("/modes/availableModes")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(|m| {
                            let id = m.get("id")?.as_str()?.to_string();
                            let name = m.get("name").and_then(Value::as_str).unwrap_or(&id).to_string();
                            Some((id, name))
                        })
                        .collect()
                })
                .unwrap_or_default(),
        };
        Session {
            id,
            how,
            config: ConfigOption::parse_list(r.get("configOptions")),
            modes,
            legacy_models: r
                .pointer("/models/availableModels")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(|m| m.get("modelId")?.as_str().map(str::to_string)).collect())
                .unwrap_or_default(),
            legacy_current_model: r.pointer("/models/currentModelId").and_then(Value::as_str).map(str::to_string),
        }
    }

    pub fn current_model(&self) -> Option<String> {
        option_for(&self.config, "model")
            .and_then(|o| o.current.as_str().map(str::to_string))
            .or_else(|| self.legacy_current_model.clone())
    }

    pub fn offers_model(&self, model: &str) -> bool {
        match option_for(&self.config, "model") {
            Some(o) => o.offers(model),
            None => self.legacy_models.iter().any(|m| m == model),
        }
    }

    pub fn offers_mode(&self, mode: &str) -> bool {
        option_for(&self.config, "mode").map(|o| o.offers(mode)).unwrap_or(false)
            || self.modes.available.iter().any(|(id, _)| id == mode)
    }

    pub fn current_mode(&self) -> Option<String> {
        option_for(&self.config, "mode")
            .and_then(|o| o.current.as_str().map(str::to_string))
            .or_else(|| self.modes.current.clone())
    }
}

#[derive(Debug, Clone, Default)]
pub struct OpenRequest {
    pub cwd: String,
    /// Reopen this session id (resume, else load) instead of creating one.
    pub resume: Option<String>,
    pub additional_directories: Vec<String>,
    pub mcp_servers: Vec<Value>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ListedSession {
    pub session_id: String,
    pub cwd: String,
    pub title: Option<String>,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone)]
pub struct PromptOutcome {
    pub stop_reason: String,
    /// Turn token usage when the agent reports it (`PromptResponse.usage`).
    pub usage: Option<Value>,
}

#[derive(Clone)]
pub struct Driver {
    pub conn: Connection,
    pub agent: AgentProfile,
}

impl Driver {
    /// `initialize` and parse the agent's capabilities.
    pub async fn initialize(conn: Connection, info: &ClientInfo, caps: &ClientCaps) -> Result<Driver, AcpError> {
        let result = conn.request(M.initialize, caps.initialize_params(info)).await?;
        let agent = AgentProfile::parse(&result).map_err(AcpError::Protocol)?;
        if agent.protocol_version != PROTOCOL_VERSION {
            return Err(AcpError::Unsupported(format!(
                "Agent speaks ACP version {}, Aura speaks {PROTOCOL_VERSION}",
                agent.protocol_version
            )));
        }
        Ok(Driver { conn, agent })
    }

    fn auth_or(&self, e: RpcError) -> AcpError {
        if e.is_auth_required() {
            AcpError::AuthRequired { methods: self.agent.auth_methods.clone(), detail: e.detail().to_string() }
        } else {
            AcpError::Rpc(e)
        }
    }

    async fn call(&self, method: &str, params: Value) -> Result<Value, AcpError> {
        self.conn.request(method, params).await.map_err(|e| self.auth_or(e))
    }

    /// Protocol-driven sign-in. Never accepts a terminal method; those are
    /// run by the client as a separate interactive process.
    pub async fn authenticate(&self, method_id: &str) -> Result<(), AcpError> {
        match self.agent.auth_method(method_id) {
            None => return Err(AcpError::Unsupported(format!("Agent did not offer sign-in method {method_id}"))),
            Some(m) if m.is_terminal() => {
                return Err(AcpError::Unsupported(format!("{} signs in from a terminal", m.name)))
            }
            Some(_) => {}
        }
        self.conn.request(M.authenticate, json!({"methodId": method_id})).await?;
        Ok(())
    }

    pub async fn logout(&self) -> Result<(), AcpError> {
        if !self.agent.logout {
            return Err(AcpError::Unsupported("Agent does not support logout".into()));
        }
        self.conn.request(M.logout, json!({})).await?;
        Ok(())
    }

    /// Open a session: resume when asked and supported, else load, else new.
    pub async fn open(&self, req: &OpenRequest) -> Result<Session, AcpError> {
        let mut params = json!({"cwd": req.cwd, "mcpServers": req.mcp_servers});
        if self.agent.additional_directories && !req.additional_directories.is_empty() {
            params["additionalDirectories"] = json!(req.additional_directories);
        }
        let Some(id) = req.resume.as_deref().filter(|s| !s.is_empty()) else {
            let r = self.call(M.session_new, params).await?;
            let id = r
                .get("sessionId")
                .and_then(Value::as_str)
                .ok_or_else(|| AcpError::Protocol("session/new returned no sessionId".into()))?
                .to_string();
            return Ok(Session::from_result(id, Opened::New, &r));
        };
        params["sessionId"] = json!(id);
        let (method, how) = if self.agent.resume {
            (M.session_resume, Opened::Resumed)
        } else if self.agent.load_session {
            (M.session_load, Opened::Loaded)
        } else {
            return Err(AcpError::Unsupported("This agent cannot reopen a previous session".into()));
        };
        let r = self.call(method, params).await?;
        Ok(Session::from_result(id.to_string(), how, &r))
    }

    /// `session/list`, following cursors up to `max_pages`.
    pub async fn list(&self, cwd: Option<&str>, max_pages: usize) -> Result<Vec<ListedSession>, AcpError> {
        if !self.agent.list {
            return Err(AcpError::Unsupported("This agent cannot list its sessions".into()));
        }
        let mut out = Vec::new();
        let mut cursor: Option<String> = None;
        for _ in 0..max_pages.max(1) {
            let mut params = json!({});
            if let Some(c) = cwd {
                params["cwd"] = json!(c);
            }
            if let Some(c) = &cursor {
                params["cursor"] = json!(c);
            }
            let r = self.call(M.session_list, params).await?;
            for s in r.get("sessions").and_then(Value::as_array).into_iter().flatten() {
                let Some(id) = s.get("sessionId").and_then(Value::as_str) else { continue };
                out.push(ListedSession {
                    session_id: id.to_string(),
                    cwd: s.get("cwd").and_then(Value::as_str).unwrap_or_default().to_string(),
                    title: s.get("title").and_then(Value::as_str).map(str::to_string),
                    updated_at: s.get("updatedAt").and_then(Value::as_str).map(str::to_string),
                });
            }
            cursor = r.get("nextCursor").and_then(Value::as_str).map(str::to_string);
            if cursor.is_none() {
                break;
            }
        }
        Ok(out)
    }

    pub async fn close(&self, session_id: &str) -> Result<(), AcpError> {
        if !self.agent.close {
            return Err(AcpError::Unsupported("This agent cannot close a session".into()));
        }
        self.call(M.session_close, json!({"sessionId": session_id})).await.map(|_| ())
    }

    pub async fn delete(&self, session_id: &str) -> Result<(), AcpError> {
        if !self.agent.delete {
            return Err(AcpError::Unsupported("This agent cannot delete a session".into()));
        }
        self.call(M.session_delete, json!({"sessionId": session_id})).await.map(|_| ())
    }

    /// `session/set_config_option`. Returns the agent's full new option set.
    pub async fn set_config(&self, session: &mut Session, config_id: &str, value: Value) -> Result<(), AcpError> {
        let mut params = json!({"sessionId": session.id, "configId": config_id, "value": value});
        if value.is_boolean() {
            params["type"] = json!("boolean");
        }
        let r = self.call(M.session_set_config_option, params).await?;
        let next = ConfigOption::parse_list(r.get("configOptions"));
        if !next.is_empty() {
            session.config = next;
        }
        Ok(())
    }

    /// Pick a model: the `model` config option, else the older
    /// `session/set_model` for agents that only report `models`.
    pub async fn select_model(&self, session: &mut Session, model: &str) -> Result<(), AcpError> {
        if !session.offers_model(model) {
            return Err(AcpError::Unsupported(format!("Model {model} is not offered by this agent session")));
        }
        if let Some(id) = option_for(&session.config, "model").map(|o| o.id.clone()) {
            return self.set_config(session, &id, json!(model)).await;
        }
        self.call("session/set_model", json!({"sessionId": session.id, "modelId": model})).await?;
        session.legacy_current_model = Some(model.to_string());
        Ok(())
    }

    /// Pick a mode: the `mode` config option, else `session/set_mode`.
    pub async fn select_mode(&self, session: &mut Session, mode: &str) -> Result<(), AcpError> {
        if let Some(id) = option_for(&session.config, "mode").filter(|o| o.offers(mode)).map(|o| o.id.clone()) {
            return self.set_config(session, &id, json!(mode)).await;
        }
        if !session.modes.available.iter().any(|(id, _)| id == mode) {
            return Err(AcpError::Unsupported(format!("Mode {mode} is not offered by this agent session")));
        }
        self.call(M.session_set_mode, json!({"sessionId": session.id, "modeId": mode})).await?;
        session.modes.current = Some(mode.to_string());
        Ok(())
    }

    /// Run one prompt turn. Resolves when the agent answers the prompt.
    pub async fn prompt(&self, session_id: &str, blocks: Vec<Value>) -> Result<PromptOutcome, AcpError> {
        let r = self.call(M.session_prompt, json!({"sessionId": session_id, "prompt": blocks})).await?;
        Ok(PromptOutcome {
            stop_reason: r.get("stopReason").and_then(Value::as_str).unwrap_or("end_turn").to_string(),
            usage: r.get("usage").cloned().filter(|u| !u.is_null()),
        })
    }

    /// `session/cancel` (a notification). The in-flight prompt still
    /// resolves, with stop reason `cancelled`.
    pub async fn cancel(&self, session_id: &str) -> Result<(), AcpError> {
        self.conn.notify(M.session_cancel, json!({"sessionId": session_id})).await?;
        Ok(())
    }
}

/// Prompt content blocks, gated on what the agent accepts.
pub fn prompt_blocks(agent: &AgentProfile, text: &str, images: &[(String, String)]) -> Result<Vec<Value>, AcpError> {
    let mut blocks = Vec::new();
    if !text.is_empty() {
        blocks.push(json!({"type": "text", "text": text}));
    }
    if !images.is_empty() && !agent.image {
        return Err(AcpError::Unsupported("This agent does not accept images".into()));
    }
    for (mime, data) in images {
        blocks.push(json!({"type": "image", "mimeType": mime, "data": data}));
    }
    Ok(blocks)
}
