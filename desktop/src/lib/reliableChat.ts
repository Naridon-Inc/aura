// Reliable-chat client primitives — Phase 1 of the chat overhaul.
//
// Goal: never silently drop a message. Three loose ends are tied off
// here that the existing CommsPanel code can't address on its own:
//   1. Optimistic local rows track a `delivery_status` ack that comes
//      from either the HTTP 2xx (via `chat_send` -> retry queue) or
//      the WS echo with a matching id.
//   2. A WebSocket auto-reconnect loop with exponential backoff up to
//      30s. On reconnect the socket replays everything past the last
//      seen `seq` (persisted in localStorage) so messages that arrived
//      while the socket was dead are not lost.
//   3. A small subscription protocol — `{type:"subscribe", room_id,
//      since_seq?}` — that the cloud uses to emit a `{type:"backfill",
//      messages:[...]}` envelope before resuming live frames.
//
// The CommsPanel rewrite (other agent) is expected to import
// `useReliableChat` and let it own the WS lifecycle + delivery state.
// Plain components can keep using the existing `api.chatList` / `api.chatSend`
// surface — this hook is additive.
//
// ── INTEGRATION (paste these into `aura-shell/src/lib/api.ts`) ────────
//
// Near the existing `chatThread` wrapper add:
//
//   chatOutboxStatus: (repoRoot: string, channel: string) =>
//     invoke<OutboxEntry[]>("chat_outbox_status", { repoRoot, channel }),
//   chatResend: (repoRoot: string, channel: string, msgId: string) =>
//     invoke<void>("chat_resend", { repoRoot, channel, msgId }),
//   chatSubscribeSince: (
//     repoRoot: string,
//     channel: string,
//     sinceSeq: number | null,
//   ) =>
//     invoke<ChatMessage[]>("chat_subscribe_since", {
//       repoRoot,
//       channel,
//       sinceSeq: sinceSeq ?? null,
//     }),
//   chatOutboxDrainKickoff: (repoRoot: string) =>
//     invoke<void>("chat_outbox_drain_kickoff", { repoRoot }),
//
// Extend the existing `ChatMessage` type with the two new fields:
//
//   delivery_status?: "pending" | "delivered" | "failed";
//   seq?: number;
//
// Add the new outbox type near `ChatSendArgs`:
//
//   export type OutboxEntry = {
//     msg_id: string;
//     channel: string;
//     attempts: number;
//     last_error?: string;
//     next_attempt_ts: number;
//     failed: boolean;
//   };
//
// ── INTEGRATION (paste into `aura-shell/src-tauri/src/lib.rs` invoke_handler) ─
//
//   cmd_team::chat_outbox_status,
//   cmd_team::chat_resend,
//   cmd_team::chat_subscribe_since,
//   cmd_team::chat_outbox_drain_kickoff,

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import { api, type ChatMessage, type ChatSendArgs } from "./api";
import { roomTokenParam } from "./roomAuth";

// Mirrors the Rust `OutboxEntry`. Repeated here so this file stays
// drop-in without waiting on the api.ts wrappers to land.
export type OutboxEntry = {
  msg_id: string;
  channel: string;
  attempts: number;
  last_error?: string;
  next_attempt_ts: number;
  failed: boolean;
};

export type WsState = "connecting" | "open" | "closed" | "backfilling";

// Local-only fields layered on top of the cloud ChatMessage. The cloud
// row never carries these; the hook adds them so the UI can render
// "retrying…" / "failed" badges without a second query.
export type ReliableChatMessage = ChatMessage & {
  delivery_status?: "pending" | "delivered" | "failed";
  seq?: number | null;
  retry_attempts?: number;
  retry_last_error?: string;
};

export type UseReliableChat = {
  messages: ReliableChatMessage[];
  send: (body: string, extra?: Partial<ChatSendArgs>) => Promise<{ ok: boolean; error?: string }>;
  retry: (msgId: string) => Promise<void>;
  wsState: WsState;
  /** Force a refresh from the file-backed JSONL + cloud catchup. */
  refresh: () => Promise<void>;
  /**
   * Emit a "read up to here" cursor for the active channel. Server upserts
   * into `chat_read_cursors` and rebroadcasts as `read_cursor_update` so
   * peers can render "Seen by" receipts. Pass the highest `seq` (or
   * timestamp fallback) the user has caught up to; the server clamps
   * monotonically so stale frames are no-ops.
   *
   * Hook callers should fire this on (a) window focus while the channel
   * is visible and (b) the message list being scrolled to the bottom.
   */
  emitReadCursor: (lastReadSeq: number) => void;
};

