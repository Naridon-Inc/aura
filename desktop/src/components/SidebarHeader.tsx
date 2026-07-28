// Sidebar header — the top zone of the full-height ADE sidebar. One compact
// icon row that owns the window chrome: a macOS traffic-light drag strip (the
// lights sit over this corner now that the sidebar runs to y=0), then the
// account + search cluster hugging the left right beside the traffic lights,
// with the workspace back/forward arrows + settings + the sidebar collapse
// toggle hugging the right against the sidebar/work divider. The whole middle
// is left as empty window-drag region.
//
// The account avatar was re-homed here from the section list below so the top
// of the sidebar reads as a single quiet chrome strip. The workspace
// back/forward arrows are the app-wide project visit-history control (grouped
// with settings at the right end, beside the gear) — distinct from the
// Pages-scoped arrows inside the Pages surface. The Agents & extensions entry
// stays in Settings + the command palette; the account popover carries
// "Account settings".

import { type ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Tooltip, TooltipTrigger, TooltipContent } from "./ui/tooltip";
import { ChromeBtn } from "./TopBar";
import { windowControlsInset } from "./topbar/windowControls";

// The strip's controls ARE the TopBar's chrome buttons — the two strips sit on
// the same baseline either side of the sidebar divider, so they have to be the
// same control. This header used to hand-roll a 22px near-copy whose own
// comment claimed it "mirrors the TopBar's ChromeBtn sizing"; it was 2px
// bigger, which is exactly the kind of drift a comment can't hold back.
const ICON_BTN = "text-text-3 disabled:opacity-30 disabled:pointer-events-none";

type SidebarHeaderProps = {
  /** True while the window is in macOS fullscreen, where it can neither be
   *  dragged nor zoomed — the strip drops its drag behaviour so a stray click
   *  in the empty middle does nothing instead of firing a no-op native call.
   *  The window-buttons gutter does NOT key off this: see
   *  `topbar/windowControls`. */
  fullscreen: boolean;
  /** Workspace visit-history back/forward — the top-level nav control (walks
   *  the projects you've opened), restored to the leftmost of the strip. This
   *  is the app-wide history, distinct from the Pages-scoped arrows inside the
   *  Pages surface. */
  onBack?: () => void;
  onForward?: () => void;
  canBack?: boolean;
  canForward?: boolean;
  onToggleSidebar?: () => void;
  onOpenPalette?: () => void;
  /** Opens Settings (where Agents & extensions now live). Rendered as a small
   *  gear beside the account avatar. */
  onOpenSettings?: () => void;
  /** Compact account control (the avatar popover) shown at the left of the
   *  strip, where the workspace nav + extensions entry used to sit. */
  account?: ReactNode;
  projectLabel: string;
};

// Same drag path the TopBar uses — a data-attribute plus a JS fallback so
// clicks that bubble through flex containers still move the window. Buttons
// carry `role=button` / are real <button>s so they're skipped here.
function handleDrag(e: React.MouseEvent) {
  if (e.button !== 0) return;
  const target = e.target as HTMLElement;
  if (target.closest("button, input, a, [role=button]")) return;
  if (e.detail === 2) {
    getCurrentWindow().toggleMaximize().catch(() => {});
    return;
  }
  getCurrentWindow().startDragging().catch(() => {});
}

export function SidebarHeader({
  fullscreen,
  onBack,
  onForward,
  canBack,
  canForward,
  onToggleSidebar,
  onOpenPalette,
  onOpenSettings,
  account,
  projectLabel,
}: SidebarHeaderProps) {
  return (
    // Single strip, no container — the controls are pushed to the two ENDS
    // with the whole middle left as empty window-drag region (`justify-between`).
    // The sidebar is the leftmost column, so this strip owns the window-buttons
    // gutter; nothing in it may render left of that.
    <div
      data-tauri-drag-region={fullscreen ? undefined : true}
      onMouseDown={fullscreen ? undefined : handleDrag}
      className="flex items-center justify-between gap-3 pr-1.5 flex-shrink-0 select-none"
      style={{
        height: "var(--topbar-h)",
        paddingLeft: windowControlsInset(true),
      }}
    >
      {/* Left end: the compact profile chip then search, hugging the traffic
          lights (⌘K). The workspace back/forward arrows moved to the right
          cluster beside the gear, so profile + search sit tight to the
          traffic lights with no leading nav in between. */}
      <div className="flex items-center gap-0.5 flex-shrink-0">
        {account}
        <Tooltip>
          <TooltipTrigger asChild>
            <ChromeBtn
              title={`Search ${projectLabel} (⌘K)`}
              tooltip
              className={ICON_BTN}
              onClick={onOpenPalette}
            >
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
                <circle cx="7" cy="7" r="4" stroke="currentColor" strokeWidth="1.4" fill="none" />
                <line x1="10" y1="10" x2="13.5" y2="13.5" stroke="currentColor" strokeWidth="1.4" />
              </svg>
            </ChromeBtn>
          </TooltipTrigger>
          <TooltipContent side="bottom">Search {projectLabel} (⌘K)</TooltipContent>
        </Tooltip>
      </div>
      {/* Middle: intentionally empty window-drag region. A running agent shows
          its "Thinking…" state inline in the chat where the user is looking,
          and the menu-bar HUD / desk-pet carry the global fleet signal — a
          persistent animated label in the window chrome was redundant noise. */}
      {/* Right end (against the sidebar/work divider): workspace back/forward
          (the top-level project visit history) grouped beside settings +
          collapse. */}
      <div className="flex items-center gap-0.5 flex-shrink-0">
        <Tooltip>
          <TooltipTrigger asChild>
            <ChromeBtn title="Back" tooltip className={ICON_BTN} disabled={!canBack} onClick={onBack}>
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
                <path d="M10 3.5L5.5 8l4.5 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </ChromeBtn>
          </TooltipTrigger>
          <TooltipContent side="bottom">Back</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <ChromeBtn title="Forward" tooltip className={ICON_BTN} disabled={!canForward} onClick={onForward}>
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
                <path d="M6 3.5L10.5 8L6 12.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </ChromeBtn>
          </TooltipTrigger>
          <TooltipContent side="bottom">Forward</TooltipContent>
        </Tooltip>
        {onOpenSettings && (
          <Tooltip>
            <TooltipTrigger asChild>
              <ChromeBtn title="Settings" tooltip className={ICON_BTN} onClick={onOpenSettings}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="3" />
                  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
                </svg>
              </ChromeBtn>
            </TooltipTrigger>
            <TooltipContent side="bottom">Settings</TooltipContent>
          </Tooltip>
        )}
        {onToggleSidebar && (
          <Tooltip>
            <TooltipTrigger asChild>
              <ChromeBtn title="Hide sidebar (⌘B)" tooltip className={ICON_BTN} onClick={onToggleSidebar}>
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
                  <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" stroke="currentColor" />
                  <line x1="6" y1="2.5" x2="6" y2="13.5" stroke="currentColor" />
                </svg>
              </ChromeBtn>
            </TooltipTrigger>
            <TooltipContent side="bottom">Hide sidebar (⌘B)</TooltipContent>
          </Tooltip>
        )}
      </div>
    </div>
  );
}

