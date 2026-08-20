/** Is the person on the other side of a DM around right now?
 *
 *  One rule, one place. Three surfaces draw that dot — the DM row in the rail,
 *  the conversation header, and the profile hero in the details panel — and two
 *  of them hardcoded `presence="online"`. A colleague who had not opened Aura
 *  in a month still showed a green dot next to their name, so the one surface
 *  that did the work (the rail) disagreed with the header directly above it. */

import type { Conversation } from "./types";

export type ConvPresence = "online" | "idle" | "offline";

/** Roster fields this rule needs. Deliberately structural so it can be handed
 *  a `TeamMember` from any layer without the domain depending on the API type. */
type PresenceRow = {
  handle: string;
  name: string;
  /** Epoch seconds, 0 when we have never seen this seat. */
  last_seen: number;
};

/** Seconds since `last_seen` within which a seat counts as actively present.
 *  Matches the roster poll interval with headroom, so a teammate sitting in
 *  Aura doesn't blink offline between polls. */
const ONLINE_WINDOW_SECS = 90;
/** Beyond `online` but recent enough to be worth a message — "was just here". */
const IDLE_WINDOW_SECS = 900;

/** `null` for anything that isn't a DM: channels and the project feed have no
 *  single person to be present. */
export function presenceForConversation(
  conv: Conversation,
  members: PresenceRow[],
  nowSecs: number = Math.floor(Date.now() / 1000),
): ConvPresence | null {
  if (conv.kind !== "dm") return null;
  // Prefer the handle — a display name can belong to two seats, and matching
  // the first would report one colleague's presence for another.
  const needle = (conv.handle ?? conv.name).trim().toLowerCase();
  const member = members.find(
    (entry) =>
      entry.handle.trim().toLowerCase() === needle ||
      entry.name.trim().toLowerCase() === needle,
  );
  // Not on the roster at all: we know nothing, and "offline" is the honest
  // reading of that — we have never seen them here.
  if (!member) return "offline";
  if (member.last_seen <= 0) return "offline";
  const age = nowSecs - member.last_seen;
  if (age <= ONLINE_WINDOW_SECS) return "online";
  if (age <= IDLE_WINDOW_SECS) return "idle";
  return "offline";
}
