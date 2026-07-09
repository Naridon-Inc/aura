// Project switcher — the work-surface header breadcrumb, rendered as TWO
// independent chips, not one control (Image #1 / #2):
//   • Repo chip — `emoji · project` — opens a FLAT list of open workspaces.
//   • Worktree chip — `⑂ branch` — a separate element that opens a menu of
//     just the active project's worktrees, so switching checkout is one hop
//     and never buried under the project list.
// Splitting them (vs a single `project › branch` button) lets each be
// clicked, hovered and reasoned about on its own — the way Conductor/Cursor
// treat repo and branch as distinct affordances top-left of the pane.
//
// The projects menu is deliberately a flat list, NOT a project→worktree tree:
// the left Workspaces rail already nests each project's worktrees, so
// duplicating that tree here was redundant. Each picker instead carries a
// last-touched time — the project's `last_opened_at` (projects.json registry)
// and the worktree's HEAD commit date — so the two selects read like a
// recency-ordered switcher without leaving the header.

import { useEffect, useMemo, useRef, useState } from "react";
import { PictureInPicture2 } from "lucide-react";
import { api } from "../lib/api";
import type { WorktreeRef } from "./WorkspaceRail";
import { openPopout } from "../lib/popout";

export type ProjectSwitcherWorkspace = {
  root: string;
  name: string;
  emoji?: string;
};

type ProjectSwitcherProps = {
  activeRoot: string;
  activeName: string;
  activeEmoji?: string;
  workspaces: ProjectSwitcherWorkspace[];
  /** Sibling git worktrees per workspace root — powers the nested tier. */
  worktreesByRoot?: Record<string, WorktreeRef[]>;
  onSwitch: (root: string) => void;
  /** Open (switch into) a sibling worktree. Same code path as a workspace
   *  switch — the caller routes the worktree path through loadProjectAt. */
  onOpenWorktree?: (path: string) => void;
  onAdd: () => void;
};

