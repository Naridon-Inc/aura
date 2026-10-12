//! Render an agent's terminal on the GPU path.
//!
//! [`native_term_open`](super::native_term_open) spawns a shell and renders
//! it. An agent session's shell is spawned by `cmd_agent_pty` long before any
//! pane exists — it survives tab switches, window restores and the pane being
//! closed — so the one terminal a user watches most was the one terminal the
//! native renderer could not draw. It fell back to xterm.js in the webview,
//! which is the engine that lags under exactly the kind of output an agent
//! produces: full-screen TUI repaints, thousands of lines a second.
//!
//! Nothing in the renderer needed changing for this. The render loop reads
//! [`PtyEvent`]s off a channel and sends input back through a
//! [`TerminalSink`](super::sink::TerminalSink), so "where the bytes come from"
//! and "where keystrokes go" were already the only two questions, and this
//! module answers both differently:
//!
//! * **Out:** [`crate::agent_pty_tap`] hands this process a copy of every
//!   chunk the agent writes, without disturbing the webview event, the replay
//!   history or the block parser that already consume it.
//! * **In:** [`AgentSink`] forwards keystrokes and resizes to
//!   `cmd_agent_pty`'s own write path, rather than to a PTY of its own.
//!
//! The pane is a *second* viewer of a session it does not own. It therefore
//! never spawns, never kills and never reaps the child: closing it detaches.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::RecvTimeoutError;
use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Manager, State};

use super::sink::TerminalSink;
use super::{Ctrl, NativeTermManager, Prepared, TermControl};
use crate::cmd_agent_pty::AgentPtyRegistry;
use aura_term_core::{GridTerminal, Palette, PtyEvent};

/// How often the tap bridge wakes to notice it has been told to stop. A tap
/// goes quiet rather than closing when nobody wants it any more, so the thread
/// cannot simply block on `recv` and wait to be disconnected.
const BRIDGE_POLL: Duration = Duration::from_millis(250);

/// One input event bound for an agent's PTY.
enum AgentInput {
    Write(Vec<u8>),
    Resize { cols: u16, rows: u16 },
}

/// A [`TerminalSink`] whose other end is an agent's PTY instead of a shell
/// this pane spawned.
///
/// The render loop is synchronous and the agent write path is not — it may
/// proxy to the PTY daemon over a socket — so input is queued to a single
/// forwarder task rather than written inline. One queue and one task, because
/// ordering is the entire contract of a terminal's input: a pane that delivers
/// `ls` as `sl` under load is worse than a pane that is slow.
struct AgentSink {
    tx: tokio::sync::mpsc::UnboundedSender<AgentInput>,
}

impl TerminalSink for AgentSink {
    fn write(&mut self, bytes: &[u8]) {
        // A closed channel means the forwarder is gone, which means the
        // session is gone. The loop finds that out from the tap closing.
        let _ = self.tx.send(AgentInput::Write(bytes.to_vec()));
    }

    fn resize(&mut self, cols: u16, rows: u16, _px_w: u16, _px_h: u16) {
        // Pixel dimensions are dropped on purpose: `agent_pty_resize` takes
        // cells, and the shadow grid `cmd_agent_pty` keeps for transcripts has
        // to be resized in the same call as the PTY or the two disagree about
        // where a wrapped line ended.
        let _ = self.tx.send(AgentInput::Resize { cols, rows });
    }
}

/// Start the task that drains [`AgentInput`] into the agent's PTY, in order.
fn spawn_input_forwarder(
    app: AppHandle,
    session_id: String,
) -> tokio::sync::mpsc::UnboundedSender<AgentInput> {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<AgentInput>();
    tauri::async_runtime::spawn(async move {
        while let Some(msg) = rx.recv().await {
            let registry = app.state::<AgentPtyRegistry>();
            match msg {
                AgentInput::Write(bytes) => {
                    let _ = crate::cmd_agent_pty::write_session_bytes(
                        &registry,
                        &session_id,
                        bytes,
                    )
                    .await;
                }
                AgentInput::Resize { cols, rows } => {
                    let _ = crate::cmd_agent_pty::resize_session_pty(
                        &registry,
                        &session_id,
                        cols,
                        rows,
                    )
                    .await;
                }
            }
        }
    });
    tx
}

