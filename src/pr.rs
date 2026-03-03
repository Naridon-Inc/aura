use colored::Colorize;
use git2::{Repository, DiffOptions};
use crate::parser::SemanticParser;
use crate::models::AstNode;
use std::fs;
use std::path::Path;

pub struct PrReviewEngine;

impl PrReviewEngine {
    pub fn run_review(base_branch: &str) -> Result<(), Box<dyn std::error::Error>> {
        println!("\n{} {} {}", "🔍".bold(), "Aura Semantic PR Review:".bold().cyan(), base_branch.yellow());
        println!("  {} Comparing current HEAD against {}...", "↳".dimmed(), base_branch);

        let repo = Repository::open(".")?;

        // 1. Get trees for both sides
        let head = repo.head()?.peel_to_commit()?;
        let head_tree = head.tree()?;

        let base_obj = repo.revparse_single(base_branch)?;
        let base_commit = base_obj.as_commit().ok_or("Base is not a commit")?;
        let base_tree = base_commit.tree()?;

        // 2. Find changed files
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
            println!("{} No changes detected between branches.", "✓".green());
            return Ok(());
        }

        println!("  {} Detected {} changed files. Parsing ASTs...", "↳".dimmed(), changed_files.len());

        let mut parser = SemanticParser::new()?;
        let mut total_changes = Vec::new();

        for path in changed_files {
            let path_str = path.to_string_lossy();
            let ext = match path.extension().and_then(|s| s.to_str()) {
                Some("rs") => "rs",
                Some("py") => "py",
                Some("ts") | Some("tsx") => "ts",
                Some("js") | Some("jsx") => "js",
                _ => continue,
            };

            // Get new version from disk (or HEAD)
            let new_source = fs::read_to_string(&path)?;
            let new_nodes = parser.parse_file(&new_source, ext)?;

            // Get old version from base tree
            let old_nodes = if let Ok(entry) = base_tree.get_path(&path) {
                let obj = entry.to_object(&repo)?;
                let blob = obj.as_blob().ok_or("Not a blob")?;
                let old_source = std::str::from_utf8(blob.content())?;
                parser.parse_file(old_source, ext)?
            } else {
                Vec::new() // New file
            };

            let file_diff = SemanticParser::diff_nodes(&old_nodes, &new_nodes);
            for (ident, action) in file_diff {
                total_changes.push((path_str.to_string(), ident, action));
            }
        }

        // 3. Output Report
        if total_changes.is_empty() {
            println!("{} No logical changes detected (only whitespace/comments).", "✓".green());
        } else {
            println!("\n{:-^80}\n", " SEMANTIC CHANGE LOG ".bold().blue());
            for (file, ident, action) in total_changes {
                let color_action = match action.as_str() {
                    "added" => action.green(),
                    "modified" => action.yellow(),
                    "deleted" => action.red(),
                    _ => action.white(),
                };
                println!("  {} {:width$} -> {} {}", "•".blue(), ident.bold().white(), color_action, format!("({})", file).dimmed(), width = 25);
            }
            println!("\n{:-^80}\n", "-".dimmed());
        }

        Ok(())
    }
}
