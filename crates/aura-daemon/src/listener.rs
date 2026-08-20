//! Per-connection read loop. First frame must be a Handshake; afterwards
//! we dispatch requests. W4.5 wires OpenSession / ListSessions /
//! CloseSession / GetBlock. Variants that remain un-wired still receive
//! a typed `Unavailable` error (lands in W4.6 / W5).

use std::path::PathBuf;
use std::sync::Arc;

use aura_blocks::BlockId;
use aura_blockstore::StoreEvent;
use serde_bytes::ByteBuf;
use tokio::io::AsyncReadExt;
use tokio::net::UnixStream;
use tokio::sync::broadcast;
use tracing::{debug, info, warn};

use aura_daemon_client::envelope::{read_frame, write_frame, Envelope, MessageKind};
use aura_daemon_client::error::{ProtocolError, ProtocolErrorKind, WireError};
use aura_daemon_client::protocol::{EventBody, RequestBody, ResponseBody};

use crate::handshake::{build_ack, validate};
use crate::state::ServerState;

#[derive(Clone)]
pub struct ConnContext {
    pub secret: Arc<Vec<u8>>,
    pub daemon_build: Arc<String>,
    pub state: Arc<ServerState>,
}

pub async fn handle_connection(mut stream: UnixStream, ctx: ConnContext) {
    let peer_label = stream
        .peer_cred()
        .map(|c| format!("pid={} uid={}", c.pid().unwrap_or(-1), c.uid()))
        .unwrap_or_else(|_| "pid=? uid=?".to_string());

    match run(&mut stream, ctx, &peer_label).await {
        Ok(()) => debug!(peer = %peer_label, "connection closed cleanly"),
        Err(e) => warn!(peer = %peer_label, error = %e, "connection terminated"),
    }
}

async fn run(stream: &mut UnixStream, ctx: ConnContext, peer: &str) -> Result<(), ProtocolError> {
    // ── Handshake must be the first frame ────────────────────────────────
    let first = read_frame(stream).await?;
    if first.kind != MessageKind::Request {
        let err = ProtocolError::new(
            ProtocolErrorKind::Handshake,
            format!("expected Request as first frame, got {:?}", first.kind),
        );
        send_error(stream, first.msg_id, &err).await?;
        return Err(err);
    }
    let req: RequestBody = first.decode_body()?;
    let handshake = match req {
        RequestBody::Handshake(h) => h,
        other => {
            let err = ProtocolError::new(
                ProtocolErrorKind::Handshake,
                format!(
                    "first request must be Handshake, got {}",
                    request_label(&other)
                ),
            );
            send_error(stream, first.msg_id, &err).await?;
            return Err(err);
        }
    };
    if let Err(e) = validate(&handshake, ctx.secret.as_ref()) {
        send_error(stream, first.msg_id, &e).await?;
        return Err(e);
    }
    let ack = build_ack(ctx.daemon_build.as_ref());
    let conn_id = ack.connection_id;
    let resp = Envelope::new_response(2, first.msg_id, &ResponseBody::HandshakeAck(ack))?;
    write_frame(stream, &resp).await?;
    info!(peer = %peer, client = %handshake.client, connection_id = %conn_id, "handshake ok");
    let client_label = handshake.client.clone();

    // ── Post-handshake dispatch loop ─────────────────────────────────────
    let mut next_msg_id = 3u64;
    loop {
        let frame = match read_frame(stream).await {
            Ok(f) => f,
            Err(e) if e.kind == ProtocolErrorKind::Io => {
                debug!(peer = %peer, "client disconnected");
                return Ok(());
            }
            Err(e) => return Err(e),
        };
        if frame.kind != MessageKind::Request {
            let err = ProtocolError::new(
                ProtocolErrorKind::Domain,
                format!("only Request frames accepted post-handshake, got {:?}", frame.kind),
            );
            send_error(stream, frame.msg_id, &err).await?;
            continue;
        }
        let body: RequestBody = frame.decode_body()?;

        // Subscribe upgrades the connection to event-only mode. Subscribe
        // to the broadcast BEFORE ack'ing so an event fired between the
        // client observing SubscribeAck and drain_events starting can't
        // be lost — broadcast channels are lossless from subscription
        // onwards (and emit Lagged if the subscriber can't keep up).
        if let RequestBody::Subscribe { filter } = &body {
            let server_filter = build_server_filter(filter);
            // Subscribe to BOTH buses before ack'ing so no event fired
            // between SubscribeAck and drain_events starting can be lost:
            // the store's StoreEvent channel (block writes) and the
            // daemon-owned EventBody bus (agent-lifecycle transitions).
            // Both are lossless-from-subscription and emit Lagged under
            // backpressure.
            let rx = ctx.state.store.subscribe();
            let event_rx = ctx.state.event_bus_subscribe();
            let ack = Envelope::new_response(
                next_msg_id,
                frame.msg_id,
                &ResponseBody::SubscribeAck,
            )?;
            next_msg_id = next_msg_id.wrapping_add(1);
            write_frame(stream, &ack).await?;
            info!(
                peer = %peer,
                filter_kinds = filter.kinds.len(),
                "client subscribed — entering event-forward mode",
            );
            return drain_events(stream, rx, event_rx, next_msg_id, server_filter).await;
        }

        let reply = dispatch(
            &body,
            ctx.state.as_ref(),
            ctx.daemon_build.as_ref(),
            &client_label,
            conn_id,
        );
        let env = match reply {
            Ok(r) => Envelope::new_response(next_msg_id, frame.msg_id, &r)?,
            Err(err) => {
                Envelope::new_error(next_msg_id, Some(frame.msg_id), &WireError::from(&err))?
            }
        };
        next_msg_id = next_msg_id.wrapping_add(1);
        write_frame(stream, &env).await?;
    }
}

