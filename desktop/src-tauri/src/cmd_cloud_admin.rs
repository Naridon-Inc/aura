//! The org's own settings, run from the desktop: its API keys, its plan
//! (checkout and the billing portal), and making a new organization.
//!
//! Each command is one request to an endpoint the web console already uses,
//! with the signed-in token the renderer never sees. The server decides who
//! may do what (minting and revoking keys is admin-only, checkout needs a
//! configured price); its refusals come back as its own sentence.

use reqwest::Method;
use serde_json::{json, Value};

use crate::cloud_org::OrgScoped;
use crate::cloud_session_sync::{cloud_origin, cloud_token, read_credentials};
use crate::cmd_cloud_members::{http_client, server_message, signed_in_org};

/// Send one request and hand back its JSON. A 2xx whose body is
/// `{"error": …}` is a refusal too: billing and org creation answer that way.
pub(crate) async fn send(method: Method, url: String, token: &str, body: Option<Value>) -> Result<Value, String> {
    let mut req = http_client()?.request(method.clone(), &url).bearer_auth(token).org_scoped();
    if let Some(body) = body {
        req = req.json(&body);
    }
    let resp = req.send().await.map_err(|e| format!("{method} {url}: {e}"))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(server_message(status, &text));
    }
    if text.trim().is_empty() {
        return Ok(Value::Null);
    }
    let value: Value = serde_json::from_str(&text).map_err(|e| format!("parse: {e}"))?;
    if let Some(error) = refusal(&value) {
        return Err(error);
    }
    Ok(value)
}

/// The sentence in a `{"error": …}` body, if the body is one.
fn refusal(value: &Value) -> Option<String> {
    value
        .get("error")
        .and_then(|e| e.as_str())
        .map(str::trim)
        .filter(|e| !e.is_empty())
        .map(str::to_string)
}

/// The signed-in token and origin, for calls that are not org-scoped by path.
pub(crate) fn signed_in() -> Result<(String, String), String> {
    let creds = read_credentials().unwrap_or_default();
    let token = cloud_token(&creds).ok_or_else(|| "Sign in to Aura Cloud first.".to_string())?;
    Ok((token, cloud_origin(&creds)))
}

/// Where Stripe sends the browser back: a web address, nothing else.
pub(crate) fn return_url(raw: &str) -> Result<String, String> {
    let url = raw.trim();
    if url.starts_with("https://") || url.starts_with("http://") {
        Ok(url.trim_end_matches('/').to_string())
    } else {
        Err("Billing needs a web address to come back to.".to_string())
    }
}

/// The org's API keys, newest first as the server orders them.
#[tauri::command]
pub async fn cloud_api_keys() -> Result<Value, String> {
    let (token, slug, origin) = signed_in_org()?;
    let url = format!("{origin}/api/v2/orgs/{slug}/api-keys");
    let value = send(Method::GET, url, &token, None).await?;
    Ok(value.get("keys").cloned().unwrap_or_else(|| json!([])))
}

/// Mint a key. The answer carries the token once; it is never readable again.
#[tauri::command]
pub async fn cloud_api_key_create(label: String, scopes: Vec<String>) -> Result<Value, String> {
    let label = label.trim().to_string();
    if label.is_empty() {
        return Err("Name the key.".to_string());
    }
    if scopes.is_empty() {
        return Err("Pick at least one thing the key may do.".to_string());
    }
    let (token, slug, origin) = signed_in_org()?;
    let url = format!("{origin}/api/v2/orgs/{slug}/api-keys");
    send(Method::POST, url, &token, Some(json!({ "label": label, "scopes": scopes }))).await
}

/// Revoke a key. Anything holding it stops working on its next request.
#[tauri::command]
pub async fn cloud_api_key_revoke(id: String) -> Result<(), String> {
    let id = id.trim().to_string();
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err("Which key?".to_string());
    }
    let (token, slug, origin) = signed_in_org()?;
    let url = format!("{origin}/api/v2/orgs/{slug}/api-keys/{id}");
    send(Method::DELETE, url, &token, None).await.map(|_| ())
}

