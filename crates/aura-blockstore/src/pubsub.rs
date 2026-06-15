//! Pub/sub surface for store change notifications.
//!
//! The [`BlockStore`](crate::BlockStore) emits [`StoreEvent`]s after every
//! transactional `apply_op`. Subscribers (the W4 UI, test harnesses, future
//! W3b sync-out task) receive events through a [`tokio::sync::broadcast`]
//! channel with server-side filtering via [`SubscribeFilter`].
//!
//! Channel is bounded. Slow subscribers that fall behind by more than the
//! buffer capacity receive [`tokio::sync::broadcast::error::RecvError::Lagged`]
//! and are expected to re-query state and re-subscribe. This is the
//! documented backpressure strategy — failing loud instead of unbounded
//! memory growth.

use aura_blocks::{AnchorRef, BlockId, BlockKind, BlockState};
use std::collections::HashSet;
use tokio::sync::broadcast;

/// Event broadcast after a successful store write.
#[derive(Debug, Clone)]
pub enum StoreEvent {
    /// A new block row was inserted.
    BlockCreated {
        block_id: BlockId,
        kind: BlockKind,
    },
    /// A BlockOp was applied to a block; `new_state` reflects the post-fold
    /// reduced state, or `None` for payloads that don't change state (e.g.
    /// `AttachAttestation`, `SetExtension`).
    OpApplied {
        block_id: BlockId,
        op_id: uuid::Uuid,
        new_state: BlockState,
    },
    /// A sidebar card was upserted after an op apply.
    SidebarCardUpdated { block_id: BlockId },
}

impl StoreEvent {
    pub fn block_id(&self) -> BlockId {
        match self {
            Self::BlockCreated { block_id, .. } => *block_id,
            Self::OpApplied { block_id, .. } => *block_id,
            Self::SidebarCardUpdated { block_id } => *block_id,
        }
    }
}

/// Filter applied client-side on received broadcast events. Kept as a value
/// type (not a closure) so subscribers can be serialized to a remote
/// protocol in a future IPC layer without refactoring.
#[derive(Debug, Clone, Default)]
pub struct SubscribeFilter {
    /// If non-empty, only pass events for these kinds. Empty = pass all.
    pub kinds: HashSet<BlockKind>,
    /// If `Some`, only pass events for blocks anchored to the given anchor.
    pub anchor: Option<AnchorRef>,
    /// If non-empty, only pass events for these specific block ids.
    pub block_ids: HashSet<BlockId>,
}

impl SubscribeFilter {
    pub fn new() -> Self {
        Self::default()
    }

    /// Does this event pass the filter? Called by the receiver side. Because
    /// `BlockKind` and `AnchorRef` aren't carried on every event, filtering
    /// by those requires the caller to look up the block — for now we only
    /// filter on the fields carried by the event itself (block_id and kind
    /// on `BlockCreated`). `anchor` filtering is reserved; callers that need
    /// it layer a follow-up lookup.
    pub fn matches(&self, ev: &StoreEvent) -> bool {
        if !self.block_ids.is_empty() && !self.block_ids.contains(&ev.block_id()) {
            return false;
        }
        if !self.kinds.is_empty() {
            match ev {
                StoreEvent::BlockCreated { kind, .. } => {
                    if !self.kinds.contains(kind) {
                        return false;
                    }
                }
                _ => {
                    // OpApplied / SidebarCardUpdated don't carry kind; pass
                    // through. Callers that want strict kind filtering on
                    // those events must combine with block_ids or perform a
                    // lookup.
                }
            }
        }
        true
    }
}

/// Default channel capacity. Large enough to ride through a short UI render
/// stall without Lagged; small enough that a truly wedged subscriber doesn't
/// hold megabytes of events.
pub const DEFAULT_CHANNEL_CAPACITY: usize = 1024;

/// Construct a new broadcast channel sized for store events.
pub fn channel() -> (broadcast::Sender<StoreEvent>, broadcast::Receiver<StoreEvent>) {
    broadcast::channel(DEFAULT_CHANNEL_CAPACITY)
}

#[cfg(test)]
mod tests {
    use super::*;
    use aura_blocks::{AnchorRef, BlockId, BlockKind, BlockState};
    use uuid::Uuid;

    fn op_applied(block_id: BlockId, state: BlockState) -> StoreEvent {
        StoreEvent::OpApplied {
            block_id,
            op_id: Uuid::now_v7(),
            new_state: state,
        }
    }

    #[test]
    fn empty_filter_matches_all() {
        let f = SubscribeFilter::new();
        let e = op_applied(BlockId::new(), BlockState::Running);
        assert!(f.matches(&e));
    }

    #[test]
    fn block_ids_filter_is_enforced() {
        let target = BlockId::new();
        let other = BlockId::new();
        let mut f = SubscribeFilter::new();
        f.block_ids.insert(target);
        assert!(f.matches(&op_applied(target, BlockState::Running)));
        assert!(!f.matches(&op_applied(other, BlockState::Running)));
    }

    #[test]
    fn kinds_filter_on_block_created() {
        let mut f = SubscribeFilter::new();
        f.kinds.insert(BlockKind::Command);
        let id = BlockId::new();
        assert!(f.matches(&StoreEvent::BlockCreated {
            block_id: id,
            kind: BlockKind::Command
        }));
        assert!(!f.matches(&StoreEvent::BlockCreated {
            block_id: id,
            kind: BlockKind::Message
        }));
    }

    #[tokio::test]
    async fn broadcast_delivers_to_multiple_subscribers() {
        let (tx, _) = channel();
        let mut a = tx.subscribe();
        let mut b = tx.subscribe();
        let id = BlockId::new();
        tx.send(StoreEvent::BlockCreated {
            block_id: id,
            kind: BlockKind::Command,
        })
        .unwrap();
        let ea = a.recv().await.unwrap();
        let eb = b.recv().await.unwrap();
        assert_eq!(ea.block_id(), id);
        assert_eq!(eb.block_id(), id);
        // Silence the unused import warning for AnchorRef under cfg(test)
        // when only used indirectly via SubscribeFilter.
        let _anchor = AnchorRef::None;
    }
}
