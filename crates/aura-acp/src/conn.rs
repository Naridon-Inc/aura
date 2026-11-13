//! One JSON-RPC connection to an ACP agent.
//!
//! The byte pipe is pluggable: a prepared `tokio::process::Command` (local
//! agents), or any `AsyncRead`/`AsyncWrite` pair (an ssh attach to a box, a
//! test duplex). A connection opened `resumable` survives the pipe dropping:
//! pending requests stay parked, outgoing frames queue, and `reattach*`
//! resumes from a byte offset. Lines already consumed are skipped on replay,
//! so a relay that re-streams its log from an earlier offset is harmless.

use crate::rpc::{self, Frame, RpcError};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot, watch};

#[derive(Debug, Clone, Copy, Default)]
pub struct ConnOpts {
    /// Keep pending requests across a dropped pipe and accept `reattach*`.
    pub resumable: bool,
}

/// Something the agent sent that the caller has to look at.
#[derive(Debug, Clone, PartialEq)]
pub enum Inbound {
    /// Agent → client request. Answer with [`Connection::respond`].
    Request { id: Value, method: String, params: Value, offset: u64 },
    Notification { method: String, params: Value, offset: u64 },
    /// A stderr line, or a stdout line that is not JSON-RPC.
    Diagnostic(String),
    /// Resumable pipe dropped; waiting for `reattach*`.
    Detached,
    /// The connection is over. Every pending request has failed.
    Closed(String),
}

impl Inbound {
    /// The stream byte offset this item started at, when it came off stdout.
    pub fn offset(&self) -> Option<u64> {
        match self {
            Inbound::Request { offset, .. } | Inbound::Notification { offset, .. } => Some(*offset),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkState {
    Attached,
    Detached,
    Closed,
}

type Writer = Box<dyn AsyncWrite + Send + Unpin>;
type Pending = HashMap<u64, oneshot::Sender<Result<Value, RpcError>>>;

struct Inner {
    resumable: bool,
    writer: tokio::sync::Mutex<Option<Writer>>,
    backlog: Mutex<Vec<Vec<u8>>>,
    pending: Mutex<Pending>,
    next_id: AtomicU64,
    inbound: mpsc::UnboundedSender<Inbound>,
    state: watch::Sender<LinkState>,
    seen_end: AtomicU64,
    generation: AtomicU64,
    child: Mutex<Option<Child>>,
}

/// Cheap to clone; every clone drives the same connection.
#[derive(Clone)]
pub struct Connection {
    inner: Arc<Inner>,
}

pub type InboundRx = mpsc::UnboundedReceiver<Inbound>;

impl Connection {
    /// Spawn a prepared command and speak ACP over its stdio. Stdio is set
    /// to piped and `kill_on_drop` on; env, cwd and process group stay the
    /// caller's.
    pub fn spawn(cmd: Command, opts: ConnOpts) -> std::io::Result<(Connection, InboundRx)> {
        let (conn, rx) = Self::detached(opts);
        conn.attach_command(cmd, 0)?;
        Ok((conn, rx))
    }

    /// Speak ACP over any byte pipe.
    pub fn over<R, W>(reader: R, writer: W, opts: ConnOpts) -> (Connection, InboundRx)
    where
        R: AsyncRead + Unpin + Send + 'static,
        W: AsyncWrite + Unpin + Send + 'static,
    {
        Self::over_at(reader, writer, 0, opts)
    }

    /// Like [`over`](Self::over), with `reader` positioned `start_offset`
    /// bytes into the agent's output stream (a relay log resumed mid-way).
    pub fn over_at<R, W>(reader: R, writer: W, start_offset: u64, opts: ConnOpts) -> (Connection, InboundRx)
    where
        R: AsyncRead + Unpin + Send + 'static,
        W: AsyncWrite + Unpin + Send + 'static,
    {
        let (conn, rx) = Self::detached(opts);
        conn.inner.seen_end.store(start_offset, Ordering::SeqCst);
        conn.attach_io(Box::new(writer), reader, start_offset);
        (conn, rx)
    }

    fn detached(opts: ConnOpts) -> (Connection, InboundRx) {
        let (tx, rx) = mpsc::unbounded_channel();
        let (state, _) = watch::channel(LinkState::Detached);
        let inner = Inner {
            resumable: opts.resumable,
            writer: tokio::sync::Mutex::new(None),
            backlog: Mutex::new(Vec::new()),
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(0),
            inbound: tx,
            state,
            seen_end: AtomicU64::new(0),
            generation: AtomicU64::new(0),
            child: Mutex::new(None),
        };
        (Connection { inner: Arc::new(inner) }, rx)
    }

    fn attach_command(&self, mut cmd: Command, start_offset: u64) -> std::io::Result<()> {
        cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
        let mut child = cmd.spawn()?;
        let stdin = child.stdin.take().ok_or_else(|| std::io::Error::other("agent has no stdin"))?;
        let stdout = child.stdout.take().ok_or_else(|| std::io::Error::other("agent has no stdout"))?;
        if let Some(stderr) = child.stderr.take() {
            let tx = self.inner.inbound.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let _ = tx.send(Inbound::Diagnostic(line));
                }
            });
        }
        if let Ok(mut slot) = self.inner.child.lock() {
            *slot = Some(child);
        }
        self.attach_io(Box::new(stdin), stdout, start_offset);
        Ok(())
    }

