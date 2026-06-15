// W3 — reconcile-on-write (AURA-41).
//
// Every entry write now passes through `reconcile_write` so the store stops
// accreting duplicates and contradictions. The pipeline, in order:
//
//   1. idempotent dedup (cognee) — sha256 of the NORMALIZED content (trim,
//      collapse whitespace, lowercase) compared against every LIVE entry in
//      the target section. Hash match → NOOP, the existing id is returned
//      and nothing is written;
//   2. candidate retrieval — the W1 hybrid ranker (`memory_retrieval.rs`)
//      runs over the section's live entries with the new content as the
//      query; survivors must clear a token-Jaccard similarity floor and at
//      most `MAX_CANDIDATES` are kept;
//   3. decision (mem0 op set) — when candidates exist the configured LLM is
//      asked to pick exactly one of ADD / UPDATE(target) / DELETE(target) /
//      NOOP with a one-line reason, replying in strict JSON. ANY failure on
//      this leg (no API key, network error, malformed JSON, an op the
//      schema doesn't allow, a target id that isn't one of the candidates)
//      degrades to ADD — reconcile must never block or lose a write. With
//      no key at all the only non-ADD outcome is the exact-hash NOOP from
//      step 1;
//   4. supersede, never delete (Zep) — UPDATE and DELETE close the old
//      entry's bi-temporal window (`valid_to = now`, W2 field) instead of
//      removing it; UPDATE additionally writes the new entry with
//      `supersedes` pointing back at the closed one. Superseded rows stay
//      in memory.json as an audit trail and are excluded from default
//      recall (see `ranked_search` vs `ranked_search_all`).

use sha2::{Digest, Sha256};

use crate::memory::{provenance, retrieval, MemoryEntry, ProjectMemory};

/// How many similar live entries the decision step may see.
pub const MAX_CANDIDATES: usize = 3;
/// Token-set Jaccard floor a ranked hit must clear to count as a candidate.
/// 0.30 ≈ "shares roughly a third of its vocabulary" — low enough to catch
/// restatements, high enough that a single shared word doesn't trigger an
/// LLM round-trip on every write.
pub const SIMILARITY_FLOOR: f64 = 0.30;

// ── Normalization + hashing ──

/// Canonical form used for idempotent dedup: trim, collapse internal
/// whitespace runs to a single space, lowercase.
pub fn normalize_content(content: &str) -> String {
    content
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

/// sha256 (hex) of the normalized content — the identity used by step 1.
pub fn content_hash(content: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(normalize_content(content).as_bytes());
    hex::encode(hasher.finalize())
}

/// Token-set Jaccard similarity over the W1 tokenizer's output. Symmetric,
/// in [0, 1]; both-empty counts as 0 (nothing to be similar about).
pub fn jaccard_similarity(a: &str, b: &str) -> f64 {
    let ta: std::collections::HashSet<String> = retrieval::tokenize(a).into_iter().collect();
    let tb: std::collections::HashSet<String> = retrieval::tokenize(b).into_iter().collect();
    if ta.is_empty() || tb.is_empty() {
        return 0.0;
    }
    let inter = ta.intersection(&tb).count() as f64;
    let union = ta.union(&tb).count() as f64;
    inter / union
}

// ── Outcome types ──

/// What the write actually did, surfaced to the CLI / MCP caller.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReconcileOp {
    /// A new entry was appended.
    Added,
    /// A new entry was appended AND it supersedes an older one (the old
    /// entry's `valid_to` is now closed, the new one's `supersedes` points
    /// back at it).
    Updated,
    /// The new fact invalidated an existing entry without adding new
    /// knowledge: the old entry's window was closed, nothing was appended.
    Deleted,
    /// Nothing was written (exact duplicate, or the model judged the fact
    /// already covered).
    Noop,
}

