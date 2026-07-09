//! Tauri commands behind the BrainSettings dialog.
//!
//! These wrap `manager/brain/` so the React picker can:
//!
//!   - List the brains compiled into this build (`brain_list_descriptors`)
//!   - Read + write the active provider (`brain_get_settings` /
//!     `brain_set_active`)
//!   - Stash / forget per-brain API keys without ever exposing them in the
//!     frontend (`brain_keychain_set` / `brain_keychain_delete` /
//!     `brain_keychain_has`)
//!
//! The actual chat streaming lives in `cmd_manager.rs` — these are
//! settings-side commands only.

use serde::{Deserialize, Serialize};

use crate::manager::brain::{
    keychain,
    registry::{self, BrainDescriptor},
    settings::{self, BrainSettings, ProviderConfig},
};

/// Provider-id prefix for user-registered OpenAI-compatible endpoints.
/// Mirrors `manager::brain::openai_compat::PROVIDER_PREFIX`, redeclared
/// here so these settings-side commands stay available even in builds
/// that compile out the `brain_openai_compat` feature (writing the
/// config is harmless; only *running* the brain needs the feature).
const OPENAI_COMPAT_PREFIX: &str = "openai_compat:";

#[derive(Debug, Clone, Serialize)]
pub struct BrainDescriptorOut {
    pub provider_id: String,
    pub display_name: String,
    pub blurb: String,
    pub requires_api_key: bool,
    /// Whether a key for this brain is currently in the keychain. The
    /// frontend uses this to render "✓ key set" without exposing the
    /// value.
    pub has_api_key: bool,
}

fn to_out(d: &BrainDescriptor) -> BrainDescriptorOut {
    BrainDescriptorOut {
        provider_id: d.provider_id.to_string(),
        display_name: d.display_name.to_string(),
        blurb: d.blurb.to_string(),
        requires_api_key: d.requires_api_key,
        has_api_key: keychain::has_api_key(&d.provider_id),
    }
}

#[tauri::command]
pub async fn brain_list_descriptors() -> Result<Vec<BrainDescriptorOut>, String> {
    Ok(registry::descriptors().iter().map(to_out).collect())
}

/// One selectable brain for the chat-header BrainPicker (WW-B1/B3). A
/// flatter shape than `BrainDescriptorOut` — just what the dropdown
/// needs: a stable id to hand back to `manager_set_brain_override`, a
/// label, the family `kind` (for an icon), and whether it's the
/// globally-active brain (the picker marks it as the default).
#[derive(Debug, Clone, Serialize)]
pub struct BrainChoice {
    pub id: String,
    pub label: String,
    pub kind: String,
    pub active: bool,
    /// Whether this brain needs an API key to run at all. CLI-wrapper
    /// brains (Claude Code, Codex, …) authenticate out-of-band and
    /// report `false`; hosted brains (Anthropic API, OpenAI-compat) report
    /// `true`. The picker uses this with `has_api_key` to disable the row.
    pub requires_api_key: bool,
    /// Whether a key for this brain is currently in the keychain. When
    /// `requires_api_key && !has_api_key` the picker disables the row and
    /// surfaces a fix-it hint instead of silently failing the next turn.
    pub has_api_key: bool,
}

/// Classify a provider_id into its brain family — drives the picker's
/// per-brain icon. Prefix families (`cli_wrapper:`, `openai_compat:`)
/// collapse to their stem; singletons map to themselves.
fn kind_of(provider_id: &str) -> String {
    if let Some(stem) = provider_id.split(':').next() {
        if stem != provider_id {
            return stem.to_string(); // `cli_wrapper:gemini` → `cli_wrapper`
        }
    }
    provider_id.to_string()
}

/// List every brain the chat-header picker can swap to (WW-B1). Built
/// from the same `registry::descriptors()` the Settings picker uses —
/// static singletons plus one entry per user-registered
/// `openai_compat:<slug>` and per installed CLI wrapper — so the two
/// surfaces never drift. `active` marks the globally-active brain.
#[tauri::command]
pub async fn manager_list_brains() -> Result<Vec<BrainChoice>, String> {
    let active_id = settings::load().active_provider_id;
    Ok(registry::descriptors()
        .iter()
        .map(|d| BrainChoice {
            id: d.provider_id.clone(),
            label: d.display_name.clone(),
            kind: kind_of(&d.provider_id),
            active: active_id.as_deref() == Some(d.provider_id.as_str()),
            requires_api_key: d.requires_api_key,
            has_api_key: keychain::has_api_key(&d.provider_id),
        })
        .collect())
}

#[tauri::command]
pub async fn brain_get_settings() -> Result<BrainSettings, String> {
    Ok(settings::load())
}

#[derive(Debug, Deserialize)]
pub struct BrainSetActiveInput {
    pub provider_id: String,
}

#[tauri::command]
pub async fn brain_set_active(input: BrainSetActiveInput) -> Result<(), String> {
    let mut s = settings::load();
    s.active_provider_id = Some(input.provider_id);
    settings::save(&s).map_err(|e| e.to_string())
}

