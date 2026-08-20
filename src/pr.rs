use colored::Colorize;
use git2::{Repository, DiffOptions};
use crate::parser::SemanticParser;
use crate::checkpoint::CheckpointStore;
use std::fs;
use std::path::PathBuf;
use std::collections::{HashSet, HashMap};
use std::time::{SystemTime, UNIX_EPOCH};
use regex::Regex;
use serde::{Deserialize, Serialize};

// Declared here (not in main.rs) so the humanizer lives next to its primary
// caller and the module list in main.rs stays untouched. pub(crate) so
// `distill` can reuse the intent-scoring (best_scored) instead of
// duplicating it.
#[path = "pr_humanize.rs"]
pub(crate) mod pr_humanize;

#[derive(Debug, Serialize, Deserialize, Clone)]
struct InvariantRules {
    #[serde(default)]
    forbidden_imports: Vec<String>,
    #[serde(default)]
    forbidden_calls: Vec<String>,
    #[serde(default)]
    layer_rules: Vec<LayerRule>,
    #[serde(default)]
    protected_nodes: Vec<String>,
}

// Ord so a layer rule can be sorted and deduped like the three string lists
// beside it. Without it `add_policy_pack` appended layer rules unconditionally
// and re-installing a pack grew production.aura.json every time.
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct LayerRule {
    from: String,
    cannot_call: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct PackDescriptor {
    pub id: &'static str,
    pub label: &'static str,
    pub description: &'static str,
    pub rule_count: usize,
    pub category: &'static str,
    /// Every rule this pack adds is already in this repo's
    /// `production.aura.json`. The desktop pane offering these had no way to
    /// know: it tracked installs in React state seeded empty, so a repo with
    /// all seven packs merged still showed seven `install` buttons, and
    /// closing Settings forgot whatever you had just done.
    pub installed: bool,
}

/// What a pack merges. Split out of the match arm it used to live inside so
/// one table answers all three questions — how many rules a pack has, whether
/// they're already present, and what to add — instead of a hand-kept
/// `rule_count` literal in one place and the rules themselves in another.
struct PackRules {
    forbidden_imports: &'static [&'static str],
    forbidden_calls: &'static [&'static str],
    protected_nodes: &'static [&'static str],
    /// (from, cannot_call)
    layer_rules: &'static [(&'static str, &'static str)],
}

impl PackRules {
    fn count(&self) -> usize {
        self.forbidden_imports.len()
            + self.forbidden_calls.len()
            + self.protected_nodes.len()
            + self.layer_rules.len()
    }

    /// Present in full. Partial overlap is not installed: packs share rules
    /// (`eval` is in both `security` and `owasp`), so "some of mine are here"
    /// would mark owasp installed the moment security was.
    fn contained_in(&self, rules: &InvariantRules) -> bool {
        self.forbidden_imports
            .iter()
            .all(|s| rules.forbidden_imports.iter().any(|x| x == s))
            && self
                .forbidden_calls
                .iter()
                .all(|s| rules.forbidden_calls.iter().any(|x| x == s))
            && self
                .protected_nodes
                .iter()
                .all(|s| rules.protected_nodes.iter().any(|x| x == s))
            && self.layer_rules.iter().all(|(from, cannot)| {
                rules
                    .layer_rules
                    .iter()
                    .any(|r| r.from == *from && r.cannot_call == *cannot)
            })
    }
}

struct Pack {
    id: &'static str,
    label: &'static str,
    description: &'static str,
    category: &'static str,
    /// Printed by `aura policy add` under the ✓ line.
    effect: &'static str,
    rules: PackRules,
}

