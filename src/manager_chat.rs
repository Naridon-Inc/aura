//! Reading a Manager conversation off disk.
//!
//! A session under `~/.aura/manager-sessions/` is stored in two pieces: the
//! session file `<sid>.json` describes the session and carries its last few
//! turns, and `<sid>.chat.jsonl` holds everything before that, one turn per
//! line. The desktop shell writes both (`aura-shell/src-tauri/src/manager/
//! chat_log.rs` has the why); this crate only ever reads them.
//!
//! Turns come back as raw `Value`s rather than a typed struct on purpose.
//! `ChatTurn` lives in the shell crate, the two are built separately, and the
//! only fields anything here wants are `role`, `text` and `anchor`. Mirroring
//! the whole struct would be a copy that silently rots.

use serde_json::Value;

/// The session file's own account of how many turns it handed to the log.
/// Absent on sessions written before the split, where the session file
/// carried the whole conversation — and a `0` reads those correctly.
fn chat_start(session: &Value) -> usize {
    session
        .get("chat_start")
        .and_then(|n| n.as_u64())
        .unwrap_or(0) as usize
}

/// The whole conversation, oldest turn first.
///
/// `session` is the parsed `<sid>.json`; `dir` is the directory it came from.
/// A missing or unreadable log yields the turns the session file holds rather
/// than nothing, so a damaged archive costs recent context instead of all of
/// it.
pub fn transcript(dir: &std::path::Path, sid: &str, session: &Value) -> Vec<Value> {
    let tail = session
        .get("chat")
        .and_then(|c| c.as_array())
        .cloned()
        .unwrap_or_default();
    let start = chat_start(session);
    if start == 0 {
        return tail;
    }

    let path = dir.join(format!("{sid}.chat.jsonl"));
    let Ok(raw) = std::fs::read_to_string(&path) else {
        eprintln!(
            "warn: manager session {sid} archives {start} turns in {} — unreadable",
            path.display()
        );
        return tail;
    };
    let mut turns: Vec<Value> = Vec::with_capacity(start + tail.len());
    for line in raw.lines() {
        if turns.len() == start {
            break;
        }
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<Value>(line) {
            Ok(turn) => turns.push(turn),
            Err(e) => eprintln!("warn: skipping unreadable turn in {}: {e}", path.display()),
        }
    }
    turns.extend(tail);
    turns
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn turn(text: &str) -> Value {
        json!({ "role": "manager", "text": text })
    }

    #[test]
    fn the_archive_comes_before_the_tail() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(
            tmp.path().join("s.chat.jsonl"),
            "{\"role\":\"user\",\"text\":\"one\"}\n{\"role\":\"manager\",\"text\":\"two\"}\n",
        )
        .unwrap();
        let session = json!({ "chat_start": 2, "chat": [turn("three")] });
        let got = transcript(tmp.path(), "s", &session);
        assert_eq!(
            got.iter()
                .map(|t| t["text"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["one", "two", "three"],
        );
    }

    /// Sessions written before the transcript moved out keep it inline and
    /// have no `chat_start`. They must still read whole.
    #[test]
    fn a_session_from_before_the_split_reads_whole() {
        let tmp = tempfile::tempdir().unwrap();
        let session = json!({ "chat": [turn("one"), turn("two")] });
        assert_eq!(transcript(tmp.path(), "s", &session).len(), 2);
    }

    /// A save that wrote its turns and died before the session file landed
    /// leaves the log ahead of the session. Those turns are not part of the
    /// conversation.
    #[test]
    fn turns_past_the_sessions_count_are_ignored() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(
            tmp.path().join("s.chat.jsonl"),
            "{\"text\":\"one\"}\n{\"text\":\"two\"}\n{\"text\":\"orphan\"}\n",
        )
        .unwrap();
        let session = json!({ "chat_start": 2, "chat": [turn("three")] });
        let got = transcript(tmp.path(), "s", &session);
        assert_eq!(got.len(), 3);
        assert!(got.iter().all(|t| t["text"] != "orphan"));
    }

    /// A lost archive must not take the recent conversation with it.
    #[test]
    fn a_missing_archive_still_yields_the_tail() {
        let tmp = tempfile::tempdir().unwrap();
        let session = json!({ "chat_start": 40, "chat": [turn("recent")] });
        let got = transcript(tmp.path(), "gone", &session);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0]["text"], "recent");
    }
}
