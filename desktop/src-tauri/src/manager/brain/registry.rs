//! Brain registry — discovers which `Brain` impls were compiled in
//! (via Cargo features) and constructs them on demand.
//!
//! W1 shipped the registry skeleton with no live brains attached. W2
//! added `anthropic_native`; W7 adds `openai_compat` — the generic
//! OpenAI-API-compatible client that lets users plug in any
//! `base_url` + `api_key` + `model` (OpenRouter, Together, Groq, vLLM,
//! ollama, LMStudio, LiteLLM proxy, anything implementing
//! `/v1/chat/completions` with streaming). Each impl lives behind a
//! feature flag (default-on for the production set) so embedded /
//! minimal builds can drop providers they don't ship.
//!
//! Static vs dynamic descriptors: most providers (`anthropic_native`,
//! `cli_wrapper`, `gemini_native`, `openai_native`) are singletons —
//! one descriptor per build. `openai_compat` is plural: the user can
//! register many endpoints, each under the id `openai_compat:<slug>`
//! (e.g. `openai_compat:local_ollama`, `openai_compat:groq_prod`).
//! `descriptors()` appends one dynamic entry per configured slug after
//! the static list.

use std::sync::Arc;

use super::{
    Brain,
    settings::{self, BrainSettings},
    types::BrainError,
};

/// Brief, UI-facing description of a brain the user can pick.
///
/// Fields are owned `String` rather than `&'static str` because the
/// `openai_compat` family contributes one descriptor per user-defined
/// slug — those names are read from disk at runtime.
#[derive(Debug, Clone)]
pub struct BrainDescriptor {
    /// Stable id (also the keychain entry name).
    pub provider_id: String,
    /// Display name for the picker ("Claude (Anthropic API)").
    pub display_name: String,
    /// One-line subtitle.
    pub blurb: String,
    /// True when an API key is required in the keychain (host-side
    /// providers); false for CLI wrappers that lean on the CLI's own
    /// stored auth.
    pub requires_api_key: bool,
}

/// All brains compiled into this build, in display order.
///
/// Static entries come first (`anthropic_native`, `cli_wrapper`, …);
/// then one dynamic entry per `openai_compat:<slug>` the user has
/// configured in `BrainSettings.providers`.
pub fn descriptors() -> Vec<BrainDescriptor> {
    let mut out = Vec::new();

    // Aura Pro leads the picker — it's the zero-setup option we want
    // the user to land on first. No API-key column (the brain reuses
    // the Aura cloud token); the picker UI special-cases this
    // provider_id to render sign-in state + a quota chip instead.
    #[cfg(feature = "brain_aura_pro")]
    {
        out.push(BrainDescriptor {
            provider_id: super::aura_pro::PROVIDER_ID.to_string(),
            display_name: "Aura Pro".to_string(),
            blurb: "Sign in with your Aura account — no API key required. Streams through aura-cloud.".to_string(),
            requires_api_key: false,
        });
    }

    #[cfg(feature = "brain_anthropic_native")]
    {
        out.push(BrainDescriptor {
            provider_id: "anthropic_native".to_string(),
            display_name: "Claude (Anthropic API)".to_string(),
            blurb: "Direct streaming from api.anthropic.com — best tool-use fidelity.".to_string(),
            requires_api_key: true,
        });
    }

    // CLI wrappers: enumerate the installed coding-agent CLIs via the
    // `aura-agents` registry and emit one descriptor per available
    // binary on the host. Picker only lists what the user can actually
    // run — no "Cursor Agent" entry on a box without `cursor-agent`.
    #[cfg(feature = "brain_cli_wrapper")]
    {
        out.extend(cli_wrapper_descriptors());
    }

    #[cfg(feature = "brain_gemini_native")]
    {
        out.push(BrainDescriptor {
            provider_id: "gemini_native".to_string(),
            display_name: "Gemini (Vertex AI)".to_string(),
            blurb: "Direct streaming from Vertex AI — v0.2.31 preview.".to_string(),
            requires_api_key: true,
        });
    }

    #[cfg(feature = "brain_openai_native")]
    {
        out.push(BrainDescriptor {
            provider_id: "openai_native".to_string(),
            display_name: "OpenAI (Responses API)".to_string(),
            blurb: "Direct streaming from api.openai.com — v0.2.31 preview.".to_string(),
            requires_api_key: true,
        });
    }

    // Dynamic descriptors: one per user-configured openai_compat endpoint.
    #[cfg(feature = "brain_openai_compat")]
    {
        let settings = settings::load();
        out.extend(openai_compat_descriptors(&settings));
    }

    out
}