const PACKS: &[Pack] = &[
    Pack {
        id: "security",
        label: "Security baseline",
        description: "Block eval/unsafe_exec; protect authenticate, verify_token, hash_password.",
        category: "security",
        effect: "Enforcing strict execution limits and auth node protection.",
        rules: PackRules {
            forbidden_imports: &[],
            forbidden_calls: &["eval", "unsafe_exec", "child_process.exec"],
            protected_nodes: &["authenticate", "verify_token", "hash_password"],
            layer_rules: &[],
        },
    },
    Pack {
        id: "payments",
        label: "PCI / payments isolation",
        description: "UI cannot call Stripe directly; protect process_payment, issue_refund.",
        category: "compliance",
        effect: "Enforcing PCI isolation (UI cannot call Stripe directly).",
        rules: PackRules {
            forbidden_imports: &[],
            forbidden_calls: &[],
            protected_nodes: &["process_payment", "issue_refund"],
            layer_rules: &[("ui", "stripe")],
        },
    },
    Pack {
        id: "web-app",
        label: "Web app layering",
        description: "Components cannot call DB or filesystem; bans fs and child_process imports.",
        category: "architecture",
        effect: "Enforcing client-server separation (Components cannot call DB or FS).",
        rules: PackRules {
            forbidden_imports: &["fs", "child_process"],
            forbidden_calls: &[],
            protected_nodes: &[],
            layer_rules: &[("components", "database")],
        },
    },
    Pack {
        id: "owasp",
        label: "OWASP Top-10",
        description: "Block unsafe deserialization (pickle/yaml.load), XSS sinks (innerHTML), and protect auth/crypto nodes.",
        category: "security",
        effect: "OWASP Top-10: blocking unsafe deserialization, XSS sinks, and protecting auth/crypto nodes.",
        rules: PackRules {
            forbidden_imports: &[],
            forbidden_calls: &[
                "eval",
                "exec",
                "system",
                "deserialize",
                "pickle.loads",
                "yaml.load",
                "innerHTML",
                "dangerouslySetInnerHTML",
            ],
            protected_nodes: &[
                "authenticate",
                "authorize",
                "sanitize_input",
                "csrf_token",
                "verify_signature",
                "encrypt",
                "decrypt",
            ],
            layer_rules: &[],
        },
    },
    Pack {
        id: "airbnb-js",
        label: "Airbnb JS style",
        description: "Discourage lodash/moment/underscore; ban fetch/axios calls inside components/.",
        category: "style",
        effect: "Airbnb JS: nudging away from deprecated utility libs and direct fetch in components.",
        rules: PackRules {
            forbidden_imports: &["lodash", "underscore", "moment"],
            forbidden_calls: &[],
            protected_nodes: &[],
            layer_rules: &[("components", "fetch"), ("components", "axios")],
        },
    },
    Pack {
        id: "google-style",
        label: "Google style guide",
        description: "Enforce api/internal isolation, public/private boundary, and ban blocking sleep calls.",
        category: "architecture",
        effect: "Google style: enforcing api/internal isolation and banning blocking sleeps.",
        rules: PackRules {
            forbidden_imports: &[],
            forbidden_calls: &["sleep", "time.sleep", "Thread.sleep"],
            protected_nodes: &[],
            layer_rules: &[("api", "internal"), ("public", "private")],
        },
    },
    Pack {
        id: "pep-python",
        label: "PEP Python",
        description: "Block deprecated imp/__future__/execfile; protect __init__, __del__, main.",
        category: "style",
        effect: "PEP Python: blocking deprecated dynamic exec and protecting module entry points.",
        rules: PackRules {
            forbidden_imports: &["imp", "__future__"],
            forbidden_calls: &["compile", "execfile"],
            protected_nodes: &["__init__", "__del__", "main"],
            layer_rules: &[],
        },
    },
];

/// Add a pack's rules to a rule set, idempotently.
///
/// `layer_rules` used to be extended and never deduped, so installing
/// `payments` twice wrote `ui cannot call stripe` twice — and the desktop
/// pane offered "re-install" as a first-class button, so twice was the
/// expected number of clicks.
fn merge_pack(rules: &mut InvariantRules, pack: &Pack) {
    rules
        .forbidden_imports
        .extend(pack.rules.forbidden_imports.iter().map(|s| s.to_string()));
    rules
        .forbidden_calls
        .extend(pack.rules.forbidden_calls.iter().map(|s| s.to_string()));
    rules
        .protected_nodes
        .extend(pack.rules.protected_nodes.iter().map(|s| s.to_string()));
    rules
        .layer_rules
        .extend(pack.rules.layer_rules.iter().map(|(from, cannot)| LayerRule {
            from: from.to_string(),
            cannot_call: cannot.to_string(),
        }));
    rules.forbidden_calls.sort();
    rules.forbidden_calls.dedup();
    rules.forbidden_imports.sort();
    rules.forbidden_imports.dedup();
    rules.protected_nodes.sort();
    rules.protected_nodes.dedup();
    rules.layer_rules.sort();
    rules.layer_rules.dedup();
}

/// This repo's invariant rules, or an empty set when the file is absent or
/// unreadable. Same lenient parse `add_policy_pack` has always used — a
/// hand-edited file that no longer deserialises must not stop you installing.
fn read_invariant_rules() -> InvariantRules {
    fs::read_to_string("production.aura.json")
        .ok()
        .and_then(|json| serde_json::from_str::<InvariantRules>(&json).ok())
        .unwrap_or_else(|| InvariantRules {
            forbidden_imports: vec![],
            forbidden_calls: vec![],
            layer_rules: vec![],
            protected_nodes: vec![],
        })
}