#[derive(Debug, Deserialize)]
pub struct BrainSetAutoRouteInput {
    pub enabled: bool,
}

/// Toggle ledger-driven auto-routing. When on, the dispatcher + tick
/// scheduler bind each unpinned lane to the Agent Skill Ledger's best
/// provider for its taxonomy cell; when off, every unpinned lane uses
/// the active brain. A manual per-lane override always wins regardless.
#[tauri::command]
pub async fn brain_set_auto_route(input: BrainSetAutoRouteInput) -> Result<(), String> {
    let mut s = settings::load();
    s.auto_route = input.enabled;
    settings::save(&s).map_err(|e| e.to_string())
}

#[derive(Debug, Deserialize)]
pub struct BrainKeychainSetInput {
    pub provider_id: String,
    pub api_key: String,
}

#[tauri::command]
pub async fn brain_keychain_set(input: BrainKeychainSetInput) -> Result<(), String> {
    keychain::set_api_key(&input.provider_id, &input.api_key).map_err(|e| e.to_string())
}

#[derive(Debug, Deserialize)]
pub struct BrainKeychainDeleteInput {
    pub provider_id: String,
}

#[tauri::command]
pub async fn brain_keychain_delete(input: BrainKeychainDeleteInput) -> Result<(), String> {
    keychain::delete_api_key(&input.provider_id).map_err(|e| e.to_string())
}

#[derive(Debug, Deserialize)]
pub struct BrainKeychainHasInput {
    pub provider_id: String,
}

#[tauri::command]
pub async fn brain_keychain_has(input: BrainKeychainHasInput) -> Result<bool, String> {
    Ok(keychain::has_api_key(&input.provider_id))
}

// ─── Custom OpenAI-compatible endpoints (Kimi/Moonshot, Gemini, …) ────
//
// WW-B0. The picker can list and run any `openai_compat:<slug>` brain
// the registry finds in settings, but until now there was no command to
// *create* one — so reaching Kimi/Moonshot or Gemini-via-OpenAI-compat
// from the Settings UI was impossible. `brain_upsert_provider` writes
// the `ProviderConfig` (model + extra.base_url) to brain_settings.json
// and stashes the API key in the OS keychain (never in plaintext). This
// is the single command behind the "Add a model endpoint" form.

#[derive(Debug, Deserialize)]
pub struct BrainUpsertProviderInput {
    /// Endpoint slug, e.g. `moonshot` or `gemini`. Combined with the
    /// `openai_compat:` prefix to form the provider_id. Lowercased;
    /// must be `[a-z0-9_-]+`.
    pub slug: String,
    /// OpenAI-compatible base URL, e.g. `https://api.moonshot.ai/v1`
    /// or `https://generativelanguage.googleapis.com/v1beta/openai`.
    pub base_url: String,
    /// Model id, e.g. `kimi-k2-0711-preview` or `gemini-2.0-flash`.
    pub model: String,
    /// API key — stored in the OS keychain. Optional: local endpoints
    /// (ollama, vLLM) may need none. An empty string clears any
    /// existing key.
    #[serde(default)]
    pub api_key: Option<String>,
    /// Make this provider the active brain immediately after upsert.
    #[serde(default)]
    pub set_active: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct BrainUpsertProviderOut {
    /// The resolved `openai_compat:<slug>` id the frontend can hand to
    /// `brain_set_active` / `manager_set_brain_override`.
    pub provider_id: String,
}

/// Validate a user-supplied endpoint slug. Kept strict so the
/// provider_id (also the keychain entry name + settings key) can't carry
/// path separators, whitespace, or the `:` that splits prefix from slug.
fn normalize_slug(raw: &str) -> Result<String, String> {
    let slug = raw.trim().to_ascii_lowercase();
    if slug.is_empty() {
        return Err("slug is required".into());
    }
    if !slug
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err("slug must be lowercase letters, digits, '_' or '-' only".into());
    }
    Ok(slug)
}

#[tauri::command]
pub async fn brain_upsert_provider(
    input: BrainUpsertProviderInput,
) -> Result<BrainUpsertProviderOut, String> {
    let slug = normalize_slug(&input.slug)?;
    let base_url = input.base_url.trim().to_string();
    let model = input.model.trim().to_string();
    if base_url.is_empty() {
        return Err("base_url is required".into());
    }
    if model.is_empty() {
        return Err("model is required".into());
    }
    let provider_id = format!("{OPENAI_COMPAT_PREFIX}{slug}");

    let mut s = settings::load();
    let entry = s.providers.entry(provider_id.clone()).or_default();
    entry.model = Some(model);
    // Preserve any unrelated keys the user/UI may have set under `extra`
    // (region, headers, …); only (re)write base_url here.
    if !entry.extra.is_object() {
        entry.extra = serde_json::json!({});
    }
    if let Some(obj) = entry.extra.as_object_mut() {
        obj.insert(
            "base_url".to_string(),
            serde_json::Value::String(base_url),
        );
    }
    if input.set_active {
        s.active_provider_id = Some(provider_id.clone());
    }
    settings::save(&s).map_err(|e| e.to_string())?;

    // Key goes to the keychain, never to settings.json. An explicit
    // empty string clears the entry (local endpoints with no auth).
    if let Some(key) = input.api_key {
        if key.is_empty() {
            // delete_api_key is a no-op when nothing is stored.
            keychain::delete_api_key(&provider_id).map_err(|e| e.to_string())?;
        } else {
            keychain::set_api_key(&provider_id, &key).map_err(|e| e.to_string())?;
        }
    }

    Ok(BrainUpsertProviderOut { provider_id })
}

