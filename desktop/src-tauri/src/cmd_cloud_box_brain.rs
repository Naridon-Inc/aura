//! The brain behind a cloud workspace whose chat runs on one of the org's
//! machines, and the relay that lets the rest of the workspace watch it.
//!
//! The chat surface is the one local work uses: it sends each turn to a brain
//! named by provider id. A box chat's brain gets one, `place:<key>`, where the
//! key names the agent the machine keeps under tmux (see
//! [`crate::manager::brain::place_chat`]). The brain is an ACP client whose
//! "process" is an attach to that agent. It is built here when the workspace
//! is opened — only this side knows which machine-book entry reaches the
//! machine and how far the agent's log has got — and then held, so every turn
//! and every reconnect after a dropped link goes through the same client.
//!
//! What the agent says goes two ways. The chat surface renders it like any
//! chat. The workspace's viewers get each protocol frame relayed to its live
//! events, keyed by where the frame sits in the machine's log, and each
//! finished turn kept on its message log, tagged with who sent it.

use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize;
use serde_json::Value;
use tokio::sync::mpsc;

use crate::cloud_box_people::{self as people, Room};
use crate::cloudbox::chat_script;
use crate::cmd_cloud_box_chat::{self as box_chat, BoxLink};
use crate::manager::brain::acp::{AcpBrain, AcpSpawn, Tap, TapEvent};
use crate::manager::brain::place::Place;
use crate::manager::brain::registry::{self, PLACE_PREFIX};
use crate::manager::brain::{gate, place_chat};

/// The protocol methods a workspace's viewers are shown: the server's list
/// (`public_box_events::KINDS`). It refuses a whole post that carries any
/// other, so everything else stops here.
const RELAYED: &[&str] = &[
    "session/update",
    "session/request_permission",
    "elicitation/create",
    "fs/read_text_file",
    "fs/write_text_file",
    "_aura/permission_resolved",
    "_aura/elicitation_resolved",
];

/// The most events one post carries, and the largest one event may be: the
/// server's limits, so a post is never refused for its size.
const BATCH: usize = 64;
const PAYLOAD_LIMIT: usize = 256 * 1024;

/// The name a workspace's chat has on its machine.
pub fn chat_key(workspace_id: &str) -> Result<String, String> {
    let key = format!("ws-{}", workspace_id.trim().to_ascii_lowercase().replace('_', "-"));
    if chat_script::is_key(&key) {
        Ok(key)
    } else {
        Err(format!("not a workspace id: {workspace_id:?}"))
    }
}

/// The chat brain's provider id for a workspace.
pub fn provider_for(workspace_id: &str) -> Result<String, String> {
    Ok(format!("{PLACE_PREFIX}{}", chat_key(workspace_id)?))
}

/// The ACP agent that runs a workspace's engine on a machine.
pub fn agent_for(engine: &str) -> Result<&'static str, String> {
    match engine.trim().to_ascii_lowercase().as_str() {
        "claude" => Ok("claude-acp"),
        "codex" => Ok("codex-acp"),
        other => Err(format!("a {other} chat can't run on one of your machines yet")),
    }
}

/// The machine-book entry for the machine a workspace names. A box holding
/// several repos has an entry per repo; any of them reaches the box. The one
/// for the project the workspace's worktree was made from is preferred, then
/// one that knows which checkout on this laptop it mirrors, because that is
/// where the conversation is filed.
pub(crate) fn machine_named(name: &str, remote_root: &str) -> Result<crate::cmd_machines::Machine, String> {
    let name = name.trim();
    let found = crate::cmd_machines::visible_machines().into_iter().filter(|m| m.name == name);
    best_entry(found, remote_root).ok_or_else(|| {
        format!("{name} isn't connected from this laptop. Connect it from Cloud, then open this workspace again.")
    })
}

