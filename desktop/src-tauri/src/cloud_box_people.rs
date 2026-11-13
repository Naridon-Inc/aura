//! A message in a machine chat that is for the people in the workspace, not
//! for its agent.
//!
//! In a cloud workspace whose chat runs on one of the org's machines, the
//! member driving it types in that chat. A message that opens with teammates'
//! @logins ("@maya can you check the copy?") is addressed to them: it goes onto
//! the workspace's shared log under the driver's name, where everyone reads
//! it, and the agent never sees it. Everything else goes to the agent as
//! before. The rule is the one the app labels turns with (`addressedTo` in
//! `cloudPeople.ts`), so what the transcript calls "to Maya" is exactly what
//! was kept from the agent.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use crate::cmd_cloud_box_chat as box_chat;

/// What the driver's laptop knows about one machine chat it is connected to.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Room {
    pub workspace: String,
    /// How the driver is shown on the turns they send.
    pub author: Option<String>,
    /// The teammates' GitHub logins a message can be addressed to.
    pub logins: Vec<String>,
}

fn rooms() -> &'static Mutex<HashMap<String, Room>> {
    static ROOMS: OnceLock<Mutex<HashMap<String, Room>>> = OnceLock::new();
    ROOMS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Remember who can be addressed in the chat behind `provider`. Called on
/// every connect, so a teammate added since the last one is known.
pub fn remember(provider: &str, room: Room) {
    if let Ok(mut map) = rooms().lock() {
        map.insert(provider.to_string(), room);
    }
}

/// Forget a chat this laptop let go of.
pub fn forget(provider: &str) {
    if let Ok(mut map) = rooms().lock() {
        map.remove(provider);
    }
}

/// Words that start a message to the agent, even after an @.
const NOT_PEOPLE: &[&str] = &["claude", "codex", "aura", "agent", "here", "all", "everyone"];

fn login_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '-'
}

/// The teammates (by login, as the room spells them) a message opens with,
/// or `None` when it is for the agent. "@maya can you look?" is Maya's;
/// "Fix @maya's test" and "@maya's test fails" are the agent's.
pub fn people_addressed(text: &str, logins: &[String]) -> Option<Vec<String>> {
    let mut found: Vec<String> = Vec::new();
    let mut rest = text.trim_start();
    while let Some(after) = rest.strip_prefix('@') {
        let len = after.find(|c: char| !login_char(c)).unwrap_or(after.len());
        let (name, tail) = after.split_at(len);
        let ends_well = tail.chars().next().is_none_or(|c| c.is_whitespace() || ",:;!?.".contains(c));
        if name.is_empty() || len > 39 || name.starts_with('-') || !ends_well {
            break;
        }
        let lower = name.to_ascii_lowercase();
        if NOT_PEOPLE.contains(&lower.as_str()) {
            break;
        }
        let Some(login) = logins.iter().find(|l| l.eq_ignore_ascii_case(name)) else {
            break;
        };
        if !found.iter().any(|f| f.eq_ignore_ascii_case(login)) {
            found.push(login.clone());
        }
        rest = tail.trim_start_matches(|c: char| c.is_whitespace() || ",:;".contains(c));
    }
    (!found.is_empty()).then_some(found)
}

/// What the person typed: the turn without the mode, pipe or goal directives
/// the composer puts in front of each message for the agent. "[AUTO MODE.
/// …]\n\n@maya" is "@maya", which is who it is for and what goes on the log.
/// Messages queued while the agent worked reach it as one turn with each
/// one's directive opening its own line; those lines go too, with the blank
/// lines after them, so the log reads the messages and nothing else.
pub fn persons_words(text: &str) -> String {
    let mut kept: Vec<&str> = Vec::new();
    let mut after_directive = false;
    for line in text.split('\n') {
        let rest = crate::manager::strip_steering_prefix(line);
        if rest.len() < line.trim_start().len() {
            after_directive = rest.trim().is_empty();
            if !after_directive {
                kept.push(rest);
            }
            continue;
        }
        if after_directive && line.trim().is_empty() {
            continue;
        }
        after_directive = false;
        kept.push(line);
    }
    kept.join("\n").trim().to_string()
}

