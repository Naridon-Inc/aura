//! Driving the real pi against a model that lives inside this test.
//!
//! Everything else in this module is unit-tested against captured lines.
//! That proves the parsing, and proves nothing about the claim the module
//! actually makes: *no third-party agent writes to your disk without
//! passing Aura's gate*. The gate rides on pi's `tool_call` hook, and that
//! hook only fires when a model decides to call a tool — which no fixture
//! can make happen.
//!
//! So this test supplies the model. A few dozen lines of HTTP serve pi's
//! OpenAI-completions client and answer its first request with a `write`
//! tool call. pi is pointed at it through a throwaway `models.json` in a
//! temporary `HOME`. Nothing leaves the machine, nothing is authenticated,
//! and no tokens are spent — the "provider" is a `TcpListener` on
//! localhost that reads the request and hands back a canned stream.
//!
//! What that buys, which nothing else here does:
//!
//!   - the extension really loads into the real binary, and the question it
//!     asks really parses;
//!   - `allow` lets the write land on disk;
//!   - a refusal stops it, and Aura's sentence reaches the model as the
//!     tool's result rather than disappearing.
//!
//! Both tests are `#[ignore]`d: they need pi installed and they spawn a
//! process and a listener. Run them when changing anything about the gate:
//!
//! ```text
//! cargo test --lib manager::brain::pi::e2e -- --ignored --test-threads=1
//! ```
//!
//! `--test-threads=1` is not optional. The tests move `HOME`, which is
//! process-wide.

use std::path::Path;
use std::sync::Arc;
use std::sync::Mutex as StdMutex;

use async_trait::async_trait;
use futures_util::StreamExt;
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use super::brain::{PiBrain, is_installed};
use crate::manager::brain::gate::{GateDecision, HostPolicy};
use crate::manager::brain::Brain;
use crate::manager::brain::types::{ChatMessage, ChatRequest};

/// The file the fake model asks pi to write, relative to the session root.
const TARGET: &str = "gate-probe.txt";

/// What Aura says when it will not let an edit through. The test asserts
/// this exact string comes back out of pi as the tool's result — that is
/// the difference between blocking a write and blocking it *legibly*.
const REFUSAL: &str = "Aura could not snapshot this file, so the edit cannot be rewound.";

// ── the model ───────────────────────────────────────────────────────────────

/// An OpenAI-completions endpoint that calls nobody.
///
/// First request: a `write` tool call. Every request after: two words and a
/// stop, so the turn ends instead of looping. That mirrors how a real turn
/// goes — call a tool, see its result, say something — without a model.
async fn serve_fake_model() -> std::io::Result<(u16, tokio::task::JoinHandle<()>)> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();

    let handle = tokio::spawn(async move {
        let mut turn = 0u32;
        while let Ok((mut sock, _)) = listener.accept().await {
            turn += 1;
            // Read past the headers, then exactly Content-Length bytes. pi
            // sends one request per connection, so this stays simple.
            let mut buf = Vec::new();
            let mut chunk = [0u8; 4096];
            let mut need: Option<usize> = None;
            loop {
                let n = match sock.read(&mut chunk).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => n,
                };
                buf.extend_from_slice(&chunk[..n]);
                if need.is_none() {
                    if let Some(pos) = find_headers_end(&buf) {
                        need = Some(pos + content_length(&buf[..pos]));
                    }
                }
                if need.is_some_and(|want| buf.len() >= want) {
                    break;
                }
            }

            let body = if turn == 1 {
                sse_tool_call()
            } else {
                sse_text("done.")
            };
            let head = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\n\
                 cache-control: no-cache\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                body.len()
            );
            let _ = sock.write_all(head.as_bytes()).await;
            let _ = sock.write_all(body.as_bytes()).await;
            let _ = sock.flush().await;
        }
    });

    Ok((port, handle))
}

fn find_headers_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n").map(|p| p + 4)
}

