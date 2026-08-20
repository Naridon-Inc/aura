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
    for (family, models) in probe_acp_agents().await {
        out.insert(family, models);
    }
    if let Some(v) = probe_pi().await {
        out.insert("pi".to_string(), v);
    }
    out
}

// ── pi ──────────────────────────────────────────────────────────────────────

/// Ask an installed pi for its own model list.
///
/// Same bargain as the ACP probe, over a different wire: pi answers
/// `get_available_models` with every model it has a provider configured for,
/// so the picker shows what this machine can actually run rather than a
/// table someone wrote once. It gets a family named `pi`, its own section in
/// the picker.
///
/// A pi that has never been signed in truthfully answers with nothing. That
/// arrives here as `Some(vec![])`, which [`merge_discovered`] turns into an
/// empty family — the picker drops the section entirely rather than showing
/// an engine that can run nothing, and nothing gets invented to fill it.
#[cfg(feature = "brain_pi")]
async fn probe_pi() -> Option<Vec<DiscoveredModel>> {
    let cwd = crate::spawn_dir::safe_spawn_dir("");
    let mut rows: Vec<DiscoveredModel> = crate::manager::brain::pi::probe_models(
        &cwd.to_string_lossy(),
    )
    .await?
    .into_iter()
    .map(|m| DiscoveredModel {
        id: m.id,
        label: m.label,
    })
    .collect();
    tidy_agent_labels(&mut rows);
    Some(rows)
}

/// Builds without the pi brain have no pi to ask.
#[cfg(not(feature = "brain_pi"))]
async fn probe_pi() -> Option<Vec<DiscoveredModel>> {
    None
}

// ── ACP agents (OpenCode, …) ────────────────────────────────────────────────

/// Ask every installed ACP agent for its own model list.
///
/// The other probes read a config file or a cached list; an ACP agent is
/// asked directly — it publishes `configOptions` from `session/new`, which is
/// the same list its own UI offers. Each agent gets a family of its own,
/// named for its registry id (`opencode`), so the picker can show it as its
/// own section the way Conductor does — and so a model shipped this morning
/// reaches the picker without anyone editing a table.
///
/// Costs nothing: the probe never prompts, so no tokens are spent. See
/// `manager::brain::acp::probe` for the lifecycle and its guards.
#[cfg(feature = "brain_acp")]
async fn probe_acp_agents() -> BTreeMap<String, Vec<DiscoveredModel>> {
    // A throwaway session has to be rooted somewhere real, and the catalog
    // build has no project in hand — `safe_spawn_dir("")` resolves to the
    // home directory, which is inert and always exists. Nothing is written
    // there: the session is opened for its reply and abandoned.
    let cwd = crate::spawn_dir::safe_spawn_dir("");
    let probed = crate::manager::brain::acp::probe_installed_agents(&cwd.to_string_lossy()).await;

    let mut out = BTreeMap::new();
    for agent in probed {
        let default = agent.facts.default_model.clone();
        let mut rows: Vec<DiscoveredModel> = agent
            .facts
            .models
            .iter()
            .filter_map(|choice| {
                // The wire value is whatever the agent will accept back in
                // `session/set_config_option`. Only string ids are usable as
                // a picker row; anything else we can't round-trip honestly.
                let id = choice.value.as_str()?.to_string();
                Some(DiscoveredModel {
                    id,
                    label: choice.name.clone(),
                })
            })
            .collect();
        tidy_agent_labels(&mut rows);
        // Float the agent's current selection to the front so the row the
        // engine is actually on leads its section.
        if let Some(def) = default {
            if let Some(pos) = rows.iter().position(|r| r.id == def) {
                let d = rows.remove(pos);
                rows.insert(0, d);
            }
        }
        if !rows.is_empty() {
            out.insert(agent.id.to_string(), rows);
        }
    }
    out
}

/// Builds without the ACP brain have no agents to ask.
#[cfg(not(feature = "brain_acp"))]
async fn probe_acp_agents() -> BTreeMap<String, Vec<DiscoveredModel>> {
    BTreeMap::new()
}

