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
};

// Per-workspace accent colour. Deterministic hash of the workspace root
// → one of 8 muted tints. Used for the tile's left edge marker so the
// user can tell projects apart at a glance without each tile screaming.
// Cool/neutral palette only — amber/yellow tints were reading as
// "yellow folder" in the rail and competed with the FileTree's neutral
// folder glyphs. Lime trimmed for the same reason. Replacement: a
// slate and a teal so we keep eight distinguishable tints without any
// warm yellow on the rail.
const ACCENT_TINTS = [
  "rgb(125 211 252)", // sky-300
  "rgb(110 231 183)", // emerald-300
  "rgb(148 163 184)", // slate-400
  "rgb(252 165 165)", // rose-300
  "rgb(196 181 253)", // violet-300
  "rgb(103 232 249)", // cyan-300
  "rgb(94 234 212)",  // teal-300
  "rgb(165 180 252)", // indigo-300
];

export function accentForRoot(root: string): string {
  if (!root) return ACCENT_TINTS[0]!;
  let h = 0;
  for (let i = 0; i < root.length; i++) {
    h = (h * 31 + root.charCodeAt(i)) | 0;
  }
  return ACCENT_TINTS[Math.abs(h) % ACCENT_TINTS.length]!;
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

      {club && club.members.length >= 2 && (
        <ClubTile
          club={club}
          memberAccents={club.members.map((m) => accentForRoot(m))}
        />
      )}

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
  const tileTitle = `${workspace.id}${shortcutHint}${hasWorktrees ? `\n${countedWorktrees.length} parallel copies — right-click to switch` : "\nright-click for actions"}`;

  // Active tile pops in full accent. Inactive tiles still carry a very
  // subtle hint of their accent (so projects stay distinguishable at a
  // glance) plus a faint border — neither competes with the active one,
  // but they read as "tiles", not invisible letters. Hover lifts both
  // tint + border a notch.
  // Emoji-picked tiles override the hash-derived cool palette with a
  // hue that matches the glyph (🔥 → orange, 🧠 → pink, …). Otherwise
  // fall back to the deterministic-hash accent so letter tiles stay
  // distinguishable but neutral.
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
        border: dragOver
          ? `1px dashed color-mix(in srgb, ${accent} 80%, white)`
          : workspace.active
            ? `1px solid color-mix(in srgb, ${accent} 60%, var(--color-line))`
            : `1px solid color-mix(in srgb, ${accent} 18%, transparent)`,
        boxShadow: dragOver
          ? `0 0 0 2px color-mix(in srgb, ${accent} 45%, transparent)`
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
      className="absolute z-30 left-full ml-2 top-0 bg-bg-1 border border-line rounded-lg shadow-lg py-1.5 px-1"
      style={{ minWidth: 240 }}
    >
      <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-text-4">
        emoji
      </div>
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
          className="w-full text-left px-2 py-1 rounded text-[11px] text-text-3 hover:bg-bg-2 hover:text-text-1"
        >
          Reset to letter
        </button>
      )}
      <div className="my-1 border-t border-line-soft" />
      {worktrees.length > 0 && (
        <>
          <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-text-4">
            worktrees
          </div>
          {worktrees.map((w) => {
            const tail = w.path.split("/").filter(Boolean).slice(-2).join("/");
            const isActive = w.path === workspaceId;
            return (
              <button
                key={w.path}
                type="button"
                onClick={() => onPickWorktree(w.path)}
                className={`w-full text-left px-2 py-1.5 rounded text-[11.5px] flex flex-col gap-0.5 ${
                  isActive
                    ? "bg-bg-2 text-text-1"
                    : "text-text-2 hover:bg-bg-2 hover:text-text-1"
                }`}
              >
                <div className="flex items-center gap-1.5">
                  <span className="font-medium truncate flex-1">{tail || w.path}</span>
                  {w.is_main && (
                    <span className="text-[9.5px] uppercase tracking-wide text-text-5">
                      main
                    </span>
                  )}
                  {w.locked && (
                    <span className="text-[9.5px] uppercase tracking-wide text-amber">
                      locked
                    </span>
                  )}
                </div>
                <div className="text-[10px] text-text-4 font-mono truncate">
                  {w.branch || w.head.slice(0, 7) || "—"}
                </div>
              </button>
            );
          })}
          <div className="my-1 border-t border-line-soft" />
        </>
      )}
      <button
        type="button"
        onClick={onClose}
        className="w-full text-left px-2 py-1.5 rounded text-[11.5px] text-text-2 hover:bg-bg-2 hover:text-text-1 flex items-center gap-1.5"
      >
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

