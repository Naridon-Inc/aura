//! Commit-time reconciliation: the DECLARED intent scope vs. what the commit
//! ACTUALLY changed.
//!
//! This is the missing half of Aura's "never lie" catch. When an agent logs
//! an intent it can declare which files it will touch (`aura_log_intent`'s
//! `writes` arg → the signed block's `declared_impacts.writes_paths`). At
//! commit time the pre-commit hook (`aura capture-context`) already knows the
//! real staged file set; here we stamp that into the block's `actual_impacts`
//! and flag any file touched beyond the declared scope.
//!
//! Two things happen here that never happened before:
//!   1. `actual_impacts` gets populated. Every prior signed block carried
//!      `actual_impacts: null`, which is precisely why the `intent-divergence`
//!      policy rule (aura-policy `match_intent_divergence`) short-circuited to
//!      "no match" and never once fired. Filling it is what wakes the gate up.
//!   2. The undeclared-writes set is surfaced to the user — the concrete
//!      "you said you'd change X, but you also changed Y".
//!
//! Reconciliation runs ONLY when the newest unreconciled intent block declared
//! a non-empty write scope. No scope claim ⇒ nothing to diverge from ⇒ silent,
//! so a plain intent with no `writes` never produces noise.
//!
//! Binding heuristic: we reconcile the newest signed intent block that still
//! has `actual_impacts == None` and a non-empty declared scope. The common
//! flow is log-intent-then-commit, where "newest" is unambiguous. A precise
//! intent→commit binding is a later refinement.

use aura_blocks::{Block, DeclaredImpacts};
use aura_policy::undeclared_writes;
use std::path::{Path, PathBuf};

/// Outcome of reconciling one commit against the agent's declared scope.
pub struct Reconciliation {
    /// The signed block that was reconciled.
    pub block_id: String,
    /// One-line intent summary, for the user-facing message.
    pub intent_summary: String,
    /// What the agent said it would touch.
    pub declared: Vec<String>,
    /// What the commit actually changed (repo-relative).
    pub actual: Vec<String>,
    /// Actual writes the agent never declared — the catch. Empty ⇒ clean.
    pub undeclared: Vec<String>,
}

impl Reconciliation {
    /// True when the commit touched files outside the declared scope.
    pub fn diverged(&self) -> bool {
        !self.undeclared.is_empty()
    }
}

/// Find the newest signed intent block that (a) still has no `actual_impacts`
/// and (b) declared a non-empty write scope. Returns its on-disk path and the
/// parsed block. Newest = greatest `created_at`. `None` when there's nothing
/// to reconcile.
fn newest_unreconciled_declared_block(blocks_dir: &Path) -> Option<(PathBuf, Block)> {
    let mut best: Option<(PathBuf, Block)> = None;
    let read = std::fs::read_dir(blocks_dir).ok()?;
    for entry in read.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let block = match crate::intent_block::load_signed_block(&path) {
            Ok(b) => b,
            Err(_) => continue,
        };
        // Only intent seals that made a scope claim and haven't been
        // reconciled yet are candidates.
        if block.actual_impacts.is_some() || block.declared_impacts.writes_paths.is_empty() {
            continue;
        }
        let newer = match &best {
            Some((_, b)) => block.created_at > b.created_at,
            None => true,
        };
        if newer {
            best = Some((path, block));
        }
    }
    best
}

