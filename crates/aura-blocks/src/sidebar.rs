//! Sidebar projection. The work-surface sidebar never reads the full Block;
//! it reads this compact, denormalized card, materialized by a view query or
//! a synced read-model. Keeping this type small is the reason the sidebar
//! can stay responsive with thousands of live blocks.

use serde::{Deserialize, Serialize};
use time::OffsetDateTime;

use crate::{BlockId, BlockKind, BlockState};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SidebarCard {
    pub block_id: BlockId,
    pub kind: BlockKind,
    pub state: BlockState,
    /// "muhammed", "claude-code", "github" — denormalized from provenance.
    pub actor_label: String,
    /// "apply_limiter", "PR #1203" — denormalized from anchor.
    pub anchor_label: Option<String>,
    /// Derived from `Intent.summary` or the kind-specific payload.
    pub summary: String,
    pub priority: SidebarPriority,
    pub unread: bool,
    pub created_at: OffsetDateTime,
    /// For DAG-aware rendering (e.g. collapsed thread counts).
    pub children_count: u32,
}

/// Sidebar ordering bucket. `#[repr(u8)]` locks the numeric discriminant
/// onto the wire format; reordering variants is a major-version bump.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[repr(u8)]
pub enum SidebarPriority {
    /// Unresolved impact on code you own.
    ImpactOnMine = 0,
    /// Message or mention directed at you.
    DirectToMe = 1,
    /// PR review requested from you.
    ReviewRequested = 2,
    /// Team activity you might care about.
    TeamActivity = 3,
    /// Agent-to-agent chatter; collapsed by default.
    AgentChatter = 4,
}
