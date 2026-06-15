//! In-memory output ring + async SQLite flusher.
//!
//! Why this exists: a live PTY emits ~10k `AppendOutput` ops in 30 seconds
//! at full bore. Routing each one through `BlockStore::apply_op` (rusqlite
//! behind a Mutex, plus the reducer) bottlenecks the renderer. AppendOutput
//! doesn't change the reduced envelope anyway — it's addressed by
//! `(block_id, lamport)` and belongs in a side-channel.
//!
//! The shape:
//!
//! ```text
//!  producer ──▶ OutputRing::append() ──▶ in-mem VecDeque (UI reads here)
//!                                    └─▶ unflushed queue
//!                                              │
//!                           (every ~100ms)    ▼
//!                                    flusher task ──▶ INSERT INTO block_ops
//! ```
//!
//! Correctness notes:
//!   * The ring is bounded by bytes; head-evicted chunks are still in the
//!     unflushed queue (they still end up in SQLite). UI that started
//!     watching after eviction reads from SQLite via `ops_since`.
//!   * The unflushed queue is NOT bounded — it is bounded indirectly by
//!     the flusher running every 100ms. If the flusher is wedged, this is
//!     a real bug and we want the memory growth to surface loudly; don't
//!     silently drop persistence.
//!   * `high_watermark` is the largest lamport the ring has seen for its
//!     block, so the UI can request `read_since(wm)` after a reconnect.

use aura_blocks::{BlockId, BlockOp, BlockOpPayload};
use base64::Engine;
use rusqlite::{Connection, params};
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

use crate::error::Result;

/// One chunk of output, suitable for direct UI rendering.
#[derive(Debug, Clone)]
pub struct OutputChunk {
    pub block_id: BlockId,
    pub lamport: u64,
    pub stream: String,
    pub bytes: Vec<u8>,
}

/// Default per-block ring cap (bytes).
pub const DEFAULT_CAP_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug)]
struct Inner {
    block_id: BlockId,
    cap_bytes: usize,
    bytes_in_buf: usize,
    buf: VecDeque<OutputChunk>,
    unflushed: Vec<BlockOp>,
    high_watermark: u64,
}

/// Bounded ring buffer of AppendOutput chunks for a single block.
#[derive(Debug)]
pub struct OutputRing {
    inner: Mutex<Inner>,
}

impl OutputRing {
    pub fn new(block_id: BlockId, cap_bytes: usize) -> Self {
        Self {
            inner: Mutex::new(Inner {
                block_id,
                cap_bytes,
                bytes_in_buf: 0,
                buf: VecDeque::new(),
                unflushed: Vec::new(),
                high_watermark: 0,
            }),
        }
    }

    pub fn block_id(&self) -> BlockId {
        self.inner.lock().expect("ring mutex").block_id
    }

    /// Append an AppendOutput op. Returns `Err(StoreError::IllegalOp)` for
    /// ops that aren't `AppendOutput` — the ring is a hot-path-only tier.
    pub fn append(&self, op: BlockOp) -> Result<()> {
        let (stream, bytes) = match &op.payload {
            BlockOpPayload::AppendOutput {
                stream, bytes_b64, ..
            } => {
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(bytes_b64.as_bytes())?;
                (stream.clone(), bytes)
            }
            _ => {
                return Err(crate::error::StoreError::IllegalOp {
                    block_id: format!("{:?}", op.block_id),
                    reason: "OutputRing only accepts AppendOutput ops".into(),
                });
            }
        };

        if op.block_id != self.block_id() {
            return Err(crate::error::StoreError::IllegalOp {
                block_id: format!("{:?}", op.block_id),
                reason: "op targets a different block than the ring".into(),
            });
        }

        let chunk = OutputChunk {
            block_id: op.block_id,
            lamport: op.lamport,
            stream,
            bytes: bytes.clone(),
        };

        let mut inner = self.inner.lock().expect("ring mutex");
        inner.bytes_in_buf += chunk.bytes.len();
        inner.buf.push_back(chunk);
        while inner.bytes_in_buf > inner.cap_bytes && inner.buf.len() > 1 {
            if let Some(head) = inner.buf.pop_front() {
                inner.bytes_in_buf -= head.bytes.len();
            }
        }
        if op.lamport > inner.high_watermark {
            inner.high_watermark = op.lamport;
        }
        inner.unflushed.push(op);
        Ok(())
    }