/// A Stripe checkout link for `plan` (pro or team) at `seats` seats. The
/// plan's cloud computer comes with it; `size` asks for a bigger one on
/// Teams, which the server prices and checks.
#[tauri::command]
pub async fn cloud_billing_checkout(
    plan: String,
    seats: Option<i32>,
    return_to: String,
    size: Option<String>,
) -> Result<String, String> {
    let plan = plan.trim().to_lowercase();
    if plan != "pro" && plan != "team" {
        return Err("Checkout sells Pro and Team.".to_string());
    }
    let size = size.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    if size.as_deref().is_some_and(|s| s.len() > 32 || !s.chars().all(|c| c.is_ascii_alphanumeric() || c == '.')) {
        return Err("Which size?".to_string());
    }
    let (token, origin) = signed_in()?;
    let body = json!({
        "plan": plan,
        "seats": seats.map(|s| s.max(1)),
        "size": size,
        "return_url": return_url(&return_to)?,
    });
    let value = send(Method::POST, format!("{origin}/api/v1/billing/checkout"), &token, Some(body)).await?;
    link_of(&value, "checkout_url", "Checkout did not return a payment link.")
}

/// The Stripe billing portal, for an org that already pays.
#[tauri::command]
pub async fn cloud_billing_portal(return_to: String) -> Result<String, String> {
    let (token, origin) = signed_in()?;
    let body = json!({ "return_url": return_url(&return_to)? });
    let value = send(Method::POST, format!("{origin}/api/v1/billing/portal"), &token, Some(body)).await?;
    link_of(&value, "portal_url", "The billing portal did not return a link.")
}

pub(crate) fn link_of(value: &Value, key: &str, missing: &str) -> Result<String, String> {
    value
        .get(key)
        .and_then(|u| u.as_str())
        .filter(|u| u.starts_with("https://"))
        .map(str::to_string)
        .ok_or_else(|| missing.to_string())
}

/// Make an organization; the server makes you its owner.
#[tauri::command]
pub async fn cloud_org_create(name: String, slug: String) -> Result<Value, String> {
    let name = name.trim().to_string();
    let slug = slug.trim().to_lowercase();
    if name.is_empty() {
        return Err("Name the organization.".to_string());
    }
    if !slug_ok(&slug) {
        return Err("The address takes 2–40 lowercase letters, digits and dashes.".to_string());
    }
    let (token, origin) = signed_in()?;
    let value = send(Method::POST, format!("{origin}/api/v1/orgs"), &token, Some(json!({ "name": name, "slug": slug }))).await?;
    value
        .get("organization")
        .cloned()
        .ok_or_else(|| "The organization was not created.".to_string())
}

fn slug_ok(slug: &str) -> bool {
    (2..=40).contains(&slug.len())
        && slug.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && !slug.starts_with('-')
        && !slug.ends_with('-')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_error_body_is_a_refusal() {
        assert_eq!(refusal(&json!({ "error": "Invalid plan" })).as_deref(), Some("Invalid plan"));
        assert_eq!(refusal(&json!({ "error": "  " })), None);
        assert_eq!(refusal(&json!({ "checkout_url": "https://x" })), None);
    }

    #[test]
    fn a_link_must_be_https() {
        let v = json!({ "checkout_url": "https://checkout.stripe.com/c/1" });
        assert_eq!(link_of(&v, "checkout_url", "no").unwrap(), "https://checkout.stripe.com/c/1");
        assert!(link_of(&json!({ "checkout_url": "javascript:1" }), "checkout_url", "no").is_err());
        assert!(link_of(&json!({}), "portal_url", "no").is_err());
    }

    #[test]
    fn slugs_and_return_urls() {
        assert!(slug_ok("acme-labs"));
        assert!(!slug_ok("a"));
        assert!(!slug_ok("-acme"));
        assert!(!slug_ok("Acme"));
        assert_eq!(return_url("https://app.auravcs.com/settings/").unwrap(), "https://app.auravcs.com/settings");
        assert!(return_url("file:///etc").is_err());
    }
}
