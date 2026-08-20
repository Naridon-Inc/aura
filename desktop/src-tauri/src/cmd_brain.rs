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
    AgentSurface, keychain,
    registry::{self, BrainDescriptor},
    settings::{self, BrainSettings, ProviderConfig},
};
use crate::cloud_org::OrgScoped;

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

/// What the agent behind `provider_id` is offering in `cwd` right now:
/// the slash commands it publishes, the modes it can work in, the plan it
/// is working to.
///
/// Empty rather than an error when nothing is running. A composer asking
/// "what can this agent do here" before the first message has been sent is
/// asking a reasonable question with a boring answer, not making a mistake.
///
/// This reads the *live* brain — `registry::build` hands back the running
/// instance for a hosted agent — so the answer is the session's own state,
/// not a guess reconstructed from settings.
#[tauri::command]
pub async fn brain_session_surface(
    provider_id: String,
    cwd: String,
) -> Result<AgentSurface, String> {
    let brain = registry::build(&provider_id).map_err(|e| e.to_string())?;
    Ok(brain.session_surface(&cwd).await.unwrap_or_default())
}

/// Put the live agent in `cwd` into one of the modes its surface offered.
///
/// Errors propagate to the caller as text: this control is worth nothing
/// unless a failure to switch is visible. Plan mode refuses every edit
/// tool, so "we asked and it didn't take" and "it is in plan mode" must
/// never look the same on screen.
#[tauri::command]
pub async fn brain_set_session_mode(
    provider_id: String,
    cwd: String,
    mode: String,
) -> Result<(), String> {
    let brain = registry::build(&provider_id).map_err(|e| e.to_string())?;
    brain
        .set_session_mode(&cwd, &mode)
        .await
        .map_err(|e| e.to_string())
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
    // Trim: a key pasted from a browser or a password manager routinely
    // arrives with a trailing newline, and the provider answers a key with
    // whitespace on it with the same "API key not valid" it gives a wrong
    // key — so the user reads "my key is bad" when the key is fine.
    keychain::set_api_key(&input.provider_id, input.api_key.trim())
        .map_err(|e| e.to_string())?;
    crate::cmd_models::invalidate_cache();
    Ok(())
}

#[derive(Debug, Deserialize)]
pub struct BrainKeychainDeleteInput {
    pub provider_id: String,
}

#[tauri::command]
pub async fn brain_keychain_delete(input: BrainKeychainDeleteInput) -> Result<(), String> {
    keychain::delete_api_key(&input.provider_id).map_err(|e| e.to_string())?;
    crate::cmd_models::invalidate_cache();
    Ok(())
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
    /// Key header scheme. `"api_key"` (or `"azure"`) uses the `api-key:`
    /// header that Azure OpenAI requires; anything else (or omitted) uses
    /// the standard `Authorization: Bearer` scheme. Persisted to
    /// `extra.auth_style` so the registry can rebuild the brain.
    #[serde(default)]
    pub auth_style: Option<String>,
    /// Azure OpenAI `api-version` query param (e.g.
    /// `"2024-08-01-preview"`). Persisted to `extra.api_version`; the
    /// registry appends it to every request. Omit for non-Azure endpoints.
    #[serde(default)]
    pub api_version: Option<String>,
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
        // Azure knobs — only written when supplied, so a plain endpoint's
        // `extra` never accumulates Azure fields. Passing an empty string
        // clears a previously-set value (e.g. switching a slug back to a
        // standard Bearer endpoint).
        match input.auth_style.as_deref().map(str::trim) {
            Some("") => {
                obj.remove("auth_style");
            }
            Some(style) => {
                obj.insert(
                    "auth_style".to_string(),
                    serde_json::Value::String(style.to_ascii_lowercase()),
                );
            }
            None => {}
        }
        match input.api_version.as_deref().map(str::trim) {
            Some("") => {
                obj.remove("api_version");
            }
            Some(ver) => {
                obj.insert(
                    "api_version".to_string(),
                    serde_json::Value::String(ver.to_string()),
                );
            }
            None => {}
        }
    }
    if input.set_active {
        s.active_provider_id = Some(provider_id.clone());
    }
    settings::save(&s).map_err(|e| e.to_string())?;

    // Key goes to the keychain, never to settings.json. An explicit
    // empty string clears the entry (local endpoints with no auth).
    if let Some(key) = input.api_key {
        if key.trim().is_empty() {
            // delete_api_key is a no-op when nothing is stored.
            keychain::delete_api_key(&provider_id).map_err(|e| e.to_string())?;
        } else {
            keychain::set_api_key(&provider_id, key.trim()).map_err(|e| e.to_string())?;
        }
        crate::cmd_models::invalidate_cache();
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
    crate::cmd_models::invalidate_cache();
    Ok(())
}

