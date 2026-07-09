//! Render a dense XML snapshot of daemon-known state so an agent can
//! resume a session with minimal prompting.
//!
//! This is the daemon-side piece of the Handover RPC. The MCP tool
//! `aura_handover` in aura-cli produces a broader payload that also
//! folds in planner / sentinel / memory context; the daemon only owns
//! blocks + sessions, so we return exactly that subset. Clients combine
//! the two to reach full-context handover.
//!
//! Scope decisions:
//! - Up to `BLOCK_LIMIT` most-recent blocks are inlined. The daemon's
//!   block store is the authoritative source of truth but a full dump
//!   would defeat the purpose of compression; clients that need the
//!   long tail should paginate `ListBlocks`.
//! - Block kind + state counts cover the whole store, so the recipient
//!   can tell how much history was elided.
//! - Intent summaries are included; payload bodies and extensions are
//!   not (they can be large and are kind-specific — recipient fetches
//!   them per-block via `GetBlock` when needed).
//! - Every `&str` that lands in an attribute or text node is XML-escaped
//!   so an attacker-controlled block summary can't inject markup.

use std::collections::BTreeMap;
use std::fmt::Write as _;

use aura_blocks::{AnchorRef, Block, BlockKind, BlockState};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

use crate::state::ServerState;
use aura_daemon_client::error::{ProtocolError, ProtocolErrorKind};

/// Cap on inlined blocks. A larger handover defeats the point of
/// compression; receivers that need the full tail paginate ListBlocks.
const BLOCK_LIMIT: u32 = 50;

