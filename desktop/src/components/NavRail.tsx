// Secondary rail — 52px wide. Sits between the workspace_rail (primary)
// and the sidebar body. Six sidebar tabs only — selecting one swaps the
// sidebar body. The main work surface is always editor-or-hero; pane
// detail views open in the body when a sidebar item is clicked.
//
// Why so few tabs: every icon here is a *daily* nav target. One-shot
// surfaces (Doctor, Proof, Memory, raw status output) live behind the
// command palette / slash commands — they don't need first-class real
// estate. Conflict folds into Impacts (severity = conflict). Semantic
// is a toggle inside Search. Git status overlays Files.

import * as Icons from "./Icons";
import { Tooltip, TooltipTrigger, TooltipContent } from "./ui/tooltip";
import { sanitizeSvgGlyph } from "../lib/sanitizeSvg";

export type SidebarTabId =
  | "files"
  | "git"
  | "prs"
  | "tasks"
  | "pages"
  | "history";

type Badge =
  | { kind: "none" }
  | { kind: "dot"; color: string }
  | { kind: "count"; n: number };

const NONE: Badge = { kind: "none" };
const TILE = 36;

/** Stage 8N — NavRail context. The rail flips between two distinct
 *  navigation surfaces driven by the active workpane:
 *
 *   • "code" — file/agent/terminal/manager work. Shows file-system
 *     centric tabs (Files, Git, Plan, Impacts, History, Search,
 *     Agents, Zones, Team).
 *   • "pr"   — PR triage + review work. Shows Inbox + Reviews +
 *     Impacts (kept across surfaces because cross-branch impacts are
 *     PR-relevant too).
 *
 *  Caller (App.tsx) computes which surface is active from store
 *  state — currently `activeInbox || activePrTabId` ⇒ "pr". */
export type NavRailSurface = "code" | "pr";

/** One plugin-contributed tile that hangs off the bottom half of the
 *  vertical rail. `glyph` is whatever a plugin manifest declared in
 *  `icon` — for v1 we only handle three formats: a single emoji
 *  (rendered as text), a `<svg …>` literal (rendered inline), or a
 *  letter fallback (first character of the label). Anything richer
 *  needs the bridge to render via iframe (deferred to a later wave). */
export type PluginRailTile = {
  pluginId: string;
  tileId: string;
  label: string;
  /** Raw glyph string from the manifest, or undefined for fallback. */
  glyph?: string;
  active?: boolean;
};

type NavRailProps = {
  activeTab: SidebarTabId;
  onSelectTab: (id: SidebarTabId) => void;
  badges?: Partial<Record<SidebarTabId, Badge>>;
  surface?: NavRailSurface;
  /** Stage 8N — bottom toggle. From code surface, click jumps into
   *  PR mode (opens the Inbox). From PR surface, click pops back to
   *  the last code surface (focuses a file tab or dashboard). */
  onToggleSurface?: () => void;
  /** Stage 10A — sidebar collapse toggle moved here from the TopBar.
   *  Sits at the very top of the rail. When sidebarOpen is false the
   *  tile is "active" (highlighted) so the user knows the button is
   *  the way back. */
  sidebarOpen?: boolean;
  onToggleSidebar?: () => void;
  /** W1.4 — plugin rail tiles. Render below the static four with a
   *  hairline separator. */
  pluginTiles?: PluginRailTile[];
  onSelectPluginTile?: (tile: PluginRailTile) => void;
};

// Chat-first sweep: rail collapsed to four daily-nav targets.
// Plan / Search / Agents / Zones / Team / Inbox / Impacts / Reviews all
// fold into the right-rail chat or TopBar status pills.
export const RAIL_TILES: SidebarTabId[] = [
  "files",
  "git",
  "prs",
  "tasks",
  "pages",
  "history",
];

