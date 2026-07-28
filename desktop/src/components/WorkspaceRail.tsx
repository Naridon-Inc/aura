// Primary rail — outermost 64px column. Hosts the workspace switcher,
// an "add workspace" plus, and a minimal bottom cluster (Manager +
// Settings). Everything advanced (Inspector, Replay, Memory, Doctor)
// lives behind the TopBar "More" menu so the rail stays calm.

import { useEffect, useRef, useState } from "react";
import * as Icons from "./Icons";
import { RepoAvatar } from "./RepoAvatar";
import { WorkspaceProgressPopover } from "./WorkspaceProgressPopover";
import { WorkspaceFleetPips } from "./WorkspaceFleetPips";
import { ClipsTray } from "./clips/ClipsTray";
import { AsciiSpinner } from "./ui/ascii-spinner";
import {
  MENU_LABEL,
  MENU_PANEL,
  MENU_ROW,
  MENU_SEP,
} from "./ui/menuSurface";
import { useEditorStore } from "../lib/editorStore";
import {
  EMOJI_PRESETS,
  accentForEmoji,
  setWorkspaceEmoji,
} from "../lib/workspaceCustomization";
import {
  dismissInFlight,
  useInFlight,
  type InFlightEntry,
} from "../lib/workspaceInFlightStore";

export type WorktreeRef = {
  path: string;
  branch: string;
  head: string;
  is_main: boolean;
  locked: boolean;
  /** Unix seconds of the HEAD commit's committer date (from
   *  `git_worktree_list`). Powers the Workspaces view's recency grouping.
   *  Absent/null when the branch tip can't be resolved. */
  head_committed_at?: number | null;
};

export type Workspace = {
  id: string;
  letter: string;     // single char shown on tile when no emoji
  /** Optional emoji glyph. When set, renders in place of the letter so
   *  the rail reads like Slack's workspace switcher. New workspaces
   *  prompt for one on creation; older ones keep the letter. */
  emoji?: string;
  active: boolean;
  accent?: string;    // ignored — kept for back-compat with App.tsx call site
  worktrees?: WorktreeRef[]; // sibling worktrees on this repo's git dir
  /** Agents in this workspace currently waiting for the user. */
  unread?: number;
};

// Every project tile shares one neutral tint. The rail used to hash the
// workspace root into one of eight hues; with more than a handful of projects
// that read as a paint chart, and it gave colour a meaning it never carried —
// a tile's identity is its avatar/letter, and the only tile that needs
// emphasis is the one you're in. Colour comes back on a tile only when the
// user picks an emoji for it (accentForEmoji) — i.e. when they asked for it.
//
// Still a function of the root because `Workspace.accent` is filled in
// per-root by the app shell, and the emoji override is resolved beside it.
export function accentForRoot(_root: string): string {
  return "var(--color-text-3)";
}

type WorkspaceRailProps = {
  workspaces: Workspace[];
  userInitial: string;
  onSelect?: (id: string) => void;
  onAddWorkspace?: () => void;
  onOpenSettings?: () => void;
  onOpenManager?: () => void;
  /** Open a sibling git worktree (or create one). Receives the
   *  worktree path. Same code path as switching workspaces. */
  onOpenWorktree?: (path: string) => void;
  /** Drop a workspace from the recents list. Called from the right-click
   *  menu's "Close workspace" item. */
  onCloseWorkspace?: (id: string) => void;
  /** Cmd+1..Cmd+9 → select the nth workspace. Implemented at the rail
   *  level so the global shortcut layer stays simple. */
  onSelectByIndex?: (index: number) => void;
  /** Club presence. When `members.length >= 2` the rail renders a
   *  special clubbed tile (knot glyph + member-accent ring). Selecting
   *  it enters the unioned view. Drag-tab-onto-tile gestures call
   *  `onDropTabOnWorkspace`. */
  club?: ClubProps;
  /** Drag-and-drop landing for tab → workspace tile. The caller looks
   *  at the source tab's repoRoot, the dst workspace id, and decides
   *  whether to add to the club (different repos) or no-op (same
   *  repo). */
  onDropTabOnWorkspace?: (srcRoot: string, dstRoot: string) => void;
};

