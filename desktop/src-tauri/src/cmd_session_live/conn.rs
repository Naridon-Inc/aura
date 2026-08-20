//! The per-session WebSocket connection: dial, `hello`, pump, reconnect, and
//! the inbound frame dispatch.
//!
//! Shape is lifted from `cmd_remote_relay` — outbound dial to the cloud with
//! the `cloud_api_token` from `~/.aura/credentials.json`, first frame parsed
//! inline so an auth/permission failure surfaces as a command error instead of
//! a silent background retry. Two deliberate differences:
//!
//!  * `cmd_remote_relay` never reconnects; if the relay drops, the phone just
//!    stops working until the user re-opens the dialog. A shared session is
//!    worse off that way — the other person is sitting there watching a frozen
//!    transcript — so this one reconnects with backoff and replays from the
//!    last `seq` it saw.
//!  * The socket is not split into two pump tasks. One task owns both halves
//!    through a `select!`, so the outbound queue survives a reconnect instead
//!    of dying with the sink.

use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tauri::Manager;
use tokio::net::TcpStream;
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::protocol::Message as TMessage;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};
use tracing::warn;

use super::ctx::{ConnCtx, Role};
use super::protocol::{
    now_secs, Author, ClientFrame, ErrorFrame, MsgFrame, Participant, PresenceFrame, ReadyFrame,
    TranscriptFrame, TunnelClosedFrame, TunnelReqFrame,
};

pub type WsStream = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// How long a fresh `session_live_share` / `_join` waits for `ready` before it
/// gives up and reports the failure to the caller.
const READY_TIMEOUT: Duration = Duration::from_secs(15);

/// Reconnect backoff bounds. Starts short so a Wi-Fi blip is invisible, tops
/// out low enough that a laptop waking from sleep rejoins within half a minute.
const BACKOFF_MIN: Duration = Duration::from_secs(1);
const BACKOFF_MAX: Duration = Duration::from_secs(30);

/// `https://host` → `wss://host`. Same helper `cmd_remote_relay` uses; copied
/// rather than imported because that one is private to its module and this
/// crate's convention is that a plane owns its own transport bits.
fn ws_origin(origin: &str) -> String {
    if let Some(rest) = origin.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = origin.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        origin.to_string()
    }
}

/// The session-live endpoint for `external_id`, with the catch-up cursor when
/// we have one.
pub fn ws_url(origin: &str, external_id: &str, since: Option<u64>) -> Result<String, String> {
    let base = ws_origin(origin);
    let mut url = url::Url::parse(&format!("{base}/api/v2/sessions/x/live/ws"))
        .map_err(|e| format!("bad cloud_url {origin}: {e}"))?;
    // Set the id through the path API so a session id containing `/` or `?`
    // cannot reshape the request.
    url.set_path(&format!("/api/v2/sessions/{external_id}/live/ws"));
    if let Some(seq) = since {
        url.set_query(Some(&format!("since={seq}")));
    }
    Ok(url.to_string())
}

/// Dial the session socket, send `hello`, and read frames until `ready`.
///
/// Errors here are the ones worth showing a person: no token, no membership,
/// session not found. Everything after this point is a background concern.
pub async fn dial_and_hello(ctx: &Arc<ConnCtx>) -> Result<(WsStream, ReadyFrame), String> {
    let url = ws_url(&ctx.origin, &ctx.external_id, ctx.last_seq())?;
    let (mut ws, _resp) = tokio_tungstenite::connect_async(url.as_str())
        .await
        .map_err(|e| format!("session-live dial: {e}"))?;

    let hello = serde_json::to_string(&ctx.hello()).map_err(|e| format!("encode hello: {e}"))?;
    ws.send(TMessage::Text(hello.into()))
        .await
        .map_err(|e| format!("session-live hello: {e}"))?;

    let ready = tokio::time::timeout(READY_TIMEOUT, await_ready(ctx, &mut ws))
        .await
        .map_err(|_| "session-live: no `ready` within 15s".to_string())??;

    Ok((ws, ready))
}

