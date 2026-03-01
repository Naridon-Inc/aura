use crate::models::StateNode;
use git2::{Commit, Repository, Signature};
use std::path::Path;

pub struct GitExporter;

impl GitExporter {
    /// Translates the chaotic, high-frequency Aura semantic DAG into a single, 
    /// clean Git commit for human coworkers.
    pub fn export_to_git(states: &[(String, StateNode)]) -> Result<(), git2::Error> {
        if states.is_empty() {
            println!("No semantic history to export.");
            return Ok(());
        }

        // 1. Open or initialize the standard Git repository (The Trojan Horse)
        let repo_path = Path::new(".");
        let repo = match Repository::open(repo_path) {
            Ok(repo) => repo,
            Err(_) => {
                println!("[Aura Git-Bridge] Initializing new shadow .git repository...");
                Repository::init(repo_path)?
            }
        };

        // 2. Stage the current state of the workspace (where the AI's final code lives)
        let mut index = repo.index()?;
        index.add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None)?;
        index.write()?;

        let oid = index.write_tree()?;
        let signature = Signature::now("Aura Agent Orchestrator", "ai@aura.vcs")?;

        // 3. The "LLM Summarizer" step.
        // In a full implementation, we pass the 50 `intent.description` strings from the 
        // `states` vector to an LLM (like Gemini) to generate one cohesive PR summary.
        // For the MVP, we aggregate them programmatically.
        let mut squashed_message = String::from("Agentic Refactor: Automated Synthesis

");
        squashed_message.push_str("This commit is a translation of 50+ micro-semantic states.
");
        squashed_message.push_str("Key Intents Executed:
");
        
        for (_, state) in states.iter().take(3) { // Take top 3 for brevity
            squashed_message.push_str(&format!("- {}
", state.intent.description));
        }

        let tree = repo.find_tree(oid)?;

        // 4. Find the parent commit if this isn't the first export
        let parent_commit = Self::find_last_commit(&repo);
        let mut parents = Vec::new();
        if let Some(ref parent) = parent_commit {
            parents.push(parent);
        }

        // 5. Create the standard Git commit
        let commit_id = repo.commit(
            Some("HEAD"),
            &signature,
            &signature,
            &squashed_message,
            &tree,
            &parents,
        )?;

        println!("✓ Shadow .git commit created successfully!");
        println!("  Git SHA: {}", commit_id);
        println!("  You can now safely run `git push origin main`");

        Ok(())
    }

    fn find_last_commit(repo: &Repository) -> Option<Commit> {
        let head = repo.head().ok()?;
        let target = head.target()?;
        repo.find_commit(target).ok()
    }
}
