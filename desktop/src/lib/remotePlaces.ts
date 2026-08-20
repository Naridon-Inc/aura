// The machines this window is holding open — plural, with one of them in front.
//
// Entering a machine used to be a single slot: `remoteEntry` in App, set on the
// way in and nulled on the way out, and the way in also called `leavePages()`,
// which cleared Aura, the fleet page, Trace and the Pages/Tasks/Team place. So
// walking into a box cost you every other surface you had up, and walking into
// a SECOND box cost you the first. Places were mutually exclusive for no reason
// other than there being one variable to put one in.
//
// This is that variable turned into an ordered set with a focused member.
// Entering adds; focusing reorders; blurring steps off the machine's page
// without forgetting the machine; leaving is the only removal, and it is a
// thing the user asked for. Everything else the window was showing is left
// exactly where it was, so stepping off the box uncovers it again.
//
// Pure and React-free on purpose: it is a reducer over a value App holds in
// `useState`, so the whole "which places am I in" rule set is testable without
// mounting a workspace, a terminal or an ssh connection.

/** A request to be somewhere that isn't this laptop.
 *
 *  A *request*, not an answer: `machineId` may be absent (entering from a cloud
 *  conversation names a thread, not a box; the fleet's "connect one" names
 *  neither) and may name a machine the book no longer holds. What actually got
 *  resolved is published by the workspace itself — see lib/activeMachine. */
export type RemotePlace = {
  /** `user@host` of the box to open. Absent picks the most recently used one. */
  machineId?: string;
  /** The cloud conversation this was entered from, if any. */
  threadKey?: string;
  /** The local checkout whose board the conversation belongs to. Part of the
   *  identity, not decoration: one box is a copy of many projects, and two
   *  projects on one box are two places you can be in at once. */
  repoRoot?: string;
};

/** Every place the window is in, least- to most-recently focused, and which one
 *  is in front. `focusedKey` of null means the machines are still held but the
 *  window is looking at something else — a page, or your own files. */
export type RemotePlaces = {
  entered: RemotePlace[];
  focusedKey: string | null;
};

export const NO_REMOTE_PLACES: RemotePlaces = { entered: [], focusedKey: null };

/** Ceiling on machines held at once. A held place costs a mounted workspace's
 *  worth of view state and keeps its box in the sidebar's "also open" set;
 *  past this the least-recently-focused is dropped. Generous, because the
 *  point of the set is that juggling boxes is normal — but not unbounded,
 *  because each one is a live connection to a computer somewhere. */
export const MAX_LIVE_REMOTE_PLACES = 6;

// Nothing legal in a machine id, a thread key or a path can be a NUL, so the
// key can never collide by way of a separator appearing inside a field.
const SEP = "\u0000";

/** One spelling of a checkout path, so `/a/b` and `/a/b/` are one project.
 *
 *  Exported because a local checkout is a place too (see lib/placeRef), and its
 *  key has to be spelled the way a remote place spells its project half. Two
 *  copies of this rule is exactly how one checkout becomes two places depending
 *  on which door you walked in through. */
export function normalizeRoot(root: string | null | undefined): string {
  return root?.trim().replace(/\/+$/, "") ?? "";
}

/** What makes two entries the same place.
 *
 *  A box plus a project, because `machine_id(user, host, repo_path)` is what
 *  the daemon already keys a cloud copy by: the same machine holding two
 *  projects is two places, and entering the second must not be mistaken for
 *  re-entering the first. An entry that names only a conversation is keyed by
 *  that, since it is all we have until the workspace resolves a box. */
export function remotePlaceKey(place: RemotePlace): string {
  const machine = place.machineId?.trim() ?? "";
  const thread = place.threadKey?.trim() ?? "";
  const root = normalizeRoot(place.repoRoot);
  if (machine) return `machine${SEP}${machine}${SEP}${root}`;
  if (thread) return `thread${SEP}${thread}`;
  // Names neither — "open my machine", from the fleet page. Still a place, and
  // still one per project, so a second such click doesn't stack a duplicate.
  return `machine${SEP}*${SEP}${root}`;
}

/** Walk into a place, and look at it.
 *
 *  Re-entering somewhere you are already in is a focus, not a second copy: the
 *  entry is refreshed (a later click may carry a `repoRoot` the first didn't)
 *  and moved to the front of the recency order. */
export function enterRemotePlace(
  places: RemotePlaces,
  place: RemotePlace,
): RemotePlaces {
  const key = remotePlaceKey(place);
  const entered = places.entered.filter((p) => remotePlaceKey(p) !== key);
  entered.push(place);
  // Oldest first, so dropping from the front drops the least-recently focused.
  // Never the one just entered — it is last, and the loop stops before it.
  while (entered.length > MAX_LIVE_REMOTE_PLACES) entered.shift();
  return { entered, focusedKey: key };
}

/** Look at a place you are already in. Unknown keys change nothing — focusing
 *  somewhere you never entered would put the window in front of a blank. */
export function focusRemotePlace(
  places: RemotePlaces,
  key: string,
): RemotePlaces {
  const place = places.entered.find((p) => remotePlaceKey(p) === key);
  if (!place) return places;
  if (places.focusedKey === key) return places;
  const entered = places.entered.filter((p) => remotePlaceKey(p) !== key);
  entered.push(place);
  return { entered, focusedKey: key };
}

/** Step off the machine's page without leaving the machine.
 *
 *  This is what going to Trace, Pages or the fleet does now. The box stays in
 *  the set — the sidebar still shows it as open, and one click is back in — but
 *  it stops covering the window, which is the whole reason a page opener used
 *  to have to null the entry. */
export function blurRemotePlaces(places: RemotePlaces): RemotePlaces {
  if (places.focusedKey === null) return places;
  return { entered: places.entered, focusedKey: null };
}

/** Leave for real. The one removal, and only ever because the user said so.
 *
 *  Focus falls to nothing rather than to the next box: "Leave" means leave, and
 *  dropping someone into a *different* machine's shell because it happened to
 *  be second in the list is the one answer nobody asked for. Whatever page was
 *  up before is uncovered instead, because entering never tore it down. */
export function leaveRemotePlace(
  places: RemotePlaces,
  key: string,
): RemotePlaces {
  const entered = places.entered.filter((p) => remotePlaceKey(p) !== key);
  if (entered.length === places.entered.length) return places;
  return {
    entered,
    focusedKey: places.focusedKey === key ? null : places.focusedKey,
  };
}

/** The place in front, or null when the window is showing something else. */
export function focusedRemotePlace(places: RemotePlaces): RemotePlace | null {
  if (!places.focusedKey) return null;
  return (
    places.entered.find((p) => remotePlaceKey(p) === places.focusedKey) ?? null
  );
}

/** Is this place held open — focused or not? */
export function isRemotePlaceEntered(
  places: RemotePlaces,
  key: string,
): boolean {
  return places.entered.some((p) => remotePlaceKey(p) === key);
}
