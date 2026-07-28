//! Bucket M2 — token-budget tracker + turn-context assembler for the
//! Aura Continuum. Maps the 2026 four-tier agent-memory pattern
//! (Letta/MemGPT, EM-LLM, MemMachine, mem0) onto Aura primitives we
//! already have:
//!
//!   * Working   — `chat[hot_window..]` (last K=24 turns by default).
//!   * Anchored  — `chat[*].anchor.is_some()` — never truncated.
//!   * Episodic  — `aura episodic-recall` (called lazily by the brain).
//!   * Semantic  — `aura ask` + `aura_memory_read` (always-on tool surface).
//!
//! No new vector DB. The existing KG + episodic timeline + intent_log
//! + memory.json do the work.
//!
//! Implementation philosophy: this module is PURE. No I/O, no async, no
//! shell-outs. The brain (cmd_manager / brain.rs) calls
//! `assemble_turn_context` with the ManagerSession state in hand and
//! gets back a TurnContext describing what to inject into the prompt
//! and what older turns to compact. The actual compaction (M3 —
//! shelling out to `aura session-summarize`) and episodic queries (M4
//! — `aura episodic-recall`) live elsewhere; tokens.rs just decides
//! WHEN they should fire.

use super::{AnchorKind, ChatRole, ChatTurn};

/// Hot window — number of trailing turns kept verbatim regardless of
/// budget. Configurable per session in a follow-up; for now the
/// default that worked well in the 2026 Letta/MemGPT papers.
pub const DEFAULT_HOT_WINDOW: usize = 24;

/// Compaction threshold — fraction of the budget that triggers
/// auto-distillation of the OLDER (pre-hot-window) turns. 0.7 leaves
/// headroom for the next response without thrashing.
pub const DEFAULT_COMPACTION_RATIO: f32 = 0.7;

/// Bucket M2 — the one chars-per-token ratio the whole engine estimates
/// against. Matches Anthropic's published average for English prose well
/// enough for budget + accounting decisions; precision-sensitive surfaces
/// (billing, API limit enforcement) should use a real model-specific
/// tokeniser instead. Kept as a single const so the chat budgeter and the
/// orchestrator token ledger never drift apart.
pub const CHARS_PER_TOKEN: f32 = 3.5;

/// Bucket M2 — heuristic token estimate for a raw string. Cheap enough to
/// run on every lane summary / transcript without measuring overhead.
/// Used by the orchestrator token ledger (`dispatcher.rs`) to price what a
/// fan-out produced vs. what the coordinator actually reads.
pub fn estimate_str_tokens(text: &str) -> u32 {
    ((text.len() as f32) / CHARS_PER_TOKEN).ceil() as u32
}

/// Bucket M2 — heuristic token estimator. Kept deliberately cheap so
/// it can run on every chat turn without measuring overhead. Delegates to
/// the same ratio as [`estimate_str_tokens`] so budgeting and accounting
/// stay consistent.
pub fn estimate_chat_tokens(chat: &[ChatTurn]) -> u32 {
    let chars: usize = chat.iter().map(|t| t.text.len()).sum();
    ((chars as f32) / CHARS_PER_TOKEN).ceil() as u32
}

/// Bucket M2 — assembled context the brain feeds into the next API
/// call. `working` is the verbatim hot-window slice; `anchored` is the
/// load-bearing turns from before the window that must stay visible;
/// `episodic_digest` is brain-authored prose summarising distilled
/// older turns; `semantic_callouts` are short bullets pulled from
/// `aura ask` / KG when the latest user turn references known symbols.
///
/// The brain reads these four lists and assembles them into one
/// `<aura-context>` XML block prepended to the prompt — invisible to
/// the user, present to the model.
#[derive(Debug, Clone)]
pub struct TurnContext {
    pub working: Vec<ChatTurn>,
    pub anchored: Vec<ChatTurn>,
    pub episodic_digest: String,
    pub semantic_callouts: Vec<String>,
    /// True when the assembler decided this turn should trigger
    /// distillation. The brain wraps the actual `aura
    /// session-summarize` call (M3) — we just signal need.
    pub should_distill: bool,
}

