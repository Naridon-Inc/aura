//! Reactions and comments on a cloud workspace's turns.
//!
//! Everyone who can open a workspace can react to a turn or comment on it,
//! even a member who may not prompt its agent. Every route lives under
//! `/api/v2/public/workspaces/{ws}`:
//!
//! - `GET  /feedback?since=` — every reaction the workspace has now, and the
//!   comments written or changed since the cursor, with the next cursor
//!   (`as_of`) and whether there is more to read;
//! - `POST /messages/{mid}/reactions` / `DELETE …/reactions/{emoji}` — your
//!   own reaction on one turn, answered with that turn's whole set;
//! - `POST /comments`, `PATCH|DELETE /comments/{cid}`,
//!   `POST /comments/{cid}/resolve|reopen` — one comment as it now stands.
//!
//! Ids and emoji go into the path, so only what an id is made of gets in, and
//! an emoji is checked to hold no text and percent-encoded. Whether it is one
//! emoji is the server's call. The server's answers are handed to the window
//! as they came.

use serde_json::{json, Map, Value};

use crate::cmd_cloud_workspaces::{call_at, path_id, Verb};

/// The reactions offered first, each with the one spelling the server stores.
pub(crate) const REACTIONS: [&str; 10] = [
    "👍", "👎", "❤️", "😄", "🎉", "👀", "🚀", "✅", "❌", "🙏",
];

const BODY_MAX: usize = 4000;
const KEY_MAX: usize = 128;

fn base(ws: &str) -> Result<String, String> {
    Ok(format!("/api/v2/public/workspaces/{}", path_id(ws)?))
}

/// A turn's or a comment's id: a UUID the cloud gave out, nothing else.
fn uuid_id(id: &str) -> Result<&str, String> {
    let id = id.trim();
    let ok = !id.is_empty()
        && id.len() <= 64
        && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-');
    if ok {
        Ok(id)
    } else {
        Err("That message or comment id isn't one the cloud gave out.".to_string())
    }
}

/// What the cloud is asked to store as a reaction: one of [`REACTIONS`] in
/// its spelling there (U+FE0F is ignored in matching, so a bare heart is the
/// heart), else a short run of symbols with no letters, spaces or controls
/// in it. Whether that run is exactly one emoji, the server decides.
pub(crate) fn reaction_of(emoji: &str) -> Option<String> {
    let bare = |s: &str| s.chars().filter(|c| *c != '\u{FE0F}').collect::<String>();
    let sent = emoji.trim();
    let want = bare(sent);
    if want.is_empty() {
        return None;
    }
    if let Some(r) = REACTIONS.iter().find(|r| bare(r) == want) {
        return Some((*r).to_string());
    }
    let symbol = |c: char| {
        !c.is_whitespace()
            && !c.is_control()
            && !c.is_alphabetic()
            && (!c.is_ascii() || matches!(c, '#' | '*' | '0'..='9'))
    };
    let ok = sent.len() <= 64
        && sent.chars().count() <= 16
        && sent.chars().all(symbol)
        && sent.chars().any(|c| !c.is_ascii());
    ok.then(|| sent.to_string())
}

/// Every byte outside the unreserved set as `%XX`, for one path segment.
fn encode_segment(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// A comment's text: trimmed, at least one character and at most 4000.
fn body_of(body: &str) -> Result<String, String> {
    let body = body.trim();
    let n = body.chars().count();
    if n == 0 {
        return Err("Write something first.".to_string());
    }
    if n > BODY_MAX {
        return Err(format!("A comment can be at most {BODY_MAX} characters."));
    }
    Ok(body.to_string())
}

/// The cursor a read starts from: an RFC 3339 time, as the server handed it.
fn since_query(since: Option<String>) -> Result<String, String> {
    let Some(since) = since.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) else {
        return Ok(String::new());
    };
    let ok = since.len() <= 64
        && since
            .chars()
            .all(|c| c.is_ascii_digit() || matches!(c, '-' | ':' | 'T' | 'Z' | '.' | '+' | 't' | 'z'));
    if !ok {
        return Err(format!("not a time: {since:?}"));
    }
    Ok(format!("?since={}", encode_segment(&since)))
}