    /// Return all chunks with `lamport >= since` in ring order. Used by a
    /// UI that reconnects or scrolls back within the in-memory window.
    pub fn read_since(&self, since: u64) -> Vec<OutputChunk> {
        let inner = self.inner.lock().expect("ring mutex");
        inner
            .buf
            .iter()
            .filter(|c| c.lamport >= since)
            .cloned()
            .collect()
    }

    /// Current high watermark — largest lamport observed for this block.
    pub fn high_watermark(&self) -> u64 {
        self.inner.lock().expect("ring mutex").high_watermark
    }

    /// Drain all pending (un-persisted) ops. Called by the flusher.
    pub fn drain_unflushed(&self) -> Vec<BlockOp> {
        let mut inner = self.inner.lock().expect("ring mutex");
        std::mem::take(&mut inner.unflushed)
    }

    /// Current in-memory byte count (for observability / tests).
    pub fn bytes_in_buf(&self) -> usize {
        self.inner.lock().expect("ring mutex").bytes_in_buf
    }
}

/// A registry of per-block rings. The store holds one of these and
/// supervises the flusher loop.
#[derive(Debug, Default)]
pub struct RingRegistry {
    rings: Mutex<HashMap<BlockId, Arc<OutputRing>>>,
}

impl RingRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn get_or_create(&self, block_id: BlockId, cap_bytes: usize) -> Arc<OutputRing> {
        let mut rings = self.rings.lock().expect("registry mutex");
        rings
            .entry(block_id)
            .or_insert_with(|| Arc::new(OutputRing::new(block_id, cap_bytes)))
            .clone()
    }

    pub fn get(&self, block_id: BlockId) -> Option<Arc<OutputRing>> {
        self.rings.lock().expect("registry mutex").get(&block_id).cloned()
    }

    pub fn remove(&self, block_id: BlockId) -> Option<Arc<OutputRing>> {
        self.rings.lock().expect("registry mutex").remove(&block_id)
    }

    /// Drain unflushed ops from every ring and return them as one batch.
    pub fn drain_all_unflushed(&self) -> Vec<BlockOp> {
        let rings: Vec<Arc<OutputRing>> = self
            .rings
            .lock()
            .expect("registry mutex")
            .values()
            .cloned()
            .collect();
        let mut all = Vec::new();
        for r in rings {
            all.extend(r.drain_unflushed());
        }
        all
    }
}