// localStorage key — scoped per (room, channel) so different repos and
// channels don't share a cursor. Persisted as the highest cloud-assigned
// seq the client has acked locally.
const lastSeqKey = (roomId: string, channel: string) =>
  `aura.chat.lastSeq.${roomId}.${channel}`;

function readLastSeq(roomId: string, channel: string): number | null {
  if (typeof window === "undefined") return null;
  try {
    const v = window.localStorage.getItem(lastSeqKey(roomId, channel));
    if (!v) return null;
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function writeLastSeq(roomId: string, channel: string, seq: number): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(lastSeqKey(roomId, channel), String(seq));
  } catch {
    /* quota or private mode — best-effort only */
  }
}

// Origin for the WebSocket — `wss://` for the public cloud, swap to
// `ws://localhost:3001` for local dev by setting AURA_LOCAL_CLOUD in
// the build env. Keeps the hook self-contained.
function wsOriginFor(): string {
  // Vite envs are inlined at build time. If unset we default to the
  // production cloud origin so the public app "just works".
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const env = (import.meta as any)?.env ?? {};
  const override = env.VITE_AURA_WS_ORIGIN ?? env.AURA_WS_ORIGIN;
  if (typeof override === "string" && override.length > 0) return override;
  return "wss://auravcs.com";
}

/**
 * useReliableChat — owns the WS lifecycle, optimistic delivery state,
 * outbox polling, and last-seq cursor for one (repoRoot, channel) pair.
 *
 * Re-entry: hot-swapping repoRoot/channel tears down the socket and
 * reinitialises from disk + cloud catchup. The hook is safe to mount
 * multiple times for different channels in the same component tree;
 * each instance owns its own socket.
 */
