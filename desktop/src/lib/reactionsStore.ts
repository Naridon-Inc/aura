// Reactions live in a singleton observable so the chat WS handler, the
// initial snapshot fetch, and every Bubble that renders chips can all
// share one source of truth without prop-drilling a Map through the
// entire component tree.
//
// Shape:   reactions[msg_id][emoji] -> { deviceIds: Set<string>, names: Map<deviceId, display> }
//
// "names" lets us tooltip "Reacted by Alice, Bob, Carol" without a
// second roster lookup; we keep it small (best-effort) so the count
// itself is always reliable.
//
// All mutations are local-first: callers should `applyServer` once the
// authoritative WS frame returns. Optimistic ops shouldn't write to the
// store directly because the WS broadcast loops back to the sender too.

type EmojiState = {
  deviceIds: Set<string>;
  names: Map<string, string>;
};

type MsgReactions = Map<string, EmojiState>; // emoji -> state

const byMsg: Map<string, MsgReactions> = new Map();
const subscribers: Set<(msgId: string | null) => void> = new Set();

function notify(msgId: string | null) {
  for (const fn of subscribers) {
    try {
      fn(msgId);
    } catch {
      /* a bad subscriber shouldn't break the others */
    }
  }
}

export type ReactionRow = {
  msg_id: string;
  emoji: string;
  device_id: string;
  display?: string;
  channel?: string;
};

export const reactionsStore = {
  /** Replace state for a set of message ids. Used on the initial GET
   * after connecting the WS so chips render before any live frames
   * arrive. */
  applySnapshot(rows: ReactionRow[]) {
    // Collect the touched msg ids so we can notify each one (subscribers
    // typically filter by msg_id and re-render the relevant Bubble only).
    const touched = new Set<string>();
    // Don't blow away existing state — overlay. The server snapshot is
    // authoritative for the (msg, emoji, device) triples it contains.
    for (const r of rows) {
      const mid = r.msg_id;
      touched.add(mid);
      let m = byMsg.get(mid);
      if (!m) {
        m = new Map();
        byMsg.set(mid, m);
      }
      let s = m.get(r.emoji);
      if (!s) {
        s = { deviceIds: new Set(), names: new Map() };
        m.set(r.emoji, s);
      }
      s.deviceIds.add(r.device_id);
      if (r.display) s.names.set(r.device_id, r.display);
    }
    for (const id of touched) notify(id);
  },

  /** Apply an authoritative server frame. `added=true` adds the
   * (emoji, device) pair, `added=false` removes it. */
  applyServer(
    msgId: string,
    emoji: string,
    deviceId: string,
    added: boolean,
    display?: string,
  ) {
    let m = byMsg.get(msgId);
    if (!m) {
      if (!added) return;
      m = new Map();
      byMsg.set(msgId, m);
    }
    let s = m.get(emoji);
    if (added) {
      if (!s) {
        s = { deviceIds: new Set(), names: new Map() };
        m.set(emoji, s);
      }
      s.deviceIds.add(deviceId);
      if (display) s.names.set(deviceId, display);
    } else if (s) {
      s.deviceIds.delete(deviceId);
      s.names.delete(deviceId);
      if (s.deviceIds.size === 0) m.delete(emoji);
      if (m.size === 0) byMsg.delete(msgId);
    }
    notify(msgId);
  },

  /** Read the current emoji aggregate for a message. */
  getFor(msgId: string): Array<{ emoji: string; count: number; deviceIds: string[]; names: string[] }> {
    const m = byMsg.get(msgId);
    if (!m) return [];
    const out: Array<{ emoji: string; count: number; deviceIds: string[]; names: string[] }> = [];
    for (const [emoji, s] of m) {
      out.push({
        emoji,
        count: s.deviceIds.size,
        deviceIds: [...s.deviceIds],
        names: [...s.deviceIds].map((d) => s.names.get(d) ?? d),
      });
    }
    // Most-reacted first, stable secondary by emoji codepoint.
    out.sort((a, b) => (b.count - a.count) || a.emoji.localeCompare(b.emoji));
    return out;
  },

  /** Has the given device reacted with this emoji on this message? */
  has(msgId: string, emoji: string, deviceId: string): boolean {
    return !!byMsg.get(msgId)?.get(emoji)?.deviceIds.has(deviceId);
  },

  /** Subscribe to all reaction updates. `handler` is called with the
   * touched msg_id (or `null` for a full-store refresh). Returns an
   * unsubscribe function. */
  subscribe(handler: (msgId: string | null) => void): () => void {
    subscribers.add(handler);
    return () => {
      subscribers.delete(handler);
    };
  },
};

/** Common emoji set surfaced in the picker. Kept short on purpose:
 * Discord/Slack analytics show >90% of reactions land in the top-20,
 * and the long tail can be typed directly into the message body. */
export const PICKER_EMOJIS = [
  "👍", "👎", "❤️", "🎉", "🚀", "🔥",
  "😂", "😅", "😢", "🤔", "🙏", "👀",
  "✅", "❌", "💯", "⚠️", "🐛", "📝",
  "🤖", "✨", "💀", "🙌", "🫡", "💪",
];
