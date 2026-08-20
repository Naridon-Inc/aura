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

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use super::{
    Brain,
    settings::{self, BrainSettings},
    types::BrainError,
};

/// Brains that own a running agent process, kept for the life of the app.
///
/// Every other brain here is a stateless client: an API key, a base URL and
/// a model id. Building a fresh one per turn is *how* an edit in Settings
/// takes effect on the next message, so they are deliberately not cached.
///
/// ACP and pi are not that. Each keeps a live child process per worktree,
/// and the conversation lives inside that process — Aura sends only what the
/// agent has not heard yet (`SessionState::delta`) precisely because the
/// agent is still there, still holding it. For those, **the instance is the
/// session**, and rebuilding it is not a fresh start, it is a hang-up.
///
/// Which is what was happening. [`BrainManager`](super::manager::BrainManager)
/// is constructed with `from_disk()` *inside each Tauri command* and caches
/// nothing across invocations, so every message built a new brain, found an
/// empty session map, dropped the old one — which kills the child, it is
/// spawned with `kill_on_drop` — and started the agent again from scratch,
/// replaying the whole transcript to it. Nobody saw a broken reply, because
/// the replay reproduces the same context; what it cost was invisible and
/// per-turn: a process start, the entire conversation re-read (and, on a
/// metered model, re-charged) every time, and everything the agent itself
/// had built up — files loaded, mode chosen, plan in progress — thrown away
/// between one message and the next. Every reuse path in both brains was
/// unreachable code.
///
/// Keyed by provider id, so `acp:opencode` and `pi` hold one each.
static LIVE: OnceLock<Mutex<HashMap<String, Arc<dyn Brain>>>> = OnceLock::new();

/// Hand back this provider's live brain, building it on first ask.
///
/// `make` runs under the lock: constructing either of these is a struct
/// literal — the child process is spawned lazily by the first turn — so the
/// cost is nil, and doing it here means two turns racing on startup cannot
/// each spawn their own agent.
fn live<F>(provider_id: &str, make: F) -> Result<Arc<dyn Brain>, BrainError>
where
    F: FnOnce() -> Arc<dyn Brain>,
{
    let mut held = LIVE
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap();
    if let Some(existing) = held.get(provider_id) {
        return Ok(existing.clone());
    }
    let built = make();
    held.insert(provider_id.to_string(), built.clone());
    Ok(built)
}

