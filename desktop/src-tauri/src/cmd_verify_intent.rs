//! The staged intent gate, as the app sees it.
//!
//! Until now the desktop app's pre-commit warning was a heuristic: it counted
//! edited files that had no matching intent note and said "these changes don't
//! have a note yet". That is a different claim from the one the product makes.
//! "Missing a note" is about paperwork; "what you asked for and what the agent
//! did disagree" is about behaviour, and only the second one can tell you a
//! function your settlement worker depends on just disappeared.
//!
//! These commands are a thin, honest bridge to `aura verify-intent --staged`,
//! which does the real comparison — approved baseline tree against the git
//! index, symbol by symbol. The app renders that verdict verbatim. It does not
//! compute its own opinion, and when there is no approved contract it says so
//! rather than inventing a reason to interrupt.
//!
//! Every call shells the same binary the pre-commit hook runs, so the dialog
//! and the hook can never disagree about whether a commit is allowed.

use std::process::Command;

use crate::agent_event_listener::resolve_aura_bin;

/// Run `aura` in `repo_root` and hand back parsed JSON from stdout.
///
/// A non-zero exit is expected and meaningful here — the gate exits 1 when it
/// blocks — so the exit status is deliberately ignored in favour of the JSON
/// body. Only a failure to spawn, or output that isn't JSON, is an error.
fn aura_json(repo_root: &str, args: &[&str]) -> Result<serde_json::Value, String> {
    let bin = resolve_aura_bin();
    let out = Command::new(&bin)
        .args(args)
        .current_dir(repo_root)
        .output()
        .map_err(|e| format!("could not run {bin}: {e}"))?;

    let stdout = String::from_utf8_lossy(&out.stdout);
    if stdout.trim().is_empty() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(if stderr.trim().is_empty() {
            format!("`aura {}` returned nothing", args.join(" "))
        } else {
            stderr.trim().to_string()
        });
    }

    serde_json::from_str(stdout.trim())
        .map_err(|e| format!("could not read the result of `aura {}`: {e}", args.join(" ")))
}

/// Compare the staged change against the approved contract.
///
/// Returns `null` when the repository has no approved intent — the caller must
/// treat that as "nothing to verify against" and let the commit through, not as
/// a failure. Holding up a commit in a repo nobody armed would make the gate
/// something people switch off.
#[tauri::command]
pub async fn verify_intent_staged(repo_root: String) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        match aura_json(&repo_root, &["verify-intent", "--staged", "--json"]) {
            Ok(v) => Ok(v),
            // The gate prints a bare `null` and exits 0 when no contract
            // exists; older builds printed nothing at all. Both mean the same
            // thing, and neither is an error worth showing a person.
            Err(e) if e.contains("returned nothing") => Ok(serde_json::Value::Null),
            Err(e) => Err(e),
        }
    })
    .await
    .map_err(|e| format!("verification did not finish: {e}"))?
}

/// The approved contract itself — what the agent was authorised to change.
///
/// `null` when nothing has been approved for this repository.
#[tauri::command]
pub async fn intent_contract_show(repo_root: String) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        match aura_json(&repo_root, &["intent-contract", "show", "--json"]) {
            Ok(v) => Ok(v),
            Err(e) if e.contains("returned nothing") => Ok(serde_json::Value::Null),
            Err(e) => Err(e),
        }
    })
    .await
    .map_err(|e| format!("could not read the approved intent: {e}"))?
}

/// Put one deleted symbol back from the approved baseline and re-verify.
///
/// Deliberately narrow: it restores the named function and stages it, leaving
/// every other edit the agent made in place. The whole point is that the
/// cleanup you asked for survives while the deletion you did not ask for does
/// not — a `git checkout` of the file would throw away both.
#[tauri::command]
pub async fn restore_deleted_symbol(
    repo_root: String,
    symbol: String,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        aura_json(&repo_root, &["restore-symbol", &symbol, "--json"])
    })
    .await
    .map_err(|e| format!("the restore did not finish: {e}"))?
}

/// The test result somebody actually recorded, if anybody did.
///
/// Deliberately not a test runner. `.aura/test_result.json` is written by
/// whoever ran the suite, and this only reads it back. When the file is absent
/// the answer is `null` and the dialog omits the line — a verification screen
/// that printed a green test count nobody observed would be the exact kind of
/// claim this whole feature exists to stop.
#[tauri::command]
pub async fn recorded_test_summary(repo_root: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = std::path::Path::new(&repo_root)
            .join(".aura")
            .join("test_result.json");
        let Ok(raw) = std::fs::read_to_string(path) else {
            return Ok(None);
        };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) else {
            return Ok(None);
        };
        Ok(value
            .get("summary")
            .and_then(|s| s.as_str())
            .map(str::to_string))
    })
    .await
    .map_err(|e| format!("could not read the recorded test result: {e}"))?
}

/// Widen the contract on purpose — the honest alternative to a bypass.
///
/// Recorded in the contract, so "we decided to allow this" stays next to the
/// code instead of evaporating into a skipped hook.
#[tauri::command]
pub async fn approve_symbol_removal(
    repo_root: String,
    symbol: String,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        aura_json(
            &repo_root,
            &["intent-contract", "amend", "--approve-removal", &symbol, "--json"],
        )
    })
    .await
    .map_err(|e| format!("the amendment did not finish: {e}"))?
}
