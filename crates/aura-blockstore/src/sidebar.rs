//! Sidebar projection — maintained by the store, queried by the UI.
//!
//! The read-side view the work-surface sidebar renders. Materialized into the
//! `sidebar_cards` table on every `apply_op`, then queried by priority bucket
//! and score. Priority is the coarse bucket (from `aura_blocks::SidebarPriority`);
//! `score` is the fine ordering within the bucket.
//!
//! Scoring rules for v1 are constants on [`Scoring`]. No config file yet —
//! these iterate once real usage lands. The struct is public so tests and
//! future tuners can supply alternate weights.

use aura_blocks::{
    AnchorRef, Block, BlockId, BlockKind, BlockPayload, BlockState, SidebarCard, SidebarPriority,
};
use rusqlite::{Connection, OptionalExtension, params};
use std::collections::HashSet;
use time::OffsetDateTime;

use crate::error::Result;

/// Scoring weights. Default values are the v1 rules captured in the plan.
#[derive(Debug, Clone, Copy)]
pub struct Scoring {
    pub mention_of_mine: f64,
    pub zone_overlap: f64,
    pub unacknowledged: f64,
    /// Age decay per hour since `created_at`.
    pub age_decay_per_hour: f64,
}

impl Default for Scoring {
    fn default() -> Self {
        Self {
            mention_of_mine: 10.0,
            zone_overlap: 5.0,
            unacknowledged: 3.0,
            age_decay_per_hour: 0.05,
        }
    }
}

/// Context supplied by the supervisor at projection time — the per-viewer
/// state that matters for scoring. In a single-user v1 this is filled from
/// config and the zones table. In W3b / W5 it gets DID-scoped.
#[derive(Debug, Clone)]
pub struct ScoringContext {
    /// DID of the current viewer (used to detect mentions). `None` in tests
    /// and in the single-user default install.
    pub viewer: Option<String>,
    /// Files the viewer owns or has recently edited. Matched against
    /// `AnchorRef::Function` / `AnchorRef::File`.
    pub mine_files: HashSet<String>,
    /// Zones the viewer currently holds a claim in.
    pub my_zones: HashSet<String>,
    /// Block ids the viewer has acknowledged (read). Absence → unread.
    pub acked_blocks: HashSet<BlockId>,
    /// Wall clock; injected for deterministic tests.
    pub now: OffsetDateTime,
}

impl Default for ScoringContext {
    fn default() -> Self {
        Self::empty_now()
    }
}

impl ScoringContext {
    pub fn empty_now() -> Self {
        Self {
            viewer: None,
            mine_files: HashSet::new(),
            my_zones: HashSet::new(),
            acked_blocks: HashSet::new(),
            now: OffsetDateTime::now_utc(),
        }
    }
}

impl Scoring {
    /// Compute the score for a block under the given viewer context.
    ///
    /// Score is a sum of positive contributions minus age decay, floored at
    /// zero. Buckets come from [`priority_for`]; score orders within a bucket.
    pub fn compute(&self, block: &Block, ctx: &ScoringContext) -> f64 {
        let mut score: f64 = 0.0;

        if is_mention_of_viewer(block, ctx) || anchor_is_mine(&block.anchor, &ctx.mine_files) {
            score += self.mention_of_mine;
        }
        if anchor_overlaps_zones(&block.anchor, &ctx.my_zones) {
            score += self.zone_overlap;
        }
        if !ctx.acked_blocks.contains(&block.id) {
            score += self.unacknowledged;
        }

        let hours_old =
            ((ctx.now - block.created_at).whole_seconds().max(0) as f64) / 3600.0;
        score -= self.age_decay_per_hour * hours_old;

        score.max(0.0)
    }
}

fn is_mention_of_viewer(block: &Block, ctx: &ScoringContext) -> bool {
    let Some(viewer) = &ctx.viewer else {
        return false;
    };
    match &block.payload {
        BlockPayload::Message { mentions, .. } => {
            mentions.iter().any(|m| &m.0 == viewer)
        }
        _ => false,
    }
}

