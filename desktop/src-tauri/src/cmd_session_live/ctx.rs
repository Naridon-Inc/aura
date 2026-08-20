//! `ConnCtx` — the shared state of one live session, and the two questions the
//! rest of the plane keeps asking it:
//!
//!   * **"is this agent mine?"** (`hosts_agent`) — only an agent running on this
//!     desktop may be injected into.
//!   * **"may this person drive?"** (`may_drive`) — only a `drive` participant's
//!     text may reach a PTY.
//!
//! Both gates live here rather than at the call site because they are the two
//! checks that decide whether text somebody else typed gets executed on this
//! machine, and a check that is easy to forget is a check that will be.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Listener};
use tokio::sync::mpsc;

use super::protocol::{
    declared_access, Author, ClientFrame, Identity, Participant, ACCESS_DRIVE, ACCESS_WATCH,
};

/// How long an injected guest message stays matchable against the transcript
/// echo it will produce. Long enough for the agent's JSONL to be tailed
/// (500ms poll) and re-published, short enough that two identical messages
/// minutes apart cannot cross-attribute.
const INJECTION_TTL: Duration = Duration::from_secs(120);
const INJECTION_CAP: usize = 64;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Role {
    Host,
    Guest,
}

impl Role {
    pub fn as_str(self) -> &'static str {
        match self {
            Role::Host => "host",
            Role::Guest => "guest",
        }
    }
}

/// What this desktop knows about the session's share. `url` always has a value
/// so the UI has something to render; `code` is `Some` only once the cloud has
/// actually minted one.
#[derive(Clone, Debug, Default)]
pub struct ShareState {
    pub url: String,
    pub code: Option<String>,
    /// The level the session was shared with — the level a new joiner gets.
    pub default_access: String,
}

#[derive(Clone, Debug)]
pub struct TunnelRecord {
    pub code: String,
    pub url: String,
    pub port: u16,
    pub label: String,
}

/// Everything one live session connection needs, shared by the pump task, the
/// transcript listener, the impact watcher and the tunnel proxy.
pub struct ConnCtx {
    pub app: AppHandle,
    /// The cloud's session identifier — the same id `/api/v2/sessions/{id}/
    /// messages` uses, which on this desktop is the PTY session id.
    pub external_id: String,
    pub role: Role,
    pub origin: String,
    pub token: String,
    /// Local PTY session to inject inbound `msg` frames into. `Some` in host
    /// mode when the session is a live agent PTY; `None` for a guest, or for a
    /// host sharing a session with no running PTY behind it.
    pub agent_session_id: Option<String>,
    pub repo_root: Option<String>,
    /// The agent this desktop runs, if any — declared in `hello.agents`.
    pub agent_identity: Option<Identity>,

    share: StdMutex<ShareState>,
    out: mpsc::UnboundedSender<ClientFrame>,
    connected: AtomicBool,
    stopped: AtomicBool,
    /// Set when the server answers our `role:"host"` claim with a demotion.
    /// A demoted host must not inject, must not publish transcript, and must
    /// not serve tunnels — it is a guest that asked for too much.
    demoted: AtomicBool,
    last_seq: AtomicU64,
    host_online: AtomicBool,

    me: StdMutex<Option<Participant>>,
    presence: StdMutex<HashMap<String, Participant>>,
    /// Agent participant ids the server confirmed belong to this desktop.
    claimed_agents: StdMutex<HashSet<String>>,
    /// Ports this desktop explicitly opened for tunnelling. The ONLY ports a
    /// `tunnel_req` may reach. Nothing else, and never another host.
    pub open_ports: StdMutex<HashSet<u16>>,
    /// tunnel code -> loopback port, so a `tunnel_req` carrying only a code
    /// still resolves without guessing.
    pub tunnels: StdMutex<HashMap<String, TunnelRecord>>,
    /// Text we pushed into the local agent on someone else's behalf, so the
    /// transcript echo it produces can be attributed to them instead of to the
    /// person sitting at this keyboard.
    injections: StdMutex<VecDeque<(String, Author, Instant)>>,
    /// Tauri event listener ids to release on leave.
    pub listeners: StdMutex<Vec<tauri::EventId>>,
    presence_state: StdMutex<String>,
}

