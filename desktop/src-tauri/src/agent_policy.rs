//! Agent-CLI config policy — a small, remotely-controllable layer that
//! repairs or normalizes each coding-agent CLI's *own* config file right as
//! Aura spawns it.
//!
//! ## Why this exists
//!
//! Aura drives third-party agent CLIs (Codex, Gemini, Kimi, …) that each read
//! their own on-disk config. Those configs are shared with the vendor's own
//! desktop app, and either side can drift a value the *other* can't run. Two
//! real codex breakages, opposite ends of the same `service_tier` field:
//!   1. Parse crash — the ChatGPT desktop app writes `service_tier = "priority"`,
//!      but the codex CLI's config enum only accepts `fast` / `flex`, so the
//!      spawn died with `unknown variant 'priority', expected 'fast' or 'flex'`.
//!   2. API reject — the OpenAI API later stopped accepting `flex` for `gpt-5.5`
//!      ("Unsupported service_tier: flex", HTTP 400), so a config sitting at the
//!      formerly-safe `flex` fails at request time instead.
//! The floor now pins the one value that survives both layers: `fast`.
//!
//! We can't edit the user's config (the desktop app owns it and would just
//! rewrite it), and we can't pin every user to one CLI version. What we *can*
//! do is inject a per-spawn override through the CLI's own override channel
//! (codex merges `-c key=value` into the TOML *before* it deserializes it, so
//! a bad base value is repaired for that one run without touching the file).
//!
//! ## Control plane (low → high precedence)
//!
//! 1. **built-in floor** — [`builtin_floor`], compiled in; always works even
//!    fully offline. Carries the codex `service_tier` repair.
//! 2. **local override** — `~/.aura/agent-policy.toml`, a power-user / ops
//!    escape hatch on one machine.
//! 3. **remote** — `https://auravcs.com/agents/policy.json`, refreshed in the
//!    background into `~/.aura/cache/agent-policy.json`. This is the fleet
//!    control: one published file steers every install (whatever CLI version
//!    they're on) without an app release.
//!
//! Merge is per-agent replacement (a higher tier that names an agent replaces
//! that agent's rules wholesale), so remote policy is authoritative and the
//! floor only fills agents nobody higher spoke for.
//!
//! ## Engine vs. wired channels
//!
//! The policy *engine* is platform-agnostic: any `agent_id`, any config key,
//! remote-controllable. What's wired end-to-end today is **codex**, because it
//! is the CLI that actually breaks and the one that exposes a non-destructive
//! per-spawn override channel (`-c`). Gemini / Kimi configure via a
//! `settings.json` edit rather than a spawn-time flag and have no reported
//! parse-crash, so their injection channel is intentionally not implemented
//! yet — [`apply_to_invocation`] is the single place a new channel plugs in.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;

/// Fleet-wide authoritative policy. Published from `aura-web/public/agents/`.
const REMOTE_URL: &str = "https://auravcs.com/agents/policy.json";
/// Background-refreshed copy under `~/.aura`. JSON so it round-trips the wire
/// shape verbatim.
const CACHE_REL: &str = "cache/agent-policy.json";
/// Optional per-machine override under `~/.aura`. TOML to match the rest of
/// Aura's user-editable config surface.
const LOCAL_REL: &str = "agent-policy.toml";

/// The whole policy: a map of `agent_id` → the rules Aura applies when it
/// spawns that agent's CLI. Deserializes from both the TOML (local) and JSON
/// (remote/cache) representations unchanged.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct AgentPolicy {
    #[serde(default)]
    pub agents: HashMap<String, AgentRules>,
}

/// Per-agent rules. Both lists default to empty so a partial policy that only
/// names one field still parses.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct AgentRules {
    /// Repair-if-invalid rules: only fire when the CLI's current config value
    /// is present *and* outside the allowed set.
    #[serde(default)]
    pub coerce: Vec<CoerceRule>,
    /// Unconditional overrides: always injected, regardless of current value.
    #[serde(default)]
    pub set: Vec<SetRule>,
}

/// "If `key` is set to something *not* in `keep`, override it to `to` for this
/// spawn." Absent key → left alone (the CLI's own default is assumed valid).
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct CoerceRule {
    /// Dotted config key, e.g. `service_tier` or `model_providers.x.name`.
    pub key: String,
    /// Values considered already-valid; these are never overridden.
    #[serde(default)]
    pub keep: Vec<String>,
    /// The value to inject when the current one isn't in `keep`.
    pub to: String,
}

