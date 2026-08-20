//! Host side of the `aura://` tunnel: serve `tunnel_req` frames from loopback.
//!
//! A collaborator watching your session usually needs the thing you are
//! running, not just the code. The cloud terminates `/t/{code}/…` and asks this
//! desktop, over the session socket it already trusts, to fetch the request
//! from `127.0.0.1`.
//!
//! The security rule is short and absolute: **this proxy reaches 127.0.0.1, on
//! a port the user explicitly opened, and nowhere else.** Two places would
//! otherwise leak:
//!
//!  1. The port. A `tunnel_req` naming a port we never opened is refused, so a
//!     forged or stale frame cannot walk the loopback port range.
//!  2. The path. `format!("http://127.0.0.1:{port}{path}")` looks harmless and
//!     is not: a path of `@evil.com/` turns `127.0.0.1:3000` into *userinfo*
//!     and the request goes to `evil.com`. The URL is therefore built by
//!     parsing a fixed loopback base and setting the path through the API,
//!     which cannot cross into the authority — then re-checked afterwards.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use tracing::warn;

use super::ctx::{ConnCtx, TunnelRecord};
use super::protocol::{ClientFrame, TunnelReqFrame};
use crate::cloud_org::OrgScoped;

/// Ceiling on both the request body we accept and the response we return.
/// A tunnel is for looking at a dev server, not for shipping build artefacts.
const MAX_BODY: usize = 8 * 1024 * 1024;

/// Per-request ceiling. A local dev server that hangs must not pin a frame id
/// forever on the cloud side.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// Headers that describe *this hop* and must not be forwarded to the next one.
/// `accept-encoding` is stripped as well: this build of reqwest has no
/// decompression features, so asking for gzip would hand us a body we would
/// have to forward opaquely along with its `content-encoding`. Asking for
/// identity keeps the proxy honest.
const HOP_BY_HOP_REQUEST: &[&str] = &[
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "trailers",
    "transfer-encoding",
    "upgrade",
    "host",
    "content-length",
    "accept-encoding",
];

const HOP_BY_HOP_RESPONSE: &[&str] = &[
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "trailers",
    "transfer-encoding",
    "upgrade",
    "content-length",
];

/// What `session_live_tunnel_open` hands back to the UI.
#[derive(Serialize, Clone, Debug)]
pub struct TunnelInfo {
    pub session_id: String,
    pub code: String,
    /// The real, auth'd URL a teammate loads.
    pub url: String,
    pub port: u16,
    pub label: String,
    /// The display form shown in the UI and accepted in the composer.
    pub display: String,
}

impl TunnelInfo {
    fn from_record(session_id: &str, rec: &TunnelRecord) -> Self {
        Self {
            session_id: session_id.to_string(),
            code: rec.code.clone(),
            url: rec.url.clone(),
            port: rec.port,
            label: rec.label.clone(),
            display: format!("aura://localhost:{}", rec.port),
        }
    }
}

#[derive(Deserialize)]
struct OpenResp {
    code: String,
    url: String,
}

