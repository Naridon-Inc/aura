// Previous / next comment in a diff.
//
// Every commented line is a target, measured in the scroll content's own
// coordinates. The targets inside the viewport (its top band of 56px left
// out, where the floating "Previous comment" button sits) are the ones being
// read; the one before them is "previous" and the one after them is "next",
// each with how many lie that way. With none in view, the split falls at the
// viewport's top. Two comments ending on the same line of the same side are
// one stop.

import { anchorLine, type ReviewComment } from "./reviewComments";

/** How far below the top of the view a comment lands, and the band at the
 *  top that does not count as showing it. */
export const COMMENT_NAV_OFFSET = 56;

export type NavTarget = { comment: ReviewComment; top: number; height: number };

export type CommentNavState = {
  previous?: ReviewComment;
  next?: ReviewComment;
  previousCount: number;
  nextCount: number;
};

export const NO_COMMENT_NAV: CommentNavState = { previousCount: 0, nextCount: 0 };

export type NavDirection = "previous" | "next";

export function commentNavState(
  targets: NavTarget[],
  scrollTop: number,
  viewportHeight: number,
): CommentNavState {
  if (targets.length === 0) return NO_COMMENT_NAV;
  const sorted = [...targets].sort((a, b) => a.top - b.top);
  const from = scrollTop + COMMENT_NAV_OFFSET;
  const to = scrollTop + viewportHeight;
  const first = sorted.findIndex((t) => t.top + t.height > from && t.top < to);
  if (first !== -1) {
    let last = first;
    for (let i = first + 1; i < sorted.length && !(sorted[i].top >= to); i++) last = i;
    const prev = first - 1;
    const next = last + 1;
    return {
      previous: sorted[prev]?.comment,
      next: sorted[next]?.comment,
      previousCount: prev + 1,
      nextCount: sorted.length - next,
    };
  }
  let above = -1;
  for (let i = 0; i < sorted.length && !(sorted[i].top > from); i++) above = i;
  const next = above + 1;
  return {
    previous: sorted[above]?.comment,
    next: sorted[next]?.comment,
    previousCount: above + 1,
    nextCount: sorted.length - next,
  };
}

/** One target per commented line, measured by `box`; a line `box` cannot
 *  place (scrolled out of a virtual list, folded away) is skipped. */
export function navTargets(
  comments: ReviewComment[],
  box: (c: ReviewComment) => { top: number; height: number } | null,
): NavTarget[] {
  const seen = new Set<string>();
  const out: NavTarget[] = [];
  for (const c of comments) {
    if (!(c.lineNumber > 0)) continue;
    const key = `${c.side}:${anchorLine(c)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const b = box(c);
    if (b) out.push({ comment: c, top: b.top, height: b.height });
  }
  return out;
}

export function sameNavCounts(a: CommentNavState, b: CommentNavState): boolean {
  return a.previousCount === b.previousCount && a.nextCount === b.nextCount;
}

/** ⌥⌘K / ⌥⌘J, matched on the physical key: with ⌥ held macOS composes a
 *  different character for the letter. */
export function commentNavChord(e: Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "code">): NavDirection | null {
  if (!(e.metaKey || e.ctrlKey) || !e.altKey || e.shiftKey) return null;
  if (e.code === "KeyK") return "previous";
  if (e.code === "KeyJ") return "next";
  return null;
}