/// Stamp `actual_writes` into the newest unreconciled declared-scope block,
/// persist it back to disk + mirror it into the git-tracked `.aura/attest/`
/// dir, and return the divergence report. `None` when there was no
/// declared-scope intent to reconcile.
///
/// Persisting `actual_impacts` does NOT break the block's signature —
/// `actual_impacts` is a reducer-maintained field stripped from the signing
/// canonical form (see `aura_blocks::canonicalize_for_signing`, whose
/// `MUTABLE_TOPLEVEL_KEYS` includes `actual_impacts`). The signature keeps
/// verifying; the record just becomes complete.
pub fn reconcile_commit(blocks_dir: &Path, actual_writes: &[String]) -> Option<Reconciliation> {
    let (path, mut block) = newest_unreconciled_declared_block(blocks_dir)?;

    let declared = block.declared_impacts.writes_paths.clone();
    let actual: Vec<String> = actual_writes.to_vec();

    let actual_impacts = DeclaredImpacts {
        writes_paths: actual.clone(),
        ..Default::default()
    };
    let undeclared = undeclared_writes(&actual_impacts, &block.declared_impacts);

    block.actual_impacts = Some(actual_impacts);
    block.updated_at = time::OffsetDateTime::now_utc();

    // Best-effort persist: a write failure must not break the commit — the
    // in-memory report is still returned so the user still sees the catch.
    if let Ok(json) = serde_json::to_string_pretty(&block) {
        let _ = std::fs::write(&path, json);
    }
    crate::intent_block::mirror_block_to_attest(&block.id.0.to_string());

    Some(Reconciliation {
        block_id: block.id.0.to_string(),
        intent_summary: block.intent.summary.clone(),
        declared,
        actual,
        undeclared,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use aura_blocks::{
        AgentRef, AnchorRef, Attestations, Block, BlockId, BlockKind, BlockPayload, BlockState,
        DeclaredImpacts, Intent, Provenance, SCHEMA_VERSION,
    };
    use serde_json::json;
    use std::collections::BTreeMap;
    use time::OffsetDateTime;

    fn declared_block(dir: &Path, writes: &[&str], created: OffsetDateTime) -> BlockId {
        let block = Block {
            id: BlockId::new(),
            schema_version: SCHEMA_VERSION,
            kind: BlockKind::SentinelEvent,
            parent_id: None,
            prior_sibling_id: None,
            supersedes_id: None,
            anchor: AnchorRef::None,
            intent: Intent {
                summary: "add search box to recipes".into(),
                detail: None,
                parent_intent: None,
            },
            declared_impacts: DeclaredImpacts {
                writes_paths: writes.iter().map(|s| s.to_string()).collect(),
                ..Default::default()
            },
            actual_impacts: None,
            payload: BlockPayload::Sentinel {
                event_type: "intent".into(),
                body: json!({ "intent": "add search box" }),
            },
            state: BlockState::Completed,
            policy: None,
            provenance: Provenance {
                actor: AgentRef("did:aura:agent/MCP-Agent".into()),
                on_behalf_of: None,
                origin_host: "host".into(),
                signature: None,
            },
            attestations: Attestations::default(),
            extensions: BTreeMap::new(),
            created_at: created,
            updated_at: created,
        };
        let id = block.id;
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(
            dir.join(format!("{}.json", id.0)),
            serde_json::to_string_pretty(&block).unwrap(),
        )
        .unwrap();
        id
    }

    #[test]
    fn catches_undeclared_write() {
        let tmp = std::env::temp_dir().join(format!("aura-recon-{}", BlockId::new().0));
        let blocks = tmp.join("blocks");
        declared_block(&blocks, &["app.js"], OffsetDateTime::UNIX_EPOCH);

        // Commit actually touched app.js AND recipes.js — recipes.js undeclared.
        let recon =
            reconcile_commit(&blocks, &["app.js".into(), "recipes.js".into()]).expect("a block");
        assert!(recon.diverged());
        assert_eq!(recon.undeclared, vec!["recipes.js".to_string()]);

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn clean_when_within_scope() {
        let tmp = std::env::temp_dir().join(format!("aura-recon-{}", BlockId::new().0));
        let blocks = tmp.join("blocks");
        declared_block(&blocks, &["app.js", "index.html"], OffsetDateTime::UNIX_EPOCH);

        let recon = reconcile_commit(&blocks, &["app.js".into()]).expect("a block");
        assert!(!recon.diverged());
        assert!(recon.undeclared.is_empty());

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn stamps_actual_impacts_onto_block() {
        let tmp = std::env::temp_dir().join(format!("aura-recon-{}", BlockId::new().0));
        let blocks = tmp.join("blocks");
        let id = declared_block(&blocks, &["app.js"], OffsetDateTime::UNIX_EPOCH);

        reconcile_commit(&blocks, &["app.js".into(), "extra.js".into()]);

        // The block on disk now carries actual_impacts (it was None before) —
        // this is the fix for "0/1196 attestations ever computed actual".
        let reloaded =
            crate::intent_block::load_signed_block(&blocks.join(format!("{}.json", id.0))).unwrap();
        let actual = reloaded.actual_impacts.expect("actual_impacts populated");
        assert_eq!(actual.writes_paths, vec!["app.js".to_string(), "extra.js".to_string()]);

        // Reconciling again is a no-op — already reconciled, not re-picked.
        assert!(reconcile_commit(&blocks, &["whatever.js".into()]).is_none());

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn silent_when_no_declared_scope() {
        let tmp = std::env::temp_dir().join(format!("aura-recon-{}", BlockId::new().0));
        let blocks = tmp.join("blocks");
        // A block with an EMPTY declared scope is not a candidate.
        declared_block(&blocks, &[], OffsetDateTime::UNIX_EPOCH);

        assert!(reconcile_commit(&blocks, &["anything.js".into()]).is_none());

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn picks_newest_declared_block() {
        let tmp = std::env::temp_dir().join(format!("aura-recon-{}", BlockId::new().0));
        let blocks = tmp.join("blocks");
        declared_block(&blocks, &["old.js"], OffsetDateTime::UNIX_EPOCH);
        let newer = OffsetDateTime::from_unix_timestamp(1_700_000_000).unwrap();
        declared_block(&blocks, &["new.js"], newer);

        let recon = reconcile_commit(&blocks, &["new.js".into()]).expect("a block");
        // Reconciled the NEWER block (declared new.js), so no divergence.
        assert_eq!(recon.declared, vec!["new.js".to_string()]);
        assert!(!recon.diverged());

        let _ = std::fs::remove_dir_all(&tmp);
    }
}