/// Event-only mode: the client has subscribed. We split the stream,
/// forward store events as Event envelopes on the write half, and watch
/// the read half for EOF (client hangup). A byte received on the read
/// half post-subscribe is a protocol violation — the subscription
/// connection is unidirectional by design (multiplexing lives in v2).
async fn drain_events(
    stream: &mut UnixStream,
    mut rx: broadcast::Receiver<StoreEvent>,
    mut event_rx: broadcast::Receiver<EventBody>,
    mut next_msg_id: u64,
    filter: aura_blockstore::pubsub::SubscribeFilter,
) -> Result<(), ProtocolError> {
    let (read_half, mut write_half) = stream.split();
    tokio::pin!(read_half);
    let mut scratch = [0u8; 1];

    loop {
        tokio::select! {
            biased;
            read = read_half.read(&mut scratch) => {
                match read {
                    Ok(0) => return Ok(()), // clean EOF
                    Ok(_) => {
                        let e = ProtocolError::new(
                            ProtocolErrorKind::Domain,
                            "post-subscribe connections are event-only — unexpected inbound byte",
                        );
                        let env = Envelope::new_error(
                            next_msg_id,
                            None,
                            &WireError::from(&e),
                        )?;
                        let _ = write_frame(&mut write_half, &env).await;
                        return Err(e);
                    }
                    Err(e) => return Err(ProtocolError::from_io(e)),
                }
            }
            ev = rx.recv() => {
                match ev {
                    Ok(store_event) => {
                        if filter.matches(&store_event) {
                            if let Some(body) = translate_event(&store_event) {
                                let env = Envelope::new_event(next_msg_id, &body)?;
                                next_msg_id = next_msg_id.wrapping_add(1);
                                write_frame(&mut write_half, &env).await?;
                            }
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_n)) => {
                        // Documented backpressure path — tell the client
                        // so it can re-query state.
                        let body = EventBody::Lagged { since_lamport: 0 };
                        let env = Envelope::new_event(next_msg_id, &body)?;
                        next_msg_id = next_msg_id.wrapping_add(1);
                        write_frame(&mut write_half, &env).await?;
                    }
                    Err(broadcast::error::RecvError::Closed) => {
                        debug!("store broadcast closed; ending event forward loop");
                        return Ok(());
                    }
                }
            }
            ev = event_rx.recv() => {
                match ev {
                    Ok(body) => {
                        // Daemon-bus EventBodys (agent-lifecycle) are already
                        // wire-shaped and session-scoped status, not block
                        // events — the block-kind/block-id SubscribeFilter
                        // does not apply, so forward verbatim to every
                        // subscriber.
                        let env = Envelope::new_event(next_msg_id, &body)?;
                        next_msg_id = next_msg_id.wrapping_add(1);
                        write_frame(&mut write_half, &env).await?;
                    }
                    Err(broadcast::error::RecvError::Lagged(_n)) => {
                        // Same backpressure contract as the store stream —
                        // signal Lagged so the monitor can re-query.
                        let body = EventBody::Lagged { since_lamport: 0 };
                        let env = Envelope::new_event(next_msg_id, &body)?;
                        next_msg_id = next_msg_id.wrapping_add(1);
                        write_frame(&mut write_half, &env).await?;
                    }
                    Err(broadcast::error::RecvError::Closed) => {
                        debug!("daemon event bus closed; ending event forward loop");
                        return Ok(());
                    }
                }
            }
        }
    }
}

