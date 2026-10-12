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

use crate::cloud_contract::ExitCode;
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

/// What can go wrong talking to the API.
///
/// The variants are the shapes a caller reacts to differently; the numbers they
/// exit with are [`crate::cloud_contract::ExitCode`]'s, so that every `aura`
/// cloud verb reads the same way from a shell.
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
    /// The code this failure exits with, on the shared contract.
    ///
    /// Note what moved: a refused key used to be `2` and a missing workspace
    /// `3`. Auth is now `3` and not-found is folded into the general runtime
    /// `1`, because a thing that does not exist is not a different *kind* of
    /// problem to a request that was well-formed and still failed. `2` belongs
    /// to usage errors, which clap has already exited with by the time any of
    /// this runs. See [`crate::cloud_contract::ExitCode`].
    pub fn exit_code(&self) -> i32 {
        self.outcome().code()
    }

    /// This failure as a contract outcome.
    pub fn outcome(&self) -> ExitCode {
        match self {
            ApiError::NoAuth | ApiError::Unauthorized { .. } => ExitCode::Auth,
            // A status we were handed gets classified by the shared rule, so a
            // 5xx is reported as the server's fault rather than ours.
            ApiError::Http { status, .. } => ExitCode::for_status(*status),
            ApiError::NotFound { .. } | ApiError::Network(_) | ApiError::Parse(_) => {
                ExitCode::Runtime
            }
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

/// Join query parameters, or nothing at all when there are none.
///
/// A `?` with nothing after it is a legal URL and an unreadable one, and the
/// alternative — each caller deciding whether its own first parameter gets the
/// `?` — is how a second parameter ends up appended with the wrong separator.
pub fn query(parts: Vec<String>) -> String {
    if parts.is_empty() {
        String::new()
    } else {
        format!("?{}", parts.join("&"))
    }
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
    query(parts)
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

    /// The caller's workspaces, newest activity first.
    ///
    /// `limit`/`offset` are passed through only when set, so a caller that
    /// wants a page says so and everyone else keeps the size this endpoint has
    /// always answered with. Both narrowings — the status and the window — are
    /// the server's to apply, in that order: a filter applied after a cap
    /// answers about the page instead of about the list.
    pub fn list(
        &self,
        status: Option<&str>,
        limit: Option<i64>,
        offset: Option<i64>,
    ) -> Result<Value, ApiError> {
        let mut parts = Vec::new();
        if let Some(s) = status.map(str::trim).filter(|s| !s.is_empty()) {
            parts.push(format!("status={}", url_encode(s)));
        }
        parts.extend(Self::page_parts(limit, offset));
        let q = query(parts);
        self.send(self.http.get(format!("{}{}", self.url("/workspaces"), q)))
    }

    pub fn get(&self, id: &str) -> Result<Value, ApiError> {
        self.send(self.http.get(self.url(&format!("/workspaces/{}", url_encode(id)))))
    }

    /// Send a prompt. Same send as [`Client::create_message`] behind a thinner
    /// answer — the server runs one path for both — so `message_id` means the
    /// same thing here: a retry with a key already used queues nothing.
    pub fn prompt(
        &self,
        id: &str,
        text: &str,
        model: Option<&str>,
        message_id: Option<&str>,
    ) -> Result<Value, ApiError> {
        let mut body = json!({ "text": text });
        if let Some(m) = model.map(str::trim).filter(|m| !m.is_empty()) {
            body["model"] = json!(m);
        }
        if let Some(k) = message_id.map(str::trim).filter(|k| !k.is_empty()) {
            body["message_id"] = json!(k);
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

    // ─── Sections ───────────────────────────────────────────────────────────
    //
    // Sidebar sections, so an agent can file the workspaces it opened instead
    // of leaving a sidebar only the user can tidy. They are personal to the
    // account behind the token, which is why there is no org-wide listing.

    pub fn sections(&self) -> Result<Value, ApiError> {
        self.send(self.http.get(self.url("/sections")))
    }

    /// Create a section. The server treats this as an upsert on the name, so a
    /// retry after a timeout returns the section that already exists rather
    /// than a second one with the same label.
    pub fn create_section(
        &self,
        name: &str,
        emoji: Option<&str>,
        position: Option<i32>,
    ) -> Result<Value, ApiError> {
        let mut body = json!({ "name": name });
        if let Some(e) = emoji.map(str::trim).filter(|e| !e.is_empty()) {
            body["emoji"] = json!(e);
        }
        if let Some(p) = position {
            body["position"] = json!(p);
        }
        self.send(self.http.post(self.url("/sections")).json(&body))
    }

    pub fn delete_section(&self, id: &str) -> Result<Value, ApiError> {
        self.send(self.http.delete(self.url(&format!("/sections/{}", url_encode(id)))))
    }

    /// File a workspace in a section, or unfile it with `None`.
    ///
    /// One call for both, because `--section <id>` and `--no-section` are the
    /// same decision with different answers: a separate unfile endpoint would
    /// let a caller send both and leave the winner to request ordering.
    pub fn move_workspace(&self, id: &str, section: Option<&str>) -> Result<Value, ApiError> {
        let body = json!({ "section_id": section });
        self.send(
            self.http
                .post(self.url(&format!("/workspaces/{}/move", url_encode(id))))
                .json(&body),
        )
    }

    /// Rename a workspace. The server trims and bounds the name; this does
    /// not pre-check, because the server is the authority for every other
    /// client too and two copies of the rule drift.
    pub fn rename(&self, id: &str, name: &str) -> Result<Value, ApiError> {
        self.send(
            self.http
                .post(self.url(&format!("/workspaces/{}/rename", url_encode(id))))
                .json(&json!({ "name": name })),
        )
    }

    /// Whose turn it is. A read — safe to poll.
    pub fn status(&self, id: &str) -> Result<Value, ApiError> {
        self.send(
            self.http
                .get(self.url(&format!("/workspaces/{}/status", url_encode(id)))),
        )
    }

    // ─── Projects ───────────────────────────────────────────────────────────
    //
    // Reads only. A project is created by opening a workspace in it.

    /// The `limit`/`offset` pair of a query, leaving out what the caller did
    /// not set so the server's own defaults apply rather than this client's
    /// guess at them.
    ///
    /// Returned as parts rather than as a string because `?status=` has to
    /// compose with it, and a function that returns a leading `?` can only
    /// ever be the first thing in a query.
    fn page_parts(limit: Option<i64>, offset: Option<i64>) -> Vec<String> {
        let mut parts = Vec::new();
        if let Some(n) = limit {
            parts.push(format!("limit={n}"));
        }
        if let Some(n) = offset {
            parts.push(format!("offset={n}"));
        }
        parts
    }

    pub fn projects(&self, limit: Option<i64>, offset: Option<i64>) -> Result<Value, ApiError> {
        let q = query(Self::page_parts(limit, offset));
        self.send(self.http.get(format!("{}{}", self.url("/projects"), q)))
    }

    /// One project, by uuid or by `owner/name`. The name contains a slash, so
    /// it is encoded — without that it would split the path and 404.
    pub fn project(&self, id: &str) -> Result<Value, ApiError> {
        self.send(self.http.get(self.url(&format!("/projects/{}", url_encode(id)))))
    }

    pub fn project_workspaces(
        &self,
        id: &str,
        status: Option<&str>,
        limit: Option<i64>,
        offset: Option<i64>,
    ) -> Result<Value, ApiError> {
        let mut parts = Vec::new();
        if let Some(s) = status.map(str::trim).filter(|s| !s.is_empty()) {
            parts.push(format!("status={}", url_encode(s)));
        }
        parts.extend(Self::page_parts(limit, offset));
        let q = query(parts);
        let path = format!("/projects/{}/workspaces", url_encode(id));
        self.send(self.http.get(format!("{}{}", self.url(&path), q)))
    }

    // ─── Messages ───────────────────────────────────────────────────────────
    //
    // `prompt` above is the same send with a thinner answer. These exist so a
    // caller can carry an idempotency key and read a message back by id — the
    // two things a retrying script needs and a person does not.

    /// Send a message. `message_id` is the caller's own key: send the same one
    /// twice and the first message comes back with `duplicate: true` instead of
    /// a second being created.
    pub fn create_message(
        &self,
        workspace: &str,
        text: &str,
        model: Option<&str>,
        message_id: Option<&str>,
    ) -> Result<Value, ApiError> {
        let mut body = json!({ "text": text });
        if let Some(m) = model.map(str::trim).filter(|m| !m.is_empty()) {
            body["model"] = json!(m);
        }
        if let Some(k) = message_id.map(str::trim).filter(|k| !k.is_empty()) {
            body["message_id"] = json!(k);
        }
        self.send(
            self.http
                .post(self.url(&format!("/workspaces/{}/messages", url_encode(workspace))))
                .json(&body),
        )
    }

    /// Read one message back. Hangs off `/messages/{id}` rather than off the
    /// workspace, because the id a send returns is all a caller kept.
    pub fn message(&self, id: &str) -> Result<Value, ApiError> {
        self.send(self.http.get(self.url(&format!("/messages/{}", url_encode(id)))))
    }

    // ─── Routines ───────────────────────────────────────────────────────────

    pub fn routines(&self) -> Result<Value, ApiError> {
        self.send(self.http.get(self.url("/routines")))
    }

    pub fn routine(&self, id: &str) -> Result<Value, ApiError> {
        self.send(self.http.get(self.url(&format!("/routines/{}", url_encode(id)))))
    }

    /// Create a routine. `triggers` arrive already parsed into the
    /// `{ kind, config }` pairs the server validates — the mini-syntax
    /// (`weekdays@09:00`) is a CLI convenience and the server has never heard
    /// of it, so the translation happens before the request and its errors are
    /// usage errors rather than 400s.
    ///
    /// Not an upsert, unlike `create_section`: a routine that silently
    /// replaced one of the same name would silently replace its webhook
    /// secret too, and break a delivery somebody else configured.
    #[allow(clippy::too_many_arguments)]
    pub fn create_routine(
        &self,
        name: &str,
        repo: Option<&str>,
        agent: Option<&str>,
        model: Option<&str>,
        effort: Option<&str>,
        prompt: &str,
        enabled: bool,
        triggers: &[Value],
    ) -> Result<Value, ApiError> {
        let mut body = json!({
            "name": name,
            "prompt": prompt,
            "enabled": enabled,
            "triggers": triggers,
        });
        for (key, value) in [
            ("repo", repo),
            ("agent", agent),
            ("model", model),
            ("effort", effort),
        ] {
            if let Some(v) = value.map(str::trim).filter(|v| !v.is_empty()) {
                body[key] = json!(v);
            }
        }
        self.send(self.http.post(self.url("/routines")).json(&body))
    }

    pub fn delete_routine(&self, id: &str) -> Result<Value, ApiError> {
        self.send(self.http.delete(self.url(&format!("/routines/{}", url_encode(id)))))
    }

    /// Mint a new webhook secret. The old URL stops working immediately, and
    /// the reply is the only place the new one is readable.
    pub fn rotate_routine_secret(&self, id: &str) -> Result<Value, ApiError> {
        self.send(self.http.post(self.url(&format!(
            "/routines/{}/rotate-secret",
            url_encode(id)
        ))))
    }

    /// Fire a routine now, without waiting for its schedule. Runs even a
    /// disabled one: switching a routine off stops its triggers, not its
    /// owner.
    pub fn run_routine(&self, id: &str) -> Result<Value, ApiError> {
        self.send(
            self.http
                .post(self.url(&format!("/routines/{}/run", url_encode(id)))),
        )
    }

    pub fn whoami(&self) -> Result<Value, ApiError> {
        self.send(self.http.get(self.url("/whoami")))
    }

    /// `whoami`, plus the two facts the server cannot report: which credential
    /// this process picked up, and which cloud answered.
    ///
    /// Both are the difference between "the key is wrong" and "you are asking
    /// the wrong server", which is the first thing anyone wants to know when a
    /// call is refused. Shared so that `aura workspace whoami` and `aura auth
    /// status` cannot describe the same machine differently.
    pub fn whoami_described(&self) -> Result<Value, ApiError> {
        let mut v = self.whoami()?;
        if let Value::Object(m) = &mut v {
            m.insert(
                "token_source".into(),
                Value::String(self.auth.source.label().into()),
            );
            m.insert("origin".into(), Value::String(self.auth.origin.clone()));
        }
        Ok(v)
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
