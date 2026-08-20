//! Code Atlas reader + meaning-change tracking for the editor hover.
//!
//! `aura atlas` (the CLI) writes `.aura/atlas.json` — a plain-English
//! directory of every symbol in the project (humanized title + one-line
//! meaning). This module ferries that registry to the desktop frontend so the
//! Monaco editor can show *what a function means in the real world* when the
//! user hovers it — the whole point for our non-engineer audience.
//!
//! It also answers the harder half of board #334: **when AI touches a function
//! and its meaning changes, we track it.** Every time the atlas is regenerated
//! we snapshot each symbol's humanized meaning into a durable baseline
//! (`.aura/atlas.meaning.json`). On the next regen we diff current-vs-baseline
//! and surface, per symbol, "was X, now Y". That diff rides along on the hover
//! payload so the change is visible exactly where the user is looking — and it
//! is computed against REAL data on disk, not a placeholder.
//!
//! The reader never mutates the atlas itself. The only file it writes is the
//! meaning baseline, and only when the atlas's `generatedAt` advances (a real
//! regen) — reads are otherwise idempotent.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// One symbol as the frontend hover needs it. A lossy, hover-shaped subset of
/// the full `atlas.json` `AtlasEntry` (we don't ferry the call-graph previews
/// the hover never shows). camelCase to match the rest of Aura's JSON surface.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AtlasHoverEntry {
    /// Stable rename-proof identity (the AST node id).
    pub key: String,
    /// Raw source identifier, verbatim (`verify_token`).
    pub name: String,
    /// Humanized title ("Verify Token").
    pub title: String,
    /// `"feature" | "component" | "atom"`.
    pub role: String,
    /// Human architectural layer ("UI (React)", "Core (Rust)", …).
    pub layer: String,
    /// Plain-language one-liner — the real-world meaning.
    pub summary: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<u32>,
    /// For features: humanized feature name ("Sign In").
    #[serde(skip_serializing_if = "Option::is_none")]
    pub feature: Option<String>,
    /// `"structural"` or `"ai"` — provenance of this meaning.
    pub summary_source: String,
    /// Set ONLY when this symbol's meaning changed since the last atlas regen.
    /// Drives the hover's "Meaning changed: was X, now Y" line.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub meaning_change: Option<MeaningChange>,
}

/// A recorded shift in a symbol's plain-language meaning between two atlas
/// generations — the provenance of "AI changed what this does".
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeaningChange {
    /// The prior humanized meaning.
    pub was: String,
    /// The current humanized meaning.
    pub now: String,
    /// Unix seconds of the atlas generation that introduced the new meaning.
    pub at: u64,
}

/// The hover-ready atlas the frontend caches per repo.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AtlasHover {
    /// `true` when `.aura/atlas.json` was found + parsed. When `false` the
    /// frontend renders nothing extra in the hover (it stays a normal editor).
    pub available: bool,
    /// Unix seconds the atlas was generated, if available.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub generated_at: Option<u64>,
    /// Repository basename, echoed from the atlas.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repo: Option<String>,
    /// Every indexable symbol, flattened across features/components/atoms.
    pub entries: Vec<AtlasHoverEntry>,
    /// How many entries carry a `meaningChange` this regen — lets the UI show a
    /// quiet "N meanings changed" affordance without rescanning.
    pub changed_count: usize,
}

