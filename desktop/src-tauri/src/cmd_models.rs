//! Live model catalog — the *stable source* for the composer model picker.
//!
//! The picker used to hardcode model lists (Gemini 2.5 only, guessed GPT
//! ids, …), which drifted the moment a provider shipped something new. The
//! user's verdict: "are you not keeping a stable thing as the source … or
//! some other api from each provider?". The answer here is each provider's
//! own `/models` endpoint — the authority that always knows what it serves:
//!
//!   - Anthropic  `GET https://api.anthropic.com/v1/models`
//!   - OpenAI     `GET https://api.openai.com/v1/models`
//!   - Gemini     `GET https://generativelanguage.googleapis.com/v1beta/models`
//!
//! Results are cached to `~/.aura/model_catalog_cache.json` for 24h so the
//! picker opens instantly and works offline; `force` skips the cache. Each
//! family is fetched independently and its error captured in `errors`, so a
//! missing key (or a down provider) for one family never blanks the others —
//! the frontend falls back to its curated static list per family.
//!
//! Keys are resolved without ever surfacing them to the UI: keychain
//! (`anthropic_native` / `openai_native` / `gemini_native`) → provider env
//! var → `~/.aura/config.json` `api_keys.*`, mirroring `legacy::resolve_api_key`.

use std::collections::BTreeMap;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::manager::brain::keychain;

/// One concrete model a provider currently serves. `created` is the
/// provider's own recency signal (unix seconds) when it exposes one —
/// used to sort newest-first; `None` keeps API order. The brand fields
/// (`vendor` / `brand` / `brand_name`) come from the Aura catalog so the
/// picker can show the real Claude/Gemini/GPT mark + name per row without
/// re-deriving them on the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created: Option<i64>,
    /// Stable per-row key from the Aura catalog (unique within a family —
    /// the 1M and base rows share an `id`, so this disambiguates).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    /// Vendor display name, e.g. "Anthropic" / "Google" / "OpenAI".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vendor: Option<String>,
    /// Icon slug for `AgentIcon` — "claude" / "gemini" / "codex".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub brand: Option<String>,
    /// Brand name shown next to the model label — "Claude" / "Gemini" / "GPT".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub brand_name: Option<String>,
    /// True for the 1M-context variant → `ChatRequest.long_context`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub long_context: Option<bool>,
    /// Recently-shipped → NEW pill.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_new: Option<bool>,
}

/// The whole picker catalog: one entry per vendor family the frontend
/// groups by (`anthropic` / `openai` / `gemini`), plus any per-family
/// fetch errors so the UI can fall back to its static list and explain why.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelCatalog {
    /// Unix seconds when this catalog was fetched (cache-age display + TTL).
    pub fetched_at: i64,
    /// True when served from the on-disk cache rather than a live fetch.
    pub cached: bool,
    pub families: BTreeMap<String, Vec<ModelInfo>>,
    pub errors: BTreeMap<String, String>,
}

const CACHE_TTL_SECS: u64 = 24 * 60 * 60;
const CACHE_FILE: &str = "model_catalog_cache.json";

// ── Aura-owned catalog (single source of truth) ──────────────────────────
//
// The offered set is defined by Aura, not scraped raw from each provider's
// `/models` (which leaks stale point-release ids and lags brand metadata).
// We ship a curated catalog embedded in the binary AND try a short-timeout
// fetch of the same file hosted by Aura, so customers get new models the
// moment we publish — no app release needed. Remote wins when reachable;
// the embedded copy is the always-works floor (offline, 404-before-deploy).

/// The curated catalog baked into the binary — the floor that always works.
const AURA_CATALOG_JSON: &str = include_str!("../model_catalog.json");
/// The Aura-hosted copy of the same file. A new model published here reaches
/// every customer on their next catalog refresh without an app update.
const AURA_CATALOG_URL: &str = "https://auravcs.com/models/catalog.json";

/// One model entry in the Aura catalog file (`model_catalog.json`). The
/// brand fields are carried per-family, not per-model, so they're folded in
/// when we expand a family.
///
/// `model_catalog.json` (and the hosted copy at {@link AURA_CATALOG_URL}) is
/// authored in camelCase — `longContext`, `isNew`, `brandName` — to match the
/// `ModelInfo` wire shape the frontend consumes. Without `rename_all` here the
/// required `brand_name` field would be absent on every family, the whole
/// `AuraCatalog` parse would fail, and the ledger would silently degrade to an
/// empty catalog (forcing the frontend's static fallback and killing the
/// no-app-release model-update path). Keep these in sync with the JSON keys.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuraCatalogModel {
    key: String,
    /// `null` keeps the brain on its own default (custom endpoints).
    #[serde(default)]
    id: Option<String>,
    label: String,
    #[serde(default)]
    long_context: Option<bool>,
    #[serde(default)]
    is_new: Option<bool>,
}

