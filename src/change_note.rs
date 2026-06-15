//! Deterministic per-file change notes.
//!
//! Every commit touches a set of files; a flat `+10 −40` churn number says how
//! *much* changed but nothing about *what*, *why*, or *where it ripples*. This
//! module answers all three from facts Aura already has — **no AI tokens**:
//!
//!   • **what** — the symbols that changed in each file, with their kind and
//!     change verb (added / modified / deleted). From the AST diff
//!     ([`crate::intent_vs_actual::run`]).
//!   • **why** — any per-symbol rationale that was recorded for this commit
//!     (`.aura/commit_rationales.jsonl`); absent that, a templated one-liner
//!     Aura composes from the diff shape. Never blocks on an LLM.
//!   • **where it affects** — the reverse call-graph blast radius: who calls the
//!     changed symbols and which user-facing features ride on them
//!     ([`crate::impact::analyze_changes`]).
//!
//! The output is a [`ChangeNoteReport`] (one [`FileChangeNote`] per changed
//! source file) that the shell renders as a per-file change card. It is the
//! engine half of "each file change needs an intent": Aura fills it in itself.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::Path;

use serde::Serialize;

use crate::impact::{self, CallerInfo, FeatureImpact};
use crate::intent_vs_actual;

/// The full change-note for one commit: header facts + a card per changed file.
#[derive(Debug, Serialize)]
pub struct ChangeNoteReport {
    pub commit_sha: String,
    pub commit_short: String,
    pub commit_message: String,
    pub commit_time: i64,
    pub author: String,
    /// One card per changed source file the parser understands, by path.
    pub files: Vec<FileChangeNote>,
    /// Changed files that yielded no tracked symbol delta — non-code (configs,
    /// docs, assets) *and* code files whose change was below symbol granularity
    /// (a const, an import, whitespace). Listed so the commit's file set stays
    /// complete without inventing symbols.
    pub other_files: Vec<String>,
    /// Where the blast-radius graph came from: `"checkpoint" | "worktree" | "none"`.
    pub graph_source: String,
}

/// A single file's change note — the per-file "intent".
#[derive(Debug, Serialize)]
pub struct FileChangeNote {
    pub file: String,
    /// Plain-language one-liner Aura composes deterministically from the diff:
    /// "2 functions modified, 1 added · affects Sign-in, +1 more".
    pub note: String,
    /// The symbols that changed in this file.
    pub symbols: Vec<ChangedSymbol>,
    /// Callers one hop from the changed symbols — who to re-check.
    pub direct_callers: Vec<CallerInfo>,
    /// Total distinct dependents reached at any depth.
    pub dependent_count: usize,
    /// User-facing features that ride on the changed symbols, closest first.
    pub features: Vec<FeatureImpact>,
    /// True when nothing in range depends on the changed symbols (a leaf edit).
    pub leaf: bool,
    /// True if a graph-walk budget tripped, so dependent counts are a floor.
    pub truncated: bool,
}

/// One changed symbol within a file.
#[derive(Debug, Serialize)]
pub struct ChangedSymbol {
    pub identifier: String,
    pub kind: String,
    /// "added" | "modified" | "deleted".
    pub change: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_line: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_line: Option<u32>,
    /// Recorded rationale for this symbol, if one was captured. Absent → the
    /// file-level `note` still describes the change.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rationale: Option<String>,
}