fn anchor_is_mine(anchor: &AnchorRef, mine: &HashSet<String>) -> bool {
    match anchor {
        AnchorRef::Function(id) => mine.contains(id),
        AnchorRef::File(path) => mine.contains(path),
        _ => false,
    }
}

fn anchor_overlaps_zones(anchor: &AnchorRef, my_zones: &HashSet<String>) -> bool {
    match anchor {
        AnchorRef::Zone(z) => my_zones.contains(z),
        _ => false,
    }
}

/// Map a block to its sidebar bucket. Coarse ordering is by kind + state.
pub fn priority_for(block: &Block) -> SidebarPriority {
    match block.kind {
        BlockKind::ImpactAlert => SidebarPriority::ImpactOnMine,
        BlockKind::Message => SidebarPriority::DirectToMe,
        BlockKind::SentinelEvent => SidebarPriority::AgentChatter,
        BlockKind::ExternalMirror => SidebarPriority::ReviewRequested,
        BlockKind::Command | BlockKind::Proposal => match block.state {
            BlockState::Gated => SidebarPriority::DirectToMe,
            _ => SidebarPriority::TeamActivity,
        },
        BlockKind::ZoneEvent
        | BlockKind::BuildEvent
        | BlockKind::Skill
        | BlockKind::Branch => SidebarPriority::TeamActivity,
    }
}

/// Human-readable summary derived from the block. Denormalized into the
/// sidebar row so the UI never has to parse the full payload.
pub fn summary_for(block: &Block) -> String {
    if !block.intent.summary.is_empty() {
        return block.intent.summary.clone();
    }
    match &block.payload {
        BlockPayload::Command { command, .. } => command.clone(),
        BlockPayload::Proposal { proposed_command, .. } => proposed_command.clone(),
        BlockPayload::Message { body, .. } => truncate(body, 120),
        BlockPayload::Sentinel { event_type, .. } => format!("sentinel: {event_type}"),
        BlockPayload::ExternalMirror { source, external_id, .. } => {
            format!("{source}#{external_id}")
        }
        BlockPayload::Impact { function_id, change_kind } => {
            format!("{function_id} {change_kind}")
        }
        BlockPayload::Zone { zone_id, action } => format!("zone {zone_id} {action}"),
        BlockPayload::Build { build_id, status } => format!("build {build_id} {status}"),
        BlockPayload::Skill { skill_name, .. } => format!("skill {skill_name}"),
        BlockPayload::Branch { reason } => format!("branch: {reason}"),
    }
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        let mut out: String = s.chars().take(max).collect();
        out.push('…');
        out
    }
}

fn anchor_label(anchor: &AnchorRef) -> Option<String> {
    match anchor {
        AnchorRef::Function(id) => Some(id.clone()),
        AnchorRef::File(path) => Some(path.clone()),
        AnchorRef::Pr(pr) => Some(format!("{}/{}#{}", pr.provider, pr.path, pr.number)),
        AnchorRef::Zone(z) => Some(format!("zone:{z}")),
        AnchorRef::Build(b) => Some(format!("build:{b}")),
        AnchorRef::Block(id) => Some(format!("block:{:?}", id.0)),
        AnchorRef::None => None,
    }
}

/// Upsert a sidebar card after reducer apply.
pub fn upsert_sidebar_card(
    conn: &Connection,
    block: &Block,
    scoring: Scoring,
    ctx: &ScoringContext,
) -> Result<()> {
    let bucket = priority_for(block) as u8 as i64;
    let score = scoring.compute(block, ctx);
    let summary = summary_for(block);
    let actor_label = block.provenance.actor.0.clone();
    let anchor = anchor_label(&block.anchor);
    let unread = if ctx.acked_blocks.contains(&block.id) { 0 } else { 1 };
    let created_us = block.created_at.unix_timestamp_nanos() / 1_000;
    let updated_us = block.updated_at.unix_timestamp_nanos() / 1_000;

    conn.execute(
        r#"
        INSERT INTO sidebar_cards (
            block_id, priority_bucket, score, actor_label, anchor_label,
            summary, unread, children_count, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8, ?9)
        ON CONFLICT(block_id) DO UPDATE SET
            priority_bucket = excluded.priority_bucket,
            score           = excluded.score,
            actor_label     = excluded.actor_label,
            anchor_label    = excluded.anchor_label,
            summary         = excluded.summary,
            unread          = excluded.unread,
            updated_at      = excluded.updated_at
        "#,
        params![
            block.id.0.as_bytes().as_slice(),
            bucket,
            score,
            actor_label,
            anchor,
            summary,
            unread,
            created_us as i64,
            updated_us as i64,
        ],
    )?;
    Ok(())
}