/// Translate an aura-agents registry id into the `cli_wrapper:` suffix
/// surfaced in `BrainDescriptor::provider_id`. The registry id is the
/// underlying agent name; the suffix is the friendly UI name. Mirrors
/// the alias table in `cli_wrapper::agent_id_for_suffix` (inverse map).
#[cfg(feature = "brain_cli_wrapper")]
fn suffix_for_agent_id(agent_id: &str) -> &'static str {
    match agent_id {
        "claude" => "claude_code",
        "gemini" => "gemini",
        "codex" => "codex",
        "cursor" => "cursor",
        "kimi" => "kimi",
        "opencode" => "opencode",
        // Unknown user-supplied providers (agents.toml) pass through
        // unchanged. We leak the string because aura-agents registry
        // entries live for the whole process lifetime and the registry
        // holds them as `String` already.
        other => Box::leak(other.to_string().into_boxed_str()),
    }
}

/// Enumerate installed coding-agent CLIs and emit one `BrainDescriptor`
/// per *available* binary. Unavailable agents are skipped so the picker
/// only lists brains the user can actually run.
#[cfg(feature = "brain_cli_wrapper")]
fn cli_wrapper_descriptors() -> Vec<BrainDescriptor> {
    let reg = aura_agents::registry();
    reg.iter()
        .filter(|p| p.is_available())
        .map(|p| {
            let suffix = suffix_for_agent_id(p.id());
            let label = p.label();
            BrainDescriptor {
                provider_id: format!("cli_wrapper:{suffix}"),
                display_name: format!("{label} (CLI)"),
                blurb: format!(
                    "Wraps the `{}` CLI you already use — reuses its login.",
                    p.bin_name()
                ),
                requires_api_key: false,
            }
        })
        .collect()
}

/// Build a `BrainDescriptor` for every `openai_compat:<slug>` entry in
/// the user's settings. Pulled out so tests / callers can pass a
/// synthetic `BrainSettings` without touching disk.
#[cfg(feature = "brain_openai_compat")]
fn openai_compat_descriptors(settings: &BrainSettings) -> Vec<BrainDescriptor> {
    use super::openai_compat::PROVIDER_PREFIX;

    let mut out = Vec::new();
    // Iterate in a stable order so the picker UI doesn't shuffle on
    // every refresh — HashMap iteration order is otherwise nondeterministic.
    let mut ids: Vec<&String> = settings
        .providers
        .keys()
        .filter(|id| id.starts_with(PROVIDER_PREFIX))
        .collect();
    ids.sort();
    for provider_id in ids {
        let cfg = match settings.providers.get(provider_id) {
            Some(c) => c,
            None => continue,
        };
        let slug = provider_id
            .strip_prefix(PROVIDER_PREFIX)
            .unwrap_or("")
            .to_string();
        let base_url = cfg
            .extra
            .get("base_url")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        out.push(BrainDescriptor {
            provider_id: provider_id.clone(),
            display_name: display_name_for_slug(&slug),
            blurb: if base_url.is_empty() {
                "OpenAI-compatible endpoint (base_url not set — open Settings → Brain).".to_string()
            } else {
                format!("OpenAI-compatible endpoint at {base_url}")
            },
            requires_api_key: false, // local endpoints often need no key
        });
    }
    out
}

