/** Team (chat) bounded context — channel identity + DM routing.
 *
 *  Built-in channel slugs, the fixed cloud room for the global Aura
 *  channel, and the pure functions that derive a DM channel slug from a
 *  pair of handles (and the inverse — the other side of a DM). Lifted
 *  verbatim from CommsPanel; on-disk conventions are preserved so existing
 *  channel JSONL files on every clone still resolve. Also holds the
 *  #aura hero-channel conversation id and the rail recency comparator,
 *  which both key off that channel's identity. */

import type { Conversation } from "./types";

// Built-in channel slugs — anything else is "custom". `aura` is the
// cross-repo global channel: every install renders it as a pinned
// builtin and the Rust side routes its chat_send / chat_list calls
// to the fixed `aura-global` cloud room (see effective_room_id in
// cmd_device.rs) so users from different repos share a single feed.
export const BUILTIN_CHANNELS = new Set(["general", "agents", "sentinel", "aura"]);

// Fixed cloud room id for the global Aura channel — kept here so the
// 2nd WebSocket subscribe doesn't need a round-trip just to learn
// what its parent already knows. Must match `AURA_GLOBAL_ROOM` in
// aura-shell/src-tauri/src/cmd_device.rs.
//
// Value = sha256("aura-global"). The cloud only accepts 64-hex room ids
// (or `local-<64hex>`); the bare "aura-global" failed that check (HTTP
// 400) and broke every #aura send. Both this WS-subscribe path and the
// Rust POST/fetch path must use the same hashed id.
export const AURA_GLOBAL_ROOM_ID =
  "9cd55691794cd647f9d052354a4a0c55f9b5da7706fd780b03b9acb8cb583d70";
export const AURA_GLOBAL_CHANNEL = "aura";

export function dmChannel(a: string, b: string): string {
  // Preserved on-disk convention: `dm-<sorted handles joined by "--">`
  // so existing channel JSONL files on every clone still resolve.
  const sorted = [a, b].filter(Boolean).sort();
  return `dm-${sorted.join("--")}`;
}

export function dmOtherSide(channel: string, self: string): string {
  if (!channel.startsWith("dm-")) return "";
  // Self-DM scratch-pad uses `dm-self-<handle>` — both "sides" are
  // the same user. Returning `self` here routes the message into
  // the synthetic "Me" conversation (id `dm:<selfHandle>`).
  if (channel.startsWith("dm-self-")) return self;
  const parts = channel.slice(3).split("--");
  return parts.find((p) => p !== self) ?? parts[0] ?? "";
}

// The #aura channel is the cross-repo "home" channel — it is always
// hoisted to the very top of the channel rail, above the project
// channel and every recency/unread/pinned consideration below.
export const AURA_CONV_ID = `ch:${AURA_GLOBAL_CHANNEL}`;

// Recency comparator — most recent activity first, unread floats above
// silent rows of the same age. Pinned conversations beat everything,
// and the #aura hero channel beats even those (always row 0).
export function byRecency(a: Conversation, b: Conversation): number {
  if ((a.id === AURA_CONV_ID) !== (b.id === AURA_CONV_ID)) {
    return a.id === AURA_CONV_ID ? -1 : 1;
  }
  if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
  const au = (a.unread ?? 0) > 0;
  const bu = (b.unread ?? 0) > 0;
  if (au !== bu) return au ? -1 : 1;
  return (b.lastTs ?? 0) - (a.lastTs ?? 0);
}