/// Build the change-note for a commit. `sha_or_ref` is anything `git revparse`
/// understands (full/short sha, `HEAD`, `HEAD~1`, a branch). Runs entirely on
/// the AST diff + reverse call graph — no network, no LLM.
pub fn run(sha_or_ref: &str) -> Result<ChangeNoteReport, Box<dyn std::error::Error>> {
    let report = intent_vs_actual::run(sha_or_ref)?;

    // Group the diffed nodes by file, preserving a stable by-path order.
    let mut by_file: BTreeMap<String, Vec<ChangedSymbol>> = BTreeMap::new();
    if let Some(nodes) = &report.nodes {
        for n in nodes {
            // Body-locals (loop counters, inline temporaries) are tracked for
            // the graph but only clutter a per-file note — list the module-level
            // and class-member symbols a reader actually reviews.
            if !n.top_level {
                continue;
            }
            let Some(file) = n.file.clone().filter(|f| !f.is_empty()) else {
                continue;
            };
            by_file.entry(file).or_default().push(ChangedSymbol {
                identifier: n.identifier.clone(),
                kind: n.kind.clone(),
                change: n.change.clone(),
                signature: n.signature.clone(),
                start_line: n.start_line,
                end_line: n.end_line,
                rationale: n.rationale.clone(),
            });
        }
    }

    // Files the diff touched but no symbol came out of (non-code, or a code
    // file changed below symbol granularity).
    let coded: HashSet<&String> = by_file.keys().collect();
    let other_files: Vec<String> = report
        .changed_files
        .iter()
        .filter(|f| !coded.contains(f))
        .cloned()
        .collect();

    // Blast-radius seeds: a symbol's *existing* dependents only make sense for
    // code that was already there, so seed with modified + deleted symbols.
    // (Added symbols have no prior callers; they show up in `symbols`, not as
    // blast-radius seeds.) Load the graph once across all files.
    let seeds: Vec<(String, Vec<String>)> = by_file
        .iter()
        .map(|(file, syms)| {
            let ids = syms
                .iter()
                .filter(|s| s.change != "added")
                .map(|s| s.identifier.clone())
                .collect::<Vec<_>>();
            (file.clone(), ids)
        })
        .collect();

    let (impacts, graph_source) = impact::analyze_changes(Path::new("."), &seeds);
    let impact_by_file: HashMap<String, impact::FileImpact> = impacts
        .into_iter()
        .map(|fi| (fi.file.clone(), fi))
        .collect();

    let mut files: Vec<FileChangeNote> = Vec::new();
    for (file, symbols) in by_file {
        let fi = impact_by_file.get(&file);
        let direct_callers = fi.map(|f| f.direct_callers.clone()).unwrap_or_default();
        let features = fi.map(|f| f.features.clone()).unwrap_or_default();
        let dependent_count = fi.map(|f| f.transitive_caller_count).unwrap_or(0);
        let truncated = fi.map(|f| f.truncated).unwrap_or(false);
        // `leaf` is only a real signal when we actually seeded the walk with an
        // existing symbol; a file of pure additions isn't "leaf-safe", it's
        // simply un-analyzable for prior dependents.
        let had_seed = symbols.iter().any(|s| s.change != "added");
        let leaf = had_seed && fi.map(|f| f.leaf).unwrap_or(false);

        let note = compose_note(&symbols, &features, dependent_count, leaf, had_seed);
        files.push(FileChangeNote {
            file,
            note,
            symbols,
            direct_callers,
            dependent_count,
            features,
            leaf,
            truncated,
        });
    }

    Ok(ChangeNoteReport {
        commit_sha: report.commit_sha,
        commit_short: report.commit_short,
        commit_message: report.commit_message,
        commit_time: report.commit_time,
        author: report.author,
        files,
        other_files,
        graph_source,
    })
}

/// Compose the deterministic file-level note: a "what" clause from the change
/// shape joined to a "where it affects" clause from the blast radius. Pure
/// string assembly — no AI.
fn compose_note(
    symbols: &[ChangedSymbol],
    features: &[FeatureImpact],
    dependent_count: usize,
    leaf: bool,
    had_seed: bool,
) -> String {
    // ── what ── a kind-aware, named sentence — not a bare count. A reader
    // should learn *what kind of thing* changed and (when the file is small)
    // *which symbols*, e.g. "Adds 2 functions (snap, tracked) and 3 constants".
    let verb = compose_verb(symbols);
    let what = if symbols.is_empty() {
        "No tracked symbols changed".to_string()
    } else if symbols.len() == 1 {
        let s = &symbols[0];
        format!("{verb} {} {}", noun_key(&s.kind), s.identifier)
    } else {
        let groups = group_by_noun(symbols);
        // Name members only while the file is small enough to read at a glance.
        let name_inline = symbols.len() <= 6;
        let phrases: Vec<String> = groups
            .iter()
            .map(|(noun, names)| {
                let count = pluralize_noun(noun, names.len());
                if name_inline {
                    format!("{count} ({})", join_names(names))
                } else {
                    count
                }
            })
            .collect();
        format!("{verb} {}", join_human(&phrases))
    };

    // ── where it affects ──
    let where_clause = if !features.is_empty() {
        let names: Vec<String> = features.iter().take(2).map(|f| f.name.clone()).collect();
        let more = features.len().saturating_sub(names.len());
        let tail = if more > 0 {
            format!(", +{more} more")
        } else {
            String::new()
        };
        Some(format!("affects {}{}", join_human(&names), tail))
    } else if dependent_count > 0 {
        Some(format!(
            "{dependent_count} dependent{} to re-check",
            if dependent_count == 1 { "" } else { "s" }
        ))
    } else if leaf {
        Some("nothing else calls it".to_string())
    } else if had_seed {
        // We seeded the walk but resolved no callers and it isn't a clean leaf
        // (e.g. the symbol's def wasn't in the graph) — stay honest.
        Some("dependents not determined".to_string())
    } else {
        // Pure additions: no prior-dependent question to answer.
        None
    };

    match where_clause {
        Some(w) => format!("{what} · {w}"),
        None => what,
    }
}

