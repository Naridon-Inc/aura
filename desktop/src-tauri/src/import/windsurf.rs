//! Windsurf.
//!
//! Verified against a real install:
//!
//! * `~/Library/Application Support/Windsurf/User/workspaceStorage` — the
//!   folders it opened (the VS Code layout, see [`vscode_folders`]).
//! * `~/.codeium/windsurf/` — `mcp_config.json` (MCP servers, read by Aura's
//!   existing discovery), `memories/global_rules.md` (rules for every
//!   project), and `cascade/*.pb` — the agent's conversations, which are
//!   encrypted and can't be read outside Windsurf.
//!
//! So Windsurf brings over its repos, each repo's rule files
//! (`.windsurfrules`, …) and its MCP servers; its chats stay behind, and the
//! scan says so with a count.

use std::path::{Path, PathBuf};

use super::{mcp_items, path_str, repo_item, rules_item, tilde, vscode_folders, Ctx, Plan, Scanned};

pub const ID: &str = "windsurf";

fn codeium_dir(home: &Path) -> PathBuf {
    home.join(".codeium").join("windsurf")
}

fn user_dir(home: &Path) -> PathBuf {
    vscode_folders::user_dir(home, "Windsurf")
}

pub fn found(home: &Path) -> bool {
    codeium_dir(home).is_dir() || user_dir(home).is_dir()
}

pub fn scan(ctx: &Ctx, out: &mut Scanned) {
    let folders = vscode_folders::folders(&user_dir(&ctx.home));
    let roots: Vec<PathBuf> = folders.iter().filter(|f| f.is_git).map(|f| f.path.clone()).collect();
    for path in &roots {
        out.push(
            repo_item(ctx, format!("repo:{}", path_str(path)), path, None, tilde(&ctx.home, path)),
            Plan::Repo { root: path.clone() },
        );
        if let Some(item) = rules_item(ctx, ID, path) {
            out.push(item, Plan::Rules { root: path.clone() });
        }
    }
    mcp_items(out, &["Windsurf"], &roots);

    let cascade = std::fs::read_dir(codeium_dir(&ctx.home).join("cascade"))
        .map(|d| {
            d.filter_map(|e| e.ok())
                .filter(|e| e.path().extension().is_some_and(|x| x == "pb"))
                .count()
        })
        .unwrap_or(0);
    if cascade > 0 {
        out.note(format!(
            "Windsurf keeps its {cascade} {} encrypted, so {} stay in Windsurf.",
            if cascade == 1 { "conversation" } else { "conversations" },
            if cascade == 1 { "it has to" } else { "they have to" }
        ));
    }
    let global_rules = codeium_dir(&ctx.home).join("memories").join("global_rules.md");
    if std::fs::metadata(&global_rules).map(|m| m.len() > 0).unwrap_or(false) {
        out.note(format!(
            "Windsurf's rules for every project are in {}. Aura's rules live with each repo, so copy what you still want into a repo's AGENTS.md.",
            tilde(&ctx.home, &global_rules)
        ));
    }
    let gone = folders.iter().filter(|f| !f.exists).count();
    if gone > 0 {
        out.note(format!(
            "{gone} {} Windsurf opened {} no longer on this Mac.",
            if gone == 1 { "folder" } else { "folders" },
            if gone == 1 { "is" } else { "are" }
        ));
    }
}
