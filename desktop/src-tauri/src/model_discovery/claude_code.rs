//! Ask the installed Claude Code which models it offers.
//!
//! The Claude section of the picker was a table someone typed, so it went
//! stale the day Claude Code shipped a model: the 5.5 family was missing
//! while Claude Code itself already offered it. Claude Code knows its own
//! list — the one its `/model` menu shows, shaped by the signed-in account —
//! and hands it over without a turn: run it in stream-json mode, send the
//! `initialize` control request, and the reply carries `models`.
//!
//!   spawn → `initialize` → read `models` → kill.
//!
//! No prompt is ever sent, so nothing is spent. The child is started with
//! hooks off and no session written, so a background catalog refresh never
//! fires the user's hooks or leaves an empty conversation in their history.
//! Everything is best-effort and time-boxed: a missing binary, a login wall
//! or an older Claude Code that doesn't answer yields `None`, and the
//! curated rows stand.

use std::collections::HashSet;
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use super::DiscoveredModel;

/// Claude Code answers `initialize` in well under a second; anything still
/// silent after this is waiting on something a background probe won't get.
const PROBE_TIMEOUT: Duration = Duration::from_secs(10);

/// Ours, so the reply can be told apart from anything else on stdout.
const REQUEST_ID: &str = "aura-model-probe";

/// `-p` with stream-json on both sides is the SDK's own control channel.
/// Hooks are switched off and the session is never persisted: this run is a
/// question about Claude Code, not a conversation.
const PROBE_ARGS: &[&str] = &[
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--settings",
    r#"{"disableAllHooks":true}"#,
    "--no-session-persistence",
    "--strict-mcp-config",
];

/// The models Claude Code on this machine offers, in its own order.
pub(super) async fn probe() -> Option<Vec<DiscoveredModel>> {
    let bin = aura_agents::bin_resolve::resolve(&["claude"])?;
    // Rooted somewhere inert that always exists; nothing is written there.
    let cwd = crate::spawn_dir::safe_spawn_dir("");
    tokio::time::timeout(PROBE_TIMEOUT, ask(&bin, &cwd))
        .await
        .ok()
        .flatten()
}

async fn ask(bin: &str, cwd: &Path) -> Option<Vec<DiscoveredModel>> {
    let mut child = tokio::process::Command::new(bin)
        .args(PROBE_ARGS)
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .ok()?;

    let mut stdin = child.stdin.take()?;
    let request = serde_json::json!({
        "type": "control_request",
        "request_id": REQUEST_ID,
        "request": { "subtype": "initialize" },
    });
    stdin
        .write_all(format!("{request}\n").as_bytes())
        .await
        .ok()?;
    stdin.flush().await.ok()?;

    let mut lines = BufReader::new(child.stdout.take()?).lines();
    let mut found = None;
    while let Ok(Some(line)) = lines.next_line().await {
        let Ok(msg) = serde_json::from_str::<Value>(line.trim()) else {
            continue;
        };
        if is_our_reply(&msg) {
            found = models_from_reply(&msg);
            break;
        }
    }
    drop(stdin);
    let _ = child.kill().await;
    found
}

/// The control response to our `initialize`, as opposed to the system and
/// hook lines Claude Code may print first.
fn is_our_reply(msg: &Value) -> bool {
    msg.get("type").and_then(Value::as_str) == Some("control_response")
        && msg
            .pointer("/response/request_id")
            .and_then(Value::as_str)
            == Some(REQUEST_ID)
}

/// Turn the `initialize` reply into picker rows.
///
/// Each entry is `{value, resolvedModel?, displayName, …}`. `value` is what
/// Claude Code's own menu stores — often an alias (`opus`) — and
/// `resolvedModel` is the model that alias runs today (`claude-opus-5-5`).
/// The row takes the resolved id so it lines up with the catalog's rows and
/// the alias and its full id don't show as two models. `default` is skipped:
/// it is a pointer at one of the others, and the picker has its own "agent's
/// default" row. A 1M suffix is dropped — the catalog carries the 1M
/// variants as their own rows.
///
/// An error reply, or one with no usable models, is `None`.
pub(super) fn models_from_reply(msg: &Value) -> Option<Vec<DiscoveredModel>> {
    let models = msg.pointer("/response/response/models")?.as_array()?;
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for m in models {
        let text = |k: &str| {
            m.get(k)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
        };
        let Some(value) = text("value") else {
            continue;
        };
        if value == "default" {
            continue;
        }
        let id = strip_one_million(text("resolvedModel").unwrap_or(value));
        if id.is_empty() || !seen.insert(id.to_string()) {
            continue;
        }
        let label = text("displayName").unwrap_or(id).to_string();
        out.push(DiscoveredModel {
            id: id.to_string(),
            label,
        });
    }
    (!out.is_empty()).then_some(out)
}