#[derive(Serialize)]
struct ReviewReport {
    base_branch: String,
    total_changes: usize,
    unverified_nodes: HashMap<String, usize>, // kind -> count
    invariant_violations: Vec<String>,
    blast_radius: Vec<String>,
    cross_branch_conflicts: Vec<String>,
    /// Phase 2 of the Taste Engine — coding-pattern violations
    /// surfaced as advisory PR findings. Each entry is a one-line
    /// human-readable summary; full structure is available via
    /// `aura taste check --json`.
    #[serde(default)]
    taste_findings: Vec<String>,
    risk_score: usize,
    risk_label: String,
    /// Plain-language one-paragraph overview, written for a reader who is not
    /// the author and not necessarily a developer. See `pr_humanize`.
    #[serde(default)]
    summary: String,
    /// The raw `*_violations` / `blast_radius` / `conflicts` streams folded
    /// into deduped, plain-language cards (what / why it matters / where / how
    /// bad / what to do). Additive — the legacy arrays above stay for back-compat.
    #[serde(default)]
    findings: Vec<pr_humanize::HumanFinding>,
    /// Per-file "what changed and *why*" — the captured intent paired with each
    /// change so a reviewer can decide without reading the code.
    #[serde(default)]
    changes: Vec<pr_humanize::ChangeIntent>,
}

pub struct PrReviewEngine;

impl PrReviewEngine {
    /// Every pack, each carrying whether this repo already has it in full.
    /// Reads `production.aura.json` relative to the process cwd, which is the
    /// repo root for both `aura policy list` and the desktop pane that shells
    /// it.
    pub fn list_policy_packs() -> Vec<PackDescriptor> {
        let current = read_invariant_rules();
        PACKS
            .iter()
            .map(|p| PackDescriptor {
                id: p.id,
                label: p.label,
                description: p.description,
                rule_count: p.rules.count(),
                category: p.category,
                installed: p.rules.contained_in(&current),
            })
            .collect()
    }

    pub fn add_policy_pack(pack_name: &str) -> Result<(), Box<dyn std::error::Error>> {
        println!("{} {} {}", "\u{1F4E6}".bold(), "Aura Policy Marketplace: Installing".bold().cyan(), pack_name.yellow());

        let wanted = pack_name.to_lowercase();
        let Some(pack) = PACKS.iter().find(|p| p.id == wanted) else {
            let ids = PACKS.iter().map(|p| p.id).collect::<Vec<_>>().join(", ");
            println!("{} Unknown policy pack '{}'. Available: {}", "\u{2717}".red(), pack_name, ids);
            println!("  {} Run {} for full descriptions.", "\u{21B3}".dimmed(), "aura policy list".cyan());
            return Ok(());
        };

        let mut rules = read_invariant_rules();
        merge_pack(&mut rules, pack);
        println!("  {} {}", "\u{21B3}".dimmed(), pack.effect);

        let updated_json = serde_json::to_string_pretty(&rules)?;
        fs::write("production.aura.json", updated_json)?;

        println!("{} Policy Pack '{}' merged into production.aura.json successfully.", "\u{2713}".green().bold(), pack_name);
        Ok(())
    }

