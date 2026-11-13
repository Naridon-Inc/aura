// The foot of a list that is drawing less than it holds.
//
// It watches for itself coming into view and asks for the next slice before
// the reader can reach the end, so a budgeted list (./rowBudget) scrolls like
// an unbudgeted one. The button is not a fallback nobody sees: it is what is
// on screen for the moment the next slice takes, and it is the whole mechanism
// in a webview without IntersectionObserver.

import { useEffect, useRef, type JSX } from "react";

import { Button } from "../ui/button";
import "../ui/tasks-board.css";

export function RevealFoot({
  hidden,
  onReveal,
}: {
  /** How many rows are held back. Nothing renders at zero. */
  hidden: number;
  onReveal: () => void;
}): JSX.Element | null {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node || hidden === 0) return;
    if (typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) onReveal();
      },
      // A screen of lead time, so scrolling never stops at a boundary.
      { rootMargin: "600px 0px" },
    );
    io.observe(node);
    return () => io.disconnect();
  }, [hidden, onReveal]);

  if (hidden === 0) return null;

  return (
    <div ref={ref} className="ui-tasks-reveal">
      <Button size="xs" variant="ghost" onClick={onReveal}>
        Show {hidden} more
      </Button>
    </div>
  );
}