/// One vendor family in the Aura catalog — its brand metadata + model rows.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuraCatalogFamily {
    vendor: String,
    brand: String,
    brand_name: String,
    models: Vec<AuraCatalogModel>,
}

/// The whole Aura catalog file.
#[derive(Debug, Clone, Deserialize)]
struct AuraCatalog {
    families: BTreeMap<String, AuraCatalogFamily>,
}

impl AuraCatalog {
    /// Expand one family into the picker's `ModelInfo` rows, stamping each
    /// with the family's brand metadata so the frontend can render the mark
    /// and name directly off the row.
    fn family_models(&self, family: &str) -> Vec<ModelInfo> {
        let Some(fam) = self.families.get(family) else {
            return Vec::new();
        };
        fam.models
            .iter()
            .map(|m| ModelInfo {
                // `id: null` in the catalog → empty wire id; the frontend
                // treats "" the same as its own `id: null` "Default" row.
                id: m.id.clone().unwrap_or_default(),
                label: m.label.clone(),
                created: None,
                key: Some(m.key.clone()),
                vendor: Some(fam.vendor.clone()),
                brand: Some(fam.brand.clone()),
                brand_name: Some(fam.brand_name.clone()),
                long_context: m.long_context,
                is_new: m.is_new,
            })
            .collect()
    }
}

/// Parse the embedded catalog. This is checked-in JSON we author, so a parse
/// failure is a build-time bug — but we still degrade to an empty catalog
/// rather than panic so the provider live-fetch path can carry the picker.
fn embedded_aura_catalog() -> AuraCatalog {
    serde_json::from_str::<AuraCatalog>(AURA_CATALOG_JSON).unwrap_or(AuraCatalog {
        families: BTreeMap::new(),
    })
}

/// Brand metadata (vendor / icon slug / brand name) for a family, for stamping
/// onto rows that CLI discovery surfaces which the curated catalog didn't carry.
/// Prefers the catalog's own family metadata; falls back to a fixed map so a
/// brand-new model still shows the right mark even if the family is somehow
/// absent from the catalog.
fn family_brand(aura: &AuraCatalog, family: &str) -> crate::model_discovery::FamilyBrand {
    if let Some(fam) = aura.families.get(family) {
        return crate::model_discovery::FamilyBrand {
            vendor: Some(fam.vendor.clone()),
            brand: Some(fam.brand.clone()),
            brand_name: Some(fam.brand_name.clone()),
        };
    }
    // An ACP agent gets a family named for itself (`opencode`). It isn't in
    // the curated catalog — the agent publishes its own models — so take the
    // mark and the name straight off the agent table.
    #[cfg(feature = "brain_acp")]
    if let Some(agent) = crate::manager::brain::acp::brain::agent_by_id(family) {
        return crate::model_discovery::FamilyBrand {
            vendor: Some(agent.label.to_string()),
            brand: Some(agent.id.to_string()),
            brand_name: Some(agent.label.to_string()),
        };
    }
    let (vendor, brand, brand_name) = match family {
        // pi publishes its own list too, but it isn't in the ACP agent table
        // — it speaks its own RPC. Same shape of answer.
        "pi" => ("pi", "pi", "pi"),
        "kimi" => ("Moonshot AI", "kimi", "Kimi"),
        "antigravity" => ("Google", "antigravity", "Antigravity"),
        "openai" => ("OpenAI", "codex", "GPT"),
        "gemini" => ("Google", "gemini", "Gemini"),
        "anthropic" => ("Anthropic", "claude", "Claude"),
        _ => return crate::model_discovery::FamilyBrand::default(),
    };
    crate::model_discovery::FamilyBrand {
        vendor: Some(vendor.to_string()),
        brand: Some(brand.to_string()),
        brand_name: Some(brand_name.to_string()),
    }
}

