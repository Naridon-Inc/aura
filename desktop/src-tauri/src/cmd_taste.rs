//! Taste-rules surface — structured JSON for the `/taste` slash card.
//!
//! The Taste Engine (aura-cli `taste`) mines the project's learned coding
//! patterns — "Indent rust files with 4 spaces", "Prefer named imports", and
//! so on — into `.aura/taste/rules.json`. `aura taste list --json` already
//! emits the full `Rule[]` array (id, template, language, layer, statement,
//! confidence, positive/negative weight, status, user_approved, examples).
//!
//! This bridge runs that command in the repo root and ferries the parsed
//! array back verbatim as `serde_json::Value`, so the rule schema lives in
//! exactly one place (the engine) and can't drift between Rust and
//! TypeScript. The frontend's `TasteRule` type in `lib/api.ts` mirrors the
//! engine's `Rule` struct.
//!
//! Deterministic and cheap: reads a local JSON file, no AI tokens, no
//! network.

use std::path::PathBuf;

/// Run `aura taste list --json` in `repo_root` and return the parsed rule
/// array. Each element mirrors the engine's `Rule` struct. An empty repo
/// (no observations yet) yields an empty array, not an error.
#[tauri::command]
pub async fn aura_taste_rules(repo_root: String) -> Result<serde_json::Value, String> {
    let cwd = PathBuf::from(&repo_root);
    if !cwd.is_dir() {
        return Err(format!("repo root does not exist: {}", repo_root));
    }

    let out = tokio::process::Command::new("aura")
        .args(["taste", "list", "--json"])
        .current_dir(&cwd)
        .output()
        .await
        .map_err(|e| format!("failed to spawn aura taste list: {}", e))?;

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!(
            "aura taste list exited with {}: {}",
            out.status.code().unwrap_or(-1),
            stderr.trim()
        ));
    }

    let stdout = String::from_utf8_lossy(&out.stdout);
    serde_json::from_str(&stdout)
        .map_err(|e| format!("failed to parse taste rules JSON: {}", e))
}
