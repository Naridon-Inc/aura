// W1 — hybrid ranked retrieval over project memory (AURA-39).
//
// Replaces the old load-all + substring scan in `MemoryManager::search`
// with three independently-ranked legs fused via Reciprocal Rank Fusion:
//
//   1. lexical  — hand-rolled BM25 (k1 = 1.2, b = 0.75) over the tokenized
//                 content + tags of every entry across all sections, with a
//                 substring fallback appended so the legacy `contains`-style
//                 recall is never lost (e.g. query "auth" still finds
//                 "authentication" even though BM25 tokens don't match);
//   2. semantic — cosine similarity between the query embedding and each
//                 entry's stored embedding. Runs ONLY when the caller could
//                 produce a query embedding (i.e. an API key is configured);
//                 without one the leg is skipped entirely — graceful
//                 degradation, never an error;
//   3. recency  — `added_at` desc over the candidate set, so newer knowledge
//                 outranks stale knowledge at equal relevance.
//
// Fusion: score(d) = Σ_legs 1 / (60 + rank_leg(d)), rank 1-based.
//
// The store is tiny (≤50 entries per section) so all scoring is in-memory —
// deliberately NO tantivy / fastembed style dependency.

use std::collections::HashMap;

use crate::memory::{MemoryEntry, ProjectMemory};

/// RRF dampening constant — the standard k = 60 from the original
/// Cormack/Clarke/Buettcher formulation.
pub const RRF_K: f64 = 60.0;
/// BM25 term-frequency saturation.
pub const BM25_K1: f64 = 1.2;
/// BM25 length normalization.
pub const BM25_B: f64 = 0.75;
/// How many documents the semantic leg may nominate into the candidate set.
const SEMANTIC_TOP_K: usize = 10;
/// Cosine floor below which a semantic hit is considered noise.
const SEMANTIC_MIN_SIM: f32 = 0.05;

/// One searchable document — a flattened view of a `MemoryEntry` plus the
/// section it came from.
#[derive(Debug, Clone)]
pub struct Doc {
    pub section: &'static str,
    pub id: String,
    pub content: String,
    pub tags: Vec<String>,
    pub added_at: u64,
    pub embedding: Option<Vec<f32>>,
    /// W3 — false when the entry's bi-temporal window is closed
    /// (`valid_to` set, i.e. superseded/invalidated). Default recall only
    /// ranks live docs.
    pub live: bool,
}

/// One fused search result, ordered by descending RRF score.
#[derive(Debug, Clone)]
pub struct RankedResult {
    pub section: &'static str,
    pub id: String,
    pub content: String,
    pub tags: Vec<String>,
    pub added_at: u64,
    /// RRF-fused score: Σ over matched legs of 1/(60 + rank).
    pub score: f64,
    /// Which legs matched this doc: "lexical", "semantic", "recency".
    pub legs: Vec<&'static str>,
}

/// Flatten the four entry sections into a single doc list. Order is stable
/// (conventions, gotchas, context, active_work — file order within each) so
/// doc indices are deterministic for a given `ProjectMemory`.
pub fn collect_docs(mem: &ProjectMemory) -> Vec<Doc> {
    let sections: [(&'static str, &Vec<MemoryEntry>); 4] = [
        ("conventions", &mem.conventions),
        ("gotchas", &mem.gotchas),
        ("context", &mem.context),
        ("active_work", &mem.active_work),
    ];
    let mut docs = Vec::new();
    for (name, entries) in sections {
        for e in entries {
            docs.push(Doc {
                section: name,
                id: e.id.clone(),
                content: e.content.clone(),
                tags: e.tags.clone(),
                added_at: e.added_at,
                embedding: e.embedding.clone(),
                live: e.valid_to.is_none(),
            });
        }
    }
    docs
}

/// Lowercase + split on non-alphanumeric. "retry_logic" → ["retry","logic"].
pub fn tokenize(text: &str) -> Vec<String> {
    text.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| !t.is_empty())
        .map(|t| t.to_string())
        .collect()
}

