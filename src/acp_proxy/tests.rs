use std::io::{self, BufReader, Read, Write};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::effects::{intent_type_for, Gate, GateQuery, Turn, WriteAt};
use super::guard::tool_for;
use super::*;

/// Effects that only remember what was asked of them. The gate refuses
/// every delete and lets everything else through.
#[derive(Clone, Default)]
struct Recorder {
    snaps: Arc<Mutex<Vec<(String, String)>>>,
    turns: Arc<Mutex<Vec<(Turn, String)>>>,
    gated: Arc<Mutex<Vec<GateQuery>>>,
}

impl Effects for Recorder {
    fn snapshot(&mut self, at: &WriteAt<'_>) {
        self.snaps.lock().unwrap().push((at.path.to_string(), at.why.to_string()));
    }
    fn log_turn(&mut self, turn: &Turn, stop_reason: &str) {
        self.turns.lock().unwrap().push((turn.clone(), stop_reason.to_string()));
    }
    fn gate(&mut self, query: &GateQuery) -> Gate {
        self.gated.lock().unwrap().push(query.clone());
        if query.tool == "delete_file" {
            Gate::Deny { title: "Delete file".into(), reason: "policy says no".into() }
        } else {
            Gate::Pass
        }
    }
}

fn snapped(r: &Recorder) -> Vec<String> {
    r.snaps.lock().unwrap().iter().map(|(p, _)| p.clone()).collect()
}

fn line(v: Value) -> String {
    v.to_string()
}

fn open(g: &mut Guard<Recorder>, cwd: &str) {
    g.from_client(&line(json!({"jsonrpc":"2.0","id":1,"method":"session/new","params":{"cwd":cwd,"mcpServers":[]}})));
    g.from_agent(&line(json!({"jsonrpc":"2.0","id":1,"result":{"sessionId":"s1"}})));
}

fn prompt(g: &mut Guard<Recorder>, id: u64, text: &str) {
    g.from_client(&line(json!({"jsonrpc":"2.0","id":id,"method":"session/prompt","params":{"sessionId":"s1","prompt":[{"type":"text","text":text}]}})));
}

fn tool_call(id: &str, kind: &str, status: &str, path: &str) -> String {
    line(json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{
        "sessionUpdate":"tool_call","toolCallId":id,"title":"t","kind":kind,"status":status,
        "locations":[{"path":path}]}}}))
}

#[test]
fn a_frame_that_is_not_json_rpc_is_passed_on_untouched() {
    let mut g = Guard::new(Recorder::default());
    assert_eq!(g.from_agent("not json at all\n"), Step { pass: true, extra: vec![] });
    assert_eq!(g.from_client("{\"jsonrpc\":\"2.0\",\"method\":\"x\"}\n"), Step { pass: true, extra: vec![] });
}

#[test]
fn an_edit_that_has_not_run_is_snapshotted_once_and_counted_for_the_turn() {
    let r = Recorder::default();
    let mut g = Guard::new(r.clone());
    open(&mut g, "/repo");
    prompt(&mut g, 2, "fix the parser");
    assert!(g.from_agent(&tool_call("c1", "edit", "pending", "/repo/src/a.rs")).pass);
    // The same call reported again (in progress) is not a second snapshot.
    let again = line(json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{
        "sessionUpdate":"tool_call_update","toolCallId":"c1","status":"in_progress","locations":[{"path":"/repo/src/a.rs"}]}}}));
    assert!(g.from_agent(&again).pass);
    assert_eq!(snapped(&r), vec!["/repo/src/a.rs"]);
    assert!(r.snaps.lock().unwrap()[0].1.contains("fix the parser"), "the reason is what was asked");

    g.from_agent(&line(json!({"jsonrpc":"2.0","id":2,"result":{"stopReason":"end_turn"}})));
    let turns = r.turns.lock().unwrap();
    assert_eq!(turns.len(), 1);
    assert_eq!(turns[0].0.writes, vec!["/repo/src/a.rs"]);
    assert_eq!(turns[0].0.prompt, "fix the parser");
    assert_eq!(turns[0].0.cwd, "/repo");
    assert_eq!(turns[0].1, "end_turn");
}

