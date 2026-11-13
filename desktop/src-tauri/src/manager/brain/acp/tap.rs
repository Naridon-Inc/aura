//! How an ACP brain comes up, and what it tells a caller that keeps its
//! own record of the conversation.
//!
//! A brain usually spawns a local binary. A cloud workspace instead hands
//! it a prepared attach to an agent running on a box, and wants every
//! frame of that conversation for the workspace's shared log, so a
//! teammate opening the chat later sees what happened. [`AcpSpawn`] is the
//! first half and [`TapEvent`] the second.

use std::sync::Arc;

use serde_json::Value;

use crate::manager::brain::jsonl_stdio::Observer;

/// How the brain brings its agent up.
#[derive(Clone)]
pub enum AcpSpawn {
    /// A binary on this machine, put into ACP mode by `args`.
    Local { bin: String, args: Vec<String> },
    /// A command someone else built — an attach to an agent that runs on
    /// another machine. Called with the byte offset of the agent's output
    /// to stream from: 0 for the first attach, the reader's position for a
    /// reattach. `resumable` means the agent outlives a dropped pipe, so
    /// the pipe is brought back rather than the turn failed.
    ///
    /// The agent's files and shell are on its own machine, so it is told
    /// this client serves neither; only the person's answers cross over.
    /// `cwd` is the session root there, sent exactly as given. `resume` is
    /// the agent's own id for a session it already holds: loaded instead
    /// of starting fresh when the agent can load sessions.
    Prepared {
        factory: Arc<dyn Fn(u64) -> tokio::process::Command + Send + Sync>,
        resumable: bool,
        cwd: String,
        resume: Option<String>,
    },
}

impl std::fmt::Debug for AcpSpawn {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AcpSpawn::Local { bin, args } => f.debug_struct("Local").field("bin", bin).field("args", args).finish(),
            AcpSpawn::Prepared { resumable, cwd, resume, .. } => f
                .debug_struct("Prepared")
                .field("resumable", resumable)
                .field("cwd", cwd)
                .field("resume", resume)
                .finish(),
        }
    }
}

/// What a tap sees of a conversation, for a caller that keeps its own
/// record of it (the cloud workspace log a teammate's view replays).
#[derive(Debug, Clone, PartialEq)]
pub enum TapEvent {
    /// Every request or notification the agent sent, with the byte offset
    /// of its output stream the line started at.
    Inbound { offset: u64, method: String, params: Value },
    /// Aura answered something the agent asked of the person
    /// (`_aura/permission_resolved` with `{requestId, optionId}`).
    Resolved { kind: String, payload: Value },
    /// A prompt was sent: the person's words, before the agent answers.
    TurnStarted { user_text: String, acp_session_id: String },
    /// A turn ended. `acp_session_id` is the agent's own session id.
    TurnFinished {
        user_text: String,
        assistant_text: String,
        stop_reason: Option<String>,
        acp_session_id: String,
    },
}

pub type Tap = Arc<dyn Fn(&TapEvent) + Send + Sync>;

