// The floating "Previous comment" / "Next comment" buttons over a diff, and
// ⌥⌘K / ⌥⌘J for the same. Each button shows only while there is a comment
// that way, with how many. The diff hands in a `NavSource`: where its
// commented lines sit, how far it is scrolled, and how to scroll it.

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";

import {
  COMMENT_NAV_OFFSET,
  NO_COMMENT_NAV,
  commentNavChord,
  commentNavState,
  navTargets,
  sameNavCounts,
  type CommentNavState,
  type NavDirection,
} from "../../../lib/diffReview/commentNav";
import type { ReviewComment } from "../../../lib/diffReview/reviewComments";
import { Button } from "../../ui/button";
import { Kbd } from "../../ui/kbd";
import "../../ui/diff-review.css";

export type NavSource = {
  scrollTop(): number;
  viewportHeight(): number;
  /** The commented line's box in scroll-content coordinates. */
  lineBox(c: ReviewComment): { top: number; height: number } | null;
  /** Bring a content offset to the top of the view, smoothly. */
  scrollTo(top: number): void;
  /** Call back on every scroll or layout change; returns the unsubscribe. */
  watch(cb: () => void): () => void;
  /** Whether this diff is the one on screen, for the shortcut. */
  visible(): boolean;
};

export function useCommentNav(source: NavSource | null, comments: ReviewComment[]) {
  const [state, setState] = useState<CommentNavState>(NO_COMMENT_NAV);
  const read = useCallback((): CommentNavState => {
    if (!source || comments.length === 0) return NO_COMMENT_NAV;
    return commentNavState(
      navTargets(comments, (c) => source.lineBox(c)),
      source.scrollTop(),
      source.viewportHeight(),
    );
  }, [source, comments]);

  useEffect(() => {
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const next = read();
        setState((prev) => (sameNavCounts(prev, next) ? prev : next));
      });
    };
    update();
    const stop = source?.watch(update);
    return () => {
      cancelAnimationFrame(frame);
      stop?.();
    };
  }, [source, read]);

  const navigate = useCallback(
    (dir: NavDirection): boolean => {
      if (!source) return false;
      const target = read()[dir];
      if (!target) return false;
      const box = source.lineBox(target);
      if (!box) return false;
      source.scrollTo(Math.max(0, box.top - COMMENT_NAV_OFFSET));
      return true;
    },
    [source, read],
  );

  return { previousCount: state.previousCount, nextCount: state.nextCount, navigate };
}

export function CommentNav({
  source,
  comments,
}: {
  source: NavSource | null;
  comments: ReviewComment[];
}) {
  const { previousCount, nextCount, navigate } = useCommentNav(source, comments);
  const nav = useRef(navigate);
  nav.current = navigate;

  useEffect(() => {
    if (!source) return;
    const onKey = (e: KeyboardEvent) => {
      const dir = commentNavChord(e);
      if (!dir || !source.visible()) return;
      e.preventDefault();
      e.stopPropagation();
      nav.current(dir);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [source]);

  return (
    <>
      {previousCount > 0 && (
        <div className="ui-diff-review-nav" data-at="top">
          <Button variant="outline" size="sm" onClick={() => navigate("previous")}>
            <ArrowUp size={14} />
            Previous comment
            <span className="ui-diff-review-nav-count">{previousCount}</span>
            <span className="ui-diff-review-nav-keys">
              <Kbd>⌥⌘K</Kbd>
            </span>
          </Button>
        </div>
      )}
      {nextCount > 0 && (
        <div className="ui-diff-review-nav" data-at="bottom">
          <Button variant="outline" size="sm" onClick={() => navigate("next")}>
            <ArrowDown size={14} />
            Next comment
            <span className="ui-diff-review-nav-count">{nextCount}</span>
            <span className="ui-diff-review-nav-keys">
              <Kbd>⌥⌘J</Kbd>
            </span>
          </Button>
        </div>
      )}
    </>
  );
}
