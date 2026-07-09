// Churn — the "+N −M" line-delta label, painted in the exact GitHub diff
// foregrounds (the same add/del palette the Monaco diff body uses) so every
// churn readout across the PR + Trace surfaces reads identically to the diff
// itself. Theme-aware: GitHub Dark Default in dark mode, Light Default in
// light. The GitHub-exact hex lives in `AURA_DIFF_CSS` (the justified Monaco
// palette exception) rather than the cool app tokens, because the user asked
// for "these exact colors" on the diff surfaces specifically.

import { useResolvedTheme } from "../../lib/themeStore";
import { AURA_DIFF_CSS } from "../../lib/monacoTheme";

/** Theme-resolved GitHub diff foregrounds (`addFg` / `delFg`). */
export function useDiffWash() {
  const isDark = useResolvedTheme() !== "light";
  return isDark ? AURA_DIFF_CSS.dark : AURA_DIFF_CSS.light;
}

/** Compact churn readout. A zero side is hidden; both-zero renders nothing.
 *  Callers own the surrounding layout via `className` (default is a mono,
 *  tabular, gap-1 inline row). */
export function Churn({
  additions,
  deletions,
  className,
}: {
  additions: number;
  deletions: number;
  className?: string;
}) {
  const wash = useDiffWash();
  if (additions <= 0 && deletions <= 0) return null;
  return (
    <span
      className={
        className ??
        "font-mono text-[11px] tabular-nums inline-flex items-center gap-1"
      }
    >
      {additions > 0 && <span style={{ color: wash.addFg }}>+{additions}</span>}
      {deletions > 0 && <span style={{ color: wash.delFg }}>−{deletions}</span>}
    </span>
  );
}