impl ConnCtx {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        app: AppHandle,
        external_id: String,
        role: Role,
        origin: String,
        token: String,
        share: ShareState,
        agent_session_id: Option<String>,
        repo_root: Option<String>,
        agent_identity: Option<Identity>,
        out: mpsc::UnboundedSender<ClientFrame>,
    ) -> Self {
        Self {
            app,
            external_id,
            role,
            origin,
            token,
            agent_session_id,
            repo_root,
            agent_identity,
            share: StdMutex::new(share),
            out,
            connected: AtomicBool::new(false),
            stopped: AtomicBool::new(false),
            demoted: AtomicBool::new(false),
            last_seq: AtomicU64::new(0),
            host_online: AtomicBool::new(false),
            me: StdMutex::new(None),
            presence: StdMutex::new(HashMap::new()),
            claimed_agents: StdMutex::new(HashSet::new()),
            open_ports: StdMutex::new(HashSet::new()),
            tunnels: StdMutex::new(HashMap::new()),
            injections: StdMutex::new(VecDeque::new()),
            listeners: StdMutex::new(Vec::new()),
            presence_state: StdMutex::new("watching".to_string()),
        }
    }

    /// Queue a frame for the socket. Never blocks and never fails loudly: the
    /// queue outlives a reconnect, so a frame written during a blip is sent
    /// when the socket comes back rather than lost.
    pub fn send(&self, frame: ClientFrame) {
        if self.stopped.load(Ordering::Relaxed) {
            return;
        }
        let _ = self.out.send(frame);
    }

    pub fn stop(&self) {
        self.stopped.store(true, Ordering::Relaxed);
    }

    pub fn stopped(&self) -> bool {
        self.stopped.load(Ordering::Relaxed)
    }

    pub fn connected(&self) -> bool {
        self.connected.load(Ordering::Relaxed)
    }

    pub fn set_connected(&self, on: bool) {
        self.connected.store(on, Ordering::Relaxed);
    }

    pub fn host_online(&self) -> bool {
        self.host_online.load(Ordering::Relaxed)
    }

    pub fn set_host_online(&self, on: bool) {
        self.host_online.store(on, Ordering::Relaxed);
    }

    pub fn demote(&self) {
        self.demoted.store(true, Ordering::Relaxed);
    }

    /// True when this desktop is the session's host *and* the server accepted
    /// the claim. A demoted host is a guest in every respect.
    pub fn is_host(&self) -> bool {
        self.role == Role::Host && !self.demoted.load(Ordering::Relaxed)
    }

    pub fn effective_role(&self) -> &'static str {
        if self.is_host() {
            "host"
        } else {
            "guest"
        }
    }

    // ── share state ────────────────────────────────────────────────────────

    pub fn share_url(&self) -> String {
        self.share.lock().map(|g| g.url.clone()).unwrap_or_default()
    }

    pub fn share_code(&self) -> Option<String> {
        self.share.lock().ok().and_then(|g| g.code.clone())
    }

    pub fn default_access(&self) -> String {
        self.share
            .lock()
            .map(|g| g.default_access.clone())
            .unwrap_or_default()
    }

    pub fn set_share(&self, next: ShareState) {
        if let Ok(mut g) = self.share.lock() {
            *g = next;
        }
    }

    /// Forget the share without touching the socket: people already here stay,
    /// the link stops admitting anyone new.
    pub fn clear_share_code(&self) {
        if let Ok(mut g) = self.share.lock() {
            g.code = None;
        }
    }

    // ── participants ───────────────────────────────────────────────────────

    pub fn participant_id(&self) -> Option<String> {
        self.me
            .lock()
            .ok()
            .and_then(|g| g.as_ref().map(|p| p.id.clone()))
    }

    pub fn me(&self) -> Option<Participant> {
        self.me.lock().ok().and_then(|g| g.clone())
    }

    pub fn set_me(&self, p: Participant) {
        if let Ok(mut g) = self.me.lock() {
            *g = Some(p);
        }
    }

    pub fn participants(&self) -> Vec<Participant> {
        self.presence
            .lock()
            .map(|g| g.values().cloned().collect())
            .unwrap_or_default()
    }

    pub fn replace_presence(&self, participants: &[Participant]) {
        if let Ok(mut g) = self.presence.lock() {
            g.clear();
            for p in participants {
                g.insert(p.id.clone(), p.clone());
            }
        }
        // Our own record is part of the roster; keeping the cached copy in step
        // means a promotion that arrives as a `presence` — which is how the doc
        // says it arrives — is reflected in `my_access` without a reconnect.
        if let Some(mine) = self.participant_id() {
            if let Some(p) = participants.iter().find(|p| p.id == mine) {
                self.set_me(p.clone());
            }
        }
    }

    pub fn claim_agents(&self, ids: &[String]) {
        if let Ok(mut g) = self.claimed_agents.lock() {
            for id in ids {
                g.insert(id.clone());
            }
        }
    }

    pub fn lookup(&self, id: &str) -> Option<Participant> {
        self.presence.lock().ok().and_then(|g| g.get(id).cloned())
    }

    // ── access ─────────────────────────────────────────────────────────────
    //
    // "May X drive?" is two different questions with two different right
    // answers when the server has not stamped `access` at all:
    //
    //   * *May someone else's text run on this machine?* — no. Getting that
    //     wrong is remote code execution on the user's laptop.
    //   * *May I type into my own composer?* — yes. Getting that wrong greys
    //     out a composer that would have worked, and the server is the
    //     authority anyway: it answers a refused `msg` with an `error` frame we
    //     already surface.
    //
    // So the inbound gate fails closed and the outbound one fails open. They
    // are separate methods rather than one with a flag, because the call sites
    // are the two most consequential in this module and a boolean argument is
    // the wrong place to encode that difference.

    /// What the server explicitly said about `id`, or `None` when it said
    /// nothing. Reported to the frontend as-is so it can apply its own rule
    /// rather than inheriting ours.
    pub fn declared_access_of(&self, id: &str) -> Option<&'static str> {
        self.lookup(id).as_ref().and_then(declared_access)
    }

    /// **Inbound gate.** May the participant `id` cause something to happen on
    /// this desktop? An id we have never seen in `presence` is not a
    /// participant, so it cannot drive.
    pub fn may_drive(&self, id: &str) -> bool {
        match self.lookup(id) {
            Some(p) => resolve_access_inbound(&p, self.is_host(), &self.default_access()) == ACCESS_DRIVE,
            None => false,
        }
    }

    /// **Outbound posture.** This desktop's own level, for the composer.
    ///
    /// Optimistic where the inbound gate is not: absent `access` reads as
    /// `drive`, so a cloud that has not shipped the field yet — which accepts
    /// `msg` from anyone — does not leave every guest staring at a disabled
    /// composer. Only an explicit `watch` disables one.
    pub fn my_access(&self) -> &'static str {
        if self.is_host() {
            return ACCESS_DRIVE;
        }
        match self.me().as_ref().and_then(declared_access) {
            Some(level) => level,
            None => ACCESS_DRIVE,
        }
    }

    // ── presence state ─────────────────────────────────────────────────────

    pub fn presence_state(&self) -> String {
        self.presence_state
            .lock()
            .map(|g| g.clone())
            .unwrap_or_else(|_| "idle".to_string())
    }

    pub fn set_presence_state(&self, s: &str) {
        if let Ok(mut g) = self.presence_state.lock() {
            *g = s.to_string();
        }
    }

    // ── injection attribution ──────────────────────────────────────────────

    /// Remember that `text` was pushed into the local agent on `author`'s
    /// behalf, so the transcript entry it produces carries their name.
    pub fn note_injection(&self, text: String, author: Author) {
        if let Ok(mut q) = self.injections.lock() {
            while q.len() >= INJECTION_CAP {
                q.pop_front();
            }
            q.push_back((text, author, Instant::now()));
        }
    }

    /// Claim back the author of an echoed prompt. Exact match only — a fuzzy
    /// match would mis-attribute one person's words to another, which is worse
    /// than showing no author at all.
    pub fn claim_injection(&self, text: &str) -> Option<Author> {
        let mut q = self.injections.lock().ok()?;
        let now = Instant::now();
        q.retain(|(_, _, at)| now.duration_since(*at) < INJECTION_TTL);
        let idx = q.iter().position(|(t, _, _)| t == text)?;
        q.remove(idx).map(|(_, a, _)| a)
    }

    /// Does the participant `to` name run on THIS desktop? Only then may an
    /// inbound `msg` be injected into a local agent.
    ///
    /// Three sources, most authoritative first:
    ///   1. `ready.your_agents` — the server told us outright.
    ///   2. our own participant record, when this socket connected *as* an
    ///      agent rather than as a person.
    ///   3. the `Participant` record itself: an agent whose `role` is "host"
    ///      is by construction the agent of the session's one host desktop, so
    ///      it is ours exactly when we are the host. A guest's agent carries
    ///      `role: "guest"` and is correctly excluded.
    pub fn hosts_agent(&self, to: &str) -> bool {
        if self
            .claimed_agents
            .lock()
            .map(|g| g.contains(to))
            .unwrap_or(false)
        {
            return true;
        }
        if let Some(p) = self.me() {
            if p.id == to && p.kind == "agent" {
                return true;
            }
        }
        if !self.is_host() {
            return false;
        }
        self.lookup(to)
            .map(|p| p.kind == "agent" && p.role == "host")
            .unwrap_or(false)
    }

    // ── emitting ───────────────────────────────────────────────────────────

    pub fn emit(&self, event: &str, payload: Value) {
        let _ = self.app.emit(event, payload);
    }

    /// Re-emit a server frame verbatim on the raw-frame channels.
    ///
    /// The renderer's transport (`aura-shell/src/lib/sessionLive.ts`) parses
    /// whole server frames — `type` intact — rather than the per-kind channels
    /// below, and listens on both a per-session topic and a global fallback.
    /// Serving both costs one extra emit and means neither half has to guess
    /// what the other settled on. Payload is the `{session_id, frame}`
    /// envelope its `accept()` unwraps first.
    pub fn emit_raw_frame(&self, frame: &Value) {
        let payload = json!({ "session_id": self.external_id, "frame": frame });
        let _ = self.app.emit(
            &format!("{}{}", super::EV_FRAME_PREFIX, self.topic()),
            payload.clone(),
        );
        let _ = self.app.emit(super::EV_FRAME_ANY, payload);
    }

    /// Transport state for the renderer's status listeners. `status` is one of
    /// connecting / live / reconnecting / closed / error.
    pub fn emit_transport(&self, status: &str, detail: Option<String>) {
        let payload = json!({
            "session_id": self.external_id,
            "status":     status,
            "detail":     detail,
        });
        let _ = self.app.emit(
            &format!("{}{}", super::EV_STATUS_PREFIX, self.topic()),
            payload.clone(),
        );
        let _ = self.app.emit(super::EV_STATUS_ANY, payload);
    }

    /// Tauri rejects event names outside `[A-Za-z0-9/_:-]` and a session's
    /// external id is opaque, so the suffix is normalised the same way the
    /// renderer's `sessionLiveTopic()` does. The two must agree character for
    /// character or the listener silently never fires.
    pub fn topic(&self) -> String {
        self.external_id
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                    c
                } else {
                    '_'
                }
            })
            .collect()
    }

    /// Fold `session_id` into every payload so a frontend listening on the
    /// single global channel can route without a second subscription.
    pub fn emit_scoped(&self, event: &str, mut payload: Value) {
        if let Some(obj) = payload.as_object_mut() {
            obj.insert(
                "session_id".to_string(),
                Value::String(self.external_id.clone()),
            );
        }
        self.emit(event, payload);
    }

    pub fn emit_status(&self, error: Option<String>) {
        self.emit(
            super::EV_STATUS,
            json!({
                "session_id":     self.external_id,
                "role":           self.effective_role(),
                "requested_role": self.role.as_str(),
                "connected":      self.connected(),
                "share_url":      self.share_url(),
                "share_code":     self.share_code(),
                "default_access": self.default_access(),
                "my_access":      self.my_access(),
                "participant_id": self.participant_id(),
                "host_online":    self.host_online(),
                "state":          self.presence_state(),
                "error":          error,
            }),
        );
    }

    // ── sequencing ─────────────────────────────────────────────────────────

    pub fn last_seq(&self) -> Option<u64> {
        match self.last_seq.load(Ordering::Relaxed) {
            0 => None,
            n => Some(n),
        }
    }

    pub fn bump_seq(&self, seq: Option<u64>) {
        if let Some(n) = seq {
            self.last_seq.fetch_max(n, Ordering::Relaxed);
        }
    }

    pub fn hello(&self) -> ClientFrame {
        ClientFrame::Hello {
            token: self.token.clone(),
            role: self.role.as_str(),
            as_who: super::local_identity(),
            agents: self.agent_identity.clone().into_iter().collect(),
            since: self.last_seq(),
        }
    }
}

