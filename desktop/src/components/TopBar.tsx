// The window's chrome vocabulary — the controls that live in the macOS title
// bar strip (`titleBarStyle: "Overlay"` in tauri.conf.json hides the native
// title and lets us paint into it), plus the drag behaviour any strip that
// starts at y=0 has to carry.

import { forwardRef, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { beginWindowDrag } from "../lib/windowDrag";
import { useWindowControlsInset } from "./topbar/windowControls";
import { Tooltip, TooltipTrigger, TooltipContent } from "./ui/tooltip";
import { MENU_PANEL, MENU_ROW } from "./ui/menuSurface";
import { api, type ResourceSnapshot } from "../lib/api";
import { applyUpdate, checkForUpdate } from "../lib/updater";
import { getVersion } from "@tauri-apps/api/app";
import { useDismiss } from "../lib/useDismiss";
import { formatMegabytes } from "../lib/bytes";
import { percent } from "../lib/percent";
import { askConfirm } from "./ui/ask";

/**
 * Move the window from a mousedown on a chrome strip.
 *
 * Any strip painted at y=0 needs this: `data-tauri-drag-region` alone misses
 * some click targets in Tauri 2 (event-bubbled clicks inside flex containers),
 * so every such strip carries the attribute AND this handler, and one of the
 * two always works. Exported because the tab strip is now one of those strips
 * — it starts at the top of the window, so its empty half is where a person
 * reaches to move the window, exactly as the band above it used to be.
 *
 * Pass `undefined` instead while the window is fullscreen: it can neither be
 * dragged nor zoomed there, and a live handler just fires no-op native calls.
 */
export function startWindowDrag(e: React.MouseEvent) {
  // Only the primary button drags. Skip drag when the mousedown was
  // really aimed at a clickable child (button / input / link) — those
  // need to fire their own handlers, not move the window.
  if (e.button !== 0) return;
  const target = e.target as HTMLElement;
  if (target.closest("button, input, a, [role=button]")) return;
  if (e.detail === 2) {
    getCurrentWindow().toggleMaximize().catch(() => {});
    return;
  }
  beginWindowDrag();
}

// The window's chrome controls. The sidebar owns identity, search, project
// switching and navigation; the bottom StatusBar owns status and system
// indicators. What was left here — the three "show/hide a pane" toggles —
// used to justify a 30px band of its own spanning the whole work column,
// stacked directly above the tab strip.
//
// That band was 95% empty. Two icons at its right end, one at its left, and
// between them seven hundred pixels of nothing, with the tab strip's own
// controls sitting 30px below in the SAME corner: four controls in two rows
// where one row would do. The top of the window read as two headers because
// it WAS two headers.
//
// So the band is gone and its contents moved into the tab strip, which was
// already a full-width row at the top of the work column with a trailing
// slot two of its call sites were using. Nothing is on screen that wasn't
// before; it is on ONE line now, and the sidebar header, the tab strip and
// the review rail's header all start and end at the same two y values —
// which is what "one header" has to mean before it can look like anything.
//
// The two clusters below are what remains, rendered by whoever owns the row
// they belong to:
//   • `SidebarPeek`   — the show-sidebar affordance. Only exists while the
//     sidebar is collapsed, and it must sit clear of the macOS traffic
//     lights, which land on whatever the work column draws first in that
//     state. It carries the gutter itself.
//   • `PaneToggles`   — terminal + review. The right end of the tab strip.

/** Leading cluster of the tab row while the sidebar is collapsed: the
 *  traffic-light gutter plus the one control that brings the sidebar back.
 *
 *  Renders nothing at all when the sidebar is open — in that state the
 *  sidebar's own header owns the window's top-left corner and the lights sit
 *  over it, so the tab row starts flush against the column divider. */
export function SidebarPeek({
  sidebarOpen,
  onToggleSidebar,
}: {
  sidebarOpen?: boolean;
  onToggleSidebar?: () => void;
}) {
  // Before the early return — this component may start rendering the moment
  // the sidebar closes, and a hook that only runs in one branch is a hook
  // that changes position between renders.
  const inset = useWindowControlsInset(true);
  if (sidebarOpen || !onToggleSidebar) return null;
  return (
    <div
      // The gutter is mostly empty space under the macOS traffic lights, and
      // with the sidebar closed it's the only chrome left in the window's
      // top-left corner — so it drags the window, the way the band it
      // replaced did. `startWindowDrag` steps aside for the button.
      data-tauri-drag-region
      onMouseDown={startWindowDrag}
      className="flex items-center gap-1 bg-bg-chrome border-b border-line-soft text-text-3"
      style={{ paddingLeft: inset, paddingRight: 4 }}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <ChromeBtn title="Show sidebar (⌘B)" onClick={onToggleSidebar} tooltip>
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
              <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" stroke="currentColor" />
              <line x1="6" y1="2.5" x2="6" y2="13.5" stroke="currentColor" />
            </svg>
          </ChromeBtn>
        </TooltipTrigger>
        <TooltipContent side="bottom">Show sidebar (⌘B)</TooltipContent>
      </Tooltip>
    </div>
  );
}

/** Trailing cluster of the tab row: the terminal and review-rail toggles.
 *
 *  These are window chrome, not tab actions, which is why they sit hard
 *  against the right edge past everything the strip itself owns — and why
 *  they keep the same icons, the same `ChromeBtn` and the same shortcuts
 *  they had in the band. Only the row they live on changed. */
export function PaneToggles({
  reviewOpen,
  terminalOpen,
  onToggleReview,
  onToggleTerminal,
}: {
  reviewOpen: boolean;
  terminalOpen: boolean;
  onToggleReview?: () => void;
  onToggleTerminal?: () => void;
}) {
  return (
    <div className="flex items-center gap-1 px-2 bg-bg-chrome border-b border-line-soft text-text-3">
      <Tooltip>
        <TooltipTrigger asChild>
          <ChromeBtn
            title="Toggle terminal (⌘J)"
            active={terminalOpen}
            onClick={onToggleTerminal}
            tooltip
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
              <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" stroke="currentColor" />
              <path d="M4 6l2.5 2L4 10" stroke="currentColor" strokeWidth="1.4" fill="none" />
              <line x1="8" y1="10.5" x2="12" y2="10.5" stroke="currentColor" strokeWidth="1.2" />
            </svg>
          </ChromeBtn>
        </TooltipTrigger>
        <TooltipContent side="bottom">Toggle terminal (⌘J)</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <ChromeBtn
            title={reviewOpen ? "Hide review rail (⌘⌥R)" : "Show review rail (⌘⌥R)"}
            active={reviewOpen}
            onClick={onToggleReview}
            tooltip
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
              <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" stroke="currentColor" />
              <line x1="10" y1="2.5" x2="10" y2="13.5" stroke="currentColor" />
            </svg>
          </ChromeBtn>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {reviewOpen ? "Hide review rail (⌘⌥R)" : "Show review rail (⌘⌥R)"}
        </TooltipContent>
      </Tooltip>
    </div>
  );
}

// Right-side overflow menu.
//
// It used to hold five more: Review Changes, Proof trail, Code Map, Memory,
// Doctor. Every one of them is a destination in Trace, which is a page with
// its own switcher — so this was a second door to the same five places, and
// it called them by different names than the page does. Two menus naming the
// same rooms differently is worse than one menu, and the one that belongs to
// the room wins. What is left is the update check, which belongs to the app
// rather than to any repo or page.
export function MoreMenu({
  placement = "down",
}: {





  /** "up" anchors the panel above the trigger — for the bottom StatusBar. */
  placement?: "up" | "down";
}) {
  const [open, setOpen] = useState(false);
  const [updateState, setUpdateState] = useState<
    | { kind: "idle" }
    | { kind: "checking" }
    | { kind: "downloading"; done: number; total: number | null }
    | { kind: "error"; message: string }
    | { kind: "uptodate"; current: string }
  >({ kind: "idle" });
  const wrapRef = useRef<HTMLDivElement>(null);

  useDismiss(open, () => setOpen(false), wrapRef);

  async function onCheckUpdates() {
    setUpdateState({ kind: "checking" });
    try {
      const info = await checkForUpdate(true);
      if (!info) {
        const current = await getVersion().catch(() => "current");
        setUpdateState({ kind: "uptodate", current });
        return;
      }
      const proceed = await askConfirm({
        title: `Aura ${info.version} is available`,
        body: `${info.notes ? `${info.notes}\n\n` : ""}Download and install it now? The app restarts when it's done.`,
        confirmLabel: "Download and install",
        cancelLabel: "Not now",
      });
      if (!proceed) {
        setUpdateState({ kind: "idle" });
        return;
      }
      setUpdateState({ kind: "downloading", done: 0, total: null });
      await applyUpdate(info, (done, total) =>
        setUpdateState({ kind: "downloading", done, total }),
      );
      // relaunch() inside applyUpdate normally fires; if it didn't,
      // leave the toast as "downloading" so the user knows it's done
      // and can manually quit.
    } catch (e) {
      setUpdateState({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  const items: Array<{
    label: string;
    hint: string;
    handler?: () => void;
  }> = [
    {
      label: "Check for Updates",
      hint: "Look for a newer Aura release",
      handler: onCheckUpdates,
    },
  ];

  const updateStatusLine = (() => {
    switch (updateState.kind) {
      case "idle":
        return null;
      case "checking":
        return "Checking for updates…";
      case "uptodate":
        return `You're on the latest (v${updateState.current}).`;
      case "downloading": {
        if (updateState.total && updateState.total > 0) {
          const pct = percent(updateState.done, updateState.total);
          return `Downloading update… ${pct}%`;
        }
        const mb = (updateState.done / (1024 * 1024)).toFixed(1);
        return `Downloading update… ${mb} MB`;
      }
      case "error":
        return `Update failed: ${updateState.message}`;
    }
  })();

  return (
    <div ref={wrapRef} className="relative">
      <Tooltip>
        <TooltipTrigger asChild>
          <ChromeBtn
            title="More tools"
            active={open}
            onClick={() => setOpen((v) => !v)}
            tooltip
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
              <circle cx="3.5" cy="8" r="1.4" />
              <circle cx="8" cy="8" r="1.4" />
              <circle cx="12.5" cy="8" r="1.4" />
            </svg>
          </ChromeBtn>
        </TooltipTrigger>
        <TooltipContent side={placement === "up" ? "top" : "bottom"}>
          More tools
        </TooltipContent>
      </Tooltip>
      {open && (
        <div
          className={`${MENU_PANEL} absolute right-0 ${
            placement === "up" ? "bottom-[26px]" : "top-[26px]"
          }`}
          style={{ minWidth: 260 }}
        >
          {items.map((it) => {
            const isUpdateItem = it.label === "Check for Updates";
            const busy =
              isUpdateItem &&
              (updateState.kind === "checking" ||
                updateState.kind === "downloading");
            return (
              <button
                key={it.label}
                type="button"
                onClick={() => {
                  if (isUpdateItem) {
                    // Keep menu open so the user can watch progress.
                    it.handler?.();
                    return;
                  }
                  setOpen(false);
                  it.handler?.();
                }}
                disabled={!it.handler || busy}
                className={`${MENU_ROW} flex-col !items-start gap-0.5`}
              >
                <span className="font-medium">{it.label}</span>
                <span className="text-xs text-text-4 leading-tight">
                  {it.hint}
                </span>
              </button>
            );
          })}
          {updateStatusLine && (
            <div
              // A failed update is a real failure, so it keeps red — but on
              // the app's own `--color-red` token, not a raw Tailwind rose.
              className={`mt-1 mx-1 px-2.5 py-1.5 rounded text-xs leading-tight border ${
                updateState.kind === "error"
                  ? "border-red/30 bg-red/10 text-red"
                  : "border-line-soft bg-bg-2 text-text-3"
              }`}
            >
              {updateStatusLine}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Resource usage pill — shows the aura-family memory footprint in the
// topbar (mirrors Activity Monitor / Task Manager). Click opens a
// popover with system CPU + memory totals and a per-process row for
// every aura binary + spawned agent CLI. Polls every 2s while open;
// silent (no network) when closed.
export function ResourcePill({
  placement = "down",
}: {
  /** "up" anchors the popover above the pill — for the bottom StatusBar. */
  placement?: "up" | "down";
} = {}) {
  const [open, setOpen] = useState(false);
  const [snap, setSnap] = useState<ResourceSnapshot | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Keep a low-rate background poll even when closed so the pill label
  // (aura-family MB) stays roughly fresh — but fall back to a single
  // probe on first mount so the pill has something to show immediately.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      try {
        const s = await api.resourceSnapshot();
        if (!cancelled) setSnap(s);
      } catch {
        /* ignore — sysinfo can transiently fail */
      }
      if (cancelled) return;
      // 2s when open, 8s when closed — closed cadence is just for the
      // pill label freshness.
      timer = setTimeout(tick, open ? 2000 : 8000);
    };
    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [open]);

  useDismiss(open, () => setOpen(false), wrapRef);

  const label = snap ? formatMegabytes(snap.aura_memory_mb) : "—";

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        title="Resource usage"
        onClick={() => setOpen((v) => !v)}
        className={`h-[22px] px-2 rounded flex items-center gap-1.5 text-xs font-medium transition-colors ${
          open
            ? "bg-bg-card text-text-1"
            : "text-text-3 hover:bg-state-hover hover:text-text-1"
        }`}
      >
        <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
          <rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" />
          <line x1="5" y1="3" x2="5" y2="13" stroke="currentColor" />
          <line x1="8" y1="3" x2="8" y2="13" stroke="currentColor" />
          <line x1="11" y1="3" x2="11" y2="13" stroke="currentColor" />
        </svg>
        <span>{label}</span>
      </button>
      {open && (
        <div
          className={`${MENU_PANEL} absolute right-0 !p-0 ${
            placement === "up" ? "bottom-[26px]" : "top-[26px]"
          }`}
          style={{ width: 320 }}
        >
          <div className="px-3 pt-2.5 pb-1.5 border-b border-line-soft">
            <div className="section-label">
              Resource Usage
            </div>
          </div>
          <div className="px-3 py-2 grid grid-cols-3 gap-2 border-b border-line-soft">
            <ResourceStat
              label="CPU"
              value={snap ? `${snap.cpu_percent.toFixed(1)}%` : "—"}
            />
            <ResourceStat
              label="Memory"
              value={
                snap
                  ? `${snap.used_memory_mb} / ${snap.total_memory_mb} MB`
                  : "—"
              }
            />
            <ResourceStat
              label="RAM Share"
              value={snap ? `${snap.app_share_percent.toFixed(2)}%` : "—"}
            />
          </div>
          <div className="px-3 pt-2 pb-1">
            <div className="section-label">
              Aura processes
            </div>
          </div>
          <div className="max-h-[260px] overflow-y-auto px-1.5 pb-2">
            {snap && snap.processes.length > 0 ? (
              snap.processes.map((p) => (
                <div
                  key={p.pid}
                  className="flex items-center gap-2 px-1.5 py-1 rounded hover:bg-state-hover"
                >
                  <span className="text-sm text-text-1 flex-1 truncate font-medium">
                    {p.name}
                  </span>
                  <span className="text-xs text-text-4 tabular-nums w-12 text-right">
                    {p.cpu_percent.toFixed(1)}%
                  </span>
                  <span className="text-xs text-text-3 tabular-nums w-14 text-right">
                    {p.memory_mb} MB
                  </span>
                </div>
              ))
            ) : (
              <div className="px-2 py-3 text-xs text-text-4">
                No aura processes detected.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ResourceStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="section-label">
        {label}
      </span>
      <span className="text-sm text-text-1 tabular-nums">{value}</span>
    </div>
  );
}
// Compact 20px tile so the whole row fits inside the 30px topbar with
// the macOS traffic lights aligned to the same vertical centerline.
//
// forwardRef + prop spread so a styled <Tooltip><TooltipTrigger asChild>
// can inject its open/close handlers and ref onto the underlying button.
// `title` doubles as the accessible label (aria-label). When the button is
// wrapped in a styled Tooltip, the caller passes `tooltip` so the native
// `title=` is dropped (no duplicate browser tooltip) while the aria-label
// keeps the button named. Callers that don't wrap it keep the native
// `title` exactly as before — no behaviour change for them.
export const ChromeBtn = forwardRef<
  HTMLButtonElement,
  {
    children: React.ReactNode;
    title: string;
    active?: boolean;
    onClick?: () => void;
    /** Set when the button is wrapped in a styled Tooltip — suppresses
     *  the native `title=` so the two tooltips don't stack. */
    tooltip?: boolean;
  } & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "title">
>(function ChromeBtn(
  { children, title, active, onClick, tooltip, className, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      aria-label={title}
      title={tooltip ? undefined : title}
      onClick={onClick}
      className={`w-[20px] h-[20px] rounded flex items-center justify-center transition-colors ${
        active
          ? "bg-bg-card text-text-1"
          : "hover:bg-state-hover hover:text-text-1"
      }${className ? ` ${className}` : ""}`}
      {...rest}
    >
      {children}
    </button>
  );
});
