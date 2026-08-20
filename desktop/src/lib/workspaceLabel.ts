// Plain-language names for workspaces — the audience is non-engineers.
//
// When you hand work to an agent (or run several in parallel) Aura gives each
// one its own private copy of the project, kept as a machine-created git
// worktree at `<parent>/.{claude,gemini,aura}/worktrees/<leaf>`. The <leaf> is
// a raw hash like "agent-a6f18ff2744081fe1" — surfaced verbatim in the
// workspace switcher it reads as gibberish, exactly the kind of machine jargon
// a vibecoder shouldn't have to decode.
//
// These helpers turn such a root — or a machine worktree branch — into
// "<project> · copy": the words for "a parallel copy of my project that an
// agent works in". A worktree that carries a real name (a place-name, a
// feature slug) keeps it: "<project> · kyoto".

// A name you typed always wins over a name we derived. Both entry points below
// consult it first, so renaming a workspace once renames it in the roster, the
// fleet list, the status bar and the Live control plane at the same moment —
// there is no fifth place that has to be told.
import { getWorkspaceName } from "./workspaceCustomization";

// Captures the parent path (group 1) + the worktree leaf (group 2).
const WORKTREE_PATH_RE = /^(.*?)\/\.(?:claude|gemini|aura)\/worktrees\/([^/]+)\/?$/;

// The bundled sample ("Recipe Box") is seeded at ~/AuraProjects/recipe-box and
// surfaced as the always-present "Get Started" project (Conductor's Quickstart
// idea) the app boots onto on first run — so its switcher/roster label reads
// "Get Started", not the raw folder name.
const SAMPLE_ROOT_SUFFIX = "/AuraProjects/recipe-box";

/** True when `root` is the bundled Get Started (Recipe Box) sample project. */
export function isSampleRoot(root: string): boolean {
  return root.replace(/\/+$/, "").endsWith(SAMPLE_ROOT_SUFFIX);
}

// A worktree leaf or branch segment with no human meaning: `agent-<hex>`,
// `worktree-agent-<hex>`, `lane-<hex>`, `work-<hex>`, `p-<hex>`, or a bare hash.
const MACHINE_LEAF_RE = /^(?:worktree-)?(?:agent|lane|work|p)[-_]?[0-9a-f]{6,}$|^[0-9a-f]{8,}$/i;

// A calm list of place names. An agent's parallel copy earns a memorable handle
// ("New Git · Austin") instead of a hash — the same idea Conductor uses for its
// chats. Deterministic: a given worktree always maps to the same name, so the
// label stays stable across restarts. Recognizable, soothing places.
const COPY_NAMES = [
  "Austin", "Kyoto", "Lisbon", "Oslo", "Denver", "Aspen", "Sedona", "Ojai",
  "Tahoe", "Ghent", "Porto", "Nara", "Hakone", "Cusco", "Bergen", "Galway",
  "Ronda", "Annecy", "Bruges", "Cascais", "Tofino", "Banff", "Telluride",
  "Bend", "Boulder", "Ithaca", "Savannah", "Asheville", "Taos", "Moab",
  "Sitka", "Leuven", "Utrecht", "Delft", "Hobart", "Nelson", "Wanaka",
  "Kaikoura", "Matera", "Siena", "Assisi", "Lucca", "Bath", "York", "Wells",
  "Totnes", "Kendal", "Ludlow", "Marlow", "Sintra", "Hallstatt", "Lofoten",
  "Positano", "Giverny", "Vail", "Bozeman", "Sonoma", "Carmel", "Mendocino",
  "Queenstown",
];

// FNV-1a over the seed → a stable index. Any string works; we feed the worktree
// leaf's hash so the same copy always lands on the same name.
function seedIndex(seed: string, mod: number): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % mod;
}

/** A stable, soothing place-name for a machine worktree leaf
 *  (`agent-a6f18ff…` → "Austin"). Deterministic per leaf. */
export function copyName(leaf: string): string {
  const seed =
    leaf.replace(/^(?:worktree-)?(?:agent|lane|work|p)[-_/]/i, "").trim() || leaf;
  return COPY_NAMES[seedIndex(seed, COPY_NAMES.length)];
}

/** True when `root` is a machine-created agent/parallel worktree checkout —
 *  not a project the user opened themselves. */
export function isWorktreeRoot(root: string): boolean {
  return WORKTREE_PATH_RE.test(root);
}

/** True when a branch/leaf segment is a machine hash carrying no real meaning. */
export function isMachineLeaf(leaf: string): boolean {
  return MACHINE_LEAF_RE.test(leaf.trim());
}

/** The project a worktree is a copy OF, as a path — but only for the layout
 *  that says so in the path itself (`<repo>/.aura/worktrees/<leaf>`).
 *
 *  The managed layout (`~/.aura/worktrees/p-<hash>/<leaf>`) names its project
 *  by a hash of the repo root, and that hash is computed in Rust and cannot be
 *  reversed here — so it needs the project registry to be read back, which is
 *  `projectRootFor` in projectRoots.ts. This returns null for it rather than
 *  guessing. */