    pub fn run_review(base_branch: &str, json_output: bool, verbose: bool) -> Result<Option<String>, Box<dyn std::error::Error>> {
        if !json_output {
            println!("\n{} {} {}", "🔍".bold(), "Aura Semantic pr-review:".bold().cyan(), base_branch.yellow());
            println!("  {} Comparing current HEAD against {}...", "↳".dimmed(), base_branch);
        }

        let repo = Repository::open(".")?;
        
        let head = repo.head()?.peel_to_commit()?;
        let head_tree = head.tree()?;
        
        let base_obj = repo.revparse_single(base_branch)?;
        let base_commit = base_obj.as_commit().ok_or("Base is not a commit")?;
        let base_tree = base_commit.tree()?;

        let mut opts = DiffOptions::new();
        let diff = repo.diff_tree_to_tree(Some(&base_tree), Some(&head_tree), Some(&mut opts))?;
        
        let mut changed_files = Vec::new();
        diff.foreach(&mut |delta, _| {
            if let Some(path) = delta.new_file().path() {
                changed_files.push(path.to_path_buf());
            }
            true
        }, None, None, None)?;

        if changed_files.is_empty() {
            if json_output {
                return Ok(Some(serde_json::to_string(&serde_json::json!({"status": "no_changes"}))?));
            } else {
                println!("{} No changes detected between branches.", "✓".green());
            }
            return Ok(None);
        }

        if !json_output {
            println!("  {} Detected {} changed files. Parsing logic structure...", "↳".dimmed(), changed_files.len());
        }

        let mut parser = SemanticParser::new()?;
        let mut total_changes = Vec::new();
        let mut modified_nodes = Vec::new();
        let mut deleted_node_names = Vec::new();

        for path in changed_files {
            let path_str = path.to_string_lossy().to_string();
            let ext = match path.extension().and_then(|s| s.to_str()) {
                Some("rs") => "rs",
                Some("py") => "py",
                Some("ts") | Some("tsx") => "ts",
                Some("js") | Some("jsx") => "js",
                _ => continue,
            };

            if let Ok(new_source) = fs::read_to_string(&path) {
                if let Ok(new_nodes) = parser.parse_file(&new_source, ext) {
                    let old_nodes = if let Ok(entry) = base_tree.get_path(&path) {
                        if let Ok(obj) = entry.to_object(&repo) {
                            if let Some(blob) = obj.as_blob() {
                                if let Ok(old_source) = std::str::from_utf8(blob.content()) {
                                    parser.parse_file(old_source, ext).unwrap_or_default()
                                } else { Vec::new() }
                            } else { Vec::new() }
                        } else { Vec::new() }
                    } else { Vec::new() };

                    let file_diff = SemanticParser::diff_nodes(&old_nodes, &new_nodes);
                    for (ident, action) in file_diff {
                        total_changes.push((path_str.clone(), ident.clone(), action.clone()));
                        if action == "modified" || action == "added" {
                            if let Some(node) = new_nodes.iter().find(|n| n.identifier.as_ref() == Some(&ident)) {
                                modified_nodes.push((path_str.clone(), node.clone()));
                            }
                        } else if action == "deleted" {
                            deleted_node_names.push(ident);
                        }
                    }
                }
            }
        }

        // 3. Wave 3: Intent Verification
        let mut unverified_nodes = Vec::new();
        let mut unverified_by_kind: HashMap<String, usize> = HashMap::new();
        let latest_checkpoint = CheckpointStore::latest_checkpoint(&repo).ok().flatten();
        
        if let Some(latest) = latest_checkpoint.as_ref() {
            let active_intent = latest.intent.to_lowercase();
            for (_, node) in &modified_nodes {
                if let Some(ref ident) = node.identifier {
                    let pattern = format!(r"\b{}\b", regex::escape(&ident.to_lowercase()));
                    if let Ok(re) = Regex::new(&pattern) {
                        if !re.is_match(&active_intent) {
                            unverified_nodes.push(ident.clone());
                            *unverified_by_kind.entry(node.kind.clone()).or_insert(0) += 1;
                        }
                    }
                }
            }
        }

        // 4. Wave 4: Blast Radius Analysis
        let mut tainted_nodes = HashSet::new();
        let mut modified_names = Vec::new();
        for (_, node) in &modified_nodes {
            if let Some(ref ident) = node.identifier {
                modified_names.push(ident.clone());
            }
        }

        if let Some(latest) = latest_checkpoint.as_ref() {
            for past_node in &latest.ast_nodes {
                for dep in &past_node.dependencies {
                    if modified_names.contains(&dep.name) {
                        if let Some(ref past_ident) = past_node.identifier {
                            if !modified_names.contains(past_ident) {
                                tainted_nodes.insert(past_ident.clone());
                            }
                        }
                    }
                }
            }
        }

        // 5. Wave 5: Invariant Engine
        let mut invariant_violations = Vec::new();
        if let Ok(rules_json) = fs::read_to_string("production.aura.json") {
            if let Ok(rules) = serde_json::from_str::<InvariantRules>(&rules_json) {
                for (path, node) in &modified_nodes {
                    let ident = node.identifier.clone().unwrap_or_else(|| "anonymous".to_string());
                    // Exact location of this changed symbol on the NEW side
                    // (nodes are parsed from head source). Appended as a
                    // `(path:line)` token so the review layer can lift it into
                    // a real inline-comment anchor — see review::findings.
                    let loc = match node.start_line {
                        Some(l) => format!(" ({path}:{l})"),
                        None => format!(" ({path})"),
                    };

                    for dep in &node.dependencies {
                        if rules.forbidden_calls.contains(&dep.name) {
                            invariant_violations.push(format!("Forbidden Call: Node '{}' calls '{}'{}", ident, dep.name, loc));
                        }
                    }

                    for rule in &rules.layer_rules {
                        if path.contains(&rule.from) {
                            let mut visited = HashSet::new();
                            let mut queue = Vec::new();
                            for dep in &node.dependencies { queue.push((dep.clone(), 1)); }

                            while let Some((current_dep, hop)) = queue.pop() {
                                if hop > 3 || visited.contains(&current_dep.name) { continue; }
                                visited.insert(current_dep.name.clone());

                                let is_violation = current_dep.name.to_lowercase().contains(&rule.cannot_call.to_lowercase()) || 
                                                 current_dep.uri.as_ref().map(|u| u.contains(&rule.cannot_call)).unwrap_or(false);
                                
                                if is_violation {
                                    invariant_violations.push(format!(
                                        "Layer Violation: '{}' layer node '{}' eventually calls '{}' ({} hops){}",
                                        rule.from, ident, rule.cannot_call, hop, loc
                                    ));
                                    break;
                                }

                                if let Some(latest) = latest_checkpoint.as_ref() {
                                    if let Some(graph_node) = latest.ast_nodes.iter().find(|n| n.identifier.as_ref() == Some(&current_dep.name)) {
                                        for next_dep in &graph_node.dependencies { queue.push((next_dep.clone(), hop + 1)); }
                                    }
                                }
                            }
                        }
                    }

                    if rules.protected_nodes.contains(&ident) {
                        invariant_violations.push(format!("Protected Node Modified: '{}' is a sensitive logic block.{}", ident, loc));
                    }
                }

                for ident in &deleted_node_names {
                    if rules.protected_nodes.contains(ident) {
                        invariant_violations.push(format!("Protected Node Deleted: '{}' has been removed!", ident));
                    }
                }
            }
        }

        // Cross-branch conflict detection removed. The previous loop emitted
        // one "graph-neighborhood overlap" finding per *existing local branch*
        // (snapshot branches `aura/snapshot/*` included) whenever any node
        // changed, while discarding the trees/checkpoints it loaded — so it
        // was pure noise that ballooned into "N conflicts" and flipped the
        // verdict to CRITICAL by branch count alone. Genuine cross-branch
        // danger is surfaced by the live-impacts system (`aura_live_impacts`)
        // instead. Kept as an empty vec so the JSON report shape is stable.
        let conflicts: Vec<String> = Vec::new();

        // Omni-Graph cross-repo federation removed. It fired a live blocking
        // HTTP call to a hardcoded endpoint on every review and added a flat
        // +100 to the risk score whenever it answered — phantom CRITICAL plus
        // a network dependency inside a local command. Cross-repo impact is a
        // real feature, but it belongs behind an explicit, authenticated
        // federation flow, not a best-effort request here. Empty vec keeps the
        // report shape stable.
        let omni_graph_impact: Vec<String> = Vec::new();

        // Phase 2 — Taste Engine surfacing as advisory findings.
        // Scan the cumulative base..head delta against active rules at
        // a 0.85 confidence floor (informational threshold; pre-commit
        // strict mode uses the same). Each violation contributes a
        // small risk score bump (3 per finding) — not enough to flip
        // a LOW review to CRITICAL on its own.
        let taste_findings: Vec<String> = match crate::taste::check::check_tree_diff(
            &repo,
            Some(&base_tree),
            &head_tree,
            0.85,
        ) {
            Ok(report) => report
                .violations
                .into_iter()
                .map(|v| {
                    format!(
                        "{}: {} (rule: {}, confidence {:.2})",
                        v.file_path, v.reason, v.template, v.confidence,
                    )
                })
                .collect(),
            Err(_) => vec![],
        };

        // Risk now reflects only real signal: changed/tainted nodes, undocumented
        // changes, architectural invariant violations, and advisory taste
        // findings. The former conflicts*15 and omni-graph +100 terms are gone
        // along with the phantom detectors that fed them.
        let mut risk_score = (modified_nodes.len() * 2) + (tainted_nodes.len() * 5);
        if !unverified_nodes.is_empty() { risk_score += 20; }
        if !invariant_violations.is_empty() { risk_score += 50; }
        risk_score += taste_findings.len() * 3;

        let risk_label = if risk_score > 60 { "CRITICAL" } else if risk_score > 20 { "MODERATE" } else { "LOW" };

        // Humanize: fold the raw finding streams into plain-language cards and
        // pair each changed file with the intent behind it, so the review reads
        // for a person — not as a developer-only dump. Computed once, used by
        // both the JSON (app) and terminal surfaces.
        let blast_vec: Vec<String> = tainted_nodes.iter().cloned().collect();
        let human_findings = pr_humanize::humanize_findings(
            &invariant_violations,
            &taste_findings,
            &blast_vec,
            &conflicts,
        );
        let mut intent_log = pr_humanize::load_intent_log(std::path::Path::new("."));
        // Reviewer fallback: someone who didn't author this branch has an
        // empty local intent log, but rows mirrored onto refs/notes/aura-intent
        // by `aura meta push` travel with the repo. Pull the review range's
        // notes rows into the candidate pool — same scoring, tagged with their
        // origin so local rows always win and the WHO field can say "via notes".
        intent_log.extend(pr_humanize::load_notes_intents(
            &repo,
            base_commit.id(),
            head.id(),
        ));
        let cp_fallback = latest_checkpoint
            .as_ref()
            .map(|c| (c.intent.as_str(), c.timestamp, c.agent_id.as_str()));
        let change_intents =
            pr_humanize::build_change_intents(&total_changes, &modified_nodes, &intent_log, cp_fallback);
        let file_count = total_changes
            .iter()
            .map(|(f, _, _)| f.as_str())
            .collect::<HashSet<_>>()
            .len();
        let summary = pr_humanize::build_summary(file_count, total_changes.len(), risk_label, &human_findings);

        if json_output {
            let mut report = serde_json::to_value(&ReviewReport {
                base_branch: base_branch.to_string(),
                total_changes: total_changes.len(),
                unverified_nodes: unverified_by_kind.clone(),
                invariant_violations: invariant_violations.clone(),
                blast_radius: blast_vec.clone(),
                cross_branch_conflicts: conflicts.clone(),
                taste_findings: taste_findings.clone(),
                risk_score,
                risk_label: risk_label.to_string(),
                summary: summary.clone(),
                findings: human_findings.clone(),
                changes: change_intents.clone(),
            })?;

            // Inject Omni-Graph data dynamically
            report["omni_graph_impact"] = serde_json::json!(omni_graph_impact);

            // Persist to .aura/reviews/<unix>.json for the PR Inbox UI.
            // Best-effort: failing to write should never break the review
            // command itself.
            let _ = persist_review(&report);

            return Ok(Some(serde_json::to_string_pretty(&report)?));
        }

        // 6. Executive Report (Human-Readable)
        println!("\n{:-^80}\n", " SEMANTIC REVIEW REPORT ".bold().blue());
        println!("{} {} logic nodes changed.", "🗂️ ".bold(), total_changes.len());

        // Plain-language lead: the review for a person, before the detailed
        // engine sections below. Mirrors the JSON `summary`/`findings`/`changes`
        // the app renders.
        println!("\n{}", summary.white());

        if !human_findings.is_empty() {
            println!("\n{} {}", "📋".bold(), "What to look at".bold().cyan());
            for f in &human_findings {
                let (icon, sev) = match f.severity.as_str() {
                    "critical" => ("🔴", "must fix".red().bold()),
                    "warning" => ("🟠", "review".yellow().bold()),
                    "advisory" => ("🔵", "style".blue().bold()),
                    _ => ("⚪", "fyi".dimmed().bold()),
                };
                let count = if f.count > 1 { format!(" ×{}", f.count) } else { String::new() };
                let loc = match (&f.file, f.line) {
                    (Some(file), Some(l)) => format!(" {}", format!("({file}:{l})").dimmed()),
                    (Some(file), None) => format!(" {}", format!("({file})").dimmed()),
                    _ => String::new(),
                };
                println!("  {} [{}] {}{}{}", icon, sev, f.title.white().bold(), count.dimmed(), loc);
                println!("      {}", f.detail.dimmed());
                if let Some(s) = &f.suggestion {
                    println!("      {} {}", "→".green(), s.green());
                }
            }
        }

        let with_why: Vec<_> = change_intents.iter().filter(|c| c.why.is_some()).collect();
        if !with_why.is_empty() {
            println!("\n{} {}", "🧭".bold(), "Why these changes".bold().cyan());
            for c in &with_why {
                println!("  {} {} {}", "•".blue(), c.file.white().bold(), format!("— {}", c.what).dimmed());
                if let Some(why) = &c.why {
                    println!("      {}", why.white());
                }
            }
        }

        println!("\n{:-^80}", "-".dimmed());

        let renames: Vec<_> = total_changes.iter().filter(|(_, _, a)| a == "renamed").collect();
        if !renames.is_empty() {
            println!("\n{} {}:", "🔄".bold(), "Logical Renames/Moves".blue().bold());
            for (file, ident, _) in renames {
                println!("  {} {} {}", "•".blue(), ident.white().bold(), format!("({})", file).dimmed());
            }
        }
        
        if !unverified_by_kind.is_empty() {
            let total_unverified = unverified_nodes.len();
            let summary: Vec<String> = unverified_by_kind.iter().map(|(k, v)| format!("{} {}s", v, k)).collect();
            println!("{} Undocumented changes: {}", "🚨".red().bold(), summary.join(", "));
            
            if verbose {
                for node in &unverified_nodes {
                    println!("  {} {}", "↳".dimmed(), node.red());
                }
            } else {
                for node in unverified_nodes.iter().take(5) {
                    println!("  {} {}", "↳".dimmed(), node.red());
                }
                if total_unverified > 5 {
                    println!("  {} ...and {} more (run with --verbose to see all)", "↳".dimmed(), total_unverified - 5);
                }
            }
        } else {
            println!("{} All logic changes verified against stated intent.", "🛡️ ".green());
        }

        if !invariant_violations.is_empty() {
            println!("\n{} {} Architectural Invariant Violations!", "❌".red().bold(), invariant_violations.len());
            for violation in invariant_violations.iter().take(5) {
                println!("  • {}", violation.yellow());
            }
        } else {
            println!("{} All architectural invariants satisfied.", "🏛️ ".green());
        }

        if !taste_findings.is_empty() {
            println!("\n{} {} Taste Violations (advisory)", "🧪".yellow().bold(), taste_findings.len());
            for finding in taste_findings.iter().take(8) {
                println!("  • {}", finding.yellow());
            }
            if taste_findings.len() > 8 {
                println!("  {} ...and {} more (run `aura taste check` to see all)", "↳".dimmed(), taste_findings.len() - 8);
            }
        }

        if !tainted_nodes.is_empty() {
            println!("\n{} {}: {} local downstream blocks affected.", "☢️ ".bold(), "Local Blast Radius".yellow().bold(), tainted_nodes.len());
            for node in tainted_nodes.iter().take(5) {
                println!("  {} {}", "↳".dimmed(), node.yellow());
            }
        }

        if !omni_graph_impact.is_empty() {
            println!("\n{} {}:", "🌐".bold(), "OMNI-GRAPH ALERT (Cross-Repo Taint)".red().bold().blink());
            for impact in &omni_graph_impact {
                println!("  {} {}", "❗".red(), impact.red());
            }
        }

        if !conflicts.is_empty() {
            println!("\n{} {}:", "⚔️ ".bold(), "Cross-Branch Conflicts".yellow().bold());
            for conflict in &conflicts {
                println!("  • {}", conflict.yellow());
            }
        }

        println!("\n{:-^80}", "-".dimmed());
        
        // DX-Friendly Verdict & Action Items
        println!("{} {}", "⚖️ ".bold(), "Aura Verdict & Next Steps".bold().cyan());
        
        let color_label = if risk_score > 60 { "CRITICAL".red().bold() } else if risk_score > 20 { "MODERATE".yellow().bold() } else { "LOW".green().bold() };
        println!("  {} {}: {}", "Risk Level".bold(), "Overall Architectural Risk", color_label);
        
        if risk_score > 60 {
            println!("  {} {}", "Verdict".bold(), "MERGE BLOCKED. High probability of semantic collision or policy violation.".red());
        } else if risk_score > 20 {
            println!("  {} {}", "Verdict".bold(), "PROCEED WITH CAUTION. The code is logically sound, but the merge may be heavy due to overlap.".yellow());
        } else {
            println!("  {} {}", "Verdict".bold(), "SAFE TO MERGE. No architectural violations or cross-branch conflicts detected.".green());
        }

        println!("\n  {}", "Suggested Actions:".bold());
        let mut no_actions = true;

        if !invariant_violations.is_empty() {
            println!("    {} Run {} to have the Sovereign Arbitrator automatically fix the policy violations.", "↳".dimmed(), "aura fix".cyan().bold());
            no_actions = false;
        }
        
        if !tainted_nodes.is_empty() {
            println!("    {} Run {} to visually inspect the blast radius and ensure downstream functions aren't broken.", "↳".dimmed(), "aura map".cyan().bold());
            no_actions = false;
        }

        if !conflicts.is_empty() {
            println!("    {} Coordinate with the owners of the overlapping branches to prevent blind logic overwrites during merge.", "↳".dimmed());
            no_actions = false;
        }
        
        if !unverified_nodes.is_empty() {
            println!("    {} Update your latest commit message with an explicit intent mentioning the undocumented nodes.", "↳".dimmed());
            no_actions = false;
        }

        if no_actions {
            println!("    {} None! You are good to go.", "↳".dimmed());
        }

        println!("{:-^80}\n", "-".dimmed());

        Ok(None)
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ReviewSummary {
    pub ts: i64,
    pub base_branch: String,
    pub total_changes: usize,
    pub risk_score: usize,
    pub risk_label: String,
    pub invariant_violations: usize,
    pub blast_radius: usize,
    pub cross_branch_conflicts: usize,
    pub omni_graph_impact: usize,
}

fn reviews_dir() -> PathBuf {
    PathBuf::from(".aura").join("reviews")
}

fn persist_review(report: &serde_json::Value) -> std::io::Result<()> {
    let dir = reviews_dir();
    fs::create_dir_all(&dir)?;
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let path = dir.join(format!("{}.json", ts));
    let body = serde_json::to_string_pretty(report)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
    fs::write(path, body)
}

pub fn list_review_summaries() -> std::io::Result<Vec<ReviewSummary>> {
    let dir = reviews_dir();
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut out: Vec<ReviewSummary> = Vec::new();
    for entry in fs::read_dir(&dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let ts = path
            .file_stem()
            .and_then(|s| s.to_str())
            .and_then(|s| s.parse::<i64>().ok())
            .unwrap_or(0);
        let body = match fs::read_to_string(&path) {
            Ok(b) => b,
            Err(_) => continue,
        };
        let v: serde_json::Value = match serde_json::from_str(&body) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let count_array = |key: &str| -> usize {
            v.get(key).and_then(|x| x.as_array()).map(|a| a.len()).unwrap_or(0)
        };
        out.push(ReviewSummary {
            ts,
            base_branch: v.get("base_branch").and_then(|x| x.as_str()).unwrap_or("").to_string(),
            total_changes: v.get("total_changes").and_then(|x| x.as_u64()).unwrap_or(0) as usize,
            risk_score: v.get("risk_score").and_then(|x| x.as_u64()).unwrap_or(0) as usize,
            risk_label: v.get("risk_label").and_then(|x| x.as_str()).unwrap_or("LOW").to_string(),
            invariant_violations: count_array("invariant_violations"),
            blast_radius: count_array("blast_radius"),
            cross_branch_conflicts: count_array("cross_branch_conflicts"),
            omni_graph_impact: count_array("omni_graph_impact"),
        });
    }
    out.sort_by(|a, b| b.ts.cmp(&a.ts));
    Ok(out)
}

pub fn read_review(ts: i64) -> std::io::Result<serde_json::Value> {
    let path = reviews_dir().join(format!("{}.json", ts));
    let body = fs::read_to_string(path)?;
    serde_json::from_str(&body).map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
}

// ── Policy packs ──────────────────────────────────────────────────────
//
// Driven from Settings → Repository → Security & policy, where seven packs
// each offered an `install` button and, once clicked, a `re-install` one.
// Both claims were made from React state seeded empty: a repo with every
// pack already merged showed seven `install` buttons, and closing the dialog
// forgot whatever had just been done. The packs now answer for themselves,
// which needs their rules to be data rather than arms of a match — and with
// the rules in one place the counts stop being hand-kept literals.
#[cfg(test)]
mod policy_pack_tests {
    use super::*;

    fn empty() -> InvariantRules {
        InvariantRules {
            forbidden_imports: vec![],
            forbidden_calls: vec![],
            layer_rules: vec![],
            protected_nodes: vec![],
        }
    }

    fn pack(id: &str) -> &'static Pack {
        PACKS.iter().find(|p| p.id == id).expect("pack exists")
    }

    #[test]
    fn every_pack_counts_the_rules_it_actually_carries() {
        // The numbers the library has always advertised, now derived. They
        // were seven literals sitting a hundred lines away from the rules
        // they described.
        for (id, want) in [
            ("security", 6),
            ("payments", 3),
            ("web-app", 3),
            ("owasp", 15),
            ("airbnb-js", 5),
            ("google-style", 5),
            ("pep-python", 7),
        ] {
            assert_eq!(pack(id).rules.count(), want, "{id}");
        }
    }

    #[test]
    fn a_pack_is_installed_only_once_all_of_it_is_there() {
        let mut rules = empty();
        assert!(!pack("payments").rules.contained_in(&rules));
        merge_pack(&mut rules, pack("payments"));
        assert!(pack("payments").rules.contained_in(&rules));
    }

    #[test]
    fn sharing_a_rule_with_another_pack_is_not_being_installed() {
        // `security` and `owasp` both ban `eval`. Any-overlap would have
        // marked owasp installed the moment security was.
        let mut rules = empty();
        merge_pack(&mut rules, pack("security"));
        assert!(rules.forbidden_calls.iter().any(|c| c == "eval"));
        assert!(!pack("owasp").rules.contained_in(&rules));
    }

    #[test]
    fn installing_twice_leaves_the_file_where_one_install_left_it() {
        // The bug: layer_rules was extended and never deduped, so the pane's
        // own `re-install` button grew production.aura.json every click.
        let mut once = empty();
        merge_pack(&mut once, pack("payments"));
        let mut twice = empty();
        merge_pack(&mut twice, pack("payments"));
        merge_pack(&mut twice, pack("payments"));
        assert_eq!(once.layer_rules, twice.layer_rules);
        assert_eq!(once.protected_nodes, twice.protected_nodes);
        assert_eq!(once.layer_rules.len(), 1);
    }

    #[test]
    fn packs_layer_rather_than_replace() {
        let mut rules = empty();
        merge_pack(&mut rules, pack("payments"));
        merge_pack(&mut rules, pack("web-app"));
        assert!(pack("payments").rules.contained_in(&rules));
        assert!(pack("web-app").rules.contained_in(&rules));
        assert_eq!(rules.layer_rules.len(), 2);
    }
}
