//! The commands that put a frame on the wire: messages, impacts, presence,
//! typing and cursor.
//!
//! `session_live_send` is the one that matters — the addressable `msg` that
//! carries every sender/recipient pairing. The rest are thin.

use std::sync::Arc;

use tauri::State;

use super::ctx::ConnCtx;
use super::protocol::{ClientFrame, SymbolRef, ACCESS_DRIVE, INTENTS, PRESENCE_STATES};
use super::session::ctx_for;
use super::SessionLiveState;

/// The local half of the access rule. The cloud drops a `msg` from a watcher
/// and answers with an `error`; refusing here as well turns that into an
/// immediate, specific message instead of a frame that vanishes.
fn require_drive(ctx: &Arc<ConnCtx>) -> Result<(), String> {
    if ctx.my_access() == ACCESS_DRIVE {
        return Ok(());
    }
    Err("you are watching this session — ask the host for drive access to send".into())
}

/// THE send command. One frame carries every pairing:
///
///   * `to` = an agent participant on some desktop → that desktop injects the
///     text into the running agent. This is how a person instructs an agent and
///     equally how this machine's Claude instructs another person's Claude.
///   * `to` = a human → an addressed message in the session.
///   * `to` = `None` → broadcast. Nobody's agent is instructed; broadcast is
///     talking to the room, not commanding it.
///
/// `intent: "ask"` from a watcher is how you request drive access — it is an
/// ordinary message, so it is allowed through even though nothing else is.
#[tauri::command]
pub async fn session_live_send(
    state: State<'_, SessionLiveState>,
    session_id: String,
    text: String,
    to: Option<String>,
    intent: Option<String>,
    refs: Option<Vec<SymbolRef>>,
    reply_to: Option<String>,
) -> Result<(), String> {
    if text.trim().is_empty() {
        return Err("message is empty".into());
    }
    let intent = intent.unwrap_or_else(|| "chat".to_string());
    if !INTENTS.contains(&intent.as_str()) {
        return Err(format!(
            "unknown intent {intent} — expected one of {}",
            INTENTS.join(", ")
        ));
    }
    let ctx = ctx_for(&state, &session_id).await?;
    // A watcher asking for access has to be able to say so; everything else
    // from a watcher is refused here and again at the cloud.
    if intent != "ask" {
        require_drive(&ctx)?;
    }
    ctx.send(ClientFrame::Msg {
        to,
        text,
        intent,
        refs: refs.unwrap_or_default(),
        reply_to,
    });
    Ok(())
}

