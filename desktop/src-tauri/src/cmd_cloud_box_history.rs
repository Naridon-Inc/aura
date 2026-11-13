//! What a laptop opening a machine chat never saw.
//!
//! The relay keeps each turn on the workspace's log as it happens, so a laptop
//! that opens the chat for the first time files that log as the conversation.
//! One gap is left: a turn the agent finishes after the lid closes has nobody
//! to keep it. The question is on the log (it is kept the moment it is sent),
//! the answer only in the agent's own log on the machine. The laptop that opens
//! the chat next reads the end of that log, and an answer in it fills the
//! question the workspace's log left open. Pairing them up is `recovered` in
//! `lib/cloudBoxChat.ts`.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, State};

use crate::cloudbox::chat_script;
use crate::cmd_cloud_box_brain::{chat_key, machine_named, BoxChat};
use crate::cmd_manager::{ensure_attached, ManagerRuntime};
use crate::manager::brain::place::Place;
use crate::manager::{now_secs, persist, ChatRole, ChatTurn};

/// How much of the end of the log is read: room for several long answers, and
/// little enough to come back over ssh in a moment.
const TAIL: u64 = 2 * 1024 * 1024;

/// The most answers handed back; the newest are the ones that can be missing.
const MOST: usize = 20;

/// The answers the agent finished, oldest first, and whether it is working on
/// another one right now.
#[derive(Debug, Default, PartialEq, Serialize)]
pub struct Answers {
    pub answers: Vec<String>,
    /// The agent is mid-turn: the newest question is still being answered.
    pub busy: bool,
}

/// The end of the chat's log on its machine, read once.
#[tauri::command]
pub async fn cloud_box_chat_answers(chat: BoxChat) -> Result<Answers, String> {
    let key = chat_key(&chat.workspace_id)?;
    let machine = machine_named(&chat.link.machine, &chat.link.remote_root)?;
    let place = Place::at_machine_home(&machine.id)?;
    let out = place.sh(&chat_script::tail(&key, TAIL)?, Duration::from_secs(30)).await?;
    if out.code != 0 {
        return Err(format!("the chat's log on {} could not be read", chat.link.machine));
    }
    Ok(answers(&out.stdout, chat.link.agent_session_id.as_deref()))
}

/// Each answer the agent finished in `log`: the text it streamed, ended by the
/// reply to the prompt, which carries a stop reason. A conversation the agent
/// replays when it is loaded again is not a new answer; the reply to the load
/// has no stop reason, so it is dropped. Lines that don't parse (the first one
/// of a tail is usually cut) are skipped.
pub(crate) fn answers(log: &str, session: Option<&str>) -> Answers {
    let mut done = Vec::new();
    let mut said = String::new();
    let mut busy = false;
    for line in log.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line.trim()) else {
            continue;
        };
        let method = v.get("method").and_then(Value::as_str);
        if method == Some("session/update") {
            let p = &v["params"];
            let elsewhere = match (session, p.get("sessionId").and_then(Value::as_str)) {
                (Some(want), Some(got)) => want != got,
                _ => false,
            };
            if elsewhere {
                continue;
            }
            let u = &p["update"];
            match u.get("sessionUpdate").and_then(Value::as_str) {
                Some("agent_message_chunk") => {
                    busy = true;
                    if let Some(t) = u["content"].get("text").and_then(Value::as_str) {
                        said.push_str(t);
                    }
                }
                Some("user_message_chunk") => {
                    busy = true;
                    said.clear();
                }
                Some("agent_thought_chunk" | "tool_call" | "tool_call_update" | "plan") => busy = true,
                _ => {}
            }
            continue;
        }
        if method.is_some() {
            // The agent asking this laptop something (a permission, a file)
            // happens only while it works on a turn.
            busy |= v.get("id").is_some();
            continue;
        }
        if v.get("id").is_some() && v.get("result").is_some() {
            if v["result"].get("stopReason").is_some() {
                let t = said.trim();
                if !t.is_empty() {
                    done.push(t.to_string());
                }
            }
            said.clear();
            busy = false;
        }
    }
    let skip = done.len().saturating_sub(MOST);
    Answers { answers: done.into_iter().skip(skip).collect(), busy }
}

