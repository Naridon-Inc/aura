// Club store — several places on screen at once, in as many arrangements as
// the work needs.
//
// By default each place owns its own tab set (see workspaceSnapshot.ts).
// Switching places serializes the outgoing tabs and hydrates the incoming
// ones. That's the right model 95% of the time — projects shouldn't bleed
// into each other.
//
// But sometimes the user is genuinely working across two places at once (a
// backend repo + its frontend, a library + the consumer app, a checkout + the
// runner it deploys to). Forcing them to switch back-and-forth and losing
// context every time is hostile. The club is the escape hatch: drag a tab from
// place A's tab strip onto place B's rail tile, and a "clubbed" pseudo-place
// appears on the rail. Click it to enter a unified view where tabs from both A
// and B coexist. Leave the club, and each place keeps its own tab set
// unchanged.
//
// WHAT CHANGED IN v2, and why the v1 notes were wrong:
//
//   • ONE CLUB AT A TIME IS GONE. v1 said two-club scenarios added UI
//     complexity ("which club is active? what's the tile?") that didn't pay
//     off until someone asked. Someone asked, and the honest reading is that
//     the cap was never buying anything: the two questions have the same
//     answers a second project has — the active club is the one you clicked,
//     and the tile is its own. Clubs are a list now, each with its own id, its
//     own tab slot and its own live state. Nothing about holding a second one
//     costs you the first, which is the same rule the rest of the window
//     already follows.
//
//   • MEMBERS ARE PLACES, NOT REPO ROOTS. v1 stored `Set<repoRoot>`, so a club
//     could only ever hold local checkouts — a machine could not join one, and
//     the whole point of a club is to put two things you are working across
//     side by side, whichever computer they live on. Members are `PlaceRef`
//     now (lib/placeRef): local checkout or remote place, keyed the same way,
//     stored as structure so a restart can re-open them.
//
//   • CLUBS SURVIVE A RESTART. v1 persisted, but through a bare
//     `localStorage.setItem` in a try/catch — the exact write that a full
//     origin drops silently (see localStore.ts). Club membership is session
//     state, not a cache: it goes through `setDurable`, which evicts
//     regenerable blobs to make room rather than losing the club.
//
// Design notes that survive from v1:
//   - We don't store tabs in the club — tabs always live in their owning
//     place's snapshot. The club is a viewing mode that unions the snapshots,
//     plus one slot of its own for what you opened while standing in it.
//   - "Active" is separate from membership so the user can leave a club
//     without dissolving it, then re-enter later.
//   - Dissolve = drop the club + its tab slot. No undo.
//
// One rule v2 deliberately does NOT add: a place may belong to more than one
// club. Frontend+backend and frontend+design-system are both real, and they
// share a member. Forbidding the overlap would be a smaller version of the cap
// this file just removed.

import { setDurable } from "./localStore";
import {
  dedupePlaces,
  parsePlaceRef,
  placeKey,
  type PlaceRef,
} from "./placeRef";
import { adoptLegacyClubSlot, removeClubSnapshot } from "./workspaceSnapshot";

const STORAGE_KEY = "aura.workspaceClub.v2";

// v1's blob: `{ members: string[]; active: boolean }`, one club, roots only.
// Read once and carried forward — and left in place rather than deleted, since
// it costs ~50 bytes and is the only thing an older build could still read.
const LEGACY_STORAGE_KEY = "aura.workspaceClub.v1";

/** A club is at least two places. One place is not an arrangement — it is just
 *  that place, and the rail already draws it. */
export const MIN_CLUB_MEMBERS = 2;

export type Club = {
  /** Stable for the club's life. Names its tab slot and its live-state place
   *  key, so two clubs never hand each other's tabs back. */
  id: string;
  /** The places shown side by side. Order is the order they were clubbed. */
  members: PlaceRef[];
};

export type ClubState = {
  /** Every club that exists, oldest first. Empty = no clubs. */
  clubs: Club[];
  /** The club being viewed, or null when the window is standing in a single
   *  place. Always names a club in `clubs`. */
  activeClubId: string | null;
  /** Ids are minted, never recycled. A dissolved club's tab slot is removed,
   *  but a storage write can fail — and inheriting a stranger's tabs because
   *  the id came back around is not a failure mode worth leaving open. */
  seq: number;
};

function emptyState(): ClubState {
  return { clubs: [], activeClubId: null, seq: 0 };
}

function parseClub(raw: unknown): Club | null {
  if (!raw || typeof raw !== "object") return null;
  const { id, members } = raw as { id?: unknown; members?: unknown };
  if (typeof id !== "string" || !id.trim()) return null;
  if (!Array.isArray(members)) return null;
  const parsed = dedupePlaces(
    members
      .map(parsePlaceRef)
      .filter((m): m is PlaceRef => m !== null),
  );
  // A club that lost members on the way back off disk (a place shape this
  // build no longer understands) stops being a club rather than coming back
  // as a one-member view of something the user never asked for.
  if (parsed.length < MIN_CLUB_MEMBERS) return null;
  return { id: id.trim(), members: parsed };
}