/// Fetch the Aura-hosted catalog with a short timeout. ANY failure (offline,
/// 404 before the file is deployed, malformed) falls back to the embedded
/// copy — this never errors out, the picker always has a curated set.
async fn fetch_aura_catalog(client: &reqwest::Client) -> AuraCatalog {
    match client
        .get(AURA_CATALOG_URL)
        .timeout(Duration::from_secs(4))
        .send()
        .await
    {
        Ok(resp) if resp.status().is_success() => match resp.json::<AuraCatalog>().await {
            Ok(cat) if !cat.families.is_empty() => cat,
            _ => embedded_aura_catalog(),
        },
        _ => embedded_aura_catalog(),
    }
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn cache_path() -> Option<std::path::PathBuf> {
    let mut p = dirs::home_dir()?;
    p.push(".aura");
    p.push(CACHE_FILE);
    Some(p)
}

fn read_cache() -> Option<ModelCatalog> {
    let bytes = std::fs::read(cache_path()?).ok()?;
    serde_json::from_slice::<ModelCatalog>(&bytes).ok()
}

fn write_cache(cat: &ModelCatalog) {
    let Some(path) = cache_path() else { return };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(bytes) = serde_json::to_vec_pretty(cat) {
        let _ = std::fs::write(path, bytes);
    }
}

/// Drop the cached catalog so the next `agent_models_list` re-fetches.
///
/// The cache holds the *answer a set of credentials produced* — which models
/// each key was granted, and the per-family error when a key was missing or
/// rejected. Change a key and that answer is stale by construction, but the
/// TTL is 24h: someone who pastes a valid Gemini key keeps seeing the curated
/// floor (and the "API key not valid" that the *old* key earned) for the rest
/// of the day, with nothing on screen saying why. Every credential mutation
/// calls this, so the next open asks the provider again.
pub fn invalidate_cache() {
    if let Some(path) = cache_path() {
        let _ = std::fs::remove_file(path);
    }
}

// ── API key resolution (keychain → env → ~/.aura/config.json) ───────────

/// `(keychain provider_id, env var, config.json api_keys key)` per family.
fn key_triplet(family: &str) -> Option<(&'static str, &'static str, &'static str)> {
    match family {
        "anthropic" => Some(("anthropic_native", "ANTHROPIC_API_KEY", "anthropic")),
        "openai" => Some(("openai_native", "OPENAI_API_KEY", "openai")),
        "gemini" => Some(("gemini_native", "GEMINI_API_KEY", "gemini")),
        // OpenRouter's key lives under the same `openai_compat:openrouter`
        // provider slot the Brain settings save it to — so the picker's
        // OpenRouter family and the brain that runs it read one key, not two.
        "openrouter" => Some(("openai_compat:openrouter", "OPENROUTER_API_KEY", "openrouter")),
        _ => None,
    }
}

fn config_api_key(json_key: &str) -> Option<String> {
    let home = std::env::var_os("HOME")?;
    let mut path = std::path::PathBuf::from(home);
    path.push(".aura");
    path.push("config.json");
    let bytes = std::fs::read(&path).ok()?;
    let v: Value = serde_json::from_slice(&bytes).ok()?;
    v.get("api_keys")
        .and_then(|x| x.get(json_key))
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty())
}

/// Resolve the API key for a family, preferring the OS keychain, then the
/// provider env var, then `~/.aura/config.json`. Returns `None` when no key
/// is configured (caller records a friendly per-family error).
fn resolve_key(family: &str) -> Option<String> {
    let (provider_id, env_var, json_key) = key_triplet(family)?;
    if let Ok(Some(k)) = keychain::get_api_key(provider_id) {
        if !k.is_empty() {
            return Some(k);
        }
    }
    if let Ok(k) = std::env::var(env_var) {
        if !k.is_empty() {
            return Some(k);
        }
    }
    config_api_key(json_key)
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("http client: {e}"))
}

// ── Label humanizers ────────────────────────────────────────────────────

/// Turn a bare OpenAI id (`gpt-5.5`, `o3-mini`) into a display label
/// (`GPT-5.5`, `O3 Mini`). OpenAI's `/models` exposes no display names.
fn humanize_openai(id: &str) -> String {
    if let Some(rest) = id.strip_prefix("gpt-") {
        return format!("GPT-{rest}");
    }
    // o1 / o3 / o4 reasoning line: keep the family letter uppercase.
    let mut chars = id.chars();
    match chars.next() {
        Some(c) => format!("{}{}", c.to_uppercase(), chars.as_str()).replace('-', " "),
        None => id.to_string(),
    }
}

