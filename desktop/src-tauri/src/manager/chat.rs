//! Chat thread helpers for ManagerSession. Currently passive — the
//! frontend drives routing (parses `aura plan` output, runs `aura ask`
//! for trivial questions) and uses `manager_append_chat` /
//! `manager_set_tasks` to push results back into the session. Promoting
//! this into a real backend router lands when we wire an in-process
//! Anthropic / Gemini API client; for now keeping the TS side as the
//! brain avoids duplicating the parser already in `ManagerLauncher.tsx`.

use crate::manager::{AnchorKind, ChatAttachment, ChatRole, ManagerSession, RibbonEvent};

/// Append a chat turn and, if it's the Manager speaking, also push a
/// `RibbonEvent::ManagerSpeech` so the surface ribbon stays in sync
/// with the chat scroll without a second event channel.
pub fn append(session: &mut ManagerSession, role: ChatRole, text: String) {
    session.push_chat(role, text.clone());
    if matches!(role, ChatRole::Manager) {
        session.push_ribbon(RibbonEvent::ManagerSpeech { text });
    }
}

/// Append a user turn carrying image attachments. Each attachment will
/// be re-sent as an `image` content block on every subsequent API
/// request — the conversation is stateless on the model side so we
/// keep the bytes inline on the turn.
pub fn append_with_attachments(
    session: &mut ManagerSession,
    role: ChatRole,
    text: String,
    attachments: Vec<ChatAttachment>,
) {
    session.push_chat_with_attachments(role, text.clone(), attachments);
    if matches!(role, ChatRole::Manager) {
        session.push_ribbon(RibbonEvent::ManagerSpeech { text });
    }
}

/// Bucket M1 — append a load-bearing turn. Auto-distillation never
/// compacts these away. Reserve for plan decisions, semantic alerts,
/// episode digests, and other content the brain genuinely needs to
/// remember verbatim.
pub fn append_anchored(
    session: &mut ManagerSession,
    role: ChatRole,
    text: String,
    anchor: AnchorKind,
) {
    session.push_anchored(role, text.clone(), anchor);
    if matches!(role, ChatRole::Manager) {
        session.push_ribbon(RibbonEvent::ManagerSpeech { text });
    }
}

/// Append a user turn that's the resolution of a QuestionCard. Pairs
/// the answer with its originating question so the chat timeline can
/// render Q+A as one element on reload.
pub fn append_answer(session: &mut ManagerSession, answer: String, question: String) {
    session.push_answer(answer, question);
}