export function NavRail({
  activeTab,
  onSelectTab,
  badges = {},
  surface = "code",
  onToggleSurface,
  sidebarOpen = true,
  onToggleSidebar,
  pluginTiles = [],
  onSelectPluginTile,
}: NavRailProps) {
  const b = (k: SidebarTabId): Badge => badges[k] ?? NONE;

  const allTiles: Record<
    SidebarTabId,
    { icon: React.ReactNode; label: string }
  > = {
    files:   { icon: <NavFolderGlyph size={18} />,    label: "Files" },
    git:     { icon: <Icons.GitBranch size={18} />,   label: "Source Control" },
    prs:     { icon: <Icons.PullRequest size={18} />, label: "Pull Requests" },
    tasks:   { icon: <Icons.Tasks size={18} />,       label: "Tasks" },
    pages:   { icon: <PagesGlyph size={18} />,        label: "Pages" },
    history: { icon: <Icons.Timeline size={18} />,    label: "History" },
  };

  const tileOrder = RAIL_TILES;

  return (
    // Width comes from `--nav-rail-w`, the same token Layout sizes the rail's
    // column with. A hardcoded 52 here ran 4px wider than its own 48px column,
    // so every tile sat a couple of pixels off the column's centre line.
    <div
      className="flex flex-col items-center h-full pt-3 pb-2"
      style={{ width: "var(--nav-rail-w)", gap: 4 }}
    >
      {tileOrder.map((id) => (
        <PaneTile
          key={id}
          icon={allTiles[id].icon}
          label={allTiles[id].label}
          active={sidebarOpen && activeTab === id}
          badge={b(id)}
          onClick={() => {
            // VSCode-style toggle parity:
            // - Sidebar collapsed → expand + activate this tab.
            // - Sidebar open + this tab already active → collapse.
            // - Sidebar open + a different tab active → switch tab.
            if (!sidebarOpen) {
              onSelectTab(id);
              onToggleSidebar?.();
              return;
            }
            if (activeTab === id) {
              onToggleSidebar?.();
              return;
            }
            onSelectTab(id);
          }}
        />
      ))}

      {pluginTiles.length > 0 && (
        <>
          {/* hairline separator between static + plugin tiles. */}
          <div
            className="w-6 border-t border-line-soft my-1"
            aria-hidden
          />
          {pluginTiles.map((t) => (
            <PaneTile
              key={`${t.pluginId}/${t.tileId}`}
              icon={<PluginGlyph glyph={t.glyph} label={t.label} />}
              label={`${t.label} · ${t.pluginId}`}
              active={Boolean(t.active)}
              badge={NONE}
              onClick={() => onSelectPluginTile?.(t)}
            />
          ))}
        </>
      )}

      <div className="flex-1" />

      {onToggleSurface && surface === "pr" && (
        <PaneTile
          icon={<NavFolderGlyph size={18} />}
          label="Back to Code"
          active={false}
          badge={NONE}
          onClick={onToggleSurface}
        />
      )}
      {onToggleSidebar && (
        // PanelLeftClose / PanelLeftOpen — matches VSCode's mental model
        // (panel rectangle with the left column highlighted + an arrow
        // showing the direction the panel will move on click). Smaller
        // tile than the main nav so it still reads as chrome.
        <CollapseSidebarBtn
          collapsed={!sidebarOpen}
          onClick={onToggleSidebar}
        />
      )}
    </div>
  );
}