/// A dated snapshot pin (`gpt-4-0613`, `gemini-2.0-flash-001`) — any
/// hyphen-delimited segment that's ≥3 all-digit chars. The picker shows the
/// rolling alias, not every frozen point-release, so these are dropped.
fn is_dated_pin(id: &str) -> bool {
    id.split('-')
        .any(|seg| seg.len() >= 3 && seg.chars().all(|c| c.is_ascii_digit()))
}

/// Leading `major.minor` version embedded after a family prefix
/// (`gemini-3.1-flash` → 3.1, `gemini-3-pro` → 3.0). Used to sort families
/// whose `/models` endpoint carries no `created` timestamp. Unparseable → 0.
fn leading_version(id: &str, prefix: &str) -> f64 {
    let rest = id.strip_prefix(prefix).unwrap_or(id);
    let token: String = rest
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '.')
        .collect();
    token.parse().unwrap_or(0.0)
}

// ── Per-provider fetchers ───────────────────────────────────────────────

/// Anthropic: `GET /v1/models`, `x-api-key` + `anthropic-version` headers.
/// Returns `{data:[{id, display_name, created_at}]}`, newest first; every
/// row is a chat model so we keep them all.
async fn fetch_anthropic(client: &reqwest::Client, key: &str) -> Result<Vec<ModelInfo>, String> {
    let resp = client
        .get("https://api.anthropic.com/v1/models?limit=100")
        .header("x-api-key", key)
        .header("anthropic-version", "2023-06-01")
        .send()
        .await
        .map_err(|e| format!("GET anthropic models: {e}"))?;
    let status = resp.status();
    let body: Value = resp.json().await.map_err(|e| format!("parse anthropic: {e}"))?;
    if !status.is_success() {
        return Err(format!("anthropic HTTP {status}: {}", err_message(&body)));
    }
    let rows = body
        .get("data")
        .and_then(|d| d.as_array())
        .ok_or("anthropic: no `data` array")?;
    let mut out = Vec::new();
    for m in rows {
        let Some(id) = m.get("id").and_then(|x| x.as_str()) else {
            continue;
        };
        let label = m
            .get("display_name")
            .and_then(|x| x.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| id.to_string());
        out.push(ModelInfo {
            id: id.to_string(),
            label,
            // `created_at` is an ISO string here; the array is already
            // newest-first, so we lean on order rather than parsing it.
            created: None,
            key: None,
            vendor: None,
            brand: None,
            brand_name: None,
            long_context: None,
            is_new: None,
        });
    }
    Ok(out)
}

/// OpenAI: `GET /v1/models`, bearer. Returns `{data:[{id, created}]}` —
/// hundreds of rows incl. embeddings/audio/tts, so we keep only the
/// chat-capable gpt-* / o-series and drop the non-conversational variants.
async fn fetch_openai(client: &reqwest::Client, key: &str) -> Result<Vec<ModelInfo>, String> {
    let resp = client
        .get("https://api.openai.com/v1/models")
        .bearer_auth(key)
        .send()
        .await
        .map_err(|e| format!("GET openai models: {e}"))?;
    let status = resp.status();
    let body: Value = resp.json().await.map_err(|e| format!("parse openai: {e}"))?;
    if !status.is_success() {
        return Err(format!("openai HTTP {status}: {}", err_message(&body)));
    }
    let rows = body
        .get("data")
        .and_then(|d| d.as_array())
        .ok_or("openai: no `data` array")?;
    let mut out = Vec::new();
    for m in rows {
        let Some(id) = m.get("id").and_then(|x| x.as_str()) else {
            continue;
        };
        if !is_openai_chat_model(id) {
            continue;
        }
        let created = m.get("created").and_then(|x| x.as_i64());
        out.push(ModelInfo {
            id: id.to_string(),
            label: humanize_openai(id),
            created,
            key: None,
            vendor: None,
            brand: None,
            brand_name: None,
            long_context: None,
            is_new: None,
        });
    }
    // Newest first by the provider's own `created` epoch.
    out.sort_by(|a, b| b.created.unwrap_or(0).cmp(&a.created.unwrap_or(0)));
    Ok(out)
}

/// Keep only conversational chat/reasoning models. OpenAI's `/models` is a
/// grab-bag; an allow-by-prefix + deny-by-substring keeps the picker clean
/// without hardcoding a frozen id list.
fn is_openai_chat_model(id: &str) -> bool {
    let chat = id.starts_with("gpt-")
        || id.starts_with("o1")
        || id.starts_with("o3")
        || id.starts_with("o4")
        || id.starts_with("chatgpt");
    if !chat || is_dated_pin(id) {
        return false;
    }
    const DENY: [&str; 9] = [
        "audio",
        "realtime",
        "transcribe",
        "tts",
        "image",
        "search",
        "embedding",
        "moderation",
        "instruct",
    ];
    !DENY.iter().any(|d| id.contains(d))
}