/// Turn a slug like `local_ollama` into a display name like `Local ollama`.
/// Cheap, intentionally not over-engineered — users can rename their slugs
/// if they want a prettier label.
#[cfg(feature = "brain_openai_compat")]
fn display_name_for_slug(slug: &str) -> String {
    if slug.is_empty() {
        return "OpenAI-compatible".to_string();
    }
    let spaced = slug.replace('_', " ").replace('-', " ");
    let mut chars = spaced.chars();
    match chars.next() {
        Some(c) => c.to_uppercase().collect::<String>() + chars.as_str(),
        None => spaced,
    }
}

/// Best available *local* brain to fall back to when the preferred brain
/// (typically `aura_pro`) can't serve a turn — e.g. the cloud rejected the
/// subscription, the token expired, or the network is down. Order mirrors
/// the picker's intent: a key-backed native provider first (best tool-use
/// fidelity), then any installed CLI wrapper, then a configured
/// `openai_compat` endpoint. Never returns `exclude` (the brain that just
/// failed) — so a fallback can't loop back onto the same dead provider.
///
/// Returns `None` when nothing local is configured (no API keys, no CLIs
/// installed) — in that case the original entitlement error is the right
/// thing to surface, since there's genuinely nothing to fall back to.
pub fn first_available_fallback(exclude: &str) -> Option<String> {
    first_available_fallback_excluding(&[exclude])
}

/// Multi-exclude variant of [`first_available_fallback`]. Identical selection
/// logic and order (native key-backed providers → installed CLI wrappers →
/// configured `openai_compat` endpoints), except a candidate is skipped when
/// its provider_id appears anywhere in `excludes`. The caller passes both the
/// brain that just failed AND every engine currently in cooldown, so a retry
/// can't loop back onto a provider we already know is dead or rate-limited.
pub fn first_available_fallback_excluding(excludes: &[&str]) -> Option<String> {
    // Native, key-gated providers — only when a key is actually stored, so
    // we never fall back onto a brain that would itself 401.
    #[cfg(feature = "brain_anthropic_native")]
    if !excludes.contains(&"anthropic_native") && super::keychain::has_api_key("anthropic_native") {
        return Some("anthropic_native".into());
    }
    #[cfg(feature = "brain_openai_native")]
    if !excludes.contains(&"openai_native") && super::keychain::has_api_key("openai_native") {
        return Some("openai_native".into());
    }
    #[cfg(feature = "brain_gemini_native")]
    if !excludes.contains(&"gemini_native") && super::keychain::has_api_key("gemini_native") {
        return Some("gemini_native".into());
    }
    // Installed CLI wrappers — `cli_wrapper_descriptors()` already filters
    // to binaries present on PATH, so any entry here is runnable.
    #[cfg(feature = "brain_cli_wrapper")]
    {
        for d in cli_wrapper_descriptors() {
            if !excludes.contains(&d.provider_id.as_str()) {
                return Some(d.provider_id);
            }
        }
    }
    // User-configured OpenAI-compatible endpoints (local ollama, etc.).
    #[cfg(feature = "brain_openai_compat")]
    {
        let settings = settings::load();
        for d in openai_compat_descriptors(&settings) {
            if !excludes.contains(&d.provider_id.as_str()) {
                return Some(d.provider_id);
            }
        }
    }
    None
}

