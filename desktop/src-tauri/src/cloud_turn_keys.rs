//! One key per turn of a chat that runs on one of the org's machines, shared
//! by this laptop's copy of the chat and the workspace's log.
//!
//! Each finished turn of such a chat is copied onto the workspace's log under
//! a key (`<turn>-u` for the question, `<turn>-a` for the answer), and the
//! cloud hands that key back on every reaction and comment as `message_key`.
//! For this laptop's chat to show them under the right turn, the turn it
//! files has to carry the same key. So the key is made once, when the turn is
//! sent ([`begin`]), stamped onto the turns this laptop files ([`stamp`]),
//! and taken by the relay that copies them onto the log ([`take`]). Nothing
//! is ever matched by text.
//!
//! The relay also notes the id the cloud gave each copy ([`kept`]), so a turn
//! nobody has reacted to yet can still be reacted to from here.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

/// How many kept ids one workspace holds before the oldest go.
const KEPT_CAP: usize = 2_000;

#[derive(Default)]
struct Keys {
    /// The turn under way, by the provider id of the machine's chat.
    by_provider: HashMap<String, String>,
    /// The turn under way and which of its sides this laptop has filed, by
    /// local chat session.
    by_session: HashMap<String, Pending>,
    /// The cloud's id for each copy the relay kept, by workspace, oldest
    /// first.
    kept: HashMap<String, Vec<(String, String)>>,
}

struct Pending {
    turn: String,
    asked_filed: bool,
}

fn keys() -> &'static Mutex<Keys> {
    static K: OnceLock<Mutex<Keys>> = OnceLock::new();
    K.get_or_init(Default::default)
}

/// The key of a turn's question, or of its answer.
pub fn side_key(turn: &str, asked: bool) -> String {
    format!("{turn}-{}", if asked { "u" } else { "a" })
}

/// A turn is being sent from `session` to the machine chat `provider`. Any
/// turn either of them had under way is over.
pub fn begin(provider: &str, session: &str) -> String {
    let turn = uuid::Uuid::new_v4().to_string();
    let mut k = keys().lock().unwrap();
    k.by_provider.insert(provider.to_string(), turn.clone());
    k.by_session.insert(
        session.to_string(),
        Pending { turn: turn.clone(), asked_filed: false },
    );
    turn
}

/// The key the turn this laptop is filing in `session` carries: its question
/// first, then its answer, which ends the turn. A note of Aura's own carries
/// none, and neither does anything filed with no turn under way.
pub fn stamp(session: &str, asked: bool) -> Option<String> {
    let mut k = keys().lock().unwrap();
    let pending = k.by_session.get_mut(session)?;
    if asked {
        if pending.asked_filed {
            return None;
        }
        pending.asked_filed = true;
        return Some(side_key(&pending.turn, true));
    }
    let turn = pending.turn.clone();
    k.by_session.remove(session);
    Some(side_key(&turn, false))
}

/// The turn the machine chat `provider` is on, for the relay to copy it onto
/// the log under. Taken once.
pub fn take(provider: &str) -> Option<String> {
    keys().lock().unwrap().by_provider.remove(provider)
}

/// The cloud gave the copy kept under `key` the id `id`.
pub fn kept(workspace: &str, key: &str, id: &str) {
    if key.is_empty() || id.is_empty() {
        return;
    }
    let mut k = keys().lock().unwrap();
    let list = k.kept.entry(workspace.to_string()).or_default();
    list.retain(|(have, _)| have != key);
    list.push((key.to_string(), id.to_string()));
    if list.len() > KEPT_CAP {
        let extra = list.len() - KEPT_CAP;
        list.drain(..extra);
    }
}

/// Every copy kept for `workspace` since this laptop started, by key.
pub fn kept_for(workspace: &str) -> HashMap<String, String> {
    keys()
        .lock()
        .unwrap()
        .kept
        .get(workspace)
        .map(|l| l.iter().cloned().collect())
        .unwrap_or_default()
}

/// The cloud ids this laptop's relay got back for a workspace's turns, by the
/// key each was kept under.
#[tauri::command]
pub fn cloud_box_turn_ids(id: String) -> Result<HashMap<String, String>, String> {
    let id = crate::cmd_cloud_workspaces::path_id(&id)?;
    Ok(kept_for(id))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_question_and_its_answer_carry_the_key_the_relay_copies_them_under() {
        let turn = begin("place:ws-t1", "s-t1");
        assert_eq!(stamp("s-t1", true), Some(format!("{turn}-u")));
        assert_eq!(stamp("s-t1", true), None, "only the first question of a turn");
        assert_eq!(take("place:ws-t1"), Some(turn.clone()));
        assert_eq!(take("place:ws-t1"), None, "taken once");
        assert_eq!(stamp("s-t1", false), Some(format!("{turn}-a")));
        assert_eq!(stamp("s-t1", false), None, "the answer ends the turn");
    }

    #[test]
    fn a_new_turn_replaces_one_that_never_finished() {
        let first = begin("place:ws-t2", "s-t2");
        let second = begin("place:ws-t2", "s-t2");
        assert_ne!(first, second);
        assert_eq!(take("place:ws-t2"), Some(second.clone()));
        assert_eq!(stamp("s-t2", true), Some(format!("{second}-u")));
    }

    #[test]
    fn a_session_with_no_turn_under_way_files_nothing_keyed() {
        assert_eq!(stamp("s-none", true), None);
        assert_eq!(stamp("s-none", false), None);
    }

    #[test]
    fn kept_ids_are_one_per_key_and_capped() {
        kept("ws-k", "a-u", "id-1");
        kept("ws-k", "a-u", "id-2");
        kept("ws-k", "", "id-3");
        assert_eq!(kept_for("ws-k").get("a-u").map(String::as_str), Some("id-2"));
        assert_eq!(kept_for("ws-k").len(), 1);
        for i in 0..(KEPT_CAP + 5) {
            kept("ws-cap", &format!("k{i}"), "id");
        }
        let ids = kept_for("ws-cap");
        assert_eq!(ids.len(), KEPT_CAP);
        assert!(!ids.contains_key("k0"));
        assert!(ids.contains_key(&format!("k{}", KEPT_CAP + 4)));
        assert!(cloud_box_turn_ids("ws/../x".into()).is_err());
    }
}
