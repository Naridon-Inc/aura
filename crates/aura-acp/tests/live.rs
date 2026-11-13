//! Live handshakes with the agents installed on this machine. Ignored by
//! default: they start real agent processes.
//!
//! `cargo test -p aura-acp --test live -- --ignored --nocapture`
//! Set `AURA_ACP_LIVE_PROMPT=1` to also send one tiny prompt per agent
//! (this uses the agent's own sign-in and quota).

use aura_acp::conn::{ConnOpts, Connection, Inbound};
use aura_acp::profile::{ClientCaps, ClientInfo};
use aura_acp::registry::{self, Availability, Probe, Registry};
use aura_acp::session::{prompt_blocks, AcpError, Driver, OpenRequest};
use aura_acp::update::{Update, UpdateKind};
use aura_acp::{elicit, permission};
use std::path::PathBuf;
use std::time::Duration;

async fn handshake(registry_id: &str) {
    let home = PathBuf::from(std::env::var_os("HOME").expect("HOME"));
    let path = std::env::var_os("PATH").unwrap_or_default();
    let which = |n: &str| registry::find_in_path(n, &path);
    let reg = Registry::pinned();
    let agent = reg.get(registry_id).expect("in registry");
    let launch = match registry::resolve(agent, &Probe { home: &home, which: &which }) {
        Availability::Ready { launch } => launch,
        other => {
            eprintln!("{registry_id}: not installed here ({other:?}); skipping");
            return;
        }
    };
    eprintln!("{registry_id}: {} {:?}", launch.program.display(), launch.args);
    let cwd = tempfile::tempdir().unwrap();
    let mut cmd = launch.command();
    cmd.current_dir(cwd.path());
    let (conn, mut rx) = Connection::spawn(cmd, ConnOpts::default()).expect("spawn");
    let caps = ClientCaps { terminal_auth: true, elicitation_form: true, ..ClientCaps::default() };
    let driver = tokio::time::timeout(Duration::from_secs(60), Driver::initialize(conn.clone(), &ClientInfo::aura("live-test"), &caps))
        .await
        .expect("initialize within 60s")
        .expect("initialize");
    eprintln!("{registry_id}: agent {:?} {:?}, auth {:?}", driver.agent.name, driver.agent.version, driver.agent.auth_methods.iter().map(|m| &m.id).collect::<Vec<_>>());
    let req = OpenRequest { cwd: cwd.path().display().to_string(), ..OpenRequest::default() };
    let session = match tokio::time::timeout(Duration::from_secs(60), driver.open(&req)).await.expect("session/new within 60s") {
        Ok(s) => s,
        Err(AcpError::AuthRequired { methods, detail }) => {
            eprintln!("{registry_id}: signed out ({detail}); offers {:?}", methods.iter().map(|m| &m.id).collect::<Vec<_>>());
            assert!(!methods.is_empty(), "an agent that wants sign-in must say how");
            conn.close("done");
            return;
        }
        Err(e) => panic!("{registry_id}: session/new failed: {e}"),
    };
    eprintln!("{registry_id}: session {} model {:?} config {:?}", session.id, session.current_model(), session.config.iter().map(|c| &c.id).collect::<Vec<_>>());
    if std::env::var("AURA_ACP_LIVE_PROMPT").as_deref() != Ok("1") {
        conn.close("done");
        return;
    }
    let blocks = prompt_blocks(&driver.agent, "Reply with exactly the word pong and nothing else. Do not use tools.", &[]).unwrap();
    let sid = session.id.clone();
    let turn = tokio::spawn({
        let d = driver.clone();
        async move { d.prompt(&sid, blocks).await }
    });
    let mut turn = turn;
    let mut text = String::new();
    let take = |item: Inbound, text: &mut String| -> Option<(serde_json::Value, Result<serde_json::Value, aura_acp::RpcError>)> {
        match item {
            Inbound::Notification { method, params, .. } if method == "session/update" => {
                if let Some(u) = Update::parse(&params) {
                    if u.kind == UpdateKind::AgentMessageChunk {
                        text.push_str(&u.chunk_text().unwrap_or_default());
                    }
                }
                None
            }
            Inbound::Request { id, method, .. } => Some((
                id,
                match method.as_str() {
                    "session/request_permission" => Ok(permission::result(permission::cancelled())),
                    "elicitation/create" => Ok(elicit::cancel()),
                    _ => Err(aura_acp::RpcError::method_not_found(&method)),
                },
            )),
            _ => None,
        }
    };
    let outcome = loop {
        tokio::select! {
            done = &mut turn => break done.unwrap(),
            item = rx.recv() => {
                let Some(item) = item else { panic!("{registry_id}: connection ended mid-turn") };
                if let Some((id, reply)) = take(item, &mut text) {
                    conn.respond(&id, reply).await.unwrap();
                }
            }
            _ = tokio::time::sleep(Duration::from_secs(180)) => panic!("{registry_id}: agent quiet for 180s"),
        }
    };
    while let Ok(item) = rx.try_recv() {
        take(item, &mut text);
    }
    let outcome = match outcome {
        Ok(o) => o,
        // Some agents only check the sign-in when the first prompt runs.
        Err(AcpError::AuthRequired { methods, detail }) => {
            eprintln!("{registry_id}: signed out at prompt ({detail}); offers {:?}", methods.iter().map(|m| &m.id).collect::<Vec<_>>());
            assert!(!methods.is_empty());
            conn.close("done");
            return;
        }
        Err(e) => panic!("{registry_id}: prompt failed: {e}"),
    };
    eprintln!("{registry_id}: stop {} usage {:?} text {text:?}", outcome.stop_reason, outcome.usage);
    assert!(text.to_ascii_lowercase().contains("pong"), "{registry_id} answered {text:?}");
    conn.close("done");
}

#[tokio::test]
#[ignore]
async fn live_opencode() {
    handshake("opencode").await;
}

#[tokio::test]
#[ignore]
async fn live_gemini() {
    handshake("gemini").await;
}

#[tokio::test]
#[ignore]
async fn live_kimi() {
    handshake("kimi").await;
}

#[tokio::test]
#[ignore]
async fn live_cursor() {
    handshake("cursor").await;
}

#[tokio::test]
#[ignore]
async fn live_claude() {
    handshake("claude-acp").await;
}

#[tokio::test]
#[ignore]
async fn live_codex() {
    handshake("codex-acp").await;
}

#[tokio::test]
#[ignore]
async fn live_goose() {
    handshake("goose").await;
}
