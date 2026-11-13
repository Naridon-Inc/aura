// The window's chrome vocabulary — the controls that live in the macOS title
// bar strip (`titleBarStyle: "Overlay"` in tauri.conf.json hides the native
// title and lets us paint into it), plus the drag behaviour any strip that
// starts at y=0 has to carry.

import { forwardRef, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { beginWindowDrag } from "../lib/windowDrag";
import { Tooltip, TooltipTrigger, TooltipContent } from "./ui/tooltip";
import { MENU_PANEL, MENU_ROW } from "./ui/menuSurface";
import { api, type ResourceSnapshot } from "../lib/api";
import { requestUpdateCheck } from "../lib/updateToast";
import { useDismiss } from "../lib/useDismiss";
import { formatMegabytes } from "../lib/bytes";
// AURA-1298
import { DiskLowWarning } from "./topbar/DiskLowWarning";
// AURA-1294
// end AURA-1294

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

export function MoreMenu({
  placement = "down",
}: {





  /** "up" anchors the panel above the trigger — for the bottom StatusBar. */
  placement?: "up" | "down";
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useDismiss(open, () => setOpen(false), wrapRef);

  const items: Array<{
    label: string;
    hint: string;
    handler?: () => void;
  }> = [
    {
      label: "Check for Updates",
      hint: "Look for a newer Aura release",
      // The answer shows in the update toast, bottom right — the one update
      // surface — so the menu can close.
      handler: requestUpdateCheck,
    },
  ];

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
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              onClick={() => {
                setOpen(false);
                it.handler?.();
              }}
              disabled={!it.handler}
              className={`${MENU_ROW} flex-col !items-start gap-0.5`}
            >
              <span className="font-medium">{it.label}</span>
              <span className="text-xs text-text-4 leading-tight">
                {it.hint}
              </span>
            </button>
          ))}
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
          {/* AURA-1298 — only renders when the workspace's volume is nearly full. */}
          <DiskLowWarning snap={snap} />
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
