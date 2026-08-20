// SurfaceHeader — the bar a surface wears at the top: what you're looking at
// on the left, what you can do about it on the right.
//
// There has only ever been one header idea in this app, and it was drawn three
// times. PageFrame's was 44px tall with a hairline and a 12px left inset;
// FullscreenOverlay's was 48px with a heavier rule and no inset; the task
// board rolled its own out of raw padding — 16/24px sides, a 20px title, a
// second line under it — and came out around 56. Three heights, three rules,
// three left edges, for the same row.
//
// That stayed invisible while each surface was somewhere you arrived on its
// own. It stopped being invisible when Tasks and Mission Control merged: the
// five lenses are now ONE strip, and picking Plan swaps the whole surface
// underneath it. If the two surfaces draw their own headers, that strip moves
// — down a few pixels, right a few pixels — at the exact moment you use it.
// A control that jumps when you press it reads as two controls.
//
// So the shape lives here and both render it. Not a style guideline anyone has
// to remember: the same element, so drift isn't possible.
//
// Deliberately no title slot — the same convention PageFrame and
// FullscreenOverlay already kept. The rail row you clicked is still lit, the
// tab still says the word; printing it again at the top of the page is the one
// thing on screen you already knew.

import { type ReactNode } from "react";
import { cn } from "../../lib/utils";

export type SurfaceHeaderProps = {
  /** Owns the top-left corner, ahead of the tabs. A modal puts its Esc chip
   *  here; a page has nothing to put here, because you leave a page by going
   *  somewhere else. */
  leading?: ReactNode;
  /** Lens/step strip, and any quiet meta that belongs beside it. */
  tabs?: ReactNode;
  /** Controls pinned right: search, filters, the primary verb. */
  actions?: ReactNode;
  /** Extra classes for the bar itself. */
  className?: string;
};

export function SurfaceHeader({
  leading,
  tabs,
  actions,
  className,
}: SurfaceHeaderProps) {
  // A surface with none of them wears no bar at all, rather than a 44px empty
  // rule.
  if (!leading && !tabs && !actions) return null;

  return (
    // items-stretch so a full-height tab strip sets the bar height while a
    // short pill strip just centers. One hairline under it — the page is
    // already bounded by the sidebar, so it needs no frame of its own.
    //
    // The height is `--surface-header-h` rather than a Tailwind step, because
    // `.ade-tabs` needs the same number to guarantee the strip is one height on
    // every page, and two places holding "44" separately is how it became three
    // heights the first time.
    <header
      style={{ minHeight: "var(--surface-header-h)" }}
      className={cn(
        "flex flex-shrink-0 items-stretch border-b border-line-soft bg-bg-content",
        className,
      )}
    >
      {leading && (
        <div className="flex items-center gap-2 px-3">{leading}</div>
      )}
      {tabs ? (
        // The 12px inset is the bar's left edge, so it belongs to whichever
        // cluster is actually at that edge — otherwise a modal pays it twice.
        <div
          className={cn(
            "flex min-w-0 flex-1 items-center gap-2",
            !leading && "pl-3",
          )}
        >
          {tabs}
        </div>
      ) : (
        <div className="min-w-0 flex-1" />
      )}
      {actions && <div className="flex items-center gap-2 px-3">{actions}</div>}
    </header>
  );
}