function settle(clubs: Club[], activeClubId: string | null, seq: number): ClubState {
  const active = clubs.some((c) => c.id === activeClubId) ? activeClubId : null;
  const highest = clubs.reduce((n, c) => {
    const at = /^club-(\d+)$/.exec(c.id);
    return at ? Math.max(n, Number(at[1])) : n;
  }, 0);
  return { clubs, activeClubId: active, seq: Math.max(seq, highest) };
}

function readV2(): ClubState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ClubState>;
    if (!parsed || !Array.isArray(parsed.clubs)) return null;
    const clubs = parsed.clubs
      .map(parseClub)
      .filter((c): c is Club => c !== null);
    const seq = typeof parsed.seq === "number" ? parsed.seq : 0;
    return settle(
      clubs,
      typeof parsed.activeClubId === "string" ? parsed.activeClubId : null,
      seq,
    );
  } catch {
    return null;
  }
}

/** Carry the single v1 club forward. Its members were bare roots, which
 *  `parsePlaceRef` reads as local places, and its tabs lived in the one club
 *  slot, which `adoptLegacyClubSlot` moves onto the migrated id — so the user
 *  relaunches into the club they left, not an empty one. */
function migrateV1(): ClubState {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(LEGACY_STORAGE_KEY);
  } catch {
    return emptyState();
  }
  if (!raw) return emptyState();
  let members: PlaceRef[] = [];
  let active = false;
  try {
    const parsed = JSON.parse(raw) as { members?: unknown; active?: unknown };
    if (!Array.isArray(parsed?.members)) return emptyState();
    members = dedupePlaces(
      parsed.members
        .map(parsePlaceRef)
        .filter((m): m is PlaceRef => m !== null),
    );
    active = Boolean(parsed.active);
  } catch {
    return emptyState();
  }
  if (members.length < MIN_CLUB_MEMBERS) return emptyState();
  const club: Club = { id: "club-1", members };
  adoptLegacyClubSlot(club.id);
  const migrated = settle([club], active ? club.id : null, 1);
  persist(migrated);
  return migrated;
}

function load(): ClubState {
  return readV2() ?? migrateV1();
}

function persist(s: ClubState): void {
  // Durable, not best-effort: which places you clubbed is not something the
  // app can work out again, and v1's bare setItem was the write a full origin
  // dropped in silence.
  setDurable(STORAGE_KEY, JSON.stringify(s));
}

// Read on first use rather than at import. The store is a module singleton and
// `localStorage` is not always there when the module is (a test process, a
// worker) — and a lazy read is also what lets a restart be reproducible
// without a second process. See `reloadClubs`.
let state: ClubState | null = null;
const listeners = new Set<() => void>();

function current(): ClubState {
  if (!state) state = load();
  return state;
}

function emit() {
  for (const l of listeners) l();
}

function commit(next: ClubState) {
  state = settle(next.clubs, next.activeClubId, next.seq);
  persist(state);
  emit();
}

export function getClubState(): ClubState {
  return current();
}

