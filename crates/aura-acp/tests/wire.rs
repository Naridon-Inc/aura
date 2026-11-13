//! The driver against response bodies captured from cursor-agent, Gemini
//! CLI, Kimi and OpenCode (`initialize` + `session/new`).

mod support;

use aura_acp::conn::ConnOpts;
use aura_acp::profile::{AuthKind, ClientCaps, ClientInfo};
use aura_acp::session::{AcpError, Driver, OpenRequest, Opened};
use aura_acp::AgentProfile;
use serde_json::{json, Value};
use support::{captured, pair};

fn caps() -> ClientCaps {
    ClientCaps { terminal_auth: true, elicitation_form: true, elicitation_url: true, ..ClientCaps::default() }
}

fn open_new(cwd: &str) -> OpenRequest {
    OpenRequest { cwd: cwd.into(), ..OpenRequest::default() }
}

#[test]
fn profiles_parse_from_every_captured_agent() {
    let cursor = AgentProfile::parse(&captured("cursor", "initialize")["result"]).unwrap();
    assert!(cursor.load_session && cursor.list && cursor.image && !cursor.resume);
    assert_eq!(cursor.auth_methods[0].id, "cursor_login");
    assert!(!cursor.auth_methods[0].is_terminal());

    let kimi = AgentProfile::parse(&captured("kimi", "initialize")["result"]).unwrap();
    assert!(kimi.resume && kimi.list && kimi.embedded_context);
    let login = kimi.auth_method("login").unwrap();
    match &login.kind {
        AuthKind::Terminal { args, .. } => assert_eq!(args, &vec!["--login".to_string()]),
        other => panic!("kimi login should be terminal auth, got {other:?}"),
    }

    let opencode = AgentProfile::parse(&captured("opencode", "initialize")["result"]).unwrap();
    assert!(opencode.close && opencode.resume && opencode.can_reopen());
    assert_eq!(opencode.name.as_deref(), Some("OpenCode"));

    let gemini = AgentProfile::parse(&captured("gemini", "initialize")["result"]).unwrap();
    assert!(gemini.auth_methods.iter().any(|m| m.id == "oauth-personal"));
}

#[tokio::test]
async fn initialize_advertises_aura_and_its_capabilities() {
    let (conn, _rx, mut agent) = pair(ConnOpts::default());
    let t = tokio::spawn(async move { Driver::initialize(conn, &ClientInfo::aura("9.9.9"), &caps()).await });
    let req = agent.expect("initialize").await;
    assert_eq!(req["params"]["protocolVersion"], 1);
    assert_eq!(req["params"]["clientInfo"]["name"], "aura");
    let c = &req["params"]["clientCapabilities"];
    assert_eq!(c["fs"]["readTextFile"], false);
    assert_eq!(c["terminal"], false);
    assert_eq!(c["auth"]["terminal"], true);
    assert!(c["elicitation"]["form"].is_object() && c["elicitation"]["url"].is_object());
    agent.answer(&req, &captured("opencode", "initialize")).await;
    let d = t.await.unwrap().unwrap();
    assert!(d.agent.resume);
}

#[tokio::test]
async fn cursor_without_login_surfaces_auth_required_with_its_methods() {
    let (conn, _rx, mut agent) = pair(ConnOpts::default());
    let t = tokio::spawn(async move {
        let d = Driver::initialize(conn, &ClientInfo::aura("0"), &caps()).await.unwrap();
        d.open(&open_new("/w")).await
    });
    let init = agent.expect("initialize").await;
    agent.answer(&init, &captured("cursor", "initialize")).await;
    let new = agent.expect("session/new").await;
    assert_eq!(new["params"]["cwd"], "/w");
    assert_eq!(new["params"]["mcpServers"], json!([]));
    agent.answer(&new, &captured("cursor", "session_new")).await;
    match t.await.unwrap() {
        Err(AcpError::AuthRequired { methods, detail }) => {
            assert_eq!(methods[0].id, "cursor_login");
            assert!(detail.contains("agent login"), "{detail}");
        }
        other => panic!("expected AuthRequired, got {other:?}"),
    }
}

#[tokio::test]
async fn kimi_model_switch_uses_config_id() {
    let (conn, _rx, mut agent) = pair(ConnOpts::default());
    let t = tokio::spawn(async move {
        let d = Driver::initialize(conn, &ClientInfo::aura("0"), &caps()).await.unwrap();
        let mut s = d.open(&open_new("/w")).await.unwrap();
        assert_eq!(s.how, Opened::New);
        assert_eq!(s.current_model().as_deref(), Some("kimi-code/k3"));
        d.select_model(&mut s, "kimi-code/kimi-for-coding").await.unwrap();
        s
    });
    let init = agent.expect("initialize").await;
    agent.answer(&init, &captured("kimi", "initialize")).await;
    let new = agent.expect("session/new").await;
    let created = captured("kimi", "session_new");
    agent.answer(&new, &created).await;
    let set = agent.expect("session/set_config_option").await;
    assert_eq!(set["params"]["configId"], "model");
    assert_eq!(set["params"]["value"], "kimi-code/kimi-for-coding");
    assert!(set["params"].get("optionId").is_none());
    let mut opts = created["result"]["configOptions"].clone();
    opts[0]["currentValue"] = json!("kimi-code/kimi-for-coding");
    agent.result(&set, json!({"configOptions": opts})).await;
    let s = t.await.unwrap();
    assert_eq!(s.current_model().as_deref(), Some("kimi-code/kimi-for-coding"));
}

