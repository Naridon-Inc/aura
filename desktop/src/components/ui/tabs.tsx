// ViewTabs — the strip at the top of a surface that says which drawing of the
// same thing you are looking at. Tasks' List / Board / Graph, and its kind.
//
// This is NOT `Segment` with a different skin, and the split is by job rather
// than by taste. `Segment` answers a question inside the page — sort direction,
// access level, which platform you're waitlisting for — so it has to look like
// a control wherever it lands: a bordered track with two sides, legible
// mid-card, inside a popover, in the middle of a wizard step. Tabs answer
// *which page*, they live in exactly one place, and that place already frames
// them: the header's own bottom hairline is the line they sit on. Giving that
// job a track means drawing a box inside a bar, one hairline nested in another
// a few pixels away, which is the shape the Medusa wizard bar deliberately
// doesn't have.
//
// So: full-height cells, divided from each other by a hairline, the selected
// one lifted and carrying a 2px accent rail that lands ON the header's hairline
// rather than above it. Nothing is animated — the rail reads as selected
// without sliding on every click, same reasoning as `Segment`'s raised cell.
//
// Height is the header's, not its own. `.ade-tabs` stretches to the bar and
// pulls its last pixel down over the rule, so a tab strip fits a 44px header
// with no new measurement to keep in sync.

import * as React from "react";

import { cn } from "../../lib/utils";
import { StripArrows, useStripOverflow } from "./stripOverflow";

export interface ViewTabOption<T extends string> {
  value: T;
  label: React.ReactNode;
  icon?: React.ReactNode;
  disabled?: boolean;
  /** Native tooltip — a second way to learn the tab, never the only one. */
  title?: string;
}

export interface ViewTabsProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  options: ViewTabOption<T>[];
  /** Greys out and blocks the whole strip. */
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
}

export function ViewTabs<T extends string>({
  value,
  onChange,
  options,
  disabled = false,
  ariaLabel,
  className,
}: ViewTabsProps<T>) {
  // Cells don't shrink — a tab squeezed to half a word is not a tab — so a
  // strip with more places than the header hands it scrolls. On the Tasks
  // header at 1200px the strip got about one cell's width and the surface
  // presented `Board` alone as if it were the whole set. `useStripOverflow`
  // is what says otherwise: anything hanging off an edge lights that edge,
  // and the arrow there pages toward it.
  const {
    ref: strip,
    hidden,
    page,
  } = useStripOverflow<HTMLDivElement>({
    active: value,
    activeSelector: '[aria-selected="true"]',
    count: options.length,
  });

  // Left/Right move between places, the ARIA tabs pattern. It is also why the
  // arrows can stay out of the tab ORDER: a keyboard reaches a hidden tab by
  // walking to it, and selection carries focus along so the next press
  // continues from where you landed.
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const usable = options.filter((o) => !o.disabled);
    const at = usable.findIndex((o) => o.value === value);
    if (at < 0) return;
    const next = usable[at + (e.key === "ArrowRight" ? 1 : -1)];
    if (!next) return;
    e.preventDefault();
    onChange(next.value);
    strip.current
      ?.querySelector<HTMLElement>(`[data-segment-value="${next.value}"]`)
      ?.focus();
  };

  return (
    <div
      className={cn(
        "ade-strip-wrap",
        disabled && "pointer-events-none opacity-50",
        className,
      )}
    >
      <div
        ref={strip}
        role="tablist"
        aria-label={ariaLabel}
        className="ade-tabs"
        onKeyDown={onKeyDown}
      >
        {options.map((opt) => {
          const active = opt.value === value;
          const off = opt.disabled;
          return (
            <button
              key={opt.value}
              type="button"
              role="tab"
              aria-selected={active}
              disabled={off}
              title={opt.title}
              // Only the selected cell is a tab stop; Left/Right walk the rest.
              tabIndex={active ? 0 : -1}
              // Lets a wrapping context menu resolve which tab was right-clicked,
              // the same hook `Segment` exposes for the views bar.
              data-segment-value={opt.value}
              onClick={() => !off && onChange(opt.value)}
              className={cn(active && "active")}
            >
              {opt.icon}
              {opt.label}
            </button>
          );
        })}
      </div>
      <StripArrows hidden={hidden} page={page} noun="views" />
    </div>
  );
}