#[test]
fn a_write_reported_only_after_it_ran_is_counted_but_not_snapshotted() {
    // The file already holds the new content; a "before" snapshot of it
    // would be a lie that `aura rewind` would then restore.
    let r = Recorder::default();
    let mut g = Guard::new(r.clone());
    open(&mut g, "/repo");
    prompt(&mut g, 2, "add a flag");
    g.from_agent(&tool_call("c1", "edit", "completed", "/repo/src/b.rs"));
    g.from_agent(&line(json!({"jsonrpc":"2.0","id":2,"result":{"stopReason":"end_turn"}})));
    assert!(snapped(&r).is_empty());
    assert_eq!(r.turns.lock().unwrap()[0].0.writes, vec!["/repo/src/b.rs"]);
}

#[test]
fn an_update_that_leaves_out_the_kind_still_counts_as_the_write_it_announced() {
    let r = Recorder::default();
    let mut g = Guard::new(r.clone());
    open(&mut g, "/repo");
    prompt(&mut g, 2, "rename it");
    g.from_agent(&line(json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{
        "sessionUpdate":"tool_call","toolCallId":"c9","title":"Move","kind":"move","status":"pending"}}})));
    g.from_agent(&line(json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{
        "sessionUpdate":"tool_call_update","toolCallId":"c9","locations":[{"path":"/repo/old.rs"},{"path":"/repo/new.rs"}]}}})));
    assert_eq!(snapped(&r), vec!["/repo/old.rs", "/repo/new.rs"]);
}

#[test]
fn a_read_or_a_search_is_never_snapshotted_and_a_quiet_turn_logs_nothing() {
    let r = Recorder::default();
    let mut g = Guard::new(r.clone());
    open(&mut g, "/repo");
    prompt(&mut g, 2, "what does this do?");
    g.from_agent(&tool_call("c1", "read", "pending", "/repo/src/a.rs"));
    g.from_agent(&tool_call("c2", "search", "pending", "/repo/src"));
    g.from_agent(&line(json!({"jsonrpc":"2.0","id":2,"result":{"stopReason":"end_turn"}})));
    assert!(snapped(&r).is_empty());
    assert!(r.turns.lock().unwrap().is_empty(), "no files touched, no intent row");
}

#[test]
fn a_client_side_write_is_snapshotted_before_the_client_sees_it() {
    let r = Recorder::default();
    let mut g = Guard::new(r.clone());
    open(&mut g, "/repo");
    prompt(&mut g, 2, "write the config");
    let write = line(json!({"jsonrpc":"2.0","id":40,"method":"fs/write_text_file","params":{"sessionId":"s1","path":"/repo/c.toml","content":"x"}}));
    assert_eq!(g.from_agent(&write), Step { pass: true, extra: vec![] });
    assert_eq!(snapped(&r), vec!["/repo/c.toml"]);
    // The client's answer to that write is not the end of the turn.
    g.from_client(&line(json!({"jsonrpc":"2.0","id":40,"result":null})));
    assert!(r.turns.lock().unwrap().is_empty());
}

#[test]
fn the_client_write_that_carries_out_an_asked_edit_is_not_kept_twice() {
    // Gemini asks permission for an edit, then performs it with
    // fs/write_text_file: one change, one snapshot. A second write to the
    // same file is a second change and is kept again.
    let r = Recorder::default();
    let mut g = Guard::new(r.clone());
    open(&mut g, "/repo");
    prompt(&mut g, 2, "change old to new");
    let ask = line(json!({"jsonrpc":"2.0","id":8,"method":"session/request_permission","params":{"sessionId":"s1",
        "toolCall":{"toolCallId":"c4","kind":"edit","locations":[{"path":"/repo/notes.txt"}]},
        "options":[{"optionId":"no","name":"Reject","kind":"reject_once"}]}}));
    g.from_agent(&ask);
    let write = |id: u64| line(json!({"jsonrpc":"2.0","id":id,"method":"fs/write_text_file","params":{"sessionId":"s1","path":"/repo/notes.txt","content":"x"}}));
    g.from_agent(&write(40));
    assert_eq!(snapped(&r), vec!["/repo/notes.txt"]);
    g.from_agent(&write(41));
    assert_eq!(snapped(&r), vec!["/repo/notes.txt", "/repo/notes.txt"]);
}

