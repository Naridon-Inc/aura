// Thin Tauri bridge to `aura impact <symbol> <file> --json`.
//
// The engine (aura-cli) owns the whole computation — reverse call-graph blast
// radius (who depends on a symbol + which user-facing features ride on it) —
// and already emits a well-shaped JSON verdict. This command just runs it in
// the repo root and ferries the parsed verdict back, so the schema lives in
// exactly one place (the engine) and can't drift between Rust and TypeScript.
// The frontend's `SymbolImpact` type in `lib/api.ts` mirrors the same shape.
//
// Powers the "N things depend on this" pre-flight shown before a surgical
// Rewind, so the fallout is visible *before* the restore. Deterministic and
// cheap: no AI tokens, no network — the same reverse-BFS the delete-guard uses.

use std::path::PathBuf;
use std::process::Command;

/// Run `aura impact <symbol> <file> --json` in `repo_root` and return the
/// parsed verdict. `file` may be repo-relative or absolute (the CLI folds an
/// absolute path back to repo-relative). Returns the engine's JSON verbatim as
/// a `serde_json::Value`.
#[tauri::command]
pub async fn aura_symbol_impact(
    repo_root: String,
    symbol: String,
    file: String,
) -> Result<serde_json::Value, String> {
    crate::blocking::run(move || {
        let cwd = PathBuf::from(&repo_root);
        if !cwd.is_dir() {
            return Err(format!("repo root does not exist: {}", repo_root));
        }
        if symbol.trim().is_empty() {
            return Err("symbol is required".to_string());
        }
        if file.trim().is_empty() {
            return Err("file is required".to_string());
        }

        let out = Command::new(crate::agent_event_listener::resolve_aura_bin())
            .args(["impact", &symbol, &file, "--json"])
            .current_dir(&cwd)
            .output()
            .map_err(|e| format!("failed to spawn aura impact: {}", e))?;

        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr);
            return Err(format!(
                "aura impact exited with {}: {}",
                out.status.code().unwrap_or(-1),
                stderr.trim()
            ));
        }

        let stdout = String::from_utf8_lossy(&out.stdout);
        serde_json::from_str(&stdout)
            .map_err(|e| format!("failed to parse impact JSON: {}", e))
    })
    .await
}
