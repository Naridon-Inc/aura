//! Feature map — the human-readable landing view of the Code Map.
//!
//! The raw knowledge graph speaks in fns, files and types; nobody who isn't
//! already inside the code can read it. This module folds that graph up into
//! FEATURES: plain-language blocks ("Login", "Billing", "Voice Gateway")
//! derived from where code lives, sized by how much code lives there, with
//! links showing which features actually touch each other. It is a pure
//! projection of the existing graph — nothing is re-scanned, so it is as
//! fresh (and as bounded) as `graph.json` itself.

use serde::Serialize;
use std::collections::HashMap;

use crate::cmd_kg::{KgGraph, KgStats};

/// Hard ceilings so the payload crossing IPC stays small no matter how big
/// the repo is — same philosophy as the raw view's caps.
pub const FEATURE_CAP: usize = 40;
pub const LINK_CAP: usize = 120;
/// A directory with fewer symbols than this is not a feature of its own; it
/// rolls up into its area so the map shows shapes, not dust.
const MIN_SYMBOLS_FOR_OWN_BLOCK: usize = 3;
const TOP_SYMBOLS_PER_FEATURE: usize = 5;
const SAMPLE_FILES_PER_FEATURE: usize = 5;

/// Path segments that say nothing about WHAT the code does, only how the
/// build is arranged. They are skipped when naming a feature, so
/// `packages/billing/src/invoices` reads as area "Billing", feature
/// "Invoices" — not "Packages".
const GENERIC_SEGMENTS: &[&str] = &[
    "src", "lib", "libs", "app", "apps", "packages", "pkg", "crates", "services",
    "modules", "internal", "core", "js", "ts", "code", "source", "sources", "main",
];

#[derive(Serialize, Clone, Debug)]
pub struct KgFeature {
    /// Stable key: `area-segment/feature-segment` (raw, pre-humanize).
    pub id: String,
    /// Plain-language name, e.g. "Voice Gateway".
    pub name: String,
    /// Plain-language area this feature lives in, e.g. "Billing".
    pub area: String,
    /// Raw path fragment for drill-down search in the pieces view.
    pub path: String,
    /// How many pieces of logic (fns/classes/types) live here.
    pub symbols: usize,
    pub files: usize,
    /// Most connected piece names — the vocabulary of this feature.
    pub top_symbols: Vec<String>,
    pub sample_files: Vec<String>,
}

