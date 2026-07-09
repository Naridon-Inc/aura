// Thin Tauri bridge to `aura change-note <sha> --json`.
//
// The engine (aura-cli) owns the whole computation — AST diff + reverse
// call-graph blast radius — and already emits a well-shaped JSON report. This
// command just runs it in the repo root and ferries the parsed report back, so
// the change-note schema lives in exactly one place (the engine) and can't
// drift between Rust and TypeScript. The frontend's `ChangeNoteReport` type in
// `lib/api.ts` mirrors the same shape.
//
// Deterministic and cheap: no AI tokens, no network. A generous timeout guards
// against a pathological graph walk hanging the IPC channel.

use std::path::PathBuf;
use std::process::Command;

/// Run `aura change-note <sha> --json` in `repo_root` and return the parsed
/// report. `sha` is anything `git revparse` understands (defaults to HEAD when
/// empty). Returns the engine's JSON verbatim as a `serde_json::Value`.
#[tauri::command]
pub async fn aura_change_note(
    repo_root: String,
    sha: Option<String>,
) -> Result<serde_json::Value, String> {
    let cwd = PathBuf::from(&repo_root);
    if !cwd.is_dir() {
        return Err(format!("repo root does not exist: {}", repo_root));
    }
    let sha = sha.filter(|s| !s.trim().is_empty()).unwrap_or_else(|| "HEAD".to_string());

    let out = Command::new("aura")
        .args(["change-note", &sha, "--json"])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("failed to spawn aura change-note: {}", e))?;

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!(
            "aura change-note exited with {}: {}",
            out.status.code().unwrap_or(-1),
            stderr.trim()
        ));
    }

    let stdout = String::from_utf8_lossy(&out.stdout);
    serde_json::from_str(&stdout)
        .map_err(|e| format!("failed to parse change-note JSON: {}", e))
}