// ─── Cloud singleton brains — Bedrock / Vertex config ────────────────
//
// Bedrock and Vertex are singleton providers (not the openai_compat:<slug>
// family), but they need more than a single API key: Bedrock wants an AWS
// region + access key id, Vertex a GCP project + location. Those non-secret
// fields live in `ProviderConfig.extra`; the credential (AWS secret access
// key / the service-account JSON) goes to the OS keychain under the provider
// id. `brain_configure_cloud` writes both from one BrainTab form.

/// Non-secret config keys we accept per cloud provider. Anything else in the
/// incoming `extra` is ignored, so the settings file can't accumulate junk.
fn cloud_extra_keys(provider_id: &str) -> &'static [&'static str] {
    match provider_id {
        "bedrock" => &["region", "access_key_id", "session_token"],
        "vertex" => &["project_id", "location"],
        _ => &[],
    }
}

#[derive(Debug, Deserialize)]
pub struct BrainConfigureCloudInput {
    /// `"bedrock"` or `"vertex"`.
    pub provider_id: String,
    /// Model id (Bedrock model/inference-profile id, or Vertex `model@version`).
    #[serde(default)]
    pub model: Option<String>,
    /// Non-secret fields — see [`cloud_extra_keys`]. An empty-string value
    /// clears that key; an absent key is left untouched.
    #[serde(default)]
    pub extra: serde_json::Value,
    /// The credential: AWS secret access key (Bedrock) or the full
    /// service-account JSON (Vertex). Empty string clears it; omitted leaves
    /// the stored credential in place.
    #[serde(default)]
    pub secret: Option<String>,
    /// Make this the active brain immediately.
    #[serde(default)]
    pub set_active: bool,
}