/// The chat's room and who a message names, when the message is for people.
pub fn addressed(provider: &str, text: &str) -> Option<(Room, Vec<String>)> {
    let room = rooms().lock().ok()?.get(provider).cloned()?;
    let people = people_addressed(&persons_words(text), &room.logins)?;
    Some((room, people))
}

/// "@maya", "@maya and @sam", "@maya, @sam and @lee".
pub fn named(people: &[String]) -> String {
    let at: Vec<String> = people.iter().map(|p| format!("@{p}")).collect();
    match at.as_slice() {
        [] => String::new(),
        [one] => one.clone(),
        [init @ .., last] => format!("{} and {last}", init.join(", ")),
    }
}

/// Keep a message to people on the workspace's shared log, under the
/// driver's name, without the agent seeing it. Only the person's words go:
/// a directive meant for the agent is nobody's business on the log.
pub async fn post(room: &Room, text: &str) -> Result<(), String> {
    let id = format!("people-{}", uuid::Uuid::new_v4());
    let words = persons_words(text);
    box_chat::cloud_box_turn(room.workspace.clone(), "user".into(), words, id, room.author.clone())
        .await
        .map(|_| ())
}

/// The line this laptop's chat shows after one: who got it, and that the
/// agent didn't. It also ends the run of people's words, so the next message
/// to the agent carries only itself.
pub fn sent_note(people: &[String]) -> String {
    format!("Sent to {} only. The agent didn't get this message.", named(people))
}

// ── Words that are already on the log ──────────────────────────────────────

/// A workspace that sat with no computer under it already holds the messages
/// its new chat starts with. They are handed to the agent as its first
/// message, and that message is not posted onto the log a second time.
fn on_log() -> &'static Mutex<HashMap<String, String>> {
    static ON_LOG: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    ON_LOG.get_or_init(|| Mutex::new(HashMap::new()))
}

