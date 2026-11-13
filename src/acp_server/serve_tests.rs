//! `aura acp-serve` as a conversational agent: Aura's own turns, and Aura
//! in front of an engine.

use std::io::{self, Write};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::engine::{from_registry, Front};
use super::local::{available_commands, own_command, LocalTurns, Out};
use crate::acp_proxy::effects::{Effects, Gate, GateQuery, Turn, WriteAt};
use crate::acp_proxy::{Filter, Guard, To};

/// What the client was sent, shared with the turns writing it.
#[derive(Clone, Default)]
struct Screen(Arc<Mutex<Vec<u8>>>);

impl Write for Screen {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl Screen {
    fn frames(&self) -> Vec<Value> {
        String::from_utf8_lossy(&self.0.lock().unwrap())
            .lines()
            .filter_map(|l| serde_json::from_str(l).ok())
            .collect()
    }

    /// Frames once one answers request `id`, or a panic after 10s.
    fn until_answered(&self, id: Value) -> Vec<Value> {
        let start = Instant::now();
        loop {
            let frames = self.frames();
            if frames.iter().any(|f| f.get("method").is_none() && f.get("id") == Some(&id)) {
                return frames;
            }
            assert!(start.elapsed() < Duration::from_secs(10), "no answer to {id}: {frames:?}");
            thread::sleep(Duration::from_millis(5));
        }
    }
}

fn out(screen: &Screen) -> Out {
    Arc::new(Mutex::new(screen.clone()))
}

/// A verb that always says `text`.
fn saying(text: &'static str) -> Arc<dyn Fn(&str, &str) -> Value + Send + Sync> {
    Arc::new(move |_: &str, _: &str| json!({ "content": [{ "type": "text", "text": text }] }))
}

/// A verb that says "late" only once `release` is sent.
fn held() -> (Arc<dyn Fn(&str, &str) -> Value + Send + Sync>, mpsc::Sender<()>) {
    let (tx, rx) = mpsc::channel::<()>();
    let rx = Mutex::new(rx);
    let run = Arc::new(move |_: &str, _: &str| {
        let _ = rx.lock().unwrap().recv_timeout(Duration::from_secs(10));
        json!({ "content": [{ "type": "text", "text": "late" }] })
    });
    (run, tx)
}

fn update_kind(f: &Value) -> Option<&str> {
    f.pointer("/params/update/sessionUpdate").and_then(Value::as_str)
}

fn command_names(frame: &Value) -> Vec<String> {
    frame
        .pointer("/params/update/availableCommands")
        .and_then(Value::as_array)
        .map(|cs| cs.iter().filter_map(|c| c["name"].as_str().map(str::to_string)).collect())
        .unwrap_or_default()
}

fn said(frames: &[Value]) -> String {
    frames
        .iter()
        .filter(|f| update_kind(f) == Some("agent_message_chunk"))
        .filter_map(|f| f.pointer("/params/update/content/text").and_then(Value::as_str))
        .collect()
}

#[test]
fn aura_offers_its_commands_first_and_keeps_the_engines_that_do_not_clash() {
    let engine = [json!({"name":"prove","description":"theirs"}), json!({"name":"compress","description":"Shrink the context"})];
    let frame = available_commands("s1", &engine);
    assert_eq!(frame["params"]["sessionId"], json!("s1"));
    assert_eq!(update_kind(&frame), Some("available_commands_update"));
    assert_eq!(command_names(&frame), ["prove", "review", "impacts", "compress"]);
    let prove = &frame["params"]["update"]["availableCommands"][0];
    assert!(prove["description"].as_str().unwrap().contains("behaviour"), "Aura's prove, not the engine's");
    assert!(prove["input"]["hint"].is_string());
}

#[test]
fn only_auras_three_slash_commands_are_kept_from_the_engine() {
    assert_eq!(own_command("/prove User can log in"), Some(("prove".into(), "User can log in".into())));
    assert_eq!(own_command("  /Review develop "), Some(("review".into(), "develop".into())));
    assert_eq!(own_command("/impacts"), Some(("impacts".into(), String::new())));
    assert_eq!(own_command("/help"), None, "help is the engine's when there is one");
    assert_eq!(own_command("/compress"), None);
    assert_eq!(own_command("prove it works"), None, "a sentence is a prompt, not a command");
}

#[test]
fn a_local_turn_streams_a_tool_call_then_its_output_then_ends_the_turn() {
    let screen = Screen::default();
    let turns = LocalTurns::with_runner(out(&screen), saying("Goal is wired: login → session → token."));
    turns.start(json!(7), "s1".into(), "/prove User can log in".into());
    let frames = screen.until_answered(json!(7));
    let kinds: Vec<&str> = frames.iter().map(|f| update_kind(f).unwrap_or("response")).collect();
    assert_eq!(kinds, ["tool_call", "agent_message_chunk", "tool_call_update", "response"]);
    assert_eq!(frames[0].pointer("/params/update/status"), Some(&json!("in_progress")));
    assert_eq!(frames[0].pointer("/params/update/title"), Some(&json!("Proving: User can log in")));
    assert_eq!(frames[0].pointer("/params/update/toolCallId"), frames[2].pointer("/params/update/toolCallId"));
    assert_eq!(frames[2].pointer("/params/update/status"), Some(&json!("completed")));
    assert_eq!(frames[3]["result"]["stopReason"], json!("end_turn"));
    assert_eq!(said(&frames), "Goal is wired: login → session → token.");
    assert!(!turns.is_running("s1"));
}

#[test]
fn a_command_that_fails_marks_its_tool_call_failed_but_still_ends_the_turn() {
    let screen = Screen::default();
    let failing = Arc::new(|_: &str, _: &str| json!({ "isError": true, "content": [{ "type": "text", "text": "not a git repo" }] }));
    let turns = LocalTurns::with_runner(out(&screen), failing);
    turns.start(json!("r1"), "s1".into(), "/review".into());
    let frames = screen.until_answered(json!("r1"));
    let done = frames.iter().find(|f| update_kind(f) == Some("tool_call_update")).unwrap();
    assert_eq!(done.pointer("/params/update/status"), Some(&json!("failed")));
    assert_eq!(frames.last().unwrap()["result"]["stopReason"], json!("end_turn"));
}

#[test]
fn help_is_said_without_a_tool_call() {
    let screen = Screen::default();
    LocalTurns::new(out(&screen)).start(json!(3), "s1".into(), "help".into());
    let frames = screen.until_answered(json!(3));
    assert!(frames.iter().all(|f| update_kind(f) != Some("tool_call")));
    assert!(said(&frames).contains("/prove"), "{frames:?}");
}

#[test]
fn cancelling_a_local_turn_answers_cancelled_at_once_and_drops_the_late_output() {
    let screen = Screen::default();
    let (run, release) = held();
    let turns = LocalTurns::with_runner(out(&screen), run);
    turns.start(json!(9), "s1".into(), "/impacts".into());
    assert!(turns.is_running("s1"));
    assert!(turns.cancel("s1"));
    let frames = screen.until_answered(json!(9));
    let kinds: Vec<&str> = frames.iter().map(|f| update_kind(f).unwrap_or("response")).collect();
    assert_eq!(kinds, ["tool_call", "tool_call_update", "response"], "the call is shown before it is ended");
    assert_eq!(frames[1].pointer("/params/update/status"), Some(&json!("failed")));
    assert_eq!(frames[2]["result"]["stopReason"], json!("cancelled"));
    assert!(!turns.is_running("s1"));
    assert!(!turns.cancel("s1"), "nothing left to cancel");

    release.send(()).unwrap();
    thread::sleep(Duration::from_millis(150));
    let after = screen.frames();
    assert_eq!(after.len(), frames.len(), "nothing is sent after the turn ended: {after:?}");
    assert!(!said(&after).contains("late"));
}

/// Effects that refuse every delete and record the rest.
#[derive(Clone, Default)]
struct Fake {
    snaps: Arc<Mutex<Vec<String>>>,
    turns: Arc<Mutex<Vec<Turn>>>,
}

impl Effects for Fake {
    fn snapshot(&mut self, at: &WriteAt<'_>) {
        self.snaps.lock().unwrap().push(at.path.to_string());
    }
    fn log_turn(&mut self, turn: &Turn, _stop_reason: &str) {
        self.turns.lock().unwrap().push(turn.clone());
    }
    fn gate(&mut self, query: &GateQuery) -> Gate {
        if query.tool == "delete_file" {
            Gate::Deny { title: "Delete file".into(), reason: "policy says no".into() }
        } else {
            Gate::Pass
        }
    }
}

fn front(screen: &Screen, run: Arc<dyn Fn(&str, &str) -> Value + Send + Sync>) -> (Front<Fake>, Fake) {
    let fake = Fake::default();
    let f = Front::new(Guard::new(fake.clone()), LocalTurns::with_runner(out(screen), run), "gemini".into());
    (f, fake)
}

fn line(v: Value) -> String {
    format!("{v}\n")
}

fn client(step: &crate::acp_proxy::Step, at: usize) -> Value {
    match &step.extra[at] {
        To::Client(f) => serde_json::from_str(f).unwrap(),
        other => panic!("not for the client: {other:?}"),
    }
}

fn prompt(id: Value, text: &str) -> String {
    line(json!({"jsonrpc":"2.0","id":id,"method":"session/prompt","params":{"sessionId":"s1","prompt":[{"type":"text","text":text}]}}))
}

fn opened(f: &mut Front<Fake>) -> crate::acp_proxy::Step {
    f.from_client(&line(json!({"jsonrpc":"2.0","id":1,"method":"session/new","params":{"cwd":"/repo","mcpServers":[]}})));
    f.from_agent(&line(json!({"jsonrpc":"2.0","id":1,"result":{"sessionId":"s1"}})))
}

#[test]
fn initialize_introduces_aura_with_the_engine_named_behind_it() {
    let (mut f, _) = front(&Screen::default(), saying(""));
    assert!(f.from_client(&line(json!({"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":1}}))).pass);
    let theirs = json!({"jsonrpc":"2.0","id":0,"result":{"protocolVersion":1,
        "agentCapabilities":{"loadSession":true,"promptCapabilities":{"image":true}},
        "agentInfo":{"name":"gemini-cli","title":"Gemini CLI","version":"0.55.1"},
        "authMethods":[{"id":"oauth-personal","name":"Log in with Google"}]}});
    let step = f.from_agent(&line(theirs));
    assert!(!step.pass, "the engine's own introduction is replaced, not sent too");
    let ours = client(&step, 0);
    assert_eq!(ours["id"], json!(0));
    assert_eq!(ours.pointer("/result/agentInfo/name"), Some(&json!("aura")));
    assert_eq!(ours.pointer("/result/agentInfo/title"), Some(&json!("Aura · Gemini CLI")));
    assert_eq!(ours.pointer("/result/_meta/aura/engine/version"), Some(&json!("0.55.1")));
    assert_eq!(ours.pointer("/result/agentCapabilities/loadSession"), Some(&json!(true)), "capabilities are the engine's");
    assert_eq!(ours.pointer("/result/authMethods/0/id"), Some(&json!("oauth-personal")));

