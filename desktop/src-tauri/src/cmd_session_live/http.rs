//! The HTTP endpoints that surround the live socket: sharing, previewing a
//! code, changing a participant's access, and reading the cloud's tunnel list.
//!
//! These are separate from `conn.rs` because they answer questions you have
//! *before* a socket exists — "what link do I hand someone", "whose machine am
//! I about to act on" — and because the link a share produces is the cloud's to
//! mint, not this desktop's to invent. A desktop-invented link is a link the
//! cloud cannot resolve, which is a share that looks like it worked.
//!
//! Every call carries the same bearer and is subject to the same repo
//! membership as the socket, so nothing here widens what a user can reach.

use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::protocol::{Participant, TunnelSummary};
use crate::cloud_org::OrgScoped;

/// These are all small control-plane calls against the user's own cloud. A
/// short ceiling keeps a wedged endpoint from freezing the share dialog.
const HTTP_TIMEOUT: Duration = Duration::from_secs(15);

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(HTTP_TIMEOUT)
        .build()
        .map_err(|e| format!("http client: {e}"))
}

/// `POST /api/v2/sessions/{external_id}/share` — the response.
#[derive(Deserialize, Serialize, Debug, Clone, Default)]
pub struct ShareResp {
    #[serde(default)]
    pub code: String,
    #[serde(default)]
    pub link: String,
    #[serde(default)]
    pub default_access: String,
}

/// Who is on the other end, as `GET /join/{code}/preview` reports them.
#[derive(Deserialize, Serialize, Debug, Clone, Default)]
pub struct PreviewHost {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub machine: String,
}

/// `GET /api/v2/sessions/join/{code}/preview`.
///
/// The preview exists so joining is an informed act: you see whose machine you
/// are about to act on, who else is in there, and what you will be allowed to
/// do — before the socket opens.
#[derive(Deserialize, Serialize, Debug, Clone, Default)]
pub struct JoinPreview {
    #[serde(default)]
    pub external_id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub host: PreviewHost,
    #[serde(default)]
    pub participants: Vec<Participant>,
    #[serde(default)]
    pub host_online: bool,
    #[serde(default)]
    pub your_access: String,
    /// Echoed back so the UI can show what it resolved from.
    #[serde(default)]
    pub code: String,
}

#[derive(Deserialize, Default)]
struct TunnelsResp {
    #[serde(default)]
    tunnels: Vec<TunnelSummary>,
}

/// Turn a non-2xx into an error a person can act on. The body is included
/// because the cloud puts the reason there ("not a member of this repo") and
/// swallowing it leaves the UI showing a bare status code.
async fn ensure_ok(resp: reqwest::Response, what: &str) -> Result<reqwest::Response, String> {
    if resp.status().is_success() {
        return Ok(resp);
    }
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    let body = body.trim();
    if body.is_empty() {
        Err(format!("{what}: HTTP {status}"))
    } else {
        Err(format!("{what}: HTTP {status}: {body}"))
    }
}

/// Start (or re-read) the share for a session and get back the link to hand out.
pub async fn share(
    origin: &str,
    token: &str,
    external_id: &str,
    default_access: &str,
) -> Result<ShareResp, String> {
    let url = format!(
        "{}/api/v2/sessions/{}/share",
        origin.trim_end_matches('/'),
        external_id
    );
    let resp = client()?
        .post(&url)
        .bearer_auth(token)
        .org_scoped()
        .json(&serde_json::json!({ "default_access": default_access }))
        .send()
        .await
        .map_err(|e| format!("POST {url}: {e}"))?;
    let resp = ensure_ok(resp, "share").await?;
    let mut parsed: ShareResp = resp
        .json()
        .await
        .map_err(|e| format!("share: bad response: {e}"))?;
    // A server that accepts the request but omits the level it applied would
    // otherwise leave the UI claiming a default it never set.
    if parsed.default_access.is_empty() {
        parsed.default_access = default_access.to_string();
    }
    Ok(parsed)
}