/// Build a handover XML payload from daemon-held state. `agent` is
/// echoed into the root element so a recipient can distinguish their
/// own handover from a sibling's.
pub fn build_handover_xml(
    state: &ServerState,
    agent: &str,
    daemon_build: &str,
) -> Result<String, ProtocolError> {
    let now = OffsetDateTime::now_utc();

    let mut sessions = state
        .all_sessions()
        .map_err(|e| ProtocolError::new(ProtocolErrorKind::Unavailable, e.to_string()))?;
    // Deterministic ordering — creation-time ascending so a resumer
    // sees oldest→newest, matching how terminals append new tabs.
    sessions.sort_by_key(|s| s.created_at);

    let all_blocks = state
        .store
        .list_blocks(&aura_blockstore::BlockFilter::default())
        .map_err(|e| {
            ProtocolError::new(
                ProtocolErrorKind::Unavailable,
                format!("blockstore list failed: {e}"),
            )
        })?;

    let total = all_blocks.len();
    // `ListBlocks` returns `ORDER BY created_at DESC`, so the first N
    // are the most-recent blocks — exactly what a handover wants to
    // inline. Clone the slice we keep so `counts_by_*` can walk the
    // full list without lifetime contortions.
    let shown_slice: Vec<Block> = all_blocks
        .iter()
        .take(BLOCK_LIMIT as usize)
        .cloned()
        .collect();

    let by_state = counts_by_state(&all_blocks);
    let by_kind = counts_by_kind(&all_blocks);

    let mut out = String::with_capacity(4096);

    writeln!(
        out,
        r#"<aura-handover version="1" agent="{}" daemon_build="{}" generated_at="{}">"#,
        esc_attr(agent),
        esc_attr(daemon_build),
        esc_attr(&fmt_time(now)?),
    )
    .expect("writing to String");

    // Sessions -----------------------------------------------------------
    writeln!(out, r#"  <sessions count="{}">"#, sessions.len()).unwrap();
    for s in &sessions {
        let workspace = s.workspace.to_string_lossy();
        let created = fmt_time(s.created_at)?;
        match &s.agent {
            Some(a) => writeln!(
                out,
                r#"    <session id="{}" workspace="{}" agent="{}" created_at="{}" />"#,
                s.id.0,
                esc_attr(&workspace),
                esc_attr(a),
                esc_attr(&created),
            )
            .unwrap(),
            None => writeln!(
                out,
                r#"    <session id="{}" workspace="{}" created_at="{}" />"#,
                s.id.0,
                esc_attr(&workspace),
                esc_attr(&created),
            )
            .unwrap(),
        }
    }
    writeln!(out, "  </sessions>").unwrap();

    // Block counts -------------------------------------------------------
    writeln!(out, "  <block_counts>").unwrap();
    write!(out, "    <by_state").unwrap();
    for (k, v) in &by_state {
        write!(out, r#" {}="{}""#, k, v).unwrap();
    }
    writeln!(out, " />").unwrap();
    write!(out, "    <by_kind").unwrap();
    for (k, v) in &by_kind {
        write!(out, r#" {}="{}""#, k, v).unwrap();
    }
    writeln!(out, " />").unwrap();
    writeln!(out, "  </block_counts>").unwrap();

    // Blocks -------------------------------------------------------------
    writeln!(
        out,
        r#"  <blocks total="{}" returned="{}">"#,
        total,
        shown_slice.len(),
    )
    .unwrap();
    for b in &shown_slice {
        write_block(&mut out, b)?;
    }
    writeln!(out, "  </blocks>").unwrap();

    writeln!(out, "</aura-handover>").unwrap();

    Ok(out)
}

fn write_block(out: &mut String, b: &Block) -> Result<(), ProtocolError> {
    let created = fmt_time(b.created_at)?;
    let updated = fmt_time(b.updated_at)?;
    let kind = kind_wire_name(&b.kind);
    let state = state_wire_name(b.state);

    writeln!(
        out,
        r#"    <block id="{}" kind="{}" state="{}" created_at="{}" updated_at="{}">"#,
        b.id.0,
        esc_attr(&kind),
        esc_attr(&state),
        esc_attr(&created),
        esc_attr(&updated),
    )
    .unwrap();

    writeln!(
        out,
        "      <intent>{}</intent>",
        esc_text(&b.intent.summary),
    )
    .unwrap();

    write_anchor(out, &b.anchor);

    if let Some(policy) = &b.policy {
        let mode = policy_mode_name(policy);
        writeln!(out, r#"      <policy mode="{}" />"#, esc_attr(&mode)).unwrap();
    }

    writeln!(out, "    </block>").unwrap();
    Ok(())
}

fn write_anchor(out: &mut String, a: &AnchorRef) {
    match a {
        AnchorRef::Function(s) => writeln!(
            out,
            r#"      <anchor kind="function" value="{}" />"#,
            esc_attr(s)
        )
        .unwrap(),
        AnchorRef::File(s) => writeln!(
            out,
            r#"      <anchor kind="file" value="{}" />"#,
            esc_attr(s)
        )
        .unwrap(),
        AnchorRef::Pr(pr) => writeln!(
            out,
            r#"      <anchor kind="pr" provider="{}" path="{}" number="{}" />"#,
            esc_attr(&pr.provider),
            esc_attr(&pr.path),
            pr.number,
        )
        .unwrap(),
        AnchorRef::Zone(s) => writeln!(
            out,
            r#"      <anchor kind="zone" value="{}" />"#,
            esc_attr(s)
        )
        .unwrap(),
        AnchorRef::Build(s) => writeln!(
            out,
            r#"      <anchor kind="build" value="{}" />"#,
            esc_attr(s)
        )
        .unwrap(),
        AnchorRef::Block(id) => writeln!(
            out,
            r#"      <anchor kind="block" id="{}" />"#,
            id.0
        )
        .unwrap(),
        AnchorRef::None => writeln!(out, r#"      <anchor kind="none" />"#).unwrap(),
    }
}

fn counts_by_state(blocks: &[Block]) -> BTreeMap<&'static str, usize> {
    let mut m = BTreeMap::new();
    for b in blocks {
        *m.entry(state_static_name(b.state)).or_insert(0) += 1;
    }
    m
}

fn counts_by_kind(blocks: &[Block]) -> BTreeMap<&'static str, usize> {
    let mut m = BTreeMap::new();
    for b in blocks {
        *m.entry(kind_static_name(&b.kind)).or_insert(0) += 1;
    }
    m
}

// State / kind name lookup tables ----------------------------------------
// The daemon serializes these with serde's `#[rename_all = "snake_case"]`
// everywhere else; replicating the match here keeps the handover layer
// pure (no serde round-trips per block, which would be measurable at
// BLOCK_LIMIT × all_blocks-long total).

fn state_static_name(s: BlockState) -> &'static str {
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

fn state_wire_name(s: BlockState) -> String {
    state_static_name(s).to_string()
}

fn kind_static_name(k: &BlockKind) -> &'static str {
    // Mirrors the generated BlockKind registry (see aura-blocks/kinds.toml).
    // Adding a variant there is a compile error here until this match is
    // updated — deliberate, because the handover string lands in a contract.
    match k {
        BlockKind::Command => "command",
        BlockKind::Proposal => "proposal",
        BlockKind::Message => "message",
        BlockKind::SentinelEvent => "sentinel_event",
        BlockKind::ExternalMirror => "external_mirror",
        BlockKind::ImpactAlert => "impact_alert",
        BlockKind::ZoneEvent => "zone_event",
        BlockKind::BuildEvent => "build_event",
        BlockKind::Skill => "skill",
        BlockKind::Branch => "branch",
    }
}

fn kind_wire_name(k: &BlockKind) -> String {
    kind_static_name(k).to_string()
}

fn policy_mode_name(p: &aura_blocks::PolicyDecision) -> String {
    // Mirrors the CapabilityGrade's serde snake_case repr exactly so a
    // client reading this attribute can compare against the same string
    // it sees everywhere else the verdict flows.
    match p.verdict {
        aura_blocks::CapabilityGrade::Auto => "auto".into(),
        aura_blocks::CapabilityGrade::Gate => "gate".into(),
        aura_blocks::CapabilityGrade::Deny => "deny".into(),
    }
}

fn fmt_time(t: OffsetDateTime) -> Result<String, ProtocolError> {
    t.format(&Rfc3339).map_err(|e| {
        ProtocolError::new(
            ProtocolErrorKind::Codec,
            format!("rfc3339 format: {e}"),
        )
    })
}

/// XML escape for attribute values. Covers the five predefined entities
/// plus the quote character used to delimit attributes. Text nodes use
/// `esc_text` which is the same set minus `'`.
fn esc_attr(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            _ => out.push(c),
        }
    }
    out
}