export function useReliableChat(
  repoRoot: string | null,
  channel: string,
): UseReliableChat {
  const [messages, setMessages] = useState<ReliableChatMessage[]>([]);
  const [wsState, setWsState] = useState<WsState>("connecting");

  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectAttemptRef = useRef(0);
  const cancelledRef = useRef(false);
  const outboxPollRef = useRef<number | null>(null);
  // Cache the resolved room_id so reconnects don't refetch it.
  const roomIdRef = useRef<string | null>(null);
  // Cached device identity used to stamp outbound read-cursor frames.
  // Resolved lazily on first emit (and on the connect path) so we never
  // block render on the Tauri command.
  const deviceRef = useRef<{ device_id: string; display: string } | null>(null);
  // Highest cursor we've sent for this (room, channel) — guards against
  // spamming the socket when focus + scroll fire back-to-back.
  const lastEmittedCursorRef = useRef<number>(0);

  // Merge a single message into local state, dedup by id, advance the
  // last-seq cursor when we observe a new high-water mark.
  const mergeMessage = useCallback(
    (incoming: ReliableChatMessage) => {
      const roomId = roomIdRef.current;
      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.id === incoming.id);
        if (idx >= 0) {
          // Existing row — patch in delivery_status / seq if cloud filled
          // them in. Don't overwrite a "delivered" with a "pending".
          const merged: ReliableChatMessage = { ...prev[idx] };
          if (incoming.seq != null && merged.seq == null) merged.seq = incoming.seq;
          if (
            incoming.delivery_status === "delivered" ||
            (incoming.delivery_status === "failed" && merged.delivery_status !== "delivered")
          ) {
            merged.delivery_status = incoming.delivery_status;
          }
          if (incoming.body && incoming.body !== merged.body) merged.body = incoming.body;
          const next = [...prev];
          next[idx] = merged;
          return next;
        }
        const next = [...prev, incoming].sort((a, b) => a.ts - b.ts);
        return next;
      });
      if (roomId && incoming.seq != null) {
        const cur = readLastSeq(roomId, channel) ?? 0;
        if (incoming.seq > cur) writeLastSeq(roomId, channel, incoming.seq);
      }
    },
    [channel],
  );

  const mergeMany = useCallback(
    (rows: ReliableChatMessage[]) => {
      for (const r of rows) mergeMessage(r);
    },
    [mergeMessage],
  );

  // Initial load: local JSONL + outbox status + cloud catchup. Runs on
  // mount and on (repoRoot, channel) change.
  const refresh = useCallback(async () => {
    if (!repoRoot || !channel) return;
    try {
      const local = await api.chatList(repoRoot, channel, undefined, 500);
      mergeMany(local as ReliableChatMessage[]);
    } catch {
      /* listing failure is non-fatal — WS will hydrate */
    }
    try {
      const outbox = await invoke<OutboxEntry[]>("chat_outbox_status", {
        repoRoot,
        channel,
      });
      // Stamp pending/failed state onto the local rows we already have.
      setMessages((prev) => {
        if (outbox.length === 0) return prev;
        const byId = new Map(outbox.map((e) => [e.msg_id, e]));
        return prev.map((m) => {
          const e = byId.get(m.id);
          if (!e) return m;
          return {
            ...m,
            delivery_status: e.failed ? "failed" : "pending",
            retry_attempts: e.attempts,
            retry_last_error: e.last_error,
          };
        });
      });
    } catch {
      /* outbox command might not be registered yet — non-fatal */
    }
  }, [channel, mergeMany, repoRoot]);

  // ── socket lifecycle ────────────────────────────────────────────────
  useEffect(() => {
    cancelledRef.current = false;
    if (!repoRoot || !channel) return;
    let closed = false;

    const clearReconnect = () => {
      if (reconnectTimerRef.current != null) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    };

    const scheduleReconnect = () => {
      if (cancelledRef.current) return;
      const attempt = reconnectAttemptRef.current;
      const delay = Math.min(30_000, 1_000 * Math.pow(2, attempt));
      reconnectAttemptRef.current = attempt + 1;
      clearReconnect();
      reconnectTimerRef.current = window.setTimeout(() => {
        reconnectTimerRef.current = null;
        connect();
      }, delay);
      setWsState("connecting");
    };

    const connect = async () => {
      if (cancelledRef.current) return;
      setWsState("connecting");
      let roomId = roomIdRef.current;
      if (!roomId) {
        try {
          roomId = await api.deviceRoomId(repoRoot);
          roomIdRef.current = roomId;
        } catch {
          scheduleReconnect();
          return;
        }
      }
      if (cancelledRef.current) return;

      const sinceSeq = readLastSeq(roomId, channel);

      // HTTP catchup runs BEFORE the socket opens so that even if the
      // WS upgrade fails we still surface anything new. This duplicates
      // a bit of work with the WS backfill (which the server emits on
      // subscribe) but the merge is id-keyed so the duplication is free.
      try {
        const catchup = await invoke<ChatMessage[]>("chat_subscribe_since", {
          repoRoot,
          channel,
          sinceSeq: sinceSeq ?? null,
        });
        if (catchup.length > 0) {
          setWsState("backfilling");
          mergeMany(catchup as ReliableChatMessage[]);
        }
      } catch {
        /* tolerate — WS backfill is the canonical path */
      }

      const origin = wsOriginFor();
      const q = sinceSeq != null ? `&since_seq=${encodeURIComponent(String(sinceSeq))}` : "";
      // Cloud bearer as ?token= so the socket authenticates once the server
      // enforces membership (AURA_ROOMS_REQUIRE_AUTH). URL already carries a
      // query (`?channel=`), so it joins with `&`; empty when signed out.
      const tok = await roomTokenParam();
      if (cancelledRef.current) return;
      const auth = tok ? `&${tok}` : "";
      const url = `${origin}/api/v1/room/${encodeURIComponent(roomId)}/ws?channel=${encodeURIComponent(channel)}${q}${auth}`;

      let socket: WebSocket;
      try {
        socket = new WebSocket(url);
      } catch {
        scheduleReconnect();
        return;
      }
      socketRef.current = socket;

      socket.onopen = () => {
        if (cancelledRef.current) {
          socket.close();
          return;
        }
        reconnectAttemptRef.current = 0;
        setWsState("open");
        // Belt-and-braces: also emit an explicit subscribe frame so
        // mid-life channel changes (without a full reconnect) still get
        // a backfill. The server honours either form.
        try {
          socket.send(
            JSON.stringify({
              type: "subscribe",
              room_id: roomId,
              channel,
              since_seq: sinceSeq,
            }),
          );
        } catch {
          /* socket might race-close; the onclose handler retries */
        }
      };

      socket.onmessage = (ev) => {
        if (typeof ev.data !== "string") return;
        let frame: unknown;
        try {
          frame = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (!frame || typeof frame !== "object") return;
        const obj = frame as Record<string, unknown>;
        const kind = (obj.kind as string) || (obj.type as string);
        if (kind === "ready") {
          // server hello — no-op
          return;
        }
        if (kind === "backfill" && Array.isArray(obj.messages)) {
          setWsState("backfilling");
          const rows = (obj.messages as Record<string, unknown>[])
            .map(normaliseCloudRow)
            .filter(Boolean) as ReliableChatMessage[];
          mergeMany(rows);
          setWsState("open");
          return;
        }
        if (kind === "msg" && obj.message && typeof obj.message === "object") {
          const norm = normaliseCloudRow(obj.message as Record<string, unknown>);
          if (norm) mergeMessage(norm);
        }
      };

      socket.onclose = () => {
        if (cancelledRef.current) return;
        setWsState("closed");
        scheduleReconnect();
      };

      socket.onerror = () => {
        /* onclose handles retry; nothing to do here */
      };
    };

    void refresh();
    void connect();

    // Outbox poll — every 2s while there's at least one pending entry.
    // The interval is cheap (file read) and gives the UI a fresh "retry
    // attempt 3/5" without needing a Tauri event channel.
    outboxPollRef.current = window.setInterval(() => {
      if (cancelledRef.current) return;
      invoke<OutboxEntry[]>("chat_outbox_status", { repoRoot, channel })
        .then((entries) => {
          setMessages((prev) => {
            const byId = new Map(entries.map((e) => [e.msg_id, e]));
            let dirty = false;
            const next = prev.map((m) => {
              const e = byId.get(m.id);
              if (!e) {
                // Outbox no longer mentions it -> delivered (or never went
                // through the outbox). Don't downgrade an explicit failed.
                if (m.delivery_status === "pending") {
                  dirty = true;
                  return { ...m, delivery_status: "delivered" as const };
                }
                return m;
              }
              const status: "pending" | "failed" = e.failed ? "failed" : "pending";
              if (
                m.delivery_status !== status ||
                m.retry_attempts !== e.attempts ||
                m.retry_last_error !== e.last_error
              ) {
                dirty = true;
                return {
                  ...m,
                  delivery_status: status,
                  retry_attempts: e.attempts,
                  retry_last_error: e.last_error,
                };
              }
              return m;
            });
            return dirty ? next : prev;
          });
        })
        .catch(() => {
          /* command might not be registered yet — silent */
        });
    }, 2000);

    // Replay any leftover outbox entries on app start (in case the previous
    // process died with pending sends). Idempotent.
    invoke<void>("chat_outbox_drain_kickoff", { repoRoot }).catch(() => {
      /* not registered yet — silent */
    });

    return () => {
      cancelledRef.current = true;
      closed = true;
      clearReconnect();
      if (outboxPollRef.current != null) {
        window.clearInterval(outboxPollRef.current);
        outboxPollRef.current = null;
      }
      const s = socketRef.current;
      socketRef.current = null;
      try {
        s?.close();
      } catch {
        /* ignored */
      }
      // belt-and-braces — silence the "closed but unused" lint
      void closed;
    };
  }, [channel, mergeMany, mergeMessage, refresh, repoRoot]);

  // ── send + retry ────────────────────────────────────────────────────
  const send = useCallback(
    async (
      body: string,
      extra: Partial<ChatSendArgs> = {},
    ): Promise<{ ok: boolean; error?: string }> => {
      if (!repoRoot || !channel) return { ok: false, error: "no repo or channel" };
      const trimmed = body.trim();
      if (trimmed.length === 0) return { ok: false, error: "empty body" };
      try {
        const msg = await api.chatSend({
          repoRoot,
          channel,
          body: trimmed,
          fromHandle: extra.fromHandle,
          fromName: extra.fromName,
          threadParent: extra.threadParent,
          isAgent: extra.isAgent,
        });
        // The Rust side now returns a "pending" row; reflect that locally
        // so the UI gets an immediate optimistic render. The outbox poll
        // + WS echo will flip it to delivered.
        mergeMessage({
          ...(msg as ReliableChatMessage),
          delivery_status: "pending",
        });
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    [channel, mergeMessage, repoRoot],
  );

  // Emit a `read_cursor` frame down the live socket. Three guards keep
  // this cheap and correct:
  //   1. Strictly monotonic — we never go backwards on the cursor for
  //      this (room, channel). A stale advance is a no-op.
  //   2. Identity stamping — display + device_id come from the cached
  //      `deviceIdentity` call so the server can attribute the row even
  //      when the user is anonymous.
  //   3. Socket-state guard — if the WS is mid-reconnect we drop the
  //      frame on the floor; the next focus/scroll will retry.
  const emitReadCursor = useCallback(
    (lastReadSeq: number) => {
      if (!Number.isFinite(lastReadSeq) || lastReadSeq <= 0) return;
      if (lastReadSeq <= lastEmittedCursorRef.current) return;
      const socket = socketRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN) return;

      const send = (ident: { device_id: string; display: string }) => {
        try {
          socket.send(
            JSON.stringify({
              kind: "read_cursor",
              channel,
              device_id: ident.device_id,
              display: ident.display,
              last_read_seq: lastReadSeq,
            }),
          );
          lastEmittedCursorRef.current = lastReadSeq;
        } catch {
          /* socket may have raced-closed; the onclose handler retries */
        }
      };

      if (deviceRef.current) {
        send(deviceRef.current);
        return;
      }
      // Lazy-resolve identity. Use the repo-scoped overlay so the
      // display name on receipts matches the sender's chat name (and
      // git log) when the user has different global vs repo-local
      // git identities. Falls back to global when there's no repo
      // overlay, or when repoRoot isn't bound yet.
      const ident$ = repoRoot
        ? api.deviceIdentityForRepo(repoRoot)
        : api.deviceIdentity();
      void ident$
        .then((ident) => {
          deviceRef.current = {
            device_id: ident.device_id,
            display: ident.display_name,
          };
          send(deviceRef.current);
        })
        .catch(() => {
          /* anonymous identity unavailable — skip the receipt */
        });
    },
    [channel],
  );

  const retry = useCallback(
    async (msgId: string) => {
      if (!repoRoot || !channel) return;
      try {
        await invoke<void>("chat_resend", { repoRoot, channel, msgId });
        setMessages((prev) =>
          prev.map((m) =>
            m.id === msgId
              ? {
                  ...m,
                  delivery_status: "pending",
                  retry_attempts: 0,
                  retry_last_error: undefined,
                }
              : m,
          ),
        );
      } catch {
        /* keep prior status — UI can re-call */
      }
    },
    [channel, repoRoot],
  );

  // Reset the cursor guard whenever the active channel changes so the
  // first read in a freshly-opened channel actually emits even if some
  // other channel was at a higher seq.
  useEffect(() => {
    lastEmittedCursorRef.current = 0;
  }, [channel]);

  return useMemo(
    () => ({ messages, send, retry, wsState, refresh, emitReadCursor }),
    [emitReadCursor, messages, refresh, retry, send, wsState],
  );
}

// ── helpers ──────────────────────────────────────────────────────────

/// Project a raw `RoomMessage` (the wire shape the cloud emits) into
/// the `ChatMessage` shape the local JSONL + UI already understand.
/// Centralised here so the WS frame path and the HTTP catchup path
/// agree byte-for-byte on the conversion.
function normaliseCloudRow(raw: Record<string, unknown>): ReliableChatMessage | null {
  const id = typeof raw.id === "string" ? raw.id : null;
  if (!id) return null;
  const body = typeof raw.body === "string" ? raw.body : "";
  const channel = typeof raw.channel === "string" ? raw.channel : "general";
  const createdAt = typeof raw.created_at === "string" ? raw.created_at : "";
  const ts = createdAt ? Math.floor(new Date(createdAt).getTime() / 1000) : 0;
  const senderDisplay = typeof raw.sender_display === "string" ? raw.sender_display : "";
  const senderEmail = typeof raw.sender_email === "string" ? raw.sender_email : null;
  const fromHandle = senderEmail
    ? senderEmail.split("@")[0]?.toLowerCase() ?? senderDisplay.toLowerCase()
    : senderDisplay.toLowerCase().replace(/[^a-z0-9_-]/g, "");
  const mentions = Array.isArray(raw.mentions)
    ? (raw.mentions.filter((x) => typeof x === "string") as string[])
    : [];
  const threadParent =
    typeof raw.thread_parent === "string" && raw.thread_parent.length > 0
      ? raw.thread_parent
      : undefined;
  const isAgent = !!raw.is_agent;
  const seq = typeof raw.seq === "number" ? raw.seq : undefined;
  return {
    id,
    channel,
    ts,
    from_handle: fromHandle,
    from_name: senderDisplay,
    body,
    mentions,
    thread_parent: threadParent,
    is_agent: isAgent,
    delivery_status: "delivered",
    seq,
  };
}