// ---------------------------------------------------------------------------
// Raw atlas.json shapes — only the fields we consume (serde ignores the rest).
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawAtlas {
    #[serde(default)]
    generated_at: u64,
    #[serde(default)]
    repo: String,
    #[serde(default)]
    features: Vec<RawEntry>,
    #[serde(default)]
    components: Vec<RawEntry>,
    #[serde(default)]
    atoms: Vec<RawEntry>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawEntry {
    key: String,
    name: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    role: String,
    #[serde(default)]
    layer: String,
    #[serde(default)]
    summary: String,
    #[serde(default)]
    file: Option<String>,
    #[serde(default)]
    line: Option<u32>,
    #[serde(default)]
    feature: Option<String>,
    #[serde(default)]
    summary_source: String,
}

// ---------------------------------------------------------------------------
// Meaning baseline — the durable record of each symbol's PRIOR meaning, so a
// later regen can say "this used to mean X". Persisted at
// `.aura/atlas.meaning.json`. Keyed by a stable symbol identity.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MeaningBaseline {
    /// The atlas `generatedAt` this baseline was captured from. We only roll
    /// the baseline forward when the live atlas is strictly newer, so a real
    /// regen advances the baseline exactly once.
    #[serde(default)]
    generated_at: u64,
    /// symbolKey → its meaning at baseline capture time.
    #[serde(default)]
    meanings: BTreeMap<String, BaselineMeaning>,
    /// symbolKey → the change detected at the LAST roll-forward. Re-served on
    /// every read until the next regen, so the hover keeps showing what changed
    /// without recomputing (and without needing the older atlas to still exist).
    #[serde(default)]
    changes: BTreeMap<String, MeaningChange>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BaselineMeaning {
    title: String,
    summary: String,
}

/// Stable per-symbol identity for meaning tracking. The atlas `key` is the
/// rename-proof AST node id, which is the right anchor — but it can shift if a
/// symbol moves files, so we fall back to `name@file` which is stable across a
/// pure rename of the surrounding code. We key on the node id primarily.
fn symbol_id(key: &str, name: &str, file: Option<&str>) -> String {
    if !key.is_empty() {
        return key.to_string();
    }
    match file {
        Some(f) => format!("{name}@{f}"),
        None => name.to_string(),
    }
}

// ---------------------------------------------------------------------------
// Tauri command
// ---------------------------------------------------------------------------

/// Read `.aura/atlas.json` for `repo_root`, flatten it into hover entries, and
/// fold in any meaning changes since the last atlas regen.
///
/// Returns `available: false` (never an error) when there's no atlas yet, so
/// the frontend can degrade gracefully to a plain editor.
#[tauri::command]
pub async fn read_atlas(repo_root: String) -> Result<AtlasHover, String> {
    crate::blocking::run(move || {
        let root = PathBuf::from(&repo_root);
        let atlas_path = root.join(".aura").join("atlas.json");

        let raw = match fs::read_to_string(&atlas_path) {
            Ok(s) => s,
            // No atlas generated yet — not an error, just nothing to show.
            Err(_) => return Ok(empty_hover()),
        };

        let atlas: RawAtlas = match serde_json::from_str(&raw) {
            Ok(a) => a,
            // A malformed/old-schema atlas shouldn't break the editor.
            Err(e) => return Err(format!("atlas.json is not valid JSON: {e}")),
        };

        // Flatten the three buckets in priority order (features first — those are
        // the things a person actually does). Dedupe by symbol id, first-wins, so a
        // feature's meaning beats an atom's if the same id appears twice.
        let mut entries: Vec<AtlasHoverEntry> = Vec::new();
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        for raw_entry in atlas
            .features
            .iter()
            .chain(atlas.components.iter())
            .chain(atlas.atoms.iter())
        {
            let id = symbol_id(&raw_entry.key, &raw_entry.name, raw_entry.file.as_deref());
            if !seen.insert(id) {
                continue;
            }
            entries.push(AtlasHoverEntry {
                key: raw_entry.key.clone(),
                name: raw_entry.name.clone(),
                title: raw_entry.title.clone(),
                role: raw_entry.role.clone(),
                layer: raw_entry.layer.clone(),
                summary: raw_entry.summary.clone(),
                file: raw_entry.file.clone(),
                line: raw_entry.line,
                feature: raw_entry.feature.clone(),
                summary_source: if raw_entry.summary_source.is_empty() {
                    "structural".to_string()
                } else {
                    raw_entry.summary_source.clone()
                },
                meaning_change: None,
            });
        }

        // Fold in meaning-change tracking against the durable baseline.
        let changes = reconcile_meanings(&root, atlas.generated_at, &entries);
        let mut changed_count = 0usize;
        for entry in entries.iter_mut() {
            let id = symbol_id(&entry.key, &entry.name, entry.file.as_deref());
            if let Some(change) = changes.get(&id) {
                entry.meaning_change = Some(change.clone());
                changed_count += 1;
            }
        }

        Ok(AtlasHover {
            available: true,
            generated_at: Some(atlas.generated_at),
            repo: Some(atlas.repo.clone()),
            entries,
            changed_count,
        })
    })
    .await
}

/// Compare the live atlas's per-symbol meanings against the stored baseline,
/// return the map of changes, and (when the atlas has actually regenerated)
/// roll the baseline forward so the NEXT regen compares against this one.
///
/// This is the honest, working first cut of meaning provenance:
/// current-vs-previous, persisted across regens.
fn reconcile_meanings(
    root: &Path,
    atlas_generated_at: u64,
    entries: &[AtlasHoverEntry],
) -> BTreeMap<String, MeaningChange> {
    let baseline_path = root.join(".aura").join("atlas.meaning.json");
    let mut baseline: MeaningBaseline = fs::read_to_string(&baseline_path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();

    // Live meanings keyed by symbol id.
    let mut live: BTreeMap<String, BaselineMeaning> = BTreeMap::new();
    for e in entries {
        let id = symbol_id(&e.key, &e.name, e.file.as_deref());
        live.insert(
            id,
            BaselineMeaning {
                title: e.title.clone(),
                summary: e.summary.clone(),
            },
        );
    }

    // First ever run (no baseline): seed it silently — there's no "before" to
    // diff against, so nothing changed yet.
    if baseline.meanings.is_empty() && baseline.generated_at == 0 {
        baseline.generated_at = atlas_generated_at;
        baseline.meanings = live;
        baseline.changes = BTreeMap::new();
        persist_baseline(&baseline_path, &baseline);
        return BTreeMap::new();
    }

    // Atlas hasn't regenerated since we last rolled the baseline → re-serve the
    // changes we already computed for this generation. Keeps the hover showing
    // "meaning changed" steadily, without needing the older atlas on disk.
    if atlas_generated_at <= baseline.generated_at {
        return baseline.changes.clone();
    }

    // A real regen happened. Diff live-vs-baseline; a symbol whose summary text
    // differs has had its real-world meaning rewritten (typically by AI editing
    // the code).
    let mut changes: BTreeMap<String, MeaningChange> = BTreeMap::new();
    for (id, now) in &live {
        if let Some(prev) = baseline.meanings.get(id) {
            if prev.summary.trim() != now.summary.trim() && !now.summary.trim().is_empty() {
                changes.insert(
                    id.clone(),
                    MeaningChange {
                        was: prev.summary.clone(),
                        now: now.summary.clone(),
                        at: atlas_generated_at,
                    },
                );
            }
        }
    }

    // Roll the baseline forward to this generation and remember the changes so
    // they survive subsequent reads until the next regen.
    baseline.generated_at = atlas_generated_at;
    baseline.meanings = live;
    baseline.changes = changes.clone();
    persist_baseline(&baseline_path, &baseline);

    changes
}

fn persist_baseline(path: &Path, baseline: &MeaningBaseline) {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(s) = serde_json::to_string_pretty(baseline) {
        let _ = fs::write(path, s);
    }
}

fn empty_hover() -> AtlasHover {
    AtlasHover {
        available: false,
        generated_at: None,
        repo: None,
        entries: Vec::new(),
        changed_count: 0,
    }
}

// ---------------------------------------------------------------------------
// Tests — pure logic over in-memory data, plus a round-trip on a temp dir.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(key: &str, name: &str, summary: &str) -> AtlasHoverEntry {
        AtlasHoverEntry {
            key: key.to_string(),
            name: name.to_string(),
            title: name.to_string(),
            role: "atom".to_string(),
            layer: "Core (Rust)".to_string(),
            summary: summary.to_string(),
            file: Some("src/auth.rs".to_string()),
            line: Some(1),
            feature: None,
            summary_source: "structural".to_string(),
            meaning_change: None,
        }
    }

    fn tmp_root() -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("aura-atlas-test-{}", std::process::id()));
        p.push(format!("{:?}", std::time::SystemTime::now()));
        fs::create_dir_all(p.join(".aura")).unwrap();
        p
    }

    #[test]
    #[ignore]
    fn parses_the_real_worktree_atlas() {
        // Run with: cargo test --lib cmd_atlas::tests::parses_the_real -- --ignored
        // Points at the real .aura/atlas.json at the repo root to prove the
        // serde shapes match the live CLI output. Skipped by default (no file
        // in CI).
        let root = std::path::PathBuf::from(
            std::env::var("AURA_ATLAS_TEST_ROOT")
                .unwrap_or_else(|_| "../..".to_string()),
        );
        let path = root.join(".aura/atlas.json");
        let raw = std::fs::read_to_string(&path).expect("atlas.json should exist");
        let atlas: RawAtlas = serde_json::from_str(&raw).expect("atlas.json should parse");
        let total = atlas.features.len() + atlas.components.len() + atlas.atoms.len();
        assert!(total > 0, "expected symbols in the real atlas");
        assert!(!atlas.repo.is_empty());
    }

    #[test]
    fn symbol_id_prefers_key() {
        assert_eq!(symbol_id("n1", "verify", Some("a.rs")), "n1");
        assert_eq!(symbol_id("", "verify", Some("a.rs")), "verify@a.rs");
        assert_eq!(symbol_id("", "verify", None), "verify");
    }

    #[test]
    fn first_run_seeds_baseline_and_reports_no_change() {
        let root = tmp_root();
        let entries = vec![entry("n1", "verify_token", "Checks a token.")];
        let changes = reconcile_meanings(&root, 100, &entries);
        assert!(changes.is_empty(), "first run must report nothing changed");
        // Baseline file now exists.
        assert!(root.join(".aura/atlas.meaning.json").exists());
    }

    #[test]
    fn regen_with_new_summary_is_a_meaning_change() {
        let root = tmp_root();
        // Seed.
        reconcile_meanings(&root, 100, &[entry("n1", "verify_token", "Checks a token.")]);
        // Regen with a rewritten meaning + a newer generatedAt.
        let changes = reconcile_meanings(
            &root,
            200,
            &[entry("n1", "verify_token", "Validates the signed session token.")],
        );
        let c = changes.get("n1").expect("n1 should have changed");
        assert_eq!(c.was, "Checks a token.");
        assert_eq!(c.now, "Validates the signed session token.");
        assert_eq!(c.at, 200);
    }

    #[test]
    fn unchanged_summary_is_not_a_change() {
        let root = tmp_root();
        reconcile_meanings(&root, 100, &[entry("n1", "verify_token", "Checks a token.")]);
        let changes =
            reconcile_meanings(&root, 200, &[entry("n1", "verify_token", "Checks a token.")]);
        assert!(changes.is_empty());
    }

    #[test]
    fn same_generation_reserves_prior_changes() {
        let root = tmp_root();
        reconcile_meanings(&root, 100, &[entry("n1", "verify_token", "Checks a token.")]);
        // Roll forward — produces a change.
        reconcile_meanings(&root, 200, &[entry("n1", "verify_token", "New meaning.")]);
        // Read AGAIN at the same generation (no regen) — change must persist.
        let again =
            reconcile_meanings(&root, 200, &[entry("n1", "verify_token", "New meaning.")]);
        assert_eq!(again.get("n1").map(|c| c.now.as_str()), Some("New meaning."));
    }
}
