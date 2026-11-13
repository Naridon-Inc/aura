//! Transport behaviour: request/response, agent requests, cancellation and
//! resuming a dropped link without replaying what was already consumed.

mod support;

use aura_acp::conn::{ConnOpts, Connection, Inbound, LinkState};
use aura_acp::RpcError;
use serde_json::json;
use std::time::Duration;
use support::pair;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

async fn recv(rx: &mut aura_acp::conn::InboundRx) -> Inbound {
    tokio::time::timeout(Duration::from_secs(5), rx.recv()).await.expect("inbound within 5s").expect("open")
}

#[tokio::test]
async fn request_resolves_with_the_matching_response() {
    let (conn, _rx, mut agent) = pair(ConnOpts::default());
    let a = tokio::spawn({
        let c = conn.clone();
        async move { c.request("x/one", json!({"n": 1})).await }
    });
    let b = tokio::spawn({
        let c = conn.clone();
        async move { c.request("x/two", json!({"n": 2})).await }
    });
    let r1 = agent.next().await;
    let r2 = agent.next().await;
    let (one, two) = if r1["method"] == "x/one" { (r1, r2) } else { (r2, r1) };
    // Answer out of order; ids route the results.
    agent.result(&two, json!("second")).await;
    agent
        .send(json!({"jsonrpc": "2.0", "id": one["id"].clone(), "error": {"code": -32602, "message": "bad"}}))
        .await;
    assert_eq!(b.await.unwrap().unwrap(), json!("second"));
    let err = a.await.unwrap().unwrap_err();
    assert_eq!(err.code, RpcError::INVALID_PARAMS);
}

