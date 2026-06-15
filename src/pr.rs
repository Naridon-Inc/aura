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

#[derive(Debug, Serialize, Deserialize, Clone)]
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
    pub fn list_policy_packs() -> Vec<PackDescriptor> {
        vec![
            PackDescriptor {
                id: "security",
                label: "Security baseline",
                description: "Block eval/unsafe_exec; protect authenticate, verify_token, hash_password.",
                rule_count: 6,
                category: "security",
            },
            PackDescriptor {
                id: "payments",
                label: "PCI / payments isolation",
                description: "UI cannot call Stripe directly; protect process_payment, issue_refund.",
                rule_count: 3,
                category: "compliance",
            },
            PackDescriptor {
                id: "web-app",
                label: "Web app layering",
                description: "Components cannot call DB or filesystem; bans fs and child_process imports.",
                rule_count: 3,
                category: "architecture",
            },
            PackDescriptor {
                id: "owasp",
                label: "OWASP Top-10",
                description: "Block unsafe deserialization (pickle/yaml.load), XSS sinks (innerHTML), and protect auth/crypto nodes.",
                rule_count: 15,
                category: "security",
            },
            PackDescriptor {
                id: "airbnb-js",
                label: "Airbnb JS style",
                description: "Discourage lodash/moment/underscore; ban fetch/axios calls inside components/.",
                rule_count: 5,
                category: "style",
            },
            PackDescriptor {
                id: "google-style",
                label: "Google style guide",
                description: "Enforce api/internal isolation, public/private boundary, and ban blocking sleep calls.",
                rule_count: 5,
                category: "architecture",
            },
            PackDescriptor {
                id: "pep-python",
                label: "PEP Python",
                description: "Block deprecated imp/__future__/execfile; protect __init__, __del__, main.",
                rule_count: 7,
                category: "style",
            },
        ]
    }

    pub fn add_policy_pack(pack_name: &str) -> Result<(), Box<dyn std::error::Error>> {
        println!("{} {} {}", "📦".bold(), "Aura Policy Marketplace: Installing".bold().cyan(), pack_name.yellow());

        let mut rules = if let Ok(json) = fs::read_to_string("production.aura.json") {
            serde_json::from_str::<InvariantRules>(&json).unwrap_or_else(|_| InvariantRules {
                forbidden_imports: vec![],
                forbidden_calls: vec![],
                layer_rules: vec![],
                protected_nodes: vec![],
            })
        } else {
            InvariantRules {
                forbidden_imports: vec![],
                forbidden_calls: vec![],
                layer_rules: vec![],
                protected_nodes: vec![],
            }
        };

        match pack_name.to_lowercase().as_str() {
            "security" => {
                rules.forbidden_calls.extend(vec!["eval".to_string(), "unsafe_exec".to_string(), "child_process.exec".to_string()]);
                rules.protected_nodes.extend(vec!["authenticate".to_string(), "verify_token".to_string(), "hash_password".to_string()]);
                println!("  {} Enforcing strict execution limits and auth node protection.", "↳".dimmed());
            }
            "payments" => {
                rules.layer_rules.push(LayerRule { from: "ui".to_string(), cannot_call: "stripe".to_string() });
                rules.protected_nodes.extend(vec!["process_payment".to_string(), "issue_refund".to_string()]);
                println!("  {} Enforcing PCI isolation (UI cannot call Stripe directly).", "↳".dimmed());
            }
            "web-app" => {
                rules.layer_rules.push(LayerRule { from: "components".to_string(), cannot_call: "database".to_string() });
                rules.forbidden_imports.extend(vec!["fs".to_string(), "child_process".to_string()]);
                println!("  {} Enforcing client-server separation (Components cannot call DB or FS).", "↳".dimmed());
            }
            "owasp" => {
                rules.forbidden_calls.extend(vec![
                    "eval".to_string(),
                    "exec".to_string(),
                    "system".to_string(),
                    "deserialize".to_string(),
                    "pickle.loads".to_string(),
                    "yaml.load".to_string(),
                    "innerHTML".to_string(),
                    "dangerouslySetInnerHTML".to_string(),
                ]);
                rules.protected_nodes.extend(vec![
                    "authenticate".to_string(),
                    "authorize".to_string(),
                    "sanitize_input".to_string(),
                    "csrf_token".to_string(),
                    "verify_signature".to_string(),
                    "encrypt".to_string(),
                    "decrypt".to_string(),
                ]);
                println!("  {} OWASP Top-10: blocking unsafe deserialization, XSS sinks, and protecting auth/crypto nodes.", "↳".dimmed());
            }
            "airbnb-js" => {
                rules.forbidden_imports.extend(vec![
                    "lodash".to_string(),
                    "underscore".to_string(),
                    "moment".to_string(),
                ]);
                rules.layer_rules.push(LayerRule { from: "components".to_string(), cannot_call: "fetch".to_string() });
                rules.layer_rules.push(LayerRule { from: "components".to_string(), cannot_call: "axios".to_string() });
                println!("  {} Airbnb JS: nudging away from deprecated utility libs and direct fetch in components.", "↳".dimmed());
            }
            "google-style" => {
                rules.layer_rules.push(LayerRule { from: "api".to_string(), cannot_call: "internal".to_string() });
                rules.layer_rules.push(LayerRule { from: "public".to_string(), cannot_call: "private".to_string() });
                rules.forbidden_calls.extend(vec![
                    "sleep".to_string(),
                    "time.sleep".to_string(),
                    "Thread.sleep".to_string(),
                ]);
                println!("  {} Google style: enforcing api/internal isolation and banning blocking sleeps.", "↳".dimmed());
            }
            "pep-python" => {
                rules.forbidden_imports.extend(vec![
                    "imp".to_string(),
                    "__future__".to_string(),
                ]);
                rules.forbidden_calls.extend(vec![
                    "compile".to_string(),
                    "execfile".to_string(),
                ]);
                rules.protected_nodes.extend(vec![
                    "__init__".to_string(),
                    "__del__".to_string(),
                    "main".to_string(),
                ]);
                println!("  {} PEP Python: blocking deprecated dynamic exec and protecting module entry points.", "↳".dimmed());
            }
            _ => {
                println!("{} Unknown policy pack '{}'. Available: security, payments, web-app, owasp, airbnb-js, google-style, pep-python", "✗".red(), pack_name);
                println!("  {} Run {} for full descriptions.", "↳".dimmed(), "aura policy list".cyan());
                return Ok(());
            }
        }

        // Deduplicate
        rules.forbidden_calls.sort(); rules.forbidden_calls.dedup();
        rules.forbidden_imports.sort(); rules.forbidden_imports.dedup();
        rules.protected_nodes.sort(); rules.protected_nodes.dedup();

        let updated_json = serde_json::to_string_pretty(&rules)?;
        fs::write("production.aura.json", updated_json)?;
        
        println!("{} Policy Pack '{}' merged into production.aura.json successfully.", "✓".green().bold(), pack_name);
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
        
        if let Ok(checkpoints) = CheckpointStore::get_all_checkpoints(&repo) {
            if let Some(latest) = checkpoints.first() {
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
        }

        // 4. Wave 4: Blast Radius Analysis
        let mut tainted_nodes = HashSet::new();
        let mut modified_names = Vec::new();
        for (_, node) in &modified_nodes {
            if let Some(ref ident) = node.identifier {
                modified_names.push(ident.clone());
            }
        }

        if let Ok(checkpoints) = CheckpointStore::get_all_checkpoints(&repo) {
            if let Some(latest) = checkpoints.first() {
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

                                if let Ok(checkpoints) = CheckpointStore::get_all_checkpoints(&repo) {
                                    if let Some(latest) = checkpoints.first() {
                                        if let Some(graph_node) = latest.ast_nodes.iter().find(|n| n.identifier.as_ref() == Some(&current_dep.name)) {
                                            for next_dep in &graph_node.dependencies { queue.push((next_dep.clone(), hop + 1)); }
                                        }
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
        let latest_cp = CheckpointStore::get_all_checkpoints(&repo)
            .ok()
            .and_then(|c| c.into_iter().next());
        let cp_fallback = latest_cp
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