/// Ask the cloud for a tunnel code, then record the port as proxyable.
///
/// The port is recorded only after the cloud accepts, so a failed open cannot
/// widen what this desktop is willing to serve.
pub async fn open(ctx: &Arc<ConnCtx>, port: u16, label: String) -> Result<TunnelInfo, String> {
    if port == 0 {
        return Err("port 0 is not a real port".into());
    }
    if !ctx.is_host() {
        return Err("only the session host can open a tunnel — this desktop is a guest".into());
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("client build: {e}"))?;
    let url = format!("{}/api/v2/tunnel/open", ctx.origin);
    let resp = client
        .post(&url)
        .bearer_auth(&ctx.token)
        .org_scoped()
        .json(&serde_json::json!({ "port": port, "label": label }))
        .send()
        .await
        .map_err(|e| format!("POST {url}: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("tunnel open failed: HTTP {status}: {body}"));
    }
    let parsed: OpenResp = resp
        .json()
        .await
        .map_err(|e| format!("tunnel open: bad response: {e}"))?;

    let rec = TunnelRecord {
        code: parsed.code.clone(),
        url: parsed.url.clone(),
        port,
        label,
    };
    if let Ok(mut g) = ctx.open_ports.lock() {
        g.insert(port);
    }
    if let Ok(mut g) = ctx.tunnels.lock() {
        g.insert(parsed.code.clone(), rec.clone());
    }
    Ok(TunnelInfo::from_record(&ctx.external_id, &rec))
}

/// Drop a tunnel from local state without touching the network, and report the
/// port it was serving.
///
/// Used both by `close` and by an inbound `tunnel_closed` — a tunnel the cloud
/// reaped must stop being proxyable here too, or this desktop keeps serving a
/// port nobody can see it is serving.
pub fn forget(ctx: &Arc<ConnCtx>, code: &str) -> Option<u16> {
    let removed = ctx.tunnels.lock().ok().and_then(|mut g| g.remove(code))?;
    // Only stop serving the port when no other live tunnel still uses it.
    let still_used = ctx
        .tunnels
        .lock()
        .map(|g| g.values().any(|r| r.port == removed.port))
        .unwrap_or(false);
    if !still_used {
        if let Ok(mut g) = ctx.open_ports.lock() {
            g.remove(&removed.port);
        }
    }
    Some(removed.port)
}

/// Close one tunnel: stop serving it, tell the session, then tell the cloud.
///
/// Local state is dropped even when the cloud call fails — refusing to proxy is
/// always the safe direction, and a stale server-side row is the cloud's to
/// reap when the socket dies.
///
/// The `tunnel_closed` frame goes out first, over the socket we already hold,
/// because it is the one signal that reaches the *guests*: without it their UI
/// keeps offering a live-looking link to a port that stopped answering.
pub async fn close(ctx: &Arc<ConnCtx>, code: &str) -> Result<(), String> {
    let port = forget(ctx, code);
    if let Some(port) = port {
        ctx.send(ClientFrame::TunnelClosed {
            code: code.to_string(),
            port,
        });
        ctx.emit_scoped(
            super::EV_TUNNEL_CLOSED,
            serde_json::json!({ "code": code, "port": port }),
        );
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("client build: {e}"))?;
    let url = format!("{}/api/v2/tunnel/{code}", ctx.origin);
    let resp = client
        .delete(&url)
        .bearer_auth(&ctx.token)
        .org_scoped()
        .send()
        .await
        .map_err(|e| format!("DELETE {url}: {e}"))?;
    if !resp.status().is_success() && resp.status().as_u16() != 404 {
        return Err(format!("tunnel close failed: HTTP {}", resp.status()));
    }
    Ok(())
}

/// Close every tunnel this connection opened. Called on leave — "tunnels die
/// with the socket that opened them".
pub async fn close_all(ctx: &Arc<ConnCtx>) {
    let codes: Vec<String> = ctx
        .tunnels
        .lock()
        .map(|g| g.keys().cloned().collect())
        .unwrap_or_default();
    for code in codes {
        if let Err(e) = close(ctx, &code).await {
            warn!(target: "session_live", "tunnel close {code}: {e}");
        }
    }
    if let Ok(mut g) = ctx.open_ports.lock() {
        g.clear();
    }
}

pub fn list(ctx: &Arc<ConnCtx>) -> Vec<TunnelInfo> {
    ctx.tunnels
        .lock()
        .map(|g| {
            g.values()
                .map(|r| TunnelInfo::from_record(&ctx.external_id, r))
                .collect()
        })
        .unwrap_or_default()
}

/// Reconcile against `GET /api/v2/sessions/{id}/tunnels` and return the agreed
/// list.
///
/// The cloud owns that endpoint; this desktop owns keeping it truthful, and the
/// two can drift in both directions:
///
///  * a code the cloud no longer lists is dropped here, and the port stops
///    being proxyable — the safe direction, taken without asking;
///  * a code the cloud lists that we have no record of is *reported*, not
///    adopted. Adopting it would mean serving a port on the say-so of a
///    response, which is exactly the trust this proxy must not extend.
///
/// A failed call leaves local state alone and surfaces the error; a network
/// blip is not a reason to tear down working tunnels.
pub async fn reconcile(ctx: &Arc<ConnCtx>) -> Result<Vec<TunnelInfo>, String> {
    let remote = super::http::tunnels(&ctx.origin, &ctx.token, &ctx.external_id).await?;
    let remote_codes: std::collections::HashSet<String> =
        remote.iter().map(|t| t.code.clone()).collect();

    let stale: Vec<String> = ctx
        .tunnels
        .lock()
        .map(|g| {
            g.keys()
                .filter(|c| !remote_codes.contains(*c))
                .cloned()
                .collect()
        })
        .unwrap_or_default();
    for code in stale {
        if let Some(port) = forget(ctx, &code) {
            warn!(
                target: "session_live",
                "tunnel {code} (port {port}) is gone from the cloud — no longer proxying it"
            );
            ctx.emit_scoped(
                super::EV_TUNNEL_CLOSED,
                serde_json::json!({ "code": code, "port": port, "reason": "reaped" }),
            );
        }
    }

    let known: std::collections::HashSet<String> = ctx
        .tunnels
        .lock()
        .map(|g| g.keys().cloned().collect())
        .unwrap_or_default();
    for t in &remote {
        if !known.contains(&t.code) {
            warn!(
                target: "session_live",
                "cloud lists tunnel {} (port {}) that this desktop never opened — not serving it",
                t.code, t.port
            );
        }
    }

    Ok(list(ctx))
}

/// Serve one `tunnel_req` off the pump task, so a slow local server cannot
/// stall the transcript everyone else is watching.
pub fn spawn_serve(ctx: Arc<ConnCtx>, req: TunnelReqFrame) {
    tauri::async_runtime::spawn(async move {
        let id = req.id.clone();
        match serve(&ctx, req).await {
            Ok(frame) => ctx.send(frame),
            Err(msg) => {
                // Always answer. A dropped `tunnel_req` leaves the teammate's
                // browser spinning with no explanation.
                warn!(target: "session_live", "tunnel_req {id}: {msg}");
                ctx.send(bad_gateway(id, &msg));
            }
        }
    });
}

async fn serve(ctx: &Arc<ConnCtx>, req: TunnelReqFrame) -> Result<ClientFrame, String> {
    if !ctx.is_host() {
        return Err("this desktop is not the session host".into());
    }
    let port = resolve_port(ctx, &req)?;
    let url = loopback_url(port, &req.path)?;

    let method = reqwest::Method::from_bytes(req.method.trim().as_bytes())
        .map_err(|_| format!("unsupported method {}", req.method))?;

    let body = match req.body_b64.as_deref() {
        Some(b64) if !b64.is_empty() => {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(b64)
                .map_err(|e| format!("bad body_b64: {e}"))?;
            if bytes.len() > MAX_BODY {
                return Err(format!("request body over {MAX_BODY} bytes"));
            }
            Some(bytes)
        }
        _ => None,
    };

    let client = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        // A dev server that redirects to an external host must not drag this
        // proxy off loopback. Hand the redirect back to the browser instead.
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("client build: {e}"))?;

    let mut request = client.request(method, url);
    for (name, value) in &req.headers {
        let lower = name.to_ascii_lowercase();
        if HOP_BY_HOP_REQUEST.contains(&lower.as_str()) {
            continue;
        }
        let Ok(header_name) = reqwest::header::HeaderName::from_bytes(name.as_bytes()) else {
            continue;
        };
        let Ok(header_value) = reqwest::header::HeaderValue::from_str(value) else {
            continue;
        };
        request = request.header(header_name, header_value);
    }
    if let Some(bytes) = body {
        request = request.body(bytes);
    }

    let resp = request
        .send()
        .await
        .map_err(|e| format!("loopback request failed: {e}"))?;

    let status = resp.status().as_u16();
    let mut headers: BTreeMap<String, String> = BTreeMap::new();
    for (name, value) in resp.headers().iter() {
        let lower = name.as_str().to_ascii_lowercase();
        if HOP_BY_HOP_RESPONSE.contains(&lower.as_str()) {
            continue;
        }
        if let Ok(v) = value.to_str() {
            headers.insert(lower, v.to_string());
        }
    }

    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("loopback body: {e}"))?;
    if bytes.len() > MAX_BODY {
        return Err(format!(
            "response is {} bytes, over the {MAX_BODY}-byte tunnel limit",
            bytes.len()
        ));
    }
    let body_b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);

    Ok(ClientFrame::TunnelRes {
        id: req.id,
        status,
        headers,
        body_b64: Some(body_b64),
    })
}

