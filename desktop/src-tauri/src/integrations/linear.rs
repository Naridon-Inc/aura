//! Linear OAuth 2.0 adapter.
//!
//! Spec reference: <https://developers.linear.app/docs/oauth/authentication>
//!
//! Shape differences from the Jira (Atlassian 3LO) adapter next door:
//!  - Authorize/token live on Linear's own hosts, and the token endpoint
//!    expects a **form-encoded** body (`application/x-www-form-urlencoded`),
//!    not JSON.
//!  - Scopes are **comma-separated** on the authorize URL, not space-joined.
//!  - There is no "accessible resources" step — a Linear token is bound to
//!    exactly one workspace, so identity is a single GraphQL `viewer` probe.
//!  - Linear access tokens are long-lived (years) and Linear does **not**
//!    return a refresh token, so there is no `refresh()` here; a lapsed
//!    token simply prompts a reconnect.
//!
//! What we reuse from the Jira adapter's approach: the loopback listener +
//! cryptographic `state` nonce for CSRF, the `ProviderTokens` shape, and the
//! keychain JSON discipline (via `super::tokens`), so the renderer-visible
//! token lifecycle stays identical across providers. PKCE is not sent —
//! Linear's authorization-code grant is a confidential client (the
//! `client_secret` lives on disk) and `state` gives the CSRF protection.

use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::{
    extract::{Query, State},
    response::Html,
    routing::get,
    Router,
};
use base64::Engine;
use rand::RngCore;
use serde::Deserialize;
use tokio::net::TcpListener;
use tokio::sync::{oneshot, Mutex};
use tokio::task::JoinHandle;

use super::config::LinearConfig;
use super::types::{ExternalIdentity, IntegrationError, ProviderTokens};

const AUTHORIZE_URL: &str = "https://linear.app/oauth/authorize";
const TOKEN_URL: &str = "https://api.linear.app/oauth/token";
const GRAPHQL_URL: &str = "https://api.linear.app/graphql";

/// Default HTTP timeout for every Linear call — short enough that a wedged
/// response can't hang the settings spinner for minutes.
const HTTP_TIMEOUT_SECS: u64 = 20;

/// Outcome handed back to the renderer after a successful connect: tokens
/// (already persisted) plus the workspace identity for "Connected as X".
/// No `sites` field — Linear is single-workspace per token.
#[derive(Debug, Clone)]
pub struct LinearConnectOutcome {
    pub tokens: ProviderTokens,
    pub identity: ExternalIdentity,
}

/// Handle returned by `start_auth` — the renderer opens `authorize_url`
/// in the browser and awaits `completion`. `cancel` aborts the flow
/// (releases the loopback port) when the user bails or a fresh connect
/// attempt needs to evict a stale listener.
pub struct LinearAuthFlow {
    pub authorize_url: String,
    pub completion: JoinHandle<Result<LinearConnectOutcome, IntegrationError>>,
    pub cancel: oneshot::Sender<()>,
}

#[derive(Clone)]
struct CallbackState {
    expected_state: String,
    sender: Arc<Mutex<Option<oneshot::Sender<Result<CallbackParams, IntegrationError>>>>>,
}

#[derive(Debug, Deserialize)]
struct CallbackParams {
    #[serde(default)]
    code: Option<String>,
    #[serde(default)]
    state: Option<String>,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    error_description: Option<String>,
}