    fn attach_io<R>(&self, writer: Writer, reader: R, start_offset: u64)
    where
        R: AsyncRead + Unpin + Send + 'static,
    {
        let generation = self.inner.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let inner = self.inner.clone();
        tokio::spawn(async move {
            {
                let mut slot = inner.writer.lock().await;
                let mut w = writer;
                let backlog = std::mem::take(&mut *inner.backlog.lock().unwrap_or_else(|p| p.into_inner()));
                for bytes in backlog {
                    if w.write_all(&bytes).await.is_err() {
                        break;
                    }
                }
                let _ = w.flush().await;
                *slot = Some(w);
            }
            inner.state.send_replace(LinkState::Attached);
            read_loop(inner, reader, start_offset, generation).await;
        });
    }

    /// Resume a resumable connection over a fresh pipe positioned at
    /// `start_offset` in the agent's output stream.
    pub fn reattach_at<R, W>(&self, reader: R, writer: W, start_offset: u64) -> Result<(), RpcError>
    where
        R: AsyncRead + Unpin + Send + 'static,
        W: AsyncWrite + Unpin + Send + 'static,
    {
        self.check_reattach()?;
        self.attach_io(Box::new(writer), reader, start_offset);
        Ok(())
    }

    /// Resume a resumable connection by spawning `cmd` (for example an ssh
    /// attach that streams the agent's log from `start_offset`).
    pub fn reattach_command(&self, cmd: Command, start_offset: u64) -> Result<(), RpcError> {
        self.check_reattach()?;
        self.attach_command(cmd, start_offset).map_err(|e| RpcError::internal(format!("reattach failed: {e}")))
    }

    fn check_reattach(&self) -> Result<(), RpcError> {
        if !self.inner.resumable {
            return Err(RpcError::internal("connection is not resumable"));
        }
        if self.state() == LinkState::Closed {
            return Err(RpcError::disconnected());
        }
        Ok(())
    }

    pub fn state(&self) -> LinkState {
        *self.inner.state.borrow()
    }

    pub fn watch_state(&self) -> watch::Receiver<LinkState> {
        self.inner.state.subscribe()
    }

    /// Byte offset just past the last line consumed from the agent. A
    /// resumable relay reattaches here.
    pub fn last_offset(&self) -> u64 {
        self.inner.seen_end.load(Ordering::SeqCst)
    }

    pub fn child_id(&self) -> Option<u32> {
        self.inner.child.lock().ok().and_then(|c| c.as_ref().and_then(Child::id))
    }

    /// Send a request and wait for its response. Dropping the future
    /// before it resolves sends `$/cancel_request` for it.
    pub async fn request(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        let id = self.inner.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        if let Ok(mut p) = self.inner.pending.lock() {
            p.insert(id, tx);
        }
        if self.state() == LinkState::Closed {
            self.take_pending(id);
            return Err(RpcError::disconnected());
        }
        let mut guard = CancelGuard { conn: self.clone(), id, armed: true };
        if let Err(e) = self.send(&rpc::request_frame(id, method, params)).await {
            guard.armed = false;
            self.take_pending(id);
            return Err(e);
        }
        let out = rx.await.unwrap_or_else(|_| Err(RpcError::disconnected()));
        guard.armed = false;
        out
    }

    pub async fn notify(&self, method: &str, params: Value) -> Result<(), RpcError> {
        self.send(&rpc::notification_frame(method, params)).await
    }

    /// Answer an agent → client request.
    pub async fn respond(&self, id: &Value, result: Result<Value, RpcError>) -> Result<(), RpcError> {
        self.send(&rpc::response_frame(id, &result)).await
    }