/// Which loopback port this request belongs to.
///
/// The documented `tunnel_req` carries neither a port nor a code, which leaves
/// the host guessing once a second tunnel is open. We accept either field,
/// prefer the explicit port, and fall back to the single open tunnel only when
/// there is exactly one — an ambiguous request is refused rather than served
/// from whichever port happened to sort first.
fn resolve_port(ctx: &Arc<ConnCtx>, req: &TunnelReqFrame) -> Result<u16, String> {
    if let Some(port) = req.port {
        return if is_open(ctx, port) {
            Ok(port)
        } else {
            Err(format!("port {port} was never opened for tunnelling"))
        };
    }
    if let Some(code) = req.code.as_deref() {
        let port = ctx
            .tunnels
            .lock()
            .ok()
            .and_then(|g| g.get(code).map(|r| r.port))
            .ok_or_else(|| format!("no tunnel open for code {code}"))?;
        return if is_open(ctx, port) {
            Ok(port)
        } else {
            Err(format!("port {port} was never opened for tunnelling"))
        };
    }
    let open: Vec<u16> = ctx
        .open_ports
        .lock()
        .map(|g| g.iter().copied().collect())
        .unwrap_or_default();
    match open.len() {
        1 => Ok(open[0]),
        0 => Err("no tunnel is open on this desktop".into()),
        n => Err(format!(
            "tunnel_req carried neither `code` nor `port` and {n} tunnels are open — refusing to guess"
        )),
    }
}