/// The inbound access ladder, as a pure function.
///
/// Split out of `ConnCtx::may_drive` so the check that decides whether someone
/// else's text runs on this machine can be tested without an `AppHandle` — a
/// gate nobody can exercise in a test is a gate that quietly rots.
///
/// Order matters, and every step is a stated fact rather than a guess:
///   1. the `access` the server stamped on the record;
///   2. `role == "host"` — the doc says the host is always `drive` and cannot
///      be demoted;
///   3. the `default_access` *this* desktop chose when it shared the session.
///      Not a server assumption: it is the host's own policy, and it is what a
///      cloud that has not shipped `access` yet would have applied anyway. This
///      is the step that keeps a session deliberately shared as `drive` working
///      against an older cloud;
///   4. `watch`.
///
/// Step 4 is the important one. An unrecognised participant fails closed,
/// because the cost of being wrong in the other direction is a stranger's text
/// running inside an agent on this machine.
pub fn resolve_access_inbound(
    p: &Participant,
    viewer_is_host: bool,
    session_default: &str,
) -> &'static str {
    if let Some(explicit) = declared_access(p) {
        return explicit;
    }
    if p.role == "host" {
        return ACCESS_DRIVE;
    }
    if viewer_is_host && session_default == ACCESS_DRIVE {
        return ACCESS_DRIVE;
    }
    ACCESS_WATCH
}