#[derive(Debug, Deserialize)]
pub struct BrainRemoveProviderInput {
    /// Full provider_id (`openai_compat:<slug>`) to forget.
    pub provider_id: String,
}

/// Remove a custom endpoint: drop its `ProviderConfig`, forget its key,
/// and clear it as the active brain if it was selected. Only
/// `openai_compat:` providers are removable — the built-in brains are
/// not user-created and stay put.
#[tauri::command]
pub async fn brain_remove_provider(input: BrainRemoveProviderInput) -> Result<(), String> {
    if !input.provider_id.starts_with(OPENAI_COMPAT_PREFIX) {
        return Err("only custom openai_compat:* providers can be removed".into());
    }
    let mut s = settings::load();
    s.providers.remove(&input.provider_id);
    if s.active_provider_id.as_deref() == Some(input.provider_id.as_str()) {
        s.active_provider_id = None;
    }
    settings::save(&s).map_err(|e| e.to_string())?;
    keychain::delete_api_key(&input.provider_id).map_err(|e| e.to_string())?;
    Ok(())
}

// ─── Aura Pro brain — sign-in state + quota ──────────────────────────
//
// v0.2.31 task #352. The Aura Pro row in the BrainSettings UI doesn't
// take an API key — instead it surfaces "Signed in as <email>" and a
// "1.2M / 2M tokens used this period" chip. These two commands back
// those two pieces of state.

#[derive(Debug, Clone, Serialize)]
pub struct AuraProSignInState {
    pub signed_in: bool,
    /// `cloud_user` from credentials.json — usually an email.
    pub user: Option<String>,
    /// `cloud_url` from credentials.json — exposed so the picker can
    /// label which deployment the user is on (helps when staging vs
    /// prod sessions get confused).
    pub cloud_origin: Option<String>,
}

#[tauri::command]
pub async fn aura_pro_is_signed_in() -> Result<AuraProSignInState, String> {
    #[cfg(feature = "brain_aura_pro")]
    {
        use crate::manager::brain::aura_pro::read_credentials;
        let creds = read_credentials();
        return Ok(AuraProSignInState {
            signed_in: creds.is_signed_in(),
            user: creds.cloud_user,
            cloud_origin: creds.cloud_origin,
        });
    }
    #[cfg(not(feature = "brain_aura_pro"))]
    Ok(AuraProSignInState {
        signed_in: false,
        user: None,
        cloud_origin: None,
    })
}

/// Mirrors the cloud `QuotaView` struct returned by `GET /v1/brain/quota`.
/// Snake-case matches the wire shape so we can hand the payload straight
/// to the frontend with no further mapping.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuraProQuota {
    pub tier: String,
    pub active: bool,
    pub monthly_token_limit: Option<i64>,
    pub tokens_used_current_period: i64,
    /// ISO-8601 timestamp when the current 30-day window started.
    pub period_started_at: String,
}

#[tauri::command]
pub async fn aura_pro_quota() -> Result<AuraProQuota, String> {
    #[cfg(feature = "brain_aura_pro")]
    {
        use crate::manager::brain::aura_pro::read_credentials;
        let creds = read_credentials();
        let token = creds
            .cloud_token
            .ok_or_else(|| "Not signed in to Aura Pro".to_string())?;
        let origin = creds
            .cloud_origin
            .unwrap_or_else(|| crate::manager::brain::aura_pro::DEFAULT_CLOUD_ORIGIN.to_string());

        let url = format!("{origin}/v1/brain/quota");
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(15))
            .build()
            .map_err(|e| format!("http client: {e}"))?;
        let resp = client
            .get(&url)
            .bearer_auth(&token)
            .send()
            .await
            .map_err(|e| format!("GET {url}: {e}"))?;
        let status = resp.status();
        if !status.is_success() {
            let txt = resp.text().await.unwrap_or_default();
            return Err(format!("quota HTTP {status}: {txt}"));
        }
        let quota: AuraProQuota = resp
            .json()
            .await
            .map_err(|e| format!("parse quota: {e}"))?;
        return Ok(quota);
    }
    #[cfg(not(feature = "brain_aura_pro"))]
    Err("aura_pro brain is not compiled into this build".into())
}