fn is_open(ctx: &Arc<ConnCtx>, port: u16) -> bool {
    ctx.open_ports
        .lock()
        .map(|g| g.contains(&port))
        .unwrap_or(false)
}

/// Build `http://127.0.0.1:<port><path>` without ever letting `path` touch the
/// authority. See the module header for why the obvious `format!` is a hole.
fn loopback_url(port: u16, raw_path: &str) -> Result<url::Url, String> {
    let mut url = url::Url::parse(&format!("http://127.0.0.1:{port}/"))
        .map_err(|e| format!("loopback base: {e}"))?;

    // Drop any fragment (never sent on the wire anyway) and split the query off
    // so both halves go through the API that percent-encodes them.
    let no_fragment = raw_path.split('#').next().unwrap_or("");
    let (path, query) = match no_fragment.split_once('?') {
        Some((p, q)) => (p, Some(q)),
        None => (no_fragment, None),
    };
    let path = if path.starts_with('/') {
        path.to_string()
    } else {
        format!("/{path}")
    };
    url.set_path(&path);
    url.set_query(query);

    // Belt and braces. If any of this drifted, we would rather serve nothing
    // than serve somebody else's host from inside the user's network.
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || url.port_or_known_default() != Some(port)
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(format!("refusing to proxy to {url} — not loopback"));
    }
    Ok(url)
}

fn bad_gateway(id: String, message: &str) -> ClientFrame {
    let mut headers = BTreeMap::new();
    headers.insert(
        "content-type".to_string(),
        "text/plain; charset=utf-8".to_string(),
    );
    let body = format!("Aura tunnel: {message}\n");
    ClientFrame::TunnelRes {
        id,
        status: 502,
        headers,
        body_b64: Some(base64::engine::general_purpose::STANDARD.encode(body.as_bytes())),
    }
}

