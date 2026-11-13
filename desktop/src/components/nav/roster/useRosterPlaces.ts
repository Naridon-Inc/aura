// Machines, and the work sent to them, filed under the repositories on screen.
//
// Every repository row is drawn from the disk: a worktree, a branch, a
// checkout. A machine has none of those, so a list that answers "what is going
// on" by reading the filesystem could not see one. Sending work to the cloud
// left the list as it was, and entering a machine changed every shell in the
// window while the list kept showing local checkouts with nothing lit. The
// list now shows the place you are in (see lib/placeScope): standing on a
// machine, it lists that machine's workspaces, filed here under the
// repositories they are copies of.

import { useEffect, useMemo, useState } from "react";
import { api, type Machine } from "../../../lib/api";
import { onOrgChanged } from "../../../lib/cloudOrgs";
import { useActiveMachine, useEnteredMachines } from "../../../lib/activeMachine";
import { useCloudJobs, type CloudJobWithRoot } from "../../../lib/useCloudJobs";
import { groupCloudThreads, railCloudThreads, type CloudThread } from "../../../lib/cloudJobs";
import { filePlaces, placesOfMachines } from "../../../lib/place";
import type { Workspace } from "../../../lib/workspaceRef";
import type { Customization } from "./rosterTypes";

export function useRosterPlaces(input: {
  workspaces: Workspace[];
  custom: Customization;
  now: number;
}) {
  const { workspaces, custom, now } = input;

  // Read per repository rather than account-wide: the account-wide list is one
  // request but carries no local root, and a row that can't name its
  // repository can't say which one it is for.
  const { jobs: cloudJobs } = useCloudJobs(workspaces.map((ws) => ws.id));

  // Which machine (and which cloud conversation) this window is standing in,
  // and every other one it is still holding open. "You are here" and "this is
  // also open" are two statements, and the list makes both.
  const { machineId: activeMachineId, threadKey: activeThreadKey } = useActiveMachine();
  const enteredMachines = useEnteredMachines();
  const heldMachineIds = useMemo(() => {
    const ids = new Set<string>();
    for (const m of enteredMachines) {
      if (m.machineId && m.machineId !== activeMachineId) ids.add(m.machineId);
    }
    return ids;
  }, [enteredMachines, activeMachineId]);
  const heldThreadKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const m of enteredMachines) {
      if (m.threadKey && m.threadKey !== activeThreadKey) keys.add(m.threadKey);
    }
    return keys;
  }, [enteredMachines, activeThreadKey]);

  // The machine book. Re-read when the active machine changes, which is also
  // what happens the moment the Connect wizard saves one, and when the org
  // changes, because the book is filtered to the org you are acting as.
  const [machines, setMachines] = useState<Machine[] | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .machinesList()
        .then((ms) => {
          if (alive) setMachines(ms);
        })
        .catch(() => {
          // A book that won't read is not worth a row of red in the list; the
          // repository menu still offers "Connect a machine…".
          if (alive) setMachines([]);
        });
    void load();
    const off = onOrgChanged(() => void load());
    return () => {
      alive = false;
      off();
    };
  }, [activeMachineId]);

  // Jobs → conversations → the few each repository carries, capped per
  // repository so one busy repository can't crowd another out.
  const cloudThreadsByRoot = useMemo(() => {
    const byRoot = new Map<string, CloudJobWithRoot[]>();
    for (const job of cloudJobs) {
      // No root means the account-wide read answered; guessing one would file
      // work under the wrong repository.
      if (!job.repoRoot) continue;
      const bucket = byRoot.get(job.repoRoot);
      if (bucket) bucket.push(job);
      else byRoot.set(job.repoRoot, [job]);
    }
    const out = new Map<string, CloudThread[]>();
    for (const [root, jobs] of byRoot) {
      out.set(root, railCloudThreads(groupCloudThreads(jobs), now));
    }
    return out;
  }, [cloudJobs, now]);

  // Archived repositories have no row, so they are not somewhere a machine
  // can be filed: a box connected for one lands with the unfiled ones.
  const knownRoots = useMemo(
    () =>
      new Set(
        workspaces
          .filter((ws) => typeof custom[ws.id]?.archived !== "number")
          .map((ws) => ws.id),
      ),
    [workspaces, custom],
  );
  const { byProject: placesByRoot, unplaced: unplacedPlaces } = useMemo(
    () => filePlaces(placesOfMachines(machines ?? []), knownRoots),
    [machines, knownRoots],
  );

  // Cloud work whose repository has no row. Dropping it would make cloud the
  // one place the app runs work and never says so.
  const orphanCloudThreads = useMemo(() => {
    const out: CloudThread[] = [];
    for (const [root, threads] of cloudThreadsByRoot) {
      if (!knownRoots.has(root)) out.push(...threads);
    }
    return out;
  }, [cloudThreadsByRoot, knownRoots]);

  return {
    machinesLoading: machines === null,
    activeMachineId,
    activeThreadKey,
    heldMachineIds,
    heldThreadKeys,
    cloudThreadsByRoot,
    placesByRoot,
    unplacedPlaces,
    orphanCloudThreads,
  };
}