    /// End the connection: kill a spawned agent and fail everything pending.
    pub fn close(&self, reason: &str) {
        if let Ok(mut c) = self.inner.child.lock() {
            if let Some(child) = c.as_mut() {
                let _ = child.start_kill();
            }
        }
        close_inner(&self.inner, reason);
    }

    fn take_pending(&self, id: u64) -> Option<oneshot::Sender<Result<Value, RpcError>>> {
        self.inner.pending.lock().ok().and_then(|mut p| p.remove(&id))
    }

    async fn send(&self, frame: &Value) -> Result<(), RpcError> {
        let mut bytes = serde_json::to_vec(frame).map_err(|e| RpcError::internal(e.to_string()))?;
        bytes.push(b'\n');
        let mut slot = self.inner.writer.lock().await;
        if let Some(w) = slot.as_mut() {
            let ok = w.write_all(&bytes).await.is_ok() && w.flush().await.is_ok();
            if ok {
                return Ok(());
            }
            *slot = None;
            if !self.inner.resumable {
                drop(slot);
                close_inner(&self.inner, "agent input closed");
                return Err(RpcError::disconnected());
            }
        }
        if self.state() == LinkState::Closed {
            return Err(RpcError::disconnected());
        }
        // No pipe yet (attach still installing it) or a resumable pipe is
        // down: queue under the writer lock so the attach flushes it in order.
        if let Ok(mut b) = self.inner.backlog.lock() {
            b.push(bytes);
        }
        Ok(())
    }
}

/// Removes a request from `pending` and tells the agent to stop working on
/// it when the awaiting future is dropped early (stable ACP request
/// cancellation, `$/cancel_request`).
struct CancelGuard {
    conn: Connection,
    id: u64,
    armed: bool,
}

impl Drop for CancelGuard {
    fn drop(&mut self) {
        if !self.armed || self.conn.take_pending(self.id).is_none() {
            return;
        }
        let conn = self.conn.clone();
        let id = self.id;
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(async move {
                let _ = conn.notify("$/cancel_request", json!({"requestId": id})).await;
            });
        }
    }
}

async fn read_loop<R: AsyncRead + Unpin>(inner: Arc<Inner>, reader: R, start: u64, generation: u64) {
    let mut reader = BufReader::new(reader);
    let mut pos = start;
    let mut buf = Vec::with_capacity(4096);
    loop {
        buf.clear();
        let n = match reader.read_until(b'\n', &mut buf).await {
            Ok(n) => n,
            Err(_) => 0,
        };
        if n == 0 {
            break;
        }
        let line_start = pos;
        pos += n as u64;
        if inner.generation.load(Ordering::SeqCst) != generation {
            return;
        }
        if line_start < inner.seen_end.load(Ordering::SeqCst) {
            continue;
        }
        inner.seen_end.store(pos, Ordering::SeqCst);
        dispatch(&inner, &buf, line_start);
    }
    if inner.generation.load(Ordering::SeqCst) != generation {
        return;
    }
    *inner.writer.lock().await = None;
    if inner.resumable && *inner.state.borrow() != LinkState::Closed {
        inner.state.send_replace(LinkState::Detached);
        let _ = inner.inbound.send(Inbound::Detached);
    } else {
        close_inner(&inner, "agent closed the connection");
    }
}

fn dispatch(inner: &Inner, line: &[u8], offset: u64) {
    let text = String::from_utf8_lossy(line);
    let text = text.trim();
    if text.is_empty() {
        return;
    }
    let Some(frame) = serde_json::from_str::<Value>(text).ok().and_then(rpc::classify) else {
        let _ = inner.inbound.send(Inbound::Diagnostic(text.to_string()));
        return;
    };
    match frame {
        Frame::Response { id, result } => {
            let waiter = id.as_u64().and_then(|id| inner.pending.lock().ok().and_then(|mut p| p.remove(&id)));
            if let Some(tx) = waiter {
                let _ = tx.send(result);
            }
        }
        Frame::Request { id, method, params } => {
            let _ = inner.inbound.send(Inbound::Request { id, method, params, offset });
        }
        Frame::Notification { method, params } => {
            let _ = inner.inbound.send(Inbound::Notification { method, params, offset });
        }
    }
}

fn close_inner(inner: &Inner, reason: &str) {
    if inner.state.send_replace(LinkState::Closed) == LinkState::Closed {
        return;
    }
    let drained: Vec<_> = inner.pending.lock().map(|mut p| p.drain().map(|(_, tx)| tx).collect()).unwrap_or_default();
    for tx in drained {
        let _ = tx.send(Err(RpcError::disconnected()));
    }
    let _ = inner.inbound.send(Inbound::Closed(reason.to_string()));
}