/// Read the share for a session WITHOUT creating one. `None` means it is not
/// shared.
///
/// This exists because the only other way to learn a session's share was to
/// POST, which mints one — so a host reopening the app could either be told
/// "still private" about a session that is in fact shared, or have the act of
/// looking quietly share it. Both are lies, and one of them is a lie that lets
/// people in.
///
/// A 404 is the cloud's answer both for "not shared" and for "you have no
/// business knowing about this session", deliberately: the same reasoning as
/// the join preview, where a wrong code and someone else's code must not be
/// distinguishable.
pub async fn share_status(
    origin: &str,
    token: &str,
    external_id: &str,
) -> Result<Option<ShareResp>, String> {
    let url = format!(
        "{}/api/v2/sessions/{}/share",
        origin.trim_end_matches('/'),
        external_id
    );
    let resp = client()?
        .get(&url)
        .bearer_auth(token)
        .org_scoped()
        .send()
        .await
        .map_err(|e| format!("GET {url}: {e}"))?;
    if resp.status().as_u16() == 404 {
        return Ok(None);
    }
    let resp = ensure_ok(resp, "share status").await?;
    let parsed: ShareResp = resp
        .json()
        .await
        .map_err(|e| format!("share status: bad response: {e}"))?;
    // A share with no code is not a share anyone can use, and reporting it as
    // one would put an empty "Or read them this code" field on screen.
    if parsed.code.trim().is_empty() {
        return Ok(None);
    }
    Ok(Some(parsed))
}

/// Stop sharing. The live socket is unaffected — people already in the session
/// stay in it; the link simply stops admitting anyone new.
pub async fn unshare(origin: &str, token: &str, external_id: &str) -> Result<(), String> {
    let url = format!(
        "{}/api/v2/sessions/{}/share",
        origin.trim_end_matches('/'),
        external_id
    );
    let resp = client()?
        .delete(&url)
        .bearer_auth(token)
        .org_scoped()
        .send()
        .await
        .map_err(|e| format!("DELETE {url}: {e}"))?;
    // 404 means it is already not shared, which is the state the caller wanted.
    if resp.status().as_u16() == 404 {
        return Ok(());
    }
    ensure_ok(resp, "unshare").await.map(|_| ())
}

/// Resolve a share code to the session behind it, without joining.
///
/// A 404 is returned by the cloud both for a code that does not exist and for
/// one belonging to another org, so a wrong code and someone else's code are
/// deliberately indistinguishable here too.
pub async fn preview(origin: &str, token: &str, code: &str) -> Result<JoinPreview, String> {
    let code = code.trim();
    if code.is_empty() {
        return Err("no share code to preview".into());
    }
    // Through the URL API rather than `format!`, so a code carrying `/` or `?`
    // cannot reshape the request path.
    let mut url = url::Url::parse(origin.trim_end_matches('/'))
        .map_err(|e| format!("bad cloud origin {origin}: {e}"))?;
    url.set_path(&format!("/api/v2/sessions/join/{code}/preview"));
    let resp = client()?
        .get(url.as_str())
        .bearer_auth(token)
        .org_scoped()
        .send()
        .await
        .map_err(|e| format!("GET {url}: {e}"))?;
    let resp = ensure_ok(resp, "preview").await?;
    let mut parsed: JoinPreview = resp
        .json()
        .await
        .map_err(|e| format!("preview: bad response: {e}"))?;
    if parsed.external_id.trim().is_empty() {
        return Err("preview returned no session id".into());
    }
    parsed.code = code.to_string();
    Ok(parsed)
}

/// Host-only: promote or demote a participant. Takes effect on their live
/// socket immediately and lands in the next `presence`.
pub async fn set_access(
    origin: &str,
    token: &str,
    external_id: &str,
    participant_id: &str,
    access: &str,
) -> Result<(), String> {
    let mut url = url::Url::parse(origin.trim_end_matches('/'))
        .map_err(|e| format!("bad cloud origin {origin}: {e}"))?;
    url.set_path(&format!(
        "/api/v2/sessions/{external_id}/participants/{participant_id}/access"
    ));
    let resp = client()?
        .patch(url.as_str())
        .bearer_auth(token)
        .org_scoped()
        .json(&serde_json::json!({ "access": access }))
        .send()
        .await
        .map_err(|e| format!("PATCH {url}: {e}"))?;
    ensure_ok(resp, "set access").await.map(|_| ())
}

/// What the cloud believes is tunnelled for this session.
pub async fn tunnels(
    origin: &str,
    token: &str,
    external_id: &str,
) -> Result<Vec<TunnelSummary>, String> {
    let url = format!(
        "{}/api/v2/sessions/{}/tunnels",
        origin.trim_end_matches('/'),
        external_id
    );
    let resp = client()?
        .get(&url)
        .bearer_auth(token)
        .org_scoped()
        .send()
        .await
        .map_err(|e| format!("GET {url}: {e}"))?;
    let resp = ensure_ok(resp, "tunnels").await?;
    let parsed: TunnelsResp = resp
        .json()
        .await
        .map_err(|e| format!("tunnels: bad response: {e}"))?;
    Ok(parsed.tunnels)
}
