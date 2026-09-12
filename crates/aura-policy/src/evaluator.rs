//! Policy evaluator — the core of the trust boundary.
//!
//! Contract:
//!   `evaluate(&CompiledPolicy, &Block, &EvalContext, &mut RateState)
//!    → PolicyDecision`
//!
//! Deterministic given the same inputs ([`RateState`] is the sole mutable
//! input, and its mutation is bounded and documented).
//!
//! Resolution rules:
//!   1. Every matching rule's verdict is recorded in `rules_fired`.
//!   2. Most restrictive verdict wins: Deny > Gate > Auto.
//!   3. Ties broken by `priority` (higher wins).
//!   4. Ties within priority broken by `id` lexicographic.
//!
//! When no rule matches: structural default
//!   - `.aura/` writes → Deny (redundant with the rule, kept as a belt)
//!   - writes_paths only, all inside repo, outside `.aura/` → Auto
//!   - anything else → Gate

use std::path::Path;

use aura_blocks::{
    AgentRef, Block, BlockPayload, BlockState, CapabilityGrade, DeclaredImpacts, PolicyDecision,
};

use crate::context::{EvalContext, RateState, WindowKey};
use crate::schema::{
    CommandMatcher, CompiledPolicy, CompiledRule, DivergenceMatcher, GlobPattern,
    HumanStateMatcher, ImpactMatcher, NetworkMatcher, PathMatcher, RateLimitMatcher, RateScope,
    RuleMatcher, TrustTier, ZoneMatcher,
};

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