    // Any other answer with the same id later is not rewritten.
    let step = f.from_agent(&line(json!({"jsonrpc":"2.0","id":0,"result":{}})));
    assert!(step.pass && step.extra.is_empty());
}

#[test]
fn a_new_session_is_offered_auras_commands_then_the_engines_list_is_merged_in() {
    let (mut f, _) = front(&Screen::default(), saying(""));
    let step = opened(&mut f);
    assert!(step.pass, "the engine's answer reaches the client");
    assert_eq!(command_names(&client(&step, 0)), ["prove", "review", "impacts"]);

    let theirs = line(json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{
        "sessionUpdate":"available_commands_update","availableCommands":[{"name":"compress","description":"Shrink"},{"name":"review","description":"theirs"}]}}}));
    let step = f.from_agent(&theirs);
    assert!(!step.pass, "the engine's list is replaced by the merged one");
    assert_eq!(command_names(&client(&step, 0)), ["prove", "review", "impacts", "compress"]);
}

#[test]
fn a_loaded_session_is_offered_the_commands_under_the_id_it_was_loaded_as() {
    let (mut f, _) = front(&Screen::default(), saying(""));
    f.from_client(&line(json!({"jsonrpc":"2.0","id":"L","method":"session/load","params":{"sessionId":"old-7","cwd":"/repo","mcpServers":[]}})));
    // A load's answer does not repeat the session id, and may be null.
    let step = f.from_agent(&line(json!({"jsonrpc":"2.0","id":"L","result":null})));
    assert!(step.pass);
    let offer = client(&step, 0);
    assert_eq!(offer["params"]["sessionId"], json!("old-7"));
    assert_eq!(command_names(&offer), ["prove", "review", "impacts"]);

    f.from_client(&line(json!({"jsonrpc":"2.0","id":"M","method":"session/load","params":{"sessionId":"old-8","cwd":"/repo","mcpServers":[]}})));
    let err = f.from_agent(&line(json!({"jsonrpc":"2.0","id":"M","error":{"code":-32603,"message":"gone"}})));
    assert!(err.pass && err.extra.is_empty(), "no commands for a session that did not open");
}