/// Gemini: `GET /v1beta/models?key=…`. Returns
/// `{models:[{name, displayName, supportedGenerationMethods}]}`; `name` is
/// `models/<id>`. Keep `gemini-*` rows that support `generateContent`.
async fn fetch_gemini(client: &reqwest::Client, key: &str) -> Result<Vec<ModelInfo>, String> {
    let url = format!(
        "https://generativelanguage.googleapis.com/v1beta/models?key={key}&pageSize=200"
    );
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("GET gemini models: {e}"))?;
    let status = resp.status();
    let body: Value = resp.json().await.map_err(|e| format!("parse gemini: {e}"))?;
    if !status.is_success() {
        return Err(format!("gemini HTTP {status}: {}", err_message(&body)));
    }
    let rows = body
        .get("models")
        .and_then(|d| d.as_array())
        .ok_or("gemini: no `models` array")?;
    let mut out = Vec::new();
    for m in rows {
        let Some(name) = m.get("name").and_then(|x| x.as_str()) else {
            continue;
        };
        let id = name.strip_prefix("models/").unwrap_or(name);
        if !id.starts_with("gemini-") || !is_gemini_chat_model(id) {
            continue;
        }
        let supports_chat = m
            .get("supportedGenerationMethods")
            .and_then(|x| x.as_array())
            .map(|a| a.iter().any(|v| v.as_str() == Some("generateContent")))
            .unwrap_or(false);
        if !supports_chat {
            continue;
        }
        let label = m
            .get("displayName")
            .and_then(|x| x.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| id.to_string());
        out.push(ModelInfo {
            id: id.to_string(),
            label,
            created: None,
            key: None,
            vendor: None,
            brand: None,
            brand_name: None,
            long_context: None,
            is_new: None,
        });
    }
    // No `created` field on Gemini's `/models`; sort newest-first by the
    // embedded version (3.5 > 3.1 > 3 > 2.5 > 2.0), ties keep API order.
    out.sort_by(|a, b| {
        leading_version(&b.id, "gemini-")
            .partial_cmp(&leading_version(&a.id, "gemini-"))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    Ok(out)
}

/// Keep conversational Gemini models; drop the image/TTS/embedding variants
/// ("Nano Banana" image-gen, `-tts`, `-embedding`), the `-latest` rolling
/// aliases (redundant with the concrete id) and dated `-001` pins.
fn is_gemini_chat_model(id: &str) -> bool {
    if is_dated_pin(id) {
        return false;
    }
    const DENY: [&str; 8] = [
        "image",
        "tts",
        "embedding",
        "aqa",
        "audio",
        "latest",
        "customtools",
        "robotics",
    ];
    !DENY.iter().any(|d| id.contains(d))
}

/// Best-effort extraction of a provider's JSON error message for surfacing.
fn err_message(body: &Value) -> String {
    body.get("error")
        .and_then(|e| e.get("message").or(Some(e)))
        .and_then(|m| m.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| body.to_string())
}

// ── OpenRouter ───────────────────────────────────────────────────────────
//
// OpenRouter is a first-class family here, exactly like Anthropic/OpenAI/Gemini
// — not a side door — so its whole catalog reaches the picker rather than the
// single hardcoded default the openai_compat provider preset carried. Two
// things make it worth its own fetch rather than the generic openai-compat
// `/models`: the endpoint returns human names AND per-model pricing, and that
// pricing is what keeps the per-response dollar figure true (OpenRouter adds a
// routing margin, so a "sonnet" priced at Anthropic's list rate would read low).

/// One model's per-MTok rate as OpenRouter publishes it. OpenRouter quotes USD
/// PER TOKEN as strings ("0.000003"); we convert to per-million to match how
/// `pricing.rs` and every provider pricing page state rates.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct OpenRouterRate {
    pub input_per_mtok: f64,
    pub output_per_mtok: f64,
}