export type ClubProps = {
  members: string[];
  active: boolean;
  /** Activate the clubbed view. Caller wires this through to the
   *  workspace switch so the rail's "active" highlight lands here. */
  onActivate: () => void;
  /** Drop a single member out of the club. UI calls this from the
   *  clubbed tile's context menu. */
  onLeaveMember: (root: string) => void;
  /** Wipe the entire club. No undo. */
  onDissolve: () => void;
};

// Compactness pass: rail trimmed 64→56px and the workspace tile
// shrunk 36→32px so the project icons read as switcher chips, not
// big monogram buttons. Font drops a notch in step.
const TILE = 32;
const RAIL_W = 56;

export function WorkspaceRail({
  workspaces,
  userInitial,
  onSelect,
  onAddWorkspace,
  onOpenSettings,
  onOpenWorktree,
  onCloseWorkspace,
  onSelectByIndex,
  club,
  onDropTabOnWorkspace,
}: WorkspaceRailProps) {
  // ⌘1..⌘9 → switch workspace by index. Skip when focus is in a text
  // field so the user can still type digits naturally.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const meta = e.metaKey || e.ctrlKey;
      if (!meta || e.altKey || e.shiftKey) return;
      const code = e.code;
      if (!code.startsWith("Digit")) return;
      const n = parseInt(code.slice(5), 10);
      if (!Number.isFinite(n) || n < 1 || n > 9) return;
      const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase();
      if (
        tag === "input" ||
        tag === "textarea" ||
        (e.target as HTMLElement | null)?.isContentEditable
      ) {
        return;
      }
      const idx = n - 1;
      if (idx >= workspaces.length) return;
      e.preventDefault();
      if (onSelectByIndex) onSelectByIndex(idx);
      else onSelect?.(workspaces[idx]!.id);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [workspaces, onSelect, onSelectByIndex]);

  // Parity W8 — optimistic launch tiles. Live entries from the in-flight
  // store render below the real workspace tiles while `workspace_launch`
  // provisions the worktree + agent fleet.
  const inFlight = useInFlight();

  return (
    <div
      className="flex flex-col items-center h-full pt-2.5 pb-2.5 gap-1.5"
      style={{ width: RAIL_W }}
    >
      {workspaces.map((w, idx) => (
        <WorkspaceTile
          key={w.id}
          workspace={w}
          shortcut={idx < 9 ? idx + 1 : null}
          onClick={() => onSelect?.(w.id)}
          onOpenWorktree={onOpenWorktree}
          onCloseWorkspace={onCloseWorkspace}
          onDropTab={onDropTabOnWorkspace}
        />
      ))}

      {club && club.members.length >= 2 && <ClubTile club={club} />}

      {inFlight.map((entry) => (
        <InFlightTile
          key={entry.key}
          entry={entry}
          onOpenWorktree={onOpenWorktree}
        />
      ))}

      <button
        type="button"
        onClick={onAddWorkspace}
        title="Add workspace"
        className="flex items-center justify-center text-text-3 hover:text-text-1 hover:bg-bg-2 rounded-lg transition-colors"
        style={{ width: TILE, height: TILE }}
      >
        <Icons.Plus size={14} />
      </button>

      <div className="flex-1" />

      <ClipsTray />

      <button
        type="button"
        onClick={onOpenSettings}
        title="Settings"
        className="flex items-center justify-center text-text-3 hover:text-text-1 hover:bg-bg-2 rounded-lg transition-colors"
        style={{ width: TILE, height: TILE }}
      >
        <Icons.Settings size={16} />
      </button>

      <UserAvatar initial={userInitial} />
    </div>
  );
}

