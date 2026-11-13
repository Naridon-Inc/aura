// Review comments on the unified diff table: a ＋ in a line's number cell
// opens a comment on it, dragging from the ＋ down the rows opens one on the
// run dragged over, and each comment sits in a row of its own under the last
// line it covers. A removed line is commented on the old side, an added or
// unchanged one on the new side.

import { useCallback, useEffect, useMemo, useRef, useState, type HTMLAttributes, type ReactNode } from "react";
import { Plus } from "lucide-react";
import { parseUnifiedDiff, type DiffLine } from "@shared/ui/diff/parse";

import { anchorLine, type CommentSide } from "../../../lib/diffReview/reviewComments";
import { DiffComment } from "./DiffComment";
import type { ReviewHost } from "./useMonacoReview";

type Pick = { side: CommentSide; from: number; to: number };

function sideOf(ln: DiffLine): { side: CommentSide; no: number } | null {
  if (ln.kind === "del" && ln.oldNo != null) return { side: "deletions", no: ln.oldNo };
  if ((ln.kind === "add" || ln.kind === "ctx") && ln.newNo != null) return { side: "additions", no: ln.newNo };
  return null;
}

function numberOn(ln: DiffLine, side: CommentSide): number | null {
  if (side === "deletions") return ln.kind === "add" ? null : ln.oldNo;
  return ln.kind === "del" ? null : ln.newNo;
}

export function useUnifiedReview(diff: string, host: ReviewHost | null) {
  const lines = useMemo(() => parseUnifiedDiff(diff), [diff]);
  const [pick, setPick] = useState<Pick | null>(null);
  const pickRef = useRef<Pick | null>(null);
  pickRef.current = pick;
  const hostRef = useRef(host);
  hostRef.current = host;

  useEffect(() => {
    if (!pick) return;
    const up = () => {
      const p = pickRef.current;
      setPick(null);
      const h = hostRef.current;
      if (!p || !h) return;
      const a = Math.min(p.from, p.to);
      const b = Math.max(p.from, p.to);
      const code = lines
        .filter((ln) => {
          const n = numberOn(ln, p.side);
          return (ln.kind === "add" || ln.kind === "del" || ln.kind === "ctx") && n != null && n >= a && n <= b;
        })
        .map((ln) => ln.text);
      h.onAdd(p.side, a, b !== a ? b : undefined, code.join("\n"));
    };
    window.addEventListener("mouseup", up, true);
    return () => window.removeEventListener("mouseup", up, true);
  }, [pick !== null, lines]); // eslint-disable-line react-hooks/exhaustive-deps

  const rowProps = useCallback(
    (ln: DiffLine) => {
      const at = sideOf(ln);
      const n = pick ? numberOn(ln, pick.side) : null;
      const picked =
        !!pick && n != null && n >= Math.min(pick.from, pick.to) && n <= Math.max(pick.from, pick.to);
      return {
        className: "ui-diff-review-row",
        "data-picked": picked ? "true" : undefined,
        // Where the previous / next comment buttons find a commented line.
        "data-review-old": ln.kind !== "add" && ln.oldNo != null ? ln.oldNo : undefined,
        "data-review-new": ln.kind !== "del" && ln.newNo != null ? ln.newNo : undefined,
        onMouseEnter: () => {
          const p = pickRef.current;
          if (!p || !at) return;
          const m = numberOn(ln, p.side);
          if (m != null && m !== p.to) setPick({ ...p, to: m });
        },
      } as HTMLAttributes<HTMLTableRowElement>;
    },
    [pick],
  );

  const gutter = useCallback((ln: DiffLine): ReactNode => {
    const at = sideOf(ln);
    if (!at) return null;
    return (
      <button
        type="button"
        className="ui-diff-review-plus"
        aria-label="Add a comment"
        onMouseDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          setPick({ side: at.side, from: at.no, to: at.no });
        }}
      >
        <Plus size={12} />
      </button>
    );
  }, []);

  const comments = host?.comments;
  const after = useCallback(
    (ln: DiffLine): ReactNode => {
      if (!comments?.length) return null;
      // An unchanged line is on both sides, so it carries the comments of
      // either side that end on it.
      const here = comments.filter((c) => numberOn(ln, c.side) === anchorLine(c));
      if (here.length === 0) return null;
      return (
        <div className="ui-diff-review-unified">
          {here.map((c) => (
            <DiffComment key={c.id} comment={c} repoRoot={host?.repoRoot} />
          ))}
        </div>
      );
    },
    [comments, host?.repoRoot],
  );

  if (!host) return {};
  return { rowProps, gutter, after };
}