/// Read until `ready`. A fatal `error` aborts; a non-fatal one is surfaced to
/// the UI and we keep waiting, because the demotion notice ("you are a guest
/// now") arrives that way and is not a failure to connect.
async fn await_ready(ctx: &Arc<ConnCtx>, ws: &mut WsStream) -> Result<ReadyFrame, String> {
    loop {
        match ws.next().await {
            Some(Ok(TMessage::Text(t))) => {
                let v: Value = match serde_json::from_str(&t) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                match v.get("type").and_then(Value::as_str).unwrap_or("") {
                    "ready" => {
                        let ready: ReadyFrame =
                            serde_json::from_value(v).map_err(|e| format!("bad ready frame: {e}"))?;
                        return Ok(ready);
                    }
                    "error" => {
                        let err: ErrorFrame = serde_json::from_value(v).unwrap_or_default();
                        if err.fatal {
                            return Err(err.message);
                        }
                        apply_error(ctx, err);
                    }
                    _ => handle_inbound_value(ctx, v),
                }
            }
            Some(Ok(TMessage::Ping(p))) => {
                let _ = ws.send(TMessage::Pong(p)).await;
            }
            Some(Ok(TMessage::Close(frame))) => {
                return Err(match frame {
                    Some(f) if !f.reason.is_empty() => {
                        format!("session-live closed: {}", f.reason)
                    }
                    _ => "session-live closed before ready".to_string(),
                });
            }
            Some(Ok(_)) => {}
            Some(Err(e)) => return Err(format!("session-live read: {e}")),
            None => return Err("session-live closed before ready".to_string()),
        }
    }
}

enum PumpExit {
    /// The caller asked us to stop — do not reconnect.
    Cancelled,
    /// The socket went away on its own — reconnect.
    Dropped,
}

/// The long-lived connection task. Owns the outbound queue across reconnects.
pub async fn run(
    ctx: Arc<ConnCtx>,
    first: WsStream,
    first_ready: ReadyFrame,
    mut out_rx: mpsc::UnboundedReceiver<ClientFrame>,
    mut cancel: oneshot::Receiver<()>,
) {
    apply_ready(&ctx, first_ready);
    ctx.set_connected(true);
    ctx.emit_status(None);
    ctx.emit_transport("live", None);

    let mut ws = Some(first);
    let mut backoff = BACKOFF_MIN;

    loop {
        let socket = match ws.take() {
            Some(s) => s,
            None => match dial_and_hello(&ctx).await {
                Ok((s, ready)) => {
                    backoff = BACKOFF_MIN;
                    apply_ready(&ctx, ready);
                    ctx.set_connected(true);
                    ctx.emit_status(None);
                    ctx.emit_transport("live", None);
                    s
                }
                Err(e) => {
                    warn!(target: "session_live", "reconnect failed: {e}");
                    ctx.emit_status(Some(e.clone()));
                    ctx.emit_transport("reconnecting", Some(e));
                    tokio::select! {
                        _ = tokio::time::sleep(backoff) => {}
                        _ = &mut cancel => break,
                    }
                    backoff = (backoff * 2).min(BACKOFF_MAX);
                    continue;
                }
            },
        };

        let exit = pump(&ctx, socket, &mut out_rx, &mut cancel).await;
        ctx.set_connected(false);
        ctx.emit_status(None);

        match exit {
            PumpExit::Cancelled => break,
            PumpExit::Dropped => {
                if ctx.stopped() {
                    break;
                }
                // Rust owns the retry, so the renderer is told "reconnecting"
                // rather than "closed" — the latter makes its transport
                // schedule a second, competing reconnect.
                ctx.emit_transport("reconnecting", None);
                tokio::select! {
                    _ = tokio::time::sleep(backoff) => {}
                    _ = &mut cancel => break,
                }
                backoff = (backoff * 2).min(BACKOFF_MAX);
            }
        }
    }

    ctx.stop();
    ctx.set_connected(false);
    ctx.emit_status(None);
    ctx.emit_transport("closed", None);
}

