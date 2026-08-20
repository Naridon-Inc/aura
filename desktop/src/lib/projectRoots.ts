// Which projects does this app know about, and which one is a place scoped to?
//
// Three surfaces needed the same two answers and only one of them had them.
// Crew worked out the roots for its own overview and kept the enumerator to
// itself; the Tasks, Pages and Team rails had no notion of a project at all,
// so they silently showed whatever the app happened to have open and gave you
// no way to say "the other one". That is the wrong shape for a rail: the
// things listed in it — tasks, sprints, workstreams, documents — belong to a
// project, so choosing the project is part of using the rail, not something
// you do somewhere else and hope it took.
//
// So the enumerator lives here, where anything can reach it, and the scope
// each place is looking at lives here beside it.
//
// ONE SCOPE PER PLACE, AND THE RAIL OWNS IT. Every body inside a place reads
// the answer from here — `rootsForScope` where it can draw several projects,
// `usePlaceRoot`/`placeRootOf` where it can only draw one. A body that keeps
// its own idea of the project is the bug this module exists to prevent, in
// both directions: a rail counting one set over a body drawing another is
// worse than a rail with no picker, and a body that grows a SECOND picker to
// compensate leaves the reader two controls that disagree. Crew had exactly
// that second picker; it is gone, and its enumerator went with it.

import { useEffect, useState } from "react";

import { api, type Task } from "./api";
import { isManagedWorktreeRoot, projectIdForRoot, sameRoot } from "./hudProjects";
import { fetchTasks } from "./tasksCache";
import { worktreeParentRoot } from "./workspaceLabel";

/** A project the app knows about. `id` is the registry's `p-<hex>` — carried
 *  because it is the ONLY thing that ties a managed worktree back to the
 *  project it is a copy of (see `projectRootFor`), and optional because the
 *  localStorage recents have no ids to give. */
export type KnownProject = { root: string; label?: string; id?: string };

/** Last path segment of a root, as a fallback display name. Tolerates trailing
 *  slashes and Windows-style separators so a name always comes out non-empty. */
export function projectNameFromRoot(root: string): string {
  const segs = root.split(/[\\/]+/).filter(Boolean);
  return segs.length > 0 ? segs[segs.length - 1] : root;
}

/** The project a root belongs to — folding a parallel copy back onto the thing
 *  it is a copy of.
 *
 *  A place is scoped to a PROJECT. When an agent's worktree happens to be the
 *  checkout the app has open, every rail here was handed that worktree as if it
 *  were a project of its own, so the Tasks picker sat there reading "marrakesh"
 *  — the name of one parallel copy — with the project it belongs to (Shopify)
 *  nowhere on the list, and the board beneath it reading that copy's files
 *  rather than the shared board.
 *
 *  Two layouts, two ways home. `<repo>/.aura/worktrees/<leaf>` says where it
 *  came from in the path. The managed store `~/.aura/worktrees/p-<hash>/<leaf>`
 *  does not: `p-<hash>` is a Rust hash of the repo root that JS cannot reverse
 *  — but the registry hands us the same id beside each project, so the way back
 *  is to look it up rather than to compute it. A copy whose project isn't in
 *  the registry keeps its own root; a wrong project would be worse than a
 *  literal one. */
export function projectRootFor(root: string, known: KnownProject[]): string {
  if (!root || !isManagedWorktreeRoot(root)) return root;
  const parent = worktreeParentRoot(root);
  if (parent) return parent;
  const withIds = known.flatMap((k) => (k.id ? [{ id: k.id, root: k.root }] : []));
  const id = projectIdForRoot(root, withIds);
  const hit = id ? known.find((k) => k.id === id) : undefined;
  return hit?.root ?? root;
}

/** Enumerate the project roots the app knows about, most-recently-opened
 *  first, de-duplicated. Prefers the backend registry (`~/.aura/projects.json`
 *  via `projectsList` — the same source the loop runner resolves task roots
 *  against), and falls back to the `aura.recents` localStorage list the
 *  workspace rail + onboarding "Recent" already use. Optionally seed with the
 *  currently-open root so the active project is always present even on a fresh
 *  registry. Never throws.
 *
 *  Returns `{ root, label? }` so the caller can prefer the registry's label
 *  over a path-derived name. */
