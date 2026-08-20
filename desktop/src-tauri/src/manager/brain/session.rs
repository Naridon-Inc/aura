//! Keeping a stateful agent behind a stateless trait.
//!
//! `Brain::chat` is handed the entire conversation every turn and holds no
//! per-conversation state — that contract is what lets Aura swap engines
//! mid-thread. A live agent session is the opposite: it remembers, and
//! re-sending the transcript would make the agent answer its own history.
//! Every engine Aura hosts as a persistent process has this problem, so
//! the reconciliation lives here rather than inside one protocol.
//!
//! `ChatRequest` carries no conversation id to key a session on, so the
//! transcript itself is the key. We fingerprint every message we've
//! delivered; next turn, if the incoming transcript still starts with
//! exactly those fingerprints, it's the same conversation and only the
//! tail is new. If it doesn't — the user edited a turn, resent, switched
//! branches, or this is a different conversation entirely — the session is
//! abandoned and a fresh one started.
//!
//! Getting the "diverged" case wrong is worse than restarting: the agent
//! would keep answering against a history the user has already thrown
//! away. So divergence is decided conservatively — any mismatch restarts.

use std::collections::HashMap;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::time::{Duration, Instant};

use crate::manager::brain::types::ChatMessage;

/// How long a live agent is kept running with nothing to do.
///
/// The brain now outlives the turn (see `registry::LIVE`), which is the
/// whole point — the agent is where the conversation lives. The cost of
/// that is a real process per worktree per engine, and a conversation
/// nobody returns to would otherwise hold one until the app quits. Half an
/// hour is longer than stepping away and shorter than having moved on.
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(30 * 60);

/// A stable fingerprint for one transcript entry.
fn fingerprint(m: &ChatMessage) -> u64 {
    let mut h = DefaultHasher::new();
    m.role.hash(&mut h);
    // `content` is provider-shaped JSON; its serialisation is stable
    // enough for equality of the *same* value, which is all we need.
    m.content.to_string().hash(&mut h);
    h.finish()
}

pub fn fingerprints(messages: &[ChatMessage]) -> Vec<u64> {
    messages.iter().map(fingerprint).collect()
}

/// What to do with a live session given the transcript for this turn.
#[derive(Debug, Clone, PartialEq)]
pub enum Delta {
    /// The session is still valid; send these messages (user turns only —
    /// the agent authored its own replies and already has them).
    Append(Vec<ChatMessage>),
    /// The transcript no longer matches what this session has seen.
    /// Abandon it and start a new one from the whole history.
    Restart,
}

/// Compare what a session has been told against the transcript now.
pub fn delta(delivered: &[u64], messages: &[ChatMessage]) -> Delta {
    // Nothing delivered yet — everything is new, but there's no session
    // to preserve either, so the caller starts one and sends the lot.
    if delivered.is_empty() {
        return Delta::Append(user_turns(messages));
    }
    // A transcript that got *shorter* cannot be a continuation.
    if messages.len() < delivered.len() {
        return Delta::Restart;
    }
    let incoming = fingerprints(&messages[..delivered.len()]);
    if incoming != delivered {
        return Delta::Restart;
    }
    Delta::Append(user_turns(&messages[delivered.len()..]))
}

/// Only the user's own turns travel to a live session. Assistant turns in
/// the tail are the agent's own words being handed back to it.
fn user_turns(messages: &[ChatMessage]) -> Vec<ChatMessage> {
    messages
        .iter()
        .filter(|m| m.role == "user")
        .cloned()
        .collect()
}

/// One live agent session and how much of the conversation it has heard.
#[derive(Debug, Clone)]
pub struct SessionState {
    pub session_id: String,
    /// The agent's own model id for this session, when it told us one.
    pub model: Option<String>,
    delivered: Vec<u64>,
    /// When this session last carried a turn, for [`sweep_idle`].
    last_used: Instant,
}

impl SessionState {
    pub fn new(session_id: impl Into<String>) -> Self {
        Self {
            session_id: session_id.into(),
            model: None,
            delivered: Vec::new(),
            last_used: Instant::now(),
        }
    }

    /// How long since this session last carried a turn.
    pub fn idle_for(&self) -> Duration {
        self.last_used.elapsed()
    }

    pub fn delta(&self, messages: &[ChatMessage]) -> Delta {
        delta(&self.delivered, messages)
    }

    /// Record that the whole of `messages` has now been delivered. Called
    /// after a turn is sent, not before — a turn that failed to send must
    /// not be remembered as heard.
    pub fn mark_delivered(&mut self, messages: &[ChatMessage]) {
        self.delivered = fingerprints(messages);
        self.last_used = Instant::now();
    }

    pub fn heard(&self) -> usize {
        self.delivered.len()
    }
}