// ── commands ───────────────────────────────────────────────────────────────

/// Open a local port to the people in this session. Returns both the real
/// auth'd URL and the `aura://localhost:<port>` display form.
#[tauri::command]
pub async fn session_live_tunnel_open(
    state: tauri::State<'_, super::SessionLiveState>,
    session_id: String,
    port: u16,
    label: Option<String>,
) -> Result<TunnelInfo, String> {
    let ctx = super::session::ctx_for(&state, &session_id).await?;
    let label = label
        .filter(|l| !l.trim().is_empty())
        .unwrap_or_else(|| format!("localhost:{port}"));
    open(&ctx, port, label).await
}

#[tauri::command]
pub async fn session_live_tunnel_close(
    state: tauri::State<'_, super::SessionLiveState>,
    session_id: String,
    code: String,
) -> Result<(), String> {
    let ctx = super::session::ctx_for(&state, &session_id).await?;
    close(&ctx, &code).await
}

/// The tunnels this session is serving.
///
/// `refresh` reconciles against the cloud's list first, dropping anything it no
/// longer knows about. Off by default because the UI calls this on every render
/// of the share sheet and a network round trip per render is a poor trade for a
/// list that changes only when the user clicks a button.
#[tauri::command]
pub async fn session_live_tunnels(
    state: tauri::State<'_, super::SessionLiveState>,
    session_id: String,
    refresh: Option<bool>,
) -> Result<Vec<TunnelInfo>, String> {
    let ctx = super::session::ctx_for(&state, &session_id).await?;
    if refresh.unwrap_or(false) {
        return reconcile(&ctx).await;
    }
    Ok(list(&ctx))
}

#[cfg(test)]
mod tests {
    use super::loopback_url;

    #[test]
    fn ordinary_paths_stay_on_loopback() {
        let u = loopback_url(3000, "/index.html").unwrap();
        assert_eq!(u.as_str(), "http://127.0.0.1:3000/index.html");
        let u = loopback_url(3000, "/a/b?x=1&y=2").unwrap();
        assert_eq!(u.host_str(), Some("127.0.0.1"));
        assert_eq!(u.query(), Some("x=1&y=2"));
    }

    #[test]
    fn a_missing_leading_slash_is_not_a_way_out() {
        let u = loopback_url(3000, "index.html").unwrap();
        assert_eq!(u.as_str(), "http://127.0.0.1:3000/index.html");
    }

    #[test]
    fn userinfo_injection_cannot_move_the_host() {
        // The whole reason this function exists: with a naive `format!` this
        // path turns `127.0.0.1:3000` into userinfo and targets evil.com.
        let u = loopback_url(3000, "@evil.com/pwn").unwrap();
        assert_eq!(u.host_str(), Some("127.0.0.1"));
        assert_eq!(u.port_or_known_default(), Some(3000));
        assert!(u.username().is_empty());
    }

    #[test]
    fn a_protocol_relative_path_stays_a_path() {
        let u = loopback_url(3000, "//evil.com/x").unwrap();
        assert_eq!(u.host_str(), Some("127.0.0.1"));
    }

    #[test]
    fn fragments_are_dropped_not_forwarded() {
        let u = loopback_url(8080, "/x#/../../etc/passwd").unwrap();
        assert_eq!(u.host_str(), Some("127.0.0.1"));
        assert_eq!(u.fragment(), None);
        assert_eq!(u.path(), "/x");
    }

    #[test]
    fn port_80_still_resolves_to_the_port_we_opened() {
        // `Url::port()` is None for a scheme's default port; the check has to
        // use `port_or_known_default` or every port-80 tunnel would be refused.
        let u = loopback_url(80, "/").unwrap();
        assert_eq!(u.port_or_known_default(), Some(80));
    }
}
