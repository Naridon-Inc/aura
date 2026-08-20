// PageFrame — the in-flow twin of FullscreenOverlay.
//
// Some surfaces are destinations, not interruptions. Workspaces, Aura and
// Mission Control are places you go and stay: you read them, you leave from
// them, you come back. Rendering them as a modal (dim backdrop, panel floating
// 8px off the viewport, an "esc" chip in the corner) told the opposite story —
// that the app was busy asking you something and everything behind it was
// suspended. The sidebar greyed out; the surface felt borrowed.
//
// So they render through this instead: the same header shape (tabs left,
// actions right, optional sticky footer), but sitting IN the content area
// beside a live sidebar, edge to edge, with no backdrop and no close chip. You
// leave by going somewhere else, which is how pages have always worked.
//
// Deliberately no title — same convention FullscreenOverlay keeps. The nav row
// you clicked is still lit; repeating its name at the top of the page is noise.
// The header disappears entirely when a surface has neither tabs nor actions.
//
// Esc still closes, because the keyboard habit is cheap to honour and costs
// nothing when unused. Callers that hold unsaved input can leave `onClose` off.

import { useEffect, type ReactNode } from "react";
import { cn } from "../../lib/utils";
import { SurfaceHeader } from "./SurfaceHeader";

export type PageFrameProps = {
  /** Leave the page. Wired to Escape; omit for surfaces that shouldn't have a
   *  keyboard exit. */
  onClose?: () => void;
  /** Lens/step strip rendered at the left of the header (e.g. All/Board/Live). */
  tabs?: ReactNode;
  /** Controls pinned to the right of the header (search, filters, + New). */
  actions?: ReactNode;
  /** Sticky bottom bar. Omitted when falsy. */
  footer?: ReactNode;
  /** Body content. A flex-col, so `flex-1` children fill the height. */
  children: ReactNode;
  /** Extra classes for the body region. */
  contentClassName?: string;
};

export function PageFrame({
  onClose,
  tabs,
  actions,
  footer,
  children,
  contentClassName,
}: PageFrameProps) {
  useEffect(() => {
    if (!onClose) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-bg-content">
      {/* The bar itself lives in SurfaceHeader, because the task board draws
          the same one and the merged Tasks destination now crosses between the
          two with a single lens strip. It renders nothing when a surface has
          neither tabs nor actions. */}
      <SurfaceHeader tabs={tabs} actions={actions} />

      <div className={cn("flex min-h-0 flex-1 flex-col", contentClassName)}>
        {children}
      </div>

      {footer && (
        <footer className="flex flex-shrink-0 items-center justify-end gap-2 border-t border-line bg-bg-content px-4 py-3">
          {footer}
        </footer>
      )}
    </div>
  );
}
