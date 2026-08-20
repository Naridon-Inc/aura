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
/// report. `sha` is anything `git revparse` understands — including a
/// `base...head` range, which is how a pull request is read as one change
/// (defaults to HEAD when empty). Returns the engine's JSON verbatim as a
/// `serde_json::Value`.
#[tauri::command]
pub async fn aura_change_note(
    repo_root: String,
    sha: Option<String>,
) -> Result<serde_json::Value, String> {
    crate::blocking::run(move || {
        let cwd = PathBuf::from(&repo_root);
        if !cwd.is_dir() {
            return Err(format!("repo root does not exist: {}", repo_root));
        }
        let sha = sha.filter(|s| !s.trim().is_empty()).unwrap_or_else(|| "HEAD".to_string());

        let out = Command::new(crate::agent_event_listener::resolve_aura_bin())
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
    })
    .await
}

/// Work out which `base...head` spelling this machine can actually resolve for
/// a pull request, so the change story can be computed for the whole range.
///
/// A pull request's detail carries branch NAMES, not shas, and which of those
/// exist locally depends on what has been fetched: a branch you are working on
/// is local, one you are only reviewing usually lives under `origin/`, and a
/// fork's head may not be here at all. Guessing wrong is expensive — a
/// change-note is a full AST diff plus a call-graph walk — so the candidates
/// are settled with `git rev-parse`, which costs milliseconds, before anything
/// pays for the real computation.
///
/// Returns the first spec whose endpoints both resolve and actually differ, or
/// `None` when this repository can't see both ends. `None` is a legitimate
/// answer, not an error: the caller then shows the diff without a story rather
/// than inventing one from a range that doesn't exist here.
#[tauri::command]
pub async fn resolve_pr_range(
    repo_root: String,
    base_ref: String,
    head_ref: String,
) -> Result<Option<String>, String> {
    crate::blocking::run(move || {
        let cwd = PathBuf::from(&repo_root);
        if !cwd.is_dir() {
            return Err(format!("repo root does not exist: {}", repo_root));
        }
        let (base_ref, head_ref) = (base_ref.trim(), head_ref.trim());
        if base_ref.is_empty() || head_ref.is_empty() {
            return Ok(None);
        }

        // Most-likely spellings first. A PR you are reviewing has both sides under
        // `origin/`; one you are building has both local; the mixed forms cover a
        // branch pushed but not yet fetched back, and vice versa.
        let candidates = [
            (format!("origin/{base_ref}"), format!("origin/{head_ref}")),
            (base_ref.to_string(), head_ref.to_string()),
            (format!("origin/{base_ref}"), head_ref.to_string()),
            (base_ref.to_string(), format!("origin/{head_ref}")),
        ];
        for (base, head) in candidates {
            let (Some(base_sha), Some(head_sha)) =
                (resolve_commit(&cwd, &base), resolve_commit(&cwd, &head))
            else {
                continue;
            };
            // Both ends exist but name the same commit — nothing to describe, and
            // whichever spelling comes next may be the real one.
            if base_sha == head_sha {
                continue;
            }
            return Ok(Some(format!("{base}...{head}")));
        }
        Ok(None)
    })
    .await
}

/// The commit a ref names, or `None` when this repository doesn't have it.
/// `^{commit}` makes an annotated tag or a branch resolve to the same thing.
fn resolve_commit(cwd: &PathBuf, git_ref: &str) -> Option<String> {
    let out = Command::new("git")
        .args([
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("{git_ref}^{{commit}}"),
        ])
        .current_dir(cwd)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let sha = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if sha.is_empty() {
        None
    } else {
        Some(sha)
    }
}
