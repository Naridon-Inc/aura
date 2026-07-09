// Unified-canvas shell (Superset-style). The whole window is one bg
// surface; columns and rows are separated only by 1px borders. No gaps,
// no rounded inset corners — panes butt against each other so the IDE
// reads as a single rectangle subdivided by hairlines, not a frame
// around floating cards.
//
// Drag handles sit on top of the column boundary border (1px wide
// hit-target widened by hover area) so resizing doesn't shift any
// pixels, just moves the divider.

import { useEffect, useRef, useState, type ReactNode } from "react";

type LayoutProps = {
  workspaceRail?: ReactNode;
  /** Vertical nav rail column. Optional — when omitted, the sidebar
   *  butts directly against the workspace rail and the nav tabs are
   *  expected to live as a horizontal strip inside `sidebar`. */
  rail?: ReactNode;
  sidebar: ReactNode;
  /** Full-height-sidebar shell (ADE v2): the sidebar column runs to y=0 and
   *  carries `sidebarHeader` (project switcher / search / nav); the top
   *  header only spans the work surface to its right. Off = the legacy
   *  full-width-topbar tree. */
  fullHeightSidebar?: boolean;
  /** Top strip of the full-height sidebar — traffic-light drag region,
   *  project switcher, search, extensions, workspace nav. Only rendered in
   *  the `fullHeightSidebar` shell. */
  sidebarHeader?: ReactNode;
  topBar: ReactNode;
  statusBar?: ReactNode;
  body: ReactNode;
  composer: ReactNode;
  reviewPanel?: ReactNode;
  bottomPane?: ReactNode;
  bottomPaneOpen?: boolean;
  /** When true the bottom pane fills the whole work-surface height (the
   *  terminal panel's maximize toggle); the body collapses behind it. */
  bottomPaneMaximized?: boolean;
  sidebarOpen?: boolean;
  reviewOpen?: boolean;
};

const SIDEBAR_KEY = "aura.sidebar.w";
const REVIEW_KEY = "aura.review.w";
const BOTTOM_KEY = "aura.bottom.h";

