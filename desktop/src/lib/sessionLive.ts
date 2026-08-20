// Session Live plane — the client the rest of the app talks to.
//
// This module is the front door: it owns the Tauri event listeners and the
// per-session `SessionLiveClient`, and it re-exports the wire vocabulary
// (`./sessionLiveFrames`), the parsers (`./sessionLiveParse`) and the command
// wrappers (`./sessionLiveCommands`) so every consumer keeps one import path.
//
// Three rules the plane enforces, all of them visible here:
//   1. Unknown frames and unknown enum values are absorbed, never thrown on —
//      old clients must survive new frames.
//   2. `seq` is server-assigned and monotonic; we dedupe on it because the
//      Rust connection replays from its last seq after every reconnect.
//   3. Nothing throws at the caller. A dead cloud surfaces as a status event
//      and an error string, not as a crashed panel.
//
// Reconnect deliberately does NOT live here. `conn.rs` owns dial, backoff and
// `?since=<seq>` replay; a second retry loop in the renderer would race it
// into two sockets. The renderer's job is to reflect `session-live:status`.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import {
  SESSION_LIVE_COMMANDS,
  bothCases,
  errText,
  fetchSessionTunnels,
} from "./sessionLiveCommands";
import {
  isObj,
  parseServerFrame,
  parseSessionLiveInfo,
  parseStatusEvent,
  parseTunnel,
} from "./sessionLiveParse";
import type {
  AccessLevel,
  ImpactSeverity,
  MsgIntent,
  ParticipantRole,
  ParticipantState,
  SessionLiveInfo,
  SessionLiveRef,
  SessionLiveServerFrame,
  SessionLiveStatusEvent,
  SessionTunnel,
} from "./sessionLiveFrames";

// One import path for the whole plane: the split below is about file size and
// testability, not about making callers learn four module names.
export * from "./sessionLiveFrames";
export * from "./sessionLiveParse";
export * from "./sessionLiveCommands";

// ── Wiring constants ─────────────────────────────────────────────────────
//
// Confirmed against `cmd_session_live/mod.rs` (`EV_*` consts).

/** Tauri event names. Each frame type gets its own topic and the payload is
 *  the frame WITHOUT its `type` field, plus `session_id` folded in by
 *  `emit_scoped` — the topics are global, so every listener filters. */
export const SESSION_LIVE_EVENTS = {
  STATUS: "session-live:status",
  READY: "session-live:ready",
  PRESENCE: "session-live:presence",
  TRANSCRIPT: "session-live:transcript",
  MSG: "session-live:msg",
  IMPACT: "session-live:impact",
  TYPING: "session-live:typing",
  CURSOR: "session-live:cursor",
  HOST: "session-live:host",
  ERROR: "session-live:error",
} as const;

// ── Client ───────────────────────────────────────────────────────────────

export type SendMessageOptions = {
  text: string;
  /** Recipient participant id, or null/omitted for the whole room. */
  to?: string | null;
  intent?: MsgIntent;
  refs?: SessionLiveRef[];
  replyTo?: string | null;
};

export type SessionLiveClientOptions = {
  /** The session's `external_id` — same identifier `/sessions/{id}/messages`
   *  uses. */
  sessionId: string;
  role: ParticipantRole;
  onFrame: (frame: SessionLiveServerFrame) => void;
  onStatus?: (ev: SessionLiveStatusEvent) => void;
  /** A command refused, or the socket could not be opened. Always a string a
   *  person can read — the Rust side writes them that way. */
  onError?: (message: string) => void;
};

/**
 * One live session, driven over Tauri. `connect()` shares (host) or joins
 * (guest); `sendMessage` is the addressable `msg` path and the rest are the
 * small typed commands the desktop exposes.
 *
 * Listeners attach before the connect command runs, so the burst of history
 * frames the server sends on join cannot land before we are listening.
 */
export class SessionLiveClient {
  readonly sessionId: string;
  readonly role: ParticipantRole;
  private readonly onFrame: (frame: SessionLiveServerFrame) => void;
  private readonly onStatus: ((ev: SessionLiveStatusEvent) => void) | null;
  private readonly onError: ((message: string) => void) | null;

  private unlisteners: UnlistenFn[] = [];
  private lastSeqValue = 0;
  private seen = new Set<number>();
  private disposed = false;
  /** Bumped on every attach so a listener whose `await` resolved after a
   *  teardown self-cleans instead of installing a zombie (same discipline as
   *  agentStreamStore's `gen`). */
  private gen = 0;