async fn pump(
    ctx: &Arc<ConnCtx>,
    ws: WsStream,
    out_rx: &mut mpsc::UnboundedReceiver<ClientFrame>,
    cancel: &mut oneshot::Receiver<()>,
) -> PumpExit {
    let (mut sink, mut stream) = ws.split();
    loop {
        tokio::select! {
            inbound = stream.next() => match inbound {
                Some(Ok(TMessage::Text(t))) => {
                    let v: Value = match serde_json::from_str(&t) {
                        Ok(v) => v,
                        // A frame we cannot parse is not a reason to drop a
                        // session someone else is watching.
                        Err(_) => continue,
                    };
                    handle_inbound_value(ctx, v);
                }
                Some(Ok(TMessage::Ping(p))) => {
                    if sink.send(TMessage::Pong(p)).await.is_err() {
                        return PumpExit::Dropped;
                    }
                }
                Some(Ok(TMessage::Close(_))) | None => return PumpExit::Dropped,
                Some(Err(_)) => return PumpExit::Dropped,
                Some(Ok(_)) => {}
            },
            outbound = out_rx.recv() => match outbound {
                Some(frame) => {
                    let json = match serde_json::to_string(&frame) {
                        Ok(j) => j,
                        Err(e) => {
                            warn!(target: "session_live", "encode frame: {e}");
                            continue;
                        }
                    };
                    if sink.send(TMessage::Text(json.into())).await.is_err() {
                        return PumpExit::Dropped;
                    }
                }
                // Every sender dropped — the session was torn down.
                None => return PumpExit::Cancelled,
            },
            _ = &mut *cancel => {
                // Flush what is already queued before closing. `leave` sends
                // `bye` and *then* cancels; without this drain the select could
                // take the cancel branch first and the other side would learn
                // we left only by timeout.
                while let Ok(frame) = out_rx.try_recv() {
                    let Ok(json) = serde_json::to_string(&frame) else { continue };
                    if sink.send(TMessage::Text(json.into())).await.is_err() {
                        break;
                    }
                }
                let _ = sink.send(TMessage::Close(None)).await;
                return PumpExit::Cancelled;
            }
        }
    }
}

fn apply_ready(ctx: &Arc<ConnCtx>, ready: ReadyFrame) {
    // The server echoes which session it put us in. A mismatch means frames
    // from someone else's session are about to be rendered as ours, which is
    // worth saying out loud rather than quietly tolerating.
    if !ready.session_id.is_empty() && ready.session_id != ctx.external_id {
        warn!(
            target: "session_live",
            "joined {} but asked for {}", ready.session_id, ctx.external_id
        );
        ctx.emit_scoped(
            super::EV_ERROR,
            json!({
                "message": format!(
                    "the cloud placed this socket in session {} instead of {}",
                    ready.session_id, ctx.external_id
                ),
                "fatal": false,
            }),
        );
    }
    if let Some(you) = ready.you.clone() {
        // The server is the authority on our role. Asking for host and being
        // handed "guest" is the documented demotion, and it must switch off
        // transcript publishing, injection and tunnel serving.
        if ctx.role == Role::Host && you.role == "guest" {
            ctx.demote();
        }
        ctx.set_me(you);
    }
    ctx.set_host_online(ready.host_online);
    ctx.claim_agents(&ready.your_agents);
    ctx.emit_scoped(
        super::EV_READY,
        json!({
            "you":            ctx.me(),
            "host_online":    ready.host_online,
            "your_agents":    ready.your_agents,
            "role":           ctx.effective_role(),
            "share_url":      ctx.share_url(),
            "share_code":     ctx.share_code(),
            "default_access": ctx.default_access(),
            "my_access":      ctx.my_access(),
        }),
    );
}

fn apply_error(ctx: &Arc<ConnCtx>, err: ErrorFrame) {
    // The doc's demotion path is an `error` frame. Detect it by content so a
    // host that lost the race stops behaving like one immediately, without
    // waiting for the next `presence`.
    let lowered = err.message.to_lowercase();
    if ctx.role == Role::Host && (lowered.contains("demot") || lowered.contains("already has")) {
        ctx.demote();
    }
    ctx.emit_scoped(
        super::EV_ERROR,
        json!({ "message": err.message, "fatal": err.fatal, "role": ctx.effective_role() }),
    );
}