fn content_length(head: &[u8]) -> usize {
    String::from_utf8_lossy(head)
        .lines()
        .find_map(|l| {
            let (k, v) = l.split_once(':')?;
            k.trim()
                .eq_ignore_ascii_case("content-length")
                .then(|| v.trim().parse().ok())?
        })
        .unwrap_or(0)
}

fn sse(chunks: &[Value]) -> String {
    let mut out = String::new();
    for c in chunks {
        out.push_str("data: ");
        out.push_str(&c.to_string());
        out.push_str("\n\n");
    }
    out.push_str("data: [DONE]\n\n");
    out
}

fn sse_tool_call() -> String {
    let base = json!({"id":"c1","object":"chat.completion.chunk","created":0,"model":"fake-1"});
    let args = json!({ "path": TARGET, "content": "hi" }).to_string();
    sse(&[
        merge(&base, json!({"choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[
            {"index":0,"id":"call_1","type":"function",
             "function":{"name":"write","arguments":args}}]},"finish_reason":null}]})),
        merge(
            &base,
            json!({"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}),
        ),
    ])
}

fn sse_text(text: &str) -> String {
    let base = json!({"id":"c2","object":"chat.completion.chunk","created":0,"model":"fake-1"});
    sse(&[
        merge(
            &base,
            json!({"choices":[{"index":0,"delta":{"content":text},"finish_reason":null}]}),
        ),
        merge(
            &base,
            json!({"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}),
        ),
    ])
}

fn merge(base: &Value, extra: Value) -> Value {
    let mut out = base.clone();
    if let (Some(o), Some(e)) = (out.as_object_mut(), extra.as_object()) {
        for (k, v) in e {
            o.insert(k.clone(), v.clone());
        }
    }
    out
}

// ── the environment pi runs in ──────────────────────────────────────────────

/// A temporary `HOME` holding a `models.json` that points pi at `port`.
///
/// Moving `HOME` also moves `~/.aura/pi/aura-gate.ts` and pi's session
/// storage, so a test run cannot disturb the developer's own pi or leave
/// an extension behind in their home directory.
fn plant_home(home: &Path, port: u16) -> std::io::Result<()> {
    let agent = home.join(".pi").join("agent");
    std::fs::create_dir_all(&agent)?;
    let models = json!({
        "providers": {
            "auralocal": {
                "name": "Aura Local Test",
                "baseUrl": format!("http://127.0.0.1:{port}/v1"),
                "api": "openai-completions",
                "apiKey": "not-a-real-key",
                "models": [{
                    "id": "fake-1", "name": "Fake 1", "reasoning": false,
                    "input": ["text"],
                    "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
                    "contextWindow": 128000, "maxTokens": 4096
                }]
            }
        }
    });
    std::fs::write(
        agent.join("models.json"),
        serde_json::to_vec_pretty(&models).unwrap(),
    )
}

/// Answers the gate with a fixed verdict and remembers what it was asked.
struct Fixed {
    decision: GateDecision,
    snapshot_fails: bool,
    calls: StdMutex<Vec<String>>,
}

impl Fixed {
    fn new(decision: GateDecision) -> Arc<Self> {
        Arc::new(Self {
            decision,
            snapshot_fails: false,
            calls: StdMutex::new(Vec::new()),
        })
    }
    fn failing_snapshot() -> Arc<Self> {
        Arc::new(Self {
            decision: GateDecision::Allow,
            snapshot_fails: true,
            calls: StdMutex::new(Vec::new()),
        })
    }
    fn calls(&self) -> Vec<String> {
        self.calls.lock().unwrap().clone()
    }
}

#[async_trait]
impl HostPolicy for Fixed {
    async fn ask_permission(&self, tool: &str, _input: &Value) -> GateDecision {
        self.calls.lock().unwrap().push(format!("ask:{tool}"));
        self.decision
    }
    async fn before_write(&self, path: &Path, _proposed: Option<&str>) -> Result<(), String> {
        self.calls
            .lock()
            .unwrap()
            .push(format!("snapshot:{}", path.display()));
        if self.snapshot_fails {
            return Err(REFUSAL.to_string());
        }
        Ok(())
    }
}

/// Run one turn against the fake model. Returns whether the file the model
/// asked for exists afterwards, plus every chunk the brain produced.
///
/// The answer is read *before* the temporary directory is removed — the
/// whole point of the test is what is on disk at the end of the turn.
///
/// Returns `None` when pi isn't installed, so the caller can skip rather
/// than fail on a machine without it.
async fn one_turn(policy: Arc<dyn HostPolicy>) -> Option<(bool, Vec<String>)> {
    if !is_installed() {
        return None;
    }
    let (port, server) = serve_fake_model().await.ok()?;

    let tmp = tempfile::tempdir().ok()?;
    let home = tmp.path().join("home");
    let work = tmp.path().join("work");
    std::fs::create_dir_all(&home).ok()?;
    std::fs::create_dir_all(&work).ok()?;
    plant_home(&home, port).ok()?;

    // Process-wide, hence `--test-threads=1` on this module.
    let prior = std::env::var("HOME").ok();
    unsafe {
        std::env::set_var("HOME", &home);
        // Keep pi off the network entirely: no update check, no catalog
        // refresh. The only socket it should open is the one above.
        std::env::set_var("PI_OFFLINE", "1");
    }

    let brain = PiBrain::new(policy);
    let request = ChatRequest {
        messages: vec![ChatMessage {
            role: "user".into(),
            content: json!("make the file"),
        }],
        model: Some("auralocal/fake-1".into()),
        cwd: work.to_string_lossy().into_owned(),
        ..Default::default()
    };

    let mut seen = Vec::new();
    if let Ok(mut stream) = brain.chat(request).await {
        while let Ok(Some(item)) = tokio::time::timeout(
            std::time::Duration::from_secs(30),
            StreamExt::next(&mut stream),
        )
        .await
        {
            match item {
                Ok(chunk) => seen.push(format!("{chunk:?}")),
                Err(e) => seen.push(format!("Err({e:?})")),
            }
        }
    }

    // Read the outcome while the directory still exists.
    let landed = work.join(TARGET).exists();

    unsafe {
        match prior {
            Some(h) => std::env::set_var("HOME", h),
            None => std::env::remove_var("HOME"),
        }
    }
    server.abort();
    drop(tmp);

    Some((landed, seen))
}

#[tokio::test]
#[ignore]
async fn an_allowed_write_reaches_the_disk() {
    let policy = Fixed::new(GateDecision::Allow);
    let Some((landed, _chunks)) = one_turn(policy.clone() as Arc<dyn HostPolicy>).await else {
        return; // pi isn't installed on this machine.
    };

    let calls = policy.calls();
    assert!(
        calls.iter().any(|c| c.starts_with("snapshot:")),
        "a write must be snapshotted before it is permitted, got {calls:?}"
    );
    assert!(
        calls.iter().any(|c| c == "ask:write"),
        "the human must be asked about a write, got {calls:?}"
    );
    assert!(landed, "an allowed write should have reached the disk");
}

#[tokio::test]
#[ignore]
async fn a_refused_write_never_happens_and_says_why() {
    let policy = Fixed::failing_snapshot();
    let Some((landed, chunks)) = one_turn(policy.clone() as Arc<dyn HostPolicy>).await else {
        return;
    };

    let calls = policy.calls();
    assert!(
        !calls.iter().any(|c| c == "ask:write"),
        "a write we already refused must not also be put to the human: {calls:?}"
    );
    assert!(!landed, "a refused write must not reach the disk");
    let transcript = chunks.join("\n");
    assert!(
        transcript.contains(REFUSAL),
        "the model should be told why, in Aura's words. Transcript:\n{transcript}"
    );
}