#[test]
fn auras_slash_commands_are_answered_by_aura_and_never_reach_the_engine() {
    let screen = Screen::default();
    let (mut f, fake) = front(&screen, saying("No unresolved impacts."));
    opened(&mut f);
    let step = f.from_client(&prompt(json!(2), "/impacts"));
    assert!(!step.pass && step.extra.is_empty());
    let frames = screen.until_answered(json!(2));
    assert_eq!(said(&frames), "No unresolved impacts.");
    assert_eq!(frames.last().unwrap()["result"]["stopReason"], json!("end_turn"));
    assert!(fake.turns.lock().unwrap().is_empty(), "a local turn is not an engine turn");
}

#[test]
fn a_free_prompt_and_the_engines_own_commands_go_to_the_engine() {
    let (mut f, _) = front(&Screen::default(), saying(""));
    opened(&mut f);
    assert!(f.from_client(&prompt(json!(2), "fix the off-by-one in the parser")).pass);
    assert!(f.from_client(&prompt(json!(3), "/compress")).pass);
    assert!(f.from_client(&prompt(json!(4), "/help")).pass);
}

#[test]
fn a_cancel_for_auras_turn_stays_with_aura_and_any_other_reaches_the_engine() {
    let screen = Screen::default();
    let (run, release) = held();
    let (mut f, _) = front(&screen, run);
    opened(&mut f);
    f.from_client(&prompt(json!(5), "/review"));
    let cancel = line(json!({"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":"s1"}}));
    assert!(!f.from_client(&cancel).pass, "the engine has no turn to cancel");
    let frames = screen.until_answered(json!(5));
    assert_eq!(frames.last().unwrap()["result"]["stopReason"], json!("cancelled"));
    assert!(f.from_client(&cancel).pass, "with no local turn the cancel is the engine's");
    release.send(()).unwrap();
}