/// Persist a batch of AppendOutput ops directly into `block_ops`, skipping
/// the reducer. Used by the flusher.
pub fn persist_output_ops(conn: &Connection, ops: &[BlockOp]) -> Result<()> {
    if ops.is_empty() {
        return Ok(());
    }
    let tx = conn.unchecked_transaction()?;
    {
        let mut stmt = tx.prepare_cached(
            "INSERT OR IGNORE INTO block_ops \
             (op_id, block_id, actor, ts, lamport, payload_kind, payload_json, partition_key) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'default')",
        )?;
        for op in ops {
            let payload_kind = match &op.payload {
                BlockOpPayload::AppendOutput { .. } => "append_output",
                // Other variants shouldn't reach here — callers route them
                // through apply_op. Persist anyway so no op is ever silently
                // dropped; payload_kind remains truthful.
                BlockOpPayload::RecordMetric { .. } => "record_metric",
                BlockOpPayload::Transition { .. } => "transition",
                BlockOpPayload::AttachPolicy { .. } => "attach_policy",
                BlockOpPayload::AttachAttestation { .. } => "attach_attestation",
                BlockOpPayload::Tag { .. } => "tag",
                BlockOpPayload::SetExtension { .. } => "set_extension",
                BlockOpPayload::Snapshot { .. } => "snapshot",
            };
            let payload_json = serde_json::to_string(&op.payload)?;
            let ts_us = (op.timestamp.unix_timestamp_nanos() / 1_000) as i64;
            stmt.execute(params![
                op.op_id.as_bytes().as_slice(),
                op.block_id.0.as_bytes().as_slice(),
                op.actor.0,
                ts_us,
                op.lamport as i64,
                payload_kind,
                payload_json,
            ])?;
        }
    }
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use aura_blocks::{AgentRef, BlockId, BlockOp, BlockOpPayload};
    use uuid::Uuid;

    fn mk_append(block_id: BlockId, lamport: u64, payload_len: usize) -> BlockOp {
        let bytes = vec![b'x'; payload_len];
        let bytes_b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
        BlockOp {
            op_id: Uuid::now_v7(),
            block_id,
            actor: AgentRef("did:aura:test".into()),
            timestamp: time::OffsetDateTime::now_utc(),
            lamport,
            payload: BlockOpPayload::AppendOutput {
                stream: "stdout".into(),
                bytes_b64,
                redactions: Vec::new(),
            },
        }
    }

    #[test]
    fn append_fills_buf_and_updates_high_watermark() {
        let id = BlockId::new();
        let ring = OutputRing::new(id, 1024);
        for i in 1..=5 {
            ring.append(mk_append(id, i, 100)).unwrap();
        }
        assert_eq!(ring.high_watermark(), 5);
        assert_eq!(ring.read_since(3).len(), 3);
    }

    #[test]
    fn eviction_drops_head_on_overflow() {
        let id = BlockId::new();
        let ring = OutputRing::new(id, 500);
        for i in 1..=10 {
            ring.append(mk_append(id, i, 100)).unwrap();
        }
        // 10 chunks * 100 bytes = 1000; cap 500 → ring should have evicted.
        assert!(ring.bytes_in_buf() <= 500);
        // Unflushed queue holds all 10 — persistence is never dropped.
        let drained = ring.drain_unflushed();
        assert_eq!(drained.len(), 10);
    }

    #[test]
    fn non_append_op_is_rejected() {
        let id = BlockId::new();
        let ring = OutputRing::new(id, 1024);
        let op = BlockOp {
            op_id: Uuid::now_v7(),
            block_id: id,
            actor: AgentRef("did:aura:test".into()),
            timestamp: time::OffsetDateTime::now_utc(),
            lamport: 1,
            payload: BlockOpPayload::Tag { tag: "x".into() },
        };
        assert!(ring.append(op).is_err());
    }

    #[test]
    fn registry_drains_all_rings() {
        let reg = RingRegistry::new();
        let a = BlockId::new();
        let b = BlockId::new();
        reg.get_or_create(a, 1024).append(mk_append(a, 1, 10)).unwrap();
        reg.get_or_create(b, 1024).append(mk_append(b, 1, 10)).unwrap();
        let drained = reg.drain_all_unflushed();
        assert_eq!(drained.len(), 2);
    }

    #[test]
    fn persist_writes_rows() {
        let conn = Connection::open_in_memory().unwrap();
        crate::schema::init_db(&conn).unwrap();

        // Need a blocks row first because block_ops.block_id is a FK.
        // Insert a minimal placeholder row bypassing the store.
        let id = BlockId::new();
        conn.execute(
            r#"INSERT INTO blocks (
                id, kind, state, anchor_kind, created_at, updated_at, block_json
            ) VALUES (?1, 'command', 'proposed', 'none', 0, 0, '{}')"#,
            params![id.0.as_bytes().as_slice()],
        )
        .unwrap();

        let ops: Vec<BlockOp> = (1..=10).map(|i| mk_append(id, i, 8)).collect();
        persist_output_ops(&conn, &ops).unwrap();

        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM block_ops WHERE block_id = ?1",
                params![id.0.as_bytes().as_slice()],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 10);
    }

    #[test]
    fn ten_thousand_appends_are_fast() {
        let id = BlockId::new();
        let ring = OutputRing::new(id, DEFAULT_CAP_BYTES);
        let start = std::time::Instant::now();
        for i in 1..=10_000_u64 {
            ring.append(mk_append(id, i, 64)).unwrap();
        }
        let elapsed = start.elapsed();
        // Generous budget; catches regressions not micro-perf.
        assert!(
            elapsed.as_secs_f64() < 1.0,
            "10k appends took {elapsed:?}; expected <1s"
        );
        // After draining, the unflushed queue must hold every op (no
        // silent drop in the persistence path).
        assert_eq!(ring.drain_unflushed().len(), 10_000);
    }
}
