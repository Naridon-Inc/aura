// Sidebar header — the top zone of the full-height ADE sidebar. One compact
// icon row that owns the window chrome which used to live in the TopBar's
// left + center: a macOS traffic-light drag strip (the lights sit over this
// corner now that the sidebar runs to y=0), then the whole control cluster
// as equal-weight icons — workspace back / forward, the sidebar collapse
// toggle, search (⌘K), and the agents/extensions entry point.
// Search + extensions used to own a second full-width row (a text search
// box); folding them into icons alongside collapse reclaims that row and
// reads as one native toolbar strip. The project switcher itself rides the
// work-surface header as a breadcrumb (Image #1 / #2) — the roster below IS
// the browsable list, so a second switcher block here would just duplicate it.

import { forwardRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Tooltip, TooltipTrigger, TooltipContent } from "./ui/tooltip";

type SidebarHeaderProps = {
  /** No traffic lights in fullscreen — collapse the left inset when true. */
  fullscreen: boolean;
  onBack?: () => void;
  onForward?: () => void;
  canBack?: boolean;
  canForward?: boolean;
  onToggleSidebar?: () => void;
  onOpenPalette?: () => void;
  onOpenExtensions?: () => void;
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
  onOpenExtensions,
  projectLabel,
}: SidebarHeaderProps) {
  return (
    // Single icon row — traffic-light drag strip on the left, then the whole
    // control cluster right-aligned as equal 22px icons. A hairline splits
    // navigation/pane-toggle from the search + extensions tools so the strip
    // reads in two calm groups instead of one long run.
    <div
      data-tauri-drag-region
      onMouseDown={handleDrag}
      className="flex items-center gap-0.5 pr-1.5 flex-shrink-0 select-none"
      style={{ height: "var(--topbar-h)", paddingLeft: fullscreen ? 8 : 74 }}
    >
      <div className="flex-1" data-tauri-drag-region />
      <Tooltip>
        <TooltipTrigger asChild>
          <IconBtn title="Back" disabled={!canBack} onClick={onBack}>
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
              <path d="M10 3.5L5.5 8l4.5 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </IconBtn>
        </TooltipTrigger>
        <TooltipContent side="bottom">Back</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <IconBtn title="Forward" disabled={!canForward} onClick={onForward}>
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
              <path d="M6 3.5L10.5 8L6 12.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </IconBtn>
        </TooltipTrigger>
        <TooltipContent side="bottom">Forward</TooltipContent>
      </Tooltip>
      {onToggleSidebar && (
        <Tooltip>
          <TooltipTrigger asChild>
            <IconBtn title="Hide sidebar (⌘B)" onClick={onToggleSidebar}>
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
                <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" stroke="currentColor" />
                <line x1="6" y1="2.5" x2="6" y2="13.5" stroke="currentColor" />
              </svg>
            </IconBtn>
          </TooltipTrigger>
          <TooltipContent side="bottom">Hide sidebar (⌘B)</TooltipContent>
        </Tooltip>
      )}
      <span className="w-px h-3.5 mx-0.5 bg-line-soft flex-shrink-0" aria-hidden />
      <Tooltip>
        <TooltipTrigger asChild>
          <IconBtn title={`Search ${projectLabel} (⌘K)`} onClick={onOpenPalette}>
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
              <circle cx="7" cy="7" r="4" stroke="currentColor" strokeWidth="1.4" fill="none" />
              <line x1="10" y1="10" x2="13.5" y2="13.5" stroke="currentColor" strokeWidth="1.4" />
            </svg>
          </IconBtn>
        </TooltipTrigger>
        <TooltipContent side="bottom">Search {projectLabel} (⌘K)</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <IconBtn
            title="Agents & extensions — your agents, skills, instructions, memory, connections, plugins and editor extensions, all in one place"
            onClick={onOpenExtensions}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M19.4 13.6a2 2 0 1 0-3.4-1.4V9.5a1 1 0 0 0-1-1h-2.7a2 2 0 1 0-3.8 0H5.8a1 1 0 0 0-1 1v2.6a2 2 0 1 0 0 3.9v2.6a1 1 0 0 0 1 1h2.7a2 2 0 1 1 3.8 0H16a1 1 0 0 0 1-1v-2.7a2 2 0 0 0 2.4-1.8Z" />
            </svg>
          </IconBtn>
        </TooltipTrigger>
        <TooltipContent side="bottom">Agents &amp; extensions</TooltipContent>
      </Tooltip>
    </div>
  );
}

// Compact 22px chrome button — mirrors the TopBar's ChromeBtn sizing so
// the sidebar's nav cluster reads as the same control language.
const IconBtn = forwardRef<
  HTMLButtonElement,
  {
    children: React.ReactNode;
    title: string;
    disabled?: boolean;
    onClick?: () => void;
  } & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "title">
>(function IconBtn({ children, title, disabled, onClick, className, ...rest }, ref) {
  return (
    <button
      ref={ref}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className={`w-[22px] h-[22px] rounded flex items-center justify-center text-text-3 transition-colors disabled:opacity-30 disabled:pointer-events-none hover:bg-bg-hover hover:text-text-1${
        className ? ` ${className}` : ""
      }`}
      {...rest}
    >
      {children}
    </button>
  );
});
