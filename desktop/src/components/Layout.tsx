// Unified-canvas shell (Superset-style). The whole window is one bg
// surface; columns and rows are separated only by 1px borders. No gaps,
// no rounded inset corners — panes butt against each other so the IDE
// reads as a single rectangle subdivided by hairlines, not a frame
// around floating cards.
//
// Drag handles sit on top of the column boundary border (1px wide
// hit-target widened by hover area) so resizing doesn't shift any
// pixels, just moves the divider. That handle, and the width behind it, are
// `ui/resizable` — the app's one pane mechanism, shared with the place rail
// and Team's context column. They used to be three private copies, which is
// how the place rail ended up as a `const` with no handle at all.

import { useEffect, useState, type ReactNode } from "react";

import { ResizablePane, usePaneSize } from "./ui/resizable";

type LayoutProps = {
  sidebar: ReactNode;
  /** Top strip of the sidebar column — traffic-light drag region, project
   *  switcher, search, extensions, workspace nav. */
  sidebarHeader?: ReactNode;
  statusBar?: ReactNode;
  body: ReactNode;
  composer: ReactNode;
  reviewPanel?: ReactNode;
  /** Header strip for the review rail. The review column runs full-height
   *  to y=0 with its OWN header — the primary rail action
   *  (Create PR) lives here, aligned with the work-surface topbar. The main
   *  header therefore stops before the review rail. */
  reviewHeader?: ReactNode;
  bottomPane?: ReactNode;
  bottomPaneOpen?: boolean;
  /** When true the bottom pane fills the whole work-surface height (the
   *  terminal panel's maximize toggle); the body collapses behind it. */
  bottomPaneMaximized?: boolean;
  sidebarOpen?: boolean;
  reviewOpen?: boolean;
  /** True when `body` is a destination that paints its own header rather than
   *  a tab strip (Workspaces, Trace, a `place`). Only used to decide whether
   *  the macOS traffic lights need a bare drag strip of their own — see
   *  `topStrip`. */
  pageOwnsWindow?: boolean;
};

const SIDEBAR_KEY = "aura.sidebar.w";
const REVIEW_KEY = "aura.review.w";
const BOTTOM_KEY = "aura.bottom.h";

const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 480;
const REVIEW_MIN = 240;
const REVIEW_MAX = 560;
const BOTTOM_MIN = 160;
const BOTTOM_MAX = 600;