#[test]
fn a_permission_the_gate_refuses_is_answered_no_and_the_client_is_told_why() {
    let r = Recorder::default();
    let mut g = Guard::new(r.clone());
    open(&mut g, "/repo");
    prompt(&mut g, 2, "clean up");
    let ask = line(json!({"jsonrpc":"2.0","id":7,"method":"session/request_permission","params":{"sessionId":"s1",
        "toolCall":{"toolCallId":"c3","title":"Delete","kind":"delete","locations":[{"path":"/repo/.aura/intent_log.jsonl"}]},
        "options":[{"optionId":"yes","name":"Allow","kind":"allow_once"},{"optionId":"no","name":"Reject","kind":"reject_once"}]}}));
    let step = g.from_agent(&ask);
    assert!(!step.pass, "the human is not asked to approve what is already refused");
    let [To::Client(notice), To::Agent(reply)] = step.extra.as_slice() else { panic!("{step:?}") };
    let notice: Value = serde_json::from_str(notice).unwrap();
    assert_eq!(notice.pointer("/params/update/sessionUpdate"), Some(&json!("agent_message_chunk")));
    let said = notice.pointer("/params/update/content/text").and_then(Value::as_str).unwrap();
    assert!(said.contains("Aura blocked") && said.contains("policy says no"), "{said}");
    let reply: Value = serde_json::from_str(reply).unwrap();
    assert_eq!(reply["id"], json!(7));
    assert_eq!(reply.pointer("/result/outcome"), Some(&json!({"outcome":"selected","optionId":"no"})));
    assert!(snapped(&r).is_empty(), "a refused delete never runs, so nothing to keep");
    let gated = r.gated.lock().unwrap();
    assert_eq!(gated[0].tool, "delete_file");
    assert_eq!(gated[0].input["file_path"], json!("/repo/.aura/intent_log.jsonl"));
}

#[test]
fn a_refusal_with_no_reject_option_cancels_rather_than_allows() {
    let mut g = Guard::new(Recorder::default());
    let ask = line(json!({"jsonrpc":"2.0","id":"p1","method":"session/request_permission","params":{"sessionId":"s1",
        "toolCall":{"toolCallId":"c3","kind":"delete","locations":[{"path":"/x"}]},
        "options":[{"optionId":"yes","name":"Allow","kind":"allow_always"}]}}));
    let step = g.from_agent(&ask);
    let To::Agent(reply) = &step.extra[1] else { panic!() };
    let reply: Value = serde_json::from_str(reply).unwrap();
    assert_eq!(reply["id"], json!("p1"));
    assert_eq!(reply.pointer("/result/outcome"), Some(&json!({"outcome":"cancelled"})));
}

#[test]
fn a_permission_the_gate_allows_reaches_the_client_and_snapshots_its_files() {
    let r = Recorder::default();
    let mut g = Guard::new(r.clone());
    open(&mut g, "/repo");
    prompt(&mut g, 2, "add logging");
    let ask = line(json!({"jsonrpc":"2.0","id":8,"method":"session/request_permission","params":{"sessionId":"s1",
        "toolCall":{"toolCallId":"c4","kind":"edit","rawInput":{"file_path":"/repo/a.rs","old_string":"a","new_string":"b"},
        "locations":[{"path":"/repo/a.rs"}]},
        "options":[{"optionId":"no","name":"Reject","kind":"reject_once"}]}}));
    assert_eq!(g.from_agent(&ask), Step { pass: true, extra: vec![] });
    assert_eq!(snapped(&r), vec!["/repo/a.rs"]);
    assert_eq!(r.gated.lock().unwrap()[0].tool, "edit");
}

