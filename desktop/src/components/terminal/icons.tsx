// Small inline glyphs the terminal panel needs that aren't in the
// pinned lucide-react build (v1.14 predates SplitSquareHorizontal /
// TerminalSquare). Sized to match lucide's 16px default so they sit
// flush next to the real icons in menus + the toolbar.

type IconProps = { className?: string };

/** Two side-by-side panes — the "split terminal" affordance. */
export function SplitIcon({ className }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className ?? "h-4 w-4"}
      aria-hidden="true"
    >
      <rect x="3" y="4" width="7.5" height="16" rx="1.5" />
      <rect x="13.5" y="4" width="7.5" height="16" rx="1.5" />
    </svg>
  );
}

/** A terminal prompt mark — the panel/profile glyph. */
export function TerminalGlyph({ className }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className ?? "h-4 w-4"}
      aria-hidden="true"
    >
      <path d="m6 9 3 3-3 3" />
      <path d="M12 15h5" />
      <rect x="2" y="4" width="20" height="16" rx="2" />
    </svg>
  );
}
