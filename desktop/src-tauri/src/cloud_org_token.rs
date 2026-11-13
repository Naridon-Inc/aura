//! The sign-in token is minted for one org; acting as another needs that
//! org's token.
//!
//! An `aura_` token is bound to the org it was minted in, and the server
//! refuses (403, empty body) any request whose `X-Aura-Org` names a different
//! one. The org switcher only ever wrote the new slug down, so after a switch
//! every org-scoped call failed: Home said it couldn't read the org's plan and
//! nothing on screen said why. Switching now mints a token for the org it
//! moves to (`POST /api/v1/auth/token`, which checks membership), and a
//! credentials file that already disagrees with itself is mended on the next
//! read: a token for the chosen org when you still belong to it, else the
//! chosen org becomes the one the token is for.
//!
//! A session token (anything not `aura_`) is not bound to an org and is left
//! alone, as are org keys and runner tokens, which never switch.

use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde_json::Value;

use crate::cloud_org::{active_org, remember_org, CloudOrg};
use crate::cloud_session_sync::{cloud_origin, cloud_token, read_credentials, write_credentials};

const TIMEOUT: Duration = Duration::from_secs(10);

/// What the label on a token minted here says in the account's token list.
const LABEL: &str = "Aura desktop";

/// The cloud's other `aura_…` credentials: org keys, runner, node, ticket,
/// connection and routine secrets. None of them is a person's to move.
const NOT_A_PERSONS: [&str; 6] = ["aura_ak_", "aura_runner_", "aura_node_", "aura_ticket_", "aura_conn_", "aura_rt_"];

/// Whether this token is one minted for a single org that a person can move
/// between: a human `aura_` token, not an org key or a machine's.
pub(crate) fn is_org_bound(token: &str) -> bool {
    token.starts_with("aura_") && !NOT_A_PERSONS.iter().any(|p| token.starts_with(p))
}

/// The org a whoami answer says the token acts in.
pub(crate) fn org_of_whoami(body: &str) -> Result<CloudOrg, String> {
    let v: Value = serde_json::from_str(body).map_err(|e| format!("whoami: {e}"))?;
    let org = v.get("org").ok_or("whoami named no org")?;
    let field = |k: &str| org.get(k).and_then(Value::as_str).map(str::trim).unwrap_or("").to_string();
    let (id, slug, name) = (field("id"), field("slug"), field("name"));
    if slug.is_empty() || id.is_empty() {
        return Err("whoami named no org".into());
    }
    let name = if name.is_empty() { slug.clone() } else { name };
    Ok(CloudOrg { id, slug, name, repo_count: 0, current: true })
}

/// The token a mint answered with. The endpoint says a refusal with a 200 and
/// an `error`, so a missing token is read as that error, never as success.
pub(crate) fn token_of_mint(body: &str) -> Result<String, String> {
    let v: Value = serde_json::from_str(body).map_err(|e| format!("token: {e}"))?;
    if let Some(token) = v.get("token").and_then(Value::as_str).map(str::trim).filter(|t| t.starts_with("aura_")) {
        return Ok(token.to_string());
    }
    Err(v.get("error").and_then(Value::as_str).unwrap_or("the cloud gave no token").to_string())
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder().timeout(TIMEOUT).build().map_err(|e| format!("http client: {e}"))
}

/// The org `token` acts in, asked with no org header so the answer is the
/// token's own.
async fn token_org(origin: &str, token: &str) -> Result<CloudOrg, String> {
    let resp = client()?
        .get(format!("{origin}/api/v2/public/whoami"))
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| format!("whoami: {e}"))?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| format!("whoami: {e}"))?;
    if !status.is_success() {
        return Err(format!("whoami said HTTP {status}"));
    }
    org_of_whoami(&body)
}

/// A token for `slug`, minted with the one in hand.
async fn mint(origin: &str, token: &str, slug: &str) -> Result<String, String> {
    let resp = client()?
        .post(format!("{origin}/api/v1/auth/token"))
        .bearer_auth(token)
        .json(&serde_json::json!({ "org_slug": slug, "label": LABEL }))
        .send()
        .await
        .map_err(|e| format!("token: {e}"))?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| format!("token: {e}"))?;
    if !status.is_success() {
        return Err(format!("the cloud said HTTP {status} to a token for {slug}"));
    }
    token_of_mint(&body)
}

/// The token and org slug last seen to agree, so a page load doesn't ask the
/// cloud again. Keyed by a digest of the token, never the token.
fn agreed() -> &'static Mutex<Option<(u64, String)>> {
    static AGREED: OnceLock<Mutex<Option<(u64, String)>>> = OnceLock::new();
    AGREED.get_or_init(|| Mutex::new(None))
}

fn digest(token: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    token.hash(&mut h);
    h.finish()
}