#[test]
fn acp_tool_kinds_map_onto_the_tools_the_gate_already_knows() {
    let call = json!({"kind":"edit","rawInput":{"path":"/r/a.rs","content":"all new"},"locations":[{"path":"/r/a.rs"}]});
    assert_eq!(tool_for(&call, "edit", None).0, "write", "a whole-file write is judged as one");
    let call = json!({"rawInput":{"command":"rm -rf build"}});
    let (name, input) = tool_for(&call, "execute", None);
    assert_eq!((name.as_str(), input["command"].as_str()), ("bash", Some("rm -rf build")));
    let call = json!({"locations":[{"path":"/r/a"},{"path":"/r/b"}]});
    let (name, input) = tool_for(&call, "move", None);
    assert_eq!((name.as_str(), input["command"].as_str()), ("bash", Some("mv /r/a /r/b")));
    let call = json!({"locations":[{"path":"/r/gone.rs"}]});
    let (name, input) = tool_for(&call, "delete", None);
    assert_eq!((name.as_str(), input["file_path"].as_str()), ("delete_file", Some("/r/gone.rs")));
}

#[test]
fn the_intent_type_is_guessed_from_whole_words_of_the_request() {
    assert_eq!(intent_type_for("Fix the crash on save"), "BugFix");
    assert_eq!(intent_type_for("add a prefix option"), "FeatureAdd", "`prefix` is not a fix");
    assert_eq!(intent_type_for("refactor the router"), "Refactor");
    assert_eq!(intent_type_for("update the README"), "Docs");
    assert_eq!(intent_type_for("undo that"), "Revert");
    assert_eq!(intent_type_for("bump serde"), "Deps");
    assert_eq!(intent_type_for("make startup faster"), "Performance");
}

#[test]
fn the_real_gate_refuses_an_agent_deleting_auras_own_records() {
    // Repo policy denies `.aura/` mutations whatever strict mode says, so
    // this holds on any machine.
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join(".git")).unwrap();
    std::fs::create_dir_all(dir.path().join(".aura")).unwrap();
    std::fs::write(dir.path().join(".aura/intent_log.jsonl"), "{}\n").unwrap();
    let cwd = dir.path().to_string_lossy().to_string();
    let target = dir.path().join(".aura/intent_log.jsonl").to_string_lossy().to_string();
    let call = json!({"kind":"delete","locations":[{"path":target}]});
    let (tool, input) = tool_for(&call, "delete", Some(&cwd));
    assert_eq!(input["file_path"], json!(".aura/intent_log.jsonl"), "judged repo-relative, as policy globs are");
    let mut live = LiveEffects::new("test".into(), std::path::PathBuf::from("/nonexistent"));
    let gate = live.gate(&GateQuery { tool, input, cwd: Some(cwd) });
    assert!(matches!(gate, Gate::Deny { .. }), "{gate:?}");
}

// ── The relay, end to end, around a scripted agent ─────────────────────────

/// The client's stdin: frames are fed one at a time, and dropping the
/// sender is the client hanging up.
struct Feed(mpsc::Receiver<Vec<u8>>, Vec<u8>);

impl Read for Feed {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.1.is_empty() {
            match self.0.recv() {
                Ok(bytes) => self.1 = bytes,
                Err(_) => return Ok(0),
            }
        }
        let n = buf.len().min(self.1.len());
        buf[..n].copy_from_slice(&self.1[..n]);
        self.1.drain(..n);
        Ok(n)
    }
}