export async function knownProjectRoots(
  currentRoot?: string,
): Promise<KnownProject[]> {
  const out: KnownProject[] = [];
  const seen = new Set<string>();
  const push = (root: string, label?: string, id?: string) => {
    if (!root || seen.has(root)) return;
    seen.add(root);
    out.push({ root, label, id });
  };

  // Backend registry first — authoritative, shared with the loop runner. It
  // has to be read BEFORE the open root is pushed, because the open root may
  // be one of an agent's parallel copies and the registry is what tells us
  // which project that copy belongs to.
  let registry: KnownProject[] = [];
  try {
    registry = (await api.projectsList()).map((e) => ({
      root: e.root,
      label: e.label,
      id: e.id,
    }));
  } catch {
    /* registry unavailable — fall through to the localStorage recents */
  }

  // The open project leads — it's the one the surface mounted on, and we want
  // it present even if the registry is empty on a brand-new install. Folded
  // onto its project first: a place lists projects, and one agent's copy of a
  // project is not a fifth project.
  if (currentRoot) {
    const open = projectRootFor(currentRoot, registry);
    const hit = registry.find((k) => sameRoot(k.root, open));
    push(open, hit?.label, hit?.id);
  }

  for (const k of registry) push(k.root, k.label, k.id);

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

// ─── The scope a place is looking at ────────────────────────────────────────
//
// One value, shared by a place's rail and its body, because a rail that counts
// one set over a body drawing another is worse than no rail. `ALL_PROJECTS` is
// a real option, not a label: a surface that offers it has to read every root.
// A surface that can't honour it must not list it.

/** The scope sentinel meaning "every project I know about". */
export const ALL_PROJECTS = "*";

/** A place's project scope: a repo root, or `ALL_PROJECTS`. */
export type ProjectScope = string;

export function isAllProjects(scope: ProjectScope): boolean {
  return scope === ALL_PROJECTS;
}

const KEY = "aura.place.scope";

const subs = new Set<() => void>();
let scope: ProjectScope = read();

function read(): ProjectScope {
  try {
    return localStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
}

/** Point the places at a project — or at all of them. Empty string means
 *  "whatever the app has open", which is where a fresh install starts. */
export function setProjectScope(next: ProjectScope): void {
  if (next === scope) return;
  scope = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    /* private mode — the choice just won't outlive the session */
  }
  for (const fn of subs) fn();
}

export function getProjectScope(): ProjectScope {
  return scope;
}

export function subscribeProjectScope(fn: () => void): () => void {
  subs.add(fn);
  return () => subs.delete(fn);
}

/** The project scope, as a hook. The rail that offers the picker and the
 *  surface that draws the result both read it, so it lives in a store rather
 *  than in either one's state — a rail counting one set over a body drawing
 *  another is the bug this exists to make impossible. */
export function useProjectScope(): ProjectScope {
  const [current, setCurrent] = useState(getProjectScope);
  useEffect(
    () => subscribeProjectScope(() => setCurrent(getProjectScope())),
    [],
  );
  return current;
}

/** Every scoped project's tasks, tagged with the root each came from, so a
 *  merged surface can still route a change back to the file it came out of.
 *  One project failing to read is that project contributing nothing, never
 *  the whole list failing. */
export async function loadTasksForRoots(
  roots: string[],
): Promise<Array<Task & { __root: string }>> {
  const per = await Promise.all(
    roots.map((root) =>
      fetchTasks(root)
        .then((ts) => ts.map((t) => ({ ...t, __root: root })))
        .catch(() => [] as Array<Task & { __root: string }>),
    ),
  );
  return per.flat();
}

/** The projects the app knows about, as a hook. Re-read when the open project
 *  changes, because opening a folder is how a new one gets on the list. */
export function useKnownProjects(openRoot: string): KnownProject[] {
  const [known, setKnown] = useState<KnownProject[]>([]);
  useEffect(() => {
    let live = true;
    void knownProjectRoots(openRoot).then((rs) => {
      if (live) setKnown(rs);
    });
    return () => {
      live = false;
    };
  }, [openRoot]);
  return known;
}

/** The one project a place is pointed at.
 *
 *  Most surfaces read a project at a time — a page editor saves into one
 *  repo, a chat room belongs to one repo — so All projects has no meaning for
 *  them and they fall back to the open one. Their picker shows THIS value
 *  rather than the raw scope, so it names the project actually on screen
 *  instead of going blank on a scope it can't honour.
 *
 *  Pure so it can be tested: a surface reading the scope through anything but
 *  this — its own `repoRoot` prop, a root captured at mount — is a surface the
 *  picker cannot move, which is the whole failure this file exists to prevent. */
export function placeRootOf(
  scope: ProjectScope,
  openRoot: string,
  known: KnownProject[],
): string {
  const roots = rootsForScope(scope, openRoot, known);
  return roots.length === 1 ? roots[0]! : projectRootFor(openRoot, known);
}

export function usePlaceRoot(openRoot: string): string {
  const scope = useProjectScope();
  const known = useKnownProjects(openRoot);
  return placeRootOf(scope, openRoot, known);
}

/** What to call the project a place is pointed at.
 *
 *  A root alone is a path; the surfaces that take a name beside it (Team's
 *  chat model, a header) were handed the OPEN project's name, so following the
 *  picker to another project kept the old project's name on screen. Prefers
 *  the registry's own label — the same string the picker's rows show — so one
 *  project isn't called two things one column apart.
 *
 *  `fallback` is for the caller that already knows this root's name from
 *  somewhere better than the path (the app knows the OPEN project's), so pass
 *  it only when it is a name for THIS root — a fallback belonging to another
 *  project is the bug this function was written to fix. */
export function placeProjectName(
  root: string,
  known: KnownProject[],
  fallback?: string,
): string {
  const hit = known.find((k) => k.root === root);
  const label = hit?.label?.trim();
  if (label) return label;
  if (fallback?.trim()) return fallback.trim();
  return projectNameFromRoot(root);
}

/** A stable string for a root list, for use as a React dependency.
 *
 *  Three surfaces derive the same list and each has to re-key an effect on it;
 *  a fresh array every render restarts a 10s poll forever, so they all reach
 *  for a joined string. They reached for a different separator each — and a
 *  space is not one: this very repo lives under "New Git", so ["/a/New",
 *  "Git/b"] and ["/a/New Git/b"] joined on a space are the same key and one
 *  scope silently answers for the other. NUL cannot occur in a path. */
export function rootsKeyOf(roots: string[]): string {
  return roots.join("\u0000");
}

/** The roots a surface should actually read, given the scope it's in and the
 *  project the app has open. One root in every case except All projects, so a
 *  caller can always `Promise.all` over the result and mean it. */
export function rootsForScope(
  scope: ProjectScope,
  openRoot: string,
  known: KnownProject[],
): string[] {
  // Fold once, here, because this is where every surface asks the question.
  // `scope` is already a project — it came out of the picker's own list — so
  // only the open checkout can be one of an agent's copies.
  const open = projectRootFor(openRoot, known);
  if (isAllProjects(scope)) {
    const roots = known.map((k) => k.root);
    return roots.length > 0 ? roots : open ? [open] : [];
  }
  const one = scope || open;
  return one ? [one] : [];
}

/** What a rail's project picker should show as its current value: the chosen
 *  scope, or — before anything has been chosen — the project the open checkout
 *  belongs to. A rail that shows the raw open root here names an agent's copy
 *  in a list that contains only projects, so the control opens with nothing
 *  selected and looks broken. */
export function scopeValueOf(
  scope: ProjectScope,
  openRoot: string,
  known: KnownProject[],
): string {
  return scope || projectRootFor(openRoot, known);
}
