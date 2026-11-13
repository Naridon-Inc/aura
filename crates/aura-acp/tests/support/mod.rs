//! A scripted agent on the far side of an in-memory pipe, answering with
//! response bodies captured from real agents.

#![allow(dead_code)]

use aura_acp::conn::{ConnOpts, Connection, InboundRx};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream, ReadHalf, WriteHalf};

pub struct AgentSide {
    pub reader: BufReader<ReadHalf<DuplexStream>>,
    pub writer: WriteHalf<DuplexStream>,
}

impl AgentSide {
    /// Next frame the client wrote.
    pub async fn next(&mut self) -> Value {
        let mut line = String::new();
        let n = tokio::time::timeout(std::time::Duration::from_secs(5), self.reader.read_line(&mut line))
            .await
            .expect("client wrote within 5s")
            .expect("read");
        assert!(n > 0, "client closed the pipe");
        serde_json::from_str(&line).expect("client wrote JSON")
    }

    pub async fn send(&mut self, v: Value) {
        let mut b = serde_json::to_vec(&v).unwrap();
        b.push(b'\n');
        self.writer.write_all(&b).await.unwrap();
        self.writer.flush().await.unwrap();
    }

    pub async fn send_raw(&mut self, s: &str) {
        self.writer.write_all(s.as_bytes()).await.unwrap();
        self.writer.flush().await.unwrap();
    }

    /// Answer `req` with a captured frame's `result` or `error`.
    pub async fn answer(&mut self, req: &Value, captured: &Value) {
        let mut frame = json!({"jsonrpc": "2.0", "id": req["id"].clone()});
        if let Some(r) = captured.get("result") {
            frame["result"] = r.clone();
        } else {
            frame["error"] = captured["error"].clone();
        }
        self.send(frame).await;
    }

    pub async fn result(&mut self, req: &Value, result: Value) {
        self.send(json!({"jsonrpc": "2.0", "id": req["id"].clone(), "result": result})).await;
    }

    pub async fn expect(&mut self, method: &str) -> Value {
        let f = self.next().await;
        assert_eq!(f["method"], method, "expected {method}, got {f}");
        f
    }
}

pub fn pair(opts: ConnOpts) -> (Connection, InboundRx, AgentSide) {
    let (client_end, agent_end) = tokio::io::duplex(1 << 20);
    let (cr, cw) = tokio::io::split(client_end);
    let (ar, aw) = tokio::io::split(agent_end);
    let (conn, rx) = Connection::over(cr, cw, opts);
    (conn, rx, AgentSide { reader: BufReader::new(ar), writer: aw })
}

pub fn fixture(name: &str) -> Value {
    let path = format!("{}/tests/fixtures/{name}.json", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

pub fn captured(name: &str, step: &str) -> Value {
    fixture(name)[step][0].clone()
}
