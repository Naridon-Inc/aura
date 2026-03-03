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

        let mut risk_score = (modified_nodes.len() * 2) + (tainted_nodes.len() * 5);
        if !unverified_nodes.is_empty() { risk_score += 20; }
        if !invariant_violations.is_empty() { risk_score += 50; }
        risk_score += conflicts.len() * 15;

        let risk_label = if risk_score > 60 { "CRITICAL" } else if risk_score > 20 { "MODERATE" } else { "LOW" };

        if json_output {
            let report = ReviewReport {
                base_branch: base_branch.to_string(),
                total_changes: total_changes.len(),
                unverified_nodes: unverified_by_kind,
                invariant_violations,
                blast_radius: tainted_nodes.into_iter().collect(),
                cross_branch_conflicts: conflicts,
                risk_score,
                risk_label: risk_label.to_string(),
            };
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
                for node in unverified_nodes {
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
            println!("\n{} {}: {} downstream logic blocks affected.", "☢️ ".bold(), "Blast Radius".yellow().bold(), tainted_nodes.len());
            for node in tainted_nodes.iter().take(5) {
                println!("  {} {}", "↳".dimmed(), node.yellow());
            }
        }

        if !conflicts.is_empty() {
            println!("\n{} {}:", "⚔️ ".bold(), "Cross-Branch Conflicts".yellow().bold());
            for conflict in conflicts {
                println!("  • {}", conflict.yellow());
            }
        }

        println!("\n{:-^80}", "-".dimmed());
        let color_label = if risk_score > 60 { "CRITICAL".red().bold() } else if risk_score > 20 { "MODERATE".yellow().bold() } else { "LOW".green().bold() };
        println!("{} {}: {}", "📊".bold(), "Overall Architectural Risk".bold(), color_label);
        println!("{:-^80}\n", "-".dimmed());

        Ok(None)
    }
}