/// Parse OpenRouter's `/api/v1/models` body into picker rows + a price map
/// keyed by model id. Pure, so the shape handling is unit-tested against a
/// fixture without a live key. A row missing an `id` is skipped; a row whose
/// pricing is absent or unparanumeric simply carries no rate (the meter falls
/// back to its tier estimate for it, never a made-up exact figure).
fn parse_openrouter_catalog(
    body: &Value,
) -> (Vec<ModelInfo>, BTreeMap<String, OpenRouterRate>) {
    let mut rows = Vec::new();
    let mut prices = BTreeMap::new();
    let Some(data) = body.get("data").and_then(|d| d.as_array()) else {
        return (rows, prices);
    };
    for m in data {
        let Some(id) = m.get("id").and_then(|x| x.as_str()) else {
            continue;
        };
        let label = m
            .get("name")
            .and_then(|x| x.as_str())
            .filter(|s| !s.is_empty())
            .unwrap_or(id)
            .to_string();
        rows.push(ModelInfo {
            id: id.to_string(),
            label,
            created: m.get("created").and_then(|x| x.as_i64()),
            key: None,
            vendor: None,
            brand: Some("openrouter".to_string()),
            brand_name: Some("OpenRouter".to_string()),
            long_context: None,
            is_new: None,
        });
        // Pricing is USD/token as a string; only record it when both sides
        // parse to a real, non-negative number.
        if let Some(p) = m.get("pricing") {
            let per_tok = |field: &str| -> Option<f64> {
                p.get(field)
                    .and_then(|v| v.as_str())
                    .and_then(|s| s.parse::<f64>().ok())
                    .filter(|n| n.is_finite() && *n >= 0.0)
            };
            if let (Some(prompt), Some(completion)) = (per_tok("prompt"), per_tok("completion")) {
                prices.insert(
                    id.to_string(),
                    OpenRouterRate {
                        input_per_mtok: prompt * 1_000_000.0,
                        output_per_mtok: completion * 1_000_000.0,
                    },
                );
            }
        }
    }
    // Newest first when OpenRouter gives a created epoch; ties keep API order.
    rows.sort_by(|a, b| b.created.unwrap_or(0).cmp(&a.created.unwrap_or(0)));
    (rows, prices)
}

/// Where the machine-fetched OpenRouter rates live — a cache the pricing
/// resolver reads. Kept SEPARATE from the user's `model_prices.json` so a
/// refresh never clobbers a rate someone typed by hand (and the user file
/// still wins outright — see `pricing::price_for`).
fn openrouter_prices_path() -> Option<std::path::PathBuf> {
    let home = std::env::var_os("HOME")?;
    let mut path = std::path::PathBuf::from(home);
    path.push(".aura");
    path.push("model_prices_openrouter.json");
    Some(path)
}

/// Persist the fetched OpenRouter rates so the cost meter can bill its models
/// at OpenRouter's own published prices. Best-effort: a write failure leaves
/// the meter on its tier estimate, which is a worse figure but never a wrong
/// catalog. Shape mirrors `model_prices.json`: `{ "<id>": {"in":N,"out":N} }`.
fn persist_openrouter_prices(prices: &BTreeMap<String, OpenRouterRate>) {
    let Some(path) = openrouter_prices_path() else {
        return;
    };
    let map: BTreeMap<&String, Value> = prices
        .iter()
        .map(|(id, r)| (id, json!({ "in": r.input_per_mtok, "out": r.output_per_mtok })))
        .collect();
    if let Ok(text) = serde_json::to_string_pretty(&map) {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(&path, text);
    }
}

/// OpenRouter: `GET /api/v1/models`, bearer. Returns `{data:[{id, name,
/// pricing:{prompt, completion}, …}]}`. Populates the picker AND refreshes the
/// price cache as a side effect so the two never drift.
async fn fetch_openrouter(
    client: &reqwest::Client,
    key: &str,
) -> Result<Vec<ModelInfo>, String> {
    let resp = client
        .get("https://openrouter.ai/api/v1/models")
        .bearer_auth(key)
        .send()
        .await
        .map_err(|e| format!("GET openrouter models: {e}"))?;
    let status = resp.status();
    let body: Value = resp
        .json()
        .await
        .map_err(|e| format!("parse openrouter: {e}"))?;
    if !status.is_success() {
        return Err(format!("openrouter HTTP {status}: {}", err_message(&body)));
    }
    let (rows, prices) = parse_openrouter_catalog(&body);
    if rows.is_empty() {
        return Err("openrouter: no `data` array".to_string());
    }
    persist_openrouter_prices(&prices);
    Ok(rows)
}

// ── Tauri command ───────────────────────────────────────────────────────

