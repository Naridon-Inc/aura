//! The agent protocol, live, over a chat kept at a real machine.
//!
//! `AURA_CHAT_LIVE_MACHINE=<machine id>` names a machine in this laptop's book
//! and `AURA_CHAT_LIVE_AGENT` the agent: `~/<path>` to a protocol adapter
//! installed there and already signed in (every turn is real and costs
//! tokens), or `scripted` for [`SCRIPTED`], which speaks the protocol with
//! fixed words so the relay and the client are tested without a model.

use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use aura_acp::permission::{self, PermissionOption};
use aura_acp::{
    ClientCaps, ClientInfo, ConnOpts, Connection, Driver, Inbound, LinkState, OpenRequest, Opened, PromptOutcome,
    RpcError, Update, UpdateKind,
};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, BufReader};

use super::place::Place;
use super::place_chat::{attacher, start, status, stop};
use crate::cloudbox::chat_script::{Launch, Started};
use crate::cloudbox::script::quote;

/// A protocol-faithful agent with fixed answers; see the file's header.
const SCRIPTED: &str = include_str!("testdata/scripted_acp_agent.py");

const TURN: Duration = Duration::from_secs(240);
const ASK: Duration = Duration::from_secs(30);

#[derive(Default)]
struct Seen {
    /// `(offset, method)` of every frame that came off the stream, in order.
    frames: Vec<(u64, String)>,
    /// Updates of any kind since the counters were last cleared.
    updates: usize,
    text: String,
    permissions: Vec<Vec<PermissionOption>>,
    detached: usize,
    closed: Option<String>,
}

type Shared = Arc<Mutex<Seen>>;

/// What the desktop does with everything the agent sends: keep the text,
/// answer a permission request with the narrowest allow it offered, and
/// refuse anything this client never said it serves.
fn pump(conn: Connection, mut rx: aura_acp::conn::InboundRx, seen: Shared) {
    tokio::spawn(async move {
        while let Some(item) = rx.recv().await {
            match item {
                Inbound::Notification { method, params, offset } => {
                    let mut s = seen.lock().unwrap();
                    s.frames.push((offset, method.clone()));
                    if method == "session/update" {
                        s.updates += 1;
                        if let Some(u) = Update::parse(&params) {
                            if u.kind == UpdateKind::AgentMessageChunk {
                                if let Some(t) = u.chunk_text() {
                                    s.text.push_str(&t);
                                }
                            }
                        }
                    }
                }
                Inbound::Request { id, method, params, offset } => {
                    seen.lock().unwrap().frames.push((offset, method.clone()));
                    let reply = if method == "session/request_permission" {
                        let options = PermissionOption::parse_list(&params);
                        let answer = permission::result(permission::outcome(&options, None, "allow_once"));
                        seen.lock().unwrap().permissions.push(options);
                        Ok(answer)
                    } else {
                        Err(RpcError::method_not_found(&method))
                    };
                    conn.respond(&id, reply).await.ok();
                }
                Inbound::Detached => seen.lock().unwrap().detached += 1,
                Inbound::Closed(why) => {
                    seen.lock().unwrap().closed = Some(why);
                    break;
                }
                Inbound::Diagnostic(_) => {}
            }
        }
    });
}

fn clear(seen: &Shared) {
    let mut s = seen.lock().unwrap();
    s.updates = 0;
    s.text.clear();
}

