//! Atlassian 3LO (OAuth 2.0) adapter — Jira Cloud.
//!
//! Spec reference: https://developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/
//!
//! Why a fresh flow rather than reusing `mcp_oauth::start_flow`:
//!  - Atlassian does not advertise RFC 8414 metadata at a
//!    well-known URL, so the discovery step is meaningless here.
//!  - The token endpoint expects a JSON body (Atlassian docs are
//!    explicit), not the form-encoded body `mcp_oauth` sends.
//!  - The authorize URL requires the Atlassian-specific
//!    `audience=api.atlassian.com` parameter that generic OAuth
//!    clients don't know about.
//!  - The callback URL is registered as an **exact** match (port
//!    included), so we have to bind a known port from
//!    `integrations.toml`, not the random `:0` port `mcp_oauth`
//!    picks.
//!
//! What we DO reuse: the `ProviderTokens` shape and the keychain JSON
//! discipline (via `super::tokens`), so the renderer-visible token
//! lifecycle stays consistent across providers.
//!
//! PKCE is intentionally **not** sent. Atlassian 3LO is a confidential
//! client (the `client_secret` lives on disk) — combining that with
//! the cryptographic `state` nonce gives both CSRF + token-binding
//! protection. Adding `code_challenge` on top has no security upside
//! and Atlassian's authorize endpoint silently ignores it.

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

use super::config::JiraConfig;
use super::types::{CloudSite, ExternalIdentity, IntegrationError, ProviderTokens};

const AUTHORIZE_URL: &str = "https://auth.atlassian.com/authorize";
const TOKEN_URL: &str = "https://auth.atlassian.com/oauth/token";
const ACCESSIBLE_RESOURCES_URL: &str =
    "https://api.atlassian.com/oauth/token/accessible-resources";

/// Default HTTP timeout for every Atlassian call. Generous because
/// Atlassian's edge can take a beat on the first cold connect from a
/// new region, but short enough that a wedged response can't hang the
/// renderer's settings spinner for minutes.
const HTTP_TIMEOUT_SECS: u64 = 20;

/// Outcome handed back to the renderer after a successful connect:
/// tokens that have already been persisted, plus everything the
/// settings UI needs to render "Connected as X on sites Y…".
#[derive(Debug, Clone)]
pub struct JiraConnectOutcome {
    pub tokens: ProviderTokens,
    pub identity: ExternalIdentity,
    pub sites: Vec<CloudSite>,
}

/// Handle returned by `start_auth` — the renderer opens
/// `authorize_url` in the user's browser and awaits `completion`.
/// `cancel` aborts the flow (releases the loopback port and resolves
/// `completion` with a "cancelled" error) when fired — used when the
/// user clicks Cancel in the settings panel, or when a fresh connect
/// attempt needs to evict a stale listener whose browser tab landed on
/// an Atlassian error page (which never redirects back to localhost).
pub struct JiraAuthFlow {
    pub authorize_url: String,
    pub completion: JoinHandle<Result<JiraConnectOutcome, IntegrationError>>,
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

/// Kick off the OAuth flow. Binds the loopback listener on the port
/// from `cfg.redirect_uri` (Atlassian rejects port mismatches), builds
/// the authorize URL, and returns immediately. The renderer opens the
/// URL in the system browser and awaits `completion`, which:
///   1. waits for the callback (5-min timeout)
///   2. exchanges code → tokens
///   3. lists accessible Jira sites
///   4. probes `/myself` on the first site for identity
///   5. persists tokens to the keychain
pub async fn start_auth(cfg: &JiraConfig) -> Result<JiraAuthFlow, IntegrationError> {
    let port = cfg.loopback_port()?;
    // Bind BEFORE returning the URL — if the port is in use we want
    // to fail fast with a clear message instead of leaving the user
    // staring at a half-completed browser tab.
    let listener = TcpListener::bind(("127.0.0.1", port))
        .await
        .map_err(|e| {
            IntegrationError::OAuth(format!(
                "bind 127.0.0.1:{port}: {e}. \
                 Another process may be using this port — change `redirect_uri` \
                 in ~/.aura/integrations.toml AND in the Atlassian console."
            ))
        })?;

    let state_nonce = gen_state();
    let mut authorize_url = url::Url::parse(AUTHORIZE_URL)?;
    {
        let mut q = authorize_url.query_pairs_mut();
        q.append_pair("audience", "api.atlassian.com");
        q.append_pair("client_id", &cfg.client_id);
        q.append_pair("scope", &cfg.scopes.join(" "));
        q.append_pair("redirect_uri", &cfg.redirect_uri);
        q.append_pair("state", &state_nonce);
        q.append_pair("response_type", "code");
        // `prompt=consent` forces the consent screen so we reliably
        // get a refresh_token returned alongside `offline_access`.
        // Without this, Atlassian sometimes silently re-uses an
        // existing approval and skips the refresh token.
        q.append_pair("prompt", "consent");
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
        // `axum::serve` returns when the listener errors; nothing we
        // can do about it from here, so swallow.
        let _ = axum::serve(listener, router).await;
    });