/// Dispatch one inbound frame. Unknown `type` values are ignored, per the
/// protocol's forward-compatibility rule.
fn handle_inbound_value(ctx: &Arc<ConnCtx>, v: Value) {
    // Verbatim first: the renderer's transport parses whole frames, and it
    // should see one we could not classify just as readily as one we could.
    ctx.emit_raw_frame(&v);
    let ty = v
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    match ty.as_str() {
        "ready" => {
            if let Ok(ready) = serde_json::from_value::<ReadyFrame>(v) {
                apply_ready(ctx, ready);
            }
        }
        "presence" => {
            let frame: PresenceFrame = serde_json::from_value(v).unwrap_or_default();
            ctx.replace_presence(&frame.participants);
            ctx.emit_scoped(
                super::EV_PRESENCE,
                json!({
                    "participants": frame.participants,
                    "my_access":    ctx.my_access(),
                }),
            );
            // A promotion or demotion arrives inside `presence`; the composer's
            // enabled state hangs off `my_access`, so say it on the status
            // channel too rather than making every surface diff the roster.
            ctx.emit_status(None);
        }
        "transcript" => {
            let frame: TranscriptFrame = match serde_json::from_value(v) {
                Ok(f) => f,
                Err(_) => return,
            };
            ctx.bump_seq(frame.seq.or(frame.entry.seq));
            ctx.emit_scoped(
                super::EV_TRANSCRIPT,
                json!({ "seq": frame.seq.or(frame.entry.seq), "entry": frame.entry }),
            );
        }
        "msg" => {
            let frame: MsgFrame = match serde_json::from_value(v) {
                Ok(f) => f,
                Err(_) => return,
            };
            ctx.bump_seq(frame.seq);
            handle_msg(ctx, frame);
        }
        "impact" => {
            ctx.emit_scoped(super::EV_IMPACT, strip_type(v));
        }
        "typing" => {
            ctx.emit_scoped(super::EV_TYPING, strip_type(v));
        }
        "cursor" => {
            ctx.emit_scoped(super::EV_CURSOR, strip_type(v));
        }
        "host" => {
            let online = v.get("online").and_then(Value::as_bool).unwrap_or(false);
            ctx.set_host_online(online);
            ctx.emit_scoped(super::EV_HOST, json!({ "online": online }));
        }
        "error" => {
            apply_error(ctx, serde_json::from_value(v).unwrap_or_default());
        }
        "tunnel_req" => {
            let frame: TunnelReqFrame = match serde_json::from_value(v) {
                Ok(f) => f,
                Err(e) => {
                    warn!(target: "session_live", "bad tunnel_req: {e}");
                    return;
                }
            };
            super::tunnel::spawn_serve(ctx.clone(), frame);
        }
        "tunnel_closed" => {
            let frame: TunnelClosedFrame = serde_json::from_value(v).unwrap_or_default();
            // Drop it locally as well. Normally this is our own frame coming
            // back on the fan-out, but a tunnel the cloud reaped (its session
            // row went away) has to stop being proxyable here too, or this
            // desktop keeps serving a port nobody can see it is serving.
            let port = super::tunnel::forget(ctx, &frame.code).or(frame.port);
            ctx.emit_scoped(
                super::EV_TUNNEL_CLOSED,
                json!({ "code": frame.code, "port": port }),
            );
        }
        // Unknown frame types are ignored on purpose — old clients must
        // survive new frames.
        _ => {}
    }
}

/// Drop the discriminator before re-emitting to the frontend: the Tauri event
/// name already says what the payload is, and leaving `type` in invites the
/// React side to switch on it a second time.
fn strip_type(mut v: Value) -> Value {
    if let Some(obj) = v.as_object_mut() {
        obj.remove("type");
    }
    v
}

