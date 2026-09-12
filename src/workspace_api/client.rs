//! HTTP client for `/api/v2/public/*`.
//!
//! Auth resolution, in order:
//!
//!   1. `AURA_API_KEY` — an org API key (`aura_ak_…`) or a human token, set
//!      by whoever provisioned the agent. Wins unconditionally: an agent given
//!      a key is meant to act as that key.
//!   2. `AURA_CLOUD_TOKEN` / the signed-in `cloud_api_token`, under the rule
//!      `crate::cloud_endpoint` already enforces — the signed-in token is
//!      never sent to a cloud named by `AURA_CLOUD_URL`.
//!
//! Base URL: `AURA_CLOUD_URL`, else the configured `cloud_url`, else the
//! public API host. Nothing here sends `x-aura-org`: no other CLI client does,
//! a key or token is minted against one org already, and naming a different
//! one is refused server-side.

use std::time::Duration;

use serde_json::{json, Value};

use crate::config::ConfigManager;

/// The env var an agent is handed its key in.
pub const API_KEY_ENV: &str = "AURA_API_KEY";
/// The public host reached when nothing else is configured.
pub const DEFAULT_ORIGIN: &str = "https://api.auravcs.com";
/// Every endpoint lives under this prefix.
pub const API_PREFIX: &str = "/api/v2/public";

/// Where a bearer came from — shown by `whoami` so a wrong key is diagnosable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TokenSource {
    ApiKeyEnv,
    CloudTokenEnv,
    SignedIn,
}

impl TokenSource {
    pub fn label(self) -> &'static str {
        match self {
            TokenSource::ApiKeyEnv => "AURA_API_KEY",
            TokenSource::CloudTokenEnv => "AURA_CLOUD_TOKEN",
            TokenSource::SignedIn => "signed-in token (aura connect)",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Auth {
    pub origin: String,
    pub token: String,
    pub source: TokenSource,
}

/// What can go wrong talking to the API, shaped for exit codes:
/// `0` ok, `2` no credentials, `3` not found, `1` everything else.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApiError {
    /// No bearer could be resolved.
    NoAuth,
    /// The server refused the bearer (401/403).
    Unauthorized { status: u16, body: String },
    /// The workspace (or repo) does not exist for this caller (404).
    NotFound { body: String },
    /// Any other non-2xx.
    Http { status: u16, body: String },
    /// Could not reach the server.
    Network(String),
    /// The body was not JSON.
    Parse(String),
}

impl ApiError {
    pub fn exit_code(&self) -> i32 {
        match self {
            ApiError::NoAuth | ApiError::Unauthorized { .. } => 2,
            ApiError::NotFound { .. } => 3,
            ApiError::Http { .. } | ApiError::Network(_) | ApiError::Parse(_) => 1,
        }
    }

    /// One line for a human. The server's `{ "error": … }` is unwrapped when
    /// it is there, so the reason reads as a sentence and not as JSON.
    pub fn message(&self) -> String {
        let reason = |body: &str| {
            serde_json::from_str::<Value>(body)
                .ok()
                .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(str::to_string))
                .unwrap_or_else(|| body.trim().to_string())
        };
        match self {
            ApiError::NoAuth => format!(
                "no credentials — set {API_KEY_ENV} to an Aura API key, or run `aura connect`"
            ),
            ApiError::Unauthorized { status, body } => {
                let r = reason(body);
                if r.is_empty() {
                    format!("HTTP {status}: the server refused this key")
                } else {
                    format!("HTTP {status}: {r}")
                }
            }
            ApiError::NotFound { body } => {
                let r = reason(body);
                if r.is_empty() {
                    "not found".to_string()
                } else {
                    r
                }
            }
            ApiError::Http { status, body } => {
                let r = reason(body);
                if r.is_empty() {
                    format!("HTTP {status}")
                } else {
                    format!("HTTP {status}: {r}")
                }
            }
            ApiError::Network(e) => format!("network: {e}"),
            ApiError::Parse(e) => format!("unexpected response: {e}"),
        }
    }
}