#[derive(Serialize, Clone, Debug)]
pub struct KgFeatureLink {
    /// Feature ids (indexes into `features` would be brittle across caps).
    pub a: String,
    pub b: String,
    /// How many graph edges cross between the two features.
    pub strength: usize,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct KgFeatureMap {
    pub features: Vec<KgFeature>,
    pub links: Vec<KgFeatureLink>,
    /// How many features were too small to show and got folded away
    /// entirely (not even into an area rollup). Honesty for the header.
    pub folded: usize,
    pub stats: KgStats,
    pub built_at: u64,
    pub head_sha: String,
}

/// "voice-gateway" → "Voice Gateway", "LoginPage" → "Login Page",
/// "api_keys" → "Api Keys". ALL-CAPS tokens survive as-is ("CLI", "HTTP").
pub(crate) fn humanize(seg: &str) -> String {
    let mut words: Vec<String> = Vec::new();
    for chunk in seg.split(['-', '_', '.', ' ']) {
        if chunk.is_empty() {
            continue;
        }
        // Split camelCase / PascalCase boundaries, and the end of an acronym
        // run ("HTTPHeader" → "HTTP" + "Header").
        let mut word = String::new();
        let mut prev_lower = false;
        let chars: Vec<char> = chunk.chars().collect();
        for (i, &ch) in chars.iter().enumerate() {
            let acronym_ends = ch.is_uppercase()
                && word.len() > 1
                && word.chars().all(char::is_uppercase)
                && chars.get(i + 1).map_or(false, |n| n.is_lowercase());
            if ch.is_uppercase() && !word.is_empty() && (prev_lower || acronym_ends) {
                words.push(word.clone());
                word.clear();
            }
            prev_lower = ch.is_lowercase() || ch.is_ascii_digit();
            word.push(ch);
        }
        if !word.is_empty() {
            words.push(word);
        }
    }
    words
        .iter()
        .map(|w| {
            if w.chars().all(|c| c.is_uppercase() || c.is_ascii_digit()) && w.len() <= 5 {
                w.clone() // acronym: CLI, HTTP, KG
            } else {
                let mut cs = w.chars();
                match cs.next() {
                    Some(f) => f.to_uppercase().collect::<String>() + &cs.as_str().to_lowercase(),
                    None => String::new(),
                }
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Which (area-segment, feature-segment) a file belongs to. Area = first
/// meaningful directory, feature = deepest meaningful directory. Files at
/// the repo root (or under only generic dirs) land in a "top level" bucket.
fn feature_key(file: &str) -> (String, String) {
    let mut segs: Vec<&str> = file.split(['/', '\\']).collect();
    segs.pop(); // drop the filename
    let meaningful: Vec<&str> = segs
        .into_iter()
        .filter(|s| !s.is_empty() && !GENERIC_SEGMENTS.iter().any(|g| s.eq_ignore_ascii_case(g)))
        .collect();
    match meaningful.as_slice() {
        [] => (String::new(), String::new()),
        [only] => ((*only).to_string(), (*only).to_string()),
        [first, .., last] => ((*first).to_string(), (*last).to_string()),
    }
}

struct FeatureAcc {
    area_seg: String,
    feat_seg: String,
    symbols: usize,
    files: Vec<String>,
    /// (degree, name) of fn/class/type nodes, for top_symbols.
    symbol_names: Vec<(usize, String)>,
}

/// Pure projection: graph in, feature map out. No IO.
pub fn select_features(g: &KgGraph) -> KgFeatureMap {
    select_features_with_assignment(g).0
}

/// The same projection, plus the node-id → feature-id assignment it was built
/// from (kept features only), so the flow layer can say which feature a step
/// lives in without re-deriving the buckets.
pub(crate) fn select_features_with_assignment(g: &KgGraph) -> (KgFeatureMap, HashMap<String, String>) {
    // 1. Assign every code node to a feature bucket.
    let mut buckets: Vec<FeatureAcc> = Vec::new();
    let mut bucket_by_key: HashMap<(String, String), usize> = HashMap::new();
    // node id → bucket index, for the edge tally later.
    let mut node_bucket: HashMap<&str, usize> = HashMap::new();
    for n in &g.nodes {
        let is_symbol = matches!(n.kind.as_str(), "fn" | "class" | "type");
        let is_file = n.kind == "file";
        if !is_symbol && !is_file {
            continue; // docs/sections aren't part of the product shape
        }
        let key = feature_key(&n.file);
        let bi = *bucket_by_key.entry(key.clone()).or_insert_with(|| {
            buckets.push(FeatureAcc {
                area_seg: key.0.clone(),
                feat_seg: key.1.clone(),
                symbols: 0,
                files: Vec::new(),
                symbol_names: Vec::new(),
            });
            buckets.len() - 1
        });
        node_bucket.insert(n.id.as_str(), bi);
        if is_file {
            buckets[bi].files.push(n.file.clone());
        } else {
            buckets[bi].symbols += 1;
            buckets[bi].symbol_names.push((n.degree, n.name.clone()));
        }
    }

    // 2. Fold dust into area rollups: a bucket below the minimum merges into
    // the (area, area) bucket for its area, if one exists or can be made.
    let mut order: Vec<usize> = (0..buckets.len()).collect();
    order.sort_by(|&a, &b| buckets[b].symbols.cmp(&buckets[a].symbols));
    let mut merged_into: Vec<Option<usize>> = vec![None; buckets.len()];
    {
        // area segment → index of that area's rollup bucket (feat == area).
        let rollup_by_area: HashMap<String, usize> = buckets
            .iter()
            .enumerate()
            .filter(|(_, b)| b.feat_seg == b.area_seg)
            .map(|(i, b)| (b.area_seg.clone(), i))
            .collect();
        for i in 0..buckets.len() {
            if buckets[i].symbols >= MIN_SYMBOLS_FOR_OWN_BLOCK {
                continue;
            }
            if let Some(&ri) = rollup_by_area.get(&buckets[i].area_seg) {
                if ri != i {
                    merged_into[i] = Some(ri);
                }
            }
        }
    }
    for i in 0..buckets.len() {
        if let Some(ri) = merged_into[i] {
            let FeatureAcc { symbols, files, symbol_names, .. } =
                std::mem::replace(&mut buckets[i], FeatureAcc {
                    area_seg: String::new(),
                    feat_seg: String::new(),
                    symbols: 0,
                    files: Vec::new(),
                    symbol_names: Vec::new(),
                });
            buckets[ri].symbols += symbols;
            buckets[ri].files.extend(files);
            buckets[ri].symbol_names.extend(symbol_names);
        }
    }
    // Redirect node assignments of merged buckets to their rollup.
    for bi in node_bucket.values_mut() {
        if let Some(ri) = merged_into[*bi] {
            *bi = ri;
        }
    }

    // 3. Keep the heaviest FEATURE_CAP buckets; count the rest honestly.
    let mut keep: Vec<usize> = (0..buckets.len())
        .filter(|&i| merged_into[i].is_none() && (buckets[i].symbols > 0 || !buckets[i].files.is_empty()))
        .collect();
    keep.sort_by(|&a, &b| buckets[b].symbols.cmp(&buckets[a].symbols));
    let folded = keep.len().saturating_sub(FEATURE_CAP);
    keep.truncate(FEATURE_CAP);
    let kept: HashMap<usize, usize> = keep.iter().enumerate().map(|(vi, &bi)| (bi, vi)).collect();

    // 4. Materialize features.
    let mut features: Vec<KgFeature> = Vec::with_capacity(keep.len());
    for &bi in &keep {
        let b = &mut buckets[bi];
        b.symbol_names.sort_by(|a, c| c.0.cmp(&a.0));
        b.symbol_names.dedup_by(|a, c| a.1 == c.1);
        let (raw_area, raw_feat) = (b.area_seg.clone(), b.feat_seg.clone());
        let name = if raw_feat.is_empty() { "Top Level".to_string() } else { humanize(&raw_feat) };
        let area = if raw_area.is_empty() { "Top Level".to_string() } else { humanize(&raw_area) };
        b.files.sort();
        b.files.dedup();
        features.push(KgFeature {
            id: format!("{raw_area}/{raw_feat}"),
            name,
            area,
            path: if raw_feat.is_empty() { raw_area.clone() } else { raw_feat.clone() },
            symbols: b.symbols,
            files: b.files.len(),
            top_symbols: b
                .symbol_names
                .iter()
                .take(TOP_SYMBOLS_PER_FEATURE)
                .map(|(_, n)| n.clone())
                .collect(),
            sample_files: b.files.iter().take(SAMPLE_FILES_PER_FEATURE).cloned().collect(),
        });
    }

    // 5. Links: tally graph edges whose endpoints land in two different kept
    // features. Unordered pairs, strongest first, capped.
    let mut pair_tally: HashMap<(usize, usize), usize> = HashMap::new();
    for e in &g.edges {
        let (Some(&ba), Some(&bb)) = (node_bucket.get(e.from.as_str()), node_bucket.get(e.to.as_str())) else {
            continue;
        };
        let (Some(&va), Some(&vb)) = (kept.get(&ba), kept.get(&bb)) else {
            continue;
        };
        if va == vb {
            continue;
        }
        let key = (va.min(vb), va.max(vb));
        *pair_tally.entry(key).or_default() += 1;
    }
    let mut pairs: Vec<((usize, usize), usize)> = pair_tally.into_iter().collect();
    pairs.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    pairs.truncate(LINK_CAP);
    let links = pairs
        .into_iter()
        .map(|((va, vb), strength)| KgFeatureLink {
            a: features[va].id.clone(),
            b: features[vb].id.clone(),
            strength,
        })
        .collect();

    let assignment: HashMap<String, String> = node_bucket
        .iter()
        .filter_map(|(id, bi)| kept.get(bi).map(|&vi| ((*id).to_string(), features[vi].id.clone())))
        .collect();

    (
        KgFeatureMap {
            features,
            links,
            folded,
            stats: g.stats.clone(),
            built_at: g.built_at,
            head_sha: g.head_sha.clone(),
        },
        assignment,
    )
}

/// Same contract as `aura_kg_view`: `None` means "no graph yet — call
/// ensure, then ask again". The projection itself is cheap (one pass over
/// nodes + one over edges), so no extra cache layer.
#[tauri::command]
pub async fn aura_kg_features(repo_root: String) -> Result<Option<KgFeatureMap>, String> {
    let Some(g) = crate::cmd_kg::load_graph_cached(&repo_root)? else {
        return Ok(None);
    };
    Ok(Some(select_features(&g)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cmd_kg::{KgEdge, KgGraph, KgNode};

    fn mk_node(id: &str, kind: &str, name: &str, file: &str, degree: usize) -> KgNode {
        KgNode {
            id: id.into(),
            kind: kind.into(),
            name: name.into(),
            file: file.into(),
            line: 1,
            degree,
            community_id: 0,
            god: false,
            provenance: "outline".into(),
            content_hash: None,
        }
    }

    fn mk_edge(from: &str, to: &str, kind: &str) -> KgEdge {
        KgEdge { from: from.into(), to: to.into(), kind: kind.into(), surprise: false, label: None, confidence: None }
    }

    #[test]
    fn generic_segments_never_name_a_feature() {
        assert_eq!(feature_key("packages/billing/src/invoices/calc.ts"), ("billing".into(), "invoices".into()));
        assert_eq!(feature_key("src/auth/login.ts"), ("auth".into(), "auth".into()));
        assert_eq!(feature_key("README.md"), (String::new(), String::new()));
        assert_eq!(feature_key("src/index.ts"), (String::new(), String::new()));
    }

    #[test]
    fn names_read_like_english_not_identifiers() {
        assert_eq!(humanize("voice-gateway"), "Voice Gateway");
        assert_eq!(humanize("LoginPage"), "Login Page");
        assert_eq!(humanize("api_keys"), "Api Keys");
        assert_eq!(humanize("CLI"), "CLI");
    }

    #[test]
    fn two_features_and_the_link_between_them() {
        let g = KgGraph {
            nodes: vec![
                mk_node("file:auth/login.ts", "file", "login.ts", "auth/login.ts", 0),
                mk_node("fn:auth/login.ts#signIn@1", "fn", "signIn", "auth/login.ts", 3),
                mk_node("fn:auth/login.ts#signOut@2", "fn", "signOut", "auth/login.ts", 1),
                mk_node("fn:auth/login.ts#refresh@3", "fn", "refresh", "auth/login.ts", 1),
                mk_node("file:billing/pay.ts", "file", "pay.ts", "billing/pay.ts", 0),
                mk_node("fn:billing/pay.ts#charge@1", "fn", "charge", "billing/pay.ts", 2),
                mk_node("fn:billing/pay.ts#refund@2", "fn", "refund", "billing/pay.ts", 1),
                mk_node("fn:billing/pay.ts#invoice@3", "fn", "invoice", "billing/pay.ts", 1),
            ],
            edges: vec![
                mk_edge("file:billing/pay.ts", "fn:auth/login.ts#signIn@1", "references"),
                mk_edge("file:billing/pay.ts", "fn:auth/login.ts#refresh@3", "references"),
                mk_edge("file:auth/login.ts", "fn:auth/login.ts#signIn@1", "contains"),
            ],
            ..Default::default()
        };
        let m = select_features(&g);
        assert_eq!(m.features.len(), 2);
        let names: Vec<&str> = m.features.iter().map(|f| f.name.as_str()).collect();
        assert!(names.contains(&"Auth") && names.contains(&"Billing"));
        // One cross-feature link, strength 2 (the contains edge is internal).
        assert_eq!(m.links.len(), 1);
        assert_eq!(m.links[0].strength, 2);
        // Top symbols lead with the most connected piece.
        let auth = m.features.iter().find(|f| f.name == "Auth").unwrap();
        assert_eq!(auth.top_symbols.first().map(String::as_str), Some("signIn"));
        assert_eq!(auth.symbols, 3);
        assert_eq!(auth.files, 1);
    }

    #[test]
    fn dust_folds_into_its_area_rollup() {
        // auth/ has a rollup-sized presence; auth/tiny has 1 symbol → folds.
        let mut nodes = vec![
            mk_node("file:auth/a.ts", "file", "a.ts", "auth/a.ts", 0),
            mk_node("file:auth/tiny/t.ts", "file", "t.ts", "auth/tiny/t.ts", 0),
            mk_node("fn:auth/tiny/t.ts#one@1", "fn", "one", "auth/tiny/t.ts", 0),
        ];
        for i in 0..4 {
            nodes.push(mk_node(&format!("fn:auth/a.ts#f{i}@{i}"), "fn", &format!("f{i}"), "auth/a.ts", 0));
        }
        let g = KgGraph { nodes, ..Default::default() };
        let m = select_features(&g);
        assert_eq!(m.features.len(), 1, "tiny dir must fold into Auth, got {:?}",
            m.features.iter().map(|f| &f.id).collect::<Vec<_>>());
        assert_eq!(m.features[0].name, "Auth");
        assert_eq!(m.features[0].symbols, 5);
        assert_eq!(m.features[0].files, 2);
    }

    #[test]
    fn the_map_stays_capped_and_counts_what_it_folded() {
        let mut nodes = Vec::new();
        for d in 0..60 {
            let file = format!("area{d}/mod.ts");
            nodes.push(mk_node(&format!("file:{file}"), "file", "mod.ts", &file, 0));
            for s in 0..MIN_SYMBOLS_FOR_OWN_BLOCK {
                nodes.push(mk_node(
                    &format!("fn:{file}#s{s}@{s}"), "fn", &format!("s{s}"), &file, 0,
                ));
            }
        }
        let g = KgGraph { nodes, ..Default::default() };
        let m = select_features(&g);
        assert_eq!(m.features.len(), FEATURE_CAP);
        assert_eq!(m.folded, 60 - FEATURE_CAP);
    }
}
