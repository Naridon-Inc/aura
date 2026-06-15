// Taste rule aggregator.
//
// Reads `.aura/taste/observations.jsonl`, groups observations by
// (template, language, layer), computes confidence with the
// signal-weighting vocabulary mirrored from the Skill Ledger, and
// writes `.aura/taste/rules.json` atomically.
//
// Lifecycle (per rule key):
//   candidate     — total weight in [1, 3)              | low confidence anywhere
//   provisional   — total weight in [3, 5)              | confidence ≥ 0.60
//   active        — total weight ≥ 5                    | confidence ≥ 0.70
//   deprecated    — confidence dropped below 0.40       | rule kept around for audit
//
// Confidence: positive_weight / (positive_weight + |negative_weight|).
// "commit" is positive; "thumbs_up" / "pr_review_pass" are positive
// boosts; "edit_on_top" / "thumbs_down" / "rewind" are negatives.
//
// Decay: confidence is reduced 10% per 30-day idle stretch since
// `last_seen`. Keeps stale rules from dominating the active list.
//
// Phase 0 stays text-only — extractors emit `detail` JSON; aggregate
// reads it back and derives a human-readable `statement`. We don't
// re-run any LLM here.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

use super::{observations_path, Observation};

const CANDIDATE_FLOOR: f64 = 1.0;
const PROVISIONAL_FLOOR: f64 = 3.0;
const ACTIVE_FLOOR: f64 = 5.0;
const PROVISIONAL_CONFIDENCE: f64 = 0.60;
const ACTIVE_CONFIDENCE: f64 = 0.70;
const DEPRECATE_BELOW: f64 = 0.40;
const DECAY_INTERVAL_SECS: u64 = 30 * 24 * 60 * 60;
const DECAY_FACTOR: f64 = 0.90;
const MAX_EXAMPLES: usize = 3;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum RuleStatus {
    Candidate,
    Provisional,
    Active,
    Deprecated,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Rule {
    pub id: String,
    pub template: String,
    pub language: String,
    pub layer: String,
    /// Human-readable summary derived from the aggregated detail.
    pub statement: String,
    /// Aggregated payload — template-specific (winning value + counts).
    pub summary: serde_json::Value,
    /// Up to MAX_EXAMPLES recent commit shas backing this rule.
    pub examples: Vec<String>,
    pub positive_weight: f64,
    pub negative_weight: f64,
    pub confidence: f64,
    pub status: RuleStatus,
    pub first_seen: u64,
    pub last_seen: u64,
    /// True only if a human approved via `aura taste approve <id>`.
    /// Auto-promoted rules stay false until reviewed.
    pub user_approved: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuleSet {
    pub version: u32,
    pub updated_at: u64,
    pub rules: Vec<Rule>,
}

impl Default for RuleSet {
    fn default() -> Self {
        Self {
            version: 1,
            updated_at: 0,
            rules: vec![],
        }
    }
}

pub fn rules_path(repo_root: &Path) -> PathBuf {
    repo_root.join(".aura").join("taste").join("rules.json")
}

pub fn load_rules(repo_root: &Path) -> RuleSet {
    let path = rules_path(repo_root);
    let Ok(raw) = fs::read_to_string(&path) else {
        return RuleSet::default();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

pub fn save_rules(repo_root: &Path, rules: &RuleSet) -> std::io::Result<()> {
    let path = rules_path(repo_root);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    // Atomic write — temp + rename so a crash never leaves rules.json
    // half-written for the MCP tool to read.
    let tmp = path.with_extension("json.tmp");
    let mut f = fs::File::create(&tmp)?;
    f.write_all(serde_json::to_string_pretty(rules).unwrap_or_default().as_bytes())?;
    f.flush()?;
    fs::rename(&tmp, &path)?;
    Ok(())
}

/// Read every observation row. Cheap O(N) — Phase 0 logs stay small.
fn load_observations(repo_root: &Path) -> Vec<Observation> {
    let path = observations_path(repo_root);
    let Ok(file) = fs::File::open(&path) else {
        return vec![];
    };
    let mut out = Vec::new();
    for line in BufReader::new(file).lines().flatten() {
        if let Ok(o) = serde_json::from_str::<Observation>(&line) {
            out.push(o);
        }
    }
    out
}

#[derive(Default)]
struct Bucket {
    positive: f64,
    negative: f64,
    first_seen: u64,
    last_seen: u64,
    /// Per-template aggregation state. Stored as a free-form blob and
    /// finalized in `summarize_bucket` once the scan is complete.
    counts: BTreeMap<String, u64>,
    examples: Vec<String>,
}

impl Bucket {
    fn ingest(&mut self, o: &Observation) {
        if o.weight >= 0.0 {
            self.positive += o.weight;
        } else {
            self.negative += o.weight.abs();
        }
        if self.first_seen == 0 || o.ts < self.first_seen {
            self.first_seen = o.ts;
        }
        if o.ts > self.last_seen {
            self.last_seen = o.ts;
        }
        // Pull the template-specific detail keys into the counts map
        // so we can pick the dominant value when finalizing the rule.
        if let Some(obj) = o.detail.as_object() {
            for (k, v) in obj {
                if let Some(n) = v.as_u64() {
                    *self.counts.entry(k.clone()).or_insert(0) += n;
                } else if let Some(s) = v.as_str() {
                    *self.counts.entry(format!("__choice__{}", s)).or_insert(0) += 1;
                }
            }
        }
        if self.examples.len() < MAX_EXAMPLES && !self.examples.contains(&o.commit_sha) {
            self.examples.push(o.commit_sha.clone());
        }
    }
}

/// Translate the dominant value in a bucket into a human-readable
/// statement. Each template has its own phrasing.
fn summarize_bucket(template: &str, language: &str, b: &Bucket) -> (String, serde_json::Value) {
    match template {
        "error_handling.with_context" => {
            let bare = b.counts.get("bare").copied().unwrap_or(0);
            let ctx = b.counts.get("with_context").copied().unwrap_or(0);
            let total = bare + ctx;
            let ratio = if total == 0 { 0.0 } else { ctx as f64 / total as f64 };
            let stmt = if ratio >= 0.7 {
                format!("Wrap errors with `.context()` before propagating ({}: {} / {} adds use context).", language, ctx, total)
            } else if ratio <= 0.3 {
                format!("Bare `?` is the dominant style ({}: {} / {} adds), so don't add `.context()` mid-flow.", language, bare, total)
            } else {
                format!("Mixed error handling in {} — context wrapping at {:.0}% of recent adds.", language, ratio * 100.0)
            };
            (stmt, serde_json::json!({ "with_context": ctx, "bare": bare, "ratio": ratio }))
        }
        "naming.exports" => {
            let named = b.counts.get("named").copied().unwrap_or(0);
            let default = b.counts.get("default").copied().unwrap_or(0);
            let total = named + default;
            let ratio = if total == 0 { 0.0 } else { named as f64 / total as f64 };
            let stmt = if ratio >= 0.7 {
                format!("Use named exports; default exports are rare here ({}: {}/{} are named).", language, named, total)
            } else if ratio <= 0.3 {
                format!("Default exports dominate in {} ({}/{} adds).", language, default, total)
            } else {
                format!("Export style is split in {} — named at {:.0}%.", language, ratio * 100.0)
            };
            (stmt, serde_json::json!({ "named": named, "default": default, "ratio": ratio }))
        }
        "imports.style" => {
            let namespace = b.counts.get("namespace").copied().unwrap_or(0);
            let named = b.counts.get("named").copied().unwrap_or(0);
            let default = b.counts.get("default").copied().unwrap_or(0);
            let total = namespace + named + default;
            let stmt = if named >= namespace && named >= default {
                format!("Prefer named imports (`import {{ a, b }} from …`) — {}/{} adds use them.", named, total.max(1))
            } else if namespace >= default {
                format!("Namespace imports (`import * as X`) lead in {} — {}/{} adds.", language, namespace, total.max(1))
            } else {
                format!("Default imports lead in {} — {}/{} adds.", language, default, total.max(1))
            };
            (stmt, serde_json::json!({ "namespace": namespace, "named": named, "default": default }))
        }
        "formatting.indent" => {
            // detail keys are choice tags written by the extractor
            // ("__choice__2", "__choice__4", "__choice__tab"). Pick
            // the one with the highest count.
            let mut best_choice = "?".to_string();
            let mut best_count = 0u64;
            for (k, v) in &b.counts {
                if let Some(rest) = k.strip_prefix("__choice__") {
                    if *v > best_count {
                        best_count = *v;
                        best_choice = rest.to_string();
                    }
                }
            }
            let label = match best_choice.as_str() {
                "tab" => "tab".to_string(),
                "2" => "2 spaces".to_string(),
                "4" => "4 spaces".to_string(),
                other => other.to_string(),
            };
            let stmt = format!("Indent {} files with {} ({} commits agree).", language, label, best_count);
            (stmt, serde_json::json!({ "dominant": best_choice, "support": best_count }))
        }
        _ => {
            let stmt = format!("Pattern `{}` observed for {}.", template, language);
            (stmt, serde_json::json!({ "raw_counts": b.counts }))
        }
    }
}

fn classify(positive: f64, negative: f64, last_seen: u64) -> (f64, RuleStatus) {
    let total = positive + negative;
    let mut confidence = if total <= 0.0 { 0.0 } else { positive / total };

    // Time decay — every 30 idle days knocks 10% off.
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    if now > last_seen && last_seen > 0 {
        let idle = now.saturating_sub(last_seen);
        let intervals = idle / DECAY_INTERVAL_SECS;
        if intervals > 0 {
            confidence *= DECAY_FACTOR.powi(intervals as i32);
        }
    }

    let status = if confidence < DEPRECATE_BELOW && positive >= ACTIVE_FLOOR {
        // Established rule that fell — flag it explicitly so the user
        // sees the deprecation rather than a silent disappearance.
        RuleStatus::Deprecated
    } else if positive >= ACTIVE_FLOOR && confidence >= ACTIVE_CONFIDENCE {
        RuleStatus::Active
    } else if positive >= PROVISIONAL_FLOOR && confidence >= PROVISIONAL_CONFIDENCE {
        RuleStatus::Provisional
    } else if positive >= CANDIDATE_FLOOR {
        RuleStatus::Candidate
    } else {
        RuleStatus::Candidate
    };

    (confidence, status)
}

/// Re-aggregate observations into rules. Preserves user_approved flags
/// and rule IDs across runs so the chat command and CLAUDE.md stay
/// stable. Returns the new rule count.
pub fn aggregate(repo_root: &Path) -> std::io::Result<RuleSet> {
    let observations = load_observations(repo_root);
    let prior = load_rules(repo_root);

    // Index prior rules by (template, language, layer) so we can
    // carry forward IDs + user_approved across re-runs.
    let mut prior_index: BTreeMap<(String, String, String), Rule> = BTreeMap::new();
    for r in prior.rules {
        prior_index.insert((r.template.clone(), r.language.clone(), r.layer.clone()), r);
    }

    let mut buckets: BTreeMap<(String, String, String), Bucket> = BTreeMap::new();
    for o in &observations {
        let key = (o.rule_template.clone(), o.language.clone(), o.layer.clone());
        buckets.entry(key).or_default().ingest(o);
    }

    let mut rules: Vec<Rule> = Vec::with_capacity(buckets.len());
    for ((template, language, layer), b) in buckets {
        let (statement, summary) = summarize_bucket(&template, &language, &b);
        let (confidence, status) = classify(b.positive, b.negative, b.last_seen);

        let prior_rule = prior_index.get(&(template.clone(), language.clone(), layer.clone()));
        let id = prior_rule.map(|r| r.id.clone()).unwrap_or_else(|| format!("rule_{}", Uuid::new_v4().simple()));
        let user_approved = prior_rule.map(|r| r.user_approved).unwrap_or(false);
        let first_seen = prior_rule
            .map(|r| if r.first_seen == 0 || b.first_seen < r.first_seen { b.first_seen } else { r.first_seen })
            .unwrap_or(b.first_seen);

        rules.push(Rule {
            id,
            template,
            language,
            layer,
            statement,
            summary,
            examples: b.examples,
            positive_weight: b.positive,
            negative_weight: b.negative,
            confidence,
            status,
            first_seen,
            last_seen: b.last_seen,
            user_approved,
        });
    }

    // Sort: active first, then by confidence desc — both for human
    // browsing in `aura taste list` and for CLAUDE.md trimming.
    rules.sort_by(|a, b| {
        let rank = |s: &RuleStatus| match s {
            RuleStatus::Active => 0,
            RuleStatus::Provisional => 1,
            RuleStatus::Candidate => 2,
            RuleStatus::Deprecated => 3,
        };
        rank(&a.status)
            .cmp(&rank(&b.status))
            .then(b.confidence.partial_cmp(&a.confidence).unwrap_or(std::cmp::Ordering::Equal))
    });

    let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let set = RuleSet {
        version: 1,
        updated_at: now,
        rules,
    };
    save_rules(repo_root, &set)?;
    Ok(set)
}

/// Mark a rule approved or rejected by id. Returns true if found.
pub fn set_user_decision(repo_root: &Path, id: &str, approved: bool) -> std::io::Result<bool> {
    let mut set = load_rules(repo_root);
    let mut hit = false;
    for r in set.rules.iter_mut() {
        if r.id == id {
            r.user_approved = approved;
            if !approved {
                // Rejection: flip to deprecated and zero confidence so
                // it disappears from CLAUDE.md immediately.
                r.status = RuleStatus::Deprecated;
                r.confidence = 0.0;
            }
            hit = true;
            break;
        }
    }
    if hit {
        save_rules(repo_root, &set)?;
    }
    Ok(hit)
}

/// Fast helper used by the MCP tool — returns rules that match a
/// (file_path, intent_type) scope. We do simple language/layer
/// matching against the path.
///
/// Scope precedence: for each (template, language), prefer a rule
/// whose layer matches `file_path`'s detected layer exactly; only
/// fall through to a `core` rule when no specific one exists. This
/// stops a coarse `core` rule from shadowing a more-specific layer
/// rule (e.g., "frontend prefers named imports" beating a core
/// "namespace lead" rule on a frontend file).
pub fn rules_for_path(repo_root: &Path, file_path: &str) -> Vec<Rule> {
    let language = super::extract::detect_language(file_path);
    let layer = super::extract::detect_layer(file_path);
    let set = load_rules(repo_root);

    // First pass: collect candidates filtered by language and non-deprecated.
    let mut candidates: Vec<Rule> = set
        .rules
        .into_iter()
        .filter(|r| {
            r.status != RuleStatus::Deprecated
                && (language.is_empty() || r.language == language)
                && (r.layer == layer || r.layer == "core")
        })
        .collect();

    // Second pass: drop core rules that have a layer-specific sibling.
    let layer_specific_keys: std::collections::HashSet<(String, String)> = candidates
        .iter()
        .filter(|r| r.layer == layer && layer != "core")
        .map(|r| (r.template.clone(), r.language.clone()))
        .collect();
    candidates.retain(|r| {
        r.layer != "core" || !layer_specific_keys.contains(&(r.template.clone(), r.language.clone()))
    });
    candidates
}
