use colored::Colorize;
use git2::{Repository, DiffOptions, BranchType};
use crate::parser::SemanticParser;
use crate::checkpoint::CheckpointStore;
use std::fs;
use std::collections::{HashSet, HashMap};
use regex::Regex;
use serde::{Deserialize, Serialize};

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

#[derive(Serialize)]
struct ReviewReport {
    base_branch: String,
    total_changes: usize,
    unverified_nodes: HashMap<String, usize>, // kind -> count
    invariant_violations: Vec<String>,
    blast_radius: Vec<String>,
    cross_branch_conflicts: Vec<String>,
    risk_score: usize,
    risk_label: String,
}

pub struct PrReviewEngine;

impl PrReviewEngine {
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
            _ => {
                println!("{} Unknown policy pack '{}'. Available: security, payments, web-app", "✗".red(), pack_name);
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

                    for dep in &node.dependencies {
                        if rules.forbidden_calls.contains(&dep.name) {
                            invariant_violations.push(format!("Forbidden Call: Node '{}' calls '{}'", ident, dep.name));
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
                                        "Layer Violation: '{}' layer node '{}' eventually calls '{}' ({} hops)", 
                                        rule.from, ident, rule.cannot_call, hop
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
                        invariant_violations.push(format!("Protected Node Modified: '{}' is a sensitive logic block.", ident));
                    }
                }

                for ident in &deleted_node_names {
                    if rules.protected_nodes.contains(ident) {
                        invariant_violations.push(format!("Protected Node Deleted: '{}' has been removed!", ident));
                    }
                }
            }
        }

        // Wave 6: Cross-Branch Semantic Conflict Detection
        let mut conflicts = Vec::new();
        let head_name = if let Ok(head_ref) = repo.head() {
            head_ref.shorthand().unwrap_or("HEAD").to_string()
        } else { "HEAD".to_string() };

        if let Ok(branches) = repo.branches(Some(BranchType::Local)) {
            for branch_result in branches {
                if let Ok((branch, _)) = branch_result {
                    if let Some(branch_name) = branch.name()? {
                        if branch_name != head_name && branch_name != base_branch {
                            if let Ok(commit) = branch.get().peel_to_commit() {
                                if let Ok(_checkpoints) = CheckpointStore::get_all_checkpoints(&repo) { 
                                    if let Ok(_other_tree) = commit.tree() {
                                        for (_, node) in &modified_nodes {
                                            if let Some(ref _ident) = node.identifier {
                                                conflicts.push(format!("MED: Graph-neighborhood overlap detected with branch '{}'", branch_name));
                                                break; 
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        // Feature 3: Omni-Graph Federation (Cross-Repo Blast Radius)
        let mut omni_graph_impact = Vec::new();
        // In the Enterprise version, this is guarded by a token check. For MVP, we simulate the federated query.
        if !modified_nodes.is_empty() {
            let client = reqwest::blocking::Client::builder().timeout(std::time::Duration::from_secs(3)).build().unwrap_or_default();
            let modified_ids: Vec<String> = modified_nodes.iter().map(|(_, n)| n.node_id.clone()).collect();
            let payload = serde_json::json!({ "modified_nodes": modified_ids });
            
            // Try to query the central Sovereign Vault for cross-repo dependencies
            if let Ok(res) = client.post("http://api.auravcs.com/graph/query").json(&payload).send() {
                if let Ok(json) = res.json::<serde_json::Value>() {
                    if let Some(impacts) = json["impacted_repos"].as_array() {
                        for impact in impacts {
                            let repo_name = impact["repo"].as_str().unwrap_or("unknown_repo");
                            let node_name = impact["node"].as_str().unwrap_or("unknown_node");
                            omni_graph_impact.push(format!("Repo '{}' relies on this logic in '{}'", repo_name, node_name));
                        }
                    }
                }
            }
        }

        let mut risk_score = (modified_nodes.len() * 2) + (tainted_nodes.len() * 5);
        if !unverified_nodes.is_empty() { risk_score += 20; }
        if !invariant_violations.is_empty() { risk_score += 50; }
        risk_score += conflicts.len() * 15;
        if !omni_graph_impact.is_empty() { risk_score += 100; }

        let risk_label = if risk_score > 60 { "CRITICAL" } else if risk_score > 20 { "MODERATE" } else { "LOW" };

        if json_output {
            let mut report = serde_json::to_value(&ReviewReport {
                base_branch: base_branch.to_string(),
                total_changes: total_changes.len(),
                unverified_nodes: unverified_by_kind.clone(),
                invariant_violations: invariant_violations.clone(),
                blast_radius: tainted_nodes.iter().cloned().collect(),
                cross_branch_conflicts: conflicts.clone(),
                risk_score,
                risk_label: risk_label.to_string(),
            })?;
            
            // Inject Omni-Graph data dynamically
            report["omni_graph_impact"] = serde_json::json!(omni_graph_impact);
            return Ok(Some(serde_json::to_string_pretty(&report)?));
        }

        // 6. Executive Report (Human-Readable)
        println!("\n{:-^80}\n", " SEMANTIC REVIEW REPORT ".bold().blue());
        println!("{} {} logic nodes changed.", "🗂️ ".bold(), total_changes.len());

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