/// Full result of one reconciled write.
#[derive(Debug, Clone)]
pub struct ReconcileOutcome {
    pub op: ReconcileOp,
    /// The id the caller should reference: the new entry for Added/Updated,
    /// the existing duplicate/covering entry for Noop, the closed entry for
    /// Deleted.
    pub id: String,
    /// Old entry whose validity window was closed (Updated / Deleted).
    pub superseded: Option<String>,
    /// One-line explanation of why this op was chosen.
    pub reason: String,
    /// Whether the store was mutated (caller persists only when true).
    pub changed: bool,
}

// ── Candidates ──

/// One live entry similar enough to the incoming content to be worth a
/// reconcile decision.
#[derive(Debug, Clone)]
pub struct Candidate {
    pub id: String,
    pub content: String,
    pub similarity: f64,
}

/// Rank the section's LIVE entries against the new content via the W1
/// hybrid ranker, then keep the top `MAX_CANDIDATES` that clear
/// `SIMILARITY_FLOOR` (token Jaccard — RRF scores are rank-derived and not
/// comparable across corpus sizes, so the floor is applied on a normalized
/// content measure instead).
pub fn find_candidates(
    live: &[&MemoryEntry],
    content: &str,
    query_embedding: Option<&[f32]>,
) -> Vec<Candidate> {
    if live.is_empty() {
        return Vec::new();
    }
    // Temp single-section store: the ranker only needs content/tags/
    // embedding/added_at, the section label is irrelevant here.
    let tmp = ProjectMemory {
        context: live.iter().map(|e| (*e).clone()).collect(),
        ..Default::default()
    };
    retrieval::ranked_search(&tmp, content, query_embedding)
        .into_iter()
        .filter_map(|r| {
            let sim = jaccard_similarity(content, &r.content);
            if sim >= SIMILARITY_FLOOR {
                Some(Candidate { id: r.id, content: r.content, similarity: sim })
            } else {
                None
            }
        })
        .take(MAX_CANDIDATES)
        .collect()
}

// ── Decision ──

/// The mem0-style op chosen for an incoming fact.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    Add,
    Update(String),
    Delete(String),
    /// `Some(id)` when the model named which entry already covers the fact.
    Noop(Option<String>),
}

/// Build the strict-JSON decision prompt shown to the model.
pub fn decision_prompt(section: &str, content: &str, candidates: &[Candidate]) -> String {
    let mut listed = String::new();
    for c in candidates {
        listed.push_str(&format!("  - id={} content=\"{}\"\n", c.id, c.content));
    }
    format!(
        "You maintain a project memory store. A new fact is being written to the \
         '{}' section.\n\
         NEW FACT: \"{}\"\n\
         EXISTING similar memories:\n{}\
         Pick exactly ONE operation:\n\
         - ADD: the fact is genuinely new information\n\
         - UPDATE: the fact restates or supersedes exactly one existing memory (set target_id)\n\
         - DELETE: the fact invalidates an existing memory without adding new knowledge (set target_id)\n\
         - NOOP: the fact is already fully covered (target_id optional)\n\
         Reply with ONLY strict JSON, nothing else:\n\
         {{\"op\":\"ADD|UPDATE|DELETE|NOOP\",\"target_id\":\"<id or null>\",\"reason\":\"one line\"}}",
        section, content, listed
    )
}

/// Parse the model's reply. Returns None on anything that isn't a clean,
/// in-schema decision — the caller then falls back to ADD. UPDATE/DELETE
/// targets MUST be one of the candidate ids; an id the model hallucinated
/// is treated as a parse failure, never trusted.
pub fn parse_decision(raw: &str, candidate_ids: &[&str]) -> Option<(Decision, String)> {
    let json_str = raw
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();
    let v: serde_json::Value = serde_json::from_str(json_str).ok()?;
    let op = v["op"].as_str()?.to_uppercase();
    let target = v["target_id"].as_str().map(|s| s.to_string()).filter(|s| !s.is_empty());
    let reason = v["reason"].as_str().unwrap_or("").to_string();
    let decision = match op.as_str() {
        "ADD" => Decision::Add,
        "NOOP" => Decision::Noop(target.filter(|t| candidate_ids.contains(&t.as_str()))),
        "UPDATE" => {
            let t = target?;
            if !candidate_ids.contains(&t.as_str()) {
                return None;
            }
            Decision::Update(t)
        }
        "DELETE" => {
            let t = target?;
            if !candidate_ids.contains(&t.as_str()) {
                return None;
            }
            Decision::Delete(t)
        }
        _ => return None,
    };
    Some((decision, reason))
}

