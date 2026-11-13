// Every copy of every open repository as a workspace row — the main checkout
// and each parallel copy — with its PR, its git state and who is on it, plus
// (when asked) the work sent to other machines. Home lists these rows and the
// Dashboard sorts them into stages; both read them from here so a copy says
// the same thing in each.

import { useEffect, useMemo, useState } from "react";

import type { WorkspaceOverview } from "../ui/workspace-preview-card";
import { useEditorStore } from "../../lib/editorStore";
import { agentsOnCopy } from "../../lib/agentsOnCopy";
import { useLivePtySessionIds } from "../../lib/useLiveAgentSessions";
import type { WorktreeRef } from "../../lib/workspaceRef";
import type { WorktreeBadge } from "../../lib/useWorktreeBadges";
import { useWorkspaceCustomization } from "../../lib/workspaceCustomization";
import { humanizeWorkspaceName } from "../../lib/workspaceLabel";
import { useCloudJobs } from "../../lib/useCloudJobs";
import { groupCloudThreads, type CloudThread } from "../../lib/cloudJobs";
import { pickBranchPr } from "../../lib/prsCache";
import { buildCopies, type CopyAgent, type ProjectMeta, type WorkspaceCopy } from "./workspacesModel";
import {
  cloudThreadOverview,
  cloudThreadsOffDisk,
  copyOverview,
  copyPr,
  type CopyPr,
} from "./workspacesOverview";
import { useFleetGit } from "./useFleetGit";

export type WorkspaceRowSource =
  | { kind: "copy"; copy: WorkspaceCopy; pr: CopyPr | null }
  | { kind: "cloud"; thread: CloudThread };

const NO_CLOUD: string[] = [];
const NO_JOBS: ReturnType<typeof useCloudJobs>["jobs"] = [];

export function useWorkspaceRows({
  projects,
  worktreesByRoot,
  badgeByPath,
  activePath,
  cloudRoots,
}: {
  projects: ProjectMeta[];
  worktreesByRoot: Record<string, WorktreeRef[]>;
  badgeByPath: Record<string, WorktreeBadge>;
  activePath: string;
  /** Whose work on other machines to add: `null` reads the whole account,
   *  a list reads those repositories, `false` adds none. */
  cloudRoots: string[] | null | false;
}): { rows: WorkspaceOverview[]; sources: Map<string, WorkspaceRowSource> } {
  const editor = useEditorStore();

  // Relative stamps stay fresh without thrashing — one tick a minute.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  // Which PTY sessions are actually still running, across every repository.
  // This is what lets a backgrounded copy claim an agent, and what stops a
  // copy you left in June from claiming one. See `agentsOnCopy`.
  const livePtyIds = useLivePtySessionIds(true);
  const agentsByPath = useMemo(() => {
    const paths = new Set<string>();
    for (const p of projects) {
      const wts = worktreesByRoot[p.id] ?? [];
      if (wts.length) wts.forEach((w) => paths.add(w.path));
      else paths.add(p.id);
    }
    const map = new Map<string, CopyAgent[]>();
    for (const path of paths) {
      const merged: CopyAgent[] = agentsOnCopy(path, editor.agentTabs, livePtyIds).map(
        (a) => ({ agentId: a.agentId, label: a.agentLabel, attention: a.attention }),
      );
      if (merged.length) map.set(path, merged);
    }
    return map;
  }, [projects, worktreesByRoot, editor.agentTabs, livePtyIds]);

  // A rename or an archive has to repaint the list the moment it happens, so
  // the customisation store is a dependency of every memo that reads it.
  const custom = useWorkspaceCustomization();
  // A repository reads the same here as in the sidebar group above it.
  const named = useMemo(
    () => projects.map((p) => ({ ...p, name: humanizeWorkspaceName(p.id, p.name) })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projects, custom],
  );
  const copies = useMemo(
    () =>
      buildCopies({ projects: named, worktreesByRoot, badgeByPath, agentsByPath, activePath }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [named, worktreesByRoot, badgeByPath, agentsByPath, activePath, custom],
  );
  const { git, prsByRoot } = useFleetGit(copies);

  // An empty list reads nothing at all; the one empty answer keeps the rows
  // below from being rebuilt on every render.
  const { jobs: read } = useCloudJobs(cloudRoots === false ? NO_CLOUD : cloudRoots);
  const cloudJobs = cloudRoots === false ? NO_JOBS : read;

  return useMemo(() => {
    const sources = new Map<string, WorkspaceRowSource>();
    const rows: WorkspaceOverview[] = [];
    for (const copy of copies) {
      const rich = pickBranchPr(prsByRoot.get(copy.root) ?? [], copy.branch || null);
      const pr = copyPr(copy, rich);
      sources.set(copy.path, { kind: "copy", copy, pr });
      rows.push(
        copyOverview({
          copy,
          nowMs,
          pr: rich,
          git: git.get(copy.path),
          archived: typeof custom[copy.path]?.archived === "number",
        }),
      );
    }
    for (const thread of cloudThreadsOffDisk(groupCloudThreads(cloudJobs), copies)) {
      const row = cloudThreadOverview(thread, nowMs, false);
      sources.set(row.id, { kind: "cloud", thread });
      rows.push(row);
    }
    return { rows, sources };
  }, [copies, prsByRoot, git, cloudJobs, nowMs, custom]);
}

/** The repository a new workspace is made in: the one holding the copy you
 *  are standing in, else the first one open. */
export function activeRepository(
  projects: ProjectMeta[],
  worktreesByRoot: Record<string, WorktreeRef[]>,
  activePath: string,
): string | undefined {
  return (
    projects.find(
      (p) => p.id === activePath || (worktreesByRoot[p.id] ?? []).some((w) => w.path === activePath),
    )?.id ?? projects[0]?.id
  );
}
