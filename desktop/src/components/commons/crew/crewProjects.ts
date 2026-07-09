// Cross-project Crew — client-side aggregation (no backend change).
//
// Crew's board is per-repo: `api.loopReadyView(root)` returns one project's
// ready/working/done/blocked/paused view. To show crews across EVERY project
// the user has open — like Conductor's "All projects" — we don't need a new
// Rust command: we already know the project roots (the backend's
// `~/.aura/projects.json` via `api.projectsList()`, with the `aura.recents`
// localStorage list as a fallback), so we fetch each root's ready-view once
// and merge the counts entirely in the frontend.
//
// This module is the pure/helper layer: it owns "given the known roots, what
// is each project's crew doing", with per-project failure tolerated — a
// project with no crew (or one that can't be read) shows zeros, never an error
// that kills the whole overview. The surface (CrewSurface.tsx) reads the
// aggregate and the per-project raw view straight from here.

import { api } from "../../../lib/api";
import type { LoopReadyCounts, ReadyViewDto } from "../../../lib/api";

/** A zeroed counts block — the shape a project with no crew (or an unreadable
 *  one) reports. Keeps every consumer numeric, never undefined. */
const ZERO_COUNTS: LoopReadyCounts = {
  ready: 0,
  blocked: 0,
  working: 0,
  done: 0,
  paused: 0,
  other: 0,
};

/** A flat, plain-language tally of one project's crew — what the overview
 *  cards and the project tab pills read. Derived from `LoopReadyCounts` plus a
 *  `total` so callers never re-sum. */
export type CrewProjectProgress = {
  ready: number;
  working: number;
  done: number;
  blocked: number;
  paused: number;
  /** Every node in the project's graph (the denominator for "{done}/{total}"). */
  total: number;
};

/** One project's crew, as the cross-project surface needs it: where it lives,
 *  what to call it, its progress tally, and — for the tab that's actually
 *  selected — the raw ready-view to hand straight to the existing board. */
export type CrewProjectSummary = {
  /** Absolute repo root — the key everything is scoped by. */
  root: string;
  /** Plain-language name (backend label, else the root's last path segment). */
  name: string;
  progress: CrewProjectProgress;
  /** The full per-project ready-view, when it loaded — null if the read
   *  failed for this project (the project still appears, just with zeros). */
  view: ReadyViewDto | null;
  /** Whether this project read failed (so the card can stay quiet, not error). */
  errored: boolean;
};

/** The whole cross-project picture: one summary per known project, ordered as
 *  the roots came in (the backend lists most-recently-opened first). */
export type CrewProjectsAggregate = {
  projects: CrewProjectSummary[];
};

/** Last path segment of a root, as a fallback display name. Tolerates trailing
 *  slashes and Windows-style separators so a name always comes out non-empty. */
export function projectNameFromRoot(root: string): string {
  const segs = root.split(/[\\/]+/).filter(Boolean);
  return segs.length > 0 ? segs[segs.length - 1] : root;
}

/** Counts → flat progress tally, with the `total` summed once here. */
function progressFromCounts(c: LoopReadyCounts): CrewProjectProgress {
  return {
    ready: c.ready,
    working: c.working,
    done: c.done,
    blocked: c.blocked,
    paused: c.paused,
    total: c.ready + c.blocked + c.working + c.done + c.paused + c.other,
  };
}

/** Enumerate the project roots the app knows about, most-recently-opened
 *  first, de-duplicated. Prefers the backend registry (`~/.aura/projects.json`
 *  via `projectsList` — the same source the Manager loop resolves task roots
 *  against), and falls back to the `aura.recents` localStorage list the
 *  workspace rail + onboarding "Recent" already use. Optionally seed with the
 *  currently-open root so the active project is always present even on a fresh
 *  registry. Never throws.
 *
 *  Returns `{ root, label? }` so the caller can prefer the registry's label
 *  over a path-derived name. */
export async function knownCrewProjectRoots(
  currentRoot?: string,
): Promise<Array<{ root: string; label?: string }>> {
  const out: Array<{ root: string; label?: string }> = [];
  const seen = new Set<string>();
  const push = (root: string, label?: string) => {
    if (!root || seen.has(root)) return;
    seen.add(root);
    out.push({ root, label });
  };

  // The open project leads — it's the one the surface mounted on, and we want
  // it present even if the registry is empty on a brand-new install.
  if (currentRoot) push(currentRoot);

  // Backend registry first — authoritative, shared with the loop runner.
  try {
    const entries = await api.projectsList();
    for (const e of entries) push(e.root, e.label);
  } catch {
    /* registry unavailable — fall through to the localStorage recents */
  }

  // localStorage recents fill any gap (and cover the pre-registry case).
  try {
    const raw = localStorage.getItem("aura.recents");
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const p of parsed) if (typeof p === "string") push(p);
      }
    }
  } catch {
    /* no recents / malformed — registry + currentRoot are enough */
  }

  return out;
}

/** Fetch one project's ready-view, tolerating failure: a project whose crew
 *  can't be read (no `.aura/a2a/`, a path that moved, a transient error) comes
 *  back as a zeroed, `errored` summary rather than rejecting — so one bad
 *  project never blanks the whole overview. */
async function loadOneProject(
  root: string,
  label?: string,
): Promise<CrewProjectSummary> {
  const name = label?.trim() || projectNameFromRoot(root);
  try {
    const view = await api.loopReadyView(root);
    return {
      root,
      name,
      progress: progressFromCounts(view.counts ?? ZERO_COUNTS),
      view,
      errored: false,
    };
  } catch {
    return {
      root,
      name,
      progress: progressFromCounts(ZERO_COUNTS),
      view: null,
      errored: true,
    };
  }
}

/** Load the cross-project aggregate: every known project's crew progress, in
 *  parallel, deterministic in input order. Resilient by construction — each
 *  project is loaded with `loadOneProject`, which never rejects, so the whole
 *  call resolves even if half the projects are unreadable.
 *
 *  Pass the explicit `roots` (already enumerated via `knownCrewProjectRoots`)
 *  so the surface controls when project discovery runs vs. when views refresh. */
export async function loadCrewProjects(
  roots: Array<{ root: string; label?: string }>,
): Promise<CrewProjectsAggregate> {
  const projects = await Promise.all(
    roots.map(({ root, label }) => loadOneProject(root, label)),
  );
  return { projects };
}

/** Roll the per-project tallies into one all-projects line for the overview
 *  header ("{done}/{total} done across N projects"). Pure. */
export function rollupProgress(
  projects: CrewProjectSummary[],
): CrewProjectProgress {
  return projects.reduce<CrewProjectProgress>(
    (acc, p) => ({
      ready: acc.ready + p.progress.ready,
      working: acc.working + p.progress.working,
      done: acc.done + p.progress.done,
      blocked: acc.blocked + p.progress.blocked,
      paused: acc.paused + p.progress.paused,
      total: acc.total + p.progress.total,
    }),
    { ready: 0, working: 0, done: 0, blocked: 0, paused: 0, total: 0 },
  );
}