/// Close every session but `keep` that has gone quiet for [`IDLE_TIMEOUT`],
/// returning the keys closed so the caller can say so in its log.
///
/// Removing the entry is what ends the process: both engines hold their
/// child with `kill_on_drop`, so this is the only shutdown either needs.
///
/// `keep` is the session about to carry a turn. Excluding it explicitly
/// rather than relying on its timestamp means a turn can never sweep the
/// agent it is addressed to, however long the user was away.
pub fn sweep_idle<T>(
    sessions: &mut HashMap<String, T>,
    keep: &str,
    state: impl Fn(&T) -> &SessionState,
) -> Vec<String> {
    let stale: Vec<String> = sessions
        .iter()
        .filter(|(key, live)| {
            key.as_str() != keep && state(live).idle_for() >= IDLE_TIMEOUT
        })
        .map(|(key, _)| key.clone())
        .collect();
    for key in &stale {
        sessions.remove(key);
    }
    stale
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn msg(role: &str, text: &str) -> ChatMessage {
        ChatMessage {
            role: role.to_string(),
            content: json!([{ "type": "text", "text": text }]),
        }
    }

    #[test]
    fn the_first_turn_sends_the_user_history() {
        let convo = vec![msg("user", "hello")];
        assert_eq!(delta(&[], &convo), Delta::Append(vec![msg("user", "hello")]));
    }

    #[test]
    fn a_continuing_conversation_sends_only_the_new_turn() {
        let first = vec![msg("user", "hello"), msg("assistant", "hi")];
        let mut s = SessionState::new("ses_1");
        s.mark_delivered(&first);

        let mut second = first.clone();
        second.push(msg("user", "and now this"));

        assert_eq!(
            s.delta(&second),
            Delta::Append(vec![msg("user", "and now this")]),
            "the agent already has its own reply; only the new question travels"
        );
    }

    #[test]
    fn an_edited_earlier_turn_restarts_the_session() {
        // Edit-and-resend: the user changed what they said three turns
        // ago. Continuing would leave the agent answering a question that
        // no longer exists in the transcript on screen.
        let first = vec![msg("user", "hello"), msg("assistant", "hi")];
        let mut s = SessionState::new("ses_1");
        s.mark_delivered(&first);

        let edited = vec![
            msg("user", "hello there"),
            msg("assistant", "hi"),
            msg("user", "next"),
        ];
        assert_eq!(s.delta(&edited), Delta::Restart);
    }

    #[test]
    fn a_truncated_transcript_restarts_the_session() {
        let first = vec![
            msg("user", "one"),
            msg("assistant", "1"),
            msg("user", "two"),
        ];
        let mut s = SessionState::new("ses_1");
        s.mark_delivered(&first);
        assert_eq!(s.delta(&first[..1]), Delta::Restart);
    }

    #[test]
    fn resending_the_identical_transcript_appends_nothing() {
        let convo = vec![msg("user", "hello"), msg("assistant", "hi")];
        let mut s = SessionState::new("ses_1");
        s.mark_delivered(&convo);
        assert_eq!(s.delta(&convo), Delta::Append(vec![]));
    }

    #[test]
    fn assistant_turns_in_the_tail_are_not_echoed_back() {
        // A handover — another engine answered a turn while this session
        // was live. Feeding the agent its peer's words as *user* input
        // would make it reply to them.
        let first = vec![msg("user", "hello")];
        let mut s = SessionState::new("ses_1");
        s.mark_delivered(&first);

        let mut next = first.clone();
        next.push(msg("assistant", "answered elsewhere"));
        next.push(msg("user", "carry on"));

        assert_eq!(s.delta(&next), Delta::Append(vec![msg("user", "carry on")]));
    }

    #[test]
    fn a_different_conversation_entirely_restarts() {
        let mut s = SessionState::new("ses_1");
        s.mark_delivered(&[msg("user", "about the parser")]);
        assert_eq!(s.delta(&[msg("user", "about the CSS")]), Delta::Restart);
    }

    /// Push a session's clock back so the sweep sees it as abandoned.
    /// `Instant` cannot be constructed, only offset from now.
    fn idle_since(session_id: &str, ago: Duration) -> SessionState {
        let mut s = SessionState::new(session_id);
        s.last_used = Instant::now().checked_sub(ago).expect("a recent instant");
        s
    }

    #[test]
    fn an_abandoned_session_is_closed_when_another_turn_comes_through() {
        let mut sessions = HashMap::from([
            ("/repo/old".to_string(), idle_since("ses_old", IDLE_TIMEOUT * 2)),
            ("/repo/live".to_string(), SessionState::new("ses_live")),
        ]);
        let closed = sweep_idle(&mut sessions, "/repo/live", |s| s);
        assert_eq!(closed, vec!["/repo/old".to_string()]);
        assert!(
            sessions.contains_key("/repo/live"),
            "the worktree being worked in keeps its agent",
        );
    }

    #[test]
    fn the_session_this_turn_is_for_is_never_swept() {
        // Away for the afternoon, then back to the same conversation. The
        // agent still holds it; ending it here would restart the session on
        // the very turn that proves the user still wants it.
        let mut sessions = HashMap::from([(
            "/repo/live".to_string(),
            idle_since("ses_live", IDLE_TIMEOUT * 10),
        )]);
        assert!(sweep_idle(&mut sessions, "/repo/live", |s| s).is_empty());
        assert!(sessions.contains_key("/repo/live"));
    }

    #[test]
    fn a_session_that_carried_a_turn_is_not_idle() {
        let mut s = idle_since("ses_1", IDLE_TIMEOUT * 2);
        s.mark_delivered(&[msg("user", "still here")]);
        assert!(
            s.idle_for() < IDLE_TIMEOUT,
            "delivering a turn is what keeps a session alive",
        );
    }

    #[test]
    fn delivered_count_tracks_the_whole_transcript_not_just_user_turns() {
        let convo = vec![
            msg("user", "one"),
            msg("assistant", "1"),
            msg("user", "two"),
        ];
        let mut s = SessionState::new("ses_1");
        s.mark_delivered(&convo);
        assert_eq!(s.heard(), 3);
    }
}