function CollapseSidebarBtn({
  collapsed,
  onClick,
}: {
  collapsed: boolean;
  onClick: () => void;
}) {
  const label = collapsed ? "Show sidebar (⌘B)" : "Hide sidebar (⌘B)";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          onClick={onClick}
          className="flex items-center justify-center text-text-4 hover:text-text-1 hover:bg-bg-2 transition-colors"
          style={{ width: 28, height: 28, borderRadius: 6 }}
        >
          <PanelLeftGlyph open={!collapsed} />
        </button>
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

// PanelLeft glyph — outer rounded rectangle, a filled column on the
// left mimicking the sidebar, and a small chevron inside the right
// region showing the toggle direction. Collapse = chevron points left
// (panel closes that way); expand = chevron points right.
function PanelLeftGlyph({ open }: { open: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <rect
        x="1.5"
        y="2.5"
        width="13"
        height="11"
        rx="1.5"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <rect x="2.25" y="3.25" width="3" height="9.5" rx="0.5" fill="currentColor" opacity="0.45" />
      <line x1="5.5" y1="2.5" x2="5.5" y2="13.5" stroke="currentColor" strokeWidth="1.2" />
      {open ? (
        <path d="M11 6L9 8l2 2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
      ) : (
        <path d="M9 6l2 2-2 2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
      )}
    </svg>
  );
}

function PaneTile({
  icon,
  label,
  active,
  badge,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  badge: Badge;
  onClick: () => void;
}) {
  return (
    <div className="relative">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={label}
            onClick={onClick}
            className={`flex items-center justify-center transition-colors ${
              active
                ? "bg-bg-2 text-text-1 border border-line"
                : "text-text-3 hover:bg-bg-2 hover:text-text-1 border border-transparent"
            }`}
            style={{ width: TILE, height: TILE, borderRadius: 8 }}
          >
            {icon}
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">{label}</TooltipContent>
      </Tooltip>
      <BadgeDot badge={badge} />
    </div>
  );
}

/** Render a plugin's icon string for the rail. v1 supports: a single
 *  emoji (text node, picks up font/scaling), a raw SVG markup
 *  (`<svg …>` literal — dangerouslySetInnerHTML so plugins can ship
 *  their own glyph), or fall back to the first letter of the label.
 *  Anything more complex (image url, lottie, animated) lives behind an
 *  iframe-rendered tile in a later wave. */
function PluginGlyph({
  glyph,
  label,
}: {
  glyph?: string;
  label: string;
}) {
  if (!glyph) {
    return (
      <span className="text-[11px] font-semibold uppercase tracking-tight">
        {label.charAt(0)}
      </span>
    );
  }
  const trimmed = glyph.trim();
  if (trimmed.startsWith("<svg")) {
    // SVG glyph — sanitize hard before injecting. Plugin markup rides the
    // Commons exchange and the unsigned-dev path, so it is untrusted:
    // `sanitizeSvgGlyph` parses it and keeps only a presentational element
    // allowlist, dropping every event handler (`onload`…), `<foreignObject>`,
    // and `javascript:` reference. Empty result → fall through to the label
    // initial rather than inject nothing.
    const safe = sanitizeSvgGlyph(trimmed);
    if (safe) {
      return (
        <span
          className="flex items-center justify-center"
          style={{ width: 18, height: 18 }}
          dangerouslySetInnerHTML={{ __html: safe }}
        />
      );
    }
    return (
      <span className="text-[11px] font-semibold uppercase tracking-tight">
        {label.charAt(0)}
      </span>
    );
  }
  // Treat anything else as text (emoji, single char).
  return (
    <span className="text-[16px] leading-none" aria-hidden>
      {trimmed}
    </span>
  );
}

function BadgeDot({ badge }: { badge: Badge }) {
  if (badge.kind === "none") return null;
  if (badge.kind === "dot") {
    return (
      <span
        className="absolute pointer-events-none"
        style={{
          top: 4,
          right: 4,
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: badge.color,
          boxShadow: "0 0 0 2px var(--color-bg-1)",
        }}
      />
    );
  }
  const display = badge.n > 99 ? "99+" : String(badge.n);
  return (
    <span
      className="absolute pointer-events-none flex items-center justify-center"
      style={{
        top: 2,
        right: 2,
        minWidth: 14,
        height: 14,
        padding: "0 4px",
        borderRadius: 7,
        // A count of things waiting on you, not a failure — amber, the
        // pack's attention slot, same as every other count pill in the
        // chrome (AdeSidebar's SEG_BADGE_INK, `.ade-row .unread`). The
        // accent stays reserved for the active-tab marker beside it, so
        // "where I am" and "what wants me" never wear the same paint.
        background: "var(--color-amber)",
        color: "var(--color-bg-0)",
        fontSize: 9,
        fontWeight: 600,
        lineHeight: "14px",
        boxShadow: "0 0 0 2px var(--color-bg-1)",
      }}
    >
      {display}
    </span>
  );
}

// Horizontal sidebar nav strip — a slim row of tab buttons that lives
// at the very top of the sidebar (above ProjectHeader). Replaces the
// 52px vertical NavRail column. Same four tile ids; same badge model.
type NavTabsProps = {
  activeTab: SidebarTabId;
  onSelectTab: (id: SidebarTabId) => void;
  badges?: Partial<Record<SidebarTabId, Badge>>;
  sidebarOpen?: boolean;
  onToggleSidebar?: () => void;
};

export function NavTabs({
  activeTab,
  onSelectTab,
  badges = {},
  sidebarOpen = true,
  onToggleSidebar,
}: NavTabsProps) {
  const b = (k: SidebarTabId): Badge => badges[k] ?? NONE;
  const allTiles: Record<
    SidebarTabId,
    { icon: React.ReactNode; label: string }
  > = {
    files:   { icon: <NavFolderGlyph size={15} />, label: "Files" },
    git:     { icon: <Icons.GitBranch size={15} />, label: "Source Control" },
    prs:     { icon: <Icons.PullRequest size={15} />, label: "Pull Requests" },
    tasks:   { icon: <Icons.Tasks size={15} />,    label: "Tasks" },
    pages:   { icon: <PagesGlyph size={15} />,     label: "Pages" },
    history: { icon: <Icons.Timeline size={15} />, label: "History" },
  };
  return (
    <div
      className="flex items-center h-9 px-2 gap-0.5 border-b border-line-soft flex-shrink-0"
      style={{ background: "var(--color-bg-1)" }}
    >
      {RAIL_TILES.map((id) => {
        const active = sidebarOpen && activeTab === id;
        const badge = b(id);
        return (
          // Same styled tooltip the vertical rail's tiles use. These buttons
          // were on a native `title=` — a different delay, a different look
          // and an OS-drawn box, for the very same control.
          <Tooltip key={id}>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => {
                  if (!sidebarOpen) {
                    onSelectTab(id);
                    onToggleSidebar?.();
                    return;
                  }
                  if (activeTab === id) {
                    onToggleSidebar?.();
                    return;
                  }
                  onSelectTab(id);
                }}
                aria-label={allTiles[id].label}
                className={`relative flex items-center justify-center w-7 h-7 rounded transition-colors ${
                  active
                    ? "bg-bg-2 text-text-1"
                    : "text-text-3 hover:text-text-1 hover:bg-bg-2"
                }`}
              >
                {allTiles[id].icon}
                <BadgeDot badge={badge} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{allTiles[id].label}</TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}

// Stacked-document silhouette for the Pages rail tile. Matches the
// flat-outline style of NavFolderGlyph so the two custom tiles read as
// part of the same icon set rather than borrowed from elsewhere.
function PagesGlyph({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M5.5 2.5h4l3 3v6.5a1 1 0 0 1-1 1H5.5a1 1 0 0 1-1-1v-8.5a1 1 0 0 1 1-1z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <path
        d="M9.5 2.5v3h3"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <path
        d="M3.5 4.5v8.5a1 1 0 0 0 1 1H11"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
        opacity="0.55"
      />
    </svg>
  );
}

// Flat outline folder — matches FileTree's FolderGlyph so the rail tile
// and the tree rows look like the same design system instead of two
// different folder icons fighting each other.
function NavFolderGlyph({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M2 4.5v8a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V5.5a1 1 0 0 0-1-1H7L5.5 3H3a1 1 0 0 0-1 1.5z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}
