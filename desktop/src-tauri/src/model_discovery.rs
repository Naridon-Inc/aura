//! Discover the models the user's *installed* agent CLIs can actually run.
//!
//! The composer picker is seeded from a hand-maintained catalog
//! (`model_catalog.json` + the hosted copy). That catalog drifts the moment a
//! CLI ships a new model — which is exactly what left Kimi showing a stale
//! "K2.6", GPT-5.6 missing, and Antigravity flat. This module closes that gap:
//! for each CLI on this machine we read its own source of truth and report the
//! models it offers, so the picker reflects the real toolset per machine
//! instead of whatever we last published.
//!
//! Every probe is **local and best-effort**. A missing CLI, an unreadable
//! file, or a failed subprocess yields `None` and the curated catalog carries
//! that family unchanged — discovery only ever *adds* fidelity, never blanks a
//! family. Sources, one per CLI:
//!
//!   - **Kimi**  `~/.kimi-code/config.toml` (falls back to legacy `~/.kimi`)
//!               — the `[models."…"]` tables carry id + `display_name`.
//!   - **Codex** `~/.codex/models_cache.json` — the CLI's own cached list.
//!   - **Antigravity** `agy models` — a fast subcommand that prints one id
//!               per line (the only one of the three that shells out).
//!
//! The pure parsers (`parse_kimi_config` / `parse_codex_cache` /
//! `parse_agy_models`) take text/bytes so they're unit-testable without a real
//! home directory or subprocess; the outer `probe_*` fns do the IO.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::Duration;

use crate::cmd_models::ModelInfo;

/// One model a locally-installed CLI reports it can run. `label` is the CLI's
/// own display name when it has one, else a humanized form of the id.
#[derive(Debug, Clone, PartialEq)]
pub struct DiscoveredModel {
    pub id: String,
    pub label: String,
}

/// Brand metadata stamped onto a discovered row the curated catalog didn't
/// already carry — so a freshly-shipped model still shows the right vendor
/// mark and name. Sourced from the catalog family when present.
#[derive(Debug, Clone, Default)]
pub struct FamilyBrand {
    pub vendor: Option<String>,
    pub brand: Option<String>,
    pub brand_name: Option<String>,
}

/// Probe every installed CLI and return models keyed by the same vendor family
/// the catalog uses (`kimi` / `openai` / `antigravity`). Absent/failed probes
/// are simply omitted — the map only carries families we positively discovered.
pub async fn discover_all() -> BTreeMap<String, Vec<DiscoveredModel>> {
    let mut out: BTreeMap<String, Vec<DiscoveredModel>> = BTreeMap::new();
    if let Some(v) = probe_kimi() {
        out.insert("kimi".to_string(), v);
    }
    if let Some(v) = probe_codex() {
        out.insert("openai".to_string(), v);
    }
    if let Some(v) = probe_antigravity().await {
        out.insert("antigravity".to_string(), v);
    }
    out
}

// ── Kimi ──────────────────────────────────────────────────────────────────

/// Parse a Kimi `config.toml` into its selectable models. Each `[models."…"]`
/// table's key is the wire id (e.g. `kimi-code/k3`) forwarded as `kimi -m <id>`;
/// `display_name` is the label. The `default_model` is floated to the front so
/// the current model leads the list; the rest follow in descending-id order
/// (newest-looking first) for a stable, deterministic result.
fn parse_kimi_config(text: &str) -> Option<Vec<DiscoveredModel>> {
    let doc: toml::Value = toml::from_str(text).ok()?;
    let models = doc.get("models")?.as_table()?;
    let default_id = doc.get("default_model").and_then(|v| v.as_str());

    let mut rows: Vec<DiscoveredModel> = models
        .iter()
        .map(|(key, tbl)| {
            let label = tbl
                .get("display_name")
                .and_then(|v| v.as_str())
                .unwrap_or(key)
                .to_string();
            DiscoveredModel {
                id: key.clone(),
                label,
            }
        })
        .collect();
    if rows.is_empty() {
        return None;
    }
    rows.sort_by(|a, b| b.id.cmp(&a.id));
    if let Some(def) = default_id {
        if let Some(pos) = rows.iter().position(|r| r.id == def) {
            let d = rows.remove(pos);
            rows.insert(0, d);
        }
    }
    Some(rows)
}