/// Ask the model (via the injected `ai` closure — production passes
/// `MemoryManager::call_ai`, tests pass a stub) to pick an op. EVERY
/// failure mode — keyless `Err`, network `Err`, unparseable reply,
/// out-of-schema op, hallucinated target — degrades to ADD so a write is
/// never blocked and reconcile can never lose data on a bad decision.
pub fn decide(
    section: &str,
    content: &str,
    candidates: &[Candidate],
    ai: &dyn Fn(&str) -> Result<String, String>,
) -> (Decision, String) {
    if candidates.is_empty() {
        return (Decision::Add, "no similar live entries".to_string());
    }
    let prompt = decision_prompt(section, content, candidates);
    match ai(&prompt) {
        Ok(reply) => {
            let ids: Vec<&str> = candidates.iter().map(|c| c.id.as_str()).collect();
            match parse_decision(&reply, &ids) {
                Some((d, reason)) => (d, reason),
                None => (
                    Decision::Add,
                    "unparseable reconcile reply — defaulted to add".to_string(),
                ),
            }
        }
        // No key / provider unreachable: heuristic path. The exact-hash
        // NOOP already ran in step 1, so everything else is an ADD.
        Err(e) => (Decision::Add, format!("no reconcile model available ({}) — added", e)),
    }
}

// ── Apply ──

/// Resolve a section name to its entry vec — same aliases the legacy write
/// path accepted (unknown names land in `context`).
pub fn section_entries_mut<'a>(
    mem: &'a mut ProjectMemory,
    section: &str,
) -> &'a mut Vec<MemoryEntry> {
    match section {
        "convention" | "conventions" => &mut mem.conventions,
        "gotcha" | "gotchas" => &mut mem.gotchas,
        "active" | "active_work" => &mut mem.active_work,
        _ => &mut mem.context,
    }
}

/// Build a fresh provenance-stamped entry (W2 stamp + optional symbol
/// fingerprint), exactly as the pre-W3 write path did.
fn build_entry(
    content: &str,
    tags: Vec<String>,
    author: &str,
    symbol: Option<&str>,
    supersedes: Option<String>,
    now: u64,
) -> MemoryEntry {
    let stamp = provenance::capture();
    let (source_symbol, source_symbol_hash) = match symbol {
        Some(s) => provenance::stamp_symbol(s),
        None => (None, None),
    };
    MemoryEntry {
        id: format!("mem-{}", &uuid::Uuid::new_v4().to_string()[..8]),
        content: content.to_string(),
        tags,
        added_by: author.to_string(),
        added_at: now,
        source_commit: stamp.source_commit,
        intent_id: stamp.intent_id,
        signer_key_id: stamp.signer_key_id,
        valid_from: stamp.valid_from,
        source_symbol,
        source_symbol_hash,
        supersedes,
        ..Default::default()
    }
}