/// Drop the provider prefix an agent puts in front of its display names
/// ("OpenCode Zen/Big Pickle" → "Big Pickle"). The section header already
/// names the engine and each row already wears its maker's mark, so the
/// prefix is repeated furniture in a narrow list — it is exactly the raw
/// `moonshotai-cn/kimi-k3` look the picker should beat.
///
/// A prefix is only dropped where it stays unambiguous: if two rows would
/// then read the same, both keep their full name. The wire id is untouched
/// either way — only the label changes.
#[cfg(feature = "brain_acp")]
fn tidy_agent_labels(rows: &mut [DiscoveredModel]) {
    let short: Vec<String> = rows
        .iter()
        .map(|r| {
            r.label
                .rsplit('/')
                .next()
                .unwrap_or(&r.label)
                .trim()
                .to_string()
        })
        .collect();
    for (i, row) in rows.iter_mut().enumerate() {
        let candidate = &short[i];
        if candidate.is_empty() {
            continue;
        }
        let collides = short
            .iter()
            .enumerate()
            .any(|(j, other)| j != i && other == candidate);
        if !collides {
            row.label = candidate.clone();
        }
    }
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
    // An engine's family IS its published list — there is no curated
    // catalog behind it, so every row would otherwise wear a NEW pill and
    // the pill would mean nothing.
    let agent_published = is_engine_published_family(family);
    let authoritative = agent_published || matches!(family, "kimi" | "antigravity");
    let mark_new = !agent_published;
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
                row_for(family, d, brand, mark_new)
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
            out.push(row_for(family, d, brand, mark_new));
        }
        out
    }
}

/// Is this family an engine's own section (`opencode`, `pi`, …) — one where
/// the engine publishes the list and this repo curates nothing?
///
/// The ACP half reads off the agent table rather than a second literal list,
/// so adding an agent can't leave the picker treating its family as a stale
/// curated one. pi is named directly because there is exactly one of it.
fn is_engine_published_family(family: &str) -> bool {
    #[cfg(feature = "brain_pi")]
    if family == crate::manager::brain::pi::PROVIDER_ID {
        return true;
    }
    #[cfg(feature = "brain_acp")]
    {
        crate::manager::brain::acp::known_agent_ids().contains(&family)
    }
    #[cfg(not(feature = "brain_acp"))]
    {
        let _ = family;
        false
    }
}

/// Shape one discovered model into a picker row.
fn row_for(
    family: &str,
    d: DiscoveredModel,
    family_brand: &FamilyBrand,
    mark_new: bool,
) -> ModelInfo {
    // Brand the row by who MAKES the model when the id says so — an agent
    // that multiplexes vendors (`anthropic/claude-sonnet-4-6`) should show
    // the Claude mark on that row, not the agent's own mark on all of them.
    let brand = brand_from_model_id(&d.id).unwrap_or_else(|| family_brand.clone());
    ModelInfo {
        id: d.id.clone(),
        label: d.label,
        created: None,
        key: Some(derive_key(family, &d.id)),
        vendor: brand.vendor,
        brand: brand.brand,
        brand_name: brand.brand_name,
        long_context: None,
        is_new: mark_new.then_some(true),
    }
}

