// Pages real-time collab provider (plan 20, v0.2.37).
//
// Wires a Y.Doc to the room-scoped CRDT endpoints in aura-cloud
// (src/pages_collab.rs). One provider instance = one (roomId, pageId)
// pair = one Y.Doc.
//
// Offline-first binding contract (the load-bearing rule):
//   The Y.Doc + Awareness are LOCAL objects — they exist the instant the
//   provider is constructed, with NO network needed. Only the room id +
//   device id (which resolve async via Tauri) are needed to open the
//   socket. So construction is split from connection:
//     • new PagesProvider({ authorHandle, authorColor }) — synchronous;
//       the doc is immediately usable for editing (solo / offline).
//     • provider.connect({ roomId, pageId, deviceId }) — called once
//       identity resolves; opens the socket + starts syncing.
//   This lets the editor bind Collaboration to the doc on its FIRST mount
//   (collab is never null-then-flips), which is what keeps the caret from
//   jumping to doc-end and keystrokes from being dropped when a late
//   provider would otherwise rebind an empty Y.Doc under the editor.
//
// Lifecycle:
//   1. createPagesProvider({authorHandle, authorColor}) mints a Y.Doc +
//      Awareness synchronously — editable at once, before any network.
//   2. connect({roomId, pageId, deviceId}) → bootstrap() hydrates from
//      GET /state (snapshot) + GET /ops?since=N, then opens the socket.
//   3. The WebSocket to /api/v1/room/{roomId}/ws filters PageOp frames
//      whose page_id matches.
//   4. Local Y.Doc 'update' events POST to /op (debounced merge).
//   5. destroy() closes WS, removes update listener, destroys Y.Doc.
//
// Origin tagging is how we avoid self-echo loops: every applyUpdate on
// the doc uses the provider instance as the origin tag, so the update
// listener can `if (origin === this) return` to skip remote-applied
// changes (which we already saw on the server side).
//
// Bandwidth: local updates are merged via Y.mergeUpdates over a 60ms
// window, then base64-encoded and POSTed. The server fans them back via
// the room hub; CRDT idempotency means re-applying our own bytes is a
// no-op even if we didn't filter, but the origin tag still saves the
// listener round-trip.

import * as Y from "yjs";
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from "y-protocols/awareness";
import { roomAuthHeaders, roomTokenParam } from "./roomAuth";

const CLOUD_ORIGIN = "https://auravcs.com";
const CLOUD_WS_ORIGIN = "wss://auravcs.com";
const PUSH_DEBOUNCE_MS = 60;
// Presence frames (cursor moves) coalesce over this window so dragging a
// selection emits one frame per ~80ms instead of one per pointer event.
const PRESENCE_DEBOUNCE_MS = 80;
// Ceiling for the push retry backoff — mirrors RECONNECT_MAX_MS so a
// persistently-failing push (e.g. an expired token → 403) settles into an
// occasional retry instead of hammering the server every PUSH_DEBOUNCE_MS.
const PUSH_MAX_BACKOFF_MS = 15_000;
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 15_000;