    let cfg = cfg.clone();
    let completion = tokio::spawn(async move {
        // Race three outcomes: the user completes the flow (rx), the
        // caller cancels us (cancel_rx — fired by the cancel command
        // or by a follow-up connect attempt), or the 5-minute upper
        // bound trips so a wedged listener can't sit on the port.
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

        let tokens = exchange_code(&cfg, &code).await?;
        let sites = list_accessible_resources(&tokens.access_token).await?;
        // No sites is rare but real — happens if the user revokes
        // access between consent and our first call. Surface clearly.
        let identity = if let Some(first) = sites.first() {
            whoami(&tokens.access_token, &first.cloud_id).await?
        } else {
            return Err(IntegrationError::OAuth(
                "Atlassian returned 0 accessible Jira sites — your account has no Jira access \
                 or all sites revoked the grant"
                    .into(),
            ));
        };

        // Persist on success. Failure to write is non-fatal for the
        // current flow (we still return a working token blob to the
        // renderer) but the user will be asked to reconnect on next
        // restart. We log + propagate as a soft error string.
        if let Err(e) = super::tokens::store(super::types::IntegrationKind::Jira, &tokens) {
            tracing::warn!(?e, "keychain store failed; tokens not persisted");
            return Err(e);
        }

        Ok(JiraConnectOutcome {
            tokens,
            identity,
            sites,
        })
    });