function WorkspaceTile({
  workspace,
  shortcut,
  onClick,
  onOpenWorktree,
  onCloseWorkspace,
  onDropTab,
}: {
  workspace: Workspace;
  shortcut: number | null;
  onClick: () => void;
  onOpenWorktree?: (path: string) => void;
  onCloseWorkspace?: (id: string) => void;
  onDropTab?: (srcRoot: string, dstRoot: string) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [hoverOpen, setHoverOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const enterTimer = useRef<number | null>(null);
  const leaveTimer = useRef<number | null>(null);
  const worktrees = workspace.worktrees ?? [];
  // `aura work` worktrees (`work/<slug>` branch in a sibling
  // `<repo>-work-<slug>` dir) are the human's own deliberate parallel
  // sessions, not extra "copies" of the repo — keep them out of the pip
  // + the "N parallel copies" tooltip count (mirrors WorkspaceRoster).
  // They stay in `worktrees` so the right-click switch menu still lists
  // them.
  const isWorkSessionWt = (wt: WorktreeRef) =>
    /^(refs\/heads\/)?work\//.test(wt.branch || "") ||
    /-work-[^/]+$/.test(wt.path);
  const countedWorktrees = worktrees.filter((wt) => !isWorkSessionWt(wt));
  const hasWorktrees = countedWorktrees.length > 1;
  // Fleet indicators — live agent tabs in this workspace, surfaced as
  // tiny brand-colored pips in the bottom-right corner of the tile.
  const editor = useEditorStore();
  const fleet = editor.agentTabs.filter((t) => t.repoRoot === workspace.id);
  const unread = workspace.unread ?? 0;

  // Close worktree menu on outside click or Escape.
  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  useEffect(() => {
    return () => {
      if (enterTimer.current) window.clearTimeout(enterTimer.current);
      if (leaveTimer.current) window.clearTimeout(leaveTimer.current);
    };
  }, []);

  const cancelEnter = () => {
    if (enterTimer.current) {
      window.clearTimeout(enterTimer.current);
      enterTimer.current = null;
    }
  };
  const cancelLeave = () => {
    if (leaveTimer.current) {
      window.clearTimeout(leaveTimer.current);
      leaveTimer.current = null;
    }
  };
  const scheduleOpen = () => {
    cancelLeave();
    if (hoverOpen || menuOpen) return;
    cancelEnter();
    enterTimer.current = window.setTimeout(() => {
      setHoverOpen(true);
      enterTimer.current = null;
    }, 280);
  };
  const scheduleClose = () => {
    cancelEnter();
    cancelLeave();
    leaveTimer.current = window.setTimeout(() => {
      setHoverOpen(false);
      leaveTimer.current = null;
    }, 180);
  };

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    cancelEnter();
    setHoverOpen(false);
    setMenuOpen((v) => !v);
  };

  const shortcutHint = shortcut ? ` (⌘${shortcut})` : "";
  const tileTitle = `${workspace.id}${shortcutHint}${unread ? `\n${unread} waiting for you` : ""}${hasWorktrees ? `\n${countedWorktrees.length} parallel copies — right-click to switch` : "\nright-click for actions"}`;

  // The tile you're in reads as a lifted surface; the rest are quiet tiles
  // with a faint border so they still read as tiles, not floating letters.
  // Neutral by default — a project's identity is its avatar/letter. Colour
  // enters only when the USER picks an emoji for the workspace (🔥 → orange,
  // 🧠 → pink): that hue is a choice they made, not one we hashed for them.
  const accent = accentForEmoji(workspace.emoji) ?? accentForRoot(workspace.id);
  // Tab → workspace drop. The Tabs strip declares
  // `application/x-aura-tab-source-root` carrying the source repo root.
  // We accept the drop only when source root ≠ this tile's root —
  // dropping onto own tile is a no-op (no "club with yourself").
  const TAB_SOURCE_MIME = "application/x-aura-tab-source-root";
  const tileFace = (
    <button
      type="button"
      onClick={onClick}
      onContextMenu={onContextMenu}
      onDragOver={(e) => {
        if (!onDropTab) return;
        if (!Array.from(e.dataTransfer.types).includes(TAB_SOURCE_MIME)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "link";
        if (!dragOver) setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        setDragOver(false);
        if (!onDropTab) return;
        const src = e.dataTransfer.getData(TAB_SOURCE_MIME);
        if (!src || src === workspace.id) return;
        e.preventDefault();
        onDropTab(src, workspace.id);
      }}
      title={tileTitle}
      className={`flex items-center justify-center font-medium transition-all relative group ${
        workspace.active
          ? "text-text-1 opacity-100"
          : "text-text-3 hover:text-text-2"
      }`}
      style={{
        width: TILE,
        height: TILE,
        borderRadius: 7,
        fontSize: 13,
        background: workspace.active
          ? `color-mix(in srgb, ${accent} 26%, var(--color-bg-2))`
          : `color-mix(in srgb, ${accent} 6%, var(--color-bg-2))`,
        // A live drop target is the one thing here that needs you, so it —
        // and only it — takes the product accent.
        border: dragOver
          ? "1px dashed var(--color-accent)"
          : workspace.active
            ? `1px solid color-mix(in srgb, ${accent} 60%, var(--color-line))`
            : `1px solid color-mix(in srgb, ${accent} 18%, transparent)`,
        boxShadow: dragOver
          ? "0 0 0 2px color-mix(in srgb, var(--color-accent) 45%, transparent)"
          : "none",
      }}
    >
      <span className="relative flex items-center justify-center">
        <RepoAvatar
          repoRoot={workspace.id}
          emoji={workspace.emoji}
          letter={workspace.letter}
          size={TILE}
          fallback={<span>{workspace.letter}</span>}
        />
      </span>
      {hasWorktrees && <WorktreePip />}
      {unread > 0 && (
        <span
          className="absolute pointer-events-none flex items-center justify-center font-semibold"
          style={{
            right: -4,
            top: -4,
            minWidth: 14,
            height: 14,
            padding: "0 3px",
            borderRadius: 7,
            // Waiting-for-you is an ask, not a failure — amber, the pack's
            // attention slot; red stays reserved for things that broke and
            // the accent for the tile you are actually standing in (the
            // active tile's border, two properties up).
            background: "var(--color-amber)",
            color: "var(--color-bg-0)",
            boxShadow: "0 0 0 2px var(--color-bg-1)",
            fontSize: 9,
          }}
          aria-label={`${unread} agents waiting for you`}
        >
          {unread > 9 ? "9+" : unread}
        </span>
      )}
      <WorkspaceFleetPips tabs={fleet} anyRunning={fleet.length > 0} />
    </button>
  );

  return (
    <div
      ref={wrapRef}
      className="relative"
      onMouseEnter={scheduleOpen}
      onMouseLeave={scheduleClose}
    >
      {tileFace}
      {menuOpen && (
        <WorkspaceMenu
          workspaceId={workspace.id}
          currentEmoji={workspace.emoji}
          worktrees={worktrees}
          onPickWorktree={(p) => {
            setMenuOpen(false);
            onOpenWorktree?.(p);
          }}
          onClose={() => {
            setMenuOpen(false);
            onCloseWorkspace?.(workspace.id);
          }}
          onPickEmoji={(emoji) => {
            setWorkspaceEmoji(workspace.id, emoji);
          }}
          onDismiss={() => setMenuOpen(false)}
        />
      )}
      {hoverOpen && !menuOpen && (
        <WorkspaceProgressPopover
          root={workspace.id}
          letter={workspace.letter}
          accent="var(--color-text-2)"
          isActive={workspace.active}
          onMouseEnter={cancelLeave}
          onMouseLeave={scheduleClose}
        />
      )}
    </div>
  );
}

function WorktreePip() {
  return (
    <span
      className="absolute pointer-events-none"
      style={{
        right: 3,
        bottom: 3,
        width: 5,
        height: 5,
        borderRadius: 3,
        background: "var(--color-text-3)",
        boxShadow: "0 0 0 1.5px var(--color-bg-1)",
      }}
    />
  );
}

function WorkspaceMenu({
  workspaceId,
  currentEmoji,
  worktrees,
  onPickWorktree,
  onClose,
  onPickEmoji,
  onDismiss,
}: {
  workspaceId: string;
  currentEmoji?: string;
  worktrees: WorktreeRef[];
  onPickWorktree: (path: string) => void;
  /** "Close workspace" — drops it from recents. */
  onClose: () => void;
  /** Set or clear the workspace's emoji glyph. Pass undefined to clear. */
  onPickEmoji: (emoji: string | undefined) => void;
  /** Close the menu without taking action. */
  onDismiss: () => void;
}) {
  // Close on outside click / Escape — wrap div doesn't bubble cleanly
  // through the popover layer, so we listen at document level.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismiss();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onDismiss]);

  return (
    <div
      className={`${MENU_PANEL} absolute left-full ml-2 top-0`}
      style={{ minWidth: 240 }}
    >
      <div className={MENU_LABEL}>Icon</div>
      <div className="px-1 pb-1 grid grid-cols-8 gap-0.5">
        {EMOJI_PRESETS.map((e) => {
          const active = e === currentEmoji;
          return (
            <button
              key={e}
              type="button"
              onClick={() => onPickEmoji(e)}
              className={`w-6 h-6 flex items-center justify-center rounded hover:bg-bg-2 text-[14px] ${
                active ? "bg-bg-2 ring-1 ring-text-3" : ""
              }`}
              title={`Set ${e}`}
            >
              {e}
            </button>
          );
        })}
      </div>
      {currentEmoji && (
        <button
          type="button"
          onClick={() => onPickEmoji(undefined)}
          className={MENU_ROW}
        >
          Reset to letter
        </button>
      )}
      <div className={MENU_SEP} />
      {worktrees.length > 0 && (
        <>
          {/* Plain language: "parallel copies", not "worktrees" — the
              sidebar and the hover card already call them that. */}
          <div className={MENU_LABEL}>Parallel copies</div>
          {worktrees.map((w) => {
            const tail = w.path.split("/").filter(Boolean).slice(-2).join("/");
            const isActive = w.path === workspaceId;
            return (
              <button
                key={w.path}
                type="button"
                onClick={() => onPickWorktree(w.path)}
                className={`${MENU_ROW} flex-col !items-start gap-0.5${
                  isActive ? " bg-bg-2 text-text-1" : ""
                }`}
              >
                <div className="flex w-full items-center gap-1.5">
                  <span className="font-medium truncate flex-1">{tail || w.path}</span>
                  {w.is_main && (
                    <span className="text-[10px] tracking-wide text-text-4">
                      main
                    </span>
                  )}
                  {w.locked && (
                    <span className="text-[10px] tracking-wide text-text-4">
                      locked
                    </span>
                  )}
                </div>
                <div className="w-full text-[11px] text-text-4 font-mono truncate">
                  {w.branch || w.head.slice(0, 7) || "—"}
                </div>
              </button>
            );
          })}
          <div className={MENU_SEP} />
        </>
      )}
      <button type="button" onClick={onClose} className={MENU_ROW}>
        <span className="text-text-4">
          <CloseGlyph />
        </span>
        <span>Close workspace</span>
      </button>
    </div>
  );
}

function CloseGlyph() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
      <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

// Clubbed tile — sits below the workspace tiles when 2+ projects have been
// clubbed. A knot glyph on the same neutral tile as every other rail tile;
// which projects are bundled is answered by the right-click menu (it lists
// them by name), not by a band of colours the user has to decode. Right click
// opens that menu — leave-member / dissolve.
function ClubTile({ club }: { club: ClubProps }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as globalThis.Node)) {
        setMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  return (
    <div
      ref={wrapRef}
      className="relative"
    >
      <button
        type="button"
        onClick={club.onActivate}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenuOpen((v) => !v);
        }}
        title={`Clubbed workspace — ${club.members.length} projects${club.active ? " (active)" : ""}`}
        className={`flex items-center justify-center font-medium transition-all ${
          club.active ? "text-text-1" : "text-text-2 hover:text-text-1"
        }`}
        style={{
          width: TILE,
          height: TILE,
          borderRadius: 7,
          // Same two-step tile treatment as WorkspaceTile: active reads as a
          // lifted surface, idle as a whisper. Selection is the only state.
          background: club.active
            ? "var(--color-bg-3)"
            : "var(--color-bg-2)",
          border: club.active
            ? "1px solid var(--color-line)"
            : "1px solid var(--color-line-soft)",
        }}
      >
        <ClubGlyph />
      </button>
      {menuOpen && (
        <div
          className={`${MENU_PANEL} absolute left-full ml-2 top-0`}
          style={{ minWidth: 220 }}
        >
          <div className={MENU_LABEL}>Members</div>
          {club.members.map((m) => {
            const tail = m.split("/").filter(Boolean).slice(-2).join("/");
            return (
              <div
                key={m}
                className="px-2 py-1 flex items-center gap-2 text-[13px] leading-5 text-text-2"
              >
                <span
                  className="inline-block flex-shrink-0 bg-text-4"
                  style={{ width: 5, height: 5, borderRadius: 3 }}
                />
                <span className="flex-1 truncate">{tail || m}</span>
                <button
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    club.onLeaveMember(m);
                  }}
                  className="text-text-4 hover:text-text-1 text-[11px] tracking-wider"
                  title="Leave club"
                >
                  Leave
                </button>
              </div>
            );
          })}
          <div className={MENU_SEP} />
          <button
            type="button"
            onClick={() => {
              setMenuOpen(false);
              club.onDissolve();
            }}
            className={MENU_ROW}
          >
            Dissolve club
          </button>
        </div>
      )}
    </div>
  );
}