fn same_words(a: &str) -> String {
    a.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Note that `workspace`'s chat opens with words its log already has.
pub fn hold_on_log(workspace: &str, text: &str) {
    let words = same_words(text);
    if words.is_empty() {
        return;
    }
    if let Ok(mut map) = on_log().lock() {
        map.insert(workspace.to_string(), words);
    }
}

/// Whether a person's turn the agent just took is the one already on the
/// log. True once: the next turn with the same words is a new message.
pub fn already_on_log(workspace: &str, text: &str) -> bool {
    let Ok(mut map) = on_log().lock() else {
        return false;
    };
    if map.get(workspace).is_some_and(|held| *held == same_words(text)) {
        map.remove(workspace);
        return true;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn logins() -> Vec<String> {
        vec!["maya-k".into(), "SamR".into()]
    }

    #[test]
    fn words_already_on_the_log_are_skipped_once() {
        hold_on_log("ws-on-log", "fix the login\n\nand its tests");
        assert!(!already_on_log("ws-on-log", "something else"));
        assert!(!already_on_log("ws-other", "fix the login and its tests"));
        assert!(already_on_log("ws-on-log", "  fix the login\nand its tests "));
        assert!(!already_on_log("ws-on-log", "fix the login and its tests"));
        hold_on_log("ws-on-log", "   ");
        assert!(!already_on_log("ws-on-log", ""));
    }

    #[test]
    fn a_message_opening_with_teammates_is_for_them() {
        assert_eq!(people_addressed("@maya-k can you check?", &logins()), Some(vec!["maya-k".into()]));
        assert_eq!(
            people_addressed("  @samr, @maya-k: lunch?", &logins()),
            Some(vec!["SamR".into(), "maya-k".into()])
        );
        assert_eq!(people_addressed("@maya-k", &logins()), Some(vec!["maya-k".into()]));
        assert_eq!(people_addressed("@maya-k @maya-k hi", &logins()), Some(vec!["maya-k".into()]));
    }

    #[test]
    fn anything_else_is_for_the_agent() {
        for text in [
            "Fix @maya-k's failing test",
            "@maya-k's test is failing",
            "@nobody hello",
            "@src/app.ts is broken",
            "please look",
            "@ maya-k hi",
        ] {
            assert_eq!(people_addressed(text, &logins()), None, "{text}");
        }
    }

    /// The composer puts its mode directive in front of a chat's first turn
    /// (and of the first after a mode change). "@maya" sent in Auto is still
    /// Maya's, and the log gets "@maya", not the directive.
    #[test]
    fn a_mode_directive_in_front_does_not_hide_who_it_is_for() {
        remember(
            "place:ws-test-directive",
            Room { workspace: "w2".into(), author: None, logins: logins() },
        );
        let auto = "[AUTO MODE. Full autopilot. Judge the request and pick the approach yourself.]\n\n@maya-k";
        let (_, people) = addressed("place:ws-test-directive", auto).unwrap();
        assert_eq!(people, vec!["maya-k".to_string()]);
        assert_eq!(persons_words(auto), "@maya-k");
        let stacked = "[↪ PIPED. User also wrote this.]\n\n[PLAN MODE. Plan first.]\n\n[GOAL. Deliver it.]\n\n@SAMR: ship?";
        assert_eq!(addressed("place:ws-test-directive", stacked).unwrap().1, vec!["SamR".to_string()]);
        assert_eq!(persons_words(stacked), "@SAMR: ship?");
        assert!(addressed("place:ws-test-directive", "[AUTO MODE. Go.]\n\nFix @maya-k's test").is_none());
        forget("place:ws-test-directive");
    }

    /// A turn of queued messages, as the agent got it: each message with the
    /// directive in front of it. The log keeps the messages only.
    #[test]
    fn a_turn_of_queued_messages_keeps_only_what_was_typed() {
        let auto = "[AUTO MODE. Full autopilot. Keep going until the task is genuinely complete.]\n\n";
        let queued = format!("@maya-k hello\nhi\n\nHello\n{auto}Hello\nhi\n{auto}hi");
        assert_eq!(persons_words(&queued), "@maya-k hello\nhi\n\nHello\nHello\nhi\nhi");
        assert_eq!(persons_words(&format!("{auto}first\n{auto}second")), "first\nsecond");
        assert_eq!(persons_words("explain [AUTO MODE. x] here"), "explain [AUTO MODE. x] here");
        assert_eq!(persons_words(&format!("{auto}")), "");
    }

    #[test]
    fn the_agents_own_name_is_never_a_person() {
        let mut l = logins();
        l.push("claude".into());
        assert_eq!(people_addressed("@claude fix it", &l), None);
    }

    #[test]
    fn a_room_answers_only_for_its_own_chat() {
        remember(
            "place:ws-test-room",
            Room { workspace: "w1".into(), author: Some("Ash".into()), logins: logins() },
        );
        let (room, people) = addressed("place:ws-test-room", "@samr look").unwrap();
        assert_eq!((room.workspace.as_str(), people), ("w1", vec!["SamR".to_string()]));
        assert!(addressed("place:ws-test-room", "fix the build").is_none());
        assert!(addressed("place:ws-other", "@samr look").is_none());
        forget("place:ws-test-room");
        assert!(addressed("place:ws-test-room", "@samr look").is_none());
    }

    #[test]
    fn the_note_names_who_got_it() {
        assert_eq!(sent_note(&["maya".into()]), "Sent to @maya only. The agent didn't get this message.");
        assert_eq!(named(&["a".into(), "b".into(), "c".into()]), "@a, @b and @c");
    }
}