fn esc_text(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            _ => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use std::path::PathBuf;
    use std::sync::Arc;

    use aura_blocks::{
        AgentRef, Attestations, Block, BlockId, BlockPayload, DeclaredImpacts, Intent, Provenance,
        SCHEMA_VERSION,
    };
    use aura_blockstore::BlockStore;

    fn make_block(summary: &str, state: BlockState) -> Block {
        Block {
            id: BlockId::new(),
            schema_version: SCHEMA_VERSION,
            kind: BlockKind::Command,
            parent_id: None,
            prior_sibling_id: None,
            supersedes_id: None,
            anchor: AnchorRef::Function("f".into()),
            intent: Intent {
                summary: summary.into(),
                detail: None,
                parent_intent: None,
            },
            declared_impacts: DeclaredImpacts::default(),
            actual_impacts: None,
            payload: BlockPayload::Command {
                command: "echo hi".into(),
                shell: None,
                cwd: "/tmp".into(),
            },
            state,
            policy: None,
            provenance: Provenance {
                actor: AgentRef("did:aura:test".into()),
                on_behalf_of: None,
                origin_host: "h".into(),
                signature: None,
            },
            attestations: Attestations::default(),
            created_at: OffsetDateTime::now_utc(),
            updated_at: OffsetDateTime::now_utc(),
            extensions: BTreeMap::new(),
        }
    }

    #[test]
    fn escapes_xml_special_chars_in_intent_and_session_agent() {
        let store = Arc::new(BlockStore::open(std::path::Path::new(":memory:")).unwrap());
        let state = ServerState::new(store.clone(), std::path::PathBuf::from("/tmp/aura-test-sentinel-unused"), std::sync::Arc::new(crate::input::InputRouter::new()));

        let mut b = make_block("hi <script> & \"quoted\"", BlockState::Completed);
        b.anchor = AnchorRef::Function("f<&>".into());
        store.insert_block(&b).unwrap();

        state
            .open_session(PathBuf::from("/work/<dir>"), Some("agent & co".into()))
            .unwrap();

        let xml = build_handover_xml(&state, "claude <alpha>", "aura-daemon/test").unwrap();

        // Attribute escape includes quote + apostrophe (defensive).
        assert!(xml.contains(r#"agent="claude &lt;alpha&gt;""#));
        // Text node does NOT double-encode ampersand.
        assert!(xml.contains("hi &lt;script&gt; &amp; \"quoted\""));
        assert!(xml.contains(r#"value="f&lt;&amp;&gt;""#));
        assert!(xml.contains(r#"agent="agent &amp; co""#));
        assert!(xml.contains(r#"workspace="/work/&lt;dir&gt;""#));
        // No raw < or > or & outside of entities should survive.
        // Sanity: every & in the output is part of an entity.
        for (idx, _) in xml.match_indices('&') {
            let tail = &xml[idx..(idx + 6).min(xml.len())];
            assert!(
                tail.starts_with("&amp;")
                    || tail.starts_with("&lt;")
                    || tail.starts_with("&gt;")
                    || tail.starts_with("&quot;")
                    || tail.starts_with("&apos;"),
                "raw '&' at {}: {:?}",
                idx,
                tail,
            );
        }
    }

    #[test]
    fn counts_and_returned_are_consistent() {
        let store = Arc::new(BlockStore::open(std::path::Path::new(":memory:")).unwrap());
        let state = ServerState::new(store.clone(), std::path::PathBuf::from("/tmp/aura-test-sentinel-unused"), std::sync::Arc::new(crate::input::InputRouter::new()));
        for i in 0..3 {
            let b = make_block(&format!("b{i}"), BlockState::Proposed);
            store.insert_block(&b).unwrap();
        }
        let b_done = make_block("done", BlockState::Completed);
        store.insert_block(&b_done).unwrap();

        let xml = build_handover_xml(&state, "claude", "aura-daemon/test").unwrap();
        assert!(xml.contains(r#"<blocks total="4" returned="4">"#));
        assert!(xml.contains(r#"proposed="3""#));
        assert!(xml.contains(r#"completed="1""#));
        assert!(xml.contains(r#"command="4""#));
    }

    #[test]
    fn block_limit_is_honored() {
        let store = Arc::new(BlockStore::open(std::path::Path::new(":memory:")).unwrap());
        let state = ServerState::new(store.clone(), std::path::PathBuf::from("/tmp/aura-test-sentinel-unused"), std::sync::Arc::new(crate::input::InputRouter::new()));
        let over = (BLOCK_LIMIT as usize) + 10;
        for i in 0..over {
            let b = make_block(&format!("b{i}"), BlockState::Proposed);
            store.insert_block(&b).unwrap();
        }

        let xml = build_handover_xml(&state, "claude", "aura-daemon/test").unwrap();
        let want_total = format!(r#"total="{}""#, over);
        let want_returned = format!(r#"returned="{}""#, BLOCK_LIMIT);
        assert!(
            xml.contains(&want_total),
            "missing total={}: xml head = {:?}",
            over,
            &xml[..200.min(xml.len())]
        );
        assert!(
            xml.contains(&want_returned),
            "missing returned={}: xml head = {:?}",
            BLOCK_LIMIT,
            &xml[..200.min(xml.len())]
        );
    }
}
