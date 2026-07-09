//! Direct-message notifications for task assignments and @-mentions.
//!
//! When someone assigns a task to a person, or @-mentions a person in a
//! task or page, that person should hear about it the same way they hear
//! about anything else on the team: a direct message on the chat rail,
//! authored by the *actor* (the human who did the assigning / mentioning),
//! not by a faceless "system" bot. This module is the seam that turns a
//! board/page event into those DMs.
//!
//! It is deliberately self-contained:
//!
//!   * `mentions` parses `@handle`s out of free text (frontend-faithful).
//!   * `ledger` records every `(item, target, reason)` we've sent so a
//!     re-save of the same task/page never re-notifies anyone.
//!   * `notify` is the one entry point the orchestrator calls. It filters
//!     the target list (no self-DMs, real roster people only, no AI
//!     agents, nothing already in the ledger), composes a `ChatMessage`
//!     from the actor, sends it through the shared rail primitive
//!     (`cmd_team::persist_and_deliver`), and records the send.
//!
//! Everything is best-effort and never panics: a target that fails to
//! send is skipped, a ledger write that fails is logged-by-omission (the
//! worst case is a future duplicate DM, never a crash in the save path).

pub mod ledger;
pub mod mentions;

use crate::cmd_team::{persist_and_deliver, ChatMessage};
use ledger::LedgerKey;

/// AI agent / bot ids that look like roster handles but are never people.
/// We must not DM these even if they appear on the roster or in a
/// mention — they don't have a human reading the rail.
const KNOWN_AGENTS: &[&str] = &[
    "claude",
    "gemini",
    "codex",
    "aura",
    "aura-manager",
    "system",
    "sentinel",
];

/// Build the on-disk DM channel slug for a conversation between `a` and
/// `b`. Mirrors the frontend `dmChannel` (`src/components/team/domain/
/// channels.ts`): handles are lowercased and sorted ascending, then
/// joined with `--` behind a `dm-` prefix, so a channel opened in the web
/// UI and one built here resolve to the same JSONL file. A self-DM
/// (`a == b`) uses the `dm-self-<handle>` scratch-pad convention.
pub fn dm_channel(a: &str, b: &str) -> String {
    let a = a.trim().to_lowercase();
    let b = b.trim().to_lowercase();
    if a == b {
        return format!("dm-self-{a}");
    }
    let (lo, hi) = if a <= b { (a, b) } else { (b, a) };
    format!("dm-{lo}--{hi}")
}

/// Why a person is being notified. Drives the DM wording and the ledger
/// `reason` so the two kinds of event dedup independently (being assigned
/// a task you were also mentioned in produces at most one DM of each).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Reason {
    Assigned,
    Mentioned,
}

impl Reason {
    /// The stable string written to the ledger (and matched against on
    /// the next save). Lowercase, no spaces.
    fn ledger_tag(&self) -> &'static str {
        match self {
            Reason::Assigned => "assigned",
            Reason::Mentioned => "mentioned",
        }
    }
}

/// The board/page item a notification points at. `label` is human copy
/// for the DM body; `deeplink` is an `aura://…` URL that opens the item
/// in the app.
#[derive(Clone, Debug)]
pub struct ItemRef {
    /// "task" | "page".
    pub kind: String,
    /// Task id, or `<scope>/<bucket>/<id>` for a page.
    pub id: String,
    /// e.g. `"AURA-42 · Fix auth flow"` or `"RFC: Auth (page)"`.
    pub label: String,
    /// e.g. `"aura://task/<id>"` or `"aura://page/<scope>/<bucket>/<id>"`.
    pub deeplink: String,
}

/// Is `handle` a real teammate we should DM? It must be on the roster and
/// must not be a known AI agent id. `roster_handles` is the lowercased
/// set of roster handles, prepared once by the caller.
fn is_real_person(handle: &str, roster_handles: &std::collections::HashSet<String>) -> bool {
    if KNOWN_AGENTS.contains(&handle) {
        return false;
    }
    roster_handles.contains(handle)
}

/// Compose the DM body for a given reason + item. First line is the
/// human sentence, second line is the deeplink (so the rail renders a
/// clickable `aura://…` unfurl card). The sentence is kept short enough
/// (label capped) that the unfurl heuristic always fires — a buried URL
/// in a long line renders as plain text instead of a clickable card.
fn body_for(reason: &Reason, item: &ItemRef) -> String {
    let label = cap_label(&item.label, 56);
    match reason {
        Reason::Assigned => format!("Assigned you {}\n{}", label, item.deeplink),
        Reason::Mentioned => format!("Mentioned you in {}\n{}", label, item.deeplink),
    }
}