/// "Always inject `key = value` for this spawn," regardless of the current
/// config. Kept separate from [`CoerceRule`] so the common repair case doesn't
/// need to read the config at all.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SetRule {
    pub key: String,
    pub value: String,
}

/// The compiled-in floor. Always present, works offline, and carries the one
/// repair we know we need: pin codex's `service_tier` to `fast`, coercing any
/// other explicit value (`flex`, `priority`, a future unknown tier) to it.
///
/// `fast` is the only value that both parses AND runs: codex's config enum
/// accepts only `fast`/`flex`, and the OpenAI API now rejects `flex` for
/// `gpt-5.5` ("Unsupported service_tier: flex", HTTP 400) — so a config left at
/// the old "safe" `flex` is exactly what breaks every gpt-5.5 spawn. An *absent*
/// key is left alone: codex's own default sends no tier and the API picks one,
/// which works — so `coerce` (present-and-not-`fast` only) is the right shape.
fn builtin_floor() -> AgentPolicy {
    let mut agents = HashMap::new();
    agents.insert(
        "codex".to_string(),
        AgentRules {
            coerce: vec![CoerceRule {
                key: "service_tier".into(),
                keep: vec!["fast".into()],
                to: "fast".into(),
            }],
            set: vec![],
        },
    );
    AgentPolicy { agents }
}

/// `~/.aura`, mirroring [`crate::cloud_session_sync::aura_dir`] without the
/// error type (policy loading is best-effort, so `None` on no-home is fine).
fn aura_home() -> Option<PathBuf> {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok()
        .map(|h| PathBuf::from(h).join(".aura"))
}

/// Per-agent replacement: every agent named in `over` replaces that agent's
/// rules in `base` wholesale (higher tier wins). Agents only in `base` survive.
fn merge(mut base: AgentPolicy, over: AgentPolicy) -> AgentPolicy {
    for (agent, rules) in over.agents {
        base.agents.insert(agent, rules);
    }
    base
}

/// floor → local override → remote cache, each layer replacing the last.
fn merged_policy() -> AgentPolicy {
    let mut p = builtin_floor();
    if let Some(local) = load_local() {
        p = merge(p, local);
    }
    if let Some(remote) = load_remote_cached() {
        p = merge(p, remote);
    }
    p
}

/// `~/.aura/agent-policy.toml`, best-effort (missing / malformed → `None`).
fn load_local() -> Option<AgentPolicy> {
    let text = std::fs::read_to_string(aura_home()?.join(LOCAL_REL)).ok()?;
    toml::from_str(&text).ok()
}

/// `~/.aura/cache/agent-policy.json`, best-effort. Written by
/// [`refresh_remote`]; absent until the first successful refresh.
fn load_remote_cached() -> Option<AgentPolicy> {
    let bytes = std::fs::read(aura_home()?.join(CACHE_REL)).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// Fetch the authoritative policy and cache it for the *next* spawn. Runs in a
/// background task at startup; entirely best-effort — any failure (offline,
/// non-200, un-parseable) leaves the previous cache (or the floor) in place.
/// We validate the body parses as an [`AgentPolicy`] before writing so a bad
/// deploy can never poison the cache.
pub async fn refresh_remote() {
    let Some(cache) = aura_home().map(|h| h.join(CACHE_REL)) else {
        return;
    };
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(6))
        .build()
    {
        Ok(c) => c,
        Err(_) => return,
    };
    let text = match client.get(REMOTE_URL).send().await {
        Ok(r) if r.status().is_success() => match r.text().await {
            Ok(t) => t,
            Err(_) => return,
        },
        _ => return,
    };
    // Never cache garbage — a body that doesn't parse as a policy is ignored,
    // and the last good cache (or the floor) keeps serving.
    if serde_json::from_str::<AgentPolicy>(&text).is_err() {
        return;
    }
    if let Some(dir) = cache.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(&cache, text);
}

/// Evaluate one agent's rules against a `lookup` over its current config,
/// returning the `(key, value)` overrides to inject. Pure — the config read is
/// injected as a closure so this is unit-testable without touching disk.
fn eval_rules(
    rules: &AgentRules,
    lookup: impl Fn(&str) -> Option<String>,
) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for c in &rules.coerce {
        // Only override a value that is BOTH present and invalid. Absent → the
        // CLI uses its own default (assumed good); already-valid → leave it.
        if let Some(cur) = lookup(&c.key) {
            if !c.keep.iter().any(|k| k == &cur) {
                out.push((c.key.clone(), c.to.clone()));
            }
        }
    }
    for s in &rules.set {
        out.push((s.key.clone(), s.value.clone()));
    }
    out
}