/// Map `aura-blockstore` internal events onto the wire `EventBody`. Any
/// variant not yet meaningful (e.g. SidebarCardUpdated — score + bucket
/// not carried on StoreEvent) returns None and is silently dropped;
/// clients rely on the events whose payloads we can render faithfully.
fn translate_event(e: &StoreEvent) -> Option<EventBody> {
    match e {
        StoreEvent::BlockCreated { block_id, .. } => Some(EventBody::BlockCreated {
            block_id: block_id.0,
            session_id: None,
        }),
        StoreEvent::OpApplied {
            block_id,
            op_id,
            new_state,
        } => Some(EventBody::OpApplied {
            block_id: block_id.0,
            op_id: *op_id,
            new_state: state_wire_name(*new_state),
        }),
        StoreEvent::SidebarCardUpdated { .. } => None,
    }
}

fn dispatch(
    req: &RequestBody,
    state: &ServerState,
    daemon_build: &str,
    client: &str,
    connection_id: uuid::Uuid,
) -> Result<ResponseBody, ProtocolError> {
    match req {
        RequestBody::Handshake(_) => Err(ProtocolError::new(
            ProtocolErrorKind::Handshake,
            "Handshake may only be sent as the first frame on a connection",
        )),
        RequestBody::OpenSession { workspace, agent } => {
            let id = state.open_session(PathBuf::from(workspace), agent.clone())?;
            Ok(ResponseBody::SessionOpened { id })
        }
        RequestBody::CloseSession { id } => {
            state.close_session(*id)?;
            Ok(ResponseBody::Ack)
        }
        RequestBody::ListSessions => {
            let sessions = state.list_sessions()?;
            Ok(ResponseBody::SessionList { sessions })
        }
        RequestBody::GetBlock { id } => {
            let block = state
                .store
                .get_block(BlockId(*id))
                .map_err(|e| {
                    ProtocolError::new(
                        ProtocolErrorKind::Unavailable,
                        format!("blockstore read failed: {e}"),
                    )
                })?
                .ok_or_else(|| {
                    ProtocolError::new(
                        ProtocolErrorKind::NotFound,
                        format!("block {id} not found"),
                    )
                })?;
            // aura-blocks is the canonical JSON shape — no need to invent a
            // second wire encoding. Tier-0 clients stay blocks-dep-free and
            // decode with serde_json themselves.
            let bytes = serde_json::to_vec(&block).map_err(|e| {
                ProtocolError::new(
                    ProtocolErrorKind::Codec,
                    format!("block json encode: {e}"),
                )
            })?;
            Ok(ResponseBody::Block {
                block: ByteBuf::from(bytes),
            })
        }
        RequestBody::ListBlocks { filter } => {
            // Narrow the wire filter (multi-kind / multi-state / session-scoped)
            // down to the store's first-match BlockFilter. Extra kinds/states
            // are silently dropped until the store grows a multi-value filter
            // surface; session_id is ignored until blocks carry a session
            // origin field (arrives with W6.5). This stays intentionally
            // conservative — no server-side filtering bugs in v1 is worth
            // more than a maximally expressive filter.
            //
            // The actor / anchor_* / since_ms / until_ms fields land via S2-BQ:
            // they pass straight through because the store's BlockFilter
            // already accepts the same shapes.
            let store_filter = aura_blockstore::BlockFilter {
                kind: filter
                    .kinds
                    .first()
                    .and_then(|k| parse_kind(k)),
                state: filter
                    .states
                    .first()
                    .and_then(|s| parse_state(s)),
                parent_id: None,
                actor: filter.actor.clone(),
                anchor_kind: filter.anchor_kind.clone(),
                anchor_value: filter.anchor_value.clone(),
                since_ms: filter.since_ms,
                until_ms: filter.until_ms,
                limit: filter.limit,
            };
            let blocks = state.store.list_blocks(&store_filter).map_err(|e| {
                ProtocolError::new(
                    ProtocolErrorKind::Unavailable,
                    format!("blockstore list failed: {e}"),
                )
            })?;
            let bytes = serde_json::to_vec(&blocks).map_err(|e| {
                ProtocolError::new(
                    ProtocolErrorKind::Codec,
                    format!("block list json encode: {e}"),
                )
            })?;
            Ok(ResponseBody::BlockList {
                blocks: ByteBuf::from(bytes),
            })
        }
        RequestBody::ApplyOp { op } => {
            let decoded: aura_blocks::BlockOp =
                serde_json::from_slice(op.as_slice()).map_err(|e| {
                    ProtocolError::new(
                        ProtocolErrorKind::Codec,
                        format!("BlockOp json decode: {e}"),
                    )
                })?;
            let reduced = state.store.apply_op(&decoded).map_err(|e| match e {
                aura_blockstore::StoreError::NotFound(msg) => {
                    ProtocolError::new(ProtocolErrorKind::NotFound, msg)
                }
                aura_blockstore::StoreError::Reducer(re) => {
                    // Illegal transitions and similar domain errors are the
                    // caller's fault, not ours. Tag as Domain so the client
                    // can distinguish from a daemon-side failure.
                    ProtocolError::new(ProtocolErrorKind::Domain, format!("reducer: {re}"))
                }
                other => ProtocolError::new(
                    ProtocolErrorKind::Unavailable,
                    format!("apply_op failed: {other}"),
                ),
            })?;
            Ok(ResponseBody::BlockUpdated {
                id: reduced.id.0,
                new_state: state_wire_name(reduced.state),
            })
        }
        // Subscribe is intercepted before dispatch — reaching this arm
        // means a second Subscribe in event-forward mode, which is a
        // protocol violation.
        RequestBody::Subscribe { .. } => Err(ProtocolError::new(
            ProtocolErrorKind::Domain,
            "Subscribe already active on this connection",
        )),
        RequestBody::Handover { agent } => {
            let xml = crate::handover::build_handover_xml(state, agent, daemon_build)?;
            Ok(ResponseBody::HandoverXml { xml })
        }
        RequestBody::ClaimZone { path } => {
            // Same pass-through contract as SendMessage: write a zone
            // file in the exact shape aura-cli ZoneRule expects, so the
            // claim is immediately visible to `aura sentinel` readers.
            // v1 wire only carries a single path — treat it as one
            // pattern and default to Warn mode. Block-mode claims are
            // an opt-in that can land on the wire later.
            let from_session = connection_id.to_string();
            let zone_id = crate::sentinel::claim_zone(
                &state.sentinel_root,
                &from_session,
                vec![path.clone()],
                crate::sentinel::ZoneMode::Warn,
            )?;
            // Reuse the existing ZoneClaimed response variant — the
            // `path` field echoes what the caller passed plus a zone id
            // marker so logs can correlate.
            Ok(ResponseBody::ZoneClaimed {
                path: format!("{path} (zone_id={zone_id})"),
            })
        }
        RequestBody::SendMessage { target, body } => {
            // Pass-through to the Sentinel mailbox. Sender identity is
            // what the daemon already knows about this connection:
            // `connection_id` (stable per-connection UUIDv7) for
            // from_session, and the handshake's `client` field for
            // from_agent. `target` "" or "*" is broadcast.
            let target_opt = if target.is_empty() || target == "*" {
                None
            } else {
                Some(target.as_str())
            };
            let from_session = connection_id.to_string();
            let msg_id = crate::sentinel::send_message(
                &state.sentinel_root,
                &from_session,
                client,
                target_opt,
                body,
            )?;
            Ok(ResponseBody::MessageSent { id: msg_id })
        }
        RequestBody::SubmitInput { session_id, input } => {
            // Route to whoever owns the PTY for this session. In-process
            // aura-term registers the sink at PTY spawn; external clients
            // submitting against an unknown session see NotFound (better
            // than silently dropping keystrokes). Input is sent as raw
            // bytes — it's the PTY's job to interpret.
            state
                .input_router
                .submit(*session_id, input.as_bytes().to_vec())?;
            Ok(ResponseBody::Ack)
        }
        RequestBody::GetFleetData { active_only } => {
            let fleet_service = crate::fleet::FleetService::new(state.store.clone());
            let query = crate::fleet::FleetPanelQuery { active_only: *active_only };
            let data = fleet_service.get_fleet_data(&query)
                .map_err(|e| ProtocolError::new(ProtocolErrorKind::Domain, format!("Fleet data error: {}", e)))?;
            let json_payload = serde_json::to_string(&data)
                .map_err(|e| ProtocolError::new(ProtocolErrorKind::Codec, format!("JSON error: {}", e)))?;
            Ok(ResponseBody::FleetData { json_payload })
        }
        RequestBody::PublishAgentLifecycle {
            session_id,
            state: lifecycle_state,
            tool,
            detail,
        } => {
            // Re-emit the lifecycle transition verbatim onto the daemon
            // event bus so headless monitors subscribed via Subscribe see
            // the live agent's phase. Like the store's own `tx.send`, a
            // send with no live receivers is not an error — the event is
            // simply dropped, so we ignore the receiver count and ack.
            let _delivered = state.publish_event(EventBody::AgentLifecycle {
                session_id: session_id.clone(),
                state: lifecycle_state.clone(),
                tool: tool.clone(),
                detail: detail.clone(),
            });
            Ok(ResponseBody::Ack)
        }
    }
}

