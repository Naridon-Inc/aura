// Shared SVG icon set — port of aura-term/src/ui/icons.rs glyph palette.
// Every icon is 16×16 viewBox so callers can size with the `size` prop
// (default 14) without recomputing strokes. `currentColor` so callers
// drive color via Tailwind text-* classes.

type IconProps = { size?: number; className?: string };

function I({
  size = 14,
  className,
  children,
}: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      className={className}
    >
      {children}
    </svg>
  );
}

// ─── Pane tiles (nav rail) ──────────────────────────────────────────────
export const Terminal = (p: IconProps) => (
  <I {...p}>
    <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" stroke="currentColor" />
    <path d="M4 6l2.5 2L4 10" stroke="currentColor" strokeWidth="1.4" fill="none" />
    <line x1="8" y1="10.5" x2="12" y2="10.5" stroke="currentColor" strokeWidth="1.2" />
  </I>
);

// Stacked pages — a sheet with a second one behind it. The one Pages mark, in
// this set's 16-grid/1.2px stroke system; AdeSidebar draws the same concept in
// its own 24-grid/2px one.
export const Pages = (p: IconProps) => (
  <I {...p}>
    <path
      d="M5.5 2.5h4l3 3v6.5a1 1 0 0 1-1 1H5.5a1 1 0 0 1-1-1v-8.5a1 1 0 0 1 1-1z"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinejoin="round"
    />
    <path
      d="M9.5 2.5v3h3"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinejoin="round"
    />
    <path
      d="M3.5 4.5v8.5a1 1 0 0 0 1 1H11"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinejoin="round"
      opacity="0.55"
    />
  </I>
);

export const Plan = (p: IconProps) => (
  <I {...p}>
    <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" stroke="currentColor" />
    <line x1="5" y1="6" x2="11" y2="6" stroke="currentColor" strokeWidth="1.2" />
    <line x1="5" y1="9" x2="11" y2="9" stroke="currentColor" strokeWidth="1.2" />
    <line x1="5" y1="12" x2="9" y2="12" stroke="currentColor" strokeWidth="1.2" />
  </I>
);

export const Impacts = (p: IconProps) => (
  <I {...p}>
    <path d="M8 1.5L14.5 13.5h-13L8 1.5z" stroke="currentColor" strokeWidth="1.2" fill="none" />
    <line x1="8" y1="6" x2="8" y2="10" stroke="currentColor" strokeWidth="1.4" />
    <circle cx="8" cy="11.8" r="0.7" fill="currentColor" />
  </I>
);

export const Proof = (p: IconProps) => (
  <I {...p}>
    <path d="M2.5 8.5l3 3 8-8" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
  </I>
);

export const Memory = (p: IconProps) => (
  <I {...p}>
    <rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" />
    <line x1="2" y1="6" x2="14" y2="6" stroke="currentColor" />
    <circle cx="4.5" cy="9.5" r="0.8" fill="currentColor" />
    <line x1="6.5" y1="9.5" x2="13" y2="9.5" stroke="currentColor" />
    <circle cx="4.5" cy="11.5" r="0.8" fill="currentColor" />
    <line x1="6.5" y1="11.5" x2="11" y2="11.5" stroke="currentColor" />
  </I>
);

export const Timeline = (p: IconProps) => (
  <I {...p}>
    <circle cx="8" cy="8" r="6" stroke="currentColor" />
    <path d="M8 4v4l2.5 2" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" />
  </I>
);

export const Doctor = (p: IconProps) => (
  <I {...p}>
    <path d="M3 3v4a5 5 0 0010 0V3" stroke="currentColor" strokeWidth="1.2" fill="none" />
    <circle cx="11" cy="11" r="2" stroke="currentColor" strokeWidth="1.2" />
    <line x1="8" y1="11" x2="9" y2="11" stroke="currentColor" strokeWidth="1.2" />
  </I>
);

export const Workflow = (p: IconProps) => (
  <I {...p}>
    <circle cx="4" cy="4" r="1.5" stroke="currentColor" strokeWidth="1.2" />
    <circle cx="12" cy="4" r="1.5" stroke="currentColor" strokeWidth="1.2" />
    <circle cx="4" cy="12" r="1.5" stroke="currentColor" strokeWidth="1.2" />
    <circle cx="12" cy="12" r="1.5" stroke="currentColor" strokeWidth="1.2" />
    <line x1="5.5" y1="4" x2="10.5" y2="4" stroke="currentColor" />
    <line x1="4" y1="5.5" x2="4" y2="10.5" stroke="currentColor" />
    <line x1="12" y1="5.5" x2="12" y2="10.5" stroke="currentColor" />
    <line x1="5.5" y1="12" x2="10.5" y2="12" stroke="currentColor" />
  </I>
);

// ─── Sidebar tabs ───────────────────────────────────────────────────────
export const Folder = (p: IconProps) => (
  <I {...p}>
    <path
      d="M2 4.5v8a1 1 0 001 1h10a1 1 0 001-1V5.5a1 1 0 00-1-1H7L5.5 3H3a1 1 0 00-1 1.5z"
      stroke="currentColor"
      fill="none"
    />
  </I>
);

// Branch — a trunk with two nodes on the spine and a third node forking off a
// gentle curve. The product's canonical "this is a branch" mark (matches the
// roster's MainBranchGlyph so branch reads the same everywhere).
export const GitBranch = (p: IconProps) => (
  <I {...p}>
    <circle cx="5" cy="4" r="1.6" stroke="currentColor" strokeWidth="1.3" />
    <circle cx="5" cy="12" r="1.6" stroke="currentColor" strokeWidth="1.3" />
    <circle cx="11.5" cy="8.5" r="1.6" stroke="currentColor" strokeWidth="1.3" />
    <path d="M5 5.6v4.8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    <path d="M5 8C6.4 8 7.4 8.5 9.9 8.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" fill="none" />
  </I>
);