function b64encode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function b64decode(s: string): Uint8Array {
  const binary = atob(s);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Construction-time identity — known synchronously the instant a page opens
 *  (it's just the local user's handle + cursor colour), so the provider can be
 *  minted before the room/device lookups resolve. The Y.Doc + Awareness are
 *  built from this alone and are immediately editable. */
export type PagesProviderInit = {
  /** Human-readable handle used to label remote cursors and stamp ops. */
  authorHandle: string;
  /** Stable cursor colour for this user — derived shell-side via
   *  hashHandleToColor(handle). */
  authorColor: string;
};

/** Connection-time coordinates — resolved async (Tauri device lookups) and
 *  handed to connect() once available. Until then the doc edits locally. */
export type PagesConnectOptions = {
  /** Repo-derived room id (see cmd_device::room_id_for_repo). */
  roomId: string;
  /** Stable page identifier — scope|bucket|uuid from notes_* commands. */
  pageId: string;
  /** Per-install device id (cmd_device::device_identity). Stamped on every
   *  presence frame so the socket can drop self-echoes — the awareness
   *  protocol carries its own clientID per peer, but the room hub fans our
   *  own frame back to us and applying it would resurrect a ghost caret. */
  deviceId: string;
};

/** Back-compat alias: the full option bag accepted by the one-shot
 *  createPagesConnectedProvider helper (init + connect coordinates). */
export type PagesProviderOptions = PagesProviderInit & PagesConnectOptions;

export type PagesProviderStatus =
  | "idle"
  | "bootstrapping"
  | "connected"
  | "reconnecting"
  | "destroyed";

type StatusListener = (s: PagesProviderStatus) => void;

export class PagesProvider {
  readonly doc: Y.Doc;
  readonly awareness: Awareness;
  /** Construction-time identity (authorHandle / authorColor). Available
   *  synchronously; read by TiptapEditor to label the local caret. */
  readonly options: PagesProviderInit;

  // Connection coordinates — null until connect() runs (room/device resolve
  // async). The doc is fully editable before these land; they only gate the
  // network (bootstrap + socket), never local editing.
  private roomId: string | null = null;
  private pageId: string | null = null;
  private deviceId: string | null = null;
  private connectStarted = false;
  // True once bootstrap() has run (server snapshot + ops drained), OR once the
  // provider is declared solo (no room will ever connect). Until this flips the
  // seed-once consumer must NOT write local markdown into the doc — doing so
  // before bootstrap would duplicate content that the server already holds.
  private bootstrapped = false;
  private syncedListeners = new Set<() => void>();

  private status: PagesProviderStatus = "idle";
  private statusListeners = new Set<StatusListener>();
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;
  private serverCursor = 0;
  private pendingUpdates: Uint8Array[] = [];
  private pushTimer: ReturnType<typeof setTimeout> | null = null;
  private inflight = false;
  // Consecutive push failures — drives an exponential backoff on the retry
  // so a persistent error doesn't spin the flush loop every PUSH_DEBOUNCE_MS.
  // Reset to 0 on the first successful push.
  private pushFailures = 0;
  // Presence (cursor) coalescing — a single rAF-like timer batches the burst
  // of awareness `update` events that fire while a user drags a selection
  // into one socket frame (~80ms), so we don't flood the hub per keystroke.
  private presenceTimer: ReturnType<typeof setTimeout> | null = null;
  private presenceDirty = false;

  constructor(init: PagesProviderInit) {
    this.options = init;
    this.doc = new Y.Doc();
    this.awareness = new Awareness(this.doc);
    this.awareness.setLocalStateField("user", {
      name: init.authorHandle,
      color: init.authorColor,
    });
    this.doc.on("update", this.handleLocalUpdate);
    // Presence: CollaborationCaret's yCursorPlugin writes the local caret
    // into awareness (`cursor` field, a JSON-encoded Y.RelativePosition) and
    // renders remote carets from awareness.getStates(). All we have to do is
    // get awareness updates across the wire — encode every local awareness
    // change and ship it over the same room socket, and apply inbound peer
    // updates. Relative positions survive concurrent edits, so carets don't
    // drift; the protocol's own per-client clock + 30s outdated-timeout
    // expires peers who went away (see Awareness._checkInterval).
    this.awareness.on("update", this.handleAwarenessUpdate);
  }

  onStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    listener(this.status);
    return () => this.statusListeners.delete(listener);
  }

  getStatus(): PagesProviderStatus {
    return this.status;
  }

  /** Whether the doc has been reconciled with the server (or declared solo).
   *  The seed-once consumer waits for this before writing local markdown so it
   *  never duplicates content the server already holds. */
  isSynced(): boolean {
    return this.bootstrapped;
  }

  /** Run `cb` once the doc is synced (bootstrap done OR solo). Fires
   *  immediately if already synced. Returns an unsubscribe. */
  onSynced(cb: () => void): () => void {
    if (this.bootstrapped) {
      cb();
      return () => {};
    }
    this.syncedListeners.add(cb);
    return () => this.syncedListeners.delete(cb);
  }

  /** Declare that no room connection will ever come (solo repo / offline /
   *  device lookup failed). Flips the synced gate so the seed-once consumer can
   *  hydrate the local doc from saved markdown — there's no server to conflict
   *  with. No-op if connect() already ran. */
  markSolo(): void {
    if (this.connectStarted || this.destroyed) return;
    this.markSynced();
  }

  private markSynced(): void {
    if (this.bootstrapped) return;
    this.bootstrapped = true;
    const listeners = Array.from(this.syncedListeners);
    this.syncedListeners.clear();
    listeners.forEach((cb) => {
      try {
        cb();
      } catch (err) {
        console.warn("[pages_collab] synced listener threw", err);
      }
    });
  }

  /** Open the network side once the room + device coordinates resolve. Safe to
   *  call exactly once; further calls are ignored. Until this runs the doc
   *  edits locally and presence/op pushes simply queue (flushed on connect).
   *  The doc is never rebound here — Collaboration is already bound to it from
   *  the editor's first mount; connect() only attaches the transport. */
  async connect(opts: PagesConnectOptions): Promise<void> {
    if (this.destroyed || this.connectStarted) return;
    this.connectStarted = true;
    this.roomId = opts.roomId;
    this.pageId = opts.pageId;
    this.deviceId = opts.deviceId;
    this.setStatus("bootstrapping");
    try {
      await this.bootstrap();
    } catch (err) {
      console.warn("[pages_collab] bootstrap failed", err);
    }
    if (this.destroyed) return;
    // Server snapshot + ops are now applied (or the fetch failed and we move on
    // either way). The doc reflects whatever the server holds, so it's now safe
    // for the seed-once consumer to hydrate from local markdown if still empty.
    this.markSynced();
    void this.openSocket();
    // Anything the user typed before the socket opened is sitting in
    // pendingUpdates — kick a flush so their offline edits sync up.
    if (this.pendingUpdates.length > 0 && !this.pushTimer && !this.inflight) {
      this.pushTimer = setTimeout(() => {
        this.pushTimer = null;
        void this.flushPush();
      }, PUSH_DEBOUNCE_MS);
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.setStatus("destroyed");
    this.syncedListeners.clear();
    this.doc.off("update", this.handleLocalUpdate);
    this.awareness.off("update", this.handleAwarenessUpdate);
    if (this.presenceTimer) {
      clearTimeout(this.presenceTimer);
      this.presenceTimer = null;
    }
    // Tell peers our caret is gone before we drop the socket. Clearing the
    // local awareness state emits a removal `update` for our clientID; encode
    // + push it synchronously while the socket is still open so peers don't
    // have to wait out the 30s outdated-timeout to lose our label.
    try {
      const removal = encodeAwarenessUpdate(this.awareness, [
        this.awareness.clientID,
      ]);
      removeAwarenessStates(this.awareness, [this.awareness.clientID], "local");
      this.sendPresenceBytes(removal);
    } catch {
      /* best-effort goodbye */
    }
    if (this.pushTimer) {
      clearTimeout(this.pushTimer);
      this.pushTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* noop */
      }
      this.ws = null;
    }
    this.awareness.destroy();
    this.doc.destroy();
  }

  /** Editor → provider glue (TiptapEditor selectionUpdate). CollaborationCaret
   *  already mirrors the live selection into awareness's `cursor` field, which
   *  is what actually renders remote carets. This records a coarse `selection`
   *  field alongside it for non-caret presence consumers (peer lists, "who's
   *  here" chips) and to make the local awareness state explicit even when the
   *  editor isn't focused. No-op once destroyed. */
  setLocalSelection(anchor: number, head: number): void {
    if (this.destroyed) return;
    this.awareness.setLocalStateField("selection", { anchor, head });
  }

  private setStatus(s: PagesProviderStatus) {
    if (this.status === s) return;
    this.status = s;
    this.statusListeners.forEach((l) => l(s));
  }

  private async bootstrap(): Promise<void> {
    const { roomId, pageId } = this;
    if (!roomId || !pageId) return;
    const base = `${CLOUD_ORIGIN}/api/v1/room/${encodeURIComponent(roomId)}/pages/${encodeURIComponent(pageId)}`;
    // Attach the cloud bearer so these room reads pass membership checks once
    // AURA_ROOMS_REQUIRE_AUTH is on; empty headers when signed out (legacy).
    const authHeaders = await roomAuthHeaders();

    const stateRes = await fetch(`${base}/state`, { headers: authHeaders });
    if (stateRes.ok) {
      const stateJson = (await stateRes.json()) as {
        snapshot_b64: string | null;
        up_to_op_id: number;
      };
      if (stateJson.snapshot_b64) {
        Y.applyUpdate(this.doc, b64decode(stateJson.snapshot_b64), this);
      }
      this.serverCursor = stateJson.up_to_op_id || 0;
    }

    const opsRes = await fetch(`${base}/ops?since=${this.serverCursor}&limit=5000`, {
      headers: authHeaders,
    });
    if (opsRes.ok) {
      const opsJson = (await opsRes.json()) as {
        ops: Array<{ op_id: number; update_b64: string }>;
        cursor: number;
      };
      for (const op of opsJson.ops) {
        Y.applyUpdate(this.doc, b64decode(op.update_b64), this);
      }
      if (opsJson.cursor > this.serverCursor) {
        this.serverCursor = opsJson.cursor;
      }
    }
  }

  private async openSocket(): Promise<void> {
    if (this.destroyed) return;
    const { roomId } = this;
    if (!roomId) return;
    // Cloud bearer as ?token= so the socket authenticates once the server
    // enforces membership; empty when signed out (legacy anonymous path).
    const tok = await roomTokenParam();
    if (this.destroyed) return;
    const url = `${CLOUD_WS_ORIGIN}/api/v1/room/${encodeURIComponent(roomId)}/ws${
      tok ? `?${tok}` : ""
    }`;
    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch (err) {
      console.warn("[pages_collab] socket construct failed", err);
      this.scheduleReconnect();
      return;
    }
    this.ws = socket;

    socket.onopen = () => {
      if (this.destroyed) return;
      this.reconnectAttempts = 0;
      this.setStatus("connected");
      // Soft catch-up: refetch ops > serverCursor to plug any gap that
      // formed while the socket was down. Skip on first open since
      // bootstrap() already drained the backlog.
      if (this.serverCursor > 0) {
        this.catchUp().catch((e) =>
          console.warn("[pages_collab] catch-up failed", e),
        );
      }
      // Announce our caret on (re)connect so peers already in the room learn
      // about us — awareness `update` events only fire on change, so a fresh
      // socket would otherwise be invisible until our next selection move.
      this.broadcastLocalPresence();
    };

    socket.onmessage = (ev) => {
      if (this.destroyed) return;
      let frame: unknown;
      try {
        frame = JSON.parse(typeof ev.data === "string" ? ev.data : "");
      } catch {
        return;
      }
      if (!frame || typeof frame !== "object" || !("kind" in frame)) {
        return;
      }
      const kind = (frame as { kind: string }).kind;
      // Presence rides ALONGSIDE the document-sync path on the same socket.
      // Apply a peer's awareness update (their caret/selection) into our local
      // Awareness; CollaborationCaret's yCursorPlugin renders it. Self-echoes
      // (our own frame fanned back by the hub) are dropped by device_id —
      // applying our own bytes would otherwise spawn a duplicate ghost caret.
      if (kind === "page_presence") {
        const p = frame as {
          kind: "page_presence";
          page_id: string;
          device_id: string;
          update_b64: string;
        };
        if (p.page_id !== this.pageId) return;
        if (p.device_id === this.deviceId) return;
        try {
          applyAwarenessUpdate(this.awareness, b64decode(p.update_b64), this);
        } catch (err) {
          console.warn("[pages_collab] presence apply failed", err);
        }
        return;
      }
      if (kind !== "page_op") return;
      const f = frame as {
        kind: "page_op";
        page_id: string;
        op_id: number;
        update_b64: string;
      };
      if (f.page_id !== this.pageId) return;
      if (f.op_id <= this.serverCursor) return;
      Y.applyUpdate(this.doc, b64decode(f.update_b64), this);
      this.serverCursor = f.op_id;
    };

    socket.onclose = () => {
      if (this.destroyed) return;
      this.ws = null;
      this.scheduleReconnect();
    };

    socket.onerror = () => {
      // onclose fires after error; let the reconnect logic run there.
    };
  }

  private scheduleReconnect(): void {
    if (this.destroyed) return;
    this.setStatus("reconnecting");
    if (this.reconnectTimer) return;
    const attempt = this.reconnectAttempts++;
    const delay = Math.min(
      RECONNECT_BASE_MS * 2 ** attempt,
      RECONNECT_MAX_MS,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.openSocket();
    }, delay);
  }

  private async catchUp(): Promise<void> {
    const { roomId, pageId } = this;
    if (!roomId || !pageId) return;
    const url = `${CLOUD_ORIGIN}/api/v1/room/${encodeURIComponent(roomId)}/pages/${encodeURIComponent(pageId)}/ops?since=${this.serverCursor}&limit=5000`;
    const res = await fetch(url, { headers: await roomAuthHeaders() });
    if (!res.ok) return;
    const json = (await res.json()) as {
      ops: Array<{ op_id: number; update_b64: string }>;
      cursor: number;
    };
    for (const op of json.ops) {
      if (op.op_id <= this.serverCursor) continue;
      Y.applyUpdate(this.doc, b64decode(op.update_b64), this);
      this.serverCursor = op.op_id;
    }
    if (json.cursor > this.serverCursor) this.serverCursor = json.cursor;
  }

  private handleLocalUpdate = (update: Uint8Array, origin: unknown) => {
    // Updates we applied ourselves (bootstrap, ops pull, WS frames) carry
    // `this` as origin. Anything else is a real local edit that must be
    // pushed to the server.
    if (origin === this) return;
    if (this.destroyed) return;
    this.pendingUpdates.push(update);
    if (this.pushTimer) return;
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null;
      void this.flushPush();
    }, PUSH_DEBOUNCE_MS);
  };

  // Awareness changed. Skip remote-applied changes (origin === this) — those
  // came in over the wire and re-broadcasting them would echo-loop. Anything
  // else is a local cursor/selection move; coalesce the burst and push our
  // full local awareness state so every peer (including ones who just joined)
  // converges on the same caret position.
  private handleAwarenessUpdate = (
    _changes: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => {
    if (this.destroyed) return;
    if (origin === this) return;
    this.presenceDirty = true;
    if (this.presenceTimer) return;
    this.presenceTimer = setTimeout(() => {
      this.presenceTimer = null;
      if (!this.presenceDirty) return;
      this.presenceDirty = false;
      this.broadcastLocalPresence();
    }, PRESENCE_DEBOUNCE_MS);
  };

  /** Encode + send our own awareness state over the room socket. */
  private broadcastLocalPresence(): void {
    if (this.destroyed) return;
    try {
      const bytes = encodeAwarenessUpdate(this.awareness, [
        this.awareness.clientID,
      ]);
      this.sendPresenceBytes(bytes);
    } catch (err) {
      console.warn("[pages_collab] presence encode failed", err);
    }
  }

  /** Wrap awareness bytes in a PagePresence frame and ship them down the
   *  socket. Presence is ephemeral — if the socket is mid-reconnect we just
   *  drop the frame; the next selection move (or the reconnect snapshot) will
   *  re-publish our caret. */
  private sendPresenceBytes(bytes: Uint8Array): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (!this.pageId || !this.deviceId) return;
    try {
      ws.send(
        JSON.stringify({
          kind: "page_presence",
          page_id: this.pageId,
          device_id: this.deviceId,
          update_b64: b64encode(bytes),
        }),
      );
    } catch (err) {
      console.warn("[pages_collab] presence send failed", err);
    }
  }

  private async flushPush(): Promise<void> {
    if (this.destroyed) return;
    // Not connected yet (offline-first): keep the user's edits queued — they
    // flush once connect() resolves the room. Local editing is unaffected.
    if (!this.roomId || !this.pageId) return;
    if (this.inflight) {
      // Another flush is in-flight; let it pick up the queue on completion.
      if (!this.pushTimer && this.pendingUpdates.length > 0) {
        this.pushTimer = setTimeout(() => {
          this.pushTimer = null;
          void this.flushPush();
        }, PUSH_DEBOUNCE_MS);
      }
      return;
    }
    const updates = this.pendingUpdates.splice(0);
    if (updates.length === 0) return;
    const merged =
      updates.length === 1 ? updates[0] : Y.mergeUpdates(updates);
    const stateVector = Y.encodeStateVector(this.doc);
    const { roomId, pageId } = this;
    const { authorHandle } = this.options;
    if (!roomId || !pageId) {
      // Connection torn down mid-flush — re-queue and bail; reconnect retries.
      this.pendingUpdates.unshift(merged);
      return;
    }
    const url = `${CLOUD_ORIGIN}/api/v1/room/${encodeURIComponent(roomId)}/pages/${encodeURIComponent(pageId)}/op`;
    this.inflight = true;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(await roomAuthHeaders()),
        },
        body: JSON.stringify({
          update_b64: b64encode(merged),
          state_vector_b64: b64encode(stateVector),
          author_handle: authorHandle,
        }),
      });
      if (res.ok) {
        const json = (await res.json()) as { op_id: number };
        if (json.op_id > this.serverCursor) this.serverCursor = json.op_id;
        this.pushFailures = 0;
      } else {
        // Re-queue so the next flush retries (with backoff below).
        this.pendingUpdates.unshift(merged);
        this.pushFailures++;
        console.warn("[pages_collab] push failed", res.status);
      }
    } catch (err) {
      this.pendingUpdates.unshift(merged);
      this.pushFailures++;
      console.warn("[pages_collab] push errored", err);
    } finally {
      this.inflight = false;
      if (this.pendingUpdates.length > 0 && !this.pushTimer) {
        // Happy path stays at PUSH_DEBOUNCE_MS (success reset pushFailures);
        // consecutive failures back off exponentially up to the ceiling.
        const delay =
          this.pushFailures > 0
            ? Math.min(
                PUSH_DEBOUNCE_MS * 2 ** this.pushFailures,
                PUSH_MAX_BACKOFF_MS,
              )
            : PUSH_DEBOUNCE_MS;
        this.pushTimer = setTimeout(() => {
          this.pushTimer = null;
          void this.flushPush();
        }, delay);
      }
    }
  }
}

