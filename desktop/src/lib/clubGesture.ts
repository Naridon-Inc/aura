// Making a club, from the rail — the gesture half.
//
// `workspaceClubStore` knows how to hold N clubs over any set of places, and
// it has known that since B4. What nothing knew was how a person is supposed
// to MAKE one: `createClub`, `clubWith`, `addToClub` and `enterClub` had zero
// callers outside their own tests, so "several workspaces at once, on
// different projects" was true of the store and false of the product. A
// feature you cannot reach is not shipped.
//
// The gesture is a PICK, not a drag. Drag-to-club reads better in a demo, but
// the rail's rows are two different components in two different lists (a local
// copy under its project, a machine under the same project, a cloud
// conversation under that) and a drop target that only some rows have is a
// gesture that works for some clubs. Picking is one rule for every row: turn
// picking on, click the rows you want, open them. It is also the only one of
// the two that can be DISCOVERED — there is a control that starts it and a bar
// that says what it wants next, where a drag is a thing you either already
// know about or never find.
//
// What lives here is everything about that gesture which is not React: which
// places are picked, whether two of them are enough yet, and what a picked row
// or a club row is CALLED. Pure over `workspaceClubStore` + `placeRef` on
// purpose — the rail can be photographed and the gesture can be tested without
// mounting a workspace, and the store below stays the one source of truth for
// membership. Nothing here keeps its own copy of a club.
//
// The pick is deliberately NOT persisted. A half-made club is a sentence you
// are still typing; coming back to it after a relaunch, with two rows lit and
// no memory of why, is worse than starting again.

import {
  dedupePlaces,
  isRemotePlace,
  placeKey,
  placeMachineId,
  placeRepoRoot,
  type PlaceRef,
} from "./placeRef";
import {
  createClub,
  getClub,
  MIN_CLUB_MEMBERS,
  setActiveClub,
  type Club,
} from "./workspaceClubStore";

/** A club being assembled. `picking` is separate from `places` because "the
 *  bar is up and I have chosen nothing yet" and "the bar is down" are
 *  different states — the first one is asking you a question. */
export type ClubPick = {
  picking: boolean;
  /** In the order they were clicked, which is the order the club will hold
   *  them (see `createClub`). */
  places: PlaceRef[];
};

const IDLE: ClubPick = { picking: false, places: [] };

// One value, replaced wholesale on every change. Held rather than rebuilt per
// read because `useSyncExternalStore` compares snapshots by identity — a
// getter that returns a fresh `{ picking, places }` each call re-renders the
// rail forever.
let pick: ClubPick = IDLE;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function commit(next: ClubPick): void {
  pick = next;
  emit();
}