/// Bridge the byte tap to the `PtyEvent` channel the render loop reads.
///
/// Returns the flag that stops it. The thread exits on any of three things:
/// the render loop dropping its receiver (the pane went away), the tap
/// disconnecting (the session went away), or the flag being raised by
/// [`super::native_term_close`].
fn spawn_tap_bridge(
    session_id: &str,
    seed: Vec<u8>,
) -> (std::sync::mpsc::Receiver<PtyEvent>, Arc<AtomicBool>) {
    let tap = crate::agent_pty_tap::subscribe(session_id);
    let (evt_tx, events) = std::sync::mpsc::channel::<PtyEvent>();
    let stop = Arc::new(AtomicBool::new(false));
    let thread_stop = stop.clone();

    // Seed the grid with what the session has already printed, before any live
    // chunk arrives. Attaching to an agent that has been working for an hour
    // should show the screen the user was looking at, not a correct and empty
    // terminal.
    if !seed.is_empty() {
        let _ = evt_tx.send(PtyEvent::Output(seed.into()));
    }

    std::thread::Builder::new()
        .name("aura-term-tap".to_string())
        .spawn(move || loop {
            match tap.recv_timeout(BRIDGE_POLL) {
                Ok(chunk) => {
                    if evt_tx.send(PtyEvent::Output(chunk.into())).is_err() {
                        return;
                    }
                }
                Err(RecvTimeoutError::Timeout) => {
                    if thread_stop.load(Ordering::Relaxed) {
                        return;
                    }
                }
                Err(RecvTimeoutError::Disconnected) => {
                    let _ = evt_tx.send(PtyEvent::Closed);
                    return;
                }
            }
        })
        .ok();

    (events, stop)
}