/// The full reconcile-on-write pipeline over an in-memory store. Pure with
/// respect to disk: the caller (`MemoryManager::add_entry_reconciled`)
/// loads/saves; tests drive a `ProjectMemory` directly. `ai` and `embed`
/// are injected so the decision and semantic legs are controllable.
#[allow(clippy::too_many_arguments)]
pub fn reconcile_write(
    mem: &mut ProjectMemory,
    section: &str,
    content: &str,
    tags: Vec<String>,
    author: &str,
    symbol: Option<&str>,
    now: u64,
    ai: &dyn Fn(&str) -> Result<String, String>,
    embed: &dyn Fn(&str) -> Option<Vec<f32>>,
) -> ReconcileOutcome {
    let hash = content_hash(content);

    // ── Step 1: idempotent dedup against LIVE entries only. A superseded
    // row with the same hash does NOT block the write — re-asserting an
    // old, closed fact legitimately re-opens it as a fresh entry. ──
    {
        let entries = section_entries_mut(mem, section);
        if let Some(existing) = entries
            .iter()
            .find(|e| e.valid_to.is_none() && content_hash(&e.content) == hash)
        {
            return ReconcileOutcome {
                op: ReconcileOp::Noop,
                id: existing.id.clone(),
                superseded: None,
                reason: "exact duplicate (normalized content hash match)".to_string(),
                changed: false,
            };
        }
    }

    // ── Step 2: candidates from the W1 ranker over live entries. The
    // embedding is attempted once for the incoming content; None (no key)
    // simply drops the semantic leg. ──
    let query_embedding = embed(content);
    let candidates = {
        let entries = section_entries_mut(mem, section);
        let live: Vec<&MemoryEntry> = entries.iter().filter(|e| e.valid_to.is_none()).collect();
        find_candidates(&live, content, query_embedding.as_deref())
    };

    // ── Step 3: decision. ──
    let (decision, reason) = decide(section, content, &candidates, ai);

    // ── Step 4: apply — supersede, never delete. ──
    let now_rfc3339 = chrono::Utc::now().to_rfc3339();
    match decision {
        Decision::Add => {
            let entry = build_entry(content, tags, author, symbol, None, now);
            let id = entry.id.clone();
            section_entries_mut(mem, section).push(entry);
            ReconcileOutcome {
                op: ReconcileOp::Added,
                id,
                superseded: None,
                reason,
                changed: true,
            }
        }
        Decision::Update(target) => {
            let entries = section_entries_mut(mem, section);
            // The target is guaranteed live (candidates only nominate live
            // entries) — close its window, then append the successor.
            match entries.iter_mut().find(|e| e.id == target) {
                Some(old) => {
                    old.valid_to = Some(now_rfc3339);
                    let entry =
                        build_entry(content, tags, author, symbol, Some(target.clone()), now);
                    let id = entry.id.clone();
                    entries.push(entry);
                    ReconcileOutcome {
                        op: ReconcileOp::Updated,
                        id,
                        superseded: Some(target),
                        reason,
                        changed: true,
                    }
                }
                // Target vanished between candidate retrieval and apply
                // (can't happen single-threaded, but never lose the write).
                None => {
                    let entry = build_entry(content, tags, author, symbol, None, now);
                    let id = entry.id.clone();
                    entries.push(entry);
                    ReconcileOutcome {
                        op: ReconcileOp::Added,
                        id,
                        superseded: None,
                        reason: format!("update target {} not found — added instead", target),
                        changed: true,
                    }
                }
            }
        }
        Decision::Delete(target) => {
            let entries = section_entries_mut(mem, section);
            match entries.iter_mut().find(|e| e.id == target) {
                Some(old) => {
                    old.valid_to = Some(now_rfc3339);
                    ReconcileOutcome {
                        op: ReconcileOp::Deleted,
                        id: target,
                        superseded: None,
                        reason,
                        changed: true,
                    }
                }
                None => {
                    let entry = build_entry(content, tags, author, symbol, None, now);
                    let id = entry.id.clone();
                    entries.push(entry);
                    ReconcileOutcome {
                        op: ReconcileOp::Added,
                        id,
                        superseded: None,
                        reason: format!("delete target {} not found — added instead", target),
                        changed: true,
                    }
                }
            }
        }
        Decision::Noop(covering) => {
            let id = covering
                .or_else(|| candidates.first().map(|c| c.id.clone()))
                .unwrap_or_default();
            ReconcileOutcome {
                op: ReconcileOp::Noop,
                id,
                superseded: None,
                reason,
                changed: false,
            }
        }
    }
}

// ── Supersession chain (for `aura memory why`) ──

/// Who superseded `id`, if anyone (the entry whose `supersedes` points at
/// it). Scans all four entry sections.
pub fn superseded_by(mem: &ProjectMemory, id: &str) -> Option<String> {
    all_entries(mem)
        .find(|e| e.supersedes.as_deref() == Some(id))
        .map(|e| e.id.clone())
}