/** Stable per-handle pastel colour for remote cursors. Mirrors the
 *  12-stop palette Notionless uses (cursor-color-1..12). Hashing the
 *  handle keeps the same person showing up in the same colour every
 *  time anyone opens a page they've touched. */
export function hashHandleToColor(handle: string): string {
  const palette = [
    "#ef4444", "#f97316", "#f59e0b", "#eab308",
    "#84cc16", "#22c55e", "#10b981", "#06b6d4",
    "#3b82f6", "#6366f1", "#a855f7", "#ec4899",
  ];
  let hash = 0;
  for (let i = 0; i < handle.length; i++) {
    hash = (hash * 31 + handle.charCodeAt(i)) | 0;
  }
  return palette[Math.abs(hash) % palette.length];
}

/** Mint a provider SYNCHRONOUSLY from the local identity alone. The returned
 *  Y.Doc is immediately editable; the caller resolves the room/device async
 *  and then calls provider.connect({roomId, pageId, deviceId}) to go live.
 *  This is the binding-correct path: the editor mounts with a non-null collab
 *  from the first render, so Collaboration binds to a stable doc and the caret
 *  never jumps / keystrokes are never dropped by a late rebind. */
export function createPagesProvider(init: PagesProviderInit): PagesProvider {
  return new PagesProvider(init);
}

/** One-shot convenience: construct AND connect in a single call when the room
 *  + device coordinates are already known up front. Most surfaces should prefer
 *  createPagesProvider(init) + a later connect(...) so the editor can bind
 *  before identity resolves, but this keeps the old single-call shape available
 *  for contexts that genuinely have everything synchronously. */
export function createPagesConnectedProvider(
  opts: PagesProviderOptions,
): PagesProvider {
  const provider = new PagesProvider({
    authorHandle: opts.authorHandle,
    authorColor: opts.authorColor,
  });
  void provider.connect({
    roomId: opts.roomId,
    pageId: opts.pageId,
    deviceId: opts.deviceId,
  });
  return provider;
}
