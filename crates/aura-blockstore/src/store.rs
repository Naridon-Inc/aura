//! `BlockStore` — the writer.
//!
//! Owns the SQLite connection (wrapped in a `Mutex` to match the `host_db.rs`
//! convention used elsewhere in aura-cli), the broadcast channel for change
//! events, and the `RingRegistry` that the output hot path feeds into.
//!
//! Every transactional write routes through [`BlockStore::apply_op`]:
//!
//!   1. Load current block envelope from SQL.
//!   2. Fold the op through [`crate::reducer::fold`].
//!   3. INSERT the op into `block_ops`.
//!   4. UPDATE the `blocks` row with the new reduced envelope.
//!   5. UPSERT the `sidebar_cards` row.
//!   6. Emit `StoreEvent::OpApplied` (+ `SidebarCardUpdated`).
//!
//! All five DB writes happen inside one SQLite transaction. If any step
//! fails, the whole apply rolls back — the event is not emitted because we
//! broadcast only after commit. `AppendOutput` ops also flow through here
//! for single-op correctness tests, but the hot-path producer uses
//! `RingRegistry::get_or_create(block_id).append(op)` instead, which
//! persists via `output_ring::persist_output_ops` on a timer.

use aura_blocks::{AnchorRef, Block, BlockId, BlockKind, BlockOp, BlockOpPayload, BlockState};
use rusqlite::{Connection, OptionalExtension, params};
use std::path::Path;
use std::sync::{Arc, Mutex};
use time::OffsetDateTime;
use tokio::sync::broadcast;

use crate::error::{Result, StoreError};
use crate::output_ring::{RingRegistry, persist_output_ops};
use crate::pubsub::{DEFAULT_CHANNEL_CAPACITY, StoreEvent};
use crate::reducer::fold;
use crate::schema::{check_version, init_db};
use crate::sidebar::{Scoring, ScoringContext, upsert_sidebar_card};

/// Filter for `list_blocks`. All fields are optional; passing none
/// returns the most recently updated blocks up to `limit`.
///
/// Indexed paths (kind, state, parent_id, anchor_kind/anchor_value,
/// updated_at) hit a covered index; the actor filter falls back to a
/// `json_extract` scan on `block_json` because actor lives in the
/// envelope rather than a denormalized column. Callers filtering by
/// actor at scale should additionally restrict by kind or time range
/// to keep the scan bounded.
#[derive(Debug, Clone, Default)]
pub struct BlockFilter {
    pub kind: Option<BlockKind>,
    pub state: Option<BlockState>,
    pub parent_id: Option<BlockId>,
    /// Filter by `provenance.actor` — matches the AgentRef wire form
    /// exactly (e.g. `did:aura:agent/claude-foo`). The DID prefix is
    /// part of the match, so `claude-foo` alone does not hit.
    pub actor: Option<String>,
    /// Anchor kind discriminant — e.g. `function`, `file`, `none`.
    /// Maps to the same wire form `AnchorRef` serialises into.
    pub anchor_kind: Option<String>,
    /// Anchor value — only consulted when `anchor_kind` is also set,
    /// since the (kind, value) pair is the indexed tuple.
    pub anchor_value: Option<String>,
    /// Only return blocks with `updated_at >= since_ms` (epoch ms).
    pub since_ms: Option<i64>,
    /// Only return blocks with `updated_at <= until_ms` (epoch ms).
    pub until_ms: Option<i64>,
    pub limit: Option<u32>,
}

/// The store.
#[derive(Debug)]
pub struct BlockStore {
    conn: Mutex<Connection>,
    tx: broadcast::Sender<StoreEvent>,
    rings: Arc<RingRegistry>,
    scoring: Scoring,
    scoring_ctx: Mutex<ScoringContext>,
}