/// Bucket M2 — slice the session's chat into the four-tier shape.
/// `budget_tokens` is the per-turn cap (claude-sonnet 4.6 = 200k input,
/// claude-opus = 200k, gemini-pro 2.5 = 1M). The caller passes the
/// effective ceiling for whatever brain is bound right now.
///
/// Decision rules:
///   * Working = last `hot_window` turns, regardless of anchor.
///   * Anchored = pre-window turns where `anchor.is_some()`.
///   * Distillation flag fires when total estimated tokens > 0.7 of
///     budget AND there's at least one non-anchored pre-window turn
///     to actually compact.
///
/// Episodic + semantic stay empty — those are populated by the brain
/// from external calls (M4 / `aura episodic-recall`). The struct
/// carries them so a single `<aura-context>` builder can serialise
/// the whole turn context as one piece.
pub fn assemble_turn_context(
    chat: &[ChatTurn],
    hot_window: usize,
    budget_tokens: u32,
) -> TurnContext {
    let total_tokens = estimate_chat_tokens(chat);
    let split_at = chat.len().saturating_sub(hot_window);
    let (older, working_slice) = chat.split_at(split_at);

    let anchored: Vec<ChatTurn> = older
        .iter()
        .filter(|t| t.is_load_bearing())
        .cloned()
        .collect();

    let has_compactable_older = older.iter().any(|t| !t.is_load_bearing());
    let threshold = (budget_tokens as f32 * DEFAULT_COMPACTION_RATIO) as u32;
    let should_distill = total_tokens > threshold && has_compactable_older;

    TurnContext {
        working: working_slice.to_vec(),
        anchored,
        episodic_digest: String::new(),
        semantic_callouts: Vec::new(),
        should_distill,
    }
}

/// Bucket M3 — partition the chat into "to compact" + "to keep".
/// Caller invokes `aura session-summarize` on the to-compact slice,
/// archives it to `<id>.archive.jsonl`, and replaces it with a single
/// `EpisodeDigest`-anchored System turn. Anchored turns stay in place
/// regardless. This helper is pure so it's testable without I/O.
///
/// Returns `(compactable_indices, anchored_indices_in_window,
/// keep_window)` — caller patches `session.chat` in-place by removing
/// the compactable indices and inserting the digest where they used
/// to be (positionally — typically right before the working slice).
pub struct CompactionPlan {
    /// Indices into `chat` of turns to summarise + archive.
    pub compact_indices: Vec<usize>,
    /// Index in `chat` where the digest turn should be inserted.
    /// Equals `chat.len() - hot_window` (the start of the hot window)
    /// post-removal, but caller can compute that from the indices.
    pub digest_insert_at: usize,
    /// True if there's enough non-anchored older content to bother
    /// compacting. False = caller should no-op.
    pub worth_compacting: bool,
}

pub fn compaction_plan(chat: &[ChatTurn], hot_window: usize) -> CompactionPlan {
    let split_at = chat.len().saturating_sub(hot_window);
    let mut compact_indices = Vec::new();
    for (i, turn) in chat[..split_at].iter().enumerate() {
        if !turn.is_load_bearing() {
            compact_indices.push(i);
        }
    }
    // Conservative: don't bother summarising fewer than 8 turns —
    // overhead of the LLM call outweighs the context savings.
    let worth_compacting = compact_indices.len() >= 8;
    CompactionPlan {
        compact_indices,
        digest_insert_at: split_at,
        worth_compacting,
    }
}

/// Bucket M7 — Memory Health snapshot rendered by `aura status
/// --manager <id>`. Pure: caller reads the session and budget, this
/// struct describes what to print.
#[derive(Debug, Clone, serde::Serialize)]
pub struct MemoryHealth {
    /// Total turns in the visible chat (post-compaction).
    pub working_turns: usize,
    /// Anchored turns (never compacted).
    pub anchored_turns: usize,
    /// Estimated tokens in the visible chat.
    pub estimated_tokens: u32,
    /// Brain budget the assembler was sized against.
    pub budget_tokens: u32,
    /// Fraction of budget consumed (0.0–1.0). Above
    /// `DEFAULT_COMPACTION_RATIO` (0.7) means the next turn will
    /// distill.
    pub budget_ratio: f32,
    /// Distillation episodes already created (counted by
    /// EpisodeDigest anchors in the visible chat).
    pub episode_digests: usize,
}