/// Filter for `query_sidebar`.
#[derive(Debug, Clone, Default)]
pub struct SidebarFilter {
    pub max_rows: Option<u32>,
    pub min_bucket: Option<SidebarPriority>,
    pub max_bucket: Option<SidebarPriority>,
    pub unread_only: bool,
}

/// Query the sidebar, ordered by (priority_bucket ASC, score DESC, updated_at DESC).
pub fn query_sidebar(conn: &Connection, filter: &SidebarFilter) -> Result<Vec<SidebarCard>> {
    let mut sql = String::from(
        "SELECT block_id, priority_bucket, actor_label, anchor_label, summary, unread, \
         children_count, updated_at \
         FROM sidebar_cards WHERE 1=1",
    );
    if let Some(min) = filter.min_bucket {
        sql.push_str(&format!(" AND priority_bucket >= {}", min as u8));
    }
    if let Some(max) = filter.max_bucket {
        sql.push_str(&format!(" AND priority_bucket <= {}", max as u8));
    }
    if filter.unread_only {
        sql.push_str(" AND unread = 1");
    }
    sql.push_str(" ORDER BY priority_bucket ASC, score DESC, updated_at DESC");
    if let Some(n) = filter.max_rows {
        sql.push_str(&format!(" LIMIT {n}"));
    }

    let mut stmt = conn.prepare(&sql)?;

    // The card rows don't carry the full block — we need `kind` / `state`
    // / `created_at` to reconstruct a `SidebarCard` value. Read them from
    // the `blocks` table in a parallel query.
    let rows: Vec<SidebarRow> = stmt
        .query_map([], |r| {
            Ok(SidebarRow {
                block_id_bytes: r.get::<_, Vec<u8>>(0)?,
                priority_bucket: r.get::<_, i64>(1)? as u8,
                actor_label: r.get::<_, String>(2)?,
                anchor_label: r.get::<_, Option<String>>(3)?,
                summary: r.get::<_, String>(4)?,
                unread: r.get::<_, i64>(5)? != 0,
                children_count: r.get::<_, i64>(6)? as u32,
                updated_at_us: r.get::<_, i64>(7)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;

    let mut out: Vec<SidebarCard> = Vec::with_capacity(rows.len());
    for row in rows {
        let id_uuid = uuid::Uuid::from_slice(&row.block_id_bytes)
            .map_err(|e| crate::error::StoreError::IllegalOp {
                block_id: format!("{:?}", &row.block_id_bytes),
                reason: format!("sidebar block_id not a uuid: {e}"),
            })?;

        let (kind_str, state_str, created_us) = conn
            .query_row(
                "SELECT kind, state, created_at FROM blocks WHERE id = ?1",
                params![row.block_id_bytes],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, i64>(2)?,
                    ))
                },
            )
            .optional()?
            .ok_or_else(|| crate::error::StoreError::NotFound(format!("{:?}", id_uuid)))?;

        let kind = BlockKind::from_serde_name(&kind_str).ok_or_else(|| {
            crate::error::StoreError::IllegalOp {
                block_id: format!("{:?}", id_uuid),
                reason: format!("unknown kind in sidebar row: {kind_str}"),
            }
        })?;
        let state: BlockState = serde_json::from_str(&format!("\"{}\"", state_str))?;
        let created_at =
            OffsetDateTime::from_unix_timestamp_nanos((created_us as i128) * 1_000)?;

        out.push(SidebarCard {
            block_id: BlockId(id_uuid),
            kind,
            state,
            actor_label: row.actor_label,
            anchor_label: row.anchor_label,
            summary: row.summary,
            priority: priority_from_bucket(row.priority_bucket),
            unread: row.unread,
            created_at,
            children_count: row.children_count,
        });

        // Silence "updated_at_us never read" for the reconstructed card —
        // the value is used via the ORDER BY clause on the query itself.
        let _ = row.updated_at_us;
    }
    Ok(out)
}

struct SidebarRow {
    block_id_bytes: Vec<u8>,
    priority_bucket: u8,
    actor_label: String,
    anchor_label: Option<String>,
    summary: String,
    unread: bool,
    children_count: u32,
    updated_at_us: i64,
}

fn priority_from_bucket(b: u8) -> SidebarPriority {
    match b {
        0 => SidebarPriority::ImpactOnMine,
        1 => SidebarPriority::DirectToMe,
        2 => SidebarPriority::ReviewRequested,
        3 => SidebarPriority::TeamActivity,
        _ => SidebarPriority::AgentChatter,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use aura_blocks::{
        AgentRef, AnchorRef, Attestations, BlockId, BlockKind, BlockPayload, BlockState,
        DeclaredImpacts, Intent, Provenance, SCHEMA_VERSION,
    };
    use std::collections::BTreeMap;

    fn mk(kind: BlockKind, anchor: AnchorRef, intent: &str) -> Block {
        Block {
            id: BlockId::new(),
            schema_version: SCHEMA_VERSION,
            kind,
            parent_id: None,
            prior_sibling_id: None,
            supersedes_id: None,
            anchor,
            intent: Intent {
                summary: intent.into(),
                detail: None,
                parent_intent: None,
            },
            declared_impacts: DeclaredImpacts::default(),
            actual_impacts: None,
            payload: BlockPayload::Command {
                command: "ls".into(),
                shell: None,
                cwd: "/".into(),
            },
            state: BlockState::Proposed,
            policy: None,
            provenance: Provenance {
                actor: AgentRef("did:aura:user/me".into()),
                on_behalf_of: None,
                origin_host: "t".into(),
                signature: None,
            },
            attestations: Attestations::default(),
            created_at: OffsetDateTime::now_utc(),
            updated_at: OffsetDateTime::now_utc(),
            extensions: BTreeMap::new(),
        }
    }

    #[test]
    fn mention_of_mine_is_weighted() {
        let b = mk(
            BlockKind::Command,
            AnchorRef::Function("apply_limiter".into()),
            "ran",
        );
        let scoring = Scoring::default();

        let mut mine = HashSet::new();
        mine.insert("apply_limiter".into());
        let ctx = ScoringContext {
            viewer: Some("did:aura:user/me".into()),
            mine_files: mine,
            my_zones: HashSet::new(),
            acked_blocks: HashSet::new(),
            now: b.created_at,
        };
        let mut other = HashSet::new();
        other.insert("retry_logic".into());
        let ctx_other = ScoringContext {
            mine_files: other,
            ..ctx.clone()
        };

        let score_mine = scoring.compute(&b, &ctx);
        let score_not_mine = scoring.compute(&b, &ctx_other);
        assert!(
            score_mine > score_not_mine,
            "mine={score_mine} vs not_mine={score_not_mine}"
        );
    }

    #[test]
    fn age_decays_score() {
        let mut b = mk(BlockKind::Command, AnchorRef::None, "old");
        let ctx = ScoringContext {
            now: b.created_at + time::Duration::hours(200),
            acked_blocks: {
                // Seed as acked so unread bonus doesn't mask decay.
                let mut s = HashSet::new();
                s.insert(b.id);
                s
            },
            ..ScoringContext::default()
        };
        b.created_at = ctx.now - time::Duration::hours(200);
        let s = Scoring::default().compute(&b, &ctx);
        assert_eq!(s, 0.0, "old acked block should decay to floor");
    }

    #[test]
    fn priority_buckets_follow_kind_and_state() {
        let msg = mk(BlockKind::Message, AnchorRef::None, "hi");
        let gated_cmd = {
            let mut b = mk(BlockKind::Command, AnchorRef::None, "");
            b.state = BlockState::Gated;
            b
        };
        assert_eq!(priority_for(&msg), SidebarPriority::DirectToMe);
        assert_eq!(priority_for(&gated_cmd), SidebarPriority::DirectToMe);
    }
}
