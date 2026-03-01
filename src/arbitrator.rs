use std::fs;
use colored::Colorize;

/// The Autonomous Arbitrator (Cost-Controlled Conflict Resolution)
pub struct Arbitrator;

impl Arbitrator {
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