impl BlockStore {
    /// Open a store at `path`. Creates the file and schema if absent.
    /// `:memory:` is a valid path (useful for tests).
    pub fn open(path: &Path) -> Result<Self> {
        let conn = if path.as_os_str() == ":memory:" {
            Connection::open_in_memory()?
        } else {
            if let Some(parent) = path.parent() {
                if !parent.as_os_str().is_empty() {
                    std::fs::create_dir_all(parent)?;
                }
            }
            Connection::open(path)?
        };
        init_db(&conn)?;
        check_version(&conn)?;
        let (tx, _rx) = broadcast::channel(DEFAULT_CHANNEL_CAPACITY);
        Ok(Self {
            conn: Mutex::new(conn),
            tx,
            rings: Arc::new(RingRegistry::new()),
            scoring: Scoring::default(),
            scoring_ctx: Mutex::new(ScoringContext::empty_now()),
        })
    }

    /// Subscribe to store change events. See [`SubscribeFilter`](crate::SubscribeFilter)
    /// for filtering.
    pub fn subscribe(&self) -> broadcast::Receiver<StoreEvent> {
        self.tx.subscribe()
    }

    /// Access the ring registry (for hot-path output producers + the flusher).
    pub fn rings(&self) -> Arc<RingRegistry> {
        self.rings.clone()
    }

    /// Replace the scoring context used when upserting sidebar cards.
    pub fn set_scoring_context(&self, ctx: ScoringContext) {
        *self.scoring_ctx.lock().expect("scoring ctx") = ctx;
    }

    fn current_ctx(&self) -> ScoringContext {
        let mut c = self.scoring_ctx.lock().expect("scoring ctx").clone();
        c.now = OffsetDateTime::now_utc();
        c
    }

    /// Insert a new block envelope. Typically called when a Proposal or
    /// Command is first created; subsequent mutations go through `apply_op`.
    pub fn insert_block(&self, block: &Block) -> Result<()> {
        let conn = self.conn.lock().expect("conn");
        insert_block_row(&conn, block)?;
        let ctx = self.current_ctx();
        upsert_sidebar_card(&conn, block, self.scoring, &ctx)?;
        drop(conn);
        let _ = self.tx.send(StoreEvent::BlockCreated {
            block_id: block.id,
            kind: block.kind.clone(),
        });
        let _ = self.tx.send(StoreEvent::SidebarCardUpdated {
            block_id: block.id,
        });
        Ok(())
    }

    /// Apply a single op. Transactional; rolls back on error.
    /// Returns the post-fold reduced block.
    pub fn apply_op(&self, op: &BlockOp) -> Result<Block> {
        let conn = self.conn.lock().expect("conn");
        let tx = conn.unchecked_transaction()?;

        let block = load_block_row(&tx, op.block_id)?
            .ok_or_else(|| StoreError::NotFound(format!("{:?}", op.block_id)))?;
        let reduced = fold(block, op)?;

        insert_op_row(&tx, op)?;
        update_block_row(&tx, &reduced)?;
        let ctx = self.current_ctx();
        upsert_sidebar_card(&tx, &reduced, self.scoring, &ctx)?;

        tx.commit()?;
        drop(conn);

        let _ = self.tx.send(StoreEvent::OpApplied {
            block_id: reduced.id,
            op_id: op.op_id,
            new_state: reduced.state,
        });
        let _ = self.tx.send(StoreEvent::SidebarCardUpdated {
            block_id: reduced.id,
        });
        Ok(reduced)
    }

    /// Persist any unflushed output ops from every registered ring.
    /// Called periodically by the flusher task (and in tests).
    pub fn flush_output_rings(&self) -> Result<usize> {
        let drained = self.rings.drain_all_unflushed();
        let n = drained.len();
        if n == 0 {
            return Ok(0);
        }
        let conn = self.conn.lock().expect("conn");
        persist_output_ops(&conn, &drained)?;
        Ok(n)
    }

    pub fn get_block(&self, id: BlockId) -> Result<Option<Block>> {
        let conn = self.conn.lock().expect("conn");
        load_block_row(&conn, id)
    }

