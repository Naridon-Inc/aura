// Churn — the one "+N −M" line-delta badge every Changes / Review / PR surface
// uses, so a file row, a PR row, a commit row and a pane header all read the
// same shape: mono, tabular, `+` then `−`, zero sides hidden.
//
// Colour rule — one question decides it: is this number the change itself, or
// a summary of one?
//
//   · A number that SUMMARISES a change is a list row: a pull request in a
//     list, a commit in a log, a folder rolling up the files beneath it.
//     Forty rows each painting a green number and a red number is a traffic
//     light — nothing stands out and the eye has nowhere to land. Those stay
//     on the neutral ramp (`tone="neutral"`, the default).
//   · A number that IS the change belongs to a diff surface: the header sitting
//     directly above the very lines it counts, or a row that stands for one
//     changed file inside a single changeset being read. There the +/− is the
//     content, not a label for it, so it earns real green/red (`tone="diff"`).
//
// `tone="active"` is the same paint for a third reason: the readout for the
// work you are in right now (your own uncommitted changes in this workspace).
// Exactly one of those is ever on screen, and it's a live diff surface too —
// "this is happening, this is yours". Kept as its own name so a call site can't
// borrow it to mean "colour please".
//
// The add/remove colours inside a diff BODY are a separate thing and keep their
// treatment — see `useDiffWash` and UnifiedDiff.

import { useResolvedTheme } from "../../lib/themeStore";
import { AURA_DIFF_CSS } from "../../lib/monacoTheme";
import { cn } from "../../lib/utils";

/** Theme-resolved diff washes (`addLine` / `delLine` backgrounds and
 *  `addFg` / `delFg` markers) for the renderers that paint diff BODIES. */
export function useDiffWash() {
  const isDark = useResolvedTheme() !== "light";
  return isDark ? AURA_DIFF_CSS.dark : AURA_DIFF_CSS.light;
}

/** `neutral` — a summary number in a list, on the neutral ramp (the default).
 *  `diff`    — a diff surface: the number IS the change being read on screen.
 *  `active`  — your own uncommitted work in the workspace you're in now. */
export type ChurnTone = "neutral" | "diff" | "active";

/** Compact churn readout. A zero side is hidden; both-zero renders nothing.
 *  `className` is merged onto the shared mono/tabular base rather than
 *  replacing it, so no call site can drift off the common shape. */
export function Churn({
  additions,
  deletions,
  className,
  tone = "neutral",
}: {
  additions: number;
  deletions: number;
  className?: string;
  tone?: ChurnTone;
}) {
  if (additions <= 0 && deletions <= 0) return null;
  // Both non-neutral tones are "the number IS the change", so they share one
  // paint — the tone name is what records WHICH rule earned it, and keeping
  // them separate stops a list row from reaching for `active` just to get
  // colour. Colours come from the live theme pack, never hardcoded.
  const coloured = tone !== "neutral";
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 whitespace-nowrap font-mono text-xs tabular-nums",
        !coloured && "text-text-3",
        className,
      )}
    >
      {additions > 0 && (
        <span style={coloured ? { color: "var(--color-green)" } : undefined}>
          +{additions}
        </span>
      )}
      {deletions > 0 && (
        <span style={coloured ? { color: "var(--color-red)" } : undefined}>
          −{deletions}
        </span>
      )}
    </span>
  );
}
