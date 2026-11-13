//! What the person is looking at while they talk to Aura, when that is not
//! the project the conversation is filed under.
//!
//! The panel beside Home is one conversation, anchored to a project on this
//! laptop, and it stays open when the person switches to their organization's
//! cloud. Everything the model is told about where it is — the project line in
//! its prompt, the tools that read files and git — says "this laptop", so
//! asked "what's running?" from the cloud's Home it answered about the local
//! project. The app now says which place is showing, with what that place
//! holds, and every engine reads it on the turn it is asked.
//!
//! The note rides on the newest user message as an `[aura]` line rather than
//! in the system prompt: a CLI engine continuing a session reads only the new
//! message, a native engine keeps its own system prompt, and the place can
//! change between two turns of one conversation. It is never written into the
//! transcript — the person did not type it, and a reload must not replay a
//! place they have since left.
//!
//! Held in memory only. A restart forgets it, and the app sets it again the
//! moment its Home is showing.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use serde_json::{json, Value};

use super::brain::ChatMessage;

/// Longest note kept. The app sends a bounded list; this is the backstop, so
/// a long organization can't crowd the person's own question out of a turn.
pub const MAX_NOTE_CHARS: usize = 6_000;

fn notes() -> &'static Mutex<HashMap<String, String>> {
    static NOTES: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    NOTES.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Set (or with `None`/blank, clear) what the conversation's person is looking
/// at. Returns what was kept.
pub fn set(session_id: &str, note: Option<&str>) -> Option<String> {
    let kept = note.map(str::trim).filter(|n| !n.is_empty()).map(bounded);
    let mut map = notes().lock().unwrap_or_else(|e| e.into_inner());
    match &kept {
        Some(n) => {
            map.insert(session_id.to_string(), n.clone());
        }
        None => {
            map.remove(session_id);
        }
    }
    kept
}

/// The note for this conversation, if its person is somewhere other than its
/// project.
pub fn get(session_id: &str) -> Option<String> {
    notes()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(session_id)
        .cloned()
}

fn bounded(note: &str) -> String {
    if note.chars().count() <= MAX_NOTE_CHARS {
        return note.to_string();
    }
    let mut out: String = note.chars().take(MAX_NOTE_CHARS).collect();
    out.push_str("\n…(cut short)");
    out
}

/// `text` as the model should read it this turn: the note first, then what
/// the person typed.
pub fn prefixed(note: Option<&str>, text: &str) -> String {
    match note {
        Some(n) if !n.trim().is_empty() => format!("{}\n\n{text}", n.trim()),
        _ => text.to_string(),
    }
}

/// Put the note in front of the newest user message. A message that is a
/// list of blocks gets it as a leading text block, so images and tool
/// results after it are untouched. No user message, nothing to do.
pub fn onto_last_user(messages: &mut [ChatMessage], note: Option<&str>) {
    let Some(note) = note.map(str::trim).filter(|n| !n.is_empty()) else {
        return;
    };
    let Some(last) = messages.iter_mut().rev().find(|m| m.role == "user") else {
        return;
    };
    match &mut last.content {
        Value::String(text) => *text = prefixed(Some(note), text),
        Value::Array(blocks) => blocks.insert(0, json!({ "type": "text", "text": note })),
        other => *other = Value::String(prefixed(Some(note), &other.to_string())),
    }
}

/// Tell Aura where the person is looking. The app calls it whenever its Home
/// panel's place changes: with a note in the cloud, with nothing back home.
#[tauri::command]
pub fn manager_set_view(session_id: String, note: Option<String>) -> Result<(), String> {
    let sid = session_id.trim();
    if sid.is_empty() {
        return Err("no conversation named".into());
    }
    set(sid, note.as_deref());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn user(content: Value) -> ChatMessage {
        ChatMessage { role: "user".into(), content }
    }

    fn assistant(text: &str) -> ChatMessage {
        ChatMessage { role: "assistant".into(), content: Value::String(text.into()) }
    }

    const CLOUD: &str = "[aura] The user is in their organization's cloud place (Northwind).";

    #[test]
    fn the_note_reaches_only_the_newest_question() {
        let mut m = vec![
            user(json!("first question")),
            assistant("first answer"),
            user(json!("what's running?")),
        ];
        onto_last_user(&mut m, Some(CLOUD));
        assert_eq!(m[0].content, json!("first question"));
        assert_eq!(m[2].content, json!(format!("{CLOUD}\n\nwhat's running?")));
    }

    #[test]
    fn a_turn_of_blocks_keeps_its_blocks() {
        let image = json!({ "type": "image", "source": { "type": "base64", "data": "AA" } });
        let mut m = vec![user(json!([image.clone(), { "type": "text", "text": "this one?" }]))];
        onto_last_user(&mut m, Some(CLOUD));
        let blocks = m[0].content.as_array().unwrap();
        assert_eq!(blocks[0], json!({ "type": "text", "text": CLOUD }));
        assert_eq!(blocks[1], image);
        assert_eq!(blocks.len(), 3);
    }

    #[test]
    fn back_home_the_question_goes_as_typed() {
        let mut m = vec![user(json!("what's running?"))];
        onto_last_user(&mut m, None);
        onto_last_user(&mut m, Some("   "));
        assert_eq!(m[0].content, json!("what's running?"));
        assert_eq!(prefixed(None, "hi"), "hi");
    }

    #[test]
    fn the_place_is_per_conversation_and_clears() {
        set("s-cloud-1", Some(CLOUD));
        assert_eq!(get("s-cloud-1").as_deref(), Some(CLOUD));
        assert_eq!(get("s-other-1"), None);
        set("s-cloud-1", None);
        assert_eq!(get("s-cloud-1"), None);
        set("s-cloud-1", Some(CLOUD));
        set("s-cloud-1", Some("  "));
        assert_eq!(get("s-cloud-1"), None);
    }

    #[test]
    fn a_long_note_is_cut_not_dropped() {
        let long = format!("[aura] {}", "x".repeat(MAX_NOTE_CHARS * 2));
        let kept = set("s-long-1", Some(&long)).unwrap();
        assert!(kept.chars().count() < long.chars().count());
        assert!(kept.starts_with("[aura] "));
        set("s-long-1", None);
    }

    #[test]
    fn the_command_needs_a_conversation() {
        assert!(manager_set_view(" ".into(), Some(CLOUD.into())).is_err());
        assert!(manager_set_view("s-cmd-1".into(), Some(CLOUD.into())).is_ok());
        assert_eq!(get("s-cmd-1").as_deref(), Some(CLOUD));
        assert!(manager_set_view("s-cmd-1".into(), None).is_ok());
        assert_eq!(get("s-cmd-1"), None);
    }
}