export function worktreeParentRoot(root: string): string | null {
  const m = root.match(WORKTREE_PATH_RE);
  return m ? m[1] || null : null;
}

/** Just the parent project's folder name for a worktree root (e.g. "New Git"),
 *  or null when `root` isn't a worktree. Use when you want the bare project
 *  name without the "· copy" suffix — e.g. the sentence "a copy of <parent>". */
export function worktreeParentName(root: string): string | null {
  const parent = worktreeParentRoot(root);
  if (!parent) return null;
  return parent.split("/").filter(Boolean).pop() ?? null;
}

/** Human label for a workspace root. Worktrees become "<project> · copy" (or
 *  "<project> · <name>" when the copy was given a real name); everything else
 *  keeps the name it was opened with, or falls back to its folder name. */
export function humanizeWorkspaceName(root: string, fallbackName?: string): string {
  const named = getWorkspaceName(root);
  if (named) return named;
  if (isSampleRoot(root)) return "Get Started";
  const m = root.match(WORKTREE_PATH_RE);
  if (m) {
    const parent = m[1].split("/").filter(Boolean).pop() ?? "project";
    const leaf = m[2];
    if (isMachineLeaf(leaf)) return `${parent} · ${copyName(leaf)}`;
    const pretty = leaf
      .replace(/^(?:worktree-)?(?:agent|lane|work|p)[-_/]/i, "")
      .replace(/[-_+]+/g, " ")
      .trim();
    return pretty ? `${parent} · ${pretty}` : `${parent} · ${copyName(leaf)}`;
  }
  return fallbackName ?? root.split("/").filter(Boolean).pop() ?? root;
}

/** "feat/s1-manifest-signing-prep" → "manifest signing prep": a branch read
 *  aloud, for the row title. A machine worktree branch carries no human
 *  meaning — de-hyphenating `worktree-agent-a6f18ff…` just yields "worktree
 *  agent a6f18ff…" — so it is called what it is.
 *
 *  Lives here, with the rest of the plain-language naming, because three
 *  surfaces answer "what is this copy called?" and were answering it three
 *  ways: the roster humanised, the fleet list humanised separately, and the
 *  Live control plane didn't humanise at all — so one checkout read
 *  "worktree control plane" on one tab of a page and `feat/worktree-control-
 *  plane` on the next.
 *
 *  Pass `path` (the checkout's own path) wherever you have it and a name the
 *  user typed wins over anything derived from the branch. It's optional only
 *  because two callers genuinely hold a branch and no checkout; they get the
 *  derived name, which is what they showed before. */
export function humanizeCopyTitle(
  branch: string,
  isMain: boolean,
  path?: string,
): string {
  const named = path ? getWorkspaceName(path) : undefined;
  if (named) return named;
  if (isMain && !branch) return "main copy";
  const seg = branch.split("/").pop() ?? branch;
  if (!seg) return isMain ? "main copy" : "detached copy";
  if (isMachineLeaf(seg)) return "parallel copy";
  const cleaned = seg
    .replace(/^(feat|fix|chore|refactor|docs|test|perf)[-_/]?/i, "")
    .replace(/^\d+[-_]/, "")
    .replace(/[-_]/g, " ")
    .trim();
  return cleaned || seg;
}

/** Does printing the branch beside the title tell you anything you can't
 *  already read in the title?
 *
 *  Almost never — the title IS the branch read aloud, so a row that shows
 *  both shows one string twice in two typefaces ("workspaces page" /
 *  `feat/workspaces-page`, "bergen" / `bergen`). Comparing them literally
 *  never caught it, because a slug is never `===` the sentence made out of
 *  it; compare the shapes instead. What survives the test is the case that
 *  genuinely needs both: a machine worktree, whose title is the generic
 *  "parallel copy" and whose slug is the only thing telling two of them
 *  apart. */
export function branchAddsNothing(branch: string, title: string): boolean {
  if (!branch) return true;
  const shape = (s: string) =>
    s
      .toLowerCase()
      .replace(/^(feat|fix|chore|refactor|docs|test|perf|release)[-_/]/, "")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  return shape(branch) === shape(title);
}

/** Quiet sub-label for a switcher/roster row. A worktree says what it is in
 *  plain words instead of dumping the `/.aura/worktrees/agent-…` path; a real
 *  project shows a shortened path so you can still tell two same-named folders
 *  apart. `mono` flags whether the text is a path (monospace) or prose. */
export function workspaceSublabel(root: string): { text: string; mono: boolean } {
  if (isWorktreeRoot(root)) {
    return { text: "Parallel copy · an agent's workspace", mono: false };
  }
  const parts = root.split("/").filter(Boolean);
  const text = parts.length <= 2 ? root : `…/${parts.slice(-2).join("/")}`;
  return { text, mono: true };
}