export const Search = (p: IconProps) => (
  <I {...p}>
    <circle cx="7" cy="7" r="4" stroke="currentColor" strokeWidth="1.4" />
    <line x1="10" y1="10" x2="13.5" y2="13.5" stroke="currentColor" strokeWidth="1.4" />
  </I>
);

export const Users = (p: IconProps) => (
  <I {...p}>
    <circle cx="6" cy="5" r="2.5" stroke="currentColor" strokeWidth="1.2" />
    <path d="M2 13c0-2.5 2-4 4-4s4 1.5 4 4" stroke="currentColor" strokeWidth="1.2" fill="none" />
    <circle cx="11.5" cy="5.5" r="1.8" stroke="currentColor" strokeWidth="1.1" />
    <path d="M10 13c0-2 1.5-3.2 3-3.2 1 0 2 .6 2.5 1.5" stroke="currentColor" strokeWidth="1.1" fill="none" />
  </I>
);

// Agents — concentric reach + dot, evokes a constellation of running
// agents. Distinct enough from Users (team) to read at a glance.
export const Agents = (p: IconProps) => (
  <I {...p}>
    <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.2" />
    <circle cx="8" cy="8" r="5" stroke="currentColor" strokeWidth="1.1" strokeDasharray="2 1.5" fill="none" />
    <circle cx="14" cy="3" r="1.2" fill="currentColor" />
    <circle cx="2" cy="13" r="1.2" fill="currentColor" />
    <circle cx="14" cy="13" r="1.2" fill="currentColor" />
  </I>
);

// Zones — bracketed glob + dot, evokes a guarded path range.
export const Zones = (p: IconProps) => (
  <I {...p}>
    <path d="M4 3v10M12 3v10" stroke="currentColor" strokeWidth="1.3" />
    <path d="M4 3h2M4 13h2M10 3h2M10 13h2" stroke="currentColor" strokeWidth="1.3" />
    <circle cx="8" cy="8" r="1.5" fill="currentColor" />
  </I>
);

export const Tasks = (p: IconProps) => (
  <I {...p}>
    <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" stroke="currentColor" />
    <path d="M5 6l1.4 1.4L9 5" stroke="currentColor" strokeWidth="1.4" fill="none" />
    <line x1="5" y1="10" x2="11" y2="10" stroke="currentColor" strokeWidth="1.2" />
  </I>
);

export const Reviews = (p: IconProps) => (
  <I {...p}>
    <path d="M3 3h7l3 3v7H3z" stroke="currentColor" strokeWidth="1.3" fill="none" />
    <path d="M9 3v3h3" stroke="currentColor" strokeWidth="1.3" fill="none" />
    <path d="M5.5 9.5l1.5 1.5 3-3" stroke="currentColor" strokeWidth="1.4" fill="none" />
  </I>
);

// Pull-Request glyph — two diverging branches joined at a merge dot,
// distinct from the GitBranch icon (single branch with a single fork)
// so the user can scan PR vs. local source control at a glance.
export const PullRequest = (p: IconProps) => (
  <I {...p}>
    <circle cx="4" cy="4" r="1.6" stroke="currentColor" strokeWidth="1.3" fill="none" />
    <circle cx="4" cy="12" r="1.6" stroke="currentColor" strokeWidth="1.3" fill="none" />
    <circle cx="12" cy="12" r="1.6" stroke="currentColor" strokeWidth="1.3" fill="none" />
    <path d="M4 5.6v4.8" stroke="currentColor" strokeWidth="1.3" />
    <path d="M12 10.4V7a2 2 0 0 0-2-2H6.5" stroke="currentColor" strokeWidth="1.3" fill="none" />
    <path d="M7.5 3.5L6 5l1.5 1.5" stroke="currentColor" strokeWidth="1.3" fill="none" />
  </I>
);

// ─── Chrome ─────────────────────────────────────────────────────────────
export const Plus = (p: IconProps) => (
  <I {...p}>
    <line x1="8" y1="3" x2="8" y2="13" stroke="currentColor" strokeWidth="1.4" />
    <line x1="3" y1="8" x2="13" y2="8" stroke="currentColor" strokeWidth="1.4" />
  </I>
);

export const Settings = (p: IconProps) => (
  <I {...p}>
    <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.3" />
    <path
      d="M8 1.5v2M8 12.5v2M14.5 8h-2M3.5 8h-2M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4M12.6 12.6l-1.4-1.4M4.8 4.8L3.4 3.4"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
    />
  </I>
);

export const Help = (p: IconProps) => (
  <I {...p}>
    <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.2" />
    <path
      d="M6 6.5C6 5.5 6.9 4.8 8 4.8s2 .7 2 1.7c0 .8-.5 1.2-1.2 1.5-.6.3-.8.6-.8 1.1V9.5"
      stroke="currentColor"
      strokeWidth="1.2"
      fill="none"
    />
    <circle cx="8" cy="11.5" r="0.7" fill="currentColor" />
  </I>
);

// ─── Status / generic ───────────────────────────────────────────────────
export const ChevronDown = (p: IconProps) => (
  <I {...p}>
    <path d="M3 6l5 5 5-5" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
  </I>
);

export const RefreshCw = (p: IconProps) => (
  <I {...p}>
    <path d="M3 8a5 5 0 019-3M13 8a5 5 0 01-9 3" stroke="currentColor" strokeWidth="1.4" fill="none" />
    <path d="M9 5h3V2M7 11H4v3" stroke="currentColor" strokeWidth="1.3" fill="none" />
  </I>
);