    pub fn list_blocks(&self, filter: &BlockFilter) -> Result<Vec<Block>> {
        let conn = self.conn.lock().expect("conn");
        // IS NULL sentinel pattern — every filter is optional and binds
        // at fixed placeholders so the prepared-statement cache stays
        // hot across heterogeneous calls. Indexed columns (kind, state,
        // parent_id, anchor_*, updated_at) match a covered index; the
        // actor predicate falls back to json_extract since actor isn't
        // a denormalized column. The `?N IS NULL OR predicate` pattern
        // collapses to a no-op when the filter is unset.
        let limit = filter.limit.unwrap_or(1024) as i64;
        let mut stmt = conn.prepare_cached(
            "SELECT block_json FROM blocks \
             WHERE (?1 IS NULL OR kind = ?1) \
               AND (?2 IS NULL OR state = ?2) \
               AND (?3 IS NULL OR parent_id = ?3) \
               AND (?4 IS NULL OR anchor_kind = ?4) \
               AND (?5 IS NULL OR anchor_value = ?5) \
               AND (?6 IS NULL OR updated_at >= ?6) \
               AND (?7 IS NULL OR updated_at <= ?7) \
               AND (?8 IS NULL OR json_extract(block_json, '$.provenance.actor') = ?8) \
             ORDER BY updated_at DESC \
             LIMIT ?9",
        )?;
        let kind_arg: Option<String> = filter.kind.as_ref().map(|k| k.wire().to_string());
        let state_arg: Option<String> = filter.state.map(|s| state_to_wire(s).to_string());
        let parent_arg: Option<Vec<u8>> = filter.parent_id.map(|p| p.0.as_bytes().to_vec());
        let anchor_kind_arg: Option<&str> = filter.anchor_kind.as_deref();
        let anchor_value_arg: Option<&str> = filter.anchor_value.as_deref();
        // Stored `updated_at` column is in microseconds (see insert_block_row),
        // so promote ms → µs before comparison to keep the public API in ms.
        let since_arg: Option<i64> = filter.since_ms.map(|ms| ms.saturating_mul(1_000));
        let until_arg: Option<i64> = filter.until_ms.map(|ms| ms.saturating_mul(1_000));
        let actor_arg: Option<&str> = filter.actor.as_deref();

        let rows: Vec<String> = stmt
            .query_map(
                params![
                    kind_arg,
                    state_arg,
                    parent_arg,
                    anchor_kind_arg,
                    anchor_value_arg,
                    since_arg,
                    until_arg,
                    actor_arg,
                    limit,
                ],
                |r| r.get::<_, String>(0),
            )?
            .collect::<std::result::Result<Vec<_>, _>>()?;

        let mut blocks = Vec::with_capacity(rows.len());
        for json in rows {
            blocks.push(serde_json::from_str::<Block>(&json)?);
        }
        Ok(blocks)
    }