/// Kick off the OAuth flow. Binds the loopback listener on the port from
/// `cfg.redirect_uri`, builds the authorize URL, and returns immediately.
/// The renderer opens the URL and awaits `completion`, which:
///   1. waits for the callback (5-min timeout)
///   2. exchanges code → tokens (form-encoded)
///   3. probes the GraphQL `viewer` for identity
///   4. persists tokens to the keychain
pub async fn start_auth(cfg: &LinearConfig) -> Result<LinearAuthFlow, IntegrationError> {
    // Linear's authorization-code grant needs the client secret. The config
    // models it as Option purely for schema tolerance — fail clearly here
    // rather than send a request Linear will reject.
    let client_secret = cfg.client_secret.clone().filter(|s| !s.trim().is_empty()).ok_or_else(|| {
        IntegrationError::NotConfigured(
            "missing client_secret in [linear] block of ~/.aura/integrations.toml — \
             copy it from your Linear OAuth application"
                .into(),
        )
    })?;

    let port = cfg.loopback_port()?;
    // Bind BEFORE returning the URL so a port collision fails fast with a
    // clear message instead of a half-completed browser tab.
    let listener = TcpListener::bind(("127.0.0.1", port)).await.map_err(|e| {
        IntegrationError::OAuth(format!(
            "bind 127.0.0.1:{port}: {e}. \
             Another process may be using this port — change `redirect_uri` \
             in ~/.aura/integrations.toml AND on your Linear OAuth application."
        ))
    })?;

    let state_nonce = gen_state();
    let mut authorize_url = url::Url::parse(AUTHORIZE_URL)?;
    {
        let mut q = authorize_url.query_pairs_mut();
        q.append_pair("client_id", &cfg.client_id);
        q.append_pair("redirect_uri", &cfg.redirect_uri);
        q.append_pair("response_type", "code");
        // Linear expects a comma-separated scope list, unlike the OAuth
        // default of space-separated.
        q.append_pair("scope", &cfg.scopes.join(","));
        q.append_pair("state", &state_nonce);
        // Force the consent screen so a re-connect always yields a fresh
        // grant rather than silently reusing an old approval.
        q.append_pair("prompt", "consent");
        // Act as the signed-in user (the default) so created/updated issues
        // are attributed to a real person, not the application actor.
        q.append_pair("actor", "user");
    }

    let (tx, rx) = oneshot::channel::<Result<CallbackParams, IntegrationError>>();
    let (cancel_tx, cancel_rx) = oneshot::channel::<()>();
    let cb_state = CallbackState {
        expected_state: state_nonce.clone(),
        sender: Arc::new(Mutex::new(Some(tx))),
    };
    let router = Router::new()
        .route("/callback", get(callback_handler))
        .with_state(cb_state);
    let listener_task = tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });

    let cfg = cfg.clone();
    let completion = tokio::spawn(async move {
        // Race three outcomes: the user completes (rx), the caller cancels
        // (cancel_rx), or the 5-minute upper bound trips so a wedged listener
        // can't sit on the port.
        let params = tokio::select! {
            res = rx => match res {
                Ok(Ok(p)) => p,
                Ok(Err(e)) => {
                    listener_task.abort();
                    return Err(e);
                }
                Err(_) => {
                    listener_task.abort();
                    return Err(IntegrationError::OAuth(
                        "callback channel closed unexpectedly".into(),
                    ));
                }
            },
            _ = cancel_rx => {
                listener_task.abort();
                return Err(IntegrationError::OAuth("connect cancelled".into()));
            }
            _ = tokio::time::sleep(Duration::from_secs(300)) => {
                listener_task.abort();
                return Err(IntegrationError::OAuth(
                    "auth flow timed out after 5 minutes".into(),
                ));
            }
        };
        listener_task.abort();

        if let Some(err) = params.error.as_ref() {
            let detail = params.error_description.as_deref().unwrap_or("");
            return Err(IntegrationError::OAuth(
                format!("authorize: {err} {detail}").trim().into(),
            ));
        }
        let code = params
            .code
            .ok_or_else(|| IntegrationError::OAuth("no code in callback".into()))?;

        let tokens = exchange_code(&cfg, &client_secret, &code).await?;
        let identity = whoami(&tokens.access_token).await?;

        if let Err(e) = super::tokens::store(super::types::IntegrationKind::Linear, &tokens) {
            tracing::warn!(?e, "keychain store failed; tokens not persisted");
            return Err(e);
        }

        Ok(LinearConnectOutcome { tokens, identity })
    });

    Ok(LinearAuthFlow {
        authorize_url: authorize_url.to_string(),
        completion,
        cancel: cancel_tx,
    })
}

async fn callback_handler(
    State(state): State<CallbackState>,
    Query(params): Query<CallbackParams>,
) -> Html<&'static str> {
    let matches = params
        .state
        .as_deref()
        .map(|s| s == state.expected_state)
        .unwrap_or(false);
    let result = if !matches {
        Err(IntegrationError::OAuth(
            "state mismatch — possible CSRF; ignored".into(),
        ))
    } else {
        Ok(params)
    };
    let mut slot = state.sender.lock().await;
    if let Some(tx) = slot.take() {
        let _ = tx.send(result);
    }
    Html(CALLBACK_HTML)
}

/// Exchange the authorization code for tokens. Linear's token endpoint
/// takes a form-encoded body (unlike Atlassian's JSON).
async fn exchange_code(
    cfg: &LinearConfig,
    client_secret: &str,
    code: &str,
) -> Result<ProviderTokens, IntegrationError> {
    let client = http_client()?;
    let form = [
        ("grant_type", "authorization_code"),
        ("client_id", cfg.client_id.as_str()),
        ("client_secret", client_secret),
        ("code", code),
        ("redirect_uri", cfg.redirect_uri.as_str()),
    ];
    let resp = client.post(TOKEN_URL).form(&form).send().await?;
    parse_token_response(resp).await
}