/// The body of `POST /comments`. A reply names its thread and nothing else:
/// the server gives it the thread's turn.
fn new_comment(
    message_id: Option<String>,
    parent_id: Option<String>,
    body: &str,
    key: Option<String>,
) -> Result<Value, String> {
    let mut m = Map::new();
    let given = |v: Option<String>| v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    match (given(parent_id), given(message_id)) {
        (Some(parent), _) => {
            m.insert("parent_id".into(), json!(uuid_id(&parent)?));
        }
        (None, Some(mid)) => {
            m.insert("message_id".into(), json!(uuid_id(&mid)?));
        }
        (None, None) => {
            m.insert("message_id".into(), Value::Null);
        }
    }
    m.insert("body".into(), json!(body_of(body)?));
    if let Some(key) = given(key) {
        if key.chars().count() > KEY_MAX {
            return Err(format!("a comment key can be at most {KEY_MAX} characters"));
        }
        m.insert("key".into(), json!(key));
    }
    Ok(Value::Object(m))
}

/// Every reaction the workspace has now, and the comments changed since
/// `since` (all of them without one), with `as_of` and `more`.
#[tauri::command]
pub async fn cloud_feedback_read(id: String, since: Option<String>) -> Result<Value, String> {
    let path = format!("{}/feedback{}", base(&id)?, since_query(since)?);
    call_at(Verb::Get, &path, None).await
}

/// Add your reaction to one turn. Answers that turn's whole set.
#[tauri::command]
pub async fn cloud_reaction_add(
    id: String,
    message_id: String,
    emoji: String,
) -> Result<Value, String> {
    let emoji = reaction_of(&emoji).ok_or_else(|| "A reaction is one emoji.".to_string())?;
    let path = format!("{}/messages/{}/reactions", base(&id)?, uuid_id(&message_id)?);
    call_at(Verb::Post, &path, Some(json!({ "emoji": emoji }))).await
}

/// Take your reaction off one turn. Answers that turn's whole set.
#[tauri::command]
pub async fn cloud_reaction_remove(
    id: String,
    message_id: String,
    emoji: String,
) -> Result<Value, String> {
    let emoji = reaction_of(&emoji).ok_or_else(|| "A reaction is one emoji.".to_string())?;
    let path = format!(
        "{}/messages/{}/reactions/{}",
        base(&id)?,
        uuid_id(&message_id)?,
        encode_segment(&emoji)
    );
    call_at(Verb::Delete, &path, None).await
}

/// Comment on a turn, on the workspace (no turn), or reply to a thread.
#[tauri::command]
pub async fn cloud_comment_create(
    id: String,
    message_id: Option<String>,
    parent_id: Option<String>,
    body: String,
    key: Option<String>,
) -> Result<Value, String> {
    let payload = new_comment(message_id, parent_id, &body, key)?;
    call_at(Verb::Post, &format!("{}/comments", base(&id)?), Some(payload)).await
}

/// Change the text of your own comment.
#[tauri::command]
pub async fn cloud_comment_edit(
    id: String,
    comment_id: String,
    body: String,
) -> Result<Value, String> {
    let body = body_of(&body)?;
    let path = format!("{}/comments/{}", base(&id)?, uuid_id(&comment_id)?);
    call_at(Verb::Patch, &path, Some(json!({ "body": body }))).await
}

/// Delete a comment. Its replies stay, and the thread keeps its shape.
#[tauri::command]
pub async fn cloud_comment_delete(id: String, comment_id: String) -> Result<Value, String> {
    let path = format!("{}/comments/{}", base(&id)?, uuid_id(&comment_id)?);
    call_at(Verb::Delete, &path, None).await
}

/// Mark a thread resolved.
#[tauri::command]
pub async fn cloud_comment_resolve(id: String, comment_id: String) -> Result<Value, String> {
    let path = format!("{}/comments/{}/resolve", base(&id)?, uuid_id(&comment_id)?);
    call_at(Verb::Post, &path, None).await
}

/// Open a resolved thread again.
#[tauri::command]
pub async fn cloud_comment_reopen(id: String, comment_id: String) -> Result<Value, String> {
    let path = format!("{}/comments/{}/reopen", base(&id)?, uuid_id(&comment_id)?);
    call_at(Verb::Post, &path, None).await
}

