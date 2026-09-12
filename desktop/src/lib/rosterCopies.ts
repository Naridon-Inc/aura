// Which of a project's parallel copies the sidebar shows, and which fold away.
//
// A project here can have fifty-seven worktrees. Listing them all is a wall;
// listing none is a lie — and the rail told that lie for a while, showing one
// row and a `+57` pill for a project whose copies were all still on disk. So
// the rule is: surface the copies you could plausibly want right now, fold the
// rest into one disclosure that still counts them, and never let a copy
// disappear from both.
//
// Pure on purpose. The component that used to hold this logic is two thousand
// lines and reads localStorage mid-render, so nothing about the ranking could
// be tested. Everything here is arguments in, three lists out.

import type { WorktreeBadge } from "./useWorktreeBadges";
import type { WorktreeRef } from "./workspaceRef";

// A copy counts as "recently active" — and so stays surfaced rather than
// sinking into the disclosure — for an hour after it was last opened. Without
// this, switching to copy B would immediately hide copy A even though you
// were just there.
export const RECENT_MS = 60 * 60 * 1000;

// A copy you just made has no agent tab and no visit stamp, so every other
// rule ranks it inactive — it lands in the collapsed disclosure, and the rail
// looks like the worktree you created a minute ago was never created. A copy
// stays surfaced for a day after it appeared or was last committed to.
export const FRESH_MS = 24 * 60 * 60 * 1000;

// …but only the newest few. Crew adds copies ten at a time, and a rail that
// lists ten of them is the same unreadable wall as a rail that lists none.
export const FRESH_CAP = 5;

export type CopySplitInput = {
  rows: readonly WorktreeRef[];
  /** The copy the window is currently on. */
  activePath: string;
  /** Epoch ms. Passed in so a test can hold time still. */
  now: number;
  /** How many live agents are attached to a copy's path. */
  agentCount: (path: string) => number;
  /** Diff / PR / cloud marks, keyed by copy path. */
  badgeByPath?: Record<string, WorktreeBadge>;
  /** Epoch ms of when the app last opened each copy. */
  visited?: Record<string, number>;
};

export type CopySplit = {
  /** Rows the rail always shows. */
  primary: WorktreeRef[];
  /** `aura work` sessions — the human's own deliberate copies. Always shown,
   *  never counted in the disclosure. */
  workSessions: WorktreeRef[];
  /** Rows behind the "N other parallel copies" disclosure. */
  inactive: WorktreeRef[];
};

/** A machine's scratch checkout (`worktree-agent-…`), by branch or by dir. */
function isScratch(w: WorktreeRef, bare: string): boolean {
  return /^worktree-agent-/.test(bare) || /\/worktree-agent-[^/]*$/.test(w.path);
}

/** `aura work` copies (`work/<slug>` branch in a sibling `<repo>-work-<slug>`
 *  dir) are the HUMAN's deliberate parallel sessions, not crew scratch. */
function isWorkSession(w: WorktreeRef, bare: string): boolean {
  return /^work\//.test(bare) || /-work-[^/]+$/.test(w.path);
}

/** Work in flight counts as work — including a run on another machine, which
 *  looks idle locally and is the row you least want hidden. */
function hasWork(badge: WorktreeBadge | undefined): boolean {
  return (
    (!!badge && (badge.added > 0 || badge.removed > 0)) ||
    !!badge?.pr ||
    !!badge?.cloud
  );
}

/** When a copy last showed a sign of life: the day it was made, or its newest
 *  commit — whichever is later, 0 when neither is known.
 *
 *  Both halves are load-bearing. Birth alone misses a copy you have been
 *  working in all week; commit alone misses one cut today off a branch nobody
 *  has touched, because such a copy inherits the old tip's date. */
export function touchedAt(w: WorktreeRef): number {
  return Math.max((w.created_at ?? 0) * 1000, (w.head_committed_at ?? 0) * 1000);
}

export function splitCopies(input: CopySplitInput): CopySplit {
  const { rows, activePath, now, agentCount, badgeByPath, visited } = input;
  const ranked = rows.map((w) => {
    const bare = (w.branch || "").replace(/^refs\/heads\//, "");
    const active = w.path === activePath;
    const agent = agentCount(w.path) > 0;
    const seenAt = visited?.[w.path];
    const recentlyOpened = !!seenAt && now - seenAt < RECENT_MS;
    const touched = touchedAt(w);
    const rank = active
      ? 0
      : // The home checkout is always surfaced — it's a project's one stable
        // view, so it never sinks into the disclosure. Otherwise an idle
        // project showed the disclosure alone, with nothing to click.
        w.is_main || agent || recentlyOpened
        ? 1
        : hasWork(badgeByPath?.[w.path])
          ? 2
          : isScratch(w, bare)
            ? 4
            : 3;
    return {
      w,
      rank,
      work: isWorkSession(w, bare),
      freshAt: touched > 0 && now - touched < FRESH_MS ? touched : null,
    };
  });

  // Surface the newest few copies no other rule caught — ranked by when they
  // appeared, so "the one I just made" is the one that comes back. Capped, so
  // a batch of ten doesn't become the rail; the rest stay in the disclosure,
  // where the count still counts them.
  const promoted = new Set(
    ranked
      .filter((r) => !r.work && r.rank > 1 && r.freshAt !== null)
      .sort((a, b) => (b.freshAt ?? 0) - (a.freshAt ?? 0))
      .slice(0, FRESH_CAP)
      .map((r) => r.w.path),
  );

  return {
    // Primary keeps git's natural worktree order, so clicking a row doesn't
    // reshuffle it to the top — activating a copy only re-tints it in place.
    primary: ranked
      .filter((r) => !r.work && (r.rank <= 1 || promoted.has(r.w.path)))
      .map((r) => r.w),
    workSessions: ranked.filter((r) => r.work).map((r) => r.w),
    // Only the hidden list is sorted (has-work → idle → scratch), so machine
    // scratch dirs sink to its bottom.
    inactive: ranked
      .filter((r) => !r.work && r.rank > 1 && !promoted.has(r.w.path))
      .sort((a, b) => a.rank - b.rank)
      .map((r) => r.w),
  };
}