/// Resolve auth from an explicit environment reader — pure, so the order is
/// testable without touching the process environment. `config_url` and
/// `config_token` are the signed-in values from `AuraConfig`.
pub fn resolve_auth_with(
    env: &dyn Fn(&str) -> Option<String>,
    config_url: Option<&str>,
    config_token: Option<&str>,
) -> Result<Auth, ApiError> {
    let clean = |v: Option<String>| v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());

    let origin = clean(env(crate::cloud_endpoint::URL_ENV))
        .or_else(|| clean(config_url.map(str::to_string)))
        .unwrap_or_else(|| DEFAULT_ORIGIN.to_string())
        .trim_end_matches('/')
        .to_string();

    if let Some(key) = clean(env(API_KEY_ENV)) {
        return Ok(Auth {
            origin,
            token: key,
            source: TokenSource::ApiKeyEnv,
        });
    }
    if let Some(explicit) = clean(env(crate::cloud_endpoint::TOKEN_ENV)) {
        return Ok(Auth {
            origin,
            token: explicit,
            source: TokenSource::CloudTokenEnv,
        });
    }
    // The signed-in token follows the signed-in URL only — never a URL the
    // environment named. Same contract as `cloud_endpoint::token`.
    if clean(env(crate::cloud_endpoint::URL_ENV)).is_some() {
        return Err(ApiError::NoAuth);
    }
    match clean(config_token.map(str::to_string)) {
        Some(token) => Ok(Auth {
            origin,
            token,
            source: TokenSource::SignedIn,
        }),
        None => Err(ApiError::NoAuth),
    }
}

/// Resolve auth from the real environment and the saved config.
pub fn resolve_auth() -> Result<Auth, ApiError> {
    let cfg = ConfigManager::load();
    resolve_auth_with(
        &|name| std::env::var(name).ok(),
        cfg.cloud_url.as_deref(),
        cfg.cloud_api_token.as_deref(),
    )
}

/// `{origin}/api/v2/public{path}` — `path` starts with `/`.
pub fn endpoint(origin: &str, path: &str) -> String {
    format!("{}{}{}", origin.trim_end_matches('/'), API_PREFIX, path)
}

/// Build the query string for `messages`, omitting what was not asked for.
pub fn messages_query(since: Option<&str>, limit: Option<u32>) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(s) = since.map(str::trim).filter(|s| !s.is_empty()) {
        parts.push(format!("since={}", url_encode(s)));
    }
    if let Some(l) = limit {
        parts.push(format!("limit={l}"));
    }
    if parts.is_empty() {
        String::new()
    } else {
        format!("?{}", parts.join("&"))
    }
}

/// Minimal percent-encoding for a query value (RFC3339 timestamps carry `+`
/// and `:`, and `+` in a query is a space unless escaped).
pub fn url_encode(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for b in raw.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

/// What `create` sends. Every field but `repo` is optional server-side too.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CreateRequest {
    pub repo: Option<String>,
    pub branch: Option<String>,
    pub title: Option<String>,
    pub intent: Option<String>,
    pub intent_type: Option<String>,
    pub agent: Option<String>,
    pub prompt: Option<String>,
    pub model: Option<String>,
}

impl CreateRequest {
    /// The JSON body — only the fields that were given, so the server's
    /// defaults apply to the rest.
    pub fn body(&self) -> Value {
        let mut m = serde_json::Map::new();
        let mut put = |k: &str, v: &Option<String>| {
            if let Some(s) = v.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                m.insert(k.to_string(), json!(s));
            }
        };
        put("repo", &self.repo);
        put("branch", &self.branch);
        put("objective", &self.title);
        put("intent", &self.intent);
        put("intent_type", &self.intent_type);
        put("agent", &self.agent);
        put("prompt", &self.prompt);
        put("model", &self.model);
        Value::Object(m)
    }
}

/// The client. One per command; cheap to build.
pub struct Client {
    auth: Auth,
    http: reqwest::blocking::Client,
}

impl Client {
    pub fn new(auth: Auth) -> Result<Self, ApiError> {
        let cfg = ConfigManager::load();
        let mut builder = reqwest::blocking::Client::builder().timeout(Duration::from_secs(30));
        if cfg.accept_self_signed {
            builder = builder.danger_accept_invalid_certs(true);
        }
        let http = builder
            .build()
            .map_err(|e| ApiError::Network(format!("http client: {e}")))?;
        Ok(Self { auth, http })
    }