/// Register a Tauri event listener and remember it so `leave` can release it.
pub fn track_listener<F>(ctx: &Arc<ConnCtx>, event: String, handler: F)
where
    F: Fn(tauri::Event) + Send + 'static,
{
    let id = ctx.app.listen(event, handler);
    if let Ok(mut g) = ctx.listeners.lock() {
        g.push(id);
    }
}

/// Release every listener this connection registered.
pub fn release_listeners(ctx: &Arc<ConnCtx>) {
    let ids = ctx
        .listeners
        .lock()
        .map(|mut g| g.drain(..).collect::<Vec<_>>())
        .unwrap_or_default();
    for id in ids {
        ctx.app.unlisten(id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn guest(access: &str) -> Participant {
        Participant {
            id: "p_1".into(),
            role: "guest".into(),
            access: access.into(),
            kind: "human".into(),
            ..Default::default()
        }
    }

    #[test]
    fn a_stated_level_wins_over_every_fallback() {
        assert_eq!(resolve_access_inbound(&guest("drive"), true, ACCESS_WATCH), "drive");
        // Even a session shared with `drive` cannot promote someone the server
        // explicitly marked `watch`.
        assert_eq!(resolve_access_inbound(&guest("watch"), true, ACCESS_DRIVE), "watch");
    }

    #[test]
    fn the_host_always_drives() {
        let mut host = guest("");
        host.role = "host".into();
        // True even when we are the guest looking at them, and even when the
        // session's default is `watch` — the doc says the host cannot be
        // demoted.
        assert_eq!(resolve_access_inbound(&host, false, ACCESS_WATCH), "drive");
    }

    #[test]
    fn an_unstamped_guest_falls_back_to_the_level_we_shared_with() {
        // Against a cloud that has not shipped `access` yet, the host's own
        // stated policy is the only honest source.
        assert_eq!(resolve_access_inbound(&guest(""), true, ACCESS_DRIVE), "drive");
        assert_eq!(resolve_access_inbound(&guest(""), true, ACCESS_WATCH), "watch");
    }

    #[test]
    fn the_outbound_posture_is_the_opposite_of_the_inbound_one() {
        // Same participant record, two different answers, on purpose. Absence
        // must not disable my own composer (the server is the authority on my
        // sends), and must not let a stranger's text run here.
        let unstamped = guest("");
        assert_eq!(declared_access(&unstamped), None);
        assert_eq!(resolve_access_inbound(&unstamped, false, ""), ACCESS_WATCH);
        // `my_access` reads the same absence as `drive` — see its doc comment.
        // Exercised here through the same `declared_access` it branches on.
        assert_eq!(
            declared_access(&guest("watch")),
            Some(ACCESS_WATCH),
            "an explicit watch is the only thing that disables a composer"
        );
        // A typo must not read as a stated level in either direction.
        assert_eq!(declared_access(&guest("Drive")), None);
        assert_eq!(declared_access(&guest("admin")), None);
    }

    #[test]
    fn an_unstamped_guest_fails_closed_when_we_are_not_the_host() {
        // A guest desktop has no idea what the host shared with, so it must not
        // assume. This is the case that would otherwise be remote code
        // execution on somebody else's laptop.
        assert_eq!(resolve_access_inbound(&guest(""), false, ACCESS_DRIVE), "watch");
        assert_eq!(resolve_access_inbound(&guest("nonsense"), false, ""), "watch");
    }
}
