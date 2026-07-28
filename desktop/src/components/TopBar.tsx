// Lives directly inside the macOS title bar — `titleBarStyle: "Overlay"`
// in tauri.conf.json hides the native title and lets us paint into that
// strip. The outer element carries `data-tauri-drag-region` AND a JS
// mousedown fallback that calls `getCurrentWindow().startDragging()`
// directly — the data-attribute injector misses some click targets in
// Tauri 2 (e.g. event-bubbled clicks inside flex containers), so we
// always have a working drag path either way. Buttons swallow their
// own click via stopPropagation so they keep working.

import { forwardRef, useEffect, useRef, useState, type ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { StatusPills } from "./topbar/StatusPills";
import { windowControlsInset } from "./topbar/windowControls";
import { Tooltip, TooltipTrigger, TooltipContent } from "./ui/tooltip";
import { Kbd } from "./ui/kbd";
import { MENU_PANEL, MENU_ROW } from "./ui/menuSurface";
import { AccountMenu } from "./account/AccountMenu";
import {
  ProjectSwitcher,
  type ProjectSwitcherWorkspace,
} from "./ProjectSwitcher";
import type { WorktreeRef } from "./WorkspaceRail";
import { api, type ResourceSnapshot } from "../lib/api";
import { CODE_MAP_ENABLED, MEMORY_SURFACE_ENABLED } from "../lib/featureFlags";
import { applyUpdate, checkForUpdate } from "../lib/updater";
import { getVersion } from "@tauri-apps/api/app";
import { useIsFullscreen } from "../lib/useIsFullscreen";

function handleDrag(e: React.MouseEvent) {
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
  getCurrentWindow().startDragging().catch(() => {});
}

type TopBarProps = {
  projectLabel: string;
  reviewOpen: boolean;
  terminalOpen: boolean;
  onOpenPalette?: () => void;
  onToggleReview?: () => void;
  onToggleTerminal?: () => void;
  /** Open the Review Changes pane. */
  onOpenInspector?: () => void;
  /** Open the Audit Trail pane. */
  onOpenReplay?: () => void;
  /** Open the Code Map pane. */
  onOpenGraph?: () => void;
  onOpenMemory?: () => void;
  onOpenDoctor?: () => void;
  /** Mobile remote — pair a phone over LAN to drive this session. */
  onOpenRemote?: () => void;
  /** Slot for the Impact Inbox badge — App.tsx wires the actual
   *  `<ImpactInbox>` so the topbar stays project-agnostic. */
  inboxSlot?: ReactNode;
  /** Active project root — drives the StatusPills row. */
  repoRoot?: string | null;
  onOpenGit?: () => void;
  onOpenSettings?: () => void;
  onFocusChat?: () => void;
  /** Sidebar collapse/expand — restored to the TopBar so the chrome owns
   *  window-level actions in one strip instead of stranding the toggle
   *  in the nav rail. */
  sidebarOpen?: boolean;
  onToggleSidebar?: () => void;
  /** `+` button — opens the Manager launcher for a new objective session. */
  onNewSession?: () => void;
  /** ADE chrome — render a slim header (brand · centered search ·
   *  settings · profile). The status + utility cluster (StatusPills,
   *  resource, inbox, toggles, more-tools) moves to the bottom StatusBar,
   *  composed by App and passed via its `trailing` slot. */
  adeChrome?: boolean;
  /** Avatar initial for the profile button (ADE header only). */
  userInitial?: string;
  /** Profile button — opens Settings → Identity (ADE header only). */
  onOpenProfile?: () => void;
  /** ADE v2 re-homes the profile + settings + help cluster into the left
   *  sidebar (Conductor pattern) so the work-surface header can stop before
   *  the review rail. When set, the header keeps only the pane toggles. */
  hideAccountCluster?: boolean;
  /** ADE breadcrumb switcher — the current project › worktree, opening the
   *  nested project/worktree picker (Image #1 / #2). Only wired for the
   *  full-height ADE shell; omit and the breadcrumb simply doesn't render. */
  activeRoot?: string;
  activeName?: string;
  activeEmoji?: string;
  workspaces?: ProjectSwitcherWorkspace[];
  worktreesByRoot?: Record<string, WorktreeRef[]>;
  onSwitchProject?: (root: string) => void;
  onOpenWorktree?: (path: string) => void;
  onAddWorkspace?: () => void;
};

export function TopBar({
  projectLabel,
  reviewOpen,
  terminalOpen,
  onOpenPalette,
  onToggleReview,
  onToggleTerminal,
  onOpenInspector,
  onOpenReplay,
  onOpenGraph,
  onOpenMemory,
  onOpenDoctor,
  onOpenRemote,
  inboxSlot,
  repoRoot,
  onOpenGit,
  onOpenSettings,
  onFocusChat,
  sidebarOpen,
  onToggleSidebar,
  onNewSession,
  adeChrome,
  userInitial,
  onOpenProfile,
  hideAccountCluster,
  activeRoot,
  activeName,
  activeEmoji,
  workspaces,
  worktreesByRoot,
  onSwitchProject,
  onOpenWorktree,
  onAddWorkspace,
}: TopBarProps) {
  // ADE chrome — identity + search + account + layout chrome. The header
  // owns the window-level pane toggles (sidebar / terminal / review) so
  // all "show/hide a pane" controls live in one strip and bracket the
  // window symmetrically; the bottom StatusBar keeps status + system
  // indicators (status pills, resource, inbox, more-tools).
  const fullscreen = useIsFullscreen();
  if (adeChrome) {
    return (
      <div
        data-tauri-drag-region={fullscreen ? undefined : true}
        onMouseDown={fullscreen ? undefined : handleDrag}
        className="relative flex items-center w-full h-full pr-2 gap-1.5 text-text-3"
      >
        {/* Left — the window-buttons gutter (no workspace rail in ADE), then
            the sidebar toggle FIRST so it sits right beside the macOS lights
            on the same baseline (they read as one control row), then
            new-session, then a compact brand mark. The gutter is reserved only
            when the sidebar is COLLAPSED: open, the sidebar is the leftmost
            column and its own header owns the corner, so this strip starts
            right of the lights and takes a plain edge pad. Same helper the
            sidebar header uses — one number, one rule. */}
        <div
          data-tauri-drag-region={fullscreen ? undefined : true}
          className="flex items-center gap-1"
          style={{ paddingLeft: windowControlsInset(!sidebarOpen) }}
        >
          {/* The full-height sidebar owns the project switcher, search,
              extensions and window nav now. All that remains here is a
              show-sidebar affordance for when the sidebar is collapsed —
              in that state its traffic lights fall onto this header, so the
              inset is reserved only then (open ⇒ lights live over the
              sidebar and this is a plain drag region). */}
          {!sidebarOpen && onToggleSidebar && (
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
          )}
          {/* The location breadcrumb — current project › worktree — opening
              the nested project/worktree picker. Sits top-left of the work
              surface (Conductor/Superset pattern), not in the sidebar. */}
          {workspaces && activeRoot && activeName && (
            <ProjectSwitcher
              activeRoot={activeRoot}
              activeName={activeName}
              activeEmoji={activeEmoji}
              workspaces={workspaces}
              worktreesByRoot={worktreesByRoot}
              onSwitch={onSwitchProject ?? (() => {})}
              onOpenWorktree={onOpenWorktree}
              onAdd={onAddWorkspace ?? (() => {})}
            />
          )}
        </div>

        {/* Right — layout chrome (terminal + review pane toggles) then
            the account cluster (settings + profile). The pane toggles sit
            here, opposite the sidebar toggle on the left, so the three
            "show/hide a pane" controls bracket the window like real window
            chrome instead of being stranded in the footer. */}
        <div className="ml-auto flex items-center gap-1">
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
                title={reviewOpen ? "Hide review rail (⌘R)" : "Show review rail (⌘R)"}
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
              {reviewOpen ? "Hide review rail (⌘R)" : "Show review rail (⌘R)"}
            </TooltipContent>
          </Tooltip>
          {!hideAccountCluster && (
            <>
              <span className="w-px h-4 bg-line-soft mx-0.5" aria-hidden />
              <Tooltip>
                <TooltipTrigger asChild>
                  <ChromeBtn title="Help & support" onClick={openHelpPane} tooltip>
                    <HelpGlyph />
                  </ChromeBtn>
                </TooltipTrigger>
                <TooltipContent side="bottom">Help &amp; support</TooltipContent>
              </Tooltip>
              {onOpenSettings && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <ChromeBtn title="Settings" onClick={onOpenSettings} tooltip>
                      <GearGlyph />
                    </ChromeBtn>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">Settings</TooltipContent>
                </Tooltip>
              )}
              <AccountMenu userInitial={userInitial} onOpenProfile={onOpenProfile} />
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      data-tauri-drag-region
      onMouseDown={handleDrag}
      className="flex items-center w-full h-full px-2 gap-1"
    >
      {/* Workspace rail (64px) handles traffic-light reservation — our
          chrome buttons start at the rail edge with normal padding. The
          sidebar toggle now lives in NavRail (Stage 10A) — moved out of
          the TopBar so the chrome stays focused on window-level actions
          (back/forward/search/review/terminal). */}
      <div data-tauri-drag-region className="flex items-center gap-0.5 text-text-3">
        {onToggleSidebar && (
          <Tooltip>
            <TooltipTrigger asChild>
              <ChromeBtn
                title={sidebarOpen ? "Hide sidebar (⌘B)" : "Show sidebar (⌘B)"}
                active={!sidebarOpen}
                onClick={onToggleSidebar}
                tooltip
              >
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
                  <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" stroke="currentColor" />
                  <line x1="6" y1="2.5" x2="6" y2="13.5" stroke="currentColor" />
                </svg>
              </ChromeBtn>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {sidebarOpen ? "Hide sidebar (⌘B)" : "Show sidebar (⌘B)"}
            </TooltipContent>
          </Tooltip>
        )}
        {onNewSession && (
          <Tooltip>
            <TooltipTrigger asChild>
              <ChromeBtn title="New session (⌘N)" onClick={onNewSession} tooltip>
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
                  <line x1="8" y1="3" x2="8" y2="13" stroke="currentColor" strokeWidth="1.4" />
                  <line x1="3" y1="8" x2="13" y2="8" stroke="currentColor" strokeWidth="1.4" />
                </svg>
              </ChromeBtn>
            </TooltipTrigger>
            <TooltipContent side="bottom">New session (⌘N)</TooltipContent>
          </Tooltip>
        )}
      </div>

      {/* centered ⌘K search */}
      <div
        data-tauri-drag-region
        className="flex-1 flex justify-center"
      >
        <button
          onClick={onOpenPalette}
          className="flex items-center gap-2 bg-bg-1 hover:bg-bg-2 border border-line text-text-3 text-[12px] rounded-md h-[22px] pl-3 pr-1.5 transition-colors"
          style={{ width: 320 }}
        >
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
            <circle cx="7" cy="7" r="4" stroke="currentColor" strokeWidth="1.4" fill="none" />
            <line x1="10" y1="10" x2="13.5" y2="13.5" stroke="currentColor" strokeWidth="1.4" />
          </svg>
          <span className="flex-1 text-left">Search {projectLabel}</span>
          <Kbd>⌘K</Kbd>
        </button>
      </div>

      <div data-tauri-drag-region className="flex items-center gap-1.5 text-text-3">
        <StatusPills
          repoRoot={repoRoot ?? null}
          onOpenGit={onOpenGit}
          onOpenSettings={onOpenSettings}
          onFocusChat={onFocusChat}
        />
        <ResourcePill />
        {inboxSlot}
        {onOpenRemote && (
          <Tooltip>
            <TooltipTrigger asChild>
              <ChromeBtn
                title="Mobile remote — pair a phone over LAN"
                onClick={onOpenRemote}
                tooltip
              >
                {/* Phone glyph (rounded rectangle + speaker slot + home dot).
                    Reads as "phone" at 16×16 better than a wifi/qr icon. */}
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
                  <rect
                    x="4.5"
                    y="1.5"
                    width="7"
                    height="13"
                    rx="1.5"
                    stroke="currentColor"
                  />
                  <line x1="6.5" y1="3" x2="9.5" y2="3" stroke="currentColor" strokeWidth="0.9" />
                  <circle cx="8" cy="12.5" r="0.6" fill="currentColor" />
                </svg>
              </ChromeBtn>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              Mobile remote — pair a phone over LAN
            </TooltipContent>
          </Tooltip>
        )}
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
              title="Toggle review (⌘R)"
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
          <TooltipContent side="bottom">Toggle review (⌘R)</TooltipContent>
        </Tooltip>
        <MoreMenu
          onOpenInspector={onOpenInspector}
          onOpenReplay={onOpenReplay}
          onOpenGraph={onOpenGraph}
          onOpenMemory={onOpenMemory}
          onOpenDoctor={onOpenDoctor}
        />
      </div>
    </div>
  );
}

// Right-side overflow menu. Deeper / less-frequent surfaces live here
// instead of stacking up on the workspace rail. Copy is plain English
// around the question each surface answers, so a non-engineer can pick
// the right tool without reading docs.
export function MoreMenu({
  onOpenInspector,
  onOpenReplay,
  onOpenGraph,
  onOpenMemory,
  onOpenDoctor,
  placement = "down",
}: {
  onOpenInspector?: () => void;
  onOpenReplay?: () => void;
  onOpenGraph?: () => void;
  onOpenMemory?: () => void;
  onOpenDoctor?: () => void;
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

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function onCheckUpdates() {
    setUpdateState({ kind: "checking" });
    try {
      const info = await checkForUpdate(true);
      if (!info) {
        const current = await getVersion().catch(() => "current");
        setUpdateState({ kind: "uptodate", current });
        return;
      }
      const proceed = window.confirm(
        `Aura ${info.version} is available.${info.notes ? `\n\n${info.notes}` : ""}\n\nDownload and install now? The app will restart when done.`,
      );
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
      label: "Review Changes",
      hint: "Check what changed vs what was asked",
      handler: onOpenInspector,
    },
    {
      label: "Proof trail",
      hint: "See proof every change is genuine and untampered",
      handler: onOpenReplay,
    },
    ...(CODE_MAP_ENABLED
      ? [
          {
            label: "Code Map",
            hint: "Find files and pieces connected to a change",
            handler: onOpenGraph,
          },
        ]
      : []),
    ...(MEMORY_SURFACE_ENABLED
      ? [
          {
            label: "Memory",
            hint: "Notes Aura remembers about this project",
            handler: onOpenMemory,
          },
        ]
      : []),
    {
      label: "Doctor",
      hint: "Check repo health and fix common issues",
      handler: onOpenDoctor,
    },
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
          const pct = Math.min(
            100,
            Math.round((updateState.done / updateState.total) * 100),
          );
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
                <span className="text-[11px] text-text-4 leading-tight">
                  {it.hint}
                </span>
              </button>
            );
          })}
          {updateStatusLine && (
            <div
              // A failed update is a real failure, so it keeps red — but on
              // the app's own `--color-red` token, not a raw Tailwind rose.
              className={`mt-1 mx-1 px-2.5 py-1.5 rounded text-[11px] leading-tight border ${
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

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const label = snap ? formatMb(snap.aura_memory_mb) : "—";

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        title="Resource usage"
        onClick={() => setOpen((v) => !v)}
        className={`h-[22px] px-2 rounded flex items-center gap-1.5 text-[11px] font-medium transition-colors ${
          open
            ? "bg-bg-card text-text-1"
            : "text-text-3 hover:bg-bg-hover hover:text-text-1"
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
            <div className="text-[10px] font-semibold tracking-wider uppercase text-text-4">
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
            <div className="text-[10px] font-semibold tracking-wider uppercase text-text-4">
              Aura processes
            </div>
          </div>
          <div className="max-h-[260px] overflow-y-auto px-1.5 pb-2">
            {snap && snap.processes.length > 0 ? (
              snap.processes.map((p) => (
                <div
                  key={p.pid}
                  className="flex items-center gap-2 px-1.5 py-1 rounded hover:bg-bg-2"
                >
                  <span className="text-[12px] text-text-1 flex-1 truncate font-medium">
                    {p.name}
                  </span>
                  <span className="text-[11px] text-text-4 tabular-nums w-12 text-right">
                    {p.cpu_percent.toFixed(1)}%
                  </span>
                  <span className="text-[11px] text-text-3 tabular-nums w-14 text-right">
                    {p.memory_mb} MB
                  </span>
                </div>
              ))
            ) : (
              <div className="px-2 py-3 text-[11px] text-text-4">
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
      <span className="text-[10px] font-semibold tracking-wider uppercase text-text-4">
        {label}
      </span>
      <span className="text-[12px] text-text-1 tabular-nums">{value}</span>
    </div>
  );
}

function formatMb(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  return `${mb} MB`;
}

// Gear glyph for the ADE header settings button (mirrors the one that
// used to live in the AdeSidebar head before the chrome consolidation).
function GearGlyph() {
  // 1.9 is the app's gear weight (sidebar header + roster menu both use it);
  // this one was drawn a hair heavier and read bolder beside them.
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
    </svg>
  );
}

function HelpGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="9" />
      <path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 2.5-3 4" strokeLinecap="round" />
      <circle cx="12" cy="17" r="0.6" fill="currentColor" stroke="none" />
    </svg>
  );
}

// Opens Settings deep-linked to the Help & Support pane. Self-contained —
// dispatches the same `aura:open-settings` CustomEvent SettingsDialog
// listens for, so no extra prop threading through the TopBar tree.
function openHelpPane() {
  window.dispatchEvent(
    new CustomEvent("aura:open-settings", { detail: { pane: "help" } }),
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
          : "hover:bg-bg-hover hover:text-text-1"
      }${className ? ` ${className}` : ""}`}
      {...rest}
    >
      {children}
    </button>
  );
});