function ClubGlyph() {
  // Two interlocking rings — reads as "linked" / "tied together"
  // without leaning on chain or knot iconography that's already used
  // elsewhere in the UI for git refs.
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <circle cx="6" cy="8" r="3.2" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="10" cy="8" r="3.2" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

// Parity W8 — one optimistic launch in the rail. The app's one loader while
// the worktree + fleet provision; a check when ready (click → open the new
// workspace; auto-dismisses shortly after); red when something failed
// (sticky — click to dismiss, error text in the tooltip so nothing is
// silently swallowed). Only the failure keeps colour — "ready" is a
// disappearing state you don't have to act on, so its check reads neutral.
function InFlightTile({
  entry,
  onOpenWorktree,
}: {
  entry: InFlightEntry;
  onOpenWorktree?: (path: string) => void;
}) {
  const busy = entry.status === "creating" || entry.status === "spawning";
  const label =
    entry.status === "creating"
      ? `Creating parallel copy ${entry.branch}…`
      : entry.status === "spawning"
        ? `Spawning ${entry.agents.join(", ")} in ${entry.branch}…`
        : entry.status === "ready"
          ? `${entry.branch} ready — click to open`
          : `Launch failed: ${entry.error ?? "unknown error"} (click to dismiss)`;

  const handleClick = () => {
    if (entry.status === "ready" && entry.worktreePath) {
      const path = entry.worktreePath;
      dismissInFlight(entry.key);
      onOpenWorktree?.(path);
      return;
    }
    if (entry.status === "error") dismissInFlight(entry.key);
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      title={label}
      className={`relative flex items-center justify-center rounded-lg transition-colors ${
        entry.status === "error"
          ? "text-red hover:bg-bg-2"
          : entry.status === "ready"
            ? "text-text-2 hover:bg-bg-2"
            : "text-text-3"
      }`}
      style={{ width: TILE, height: TILE }}
    >
      {busy ? (
        <AsciiSpinner className="text-[12px]" />
      ) : entry.status === "ready" ? (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <path
            d="M3 8.5 6.5 12 13 4.5"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <path
            d="M4 4l8 8M12 4l-8 8"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
        </svg>
      )}
      {/* Branch initial badge so two parallel launches stay tellable apart */}
      <span
        className="absolute -bottom-0.5 -right-0.5 flex items-center justify-center text-[8px] font-semibold text-text-2"
        style={{
          width: 11,
          height: 11,
          background: "var(--color-bg-2)",
          borderRadius: 4,
        }}
      >
        {(entry.branch.split("/").pop() || entry.branch).charAt(0).toUpperCase()}
      </span>
    </button>
  );
}

function UserAvatar({ initial }: { initial: string }) {
  return (
    <div
      className="flex items-center justify-center text-text-2 font-medium"
      style={{
        width: TILE,
        height: TILE,
        background: "var(--color-bg-2)",
        borderRadius: 7,
        fontSize: 13,
      }}
    >
      {initial}
    </div>
  );
}