fn best_entry(
    entries: impl Iterator<Item = crate::cmd_machines::Machine>,
    remote_root: &str,
) -> Option<crate::cmd_machines::Machine> {
    let filed = |m: &crate::cmd_machines::Machine| m.project_root.as_deref().is_some_and(|r| !r.trim().is_empty());
    // A worktree sits beside its project as `<project>-<branch>`.
    let mirrors = |m: &crate::cmd_machines::Machine| {
        m.repo_path
            .as_deref()
            .map(|p| p.trim_end_matches('/'))
            .is_some_and(|p| !p.is_empty() && (remote_root == p || remote_root.starts_with(&format!("{p}-"))))
    };
    entries.max_by_key(|m| (mirrors(m), filed(m)))
}

/// A connected chat: where its turns go and what the chat surface files it
/// under.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Attached {
    pub provider: String,
    pub machine_id: String,
    /// The checkout on this laptop the machine mirrors, when the book knows.
    pub repo_root: Option<String>,
}

/// One workspace's chat, as the workspace describes it.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoxChat {
    pub workspace_id: String,
    pub link: BoxLink,
    /// How the member driving the chat is shown on the turns they send.
    #[serde(default)]
    pub author_name: Option<String>,
    /// The teammates' GitHub logins: a message opening with one of them is
    /// kept on the shared log for them and not sent to the agent.
    #[serde(default)]
    pub people: Vec<String>,
}

/// Connect this laptop to a workspace's chat on its machine and hand back the
/// provider id its turns go to. Already connected is not an error: the held
/// brain is the connection.
#[tauri::command]
pub async fn cloud_box_chat_attach(chat: BoxChat) -> Result<Attached, String> {
    let key = chat_key(&chat.workspace_id)?;
    let provider = provider_for(&chat.workspace_id)?;
    let machine = machine_named(&chat.link.machine, &chat.link.remote_root)?;
    let machine_id = machine.id.clone();
    let attached = Attached {
        provider: provider.clone(),
        machine_id: machine_id.clone(),
        repo_root: machine.project_root.clone().filter(|r| !r.trim().is_empty()),
    };
    // Before the already-connected return: each connect brings the team as
    // it is now.
    people::remember(
        &provider,
        Room { workspace: chat.workspace_id.clone(), author: chat.author_name.clone(), logins: chat.people.clone() },
    );
    let agent = agent_for(&chat.link.engine)?;
    let place = Place::at_machine_home(&machine_id)?;
    let status = place_chat::status(&place, &key).await;
    if registry::held(&provider).is_some() {
        // A held connection is only as good as the agent behind it. A machine
        // that was replaced or restarted keeps none, and every turn would fail
        // on an attach to a chat that isn't there; let go of it and start the
        // agent again below. A machine this laptop can't reach right now keeps
        // the connection it has.
        if !matches!(&status, Ok(st) if !st.alive) {
            return Ok(attached);
        }
        registry::release(&provider);
    }
    let mut status = status?;
    if !status.alive {
        status = crate::cmd_cloud_box_open::restart(&place, &chat.workspace_id, &chat.link).await?;
    }
    // Everything already in the log was read by whoever was here before; this
    // client starts at the next byte, so an old answer is never matched to a
    // new question.
    let base = status.size.unwrap_or(0);
    let cwd = absolute_root(&place, &chat.link.remote_root).await?;
    let attach = place_chat::attacher(&machine_id, &key)?;
    let spawn = AcpSpawn::Prepared {
        factory: Arc::new(move |from| attach(base + from)),
        resumable: true,
        cwd,
        // The conversation the workspace already had, when it had one: the
        // agent loads it back rather than meeting this laptop as a stranger.
        resume: chat.link.agent_session_id.clone().filter(|s| is_session_id(s)),
    };
    let tap = relay(Relay {
        workspace: chat.workspace_id.clone(),
        base,
        link: chat.link.clone(),
        author: chat.author_name.clone(),
    });
    let brain = AcpBrain::with_spawn(provider.clone(), agent, spawn, gate::for_agent(&provider)).with_tap(tap);
    registry::hold(&provider, Arc::new(brain));
    Ok(attached)
}

