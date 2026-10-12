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

import { useZoom } from "../lib/zoomStore";
import { ResizablePane, usePaneSize } from "./ui/resizable";

type LayoutProps = {
  sidebar: ReactNode;
  /** Top strip of the sidebar column — traffic-light drag region, project
   *  switcher, search, workspace nav. */
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

// Every pane bound here is in WINDOW POINTS, not CSS px — see `sidebarCss`
// for why, and `reviewCss` / `bottomCss` for the two that followed it.
const SIDEBAR_MIN_PT = 200;
const SIDEBAR_MAX_PT = 480;
const SIDEBAR_DEFAULT_PT = 280;
const REVIEW_MIN_PT = 240;
const REVIEW_MAX_PT = 560;
const REVIEW_DEFAULT_PT = 320;
const BOTTOM_MIN_PT = 160;
const BOTTOM_MAX_PT = 600;
const BOTTOM_DEFAULT_PT = 240;

/** The least CSS px of work surface worth leaving beside a rail. A *content*
 *  minimum, so it stays in CSS px while the rails beside it are measured in
 *  window points: the question it answers is "does anything still fit in
 *  there", and what fits is counted in the same zoomed pixels the content is
 *  laid out in. */
const WORK_MIN_CSS = 360;
/** Same question for the work surface with the review rail also standing. */
const WORK_MIN_WITH_REVIEW_CSS = 480;

export function Layout(props: LayoutProps) {
  // Webview zoom, as the factor every CSS px is multiplied by on its way to
  // the window. Read from the store the keyboard and Settings share, so the
  // conversions below move on the same keystroke the rest of the app does.
  const zoom = useZoom();

  const [sidebarPt, setSidebarPt] = usePaneSize(
    SIDEBAR_KEY,
    SIDEBAR_DEFAULT_PT,
    SIDEBAR_MIN_PT,
    SIDEBAR_MAX_PT,
  );
  const [reviewPt, setReviewPt] = usePaneSize(
    REVIEW_KEY,
    REVIEW_DEFAULT_PT,
    REVIEW_MIN_PT,
    REVIEW_MAX_PT,
  );
  const [bottomPt, setBottomPt] = usePaneSize(
    BOTTOM_KEY,
    BOTTOM_DEFAULT_PT,
    BOTTOM_MIN_PT,
    BOTTOM_MAX_PT,
  );

  // The sidebar is the one pane whose width is held in window points, and this
  // division is where it becomes a layout length.
  //
  // It used to be a flat 280 CSS px. Zoom multiplies every CSS px on its way
  // to the window, so the rail grew with it while the window did not: measured
  // on a 1000pt window it took 28% of the viewport at 100%, 35% at 125% and
  // 42% at 150%, and the work surface paid for all of it. That is the rail
  // answering "this text is too small" by taking more of the window from its
  // neighbour instead of showing less of itself — the only element in the
  // window that does. Everything else answers zoom the way zoom means it:
  // bigger, therefore less fits.
  //
  // So the rail keeps its SHARE of the window. On a window of fixed physical
  // size a constant point width is a constant share, which is what the
  // division buys: 280pt is 28% of a 1000pt window at every zoom level. The
  // price is paid inside the rail — its labels grow while its box does not, so
  // fewer characters fit and more rows ellipsize. That is the right place for
  // zoom's cost to land: the rail's job is eight to twenty destination names,
  // and it is draggable, so a reader who wants the names back takes the width
  // deliberately — and now that width means the same physical size at every
  // zoom instead of a different one per level.
  //
  // Same reasoning, same divisor as the traffic-light gutter
  // (`ZOOM_INVARIANT_GUTTER` in topbar/windowControls.ts), and the same unit
  // the native terminal surface beside it is placed in (`toWindowPoints`) — so
  // the pane that decides where that surface's hole starts is now measured in
  // the surface's own coordinates.
  const sidebarCss = sidebarPt / zoom;

  // The other two rails, for the same reason and by the same division.
  //
  // They had the sidebar's defect exactly: a flat 320 CSS px and a flat 240,
  // growing with zoom while the window stood still. The review rail's symptom
  // was the sneakier of the two, because the guard below fires before the rail
  // can finish eating the window — past about 125% zoom the inequality stops
  // holding and the rail simply disappears, which reads as a bug in the review
  // panel rather than as a width that outgrew its window.
  //
  // The bottom pane is the same statement about height. A pane that is a
  // quarter of the window at 100% is well over a third at 150%, and what it
  // takes comes out of the body above it.
  const reviewCss = reviewPt / zoom;
  const bottomCss = bottomPt / zoom;

  // Responsive guards — at narrow widths the review rail (320 points and up)
  // on top of the sidebar can crowd the work surface to ~250px or less. Hide
  // the review when the work area would drop below the threshold; the user
  // can still toggle it back via ⌘⌥R. Every term here is CSS px: `winW` is
  // `innerWidth`, and both rails' points are converted before they are
  // compared, rather than one side of the inequality being in points.
  const winW = useWindowWidth();
  const fixed = props.sidebarOpen ?? true ? sidebarCss : 0;
  const reviewFitsWide = winW - fixed - reviewCss >= WORK_MIN_WITH_REVIEW_CSS;
  const reviewVisible =
    !!props.reviewPanel && (props.reviewOpen ?? true) && reviewFitsWide;
  const sidebarFitsWide = winW - sidebarCss >= WORK_MIN_CSS;
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
            size={bottomCss}
            min={BOTTOM_MIN_PT / zoom}
            max={BOTTOM_MAX_PT / zoom}
            onResize={(css) => setBottomPt(css * zoom)}
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
          size={sidebarCss}
          /* The bounds travel through the same divisor as the size, so the
             drag clamps to 200–480 POINTS at whatever zoom it happens at —
             and a width dragged at 150% means the same rail at 100%. */
          min={SIDEBAR_MIN_PT / zoom}
          max={SIDEBAR_MAX_PT / zoom}
          /* A drag delta is `clientX`, i.e. CSS px; multiplying it back is
             what keeps the stored width, the handle and the layout all
             talking about points. Without this the stored number would mean
             a different physical width per zoom level — a resize handle and
             a zoom divisor disagreeing about units. */
          onResize={(css) => setSidebarPt(css * zoom)}
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
          size={reviewCss}
          min={REVIEW_MIN_PT / zoom}
          max={REVIEW_MAX_PT / zoom}
          onResize={(css) => setReviewPt(css * zoom)}
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
