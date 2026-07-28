// Always-on chat notifier.
//
// Fires an OS notification for EVERY inbound team-chat message — not just
// @-mentions, and regardless of whether the Team surface is mounted. The
// in-surface `useTeamChat` hook only runs while the Team pane is open and
// only ever notified on mentions, so messages that arrived while the user
// was on Build / Trace / Plan went silent. This hook closes that gap by
// owning its own lightweight, notify-only WebSocket to:
//   - the per-repo room (`api.deviceRoomId`), and
//   - the fixed `aura-global` room (the cross-repo #aura channel).
//
// It parses only `kind === "msg"` frames, skips our own messages (by
// sender device id, falling back to display/email for the global room
// which omits the device id), and routes everything through `notify()`,
// which already suppresses while the window is focused and de-dupes by
// key. Mentions get a richer title. The OS-notification path in App's
// legacy mention bridge is retired in favour of this single source.

import { useEffect, useRef } from "react";
import { api } from "./api";
import {
  notify,
  isWindowFocused,
  CHAT_REPLY_ACTION_TYPE,
  ensureChatReplyActionType,
  onChatReply,
} from "./notifications";
import { playChime, isChimeMuted } from "./chime";
import { roomTokenParam } from "./roomAuth";
import {
  AURA_GLOBAL_ROOM_ID,
  AURA_GLOBAL_CHANNEL,
} from "../components/team/domain/channels";

const WS_ORIGIN = "wss://auravcs.com";

type IncomingMsg = {
  id: string;
  channel?: string;
  sender_device_id?: string;
  sender_display?: string;
  sender_email?: string;
  body?: string;
  mentions?: string[];
  is_agent?: boolean;
};