pub fn evaluate(
    policy: &CompiledPolicy,
    block: &Block,
    ctx: &EvalContext,
    rate: &mut RateState,
) -> PolicyDecision {
    debug_assert_eq!(
        block.state,
        BlockState::Proposed,
        "evaluate() is only valid on Proposed blocks"
    );

    let mut fired: Vec<MatchedRule> = Vec::new();

    // Agent-capability precheck: if the actor isn't allowed to propose this
    // block kind at all, that's a Deny before any rules run.
    let actor_grant = policy
        .agents
        .iter()
        .find(|g| g.did_matcher.matches(&ctx.actor.0));
    if let Some(grant) = actor_grant {
        if !grant.can_propose_kinds.iter().any(|k| k == &block.kind) {
            return PolicyDecision {
                verdict: CapabilityGrade::Deny,
                rules_fired: vec!["agent-kind-capability".into()],
                reason: format!(
                    "Agent {} not permitted to propose blocks of kind {:?}.",
                    ctx.actor.0, block.kind
                ),
                decided_by: AgentRef("did:aura:policy-engine/v1".into()),
                decided_at: ctx.now,
                gate_reviewer: None,
            };
        }
    } else if !policy.agents.is_empty() {
        // An actor no grant recognizes is not ungoverned — it is gated.
        // Seeded as a fired rule rather than an early return so a Deny rule
        // below can still escalate past it.
        fired.push(MatchedRule {
            id: "agent-grant-unmatched".into(),
            verdict: CapabilityGrade::Gate,
            priority: 950,
            reason: "No capability grant matches this actor; a human must review its proposals."
                .into(),
            detail: Some(format!("actor {}", ctx.actor.0)),
        });
    }
    let actor_grant_id = actor_grant.map(|g| g.id.as_str());

    // AURA-505: Cedar Integration
    // If a Cedar policy is loaded, evaluate it first.
    if let Some(cedar) = &policy.cedar_evaluator {
        match cedar.evaluate_block(block) {
            Ok(Some(verdict)) => {
                if verdict == CapabilityGrade::Deny {
                    return PolicyDecision {
                        verdict,
                        rules_fired: vec!["cedar-policy-pack".into()],
                        reason: "Cedar policy explicitly denied the action.".into(),
                        decided_by: AgentRef("did:aura:policy-engine/v2-cedar".into()),
                        decided_at: ctx.now,
                        gate_reviewer: None,
                    };
                } else if verdict == CapabilityGrade::Auto {
                    return PolicyDecision {
                        verdict,
                        rules_fired: vec!["cedar-policy-pack".into()],
                        reason: "Cedar policy explicitly approved the action.".into(),
                        decided_by: AgentRef("did:aura:policy-engine/v2-cedar".into()),
                        decided_at: ctx.now,
                        gate_reviewer: None,
                    };
                }
            }
            Ok(None) => {
                // Fall through to deterministic W2 advisor/evaluator rules
            }
            Err(e) => {
                // Fail-closed on evaluation errors
                return PolicyDecision {
                    verdict: CapabilityGrade::Deny,
                    rules_fired: vec!["cedar-eval-error".into()],
                    reason: format!("Cedar evaluation failed: {}", e),
                    decided_by: AgentRef("did:aura:policy-engine/v2-cedar".into()),
                    decided_at: ctx.now,
                    gate_reviewer: None,
                };
            }
        }
    }

    // Running "tentative verdict so far" so human-state rules can condition
    // on it without recomputing.
    let mut tentative = CapabilityGrade::Auto;
    for f in &fired {
        tentative = most_restrictive(tentative, f.verdict);
    }

    for rule in &policy.rules {
        if !rule_applies_to_actor(rule, ctx, actor_grant_id) {
            continue;
        }
        if let Some(m) = rule_matches(rule, block, ctx, rate, tentative) {
            fired.push(MatchedRule {
                id: rule.id.clone(),
                verdict: rule.verdict,
                priority: rule.priority,
                reason: rule.reason.clone(),
                detail: m.detail,
            });
            tentative = most_restrictive(tentative, rule.verdict);
        }
    }

    // Resolve
    let (verdict, winning_rule_id, winning_reason) = if fired.is_empty() {
        let (v, r) = structural_default(block, &ctx.repo_root);
        (v, None, r)
    } else {
        let winner = pick_winner(&fired);
        (
            winner.verdict,
            Some(winner.id.clone()),
            winner.reason.clone(),
        )
    };

    PolicyDecision {
        verdict,
        rules_fired: fired.iter().map(|f| f.id.clone()).collect(),
        reason: compose_reason(verdict, winning_rule_id.as_deref(), &winning_reason, &fired),
        decided_by: AgentRef("did:aura:policy-engine/v1".into()),
        decided_at: ctx.now,
        gate_reviewer: None,
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Pre-checks
// ─────────────────────────────────────────────────────────────────────────────

fn rule_applies_to_actor(
    rule: &CompiledRule,
    ctx: &EvalContext,
    actor_grant_id: Option<&str>,
) -> bool {
    if rule.applies_to_agents.is_empty() {
        return true;
    }
    // `applies_to_agents` names grant ids from [[agents]]. Resolve through the
    // grant that matched this actor's DID; when no grant matched, fall back to
    // the agent segment of `did:aura:agent/<agent>/<session>`.
    let actor_id = actor_grant_id
        .or_else(|| ctx.actor.0.split('/').nth(1))
        .unwrap_or("");
    rule.applies_to_agents.iter().any(|a| a == actor_id)
}

// ─────────────────────────────────────────────────────────────────────────────
// Rule matching — one function per matcher variant
// ─────────────────────────────────────────────────────────────────────────────

struct MatchResult {
    detail: Option<String>,
}

fn rule_matches(
    rule: &CompiledRule,
    block: &Block,
    ctx: &EvalContext,
    rate: &mut RateState,
    tentative_so_far: CapabilityGrade,
) -> Option<MatchResult> {
    match &rule.matcher {
        RuleMatcher::PathWrite(m) => match_path_write(m, block, ctx),
        RuleMatcher::Network(m) => match_network(m, block, ctx),
        RuleMatcher::CommandPattern(m) => match_command(m, block),
        RuleMatcher::DeclaredImpact(m) => match_declared_impact(m, block),
        RuleMatcher::Zone(m) => match_zone(m, block, ctx),
        RuleMatcher::IntentDivergence(m) => match_intent_divergence(m, block),
        RuleMatcher::RateLimit(m) => match_rate_limit(rule, m, block, ctx, rate),
        RuleMatcher::HumanState(m) => match_human_state(m, block, ctx, tentative_so_far),
    }
}

fn match_path_write(m: &PathMatcher, block: &Block, ctx: &EvalContext) -> Option<MatchResult> {
    let writes = block
        .declared_impacts
        .writes_paths
        .iter()
        .collect::<Vec<_>>();
    if writes.is_empty() {
        return None;
    }

    for w in &writes {
        let path = Path::new(w.as_str());
        let norm = normalize_repo_relative(path, &ctx.repo_root);
        let inside = norm.is_some();
        // Globs match the normalized repo-relative form, so `src/../.aura/x`
        // can't slip past a `.aura/**` rule by spelling the path differently.
        let cand: &str = match &norm {
            Some(n) => n.to_str().unwrap_or(w.as_str()),
            None => w.as_str(),
        };

        if m.paths_outside_repo && !inside {
            return Some(MatchResult {
                detail: Some(format!("path {} is outside repo", w)),
            });
        }
        if m.paths_inside_repo && inside {
            // But check exclusions
            if m.paths_exclude.iter().any(|g| glob_match(g, cand)) {
                continue;
            }
            if m.paths.is_empty() {
                return Some(MatchResult {
                    detail: Some(format!("path {} inside repo", w)),
                });
            }
        }

        // Glob list
        let mut any_positive = false;
        let mut any_negative_hit = false;
        for g in &m.paths {
            if g.negated {
                if glob_match(g, cand) {
                    any_negative_hit = true;
                }
            } else if glob_match(g, cand) {
                any_positive = true;
            }
        }
        if any_positive && !any_negative_hit {
            return Some(MatchResult {
                detail: Some(format!("path {} matches rule globs", w)),
            });
        }
    }
    None
}

fn match_network(m: &NetworkMatcher, block: &Block, ctx: &EvalContext) -> Option<MatchResult> {
    if let Some(required_tier) = m.trust_tier {
        if ctx.actor_trust_tier != required_tier {
            return None;
        }
        // If only trust_tier is set, matching on tier alone is sufficient.
        if m.hosts.is_empty() && !m.hosts_not_in_allowlist && m.methods.is_empty() {
            return Some(MatchResult {
                detail: Some(format!("trust_tier match: {:?}", required_tier)),
            });
        }
    }

    for n in &block.declared_impacts.network {
        let host_match = !m.hosts.is_empty() && m.hosts.iter().any(|h| h == &n.host);
        let off_allowlist = m.hosts_not_in_allowlist && !ctx.network_allowlist.contains(&n.host);
        let method_wire = n.method.as_wire();
        let method_match = m.methods.is_empty() || m.methods.iter().any(|me| me == method_wire);

        let host_side = host_match || off_allowlist;
        if host_side && method_match {
            return Some(MatchResult {
                detail: Some(format!("network: {} {}", method_wire, n.host)),
            });
        }
    }
    None
}

fn match_command(m: &CommandMatcher, block: &Block) -> Option<MatchResult> {
    let cmd = match &block.payload {
        BlockPayload::Command { command, .. } => command,
        BlockPayload::Proposal {
            proposed_command, ..
        } => proposed_command,
        _ => return None,
    };
    // `scope` distinguishes agent-vs-human. The supervisor sets actor DIDs
    // such that `did:aura:user/*` is human, everything else is agent-like.
    // Scope refinement lives in the supervisor for v1 — the evaluator treats
    // `Any | HumanOnly | AgentOnly` equivalently for now.
    let _ = &m.scope;

    if m.regex.is_match(cmd) {
        Some(MatchResult {
            detail: Some(format!("command matches pattern: {cmd}")),
        })
    } else {
        None
    }
}

fn match_declared_impact(m: &ImpactMatcher, block: &Block) -> Option<MatchResult> {
    if let Some(k) = &m.kind_is {
        if &block.kind != k {
            return None;
        }
    }

    if m.empty_declared_impacts && is_declared_impacts_empty(&block.declared_impacts) {
        return Some(MatchResult {
            detail: Some("agent declared no impacts".into()),
        });
    }

    for field in &m.has_nonempty_fields {
        let nonempty = match field.as_str() {
            "writes_paths" => !block.declared_impacts.writes_paths.is_empty(),
            "reads_paths" => !block.declared_impacts.reads_paths.is_empty(),
            "network" => !block.declared_impacts.network.is_empty(),
            "touches_zones" => !block.declared_impacts.touches_zones.is_empty(),
            "installs_packages" => !block.declared_impacts.installs_packages.is_empty(),
            "mutates_secrets" => !block.declared_impacts.mutates_secrets.is_empty(),
            "deploys" => !block.declared_impacts.deploys.is_empty(),
            _ => false,
        };
        if nonempty {
            return Some(MatchResult {
                detail: Some(format!("declared_impacts.{field} is non-empty")),
            });
        }
    }
    None
}

fn match_zone(m: &ZoneMatcher, block: &Block, ctx: &EvalContext) -> Option<MatchResult> {
    if !m.writes_into_other_actor_zone {
        return None;
    }
    for z in &block.declared_impacts.touches_zones {
        if let Some(owner) = ctx.zone_claims.get(z) {
            if owner != &ctx.actor {
                return Some(MatchResult {
                    detail: Some(format!("zone {z} owned by {}", owner.0)),
                });
            }
        }
    }
    None
}

fn match_intent_divergence(m: &DivergenceMatcher, block: &Block) -> Option<MatchResult> {
    if !m.actual_exceeds_declared {
        return None;
    }
    let actual = block.actual_impacts.as_ref()?;
    if impacts_exceed(actual, &block.declared_impacts) {
        Some(MatchResult {
            detail: Some("actual impacts exceed declared".into()),
        })
    } else {
        None
    }
}

fn match_rate_limit(
    rule: &CompiledRule,
    m: &RateLimitMatcher,
    block: &Block,
    ctx: &EvalContext,
    rate: &mut RateState,
) -> Option<MatchResult> {
    // Does the command/trust filter match?
    if let Some(rx) = &m.command_regex {
        let cmd = match &block.payload {
            BlockPayload::Command { command, .. } => command.as_str(),
            BlockPayload::Proposal {
                proposed_command, ..
            } => proposed_command.as_str(),
            _ => return None,
        };
        if !rx.is_match(cmd) {
            return None;
        }
    }
    if let Some(tt) = m.trust_tier {
        if ctx.actor_trust_tier != tt {
            return None;
        }
    }

    let window = rule.window.as_ref()?;
    let scope_key = match window.scope {
        RateScope::PerActor => ctx.actor.0.clone(),
        RateScope::PerBlockKind => format!("{:?}", block.kind),
        RateScope::Global => "global".into(),
    };
    let key = WindowKey {
        rule_id: rule.id.clone(),
        scope_key,
    };
    let count = rate.tick(key, ctx.now, window.duration_seconds);

    if count > window.max_count {
        Some(MatchResult {
            detail: Some(format!(
                "rate limit: {count} events in {}s (max {})",
                window.duration_seconds, window.max_count
            )),
        })
    } else {
        None
    }
}

fn match_human_state(
    m: &HumanStateMatcher,
    block: &Block,
    ctx: &EvalContext,
    tentative_so_far: CapabilityGrade,
) -> Option<MatchResult> {
    if let Some(v) = m.verdict_so_far_is {
        if tentative_so_far != v {
            return None;
        }
    }
    if let Some((lo, hi)) = m.local_hour_between {
        let local_now = ctx.now + time::Duration::hours(ctx.local_offset_hours as i64);
        let h = local_now.hour();
        let in_window = if lo <= hi {
            h >= lo && h < hi
        } else {
            h >= lo || h < hi
        };
        if !in_window {
            return None;
        }
    }
    if let Some(rx) = &m.command_regex {
        let cmd = match &block.payload {
            BlockPayload::Command { command, .. } => command.as_str(),
            BlockPayload::Proposal {
                proposed_command, ..
            } => proposed_command.as_str(),
            _ => return None,
        };
        if !rx.is_match(cmd) {
            return None;
        }
    }
    Some(MatchResult {
        detail: Some("human-state conditions met".into()),
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/// Lexically resolve a declared path against the repo root. Returns the
/// normalized repo-relative path when it stays inside the repo, and `None`
/// when it is absolute-outside or escapes via `..`. Declared paths come from
/// an agent and may not exist yet — no filesystem calls, pure string logic.
fn normalize_repo_relative(p: &Path, repo_root: &Path) -> Option<std::path::PathBuf> {
    use std::path::Component;
    let rel = if p.is_absolute() {
        p.strip_prefix(repo_root).ok()?.to_path_buf()
    } else {
        p.to_path_buf()
    };
    let mut stack: Vec<std::ffi::OsString> = Vec::new();
    for c in rel.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                if stack.pop().is_none() {
                    return None; // walked above the repo root
                }
            }
            Component::Normal(seg) => stack.push(seg.to_os_string()),
            Component::RootDir | Component::Prefix(_) => return None,
        }
    }
    Some(stack.iter().collect())
}

fn glob_match(g: &GlobPattern, s: &str) -> bool {
    g.compiled.matches(s)
}

fn is_declared_impacts_empty(d: &DeclaredImpacts) -> bool {
    d.writes_paths.is_empty()
        && d.reads_paths.is_empty()
        && d.network.is_empty()
        && d.touches_zones.is_empty()
        && d.installs_packages.is_empty()
        && d.mutates_secrets.is_empty()
        && d.deploys.is_empty()
}

/// The write-scope half of the intent-divergence catch: every path the
/// execution actually wrote that the agent never declared up-front. Empty
/// ⇒ the change stayed inside the declared scope; non-empty ⇒ the agent
/// touched files it didn't say it would (the "did exactly what it said"
/// violation).
///
/// Public so the commit-time reconciler (aura-cli) can render the exact
/// undeclared files to the user, not just a yes/no. The evaluator's gate
/// and the CLI's warning then share ONE definition of "exceeded" and can
/// never drift.
pub fn undeclared_writes(actual: &DeclaredImpacts, declared: &DeclaredImpacts) -> Vec<String> {
    actual
        .writes_paths
        .iter()
        .filter(|p| !declared.writes_paths.contains(p))
        .cloned()
        .collect()
}

fn impacts_exceed(actual: &DeclaredImpacts, declared: &DeclaredImpacts) -> bool {
    !undeclared_writes(actual, declared).is_empty()
        || actual
            .network
            .iter()
            .any(|n| !declared.network.iter().any(|d| d.host == n.host))
        || actual
            .mutates_secrets
            .iter()
            .any(|s| !declared.mutates_secrets.contains(s))
        || actual.deploys.iter().any(|d| !declared.deploys.contains(d))
        || actual
            .installs_packages
            .iter()
            .any(|p| !declared.installs_packages.contains(p))
        || actual
            .touches_zones
            .iter()
            .any(|z| !declared.touches_zones.contains(z))
}

fn is_reversible(block: &Block, repo_root: &Path) -> bool {
    let d = &block.declared_impacts;
    if !d.network.is_empty()
        || !d.installs_packages.is_empty()
        || !d.mutates_secrets.is_empty()
        || !d.deploys.is_empty()
    {
        return false;
    }
    d.writes_paths.iter().all(|p| {
        match normalize_repo_relative(Path::new(p), repo_root) {
            // Outside the repo (or escaping it via `..`) — rewind can't
            // restore what it never snapshotted.
            None => false,
            Some(rel) => !matches!(
                rel.components().next(),
                Some(std::path::Component::Normal(seg)) if seg == ".aura" || seg == ".git"
            ),
        }
    })
}

fn structural_default(block: &Block, repo_root: &Path) -> (CapabilityGrade, String) {
    if is_reversible(block, repo_root) {
        (
            CapabilityGrade::Auto,
            "No rule matched; block is structurally reversible.".into(),
        )
    } else {
        (
            CapabilityGrade::Gate,
            "No rule matched and block is not structurally reversible.".into(),
        )
    }
}

fn most_restrictive(a: CapabilityGrade, b: CapabilityGrade) -> CapabilityGrade {
    use CapabilityGrade::*;
    match (a, b) {
        (Deny, _) | (_, Deny) => Deny,
        (Gate, _) | (_, Gate) => Gate,
        _ => Auto,
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Winner selection
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
struct MatchedRule {
    id: String,
    verdict: CapabilityGrade,
    priority: i32,
    reason: String,
    #[allow(dead_code)]
    detail: Option<String>,
}

fn pick_winner(fired: &[MatchedRule]) -> &MatchedRule {
    // Sort descending by (verdict_weight, priority, id_reverse).
    fn weight(v: CapabilityGrade) -> u8 {
        match v {
            CapabilityGrade::Deny => 2,
            CapabilityGrade::Gate => 1,
            CapabilityGrade::Auto => 0,
        }
    }
    fired
        .iter()
        .max_by(|a, b| {
            weight(a.verdict)
                .cmp(&weight(b.verdict))
                .then(a.priority.cmp(&b.priority))
                .then(a.id.cmp(&b.id).reverse())
        })
        .expect("fired is non-empty by caller")
}

fn compose_reason(
    verdict: CapabilityGrade,
    winner_id: Option<&str>,
    winner_reason: &str,
    fired: &[MatchedRule],
) -> String {
    let lead = match (verdict, winner_id) {
        (CapabilityGrade::Auto, None) => "Auto-approved by structural default.".to_string(),
        (_, Some(id)) => format!(
            "{} (rule {id}): {}",
            match verdict {
                CapabilityGrade::Deny => "Denied",
                CapabilityGrade::Gate => "Human approval required",
                CapabilityGrade::Auto => "Approved",
            },
            winner_reason
        ),
        (g, None) => format!("{:?} by structural default: {}", g, winner_reason),
    };
    if fired.len() > 1 {
        let others: Vec<String> = fired
            .iter()
            .filter(|r| Some(r.id.as_str()) != winner_id)
            .map(|r| format!("{} ({:?})", r.id, r.verdict))
            .collect();
        format!("{lead} Other matches: {}.", others.join(", "))
    } else {
        lead
    }
}

// The unused `TrustTier` import is pulled in only so re-exports compile;
// silence warn under `#[allow]`.
#[allow(dead_code)]
fn _trust_tier_witness(_: TrustTier) {}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{BTreeMap, HashMap, HashSet};
    use std::path::PathBuf;
    use time::OffsetDateTime;

    use aura_blocks::{
        AnchorRef, Attestations, Block, BlockId, BlockKind, BlockPayload, BlockState,
        CapabilityGrade, DeclaredImpacts, Intent, NetworkIntent, NetworkMethod, Provenance,
        SCHEMA_VERSION,
    };

    use crate::context::{EvalContext, RateState};
    use crate::schema::{load_from_str, TrustTier};

    fn policy_from_str(s: &str) -> crate::schema::CompiledPolicy {
        load_from_str(s).unwrap()
    }

    fn ctx(actor: &str, tier: TrustTier) -> EvalContext {
        EvalContext {
            repo_root: PathBuf::from("/repo"),
            cwd: PathBuf::from("/repo"),
            branch: Some("main".into()),
            now: OffsetDateTime::from_unix_timestamp(1_700_000_000).unwrap(),
            local_offset_hours: 0,
            origin_host: "test-host".into(),
            actor: AgentRef(actor.into()),
            actor_trust_tier: tier,
            zone_claims: HashMap::new(),
            network_allowlist: HashSet::new(),
        }
    }

    fn mk_block(payload: BlockPayload, impacts: DeclaredImpacts, kind: BlockKind) -> Block {
        let now = OffsetDateTime::from_unix_timestamp(1_700_000_000).unwrap();
        Block {
            id: BlockId::new(),
            schema_version: SCHEMA_VERSION,
            kind,
            parent_id: None,
            prior_sibling_id: None,
            supersedes_id: None,
            anchor: AnchorRef::None,
            intent: Intent {
                summary: "test".into(),
                detail: None,
                parent_intent: None,
            },
            declared_impacts: impacts,
            actual_impacts: None,
            payload,
            state: BlockState::Proposed,
            policy: None,
            provenance: Provenance {
                actor: AgentRef("did:aura:agent/claude-code/s1".into()),
                on_behalf_of: None,
                origin_host: "test".into(),
                signature: None,
            },
            attestations: Attestations::default(),
            created_at: now,
            updated_at: now,
            extensions: BTreeMap::new(),
        }
    }

    #[test]
    fn reversible_in_repo_write_is_auto() {
        let pol = policy_from_str(include_str!("../policy.toml"));
        let block = mk_block(
            BlockPayload::Command {
                command: "touch src/new.rs".into(),
                shell: Some("zsh".into()),
                cwd: "/repo".into(),
            },
            DeclaredImpacts {
                writes_paths: vec!["src/new.rs".into()],
                ..Default::default()
            },
            BlockKind::Command,
        );
        let mut rate = RateState::new();
        let dec = evaluate(
            &pol,
            &block,
            &ctx("did:aura:agent/claude-code/s1", TrustTier::Standard),
            &mut rate,
        );
        assert_eq!(dec.verdict, CapabilityGrade::Auto, "{}", dec.reason);
    }

    #[test]
    fn aura_dir_write_is_deny() {
        let pol = policy_from_str(include_str!("../policy.toml"));
        let block = mk_block(
            BlockPayload::Command {
                command: "echo x > .aura/policy.toml".into(),
                shell: Some("zsh".into()),
                cwd: "/repo".into(),
            },
            DeclaredImpacts {
                writes_paths: vec![".aura/policy.toml".into()],
                ..Default::default()
            },
            BlockKind::Command,
        );
        let mut rate = RateState::new();
        let dec = evaluate(
            &pol,
            &block,
            &ctx("did:aura:agent/claude-code/s1", TrustTier::Standard),
            &mut rate,
        );
        assert_eq!(dec.verdict, CapabilityGrade::Deny, "{}", dec.reason);
    }

    #[test]
    fn deploy_is_gate() {
        let pol = policy_from_str(include_str!("../policy.toml"));
        let block = mk_block(
            BlockPayload::Command {
                command: "kubectl apply -f staging/".into(),
                shell: Some("zsh".into()),
                cwd: "/repo".into(),
            },
            DeclaredImpacts {
                deploys: vec!["k8s:staging".into()],
                ..Default::default()
            },
            BlockKind::Command,
        );
        let mut rate = RateState::new();
        let dec = evaluate(
            &pol,
            &block,
            &ctx("did:aura:agent/claude-code/s1", TrustTier::Standard),
            &mut rate,
        );
        assert_eq!(dec.verdict, CapabilityGrade::Gate, "{}", dec.reason);
    }

    #[test]
    fn rate_limit_trips_after_threshold() {
        let pol = policy_from_str(include_str!("../policy.toml"));
        let mk = || {
            mk_block(
                BlockPayload::Command {
                    command: "kubectl apply -f staging/".into(),
                    shell: Some("zsh".into()),
                    cwd: "/repo".into(),
                },
                DeclaredImpacts {
                    deploys: vec!["k8s:staging".into()],
                    ..Default::default()
                },
                BlockKind::Command,
            )
        };
        let mut rate = RateState::new();
        // First 3 deploys: Gate (from deploy-commands rule)
        for _ in 0..3 {
            let dec = evaluate(
                &pol,
                &mk(),
                &ctx("did:aura:agent/claude-code/s1", TrustTier::Standard),
                &mut rate,
            );
            assert_eq!(dec.verdict, CapabilityGrade::Gate);
        }
        // 4th tick triggers the rate-limit rule as well; verdict is still Gate,
        // but rules_fired should now include deploy-rate-limit.
        let dec = evaluate(
            &pol,
            &mk(),
            &ctx("did:aura:agent/claude-code/s1", TrustTier::Standard),
            &mut rate,
        );
        assert_eq!(dec.verdict, CapabilityGrade::Gate);
        assert!(
            dec.rules_fired.iter().any(|r| r == "deploy-rate-limit"),
            "rate limit should fire; fired = {:?}",
            dec.rules_fired
        );
    }

    #[test]
    fn most_restrictive_wins_over_priority() {
        // A block that matches both an Auto rule (in-repo-reversible-writes)
        // and a Gate rule (secrets-files) — Gate should win.
        let pol = policy_from_str(include_str!("../policy.toml"));
        let block = mk_block(
            BlockPayload::Command {
                command: "touch .env".into(),
                shell: Some("zsh".into()),
                cwd: "/repo".into(),
            },
            DeclaredImpacts {
                writes_paths: vec![".env".into()],
                ..Default::default()
            },
            BlockKind::Command,
        );
        let mut rate = RateState::new();
        let dec = evaluate(
            &pol,
            &block,
            &ctx("did:aura:agent/claude-code/s1", TrustTier::Standard),
            &mut rate,
        );
        assert_eq!(dec.verdict, CapabilityGrade::Gate);
        assert!(dec.rules_fired.contains(&"secrets-files".to_string()));
    }

    #[test]
    fn untrusted_agent_network_is_deny() {
        let pol = policy_from_str(include_str!("../policy.toml"));
        let block = mk_block(
            BlockPayload::Command {
                command: "curl https://registry.npmjs.org/pkg".into(),
                shell: Some("zsh".into()),
                cwd: "/repo".into(),
            },
            DeclaredImpacts {
                network: vec![NetworkIntent {
                    host: "registry.npmjs.org".into(),
                    method: NetworkMethod::Get,
                    purpose: "fetch package".into(),
                }],
                ..Default::default()
            },
            BlockKind::Command,
        );
        let mut rate = RateState::new();
        let dec = evaluate(
            &pol,
            &block,
            &ctx("did:ext:other-org/agent/x", TrustTier::Untrusted),
            &mut rate,
        );
        assert_eq!(dec.verdict, CapabilityGrade::Deny);
    }

    #[test]
    fn a_dotdot_traversal_cannot_pose_as_an_in_repo_write() {
        // Before normalization, `src/../../../etc/cron.d/evil` joined onto the
        // repo root started with the root and counted as "inside" — the
        // out-of-repo gate never saw it and the write auto-approved.
        let pol = policy_from_str(include_str!("../policy.toml"));
        let block = mk_block(
            BlockPayload::Command {
                command: "install cron job".into(),
                shell: Some("zsh".into()),
                cwd: "/repo".into(),
            },
            DeclaredImpacts {
                writes_paths: vec!["src/../../../etc/cron.d/evil".into()],
                ..Default::default()
            },
            BlockKind::Command,
        );
        let mut rate = RateState::new();
        let dec = evaluate(
            &pol,
            &block,
            &ctx("did:aura:agent/claude-code/s1", TrustTier::Standard),
            &mut rate,
        );
        assert_eq!(dec.verdict, CapabilityGrade::Gate, "{}", dec.reason);
        assert!(
            dec.rules_fired.iter().any(|r| r == "out-of-repo-writes"),
            "escape must hit the out-of-repo rule; fired = {:?}",
            dec.rules_fired
        );
    }

    #[test]
    fn a_dotdot_detour_into_aura_is_still_denied() {
        // `.aura/**` globs match the normalized form, so spelling the path
        // `src/../.aura/…` can't slip past the sanctity rule.
        let pol = policy_from_str(include_str!("../policy.toml"));
        let block = mk_block(
            BlockPayload::Command {
                command: "echo x > src/../.aura/policy.toml".into(),
                shell: Some("zsh".into()),
                cwd: "/repo".into(),
            },
            DeclaredImpacts {
                writes_paths: vec!["src/../.aura/policy.toml".into()],
                ..Default::default()
            },
            BlockKind::Command,
        );
        let mut rate = RateState::new();
        let dec = evaluate(
            &pol,
            &block,
            &ctx("did:aura:agent/claude-code/s1", TrustTier::Standard),
            &mut rate,
        );
        assert_eq!(dec.verdict, CapabilityGrade::Deny, "{}", dec.reason);
        assert!(
            dec.rules_fired.iter().any(|r| r == "system-aura-sanctity"),
            "detour must hit the sanctity rule; fired = {:?}",
            dec.rules_fired
        );
    }

    #[test]
    fn an_actor_no_grant_recognizes_is_gated_not_ungoverned() {
        // With grants configured, an unmatched DID used to sail through the
        // capability precheck entirely and auto-approve reversible writes.
        let pol = policy_from_str(include_str!("../policy.toml"));
        let block = mk_block(
            BlockPayload::Command {
                command: "touch src/new.rs".into(),
                shell: Some("zsh".into()),
                cwd: "/repo".into(),
            },
            DeclaredImpacts {
                writes_paths: vec!["src/new.rs".into()],
                ..Default::default()
            },
            BlockKind::Command,
        );
        let mut rate = RateState::new();
        let dec = evaluate(
            &pol,
            &block,
            &ctx("did:aura:mystery/thing/x", TrustTier::Standard),
            &mut rate,
        );
        assert_eq!(dec.verdict, CapabilityGrade::Gate, "{}", dec.reason);
        assert!(
            dec.rules_fired.iter().any(|r| r == "agent-grant-unmatched"),
            "fired = {:?}",
            dec.rules_fired
        );
    }

    #[test]
    fn agent_scoped_rules_fire_for_the_named_agent_and_only_it() {
        // `applies_to_agents` names grant ids. The old code compared against
        // the DID's *session* segment, so scoped rules never fired for anyone.
        let pol = policy_from_str(include_str!("../policy.toml"));
        let mk = || {
            mk_block(
                BlockPayload::Command {
                    command: "touch src/new.rs".into(),
                    shell: Some("zsh".into()),
                    cwd: "/repo".into(),
                },
                DeclaredImpacts {
                    writes_paths: vec!["src/new.rs".into()],
                    ..Default::default()
                },
                BlockKind::Command,
            )
        };
        let mut rate = RateState::new();

        let dec = evaluate(
            &pol,
            &mk(),
            &ctx("did:aura:agent/claude-code/s1", TrustTier::Standard),
            &mut rate,
        );
        assert_eq!(dec.verdict, CapabilityGrade::Auto, "{}", dec.reason);
        assert!(
            dec.rules_fired
                .iter()
                .any(|r| r == "in-repo-reversible-writes"),
            "the scoped auto rule must fire for claude-code; fired = {:?}",
            dec.rules_fired
        );

        // gemini's grant id is "gemini-retrieval" — not in the rule's list.
        let dec = evaluate(
            &pol,
            &mk(),
            &ctx("did:aura:agent/gemini/s1", TrustTier::Standard),
            &mut rate,
        );
        assert_eq!(dec.verdict, CapabilityGrade::Auto, "{}", dec.reason);
        assert!(
            !dec.rules_fired
                .iter()
                .any(|r| r == "in-repo-reversible-writes"),
            "the scoped rule must NOT fire for gemini; fired = {:?}",
            dec.rules_fired
        );
    }

    #[test]
    fn divergence_sees_undeclared_installs_and_zone_touches() {
        let declared = DeclaredImpacts::default();
        let installs = DeclaredImpacts {
            installs_packages: vec!["leftpad".into()],
            ..Default::default()
        };
        let zones = DeclaredImpacts {
            touches_zones: vec!["payments".into()],
            ..Default::default()
        };
        assert!(impacts_exceed(&installs, &declared));
        assert!(impacts_exceed(&zones, &declared));
        assert!(!impacts_exceed(&declared, &installs));
        assert!(!impacts_exceed(&installs, &installs));
    }

    #[test]
    fn paths_normalize_lexically_against_the_repo_root() {
        let root = Path::new("/repo");
        assert_eq!(
            normalize_repo_relative(Path::new("src/../../etc/x"), root),
            None
        );
        assert_eq!(
            normalize_repo_relative(Path::new("src/../.aura/x"), root),
            Some(PathBuf::from(".aura/x"))
        );
        assert_eq!(
            normalize_repo_relative(Path::new("./src/./a.rs"), root),
            Some(PathBuf::from("src/a.rs"))
        );
        assert_eq!(
            normalize_repo_relative(Path::new("/repo/src/x"), root),
            Some(PathBuf::from("src/x"))
        );
        assert_eq!(normalize_repo_relative(Path::new("/etc/x"), root), None);
        assert_eq!(
            normalize_repo_relative(Path::new("/repo/src/../../escape"), root),
            None
        );
    }

    #[test]
    fn an_outside_repo_write_is_not_structurally_reversible() {
        let block = mk_block(
            BlockPayload::Command {
                command: "touch ../sibling/file".into(),
                shell: Some("zsh".into()),
                cwd: "/repo".into(),
            },
            DeclaredImpacts {
                writes_paths: vec!["../sibling/file".into()],
                ..Default::default()
            },
            BlockKind::Command,
        );
        assert!(!is_reversible(&block, Path::new("/repo")));
        let (verdict, _) = structural_default(&block, Path::new("/repo"));
        assert_eq!(verdict, CapabilityGrade::Gate);
    }
}
