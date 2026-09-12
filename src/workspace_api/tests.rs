//! No network: URL building, auth order, exit codes and rendering are all
//! pure functions, and that is deliberate — every one of them is a contract
//! an agent scripts against.

use std::collections::HashMap;

use serde_json::json;

use super::client::{
    classify, endpoint, has_reply, latest_cursor, messages_query, resolve_auth_with, url_encode,
    ApiError, CreateRequest, TokenSource, API_KEY_ENV, DEFAULT_ORIGIN,
};
use super::output;
use crate::cloud_endpoint::{TOKEN_ENV, URL_ENV};

fn env(pairs: &[(&str, &str)]) -> HashMap<String, String> {
    pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
}

fn resolve(
    vars: &HashMap<String, String>,
    cfg_url: Option<&str>,
    cfg_token: Option<&str>,
) -> Result<super::client::Auth, ApiError> {
    resolve_auth_with(&|k| vars.get(k).cloned(), cfg_url, cfg_token)
}

// ── URL building ─────────────────────────────────────────────────────────

#[test]
fn endpoints_live_under_the_public_prefix_and_never_double_slash() {
    assert_eq!(
        endpoint("https://api.auravcs.com", "/workspaces"),
        "https://api.auravcs.com/api/v2/public/workspaces"
    );
    assert_eq!(
        endpoint("http://localhost:3011/", "/whoami"),
        "http://localhost:3011/api/v2/public/whoami"
    );
}

#[test]
fn messages_query_omits_what_was_not_asked_and_escapes_the_cursor() {
    assert_eq!(messages_query(None, None), "");
    assert_eq!(messages_query(None, Some(50)), "?limit=50");
    assert_eq!(
        messages_query(Some("2026-09-07T10:00:00+00:00"), None),
        "?since=2026-09-07T10%3A00%3A00%2B00%3A00"
    );
    assert_eq!(
        messages_query(Some("  "), Some(5)),
        "?limit=5",
        "a blank cursor is no cursor"
    );
}

#[test]
fn url_encoding_keeps_ids_and_escapes_everything_else() {
    assert_eq!(url_encode("6f1c-abc_D.~"), "6f1c-abc_D.~");
    assert_eq!(url_encode("a b/c"), "a%20b%2Fc");
}

// ── Auth resolution order ────────────────────────────────────────────────

#[test]
fn api_key_env_wins_over_everything() {
    let vars = env(&[
        (API_KEY_ENV, "aura_ak_agent"),
        (TOKEN_ENV, "aura_cloud_token"),
        (URL_ENV, "https://staging.example"),
    ]);
    let a = resolve(&vars, Some("https://api.auravcs.com"), Some("aura_signed_in")).unwrap();
    assert_eq!(a.token, "aura_ak_agent");
    assert_eq!(a.source, TokenSource::ApiKeyEnv);
    assert_eq!(a.origin, "https://staging.example", "the env URL still names the cloud");
}

#[test]
fn cloud_token_env_is_second() {
    let vars = env(&[(TOKEN_ENV, "aura_cloud_token")]);
    let a = resolve(&vars, None, Some("aura_signed_in")).unwrap();
    assert_eq!(a.token, "aura_cloud_token");
    assert_eq!(a.source, TokenSource::CloudTokenEnv);
    assert_eq!(a.origin, DEFAULT_ORIGIN);
}

#[test]
fn signed_in_token_follows_the_signed_in_url_only() {
    let vars = env(&[]);
    let a = resolve(&vars, Some("https://api.auravcs.com/"), Some("aura_signed_in")).unwrap();
    assert_eq!(a.token, "aura_signed_in");
    assert_eq!(a.source, TokenSource::SignedIn);
    assert_eq!(a.origin, "https://api.auravcs.com", "trailing slash trimmed");

    // Pointing at another cloud without naming a token must NOT leak the
    // production bearer — same contract as `cloud_endpoint::token`.
    let vars = env(&[(URL_ENV, "https://staging.example")]);
    assert_eq!(
        resolve(&vars, Some("https://api.auravcs.com"), Some("aura_signed_in")),
        Err(ApiError::NoAuth)
    );
}

