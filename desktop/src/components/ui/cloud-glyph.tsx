// CloudGlyph — the one mark that says "this runs somewhere else".
//
// Once a box can drain your work, the same row can mean two very different
// things: an agent on this Mac dies when you close the lid, an agent on your
// runner does not. A worktree on this disk is yours alone; a cloud worktree is
// checked out on shared hardware. Nothing in the UI carried that distinction,
// so the only way to know where your work was actually running was to remember.
//
// This is deliberately a *dot grid*, not a filled cloud icon: at 12px a solid
// glyph reads as a status blob next to the agent icons already on the row,
// while a stipple reads as texture and stays legible against both themes. It
// inherits `currentColor`, so a caller tints it by wrapping it in a coloured
// span rather than passing a colour through.
//
// `pulse` is for a machine that is coming up (provisioning, booting, restoring)
// — a slow breath, not a spinner. Real loading still belongs to AsciiSpinner;
// this never replaces it.

import { cn } from "../../lib/utils";

/** Dot centres on a 0–120 × 0–80 grid, arranged as a cloud silhouette:
 *  a wide base with two rises. Authored for this component. */
const DOTS: Array<[number, number]> = [
  // upper rise
  [46, 12],
  [64, 12],
  // shoulders
  [30, 32],
  [46, 32],
  [64, 32],
  [82, 32],
  // base
  [14, 54],
  [32, 54],
  [50, 54],
  [68, 54],
  [86, 54],
  [104, 54],
];

export type CloudGlyphProps = {
  /** Rendered width in px. Height follows the 3:2 grid. */
  size?: number;
  /** Breathe, for a machine that is still coming up. */
  pulse?: boolean;
  className?: string;
  /** Accessible label. Omit for a purely decorative mark beside visible text. */
  label?: string;
};

export function CloudGlyph({
  size = 14,
  pulse = false,
  className,
  label,
}: CloudGlyphProps) {
  return (
    <svg
      width={size}
      height={Math.round((size * 2) / 3)}
      viewBox="0 0 120 80"
      fill="none"
      className={cn("shrink-0 overflow-visible", className)}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {DOTS.map(([cx, cy], i) => (
        <circle
          key={`${cx}-${cy}`}
          cx={cx}
          cy={cy}
          r={8}
          fill="currentColor"
          className={pulse ? "cloud-glyph-dot" : undefined}
          // Stagger along the row so the breath travels left-to-right rather
          // than the whole cloud blinking at once.
          style={pulse ? { animationDelay: `${i * 70}ms` } : undefined}
        />
      ))}
    </svg>
  );
}