/// The client's stdout.
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
    fn text(&self) -> String {
        String::from_utf8_lossy(&self.0.lock().unwrap()).to_string()
    }
    fn wait_for(&self, needle: &str) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while !self.text().contains(needle) {
            assert!(Instant::now() < deadline, "never saw {needle}: {}", self.text());
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

#[test]
fn the_proxy_relays_a_whole_turn_and_does_its_four_jobs_on_the_way() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_string_lossy().to_string();
    let heard = dir.path().join("heard");
    let tool_call = tool_call("c1", "edit", "pending", &format!("{root}/a.rs"));
    let write = line(json!({"jsonrpc":"2.0","id":100,"method":"fs/write_text_file","params":{"sessionId":"s1","path":format!("{root}/b.rs"),"content":"new"}}));
    let ask = line(json!({"jsonrpc":"2.0","id":101,"method":"session/request_permission","params":{"sessionId":"s1",
        "toolCall":{"toolCallId":"c2","kind":"delete","locations":[{"path":format!("{root}/.aura/x")}]},
        "options":[{"optionId":"ok","name":"Allow","kind":"allow_once"},{"optionId":"reject","name":"Reject","kind":"reject_once"}]}}));
    // A stray space and a trailing CR survive: pass-through means the bytes.
    let odd = "{\"jsonrpc\":\"2.0\", \"method\":\"_vendor/ping\"}\r";
    let script = format!(
        "read -r l; echo '{{\"jsonrpc\":\"2.0\",\"id\":0,\"result\":{{\"protocolVersion\":1}}}}'\n\
         read -r l; echo '{{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{{\"sessionId\":\"s1\"}}}}'\n\
         read -r l; printf '%s\\n' '{odd}'; echo '{tool_call}'; echo '{write}'; echo '{ask}'\n\
         read -r a; read -r b; printf '%s\\n%s\\n' \"$a\" \"$b\" > '{heard}'\n\
         echo '{{\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{{\"stopReason\":\"end_turn\"}}}}'\n",
        heard = heard.display(),
    );
    let child = spawn("sh", &["-c".to_string(), script]).unwrap();
    let (feed, rx) = mpsc::channel::<Vec<u8>>();
    let screen = Screen::default();
    let r = Recorder::default();
    let relay_screen = screen.clone();
    let guard = Guard::new(r.clone());
    let out = Arc::new(Mutex::new(relay_screen));
    let handle = std::thread::spawn(move || relay(BufReader::new(Feed(rx, Vec::new())), out, child, guard));

    let send = |v: Value| feed.send(format!("{}\n", v).into_bytes()).unwrap();
    send(json!({"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":1}}));
    send(json!({"jsonrpc":"2.0","id":1,"method":"session/new","params":{"cwd":root,"mcpServers":[]}}));
    send(json!({"jsonrpc":"2.0","id":2,"method":"session/prompt","params":{"sessionId":"s1","prompt":[{"type":"text","text":"fix the parser"}]}}));
    screen.wait_for("fs/write_text_file");
    send(json!({"jsonrpc":"2.0","id":100,"result":null}));

    let status = handle.join().unwrap().unwrap();
    drop(feed);
    assert!(status.success());

    let out = screen.text();
    assert!(out.contains(&format!("{odd}\n")), "an unknown frame passes byte for byte: {out}");
    assert!(out.contains(&format!("{tool_call}\n")), "{out}");
    assert!(out.contains(&format!("{write}\n")), "{out}");
    assert!(!out.contains("session/request_permission"), "the refused ask never reached the client");
    assert!(out.contains("Aura blocked this step"), "{out}");
    assert!(out.contains("\"stopReason\":\"end_turn\""), "{out}");

    let heard = std::fs::read_to_string(&heard).unwrap();
    let replies: Vec<Value> = heard.lines().map(|l| serde_json::from_str(l).unwrap()).collect();
    assert!(replies.iter().any(|r| r["id"] == json!(100)), "the client's own answer reached the agent: {heard}");
    let refusal = replies.iter().find(|r| r["id"] == json!(101)).expect("the agent got its answer");
    assert_eq!(refusal.pointer("/result/outcome/optionId"), Some(&json!("reject")));

    assert_eq!(snapped(&r), vec![format!("{root}/a.rs"), format!("{root}/b.rs")]);
    let turns = r.turns.lock().unwrap();
    assert_eq!(turns.len(), 1);
    assert_eq!(turns[0].0.writes, vec![format!("{root}/a.rs"), format!("{root}/b.rs")]);
    assert_eq!(turns[0].1, "end_turn");
}
