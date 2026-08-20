// Taking a notification tap to the message it was about.
//
// Tapping a chat notification without typing a reply used to call
// `focusWindow()` and stop there: the app came forward showing whatever you
// were looking at before — a diff, a terminal, another project's board — and
// the message you tapped was somewhere you had to go and find. The
// notification told you who and where ("Ashiq · #design"); the tap threw that
// away.
//
// Everything needed to land on it already existed and was never joined up:
// `goToPlace("team")` is the one door to the Team place, and
// `aura:focus-chat-channel` is the event `useTeamChat` already listens on to
// select a conversation (ShareCodeDialog has used it for its "sent — go look"
// hop for a while). This module is the join, plus the one piece neither of
// them had: somewhere for the destination to WAIT.
//
// WHY A PENDING BOX. `goToPlace` is a React state change, so on a tap that
// arrives while Team is closed the surface mounts a render later — after an
// immediate event would already have been dispatched to nobody. So the
// destination is parked here, and `useTeamChat` collects it on mount. Whoever
// gets there first — the live listener or the mount — consumes it; the other
// finds it gone.
//
// WHY IT EXPIRES. A parked destination that never got collected (Team was
// closed and the user went somewhere else entirely) must not sit around
// waiting to hijack the next visit to Team. Half a minute is far longer than
// the gap between tapping a notification and the surface mounting, and far
// shorter than "later".

import { goToPlace } from "./placeRoute";

/** The event `useTeamChat` selects a conversation on. Its detail is
 *  `{ channel }`, where a `dm-…` slug means the 1:1 with the other side. */
export const CHAT_FOCUS_EVENT = "aura:focus-chat-channel";

/** How long a parked destination stays collectable. Long enough to cover a
 *  mount, short enough that it can never be mistaken for a later intent. */
export const ROUTE_TTL_MS = 30_000;

type PendingRoute = { repoRoot: string; channel: string; at: number };

let pending: PendingRoute | null = null;

/** Ask the app to show `channel`, opening the Team place if it isn't already
 *  showing. Safe to call whether or not Team is mounted. */
export function routeToChatChannel(repoRoot: string, channel: string): void {
  if (!repoRoot || !channel) return;
  pending = { repoRoot, channel, at: Date.now() };
  goToPlace("team");
  focusChatChannel(channel);
}

/** Select a conversation in an already-mounted Team surface. */
export function focusChatChannel(channel: string): void {
  window.dispatchEvent(
    new CustomEvent(CHAT_FOCUS_EVENT, { detail: { channel } }),
  );
}

/** Collect a destination parked for this repo, if there is one and it is
 *  still fresh. Consumes it — a destination is acted on once. */
export function takePendingChatRoute(repoRoot: string): string | null {
  const parked = pending;
  if (!parked) return null;
  // Another project's destination is not this surface's to act on: the Team
  // place renders the open project, so honouring it here would select a
  // channel slug against the wrong team's conversation list.
  if (parked.repoRoot !== repoRoot) return null;
  pending = null;
  if (Date.now() - parked.at > ROUTE_TTL_MS) return null;
  return parked.channel;
}

/** Drop whatever is parked — for the live listener, which has just handled
 *  the same destination and would otherwise leave it to fire again on the
 *  next mount. */
export function clearPendingChatRoute(): void {
  pending = null;
}