/// Join a short list as "a", "a and b", or "a, b and c". Deterministic.
fn join_human(items: &[String]) -> String {
    match items.len() {
        0 => String::new(),
        1 => items[0].clone(),
        2 => format!("{} and {}", items[0], items[1]),
        _ => {
            let (last, head) = items.split_last().unwrap();
            format!("{} and {}", head.join(", "), last)
        }
    }
}

/// Lead verb for the file note from the mix of change kinds: pure adds →
/// "Adds", pure modifications → "Updates", pure deletes → "Removes", any mix →
/// "Reworks".
fn compose_verb(symbols: &[ChangedSymbol]) -> &'static str {
    let (mut a, mut m, mut d) = (false, false, false);
    for s in symbols {
        match s.change.as_str() {
            "added" => a = true,
            "deleted" => d = true,
            _ => m = true,
        }
    }
    match (a, m, d) {
        (true, false, false) => "Adds",
        (false, true, false) => "Updates",
        (false, false, true) => "Removes",
        _ => "Reworks",
    }
}

/// tree-sitter node kind → a friendly singular noun a non-developer can read.
/// Unknown kinds collapse to "symbol".
fn noun_key(kind: &str) -> &'static str {
    match kind {
        "function_item"
        | "function_declaration"
        | "function_definition"
        | "arrow_function"
        | "function_expression"
        | "generator_function"
        | "generator_function_declaration"
        | "method_definition"
        | "method_declaration"
        | "method"
        | "singleton_method"
        | "constructor_declaration" => "function",
        "variable_declarator" | "lexical_declaration" => "constant",
        "struct_item" | "struct_specifier" | "struct_declaration" => "struct",
        "impl_item" => "impl block",
        "class_declaration" | "class_definition" | "class_specifier" | "class" => "class",
        "enum_item" | "enum_declaration" => "enum",
        "trait_item" => "trait",
        "interface_declaration" => "interface",
        "type_alias_declaration" | "type_item" | "type_declaration" => "type",
        "module" | "object_declaration" | "namespace_declaration" => "module",
        _ => "symbol",
    }
}

/// "1 class", "2 functions" — count + correctly-pluralized noun.
fn pluralize_noun(noun: &str, n: usize) -> String {
    if n == 1 {
        return format!("1 {noun}");
    }
    match noun {
        "class" => format!("{n} classes"),
        "impl block" => format!("{n} impl blocks"),
        _ => format!("{n} {noun}s"),
    }
}

/// Group changed symbols by friendly noun in a stable priority order, so the
/// note reads the same way every time regardless of diff iteration order.
fn group_by_noun(symbols: &[ChangedSymbol]) -> Vec<(&'static str, Vec<String>)> {
    const ORDER: &[&str] = &[
        "function",
        "class",
        "struct",
        "impl block",
        "trait",
        "interface",
        "enum",
        "type",
        "constant",
        "module",
        "symbol",
    ];
    let mut by_noun: HashMap<&'static str, Vec<String>> = HashMap::new();
    for s in symbols {
        by_noun
            .entry(noun_key(&s.kind))
            .or_default()
            .push(s.identifier.clone());
    }
    ORDER
        .iter()
        .filter_map(|noun| by_noun.remove(*noun).map(|names| (*noun, names)))
        .collect()
}

/// Name up to three members inline, then "+N more", so a small file lists its
/// symbols without a long file note running off the card.
fn join_names(names: &[String]) -> String {
    if names.len() <= 3 {
        join_human(names)
    } else {
        format!("{} +{} more", names[..3].join(", "), names.len() - 3)
    }
}
