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
//! Reconciliation runs ONLY when something declared a non-empty write scope
//! since the last commit. No scope claim ⇒ nothing to diverge from ⇒ silent,
//! so a plain intent with no `writes` never produces noise.
//!
//! Two things this used to get wrong, both of which made it accuse the
//! innocent:
//!
//!   * **It had no sense of when.** It took the newest block whose
//!     `actual_impacts` was still `None`, however old that block was. Blocks
//!     go unreconciled for all sorts of ordinary reasons, so a scope sealed
//!     weeks ago would be matched against today's staged files and every file
//!     in today's commit read as undeclared. The report named real files and
//!     quoted a real intent, which is what made it convincing and wrong.
//!     `since` — the commit time of `HEAD` — is the fix: a declaration made
//!     before the last commit already answered for that commit.
//!   * **It only read `.aura/blocks`.** `aura log-intent --writes` appends
//!     `writes_paths` to `.aura/intent_log.jsonl` and seals no block, so every
//!     scope declared through the CLI — which is how agents declare scope —
//!     was invisible here. Declaring your files correctly and then being told
//!     you declared nothing teaches exactly one lesson, and it is to reach for
//!     `AURA_SKIP`. Log declarations now count, and a divergence is reported
//!     off them even when no block was sealed at all.
//!
//! Binding heuristic: among candidates from `since` onward we take the newest
//! signed block that still has `actual_impacts == None` and a non-empty
//! declared scope, unioned with every scope the log declared in that window.
//! The common flow is log-intent-then-commit. A precise intent→commit binding
//! is a later refinement.

use aura_blocks::{Block, DeclaredImpacts};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use crate::intent_query::parse_intent_line;
use crate::why_gate::{covered_by, normalize_path};

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