/// Wire-form state name. Matches the `#[serde(rename_all = "snake_case")]`
/// repr on `BlockState`, so the same string appears in `BlockFilter.states`
/// (inbound) and in `BlockUpdated.new_state` / `EventBody::OpApplied.new_state`
/// (outbound). Sourcing through serde_json keeps the two sides coherent if
/// aura-blocks ever adds or renames a state.
fn state_wire_name(state: aura_blocks::BlockState) -> String {
    match serde_json::to_value(state) {
        Ok(serde_json::Value::String(s)) => s,
        // BlockState is a C-style enum; serde_json always returns String.
        // The fallback exists solely to avoid a panic if someone adds a
        // struct variant later — in that case, Debug is still useful.
        _ => format!("{state:?}"),
    }
}

fn parse_kind(s: &str) -> Option<aura_blocks::BlockKind> {
    // BlockKind is serde's internally-tagged form (`#[serde(tag = "kind",
    // rename_all = "snake_case")]`) — unit variants serialize as
    // `{"kind": "command"}`, not as the bare string "command". Build the
    // tagged object so any future generated variant round-trips correctly
    // without touching this function.
    let tagged = serde_json::json!({ "kind": s });
    serde_json::from_value(tagged).ok()
}

/// Translate the wire-level `SubscribeFilter` (kinds + session_ids as
/// strings/UUIDs) into the blockstore's in-process filter
/// (`HashSet<BlockKind>` + reserved anchor / block_ids).
///
/// - **Unknown kind strings are silently dropped** rather than failing the
///   Subscribe. A client built against a newer schema could otherwise not
///   subscribe to an older daemon; better to degrade to broader-than-asked
///   delivery and let the client's own match layer narrow further.
/// - **`session_ids` are currently ignored.** The daemon does not yet
///   track a session ↔ block relationship; until it does, we cannot
///   translate session_ids into block_ids without a lookup on every event.
///   This is W6.5 territory — when session tracking lands, route through
///   `filter.block_ids` here.
fn build_server_filter(
    wire: &aura_daemon_client::protocol::SubscribeFilter,
) -> aura_blockstore::pubsub::SubscribeFilter {
    use std::collections::HashSet;
    let kinds: HashSet<aura_blocks::BlockKind> = wire
        .kinds
        .iter()
        .filter_map(|k| parse_kind(k))
        .collect();
    aura_blockstore::pubsub::SubscribeFilter {
        kinds,
        anchor: None,
        block_ids: HashSet::new(),
    }
}

