// proveCache — a process-lifetime, in-memory stale-while-revalidate cache for
// `aura prove --goal <text> --json` outcomes, keyed by (repoRoot, goal text).
//
// Why this exists: the Goals surface (GoalProbe's `autoExplain`) re-shells the
// `aura` CLI through `runProveStructured` on EVERY mount. Landing on a session
// Summary, closing it, and re-opening it paid the full cold prove cost each
// time, and the breakdown popped in a beat late. This cache lets a caller paint
// the last-known breakdown instantly (peekProveOutcome) and refresh quietly
// underneath (fetchProveOutcome), so re-landing is instant and the panel never
// blanks while it re-checks.
//
// Deliberately in-memory only (NOT localStorage): a proof outcome is a fact
// about the CURRENT code, which changes as the user edits. Persisting it across
// an app restart would risk showing a verdict for code that has since moved on.
// A process-lifetime cache is the right lifetime — it kills the re-mount re-run
// within a session and is dropped on relaunch, when the code may have changed.
//
// In-flight de-dup: several GoalProbes can mount for the same goal at once (a
// session with a few aligned goals). fetchProveOutcome shares one in-flight
// promise per key so they collapse onto a single CLI shell, not N.

import { runProveStructured, type ProveOutcome } from "./prove";

type Entry = {
  outcome?: ProveOutcome;
  fetchedAt: number;
  inflight?: Promise<ProveOutcome>;
};

const mem = new Map<string, Entry>();

/** Normalize the goal text the same way goalStore identifies a goal, so the
 *  cache key matches regardless of incidental whitespace / case. `atCommit` is
 *  part of the key: proving the same goal at a commit vs. the working tree are
 *  distinct facts and must never share a cache slot. The `\0` separators can't
 *  appear in a path, sha, or goal, so keys never collide across the fields. */
function keyFor(repoRoot: string, goal: string, atCommit?: string): string {
  const norm = goal.trim().toLowerCase().replace(/\s+/g, " ");
  return `${repoRoot}\0${atCommit ?? ""}\0${norm}`;
}

/** The last-known outcome for (repoRoot, goal[, atCommit]), or null if never
 *  proved this session. Synchronous — pair it with fetchProveOutcome for SWR:
 *  seed state from this for an instant paint, then let the fetch refresh it. */
export function peekProveOutcome(
  repoRoot: string,
  goal: string,
  atCommit?: string,
): ProveOutcome | null {
  const e = mem.get(keyFor(repoRoot, goal, atCommit));
  return e?.outcome ?? null;
}

/** Store a freshly-computed outcome (e.g. from a manual Verify that ran the
 *  prove itself) so later mounts paint it instantly. */
export function writeProveOutcome(
  repoRoot: string,
  goal: string,
  outcome: ProveOutcome,
  atCommit?: string,
): void {
  const k = keyFor(repoRoot, goal, atCommit);
  const prev = mem.get(k);
  mem.set(k, { outcome, fetchedAt: Date.now(), inflight: prev?.inflight });
}

/** Run the structured prove with in-flight de-dup, writing the cache on
 *  success. Always resolves with the freshest outcome the CLI produced. A
 *  caller pairs this with peekProveOutcome so the panel shows the cached
 *  breakdown immediately and this quietly replaces it when it lands. */
export function fetchProveOutcome(
  repoRoot: string,
  goal: string,
  atCommit?: string,
): Promise<ProveOutcome> {
  const k = keyFor(repoRoot, goal, atCommit);
  const existing = mem.get(k);
  if (existing?.inflight) return existing.inflight;

  const p = runProveStructured(repoRoot, goal, atCommit)
    .then((outcome) => {
      const cur = mem.get(k);
      mem.set(k, { outcome, fetchedAt: Date.now(), inflight: cur?.inflight });
      return outcome;
    })
    .finally(() => {
      const cur = mem.get(k);
      if (cur) cur.inflight = undefined;
    });

  mem.set(k, {
    outcome: existing?.outcome,
    fetchedAt: existing?.fetchedAt ?? 0,
    inflight: p,
  });
  return p;
}
