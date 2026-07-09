// Club store — opt-in cross-workspace pinning.
//
// By default each workspace owns its own tab set (see workspaceSnapshot.ts).
// Switching workspaces serializes the outgoing tabs and hydrates the
// incoming ones. That's the right model 95% of the time — projects
// shouldn't bleed into each other.
//
// But sometimes the user is genuinely working across two projects at
// once (a backend repo + its frontend, a library + the consumer app).
// Forcing them to switch back-and-forth and losing context every time
// is hostile. The club is the escape hatch: drag a tab from project A's
// tab strip onto project B's rail tile, and a "clubbed" pseudo-workspace
// appears on the rail. Click it to enter a unified view where tabs from
// both A and B coexist. Leave the club, and each workspace keeps its
// own tab set unchanged.
//
// Design notes:
//   - One club at a time in v1. Two-club scenarios add UI complexity
//     (which club is active? what's the tile?) that doesn't pay off
//     until someone asks for it.
//   - Membership is a `Set<repoRoot>` persisted in localStorage. We
//     don't store tabs in the club — tabs always live in their owning
//     workspace's snapshot. The club is just a viewing mode that
//     unions the snapshots.
//   - "Active club" is a separate flag from membership so the user can
//     leave the club without dissolving it, then re-enter later.
//   - Dissolve = wipe membership + clear active flag. No undo.

const STORAGE_KEY = "aura.workspaceClub.v1";

export type ClubState = {
  /** Repo roots currently in the club. Empty = no club exists. */
  members: string[];
  /** True when the user is viewing the clubbed surface rather than
   *  a single workspace. When true, the rail's clubbed tile is the
   *  "active" workspace and `App.tsx project.root` should reflect
   *  the most recent member root (for shell commands that need a
   *  concrete cwd). */
  active: boolean;
};

function emptyState(): ClubState {
  return { members: [], active: false };
}

function load(): ClubState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyState();
    const parsed = JSON.parse(raw) as ClubState;
    if (!parsed || !Array.isArray(parsed.members)) return emptyState();
    return {
      members: parsed.members.filter((m) => typeof m === "string"),
      active: Boolean(parsed.active),
    };
  } catch {
    return emptyState();
  }
}

function save(s: ClubState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* quota — club is best-effort */
  }
}

let state: ClubState = load();
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function commit(next: ClubState) {
  state = next;
  save(state);
  emit();
}

export function getClubState(): ClubState {
  return state;
}

export function subscribeClub(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Add a workspace to the club. If the club is empty this seeds the
 *  initial pair (caller is expected to add both roots in sequence). */
export function addToClub(repoRoot: string): void {
  if (!repoRoot) return;
  if (state.members.includes(repoRoot)) return;
  commit({ members: [...state.members, repoRoot], active: state.active });
}

/** Drop a workspace from the club. If membership falls to ≤1 the club
 *  auto-dissolves — a club of one is just a regular workspace. */
export function removeFromClub(repoRoot: string): void {
  const next = state.members.filter((m) => m !== repoRoot);
  if (next.length <= 1) {
    commit(emptyState());
  } else {
    commit({ members: next, active: state.active });
  }
}

export function dissolveClub(): void {
  commit(emptyState());
}

export function setClubActive(active: boolean): void {
  if (state.active === active) return;
  commit({ members: state.members, active });
}

/** Convenience for the drag-to-tile gesture: starts a club from two
 *  roots (or extends an existing one with the new root) and activates
 *  it so the rail's clubbed tile lights up immediately. */
export function clubWith(currentRoot: string, addedRoot: string): void {
  if (!currentRoot || !addedRoot || currentRoot === addedRoot) return;
  const members = new Set(state.members);
  members.add(currentRoot);
  members.add(addedRoot);
  commit({ members: [...members], active: true });
}