    /// Resolve credentials and build — the one-liner every verb starts with.
    pub fn from_env() -> Result<Self, ApiError> {
        Self::new(resolve_auth()?)
    }

    pub fn auth(&self) -> &Auth {
        &self.auth
    }

    fn url(&self, path: &str) -> String {
        endpoint(&self.auth.origin, path)
    }

    fn send(&self, req: reqwest::blocking::RequestBuilder) -> Result<Value, ApiError> {
        let resp = req
            .header("Authorization", format!("Bearer {}", self.auth.token))
            .header("Accept", "application/json")
            .send()
            .map_err(|e| ApiError::Network(e.to_string()))?;
        let status = resp.status().as_u16();
        let body = resp
            .text()
            .map_err(|e| ApiError::Network(e.to_string()))?;
        classify(status, body)
    }

    pub fn create(&self, req: &CreateRequest) -> Result<Value, ApiError> {
        self.send(self.http.post(self.url("/workspaces")).json(&req.body()))
    }

    pub fn list(&self, status: Option<&str>) -> Result<Value, ApiError> {
        let q = match status.map(str::trim).filter(|s| !s.is_empty()) {
            Some(s) => format!("?status={}", url_encode(s)),
            None => String::new(),
        };
        self.send(self.http.get(format!("{}{}", self.url("/workspaces"), q)))
    }

    pub fn get(&self, id: &str) -> Result<Value, ApiError> {
        self.send(self.http.get(self.url(&format!("/workspaces/{}", url_encode(id)))))
    }

    pub fn prompt(&self, id: &str, text: &str, model: Option<&str>) -> Result<Value, ApiError> {
        let mut body = json!({ "text": text });
        if let Some(m) = model.map(str::trim).filter(|m| !m.is_empty()) {
            body["model"] = json!(m);
        }
        self.send(
            self.http
                .post(self.url(&format!("/workspaces/{}/prompt", url_encode(id))))
                .json(&body),
        )
    }

    pub fn messages(&self, id: &str, since: Option<&str>, limit: Option<u32>) -> Result<Value, ApiError> {
        let path = format!("/workspaces/{}/messages{}", url_encode(id), messages_query(since, limit));
        self.send(self.http.get(self.url(&path)))
    }

    pub fn sleep(&self, id: &str) -> Result<Value, ApiError> {
        self.send(self.http.post(self.url(&format!("/workspaces/{}/sleep", url_encode(id)))))
    }

    pub fn archive(&self, id: &str) -> Result<Value, ApiError> {
        self.send(self.http.post(self.url(&format!("/workspaces/{}/archive", url_encode(id)))))
    }

    pub fn models(&self) -> Result<Value, ApiError> {
        self.send(self.http.get(self.url("/models")))
    }

    pub fn whoami(&self) -> Result<Value, ApiError> {
        self.send(self.http.get(self.url("/whoami")))
    }
}

/// Turn a status + body into the typed result. Pure, so the exit-code
/// mapping is testable without a server.
pub fn classify(status: u16, body: String) -> Result<Value, ApiError> {
    match status {
        200..=299 => {
            if body.trim().is_empty() {
                return Ok(Value::Null);
            }
            serde_json::from_str(&body).map_err(|e| ApiError::Parse(e.to_string()))
        }
        401 | 403 => Err(ApiError::Unauthorized { status, body }),
        404 => Err(ApiError::NotFound { body }),
        _ => Err(ApiError::Http { status, body }),
    }
}

/// The newest `created_at` in a message page — the cursor to poll from next.
pub fn latest_cursor(messages: &Value) -> Option<String> {
    messages
        .as_array()?
        .iter()
        .filter_map(|m| m.get("created_at").and_then(|c| c.as_str()))
        .max()
        .map(str::to_string)
}

/// True when the page holds a turn that is not the caller's own prompt —
/// the thing `messages --wait` is waiting for.
pub fn has_reply(messages: &Value) -> bool {
    messages
        .as_array()
        .map(|rows| {
            rows.iter().any(|m| {
                m.get("role")
                    .and_then(|r| r.as_str())
                    .map(|r| r != "user")
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}