export function ProjectSwitcher({
  activeRoot,
  activeName,
  activeEmoji,
  workspaces,
  worktreesByRoot,
  onSwitch,
  onOpenWorktree,
  onAdd,
}: ProjectSwitcherProps) {
  // Only one of the two chips' menus is open at a time.
  const [menu, setMenu] = useState<null | "projects" | "worktrees">(null);
  // Root → last-opened unix seconds, from the projects.json registry. Powers
  // the "2h ago" recency label on each project row. Absent roots simply show
  // no time (the registry stamps on open, so a never-opened root has none).
  const [lastOpenedByRoot, setLastOpenedByRoot] = useState<
    Record<string, number>
  >({});
  const wrapRef = useRef<HTMLDivElement>(null);

  // The workspace that owns the open checkout. `activeRoot` may be the main
  // repo root OR a sibling worktree path, so resolve back to the workspace
  // root whose worktree set contains it — that's what scopes the worktree
  // chip's menu and seeds the projects tier.
  const activeWorkspaceRoot = useMemo(() => {
    for (const [root, wts] of Object.entries(worktreesByRoot ?? {})) {
      if (root === activeRoot) return root;
      if (wts.some((w) => w.path === activeRoot)) return root;
    }
    return activeRoot;
  }, [worktreesByRoot, activeRoot]);

  // The active project's worktrees, main-first — the worktree chip's menu.
  const activeWorktrees = useMemo(
    () =>
      [...(worktreesByRoot?.[activeWorkspaceRoot] ?? [])].sort((a, b) =>
        a.is_main === b.is_main ? 0 : a.is_main ? -1 : 1,
      ),
    [worktreesByRoot, activeWorkspaceRoot],
  );

  // The branch of the currently-open checkout — the worktree chip's label.
  // Matched against every known worktree so it resolves whether `activeRoot`
  // is the main repo or a sibling. Omitted when there's no branch (detached
  // / unknown) — the chip hides entirely rather than show a blank segment.
  const activeBranch = useMemo(() => {
    const wt = Object.values(worktreesByRoot ?? {})
      .flat()
      .find((w) => w.path === activeRoot);
    const bare = (wt?.branch ?? "").replace(/^refs\/heads\//, "");
    return bare || undefined;
  }, [worktreesByRoot, activeRoot]);

  useEffect(() => {
    if (!menu) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  // Load the projects registry (root → last_opened_at) on mount and each time
  // the projects menu opens, so the recency labels are fresh when shown. Cheap
  // (~a small JSON read); failures leave the map empty and the rows omit times.
  const projectsOpen = menu === "projects";
  useEffect(() => {
    let cancelled = false;
    api
      .projectsList()
      .then((entries) => {
        if (cancelled) return;
        const next: Record<string, number> = {};
        for (const e of entries) next[e.root] = e.last_opened_at;
        setLastOpenedByRoot(next);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [projectsOpen]);

  return (
    <div ref={wrapRef} className="relative flex items-center gap-0.5 min-w-0">
      {/* Repo chip — its own element. Opens the projects menu. */}
      <div className="relative flex-shrink-0">
        <button
          type="button"
          onClick={() => setMenu((m) => (m === "projects" ? null : "projects"))}
          title="Switch project"
          className={`flex items-center gap-1.5 h-[24px] max-w-[240px] pl-1 pr-1.5 rounded-md text-[12px] transition-colors ${
            menu === "projects"
              ? "bg-bg-2 text-text-1"
              : "text-text-2 hover:bg-bg-2 hover:text-text-1"
          }`}
        >
          <WorkspaceMark emoji={activeEmoji} name={activeName} />
          <span className="min-w-0 truncate font-medium text-text-1">
            {activeName}
          </span>
        </button>

        {menu === "projects" && (
          <div
            className="absolute left-0 top-full mt-1 z-50 bg-bg-1 border border-line-soft rounded-lg shadow-[var(--shadow-flyout)] p-1"
            style={{ minWidth: 248, maxWidth: 340 }}
          >
            <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.06em] text-text-4">
              Projects
            </div>
            <div className="max-h-[60vh] overflow-y-auto">
              {workspaces.map((w) => (
                <WorkspaceRow
                  key={w.root}
                  ws={w}
                  active={w.root === activeWorkspaceRoot}
                  lastOpened={lastOpenedByRoot[w.root]}
                  onSwitch={() => {
                    setMenu(null);
                    if (w.root !== activeRoot) onSwitch(w.root);
                  }}
                  onPopout={() => {
                    setMenu(null);
                    void openPopout({
                      kind: "workspace",
                      root: w.root,
                      title: w.name,
                    });
                  }}
                />
              ))}
            </div>
            <div className="mt-1 pt-1 border-t border-line-soft">
              <button
                type="button"
                onClick={() => {
                  setMenu(null);
                  onAdd();
                }}
                className="w-full flex items-center gap-2 px-2 py-1 rounded-md text-text-3 hover:text-text-1 hover:bg-bg-2 text-[12px] transition-colors"
              >
                <span className="w-5 h-5 rounded-md flex items-center justify-center border border-line-soft">
                  <Plus />
                </span>
                Add project…
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Worktree chip — a separate element, worktree icon leading its name.
          Opens a menu scoped to the active project's worktrees. Hidden when
          there's no resolvable branch. */}
      {activeBranch && (
        <>
          <Sep />
          <div className="relative min-w-0">
            <button
              type="button"
              onClick={() =>
                setMenu((m) => (m === "worktrees" ? null : "worktrees"))
              }
              title="Switch worktree"
              className={`flex items-center gap-1.5 h-[24px] max-w-[220px] pl-1 pr-1.5 rounded-md text-[11px] transition-colors ${
                menu === "worktrees"
                  ? "bg-bg-2 text-text-1"
                  : "text-text-3 hover:bg-bg-2 hover:text-text-1"
              }`}
            >
              <span className="flex-shrink-0 text-text-4">
                <BranchGlyph />
              </span>
              <span className="min-w-0 truncate font-mono">{activeBranch}</span>
            </button>

            {menu === "worktrees" && (
              <div
                className="absolute left-0 top-full mt-1 z-50 bg-bg-1 border border-line-soft rounded-lg shadow-[var(--shadow-flyout)] p-1"
                style={{ minWidth: 220, maxWidth: 320 }}
              >
                <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.06em] text-text-4">
                  Worktrees
                </div>
                <div className="max-h-[60vh] overflow-y-auto">
                  {activeWorktrees.length === 0 ? (
                    <div className="px-2 py-1.5 text-[11px] text-text-4">
                      No sibling worktrees
                    </div>
                  ) : (
                    activeWorktrees.map((wt) => {
                      const wtActive = wt.path === activeRoot;
                      return (
                        <button
                          key={wt.path}
                          type="button"
                          onClick={() => {
                            setMenu(null);
                            if (!wtActive) onOpenWorktree?.(wt.path);
                          }}
                          className={`w-full flex items-center gap-2 px-2 py-1 rounded-md text-left transition-colors ${
                            wtActive
                              ? "bg-bg-3 text-text-1"
                              : "text-text-2 hover:text-text-1 hover:bg-bg-2"
                          }`}
                        >
                          <span className="flex-shrink-0 text-text-4">
                            {wt.is_main ? <MainDot /> : <BranchGlyph />}
                          </span>
                          <span className="flex-1 min-w-0 truncate font-mono text-[11px]">
                            {wt.branch || "(detached)"}
                          </span>
                          {sinceLabel(wt.head_committed_at) && (
                            <span className="flex-shrink-0 text-[10.5px] text-text-4 tabular-nums">
                              {sinceLabel(wt.head_committed_at)}
                            </span>
                          )}
                          {wtActive && (
                            <span
                              className="flex-shrink-0"
                              style={{ color: "var(--color-accent)" }}
                            >
                              <Check />
                            </span>
                          )}
                        </button>
                      );
                    })
                  )}
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// A single project row in the (flat) projects menu: mark + name, a
// right-aligned last-opened time, a hover popout, and a check when active.
// No worktree tier — the left Workspaces rail owns that nesting; here the
// worktree chip beside this menu is the dedicated worktree switch.
function WorkspaceRow({
  ws,
  active,
  lastOpened,
  onSwitch,
  onPopout,
}: {
  ws: ProjectSwitcherWorkspace;
  active: boolean;
  lastOpened?: number;
  onSwitch: () => void;
  onPopout: () => void;
}) {
  const touched = sinceLabel(lastOpened);
  return (
    <div
      className={`group/ws w-full flex items-center gap-2 px-1.5 py-1 rounded-md transition-colors ${
        active ? "bg-bg-3 text-text-1" : "text-text-2 hover:text-text-1 hover:bg-bg-2"
      }`}
    >
      <button
        type="button"
        onClick={onSwitch}
        className="flex-1 min-w-0 flex items-center gap-2 text-left"
      >
        <WorkspaceMark emoji={ws.emoji} name={ws.name} />
        <span className="flex-1 min-w-0 truncate text-[12px] font-medium">
          {ws.name}
        </span>
      </button>
      {touched && (
        <span className="flex-shrink-0 text-[10.5px] text-text-4 tabular-nums">
          {touched}
        </span>
      )}
      <button
        type="button"
        onClick={onPopout}
        title="Open in a new window"
        aria-label={`Open ${ws.name} in a new window`}
        className="flex-shrink-0 w-5 h-5 flex items-center justify-center rounded-md text-text-4 opacity-0 group-hover/ws:opacity-100 hover:text-text-1 hover:bg-bg-2 transition-opacity"
      >
        <PictureInPicture2 size={13} strokeWidth={1.6} aria-hidden />
      </button>
      {active && (
        <span className="flex-shrink-0" style={{ color: "var(--color-accent)" }}>
          <Check />
        </span>
      )}
    </div>
  );
}

// Compact "last touched" label from an absolute unix-seconds timestamp.
// Returns "" for a missing/zero stamp so the row simply omits it — recency is
// never faked. Mirrors streamSummary.relAge's tiers with a "just now" floor
// and week/month/year rollups for long-idle projects.
function sinceLabel(tsSecs?: number | null): string {
  if (!tsSecs || tsSecs <= 0) return "";
  const s = Math.floor(Date.now() / 1000) - tsSecs;
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 604800) return `${Math.floor(s / 86400)}d ago`;
  if (s < 2629800) return `${Math.floor(s / 604800)}w ago`;
  if (s < 31557600) return `${Math.floor(s / 2629800)}mo ago`;
  return `${Math.floor(s / 31557600)}y ago`;
}

function WorkspaceMark({ emoji, name }: { emoji?: string; name: string }) {
  return (
    <span
      className="w-[18px] h-[18px] rounded-md flex items-center justify-center flex-shrink-0 text-[10px] font-semibold"
      style={{
        background: "color-mix(in srgb, var(--color-accent) 16%, transparent)",
        color: "var(--color-accent)",
      }}
    >
      {emoji ?? (name.replace(/^[^a-z0-9]+/i, "").slice(0, 1).toUpperCase() || "·")}
    </span>
  );
}

// Breadcrumb separator — a thin `›` between the project and its branch.
function Sep() {
  return (
    <svg
      width="9"
      height="9"
      viewBox="0 0 16 16"
      fill="none"
      className="flex-shrink-0 text-text-4"
      aria-hidden
    >
      <path d="M6 3.5L10.5 8L6 12.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function BranchGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
      <circle cx="4" cy="4" r="1.6" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="4" cy="12" r="1.6" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="12" cy="6" r="1.6" stroke="currentColor" strokeWidth="1.2" />
      <path d="M4 5.6v4.8M4 8h4a2 2 0 0 0 2-2" stroke="currentColor" strokeWidth="1.2" fill="none" />
    </svg>
  );
}

function MainDot() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="3" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

function Check() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
      <path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Plus() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
      <line x1="8" y1="3" x2="8" y2="13" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <line x1="3" y1="8" x2="13" y2="8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}
