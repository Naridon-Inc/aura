// Workspaces — the full-screen "cool view" for the whole fleet of parallel
// copies, so the Build sidebar stays a curated few. Two ways to look at the
// same real data: a time-grouped list ("All") and a status board ("Board").
// Opened from the roster's "…other parallel copies" disclosure and from the
// Workspaces nav. Read-only over data App already has (worktrees + diff/PR
// badges + live agent tabs) — no new backend beyond the HEAD commit time.

import { useEffect, useMemo, useState } from "react";

import { FullscreenOverlay } from "../FullscreenOverlay";
import { WizardStepTabs } from "../ui/wizard";
import { useEditorStore, readPersistedAgents } from "../../lib/editorStore";
import type { WorktreeRef } from "../WorkspaceRail";
import type { WorktreeBadge } from "../../lib/useWorktreeBadges";
import {
  buildCopies,
  type CopyAgent,
  type ProjectMeta,
} from "./workspacesModel";
import { WorkspacesAllTab } from "./WorkspacesAllTab";
import { WorkspacesBoardTab } from "./WorkspacesBoardTab";

export type WorkspacesSurfaceProps = {
  onClose: () => void;
  projects: ProjectMeta[];
  worktreesByRoot: Record<string, WorktreeRef[]>;
  badgeByPath: Record<string, WorktreeBadge>;
  activePath: string;
  /** When opened from a single project's disclosure, scope the view to it
   *  (a removable chip); null = every open project. */
  initialProjectId?: string | null;
  /** Jump into a copy (checkout path). Closes the surface. */
  onOpen: (path: string) => void;
  /** Open the folder picker to add a workspace. */
  onAddWorkspace?: () => void;
};

export function WorkspacesSurface({
  onClose,
  projects,
  worktreesByRoot,
  badgeByPath,
  activePath,
  initialProjectId = null,
  onOpen,
  onAddWorkspace,
}: WorkspacesSurfaceProps) {
  const editor = useEditorStore();
  const [tab, setTab] = useState(0); // 0 = All, 1 = Board
  const [query, setQuery] = useState("");
  const [projectFilter, setProjectFilter] = useState<string | null>(
    initialProjectId,
  );

  // Keep relative stamps fresh without thrashing — one tick a minute.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  // Every agent parked on any worktree path — live tabs unioned with the
  // persisted per-repo roster (backgrounded workspaces), matching how the
  // sidebar roster resolves who's on a copy. Live tabs win on dedup.
  const agentsByPath = useMemo(() => {
    const paths = new Set<string>();
    for (const p of projects) {
      const wts = worktreesByRoot[p.id] ?? [];
      if (wts.length) wts.forEach((w) => paths.add(w.path));
      else paths.add(p.id);
    }
    const map = new Map<string, CopyAgent[]>();
    for (const path of paths) {
      const live = editor.agentTabs.filter((t) => t.repoRoot === path);
      const seen = new Set(live.map((t) => t.sessionId));
      const merged: CopyAgent[] = [
        ...live.map((t) => ({
          agentId: t.agentId,
          label: t.agentLabel,
          attention: !!t.attention,
        })),
        ...readPersistedAgents(path)
          .filter((p) => !seen.has(p.sessionId))
          .map((p) => ({
            agentId: p.agentId,
            label: p.agentLabel,
            attention: false,
          })),
      ];
      if (merged.length) map.set(path, merged);
    }
    return map;
  }, [projects, worktreesByRoot, editor.agentTabs]);

  const allCopies = useMemo(
    () =>
      buildCopies({
        projects,
        worktreesByRoot,
        badgeByPath,
        agentsByPath,
        activePath,
      }),
    [projects, worktreesByRoot, badgeByPath, agentsByPath, activePath],
  );

  const copies = useMemo(() => {
    const q = query.trim().toLowerCase();
    return allCopies.filter((c) => {
      if (projectFilter && c.root !== projectFilter) return false;
      if (!q) return true;
      return (
        c.title.toLowerCase().includes(q) ||
        c.branch.toLowerCase().includes(q) ||
        c.projectName.toLowerCase().includes(q)
      );
    });
  }, [allCopies, query, projectFilter]);

  const open = (path: string) => {
    onOpen(path);
    onClose();
  };

  const filteredProjectName =
    projectFilter != null
      ? projects.find((p) => p.id === projectFilter)?.name
      : null;

  return (
    <FullscreenOverlay
      onClose={onClose}
      tabs={
        <WizardStepTabs
          variant="tabs"
          steps={[
            { id: "all", label: "All" },
            { id: "board", label: "Board" },
          ]}
          index={tab}
          onJump={setTab}
        />
      }
      actions={
        <div className="flex items-center gap-2">
          {filteredProjectName && (
            <button
              type="button"
              onClick={() => setProjectFilter(null)}
              className="inline-flex items-center gap-1 h-7 pl-2 pr-1.5 rounded-md text-[12px] text-text-2 bg-bg-2 hover:bg-bg-3 transition-colors"
              title="Show every project"
            >
              {filteredProjectName}
              <span aria-hidden className="text-text-4">
                ✕
              </span>
            </button>
          )}
          <div className="flex items-center h-7 rounded-md bg-bg-2 pl-2 pr-1 focus-within:ring-1 focus-within:ring-line">
            <SearchGlyph />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter copies…"
              className="w-40 bg-transparent px-1.5 text-[12px] text-text-1 placeholder:text-text-5 outline-none"
            />
          </div>
          <span className="text-[11px] tabular-nums text-text-4">
            {copies.length}
          </span>
          {onAddWorkspace && (
            <button
              type="button"
              onClick={() => {
                onAddWorkspace();
                onClose();
              }}
              className="inline-flex items-center gap-1 h-7 px-2.5 rounded-md text-[12px] font-medium text-accent bg-[color-mix(in_srgb,var(--color-accent)_12%,transparent)] hover:bg-[color-mix(in_srgb,var(--color-accent)_20%,transparent)] transition-colors"
              title="Open a project folder (⌘N)"
            >
              + New
            </button>
          )}
        </div>
      }
    >
      {tab === 0 ? (
        <WorkspacesAllTab
          copies={copies}
          nowMs={nowMs}
          activePath={activePath}
          onOpen={open}
        />
      ) : (
        <WorkspacesBoardTab copies={copies} nowMs={nowMs} onOpen={open} />
      )}
    </FullscreenOverlay>
  );
}

function SearchGlyph() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      className="flex-none text-text-4"
      aria-hidden
    >
      <circle cx="7" cy="7" r="4.5" />
      <path d="m11 11 3 3" strokeLinecap="round" />
    </svg>
  );
}