#[test]
fn the_engines_permission_requests_still_go_through_the_gate() {
    let (mut f, fake) = front(&Screen::default(), saying(""));
    opened(&mut f);
    f.from_client(&prompt(json!(2), "clean up"));
    let ask = line(json!({"jsonrpc":"2.0","id":11,"method":"session/request_permission","params":{"sessionId":"s1",
        "toolCall":{"toolCallId":"c1","kind":"delete","locations":[{"path":"/repo/.aura/intent_log.jsonl"}]},
        "options":[{"optionId":"ok","name":"Allow","kind":"allow_once"},{"optionId":"no","name":"Reject","kind":"reject_once"}]}}));
    let step = f.from_agent(&ask);
    assert!(!step.pass);
    let To::Agent(reply) = &step.extra[1] else { panic!("{step:?}") };
    let reply: Value = serde_json::from_str(reply).unwrap();
    assert_eq!(reply.pointer("/result/outcome/optionId"), Some(&json!("no")));

    let edit = line(json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{
        "sessionUpdate":"tool_call","toolCallId":"c2","kind":"edit","status":"pending","locations":[{"path":"/repo/src/a.rs"}]}}}));
    assert!(f.from_agent(&edit).pass);
    assert_eq!(*fake.snaps.lock().unwrap(), ["/repo/src/a.rs"]);
    f.from_agent(&line(json!({"jsonrpc":"2.0","id":2,"result":{"stopReason":"end_turn"}})));
    assert_eq!(fake.turns.lock().unwrap()[0].writes, ["/repo/src/a.rs"]);
}

#[test]
fn an_engine_is_resolved_from_the_registry_by_its_id_or_auras_name_for_it() {
    use aura_acp::registry::{Probe, Registry};
    use std::path::{Path, PathBuf};
    let home = Path::new("/nonexistent-home");
    let reg = Registry::pinned();
    let on_path = |name: &str| (name == "gemini" || name == "qwen").then(|| PathBuf::from(format!("/bin/{name}")));
    let probe = Probe { home, which: &on_path };

    let gemini = from_registry("gemini", &reg, &probe).unwrap();
    let qwen = from_registry("qwen", &reg, &probe).unwrap();
    assert_eq!(qwen.label, "qwen-code", "Aura's name for an agent finds its registry entry");
    assert_eq!(gemini.label, "gemini");
    assert_eq!(gemini.program, "/bin/gemini");
    assert!(!gemini.args.is_empty(), "launched in ACP mode: {:?}", gemini.args);

    let none = |_: &str| None;
    let bare = Probe { home, which: &none };
    let err = from_registry("no-such-agent", &reg, &bare).unwrap_err();
    assert!(err.contains("Known:") && err.contains("gemini"), "{err}");
}

#[test]
fn a_trailing_command_beats_a_registry_id_and_nothing_named_is_tool_only() {
    use super::engine::resolve;
    let cmd = vec!["/opt/agents/my-agent".to_string(), "--acp".to_string()];
    let e = resolve(Some("gemini"), &cmd).unwrap().unwrap();
    assert_eq!((e.label.as_str(), e.program.as_str(), e.args.as_slice()), ("my-agent", "/opt/agents/my-agent", &["--acp".to_string()][..]));
    if std::env::var_os("AURA_ACP_AGENT").is_none() {
        assert_eq!(resolve(None, &[]), Ok(None));
        assert_eq!(resolve(Some("  "), &[]), Ok(None));
    }
}