/// Turns the transport's per-line observer into tap events: requests and
/// notifications only, which is every line that carries a method.
pub(super) fn inbound_observer(tap: Tap) -> Observer {
    Arc::new(move |offset, v: &Value| {
        let Some(method) = v.get("method").and_then(Value::as_str) else {
            return;
        };
        tap(&TapEvent::Inbound {
            offset,
            method: method.to_string(),
            params: v.get("params").cloned().unwrap_or(Value::Null),
        });
    })
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex as StdMutex;

    use async_trait::async_trait;
    use futures_util::StreamExt;
    use serde_json::json;

    use super::*;
    use crate::manager::brain::Brain;
    use crate::manager::brain::acp::brain::AcpBrain;
    use crate::manager::brain::acp::host::{GateDecision, HostPolicy};
    use crate::manager::brain::types::{ChatChunk, ChatMessage, ChatRequest};

    struct AllowAll;

    #[async_trait]
    impl HostPolicy for AllowAll {
        async fn ask_permission(&self, _: &str, _: &Value) -> GateDecision {
            GateDecision::Allow
        }
        async fn before_write(&self, _: &std::path::Path, _: Option<&str>) -> Result<(), String> {
            Ok(())
        }
    }

    /// A scripted agent, one reply per line it reads: initialize, a
    /// session whose model option is called `llm`, the model switch, then
    /// a prompt that asks permission before it answers. Every line it
    /// receives is kept in `heard`, so the test reads what Aura sent.
    fn scripted_agent(dir: &std::path::Path) -> String {
        let heard = dir.join("heard.log");
        let h = heard.to_string_lossy();
        let lines = [
            r#"{"jsonrpc":"2.0","id":"1","result":{"protocolVersion":1,"agentCapabilities":{},"authMethods":[]}}"#.to_string(),
            r#"{"jsonrpc":"2.0","id":"2","result":{"sessionId":"s1","configOptions":[{"id":"llm","name":"Model","category":"model","type":"select","currentValue":"a","options":[{"value":"a","name":"A"},{"value":"b","name":"B"}]}]}}"#.to_string(),
            r#"{"jsonrpc":"2.0","id":"3","result":{}}"#.to_string(),
            r#"{"jsonrpc":"2.0","id":99,"method":"session/request_permission","params":{"sessionId":"s1","toolCall":{"toolCallId":"t1","title":"Edit a.rs"},"options":[{"optionId":"ok","name":"Allow","kind":"allow_once"},{"optionId":"no","name":"Reject","kind":"reject_once"}]}}"#.to_string(),
        ];
        let after_answer = [
            r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"pong"}}}}"#,
            r#"{"jsonrpc":"2.0","id":"4","result":{"stopReason":"end_turn"}}"#,
        ];
        let mut script = String::new();
        for l in &lines {
            script.push_str(&format!("read -r l; echo \"$l\" >> '{h}'; echo '{l}'\n"));
        }
        script.push_str(&format!("read -r l; echo \"$l\" >> '{h}'\n"));
        for l in &after_answer {
            script.push_str(&format!("echo '{l}'\n"));
        }
        script.push_str("sleep 10\n");
        script
    }

    #[tokio::test]
    async fn a_prepared_agent_reports_frames_answers_and_the_finished_turn() {
        let dir = tempfile::tempdir().unwrap();
        let script = scripted_agent(dir.path());
        let offsets = Arc::new(StdMutex::new(Vec::new()));
        let asked = offsets.clone();
        let factory: Arc<dyn Fn(u64) -> tokio::process::Command + Send + Sync> = Arc::new(move |offset| {
            asked.lock().unwrap().push(offset);
            let mut cmd = tokio::process::Command::new("sh");
            cmd.arg("-c").arg(&script);
            cmd
        });

        let seen: Arc<StdMutex<Vec<TapEvent>>> = Arc::new(StdMutex::new(Vec::new()));
        let sink = seen.clone();
        let tap: Tap = Arc::new(move |e: &TapEvent| sink.lock().unwrap().push(e.clone()));
        let brain = AcpBrain::with_spawn(
            "box:test",
            "scripted",
            AcpSpawn::Prepared { factory, resumable: false, cwd: "/srv/box/repo".into(), resume: None },
            Arc::new(AllowAll),
        )
        .with_tap(tap);
        assert_eq!(brain.provider_id(), "box:test");

        let request = ChatRequest {
            messages: vec![ChatMessage { role: "user".into(), content: json!("ping") }],
            cwd: dir.path().to_string_lossy().into_owned(),
            model: Some("b".into()),
            ..Default::default()
        };
        let chunks: Vec<_> = tokio::time::timeout(
            std::time::Duration::from_secs(20),
            brain.chat(request).await.expect("turn starts").collect::<Vec<_>>(),
        )
        .await
        .expect("turn ends");

        let text: String = chunks
            .iter()
            .filter_map(|c| match c {
                Ok(ChatChunk::Text { text, .. }) => Some(text.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(text, "pong");
        assert!(matches!(chunks.last(), Some(Ok(ChatChunk::End { .. }))), "{chunks:?}");
        assert_eq!(offsets.lock().unwrap().clone(), vec![0], "first attach starts at the top");

        // The model is switched by the agent's own option id, as `configId`.
        let heard = std::fs::read_to_string(dir.path().join("heard.log")).unwrap();
        let switch: Value = serde_json::from_str(heard.lines().nth(2).unwrap()).unwrap();
        assert_eq!(switch["method"], "session/set_config_option");
        assert_eq!(switch["params"], json!({"sessionId": "s1", "configId": "llm", "value": "b"}));
        // And the permission was answered with the allow option.
        let answer: Value = serde_json::from_str(heard.lines().nth(4).unwrap()).unwrap();
        assert_eq!(answer["result"]["outcome"]["optionId"], "ok");

        let events = seen.lock().unwrap().clone();
        let inbound: Vec<(u64, String)> = events
            .iter()
            .filter_map(|e| match e {
                TapEvent::Inbound { offset, method, .. } => Some((*offset, method.clone())),
                _ => None,
            })
            .collect();
        assert_eq!(inbound.iter().map(|(_, m)| m.as_str()).collect::<Vec<_>>(), [
            "session/request_permission",
            "session/update"
        ]);
        assert!(inbound[0].0 > 0 && inbound[1].0 > inbound[0].0, "offsets climb: {inbound:?}");
        assert!(events.contains(&TapEvent::Resolved {
            kind: "_aura/permission_resolved".into(),
            payload: json!({"requestId": 99, "optionId": "ok", "outcome": "selected"}),
        }));
        assert_eq!(events.first(), Some(&TapEvent::TurnStarted {
            user_text: "ping".into(),
            acp_session_id: "s1".into(),
        }));
        assert_eq!(events.last(), Some(&TapEvent::TurnFinished {
            user_text: "ping".into(),
            assistant_text: "pong".into(),
            stop_reason: Some("end_turn".into()),
            acp_session_id: "s1".into(),
        }));
    }
    /// An agent scripted step by step: each step reads one line Aura sent
    /// (kept in `heard.log`) and then prints that step's lines.
    fn stepped_agent(dir: &std::path::Path, steps: &[&[&str]]) -> String {
        let h = dir.join("heard.log");
        let h = h.to_string_lossy();
        let mut script = String::new();
        for step in steps {
            script.push_str(&format!("read -r l; echo \"$l\" >> '{h}'\n"));
            for l in *step {
                script.push_str(&format!("echo '{l}'\n"));
            }
        }
        script.push_str("sleep 10\n");
        script
    }

    fn box_brain(script: String, resume: Option<&str>, tap: Tap) -> AcpBrain {
        let factory: Arc<dyn Fn(u64) -> tokio::process::Command + Send + Sync> = Arc::new(move |_| {
            let mut cmd = tokio::process::Command::new("sh");
            cmd.arg("-c").arg(&script);
            cmd
        });
        AcpBrain::with_spawn(
            "box:test",
            "scripted",
            AcpSpawn::Prepared {
                factory,
                resumable: false,
                cwd: "/srv/box/repo".into(),
                resume: resume.map(str::to_string),
            },
            Arc::new(AllowAll),
        )
        .with_tap(tap)
    }

    fn heard(dir: &std::path::Path) -> Vec<Value> {
        std::fs::read_to_string(dir.join("heard.log"))
            .unwrap()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }

    fn turn(messages: &[(&str, &str)], dir: &std::path::Path) -> ChatRequest {
        ChatRequest {
            messages: messages
                .iter()
                .map(|(role, text)| ChatMessage { role: role.to_string(), content: json!(text) })
                .collect(),
            cwd: dir.to_string_lossy().into_owned(),
            ..Default::default()
        }
    }

    async fn run(brain: &AcpBrain, request: ChatRequest) -> (String, Vec<Result<ChatChunk, crate::manager::brain::BrainError>>) {
        let chunks: Vec<_> = tokio::time::timeout(
            std::time::Duration::from_secs(20),
            brain.chat(request).await.expect("turn starts").collect::<Vec<_>>(),
        )
        .await
        .expect("turn ends");
        let text = chunks
            .iter()
            .filter_map(|c| match c {
                Ok(ChatChunk::Text { text, .. }) => Some(text.as_str()),
                _ => None,
            })
            .collect();
        (text, chunks)
    }

    #[tokio::test]
    async fn a_box_agent_is_loaded_back_offered_no_laptop_tools_and_told_only_whats_new() {
        let dir = tempfile::tempdir().unwrap();
        let script = stepped_agent(dir.path(), &[
            &[r#"{"jsonrpc":"2.0","id":"1","result":{"protocolVersion":1,"agentCapabilities":{"loadSession":true},"authMethods":[]}}"#],
            &[
                r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s-old","update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"first"}}}}"#,
                r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s-old","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"old answer"}}}}"#,
                r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s-old","update":{"sessionUpdate":"available_commands_update","availableCommands":[{"name":"plan","description":"Plan first"}]}}}"#,
                r#"{"jsonrpc":"2.0","id":"2","result":{}}"#,
            ],
            // Asked for a file on its own disk anyway; refused, not served
            // from this one.
            &[r#"{"jsonrpc":"2.0","id":98,"method":"fs/read_text_file","params":{"sessionId":"s-old","path":"/etc/hosts"}}"#],
            &[
                r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s-old","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"fresh"}}}}"#,
                r#"{"jsonrpc":"2.0","id":"3","result":{"stopReason":"end_turn"}}"#,
            ],
        ]);
        let seen: Arc<StdMutex<Vec<TapEvent>>> = Arc::new(StdMutex::new(Vec::new()));
        let sink = seen.clone();
        let brain = box_brain(script, Some("s-old"), Arc::new(move |e: &TapEvent| sink.lock().unwrap().push(e.clone())));

        let request = turn(&[("user", "first"), ("assistant", "old answer"), ("user", "second")], dir.path());
        let (text, chunks) = run(&brain, request).await;
        assert_eq!(text, "fresh", "the replayed history stays out of this turn: {chunks:?}");

        let heard = heard(dir.path());
        assert_eq!(
            heard[0]["params"]["clientCapabilities"],
            json!({"fs": {"readTextFile": false, "writeTextFile": false}, "terminal": false}),
        );
        assert_eq!(heard[1]["method"], "session/load");
        assert_eq!(heard[1]["params"], json!({"sessionId": "s-old", "cwd": "/srv/box/repo", "mcpServers": []}));
        assert_eq!(heard[2]["method"], "session/prompt");
        assert_eq!(heard[2]["params"]["sessionId"], "s-old");
        assert_eq!(heard[2]["params"]["prompt"], json!([{"type": "text", "text": "second"}]));
        assert_eq!(heard[3]["id"], 98);
        assert_eq!(heard[3]["error"]["code"], -32601);

        // The commands the replay carried still reach the composer.
        let surface = brain.session_surface(&dir.path().to_string_lossy()).await.expect("live session");
        assert_eq!(surface.commands.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), ["plan"]);

        // And the tap saw the replay, frame for frame.
        let replayed = seen
            .lock()
            .unwrap()
            .iter()
            .filter(|e| matches!(e, TapEvent::Inbound { method, .. } if method == "session/update"))
            .count();
        assert_eq!(replayed, 4, "three replayed frames and this turn's one");
    }

    #[tokio::test]
    async fn a_session_the_box_no_longer_has_is_started_fresh_and_told_the_history() {
        let dir = tempfile::tempdir().unwrap();
        let script = stepped_agent(dir.path(), &[
            &[r#"{"jsonrpc":"2.0","id":"1","result":{"protocolVersion":1,"agentCapabilities":{"loadSession":true},"authMethods":[]}}"#],
            &[r#"{"jsonrpc":"2.0","id":"2","error":{"code":-32002,"message":"no such session"}}"#],
            &[r#"{"jsonrpc":"2.0","id":"3","result":{"sessionId":"s-new"}}"#],
            &[
                r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s-new","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"ok"}}}}"#,
                r#"{"jsonrpc":"2.0","id":"4","result":{"stopReason":"end_turn"}}"#,
            ],
        ]);
        let brain = box_brain(script, Some("s-gone"), Arc::new(|_: &TapEvent| {}));
        let request = turn(&[("user", "first"), ("assistant", "a"), ("user", "second")], dir.path());
        let (text, _) = run(&brain, request).await;
        assert_eq!(text, "ok");

        let heard = heard(dir.path());
        assert_eq!(heard[1]["method"], "session/load");
        assert_eq!(heard[2]["method"], "session/new");
        assert_eq!(heard[2]["params"]["cwd"], "/srv/box/repo");
        let prompt = heard[3]["params"]["prompt"].to_string();
        assert!(prompt.contains("first") && prompt.contains("second"), "{prompt}");
    }
    /// A person who fills every form with the same name.
    struct FillsForms(StdMutex<Vec<Value>>);

    #[async_trait]
    impl HostPolicy for FillsForms {
        async fn ask_permission(&self, _: &str, _: &Value) -> GateDecision {
            GateDecision::Allow
        }
        async fn before_write(&self, _: &std::path::Path, _: Option<&str>) -> Result<(), String> {
            Ok(())
        }
        fn can_elicit(&self) -> bool {
            true
        }
        async fn elicit(&self, params: &Value) -> Result<Value, aura_acp::RpcError> {
            self.0.lock().unwrap().push(params.clone());
            Ok(json!({"action": "accept", "content": {"name": "Ada"}}))
        }
    }

    #[tokio::test]
    async fn a_form_the_agent_asks_for_is_answered_by_the_person_and_recorded() {
        let dir = tempfile::tempdir().unwrap();
        let script = stepped_agent(dir.path(), &[
            &[r#"{"jsonrpc":"2.0","id":"1","result":{"protocolVersion":1,"agentCapabilities":{},"authMethods":[]}}"#],
            &[r#"{"jsonrpc":"2.0","id":"2","result":{"sessionId":"s1"}}"#],
            &[r#"{"jsonrpc":"2.0","id":97,"method":"elicitation/create","params":{"sessionId":"s1","mode":"form","message":"Who is this for?","requestedSchema":{"type":"object","properties":{"name":{"type":"string"}},"required":["name"]}}}"#],
            &[
                r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"thanks"}}}}"#,
                r#"{"jsonrpc":"2.0","id":"3","result":{"stopReason":"end_turn"}}"#,
            ],
        ]);
        let factory: Arc<dyn Fn(u64) -> tokio::process::Command + Send + Sync> = Arc::new(move |_| {
            let mut cmd = tokio::process::Command::new("sh");
            cmd.arg("-c").arg(&script);
            cmd
        });
        let seen: Arc<StdMutex<Vec<TapEvent>>> = Arc::new(StdMutex::new(Vec::new()));
        let sink = seen.clone();
        let person = Arc::new(FillsForms(StdMutex::new(Vec::new())));
        let brain = AcpBrain::with_spawn(
            "box:test",
            "scripted",
            AcpSpawn::Prepared { factory, resumable: false, cwd: "/srv/box/repo".into(), resume: None },
            person.clone(),
        )
        .with_tap(Arc::new(move |e: &TapEvent| sink.lock().unwrap().push(e.clone())));

        let (text, _) = run(&brain, turn(&[("user", "make it")], dir.path())).await;
        assert_eq!(text, "thanks");

        let heard = heard(dir.path());
        assert_eq!(heard[0]["params"]["clientCapabilities"]["elicitation"], json!({"form": {}, "url": {}}));
        assert_eq!(heard[0]["params"]["clientCapabilities"]["terminal"], false);
        assert_eq!(heard[3]["id"], 97);
        assert_eq!(heard[3]["result"], json!({"action": "accept", "content": {"name": "Ada"}}));
        assert_eq!(person.0.lock().unwrap()[0]["message"], "Who is this for?");
        assert!(seen.lock().unwrap().contains(&TapEvent::Resolved {
            kind: "_aura/elicitation_resolved".into(),
            payload: json!({"requestId": 97, "action": "accept", "content": {"name": "Ada"}}),
        }));
    }
}