pub fn memory_health(chat: &[ChatTurn], budget_tokens: u32) -> MemoryHealth {
    let working_turns = chat.len();
    let anchored_turns = chat.iter().filter(|t| t.is_load_bearing()).count();
    let estimated_tokens = estimate_chat_tokens(chat);
    let budget_ratio = if budget_tokens == 0 {
        0.0
    } else {
        estimated_tokens as f32 / budget_tokens as f32
    };
    let episode_digests = chat
        .iter()
        .filter(|t| matches!(t.anchor, Some(AnchorKind::EpisodeDigest)))
        .count();
    MemoryHealth {
        working_turns,
        anchored_turns,
        estimated_tokens,
        budget_tokens,
        budget_ratio,
        episode_digests,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn turn(role: ChatRole, text: &str, anchor: Option<AnchorKind>) -> ChatTurn {
        ChatTurn {
            role,
            text: text.to_string(),
            at: 0,
            answered_question: None,
            anchor,
            attachments: Vec::new(),
            brain: None,
            tool_calls: Vec::new(),
            thinking: None,
            saved_tokens: None,
            input_tokens: None,
            output_tokens: None,
        }
    }

    #[test]
    fn estimate_tokens_uses_chars_heuristic() {
        let chat = vec![
            turn(ChatRole::User, "hello world", None), // 11 chars
            turn(ChatRole::Manager, "hi back!", None), // 8 chars
        ];
        // 19 chars / 3.5 = 5.43 → ceil 6
        assert_eq!(estimate_chat_tokens(&chat), 6);
    }

    #[test]
    fn estimate_str_tokens_matches_ratio() {
        assert_eq!(estimate_str_tokens(""), 0);
        // 35 chars / 3.5 = 10 exactly.
        assert_eq!(estimate_str_tokens(&"x".repeat(35)), 10);
        // 36 chars / 3.5 = 10.28 → ceil 11.
        assert_eq!(estimate_str_tokens(&"x".repeat(36)), 11);
    }

    #[test]
    fn assemble_keeps_anchors_outside_hot_window() {
        let mut chat = Vec::new();
        // 30 boring older turns — only some anchored.
        for i in 0..30 {
            let anchor = if i % 10 == 0 {
                Some(AnchorKind::PlanDecision)
            } else {
                None
            };
            chat.push(turn(ChatRole::User, &format!("turn {i}"), anchor));
        }
        // 5 fresh ones in the hot window (window=10 covers them).
        for i in 30..35 {
            chat.push(turn(ChatRole::Manager, &format!("turn {i}"), None));
        }

        let ctx = assemble_turn_context(&chat, 10, 200_000);
        assert_eq!(ctx.working.len(), 10, "hot window respected");
        // Anchored: indices 0, 10, 20 from the older slice (3 hits).
        assert_eq!(ctx.anchored.len(), 3, "anchors preserved");
    }

    #[test]
    fn distillation_fires_when_budget_pressured() {
        // 50 turns of 800-char text each = 40000 chars / 3.5 ≈ 11430 tokens.
        // Budget 10k → ratio 1.14 > 0.7 = should distill.
        let mut chat = Vec::new();
        let big = "x".repeat(800);
        for _ in 0..50 {
            chat.push(turn(ChatRole::User, &big, None));
        }
        let ctx = assemble_turn_context(&chat, 5, 10_000);
        assert!(ctx.should_distill, "should distill above 0.7 budget");
    }

    #[test]
    fn distillation_skips_when_only_anchors_in_older_slice() {
        // Older slice is all anchored — nothing to compact, even if
        // budget is over.
        let mut chat = Vec::new();
        let big = "y".repeat(800);
        for _ in 0..20 {
            chat.push(turn(ChatRole::User, &big, Some(AnchorKind::UserPin)));
        }
        for _ in 0..5 {
            chat.push(turn(ChatRole::Manager, &big, None));
        }
        let ctx = assemble_turn_context(&chat, 5, 10_000);
        assert!(!ctx.should_distill, "no compactable older = no distill");
    }

    #[test]
    fn compaction_plan_skips_anchors() {
        let mut chat = Vec::new();
        for i in 0..15 {
            let anchor = if i == 5 || i == 7 {
                Some(AnchorKind::SemanticAlert)
            } else {
                None
            };
            chat.push(turn(ChatRole::User, &format!("t{i}"), anchor));
        }
        // hot_window=5 → older slice is indices 0..10. Anchors at 5 + 7 stay.
        let plan = compaction_plan(&chat, 5);
        assert_eq!(plan.compact_indices.len(), 8, "13 older turns - 2 anchored - need 8 to be worth it");
        assert_eq!(plan.digest_insert_at, 10);
        assert!(plan.worth_compacting);
    }

    #[test]
    fn compaction_plan_below_threshold_is_not_worth_it() {
        // 6 older + 5 hot = 11 total. Only 6 compactable < 8 minimum.
        let mut chat = Vec::new();
        for i in 0..11 {
            chat.push(turn(ChatRole::User, &format!("t{i}"), None));
        }
        let plan = compaction_plan(&chat, 5);
        assert!(!plan.worth_compacting, "6 turns isn't worth a digest call");
    }

    #[test]
    fn memory_health_reports_consumption() {
        let chat = vec![
            turn(ChatRole::User, &"a".repeat(100), None),
            turn(ChatRole::Manager, &"b".repeat(100), Some(AnchorKind::PlanDecision)),
            turn(
                ChatRole::System,
                &"c".repeat(100),
                Some(AnchorKind::EpisodeDigest),
            ),
        ];
        let h = memory_health(&chat, 1000);
        assert_eq!(h.working_turns, 3);
        assert_eq!(h.anchored_turns, 2);
        assert_eq!(h.episode_digests, 1);
        // 300 chars / 3.5 ceil = 86. 86/1000 = 0.086.
        assert!(h.estimated_tokens >= 85 && h.estimated_tokens <= 87);
        assert!(h.budget_ratio < 0.1);
    }
}
