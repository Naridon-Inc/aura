//! Permission, elicitation and session/update parsing on spec-shaped bodies.

use aura_acp::elicit::{self, Answer, Elicitation, FieldKind};
use aura_acp::permission::{self, PermissionOption};
use aura_acp::update::{Update, UpdateKind};
use serde_json::json;

fn options() -> Vec<PermissionOption> {
    PermissionOption::parse_list(&json!({"options": [
        {"optionId": "a1", "name": "Allow", "kind": "allow_once"},
        {"optionId": "aa", "name": "Always", "kind": "allow_always"},
        {"optionId": "r1", "name": "Reject", "kind": "reject_once"},
    ]}))
}

#[test]
fn permission_reply_never_widens_the_choice() {
    let o = options();
    assert_eq!(permission::outcome(&o, Some("a1"), "allow_always"), json!({"outcome": "selected", "optionId": "a1"}));
    assert_eq!(permission::outcome(&o, None, "reject_once"), json!({"outcome": "selected", "optionId": "r1"}));
    // An id the agent never offered cancels rather than guessing.
    assert_eq!(permission::outcome(&o, Some("forged"), "allow_once"), json!({"outcome": "cancelled"}));
    assert_eq!(permission::outcome(&o, None, "reject_always"), json!({"outcome": "cancelled"}));
    assert_eq!(permission::result(permission::cancelled()), json!({"outcome": {"outcome": "cancelled"}}));
}

#[test]
fn form_elicitation_round_trips_to_schema_content() {
    let e = Elicitation::parse(&json!({
        "sessionId": "s", "mode": "form", "message": "Pick a deploy target",
        "requestedSchema": {
            "type": "object",
            "properties": {
                "env": {"type": "string", "title": "Environment", "enum": ["stg", "prod"], "enumNames": ["Staging", "Production"]},
                "replicas": {"type": "integer", "minimum": 1, "maximum": 5},
                "notify": {"type": "boolean"},
                "tags": {"type": "array", "items": {"anyOf": [{"const": "a", "title": "A"}, {"const": "b", "title": "B"}]}},
                "note": {"type": "string"}
            },
            "required": ["env", "replicas"]
        }
    }))
    .unwrap();
    let Elicitation::Form { fields, message, session_id, .. } = e else { panic!("form") };
    assert_eq!(message, "Pick a deploy target");
    assert_eq!(session_id.as_deref(), Some("s"));
    let env = fields.iter().find(|f| f.name == "env").unwrap();
    assert!(env.required);
    assert!(matches!(&env.kind, FieldKind::Choice { options, multi: false } if options[1].label == "Production"));
    let tags = fields.iter().find(|f| f.name == "tags").unwrap();
    assert!(matches!(&tags.kind, FieldKind::Choice { multi: true, .. }));

    let ans = |n: &str, sel: &[&str], text: &str| {
        (n.to_string(), Answer { selected: sel.iter().map(|s| s.to_string()).collect(), text: text.into() })
    };
    let c = elicit::content(
        &fields,
        &[ans("env", &["Production"], ""), ans("replicas", &[], "3"), ans("notify", &["yes"], ""), ans("tags", &["a", "b"], "")],
    )
    .unwrap();
    assert_eq!(c, json!({"env": "prod", "replicas": 3, "notify": true, "tags": ["a", "b"]}));
    assert!(elicit::content(&fields, &[ans("env", &["stg"], "")]).unwrap_err().contains("required"));
    assert!(elicit::content(&fields, &[ans("env", &["stg"], ""), ans("replicas", &[], "9")]).unwrap_err().contains("range"));
    assert_eq!(elicit::accept(Some(c.clone()))["action"], "accept");
    assert_eq!(elicit::decline(), json!({"action": "decline"}));
}

#[test]
fn url_elicitation_shows_its_host_and_flags_lookalikes() {
    let e = Elicitation::parse(&json!({
        "mode": "url", "elicitationId": "e1", "url": "https://auth.example.com/device?code=1", "message": "Sign in"
    }))
    .unwrap();
    assert!(matches!(e, Elicitation::Url { ref host, suspicious: false, .. } if host == "auth.example.com"));
    assert!(elicit::url_host("https://user@evil.example/").unwrap().1);
    assert!(elicit::url_host("https://xn--pple-43d.com/").unwrap().1);
    assert!(elicit::url_host("http://10.0.0.1:8080/x").unwrap().1);
    assert!(elicit::url_host("file:///etc/passwd").is_none());
    assert!(Elicitation::parse(&json!({"mode": "url", "elicitationId": "e", "url": "javascript:alert(1)"})).is_err());
    assert!(Elicitation::parse(&json!({"mode": "form"})).is_err());
}

#[test]
fn updates_classify_and_expose_their_fields() {
    let u = Update::parse(&json!({"sessionId": "s", "update": {
        "sessionUpdate": "tool_call", "toolCallId": "t1", "title": "Edit a.rs", "kind": "edit", "status": "pending",
        "locations": [{"path": "/w/a.rs"}],
        "content": [{"type": "diff", "path": "/w/b.rs", "oldText": "a", "newText": "b"}]
    }}))
    .unwrap();
    assert_eq!(u.kind, UpdateKind::ToolCall);
    assert_eq!(u.tool_call_id(), Some("t1"));
    assert_eq!(u.tool_kind(), Some("edit"));
    assert_eq!(u.tool_paths(), vec!["/w/a.rs".to_string(), "/w/b.rs".to_string()]);
    assert!(u.typed().is_ok());

    let usage = Update::parse(&json!({"sessionId": "s", "update": {
        "sessionUpdate": "usage_update", "used": 1200, "size": 200000, "cost": {"amount": 0.25, "currency": "USD"}
    }}))
    .unwrap();
    assert_eq!(usage.kind, UpdateKind::Usage);
    let cu = usage.usage().unwrap();
    assert_eq!((cu.used, cu.size), (1200, 200000));
    assert_eq!(cu.cost, Some((0.25, "USD".to_string())));

    let title = Update::parse(&json!({"sessionId": "s", "update": {"sessionUpdate": "session_info_update", "title": "Fix login"}})).unwrap();
    assert_eq!(title.title(), Some(Some("Fix login".to_string())));

    let chunk = Update::parse(&json!({"sessionId": "s", "update": {
        "sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "hi"}
    }}))
    .unwrap();
    assert_eq!(chunk.chunk_text().as_deref(), Some("hi"));

    let future = Update::parse(&json!({"sessionId": "s", "update": {"sessionUpdate": "brand_new_kind"}})).unwrap();
    assert_eq!(future.kind, UpdateKind::Other("brand_new_kind".into()));
}