fn probe_kimi() -> Option<Vec<DiscoveredModel>> {
    let home = dirs::home_dir()?;
    // The migrated `kimi-code` config wins; the legacy `~/.kimi` is the fallback
    // for installs that haven't migrated.
    let candidates = [
        home.join(".kimi-code").join("config.toml"),
        home.join(".kimi").join("config.toml"),
    ];
    let path = candidates.into_iter().find(|p| p.exists())?;
    let text = std::fs::read_to_string(path).ok()?;
    parse_kimi_config(&text)
}

// ── Codex (OpenAI) ──────────────────────────────────────────────────────────

/// Parse codex's `models_cache.json`. Each entry carries a `slug` (the id) and
/// `display_name`; models the CLI hides from selection (`visibility: "hide"`)
/// are dropped so internal/utility entries like `codex-auto-review` don't leak
/// into the picker.
fn parse_codex_cache(bytes: &[u8]) -> Option<Vec<DiscoveredModel>> {
    let doc: serde_json::Value = serde_json::from_slice(bytes).ok()?;
    let arr = doc.get("models")?.as_array()?;
    let mut rows = Vec::new();
    for m in arr {
        let Some(slug) = m.get("slug").and_then(|v| v.as_str()) else {
            continue;
        };
        if m
            .get("visibility")
            .and_then(|v| v.as_str())
            .is_some_and(|vis| vis.eq_ignore_ascii_case("hide"))
        {
            continue;
        }
        let label = m
            .get("display_name")
            .and_then(|v| v.as_str())
            .unwrap_or(slug)
            .to_string();
        rows.push(DiscoveredModel {
            id: slug.to_string(),
            label,
        });
    }
    if rows.is_empty() {
        None
    } else {
        Some(rows)
    }
}

fn probe_codex() -> Option<Vec<DiscoveredModel>> {
    let home = dirs::home_dir()?;
    let bytes = std::fs::read(home.join(".codex").join("models_cache.json")).ok()?;
    parse_codex_cache(&bytes)
}

// ── Antigravity (`agy`) ─────────────────────────────────────────────────────

/// The base model behind an `agy models` id, i.e. the id with any trailing
/// reasoning tier (`-low` / `-medium` / `-high`) stripped. The tier is a knob
/// the picker's Level chip drives, not a distinct model, so several tiered ids
/// collapse to one base row. `-thinking` is NOT a reasoning tier — it's part of
/// the model's identity (`claude-opus-4-6-thinking`) — so it's left intact.
fn agy_base_id(id: &str) -> &str {
    for suffix in ["-low", "-medium", "-high"] {
        if let Some(base) = id.strip_suffix(suffix) {
            return base;
        }
    }
    id
}

/// Parse `agy models` stdout — one model id per line. Only tokens that look
/// like an id (non-empty, no whitespace, alphanumeric lead) are kept, so a
/// stray banner/blank line can't become a phantom model. Tiered ids collapse to
/// one base row (first-seen order preserved) so the picker shows one model per
/// base and the shared Level chip picks the tier — `build_invocation` re-attaches
/// it. Membership stays CLI-authoritative: only bases the CLI reports appear.
fn parse_agy_models(stdout: &str) -> Option<Vec<DiscoveredModel>> {
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let rows: Vec<DiscoveredModel> = stdout
        .lines()
        .map(str::trim)
        .filter(|l| {
            !l.is_empty()
                && !l.contains(char::is_whitespace)
                && l.chars().next().is_some_and(|c| c.is_ascii_alphanumeric())
        })
        .map(agy_base_id)
        .filter(|base| seen.insert(base.to_string()))
        .map(|base| DiscoveredModel {
            id: base.to_string(),
            label: humanize_agy_id(base),
        })
        .collect();
    if rows.is_empty() {
        None
    } else {
        Some(rows)
    }
}

/// Resolve the `agy` binary: its documented install path first, then `$PATH`.
fn which_agy() -> Option<PathBuf> {
    if let Some(home) = dirs::home_dir() {
        let p = home.join(".local").join("bin").join("agy");
        if p.exists() {
            return Some(p);
        }
    }
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join("agy"))
        .find(|cand| cand.exists())
}