/// The workspace's folder on the machine as an absolute path.
pub(crate) async fn absolute_root(place: &Place, root: &str) -> Result<String, String> {
    let root = root.trim();
    if root.starts_with('/') {
        return Ok(root.to_string());
    }
    let out = place.sh(&chat_script::absolute(root)?, Duration::from_secs(30)).await?;
    let path = out.stdout.trim();
    if out.code != 0 || !path.starts_with('/') {
        return Err(format!("{root} isn't a folder on the machine"));
    }
    Ok(path.to_string())
}

/// Who a workspace's chat can address, as the workspace knows it now.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoxChatPeople {
    pub workspace_id: String,
    #[serde(default)]
    pub author_name: Option<String>,
    #[serde(default)]
    pub people: Vec<String>,
}

/// Tell a connected chat who it can address now. The team is read apart from
/// the workspace, so its logins can arrive after the chat connected (a slow
/// or failed first read, a teammate who joined since); a chat that only
/// learned the team on connect kept none of them and sent every "@login" to
/// the agent.
#[tauri::command]
pub fn cloud_box_chat_people(chat: BoxChatPeople) -> Result<(), String> {
    let provider = provider_for(&chat.workspace_id)?;
    people::remember(&provider, Room { workspace: chat.workspace_id, author: chat.author_name, logins: chat.people });
    Ok(())
}

/// Drop this laptop's connection to a workspace's chat. The agent on the
/// machine keeps running; the next attach starts a fresh client.
#[tauri::command]
pub async fn cloud_box_chat_release(workspace_id: String) -> Result<bool, String> {
    let provider = provider_for(&workspace_id)?;
    people::forget(&provider);
    Ok(registry::release(&provider))
}

/// End a workspace's chat: the agent on the machine stops and this laptop
/// lets go of it. Its log stays on the machine. A machine this laptop can't
/// reach is an error, so an archive never claims to have stopped an agent
/// that is still running.
#[tauri::command]
pub async fn cloud_box_chat_end(chat: BoxChat) -> Result<(), String> {
    let key = chat_key(&chat.workspace_id)?;
    let provider = provider_for(&chat.workspace_id)?;
    people::forget(&provider);
    registry::release(&provider);
    let machine = machine_named(&chat.link.machine, &chat.link.remote_root)?;
    place_chat::stop(&Place::at_machine_home(&machine.id)?, &key).await
}

/// One model a machine's agent offers.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct MachineModel {
    pub id: String,
    pub label: String,
}

/// The models the agent on a workspace's machine offers, as it reported them
/// when its conversation opened. Empty until then, and for a chat this laptop
/// isn't connected to: the picker then offers only the agent's own default,
/// never a model from this laptop.
#[tauri::command]
pub async fn cloud_box_chat_models(provider: String) -> Result<Vec<MachineModel>, String> {
    if !provider.starts_with(PLACE_PREFIX) {
        return Err(format!("`{provider}` isn't a chat on one of your machines"));
    }
    Ok(registry::held(&provider)
        .map(|brain| machine_models(&brain.capabilities()))
        .unwrap_or_default())
}

fn machine_models(caps: &crate::manager::brain::BrainCapabilities) -> Vec<MachineModel> {
    let Some(list) = caps
        .get(crate::manager::brain::cap_keys::MODEL_CHOICES)
        .and_then(Value::as_array)
    else {
        return Vec::new();
    };
    let mut out: Vec<MachineModel> = Vec::new();
    for c in list {
        let Some(id) = c.get("id").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()) else {
            continue;
        };
        if out.iter().any(|m| m.id == id) {
            continue;
        }
        let name = c.get("name").and_then(Value::as_str).map(str::trim).unwrap_or("");
        let label = if name.is_empty() { id } else { name };
        out.push(MachineModel { id: id.to_string(), label: label.to_string() });
    }
    out
}

/// Where one chat's frames and turns go.
struct Relay {
    workspace: String,
    /// Where in the machine's log this client started reading.
    base: u64,
    link: BoxLink,
    author: Option<String>,
}