// Clubbed tile — sits below the workspace tiles when 2+ projects have
// been clubbed. Renders a "knot" glyph composed of the member accents
// so the user can read at a glance which workspaces are bundled. Right
// click opens a menu to leave-member / dissolve.
function ClubTile({
  club,
  memberAccents,
}: {
  club: ClubProps;
  memberAccents: string[];
}) {
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

  // Background = layered gradient from the member accents so the tile
  // visually reads as a blend rather than a single colour. Two members
  // = simple 50/50 split; three+ = even bands.
  const stops = memberAccents.length === 0
    ? "var(--color-bg-2)"
    : memberAccents.length === 1
      ? `color-mix(in srgb, ${memberAccents[0]} 26%, var(--color-bg-2))`
      : memberAccents
          .map((c, i) => {
            const from = Math.round((i / memberAccents.length) * 100);
            const to = Math.round(((i + 1) / memberAccents.length) * 100);
            return `color-mix(in srgb, ${c} 38%, var(--color-bg-2)) ${from}%, color-mix(in srgb, ${c} 38%, var(--color-bg-2)) ${to}%`;
          })
          .join(", ");
  const background =
    memberAccents.length >= 2 ? `linear-gradient(135deg, ${stops})` : stops;

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
          background,
          border: club.active
            ? `1px solid color-mix(in srgb, ${memberAccents[0] ?? "white"} 60%, var(--color-line))`
            : `1px solid var(--color-line-soft)`,
        }}
      >
        <ClubGlyph />
      </button>
      {menuOpen && (
        <div
          className="absolute z-30 left-full ml-2 top-0 bg-bg-1 border border-line rounded-lg shadow-lg py-1.5 px-1"
          style={{ minWidth: 220 }}
        >
          <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-text-4">
            members
          </div>
          {club.members.map((m, i) => {
            const tail = m.split("/").filter(Boolean).slice(-2).join("/");
            return (
              <div
                key={m}
                className="px-2 py-1 flex items-center gap-1.5 text-[11.5px] text-text-2"
              >
                <span
                  className="inline-block flex-shrink-0"
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: 4,
                    background: memberAccents[i] ?? "currentColor",
                  }}
                />
                <span className="flex-1 truncate">{tail || m}</span>
                <button
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    club.onLeaveMember(m);
                  }}
                  className="text-text-4 hover:text-text-1 text-[10px] uppercase tracking-wider"
                  title="Leave club"
                >
                  leave
                </button>
              </div>
            );
          })}
          <div className="my-1 border-t border-line-soft" />
          <button
            type="button"
            onClick={() => {
              setMenuOpen(false);
              club.onDissolve();
            }}
            className="w-full text-left px-2 py-1.5 rounded text-[11.5px] text-text-2 hover:bg-bg-2 hover:text-text-1"
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

// Parity W8 — one optimistic launch in the rail. Spinner ring while the
// worktree + fleet provision; green check when ready (click → open the new
// workspace; auto-dismisses shortly after); red when something failed
// (sticky — click to dismiss, error text in the tooltip so nothing is
// silently swallowed).
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
          ? "text-red-400 hover:bg-bg-2"
          : entry.status === "ready"
            ? "text-green-400 hover:bg-bg-2"
            : "text-text-3"
      }`}
      style={{ width: TILE, height: TILE }}
    >
      {busy ? (
        <span
          className="inline-block animate-spin rounded-full border-2 border-current border-t-transparent"
          style={{ width: 14, height: 14 }}
        />
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