/// One turn this laptop never saw, as the workspace's log has it.
#[derive(Debug, Clone, Deserialize)]
pub struct SeedTurn {
    pub role: String,
    pub text: String,
    /// When it was said, in seconds; 0 for now.
    #[serde(default)]
    pub at: u64,
    /// The cloud's id for this turn on the workspace's log, so reactions and
    /// comments on it show under the turn here.
    #[serde(default)]
    pub cloud_id: Option<String>,
    /// The key the turn was kept on the log under, for one this laptop keeps
    /// as it files it (a recovered answer).
    #[serde(default)]
    pub cloud_key: Option<String>,
}

/// File turns this laptop never saw onto the local chat a machine chat is shown
/// in: the whole log on a laptop that opens the chat for the first time, or an
/// answer that finished while the lid was closed. `after` is the text the chat
/// has to end on, or nothing for a chat that has to be empty, so a second run,
/// or one after the person typed on, files nothing. Says whether it filed them.
#[tauri::command]
pub async fn cloud_box_chat_backfill(
    app: AppHandle,
    runtime: State<'_, ManagerRuntime>,
    session_id: String,
    turns: Vec<SeedTurn>,
    after: Option<String>,
    brain: Option<String>,
) -> Result<bool, String> {
    let filed = seed_turns(turns, brain.as_deref(), now_secs());
    if filed.is_empty() {
        return Ok(false);
    }
    let state = ensure_attached(&runtime, &session_id).await?;
    let snapshot = {
        let mut s = state.lock().unwrap();
        if !ends_where(&s.chat, after.as_deref()) {
            return Ok(false);
        }
        s.chat.extend(filed);
        s.touch();
        s.clone()
    };
    let to_save = snapshot.clone();
    crate::blocking::run(move || persist::save(&to_save)).await?;
    let _ = app.emit(&format!("manager:{session_id}"), &snapshot);
    Ok(true)
}

/// Whether the conversation ends where the turns being filed carry on from.
/// Aura's own notes in between ("Couldn't start this turn…") don't count.
fn ends_where(chat: &[ChatTurn], after: Option<&str>) -> bool {
    let last = chat.iter().rev().find(|t| t.role != ChatRole::System);
    match (last, after) {
        (None, None) => true,
        (Some(t), Some(want)) => t.text.trim() == want.trim(),
        _ => false,
    }
}

