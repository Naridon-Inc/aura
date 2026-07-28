// PrDiffMeaning — plain-language "what changed" strip above a PR file's diff.
//
// The session Changes tab explains each edit in everyday words: what the code
// USED TO DO, what it does NOW, and WHY it was changed + how it works. A pull
// request's file diff deserves the same setup — a reviewer (often a
// non-engineer) shouldn't have to read the raw patch to know what it means.
//
// A PR file has no single commit to point at (the diff is the base..head range
// `gh pr diff` returns), so we hand the raw hunk straight to the explanation
// engine, which caches the words by the diff's own content-hash. Nothing paints
// until real, model-written words arrive — the diff editor below is always the
// ground truth, so an unreachable model just leaves this strip absent rather
// than showing filler.

import { useEffect, useRef, useState } from "react";

import {
  type ChangeExplanation,
  hasExplanation,
  loadExplanationForDiff,
} from "../../lib/changeExplain";

export function PrDiffMeaning({
  repoRoot,
  filePath,
  diff,
}: {
  repoRoot: string;
  filePath: string;
  /** The file's raw unified diff (base..head) — the same bytes the diff editor
   *  renders. Used verbatim as the explanation's cache identity. */
  diff: string;
}) {
  const [exp, setExp] = useState<ChangeExplanation | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    setExp(null);
    if (!repoRoot || !filePath || !diff.trim()) return;
    void loadExplanationForDiff(repoRoot, filePath, diff).then((r) => {
      if (alive.current) setExp(r);
    });
    return () => {
      alive.current = false;
    };
  }, [repoRoot, filePath, diff]);

  // No readable words yet (still loading, or no model reachable) → render
  // nothing. The diff editor below already tells the full story.
  if (!hasExplanation(exp)) return null;

  const before = exp?.before?.trim() || "";
  const nowDoes = exp?.what?.trim() || "";
  const why = exp?.why?.trim() || "";
  const hasBefore = before.length > 0;

  return (
    <div className="border-b border-line-soft/60 bg-bg-1/40 px-3 py-2">
      {/* BEFORE → NOW — what this file used to do, and what it does now. A
          brand-new file has no "before", so it shows a single line instead. */}
      {hasBefore ? (
        <div className="flex flex-col gap-1.5 sm:flex-row sm:gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-[10px] uppercase tracking-wide text-text-4">Used to</div>
            <div className="mt-0.5 text-[11.5px] leading-snug text-text-3">{before}</div>
          </div>
          {nowDoes ? (
            <div className="min-w-0 flex-1">
              <div className="text-[10px] uppercase tracking-wide text-text-4">Now</div>
              <div className="mt-0.5 text-[11.5px] leading-snug text-text-1">{nowDoes}</div>
            </div>
          ) : null}
        </div>
      ) : nowDoes ? (
        <div>
          <div className="text-[10px] uppercase tracking-wide text-text-4">What this adds</div>
          <div className="mt-0.5 text-[11.5px] leading-snug text-text-1">{nowDoes}</div>
        </div>
      ) : null}

      {/* WHY (+ how) — why this exact change was made and how it now works. */}
      {why ? (
        <p className="mt-2 text-[11.5px] leading-snug text-text-2">
          <span className="text-text-5">Why &amp; how — </span>
          {why}
        </p>
      ) : null}
    </div>
  );
}