fn parse_state(s: &str) -> Option<aura_blocks::BlockState> {
    serde_json::from_value(serde_json::Value::String(s.to_string())).ok()
}

async fn send_error(
    stream: &mut UnixStream,
    in_reply_to: u64,
    err: &ProtocolError,
) -> Result<(), ProtocolError> {
    let env = Envelope::new_error(u64::MAX, Some(in_reply_to), &WireError::from(err))?;
    write_frame(stream, &env).await
}

fn request_label(req: &RequestBody) -> &'static str {
    match req {
        RequestBody::Handshake(_) => "Handshake",
        RequestBody::ListSessions => "ListSessions",
        RequestBody::OpenSession { .. } => "OpenSession",
        RequestBody::CloseSession { .. } => "CloseSession",
        RequestBody::GetBlock { .. } => "GetBlock",
        RequestBody::ListBlocks { .. } => "ListBlocks",
        RequestBody::SubmitInput { .. } => "SubmitInput",
        RequestBody::ApplyOp { .. } => "ApplyOp",
        RequestBody::ClaimZone { .. } => "ClaimZone",
        RequestBody::SendMessage { .. } => "SendMessage",
        RequestBody::Handover { .. } => "Handover",
        RequestBody::Subscribe { .. } => "Subscribe",
        RequestBody::GetFleetData { .. } => "GetFleetData",
        RequestBody::PublishAgentLifecycle { .. } => "PublishAgentLifecycle",
    }
}