/// A tap that hands what the agent says to [`pump`], which posts it. The tap
/// runs on the reader, so it only queues.
fn relay(r: Relay) -> Tap {
    let (tx, rx) = mpsc::unbounded_channel::<TapEvent>();
    tokio::spawn(pump(r, rx));
    Arc::new(move |e: &TapEvent| {
        let _ = tx.send(e.clone());
    })
}

/// One side of a turn, to be kept on the workspace's log. Both sides of a
/// turn share `turn`, so the two messages read as one exchange.
#[derive(Debug, PartialEq)]
struct Said {
    role: &'static str,
    text: String,
    turn: String,
}

impl Said {
    fn message_id(&self) -> String {
        crate::cloud_turn_keys::side_key(&self.turn, self.role == "user")
    }
}

#[derive(Debug, PartialEq)]
enum Out {
    Event(Value),
    /// The person's words, kept the moment they are sent so everyone
    /// watching sees the question while the agent works on it.
    Asked(Said),
    /// A turn ended. The question rides along only when it was never kept
    /// at the start.
    Finished { asked: Option<Said>, answer: Said, session: String },
}

/// What the relay has learned from the stream so far.
#[derive(Debug, Default)]
struct Seen {
    /// The agent's session id, from the last frame that named one.
    session: Option<String>,
    /// The key the last event went out under. An answer Aura gave on the
    /// person's behalf has no line in the log, so it takes the next number
    /// after the frame it followed: a line is longer than one byte, so that
    /// number is never another line's start.
    seq: u64,
    /// The session id the workspace's link already names.
    linked: Option<String>,
    /// The turn under way, once its question was kept.
    turn: Option<String>,
    /// The provider id of the chat this relays, whose turns this laptop
    /// keyed when it sent them.
    provider: String,
}

impl Seen {
    /// The key the turn starting now is kept under: the one this laptop gave
    /// it when it sent it, so its copy of the chat files the turn under the
    /// same key, or a fresh one for a turn it never keyed.
    fn next_turn(&self) -> String {
        crate::cloud_turn_keys::take(&self.provider).unwrap_or_else(|| uuid::Uuid::new_v4().to_string())
    }

    fn take(&mut self, base: u64, e: TapEvent) -> Option<Out> {
        match e {
            TapEvent::Inbound { offset, method, params } => {
                if let Some(s) = params.get("sessionId").and_then(Value::as_str) {
                    self.session = Some(s.to_string());
                }
                self.seq = base + offset;
                frame(self.seq, self.session.as_deref()?, &method, params).map(Out::Event)
            }
            TapEvent::Resolved { kind, payload } => {
                self.seq += 1;
                frame(self.seq, self.session.as_deref()?, &kind, payload).map(Out::Event)
            }
            TapEvent::TurnStarted { user_text, .. } => {
                let turn = self.next_turn();
                self.turn = Some(turn.clone());
                Some(Out::Asked(Said { role: "user", text: user_text, turn }))
            }
            TapEvent::TurnFinished { user_text, assistant_text, acp_session_id, .. } => {
                let (turn, asked) = match self.turn.take() {
                    Some(turn) => (turn, None),
                    None => {
                        let turn = self.next_turn();
                        (turn.clone(), Some(Said { role: "user", text: user_text, turn }))
                    }
                };
                Some(Out::Finished {
                    asked,
                    answer: Said { role: "assistant", text: assistant_text, turn },
                    session: acp_session_id,
                })
            }
        }
    }
}