#[test]
fn blank_env_values_count_as_unset() {
    let vars = env(&[(API_KEY_ENV, "   "), (TOKEN_ENV, ""), (URL_ENV, " ")]);
    let a = resolve(&vars, Some("https://api.auravcs.com"), Some("aura_signed_in")).unwrap();
    assert_eq!(a.source, TokenSource::SignedIn);
    assert_eq!(a.origin, "https://api.auravcs.com");
}

#[test]
fn nothing_configured_is_no_auth() {
    assert_eq!(resolve(&env(&[]), None, None), Err(ApiError::NoAuth));
    assert_eq!(ApiError::NoAuth.exit_code(), 2);
    assert!(ApiError::NoAuth.message().contains(API_KEY_ENV));
}

// ── Exit-code mapping ────────────────────────────────────────────────────

#[test]
fn status_codes_map_to_the_documented_exit_codes() {
    assert_eq!(classify(200, r#"{"id":"w"}"#.into()).unwrap()["id"], "w");
    assert_eq!(classify(204, "".into()).unwrap(), serde_json::Value::Null);

    let e = classify(401, r#"{"error":"bad key"}"#.into()).unwrap_err();
    assert_eq!(e.exit_code(), 2);
    assert_eq!(e.message(), "HTTP 401: bad key");

    let e = classify(403, "".into()).unwrap_err();
    assert_eq!(e.exit_code(), 2);

    let e = classify(404, r#"{"error":"workspace not found"}"#.into()).unwrap_err();
    assert_eq!(e.exit_code(), 3);
    assert_eq!(e.message(), "workspace not found");

    let e = classify(409, r#"{"error":"workspace is archived"}"#.into()).unwrap_err();
    assert_eq!(e.exit_code(), 1);
    assert_eq!(e.message(), "HTTP 409: workspace is archived");

    let e = classify(500, "boom".into()).unwrap_err();
    assert_eq!(e.exit_code(), 1);
    assert_eq!(e.message(), "HTTP 500: boom");

    let e = classify(200, "not json".into()).unwrap_err();
    assert!(matches!(e, ApiError::Parse(_)));
    assert_eq!(e.exit_code(), 1);
}

// ── Request bodies ───────────────────────────────────────────────────────

#[test]
fn create_body_sends_only_what_was_given_and_maps_title_to_objective() {
    let req = CreateRequest {
        repo: Some("acme/shop".into()),
        title: Some("checkout split".into()),
        intent: Some("parallelise the mobile checkout work".into()),
        model: Some("  ".into()),
        ..Default::default()
    };
    let body = req.body();
    assert_eq!(body["repo"], "acme/shop");
    assert_eq!(body["objective"], "checkout split");
    assert_eq!(body["intent"], "parallelise the mobile checkout work");
    assert!(body.get("model").is_none(), "blank is absent");
    assert!(body.get("branch").is_none());
    assert!(body.get("prompt").is_none());
}

// ── Polling helpers ──────────────────────────────────────────────────────

#[test]
fn a_reply_is_any_turn_that_is_not_the_users_own() {
    let only_prompt = json!([{ "role": "user", "body": "hi", "created_at": "2026-09-07T10:00:00Z" }]);
    assert!(!has_reply(&only_prompt));
    let with_reply = json!([
        { "role": "user", "body": "hi", "created_at": "2026-09-07T10:00:00Z" },
        { "role": "assistant", "body": "hello", "created_at": "2026-09-07T10:00:05Z" }
    ]);
    assert!(has_reply(&with_reply));
    assert_eq!(latest_cursor(&with_reply).as_deref(), Some("2026-09-07T10:00:05Z"));
    assert_eq!(latest_cursor(&json!([])), None);
    assert!(!has_reply(&json!(null)));
}

// ── Rendering ────────────────────────────────────────────────────────────

#[test]
fn workspace_rendering_leads_with_the_id_and_carries_the_intent() {
    let v = json!({
        "id": "ws-1", "status": "running", "objective": "checkout split",
        "intent": "parallelise the mobile checkout work", "branch": "main",
        "created_at": "2026-09-07T10:00:00Z"
    });
    let out = output::render_workspace(&v);
    let lines: Vec<&str> = out.lines().collect();
    assert!(lines[0].starts_with("  id"), "{out}");
    assert!(lines[0].contains("ws-1"));
    assert!(out.contains("intent     parallelise the mobile checkout work"));
    assert!(out.contains("branch     main"));
    assert!(!out.contains("model"), "absent fields are not printed");
}

#[test]
fn list_rendering_prefers_intent_over_title_and_handles_empty() {
    assert_eq!(output::render_workspace_list(&json!([])), "  no workspaces");
    let v = json!([
        { "id": "a", "status": "running", "objective": "t", "intent": "why" },
        { "id": "b", "status": "sleeping", "objective": "only title" },
        { "id": "c", "status": "archived" }
    ]);
    let out = output::render_workspace_list(&v);
    let lines: Vec<&str> = out.lines().collect();
    assert_eq!(lines.len(), 3);
    assert!(lines[0].contains("why") && !lines[0].contains(" t"));
    assert!(lines[1].contains("only title"));
    assert!(lines[2].contains("(untitled)"));
}

#[test]
fn messages_rendering_is_one_line_per_turn_with_continuations_indented() {
    assert_eq!(output::render_messages(&json!([])), "  no messages");
    let v = json!([
        { "role": "user", "body": "hi", "created_at": "2026-09-07T10:00:00Z" },
        { "role": "assistant", "body": "line one\nline two", "created_at": "2026-09-07T10:00:05Z" }
    ]);
    let out = output::render_messages(&v);
    let lines: Vec<&str> = out.lines().collect();
    assert_eq!(lines.len(), 3);
    assert!(lines[0].contains("user") && lines[0].ends_with("hi"));
    assert!(lines[1].contains("assistant") && lines[1].ends_with("line one"));
    assert!(lines[2].trim() == "line two");
}

#[test]
fn models_and_whoami_render_plainly() {
    let models = json!({
        "models": [
            { "id": "claude-sonnet-4-6", "provider": "anthropic", "tier": "deep", "available": true },
            { "id": "gpt-4o", "provider": "openai", "tier": "deep", "available": false }
        ],
        "default_provider": "anthropic",
        "catalog_url": "https://auravcs.com/models/catalog.json"
    });
    let out = output::render_models(&models);
    assert!(out.contains("claude-sonnet-4-6") && out.contains("key configured"));
    assert!(out.contains("gpt-4o") && out.contains("no key"));
    assert!(out.contains("default provider: anthropic"));

    let who = json!({
        "user": { "id": "u1", "login": "ashiq" },
        "org": { "id": "o1", "slug": "naridon", "name": "Naridon" },
        "key": { "kind": "org_api_key", "label": "ci", "scopes": ["places:run", "repo:read"], "unrestricted": false },
        "token_source": "AURA_API_KEY"
    });
    let out = output::render_whoami(&who);
    assert!(out.contains("ashiq (u1)"));
    assert!(out.contains("naridon (Naridon)"));
    assert!(out.contains("org_api_key \"ci\""));
    assert!(out.contains("places:run, repo:read"));
    assert!(out.contains("AURA_API_KEY"));

    let human = json!({
        "user": { "id": "u1" }, "org": { "slug": "n", "name": "N" },
        "key": { "kind": "api_token", "scopes": [], "unrestricted": true }
    });
    assert!(output::render_whoami(&human).contains("unrestricted"));
}

#[test]
fn prompt_ack_shows_the_queued_id_and_status() {
    let out = output::render_prompt_ack(&json!({ "id": "m1", "status": "running" }));
    assert_eq!(out, "  queued  m1  (running)");
}
