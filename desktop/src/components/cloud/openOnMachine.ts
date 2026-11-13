// Opening something from the workspace frame into the machine's own tabs.
//
// The header and the right panel are the workspace's, on a laptop or on a
// machine alike; the tabs they open into are not. On this laptop a file opens
// in the editor; with a machine in front it has to open as a tab of the
// machine's workspace, or it lands behind it in an editor nobody can see.
// The frame says what to open; the machine workspace that is mounted decides
// where. A window event rather than a prop chain because the two meet only
// at App, which already owns too much.

import { useEffect, useRef } from "react";

export type MachineOpen =
  /** A file of the project, to edit. Local-spelled absolute path. */
  | { kind: "file"; path: string }
  /** A scope's diff: the working tree (`sha` null) or one commit, on a file
   *  relative to the project (or its summary when `path` is null). */
  | { kind: "diff"; sha: string | null; path: string | null };

const EVENT = "aura:open-on-machine";

export function openOnMachine(req: MachineOpen): void {
  window.dispatchEvent(new CustomEvent<MachineOpen>(EVENT, { detail: req }));
}

/** Handle opens while mounted. The latest handler is used without re-binding. */
export function useOpenOnMachine(handler: (req: MachineOpen) => void): void {
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => {
    const on = (e: Event) => {
      const req = (e as CustomEvent<MachineOpen>).detail;
      if (req) latest.current(req);
    };
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);
}

/** `path` relative to `root`, for a path the panel spelled absolute. */
export function underRoot(root: string, path: string): string {
  const base = root.replace(/\/$/, "");
  return path.startsWith(base + "/") ? path.slice(base.length + 1) : path;
}