export function Layout(props: LayoutProps) {
  const [sidebarW, setSidebarW] = useStored(SIDEBAR_KEY, 280, 200, 480);
  const [reviewW, setReviewW] = useStored(REVIEW_KEY, 320, 240, 560);
  const [bottomH, setBottomH] = useStored(BOTTOM_KEY, 240, 160, 600);
  const dragging = useRef<"sidebar" | "review" | "bottom" | null>(null);

  const workspaceRailW = props.workspaceRail ? 56 : 0;
  // Must track the rendered rail width (`--nav-rail-w` in styles.css). A stale
  // 52 here over-reserved 4px in the responsive guards and the sidebar drag
  // clamp below, drifting both off the actual 48px tile column.
  const railW = props.rail ? 48 : 0;

  // Responsive guards — at narrow widths the review panel (320px+) on
  // top of the sidebar (280px) can crowd the work surface to ~250px or
  // less. Hide the review when the work area would drop below the
  // 480px threshold; the user can still toggle it back via ⌘R.
  const winW = useWindowWidth();
  const fixed = workspaceRailW + railW + (props.sidebarOpen ?? true ? sidebarW : 0);
  const reviewFitsWide = winW - fixed - reviewW >= 480;
  const reviewVisible =
    !!props.reviewPanel && (props.reviewOpen ?? true) && reviewFitsWide;
  const sidebarFitsWide = winW - workspaceRailW - railW - sidebarW >= 360;
  const sidebarVisible = (props.sidebarOpen ?? true) && sidebarFitsWide;
  useEffect(() => {
    function move(e: MouseEvent) {
      if (dragging.current === "sidebar") {
        // Sidebar starts after the workspace rail (optional 64px) + the
        // nav rail (optional 52px) + one chrome gap.
        setSidebarW(clamp(e.clientX - workspaceRailW - railW - 6, 200, 480));
      } else if (dragging.current === "review") {
        setReviewW(clamp(window.innerWidth - e.clientX - 6, 240, 560));
      } else if (dragging.current === "bottom") {
        setBottomH(clamp(window.innerHeight - e.clientY - 28, 160, 600));
      }
    }
    function up() {
      dragging.current = null;
      document.body.style.cursor = "";
    }
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, []);

  const startSidebarDrag = () => {
    dragging.current = "sidebar";
    document.body.style.cursor = "col-resize";
  };

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

      {props.bottomPane && props.bottomPaneOpen && (
        <>
          {!props.bottomPaneMaximized && (
            <DragHandle
              orientation="horizontal"
              onStart={() => {
                dragging.current = "bottom";
                document.body.style.cursor = "row-resize";
              }}
            />
          )}
          <div
            className={
              props.bottomPaneMaximized
                ? "flex-1 min-h-0 overflow-hidden border-t border-line-soft"
                : "flex-shrink-0 overflow-hidden border-t border-line-soft"
            }
            style={props.bottomPaneMaximized ? undefined : { height: bottomH }}
          >
            {props.bottomPane}
          </div>
        </>
      )}

      <div className="flex-shrink-0 border-t border-line-soft">
        {props.composer}
      </div>
    </div>
  );

  const reviewSection = reviewVisible ? (
    <>
      <DragHandle
        orientation="vertical"
        onStart={() => {
          dragging.current = "review";
          document.body.style.cursor = "col-resize";
        }}
      />
      <FlushPanel width={reviewW} borderLeft className="ade-shell-review">
        {props.reviewPanel}
      </FlushPanel>
    </>
  ) : null;

  const statusBarRow = props.statusBar ? (
    <div
      className="flex-shrink-0 flex items-center bg-bg-0 border-t border-line-soft"
      style={{ height: "var(--statusbar-h)" }}
    >
      {props.statusBar}
    </div>
  ) : null;

  // Full-height-sidebar shell (ADE v2). The sidebar column runs edge-to-edge
  // to y=0 and carries its own header strip (traffic-light drag region,
  // project switcher, search, workspace nav); the top header only spans the
  // work surface to the right of it, so the window reads as an L of chrome
  // whose vertical arm is the sidebar and whose horizontal arm is the header.
  if (props.fullHeightSidebar) {
    return (
      <div className="ade-shell-root flex h-screen w-screen text-text-1 select-none overflow-hidden bg-bg-0">
        {sidebarVisible && (
          <>
            {/* `.ade-side` so the whole column (header + roster) picks up the
                macOS vibrancy frost — an opaque bg here would block the blur.
                Off-vibrancy it falls back to the same solid bg-1, never
                black/see-through. The AdeSidebar it wraps is itself an
                `.ade-side`; a nested-tint guard in styles.css blanks the inner
                layer so the two 66% frosts don't stack into a near-opaque
                slab. */}
            <div
              className="ade-side flex flex-col flex-shrink-0 relative border-r border-line-soft"
              style={{ width: sidebarW }}
            >
              {props.sidebarHeader}
              <div className="flex-1 min-h-0 overflow-hidden">
                {props.sidebar}
              </div>
            </div>
            <DragHandle orientation="vertical" onStart={startSidebarDrag} />
          </>
        )}

        <div className="ade-shell-main flex flex-col flex-1 min-w-0 bg-bg-1">
          {/* Top header — chrome strip spanning only the work surface. */}
          <div
            className="flex-shrink-0 flex items-center bg-bg-1 border-b border-line"
            style={{ height: "var(--topbar-h)" }}
          >
            {props.topBar}
          </div>

          <div className="ade-shell-mid flex flex-1 min-h-0 bg-bg-0 overflow-hidden">
            {workSurface}
            {reviewSection}
          </div>

          {statusBarRow}
        </div>
      </div>
    );
  }

  return (
    <div className="ade-shell-root flex h-screen w-screen text-text-1 select-none overflow-hidden bg-bg-1">
      {/* Workspace rail — chrome bg (bg-1). Same bg as topbar so the
          two visually merge into one continuous L. No border-r — the
          inner content's rounded top-left corner is the only visual
          break between rail and content. */}
      {props.workspaceRail && (
        <div
          className="flex flex-col items-center flex-shrink-0 relative bg-bg-1"
          style={{
            width: 56,
            paddingTop: "var(--topbar-h)",
          }}
        >
          {/* macOS traffic-light strip (above first tile) — drag-region
              so clicks-and-drags move the window. */}
          <span
            data-tauri-drag-region
            className="absolute left-0 right-0 top-0"
            style={{ height: "var(--topbar-h)" }}
          />
          {props.workspaceRail}
        </div>
      )}

      <div className="ade-shell-main flex flex-col flex-1 min-w-0 bg-bg-1">
        {/* TOPBAR — chrome strip; same bg as the workspace rail so the
            top-left of the window reads as one continuous L of chrome.
            A bottom hairline divides the chrome from the content below
            (the rounded top-left corner tucks under it on the left). */}
        <div
          className="flex-shrink-0 flex items-center bg-bg-1 border-b border-line"
          style={{ height: "var(--topbar-h)" }}
        >
          {props.topBar}
        </div>

        {/* MIDDLE ROW — nav rail + sidebar + work surface + review.
            Lives on bg-0 (content surface), nests into the chrome with
            a rounded top-left corner so the rail+topbar L bends
            inward. overflow-hidden clips child borders to the radius
            so the column dividers terminate cleanly inside the curve. */}
        <div
          className="ade-shell-mid flex flex-1 min-h-0 bg-bg-0 overflow-hidden"
          style={{ borderTopLeftRadius: "var(--radius-panel)" }}
        >
          {/* Nav rail — 52px tile column. Hidden when `rail` prop is
              omitted (nav lives as a horizontal strip inside the
              sidebar instead). */}
          {props.rail && (
            <div
              className="flex flex-col items-center flex-shrink-0 border-r border-line-soft"
              style={{ width: "var(--nav-rail-w)" }}
            >
              {props.rail}
            </div>
          )}

          {sidebarVisible && (
            <>
              <FlushPanel width={sidebarW} borderRight>
                {props.sidebar}
              </FlushPanel>
              <DragHandle
                orientation="vertical"
                onStart={() => {
                  dragging.current = "sidebar";
                  document.body.style.cursor = "col-resize";
                }}
              />
            </>
          )}

          {workSurface}

          {reviewSection}
        </div>

        {statusBarRow}
      </div>
    </div>
  );
}