/// The delivery rule, client side.
///
/// `to` naming an agent this desktop hosts is the one case that reaches the
/// running process. Everything else — addressed to a person, addressed to
/// somebody else's agent, or broadcast — is rendered, not executed. Broadcast
/// deliberately never injects: talking to the room is not commanding it.
///
/// The second gate is `access`. The cloud is required to drop a `msg` from a
/// `watch` participant, but this desktop is the machine that would actually
/// *run* the text, so it checks again. Defence in depth is not politeness here:
/// a watcher whose frame slipped through — a cloud bug, a stale participant
/// record, a hand-rolled client — would otherwise have remote code execution on
/// somebody else's laptop.
fn handle_msg(ctx: &Arc<ConnCtx>, frame: MsgFrame) {
    let from = frame.from.clone().unwrap_or_default();
    let sender = ctx.lookup(&from);
    // Reported as the server stated it, `null` when it stated nothing — the
    // frontend has its own rule for absence and should not inherit the
    // conservative one this module uses for the injection gate.
    let sender_access = ctx.declared_access_of(&from);

    let addressed_to_our_agent = frame
        .to
        .as_deref()
        .map(|to| ctx.hosts_agent(to))
        .unwrap_or(false);
    let may_drive = ctx.may_drive(&from);
    let inject = addressed_to_our_agent && may_drive;

    ctx.emit_scoped(
        super::EV_MSG,
        json!({
            "seq":       frame.seq,
            "from":      frame.from,
            "to":        frame.to,
            "text":      frame.text,
            "intent":    frame.intent,
            "refs":      frame.refs,
            "reply_to":  frame.reply_to,
            "at":        frame.at.unwrap_or_else(now_secs),
            "from_participant": sender.clone(),
            // What the sender was allowed to do. The host's UI uses this plus
            // `intent == "ask"` to recognise a request for more access and
            // offer to promote them — the doc's way of asking, with no extra
            // frame.
            "from_access": sender_access,
            "injected":  inject,
        }),
    );

    if !addressed_to_our_agent {
        return;
    }
    if !may_drive {
        warn!(
            target: "session_live",
            "refused to inject a message from {from}: not a `drive` participant"
        );
        ctx.emit_scoped(
            super::EV_ERROR,
            json!({
                "message": format!(
                    "{} asked this desktop's agent to do something but only has watch access — the message was shown, not run",
                    sender.as_ref().map(|p| p.name.clone()).filter(|n| !n.is_empty()).unwrap_or_else(|| "someone".to_string())
                ),
                "fatal": false,
            }),
        );
        return;
    }
    // Our own frames come back to us on the fan-out; injecting them would
    // loop this desktop's agent against itself.
    if Some(from.as_str()) == ctx.participant_id().as_deref() {
        return;
    }
    let Some(session_id) = ctx.agent_session_id.clone() else {
        ctx.emit_scoped(
            super::EV_ERROR,
            json!({
                "message": "a message was addressed to this desktop's agent, but no running agent session is attached to this share",
                "fatal": false,
            }),
        );
        return;
    };

    let author = Author {
        id: from.clone(),
        name: sender
            .as_ref()
            .map(|p| p.name.clone())
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| "a teammate".to_string()),
        kind: sender
            .as_ref()
            .map(|p| p.kind.clone())
            .filter(|k| !k.is_empty())
            .unwrap_or_else(|| "human".to_string()),
    };
    let payload = format!("{}{}", attribution_prefix(sender.as_ref()), frame.text);
    ctx.note_injection(payload.clone(), author);

    let ctx2 = ctx.clone();
    tauri::async_runtime::spawn(async move {
        let app = ctx2.app.clone();
        let registry = app.state::<crate::cmd_agent_pty::AgentPtyRegistry>();
        // The composer's own path — bracketed paste plus the submit CR, and
        // the same Prompt/Output block synthesis the local UI renders. A
        // second, parallel input path would drift from it.
        if let Err(e) =
            crate::cmd_agent_pty::agent_pty_send_prompt(app.clone(), registry, session_id, payload)
                .await
        {
            warn!(target: "session_live", "inject failed: {e}");
            ctx2.emit_scoped(
                super::EV_ERROR,
                json!({ "message": format!("could not deliver the message to the agent: {e}"), "fatal": false }),
            );
        }
    });
}

/// What the agent reads before the message body. The agent has to know it is
/// not being addressed by the person at this keyboard — otherwise "do it" from
/// a remote peer is indistinguishable from the owner typing it.
fn attribution_prefix(sender: Option<&Participant>) -> String {
    match sender {
        Some(p) if p.kind == "agent" => {
            let kind = p.agent_kind.clone().unwrap_or_else(|| "agent".to_string());
            let who = if p.name.is_empty() {
                kind.clone()
            } else {
                p.name.clone()
            };
            format!("[Aura shared session] {who} — a teammate's {kind} — says:\n")
        }
        Some(p) if !p.name.is_empty() => {
            format!("[Aura shared session] {} says:\n", p.name)
        }
        _ => "[Aura shared session] a teammate says:\n".to_string(),
    }
}
