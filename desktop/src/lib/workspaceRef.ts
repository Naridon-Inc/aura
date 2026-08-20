// What a workspace and its sibling copies are, as plain data.
//
// These types used to live in components/WorkspaceRail.tsx, which meant five
// files that only ever wanted the shape — the roster, the hover card, the
// Workspaces surface and its model, the app shell — imported a 820-line rail
// component to get it. That rail rendered only under the legacy shell nobody
// could reach, and it's gone; the shape it described is still the app's.

export type WorktreeRef = {
  path: string;
  branch: string;
  head: string;
  is_main: boolean;
  locked: boolean;
  /** Unix seconds of the HEAD commit's committer date (from
   *  `git_worktree_list`). Powers the Workspaces view's recency grouping.
   *  Absent/null when the branch tip can't be resolved. */
  head_committed_at?: number | null;
};

export type Workspace = {
  id: string;
  /** Single character shown when there's no emoji. */
  letter: string;
  /** Optional emoji glyph. When set, renders in place of the letter. New
   *  workspaces prompt for one on creation; older ones keep the letter. */
  emoji?: string;
  active: boolean;
  /** Tint for the project's avatar — see `accentForRoot`. */
  accent?: string;
  /** Sibling worktrees on this repo's git dir. */
  worktrees?: WorktreeRef[];
  /** Agents in this workspace currently waiting for the user. */
  unread?: number;
};

// Every project shares one neutral tint. This used to hash the workspace root
// into one of eight hues; past a handful of projects that read as a paint
// chart, and it gave colour a meaning it never carried — a project's identity
// is its avatar and letter, and the only one that needs emphasis is the one
// you're in. Colour comes back only when the user picks an emoji for it
// (`accentForEmoji`) — i.e. when they asked for it.
//
// Still a function of the root because that's what every call site has, and
// because the day per-project identity earns its colour back this is where it
// goes.
export function accentForRoot(_root: string): string {
  return "var(--color-text-3)";
}
