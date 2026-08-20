//! Host-side publishers: the agent transcript, and the impact plane.
//!
//! Both ride the machinery that already exists rather than a second reader:
//!
//!  * `claude_session_watch` already tails the agent's JSONL every 500ms and
//!    emits parsed `StreamEvent`s on `claude-session:<session_id>`. Listening
//!    on that channel means a guest sees exactly what the local AgentStreamView
//!    sees, at the same moment, with no second parser to drift.
//!  * `.aura/impacts.jsonl` is where the impact/radar plane records a
//!    cross-branch collision. Watching it turns "somebody edited a function you
//!    depend on" into a frame inside the shared session immediately, instead of
//!    on the next radar poll.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use serde_json::json;
use uuid::Uuid;

use super::ctx::ConnCtx;
use super::protocol::{now_secs, ClientFrame, Entry};
use crate::cmd_agent_stream::StreamEvent;
use crate::cmd_aura_fs::ImpactAlert;

/// How often the impact log is re-read. Matches the cadence the app's own
/// impact surfaces poll at — a collision does not need sub-second latency, and
/// a tight loop on a file most repos never write is waste.
const IMPACT_POLL: Duration = Duration::from_secs(3);

/// Ceiling on a published transcript entry. Tool results in particular can be
/// megabytes; a shared session is a conversation, not a file transfer.
const MAX_ENTRY_TEXT: usize = 16 * 1024;

/// Attach the host-only publishers. No-op for a guest, and no-op for a host the
/// server demoted — only the host may emit `transcript`.
pub fn attach(ctx: &Arc<ConnCtx>) {
    if !ctx.is_host() {
        return;
    }
    attach_transcript(ctx);
    attach_impacts(ctx);
}

/// Republish every `StreamEvent` the local JSONL tail produces as a
/// `transcript` frame.
fn attach_transcript(ctx: &Arc<ConnCtx>) {
    let Some(session_id) = ctx.agent_session_id.clone() else {
        // Sharing a session with no live agent behind it is legitimate (two
        // people can still talk in it); there is simply nothing to publish.
        return;
    };
    let channel = format!("claude-session:{session_id}");
    let ctx_for_listener = ctx.clone();
    super::ctx::track_listener(ctx, channel, move |event| {
        let ctx = &ctx_for_listener;
        if ctx.stopped() || !ctx.is_host() {
            return;
        }
        let Ok(ev) = serde_json::from_str::<StreamEvent>(event.payload()) else {
            return;
        };
        if let Some(entry) = entry_from_event(ctx, ev) {
            ctx.send(ClientFrame::Transcript { entry });
        }
    });
}

/// Map one local stream event onto a protocol `Entry`.
///
/// Only what a reader can actually follow crosses the wire: prompts, answers,
/// which tool ran, and what it returned. Token accounting, inline images and
/// per-turn cost are local telemetry — they would be noise in someone else's
/// panel and they are not part of the documented `role` set.
fn entry_from_event(ctx: &Arc<ConnCtx>, ev: StreamEvent) -> Option<Entry> {
    let (role, text) = match ev {
        StreamEvent::UserPrompt { text, .. } => {
            if is_synthetic_prompt(&text) {
                return None;
            }
            ("user", text)
        }
        StreamEvent::AssistantText { text, .. } => ("assistant", text),
        StreamEvent::ToolUse { name, input, .. } => {
            // The tool's arguments can be a whole file body. A one-line
            // summary is what a person reading along needs.
            let summary = summarise_tool_input(&input);
            (
                "tool",
                if summary.is_empty() {
                    name
                } else {
                    format!("{name} — {summary}")
                },
            )
        }
        StreamEvent::ToolResult {
            content, is_error, ..
        } => (
            "tool",
            if is_error {
                format!("error: {content}")
            } else {
                content
            },
        ),
        StreamEvent::RawError { message, .. } => ("system", message),
        // Deliberately not published — see the note above.
        StreamEvent::SystemInit { .. }
        | StreamEvent::Usage { .. }
        | StreamEvent::Result { .. }
        | StreamEvent::Image { .. } => return None,
    };

    if text.trim().is_empty() {
        return None;
    }

    // A prompt this desktop pushed in on a peer's behalf is theirs, not the
    // local user's. Without this, everything a remote person types shows up
    // under the host's avatar.
    let author = if role == "user" {
        ctx.claim_injection(&text).or_else(|| super::local_author(ctx))
    } else {
        super::agent_author(ctx)
    };

    Some(Entry {
        id: format!("e_{}", Uuid::new_v4().simple()),
        seq: None,
        role: role.to_string(),
        author,
        text: truncate(text, MAX_ENTRY_TEXT),
        at: now_secs(),
    })
}

/// A short, human-readable stand-in for a tool call's arguments.
fn summarise_tool_input(input: &serde_json::Value) -> String {
    // The fields that actually say what the tool is about, in the order a
    // reader would want them.
    for key in [
        "file_path", "path", "command", "pattern", "query", "url", "prompt",
    ] {
        if let Some(s) = input.get(key).and_then(|v| v.as_str()) {
            return truncate(s.to_string(), 200);
        }
    }
    match input {
        serde_json::Value::Object(map) if map.is_empty() => String::new(),
        serde_json::Value::Null => String::new(),
        other => truncate(other.to_string(), 200),
    }
}

fn truncate(mut s: String, max: usize) -> String {
    if s.len() <= max {
        return s;
    }
    // Cut on a char boundary — `String::truncate` panics mid-codepoint.
    let mut cut = max;
    while cut > 0 && !s.is_char_boundary(cut) {
        cut -= 1;
    }
    s.truncate(cut);
    s.push('…');
    s
}