fn note_agreed(token: &str, slug: &str) {
    if let Ok(mut a) = agreed().lock() {
        *a = Some((digest(token), slug.to_string()));
    }
}

fn known_to_agree(token: &str, slug: &str) -> bool {
    agreed().lock().ok().and_then(|a| a.clone()).is_some_and(|(d, s)| d == digest(token) && s == slug)
}

fn keep_token(token: &str) -> Result<(), String> {
    let mut creds = read_credentials()?;
    creds.insert("cloud_api_token".into(), Value::String(token.to_string()));
    write_credentials(&creds)
}

/// Make the signed-in token act in `org`, then record `org` as the one the app
/// acts as. Nothing is written when the cloud won't give a token for it, so a
/// failed switch leaves the app where it was rather than half moved.
pub(crate) async fn act_as(org: &CloudOrg) -> Result<(), String> {
    let creds = read_credentials()?;
    let Some(token) = cloud_token(&creds) else {
        return remember_org(org);
    };
    if !is_org_bound(&token) {
        return remember_org(org);
    }
    let origin = cloud_origin(&creds);
    let theirs = token_org(&origin, &token).await?;
    if theirs.slug == org.slug {
        note_agreed(&token, &org.slug);
        return remember_org(org);
    }
    let fresh = mint(&origin, &token, &org.slug).await?;
    keep_token(&fresh)?;
    note_agreed(&fresh, &org.slug);
    remember_org(org)
}

/// Mend a credentials file whose token and chosen org disagree. A token for
/// the chosen org when the cloud will mint one; else the chosen org becomes
/// the token's, so the app works somewhere instead of nowhere. Quiet when they
/// already agree, and asks the cloud at most once per token and org.
pub(crate) async fn mend() -> Result<(), String> {
    let creds = read_credentials()?;
    let Some(token) = cloud_token(&creds) else { return Ok(()) };
    let Some(chosen) = active_org(&creds).slug else { return Ok(()) };
    if !is_org_bound(&token) || known_to_agree(&token, &chosen) {
        return Ok(());
    }
    let origin = cloud_origin(&creds);
    let theirs = token_org(&origin, &token).await?;
    if theirs.slug == chosen {
        note_agreed(&token, &chosen);
        return Ok(());
    }
    match mint(&origin, &token, &chosen).await {
        Ok(fresh) => {
            keep_token(&fresh)?;
            note_agreed(&fresh, &chosen);
            Ok(())
        }
        Err(why) => {
            tracing::warn!(target: "cloud::org", "no token for the chosen org, acting as the token's own: {why}");
            remember_org(&theirs)?;
            note_agreed(&token, &theirs.slug);
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_persons_aura_token_is_bound_to_an_org_they_can_leave() {
        assert!(is_org_bound("aura_1a2b3c"));
        assert!(!is_org_bound("aura_ak_live_key"));
        assert!(!is_org_bound("aura_runner_box"));
        assert!(!is_org_bound("aura_rt_routine"));
        assert!(!is_org_bound("eyJhbGciOiJIUzI1NiJ9.session.jwt"));
    }

    #[test]
    fn whoami_names_the_org_the_token_acts_in() {
        let body = r#"{"user":{"id":"u"},"org":{"id":"o1","slug":"aura-e2e-test","name":"Aura E2E Test"},"key":{}}"#;
        let org = org_of_whoami(body).unwrap();
        assert_eq!((org.id.as_str(), org.slug.as_str(), org.name.as_str()), ("o1", "aura-e2e-test", "Aura E2E Test"));
        let unnamed = org_of_whoami(r#"{"org":{"id":"o2","slug":"mhask","name":""}}"#).unwrap();
        assert_eq!(unnamed.name, "mhask");
        assert!(org_of_whoami(r#"{"org":{"id":"","slug":"x"}}"#).is_err());
        assert!(org_of_whoami(r#"{"user":{}}"#).is_err());
    }

    #[test]
    fn a_refused_mint_is_its_reason_never_a_token() {
        assert_eq!(token_of_mint(r#"{"token":"aura_new","message":"Save this token"}"#).unwrap(), "aura_new");
        assert_eq!(
            token_of_mint(r#"{"error":"Not a member of this organization"}"#).unwrap_err(),
            "Not a member of this organization"
        );
        assert!(token_of_mint(r#"{"token":""}"#).is_err());
        assert!(token_of_mint("not json").is_err());
    }

    #[test]
    fn agreement_is_remembered_per_token_and_org() {
        note_agreed("aura_one", "mhask");
        assert!(known_to_agree("aura_one", "mhask"));
        assert!(!known_to_agree("aura_one", "naridon"));
        assert!(!known_to_agree("aura_two", "mhask"));
    }
}
