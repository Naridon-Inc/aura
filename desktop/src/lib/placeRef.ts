// A place, when a place can be either of two things.
//
// The window holds several places at once now — checkouts on this laptop and
// machines somewhere else — and the two halves grew their own vocabulary. A
// local place was a `repoRoot: string` everywhere it appeared: the live-state
// registry keys on it (placeStates), the tab snapshot slot is named after it
// (workspaceSnapshot), the rail draws one tile per one. A remote place was a
// `RemotePlace` with its own `remotePlaceKey` (remotePlaces).
//
// That was survivable while nothing had to hold both. Clubbing does: a club is
// a SET of places shown side by side, and "your backend checkout beside the
// runner it deploys to" is the request, not "two local checkouts". A set whose
// members are bare strings can only ever be one of the two, which is how a
// feature lands in one place-mode only.
//
// So this is the identity both halves answer to. Two rules, and they are the
// whole module:
//
//   • A LOCAL place's key IS its repo root. Not a wrapper around it — the same
//     string the snapshot slot and the registry already use, so a club member
//     needs no translation to find the tabs it stands for.
//   • A REMOTE place's key is `remotePlaceKey`'s, unchanged. It begins with
//     `machine` or `thread` and carries NUL separators, and a repo root is an
//     absolute path, so the two key spaces cannot collide. That is checked in
//     tests rather than asserted here.
//
// `PlaceRef` is what gets PERSISTED (a club has to survive a restart, and a key
// alone can't be re-opened — you cannot recover `user@host` from a key you
// never parse). `placeKey` is what gets COMPARED.

import { normalizeRoot, remotePlaceKey, type RemotePlace } from "./remotePlaces";

/** A checkout on this laptop. */
export type LocalPlaceRef = { kind: "local"; repoRoot: string };

/** A place on some other computer — a box, or a cloud conversation that has
 *  not resolved to one yet. Carries `RemotePlace` verbatim so entering a club
 *  member is the same call as entering it on its own. */
export type RemotePlaceRef = { kind: "remote" } & RemotePlace;

/** Somewhere the window can stand. */
export type PlaceRef = LocalPlaceRef | RemotePlaceRef;

/** This laptop's checkout at `repoRoot`. */
export function localPlace(repoRoot: string): LocalPlaceRef {
  return { kind: "local", repoRoot: normalizeRoot(repoRoot) };
}

/** The machine (or the conversation) `place` names. */
export function remotePlace(place: RemotePlace): RemotePlaceRef {
  return { kind: "remote", ...place };
}

/** The remote half on its own, without the tag.
 *
 *  What `lib/remotePlaces` and the remote workspace are actually opened with: a
 *  `RemotePlace`, the shape that predates the union. Written out field by field
 *  rather than spread-minus-`kind` so the two never drift — a stray `kind` in an
 *  entered-places set is a field nothing reads and everything copies. */
export function remotePlaceOf(ref: RemotePlaceRef): RemotePlace {
  return {
    machineId: ref.machineId,
    threadKey: ref.threadKey,
    repoRoot: ref.repoRoot,
  };
}

export function isLocalPlace(ref: PlaceRef): ref is LocalPlaceRef {
  return ref.kind === "local";
}

export function isRemotePlace(ref: PlaceRef): ref is RemotePlaceRef {
  return ref.kind === "remote";
}

/** What this place is filed under — its live state, its tab snapshot, its row
 *  in a club. The one string every other module already keys by. */
export function placeKey(ref: PlaceRef): string {
  return ref.kind === "local" ? normalizeRoot(ref.repoRoot) : remotePlaceKey(ref);
}

/** Same place, however each side happens to spell it. */
export function samePlaceRef(a: PlaceRef, b: PlaceRef): boolean {
  return placeKey(a) === placeKey(b);
}

/** The checkout on THIS laptop a place belongs to, if it names one.
 *
 *  Both kinds can: a remote place carries the local root whose board, transcript
 *  and intent log the work belongs to even while the code sits on a box. Null
 *  for a place that hasn't resolved a project yet (entered from the fleet, or
 *  from a conversation whose repo isn't known). */
export function placeRepoRoot(ref: PlaceRef): string | null {
  return normalizeRoot(ref.repoRoot) || null;
}

/** The machine a place runs on — null meaning this laptop. */
export function placeMachineId(ref: PlaceRef): string | null {
  if (ref.kind === "local") return null;
  return ref.machineId?.trim() || null;
}

/** Read a place back off disk.
 *
 *  Deliberately forgiving in one direction only: a bare string is taken as a
 *  local root, because that is exactly what the v1 club stored and re-reading
 *  it must not silently drop the user's club. Anything it cannot make sense of
 *  is null rather than a half-built place — a member that can't be opened is
 *  worse than a member that isn't there. */
export function parsePlaceRef(value: unknown): PlaceRef | null {
  if (typeof value === "string") {
    const root = normalizeRoot(value);
    return root ? localPlace(root) : null;
  }
  if (!value || typeof value !== "object") return null;
  // Read field by field rather than through the union: a blob off disk is not
  // a `PlaceRef` until this function says so, and typing it as one up front
  // makes the two `kind`s cancel each other out.
  const raw = value as Record<string, unknown>;
  const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
  if (raw.kind === "local") {
    const root = normalizeRoot(text(raw.repoRoot));
    return root ? localPlace(root) : null;
  }
  if (raw.kind !== "remote") return null;
  const machineId = text(raw.machineId) || undefined;
  const threadKey = text(raw.threadKey) || undefined;
  const repoRoot = normalizeRoot(text(raw.repoRoot)) || undefined;
  // "Names neither a box nor a conversation nor a project" is the one remote
  // shape with nothing to re-open — `remotePlaceKey` would hand back the same
  // wildcard key for every such member and a club would collapse into one row.
  if (!machineId && !threadKey && !repoRoot) return null;
  return remotePlace({ machineId, threadKey, repoRoot });
}

/** Drop repeats, keeping the first spelling of each place. Order is the user's
 *  — a club is drawn in the order it was built. */
export function dedupePlaces(refs: readonly PlaceRef[]): PlaceRef[] {
  const seen = new Set<string>();
  const out: PlaceRef[] = [];
  for (const ref of refs) {
    const key = placeKey(ref);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}