fn strip_one_million(id: &str) -> &str {
    id.strip_suffix("[1m]").unwrap_or(id).trim()
}

/// Claude Code's bare aliases. A row whose id is one of these (an older
/// Claude Code that reports no `resolvedModel`) is matched to the catalog
/// by its label instead of its id.
pub(super) fn is_alias(id: &str) -> bool {
    matches!(id, "opus" | "sonnet" | "haiku" | "fable" | "opusplan")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A trimmed copy of what Claude Code 2.1 actually sends back.
    fn reply() -> Value {
        serde_json::json!({
            "type": "control_response",
            "response": {
                "subtype": "success",
                "request_id": REQUEST_ID,
                "response": {
                    "models": [
                        {"value": "default", "resolvedModel": "claude-opus-5-5", "displayName": "Default (recommended)"},
                        {"value": "opus", "resolvedModel": "claude-opus-5-5", "displayName": "Opus 5.5"},
                        {"value": "fable", "resolvedModel": "claude-fable-5-2", "displayName": "Fable 5.2"},
                        {"value": "sonnet", "resolvedModel": "claude-sonnet-5-5", "displayName": "Sonnet 5.5"},
                        {"value": "haiku", "resolvedModel": "claude-haiku-5-5", "displayName": "Haiku 5.5"},
                        {"value": "claude-fable-5-1", "resolvedModel": "claude-fable-5-1", "displayName": "Fable 5.1"},
                        {"value": "claude-haiku-4-5-20251001", "resolvedModel": "claude-haiku-4-5-20251001", "displayName": "Haiku 4.5"},
                        {"value": "claude-opus-4-8", "resolvedModel": "claude-opus-4-8", "displayName": "Opus 4.8"}
                    ]
                }
            }
        })
    }

    #[test]
    fn rows_take_the_resolved_id_in_claude_codes_order() {
        let rows = models_from_reply(&reply()).expect("models");
        let got: Vec<(&str, &str)> = rows.iter().map(|r| (r.id.as_str(), r.label.as_str())).collect();
        assert_eq!(
            got,
            vec![
                ("claude-opus-5-5", "Opus 5.5"),
                ("claude-fable-5-2", "Fable 5.2"),
                ("claude-sonnet-5-5", "Sonnet 5.5"),
                ("claude-haiku-5-5", "Haiku 5.5"),
                ("claude-fable-5-1", "Fable 5.1"),
                ("claude-haiku-4-5-20251001", "Haiku 4.5"),
                ("claude-opus-4-8", "Opus 4.8"),
            ]
        );
    }

    #[test]
    fn the_default_pointer_is_not_a_model_of_its_own() {
        let rows = models_from_reply(&reply()).expect("models");
        assert!(rows.iter().all(|r| r.id != "default" && r.label != "Default (recommended)"));
    }

    #[test]
    fn an_older_claude_code_without_resolved_ids_keeps_its_aliases() {
        let msg = serde_json::json!({
            "type": "control_response",
            "response": {"request_id": REQUEST_ID, "response": {"models": [
                {"value": "opus", "displayName": "Opus 5.5"},
                {"value": "claude-fable-5-1[1m]", "displayName": "Fable"}
            ]}}
        });
        let rows = models_from_reply(&msg).expect("models");
        assert_eq!(rows[0].id, "opus");
        assert!(is_alias(&rows[0].id));
        assert_eq!(rows[1].id, "claude-fable-5-1");
    }

    #[test]
    fn an_error_reply_or_empty_list_is_nothing() {
        let err = serde_json::json!({
            "type": "control_response",
            "response": {"subtype": "error", "request_id": REQUEST_ID, "error": "nope"}
        });
        assert!(models_from_reply(&err).is_none());
        let empty = serde_json::json!({
            "type": "control_response",
            "response": {"request_id": REQUEST_ID, "response": {"models": []}}
        });
        assert!(models_from_reply(&empty).is_none());
    }

    #[test]
    fn only_the_reply_to_our_request_counts() {
        assert!(is_our_reply(&reply()));
        let hook = serde_json::json!({"type": "system", "subtype": "hook_started"});
        assert!(!is_our_reply(&hook));
        let other = serde_json::json!({
            "type": "control_response",
            "response": {"request_id": "someone-else"}
        });
        assert!(!is_our_reply(&other));
    }

    /// Drives the real `claude` and asserts it lists its models. Ignored by
    /// default: it needs Claude Code installed and signed in. Run with
    /// `--ignored` when changing the handshake.
    #[tokio::test]
    #[ignore]
    async fn a_real_claude_code_lists_its_models() {
        let rows = probe().await.expect("claude answered the probe");
        assert!(rows.iter().any(|r| r.id.starts_with("claude-")), "{rows:?}");
    }
}