async fn probe_antigravity() -> Option<Vec<DiscoveredModel>> {
    let bin = which_agy()?;
    // `agy models` is quick; cap it hard so a wedged CLI can never stall the
    // catalog build (which the picker awaits on a cold cache).
    let output = tokio::time::timeout(
        Duration::from_secs(4),
        tokio::process::Command::new(&bin).arg("models").output(),
    )
    .await
    .ok()?
    .ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    parse_agy_models(&stdout)
}

/// Best-effort pretty label for an `agy` id we don't have a curated label for.
/// The current line is enriched from the catalog, so this only styles a *new*
/// id: `gemini-3.6-flash-high` → `Gemini 3.6 Flash · High`. Recognizes the
/// trailing reasoning tier and a few brand words; everything else title-cases.
fn humanize_agy_id(id: &str) -> String {
    let mut parts: Vec<&str> = id.split('-').collect();
    let effort = matches!(
        parts.last().copied(),
        Some("high") | Some("medium") | Some("low") | Some("max") | Some("thinking")
    )
    .then(|| parts.pop().unwrap());

    let base = parts
        .iter()
        .map(|tok| match *tok {
            "gpt" => "GPT".to_string(),
            "oss" => "OSS".to_string(),
            "gemini" => "Gemini".to_string(),
            "claude" => "Claude".to_string(),
            "sonnet" => "Sonnet".to_string(),
            "opus" => "Opus".to_string(),
            "flash" => "Flash".to_string(),
            "pro" => "Pro".to_string(),
            other => {
                let mut c = other.chars();
                match c.next() {
                    Some(f) => f.to_ascii_uppercase().to_string() + c.as_str(),
                    None => String::new(),
                }
            }
        })
        .collect::<Vec<_>>()
        .join(" ");

    match effort {
        Some(e) => {
            let mut c = e.chars();
            let e_title = c.next().map(|f| f.to_ascii_uppercase().to_string() + c.as_str());
            format!("{base} · {}", e_title.unwrap_or_default())
        }
        None => base,
    }
}

// ── Merge into the picker catalog ───────────────────────────────────────────

/// A stable per-row key derived from a wire id, for rows the curated catalog
/// didn't supply one for. Mirrors the catalog's own key convention so a later
/// hand-authored row for the same id lines up: `kimi-code/k3` → `kimi-k3`,
/// `gemini-3.6-flash-high` → `agy-gemini-3-6-flash-high`.
fn derive_key(family: &str, id: &str) -> String {
    let prefix = match family {
        "antigravity" => "agy",
        other => other,
    };
    let slug: String = id
        .rsplit('/')
        .next()
        .unwrap_or(id)
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '-' })
        .collect();
    format!("{prefix}-{slug}")
}

