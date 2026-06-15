//! Policy schema — Raw (parsed from policy.toml) + Compiled (evaluator-ready).
//!
//! Raw form round-trips TOML cleanly for diffing and authoring.
//! Compiled form indexes rules by kind, pre-compiles regexes, and validates
//! that every rule is well-formed. The evaluator only ever sees Compiled.

use aura_blocks::{BlockKind, CapabilityGrade};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use thiserror::Error;

// ─────────────────────────────────────────────────────────────────────────────
// Top-level policy document
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct RawPolicy {
    pub version: String,
    pub schema: u32,
    #[serde(default)]
    pub agents: Vec<RawAgentGrant>,
    #[serde(default)]
    pub rules: Vec<RawRule>,
    #[serde(default)]
    pub advisor: Option<AdvisorConfig>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct RawAgentGrant {
    pub id: String,
    pub did_pattern: String,
    pub trust_tier: TrustTier,
    pub can_propose_kinds: Vec<String>, // matches BlockKind serde names
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TrustTier {
    Untrusted,
    Standard,
    Privileged,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct RawRule {
    pub id: String,
    pub kind: RuleKind,
    #[serde(default)]
    pub priority: i32,
    pub verdict: RawVerdict,
    #[serde(default)]
    pub r#match: HashMap<String, toml::Value>, // kind-specific; parsed below
    #[serde(default)]
    pub window: Option<RateWindow>,
    #[serde(default)]
    pub applies_to_agents: Vec<String>, // agent IDs from [[agents]]
    pub reason: String,
}

/// Wire verdict — lowercase snake-case TOML. Mirrors [`CapabilityGrade`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RawVerdict {
    Auto,
    Gate,
    Deny,
}

impl From<RawVerdict> for CapabilityGrade {
    fn from(v: RawVerdict) -> Self {
        match v {
            RawVerdict::Auto => CapabilityGrade::Auto,
            RawVerdict::Gate => CapabilityGrade::Gate,
            RawVerdict::Deny => CapabilityGrade::Deny,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RuleKind {
    PathWrite,
    Network,
    CommandPattern,
    DeclaredImpact,
    Zone,
    IntentDivergence,
    RateLimit,
    HumanState,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct RateWindow {
    pub duration_seconds: u64,
    pub max_count: u32,
    pub scope: RateScope,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RateScope {
    PerActor,
    PerBlockKind,
    Global,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct AdvisorConfig {
    #[serde(default = "default_threshold")]
    pub suggest_rule_threshold_approvals: u32,
    #[serde(default = "default_window_days")]
    pub suggest_rule_min_window_days: u32,
}
fn default_threshold() -> u32 {
    10
}
fn default_window_days() -> u32 {
    7
}

// ─────────────────────────────────────────────────────────────────────────────
// Compiled form — evaluator-ready, no parsing on hot path
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct CompiledPolicy {
    pub version: String,
    pub agents: Vec<CompiledAgentGrant>,
    pub rules: Vec<CompiledRule>,
    pub advisor: AdvisorConfig,
    pub cedar_evaluator: Option<std::sync::Arc<crate::cedar::CedarEvaluator>>,
}

#[derive(Debug, Clone)]
pub struct CompiledAgentGrant {
    pub id: String,
    pub did_matcher: DidMatcher,
    pub trust_tier: TrustTier,
    pub can_propose_kinds: Vec<BlockKind>,
}

#[derive(Debug, Clone)]
pub struct DidMatcher {
    /// Simple prefix + optional glob. `"did:aura:agent/claude-code/*"` →
    /// prefix `"did:aura:agent/claude-code/"` and `has_wildcard_tail = true`.
    pub prefix: String,
    pub has_wildcard_tail: bool,
}

impl DidMatcher {
    pub fn parse(pat: &str) -> Result<Self, PolicyError> {
        if let Some(stripped) = pat.strip_suffix('*') {
            Ok(Self {
                prefix: stripped.to_string(),
                has_wildcard_tail: true,
            })
        } else {
            Ok(Self {
                prefix: pat.to_string(),
                has_wildcard_tail: false,
            })
        }
    }
    pub fn matches(&self, did: &str) -> bool {
        if self.has_wildcard_tail {
            did.starts_with(&self.prefix)
        } else {
            did == self.prefix
        }
    }
}

#[derive(Debug, Clone)]
pub struct CompiledRule {
    pub id: String,
    pub kind: RuleKind,
    pub priority: i32,
    pub verdict: CapabilityGrade,
    pub matcher: RuleMatcher,
    pub window: Option<RateWindow>,
    pub applies_to_agents: Vec<String>,
    pub reason: String,
}

/// Per-kind matcher, pre-compiled. Variants are narrow on purpose — if a new
/// match shape is needed, add a variant, don't stuff it into `extras`.
#[derive(Debug, Clone)]
pub enum RuleMatcher {
    PathWrite(PathMatcher),
    Network(NetworkMatcher),
    CommandPattern(CommandMatcher),
    DeclaredImpact(ImpactMatcher),
    Zone(ZoneMatcher),
    IntentDivergence(DivergenceMatcher),
    RateLimit(RateLimitMatcher),
    HumanState(HumanStateMatcher),
}

#[derive(Debug, Clone, Default)]
pub struct PathMatcher {
    pub paths: Vec<GlobPattern>,         // include list
    pub paths_exclude: Vec<GlobPattern>, // negative filter (`!pattern` → exclude)
    pub paths_outside_repo: bool,
    pub paths_inside_repo: bool,
}

#[derive(Debug, Clone)]
pub struct GlobPattern {
    pub raw: String,
    pub compiled: glob::Pattern,
    pub negated: bool, // `!foo/**` → negated = true
}

#[derive(Debug, Clone, Default)]
pub struct NetworkMatcher {
    pub hosts: Vec<String>,
    pub hosts_not_in_allowlist: bool,
    pub methods: Vec<String>,
    pub trust_tier: Option<TrustTier>,
}

#[derive(Debug, Clone)]
pub struct CommandMatcher {
    pub regex: Regex,
    pub scope: CommandScope,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandScope {
    Any,
    HumanOnly,
    AgentOnly,
}

#[derive(Debug, Clone, Default)]
pub struct ImpactMatcher {
    pub has_nonempty_fields: Vec<String>, // e.g. ["mutates_secrets"]
    pub empty_declared_impacts: bool,
    pub kind_is: Option<BlockKind>,
}

#[derive(Debug, Clone, Default)]
pub struct ZoneMatcher {
    pub writes_into_other_actor_zone: bool,
}

#[derive(Debug, Clone, Default)]
pub struct DivergenceMatcher {
    pub actual_exceeds_declared: bool,
}

#[derive(Debug, Clone)]
pub struct RateLimitMatcher {
    pub command_regex: Option<Regex>,
    pub trust_tier: Option<TrustTier>,
}

#[derive(Debug, Clone, Default)]
pub struct HumanStateMatcher {
    pub verdict_so_far_is: Option<CapabilityGrade>,
    pub local_hour_between: Option<(u8, u8)>,
    pub command_regex: Option<Regex>,
}

// ─────────────────────────────────────────────────────────────────────────────
// Compilation
// ─────────────────────────────────────────────────────────────────────────────

impl RawPolicy {
    pub fn compile(self) -> Result<CompiledPolicy, PolicyError> {
        if self.schema != 1 {
            return Err(PolicyError::UnsupportedSchema(self.schema));
        }

        let agents = self
            .agents
            .into_iter()
            .map(compile_agent)
            .collect::<Result<Vec<_>, _>>()?;

        let rules = self
            .rules
            .into_iter()
            .map(compile_rule)
            .collect::<Result<Vec<_>, _>>()?;

        // Assert rule IDs are unique — audit logs reference them.
        let mut seen = std::collections::HashSet::new();
        for r in &rules {
            if !seen.insert(r.id.clone()) {
                return Err(PolicyError::DuplicateRuleId(r.id.clone()));
            }
        }

        Ok(CompiledPolicy {
            version: self.version,
            agents,
            rules,
            advisor: self.advisor.unwrap_or(AdvisorConfig {
                suggest_rule_threshold_approvals: default_threshold(),
                suggest_rule_min_window_days: default_window_days(),
            }),
            cedar_evaluator: None,
        })
    }
}

fn compile_agent(raw: RawAgentGrant) -> Result<CompiledAgentGrant, PolicyError> {
    let kinds = raw
        .can_propose_kinds
        .iter()
        .map(|k| {
            BlockKind::from_serde_name(k).ok_or_else(|| PolicyError::UnknownBlockKind(k.clone()))
        })
        .collect::<Result<Vec<_>, _>>()?;

    Ok(CompiledAgentGrant {
        id: raw.id,
        did_matcher: DidMatcher::parse(&raw.did_pattern)?,
        trust_tier: raw.trust_tier,
        can_propose_kinds: kinds,
    })
}

fn compile_rule(raw: RawRule) -> Result<CompiledRule, PolicyError> {
    let matcher = match raw.kind {
        RuleKind::PathWrite => RuleMatcher::PathWrite(parse_path_match(&raw.r#match)?),
        RuleKind::Network => RuleMatcher::Network(parse_network_match(&raw.r#match)?),
        RuleKind::CommandPattern => RuleMatcher::CommandPattern(parse_command_match(&raw.r#match)?),
        RuleKind::DeclaredImpact => RuleMatcher::DeclaredImpact(parse_impact_match(&raw.r#match)?),
        RuleKind::Zone => RuleMatcher::Zone(parse_zone_match(&raw.r#match)?),
        RuleKind::IntentDivergence => {
            RuleMatcher::IntentDivergence(parse_divergence_match(&raw.r#match)?)
        }
        RuleKind::RateLimit => RuleMatcher::RateLimit(parse_rate_match(&raw.r#match)?),
        RuleKind::HumanState => RuleMatcher::HumanState(parse_human_state_match(&raw.r#match)?),
    };

    if matches!(raw.kind, RuleKind::RateLimit) && raw.window.is_none() {
        return Err(PolicyError::MissingWindow(raw.id));
    }

    Ok(CompiledRule {
        id: raw.id,
        kind: raw.kind,
        priority: raw.priority,
        verdict: raw.verdict.into(),
        matcher,
        window: raw.window,
        applies_to_agents: raw.applies_to_agents,
        reason: raw.reason,
    })
}

// Parsers for each match block — small, tight, no magic.

fn parse_path_match(m: &HashMap<String, toml::Value>) -> Result<PathMatcher, PolicyError> {
    let mut out = PathMatcher::default();
    if let Some(v) = m.get("paths").and_then(|v| v.as_array()) {
        for p in v {
            let s = p
                .as_str()
                .ok_or_else(|| PolicyError::BadMatch("paths must be strings".into()))?;
            out.paths.push(parse_glob(s)?);
        }
    }
    if let Some(v) = m.get("paths_exclude").and_then(|v| v.as_array()) {
        for p in v {
            let s = p
                .as_str()
                .ok_or_else(|| PolicyError::BadMatch("paths_exclude must be strings".into()))?;
            out.paths_exclude.push(parse_glob(s)?);
        }
    }
    out.paths_outside_repo = m
        .get("paths_outside_repo")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    out.paths_inside_repo = m
        .get("paths_inside_repo")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    Ok(out)
}

fn parse_glob(s: &str) -> Result<GlobPattern, PolicyError> {
    let (negated, body) = if let Some(rest) = s.strip_prefix('!') {
        (true, rest)
    } else {
        (false, s)
    };
    let compiled =
        glob::Pattern::new(body).map_err(|_| PolicyError::BadGlob(body.to_string()))?;
    Ok(GlobPattern {
        raw: s.to_string(),
        compiled,
        negated,
    })
}

fn parse_network_match(m: &HashMap<String, toml::Value>) -> Result<NetworkMatcher, PolicyError> {
    let mut out = NetworkMatcher::default();
    if let Some(v) = m.get("hosts").and_then(|v| v.as_array()) {
        out.hosts = v
            .iter()
            .filter_map(|x| x.as_str().map(String::from))
            .collect();
    }
    out.hosts_not_in_allowlist = m
        .get("hosts_not_in_allowlist")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if let Some(v) = m.get("methods").and_then(|v| v.as_array()) {
        out.methods = v
            .iter()
            .filter_map(|x| x.as_str().map(String::from))
            .collect();
    }
    if let Some(v) = m.get("trust_tier").and_then(|v| v.as_str()) {
        out.trust_tier = Some(parse_trust_tier(v)?);
    }
    Ok(out)
}

fn parse_command_match(m: &HashMap<String, toml::Value>) -> Result<CommandMatcher, PolicyError> {
    let pat = m
        .get("pattern")
        .and_then(|v| v.as_str())
        .ok_or_else(|| PolicyError::BadMatch("command pattern missing".into()))?;
    let scope = match m.get("scope").and_then(|v| v.as_str()).unwrap_or("any") {
        "any" => CommandScope::Any,
        "human_only" => CommandScope::HumanOnly,
        "agent_only" => CommandScope::AgentOnly,
        other => return Err(PolicyError::BadMatch(format!("unknown scope: {other}"))),
    };
    Ok(CommandMatcher {
        regex: Regex::new(pat).map_err(|e| PolicyError::BadRegex(e.to_string()))?,
        scope,
    })
}

fn parse_impact_match(m: &HashMap<String, toml::Value>) -> Result<ImpactMatcher, PolicyError> {
    let mut out = ImpactMatcher::default();
    if let Some(v) = m.get("has_nonempty") {
        match v {
            toml::Value::String(s) => out.has_nonempty_fields.push(s.clone()),
            toml::Value::Array(arr) => {
                for x in arr {
                    if let Some(s) = x.as_str() {
                        out.has_nonempty_fields.push(s.to_string());
                    }
                }
            }
            _ => {
                return Err(PolicyError::BadMatch(
                    "has_nonempty must be string or array".into(),
                ));
            }
        }
    }
    out.empty_declared_impacts = m
        .get("empty_declared_impacts")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if let Some(k) = m.get("kind_is").and_then(|v| v.as_str()) {
        out.kind_is = BlockKind::from_serde_name(k);
    }
    Ok(out)
}

fn parse_zone_match(m: &HashMap<String, toml::Value>) -> Result<ZoneMatcher, PolicyError> {
    Ok(ZoneMatcher {
        writes_into_other_actor_zone: m
            .get("writes_into_other_actor_zone")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
    })
}

fn parse_divergence_match(
    m: &HashMap<String, toml::Value>,
) -> Result<DivergenceMatcher, PolicyError> {
    Ok(DivergenceMatcher {
        actual_exceeds_declared: m
            .get("actual_exceeds_declared")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
    })
}

fn parse_rate_match(m: &HashMap<String, toml::Value>) -> Result<RateLimitMatcher, PolicyError> {
    let command_regex = match m.get("command_pattern").and_then(|v| v.as_str()) {
        Some(p) => Some(Regex::new(p).map_err(|e| PolicyError::BadRegex(e.to_string()))?),
        None => None,
    };
    let trust_tier = match m.get("trust_tier").and_then(|v| v.as_str()) {
        Some(s) => Some(parse_trust_tier(s)?),
        None => None,
    };
    Ok(RateLimitMatcher {
        command_regex,
        trust_tier,
    })
}

fn parse_human_state_match(
    m: &HashMap<String, toml::Value>,
) -> Result<HumanStateMatcher, PolicyError> {
    let mut out = HumanStateMatcher::default();
    if let Some(v) = m.get("verdict_so_far_is").and_then(|v| v.as_str()) {
        out.verdict_so_far_is = Some(match v {
            "auto" => CapabilityGrade::Auto,
            "gate" => CapabilityGrade::Gate,
            "deny" => CapabilityGrade::Deny,
            _ => return Err(PolicyError::BadMatch("unknown verdict_so_far_is".into())),
        });
    }
    if let Some(v) = m.get("local_hour_between").and_then(|v| v.as_array()) {
        if v.len() == 2 {
            let lo = v[0]
                .as_integer()
                .ok_or_else(|| PolicyError::BadMatch("hour not int".into()))?
                as u8;
            let hi = v[1]
                .as_integer()
                .ok_or_else(|| PolicyError::BadMatch("hour not int".into()))?
                as u8;
            out.local_hour_between = Some((lo, hi));
        }
    }
    if let Some(p) = m.get("command_pattern").and_then(|v| v.as_str()) {
        out.command_regex = Some(Regex::new(p).map_err(|e| PolicyError::BadRegex(e.to_string()))?);
    }
    Ok(out)
}

fn parse_trust_tier(s: &str) -> Result<TrustTier, PolicyError> {
    match s {
        "untrusted" => Ok(TrustTier::Untrusted),
        "standard" => Ok(TrustTier::Standard),
        "privileged" => Ok(TrustTier::Privileged),
        other => Err(PolicyError::BadMatch(format!(
            "unknown trust_tier: {other}"
        ))),
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Error)]
pub enum PolicyError {
    #[error("unsupported policy schema: {0}")]
    UnsupportedSchema(u32),
    #[error("duplicate rule id: {0}")]
    DuplicateRuleId(String),
    #[error("unknown block kind: {0}")]
    UnknownBlockKind(String),
    #[error("rate-limit rule missing window: {0}")]
    MissingWindow(String),
    #[error("bad match field: {0}")]
    BadMatch(String),
    #[error("bad glob: {0}")]
    BadGlob(String),
    #[error("bad regex: {0}")]
    BadRegex(String),
    #[error("toml parse: {0}")]
    Toml(#[from] toml::de::Error),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

pub fn load_from_str(s: &str) -> Result<CompiledPolicy, PolicyError> {
    let raw: RawPolicy = toml::from_str(s)?;
    raw.compile()
}

pub fn load_from_path(p: &std::path::Path) -> Result<CompiledPolicy, PolicyError> {
    let s = std::fs::read_to_string(p)?;
    load_from_str(&s)
}
