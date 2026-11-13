// What the open machine puts in the work header.
//
// The machine's name is the workspace's title, so it sits where every
// workspace's title sits — the header above the tabs — and its details open
// from there. The header is drawn by App around whichever work surface is in
// front, and the machine workspace is drawn inside it as an overlay, so the
// two meet here: the workspace publishes what its details need, and the
// header's title reads it. One machine is in front at a time (each popped-out
// window is its own page with its own copy of this), so one slot is enough.

import { useSyncExternalStore } from "react";

import type { Machine } from "../../lib/api";
import type { CloudSessionState } from "../ui/cloud-workspace";

export type RemoteHeader = {
  machine: Machine | null;
  /** The repository this workspace is filed under, by name. */
  repository: string | null;
  /** Whether the machine is up, in the cloud status words — see `machineState`. */
  state: CloudSessionState;
  onClose: () => void;
  onPopOut?: () => void;
  onMachineChanged: (m: Machine) => void;
  /** Open a shell on the machine. Absent while nothing can be dialled. */
  onOpenShell?: () => Promise<void>;
  /** Show what is running on the machine, and what can be started there. */
  onOpenJoin?: () => void;
};

let current: RemoteHeader | null = null;
const listeners = new Set<() => void>();

export function publishRemoteHeader(next: RemoteHeader | null): void {
  current = next;
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useRemoteHeader(): RemoteHeader | null {
  return useSyncExternalStore(subscribe, () => current);
}