/// Attach a native GPU pane to an agent session's existing PTY.
///
/// Mirrors [`native_term_open`](super::native_term_open) except that the PTY
/// is not ours: no shell is spawned here, and closing the pane detaches rather
/// than killing the agent.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn native_term_attach(
    app: AppHandle,
    manager: State<'_, NativeTermManager>,
    term_id: String,
    session_id: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    scale: f64,
) -> Result<(), String> {
    // Idempotent, same as open: an existing pane just gets repositioned. No
    // clip — an attach only ever carries the hole, and the reconcile that
    // called it sends the current clip in its own `set_bounds` immediately
    // after, so a terminal is never left painting under an open overlay for
    // longer than that one call.
    if manager.terms.lock().unwrap().contains_key(&term_id) {
        return super::native_term_set_bounds(
            app, manager, term_id, x, y, width, height, scale, None,
        );
    }

    // Fail before building a GPU surface for a session that isn't there, so
    // the frontend can fall back to xterm instead of showing a blank hole.
    {
        let registry = app.state::<AgentPtyRegistry>();
        if !registry.has_session(&session_id) {
            return Err(format!("unknown session: {session_id}"));
        }
    }

    let Prepared {
        surface,
        view,
        config,
        renderer,
        font_px,
        device,
        queue,
        cols,
        rows,
        cell_w: _,
        cell_h: _,
    } = super::prepare(&app, &manager, x, y, width, height, scale).await?;

    let seed = {
        let registry = app.state::<AgentPtyRegistry>();
        crate::cmd_agent_pty::session_raw_tail(&registry, &session_id)
    };
    let (events, tap_stop) = spawn_tap_bridge(&session_id, seed);

    // Match the agent's PTY to the pane we just sized. The session may have
    // been shaped by a webview pane of a different size, or by none at all.
    {
        let registry = app.state::<AgentPtyRegistry>();
        let _ = crate::cmd_agent_pty::resize_session_pty(&registry, &session_id, cols, rows).await;
    }

    let sink = AgentSink {
        tx: spawn_input_forwarder(app.clone(), session_id.clone()),
    };

    let mut grid = GridTerminal::with_palette(cols, rows, manager.appearance.get().palette);
    grid.set_focused(true);

    let (ctrl_tx, ctrl_rx) = std::sync::mpsc::channel::<Ctrl>();
    let thread_app = app.clone();
    let thread_id = term_id.clone();
    std::thread::Builder::new()
        .name(format!("aura-term-{term_id}"))
        .spawn(move || {
            super::render_loop(
                thread_app,
                thread_id,
                surface,
                device,
                queue,
                renderer,
                font_px,
                grid,
                Box::new(sink),
                events,
                ctrl_rx,
                config,
            );
        })
        .map_err(|e| e.to_string())?;

    // The surface takes the scroll wheel itself, so it needs a way back to
    // this render thread.
    #[cfg(target_os = "macos")]
    super::wheel::register(view, ctrl_tx.clone());

    let displaced = manager.terms.lock().unwrap().insert(
        term_id,
        TermControl {
            ctrl: ctrl_tx,
            view,
            tap_stop: Some(tap_stop),
        },
    );
    // A concurrent attach for the same pane got here first. Its surface is
    // still in the window and the map no longer names it, so this is the last
    // chance anything has to take it down.
    if let Some(old) = displaced {
        super::retire(&app, old);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The sink's whole job is to hand input to the forwarder in the order it
    /// was typed. Drive it without a Tauri app behind it and read the queue.
    fn drain(rx: &mut tokio::sync::mpsc::UnboundedReceiver<AgentInput>) -> Vec<AgentInput> {
        let mut out = Vec::new();
        while let Ok(msg) = rx.try_recv() {
            out.push(msg);
        }
        out
    }

    #[test]
    fn keystrokes_queue_in_the_order_they_were_typed() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let mut sink = AgentSink { tx };
        for b in [b"l".as_slice(), b"s", b"\r"] {
            sink.write(b);
        }
        let got: Vec<Vec<u8>> = drain(&mut rx)
            .into_iter()
            .filter_map(|m| match m {
                AgentInput::Write(b) => Some(b),
                _ => None,
            })
            .collect();
        assert_eq!(got, vec![b"l".to_vec(), b"s".to_vec(), b"\r".to_vec()]);
    }

    #[test]
    fn bytes_reach_the_queue_unaltered() {
        // Terminal input is not text: a paste can carry invalid UTF-8 and an
        // escape sequence can be split across chunks.
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let mut sink = AgentSink { tx };
        let raw = vec![0x1b, 0x5b, 0x41, 0xff, 0x00, 0xfe];
        sink.write(&raw);
        match drain(&mut rx).pop() {
            Some(AgentInput::Write(b)) => assert_eq!(b, raw),
            _ => panic!("expected a write"),
        }
    }

    #[test]
    fn resize_sends_cells_not_pixels() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let mut sink = AgentSink { tx };
        sink.resize(120, 40, 1440, 900);
        match drain(&mut rx).pop() {
            Some(AgentInput::Resize { cols, rows }) => {
                assert_eq!((cols, rows), (120, 40));
            }
            _ => panic!("expected a resize"),
        }
    }

    #[test]
    fn a_dead_forwarder_does_not_panic_the_render_thread() {
        // The render loop calls write() on every keystroke and has nothing to
        // do with the result; dropping the receiver must not take it down.
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let mut sink = AgentSink { tx };
        drop(rx);
        sink.write(b"after the session died");
        sink.resize(80, 24, 0, 0);
    }

    #[test]
    fn the_bridge_seeds_the_grid_with_prior_output_before_anything_live() {
        let (events, stop) = spawn_tap_bridge("attach-test-seed", b"welcome back\r\n".to_vec());
        match events.recv_timeout(Duration::from_secs(1)) {
            Ok(PtyEvent::Output(b)) => assert_eq!(&b[..], b"welcome back\r\n"),
            other => panic!("expected the seed first, got {other:?}"),
        }
        stop.store(true, Ordering::Relaxed);
    }

    #[test]
    fn live_chunks_reach_the_loop_after_the_seed() {
        let sid = "attach-test-live";
        let (events, stop) = spawn_tap_bridge(sid, Vec::new());
        crate::agent_pty_tap::publish(sid, b"tokens");
        match events.recv_timeout(Duration::from_secs(1)) {
            Ok(PtyEvent::Output(b)) => assert_eq!(&b[..], b"tokens"),
            other => panic!("expected the published chunk, got {other:?}"),
        }
        stop.store(true, Ordering::Relaxed);
    }

    #[test]
    fn raising_the_stop_flag_ends_the_bridge() {
        let sid = "attach-test-stop";
        let (events, stop) = spawn_tap_bridge(sid, Vec::new());
        stop.store(true, Ordering::Relaxed);
        // Once the thread is gone its sender is dropped, so the receiver
        // disconnects. Poll rather than sleep: the thread wakes on its own
        // schedule and the point is that it eventually does.
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            match events.recv_timeout(Duration::from_millis(100)) {
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                _ if std::time::Instant::now() > deadline => {
                    panic!("bridge still running after the stop flag was raised")
                }
                _ => {}
            }
        }
    }
}