export function subscribeClubPick(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** The pick as it stands. Stable between changes — safe to hand a hook. */
export function getClubPick(): ClubPick {
  return pick;
}

/** Start picking. `seed` is the row the gesture was started FROM, when it was
 *  started from one — beginning with the place you are standing in means the
 *  common case ("this, beside that") costs one click instead of two. */
export function beginClubPick(seed?: PlaceRef | null): void {
  commit({ picking: true, places: seed ? dedupePlaces([seed]) : [] });
}

/** Put the bar away and forget the picks. */
export function cancelClubPick(): void {
  if (pick === IDLE) return;
  commit(IDLE);
}

/** In or out. Picking a row is also how picking STARTS, so a row that offers
 *  the gesture directly (a context-menu "Put side by side") doesn't have to
 *  arm the mode first and then repeat itself. A place already picked is
 *  dropped, which is what makes the mark a checkbox rather than a one-way
 *  door. */
export function toggleClubPick(ref: PlaceRef): void {
  const key = placeKey(ref);
  // A place with no key cannot be compared, entered or stored — picking it
  // would put a row in the bar that no club could ever hold.
  if (!key) return;
  const held = pick.places.some((p) => placeKey(p) === key);
  commit({
    picking: true,
    places: held
      ? pick.places.filter((p) => placeKey(p) !== key)
      : dedupePlaces([...pick.places, ref]),
  });
}

/** Is this place in the pick? Takes a ref or the key one, because the rail
 *  has both — a row holds its own ref, the bar's chips hold keys. */
export function isPickedPlace(ref: PlaceRef | string): boolean {
  const key = typeof ref === "string" ? ref : placeKey(ref);
  if (!key) return false;
  return pick.places.some((p) => placeKey(p) === key);
}

/** Enough places chosen for the "Open" button to mean anything. */
export function canOpenClubPick(): boolean {
  return pick.places.length >= MIN_CLUB_MEMBERS;
}

/** Make the club the pick describes.
 *
 *  Null when there aren't two distinct places yet, and in that case the pick
 *  is LEFT UP: the answer to "you only chose one" is the bar still asking for
 *  the second, not the gesture disappearing and the user starting over.
 *
 *  Asking for a set you already have hands back that club rather than a second
 *  empty copy of it (`createClub`), so picking the same two rows twice is
 *  re-entering the arrangement you left, with the tabs you left in it.
 *
 *  Makes it; does not enter it. Entering is the rail's move because it has to
 *  wait on the window — a member project may not be open yet — and a club
 *  marked "you are in this" before the window got there is a lit row over a
 *  screen that never changed. */
export function openPickedClub(): Club | null {
  const club = createClub(pick.places);
  if (!club) return null;
  commit(IDLE);
  return club;
}

/** Walk into an existing club — what a club row's click does.
 *
 *  Returns the club so the caller can read its members without a second
 *  lookup, or null for an id naming nothing (a club dissolved in another
 *  window while this rail was up). Any half-made pick is dropped: you asked
 *  for a club that exists, so the one you were building is no longer the
 *  question on screen. */
export function enterClubFromRail(clubId: string): Club | null {
  const club = getClub(clubId);
  if (!club) return null;
  setActiveClub(clubId);
  cancelClubPick();
  return club;
}

/** Step off the club, back into a single place. The tabs stay in the club's
 *  own slot and every member keeps its own live state — see editorStore's
 *  `exitClub`, which the caller pairs with this. */
export function leaveClub(): void {
  setActiveClub(null);
}

/** The last path segment, which is what a project is called before anyone
 *  renames it. */
function leafName(root: string): string {
  return root.split("/").filter(Boolean).pop() ?? root;
}

/** What a place is called on a club row.
 *
 *  One function for both kinds, because a club row that branched on `kind` to
 *  find a name is the branch that lets the local half and the remote half
 *  drift apart again. A remote place says which computer it is on, since "the
 *  same project, over there" is the whole reason it is in the club. */
export function placeLabel(ref: PlaceRef): string {
  const root = placeRepoRoot(ref);
  const project = root ? leafName(root) : "";
  const machine = placeMachineId(ref);
  if (machine) {
    // `user@host` — the host is the part people recognise, and the user half
    // is the same `ubuntu` on every box.
    const at = machine.indexOf("@");
    const host = at >= 0 ? machine.slice(at + 1) : machine;
    return project ? `${project} on ${host}` : host;
  }
  if (isRemotePlace(ref)) {
    // A conversation that hasn't resolved a box yet. Still a place, and still
    // one you can club — it just can't name a computer.
    return project ? `${project} in the cloud` : "a cloud conversation";
  }
  return project || "this laptop";
}

/** How many members a row names before it starts counting them instead. Two
 *  fit in a 232px rail; three do not, and a row that ellipsises the last name
 *  says less than one that says "+1". */
const NAMED_MEMBERS = 2;

/** The club, in the width of a rail row: "aura · aura-web", or "aura · aura-web
 *  +2" once it holds more than a row can name. */
export function clubLabel(club: Club): string {
  const names = club.members.map(placeLabel);
  if (names.length <= NAMED_MEMBERS) return names.join(" · ");
  const rest = names.length - NAMED_MEMBERS;
  return `${names.slice(0, NAMED_MEMBERS).join(" · ")} +${rest}`;
}

/** Every member, spelled out — the row's tooltip, where there is room to say
 *  all of them however many there are. */
export function clubMembersLine(club: Club): string {
  return club.members.map(placeLabel).join(" · ");
}