#[tokio::test]
async fn gemini_legacy_models_and_modes() {
    let (conn, _rx, mut agent) = pair(ConnOpts::default());
    let t = tokio::spawn(async move {
        let d = Driver::initialize(conn, &ClientInfo::aura("0"), &caps()).await.unwrap();
        let mut s = d.open(&open_new("/w")).await.unwrap();
        assert!(s.config.is_empty());
        assert!(s.offers_mode("plan"));
        d.select_mode(&mut s, "plan").await.unwrap();
        let first = s.legacy_models.iter().find(|m| m.as_str() != "auto").cloned().unwrap();
        d.select_model(&mut s, &first).await.unwrap();
        (s, first)
    });
    let init = agent.expect("initialize").await;
    agent.answer(&init, &captured("gemini", "initialize")).await;
    let new = agent.expect("session/new").await;
    agent.answer(&new, &captured("gemini", "session_new")).await;
    let mode = agent.expect("session/set_mode").await;
    assert_eq!(mode["params"]["modeId"], "plan");
    agent.result(&mode, json!({})).await;
    let model = agent.expect("session/set_model").await;
    agent.result(&model, json!({})).await;
    let (s, first) = t.await.unwrap();
    assert_eq!(model["params"]["modelId"], Value::String(first.clone()));
    assert_eq!(s.current_mode().as_deref(), Some("plan"));
    assert_eq!(s.current_model(), Some(first));
}

#[tokio::test]
async fn reopen_prefers_resume_then_load() {
    let (conn, _rx, mut agent) = pair(ConnOpts::default());
    let t = tokio::spawn(async move {
        let d = Driver::initialize(conn, &ClientInfo::aura("0"), &caps()).await.unwrap();
        let req = OpenRequest { cwd: "/w".into(), resume: Some("ses_1".into()), ..OpenRequest::default() };
        d.open(&req).await.unwrap()
    });
    let init = agent.expect("initialize").await;
    agent.answer(&init, &captured("opencode", "initialize")).await;
    let resume = agent.expect("session/resume").await;
    assert_eq!(resume["params"]["sessionId"], "ses_1");
    agent.result(&resume, json!({})).await;
    assert_eq!(t.await.unwrap().how, Opened::Resumed);

    let (conn, _rx, mut agent) = pair(ConnOpts::default());
    let t = tokio::spawn(async move {
        let d = Driver::initialize(conn, &ClientInfo::aura("0"), &caps()).await.unwrap();
        let req = OpenRequest { cwd: "/w".into(), resume: Some("s2".into()), ..OpenRequest::default() };
        d.open(&req).await.unwrap()
    });
    let init = agent.expect("initialize").await;
    agent.answer(&init, &captured("cursor", "initialize")).await;
    let load = agent.expect("session/load").await;
    agent.result(&load, json!({})).await;
    assert_eq!(t.await.unwrap().how, Opened::Loaded);
}

#[tokio::test]
async fn list_follows_cursors() {
    let (conn, _rx, mut agent) = pair(ConnOpts::default());
    let t = tokio::spawn(async move {
        let d = Driver::initialize(conn, &ClientInfo::aura("0"), &caps()).await.unwrap();
        d.list(Some("/w"), 5).await.unwrap()
    });
    let init = agent.expect("initialize").await;
    agent.answer(&init, &captured("kimi", "initialize")).await;
    let p1 = agent.expect("session/list").await;
    assert_eq!(p1["params"]["cwd"], "/w");
    agent
        .result(&p1, json!({"sessions": [{"sessionId": "a", "cwd": "/w", "title": "Fix login"}], "nextCursor": "c1"}))
        .await;
    let p2 = agent.expect("session/list").await;
    assert_eq!(p2["params"]["cursor"], "c1");
    agent.result(&p2, json!({"sessions": [{"sessionId": "b", "cwd": "/w", "updatedAt": "2026-11-10T00:00:00Z"}]})).await;
    let got = t.await.unwrap();
    assert_eq!(got.len(), 2);
    assert_eq!(got[0].title.as_deref(), Some("Fix login"));
    assert_eq!(got[1].updated_at.as_deref(), Some("2026-11-10T00:00:00Z"));
}

#[tokio::test]
async fn terminal_auth_is_never_sent_as_authenticate() {
    let (conn, _rx, mut agent) = pair(ConnOpts::default());
    let t = tokio::spawn(async move {
        let d = Driver::initialize(conn, &ClientInfo::aura("0"), &caps()).await.unwrap();
        d.authenticate("login").await
    });
    let init = agent.expect("initialize").await;
    agent.answer(&init, &captured("kimi", "initialize")).await;
    assert!(matches!(t.await.unwrap(), Err(AcpError::Unsupported(_))));
}

#[tokio::test]
async fn images_are_refused_for_agents_without_the_capability() {
    let mut p = AgentProfile::parse(&captured("cursor", "initialize")["result"]).unwrap();
    let ok = aura_acp::session::prompt_blocks(&p, "hi", &[("image/png".into(), "AAAA".into())]).unwrap();
    assert_eq!(ok[1]["type"], "image");
    p.image = false;
    assert!(aura_acp::session::prompt_blocks(&p, "hi", &[("image/png".into(), "AAAA".into())]).is_err());
}
