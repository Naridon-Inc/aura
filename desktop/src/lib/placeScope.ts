// Which place the window is in, and which workspaces belong to it.
//
// The window stands in one place at a time: this computer, the cloud, or a
// machine somewhere else. Every list of workspaces — the sidebar, the
// dashboard, the workspaces page, the palette — shows only the place you are
// in, and the place switcher in the account menu is the way across. One
// answer, here, so no two lists can disagree about where you are.
//
// The cloud wins over a machine: the cloud covers the whole window, sidebar
// included. A machine counts only while it is in front — one held open behind
// a page or your own files is one click away, but you are not standing in it.

import { useSyncExternalStore } from "react";

import { getActiveMachine, subscribeActiveMachine } from "./activeMachine";
import { cloudPlaceNow, leaveCloud, openCloud, useCloudPlace } from "./cloudPlace";

/** Where the window is standing. */
export type PlaceScope =
  | { kind: "local" }
  | { kind: "cloud" }
  | { kind: "machine"; machineId: string };

export const LOCAL_SCOPE: PlaceScope = { kind: "local" };
export const CLOUD_SCOPE: PlaceScope = { kind: "cloud" };

/** Where a workspace lives. A local checkout or copy says neither; a cloud
 *  workspace says `cloud`; one on a connected machine names the machine. */
export type WorkspaceHome = {
  cloud?: boolean;
  machineId?: string | null;
};

/** The place, from the two things that decide it: whether the cloud is open,
 *  and which machine (if any) is in front. */
export function placeScopeOf(input: {
  cloudOpen: boolean;
  machineId: string | null | undefined;
}): PlaceScope {
  if (input.cloudOpen) return CLOUD_SCOPE;
  if (input.machineId) return { kind: "machine", machineId: input.machineId };
  return LOCAL_SCOPE;
}

/** A stable string per place: `local`, `cloud`, `machine:<user@host>`. */
export function placeScopeKey(scope: PlaceScope): string {
  return scope.kind === "machine" ? `machine:${scope.machineId}` : scope.kind;
}

export function sameScope(a: PlaceScope, b: PlaceScope): boolean {
  return placeScopeKey(a) === placeScopeKey(b);
}

/** Does a workspace living at `home` belong to the place? */
export function belongsToScope(scope: PlaceScope, home: WorkspaceHome): boolean {
  const cloud = home.cloud === true;
  const machineId = home.machineId ?? null;
  switch (scope.kind) {
    case "local":
      return !cloud && machineId === null;
    case "cloud":
      return cloud;
    case "machine":
      return !cloud && machineId === scope.machineId;
  }
}

/** The rows of a list that belong to the place, in their order. */
export function filterToScope<T>(
  scope: PlaceScope,
  rows: readonly T[],
  homeOf: (row: T) => WorkspaceHome,
): T[] {
  return rows.filter((row) => belongsToScope(scope, homeOf(row)));
}

function focusedMachineId(): string | null {
  return getActiveMachine().machineId;
}

/** The place the window is in, re-rendering when it changes. */
export function usePlaceScope(): PlaceScope {
  const cloud = useCloudPlace();
  const machineId = useSyncExternalStore(
    subscribeActiveMachine,
    focusedMachineId,
    focusedMachineId,
  );
  // Rebuilt only when the answer changes, so a consumer can key effects on it.
  const key = cloud.open ? "cloud" : machineId ? `machine:${machineId}` : "local";
  return scopeForKey(key);
}

const scopeCache = new Map<string, PlaceScope>();
function scopeForKey(key: string): PlaceScope {
  let scope = scopeCache.get(key);
  if (!scope) {
    scope =
      key === "cloud"
        ? CLOUD_SCOPE
        : key === "local"
          ? LOCAL_SCOPE
          : { kind: "machine", machineId: key.slice("machine:".length) };
    scopeCache.set(key, scope);
  }
  return scope;
}

/** The place, read once outside React. */
export function placeScopeNow(): PlaceScope {
  return placeScopeOf({ cloudOpen: cloudPlaceNow().open, machineId: focusedMachineId() });
}

/** Asks the window to step out of whatever machine is in front without
 *  leaving it: its sessions keep running and it stays one pick away. */
export const STEP_OUT_OF_MACHINE_EVENT = "aura:step-out-of-machine";

/** Go to a place — what the place switcher does. */
export function goToPlace(scope: PlaceScope): void {
  if (typeof window === "undefined") return;
  switch (scope.kind) {
    case "local":
      leaveCloud();
      window.dispatchEvent(new CustomEvent(STEP_OUT_OF_MACHINE_EVENT));
      return;
    case "cloud":
      window.dispatchEvent(new CustomEvent(STEP_OUT_OF_MACHINE_EVENT));
      openCloud("home");
      return;
    case "machine":
      leaveCloud();
      // The same request a machine's row makes when clicked.
      window.dispatchEvent(
        new CustomEvent("aura:open-remote-workspace", {
          detail: { machineId: scope.machineId },
        }),
      );
      return;
  }
}