/// Trim a label to `max` chars (char-safe, ellipsis on overflow) so the
/// DM's first line stays under the unfurl threshold for any title length.
fn cap_label(label: &str, max: usize) -> String {
    let trimmed = label.trim();
    if trimmed.chars().count() <= max {
        return trimmed.to_string();
    }
    let head: String = trimmed.chars().take(max.saturating_sub(1)).collect();
    format!("{}…", head.trim_end())
}

/// Notify each target handle that `actor` assigned / mentioned them on
/// `item`. For each target we skip when:
///
///   * the target is the actor (no self-DMs),
///   * the target is not a real roster person (unknown handle, or an AI
///     agent id), or
///   * the `(item, target, reason)` was already recorded in the ledger.
///
/// Otherwise we build a `ChatMessage` authored by the actor on the
/// actor↔target DM channel and push it through the shared rail primitive,
/// then record the send so a later re-save is a no-op. Returns the number
/// of DMs actually sent.
pub fn notify(
    repo_root: &str,
    actor_handle: &str,
    actor_name: &str,
    targets: &[String],
    item: &ItemRef,
    reason: Reason,
) -> usize {
    let actor = actor_handle.trim().to_lowercase();

    // Roster handles, lowercased, as a fast membership set.
    let roster_handles: std::collections::HashSet<String> =
        crate::integrations::jira_users::load_roster(repo_root)
            .into_iter()
            .map(|m| m.handle.trim().to_lowercase())
            .filter(|h| !h.is_empty())
            .collect();

    let mut sent = 0usize;
    // De-dup targets within this single call too, so a body that mentions
    // the same person twice (or a target also passed explicitly) is one DM.
    let mut handled: std::collections::HashSet<String> = std::collections::HashSet::new();

    for raw in targets {
        let target = raw.trim().to_lowercase();
        if target.is_empty() {
            continue;
        }
        if !handled.insert(target.clone()) {
            continue;
        }
        if target == actor {
            continue; // never DM yourself
        }
        if !is_real_person(&target, &roster_handles) {
            continue; // unknown handle or AI agent
        }

        let key = LedgerKey {
            item_kind: item.kind.clone(),
            item_id: item.id.clone(),
            target: target.clone(),
            reason: reason.ledger_tag().to_string(),
        };
        if ledger::already_sent(repo_root, &key) {
            continue; // re-save → no double-notify
        }

        let msg = ChatMessage {
            id: uuid::Uuid::new_v4().to_string(),
            channel: dm_channel(&actor, &target),
            ts: chrono::Utc::now().timestamp(),
            from_handle: actor.clone(),
            from_name: actor_name.to_string(),
            body: body_for(&reason, item),
            mentions: vec![target.clone()],
            thread_parent: None,
            is_agent: false,
            delivery_status: "pending".to_string(),
            seq: None,
        };

        // Send first; only record once the rail has durably accepted it,
        // so a send failure leaves the ledger untouched and the next
        // save retries. A ledger write failure after a successful send is
        // swallowed (a future duplicate DM is acceptable; a panic here,
        // mid task-save, is not).
        match persist_and_deliver(repo_root, msg) {
            Ok(_) => {
                let _ = ledger::record(repo_root, &key);
                sent += 1;
            }
            Err(_) => {
                // Skip this target; leave the ledger clean for a retry.
            }
        }
    }

    sent
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dm_channel_sorts_and_lowercases() {
        assert_eq!(dm_channel("Bob", "alice"), "dm-alice--bob");
        assert_eq!(dm_channel("alice", "BOB"), "dm-alice--bob");
        assert_eq!(dm_channel("  Carol ", "dave"), "dm-carol--dave");
    }

    #[test]
    fn dm_channel_self() {
        assert_eq!(dm_channel("alice", "alice"), "dm-self-alice");
        assert_eq!(dm_channel("Alice", "alice "), "dm-self-alice");
    }

    #[test]
    fn body_wording() {
        let item = ItemRef {
            kind: "task".into(),
            id: "AURA-42".into(),
            label: "AURA-42 · Fix auth flow".into(),
            deeplink: "aura://task/AURA-42".into(),
        };
        assert_eq!(
            body_for(&Reason::Assigned, &item),
            "Assigned you AURA-42 · Fix auth flow\naura://task/AURA-42"
        );
        assert_eq!(
            body_for(&Reason::Mentioned, &item),
            "Mentioned you in AURA-42 · Fix auth flow\naura://task/AURA-42"
        );
    }

    #[test]
    fn known_agents_are_not_people() {
        let roster: std::collections::HashSet<String> =
            ["claude", "alice"].iter().map(|s| s.to_string()).collect();
        assert!(!is_real_person("claude", &roster));
        assert!(!is_real_person("system", &roster));
        assert!(is_real_person("alice", &roster));
        assert!(!is_real_person("stranger", &roster)); // not on roster
    }
}