    Ok(JiraAuthFlow {
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

/// Exchange the authorization code for tokens. Atlassian expects a
/// JSON body (the form-encoded variant the `mcp_oauth` helper sends is
/// not documented as supported).
async fn exchange_code(cfg: &JiraConfig, code: &str) -> Result<ProviderTokens, IntegrationError> {
    let client = http_client()?;
    let body = serde_json::json!({
        "grant_type": "authorization_code",
        "client_id": cfg.client_id,
        "client_secret": cfg.client_secret,
        "code": code,
        "redirect_uri": cfg.redirect_uri,
    });
    let resp = client
        .post(TOKEN_URL)
        .json(&body)
        .send()
        .await?;
    parse_token_response(resp).await
}

/// Refresh an expired access token. Atlassian rotates the refresh
/// token on every refresh, so callers MUST persist the returned
/// tokens (we do — see `valid_access_token` in cmd_integrations).
pub async fn refresh(
    cfg: &JiraConfig,
    refresh_token: &str,
) -> Result<ProviderTokens, IntegrationError> {
    let client = http_client()?;
    let body = serde_json::json!({
        "grant_type": "refresh_token",
        "client_id": cfg.client_id,
        "client_secret": cfg.client_secret,
        "refresh_token": refresh_token,
    });
    let resp = client
        .post(TOKEN_URL)
        .json(&body)
        .send()
        .await?;
    parse_token_response(resp).await
}

#[derive(Debug, Deserialize)]
struct AtlassianTokenResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    token_type: Option<String>,
    #[serde(default)]
    expires_in: Option<u64>,
    #[serde(default)]
    scope: Option<String>,
}

async fn parse_token_response(
    resp: reqwest::Response,
) -> Result<ProviderTokens, IntegrationError> {
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(IntegrationError::Http {
            status: status.as_u16(),
            body,
        });
    }
    let parsed: AtlassianTokenResponse = resp.json().await?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    Ok(ProviderTokens {
        access_token: parsed.access_token,
        refresh_token: parsed.refresh_token,
        token_type: parsed.token_type,
        expires_at: parsed.expires_in.map(|s| now + s),
        scope: parsed.scope,
    })
}

#[derive(Debug, Deserialize)]
struct AccessibleResource {
    id: String,
    url: String,
    name: String,
    #[serde(default)]
    scopes: Vec<String>,
    #[serde(default, rename = "avatarUrl")]
    avatar_url: Option<String>,
}

/// Atlassian: GET /oauth/token/accessible-resources → the list of
/// cloud sites the access token can reach. Empty list is valid (no
/// access granted to any site) — caller decides whether that's an
/// error in their flow.
pub async fn list_accessible_resources(
    access_token: &str,
) -> Result<Vec<CloudSite>, IntegrationError> {
    let client = http_client()?;
    let resp = client
        .get(ACCESSIBLE_RESOURCES_URL)
        .bearer_auth(access_token)
        .header("Accept", "application/json")
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
    let parsed: Vec<AccessibleResource> = resp.json().await?;
    Ok(parsed
        .into_iter()
        .map(|r| CloudSite {
            cloud_id: r.id,
            url: r.url,
            name: r.name,
            scopes: r.scopes,
            avatar_url: r.avatar_url,
        })
        .collect())
}

#[derive(Debug, Deserialize)]
struct JiraMyself {
    #[serde(rename = "accountId")]
    account_id: String,
    #[serde(default, rename = "displayName")]
    display_name: Option<String>,
    #[serde(default, rename = "emailAddress")]
    email_address: Option<String>,
    #[serde(default, rename = "avatarUrls")]
    avatar_urls: Option<JiraAvatarUrls>,
}

#[derive(Debug, Deserialize)]
struct JiraAvatarUrls {
    /// Atlassian returns size-keyed URLs (`"48x48"`, `"32x32"`, …).
    /// We prefer the 48px square, falling back to whatever's largest.
    #[serde(default, rename = "48x48")]
    px48: Option<String>,
}

/// GET /ex/jira/{cloudid}/rest/api/3/myself — Jira-context whoami.
/// Picked over the Atlassian-account-level `/me` because it only
/// needs the `read:jira-user` scope (which we already require for
/// pulling assignees), avoiding the need for a separate
/// "User identity API" scope addition in the console.
pub async fn whoami(
    access_token: &str,
    cloud_id: &str,
) -> Result<ExternalIdentity, IntegrationError> {
    let client = http_client()?;
    let url = format!("https://api.atlassian.com/ex/jira/{cloud_id}/rest/api/3/myself");
    let resp = client
        .get(&url)
        .bearer_auth(access_token)
        .header("Accept", "application/json")
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
    let me: JiraMyself = resp.json().await?;
    Ok(ExternalIdentity {
        account_id: me.account_id,
        display_name: me.display_name.unwrap_or_else(|| "Jira user".into()),
        email: me.email_address,
        avatar_url: me.avatar_urls.and_then(|a| a.px48),
    })
}

fn http_client() -> Result<reqwest::Client, IntegrationError> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(HTTP_TIMEOUT_SECS))
        .build()
        .map_err(|e| IntegrationError::Other(format!("reqwest build: {e}")))
}

/// 32-byte cryptographic state nonce, URL-safe base64 without padding.
/// Used for CSRF protection on the authorize → callback hop.
fn gen_state() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// Confirmation page shown in the browser tab after the redirect.
/// Kept tiny + self-contained so it works offline and doesn't pull in
/// any tracking. Visual style mirrors `mcp_oauth::CALLBACK_HTML` so the
/// two flows feel like one product.
const CALLBACK_HTML: &str = r#"<!doctype html><html><head><title>Aura · Jira connected</title>
<style>
body{font-family:system-ui;background:#0b0b10;color:#e6e6e9;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.card{padding:32px;border-radius:12px;background:#15151c;border:1px solid #2a2a36;max-width:380px;text-align:center}
h1{font-size:18px;margin:0 0 8px}
p{color:#9a9aa6;font-size:13px;line-height:1.5;margin:0}
.dot{width:8px;height:8px;border-radius:50%;background:#22c55e;display:inline-block;margin-right:6px}
</style></head><body><div class=card>
<h1><span class=dot></span>Jira connected</h1>
<p>You can close this tab and return to Aura.</p>
</div></body></html>"#;