#[derive(Debug, Deserialize)]
struct LinearTokenResponse {
    access_token: String,
    #[serde(default)]
    token_type: Option<String>,
    #[serde(default)]
    expires_in: Option<u64>,
    #[serde(default)]
    scope: Option<LinearScope>,
}

/// Linear returns `scope` as an array of strings; older/other responses may
/// send a single space/comma string. Accept both and normalise to a joined
/// string for `ProviderTokens.scope`.
#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum LinearScope {
    List(Vec<String>),
    One(String),
}

impl LinearScope {
    fn into_string(self) -> String {
        match self {
            LinearScope::List(v) => v.join(","),
            LinearScope::One(s) => s,
        }
    }
}

async fn parse_token_response(resp: reqwest::Response) -> Result<ProviderTokens, IntegrationError> {
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(IntegrationError::Http {
            status: status.as_u16(),
            body,
        });
    }
    let parsed: LinearTokenResponse = resp.json().await?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    Ok(ProviderTokens {
        access_token: parsed.access_token,
        // Linear does not issue refresh tokens — the access token is
        // long-lived and a reconnect handles the rare expiry.
        refresh_token: None,
        token_type: parsed.token_type,
        expires_at: parsed.expires_in.map(|s| now + s),
        scope: parsed.scope.map(|s| s.into_string()),
    })
}

#[derive(Debug, Deserialize)]
struct GraphQlResponse<T> {
    // `Option` fields are already treated as optional by serde (missing →
    // None); no `#[serde(default)]` here — on a generic struct that would
    // force `T: Default`, which the payload types don't (and needn't) impl.
    data: Option<T>,
    errors: Option<Vec<GraphQlError>>,
}

#[derive(Debug, Deserialize)]
struct GraphQlError {
    message: String,
}

#[derive(Debug, Deserialize)]
struct ViewerData {
    viewer: Viewer,
}

#[derive(Debug, Deserialize)]
struct Viewer {
    id: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    email: Option<String>,
    #[serde(default, rename = "avatarUrl")]
    avatar_url: Option<String>,
}

/// GraphQL `viewer` probe — the authenticated user in the token's
/// workspace. The single identity call Linear needs (there's no
/// multi-site concept).
pub async fn whoami(access_token: &str) -> Result<ExternalIdentity, IntegrationError> {
    let client = http_client()?;
    let body = serde_json::json!({
        "query": "{ viewer { id name email avatarUrl } }"
    });
    let resp = client
        .post(GRAPHQL_URL)
        .bearer_auth(access_token)
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(IntegrationError::Http {
            status: status.as_u16(),
            body,
        });
    }
    let parsed: GraphQlResponse<ViewerData> = resp.json().await?;
    if let Some(errs) = parsed.errors.filter(|e| !e.is_empty()) {
        let joined = errs
            .into_iter()
            .map(|e| e.message)
            .collect::<Vec<_>>()
            .join("; ");
        return Err(IntegrationError::Other(format!("linear graphql: {joined}")));
    }
    let viewer = parsed
        .data
        .ok_or_else(|| IntegrationError::Other("linear graphql: empty viewer".into()))?
        .viewer;
    Ok(ExternalIdentity {
        account_id: viewer.id,
        display_name: viewer.name.unwrap_or_else(|| "Linear user".into()),
        email: viewer.email,
        avatar_url: viewer.avatar_url,
    })
}

fn http_client() -> Result<reqwest::Client, IntegrationError> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(HTTP_TIMEOUT_SECS))
        .build()
        .map_err(|e| IntegrationError::Other(format!("reqwest build: {e}")))
}

/// 32-byte cryptographic state nonce, URL-safe base64 without padding —
/// CSRF protection on the authorize → callback hop.
fn gen_state() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// Confirmation page shown in the browser after the redirect. Mirrors the
/// Jira adapter's page so the two flows feel like one product.
const CALLBACK_HTML: &str = r#"<!doctype html><html><head><title>Aura · Linear connected</title>
<style>
body{font-family:system-ui;background:#0b0b10;color:#e6e6e9;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.card{padding:32px;border-radius:12px;background:#15151c;border:1px solid #2a2a36;max-width:380px;text-align:center}
h1{font-size:18px;margin:0 0 8px}
p{color:#9a9aa6;font-size:13px;line-height:1.5;margin:0}
.dot{width:8px;height:8px;border-radius:50%;background:#5e6ad2;display:inline-block;margin-right:6px}
</style></head><body><div class=card>
<h1><span class=dot></span>Linear connected</h1>
<p>You can close this tab and return to Aura.</p>
</div></body></html>"#;