// Flush column on the unified canvas. Optional 1px hairline on the
// trailing edge so the next column has a visible separator.
function FlushPanel({
  width,
  children,
  borderRight,
  borderLeft,
  className,
}: {
  width: number;
  children: ReactNode;
  borderRight?: boolean;
  borderLeft?: boolean;
  className?: string;
}) {
  return (
    <div
      className={`flex flex-col overflow-hidden flex-shrink-0 ${
        borderRight ? "border-r border-line-soft" : ""
      } ${borderLeft ? "border-l border-line-soft" : ""} ${className ?? ""}`}
      style={{ width }}
    >
      {children}
    </div>
  );
}

// 1px hit-target overlay for column/row resizing. Negative-margin
// trick widens the hover catch area to ~6px without consuming layout
// width, so neighbouring panes stay flush against the hairline border.
function DragHandle({
  orientation,
  onStart,
}: {
  orientation: "vertical" | "horizontal";
  onStart: () => void;
}) {
  if (orientation === "vertical") {
    return (
      <div
        onMouseDown={onStart}
        className="cursor-col-resize hover:bg-line"
        style={{
          width: 4,
          marginLeft: -2,
          marginRight: -2,
          background: "transparent",
          flexShrink: 0,
          zIndex: 5,
        }}
      />
    );
  }
  return (
    <div
      onMouseDown={onStart}
      className="cursor-row-resize hover:bg-line"
      style={{
        height: 4,
        marginTop: -2,
        marginBottom: -2,
        background: "transparent",
        flexShrink: 0,
        zIndex: 5,
      }}
    />
  );
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

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

function useStored(key: string, initial: number, lo: number, hi: number) {
  const [v, setV] = useState<number>(() => {
    const raw = localStorage.getItem(key);
    if (!raw) return initial;
    const n = parseFloat(raw);
    return Number.isFinite(n) ? clamp(n, lo, hi) : initial;
  });
  useEffect(() => {
    localStorage.setItem(key, String(v));
  }, [key, v]);
  return [v, setV] as const;
}
