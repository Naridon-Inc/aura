//! No network: URL building, auth order, exit codes and rendering are all
//! pure functions, and that is deliberate — every one of them is a contract
//! an agent scripts against.

use std::collections::HashMap;

use serde_json::{json, Value};

use super::client::{
    self, classify, endpoint, has_reply, latest_cursor, messages_query, resolve_auth_with,
    url_encode, ApiError, CreateRequest, TokenSource, API_KEY_ENV, DEFAULT_ORIGIN,
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
    assert_eq!(ApiError::NoAuth.exit_code(), 3);
    assert!(ApiError::NoAuth.message().contains(API_KEY_ENV));
}

// ── Exit-code mapping ────────────────────────────────────────────────────

#[test]
fn status_codes_map_to_the_documented_exit_codes() {
    assert_eq!(classify(200, r#"{"id":"w"}"#.into()).unwrap()["id"], "w");
    assert_eq!(classify(204, "".into()).unwrap(), serde_json::Value::Null);

    // Credentials are 3, not 2 — 2 is reserved for the argument mistakes clap
    // already exits with.
    let e = classify(401, r#"{"error":"bad key"}"#.into()).unwrap_err();
    assert_eq!(e.exit_code(), 3);
    assert_eq!(e.message(), "HTTP 401: bad key");

    let e = classify(403, "".into()).unwrap_err();
    assert_eq!(e.exit_code(), 3);

    // A missing workspace is an ordinary runtime failure, not its own code.
    let e = classify(404, r#"{"error":"workspace not found"}"#.into()).unwrap_err();
    assert_eq!(e.exit_code(), 1);
    assert_eq!(e.message(), "workspace not found");

    let e = classify(409, r#"{"error":"workspace is archived"}"#.into()).unwrap_err();
    assert_eq!(e.exit_code(), 1);
    assert_eq!(e.message(), "HTTP 409: workspace is archived");

    // The server breaking is distinguishable from us asking for the wrong
    // thing, so a caller can retry on 4 without retrying on a real conflict.
    let e = classify(500, "boom".into()).unwrap_err();
    assert_eq!(e.exit_code(), 4);
    assert_eq!(e.message(), "HTTP 500: boom");

    let e = classify(503, "".into()).unwrap_err();
    assert_eq!(e.exit_code(), 4);

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
    assert_eq!(output::render_workspace_list(&json!([]), None), "  no workspaces");
    let v = json!([
        { "id": "a", "status": "running", "objective": "t", "intent": "why" },
        { "id": "b", "status": "sleeping", "objective": "only title" },
        { "id": "c", "status": "archived" }
    ]);
    let out = output::render_workspace_list(&v, None);
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

// ── Whose turn is it (AURA-1437 item 6) ──────────────────────────────────

#[test]
fn status_leads_with_the_word_a_script_matches_on() {
    let out = output::render_workspace_status(&json!({
        "id": "ws-1",
        "state": "working",
        "status": "running",
        "waiting_on": "agent",
        "accepts_prompt": true,
        "messages": 3,
        "last_speaker": "user",
        "summary": "your prompt is the newest thing here, so the agent has the turn"
    }));
    let first = out.lines().next().unwrap();
    assert!(first.contains("state"), "{out}");
    assert!(first.contains("working"), "{out}");
    assert!(out.contains("next move  agent"), "{out}");
    assert!(out.contains("messages   3"), "{out}");
    // Nothing is refused, so nothing says so.
    assert!(!out.contains("prompts"), "{out}");
}

#[test]
fn a_closed_workspace_prints_no_empty_next_move_row() {
    // `waiting_on` is null because nobody's move is coming. An empty row here
    // would read as a missing value rather than as the answer.
    let out = output::render_workspace_status(&json!({
        "id": "ws-1",
        "state": "archived",
        "status": "archived",
        "waiting_on": null,
        "accepts_prompt": false,
        "messages": 8,
        "last_speaker": "assistant",
        "summary": "archived — prompts are refused"
    }));
    assert!(!out.contains("next move"), "{out}");
    assert!(out.contains("prompts    refused"), "{out}");
}

#[test]
fn rename_and_status_hang_off_the_workspace_they_act_on() {
    assert_eq!(
        endpoint("https://api.auravcs.com", "/workspaces/ws-1/rename"),
        "https://api.auravcs.com/api/v2/public/workspaces/ws-1/rename"
    );
    assert_eq!(
        endpoint("https://api.auravcs.com", "/workspaces/ws-1/status"),
        "https://api.auravcs.com/api/v2/public/workspaces/ws-1/status"
    );
}

#[test]
fn a_fresh_send_says_sent_and_a_repeat_says_already() {
    // The first line is what a retrying script reads. If both cases printed
    // the same word, the only way to tell them apart would be to compare
    // timestamps — and a script that cannot tell will send a third.
    let fresh = output::render_message(&json!({
        "id": "11111111-1111-1111-1111-111111111111",
        "workspace_id": "ws-1",
        "role": "user",
        "text": "Summarise the parser",
        "message_id": "turn-1",
        "duplicate": false,
        "workspace_status": "running"
    }));
    assert!(fresh.lines().next().unwrap().contains("sent"), "{fresh}");
    assert!(!fresh.contains("already sent"), "{fresh}");

    let repeat = output::render_message(&json!({
        "id": "11111111-1111-1111-1111-111111111111",
        "workspace_id": "ws-1",
        "role": "user",
        "text": "Summarise the parser",
        "message_id": "turn-1",
        "duplicate": true,
        "workspace_status": "running"
    }));
    assert!(repeat.contains("already sent"), "{repeat}");
    assert!(repeat.contains("no second message was created"), "{repeat}");
    // Same id both times — that is the guarantee, and it has to be visible.
    assert!(repeat.contains("11111111-1111-1111-1111-111111111111"), "{repeat}");
}

#[test]
fn a_send_reports_the_state_it_left_the_workspace_in() {
    // So `message create` answers "did it wake?" without a second call.
    let out = output::render_message(&json!({
        "id": "22222222-2222-2222-2222-222222222222",
        "workspace_id": "ws-2",
        "role": "user",
        "text": "Wake up",
        "duplicate": false,
        "workspace_status": "running"
    }));
    assert!(out.contains("state"), "{out}");
    assert!(out.contains("running"), "{out}");
    // No key was sent, so no key row — an empty one would read as a blank key.
    assert!(!out.contains("key"), "{out}");
}

#[test]
fn a_multi_line_message_keeps_its_lines_under_one_label() {
    let out = output::render_message(&json!({
        "id": "33333333-3333-3333-3333-333333333333",
        "workspace_id": "ws-3",
        "text": "first\nsecond",
        "duplicate": false
    }));
    assert!(out.contains("text"), "{out}");
    assert!(out.contains("second"), "{out}");
    // The label is printed once, not per line.
    assert_eq!(out.matches("text").count(), 1, "{out}");
}

#[test]
fn a_message_is_fetched_by_id_alone_not_through_its_workspace() {
    // The id a send returned is all a caller kept, so the read must not need
    // the workspace as well.
    assert_eq!(
        endpoint("https://api.auravcs.com", "/messages/33333333-3333-3333-3333-333333333333"),
        "https://api.auravcs.com/api/v2/public/messages/33333333-3333-3333-3333-333333333333"
    );
    assert_eq!(
        endpoint("https://api.auravcs.com", "/workspaces/ws-1/messages"),
        "https://api.auravcs.com/api/v2/public/workspaces/ws-1/messages"
    );
}

#[test]
fn a_project_listing_says_when_it_is_only_a_page() {
    // Without this a reader takes the first 25 projects for all of them. The
    // footer prints the next command, not the arithmetic.
    let out = output::render_projects(
        &json!({
            "items": [
                {"id": "r1", "name": "acme/app", "workspaces": 4, "last_activity_at": "2026-10-09T06:00:00Z", "implicit": false},
                {"id": "r2", "name": "acme/web", "workspaces": 1, "last_activity_at": "2026-10-08T06:00:00Z", "implicit": false}
            ],
            "limit": 2, "offset": 0, "has_more": true
        }),
        "aura project list --limit 2",
    );
    assert!(out.contains("acme/app"), "{out}");
    assert!(out.contains("4 workspaces"), "{out}");
    // Singular for one, because "1 workspaces" reads like a bug.
    assert!(out.contains("1 workspace "), "{out}");
    // The whole command, runnable as printed — not just the number.
    assert!(out.contains("aura project list --limit 2 --offset 2"), "{out}");
}

#[test]
fn the_next_page_footer_is_the_command_it_was_given() {
    // The renderer knows how far the page reached; it does not know what the
    // caller typed. It must not invent the command — a footer that dropped
    // `--status` would page into rows of every status and look like the rest
    // of the archived ones.
    let out = output::render_paged_workspaces(
        &json!({
            "items": [{"id": "w1", "status": "archived", "objective": "old work"}],
            "limit": 1, "offset": 2, "has_more": true
        }),
        "aura project workspaces acme/app --status archived --limit 1",
    );
    assert!(
        out.contains("aura project workspaces acme/app --status archived --limit 1 --offset 3"),
        "{out}"
    );
}

#[test]
fn a_complete_listing_prints_no_footer() {
    let out = output::render_projects(
        &json!({
            "items": [{"id": "r1", "name": "acme/app", "workspaces": 0, "implicit": false}],
            "limit": 25, "offset": 0, "has_more": false
        }),
        "aura project list",
    );
    assert!(!out.contains("more rows"), "{out}");
    assert!(!out.contains("--offset"), "{out}");
}

#[test]
fn the_holding_area_is_labelled_where_a_person_will_read_it() {
    // A project nobody created showing up in a list needs explaining at the
    // point of confusion, not in a JSON field.
    let listed = output::render_projects(
        &json!({
            "items": [{"id": "r9", "name": "aura-workspace/abc", "workspaces": 2, "implicit": true}],
            "limit": 25, "offset": 0, "has_more": false
        }),
        "aura project list",
    );
    assert!(listed.contains("unfiled work"), "{listed}");

    let single = output::render_project(&json!({
        "id": "r9", "name": "aura-workspace/abc", "default_branch": "main",
        "workspaces": 2, "implicit": true
    }));
    assert!(single.contains("not created by anyone"), "{single}");
}

#[test]
fn a_real_project_is_not_labelled_as_unfiled() {
    let out = output::render_project(&json!({
        "id": "r1", "name": "acme/app", "default_branch": "main",
        "workspaces": 3, "implicit": false
    }));
    assert!(!out.contains("not created by anyone"), "{out}");
    assert!(out.lines().next().unwrap().contains("acme/app"), "{out}");
}

#[test]
fn an_empty_project_says_so_rather_than_printing_a_header_with_nothing_under_it() {
    let empty = json!({"items": [], "limit": 25, "offset": 0, "has_more": false});
    assert_eq!(
        output::render_paged_workspaces(&empty, "aura project workspaces acme/app"),
        "  no workspaces"
    );
    assert_eq!(output::render_projects(&empty, "aura project list"), "  no projects");
}

#[test]
fn a_bare_array_still_renders_so_a_shape_change_does_not_read_as_empty() {
    // If a server ever answers with a plain list instead of an envelope, the
    // rows should still print — "no projects" would be a lie about the data.
    let out = output::render_projects(
        &json!([{"id": "r1", "name": "acme/app", "workspaces": 1, "implicit": false}]),
        "aura project list",
    );
    assert!(out.contains("acme/app"), "{out}");
}

#[test]
fn a_full_workspace_page_offers_the_next_one_and_a_short_page_does_not() {
    // `workspace list` answers with a bare array — no `has_more` to read — so
    // the only signal that more might follow is the page coming back as long
    // as it was allowed to be.
    let rows = json!([
        { "id": "a", "status": "running" },
        { "id": "b", "status": "running" }
    ]);
    let full = output::AskedPage {
        limit: 2,
        offset: 4,
        next_hint: "aura workspace list --status running --limit 2",
    };
    let out = output::render_workspace_list(&rows, Some(&full));
    assert!(
        out.contains("aura workspace list --status running --limit 2 --offset 6"),
        "{out}"
    );

    // One row short of the limit means the list ended here. Offering a next
    // page would send the reader to an empty one.
    let short = output::AskedPage {
        limit: 3,
        offset: 0,
        next_hint: "aura workspace list --limit 3",
    };
    let out = output::render_workspace_list(&rows, Some(&short));
    assert!(!out.contains("--offset"), "{out}");
}

#[test]
fn a_workspace_listing_with_no_page_size_asked_for_says_nothing_about_pages() {
    // Without `--limit` the page size is the server's default, and this client
    // would have to restate that number to know whether a page was full. A
    // footer built on a number we are only guessing at is worse than none.
    let rows: Vec<Value> = (0..3)
        .map(|i| json!({ "id": format!("w{i}"), "status": "running" }))
        .collect();
    let out = output::render_workspace_list(&Value::Array(rows), None);
    assert!(!out.contains("more"), "{out}");
}

#[test]
fn a_filter_and_a_window_travel_together_in_one_query() {
    // Both narrowings belong to the server, and `?status=` has to compose with
    // the window rather than each of them owning the leading `?`.
    assert_eq!(client::query(vec![]), "");
    assert_eq!(
        client::query(vec!["status=archived".into(), "limit=2".into(), "offset=4".into()]),
        "?status=archived&limit=2&offset=4"
    );
}

#[test]
fn a_project_is_addressed_by_id_or_by_owner_slash_name() {
    assert_eq!(
        endpoint("https://api.auravcs.com", "/projects"),
        "https://api.auravcs.com/api/v2/public/projects"
    );
    // The slash in a name has to survive as part of one path segment, or the
    // request goes somewhere else entirely.
    assert_eq!(
        endpoint("https://api.auravcs.com", "/projects/acme%2Fapp/workspaces"),
        "https://api.auravcs.com/api/v2/public/projects/acme%2Fapp/workspaces"
    );
}