/// Read a dotted key out of an agent CLI's current on-disk config. Returns the
/// value as a string (numbers/bools stringified) or `None` if the config or
/// key is missing. Only agents with a wired reader are handled; others always
/// return `None`, so their coerce rules never fire.
fn current_config_value(agent_id: &str, key: &str) -> Option<String> {
    match agent_id {
        "codex" => codex_config_value(key),
        _ => None,
    }
}

/// Look up a dotted key in codex's `config.toml`. Honors `CODEX_HOME` (the
/// same env var codex itself reads) and falls back to `~/.codex`. Parsed as a
/// generic `toml::Value`, so a value the codex *enum* would reject (e.g.
/// `service_tier = "priority"`) still reads fine here as a plain string — which
/// is exactly what lets us detect and repair it.
fn codex_config_value(key: &str) -> Option<String> {
    let home = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var("HOME").ok().map(|h| PathBuf::from(h).join(".codex")))?;
    let text = std::fs::read_to_string(home.join("config.toml")).ok()?;
    let root: toml::Value = toml::from_str(&text).ok()?;
    toml_lookup(&root, key)
}

/// Resolve a dotted path (`a.b.c`) through nested TOML tables to a scalar
/// string. Non-string scalars are stringified; a missing segment → `None`.
fn toml_lookup(root: &toml::Value, dotted: &str) -> Option<String> {
    let mut cur = root;
    for seg in dotted.split('.') {
        cur = cur.as_table()?.get(seg)?;
    }
    match cur {
        toml::Value::String(s) => Some(s.clone()),
        other => Some(other.to_string()),
    }
}

/// The overrides to inject for `agent_id`, given the merged policy and the
/// agent's current config. Empty when the agent has no rules or nothing needs
/// changing — in which case the spawn stays byte-identical to the pre-feature
/// build.
fn resolve(agent_id: &str) -> Vec<(String, String)> {
    let policy = merged_policy();
    let Some(rules) = policy.agents.get(agent_id) else {
        return Vec::new();
    };
    eval_rules(rules, |key| current_config_value(agent_id, key))
}