/// Send one whole client frame. The typed commands cover the common cases;
/// this is the escape hatch the renderer's transport uses for everything that
/// is not a `msg` (typing / cursor / transcript / bye), so a new frame type
/// does not need a new command on both sides at once.
///
/// `hello`, `tunnel_res` and `tunnel_closed` are refused: this desktop owns the
/// handshake and the loopback proxy, and letting the renderer forge any of them
/// would hand it the cloud bearer's authority, the SSRF guard's decision, or
/// the ability to retire a teammate's working link.
#[tauri::command]
pub async fn session_live_say(
    state: State<'_, SessionLiveState>,
    session_id: String,
    frame: serde_json::Value,
) -> Result<(), String> {
    let ctx = ctx_for(&state, &session_id).await?;
    let ty = frame
        .get("type")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "frame has no `type`".to_string())?;

    let out = match ty {
        "msg" => {
            let intent = frame
                .get("intent")
                .and_then(|v| v.as_str())
                .unwrap_or("chat")
                .to_string();
            if !INTENTS.contains(&intent.as_str()) {
                return Err(format!("unknown intent {intent}"));
            }
            if intent != "ask" {
                require_drive(&ctx)?;
            }
            let text = frame
                .get("text")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            if text.trim().is_empty() {
                return Err("message is empty".into());
            }
            ClientFrame::Msg {
                to: frame.get("to").and_then(|v| v.as_str()).map(str::to_string),
                text,
                intent,
                refs: frame
                    .get("refs")
                    .cloned()
                    .and_then(|v| serde_json::from_value::<Vec<SymbolRef>>(v).ok())
                    .unwrap_or_default(),
                reply_to: frame
                    .get("reply_to")
                    .and_then(|v| v.as_str())
                    .map(str::to_string),
            }
        }
        "transcript" => {
            if !ctx.is_host() {
                return Err("only the session host may publish transcript".into());
            }
            let entry = frame
                .get("entry")
                .cloned()
                .ok_or_else(|| "transcript frame has no `entry`".to_string())?;
            ClientFrame::Transcript {
                entry: serde_json::from_value(entry)
                    .map_err(|e| format!("bad transcript entry: {e}"))?,
            }
        }
        "typing" => ClientFrame::Typing {
            on: frame.get("on").and_then(|v| v.as_bool()).unwrap_or(false),
        },
        "cursor" => ClientFrame::Cursor {
            file: frame
                .get("file")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string(),
            line: frame.get("line").and_then(|v| v.as_u64()).unwrap_or(0),
        },
        "state" => {
            let s = frame
                .get("state")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            if !PRESENCE_STATES.contains(&s.as_str()) {
                return Err(format!("unknown state {s}"));
            }
            ctx.set_presence_state(&s);
            ClientFrame::State { state: s }
        }
        "impact" => {
            let severity = frame
                .get("severity")
                .and_then(|v| v.as_str())
                .unwrap_or("likely")
                .to_string();
            if severity != "direct" && severity != "likely" {
                return Err("severity must be \"direct\" or \"likely\"".into());
            }
            ClientFrame::Impact {
                symbol: frame
                    .get("symbol")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string(),
                file: frame
                    .get("file")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string(),
                severity,
            }
        }
        "bye" => ClientFrame::Bye {},
        "hello" | "tunnel_res" | "tunnel_closed" => {
            return Err(format!("{ty} is owned by the desktop, not the renderer"))
        }
        other => return Err(format!("unknown frame type {other}")),
    };
    ctx.send(out);
    Ok(())
}

/// Announce a collision into the shared session. The host watches
/// `.aura/impacts.jsonl` and fires this automatically; this command is for the
/// surfaces that notice one another way (a rewind pre-flight, a zone clash).
#[tauri::command]
pub async fn session_live_impact(
    state: State<'_, SessionLiveState>,
    session_id: String,
    symbol: String,
    file: String,
    severity: Option<String>,
) -> Result<(), String> {
    if symbol.trim().is_empty() {
        return Err("symbol is required".into());
    }
    let severity = severity.unwrap_or_else(|| "likely".to_string());
    if severity != "direct" && severity != "likely" {
        return Err("severity must be \"direct\" or \"likely\"".into());
    }
    let ctx = ctx_for(&state, &session_id).await?;
    ctx.send(ClientFrame::Impact {
        symbol,
        file,
        severity,
    });
    Ok(())
}

/// Set what the sidebar renders next to this participant's avatar.
#[tauri::command]
pub async fn session_live_set_state(
    state: State<'_, SessionLiveState>,
    session_id: String,
    presence_state: String,
) -> Result<(), String> {
    if !PRESENCE_STATES.contains(&presence_state.as_str()) {
        return Err(format!(
            "unknown state {presence_state} — expected one of {}",
            PRESENCE_STATES.join(", ")
        ));
    }
    let ctx = ctx_for(&state, &session_id).await?;
    ctx.set_presence_state(&presence_state);
    ctx.send(ClientFrame::State {
        state: presence_state,
    });
    ctx.emit_status(None);
    Ok(())
}

#[tauri::command]
pub async fn session_live_typing(
    state: State<'_, SessionLiveState>,
    session_id: String,
    on: bool,
) -> Result<(), String> {
    let ctx = ctx_for(&state, &session_id).await?;
    ctx.send(ClientFrame::Typing { on });
    Ok(())
}

#[tauri::command]
pub async fn session_live_cursor(
    state: State<'_, SessionLiveState>,
    session_id: String,
    file: String,
    line: u64,
) -> Result<(), String> {
    let ctx = ctx_for(&state, &session_id).await?;
    ctx.send(ClientFrame::Cursor { file, line });
    Ok(())
}
