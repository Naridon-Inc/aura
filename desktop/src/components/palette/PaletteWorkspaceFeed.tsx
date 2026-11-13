// Where the ⌘K palette's workspace rows come from: the place the window is
// in, and only that place. On this computer, its checkouts and copies; in the
// cloud, the cloud's workspaces; on a machine, that machine's work. Each feed
// is mounted only while the palette is open, in the one place it serves, and
// hands its rows up with the way to open one.

import { useEffect } from "react";

import { api } from "../../lib/api";
import { openCloudWorkspace, useCloudPlace } from "../../lib/cloudPlace";
import { openCloudThread, openRemoteWorkspace } from "../../lib/editorStore";
import { placeRowLabel, placesOfMachines, type Place } from "../../lib/place";
import { filterToScope, type PlaceScope } from "../../lib/placeScope";
import { relativeAgeFromSecs } from "../../lib/relativeTime";
import type { WorktreeRef } from "../../lib/workspaceRef";
import type { WorktreeBadge } from "../../lib/useWorktreeBadges";
import { useCloudPlaceData, valueOf } from "../cloudplace/cloudPlaceStore";
import { rowNumber } from "../cloudplace/cloudRows";
import { useCloudNow, useCloudRows } from "../cloudplace/useCloudRows";
import type { CloudMember } from "../ui/cloud-workspace";
import type { WorkspaceOverview } from "../ui/workspace-preview-card";
import type { ProjectMeta } from "../workspaces/workspacesModel";
import { CLOUD_ROW_PREFIX } from "../workspaces/workspacesOverview";
import { useWorkspaceRows } from "../workspaces/useWorkspaceRows";
import type { PaletteWorkspace } from "./paletteWorkspaces";

export type PaletteWorkspaceFeed = {
  rows: PaletteWorkspace[];
  /** The row in front of the palette, left out of the recent ones. */
  activeId: string | null;
  /** The workspace in front is a copy, so it can be archived. */
  canArchive: boolean;
  /** The cloud's members, for its owner filter. */
  members: CloudMember[];
  open: (row: PaletteWorkspace) => void;
};

export const EMPTY_FEED: PaletteWorkspaceFeed = {
  rows: [],
  activeId: null,
  canArchive: false,
  members: [],
  open: () => {},
};

function fromOverview(
  w: WorkspaceOverview,
  repo: PaletteWorkspace["repo"],
  extra: Partial<PaletteWorkspace> = {},
): PaletteWorkspace {
  return {
    id: w.id,
    title: w.title,
    branch: w.branch,
    project: w.project,
    projectId: w.projectId,
    stage: w.stage,
    updatedAt: w.updatedAt,
    timeLabel: w.timeLabel,
    archived: !!w.archived,
    unread: !!w.unread,
    live: w.workflow.state === "working",
    repo,
    fields: [w.title, w.branch, w.project, w.id],
    ...extra,
  };
}

export type LocalFeedProps = {
  scope: PlaceScope;
  projects: ProjectMeta[];
  worktreesByRoot: Record<string, WorktreeRef[]>;
  badgeByPath: Record<string, WorktreeBadge>;
  activePath: string;
  /** Opens a checkout or copy on this computer by its path. */
  openPath: (path: string) => void;
  onFeed: (feed: PaletteWorkspaceFeed) => void;
};

/** This computer's checkouts and copies. */
export function LocalWorkspaceFeed({
  scope,
  projects,
  worktreesByRoot,
  badgeByPath,
  activePath,
  openPath,
  onFeed,
}: LocalFeedProps) {
  const { rows, sources } = useWorkspaceRows({
    projects,
    worktreesByRoot,
    badgeByPath,
    activePath,
    cloudRoots: false,
  });
  useEffect(() => {
    const here = filterToScope(scope, rows, (r) => (sources.get(r.id)?.kind === "cloud" ? { cloud: true } : {}));
    const front = sources.get(activePath);
    onFeed({
      rows: here.map((w) => fromOverview(w, { kind: "local", root: w.projectId })),
      activeId: activePath,
      canArchive: front?.kind === "copy" && !front.copy.isMain,
      members: [],
      open: (row) => openPath(row.id),
    });
  }, [scope, rows, sources, activePath, openPath, onFeed]);
  return null;
}

/** The cloud's workspaces, with who opened each. */
export function CloudWorkspaceFeed({ onFeed }: { onFeed: (feed: PaletteWorkspaceFeed) => void }) {
  const data = useCloudPlaceData();
  const nowMs = useCloudNow(data);
  const cloud = useCloudRows(data, nowMs);
  const place = useCloudPlace();
  useEffect(() => {
    const fullName = new Map(valueOf(data.repos, []).map((r) => [r.id, r.full_name]));
    onFeed({
      rows: cloud.workspaces.map((w) =>
        fromOverview(
          w,
          { kind: "cloud", fullName: fullName.get(w.projectId) ?? null },
          { number: rowNumber(w.id), owner: cloud.ownerByWorkspace[w.id] },
        ),
      ),
      activeId: place.page === "workspace" ? place.workspaceId : null,
      canArchive: false,
      members: cloud.members,
      open: (row) => {
        openCloudWorkspace(row.id);
        if (row.id.startsWith(CLOUD_ROW_PREFIX))
          openCloudThread(row.id.slice(CLOUD_ROW_PREFIX.length), row.projectId === "cloud" ? "" : row.projectId);
      },
    });
  }, [data.repos, cloud, place.page, place.workspaceId, onFeed]);
  return null;
}

function placeRow(p: Place): PaletteWorkspace {
  const { work, machine } = placeRowLabel(p);
  const root = p.project.root;
  const project = root ? root.split("/").filter(Boolean).pop() || root : machine || p.name;
  return {
    id: p.machineId ?? p.name,
    title: work,
    branch: p.project.branch ?? "",
    project,
    projectId: root ?? p.machineId ?? p.name,
    stage: "in-progress",
    updatedAt: p.lastUsedAt * 1000,
    timeLabel: relativeAgeFromSecs(p.lastUsedAt, { style: "compact", empty: "" }),
    archived: false,
    unread: false,
    live: false,
    repo: root ? { kind: "local", root } : null,
    fields: [work, p.project.branch ?? "", project, p.name, p.project.path ?? ""],
  };
}

/** The work on the machine the window is standing in. */
export function MachineWorkspaceFeed({
  machineId,
  onFeed,
}: {
  machineId: string;
  onFeed: (feed: PaletteWorkspaceFeed) => void;
}) {
  useEffect(() => {
    let cancelled = false;
    api
      .machinesList()
      .then((machines) => {
        if (cancelled) return;
        const places = placesOfMachines(machines).filter((p) => p.machineId === machineId);
        onFeed({
          rows: places.map(placeRow),
          activeId: machineId,
          canArchive: false,
          members: [],
          open: (row) => {
            const p = places.find((x) => (x.machineId ?? x.name) === row.id);
            if (p?.machineId) openRemoteWorkspace({ machineId: p.machineId, repoRoot: p.project.root ?? undefined });
          },
        });
      })
      .catch(() => {
        if (!cancelled) onFeed(EMPTY_FEED);
      });
    return () => {
      cancelled = true;
    };
  }, [machineId, onFeed]);
  return null;
}