#[tokio::test]
async fn agent_requests_reach_the_caller_and_answers_go_back() {
    let (conn, mut rx, mut agent) = pair(ConnOpts::default());
    agent
        .send(json!({"jsonrpc": "2.0", "id": "p1", "method": "session/request_permission", "params": {"sessionId": "s"}}))
        .await;
    agent.send_raw("not json at all\n").await;
    agent.send(json!({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": "s"}})).await;
    let Inbound::Request { id, method, offset, .. } = recv(&mut rx).await else { panic!("request first") };
    assert_eq!(method, "session/request_permission");
    assert_eq!(offset, 0);
    assert!(matches!(recv(&mut rx).await, Inbound::Diagnostic(s) if s == "not json at all"));
    assert!(matches!(recv(&mut rx).await, Inbound::Notification { method, .. } if method == "session/update"));
    conn.respond(&id, Ok(json!({"outcome": {"outcome": "cancelled"}}))).await.unwrap();
    let back = agent.next().await;
    assert_eq!(back["id"], "p1");
    assert_eq!(back["result"]["outcome"]["outcome"], "cancelled");
}

#[tokio::test]
async fn dropping_a_request_sends_cancel_request() {
    let (conn, _rx, mut agent) = pair(ConnOpts::default());
    let fut = conn.request("session/prompt", json!({}));
    let _ = tokio::time::timeout(Duration::from_millis(100), fut).await;
    let req = agent.expect("session/prompt").await;
    let cancel = agent.expect("$/cancel_request").await;
    assert_eq!(cancel["params"]["requestId"], req["id"]);
}

#[tokio::test]
async fn eof_on_a_plain_connection_fails_pending_requests() {
    let (conn, mut rx, agent) = pair(ConnOpts::default());
    let pending = tokio::spawn({
        let c = conn.clone();
        async move { c.request("x/slow", json!({})).await }
    });
    tokio::time::sleep(Duration::from_millis(50)).await;
    drop(agent);
    let err = pending.await.unwrap().unwrap_err();
    assert!(err.is_disconnected());
    loop {
        if let Inbound::Closed(_) = recv(&mut rx).await {
            break;
        }
    }
    assert_eq!(conn.state(), LinkState::Closed);
    assert!(conn.request("x/after", json!({})).await.unwrap_err().is_disconnected());
}

#[tokio::test]
async fn resumable_link_reattaches_at_the_last_offset_without_replays() {
    // The agent's stdout as a relay log on the box.
    let l1 = format!("{}\n", json!({"jsonrpc": "2.0", "method": "session/update", "params": {"n": 1}}));
    let l2 = format!("{}\n", json!({"jsonrpc": "2.0", "method": "session/update", "params": {"n": 2}}));

    let (client_end, agent_end) = tokio::io::duplex(1 << 16);
    let (cr, cw) = tokio::io::split(client_end);
    let (ar, mut aw) = tokio::io::split(agent_end);
    let (conn, mut rx) = Connection::over(cr, cw, ConnOpts { resumable: true });

    let pending = tokio::spawn({
        let c = conn.clone();
        async move { c.request("session/prompt", json!({})).await }
    });
    let mut agent_in = BufReader::new(ar);
    let mut line = String::new();
    agent_in.read_line(&mut line).await.unwrap();
    let req: serde_json::Value = serde_json::from_str(&line).unwrap();

    aw.write_all(l1.as_bytes()).await.unwrap();
    aw.flush().await.unwrap();
    assert!(matches!(recv(&mut rx).await, Inbound::Notification { offset: 0, .. }));
    // Link drops.
    drop(aw);
    drop(agent_in);
    assert!(matches!(recv(&mut rx).await, Inbound::Detached));
    assert_eq!(conn.state(), LinkState::Detached);
    assert_eq!(conn.last_offset(), l1.len() as u64);

    // A frame written while detached waits for the new link.
    conn.notify("session/cancel", json!({"sessionId": "s"})).await.unwrap();

    // The relay replays from an earlier offset (0): l1 must not come back.
    let (client_end, agent_end) = tokio::io::duplex(1 << 16);
    let (cr, cw) = tokio::io::split(client_end);
    let (ar, mut aw) = tokio::io::split(agent_end);
    conn.reattach_at(cr, cw, 0).unwrap();
    let mut agent_in = BufReader::new(ar);
    let mut line = String::new();
    agent_in.read_line(&mut line).await.unwrap();
    assert!(line.contains("session/cancel"), "backlog flushed on reattach: {line}");

    let resp = format!("{}\n", json!({"jsonrpc": "2.0", "id": req["id"].clone(), "result": {"stopReason": "cancelled"}}));
    aw.write_all(format!("{l1}{l2}{resp}").as_bytes()).await.unwrap();
    aw.flush().await.unwrap();
    match recv(&mut rx).await {
        Inbound::Notification { params, offset, .. } => {
            assert_eq!(params["n"], 2, "l1 was already consumed");
            assert_eq!(offset, l1.len() as u64);
        }
        other => panic!("expected l2, got {other:?}"),
    }
    assert_eq!(pending.await.unwrap().unwrap()["stopReason"], "cancelled");
    assert_eq!(conn.last_offset(), (l1.len() + l2.len() + resp.len()) as u64);
}

#[tokio::test]
async fn plain_connections_refuse_reattach() {
    let (conn, _rx, _agent) = pair(ConnOpts::default());
    let (a, _b) = tokio::io::duplex(64);
    let (r, w) = tokio::io::split(a);
    assert!(conn.reattach_at(r, w, 0).is_err());
}

#[tokio::test]
async fn spawned_agent_speaks_over_stdio_and_stderr_is_diagnostic() {
    // A two-line "agent": echo stderr, answer one request, exit.
    let script = r#"read line; echo "booting" 1>&2; id=$(printf '%s' "$line" | sed 's/.*"id":\([0-9]*\).*/\1/'); printf '{"jsonrpc":"2.0","id":%s,"result":{"ok":true}}\n' "$id""#;
    let mut cmd = tokio::process::Command::new("sh");
    cmd.arg("-c").arg(script);
    let (conn, mut rx) = Connection::spawn(cmd, ConnOpts::default()).unwrap();
    assert!(conn.child_id().is_some());
    let r = conn.request("initialize", json!({})).await.unwrap();
    assert_eq!(r["ok"], true);
    let mut saw_diag = false;
    loop {
        match recv(&mut rx).await {
            Inbound::Diagnostic(s) if s == "booting" => saw_diag = true,
            Inbound::Closed(_) => break,
            _ => {}
        }
    }
    assert!(saw_diag);
}
