// What the right panel reads from the machine a workspace's chat runs on:
// which machine-book entry it goes through, what the branch changed, and
// where the branch stands.
//
// Each read is an ssh round trip, so each is kept for the window
// (useKeptView): opening the workspace again shows what the panel showed
// last at once, and the next round trip refreshes it. A read that fails
// keeps what is already shown rather than blanking the panel.

import { useEffect, useState } from "react";

import { api } from "../../lib/api";
import type { CloudWorkspacePlace } from "../../lib/cloudWorkspacesApi";
import {
  placeGitAheadBehind,
  placeGitDiffStatsPerFile,
  placeGitStatusV2,
  type WorkAt,
} from "../../lib/place/placeWork";
import { boxChanges, boxWorkAt, type BoxWorkTarget } from "./boxWork";
import { viewKey } from "./cloudPlaceKeep";
import { useKeptView } from "./useKeptView";

export type Read<T> = { state: "loading" } | { state: "failed"; message: string } | { state: "read"; value: T };

export function textOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The panel's key for one read of one worktree on one machine. */
export function boxKey(part: string, at: WorkAt | null): string {
  return viewKey(part, at?.machineId, at?.repoRoot);
}

const sameTarget = (a: BoxWorkTarget, b: BoxWorkTarget) => JSON.stringify(a) === JSON.stringify(b);

/** The machine-book entry the chat goes through, read once per open. */
export function useTarget(place: CloudWorkspacePlace | null): BoxWorkTarget | null {
  const [target, keepTarget] = useKeptView<BoxWorkTarget | null>(
    viewKey("box-target", place?.machine, place?.remote_root),
    null,
  );
  const machine = place?.machine ?? null;
  const remoteRoot = place?.remote_root ?? null;
  useEffect(() => {
    // A workspace with no machine has nothing to find.
    if (machine === null || remoteRoot === null) return;
    const place = { machine, remote_root: remoteRoot };
    let live = true;
    api.machinesList().then(
      (book) => {
        if (!live) return;
        const next = boxWorkAt(book, place);
        // The same answer keeps its identity, so the reads hanging off it
        // don't run a second time.
        keepTarget((was) => (was && sameTarget(was, next) ? was : next));
      },
      // An unreadable book says nothing new about an entry already found.
      () => live && keepTarget((was) => was ?? boxWorkAt([], place)),
    );
    return () => {
      live = false;
    };
  }, [machine, remoteRoot, keepTarget]);
  return machine === null ? null : target;
}

/** A read of the machine that runs again on each tick, keeping what it
 *  showed while it does and when it fails: a slow or lost round trip never
 *  blanks the panel. */
function useMachineRead<T>(
  part: string,
  at: WorkAt | null,
  read: (at: WorkAt) => Promise<T>,
  tick: number,
): Read<T> {
  const [value, keep] = useKeptView<T | undefined>(boxKey(part, at), undefined);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    if (!at) return;
    let live = true;
    read(at).then(
      (v) => {
        if (!live) return;
        keep(() => v);
        setFailed(null);
      },
      (e) => live && setFailed(textOf(e)),
    );
    return () => {
      live = false;
    };
  }, [at, read, tick, keep]);
  if (value !== undefined) return { state: "read", value };
  return failed === null ? { state: "loading" } : { state: "failed", message: failed };
}

const readChanges = (at: WorkAt) =>
  Promise.all([placeGitDiffStatsPerFile(at, true), placeGitStatusV2(at)]).then(([stats, status]) =>
    boxChanges(stats, status),
  );
const readAhead = (at: WorkAt) => placeGitAheadBehind(at);

/** Everything the branch changed since it left its base, committed or not. */
export function useBoxChanges(at: WorkAt | null, tick: number) {
  return useMachineRead("box-changes", at, readChanges, tick);
}

/** Where the branch stands against the one it pushes to. */
export function useBoxAhead(at: WorkAt | null, tick: number) {
  return useMachineRead("box-ahead", at, readAhead, tick);
}