export function subscribeClub(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Every club, oldest first. */
export function listClubs(): Club[] {
  return current().clubs;
}

export function getClub(id: string | null | undefined): Club | null {
  if (!id) return null;
  return current().clubs.find((c) => c.id === id) ?? null;
}

/** The club being viewed, or null when standing in a single place. */
export function getActiveClub(): Club | null {
  return getClub(current().activeClubId);
}

/** The keys of a club's members — what `enterClub` takes, and what the rail
 *  draws a row per. */
export function clubMemberKeys(club: Club): string[] {
  return club.members.map(placeKey);
}

/** Is this place in this club? */
export function clubHolds(club: Club, ref: PlaceRef | string): boolean {
  const key = typeof ref === "string" ? ref : placeKey(ref);
  return club.members.some((m) => placeKey(m) === key);
}

/** Every club holding this place. Plural on purpose — a place may be clubbed
 *  with two different sets of neighbours. */
export function clubsForPlace(ref: PlaceRef | string): Club[] {
  return current().clubs.filter((c) => clubHolds(c, ref));
}

/** Start a club from a set of places.
 *
 *  Returns the club, or null when there aren't two distinct places to club.
 *  A set that exactly matches an existing club IS that club — asking twice for
 *  the same arrangement gets you the one you already have, with the tabs you
 *  left in it, rather than a second empty copy of it. Does not activate:
 *  entering is the caller's move (see `clubWith` for the drag gesture, which
 *  does both). */
export function createClub(members: readonly PlaceRef[]): Club | null {
  const unique = dedupePlaces(members);
  if (unique.length < MIN_CLUB_MEMBERS) return null;
  const s = current();
  const wanted = new Set(unique.map(placeKey));
  // Compared as sets rather than as a joined string: a place key already
  // carries the only separator worth picking, so any join is a collision
  // waiting to hand back the wrong club.
  const existing = s.clubs.find(
    (c) =>
      c.members.length === wanted.size &&
      clubMemberKeys(c).every((k) => wanted.has(k)),
  );
  if (existing) return existing;
  const seq = s.seq + 1;
  const club: Club = { id: `club-${seq}`, members: unique };
  commit({ clubs: [...s.clubs, club], activeClubId: s.activeClubId, seq });
  return club;
}

/** Add a place to an existing club. A place already in it is left alone —
 *  including its position, so the rail doesn't reshuffle on a re-drop. */
export function addToClub(clubId: string, ref: PlaceRef): void {
  const s = current();
  const club = s.clubs.find((c) => c.id === clubId);
  if (!club || clubHolds(club, ref)) return;
  const next = { ...club, members: [...club.members, ref] };
  commit({
    clubs: s.clubs.map((c) => (c.id === clubId ? next : c)),
    activeClubId: s.activeClubId,
    seq: s.seq,
  });
}

/** Drop a place from a club. If membership falls below two the club
 *  auto-dissolves — a club of one is just that place. */
export function removeFromClub(clubId: string, ref: PlaceRef | string): void {
  const s = current();
  const club = s.clubs.find((c) => c.id === clubId);
  if (!club || !clubHolds(club, ref)) return;
  const key = typeof ref === "string" ? ref : placeKey(ref);
  const members = club.members.filter((m) => placeKey(m) !== key);
  if (members.length < MIN_CLUB_MEMBERS) {
    dissolveClub(clubId);
    return;
  }
  commit({
    clubs: s.clubs.map((c) => (c.id === clubId ? { ...c, members } : c)),
    activeClubId: s.activeClubId,
    seq: s.seq,
  });
}

/** Drop a club. Its tab slot goes with it — the tabs the user opened while
 *  standing in an arrangement that no longer exists have nowhere to be, and
 *  leaving the slot behind is how a future club with a recycled id would
 *  inherit a stranger's window. Member places keep their own tabs, untouched. */
export function dissolveClub(clubId: string): void {
  const s = current();
  if (!s.clubs.some((c) => c.id === clubId)) return;
  removeClubSnapshot(clubId);
  commit({
    clubs: s.clubs.filter((c) => c.id !== clubId),
    activeClubId: s.activeClubId === clubId ? null : s.activeClubId,
    seq: s.seq,
  });
}

/** Look at a club, or step off whichever one is up (`null`). An id naming no
 *  club is a no-op rather than a blank surface. */
export function setActiveClub(clubId: string | null): void {
  const s = current();
  if (clubId !== null && !s.clubs.some((c) => c.id === clubId)) return;
  if (s.activeClubId === clubId) return;
  commit({ clubs: s.clubs, activeClubId: clubId, seq: s.seq });
}

/** The drag-to-tile gesture: put `added` beside `current`, and go there.
 *
 *  Extends rather than duplicates. If the two are already clubbed together
 *  that club is what lights up; if `current` is in exactly one club, `added`
 *  joins it; otherwise a new club of the two is minted. When `current` is in
 *  several clubs the answer is ambiguous, so a new one is minted rather than
 *  guessed at — the user can drop onto the club's own tile to extend a
 *  specific one. */
export function clubWith(
  currentPlace: PlaceRef,
  addedPlace: PlaceRef,
): Club | null {
  const currentKey = placeKey(currentPlace);
  const addedKey = placeKey(addedPlace);
  if (!currentKey || !addedKey || currentKey === addedKey) return null;
  const together = current().clubs.find(
    (c) => clubHolds(c, currentKey) && clubHolds(c, addedKey),
  );
  if (together) {
    setActiveClub(together.id);
    return together;
  }
  const holding = clubsForPlace(currentKey);
  if (holding.length === 1) {
    const club = holding[0]!;
    addToClub(club.id, addedPlace);
    setActiveClub(club.id);
    return getClub(club.id);
  }
  const made = createClub([currentPlace, addedPlace]);
  if (made) setActiveClub(made.id);
  return made;
}

/** Re-read the persisted clubs.
 *
 *  What a relaunch does, and the only way to reproduce one in a test without a
 *  second process. Notifies subscribers, because the state on screen may no
 *  longer be the state on disk. */
export function reloadClubs(): void {
  state = load();
  emit();
}

/** Forget every club, on disk and in memory. Teardown and tests — not a user
 *  action; dissolving one club is (`dissolveClub`). */
export function resetClubs(): void {
  for (const club of current().clubs) removeClubSnapshot(club.id);
  state = emptyState();
  persist(state);
  emit();
}