fn is_session_id(s: &str) -> bool {
    !s.is_empty() && s.len() <= 128 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// One event as the server takes it, or nothing for one it would refuse.
fn frame(seq: u64, session: &str, kind: &str, payload: Value) -> Option<Value> {
    if !RELAYED.contains(&kind) || !is_session_id(session) {
        return None;
    }
    if serde_json::to_vec(&payload).map_or(true, |b| b.len() > PAYLOAD_LIMIT) {
        tracing::debug!(target: "cloud::box_chat", kind, "a frame too large to relay was left out");
        return None;
    }
    Some(box_chat::event(seq, session, kind, payload))
}

/// Post what the tap queued, in the order it happened: frames in batches as
/// they come, a question the moment it is sent, an answer once the frames
/// before it have gone. A failed post is logged and dropped; viewers who
/// missed a frame still get the turn off the log.
async fn pump(r: Relay, mut rx: mpsc::UnboundedReceiver<TapEvent>) {
    let mut seen = Seen {
        linked: r.link.agent_session_id.clone(),
        provider: provider_for(&r.workspace).unwrap_or_default(),
        ..Seen::default()
    };
    while let Some(first) = rx.recv().await {
        let mut events = Vec::new();
        let mut next = Some(first);
        while let Some(e) = next.take() {
            match seen.take(r.base, e) {
                Some(Out::Event(v)) => events.push(v),
                Some(other) => {
                    flush(&r, &mut events).await;
                    keep(&r, &mut seen, other).await;
                }
                None => {}
            }
            if events.len() >= BATCH {
                break;
            }
            next = rx.try_recv().ok();
        }
        flush(&r, &mut events).await;
    }
}

async fn flush(r: &Relay, events: &mut Vec<Value>) {
    if events.is_empty() {
        return;
    }
    if let Err(e) = box_chat::post_events(&r.workspace, std::mem::take(events)).await {
        tracing::warn!(target: "cloud::box_chat", "live frames not relayed: {e}");
    }
}

/// Keep a side of a turn on the workspace's log, and the agent's session id
/// on its link the first time it is seen, so a laptop opening the workspace
/// later can carry on the same conversation.
async fn keep(r: &Relay, seen: &mut Seen, out: Out) {
    let sides = match out {
        Out::Event(_) => return,
        Out::Asked(q) => vec![q],
        Out::Finished { asked, answer, session } => {
            if is_session_id(&session) && seen.linked.as_deref() != Some(session.as_str()) {
                let mut link = r.link.clone();
                link.agent_session_id = Some(session.clone());
                match box_chat::cloud_box_link(r.workspace.clone(), link).await {
                    Ok(_) => seen.linked = Some(session),
                    Err(e) => tracing::warn!(target: "cloud::box_chat", "the chat's session id was not kept: {e}"),
                }
            }
            asked.into_iter().chain([answer]).collect()
        }
    };
    for said in sides {
        let id = said.message_id();
        let text = shared_words(&said);
        if text.trim().is_empty() {
            continue;
        }
        if said.role == "user" && people::already_on_log(&r.workspace, &text) {
            continue;
        }
        let author = (said.role == "user").then(|| r.author.clone()).flatten();
        match box_chat::cloud_box_turn(r.workspace.clone(), said.role.into(), text, id.clone(), author).await {
            Ok(v) => {
                if let Some(cloud_id) = v.get("id").and_then(Value::as_str) {
                    crate::cloud_turn_keys::kept(&r.workspace, &id, cloud_id);
                }
            }
            Err(e) => tracing::warn!(target: "cloud::box_chat", role = said.role, "a turn was not kept on the workspace: {e}"),
        }
    }
}

/// What a side of a turn puts on the shared log. The agent got the person's
/// message with the composer's directives in front (one per message, when
/// several queued up while it worked); teammates get what the person typed.
fn shared_words(said: &Said) -> String {
    if said.role == "user" {
        people::persons_words(&said.text)
    } else {
        said.text.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn entry(id: &str, repo: Option<&str>, filed: bool) -> crate::cmd_machines::Machine {
        crate::cmd_machines::Machine {
            id: id.into(),
            aliases: Vec::new(),
            name: "aura-runner".into(),
            host: "h".into(),
            user: "ubuntu".into(),
            key_path: String::new(),
            box_kind: "mine".into(),
            repo_path: repo.map(str::to_string),
            repo_branch: None,
            project_root: filed.then(|| "/laptop/aura".to_string()),
            org_slug: None,
            forward_agent: false,
            instance_id: None,
            asleep_since: 0,
            added_at: 0,
            last_used_at: 0,
        }
    }

    #[test]
    fn a_chat_is_filed_with_the_project_its_worktree_came_from() {
        let book = || {
            vec![
                entry("other", Some("/home/ubuntu/naridon"), true),
                entry("ours", Some("/home/ubuntu/aura"), false),
                entry("bare", None, true),
            ]
            .into_iter()
        };
        assert_eq!(best_entry(book(), "/home/ubuntu/aura-feat-x").unwrap().id, "ours");
        // `aura-cli` is a different project, not a worktree of `aura`.
        assert_ne!(best_entry(book(), "/home/ubuntu/auraplus").unwrap().id, "ours");
        // Nothing mirrors it: the one filed under a checkout here wins.
        assert_ne!(best_entry(book(), "/srv/elsewhere").unwrap().id, "ours");
        assert!(best_entry(std::iter::empty(), "/x").is_none());
    }

    #[test]
    fn a_workspace_names_its_chat_and_its_brain() {
        let id = "8F1C2D3E-0000-4000-8000-000000000001";
        assert_eq!(chat_key(id).unwrap(), "ws-8f1c2d3e-0000-4000-8000-000000000001");
        assert_eq!(provider_for(id).unwrap(), "place:ws-8f1c2d3e-0000-4000-8000-000000000001");
        assert!(chat_key("a b").is_err());
        assert!(chat_key("x;rm").is_err());
        assert!(chat_key(&"a".repeat(80)).is_err());
    }

    #[test]
    fn only_engines_with_an_agent_run_on_a_machine() {
        assert_eq!(agent_for(" Claude ").unwrap(), "claude-acp");
        assert_eq!(agent_for("codex").unwrap(), "codex-acp");
        assert!(agent_for("aura").is_err());
    }

    #[test]
    fn a_machine_offers_the_models_its_agent_reported() {
        use crate::manager::brain::{cap_keys, BrainCapabilities};
        assert!(machine_models(&BrainCapabilities::default()).is_empty());
        let caps = BrainCapabilities::default().with(
            cap_keys::MODEL_CHOICES,
            json!([
                {"id": "default", "name": "Default (recommended)"},
                {"id": "opus", "name": ""},
                {"id": "default", "name": "again"},
                {"id": 7, "name": "not an id"},
                {"name": "no id"},
            ]),
        );
        assert_eq!(
            machine_models(&caps),
            vec![
                MachineModel { id: "default".into(), label: "Default (recommended)".into() },
                MachineModel { id: "opus".into(), label: "opus".into() },
            ]
        );
    }

    fn inbound(offset: u64, method: &str, params: Value) -> TapEvent {
        TapEvent::Inbound { offset, method: method.into(), params }
    }

    #[test]
    fn a_frame_is_keyed_by_where_it_sits_in_the_machine_log() {
        let mut seen = Seen::default();
        let out = seen.take(4096, inbound(120, "session/update", json!({"sessionId": "s-1", "update": {}})));
        let Some(Out::Event(e)) = out else { panic!("{out:?}") };
        assert_eq!(e["seq"], 4216);
        assert_eq!(e["acp_session_id"], "s-1");
        assert_eq!(e["kind"], "session/update");
    }

    #[test]
    fn an_answer_aura_gave_follows_the_frame_it_answered() {
        let mut seen = Seen::default();
        seen.take(0, inbound(300, "session/request_permission", json!({"sessionId": "s-1"})));
        let out = seen.take(0, TapEvent::Resolved {
            kind: "_aura/permission_resolved".into(),
            payload: json!({"requestId": 4, "optionId": "allow_once", "outcome": "selected"}),
        });
        let Some(Out::Event(e)) = out else { panic!("{out:?}") };
        assert_eq!(e["seq"], 301);
        assert_eq!(e["payload"]["optionId"], "allow_once");
    }

    #[test]
    fn what_the_server_would_refuse_is_never_sent() {
        let mut seen = Seen::default();
        assert!(seen.take(0, inbound(1, "session/update", json!({}))).is_none(), "no session id yet");
        seen.take(0, inbound(2, "session/update", json!({"sessionId": "s-1"})));
        assert!(seen.take(0, inbound(3, "terminal/create", json!({"sessionId": "s-1"}))).is_none());
        let big = json!({"sessionId": "s-1", "text": "x".repeat(PAYLOAD_LIMIT)});
        assert!(seen.take(0, inbound(4, "session/update", big)).is_none());
        assert!(seen.take(0, inbound(5, "session/update", json!({"sessionId": "s 1"}))).is_none());
    }

    fn finished(user: &str, assistant: &str) -> TapEvent {
        TapEvent::TurnFinished {
            user_text: user.into(),
            assistant_text: assistant.into(),
            stop_reason: Some("end_turn".into()),
            acp_session_id: "s-1".into(),
        }
    }

    #[test]
    fn a_question_is_kept_when_it_is_asked_and_the_answer_when_it_ends() {
        let mut seen = Seen::default();
        let asked = seen.take(0, TapEvent::TurnStarted { user_text: "ping".into(), acp_session_id: "s-1".into() });
        let Some(Out::Asked(q)) = asked else { panic!("{asked:?}") };
        assert_eq!((q.role, q.text.as_str()), ("user", "ping"));
        let out = seen.take(0, finished("ping", "pong"));
        let Some(Out::Finished { asked, answer, session }) = out else { panic!("{out:?}") };
        assert_eq!(asked, None, "the question is not kept twice");
        assert_eq!((answer.role, answer.text.as_str(), session.as_str()), ("assistant", "pong", "s-1"));
        assert_eq!(answer.turn, q.turn, "both sides read as one exchange");
        assert_eq!((q.message_id(), answer.message_id()), (format!("{}-u", q.turn), format!("{}-a", q.turn)));
    }

    #[test]
    fn the_log_gets_the_persons_words_and_the_agent_s_answer_whole() {
        let auto = "[AUTO MODE. Full autopilot.]\n\n";
        let asked = Said { role: "user", text: format!("{auto}hello\n{auto}hi"), turn: "t".into() };
        assert_eq!(shared_words(&asked), "hello\nhi");
        let answer = Said { role: "assistant", text: format!("{auto}kept as said"), turn: "t".into() };
        assert_eq!(shared_words(&answer), format!("{auto}kept as said"));
    }

    #[test]
    fn a_turn_this_laptop_sent_is_kept_under_the_key_its_chat_filed_it_with() {
        let mut seen = Seen { provider: "place:ws-keyed".into(), ..Seen::default() };
        let turn = crate::cloud_turn_keys::begin("place:ws-keyed", "s-keyed");
        let filed = crate::cloud_turn_keys::stamp("s-keyed", true);
        let asked = seen.take(0, TapEvent::TurnStarted { user_text: "ping".into(), acp_session_id: "s-1".into() });
        let Some(Out::Asked(q)) = asked else { panic!("{asked:?}") };
        assert_eq!(q.turn, turn);
        assert_eq!(Some(q.message_id()), filed);
        let Some(Out::Finished { answer, .. }) = seen.take(0, finished("ping", "pong")) else { panic!() };
        assert_eq!(Some(answer.message_id()), crate::cloud_turn_keys::stamp("s-keyed", false));
    }

    #[test]
    fn a_turn_whose_start_went_unseen_is_kept_whole() {
        let mut seen = Seen::default();
        let out = seen.take(0, finished("ping", "pong"));
        let Some(Out::Finished { asked: Some(q), answer, .. }) = out else { panic!("{out:?}") };
        assert_eq!((q.text.as_str(), answer.text.as_str()), ("ping", "pong"));
        assert_eq!(q.turn, answer.turn);
        // The next turn starts its own exchange.
        let Some(Out::Asked(next)) = seen.take(0, TapEvent::TurnStarted { user_text: "again".into(), acp_session_id: "s-1".into() }) else {
            panic!()
        };
        assert_ne!(next.turn, q.turn);
    }
}