/// Build the model catalog the picker offers.
///
/// The Aura-owned catalog (remote → embedded) is AUTHORITATIVE for the
/// offered set: every family is seeded from it, carrying the curated rows +
/// brand metadata (icon slug + brand name) so customers always see the right
/// models with the right marks, and new models reach them the moment Aura
/// publishes — no app release. When the user has a provider key, the live
/// `/models` fetch ONLY enriches: any chat model the account exposes that the
/// curated list doesn't already carry is appended (so BYOK users still see
/// their account's extras), but the curated rows are never dropped or
/// reordered, so no stale raw id ever leaks to the front.
///
/// Served from the 24h disk cache unless stale or `force`. Live fetch errors
/// are non-fatal now (the curated set already populated the family) but are
/// still recorded in `errors` for the UI's key-status surfacing.
#[tauri::command]
pub async fn agent_models_list(force: Option<bool>) -> Result<ModelCatalog, String> {
    let force = force.unwrap_or(false);
    if !force {
        if let Some(cached) = read_cache() {
            let age = now_secs().saturating_sub(cached.fetched_at);
            if age >= 0 && (age as u64) < CACHE_TTL_SECS {
                return Ok(ModelCatalog {
                    cached: true,
                    ..cached
                });
            }
        }
    }

    let client = http_client()?;
    // The Aura catalog defines what's shown. Remote (auravcs.com) wins when
    // reachable; the embedded copy is the always-works floor.
    let aura = fetch_aura_catalog(&client).await;

    let mut families: BTreeMap<String, Vec<ModelInfo>> = BTreeMap::new();
    let mut errors: BTreeMap<String, String> = BTreeMap::new();

    // `kimi` and `antigravity` are CLI-wrapper families with no first-party key
    // slot — they were never served by the backend before, so the frontend fell
    // back to its static list. Include them here so their curated catalog rows
    // (and the CLI discovery below) reach the picker like every other family.
    for family in ["anthropic", "openai", "gemini", "openrouter", "xai", "kimi", "antigravity"] {
        // Seed from the curated Aura catalog — this is the offered set.
        let mut rows = aura.family_models(family);

        // Enrich with the user's own account when a key is present. A live
        // fetch can ONLY append ids the curated set doesn't already carry; it
        // never removes or reorders the curated rows. Only first-party API
        // families have a key slot (`key_triplet`); xAI (OpenAI-compatible
        // custom brain) and the CLI-wrapper families (kimi/antigravity) have
        // none, so we skip the fetch — and, crucially, don't record a spurious
        // "no API key configured" error for them.
        if key_triplet(family).is_some() {
            match resolve_key(family) {
                None => {
                    errors.insert(family.to_string(), "no API key configured".to_string());
                }
                Some(key) => {
                    let fetched = match family {
                        "anthropic" => fetch_anthropic(&client, &key).await,
                        "openai" => fetch_openai(&client, &key).await,
                        "gemini" => fetch_gemini(&client, &key).await,
                        "openrouter" => fetch_openrouter(&client, &key).await,
                        _ => unreachable!(),
                    };
                    match fetched {
                        Ok(live) => {
                            let have: std::collections::HashSet<String> =
                                rows.iter().map(|m| m.id.clone()).collect();
                            for m in live {
                                if !m.id.is_empty() && !have.contains(&m.id) {
                                    rows.push(m);
                                }
                            }
                        }
                        Err(e) => {
                            // Non-fatal: the curated rows still stand. Record it
                            // so the UI can explain a missing/invalid key.
                            errors.insert(family.to_string(), e);
                        }
                    }
                }
            }
        }

        if !rows.is_empty() {
            families.insert(family.to_string(), rows);
        }
    }

    // Fold in what the user's *installed* CLIs actually offer. For CLI-wrapper
    // families (kimi/antigravity) the installed CLI defines membership; for the
    // shared native+CLI families (openai) it appends ids the curated set lacks.
    // Every probe is best-effort — a missing/failed CLI leaves the family on its
    // curated rows. See `model_discovery` for the merge policy.
    let discovered = crate::model_discovery::discover_all().await;
    for (family, disc) in discovered {
        let brand = family_brand(&aura, &family);
        let existing = families.remove(&family).unwrap_or_default();
        let merged = crate::model_discovery::merge_discovered(&family, existing, disc, &brand);
        if !merged.is_empty() {
            families.insert(family, merged);
        }
    }

    let catalog = ModelCatalog {
        fetched_at: now_secs(),
        cached: false,
        families,
        errors,
    };
    // The curated catalog always populates families, so this caches a usable
    // catalog even fully offline (embedded floor) — good for instant opens.
    if !catalog.families.is_empty() {
        write_cache(&catalog);
    }
    Ok(catalog)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn openrouter_catalog_parses_rows_and_prices() {
        // A trimmed slice of a real /api/v1/models body: two priced models and
        // one with no pricing block.
        let body = json!({
            "data": [
                {
                    "id": "anthropic/claude-3.5-sonnet",
                    "name": "Anthropic: Claude 3.5 Sonnet",
                    "created": 1_718_841_600i64,
                    "pricing": { "prompt": "0.000003", "completion": "0.000015" }
                },
                {
                    "id": "openai/gpt-4o-mini",
                    "name": "OpenAI: GPT-4o-mini",
                    "created": 1_700_000_000i64,
                    "pricing": { "prompt": "0.00000015", "completion": "0.0000006" }
                },
                { "id": "some/unpriced-model", "name": "No Price" }
            ]
        });
        let (rows, prices) = parse_openrouter_catalog(&body);
        assert_eq!(rows.len(), 3, "every row with an id becomes a picker entry");
        // Newest-created first.
        assert_eq!(rows[0].id, "anthropic/claude-3.5-sonnet");
        assert_eq!(rows[0].label, "Anthropic: Claude 3.5 Sonnet");
        assert_eq!(rows[0].brand.as_deref(), Some("openrouter"));
        // Per-token strings convert to per-MTok.
        let sonnet = prices.get("anthropic/claude-3.5-sonnet").unwrap();
        assert!((sonnet.input_per_mtok - 3.0).abs() < 1e-9);
        assert!((sonnet.output_per_mtok - 15.0).abs() < 1e-9);
        let mini = prices.get("openai/gpt-4o-mini").unwrap();
        assert!((mini.input_per_mtok - 0.15).abs() < 1e-9);
        // A row with no pricing block carries no rate — the meter estimates it
        // by tier rather than inventing an exact figure.
        assert!(!prices.contains_key("some/unpriced-model"));
    }

    #[test]
    fn openrouter_catalog_tolerates_a_shapeless_body() {
        let (rows, prices) = parse_openrouter_catalog(&json!({}));
        assert!(rows.is_empty() && prices.is_empty());
        // A row missing an id is skipped, not a panic.
        let (rows, _) = parse_openrouter_catalog(&json!({ "data": [{ "name": "x" }] }));
        assert!(rows.is_empty());
    }

    /// The embedded `model_catalog.json` is the always-works floor: if it stops
    /// parsing, the whole ledger silently degrades to empty and the frontend
    /// falls back to its hardcoded list (so new models can't ship without an app
    /// release). This guards the camelCase key contract between the JSON and the
    /// `AuraCatalog*` structs — a snake_case regression here would have it parse
    /// to an empty catalog instead of erroring loudly.
    #[test]
    fn embedded_catalog_parses_with_flags() {
        let cat = embedded_aura_catalog();
        assert!(
            !cat.families.is_empty(),
            "embedded model_catalog.json parsed to an empty ledger — \
             check the camelCase serde contract on AuraCatalog*"
        );

        // Brand metadata (the required `brandName` key) must survive.
        let gemini = cat
            .families
            .get("gemini")
            .expect("gemini family present in the embedded catalog");
        assert_eq!(gemini.brand_name, "Gemini");
        assert_eq!(gemini.vendor, "Google");

        // The expanded rows must carry the camelCase flags, not drop them.
        let rows = cat.family_models("gemini");
        let pro = rows
            .iter()
            .find(|m| m.id == "gemini-3.1-pro-preview")
            .expect("Gemini 3.1 Pro row present");
        assert_eq!(pro.is_new, Some(true), "isNew flag lost in parse");
        assert_eq!(pro.brand_name.as_deref(), Some("Gemini"));

        // A long-context Anthropic row must keep its longContext flag.
        let anth = cat.family_models("anthropic");
        let opus_1m = anth
            .iter()
            .find(|m| m.label == "Opus 4.8 1M")
            .expect("Opus 4.8 1M row present");
        assert_eq!(opus_1m.long_context, Some(true), "longContext flag lost in parse");

        let xai = cat.family_models("xai");
        assert_eq!(xai.first().map(|m| m.id.as_str()), Some("grok-4.5"));
    }
}
