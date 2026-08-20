// worktreeDiffCache — "how much has changed in each worktree?", asked once for
// everybody, in one round-trip.
//
// The Build roster puts a `+207 −1` badge on every worktree row. Two surfaces
// draw that roster — the sidebar roster in App and the Workspaces pane — and
// each mounts its own copy of `useWorktreeBadges`, each with its own 30-second
// timer, neither aware of the other. Every sweep asked the backend once per
// worktree.
//
// On a 49-worktree checkout that is 98 `invoke` calls per cycle. On macOS a
// Tauri `invoke` is not a function call: it is a `fetch` to a custom scheme
// handler, a hop out to the app process and back, on the same queue a terminal
// keystroke and its echo travel on. Measured on an idle app, nothing on screen
// moving: 129 of the 131 `git_diff_stats` calls in a 20-second window were this
// one sweep — a quarter of all the IPC in the app, spent on badges for
// worktrees nobody was looking at.
//
// Two changes, both here:
//
//   Ask for all of them at once. `gitDiffStatsBatch` takes the whole list and
//   returns the whole answer, running the per-worktree git work concurrently in
//   the backend instead of serially through the frontend's event loop. 49 hops
//   become one.
//
//   Ask once for both surfaces. The answers are cached per path, so the second
//   roster to sweep inside the window is served from what the first one read,
//   and only the paths nobody has a fresh answer for are put on the wire.
//
// A NOTE ON FAILURE, which is the whole reason the null handling below is
// explicit. Worktrees get removed while a roster is still holding the old list,
// so a path that cannot be read is ordinary, not exceptional. It must stay
// distinguishable from a worktree that is genuinely clean: "+0 −0" is a claim,
// and rendering a failed read as one puts a confident, wrong number on screen.
// A path we could not read is simply absent from the result, and the row shows
// no badge — which is what the caller's own `catch` did before this existed.

import { api, type DiffStats } from "./api";

/** How long one worktree's numbers stay good enough to hand to the next roster.
 *
 *  Sized just under the callers' 30-second refresh, on purpose. The two rosters
 *  mount seconds apart, so within a cycle the second one is served from the
 *  first one's read; on the next cycle the leading roster is past the window
 *  and does a real read. One backend sweep per cycle instead of two, without
 *  ever showing numbers from the cycle before. */
const FRESH_MS = 25_000;

type Entry = { value: DiffStats; readAt: number };

const cache = new Map<string, Entry>();
/** Per-path promises for a batch that is currently on the wire, so a second
 *  roster sweeping mid-flight joins that batch rather than starting its own. */
const inflight = new Map<string, Promise<DiffStats | null>>();
/** Bumped by an invalidation. A batch that was already out when the world
 *  changed is describing the old world: it is allowed to resolve, because
 *  someone is waiting on it, but it must not be written to the cache. */
let epoch = 0;

/** Diff totals for each of `paths`, keyed by path.
 *
 *  Paths that could not be read are absent from the returned record — never
 *  present with zeroes. The caller renders no badge for them.
 *
 *  Resolves rather than rejects: the batch as a whole failing is still a real
 *  outcome for each row (we don't know), and one bad path must not blank the
 *  other forty-eight. */
export async function fetchWorktreeDiffs(
  paths: string[],
): Promise<Record<string, DiffStats>> {
  const out: Record<string, DiffStats> = {};
  const now = Date.now();

  // Three buckets: already fresh, already on the wire, and nobody has asked.
  const joins: Array<[string, Promise<DiffStats | null>]> = [];
  const missing: string[] = [];
  for (const path of new Set(paths)) {
    const entry = cache.get(path);
    if (entry !== undefined && now - entry.readAt < FRESH_MS) {
      out[path] = entry.value;
      continue;
    }
    const pending = inflight.get(path);
    if (pending) {
      joins.push([path, pending]);
      continue;
    }
    missing.push(path);
  }

  if (missing.length > 0) {
    const startedIn = epoch;
    // One call, one hop, however many worktrees.
    const batch = api
      .gitDiffStatsBatch(missing)
      .then((rows) => {
        const byPath = new Map<string, DiffStats | null>();
        for (const row of rows) byPath.set(row.repo_root, row.stats);
        if (epoch === startedIn) {
          const readAt = Date.now();
          for (const [path, stats] of byPath) {
            // Only real answers are remembered. Caching a failure would turn
            // one bad moment into a whole freshness window of no badge, and
            // caching a zero would turn it into a wrong badge.
            if (stats) cache.set(path, { value: stats, readAt });
          }
        }
        return byPath;
      })
      .catch(() => new Map<string, DiffStats | null>());

    for (const path of missing) {
      const own = batch.then((byPath) => byPath.get(path) ?? null);
      inflight.set(path, own);
      // Clearing in a follow-up rather than inside `own` keeps every joiner
      // reading the same settled promise while it is still the current one.
      void own.finally(() => {
        if (inflight.get(path) === own) inflight.delete(path);
      });
      joins.push([path, own]);
    }
  }

  const settled = await Promise.all(joins.map(([, p]) => p));
  joins.forEach(([path], i) => {
    const stats = settled[i];
    if (stats) out[path] = stats;
  });
  return out;
}

/** Synchronous peek at what was last read for a path, however old. For a roster
 *  that would otherwise blank a badge it already knows while a sweep runs. */
export function peekWorktreeDiff(path: string): DiffStats | undefined {
  return cache.get(path)?.value;
}

/** Forget the worktree numbers, so the next roster sweep asks for real. */
export function invalidateWorktreeDiffs(): void {
  epoch += 1;
  cache.clear();
}

// A commit, a checkout, a job that touched files — all of them announce
// themselves this way and none of them says which worktree, so everything goes.
// Subscribing here rather than in the hook is the point: a badge is at its most
// misleading in the second right after the thing that changed it.
if (typeof window !== "undefined") {
  window.addEventListener("aura:git-changed", invalidateWorktreeDiffs);
}