async fn until(seen: &Shared, what: &str, done: impl Fn(&Seen) -> bool) {
    let deadline = tokio::time::Instant::now() + TURN;
    while !done(&seen.lock().unwrap()) {
        assert!(tokio::time::Instant::now() < deadline, "waited too long for {what}");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

async fn state(conn: &Connection, want: LinkState) {
    let mut w = conn.watch_state();
    tokio::time::timeout(ASK, w.wait_for(|s| *s == want)).await.expect("link state").expect("link watch");
}

fn ask(text: &str) -> Vec<Value> {
    vec![json!({"type": "text", "text": text})]
}

async fn turn(driver: &Driver, sid: &str, text: &str) -> PromptOutcome {
    tokio::time::timeout(TURN, driver.prompt(sid, ask(text))).await.expect("the turn timed out").expect("the turn")
}

fn spawn_turn(driver: &Driver, sid: &str, text: &str) -> tokio::task::JoinHandle<PromptOutcome> {
    let (d, sid, blocks) = (driver.clone(), sid.to_string(), ask(text));
    tokio::spawn(async move { tokio::time::timeout(TURN, d.prompt(&sid, blocks)).await.expect("timed out").expect("turn") })
}

/// A first link the test can cut: the desktop's own process, killed the way a
/// lid close or a dropped network kills it.
fn first_link(machine: &str, key: &str, from: u64) -> (Connection, aura_acp::conn::InboundRx, tokio::process::Child) {
    let mut cmd = attacher(machine, key).expect("attacher")(from);
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true);
    let mut child = cmd.spawn().expect("attach");
    let (out, inp) = (child.stdout.take().unwrap(), child.stdin.take().unwrap());
    let (conn, rx) = Connection::over_at(out, inp, from, ConnOpts { resumable: true });
    (conn, rx, child)
}

async fn client(conn: Connection) -> Driver {
    Driver::initialize(conn, &ClientInfo::aura("live-test"), &ClientCaps::default()).await.expect("initialize")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs a real machine with a signed-in adapter; set AURA_CHAT_LIVE_MACHINE and AURA_CHAT_LIVE_AGENT"]
async fn a_chat_at_a_place_survives_drops_viewers_cancels_permissions_and_a_new_client() {
    let (Ok(machine), Ok(agent)) = (std::env::var("AURA_CHAT_LIVE_MACHINE"), std::env::var("AURA_CHAT_LIVE_AGENT"))
    else {
        return;
    };
    let place = Place::at_machine(&machine).expect("place");
    let key = format!("acp-live-{}", uuid::Uuid::new_v4().simple());
    let mk = format!(
        "d=\"$HOME/.aura/chat-live/{key}-cwd\" && mkdir -p \"$d\" && cd \"$d\" && git init -q && printf '%s' \"$d\""
    );
    let cwd = place.sh(&mk, ASK).await.expect("scratch dir").stdout;
    assert!(cwd.starts_with('/'), "{cwd}");
    let script = format!("{}/{key}-agent.py", cwd.rsplit_once('/').map_or(cwd.as_str(), |(dir, _)| dir));
    let argv = if agent == "scripted" {
        let put = format!("printf '%s' {} > {}", quote(SCRIPTED), quote(&script));
        assert_eq!(place.sh(&put, ASK).await.expect("install the scripted agent").code, 0);
        vec!["python3".into(), "-u".into(), script.clone()]
    } else {
        vec![agent]
    };
    let launch = Launch { key: key.clone(), cwd: cwd.clone(), argv, sign_in: None };
    let Started::At(origin) = start(&place, launch).await.expect("start") else {
        panic!("a new chat said it was already running");
    };

    let body = tokio::spawn(scenario(place.clone(), machine.clone(), key.clone(), cwd.clone(), origin));
    let result = body.await;

    stop(&place, &key).await.ok();
    let st = status(&place, &key).await.expect("status");
    let tidy = format!(
        "find \"$HOME/.aura/chat/{key}\" {} {} -depth -delete",
        quote(&cwd),
        quote(&script)
    );
    place.sh(&tidy, ASK).await.ok();
    if let Err(e) = result {
        std::panic::resume_unwind(e.into_panic());
    }
    assert!(!st.alive, "the chat ended when asked: {st:?}");
}

async fn scenario(place: Place, machine: String, key: String, cwd: String, origin: u64) {
    let seen: Shared = Arc::default();
    let (conn, rx, mut link) = first_link(&machine, &key, origin);
    pump(conn.clone(), rx, seen.clone());
    let driver = client(conn.clone()).await;
    let mut session = driver
        .open(&OpenRequest { cwd: cwd.clone(), ..Default::default() })
        .await
        .expect("a session (an AuthRequired here means the adapter on the machine is not signed in)");
    let sid = session.id.clone();
    eprintln!("agent modes: {:?}", session.modes.available);

    // 1. One whole turn.
    clear(&seen);
    let out = turn(&driver, &sid, "Reply with exactly the word pong and nothing else.").await;
    assert_eq!(out.stop_reason, "end_turn");
    assert!(seen.lock().unwrap().text.to_lowercase().contains("pong"), "{}", seen.lock().unwrap().text);
    eprintln!("ok: a whole turn");

    // 2. The link drops mid-turn; the agent keeps going; a new link from the
    // last byte seen gets the rest of the answer and nothing twice.
    clear(&seen);
    let pending = spawn_turn(
        &driver,
        &sid,
        "Write the whole numbers from 1 to 150, one per line, and nothing else. Do not use any tools.",
    );
    until(&seen, "the turn to start streaming", |s| s.updates >= 3).await;
    assert!(!pending.is_finished(), "the turn ended before the link could be dropped");
    link.kill().await.ok();
    state(&conn, LinkState::Detached).await;
    let before = seen.lock().unwrap().frames.len();
    tokio::time::sleep(Duration::from_secs(4)).await;
    let mid = status(&place, &key).await.expect("status");
    assert!(mid.alive, "the agent outlived the link: {mid:?}");
    let at = conn.last_offset();
    conn.reattach_command(attacher(&machine, &key).expect("attacher")(at), at).expect("reattach");
    let out = pending.await.expect("the turn task");
    assert_eq!(out.stop_reason, "end_turn");
    {
        let s = seen.lock().unwrap();
        assert!(s.detached >= 1, "the drop was seen");
        assert!(s.frames.len() > before, "the answer that landed while detached was read after the reattach");
        assert!(s.text.contains("150"), "the whole answer arrived: {}", s.text);
        assert!(s.frames.windows(2).all(|w| w[0].0 < w[1].0), "no frame was read twice");
    }
    eprintln!("ok: dropped mid-turn and reattached at byte {at}");

    // 3. A second reader of the same chat sees what the driver sees.
    let from = conn.last_offset();
    let mut viewer = attacher(&machine, &key).expect("attacher")(from);
    viewer.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true);
    let mut viewer = viewer.spawn().expect("viewer");
    let mut lines = BufReader::new(viewer.stdout.take().unwrap()).lines();
    let read: Arc<Mutex<Vec<u64>>> = Arc::default();
    let into = read.clone();
    tokio::spawn(async move {
        let mut at = from;
        while let Ok(Some(line)) = lines.next_line().await {
            if serde_json::from_str::<Value>(&line).ok().and_then(|v| v.get("method").cloned()).is_some() {
                into.lock().unwrap().push(at);
            }
            at += line.len() as u64 + 1;
        }
    });
    clear(&seen);
    let out = turn(&driver, &sid, "Reply with exactly the word viewers and nothing else.").await;
    assert_eq!(out.stop_reason, "end_turn");
    tokio::time::sleep(Duration::from_secs(1)).await;
    viewer.kill().await.ok();
    let viewer_saw = read.lock().unwrap().clone();
    let last = *viewer_saw.last().expect("the second reader saw the turn");
    // Up to where the second reader was stopped, which is after the turn ended.
    let driver_saw: Vec<u64> =
        seen.lock().unwrap().frames.iter().map(|(o, _)| *o).filter(|o| (from..=last).contains(o)).collect();
    assert!(driver_saw.len() >= 2, "the turn streamed: {driver_saw:?}");
    assert_eq!(driver_saw, viewer_saw, "both readers saw the same frames at the same offsets");
    eprintln!("ok: a second reader saw all {} frames", viewer_saw.len());

    // 4. Cancel stops a long turn.
    clear(&seen);
    let pending = spawn_turn(
        &driver,
        &sid,
        "Write an essay of at least 2000 words on the history of rivers. Plain text only, no tools.",
    );
    until(&seen, "the long turn to start", |s| s.updates >= 3).await;
    driver.cancel(&sid).await.expect("cancel");
    let out = tokio::time::timeout(Duration::from_secs(60), pending).await.expect("cancel took effect").expect("task");
    assert_eq!(out.stop_reason, "cancelled");
    eprintln!("ok: cancelled mid-turn");

    // 5. A permission request goes out, the answer comes back, the work happens.
    if let Some(mode) = ["read-only", "default"].into_iter().find(|m| session.offers_mode(m)) {
        driver.select_mode(&mut session, mode).await.expect("mode");
        eprintln!("mode: {mode}");
    }
    clear(&seen);
    let asked = seen.lock().unwrap().permissions.len();
    let out = turn(
        &driver,
        &sid,
        "Create a file named aura-permission-check.txt in the current working directory whose entire content is the word ok. Do it now with your tools.",
    )
    .await;
    assert_eq!(out.stop_reason, "end_turn");
    let got = place.sh(&format!("cat {}/aura-permission-check.txt", quote(&cwd)), ASK).await.expect("read back");
    {
        let s = seen.lock().unwrap();
        assert!(s.permissions.len() > asked, "the agent asked before writing; it wrote: {:?}", got.stdout);
        eprintln!("asked with: {:?}", s.permissions.last().map(|o| o.iter().map(|p| &p.kind).collect::<Vec<_>>()));
    }
    assert_eq!(got.stdout.trim(), "ok", "the allowed write happened: {got:?}");
    eprintln!("ok: permission round-trip");

    // 6. The desktop quits and opens again: a brand-new client, attached from
    // the byte it last stored, picks the same conversation back up.
    let at = conn.last_offset();
    conn.close("the app quit");
    drop(driver);
    let seen2: Shared = Arc::default();
    let (conn2, rx2, _link2) = first_link(&machine, &key, at);
    pump(conn2.clone(), rx2, seen2.clone());
    let driver2 = client(conn2.clone()).await;
    let reopened = driver2.open(&OpenRequest { cwd: cwd.clone(), resume: Some(sid.clone()), ..Default::default() }).await;
    let reopened = reopened.expect("the same conversation reopens");
    assert!(matches!(reopened.how, Opened::Resumed | Opened::Loaded), "{:?}", reopened.how);
    let out = turn(&driver2, &sid, "What single word did you reply with in your very first answer here? Reply with just that word.").await;
    assert_eq!(out.stop_reason, "end_turn");
    assert!(seen2.lock().unwrap().text.to_lowercase().contains("pong"), "{}", seen2.lock().unwrap().text);
    eprintln!("ok: a new client reopened the conversation ({:?})", reopened.how);
    conn2.close("done");
}