/// The vendor a `provider/model` id names, when we recognize the provider.
/// `None` for a bare id (no prefix) or a provider we have no mark for — the
/// caller then falls back to the family's own brand rather than guessing.
fn brand_from_model_id(id: &str) -> Option<FamilyBrand> {
    let provider = id.split('/').next()?;
    if provider == id {
        return None; // no `provider/` prefix to read
    }
    let p = provider.to_ascii_lowercase();
    let (vendor, brand, brand_name) = if p.starts_with("anthropic") || p.contains("claude") {
        ("Anthropic", "claude", "Claude")
    } else if p.starts_with("openai") {
        ("OpenAI", "codex", "GPT")
    } else if p.starts_with("google") || p.starts_with("gemini") {
        ("Google", "gemini", "Gemini")
    } else if p.starts_with("moonshot") || p.starts_with("kimi") {
        ("Moonshot AI", "kimi", "Kimi")
    } else if p.starts_with("xai") {
        ("xAI", "xai", "Grok")
    } else {
        return None;
    };
    Some(FamilyBrand {
        vendor: Some(vendor.to_string()),
        brand: Some(brand.to_string()),
        brand_name: Some(brand_name.to_string()),
    })
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

    /// Labels captured from a real `opencode acp` handshake. The provider
    /// prefix comes off where it can, and stays where dropping it would make
    /// two rows read alike.
    #[cfg(feature = "brain_acp")]
    #[test]
    fn agent_labels_lose_the_provider_prefix_unless_it_disambiguates() {
        let mut rows = vec![
            DiscoveredModel { id: "opencode/big-pickle".into(), label: "OpenCode Zen/Big Pickle".into() },
            DiscoveredModel {
                id: "opencode/deepseek-v4-flash-free".into(),
                label: "OpenCode Zen/DeepSeek V4 Flash Free (New)".into(),
            },
            // Same model from two providers — the prefix is the only thing
            // telling them apart, so it has to stay on both.
            DiscoveredModel { id: "anthropic/claude-sonnet-4-6".into(), label: "Anthropic/Sonnet 4.6".into() },
            DiscoveredModel { id: "bedrock/claude-sonnet-4-6".into(), label: "Bedrock/Sonnet 4.6".into() },
        ];
        tidy_agent_labels(&mut rows);
        assert_eq!(rows[0].label, "Big Pickle");
        assert_eq!(rows[1].label, "DeepSeek V4 Flash Free (New)");
        assert_eq!(rows[2].label, "Anthropic/Sonnet 4.6");
        assert_eq!(rows[3].label, "Bedrock/Sonnet 4.6");
        // Ids are the wire contract and must survive untouched.
        assert_eq!(rows[0].id, "opencode/big-pickle");
    }

    /// An ACP agent's family is whatever the running agent published — there
    /// is no curated list behind it. So: membership comes from the agent, no
    /// row wears a NEW pill (against what would it be new?), and a row whose
    /// id names its maker wears that maker's mark rather than the agent's.
    #[cfg(feature = "brain_acp")]
    #[test]
    fn an_agent_published_family_brands_each_row_by_its_maker() {
        let discovered = vec![
            DiscoveredModel { id: "opencode/big-pickle".into(), label: "Big Pickle".into() },
            DiscoveredModel { id: "anthropic/claude-sonnet-4-6".into(), label: "Claude Sonnet 4.6".into() },
            DiscoveredModel { id: "moonshotai-cn/kimi-k3".into(), label: "Kimi K3".into() },
        ];
        let brand = FamilyBrand {
            vendor: Some("OpenCode".into()),
            brand: Some("opencode".into()),
            brand_name: Some("OpenCode".into()),
        };
        let merged = merge_discovered("opencode", vec![], discovered, &brand);
        let ids: Vec<&str> = merged.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(
            ids,
            vec!["opencode/big-pickle", "anthropic/claude-sonnet-4-6", "moonshotai-cn/kimi-k3"]
        );
        assert!(
            merged.iter().all(|m| m.is_new.is_none()),
            "an agent-published row has no curated list to be new against"
        );
        // The agent's own model keeps the agent's mark; the vendor-prefixed
        // ones wear the vendor's.
        assert_eq!(merged[0].brand.as_deref(), Some("opencode"));
        assert_eq!(merged[1].brand.as_deref(), Some("claude"));
        assert_eq!(merged[1].brand_name.as_deref(), Some("Claude"));
        assert_eq!(merged[2].brand.as_deref(), Some("kimi"));
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

    /// The whole catalog path, against whatever is really installed here.
    ///
    /// Every other test in this file feeds `merge_discovered` a list someone
    /// typed. This one runs the function the picker calls and prints what
    /// comes back, so "the composer only shows Default" can be answered with
    /// the rows themselves rather than by reasoning about the code. Ignored
    /// because it spawns real agents and depends on this machine; run it with
    /// `--ignored --nocapture` when a picker section looks wrong.
    #[tokio::test]
    #[ignore]
    async fn what_the_picker_actually_gets_from_this_machine() {
        let families = discover_all().await;
        for (family, rows) in &families {
            println!("{family} ({} models)", rows.len());
            for r in rows {
                println!("    {}  →  {}", r.id, r.label);
            }
        }
        assert!(
            !families.is_empty(),
            "no engine on this machine published a model list"
        );
    }
}