/// Build a brain by provider_id. Returns `UnknownProvider` if the id
/// isn't compiled into this build, or `Keychain` if a required API
/// key is missing.
pub fn build(provider_id: &str) -> Result<Arc<dyn Brain>, BrainError> {
    // `cli_wrapper:<suffix>` is a family of provider ids — one per
    // installed coding-agent CLI — so it gets its own arm before the
    // exact-match table.
    #[cfg(feature = "brain_cli_wrapper")]
    {
        if let Some(suffix) = provider_id.strip_prefix("cli_wrapper:") {
            return Ok(Arc::new(super::cli_wrapper::CliWrapperBrain::new(suffix)?));
        }
    }

    // openai_compat is matched next because it's also a prefix match —
    // any id starting with `openai_compat:` routes to the generic client.
    #[cfg(feature = "brain_openai_compat")]
    {
        if let Some(slug) = provider_id.strip_prefix(super::openai_compat::PROVIDER_PREFIX) {
            return build_openai_compat(provider_id, slug);
        }
    }

    match provider_id {
        #[cfg(feature = "brain_aura_pro")]
        id if id == super::aura_pro::PROVIDER_ID => {
            let creds = super::aura_pro::read_credentials();
            let token = creds.cloud_token.ok_or_else(|| BrainError::AuthRequired {
                message:
                    "Not signed in to Aura — open Onboarding (or Settings → Brain → Aura Pro) to sign in"
                        .into(),
            })?;
            let mut brain = super::aura_pro::AuraProBrain::new(token);
            if let Some(origin) = creds.cloud_origin {
                brain = brain.with_cloud_origin(origin);
            }
            // Honor a user-chosen model override (settings UI may write
            // this later) but fall through to the brain's built-in
            // default when nothing is set.
            let settings = settings::load();
            if let Some(cfg) = settings.providers.get(super::aura_pro::PROVIDER_ID) {
                if let Some(model) = cfg.model.as_deref().filter(|s| !s.is_empty()) {
                    brain = brain.with_model(model);
                }
            }
            Ok(Arc::new(brain))
        }
        #[cfg(feature = "brain_anthropic_native")]
        "anthropic_native" => {
            let api_key = super::keychain::get_api_key("anthropic_native")?
                .ok_or_else(|| BrainError::Keychain {
                    message: "no API key stored for anthropic_native — open Settings → Brain to add one".into(),
                })?;
            Ok(Arc::new(super::anthropic_native::AnthropicNativeBrain::new(
                api_key,
            )))
        }
        #[cfg(feature = "brain_gemini_native")]
        "gemini_native" => {
            let api_key = super::keychain::get_api_key("gemini_native")?
                .ok_or_else(|| BrainError::Keychain {
                    message: "no API key stored for gemini_native — open Settings → Brain to add one".into(),
                })?;
            Ok(Arc::new(super::gemini_native::GeminiNativeBrain::new(
                api_key,
            )))
        }
        #[cfg(feature = "brain_openai_native")]
        "openai_native" => {
            let api_key = super::keychain::get_api_key("openai_native")?
                .ok_or_else(|| BrainError::Keychain {
                    message: "no API key stored for openai_native — open Settings → Brain to add one".into(),
                })?;
            Ok(Arc::new(super::openai_native::OpenAINativeBrain::new(
                api_key,
            )))
        }
        _ => Err(BrainError::UnknownProvider {
            provider_id: provider_id.to_string(),
        }),
    }
}

/// Build an `OpenAICompatBrain` from the persisted settings + keychain.
/// Failure modes are deliberately precise so the picker UI can surface
/// the exact fix (`base_url` missing vs `model` missing vs key error).
#[cfg(feature = "brain_openai_compat")]
fn build_openai_compat(
    provider_id: &str,
    slug: &str,
) -> Result<Arc<dyn Brain>, BrainError> {
    let settings = settings::load();
    let cfg = settings
        .providers
        .get(provider_id)
        .ok_or_else(|| BrainError::Other {
            message: format!(
                "no provider config for {provider_id} — open Settings → Brain to add base_url + model"
            ),
        })?;
    let base_url = cfg
        .extra
        .get("base_url")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| BrainError::Other {
            message: format!("{provider_id}: extra.base_url is required"),
        })?;
    // model can come from either `ProviderConfig.model` (typed) or
    // `extra.model` (untyped) — accept both so the settings UI can
    // evolve without breaking older configs.
    let model = cfg
        .model
        .as_deref()
        .or_else(|| cfg.extra.get("model").and_then(|v| v.as_str()))
        .filter(|s| !s.is_empty())
        .ok_or_else(|| BrainError::Other {
            message: format!("{provider_id}: model is required"),
        })?;

    // Empty key is legitimate (ollama, local vLLM without auth). The
    // keychain returns `Ok(None)` when no entry exists — treat that
    // as "blank key, skip Authorization".
    let api_key = super::keychain::get_api_key(provider_id)?.unwrap_or_default();

    Ok(Arc::new(super::openai_compat::OpenAICompatBrain::new(
        slug, base_url, api_key, model,
    )))
}
