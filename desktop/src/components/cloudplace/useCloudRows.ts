// The place's data as the library's shapes: members as `CloudMember`, every
// piece of cloud work as one `WorkspaceOverview` list, and who owns what.

import { useMemo } from "react";

import { groupCloudThreads } from "../../lib/cloudJobs";
import type { PresenceEntry } from "../../lib/cloudTeamApi";
import { useCloudJobs, type CloudJobWithRoot } from "../../lib/useCloudJobs";
import { useAgeTick } from "../../lib/useMinuteTick";
import type { CloudMember } from "../ui/cloud-workspace";
import type { WorkspaceOverview } from "../ui/workspace-preview-card";
import { cloudThreadOverview } from "../workspaces/workspacesOverview";
import { activeIdsOf, byPresence, meAmong } from "./cloudPeople";
import { valueOf, type CloudPlaceData } from "./cloudPlaceStore";
import {
  memberOf,
  newestActivityMs,
  ownersOf,
  publicWorkspaceOverview,
  PUBLIC_ROW_PREFIX,
  ROUTINE_SOURCE,
} from "./cloudRows";
import { useCloudPresence } from "./cloudTeamStore";

export type CloudRows = {
  members: CloudMember[];
  /** Your own member id: the cloud's user id for the signed-in account. */
  me: string | null;
  workspaces: WorkspaceOverview[];
  ownerByWorkspace: Record<string, string>;
  routineIds: string[];
  /** Ids of members using the app right now, from presence. */
  activeIds: Set<string>;
};

/** The time the cloud's lists print their ages against — "just now",
 *  "12m ago" — re-read as often as the freshest workspace's age can move, on
 *  the app's one clock. Read it once per surface and pass it everywhere. */
export function useCloudNow(data: CloudPlaceData): number {
  return useAgeTick(newestActivityMs(valueOf(data.workspaces, [])));
}

export function useCloudRows(data: CloudPlaceData, nowMs: number): CloudRows {
  const { jobs } = useCloudJobs(null);
  const presence = useCloudPresence();
  return useMemo(() => cloudRowsOf(data, jobs, presence, nowMs), [data, jobs, nowMs, presence]);
}

/** The rows themselves, from what the place read, the cloud jobs and who is
 *  here. Pure, so who "you" are and what is yours is tested without the app. */
export function cloudRowsOf(
  data: CloudPlaceData,
  jobs: CloudJobWithRoot[],
  presence: PresenceEntry[],
  nowMs: number,
): CloudRows {
  const rawMembers = valueOf(data.members, []);
  const rows = valueOf(data.workspaces, []);
  const repos = new Map(valueOf(data.repos, []).map((r) => [r.id, r]));
  const activeIds = activeIdsOf(presence);
  // Whoever is here now comes first, wherever members are listed.
  const members = byPresence(
    rawMembers.map((m) => memberOf(m, activeIds)),
    presence,
  );
  const me = meAmong(rawMembers, data.userId, data.login);
  const threads = groupCloudThreads(jobs).map((t) => cloudThreadOverview(t, nowMs, false));
  const workspaces = [
    ...rows.map((w) => publicWorkspaceOverview(w, repos, nowMs)),
    ...threads,
  ].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  return {
    members,
    me,
    workspaces,
    ownerByWorkspace: ownersOf(rows, members),
    routineIds: rows
      .filter((w) => w.source === ROUTINE_SOURCE)
      .map((w) => `${PUBLIC_ROW_PREFIX}${w.id}`),
    activeIds,
  };
}

/** Your workspaces still open, the ones the sidebar lists as yours. */
export function myWorkspaces(rows: CloudRows): WorkspaceOverview[] {
  const { me } = rows;
  if (!me) return [];
  return rows.workspaces.filter((w) => !w.archived && rows.ownerByWorkspace[w.id] === me);
}