export function useChatNotifier(repoRoot: string | null): void {
  // Our own identity — used to drop our own broadcasts and to detect when
  // a message mentions us. Resolved once per repo; the WS effect reads the
  // refs so it doesn't re-subscribe when identity hydrates.
  const deviceIdRef = useRef<string>("");
  const selfNeedlesRef = useRef<string[]>([]);
  const seenRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!repoRoot) return;
    let cancelled = false;
    (async () => {
      try {
        const id = await api.deviceIdentityForRepo(repoRoot);
        if (cancelled) return;
        deviceIdRef.current = id.device_id ?? "";
        const needles: string[] = [];
        if (id.display_name) needles.push(id.display_name.toLowerCase());
        if (id.email) {
          needles.push(id.email.toLowerCase());
          const local = id.email.split("@")[0];
          if (local) needles.push(local.toLowerCase());
        }
        selfNeedlesRef.current = needles.filter(Boolean);
      } catch {
        /* identity unavailable — notifier still fires, just can't self-skip */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [repoRoot]);

  // Register the notification "Reply" action once and route any inline reply
  // back into the right room. The reply's own `extra` carries the repo/channel,
  // so a single listener handles every room regardless of which repo is focused.
  useEffect(() => {
    void ensureChatReplyActionType();
    void onChatReply((r) => {
      const root =
        typeof r.extra.repoRoot === "string" ? r.extra.repoRoot : repoRoot;
      const channel =
        typeof r.extra.channel === "string" ? r.extra.channel : "general";
      if (!root) return;
      void api.chatSend({ repoRoot: root, channel, body: r.text }).catch(() => {
        /* reply send failed — best-effort; user can retry in-app */
      });
    });
  }, [repoRoot]);

  useEffect(() => {
    if (!repoRoot) return;
    let cancelled = false;
    const sockets: WebSocket[] = [];
    const timers: number[] = [];

    const isSelf = (m: IncomingMsg): boolean => {
      if (
        m.sender_device_id &&
        deviceIdRef.current &&
        m.sender_device_id === deviceIdRef.current
      ) {
        return true;
      }
      const disp = (m.sender_display ?? "").toLowerCase();
      const email = (m.sender_email ?? "").toLowerCase();
      return selfNeedlesRef.current.some((n) => n === disp || n === email);
    };

    const mentionsMe = (m: IncomingMsg): boolean => {
      const ms = (m.mentions ?? []).map((x) => x.toLowerCase());
      if (ms.length === 0) return false;
      return selfNeedlesRef.current.some((n) => ms.includes(n));
    };

    const handleFrame = (data: string, fallbackChannel?: string) => {
      let frame: { kind?: string; message?: IncomingMsg };
      try {
        frame = JSON.parse(data);
      } catch {
        return;
      }
      if (frame.kind !== "msg" || !frame.message) return;
      const m = frame.message;
      if (!m.id || seenRef.current.has(m.id)) return;
      seenRef.current.add(m.id);
      // Bound the de-dupe set — keep the newest 250 ids (insertion order).
      if (seenRef.current.size > 500) {
        seenRef.current = new Set(Array.from(seenRef.current).slice(-250));
      }
      if (isSelf(m)) return;

      const channel = m.channel || fallbackChannel || "general";
      const who = m.sender_display || "Someone";
      const preview = (m.body ?? "").replace(/\s+/g, " ").trim();
      const body = preview.length > 120 ? `${preview.slice(0, 120)}…` : preview;
      const mention = mentionsMe(m);
      const title = mention
        ? `${who} mentioned you in #${channel}`
        : channel === AURA_GLOBAL_CHANNEL
          ? `${who} in #aura`
          : `${who} · #${channel}`;
      // A message is audible either way: a soft in-app chime when the window is
      // focused, or the OS notification's own system sound when it isn't — never
      // both, so one message never double-pings.
      void (async () => {
        if (await isWindowFocused()) {
          playChime(mention ? "mention" : "message");
          return;
        }
        void notify({
          title,
          body: body || undefined,
          dedupeKey: `chat:${m.id}`,
          // Same mute preference as the in-app chime — silence means silence
          // on both paths.
          sound: isChimeMuted() ? undefined : mention ? "Glass" : "Ping",
          actionTypeId: CHAT_REPLY_ACTION_TYPE,
          extra: { kind: "chat", repoRoot, channel },
        });
      })();
    };

    const openRoom = (roomId: string, fallbackChannel?: string) => {
      let attempt = 0;
      const scheduleReconnect = () => {
        if (cancelled) return;
        const delay = Math.min(30000, 1000 * Math.pow(2, attempt));
        attempt += 1;
        const t = window.setTimeout(connect, delay);
        timers.push(t);
      };
      async function connect() {
        if (cancelled) return;
        // Bearer as ?token= so the notifier socket authenticates like the
        // chat one — required once AURA_ROOMS_REQUIRE_AUTH is on.
        const tok = await roomTokenParam();
        if (cancelled) return;
        let socket: WebSocket;
        try {
          socket = new WebSocket(
            `${WS_ORIGIN}/api/v1/room/${encodeURIComponent(roomId)}/ws${
              tok ? `?${tok}` : ""
            }`,
          );
        } catch {
          scheduleReconnect();
          return;
        }
        sockets.push(socket);
        socket.onopen = () => {
          attempt = 0;
        };
        socket.onmessage = (ev) => {
          if (typeof ev.data === "string") handleFrame(ev.data, fallbackChannel);
        };
        socket.onclose = () => {
          if (!cancelled) scheduleReconnect();
        };
        socket.onerror = () => {
          /* let onclose drive the reconnect */
        };
      }
      connect();
    };

    // The cross-repo #aura room is always live.
    openRoom(AURA_GLOBAL_ROOM_ID, AURA_GLOBAL_CHANNEL);
    // The per-repo room id is resolved async, then opened.
    (async () => {
      try {
        const roomId = await api.deviceRoomId(repoRoot);
        if (!cancelled) openRoom(roomId);
      } catch {
        /* no room provisioned for this repo yet — global still notifies */
      }
    })();

    return () => {
      cancelled = true;
      timers.forEach((t) => window.clearTimeout(t));
      sockets.forEach((s) => {
        try {
          s.close();
        } catch {
          /* noop */
        }
      });
    };
  }, [repoRoot]);
}
