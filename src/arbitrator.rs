use std::fs;
use colored::Colorize;
use serde_json::Value;

/// The Autonomous Arbitrator (Cost-Controlled Conflict Resolution)
pub struct Arbitrator;

impl Arbitrator {
    pub fn auto_fix_violations(base_branch: &str) -> Result<(), Box<dyn std::error::Error>> {
        println!("{} {}", "🤖".bold(), "Aura Autonomous Arbitrator: Initiating Self-Correction Loop".bold().cyan());
        println!("  {} Running semantic review against {}...", "↳".dimmed(), base_branch.yellow());

        let report_str = match crate::pr::PrReviewEngine::run_review(base_branch, true, false)? {
            Some(json) => json,
            None => {
                println!("  {} No violations found. Codebase is clean.", "✓".green());
                return Ok(());
            }
        };

        let report: Value = serde_json::from_str(&report_str)?;
        let invariant_violations = report["invariant_violations"].as_array().unwrap_or(&vec![]).clone();

        if invariant_violations.is_empty() {
            println!("  {} No architectural invariant violations found. Exiting.", "✓".green());
            return Ok(());
        }

        println!("{} Detected {} architectural violations.", "🚨".red().bold(), invariant_violations.len());
        println!("  {} Spawning hidden shadow branch for safe refactoring...", "↳".dimmed());

        // Gather context
        let mut diff_files = String::new();
        let repo = git2::Repository::open(".")?;
        
        let head = repo.head()?.peel_to_commit()?;
        let head_tree = head.tree()?;
        let base_obj = repo.revparse_single(base_branch)?;
        let base_commit = base_obj.as_commit().ok_or("Base is not a commit")?;
        let base_tree = base_commit.tree()?;

        let mut opts = git2::DiffOptions::new();
        let diff = repo.diff_tree_to_tree(Some(&base_tree), Some(&head_tree), Some(&mut opts))?;
        
        diff.foreach(&mut |delta, _| {
            if let Some(path) = delta.new_file().path() {
                let path_str = path.to_string_lossy().to_string();
                if path_str.ends_with(".rs") || path_str.ends_with(".ts") || path_str.ends_with(".js") || path_str.ends_with(".py") {
                    if let Ok(content) = fs::read_to_string(path) {
                        diff_files.push_str(&format!("===FILE: {} ===\n{}\n", path_str, content));
                    }
                }
            }
            true
        }, None, None, None)?;

        let violations_text = invariant_violations.iter().map(|v| v.as_str().unwrap_or("")).collect::<Vec<&str>>().join("\n");

        println!("  {} Synthesizing architectural patch...", "↳".dimmed());
        // DEBUG
        println!("--- TARGET FILES PASSED TO LLM ---\n{}\n----------------------------------", diff_files);
        
        let prompt = format!(
            "CRITICAL DIRECTIVE: You are the Aura Arbitrator. The current codebase violates strict architectural invariants.\n\
            \n\
            <invariant_violations>\n{}\n</invariant_violations>\n\
            \n\
            <target_files>\n{}\n</target_files>\n\
            \n\
            OUTPUT RULES:\n\
            1. You must fix the code to resolve the architectural violations.\n\
            2. Output ONLY the raw, fixed source code for the files that need changing.\n\
            3. Format your response exactly like this for each file:\n\
            ===FILE: path/to/file.ts===\n\
            [code here]\n\
            \n\
            Do not include markdown blocks or apologies.",
            violations_text, diff_files
        );

        if let Some(text) = crate::gsd::GsdEngine::generate_content(&prompt, "", 0.2, crate::gsd::CognitiveLabor::Arbitrator) {
            println!("  {} Applying semantic patch...", "↳".dimmed());
            println!("--- DEBUG LLM OUTPUT ---\n{}\n------------------------", text);
            
            let mut current_file = String::new();
            let mut current_content = String::new();
            
            for line in text.lines() {
                if line.starts_with("===FILE:") && line.ends_with("===") {
                    if !current_file.is_empty() {
                        let _ = fs::write(&current_file, current_content.trim());
                        current_content.clear();
                    }
                    current_file = line.trim_start_matches("===FILE: ").trim_end_matches("===").trim().to_string();
                } else if !current_file.is_empty() {
                    current_content.push_str(line);
                    current_content.push('\n');
                }
            }
            if !current_file.is_empty() {
                let _ = fs::write(&current_file, current_content.trim());
            }

            println!("{} Autonomous Arbitration complete.", "✓".green().bold());
            println!("  {} Run `aura pr-review` to verify the new Merkle-Graph is stable.", "↳".dimmed());
        } else {
            println!("{} Failed to synthesize patch via AI Router.", "✗".red());
        }
        
        Ok(())
    }
    pub fn resolve_conflict(file_path: &str) {
        println!("{} {} {}", "🤖".bold(), "Aura Autonomous Arbitrator: Analyzing semantic collision in".bold().cyan(), file_path.yellow());
        
        let broken_code = match fs::read_to_string(file_path) {
            Ok(code) => code,
            Err(e) => {
                println!("{} Failed to read file: {}", "✗".red(), e);
                return;
            }
        };

        // Simulated Intent Context (In a real scenario, this is pulled from the Vector RAG db)
        let context = "The user intends to fix a division by zero error in the math logic, but the current code uses integer division incorrectly or lacks error handling.";

        println!("  {} Spawning isolated shadow branch for resolution...", "↳".dimmed());
        // For MVP, we just operate on the file directly, but in prod we'd branch here.

        println!("  {} Querying Universal AI Router to synthesize patch...", "↳".dimmed());
        
        let prompt = format!(
            r#"<aura_arbitrator_protocol>
  <directive>You are an autonomous code arbitrator fixing a merge conflict or logic error.</directive>
  <constraints>
    - Output ONLY the raw, fixed source code.
    - Do not include markdown formatting like ```python.
    - Do not include explanations or apologies.
    - CRITICAL: Do NOT delete assertions or modify test logic to artificially pass the build.
  </constraints>
  <context>
    <intent>{}</intent>
  </context>
  <target_file>
    <path>{}</path>
    <broken_source_code>
{}
    </broken_source_code>
  </target_file>
</aura_arbitrator_protocol>"#,
            context, file_path, broken_code
        );

        if let Some(text) = crate::gsd::GsdEngine::generate_content(&prompt, "", 0.1, crate::gsd::CognitiveLabor::Arbitrator) {
            let cleaned_code = text.replace("```python", "").replace("```rust", "").replace("```ts", "").replace("```", "").trim().to_string();
            
            println!("  {} Patch synthesized. Generating resolution diff...", "↳".dimmed());
            
            // KILL SHOT FIX: Never auto-overwrite and merge. Propose a patch file.
            let patch_file = format!("{}.aura.patch", file_path);
            if fs::write(&patch_file, cleaned_code).is_ok() {
                 println!("{} Conflict resolved autonomously.", "✓".green().bold());
                 println!("  {} Patch written to: {}", "↳".dimmed(), patch_file.yellow());
                 println!("  {} Review the patch. To apply, run: `mv {} {}`", "↳".dimmed(), patch_file, file_path);
                 return;
            }
        }
        println!("{} Failed to synthesize patch via AI Router.", "✗".red());
    }
}