/// Fold a family's discovered models into its curated catalog rows.
///
/// Two merge policies, by family:
///
///   - **CLI-authoritative** (`kimi`, `antigravity`): the installed CLI defines
///     *membership* — only models it reports appear, in the CLI's order — while
///     the catalog supplies pretty metadata (label / key / NEW / brand) for any
///     id it recognizes. So an older CLI never offers a model it can't run, and
///     a newer CLI's fresh models surface immediately (marked NEW).
///   - **Shared native+CLI** (`openai`, `gemini`): the curated list is the
///     authoritative shape; discovery only *appends* ids it doesn't already
///     carry, never reordering or dropping a curated row — same contract as the
///     BYOK live-append.
///
/// `existing` is the family's curated rows (already brand-stamped);
/// `discovered` is what the probe found; `brand` supplies vendor marks for
/// brand-new ids.
pub fn merge_discovered(
    family: &str,
    existing: Vec<ModelInfo>,
    discovered: Vec<DiscoveredModel>,
    brand: &FamilyBrand,
) -> Vec<ModelInfo> {
    let authoritative = matches!(family, "kimi" | "antigravity");
    if authoritative {
        discovered
            .into_iter()
            .map(|d| {
                // Curated row for this exact id → keep it verbatim (its label,
                // key, NEW pill and brand are the hand-tuned truth).
                if let Some(cat) = existing.iter().find(|m| m.id == d.id) {
                    return cat.clone();
                }
                // A model the catalog doesn't know yet — surface it honestly,
                // flagged NEW, with the CLI's own label and the family brand.
                ModelInfo {
                    id: d.id.clone(),
                    label: d.label,
                    created: None,
                    key: Some(derive_key(family, &d.id)),
                    vendor: brand.vendor.clone(),
                    brand: brand.brand.clone(),
                    brand_name: brand.brand_name.clone(),
                    long_context: None,
                    is_new: Some(true),
                }
            })
            .collect()
    } else {
        let mut out = existing;
        let have: std::collections::HashSet<String> =
            out.iter().map(|m| m.id.clone()).collect();
        for d in discovered {
            if d.id.is_empty() || have.contains(&d.id) {
                continue;
            }
            out.push(ModelInfo {
                id: d.id.clone(),
                label: d.label,
                created: None,
                key: Some(derive_key(family, &d.id)),
                vendor: brand.vendor.clone(),
                brand: brand.brand.clone(),
                brand_name: brand.brand_name.clone(),
                long_context: None,
                is_new: Some(true),
            });
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cat_row(id: &str, label: &str, key: &str) -> ModelInfo {
        ModelInfo {
            id: id.to_string(),
            label: label.to_string(),
            created: None,
            key: Some(key.to_string()),
            vendor: Some("Moonshot AI".to_string()),
            brand: Some("kimi".to_string()),
            brand_name: Some("Kimi".to_string()),
            long_context: None,
            is_new: Some(true),
        }
    }

    #[test]
    fn kimi_config_lists_models_default_first() {
        let toml = r#"
default_model = "kimi-code/k3"

[models."kimi-code/kimi-for-coding"]
model = "kimi-for-coding"
display_name = "K2.7 Coding"

[models."kimi-code/kimi-for-coding-highspeed"]
model = "kimi-for-coding-highspeed"
display_name = "K2.7 Coding Highspeed"

[models."kimi-code/k3"]
model = "k3"
display_name = "K3"
"#;
        let rows = parse_kimi_config(toml).expect("parsed");
        // Default (K3) leads.
        assert_eq!(rows[0].id, "kimi-code/k3");
        assert_eq!(rows[0].label, "K3");
        // All three present, each with its real id + display name.
        let ids: Vec<&str> = rows.iter().map(|r| r.id.as_str()).collect();
        assert!(ids.contains(&"kimi-code/kimi-for-coding"));
        assert!(ids.contains(&"kimi-code/kimi-for-coding-highspeed"));
        assert_eq!(rows.len(), 3);
    }

    #[test]
    fn kimi_config_without_models_is_none() {
        assert!(parse_kimi_config("default_model = \"x\"\n").is_none());
    }

    #[test]
    fn codex_cache_drops_hidden_models() {
        let json = br#"{
            "models": [
                { "slug": "gpt-5.6-sol", "display_name": "GPT-5.6-Sol", "visibility": "list" },
                { "slug": "codex-auto-review", "display_name": "Auto Review", "visibility": "hide" }
            ]
        }"#;
        let rows = parse_codex_cache(json).expect("parsed");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, "gpt-5.6-sol");
        assert_eq!(rows[0].label, "GPT-5.6-Sol");
    }

    #[test]
    fn agy_models_collapses_tiers_to_base_rows() {
        // The three flash tiers collapse to one base row; the tier-less claude
        // id passes through; `-thinking` is kept (it's identity, not a tier).
        let out = "gemini-3.6-flash-high\ngemini-3.6-flash-medium\ngemini-3.6-flash-low\n\nclaude-sonnet-4-6\nclaude-opus-4-6-thinking\n";
        let rows = parse_agy_models(out).expect("parsed");
        let ids: Vec<&str> = rows.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(
            ids,
            vec!["gemini-3.6-flash", "claude-sonnet-4-6", "claude-opus-4-6-thinking"]
        );
        // First-seen order preserved; base gets a clean, tier-free label.
        assert_eq!(rows[0].label, "Gemini 3.6 Flash");
    }

    #[test]
    fn agy_base_id_strips_only_reasoning_tiers() {
        assert_eq!(agy_base_id("gemini-3.6-flash-high"), "gemini-3.6-flash");
        assert_eq!(agy_base_id("gemini-3.1-pro-low"), "gemini-3.1-pro");
        assert_eq!(agy_base_id("gpt-oss-120b-medium"), "gpt-oss-120b");
        // Not a reasoning tier — left whole.
        assert_eq!(agy_base_id("claude-opus-4-6-thinking"), "claude-opus-4-6-thinking");
        assert_eq!(agy_base_id("claude-sonnet-4-6"), "claude-sonnet-4-6");
    }

    #[test]
    fn humanizes_unknown_agy_ids() {
        assert_eq!(humanize_agy_id("gpt-oss-120b-medium"), "GPT OSS 120b · Medium");
        assert_eq!(humanize_agy_id("gemini-4-pro"), "Gemini 4 Pro");
    }

    #[test]
    fn derive_key_matches_catalog_convention() {
        assert_eq!(derive_key("kimi", "kimi-code/k3"), "kimi-k3");
        assert_eq!(
            derive_key("antigravity", "gemini-3.6-flash-high"),
            "agy-gemini-3-6-flash-high"
        );
    }

    #[test]
    fn authoritative_merge_takes_cli_membership_and_catalog_labels() {
        // Catalog knows K3 + K2.7 Coding; the installed CLI reports K3 + a
        // brand-new K4 (but NOT K2.7). Result: exactly what the CLI runs, K3
        // wearing its curated label, K4 surfaced as NEW.
        let existing = vec![
            cat_row("kimi-code/k3", "K3", "kimi-k3"),
            cat_row("kimi-code/kimi-for-coding", "K2.7 Coding", "kimi-k2-7-coding"),
        ];
        let discovered = vec![
            DiscoveredModel { id: "kimi-code/k3".into(), label: "K3 (raw)".into() },
            DiscoveredModel { id: "kimi-code/k4".into(), label: "K4".into() },
        ];
        let brand = FamilyBrand {
            vendor: Some("Moonshot AI".into()),
            brand: Some("kimi".into()),
            brand_name: Some("Kimi".into()),
        };
        let merged = merge_discovered("kimi", existing, discovered, &brand);
        let ids: Vec<&str> = merged.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, vec!["kimi-code/k3", "kimi-code/k4"]);
        // K3 kept its curated label, not the CLI's raw one.
        assert_eq!(merged[0].label, "K3");
        // K4 is surfaced as NEW with the family brand.
        assert_eq!(merged[1].label, "K4");
        assert_eq!(merged[1].is_new, Some(true));
        assert_eq!(merged[1].key.as_deref(), Some("kimi-k4"));
        assert_eq!(merged[1].brand_name.as_deref(), Some("Kimi"));
    }

    #[test]
    fn shared_family_merge_appends_only() {
        // openai: curated GPT-5.6 stays first; a CLI-only id is appended; a
        // duplicate id is ignored.
        let existing = vec![ModelInfo {
            id: "gpt-5.6-sol".into(),
            label: "GPT-5.6 Sol".into(),
            created: None,
            key: Some("gpt-5-6-sol".into()),
            vendor: Some("OpenAI".into()),
            brand: Some("codex".into()),
            brand_name: Some("GPT".into()),
            long_context: None,
            is_new: Some(true),
        }];
        let discovered = vec![
            DiscoveredModel { id: "gpt-5.6-sol".into(), label: "dup".into() },
            DiscoveredModel { id: "gpt-5.4-mini".into(), label: "GPT-5.4-Mini".into() },
        ];
        let brand = FamilyBrand {
            vendor: Some("OpenAI".into()),
            brand: Some("codex".into()),
            brand_name: Some("GPT".into()),
        };
        let merged = merge_discovered("openai", existing, discovered, &brand);
        let ids: Vec<&str> = merged.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, vec!["gpt-5.6-sol", "gpt-5.4-mini"]);
        // Curated row untouched (label preserved, not overwritten by "dup").
        assert_eq!(merged[0].label, "GPT-5.6 Sol");
    }
}