/// Find the newest signed intent block that (a) still has no `actual_impacts`,
/// (b) declared a non-empty write scope, and (c) was sealed at or after
/// `since`. Returns its on-disk path and the parsed block. Newest = greatest
/// `created_at`. `None` when there's nothing to reconcile.
fn newest_unreconciled_declared_block(blocks_dir: &Path, since: u64) -> Option<(PathBuf, Block)> {
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
        // And only ones from this commit's window. Without this an old block
        // that was never reconciled sits at the front of the queue forever and
        // answers for every commit after it.
        if block.created_at.unix_timestamp() < since as i64 {
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

/// Scopes declared through the CLI since `since`, newest row last.
///
/// `aura log-intent --writes a.rs,b.rs` puts those paths in a
/// `writes_paths` array on one `.aura/intent_log.jsonl` row and seals no
/// block. That is the ordinary way an agent declares scope, so it has to
/// count here. Returns the union of every such row in the window, plus the
/// summary of the last row that declared anything — the sentence to quote
/// back when the commit turns out to have gone further.
fn declared_in_log(log_text: &str, since: u64) -> (Vec<String>, Option<String>) {
    let mut paths: Vec<String> = Vec::new();
    let mut seen: BTreeSet<String> = BTreeSet::new();
    let mut summary: Option<String> = None;
    for line in log_text.lines() {
        let row = match parse_intent_line(line) {
            Some(r) => r,
            None => continue,
        };
        if row.timestamp < since {
            continue;
        }
        let value: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let arr = match value.get("writes_paths").and_then(|w| w.as_array()) {
            Some(a) if !a.is_empty() => a.clone(),
            _ => continue,
        };
        let mut declared_any = false;
        for p in arr.iter().filter_map(|p| p.as_str()) {
            let p = normalize_path(p);
            if p.is_empty() {
                continue;
            }
            declared_any = true;
            if seen.insert(p.clone()) {
                paths.push(p);
            }
        }
        if declared_any {
            summary = Some(row.intent.clone());
        }
    }
    (paths, summary)
}

/// Stamp `actual_writes` into the newest unreconciled declared-scope block,
/// persist it back to disk + mirror it into the git-tracked `.aura/attest/`
/// dir, and return the divergence report. `None` when nothing declared a
/// scope for this commit.
///
/// `intent_log_text` is the whole of `.aura/intent_log.jsonl` and `since` the
/// commit time of `HEAD`; together they decide which declarations are about
/// this commit rather than a previous one.
///
/// Persisting `actual_impacts` does NOT break the block's signature —
/// `actual_impacts` is a reducer-maintained field stripped from the signing
/// canonical form (see `aura_blocks::canonicalize_for_signing`, whose
/// `MUTABLE_TOPLEVEL_KEYS` includes `actual_impacts`). The signature keeps
/// verifying; the record just becomes complete.
pub fn reconcile_commit(
    blocks_dir: &Path,
    actual_writes: &[String],
    intent_log_text: &str,
    since: u64,
) -> Option<Reconciliation> {
    let (log_declared, log_summary) = declared_in_log(intent_log_text, since);
    let sealed = newest_unreconciled_declared_block(blocks_dir, since);
    if sealed.is_none() && log_declared.is_empty() {
        return None;
    }

    // Everything anybody claimed for this commit, from either surface. A file
    // named on either side is declared; requiring it on both would fail the
    // agent that used one of the two supported ways to say so.
    let mut declared: Vec<String> = Vec::new();
    let mut seen: BTreeSet<String> = BTreeSet::new();
    for p in sealed
        .iter()
        .flat_map(|(_, b)| b.declared_impacts.writes_paths.iter())
        .map(|p| normalize_path(p))
        .chain(log_declared.into_iter())
    {
        if !p.is_empty() && seen.insert(p.clone()) {
            declared.push(p);
        }
    }

    let actual: Vec<String> = actual_writes.to_vec();
    let undeclared: Vec<String> = actual
        .iter()
        .map(|p| normalize_path(p))
        .filter(|p| !p.is_empty())
        .filter(|p| !covered_by(&seen, p))
        .collect();

    let actual_impacts = DeclaredImpacts {
        writes_paths: actual.clone(),
        ..Default::default()
    };

    // Only a sealed block has somewhere to record the outcome. A log-only
    // declaration still produces the report; there is simply no block to
    // stamp, and inventing one to hold the stamp would put an unsigned record
    // in the place signed records live.
    let (block_id, intent_summary) = match sealed {
        Some((path, mut block)) => {
            let id = block.id.0.to_string();
            let summary = block.intent.summary.clone();
            block.actual_impacts = Some(actual_impacts);
            block.updated_at = time::OffsetDateTime::now_utc();
            // Best-effort persist: a write failure must not break the commit —
            // the in-memory report is still returned so the user still sees
            // the catch.
            if let Ok(json) = serde_json::to_string_pretty(&block) {
                let _ = std::fs::write(&path, json);
            }
            crate::intent_block::mirror_block_to_attest(&id);
            (id, summary)
        }
        None => (
            String::new(),
            log_summary.unwrap_or_else(|| "(declared via aura log-intent --writes)".to_string()),
        ),
    };

    Some(Reconciliation {
        block_id,
        intent_summary,
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

    /// One `.aura/intent_log.jsonl` row of the shape `aura log-intent
    /// --writes` appends: a scope claim with no signed block behind it.
    fn log_row(ts: u64, summary: &str, writes: &[&str]) -> String {
        let arr = writes
            .iter()
            .map(|w| format!("\"{w}\""))
            .collect::<Vec<_>>()
            .join(",");
        format!(
            r#"{{"timestamp":{ts},"agent_id":"claude","intent":"{summary}","writes_paths":[{arr}]}}"#
        )
    }

    #[test]
    fn catches_undeclared_write() {
        let tmp = std::env::temp_dir().join(format!("aura-recon-{}", BlockId::new().0));
        let blocks = tmp.join("blocks");
        declared_block(&blocks, &["app.js"], OffsetDateTime::UNIX_EPOCH);

        // Commit actually touched app.js AND recipes.js — recipes.js undeclared.
        let recon = reconcile_commit(&blocks, &["app.js".into(), "recipes.js".into()], "", 0)
            .expect("a block");
        assert!(recon.diverged());
        assert_eq!(recon.undeclared, vec!["recipes.js".to_string()]);

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn clean_when_within_scope() {
        let tmp = std::env::temp_dir().join(format!("aura-recon-{}", BlockId::new().0));
        let blocks = tmp.join("blocks");
        declared_block(&blocks, &["app.js", "index.html"], OffsetDateTime::UNIX_EPOCH);

        let recon = reconcile_commit(&blocks, &["app.js".into()], "", 0).expect("a block");
        assert!(!recon.diverged());
        assert!(recon.undeclared.is_empty());

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn stamps_actual_impacts_onto_block() {
        let tmp = std::env::temp_dir().join(format!("aura-recon-{}", BlockId::new().0));
        let blocks = tmp.join("blocks");
        let id = declared_block(&blocks, &["app.js"], OffsetDateTime::UNIX_EPOCH);

        reconcile_commit(&blocks, &["app.js".into(), "extra.js".into()], "", 0);

        // The block on disk now carries actual_impacts (it was None before) —
        // this is the fix for "0/1196 attestations ever computed actual".
        let reloaded =
            crate::intent_block::load_signed_block(&blocks.join(format!("{}.json", id.0))).unwrap();
        let actual = reloaded.actual_impacts.expect("actual_impacts populated");
        assert_eq!(actual.writes_paths, vec!["app.js".to_string(), "extra.js".to_string()]);

        // Reconciling again is a no-op — already reconciled, not re-picked.
        assert!(reconcile_commit(&blocks, &["whatever.js".into()], "", 0).is_none());

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn silent_when_no_declared_scope() {
        let tmp = std::env::temp_dir().join(format!("aura-recon-{}", BlockId::new().0));
        let blocks = tmp.join("blocks");
        // A block with an EMPTY declared scope is not a candidate.
        declared_block(&blocks, &[], OffsetDateTime::UNIX_EPOCH);

        assert!(reconcile_commit(&blocks, &["anything.js".into()], "", 0).is_none());

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn picks_newest_declared_block() {
        let tmp = std::env::temp_dir().join(format!("aura-recon-{}", BlockId::new().0));
        let blocks = tmp.join("blocks");
        declared_block(&blocks, &["old.js"], OffsetDateTime::UNIX_EPOCH);
        let newer = OffsetDateTime::from_unix_timestamp(1_700_000_000).unwrap();
        declared_block(&blocks, &["new.js"], newer);

        let recon = reconcile_commit(&blocks, &["new.js".into()], "", 0).expect("a block");
        // Reconciled the NEWER block (declared new.js), so no divergence.
        assert_eq!(recon.declared, vec!["new.js".to_string()]);
        assert!(!recon.diverged());

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn a_block_from_before_the_last_commit_does_not_answer_for_this_one() {
        // The false accusation this fixes: an old unreconciled block sat at
        // the front of the queue and every later commit was measured against
        // a scope declared for something else entirely.
        let tmp = std::env::temp_dir().join(format!("aura-recon-{}", BlockId::new().0));
        let blocks = tmp.join("blocks");
        let stale = OffsetDateTime::from_unix_timestamp(1_000).unwrap();
        declared_block(&blocks, &["something-else.js"], stale);

        assert!(reconcile_commit(&blocks, &["app.js".into()], "", 5_000).is_none());

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn a_scope_declared_through_the_cli_counts_even_with_no_block() {
        // `aura log-intent --writes` seals no block. Before this, declaring
        // your files that way was the same as declaring nothing.
        let tmp = std::env::temp_dir().join(format!("aura-recon-{}", BlockId::new().0));
        let blocks = tmp.join("blocks");
        std::fs::create_dir_all(&blocks).unwrap();
        let log = log_row(6_000, "why app.js changed", &["app.js"]);

        let recon =
            reconcile_commit(&blocks, &["app.js".into()], &log, 5_000).expect("a declaration");
        assert!(!recon.diverged());
        assert_eq!(recon.declared, vec!["app.js".to_string()]);
        assert_eq!(recon.intent_summary, "why app.js changed");

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn a_cli_declaration_still_catches_the_file_it_left_out() {
        let tmp = std::env::temp_dir().join(format!("aura-recon-{}", BlockId::new().0));
        let blocks = tmp.join("blocks");
        std::fs::create_dir_all(&blocks).unwrap();
        let log = log_row(6_000, "why app.js changed", &["app.js"]);

        let recon = reconcile_commit(&blocks, &["app.js".into(), "sneaky.js".into()], &log, 5_000)
            .expect("a declaration");
        assert!(recon.diverged());
        assert_eq!(recon.undeclared, vec!["sneaky.js".to_string()]);

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn a_cli_declaration_from_before_the_last_commit_does_not_count() {
        let tmp = std::env::temp_dir().join(format!("aura-recon-{}", BlockId::new().0));
        let blocks = tmp.join("blocks");
        std::fs::create_dir_all(&blocks).unwrap();
        let log = log_row(1_000, "why app.js changed last time", &["app.js"]);

        assert!(reconcile_commit(&blocks, &["app.js".into()], &log, 5_000).is_none());

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn a_block_and_the_log_both_speak_for_the_commit() {
        // Half declared in a sealed block, half through the CLI. Requiring
        // one surface to carry the whole scope would fail an agent that used
        // both supported ways to say the same thing.
        let tmp = std::env::temp_dir().join(format!("aura-recon-{}", BlockId::new().0));
        let blocks = tmp.join("blocks");
        let fresh = OffsetDateTime::from_unix_timestamp(6_000).unwrap();
        declared_block(&blocks, &["app.js"], fresh);
        let log = log_row(6_100, "and index.html too", &["index.html"]);

        let recon = reconcile_commit(&blocks, &["app.js".into(), "index.html".into()], &log, 5_000)
            .expect("a declaration");
        assert!(!recon.diverged());

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn a_path_declared_from_inside_a_subdirectory_still_counts() {
        // The agent working in `aura-shell/` writes the path it sees. Both
        // guards read these rows, so both have to read them the same way.
        let tmp = std::env::temp_dir().join(format!("aura-recon-{}", BlockId::new().0));
        let blocks = tmp.join("blocks");
        std::fs::create_dir_all(&blocks).unwrap();
        let log = log_row(6_000, "why it changed", &["src/lib/thing.ts"]);

        let recon = reconcile_commit(&blocks, &["aura-shell/src/lib/thing.ts".into()], &log, 5_000)
            .expect("a declaration");
        assert!(!recon.diverged());

        let _ = std::fs::remove_dir_all(&tmp);
    }
}