/// Claude Code writes plumbing wrappers into the JSONL as `user`-role
/// messages. Publishing them would show a teammate a stream of
/// `<system-reminder>` blocks nobody typed.
///
/// This mirrors the private `is_synthetic_prompt` in `cmd_claude_sessions`. It
/// is duplicated rather than shared because that module belongs to another
/// surface and this plane must not reach into it; the list is small and the
/// cost of a miss is one noisy entry, not a break.
fn is_synthetic_prompt(text: &str) -> bool {
    const SYNTHETIC_TAGS: &[&str] = &[
        "<task-notification>",
        "<system-reminder>",
        "<command-name>",
        "<command-message>",
        "<command-args>",
        "<local-command-stdout>",
        "<local-command-stderr>",
        "<local-command-caveat>",
        "<bash-input>",
        "<bash-stdout>",
        "<bash-stderr>",
        "<user-prompt-submit-hook>",
    ];
    let head = text.trim_start();
    if SYNTHETIC_TAGS.iter().any(|tag| head.starts_with(tag)) {
        return true;
    }
    head.starts_with("[Image: source:") || head.starts_with("[Request interrupted")
}

/// Watch `.aura/impacts.jsonl` and publish each newly-noticed collision.
fn attach_impacts(ctx: &Arc<ConnCtx>) {
    let Some(repo_root) = ctx.repo_root.clone() else {
        return;
    };
    let ctx = ctx.clone();
    tauri::async_runtime::spawn(async move {
        let path = PathBuf::from(&repo_root).join(".aura").join("impacts.jsonl");
        // Prime with what is already on disk. A share should announce
        // collisions noticed *from now on*; replaying a repo's whole backlog
        // into someone else's session on join is spam, not signal.
        let mut seen: HashSet<String> = read_alerts(&path)
            .into_iter()
            .map(|a| alert_key(&a))
            .collect();

        loop {
            tokio::time::sleep(IMPACT_POLL).await;
            if ctx.stopped() {
                break;
            }
            if !ctx.is_host() {
                continue;
            }
            for alert in read_alerts(&path) {
                let key = alert_key(&alert);
                if !seen.insert(key) {
                    continue;
                }
                ctx.send(ClientFrame::Impact {
                    symbol: alert.function.clone(),
                    file: alert.file.clone(),
                    severity: severity_for(&alert.severity).to_string(),
                });
                // Surface it locally too, so the person who owns the collision
                // sees it in the session panel without a round trip.
                ctx.emit_scoped(
                    super::EV_IMPACT,
                    json!({
                        "from":     ctx.participant_id(),
                        "symbol":   alert.function,
                        "file":     alert.file,
                        "severity": severity_for(&alert.severity),
                        "message":  alert.message,
                        "branch":   alert.branch,
                        "at":       now_secs(),
                        "local":    true,
                    }),
                );
            }
        }
    });
}

/// Unresolved alerts currently in the log. A missing or unparsable file is an
/// empty list — the impact plane is optional and its absence is not an error.
fn read_alerts(path: &PathBuf) -> Vec<ImpactAlert> {
    let Ok(body) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    body.lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() {
                return None;
            }
            serde_json::from_str::<ImpactAlert>(line).ok()
        })
        .filter(|a| !a.resolved)
        .collect()
}

/// Identity of an alert for dedup. `id` when the writer set one; otherwise the
/// triple that makes it unique, so a log without ids still de-duplicates.
fn alert_key(a: &ImpactAlert) -> String {
    if !a.id.is_empty() {
        return a.id.clone();
    }
    format!("{}|{}|{}", a.function, a.file, a.timestamp)
}

/// The impact plane grades low/medium/high/critical; the session plane speaks
/// direct/likely, the same two words the Team Radar uses. High and above is a
/// collision on the thing itself.
fn severity_for(local: &str) -> &'static str {
    match local {
        "high" | "critical" => "direct",
        _ => "likely",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn severity_folds_to_the_two_wire_values() {
        assert_eq!(severity_for("critical"), "direct");
        assert_eq!(severity_for("high"), "direct");
        assert_eq!(severity_for("medium"), "likely");
        assert_eq!(severity_for("low"), "likely");
        assert_eq!(severity_for(""), "likely");
    }

    #[test]
    fn plumbing_prompts_never_reach_a_teammate() {
        assert!(is_synthetic_prompt("<system-reminder>hi</system-reminder>"));
        assert!(is_synthetic_prompt("  <bash-input>ls</bash-input>"));
        assert!(is_synthetic_prompt("[Request interrupted by user]"));
        assert!(!is_synthetic_prompt("fix the retry path"));
    }

    #[test]
    fn truncation_never_splits_a_codepoint() {
        // 'é' is two bytes; cutting at 3 would land mid-character.
        let out = truncate("aéé".to_string(), 3);
        assert!(out.starts_with('a'));
        assert!(out.ends_with('…'));
    }

    #[test]
    fn tool_input_summary_prefers_the_identifying_field() {
        let v = serde_json::json!({ "file_path": "src/foo.rs", "offset": 1 });
        assert_eq!(summarise_tool_input(&v), "src/foo.rs");
        assert_eq!(summarise_tool_input(&serde_json::json!({})), "");
    }

    #[test]
    fn alert_key_falls_back_when_the_log_has_no_ids() {
        let mut a = ImpactAlert {
            id: String::new(),
            severity: "high".into(),
            function: "retry_logic".into(),
            message: String::new(),
            branch: String::new(),
            file: "src/retry.rs".into(),
            timestamp: 42,
            resolved: false,
        };
        assert_eq!(alert_key(&a), "retry_logic|src/retry.rs|42");
        a.id = "imp_1".into();
        assert_eq!(alert_key(&a), "imp_1");
    }
}