/// Hand-rolled BM25 over pre-tokenized documents. Returns one score per doc
/// (0.0 = no query term present). idf uses the non-negative
/// `ln(1 + (N - df + 0.5)/(df + 0.5))` variant so single-doc corpora don't
/// go negative.
pub fn bm25_scores(doc_tokens: &[Vec<String>], query_tokens: &[String]) -> Vec<f64> {
    let n_docs = doc_tokens.len();
    if n_docs == 0 || query_tokens.is_empty() {
        return vec![0.0; n_docs];
    }

    let avg_len: f64 = doc_tokens.iter().map(|d| d.len() as f64).sum::<f64>() / n_docs as f64;
    // Guard the degenerate all-empty-docs corpus.
    let avg_len = if avg_len <= 0.0 { 1.0 } else { avg_len };

    // Document frequency per query term (count each term once even if the
    // query repeats it).
    let mut unique_terms: Vec<&String> = Vec::new();
    for t in query_tokens {
        if !unique_terms.contains(&t) {
            unique_terms.push(t);
        }
    }

    let mut df: HashMap<&String, usize> = HashMap::new();
    for term in &unique_terms {
        let count = doc_tokens.iter().filter(|d| d.contains(term)).count();
        df.insert(term, count);
    }

    let mut scores = vec![0.0_f64; n_docs];
    for (i, tokens) in doc_tokens.iter().enumerate() {
        let dl = tokens.len() as f64;
        for term in &unique_terms {
            let tf = tokens.iter().filter(|t| *t == *term).count() as f64;
            if tf == 0.0 {
                continue;
            }
            let dfi = df[term] as f64;
            let idf = (1.0 + (n_docs as f64 - dfi + 0.5) / (dfi + 0.5)).ln();
            let denom = tf + BM25_K1 * (1.0 - BM25_B + BM25_B * dl / avg_len);
            scores[i] += idf * tf * (BM25_K1 + 1.0) / denom;
        }
    }
    scores
}

/// One leg's ordering: doc indices, best first.
pub type LegRanking = Vec<usize>;