#[tauri::command]
pub async fn brain_configure_cloud(input: BrainConfigureCloudInput) -> Result<(), String> {
    let provider_id = input.provider_id.trim();
    let allowed = cloud_extra_keys(provider_id);
    if allowed.is_empty() {
        return Err(format!(
            "unknown cloud provider '{provider_id}' — expected 'bedrock' or 'vertex'"
        ));
    }

    let mut s = settings::load();
    let entry = s.providers.entry(provider_id.to_string()).or_default();
    if let Some(model) = input.model.as_deref().map(str::trim) {
        entry.model = if model.is_empty() {
            None
        } else {
            Some(model.to_string())
        };
    }
    if !entry.extra.is_object() {
        entry.extra = serde_json::json!({});
    }
    if let Some(obj) = entry.extra.as_object_mut() {
        for key in allowed {
            let Some(val) = input.extra.get(*key).and_then(|v| v.as_str()) else {
                continue; // key absent → leave existing value untouched
            };
            let val = val.trim();
            if val.is_empty() {
                obj.remove(*key);
            } else {
                obj.insert((*key).to_string(), serde_json::Value::String(val.to_string()));
            }
        }
    }
    if input.set_active {
        s.active_provider_id = Some(provider_id.to_string());
    }
    settings::save(&s).map_err(|e| e.to_string())?;

    // Credential → keychain. Empty clears; None leaves it in place.
    if let Some(secret) = input.secret {
        if secret.trim().is_empty() {
            keychain::delete_api_key(provider_id).map_err(|e| e.to_string())?;
        } else {
            keychain::set_api_key(provider_id, secret.trim()).map_err(|e| e.to_string())?;
        }
        crate::cmd_models::invalidate_cache();
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
pub struct BrainCloudConfigOut {
    pub provider_id: String,
    pub model: Option<String>,
    /// The non-secret `extra` map (region/project/etc.) — never the credential.
    pub extra: serde_json::Value,
    /// Whether a credential is stored in the keychain for this provider.
    pub has_secret: bool,
}

/// Read back a cloud provider's saved config so the BrainTab form can
/// prefill. Never returns the stored credential — only whether one is set.
#[tauri::command]
pub async fn brain_cloud_config_get(provider_id: String) -> Result<BrainCloudConfigOut, String> {
    let id = provider_id.trim().to_string();
    let s = settings::load();
    let (model, extra) = match s.providers.get(&id) {
        Some(cfg) => (cfg.model.clone(), cfg.extra.clone()),
        None => (None, serde_json::json!({})),
    };
    let has_secret = keychain::has_api_key(&id);
    Ok(BrainCloudConfigOut {
        provider_id: id,
        model,
        extra,
        has_secret,
    })
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

/// Why a quota read failed, in the shape the panel needs to decide what to
/// offer the user.
///
/// It used to fail as a bare string, and the one case that matters got lost in
/// it. [`aura_pro_is_signed_in`] proves only that a token *string* is on disk —
/// never that the cloud still honours it — so an expired session left the panel
/// saying "Signed in as <email>" beside a Refresh button whose every press
/// repeats the same 401. The user is told nothing is wrong with their account
/// and handed the one control that cannot fix it.
///
/// `kind` is the machine-readable half; `message` keeps the detail for the
/// small print. Naming the auth case is what lets the UI offer signing in
/// again, which is the only thing that helps.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuraProQuotaError {
    /// `unauthorized` — the cloud rejected this token, or there isn't one.
    /// `offline` — the request never reached the cloud.
    /// `server` — it arrived and the answer wasn't usable.
    /// `unsupported` — this build has no Aura Pro brain compiled in.
    pub kind: String,
    pub message: String,
}

impl AuraProQuotaError {
    fn new(kind: &str, message: impl Into<String>) -> Self {
        Self {
            kind: kind.to_string(),
            message: message.into(),
        }
    }
}

#[tauri::command]
pub async fn aura_pro_quota() -> Result<AuraProQuota, AuraProQuotaError> {
    #[cfg(feature = "brain_aura_pro")]
    {
        use crate::manager::brain::aura_pro::read_credentials;
        let creds = read_credentials();
        let token = creds.cloud_token.ok_or_else(|| {
            AuraProQuotaError::new("unauthorized", "Not signed in to Aura Pro")
        })?;
        let origin = creds
            .cloud_origin
            .unwrap_or_else(|| crate::manager::brain::aura_pro::DEFAULT_CLOUD_ORIGIN.to_string());

        let url = format!("{origin}/v1/brain/quota");
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(15))
            .build()
            .map_err(|e| AuraProQuotaError::new("offline", format!("http client: {e}")))?;
        let resp = client
            .get(&url)
            .bearer_auth(&token)
            .org_scoped()
            .send()
            .await
            .map_err(|e| AuraProQuotaError::new("offline", format!("GET {url}: {e}")))?;
        let status = resp.status();
        if !status.is_success() {
            let txt = resp.text().await.unwrap_or_default();
            // A 401 body is empty, so the status is the whole story — which is
            // why this case has to be named rather than pasted into a sentence.
            let kind = if status.as_u16() == 401 || status.as_u16() == 403 {
                "unauthorized"
            } else {
                "server"
            };
            return Err(AuraProQuotaError::new(
                kind,
                format!("quota HTTP {status}: {txt}"),
            ));
        }
        let quota: AuraProQuota = resp
            .json()
            .await
            .map_err(|e| AuraProQuotaError::new("server", format!("parse quota: {e}")))?;
        return Ok(quota);
    }
    #[cfg(not(feature = "brain_aura_pro"))]
    Err(AuraProQuotaError::new(
        "unsupported",
        "aura_pro brain is not compiled into this build",
    ))
}