/// The full supersession chain through `id`, oldest first. Walks
/// `supersedes` pointers backward and "who points at me" forward; a lone
/// entry yields a single-element chain. Cycle-guarded (corrupt files must
/// not hang `why`).
pub fn supersession_chain(mem: &ProjectMemory, id: &str) -> Vec<String> {
    let mut chain = vec![id.to_string()];
    let mut seen: std::collections::HashSet<String> = chain.iter().cloned().collect();

    // Backward: what does the head of the chain supersede?
    loop {
        let head = chain[0].clone();
        let prev = all_entries(mem)
            .find(|e| e.id == head)
            .and_then(|e| e.supersedes.clone());
        match prev {
            Some(p) if seen.insert(p.clone()) => chain.insert(0, p),
            _ => break,
        }
    }
    // Forward: who supersedes the tail?
    loop {
        let tail = chain[chain.len() - 1].clone();
        match superseded_by(mem, &tail) {
            Some(n) if seen.insert(n.clone()) => chain.push(n),
            _ => break,
        }
    }
    chain
}

fn all_entries(mem: &ProjectMemory) -> impl Iterator<Item = &MemoryEntry> {
    mem.conventions
        .iter()
        .chain(&mem.gotchas)
        .chain(&mem.context)
        .chain(&mem.active_work)
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: u64 = 1_760_000_000;

    fn no_ai(_p: &str) -> Result<String, String> {
        Err("No API key found".to_string())
    }
    fn no_embed(_t: &str) -> Option<Vec<f32>> {
        None
    }

    fn write(
        mem: &mut ProjectMemory,
        content: &str,
        ai: &dyn Fn(&str) -> Result<String, String>,
    ) -> ReconcileOutcome {
        reconcile_write(mem, "context", content, vec![], "test", None, NOW, ai, &no_embed)
    }

    #[test]
    fn normalize_collapses_whitespace_and_case() {
        assert_eq!(normalize_content("  Retry   uses\tBackoff \n"), "retry uses backoff");
        assert_eq!(content_hash("  Retry   uses Backoff "), content_hash("retry uses backoff"));
        assert_ne!(content_hash("retry uses backoff"), content_hash("retry uses linear"));
    }

    #[test]
    fn jaccard_basics() {
        assert!((jaccard_similarity("a b c", "a b c") - 1.0).abs() < 1e-12);
        assert_eq!(jaccard_similarity("a b", "x y"), 0.0);
        assert_eq!(jaccard_similarity("", "a"), 0.0);
        // 2 shared of 4 union.
        assert!((jaccard_similarity("a b c", "a b d") - 0.5).abs() < 1e-12);
    }

    #[test]
    fn exact_duplicate_is_noop_even_when_normalized_differently() {
        let mut mem = ProjectMemory::default();
        let first = write(&mut mem, "Retry logic uses exponential backoff", &no_ai);
        assert_eq!(first.op, ReconcileOp::Added);
        assert!(first.changed);
        assert_eq!(mem.context.len(), 1);

        // Byte-identical duplicate.
        let dup = write(&mut mem, "Retry logic uses exponential backoff", &no_ai);
        assert_eq!(dup.op, ReconcileOp::Noop);
        assert!(!dup.changed);
        assert_eq!(dup.id, first.id, "noop must reference the existing entry");
        assert_eq!(mem.context.len(), 1, "nothing appended");

        // Whitespace/case variant — still the same normalized hash.
        let dup2 = write(&mut mem, "  retry   LOGIC uses  exponential backoff ", &no_ai);
        assert_eq!(dup2.op, ReconcileOp::Noop);
        assert_eq!(mem.context.len(), 1);
    }

    #[test]
    fn keyless_path_adds_similar_but_not_identical_content() {
        // No LLM: a restatement must NOT update/supersede — only an exact
        // hash can noop, everything else adds. Data is never lost silently.
        let mut mem = ProjectMemory::default();
        let a = write(&mut mem, "retry logic uses exponential backoff", &no_ai);
        let b = write(&mut mem, "retry logic now uses linear backoff", &no_ai);
        assert_eq!(a.op, ReconcileOp::Added);
        assert_eq!(b.op, ReconcileOp::Added);
        assert_eq!(mem.context.len(), 2);
        assert!(mem.context.iter().all(|e| e.valid_to.is_none()), "no supersession without a model");
        assert!(mem.context.iter().all(|e| e.supersedes.is_none()));
    }

    #[test]
    fn llm_update_builds_supersession_chain() {
        let mut mem = ProjectMemory::default();
        let old = write(&mut mem, "retry logic uses exponential backoff", &no_ai);

        let old_id = old.id.clone();
        let ai = move |_p: &str| -> Result<String, String> {
            Ok(format!(
                "{{\"op\":\"UPDATE\",\"target_id\":\"{}\",\"reason\":\"restates retry policy\"}}",
                old_id
            ))
        };
        let upd = write(&mut mem, "retry logic now uses linear backoff", &ai);

        assert_eq!(upd.op, ReconcileOp::Updated);
        assert_eq!(upd.superseded.as_deref(), Some(old.id.as_str()));
        assert_eq!(mem.context.len(), 2, "old row stays — audit trail");

        let old_row = mem.context.iter().find(|e| e.id == old.id).unwrap();
        assert!(old_row.valid_to.is_some(), "old entry's window must be closed");
        let new_row = mem.context.iter().find(|e| e.id == upd.id).unwrap();
        assert_eq!(new_row.supersedes.as_deref(), Some(old.id.as_str()));
        assert!(new_row.valid_to.is_none());

        // Chain reads oldest → newest from either end.
        assert_eq!(supersession_chain(&mem, &old.id), vec![old.id.clone(), upd.id.clone()]);
        assert_eq!(supersession_chain(&mem, &upd.id), vec![old.id.clone(), upd.id.clone()]);
        assert_eq!(superseded_by(&mem, &old.id).as_deref(), Some(upd.id.as_str()));
        assert_eq!(superseded_by(&mem, &upd.id), None);
    }

    #[test]
    fn llm_delete_closes_window_without_appending() {
        let mut mem = ProjectMemory::default();
        let old = write(&mut mem, "the staging cluster lives in us-east-1", &no_ai);

        let old_id = old.id.clone();
        let ai = move |_p: &str| -> Result<String, String> {
            Ok(format!(
                "{{\"op\":\"DELETE\",\"target_id\":\"{}\",\"reason\":\"cluster decommissioned\"}}",
                old_id
            ))
        };
        let del = write(&mut mem, "the staging cluster in us-east-1 was decommissioned", &ai);

        assert_eq!(del.op, ReconcileOp::Deleted);
        assert_eq!(mem.context.len(), 1, "delete never appends");
        assert!(mem.context[0].valid_to.is_some(), "row stays, window closed");
    }

    #[test]
    fn llm_noop_writes_nothing() {
        let mut mem = ProjectMemory::default();
        let old = write(&mut mem, "tests run with cargo test in aura-cli", &no_ai);
        let ai = |_p: &str| -> Result<String, String> {
            Ok("{\"op\":\"NOOP\",\"target_id\":null,\"reason\":\"already covered\"}".to_string())
        };
        let out = write(&mut mem, "cargo test runs the aura-cli tests", &ai);
        assert_eq!(out.op, ReconcileOp::Noop);
        assert!(!out.changed);
        assert_eq!(out.id, old.id, "noop points at the covering entry");
        assert_eq!(mem.context.len(), 1);
    }

    #[test]
    fn garbage_or_hallucinated_replies_degrade_to_add() {
        let mut mem = ProjectMemory::default();
        write(&mut mem, "retry logic uses exponential backoff", &no_ai);

        // Unparseable reply.
        let garbage = |_p: &str| -> Result<String, String> { Ok("sure, I'd UPDATE that!".into()) };
        let out = write(&mut mem, "retry logic uses fancy backoff", &garbage);
        assert_eq!(out.op, ReconcileOp::Added);
        assert_eq!(mem.context.len(), 2);

        // Hallucinated target id — must NOT be trusted.
        let liar = |_p: &str| -> Result<String, String> {
            Ok("{\"op\":\"DELETE\",\"target_id\":\"mem-not-a-candidate\",\"reason\":\"x\"}".into())
        };
        let out = write(&mut mem, "retry logic with hallucinated backoff", &liar);
        assert_eq!(out.op, ReconcileOp::Added);
        assert_eq!(mem.context.len(), 3);
        assert!(mem.context.iter().all(|e| e.valid_to.is_none()));
    }

    #[test]
    fn rewriting_a_superseded_fact_reopens_it_as_a_new_entry() {
        let mut mem = ProjectMemory::default();
        let old = write(&mut mem, "deploys go through jenkins", &no_ai);
        // Close it via DELETE (the restatement shares enough vocabulary to
        // clear the candidate floor, so the model is consulted).
        let old_id = old.id.clone();
        let ai = move |_p: &str| -> Result<String, String> {
            Ok(format!("{{\"op\":\"DELETE\",\"target_id\":\"{}\",\"reason\":\"gone\"}}", old_id))
        };
        let del = write(&mut mem, "deploys no longer go through jenkins", &ai);
        assert_eq!(del.op, ReconcileOp::Deleted);
        assert!(mem.context[0].valid_to.is_some());

        // Same content as the CLOSED row: hash dedup only checks live rows,
        // so this re-adds.
        let again = write(&mut mem, "deploys go through jenkins", &no_ai);
        assert_eq!(again.op, ReconcileOp::Added);
        assert_ne!(again.id, old.id);
    }

    #[test]
    fn parse_decision_strictness() {
        let ids = ["mem-1", "mem-2"];
        // Fenced JSON is tolerated (same as compact's parser).
        let (d, _) = parse_decision(
            "```json\n{\"op\":\"update\",\"target_id\":\"mem-2\",\"reason\":\"r\"}\n```",
            &ids,
        )
        .unwrap();
        assert_eq!(d, Decision::Update("mem-2".to_string()));

        // UPDATE without target → reject.
        assert!(parse_decision("{\"op\":\"UPDATE\",\"reason\":\"r\"}", &ids).is_none());
        // Unknown op → reject.
        assert!(parse_decision("{\"op\":\"MERGE\",\"target_id\":\"mem-1\"}", &ids).is_none());
        // Non-candidate target → reject.
        assert!(
            parse_decision("{\"op\":\"UPDATE\",\"target_id\":\"mem-9\",\"reason\":\"r\"}", &ids)
                .is_none()
        );
        // NOOP with a non-candidate target keeps the op, drops the id.
        let (d, _) = parse_decision(
            "{\"op\":\"NOOP\",\"target_id\":\"mem-9\",\"reason\":\"r\"}",
            &ids,
        )
        .unwrap();
        assert_eq!(d, Decision::Noop(None));
    }

    #[test]
    fn candidates_respect_floor_and_cap() {
        let mk = |id: &str, content: &str| MemoryEntry {
            id: id.to_string(),
            content: content.to_string(),
            added_by: "t".into(),
            added_at: 1,
            ..Default::default()
        };
        let e1 = mk("mem-1", "retry logic uses exponential backoff for rate limits");
        let e2 = mk("mem-2", "the ui theme is arctic blue");
        let e3 = mk("mem-3", "retry logic backoff tuning notes for rate limits");
        let live = vec![&e1, &e2, &e3];
        let cands = find_candidates(&live, "retry logic uses linear backoff for rate limits", None);
        assert!(cands.iter().any(|c| c.id == "mem-1"));
        assert!(cands.iter().any(|c| c.id == "mem-3"));
        assert!(cands.iter().all(|c| c.id != "mem-2"), "dissimilar entry must not clear the floor");
        assert!(cands.len() <= MAX_CANDIDATES);
        assert!(cands.iter().all(|c| c.similarity >= SIMILARITY_FLOOR));
    }
}