export function Layout(props: LayoutProps) {
  const [sidebarW, setSidebarW] = usePaneSize(SIDEBAR_KEY, 280, SIDEBAR_MIN, SIDEBAR_MAX);
  const [reviewW, setReviewW] = usePaneSize(REVIEW_KEY, 320, REVIEW_MIN, REVIEW_MAX);
  const [bottomH, setBottomH] = usePaneSize(BOTTOM_KEY, 240, BOTTOM_MIN, BOTTOM_MAX);

  // Responsive guards — at narrow widths the review panel (320px+) on
  // top of the sidebar (280px) can crowd the work surface to ~250px or
  // less. Hide the review when the work area would drop below the
  // 480px threshold; the user can still toggle it back via ⌘⌥R.
  const winW = useWindowWidth();
  const fixed = props.sidebarOpen ?? true ? sidebarW : 0;
  const reviewFitsWide = winW - fixed - reviewW >= 480;
  const reviewVisible =
    !!props.reviewPanel && (props.reviewOpen ?? true) && reviewFitsWide;
  const sidebarFitsWide = winW - sidebarW >= 360;
  const sidebarVisible = (props.sidebarOpen ?? true) && sidebarFitsWide;

  // The work column no longer draws a chrome band of its own.
  //
  // It used to: a strip at `--topbar-h` above the body, holding the terminal
  // and review toggles at its right end and nothing else across the rest of
  // its width — directly above the tab strip, which has its own controls in
  // the same corner. Two headers, four controls, one row's worth of content.
  // The toggles moved into the tab strip (see TopBar's `PaneToggles`) and the
  // band went with them, so the work column now starts with its own content
  // at y=0 and the window's top edge is one line across all three columns.
  //
  // With one exception, which is why this is not simply deleted. macOS runs
  // this window with an overlay title bar, so the traffic lights are a native
  // layer pinned to the top-left corner and nothing in the DOM can move them.
  // The sidebar header is what normally sits beneath them. With the sidebar
  // CLOSED they fall onto whatever the work column draws first — and a page
  // that draws its own header (Workspaces, Trace, any `place`) has no
  // traffic-light gutter to give them. Tab-bearing surfaces handle this
  // themselves via `SidebarPeek`, which reserves the gutter and puts the
  // show-sidebar control in it; a page that owns the window does not, so it
  // gets a bare drag strip here. The lights always have a surface, and the
  // window always has somewhere to be dragged.
  const topStrip =
    sidebarVisible || !props.pageOwnsWindow ? null : (
      <span data-tauri-drag-region className="h-full flex-1" />
    );

  // Shared work surface — body + (optional) bottom pane + composer stacked,
  // each row separated by a border-t hairline. Reused by both shells so the
  // work column stays a single definition.
  const workSurface = (
    <div className="ade-shell-work flex flex-col flex-1 min-w-0">
      <div
        className={
          props.bottomPaneOpen && props.bottomPaneMaximized
            ? "hidden"
            : "flex-1 min-h-0 overflow-hidden"
        }
      >
        {props.body}
      </div>

      {props.bottomPane &&
        props.bottomPaneOpen &&
        // Maximized, the pane IS the work surface — there is no boundary left
        // to drag, so it renders as a plain filling row rather than a pane.
        (props.bottomPaneMaximized ? (
          <div className="flex-1 min-h-0 overflow-hidden border-t border-line-soft">
            {props.bottomPane}
          </div>
        ) : (
          <ResizablePane
            orientation="horizontal"
            edge="trailing"
            size={bottomH}
            min={BOTTOM_MIN}
            max={BOTTOM_MAX}
            onResize={setBottomH}
            label="Resize panel"
            className="overflow-hidden border-t border-line-soft"
          >
            {props.bottomPane}
          </ResizablePane>
        ))}

      <div className="flex-shrink-0 border-t border-line-soft">
        {props.composer}
      </div>
    </div>
  );

  const statusBarRow = props.statusBar ? (
    <div
      className="flex-shrink-0 flex items-center bg-bg-0 border-t border-line-soft"
      style={{ height: "var(--statusbar-h)" }}
    >
      {props.statusBar}
    </div>
  ) : null;

  // The sidebar column runs edge-to-edge to y=0 and carries its own header
  // strip (traffic-light drag region, project switcher, search, workspace
  // nav); the top header only spans the work surface to the right of it, so
  // the window reads as an L of chrome whose vertical arm is the sidebar and
  // whose horizontal arm is the header.
  return (
    <div className="ade-shell-root flex h-screen w-screen text-text-1 select-none overflow-hidden bg-bg-0">
      {sidebarVisible && (
        /* `.ade-side` so the whole column (header + roster) picks up the
           macOS vibrancy frost — an opaque bg here would block the blur.
           Off-vibrancy it falls back to the same solid bg-1, never
           black/see-through. The AdeSidebar it wraps is itself an
           `.ade-side`; a nested-tint guard in styles.css blanks the inner
           layer so the two 66% frosts don't stack into a near-opaque
           slab. */
        <ResizablePane
          edge="leading"
          size={sidebarW}
          min={SIDEBAR_MIN}
          max={SIDEBAR_MAX}
          onResize={setSidebarW}
          label="Resize sidebar"
          className="ade-side flex flex-col relative border-r border-line-soft"
        >
          {props.sidebarHeader}
          <div className="flex-1 min-h-0 overflow-hidden">{props.sidebar}</div>
        </ResizablePane>
      )}

      <div className="ade-shell-main flex flex-col flex-1 min-w-0 bg-bg-1">
        {/* Top header — chrome strip spanning ONLY the work surface. It
            stops before the review rail, which owns its own header (below)
            running to y=0, so the window reads as three full-height
            columns (sidebar · work · review) each with its own header. */}
        {topStrip && (
          <div
            className="flex-shrink-0 flex items-center bg-bg-1 border-b border-line"
            style={{ height: "var(--topbar-h)" }}
          >
            {topStrip}
          </div>
        )}

        <div className="ade-shell-mid flex flex-1 min-h-0 bg-bg-0 overflow-hidden">
          {workSurface}
        </div>

        {statusBarRow}
      </div>

      {/* Review rail — a full-height column to y=0 (Conductor pattern),
          with its OWN header strip carrying the rail's primary action
          (Create PR). Aligned with the work-surface topbar so the two
          headers read as one continuous strip broken only by the column
          divider. */}
      {reviewVisible && (
        <ResizablePane
          edge="trailing"
          size={reviewW}
          min={REVIEW_MIN}
          max={REVIEW_MAX}
          onResize={setReviewW}
          label="Resize panel"
          className="ade-shell-review flex flex-col border-l border-line-soft bg-bg-1"
        >
          <div
            className="flex-shrink-0 flex items-center bg-bg-1 border-b border-line"
            style={{ height: "var(--topbar-h)" }}
          >
            {props.reviewHeader}
          </div>
          <div className="flex-1 min-h-0 overflow-hidden">
            {props.reviewPanel}
          </div>
        </ResizablePane>
      )}
    </div>
  );
}

// `DragHandle`, `clamp` and `useStored` lived here — the hit-target overlay,
// the bounds check and the localStorage-backed width. All three are
// `ui/resizable` now (`PaneResizer`, `clampSize`, `usePaneSize`), shared with
// the place rail and Team's context column, so the app has one answer to "what
// makes a pane a pane" rather than one per file.

// Live window-width tracker. Drives the responsive auto-collapse for
// the sidebar and review panel when the window gets too narrow.
function useWindowWidth(): number {
  const [w, setW] = useState<number>(() =>
    typeof window === "undefined" ? 1200 : window.innerWidth,
  );
  useEffect(() => {
    const onResize = () => setW(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return w;
}