  constructor(opts: SessionLiveClientOptions) {
    this.sessionId = opts.sessionId;
    this.role = opts.role;
    this.onFrame = opts.onFrame;
    this.onStatus = opts.onStatus ?? null;
    this.onError = opts.onError ?? null;
  }

  /** Highest server-assigned seq seen. The Rust side keeps its own copy for
   *  `?since=`; this one is what makes our dedupe cheap. */
  get lastSeq(): number {
    return this.lastSeqValue;
  }

  /**
   * Open the session. `target` may be a session id or a share link — the
   * desktop parses both — and defaults to `sessionId`. Returns null when the
   * command refused (not signed in, not a member, session unknown); the
   * message goes to `onError`.
   *
   * `defaultAccess` is the host's answer to "what does someone get when they
   * walk in", and it has to travel on this call: the desktop's share command
   * mints the link, so a level chosen after the fact would be a level the
   * first joiner never saw.
   */
  async connect(
    target?: string,
    defaultAccess?: AccessLevel,
  ): Promise<SessionLiveInfo | null> {
    if (this.disposed) return null;
    await this.attach();
    if (this.disposed) return null;
    try {
      const res =
        this.role === "host"
          ? await invoke<unknown>(
              SESSION_LIVE_COMMANDS.share,
              bothCases({
                sessionId: this.sessionId,
                defaultAccess: defaultAccess ?? null,
              }),
            )
          : await invoke<unknown>(
              SESSION_LIVE_COMMANDS.join,
              bothCases({ target: target ?? this.sessionId }),
            );
      return parseSessionLiveInfo(res);
    } catch (e) {
      this.fail(errText(e));
      return null;
    }
  }

  /**
   * The addressable message — the one frame behind every pairing. `to` is a
   * participant id (a human, my agent, or a peer's agent) or null for the
   * room. False means it did not go out; the reason went to `onError`.
   */
  sendMessage(opts: SendMessageOptions): Promise<boolean> {
    return this.run(
      SESSION_LIVE_COMMANDS.send,
      bothCases({
        sessionId: this.sessionId,
        text: opts.text,
        to: opts.to ?? null,
        intent: opts.intent ?? "chat",
        refs: opts.refs ?? [],
        replyTo: opts.replyTo ?? null,
      }),
    );
  }

  setTyping(on: boolean): Promise<boolean> {
    return this.run(
      SESSION_LIVE_COMMANDS.typing,
      bothCases({ sessionId: this.sessionId, on }),
    );
  }

  sendCursor(file: string, line: number): Promise<boolean> {
    return this.run(
      SESSION_LIVE_COMMANDS.cursor,
      bothCases({ sessionId: this.sessionId, file, line }),
    );
  }

  /** Set what the sidebar renders next to our avatar. */
  setPresenceState(state: ParticipantState): Promise<boolean> {
    return this.run(
      SESSION_LIVE_COMMANDS.setState,
      bothCases({ sessionId: this.sessionId, presenceState: state }),
    );
  }

  /** Raise a collision into the session the moment it is noticed, rather than
   *  waiting for the next radar poll. */
  raiseImpact(opts: {
    symbol: string;
    file: string;
    severity?: ImpactSeverity;
  }): Promise<boolean> {
    return this.run(
      SESSION_LIVE_COMMANDS.impact,
      bothCases({
        sessionId: this.sessionId,
        symbol: opts.symbol,
        file: opts.file,
        severity: opts.severity ?? "likely",
      }),
    );
  }

  /** Share a local port with the room. Null when the open was refused. */
  async openTunnel(port: number, label?: string): Promise<SessionTunnel | null> {
    try {
      const res = await invoke<unknown>(
        SESSION_LIVE_COMMANDS.tunnelOpen,
        bothCases({ sessionId: this.sessionId, port, label: label ?? null }),
      );
      return parseTunnel(res, Math.floor(Date.now() / 1000));
    } catch (e) {
      this.fail(errText(e));
      return null;
    }
  }

  closeTunnel(code: string): Promise<boolean> {
    return this.run(
      SESSION_LIVE_COMMANDS.tunnelClose,
      bothCases({ sessionId: this.sessionId, code }),
    );
  }

  /** Null means the desktop could not be asked — distinct from `[]`, which
   *  means nothing is open. */
  listTunnels(): Promise<SessionTunnel[] | null> {
    return fetchSessionTunnels(this.sessionId, (m) => this.fail(m));
  }