/// The log's turns as the chat files them. The agent's answers are marked as
/// the machine's brain's, so the chat says where they came from.
fn seed_turns(turns: Vec<SeedTurn>, brain: Option<&str>, now: u64) -> Vec<ChatTurn> {
    turns
        .into_iter()
        .filter_map(|t| {
            let role = match t.role.trim() {
                "user" => ChatRole::User,
                "assistant" => ChatRole::Manager,
                _ => return None,
            };
            let text = t.text.trim();
            if text.is_empty() {
                return None;
            }
            Some(ChatTurn {
                brain: (role == ChatRole::Manager).then(|| brain.map(str::to_string)).flatten(),
                role,
                text: text.to_string(),
                at: if t.at == 0 { now } else { t.at },
                answered_question: None,
                anchor: None,
                attachments: Vec::new(),
                tool_calls: Vec::new(),
                thinking: None,
                saved_tokens: None,
                input_tokens: None,
                output_tokens: None,
                model: None,
                cost_usd: None,
                cost_estimated: None,
                cloud_key: t.cloud_key.clone().filter(|k| !k.trim().is_empty()),
                cloud_id: t.cloud_id.clone().filter(|k| !k.trim().is_empty()),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn update(session: &str, kind: &str, text: &str) -> String {
        json!({"jsonrpc": "2.0", "method": "session/update", "params": {
            "sessionId": session,
            "update": {"sessionUpdate": kind, "content": {"type": "text", "text": text}},
        }})
        .to_string()
    }

    fn reply(id: u64, result: Value) -> String {
        json!({"jsonrpc": "2.0", "id": id, "result": result}).to_string()
    }

    fn seed(role: &str, text: &str, at: u64) -> SeedTurn {
        SeedTurn { role: role.into(), text: text.into(), at, cloud_id: None, cloud_key: None }
    }

    #[test]
    fn each_finished_answer_is_read_off_the_log() {
        let log = [
            "ion\":\"s-1\",\"update\":{}}}".to_string(),
            update("s-1", "agent_message_chunk", "Hel"),
            update("s-1", "agent_message_chunk", "lo."),
            json!({"jsonrpc": "2.0", "method": "session/request_permission", "id": 9, "params": {"sessionId": "s-1"}})
                .to_string(),
            reply(3, json!({"stopReason": "end_turn"})),
            update("s-1", "agent_message_chunk", "Second."),
            reply(4, json!({"stopReason": "end_turn"})),
        ]
        .join("\n");
        let got = answers(&log, Some("s-1"));
        assert_eq!(got.answers, vec!["Hello.", "Second."]);
        assert!(!got.busy);
    }

    #[test]
    fn an_answer_under_way_is_not_finished() {
        let mut log = vec![update("s-1", "agent_message_chunk", "Done."), reply(3, json!({"stopReason": "end_turn"}))];
        log.push(update("s-1", "available_commands_update", ""));
        assert!(!answers(&log.join("\n"), Some("s-1")).busy, "a list of commands is not work");
        log.push(update("s-1", "tool_call", ""));
        let got = answers(&log.join("\n"), Some("s-1"));
        assert_eq!(got.answers, vec!["Done."]);
        assert!(got.busy);
    }

    #[test]
    fn a_replayed_conversation_and_other_sessions_are_not_answers() {
        let log = [
            update("s-1", "user_message_chunk", "old question"),
            update("s-1", "agent_message_chunk", "old answer"),
            reply(2, json!({"modes": {}})),
            update("s-2", "agent_message_chunk", "someone else "),
            update("s-1", "agent_message_chunk", "new answer"),
            reply(3, json!({"stopReason": "end_turn"})),
            reply(4, json!({"stopReason": "cancelled"})),
        ]
        .join("\n");
        assert_eq!(answers(&log, Some("s-1")).answers, vec!["new answer"]);
        assert_eq!(answers(&log, None).answers, vec!["someone else new answer"]);
        assert_eq!(answers("", None), Answers::default());
    }

    #[test]
    fn only_the_newest_answers_come_back() {
        let log: Vec<String> = (0..MOST + 5)
            .flat_map(|i| {
                [update("s", "agent_message_chunk", &format!("a{i}")), reply(i as u64, json!({"stopReason": "end_turn"}))]
            })
            .collect();
        let got = answers(&log.join("\n"), None).answers;
        assert_eq!(got.len(), MOST);
        assert_eq!(got.first().map(String::as_str), Some("a5"));
        assert_eq!(got.last().cloned(), Some(format!("a{}", MOST + 4)));
    }

    #[test]
    fn the_log_is_filed_as_a_conversation_with_the_machine_named_on_its_answers() {
        let filed = seed_turns(
            vec![seed("user", " Fix it ", 10), seed("assistant", "Fixed.", 0), seed("system", "x", 1), seed("user", "  ", 2)],
            Some("place:ws-1"),
            99,
        );
        assert_eq!(filed.len(), 2);
        assert_eq!((filed[0].role, filed[0].text.as_str(), filed[0].at, filed[0].brain.as_deref()), (ChatRole::User, "Fix it", 10, None));
        assert_eq!(
            (filed[1].role, filed[1].text.as_str(), filed[1].at, filed[1].brain.as_deref()),
            (ChatRole::Manager, "Fixed.", 99, Some("place:ws-1"))
        );
    }

    #[test]
    fn turns_are_filed_only_where_the_chat_left_off() {
        let chat = seed_turns(vec![seed("user", "Fix it", 1)], None, 1);
        assert!(ends_where(&[], None));
        assert!(!ends_where(&chat, None), "a chat that has turns is not filed over");
        assert!(ends_where(&chat, Some(" Fix it ")));
        assert!(!ends_where(&chat, Some("something else")));
        assert!(!ends_where(&[], Some("Fix it")));
        let mut noted = chat.clone();
        noted.push(ChatTurn { role: ChatRole::System, text: "Couldn't start this turn".into(), ..chat[0].clone() });
        assert!(ends_where(&noted, Some("Fix it")), "Aura's own note is not where the chat left off");
    }
}
