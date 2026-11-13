//! The one call, and what came back.
//!
//! Deliberately thin. `workspace_api::client` wraps each endpoint it knows
//! about and hands back parsed JSON; this hands back the status and the bytes,
//! because a passthrough that parsed the answer could not show a caller an
//! endpoint it had never heard of, or a reply that was not JSON at all.

use crate::workspace_api::client::Auth;

use super::request::Request;

/// A reply, unexamined.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Answer {
    pub status: u16,
    pub body: String,
}

/// Send `req` as `auth`.
///
/// The bearer is attached here and nowhere else, so there is exactly one line
/// in this command that can put a token on the wire. `Accept` is set for the
/// same reason the typed client sets it: a server that can answer either way
/// should answer in JSON unless the caller said otherwise, and a caller who
/// did say otherwise overrides it, because their `-H` is applied after.
pub fn send(
    http: &reqwest::blocking::Client,
    auth: &Auth,
    req: &Request,
) -> Result<Answer, String> {
    let method = reqwest::Method::from_bytes(req.method.as_bytes())
        .map_err(|e| format!("{}: {e}", req.method))?;
    let mut builder = http
        .request(method, &req.url)
        .header("Authorization", format!("Bearer {}", auth.token))
        .header("Accept", "application/json");
    for (name, value) in &req.headers {
        builder = builder.header(name, value);
    }
    if let Some(body) = &req.body {
        builder = builder
            .header("Content-Type", "application/json")
            .body(body.clone());
    }
    let resp = builder.send().map_err(|e| e.to_string())?;
    let status = resp.status().as_u16();
    let body = resp.text().map_err(|e| e.to_string())?;
    Ok(Answer { status, body })
}