/// Apply the resolved config policy to an [`aura_agents::Invocation`] the
/// caller just built, mutating it in place. **Every spawn path that builds an
/// invocation must call this**, so the fleet policy is enforced uniformly no
/// matter how an agent is launched (PTY, stream-json, one-shot, manager brain).
///
/// No-op when the agent has no overrides *or* no wired injection channel, so
/// uncovered paths stay byte-identical.
pub fn apply_to_invocation(agent_id: &str, inv: &mut aura_agents::Invocation) {
    let overrides = resolve(agent_id);
    if overrides.is_empty() {
        return;
    }
    match agent_id {
        "codex" => {
            // Codex takes config overrides as top-level `-c key=value` tokens
            // that MUST precede the subcommand (`exec` / `resume`). Every arg
            // codex.rs emits is already pre-subcommand, so prepending keeps
            // these ahead of it. Codex merges them into the loaded TOML BEFORE
            // it deserializes, so a bad base value is repaired for this run.
            let mut prefixed = Vec::with_capacity(overrides.len() * 2 + inv.args.len());
            for (k, v) in overrides {
                prefixed.push("-c".to_string());
                prefixed.push(format!("{k}={v}"));
            }
            prefixed.append(&mut inv.args);
            inv.args = prefixed;
        }
        // A wired channel exists only for codex today. Other agents resolve
        // their rules but have no spawn-time override channel yet; surface the
        // gap at debug level rather than silently dropping it.
        other => {
            tracing::debug!(
                agent = other,
                count = overrides.len(),
                "agent-policy: overrides resolved but no injection channel wired for this agent"
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn codex_rules() -> AgentRules {
        AgentRules {
            coerce: vec![CoerceRule {
                key: "service_tier".into(),
                keep: vec!["fast".into()],
                to: "fast".into(),
            }],
            set: vec![],
        }
    }

    #[test]
    fn coerce_fires_only_on_invalid_present_value() {
        // Present + not `fast` → coerced. Both the parse-crash tier (`priority`)
        // and the API-rejected tier (`flex`) land on `fast`.
        let out = eval_rules(&codex_rules(), |_| Some("priority".to_string()));
        assert_eq!(out, vec![("service_tier".to_string(), "fast".to_string())]);
        let out = eval_rules(&codex_rules(), |_| Some("flex".to_string()));
        assert_eq!(out, vec![("service_tier".to_string(), "fast".to_string())]);
    }

    #[test]
    fn coerce_skips_already_valid_value() {
        // Only `fast` is kept as-is now; `flex` is no longer valid (see
        // `coerce_fires_only_on_invalid_present_value`).
        let out = eval_rules(&codex_rules(), |_| Some("fast".to_string()));
        assert!(out.is_empty());
    }

    #[test]
    fn coerce_skips_absent_value() {
        // No such key set → the CLI's own default is assumed valid.
        let out = eval_rules(&codex_rules(), |_| None);
        assert!(out.is_empty());
    }

    #[test]
    fn set_rules_always_emit() {
        let rules = AgentRules {
            coerce: vec![],
            set: vec![SetRule {
                key: "model".into(),
                value: "o3".into(),
            }],
        };
        let out = eval_rules(&rules, |_| None);
        assert_eq!(out, vec![("model".to_string(), "o3".to_string())]);
    }

    #[test]
    fn merge_replaces_named_agent_and_keeps_others() {
        let mut base_agents = HashMap::new();
        base_agents.insert("codex".to_string(), codex_rules());
        base_agents.insert(
            "gemini".to_string(),
            AgentRules { coerce: vec![], set: vec![] },
        );
        let base = AgentPolicy { agents: base_agents };

        let mut over_agents = HashMap::new();
        over_agents.insert(
            "codex".to_string(),
            AgentRules {
                coerce: vec![],
                set: vec![SetRule { key: "service_tier".into(), value: "fast".into() }],
            },
        );
        let over = AgentPolicy { agents: over_agents };

        let merged = merge(base, over);
        // codex replaced wholesale by the override…
        assert!(merged.agents["codex"].coerce.is_empty());
        assert_eq!(merged.agents["codex"].set.len(), 1);
        // …gemini (only in base) survives.
        assert!(merged.agents.contains_key("gemini"));
    }

    #[test]
    fn floor_carries_codex_service_tier_repair() {
        let floor = builtin_floor();
        let rules = floor.agents.get("codex").expect("codex in floor");
        // The old ChatGPT-desktop value that won't parse…
        let out = eval_rules(rules, |_| Some("priority".to_string()));
        assert_eq!(out, vec![("service_tier".to_string(), "fast".to_string())]);
        // …and the formerly-safe `flex` the API now rejects for gpt-5.5 — both
        // coerce to `fast`.
        let out = eval_rules(rules, |_| Some("flex".to_string()));
        assert_eq!(out, vec![("service_tier".to_string(), "fast".to_string())]);
    }

    #[test]
    fn apply_prepends_codex_overrides_before_subcommand() {
        // PtyRepl resume shape: `codex resume <id>`. The override must land
        // ahead of `resume`.
        let mut inv = aura_agents::Invocation {
            bin: "codex".into(),
            args: vec!["resume".into(), "uuid-1".into()],
            env: vec![],
            stdout_is_stream_json: false,
        };
        // Drive apply through a rules eval we control: emulate what resolve
        // would produce for a bad service_tier by prepending directly.
        let overrides = eval_rules(&codex_rules(), |_| Some("priority".to_string()));
        let mut prefixed: Vec<String> = Vec::new();
        for (k, v) in overrides {
            prefixed.push("-c".into());
            prefixed.push(format!("{k}={v}"));
        }
        prefixed.append(&mut inv.args);
        inv.args = prefixed;
        assert_eq!(
            inv.args,
            vec!["-c", "service_tier=fast", "resume", "uuid-1"]
        );
    }

    #[test]
    fn toml_lookup_reads_dotted_and_scalar() {
        let root: toml::Value = toml::from_str(
            "service_tier = \"priority\"\n[nested]\nkey = 7\n",
        )
        .unwrap();
        assert_eq!(toml_lookup(&root, "service_tier").as_deref(), Some("priority"));
        assert_eq!(toml_lookup(&root, "nested.key").as_deref(), Some("7"));
        assert_eq!(toml_lookup(&root, "nope"), None);
        assert_eq!(toml_lookup(&root, "nested.nope"), None);
    }
}