  /** Leave for good. Idempotent; the client is unusable afterwards. */
  async leave(): Promise<void> {
    if (this.disposed) {
      this.detach();
      return;
    }
    this.disposed = true;
    try {
      await invoke(
        SESSION_LIVE_COMMANDS.leave,
        bothCases({ sessionId: this.sessionId }),
      );
    } catch {
      // Leaving twice, or leaving while the app is closing, is not an error
      // worth showing anyone — the desktop says so too.
    }
    this.detach();
  }

  private async run(
    command: string,
    args: Record<string, unknown>,
  ): Promise<boolean> {
    if (this.disposed) return false;
    try {
      await invoke(command, args);
      return true;
    } catch (e) {
      this.fail(errText(e));
      return false;
    }
  }

  private fail(message: string): void {
    if (!this.onError) return;
    try {
      this.onError(message);
    } catch (e) {
      console.warn("sessionLive.onError threw", e);
    }
  }

  private dispatch(frame: SessionLiveServerFrame): void {
    // `transcript` and `msg` share one server-assigned monotonic counter, so
    // one seen-set covers both. The Rust connection replays from its last seq
    // on every reconnect, which is exactly when the overlap happens.
    if (frame.type === "transcript" || frame.type === "msg") {
      if (frame.seq > 0) {
        if (this.seen.has(frame.seq)) return;
        this.seen.add(frame.seq);
        if (this.seen.size > SEEN_SEQ_CAP) this.trimSeen();
        if (frame.seq > this.lastSeqValue) this.lastSeqValue = frame.seq;
      }
    }
    try {
      this.onFrame(frame);
    } catch (e) {
      console.warn("sessionLive.onFrame threw", e);
    }
  }

  private trimSeen(): void {
    // Sets iterate in insertion order — drop the oldest half in one pass.
    let drop = this.seen.size - SEEN_SEQ_CAP / 2;
    for (const s of this.seen) {
      if (drop-- <= 0) break;
      this.seen.delete(s);
    }
  }

  /** The topics are global, so every payload is checked against our id first;
   *  the frame type comes from the topic and is stamped back on. */
  private accept(type: SessionLiveServerFrame["type"], payload: unknown): void {
    if (this.disposed) return;
    if (!isObj(payload)) return;
    const sessionId =
      typeof payload.session_id === "string" ? payload.session_id : "";
    if (sessionId !== this.sessionId) return;
    const frame = parseServerFrame({ ...payload, type });
    if (frame) this.dispatch(frame);
  }

  private acceptStatus(payload: unknown): void {
    if (this.disposed || !this.onStatus) return;
    const ev = parseStatusEvent(payload);
    if (!ev || ev.session_id !== this.sessionId) return;
    try {
      this.onStatus(ev);
    } catch (e) {
      console.warn("sessionLive.onStatus threw", e);
    }
  }

  private async attach(): Promise<void> {
    this.detach();
    if (this.disposed) return;
    this.gen += 1;
    const gen = this.gen;
    const installed: UnlistenFn[] = [];
    const frameTopics: ReadonlyArray<
      [string, SessionLiveServerFrame["type"]]
    > = [
      [SESSION_LIVE_EVENTS.READY, "ready"],
      [SESSION_LIVE_EVENTS.PRESENCE, "presence"],
      [SESSION_LIVE_EVENTS.TRANSCRIPT, "transcript"],
      [SESSION_LIVE_EVENTS.MSG, "msg"],
      [SESSION_LIVE_EVENTS.IMPACT, "impact"],
      [SESSION_LIVE_EVENTS.TYPING, "typing"],
      [SESSION_LIVE_EVENTS.CURSOR, "cursor"],
      [SESSION_LIVE_EVENTS.HOST, "host"],
      [SESSION_LIVE_EVENTS.ERROR, "error"],
    ];
    try {
      for (const [topic, type] of frameTopics) {
        installed.push(
          await listen<unknown>(topic, (e) => this.accept(type, e.payload)),
        );
      }
      installed.push(
        await listen<unknown>(SESSION_LIVE_EVENTS.STATUS, (e) =>
          this.acceptStatus(e.payload),
        ),
      );
    } catch (e) {
      for (const un of installed) un();
      this.fail(errText(e));
      return;
    }
    if (this.gen !== gen || this.disposed) {
      for (const un of installed) un();
      return;
    }
    this.unlisteners = installed;
  }

  private detach(): void {
    this.gen += 1;
    const list = this.unlisteners;
    this.unlisteners = [];
    for (const un of list) {
      try {
        un();
      } catch {
        // A listener torn down twice (double leave) is not an error.
      }
    }
  }
}

/** Bound on the dedupe window. The desktop replays from its last seq, so we
 *  only need enough memory to absorb a re-delivered burst. */
const SEEN_SEQ_CAP = 4000;