/// Provider ids currently holding a live agent. Test-only: the point of
/// [`LIVE`] is *which* brains are in it, and that is worth asserting.
#[cfg(test)]
fn live_ids() -> Vec<String> {
    let mut ids: Vec<String> = LIVE
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap()
        .keys()
        .cloned()
        .collect();
    ids.sort();
    ids
}

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
            // NOT Vertex — that is `brain_vertex`, which is Claude on your
            // own GCP project and takes a service-account JSON. This is
            // Google's Generative Language API and takes the API key you
            // get from AI Studio. Naming it after the wrong control plane
            // is how someone with a key ends up staring at a brain list
            // that appears not to have their model in it.
            display_name: "Gemini".to_string(),
            blurb: "Google's Gemini models, by API key — separate from the gemini CLI's login.".to_string(),
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

    // Cloud-hosted Claude via the hyperscaler control planes. The "API key"
    // column carries the AWS secret access key / the service-account JSON —
    // the BrainTab config forms collect the extra fields (region / project)
    // these need before the credential is stored.
    #[cfg(feature = "brain_bedrock")]
    {
        out.push(BrainDescriptor {
            provider_id: "bedrock".to_string(),
            display_name: "Claude (AWS Bedrock)".to_string(),
            blurb: "Anthropic Claude through your AWS account — SigV4-signed Bedrock runtime."
                .to_string(),
            requires_api_key: true,
        });
    }

    #[cfg(feature = "brain_vertex")]
    {
        out.push(BrainDescriptor {
            provider_id: "vertex".to_string(),
            display_name: "Claude (Google Vertex AI)".to_string(),
            blurb: "Anthropic Claude through your GCP project — service-account auth on Vertex AI."
                .to_string(),
            requires_api_key: true,
        });
    }

    // Installed agents that speak ACP. Listed ahead of the CLI wrappers
    // for the same binaries: it is the same agent either way, and this is
    // the better half of it.
    #[cfg(feature = "brain_acp")]
    {
        out.extend(acp_descriptors());
    }

    // pi, when it's installed. Same reasoning as the ACP entries: it sits
    // ahead of `cli_wrapper:pi` because it is the better half of the same
    // binary.
    #[cfg(feature = "brain_pi")]
    {
        if super::pi::is_installed() {
            out.push(BrainDescriptor {
                provider_id: super::pi::PROVIDER_ID.to_string(),
                display_name: super::pi::LABEL.to_string(),
                blurb: super::pi::BLURB.to_string(),
                requires_api_key: false,
            });
        }
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

/// One descriptor per installed ACP-speaking agent.
///
/// These sit alongside the `cli_wrapper:` entries for the same binaries
/// and are the ones to prefer: same agent, same login, but a live session
/// instead of a one-shot process — so the model list is the agent's own,
/// tool calls arrive structured, and every edit passes Aura's gate on the
/// way to disk. `cli_wrapper:opencode` stays listed because a user who
/// pinned it in settings should not have their choice silently rewritten.
#[cfg(feature = "brain_acp")]
fn acp_descriptors() -> Vec<BrainDescriptor> {
    super::acp::descriptors_for_installed_agents()
        .into_iter()
        .map(|a| BrainDescriptor {
            provider_id: format!("{}{}", super::acp::PROVIDER_PREFIX, a.id),
            display_name: a.label.to_string(),
            blurb: a.blurb.to_string(),
            requires_api_key: false,
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
    // `acp:<agent>` — a live agent session. Matched before the exact
    // table for the same reason `cli_wrapper:` is: it's a family.
    #[cfg(feature = "brain_acp")]
    {
        if let Some(id) = provider_id.strip_prefix(super::acp::PROVIDER_PREFIX) {
            let agent = super::acp::brain::agent_by_id(id).ok_or_else(|| BrainError::Other {
                message: format!(
                    "{id} isn't an agent Aura knows how to run over ACP. Installed: {}",
                    super::acp::descriptors_for_installed_agents()
                        .iter()
                        .map(|a| a.id)
                        .collect::<Vec<_>>()
                        .join(", ")
                ),
            })?;
            // Cached: this brain *is* the running agent. See [`LIVE`].
            return live(provider_id, || {
                Arc::new(super::acp::AcpBrain::from_agent(
                    agent,
                    super::gate::for_agent(provider_id),
                ))
            });
        }
    }

    #[cfg(feature = "brain_pi")]
    {
        if provider_id == super::pi::PROVIDER_ID {
            // Cached: this brain *is* the running agent. See [`LIVE`].
            return live(provider_id, || {
                Arc::new(super::pi::PiBrain::new(super::gate::for_agent(provider_id)))
            });
        }
    }

    // `cli_wrapper:<suffix>` is a family of provider ids — one per
    // installed coding-agent CLI — so it gets its own arm before the
    // exact-match table.
    #[cfg(feature = "brain_cli_wrapper")]
    {
        if let Some(suffix) = provider_id.strip_prefix("cli_wrapper:") {
            return Ok(Arc::new(super::cli_wrapper::CliWrapperBrain::new(suffix)?));
        }
        // A bare `cli_wrapper` names the *family*, not a member of it, so
        // there is no arm below that can build it. Anything holding one —
        // an old persisted setting, a hand-edited settings file — used to
        // get `UnknownProvider`, which reads as "this app is broken" when
        // the real state is "nobody has picked which CLI". Resolve it to
        // the first installed CLI, and when there isn't one, say that.
        if provider_id == "cli_wrapper" {
            let first = cli_wrapper_descriptors().into_iter().next().ok_or_else(|| {
                BrainError::Other {
                    message: "No coding-agent CLI was found on this computer. Install one \
                              (Claude Code, Codex, Gemini CLI, …), or add an API key under \
                              Settings → Brains."
                        .into(),
                }
            })?;
            return build(&first.provider_id);
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
        #[cfg(feature = "brain_bedrock")]
        "bedrock" => build_bedrock(),
        #[cfg(feature = "brain_vertex")]
        "vertex" => build_vertex(),
        _ => Err(BrainError::UnknownProvider {
            provider_id: provider_id.to_string(),
        }),
    }
}

/// Build the Bedrock brain from settings (`extra.region`, `extra.access_key_id`,
/// optional `extra.session_token`, `model`/`extra.model`) + the secret access
/// key from the keychain. Errors name the exact missing field so the config
/// form can point the user at it.
#[cfg(feature = "brain_bedrock")]
fn build_bedrock() -> Result<Arc<dyn Brain>, BrainError> {
    let settings = settings::load();
    let cfg = settings
        .providers
        .get("bedrock")
        .ok_or_else(|| BrainError::Other {
            message: "Bedrock isn't configured yet — open Settings → Brains → Claude (AWS Bedrock)"
                .into(),
        })?;
    let extra_str = |key: &str| {
        cfg.extra
            .get(key)
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .filter(|s| !s.is_empty())
    };
    let region = extra_str("region").ok_or_else(|| BrainError::Other {
        message: "Bedrock: AWS region is required (e.g. us-east-1)".into(),
    })?;
    let access_key_id = extra_str("access_key_id").ok_or_else(|| BrainError::Other {
        message: "Bedrock: AWS access key id is required".into(),
    })?;
    let model = cfg
        .model
        .clone()
        .filter(|s| !s.is_empty())
        .or_else(|| extra_str("model"))
        .ok_or_else(|| BrainError::Other {
            message:
                "Bedrock: a model id is required (e.g. us.anthropic.claude-sonnet-4-5-20250929-v1:0)"
                    .into(),
        })?;
    let secret = super::keychain::get_api_key("bedrock")?.ok_or_else(|| BrainError::Keychain {
        message: "Bedrock: no AWS secret access key stored — open Settings → Brains to add one"
            .into(),
    })?;
    let brain = super::bedrock::BedrockBrain::new(access_key_id, secret, region, model)
        .with_session_token(extra_str("session_token"));
    Ok(Arc::new(brain))
}

/// Build the Vertex brain from settings (`extra.project_id`, `extra.location`,
/// `model`/`extra.model`) + the service-account JSON from the keychain.
#[cfg(feature = "brain_vertex")]
fn build_vertex() -> Result<Arc<dyn Brain>, BrainError> {
    let settings = settings::load();
    let cfg = settings
        .providers
        .get("vertex")
        .ok_or_else(|| BrainError::Other {
            message:
                "Vertex isn't configured yet — open Settings → Brains → Claude (Google Vertex AI)"
                    .into(),
        })?;
    let extra_str = |key: &str| {
        cfg.extra
            .get(key)
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .filter(|s| !s.is_empty())
    };
    let project_id = extra_str("project_id").ok_or_else(|| BrainError::Other {
        message: "Vertex: GCP project id is required".into(),
    })?;
    let location = extra_str("location").ok_or_else(|| BrainError::Other {
        message: "Vertex: region/location is required (e.g. us-east5)".into(),
    })?;
    let model = cfg
        .model
        .clone()
        .filter(|s| !s.is_empty())
        .or_else(|| extra_str("model"))
        .ok_or_else(|| BrainError::Other {
            message: "Vertex: a model id is required (e.g. claude-sonnet-4-5@20250929)".into(),
        })?;
    let sa_json = super::keychain::get_api_key("vertex")?.ok_or_else(|| BrainError::Keychain {
        message: "Vertex: no service-account JSON stored — open Settings → Brains to add one"
            .into(),
    })?;
    let sa = super::gcp_oauth::ServiceAccount::from_json(&sa_json)?;
    Ok(Arc::new(super::vertex::VertexBrain::new(
        sa, project_id, location, model,
    )))
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

    // Azure OpenAI presents itself as an openai_compat endpoint with two
    // twists: `api-key:` auth instead of Bearer, and a mandatory
    // `api-version` query param. Both are opt-in via `extra` so standard
    // endpoints are unaffected:
    //   extra.auth_style = "api_key"          → header scheme
    //   extra.api_version = "2024-08-01-preview" → query param
    //   extra.query = { "k": "v", … }         → arbitrary extra params
    let auth_style = match cfg.extra.get("auth_style").and_then(|v| v.as_str()) {
        Some("api_key") | Some("api-key") | Some("azure") => {
            super::openai_compat::AuthStyle::ApiKey
        }
        _ => super::openai_compat::AuthStyle::Bearer,
    };
    let mut query: Vec<(String, String)> = Vec::new();
    if let Some(ver) = cfg
        .extra
        .get("api_version")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
    {
        query.push(("api-version".to_string(), ver.to_string()));
    }
    if let Some(obj) = cfg.extra.get("query").and_then(|v| v.as_object()) {
        for (k, v) in obj {
            if let Some(s) = v.as_str() {
                query.push((k.clone(), s.to_string()));
            }
        }
    }

    Ok(Arc::new(
        super::openai_compat::OpenAICompatBrain::new(slug, base_url, api_key, model)
            .with_auth_style(auth_style)
            .with_query(query),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `cli_wrapper` names the family; `cli_wrapper:claude_code` names a
    /// member. The cold-boot default used to hand `build` the family name,
    /// and every turn on a machine with no API key stored came back
    /// "unknown provider: cli_wrapper" — a message that describes the app
    /// as broken when the truth is that no CLI has been picked yet.
    ///
    /// Whether this machine has a CLI installed decides which arm answers,
    /// so the assertion is on the arm we must never take again, not on
    /// success: `UnknownProvider` for a name we ship and offer is a lie.
    #[test]
    fn a_bare_family_id_is_never_an_unknown_provider() {
        if let Err(BrainError::UnknownProvider { provider_id }) = build("cli_wrapper") {
            panic!("`{provider_id}` is a family we ship — resolve it or explain it, don't disown it");
        }
    }

    /// Every id the picker offers has to be an id `build` recognises.
    /// A descriptor that can't be built is a row the user can select and
    /// then never get an answer from — the same class of bug as the one
    /// above, arriving through the Settings pane instead of cold boot.
    /// Missing keys and unconfigured endpoints are fine here; those are
    /// states the user can fix and the error already says how.
    #[test]
    fn every_offered_provider_is_buildable_or_says_what_is_missing() {
        for d in descriptors() {
            if let Err(BrainError::UnknownProvider { provider_id }) = build(&d.provider_id) {
                panic!("the picker offers `{provider_id}` but `build` has no arm for it");
            }
        }
    }

    /// The instance is the session, so asking twice has to give back the
    /// same one.
    ///
    /// `BrainManager::from_disk()` runs inside each Tauri command and caches
    /// nothing between them, so "asking twice" is what every second message
    /// in a conversation does. Hand back a new brain there and its session
    /// map is empty, which reads as "no agent is running", which kills the
    /// one that *is* running (`kill_on_drop`) and starts another — then
    /// replays the entire transcript into it. The reply still looks right,
    /// so nothing in the UI ever showed this; what it cost was a process
    /// start and the whole conversation re-read on every single turn.
    #[test]
    #[cfg(feature = "brain_pi")]
    fn a_live_agent_survives_between_turns() {
        let first = build(super::super::pi::PROVIDER_ID).expect("pi builds without a binary");
        let second = build(super::super::pi::PROVIDER_ID).expect("pi builds without a binary");
        assert!(
            Arc::ptr_eq(&first, &second),
            "the second turn of a conversation must reach the agent the first one started",
        );
    }

    /// Same contract, and the one the user actually meets: OpenCode.
    #[test]
    #[cfg(feature = "brain_acp")]
    fn an_acp_agent_survives_between_turns() {
        let id = format!("{}opencode", super::super::acp::PROVIDER_PREFIX);
        let (Ok(first), Ok(second)) = (build(&id), build(&id)) else {
            panic!("`{id}` is a picker row; it has to build whether or not the binary is here");
        };
        assert!(
            Arc::ptr_eq(&first, &second),
            "OpenCode must not be restarted between two messages of one conversation",
        );
    }

    /// And only those. A brain holding an API key or a base URL is built
    /// fresh every turn on purpose — that is what makes an edit in Settings
    /// take effect on the next message rather than the next launch. Caching
    /// one would pin whatever was configured when the app started.
    #[test]
    fn nothing_but_a_live_agent_is_held_open() {
        for d in descriptors() {
            let _ = build(&d.provider_id);
        }
        let live_families = ["pi", "acp:"];
        for id in live_ids() {
            assert!(
                live_families.iter().any(|f| id.starts_with(f)),
                "`{id}` owns no agent process, so holding it open only serves stale settings",
            );
        }
    }

    /// Gemini shipped disabled for a long while, and the reason recorded in
    /// Cargo.toml was "once their streaming is real" — a condition satisfied
    /// by the commit that wrote the file. A build with a full provider
    /// compiled out is indistinguishable, from the Settings pane, from a
    /// product that doesn't support it.
    #[test]
    fn gemini_is_offered_by_default() {
        assert!(
            descriptors().iter().any(|d| d.provider_id == "gemini_native"),
            "a default build should offer Gemini by API key",
        );
    }

    /// `gemini_native` streams generativelanguage.googleapis.com with an AI
    /// Studio key. `vertex` is Claude on your own GCP project, authenticated
    /// with a service-account JSON. They are different providers, and the
    /// Gemini one was labelled after the other — so someone holding a Gemini
    /// key read the list, found "Gemini (Vertex AI)", concluded it wanted
    /// something they didn't have, and went looking for a key field that was
    /// right there.
    #[test]
    fn gemini_is_not_named_after_vertex() {
        for d in descriptors() {
            if d.provider_id == "gemini_native" {
                assert!(!d.display_name.to_lowercase().contains("vertex"));
                assert!(!d.blurb.to_lowercase().contains("vertex"));
                assert!(d.requires_api_key, "the whole point is that it takes a key");
            }
        }
    }

    /// Whether OpenCode is installed on the machine running the tests is
    /// not something to assert on, but the mapping from the agent table to
    /// a provider id is — a typo there produces a picker row that builds
    /// into `UnknownProvider` when clicked.
    #[cfg(feature = "brain_acp")]
    #[test]
    fn every_acp_agent_maps_to_a_provider_id_that_builds() {
        for a in super::super::acp::brain::KNOWN_AGENTS {
            let id = format!("{}{}", super::super::acp::PROVIDER_PREFIX, a.id);
            assert!(
                build(&id).is_ok(),
                "{id} is offered by the agent table but does not build"
            );
            assert!(
                !a.args.is_empty(),
                "{} needs the arguments that put it in ACP mode",
                a.id
            );
        }
    }

    /// An id under the `acp:` prefix that isn't in the table must say what
    /// is available rather than fall through to the generic "unknown
    /// provider" — a stale pinned setting is the likely way to get here.
    #[cfg(feature = "brain_acp")]
    #[test]
    fn an_unknown_acp_agent_names_the_ones_that_exist() {
        // `Arc<dyn Brain>` isn't Debug, so unwrap_err() can't be used.
        let msg = match build("acp:not-a-real-agent") {
            Err(e) => format!("{e}"),
            Ok(_) => panic!("an agent that doesn't exist must not build"),
        };
        assert!(
            msg.contains("not-a-real-agent") && msg.contains("Installed"),
            "the message has to be actionable: {msg}"
        );
    }
}
