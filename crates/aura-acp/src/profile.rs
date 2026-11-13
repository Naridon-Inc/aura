//! What a client says about itself in `initialize`, and what the agent
//! answers. The agent's answer is parsed with the ACP schema's own types so
//! capability defaults follow the spec exactly.

use agent_client_protocol_schema::v1 as schema;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;

pub const PROTOCOL_VERSION: u64 = 1;

#[derive(Debug, Clone)]
pub struct ClientInfo {
    pub name: String,
    pub title: String,
    pub version: String,
}

impl ClientInfo {
    pub fn aura(version: &str) -> Self {
        Self { name: "aura".into(), title: "Aura".into(), version: version.into() }
    }
}

/// Client capabilities. Only advertise what the caller really serves: an
/// agent that sees `fs.writeTextFile` will route its edits through us.
#[derive(Debug, Clone, Default)]
pub struct ClientCaps {
    pub fs_read: bool,
    pub fs_write: bool,
    pub terminal: bool,
    /// We can re-run the agent program interactively for terminal auth.
    pub terminal_auth: bool,
    pub elicitation_form: bool,
    pub elicitation_url: bool,
}

impl ClientCaps {
    pub fn to_value(&self) -> Value {
        let mut caps = json!({
            "fs": {"readTextFile": self.fs_read, "writeTextFile": self.fs_write},
            "terminal": self.terminal,
        });
        if self.terminal_auth {
            caps["auth"] = json!({"terminal": true});
        }
        if self.elicitation_form || self.elicitation_url {
            let mut e = json!({});
            if self.elicitation_form {
                e["form"] = json!({});
            }
            if self.elicitation_url {
                e["url"] = json!({});
            }
            caps["elicitation"] = e;
        }
        caps
    }