#[cfg(test)]
mod tests {
    use super::*;

    const MID: &str = "0b6c1f3e-2a4d-4c5e-9f00-1234567890ab";

    #[test]
    fn a_reaction_is_an_emoji_and_the_ten_keep_their_spelling() {
        let of = |s: &str| reaction_of(s);
        assert_eq!(of("👍").as_deref(), Some("👍"));
        assert_eq!(of("❤").as_deref(), Some("❤️"));
        assert_eq!(of("❤️").as_deref(), Some("❤️"));
        assert_eq!(of(" 🙏 ").as_deref(), Some("🙏"));
        assert_eq!(of("👍🏽").as_deref(), Some("👍🏽"));
        assert_eq!(of("🤡").as_deref(), Some("🤡"));
        assert_eq!(of("👩‍💻").as_deref(), Some("👩‍💻"));
        assert_eq!(of("1️⃣").as_deref(), Some("1️⃣"));
        assert_eq!(of(""), None);
        assert_eq!(of("\u{FE0F}"), None);
        assert_eq!(of("1"), None);
        assert_eq!(of("lol"), None);
        assert_eq!(of("🔥 fire"), None);
        assert_eq!(of("é"), None);
        assert_eq!(of("日本"), None);
        assert_eq!(of("👍/../x"), None);
        assert_eq!(REACTIONS.len(), 10);
    }

    #[test]
    fn an_emoji_goes_into_the_path_percent_encoded() {
        assert_eq!(encode_segment("👍"), "%F0%9F%91%8D");
        assert_eq!(encode_segment("❤️"), "%E2%9D%A4%EF%B8%8F");
        assert_eq!(encode_segment("a-b_c.d~"), "a-b_c.d~");
        assert_eq!(encode_segment("a/b"), "a%2Fb");
    }

    #[test]
    fn only_a_cloud_id_reaches_the_path() {
        assert_eq!(uuid_id(MID), Ok(MID));
        assert!(uuid_id("").is_err());
        assert!(uuid_id("../reactions").is_err());
        assert!(uuid_id("abc/def").is_err());
        assert!(uuid_id(&"a".repeat(65)).is_err());
        assert!(base("ws-1").is_ok());
        assert!(base("ws/1").is_err());
    }

    #[test]
    fn a_comment_is_one_to_four_thousand_characters_after_trimming() {
        assert_eq!(body_of("  hi  "), Ok("hi".to_string()));
        assert!(body_of("   ").is_err());
        assert!(body_of(&"é".repeat(BODY_MAX)).is_ok());
        assert!(body_of(&"é".repeat(BODY_MAX + 1)).is_err());
    }

    #[test]
    fn the_cursor_is_a_time_or_nothing() {
        assert_eq!(since_query(None), Ok(String::new()));
        assert_eq!(since_query(Some("  ".into())), Ok(String::new()));
        assert_eq!(
            since_query(Some("2026-11-11T09:30:00.123456Z".into())),
            Ok("?since=2026-11-11T09%3A30%3A00.123456Z".to_string())
        );
        assert_eq!(
            since_query(Some("2026-11-11T09:30:00+05:30".into())),
            Ok("?since=2026-11-11T09%3A30%3A00%2B05%3A30".to_string())
        );
        assert!(since_query(Some("yesterday&x=1".into())).is_err());
    }

    #[test]
    fn a_reply_names_its_thread_and_lets_the_server_give_it_the_turn() {
        let reply = new_comment(Some(MID.into()), Some(MID.into()), "ok", None).unwrap();
        assert_eq!(reply, json!({ "parent_id": MID, "body": "ok" }));
        let on_turn = new_comment(Some(MID.into()), None, " looks good ", Some("k1".into())).unwrap();
        assert_eq!(on_turn, json!({ "message_id": MID, "body": "looks good", "key": "k1" }));
        let workspace = new_comment(None, Some("  ".into()), "hello", None).unwrap();
        assert_eq!(workspace, json!({ "message_id": null, "body": "hello" }));
        assert!(new_comment(Some("x/y".into()), None, "hi", None).is_err());
        assert!(new_comment(None, None, "hi", Some("k".repeat(KEY_MAX + 1))).is_err());
        assert!(new_comment(None, None, "  ", None).is_err());
    }
}
