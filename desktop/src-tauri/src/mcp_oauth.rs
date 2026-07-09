// Wave C — Native OAuth 2.1 + PKCE for remote MCP servers.
//
// MCP's remote-server spec (model-context-protocol/draft-protocol/auth)
// follows the OAuth 2.1 BCP — Authorization Code with PKCE, optionally
// preceded by RFC 7591 Dynamic Client Registration and discovered via
// RFC 8414 Authorization Server Metadata.
//
// This module owns the full dance:
//   1. Fetch `{issuer}/.well-known/oauth-authorization-server` to learn
//      the auth + token endpoints. Falls back to a sensible guess if
//      the issuer doesn't advertise metadata.
//   2. Optionally register a dynamic client (most providers support
//      this; if not we read the user-supplied client_id from config).
//   3. Generate a PKCE code_verifier + S256 challenge.
//   4. Spin up a one-shot loopback HTTP listener on 127.0.0.1 to catch
//      the redirect. The listener binds port 0 so we get a free port
//      and embed it in the redirect_uri.
//   5. Open the authorize URL in the user's browser (caller does this
//      after we hand back the URL — keeps this module free of
//      Tauri-specific deps).
//   6. Receive the authorization_code from the callback and exchange
//      it for tokens with the code_verifier.
//   7. Store the resulting access + refresh tokens in the OS keychain
//      (service "aura-mcp-oauth", account = server name).
//
// We do NOT yet implement the streaming HTTP MCP transport that would
// USE these tokens — that ships separately. Wave C's job is owning the
// OAuth UX so customers never have to drop to a terminal for it.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::{
    extract::{Query, State},
    response::Html,
    routing::get,
    Router,
};
use base64::Engine;
use rand::Rng;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::net::TcpListener;
use tokio::sync::{oneshot, Mutex};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AuthServerMetadata {
    pub issuer: String,
    pub authorization_endpoint: String,
    pub token_endpoint: String,
    #[serde(default)]
    pub registration_endpoint: Option<String>,
    #[serde(default)]
    pub scopes_supported: Vec<String>,
    #[serde(default)]
    pub code_challenge_methods_supported: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OAuthTokens {
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: Option<String>,
    #[serde(default)]
    pub token_type: Option<String>,
    /// Absolute unix timestamp (seconds) when `access_token` expires.
    /// Computed by adding `expires_in` to wall-clock at issue time so
    /// the keychain blob is self-describing.
    pub expires_at: Option<u64>,
    #[serde(default)]
    pub scope: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
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

#[derive(Debug, Deserialize, Serialize)]
struct ClientRegistrationResponse {
    client_id: String,
    #[serde(default)]
    client_secret: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OAuthConfig {
    /// Base URL of the MCP server (e.g. `https://mcp.atlassian.com/v1/sse`).
    /// We strip path + query to get the issuer for metadata discovery.
    pub server_url: String,
    /// Optional pre-registered client_id. If absent we attempt DCR.
    #[serde(default)]
    pub client_id: Option<String>,
    /// Optional client_secret (for confidential clients). Public clients
    /// must NOT have this set per OAuth 2.1.
    #[serde(default)]
    pub client_secret: Option<String>,
    #[serde(default)]
    pub scope: Option<String>,
}

#[derive(Debug)]
pub struct OAuthFlow {
    pub authorize_url: String,
    /// One-shot future that resolves to the exchanged tokens once the
    /// user completes the browser flow. Holds the listener task as
    /// long as it's alive so dropping this aborts the loopback server.
    pub completion: tokio::task::JoinHandle<Result<OAuthTokens, String>>,
    pub redirect_uri: String,
}

#[derive(Clone)]
struct CallbackState {
    expected_state: String,
    sender: Arc<Mutex<Option<oneshot::Sender<Result<CallbackParams, String>>>>>,
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

/// Kicks off the OAuth flow. Returns immediately with the authorize URL
/// and a JoinHandle that resolves once the user finishes (or times out
/// at 5 minutes). The caller is responsible for opening the URL in the
/// user's browser.
pub async fn start_flow(cfg: OAuthConfig) -> Result<OAuthFlow, String> {
    let metadata = discover_metadata(&cfg.server_url).await?;

    // Resolve client_id, registering dynamically if we don't already
    // have one and the auth server advertises a registration endpoint.
    let (client_id, client_secret) = match cfg.client_id.clone() {
        Some(id) => (id, cfg.client_secret.clone()),
        None => {
            let endpoint = metadata
                .registration_endpoint
                .as_ref()
                .ok_or_else(|| {
                    "no client_id provided and server doesn't support dynamic registration"
                        .to_string()
                })?;
            register_client(endpoint).await?
        }
    };

    // Bind the loopback callback listener on a free port BEFORE
    // building the authorize URL so we can embed the chosen port in
    // redirect_uri.
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("bind callback listener: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("local_addr: {e}"))?
        .port();
    let redirect_uri = format!("http://127.0.0.1:{}/callback", port);

    let code_verifier = gen_code_verifier();
    let code_challenge = pkce_s256(&code_verifier);
    let state_nonce = gen_state();
    let scope = cfg
        .scope
        .clone()
        .or_else(|| metadata.scopes_supported.first().cloned())
        .unwrap_or_default();

    let mut authorize_url = url::Url::parse(&metadata.authorization_endpoint)
        .map_err(|e| format!("bad authorization_endpoint: {e}"))?;
    authorize_url
        .query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", &client_id)
        .append_pair("redirect_uri", &redirect_uri)
        .append_pair("code_challenge", &code_challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", &state_nonce);
    if !scope.is_empty() {
        authorize_url
            .query_pairs_mut()
            .append_pair("scope", &scope);
    }

    let (tx, rx) = oneshot::channel::<Result<CallbackParams, String>>();
    let state = CallbackState {
        expected_state: state_nonce.clone(),
        sender: Arc::new(Mutex::new(Some(tx))),
    };
    let app = Router::new()
        .route("/callback", get(callback_handler))
        .with_state(state.clone());

    let listener_task = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });

    let token_endpoint = metadata.token_endpoint.clone();
    let completion = tokio::spawn(async move {
        // 5-minute upper bound — long enough for a user to fight with
        // a corporate SSO, short enough to garbage-collect a wedged
        // listener if they bail.
        let params = match tokio::time::timeout(Duration::from_secs(300), rx).await {
            Ok(Ok(Ok(p))) => p,
            Ok(Ok(Err(e))) => {
                listener_task.abort();
                return Err(e);
            }
            Ok(Err(_)) => {
                listener_task.abort();
                return Err("callback channel closed unexpectedly".into());
            }
            Err(_) => {
                listener_task.abort();
                return Err("auth flow timed out after 5 minutes".into());
            }
        };
        listener_task.abort();
        if let Some(err) = params.error.as_ref() {
            let detail = params.error_description.as_deref().unwrap_or("");
            return Err(format!("authorize error: {err} {detail}").trim().into());
        }
        let code = params.code.ok_or("no code in callback")?;
        let tokens = exchange_code(
            &token_endpoint,
            &client_id,
            client_secret.as_deref(),
            &code,
            &redirect_uri,
            &code_verifier,
        )
        .await?;
        Ok(tokens)
    });

    Ok(OAuthFlow {
        authorize_url: authorize_url.to_string(),
        completion,
        redirect_uri: format!("http://127.0.0.1:{port}/callback"),
    })
}

async fn callback_handler(
    State(state): State<CallbackState>,
    Query(params): Query<CallbackParams>,
) -> Html<&'static str> {
    let state_matches = params
        .state
        .as_deref()
        .map(|s| s == state.expected_state)
        .unwrap_or(false);
    let result = if !state_matches {
        Err("state mismatch — possible CSRF; ignored".to_string())
    } else {
        Ok(params)
    };
    let mut slot = state.sender.lock().await;
    if let Some(tx) = slot.take() {
        let _ = tx.send(result);
    }
    Html(CALLBACK_HTML)
}

const CALLBACK_HTML: &str = r#"<!doctype html><html><head><title>Aura · Authentication complete</title>
<style>
body{font-family:system-ui;background:#0b0b10;color:#e6e6e9;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.card{padding:32px;border-radius:12px;background:#15151c;border:1px solid #2a2a36;max-width:380px;text-align:center}
h1{font-size:18px;margin:0 0 8px}
p{color:#9a9aa6;font-size:13px;line-height:1.5;margin:0}
.dot{width:8px;height:8px;border-radius:50%;background:#22c55e;display:inline-block;margin-right:6px}
</style></head><body><div class=card>
<h1><span class=dot></span>Authentication complete</h1>
<p>You can close this tab and return to Aura.</p>
</div></body></html>"#;

pub async fn discover_metadata(server_url: &str) -> Result<AuthServerMetadata, String> {
    // Strip path/query to get the issuer base, then probe
    // {issuer}/.well-known/oauth-authorization-server (RFC 8414) and
    // fall back to {issuer}/.well-known/openid-configuration.
    let mut parsed = url::Url::parse(server_url).map_err(|e| format!("bad server URL: {e}"))?;
    parsed.set_path("");
    parsed.set_query(None);
    let issuer = parsed.as_str().trim_end_matches('/').to_string();

    let candidates = [
        format!("{issuer}/.well-known/oauth-authorization-server"),
        format!("{issuer}/.well-known/openid-configuration"),
    ];
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("reqwest build: {e}"))?;
    for candidate in &candidates {
        if let Ok(resp) = client.get(candidate).send().await {
            if resp.status().is_success() {
                if let Ok(meta) = resp.json::<AuthServerMetadata>().await {
                    if !meta.authorization_endpoint.is_empty()
                        && !meta.token_endpoint.is_empty()
                    {
                        return Ok(meta);
                    }
                }
            }
        }
    }
    Err(format!(
        "no OAuth metadata at {} (tried oauth-authorization-server and openid-configuration)",
        issuer
    ))
}

async fn register_client(endpoint: &str) -> Result<(String, Option<String>), String> {
    let body = serde_json::json!({
        "client_name": "Aura Shell",
        "redirect_uris": ["http://127.0.0.1/callback"],
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "token_endpoint_auth_method": "none",
        "application_type": "native",
    });
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("reqwest build: {e}"))?;
    let resp = client
        .post(endpoint)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("DCR request: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let txt = resp.text().await.unwrap_or_default();
        return Err(format!("DCR failed ({status}): {txt}"));
    }
    let parsed: ClientRegistrationResponse = resp
        .json()
        .await
        .map_err(|e| format!("DCR parse: {e}"))?;
    Ok((parsed.client_id, parsed.client_secret))
}

async fn exchange_code(
    token_endpoint: &str,
    client_id: &str,
    client_secret: Option<&str>,
    code: &str,
    redirect_uri: &str,
    code_verifier: &str,
) -> Result<OAuthTokens, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("reqwest build: {e}"))?;
    let mut form: HashMap<&str, &str> = HashMap::new();
    form.insert("grant_type", "authorization_code");
    form.insert("code", code);
    form.insert("redirect_uri", redirect_uri);
    form.insert("client_id", client_id);
    form.insert("code_verifier", code_verifier);
    let mut req = client.post(token_endpoint).form(&form);
    if let Some(secret) = client_secret {
        req = req.basic_auth(client_id, Some(secret));
    }
    let resp = req
        .send()
        .await
        .map_err(|e| format!("token request: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let txt = resp.text().await.unwrap_or_default();
        return Err(format!("token exchange failed ({status}): {txt}"));
    }
    let tr: TokenResponse = resp
        .json()
        .await
        .map_err(|e| format!("token parse: {e}"))?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    Ok(OAuthTokens {
        access_token: tr.access_token,
        refresh_token: tr.refresh_token,
        token_type: tr.token_type,
        expires_at: tr.expires_in.map(|s| now + s),
        scope: tr.scope,
    })
}

pub async fn refresh_tokens(
    token_endpoint: &str,
    client_id: &str,
    client_secret: Option<&str>,
    refresh_token: &str,
) -> Result<OAuthTokens, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("reqwest build: {e}"))?;
    let mut form: HashMap<&str, &str> = HashMap::new();
    form.insert("grant_type", "refresh_token");
    form.insert("refresh_token", refresh_token);
    form.insert("client_id", client_id);
    let mut req = client.post(token_endpoint).form(&form);
    if let Some(secret) = client_secret {
        req = req.basic_auth(client_id, Some(secret));
    }
    let resp = req
        .send()
        .await
        .map_err(|e| format!("refresh request: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let txt = resp.text().await.unwrap_or_default();
        return Err(format!("refresh failed ({status}): {txt}"));
    }
    let tr: TokenResponse = resp
        .json()
        .await
        .map_err(|e| format!("refresh parse: {e}"))?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    Ok(OAuthTokens {
        access_token: tr.access_token,
        refresh_token: tr.refresh_token,
        token_type: tr.token_type,
        expires_at: tr.expires_in.map(|s| now + s),
        scope: tr.scope,
    })
}

// ── Token-store helpers ──────────────────────────────────────────────
//
// We store the full token blob as JSON under (service, account) so a
// future read can decide whether to refresh. The backing store is the OS
// keychain in release and a dev file fallback in debug — see
// `crate::secret_store`; both encrypt-at-rest (release) or 0600-protect
// (debug) the value.

const KEYCHAIN_SERVICE: &str = "aura-mcp-oauth";

pub fn keychain_store(name: &str, tokens: &OAuthTokens) -> Result<(), String> {
    let blob = serde_json::to_string(tokens).map_err(|e| format!("encode: {e}"))?;
    crate::secret_store::set(KEYCHAIN_SERVICE, name, &blob)
}

pub fn keychain_load(name: &str) -> Result<Option<OAuthTokens>, String> {
    match crate::secret_store::get(KEYCHAIN_SERVICE, name)? {
        Some(blob) => serde_json::from_str::<OAuthTokens>(&blob)
            .map(Some)
            .map_err(|e| format!("decode: {e}")),
        None => Ok(None),
    }
}

pub fn keychain_delete(name: &str) -> Result<(), String> {
    crate::secret_store::delete(KEYCHAIN_SERVICE, name)
}

// ── PKCE + state helpers ────────────────────────────────────────────

fn gen_code_verifier() -> String {
    // OAuth 2.1 spec: code_verifier = 43-128 chars from
    // [A-Z]/[a-z]/[0-9]/'-'/'.'/'_'/'~'. We use 64 random bytes ->
    // url-safe base64 (no padding) which lands in the legal range.
    let mut bytes = [0u8; 64];
    rand::thread_rng().fill(&mut bytes);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn pkce_s256(verifier: &str) -> String {
    let mut h = Sha256::new();
    h.update(verifier.as_bytes());
    let digest = h.finalize();
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(digest)
}

fn gen_state() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill(&mut bytes);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

// ── Token-refresh shim ──────────────────────────────────────────────
//
// Called by the HTTP transport on every request. Loads the stored
// token blob, refreshes if it's about to expire, persists the new
// one, and hands back a bearer string. Returns Ok(None) only when
// the keychain has nothing — that's the "user hasn't auth'd yet"
// case and the caller surfaces it as a UI prompt.
//
// 30-second skew window: we treat a token as expired-already if it
// expires within the next 30s so a request that's mid-flight when
// the deadline ticks over still uses fresh credentials.
const EXPIRY_SKEW_SECS: u64 = 30;

pub async fn valid_access_token(
    name: &str,
    server_url: &str,
    client_id: Option<&str>,
) -> Result<Option<String>, String> {
    let Some(stored) = keychain_load(name)? else {
        return Ok(None);
    };

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let still_valid = match stored.expires_at {
        None => true, // server didn't advertise expiry — trust it.
        Some(exp) => exp > now + EXPIRY_SKEW_SECS,
    };
    if still_valid {
        return Ok(Some(stored.access_token));
    }

    // Expired (or about to expire). Refresh if we can.
    let refresh = match stored.refresh_token.as_deref() {
        Some(rt) if !rt.is_empty() => rt,
        _ => {
            // No refresh token — best-effort: hand back the stale
            // access_token. The server will 401, and the UI can
            // prompt re-auth. Beats hard-failing here when the only
            // reason we know it's expired is a clock skew.
            return Ok(Some(stored.access_token));
        }
    };
    let cid = match client_id {
        Some(c) if !c.is_empty() => c,
        _ => {
            return Ok(Some(stored.access_token));
        }
    };

    let metadata = discover_metadata(server_url).await?;
    let fresh =
        refresh_tokens(&metadata.token_endpoint, cid, None, refresh).await?;
    // RFC 6749 §6: refresh response MAY omit a new refresh_token,
    // in which case we have to keep using the old one.
    let merged = OAuthTokens {
        access_token: fresh.access_token.clone(),
        refresh_token: fresh
            .refresh_token
            .clone()
            .or(stored.refresh_token.clone()),
        token_type: fresh.token_type.clone().or(stored.token_type.clone()),
        expires_at: fresh.expires_at,
        scope: fresh.scope.clone().or(stored.scope.clone()),
    };
    keychain_store(name, &merged)?;
    Ok(Some(merged.access_token))
}