    pub fn initialize_params(&self, info: &ClientInfo) -> Value {
        json!({
            "protocolVersion": PROTOCOL_VERSION,
            "clientCapabilities": self.to_value(),
            "clientInfo": {"name": info.name, "title": info.title, "version": info.version},
        })
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AuthKind {
    /// The agent runs its own flow when the client calls `authenticate`.
    Agent,
    /// The client re-runs the agent program with `args`/`env` in a terminal.
    Terminal { args: Vec<String>, env: BTreeMap<String, String> },
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AuthMethod {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    #[serde(flatten)]
    pub kind: AuthKind,
}

impl AuthMethod {
    pub fn is_terminal(&self) -> bool {
        matches!(self.kind, AuthKind::Terminal { .. })
    }
}

/// Env names a terminal-auth descriptor may not set without the user's
/// approval (program lookup, dynamic loading, interpreter startup, proxy and
/// TLS trust), per the spec's launch-safety rules.
pub fn is_unsafe_auth_env(name: &str) -> bool {
    let n = name.to_ascii_uppercase();
    const EXACT: &[&str] = &[
        "PATH", "NODE_OPTIONS", "NODE_PATH", "PYTHONPATH", "PYTHONSTARTUP", "BASH_ENV", "ENV", "ZDOTDIR",
        "HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR",
        "NODE_EXTRA_CA_CERTS", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE", "PERL5LIB", "RUBYLIB", "RUBYOPT",
    ];
    EXACT.contains(&n.as_str()) || n.starts_with("LD_") || n.starts_with("DYLD_")
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct AgentProfile {
    pub protocol_version: u64,
    pub name: Option<String>,
    pub title: Option<String>,
    pub version: Option<String>,
    pub load_session: bool,
    pub image: bool,
    pub audio: bool,
    pub embedded_context: bool,
    pub list: bool,
    pub resume: bool,
    pub close: bool,
    pub delete: bool,
    pub additional_directories: bool,
    pub logout: bool,
    pub auth_methods: Vec<AuthMethod>,
}

fn id_string<T: Serialize>(v: &T) -> String {
    match serde_json::to_value(v) {
        Ok(Value::String(s)) => s,
        Ok(other) => other.to_string(),
        Err(_) => String::new(),
    }
}

impl AgentProfile {
    /// Parse an `initialize` result. Errors only when the body is not an
    /// initialize response at all; unknown or malformed optional fields fall
    /// back to the spec defaults.
    pub fn parse(result: &Value) -> Result<Self, String> {
        let typed: schema::InitializeResponse =
            serde_json::from_value(result.clone()).map_err(|e| format!("not an ACP initialize response: {e}"))?;
        let caps = &typed.agent_capabilities;
        let session = &caps.session_capabilities;
        let auth_methods = typed
            .auth_methods
            .iter()
            .filter_map(|m| match m {
                schema::AuthMethod::Agent(a) => Some(AuthMethod {
                    id: id_string(&a.id),
                    name: a.name.clone(),
                    description: a.description.clone(),
                    kind: AuthKind::Agent,
                }),
                schema::AuthMethod::Terminal(t) => Some(AuthMethod {
                    id: id_string(&t.id),
                    name: t.name.clone(),
                    description: t.description.clone(),
                    kind: AuthKind::Terminal {
                        args: t.args.clone(),
                        env: t.env.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
                    },
                }),
                _ => None,
            })
            .collect();
        Ok(Self {
            protocol_version: result.get("protocolVersion").and_then(Value::as_u64).unwrap_or(0),
            name: typed.agent_info.as_ref().map(|i| i.name.clone()),
            title: typed.agent_info.as_ref().and_then(|i| i.title.clone()),
            version: typed.agent_info.as_ref().map(|i| i.version.clone()),
            load_session: caps.load_session,
            image: caps.prompt_capabilities.image,
            audio: caps.prompt_capabilities.audio,
            embedded_context: caps.prompt_capabilities.embedded_context,
            list: session.list.is_some(),
            resume: session.resume.is_some(),
            close: session.close.is_some(),
            delete: session.delete.is_some(),
            additional_directories: session.additional_directories.is_some(),
            logout: caps.auth.logout.is_some(),
            auth_methods,
        })
    }

    pub fn can_reopen(&self) -> bool {
        self.resume || self.load_session
    }

    pub fn auth_method(&self, id: &str) -> Option<&AuthMethod> {
        self.auth_methods.iter().find(|m| m.id == id)
    }
}

/// One session config option (`configOptions[]`): model, mode, thought
/// level, or an agent-specific select/boolean.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ConfigOption {
    pub id: String,
    pub name: String,
    pub category: Option<String>,
    /// `select` or `boolean`.
    pub kind: String,
    pub current: Value,
    pub choices: Vec<ConfigChoice>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ConfigChoice {
    pub value: String,
    pub name: String,
    pub description: Option<String>,
    pub group: Option<String>,
}

impl ConfigOption {
    pub fn parse_list(v: Option<&Value>) -> Vec<ConfigOption> {
        v.and_then(Value::as_array).map(|a| a.iter().filter_map(Self::parse).collect()).unwrap_or_default()
    }

    pub fn parse(v: &Value) -> Option<ConfigOption> {
        let id = v.get("id")?.as_str()?.to_string();
        let mut choices = Vec::new();
        for o in v.get("options").and_then(Value::as_array).into_iter().flatten() {
            // Grouped selects nest their choices one level down.
            if let Some(group) = o.get("options").and_then(Value::as_array) {
                let gname = o.get("name").and_then(Value::as_str).map(str::to_string);
                choices.extend(group.iter().filter_map(|c| ConfigChoice::parse(c, gname.clone())));
            } else if let Some(c) = ConfigChoice::parse(o, None) {
                choices.push(c);
            }
        }
        Some(ConfigOption {
            name: v.get("name").and_then(Value::as_str).unwrap_or(&id).to_string(),
            id,
            category: v.get("category").and_then(Value::as_str).map(str::to_string),
            kind: v.get("type").and_then(Value::as_str).unwrap_or("select").to_string(),
            current: v.get("currentValue").cloned().unwrap_or(Value::Null),
            choices,
        })
    }

    pub fn offers(&self, value: &str) -> bool {
        self.choices.iter().any(|c| c.value == value)
    }
}

impl ConfigChoice {
    fn parse(v: &Value, group: Option<String>) -> Option<ConfigChoice> {
        let value = v.get("value")?.as_str()?.to_string();
        Some(ConfigChoice {
            name: v.get("name").and_then(Value::as_str).unwrap_or(&value).to_string(),
            value,
            description: v.get("description").and_then(Value::as_str).map(str::to_string),
            group,
        })
    }
}

/// Find the option for a category (`model`, `mode`, `thought_level`), by
/// category first and by the conventional id second.
pub fn option_for<'a>(options: &'a [ConfigOption], category: &str) -> Option<&'a ConfigOption> {
    options
        .iter()
        .find(|o| o.category.as_deref() == Some(category))
        .or_else(|| options.iter().find(|o| o.id == category))
}