/// Reciprocal Rank Fusion across named legs. Each leg is an ordered list of
/// doc indices (best first); a doc absent from a leg contributes nothing for
/// that leg. Returns `(doc_index, fused_score, matched_leg_names)` sorted by
/// score desc (ties break on lower doc index for determinism).
pub fn rrf_fuse(legs: &[(&'static str, LegRanking)]) -> Vec<(usize, f64, Vec<&'static str>)> {
    let mut scores: HashMap<usize, (f64, Vec<&'static str>)> = HashMap::new();
    for (name, ranking) in legs {
        for (rank0, doc_idx) in ranking.iter().enumerate() {
            let entry = scores.entry(*doc_idx).or_insert((0.0, Vec::new()));
            entry.0 += 1.0 / (RRF_K + (rank0 + 1) as f64);
            entry.1.push(*name);
        }
    }
    let mut fused: Vec<(usize, f64, Vec<&'static str>)> = scores
        .into_iter()
        .map(|(idx, (score, legs))| (idx, score, legs))
        .collect();
    fused.sort_by(|a, b| {
        b.1.partial_cmp(&a.1)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.0.cmp(&b.0))
    });
    fused
}

/// Lazily embed entries that don't carry a vector yet. Called by the search
/// path only after the caller proved an embedding provider is reachable (the
/// query itself embedded successfully). Returns how many entries gained an
/// embedding so the caller knows whether to persist.
pub fn backfill_embeddings(
    mem: &mut ProjectMemory,
    embed: &dyn Fn(&str) -> Option<Vec<f32>>,
) -> usize {
    let mut updated = 0;
    let sections: [&mut Vec<MemoryEntry>; 4] = [
        &mut mem.conventions,
        &mut mem.gotchas,
        &mut mem.context,
        &mut mem.active_work,
    ];
    for entries in sections {
        for e in entries.iter_mut() {
            if e.embedding.is_none() {
                let text = if e.tags.is_empty() {
                    e.content.clone()
                } else {
                    format!("{} {}", e.content, e.tags.join(" "))
                };
                if let Some(v) = embed(&text) {
                    e.embedding = Some(v);
                    updated += 1;
                }
            }
        }
    }
    updated
}

/// Hybrid ranked search over LIVE entries only — superseded rows (W3,
/// `valid_to` set) never surface here. `query_embedding = None` skips the
/// semantic leg entirely (no API key configured) — lexical + recency still
/// rank.
pub fn ranked_search(
    mem: &ProjectMemory,
    query: &str,
    query_embedding: Option<&[f32]>,
) -> Vec<RankedResult> {
    ranked_search_opts(mem, query, query_embedding, false)
}

/// W3 — `ranked_search` including superseded rows (the `--all` /
/// `include_superseded` surface).
pub fn ranked_search_all(
    mem: &ProjectMemory,
    query: &str,
    query_embedding: Option<&[f32]>,
) -> Vec<RankedResult> {
    ranked_search_opts(mem, query, query_embedding, true)
}

fn ranked_search_opts(
    mem: &ProjectMemory,
    query: &str,
    query_embedding: Option<&[f32]>,
    include_superseded: bool,
) -> Vec<RankedResult> {
    let mut docs = collect_docs(mem);
    if !include_superseded {
        docs.retain(|d| d.live);
    }
    if docs.is_empty() {
        return Vec::new();
    }

    let doc_tokens: Vec<Vec<String>> = docs
        .iter()
        .map(|d| {
            let mut t = tokenize(&d.content);
            for tag in &d.tags {
                t.extend(tokenize(tag));
            }
            t
        })
        .collect();
    let query_tokens = tokenize(query);

    // ── Leg 1: lexical (BM25 + substring fallback) ──
    let scores = bm25_scores(&doc_tokens, &query_tokens);
    let mut lexical: Vec<usize> = (0..docs.len()).filter(|&i| scores[i] > 0.0).collect();
    // Ties on BM25 score break by recency (then index) — otherwise two
    // equally-relevant docs would rank by insertion order and cancel the
    // recency leg out in the fusion.
    lexical.sort_by(|&a, &b| {
        scores[b]
            .partial_cmp(&scores[a])
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| docs[b].added_at.cmp(&docs[a].added_at))
            .then_with(|| a.cmp(&b))
    });
    // Substring fallback — preserves the old `contains` recall for partial
    // tokens. Appended after real BM25 hits, newest first.
    let q_lower = query.to_lowercase();
    if !q_lower.trim().is_empty() {
        let mut fallback: Vec<usize> = (0..docs.len())
            .filter(|&i| {
                scores[i] <= 0.0
                    && (docs[i].content.to_lowercase().contains(&q_lower)
                        || docs[i].tags.iter().any(|t| t.to_lowercase().contains(&q_lower)))
            })
            .collect();
        fallback.sort_by(|&a, &b| docs[b].added_at.cmp(&docs[a].added_at).then_with(|| a.cmp(&b)));
        lexical.extend(fallback);
    }

    // ── Leg 2: semantic (only with a query embedding) ──
    let mut semantic: Vec<usize> = Vec::new();
    if let Some(qv) = query_embedding {
        let mut sims: Vec<(usize, f32)> = docs
            .iter()
            .enumerate()
            .filter_map(|(i, d)| {
                d.embedding
                    .as_ref()
                    .map(|ev| (i, crate::embeddings::cosine_similarity(qv, ev)))
            })
            .filter(|(_, sim)| *sim >= SEMANTIC_MIN_SIM)
            .collect();
        sims.sort_by(|a, b| {
            b.1.partial_cmp(&a.1)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| a.0.cmp(&b.0))
        });
        sims.truncate(SEMANTIC_TOP_K);
        semantic = sims.into_iter().map(|(i, _)| i).collect();
    }

    // ── Candidate set: union of the content legs. Recency alone never
    // nominates a doc — otherwise every query would return the whole store.
    let mut candidates: Vec<usize> = Vec::new();
    for &i in lexical.iter().chain(semantic.iter()) {
        if !candidates.contains(&i) {
            candidates.push(i);
        }
    }
    if candidates.is_empty() {
        return Vec::new();
    }

    // ── Leg 3: recency over the candidates ──
    let mut recency = candidates.clone();
    recency.sort_by(|&a, &b| docs[b].added_at.cmp(&docs[a].added_at).then_with(|| a.cmp(&b)));

    let mut legs: Vec<(&'static str, LegRanking)> = vec![("lexical", lexical)];
    if !semantic.is_empty() {
        legs.push(("semantic", semantic));
    }
    legs.push(("recency", recency));

    rrf_fuse(&legs)
        .into_iter()
        .map(|(idx, score, matched)| {
            let d = &docs[idx];
            RankedResult {
                section: d.section,
                id: d.id.clone(),
                content: d.content.clone(),
                tags: d.tags.clone(),
                added_at: d.added_at,
                score,
                legs: matched,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: &str, content: &str, tags: &[&str], added_at: u64) -> MemoryEntry {
        MemoryEntry {
            id: id.to_string(),
            content: content.to_string(),
            tags: tags.iter().map(|t| t.to_string()).collect(),
            added_by: "test".to_string(),
            added_at,
            ..Default::default()
        }
    }

    fn mem_with_context(entries: Vec<MemoryEntry>) -> ProjectMemory {
        ProjectMemory {
            context: entries,
            ..Default::default()
        }
    }

    #[test]
    fn tokenize_splits_on_non_alphanumeric() {
        assert_eq!(tokenize("retry_logic uses Exponential-Backoff!"),
            vec!["retry", "logic", "uses", "exponential", "backoff"]);
        assert!(tokenize("  ").is_empty());
    }

    #[test]
    fn bm25_ranks_exact_term_entry_above_unrelated() {
        let mem = mem_with_context(vec![
            entry("mem-1", "retry_logic uses exponential backoff for rate limits", &[], 100),
            entry("mem-2", "the UI theme is arctic blue with teal accents", &[], 200),
            entry("mem-3", "backoff is configured in config.rs", &[], 150),
        ]);
        let results = ranked_search(&mem, "exponential backoff", None);
        assert!(!results.is_empty());
        // The doc containing BOTH query terms must rank first.
        assert_eq!(results[0].id, "mem-1");
        // The unrelated entry must not appear at all (no lexical match, no
        // semantic leg, recency never nominates on its own).
        assert!(results.iter().all(|r| r.id != "mem-2"));
        // The single-term doc is present but below the two-term doc.
        assert!(results.iter().any(|r| r.id == "mem-3"));
    }

    #[test]
    fn bm25_scores_zero_without_query_terms() {
        let docs = vec![tokenize("alpha beta"), tokenize("gamma delta")];
        let scores = bm25_scores(&docs, &tokenize("epsilon"));
        assert_eq!(scores, vec![0.0, 0.0]);
    }

    #[test]
    fn rrf_fuses_two_leg_orderings_correctly() {
        // Leg A ranks: 0, 1, 2.  Leg B ranks: 2, 0, 1.
        let legs: Vec<(&'static str, LegRanking)> =
            vec![("lexical", vec![0, 1, 2]), ("recency", vec![2, 0, 1])];
        let fused = rrf_fuse(&legs);
        assert_eq!(fused.len(), 3);

        // Hand-computed expectations:
        //   doc0 = 1/61 + 1/62, doc1 = 1/62 + 1/63, doc2 = 1/63 + 1/61
        let s0 = 1.0 / 61.0 + 1.0 / 62.0;
        let s1 = 1.0 / 62.0 + 1.0 / 63.0;
        let s2 = 1.0 / 63.0 + 1.0 / 61.0;
        assert_eq!(fused[0].0, 0);
        assert!((fused[0].1 - s0).abs() < 1e-12);
        assert_eq!(fused[1].0, 2);
        assert!((fused[1].1 - s2).abs() < 1e-12);
        assert_eq!(fused[2].0, 1);
        assert!((fused[2].1 - s1).abs() < 1e-12);

        // Every doc matched both legs.
        for (_, _, legs) in &fused {
            assert_eq!(legs.len(), 2);
        }
    }

    #[test]
    fn rrf_doc_in_one_leg_only_gets_single_contribution() {
        let legs: Vec<(&'static str, LegRanking)> =
            vec![("lexical", vec![5]), ("semantic", vec![7])];
        let fused = rrf_fuse(&legs);
        assert_eq!(fused.len(), 2);
        // Same rank (1) in their respective legs → identical scores; the
        // deterministic tiebreak puts the lower index first.
        assert_eq!(fused[0].0, 5);
        assert_eq!(fused[1].0, 7);
        assert!((fused[0].1 - 1.0 / 61.0).abs() < 1e-12);
        assert_eq!(fused[0].2, vec!["lexical"]);
        assert_eq!(fused[1].2, vec!["semantic"]);
    }

    #[test]
    fn no_embedding_path_still_ranks() {
        let mem = mem_with_context(vec![
            entry("mem-old", "deploy steps for the legacy stack", &["deploy"], 100),
            entry("mem-new", "deploy steps for the modern stack", &["deploy"], 900),
        ]);
        // query_embedding = None — semantic leg must be skipped, not error.
        let results = ranked_search(&mem, "deploy", None);
        assert_eq!(results.len(), 2);
        for r in &results {
            assert!(r.legs.contains(&"lexical"));
            assert!(r.legs.contains(&"recency"));
            assert!(!r.legs.contains(&"semantic"));
            assert!(r.score > 0.0);
        }
        // Identical token profile → equal BM25 score → recency decides.
        let newer = results.iter().position(|r| r.id == "mem-new").unwrap();
        let older = results.iter().position(|r| r.id == "mem-old").unwrap();
        assert!(newer < older, "newer entry should outrank older at equal relevance");
    }

    #[test]
    fn semantic_leg_ranks_when_embeddings_present() {
        let mut e1 = entry("mem-a", "completely unrelated words here", &[], 100);
        e1.embedding = Some(vec![1.0, 0.0, 0.0]);
        let mut e2 = entry("mem-b", "also nothing in common lexically", &[], 100);
        e2.embedding = Some(vec![0.0, 1.0, 0.0]);
        let mem = mem_with_context(vec![e1, e2]);

        // Query embedding aligned with e1's vector.
        let results = ranked_search(&mem, "zzz-no-lexical-match", Some(&[1.0, 0.0, 0.0]));
        assert_eq!(results.len(), 1, "only the cosine-similar doc should match");
        assert_eq!(results[0].id, "mem-a");
        assert!(results[0].legs.contains(&"semantic"));
    }

    #[test]
    fn substring_fallback_preserves_legacy_recall() {
        let mem = mem_with_context(vec![entry(
            "mem-1",
            "authentication flows through verify_token",
            &[],
            100,
        )]);
        // "auth" is not a full token of the content — BM25 alone would miss
        // it; the substring fallback must keep the legacy behavior.
        let results = ranked_search(&mem, "auth", None);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].id, "mem-1");
    }

    #[test]
    fn empty_store_and_empty_query_are_safe() {
        let mem = ProjectMemory::default();
        assert!(ranked_search(&mem, "anything", None).is_empty());

        let mem = mem_with_context(vec![entry("mem-1", "content", &[], 1)]);
        assert!(ranked_search(&mem, "", None).is_empty());
    }

    #[test]
    fn superseded_entries_excluded_by_default_included_with_all() {
        let mut closed = entry("mem-old", "deploy steps for the legacy stack", &["deploy"], 100);
        closed.valid_to = Some("2026-06-11T00:00:00+00:00".to_string());
        closed.supersedes = None;
        let live = entry("mem-new", "deploy steps for the modern stack", &["deploy"], 900);
        let mem = mem_with_context(vec![closed, live]);

        // Default recall: only the live entry.
        let results = ranked_search(&mem, "deploy", None);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].id, "mem-new");

        // include_superseded: both, audit row included.
        let all = ranked_search_all(&mem, "deploy", None);
        assert_eq!(all.len(), 2);
        assert!(all.iter().any(|r| r.id == "mem-old"));
    }

    #[test]
    fn backfill_embeds_only_missing() {
        let mut pre = entry("mem-a", "already has vector", &[], 1);
        pre.embedding = Some(vec![0.5]);
        let mut mem = mem_with_context(vec![pre, entry("mem-b", "needs vector", &[], 2)]);
        let n = backfill_embeddings(&mut mem, &|_t| Some(vec![1.0, 2.0]));
        assert_eq!(n, 1);
        assert_eq!(mem.context[0].embedding, Some(vec![0.5]));
        assert_eq!(mem.context[1].embedding, Some(vec![1.0, 2.0]));

        // Provider failing → nothing changes, no error.
        let mut mem2 = mem_with_context(vec![entry("mem-c", "x", &[], 1)]);
        assert_eq!(backfill_embeddings(&mut mem2, &|_t| None), 0);
        assert!(mem2.context[0].embedding.is_none());
    }
}