    /// Rebuild a block by replaying every op in `block_ops`. Used as a
    /// correctness check and as a disaster-recovery tool.
    ///
    /// Returns the block with its ops applied in canonical (ts, lamport,
    /// actor) order. The envelope used as the seed is the CURRENTLY-stored
    /// `block_json` minus state mutations — we strip the reduced header
    /// back to its `created_at` identity and replay from there. If no block
    /// row exists, returns `StoreError::NotFound`.
    pub fn rebuild_block_from_ops(&self, id: BlockId) -> Result<Block> {
        let conn = self.conn.lock().expect("conn");
        let mut stored = load_block_row(&conn, id)?
            .ok_or_else(|| StoreError::NotFound(format!("{:?}", id)))?;
        stored.state = BlockState::Proposed;
        stored.policy = None;
        stored.attestations.items.clear();
        stored.extensions.clear();
        stored.actual_impacts = None;
        stored.updated_at = stored.created_at;

        let ops = load_ops_for_block(&conn, id)?;
        crate::reducer::replay(stored, &ops)
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// SQL helpers. Kept free-standing so both `BlockStore` and the in-transaction
// apply_op can call them with the same API surface.
// ─────────────────────────────────────────────────────────────────────────────

fn insert_block_row(conn: &Connection, block: &Block) -> Result<()> {
    let json = serde_json::to_string(block)?;
    let (anchor_kind, anchor_value) = anchor_cols(&block.anchor);
    conn.execute(
        r#"
        INSERT INTO blocks (
            id, kind, state, parent_id, prior_sibling_id, supersedes_id,
            anchor_kind, anchor_value, created_at, updated_at, block_json
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
        "#,
        params![
            block.id.0.as_bytes().as_slice(),
            block.kind.wire(),
            state_to_wire(block.state),
            block.parent_id.map(|id| id.0.as_bytes().to_vec()),
            block.prior_sibling_id.map(|id| id.0.as_bytes().to_vec()),
            block.supersedes_id.map(|id| id.0.as_bytes().to_vec()),
            anchor_kind,
            anchor_value,
            (block.created_at.unix_timestamp_nanos() / 1_000) as i64,
            (block.updated_at.unix_timestamp_nanos() / 1_000) as i64,
            json,
        ],
    )?;
    Ok(())
}

fn update_block_row(conn: &Connection, block: &Block) -> Result<()> {
    let json = serde_json::to_string(block)?;
    conn.execute(
        r#"
        UPDATE blocks
        SET kind = ?2,
            state = ?3,
            updated_at = ?4,
            block_json = ?5
        WHERE id = ?1
        "#,
        params![
            block.id.0.as_bytes().as_slice(),
            block.kind.wire(),
            state_to_wire(block.state),
            (block.updated_at.unix_timestamp_nanos() / 1_000) as i64,
            json,
        ],
    )?;
    Ok(())
}

fn load_block_row(conn: &Connection, id: BlockId) -> Result<Option<Block>> {
    let row: Option<String> = conn
        .query_row(
            "SELECT block_json FROM blocks WHERE id = ?1",
            params![id.0.as_bytes().as_slice()],
            |r| r.get(0),
        )
        .optional()?;
    match row {
        Some(j) => Ok(Some(serde_json::from_str::<Block>(&j)?)),
        None => Ok(None),
    }
}

fn insert_op_row(conn: &Connection, op: &BlockOp) -> Result<()> {
    let payload_kind = match &op.payload {
        BlockOpPayload::AppendOutput { .. } => "append_output",
        BlockOpPayload::RecordMetric { .. } => "record_metric",
        BlockOpPayload::Transition { .. } => "transition",
        BlockOpPayload::AttachPolicy { .. } => "attach_policy",
        BlockOpPayload::AttachAttestation { .. } => "attach_attestation",
        BlockOpPayload::Tag { .. } => "tag",
        BlockOpPayload::SetExtension { .. } => "set_extension",
        BlockOpPayload::Snapshot { .. } => "snapshot",
    };
    let payload_json = serde_json::to_string(&op.payload)?;
    conn.execute(
        r#"
        INSERT INTO block_ops (
            op_id, block_id, actor, ts, lamport, payload_kind, payload_json
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
        "#,
        params![
            op.op_id.as_bytes().as_slice(),
            op.block_id.0.as_bytes().as_slice(),
            op.actor.0,
            (op.timestamp.unix_timestamp_nanos() / 1_000) as i64,
            op.lamport as i64,
            payload_kind,
            payload_json,
        ],
    )?;
    Ok(())
}

fn load_ops_for_block(conn: &Connection, block_id: BlockId) -> Result<Vec<BlockOp>> {
    let mut stmt = conn.prepare(
        "SELECT op_id, actor, ts, lamport, payload_json \
         FROM block_ops WHERE block_id = ?1 \
         ORDER BY ts ASC, lamport ASC, actor ASC",
    )?;
    let rows: Vec<OpRow> = stmt
        .query_map(params![block_id.0.as_bytes().as_slice()], |r| {
            Ok(OpRow {
                op_id_bytes: r.get::<_, Vec<u8>>(0)?,
                actor: r.get::<_, String>(1)?,
                ts_us: r.get::<_, i64>(2)?,
                lamport: r.get::<_, i64>(3)?,
                payload_json: r.get::<_, String>(4)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;

    let mut ops = Vec::with_capacity(rows.len());
    for row in rows {
        let op_id = uuid::Uuid::from_slice(&row.op_id_bytes).map_err(|e| StoreError::IllegalOp {
            block_id: format!("{:?}", block_id),
            reason: format!("op_id not a uuid: {e}"),
        })?;
        let payload: BlockOpPayload = serde_json::from_str(&row.payload_json)?;
        let timestamp =
            OffsetDateTime::from_unix_timestamp_nanos((row.ts_us as i128) * 1_000)?;
        ops.push(BlockOp {
            op_id,
            block_id,
            actor: aura_blocks::AgentRef(row.actor),
            timestamp,
            lamport: row.lamport as u64,
            payload,
        });
    }
    Ok(ops)
}

struct OpRow {
    op_id_bytes: Vec<u8>,
    actor: String,
    ts_us: i64,
    lamport: i64,
    payload_json: String,
}

fn anchor_cols(anchor: &AnchorRef) -> (String, Option<String>) {
    match anchor {
        AnchorRef::Function(id) => ("function".into(), Some(id.clone())),
        AnchorRef::File(p) => ("file".into(), Some(p.clone())),
        AnchorRef::Pr(pr) => (
            "pr".into(),
            Some(format!("{}/{}#{}", pr.provider, pr.path, pr.number)),
        ),
        AnchorRef::Zone(z) => ("zone".into(), Some(z.clone())),
        AnchorRef::Build(b) => ("build".into(), Some(b.clone())),
        AnchorRef::Block(id) => ("block".into(), Some(format!("{:?}", id.0))),
        AnchorRef::None => ("none".into(), None),
    }
}

/// Map a `BlockState` to its on-wire / SQL-column string representation.
/// This mirrors the `#[serde(rename_all = "snake_case")]` rule on `BlockState`
/// but is written explicitly so a serde flip can't silently change the
/// schema without a migration.
fn state_to_wire(s: BlockState) -> &'static str {
    match s {
        BlockState::Proposed => "proposed",
        BlockState::Gated => "gated",
        BlockState::Denied => "denied",
        BlockState::Running => "running",
        BlockState::Suspended => "suspended",
        BlockState::Resumed => "resumed",
        BlockState::Completed => "completed",
        BlockState::Failed => "failed",
        BlockState::RolledBack => "rolled_back",
        BlockState::Superseded => "superseded",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use aura_blocks::{
        AgentRef, AnchorRef, Attestations, Block, BlockId, BlockKind, BlockPayload, BlockState,
        CapabilityGrade, DeclaredImpacts, Intent, PolicyDecision, Provenance, SCHEMA_VERSION,
    };
    use base64::Engine;
    use std::collections::BTreeMap;

    fn mk_block() -> Block {
        Block {
            id: BlockId::new(),
            schema_version: SCHEMA_VERSION,
            kind: BlockKind::Command,
            parent_id: None,
            prior_sibling_id: None,
            supersedes_id: None,
            anchor: AnchorRef::Function("apply_limiter".into()),
            intent: Intent {
                summary: "apply limiter test".into(),
                detail: None,
                parent_intent: None,
            },
            declared_impacts: DeclaredImpacts::default(),
            actual_impacts: None,
            payload: BlockPayload::Command {
                command: "kubectl apply -f staging/".into(),
                shell: Some("zsh".into()),
                cwd: "/work".into(),
            },
            state: BlockState::Proposed,
            policy: None,
            provenance: Provenance {
                actor: AgentRef("did:aura:user/you".into()),
                on_behalf_of: None,
                origin_host: "laptop".into(),
                signature: None,
            },
            attestations: Attestations::default(),
            created_at: OffsetDateTime::now_utc(),
            updated_at: OffsetDateTime::now_utc(),
            extensions: BTreeMap::new(),
        }
    }

    fn mk_op(block_id: BlockId, lamport: u64, payload: BlockOpPayload) -> BlockOp {
        BlockOp {
            op_id: uuid::Uuid::now_v7(),
            block_id,
            actor: AgentRef("did:aura:supervisor".into()),
            timestamp: OffsetDateTime::now_utc(),
            lamport,
            payload,
        }
    }

    #[test]
    fn insert_and_get_roundtrip() {
        let store = BlockStore::open(Path::new(":memory:")).unwrap();
        let b = mk_block();
        let id = b.id;
        store.insert_block(&b).unwrap();
        let back = store.get_block(id).unwrap().unwrap();
        assert_eq!(back.id, id);
        assert_eq!(back.state, BlockState::Proposed);
        assert_eq!(back.intent.summary, "apply limiter test");
    }

    #[test]
    fn apply_op_transitions_and_persists() {
        let store = BlockStore::open(Path::new(":memory:")).unwrap();
        let b = mk_block();
        let id = b.id;
        store.insert_block(&b).unwrap();

        let op = mk_op(
            id,
            1,
            BlockOpPayload::Transition {
                to: BlockState::Gated,
                reason: None,
            },
        );
        let reduced = store.apply_op(&op).unwrap();
        assert_eq!(reduced.state, BlockState::Gated);

        let persisted = store.get_block(id).unwrap().unwrap();
        assert_eq!(persisted.state, BlockState::Gated);
    }

    #[test]
    fn list_filter_by_kind_and_state() {
        let store = BlockStore::open(Path::new(":memory:")).unwrap();
        let mut b1 = mk_block();
        let mut b2 = mk_block();
        b2.kind = BlockKind::Message;
        b2.payload = BlockPayload::Message {
            body: "hi".into(),
            mentions: vec![],
        };
        b1.id = BlockId::new();
        b2.id = BlockId::new();
        store.insert_block(&b1).unwrap();
        store.insert_block(&b2).unwrap();

        let msgs = store
            .list_blocks(&BlockFilter {
                kind: Some(BlockKind::Message),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].kind, BlockKind::Message);
    }

    #[test]
    fn list_filter_by_actor_matches_exact_did() {
        let store = BlockStore::open(Path::new(":memory:")).unwrap();
        let mut b1 = mk_block(); // actor = did:aura:user/you
        let mut b2 = mk_block();
        b2.id = BlockId::new();
        b2.provenance.actor = AgentRef("did:aura:agent/claude".into());
        b1.id = BlockId::new();
        store.insert_block(&b1).unwrap();
        store.insert_block(&b2).unwrap();

        let claude_only = store
            .list_blocks(&BlockFilter {
                actor: Some("did:aura:agent/claude".into()),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(claude_only.len(), 1);
        assert_eq!(claude_only[0].provenance.actor.0, "did:aura:agent/claude");

        // Substring of the DID must NOT match — actor filter is exact.
        let nope = store
            .list_blocks(&BlockFilter {
                actor: Some("claude".into()),
                ..Default::default()
            })
            .unwrap();
        assert!(nope.is_empty());
    }

    #[test]
    fn list_filter_by_anchor_kind_and_value() {
        let store = BlockStore::open(Path::new(":memory:")).unwrap();
        let mut b1 = mk_block(); // anchor = Function("apply_limiter")
        let mut b2 = mk_block();
        b2.id = BlockId::new();
        b2.anchor = AnchorRef::Function("parse_token".into());
        let mut b3 = mk_block();
        b3.id = BlockId::new();
        b3.anchor = AnchorRef::File("src/lib.rs".into());
        b1.id = BlockId::new();
        store.insert_block(&b1).unwrap();
        store.insert_block(&b2).unwrap();
        store.insert_block(&b3).unwrap();

        // anchor_kind alone narrows to all function-anchored blocks.
        let fns = store
            .list_blocks(&BlockFilter {
                anchor_kind: Some("function".into()),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(fns.len(), 2);

        // anchor_kind + value pinpoints exactly one.
        let one = store
            .list_blocks(&BlockFilter {
                anchor_kind: Some("function".into()),
                anchor_value: Some("apply_limiter".into()),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(one.len(), 1);
        assert!(matches!(&one[0].anchor, AnchorRef::Function(s) if s == "apply_limiter"));

        // file kind isolates the third row.
        let files = store
            .list_blocks(&BlockFilter {
                anchor_kind: Some("file".into()),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(files.len(), 1);
    }

    #[test]
    fn list_filter_by_time_range() {
        let store = BlockStore::open(Path::new(":memory:")).unwrap();
        // Three blocks with explicit updated_at: 1000ms, 2000ms, 3000ms.
        let make_at = |ms: i64| {
            let mut b = mk_block();
            b.id = BlockId::new();
            let t = OffsetDateTime::from_unix_timestamp_nanos((ms as i128) * 1_000_000).unwrap();
            b.created_at = t;
            b.updated_at = t;
            b
        };
        store.insert_block(&make_at(1000)).unwrap();
        store.insert_block(&make_at(2000)).unwrap();
        store.insert_block(&make_at(3000)).unwrap();

        // since=1500 → drops the 1000ms row.
        let since = store
            .list_blocks(&BlockFilter {
                since_ms: Some(1500),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(since.len(), 2);

        // until=2500 → drops the 3000ms row.
        let until = store
            .list_blocks(&BlockFilter {
                until_ms: Some(2500),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(until.len(), 2);

        // since + until window picks only the middle row.
        let window = store
            .list_blocks(&BlockFilter {
                since_ms: Some(1500),
                until_ms: Some(2500),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(window.len(), 1);
    }

    #[test]
    fn list_filter_combined_kind_actor_anchor() {
        let store = BlockStore::open(Path::new(":memory:")).unwrap();
        // The needle: Command kind + claude actor + parse_token anchor.
        let mut needle = mk_block();
        needle.id = BlockId::new();
        needle.provenance.actor = AgentRef("did:aura:agent/claude".into());
        needle.anchor = AnchorRef::Function("parse_token".into());
        store.insert_block(&needle).unwrap();
        // Distractors that miss on each axis.
        let mut wrong_kind = mk_block();
        wrong_kind.id = BlockId::new();
        wrong_kind.kind = BlockKind::Message;
        wrong_kind.payload = BlockPayload::Message { body: "x".into(), mentions: vec![] };
        wrong_kind.provenance.actor = AgentRef("did:aura:agent/claude".into());
        wrong_kind.anchor = AnchorRef::Function("parse_token".into());
        store.insert_block(&wrong_kind).unwrap();

        let mut wrong_actor = mk_block();
        wrong_actor.id = BlockId::new();
        wrong_actor.anchor = AnchorRef::Function("parse_token".into());
        store.insert_block(&wrong_actor).unwrap();

        let mut wrong_anchor = mk_block();
        wrong_anchor.id = BlockId::new();
        wrong_anchor.provenance.actor = AgentRef("did:aura:agent/claude".into());
        store.insert_block(&wrong_anchor).unwrap();

        let hits = store
            .list_blocks(&BlockFilter {
                kind: Some(BlockKind::Command),
                actor: Some("did:aura:agent/claude".into()),
                anchor_kind: Some("function".into()),
                anchor_value: Some("parse_token".into()),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(hits.len(), 1, "all three filters must AND together");
        assert_eq!(hits[0].id, needle.id);
    }

    #[test]
    fn rebuild_matches_reduced() {
        let store = BlockStore::open(Path::new(":memory:")).unwrap();
        let b = mk_block();
        let id = b.id;
        store.insert_block(&b).unwrap();

        let decision = PolicyDecision {
            verdict: CapabilityGrade::Auto,
            rules_fired: vec!["r1".into()],
            reason: "auto".into(),
            decided_by: AgentRef("did:aura:policy".into()),
            decided_at: OffsetDateTime::now_utc(),
            gate_reviewer: None,
        };
        store
            .apply_op(&mk_op(
                id,
                1,
                BlockOpPayload::AttachPolicy { decision },
            ))
            .unwrap();
        store
            .apply_op(&mk_op(
                id,
                2,
                BlockOpPayload::Transition {
                    to: BlockState::Running,
                    reason: None,
                },
            ))
            .unwrap();
        store
            .apply_op(&mk_op(
                id,
                3,
                BlockOpPayload::Transition {
                    to: BlockState::Completed,
                    reason: None,
                },
            ))
            .unwrap();

        let rebuilt = store.rebuild_block_from_ops(id).unwrap();
        let reduced = store.get_block(id).unwrap().unwrap();
        assert_eq!(rebuilt.state, reduced.state);
        assert!(rebuilt.policy.is_some());
        assert_eq!(rebuilt.policy.as_ref().unwrap().verdict, CapabilityGrade::Auto);
    }

    #[tokio::test]
    async fn subscribe_receives_events_in_order() {
        let store = BlockStore::open(Path::new(":memory:")).unwrap();
        let mut rx = store.subscribe();
        let b = mk_block();
        let id = b.id;
        store.insert_block(&b).unwrap();
        store
            .apply_op(&mk_op(
                id,
                1,
                BlockOpPayload::Transition {
                    to: BlockState::Gated,
                    reason: None,
                },
            ))
            .unwrap();

        // Insert → 2 events (BlockCreated, SidebarCardUpdated).
        // Apply → 2 events (OpApplied, SidebarCardUpdated).
        let mut saw_block_created = false;
        let mut saw_op_applied = false;
        for _ in 0..4 {
            match rx.recv().await {
                Ok(StoreEvent::BlockCreated { block_id, .. }) if block_id == id => {
                    saw_block_created = true;
                }
                Ok(StoreEvent::OpApplied { block_id, new_state, .. }) if block_id == id => {
                    saw_op_applied = true;
                    assert_eq!(new_state, BlockState::Gated);
                }
                Ok(StoreEvent::SidebarCardUpdated { .. }) => {}
                Err(e) => panic!("recv: {e}"),
                Ok(other) => panic!("unexpected: {other:?}"),
            }
        }
        assert!(saw_block_created);
        assert!(saw_op_applied);
    }

    #[test]
    fn flush_output_rings_persists_queued_appends() {
        let store = BlockStore::open(Path::new(":memory:")).unwrap();
        let b = mk_block();
        let id = b.id;
        store.insert_block(&b).unwrap();

        let ring = store.rings().get_or_create(id, 4096);
        for i in 1..=50 {
            let bytes = format!("line-{i}\n").into_bytes();
            let bytes_b64 = base64::engine::general_purpose::STANDARD
                .encode(&bytes);
            ring.append(BlockOp {
                op_id: uuid::Uuid::now_v7(),
                block_id: id,
                actor: AgentRef("did:aura:user".into()),
                timestamp: OffsetDateTime::now_utc(),
                lamport: i,
                payload: BlockOpPayload::AppendOutput {
                    stream: "stdout".into(),
                    bytes_b64,
                    redactions: vec![],
                },
            })
            .unwrap();
        }
        let n = store.flush_output_rings().unwrap();
        assert_eq!(n, 50);

        let conn = store.conn.lock().unwrap();
        let rows: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM block_ops WHERE block_id = ?1 AND payload_kind = 'append_output'",
                params![id.0.as_bytes().as_slice()],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(rows, 50);
    }
}
