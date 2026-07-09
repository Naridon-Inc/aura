// The runnable commands that enabled web extensions contribute, surfaced to the
// Command Palette. Mirrors the tiny pub/sub shape the rest of the vscodeExt
// layer uses (vsixStore) so a React surface can subscribe without a heavier
// state library. The extHostRuntime owns the writes (it learns the real command
// set back from the worker after activation); the palette only reads.

import { useEffect, useState } from "react";

/** Which host runs a command — the Web-Worker host (web extensions) or the Node
 *  host (language/program extensions). Drives where `executeExtCommand` dispatches. */
export type ExtCommandSource = "worker" | "node";

/** One command a non-engineer can run from the palette. */
export type ExtCommand = {
  /** The command id, e.g. `helloworld-web-sample.helloWorld`. */
  command: string;
  /** Palette label, already prefixed with `Category: ` when one is declared. */
  title: string;
  /** Owning extension id, for grouping / attribution. */
  extId: string;
  /** Owning extension display name, shown as the palette hint. */
  extName: string;
  /** Which host owns it (defaults to the worker for back-compat). */
  source?: ExtCommandSource;
};

const subs = new Set<() => void>();
/** Per-host command sets, kept separate so one host's reconcile never wipes the
 *  other's commands; the published list is their union. */
const bySource: Record<ExtCommandSource, ExtCommand[]> = { worker: [], node: [] };
let commands: ExtCommand[] = [];

function notify(): void {
  subs.forEach((fn) => fn());
}

function republish(): void {
  // De-dupe by (extId, command) across BOTH hosts: a re-activation refresh from
  // the SAME extension collapses to one entry, but two DIFFERENT extensions that
  // happen to declare the same command id both survive (keying by command id
  // alone silently dropped the second). The owning source is preserved.
  const byKey = new Map<string, ExtCommand>();
  for (const c of [...bySource.worker, ...bySource.node]) {
    byKey.set(`${c.source ?? "worker"}\n${c.extId}\n${c.command}`, c);
  }
  commands = [...byKey.values()];
  notify();
}

/** Replace one host's command set (called by its runtime after a reconcile). */
export function setExtCommandsForSource(source: ExtCommandSource, next: ExtCommand[]): void {
  bySource[source] = next.map((c) => ({ ...c, source }));
  republish();
}

/** Replace the Web-Worker host's command set (back-compat shim → worker source). */
export function setExtCommands(next: ExtCommand[]): void {
  setExtCommandsForSource("worker", next);
}

export function getExtCommands(): ExtCommand[] {
  return commands;
}

/** Subscribe outside React (the runtime doesn't need it, but kept symmetric). */
export function subscribeExtCommands(cb: () => void): () => void {
  subs.add(cb);
  return () => {
    subs.delete(cb);
  };
}

/** Reactive list of runnable extension commands for the palette. */
export function useExtCommands(): ExtCommand[] {
  const [val, setVal] = useState<ExtCommand[]>(commands);
  useEffect(() => {
    const fn = () => setVal(commands);
    subs.add(fn);
    fn();
    return () => {
      subs.delete(fn);
    };
  }, []);
  return val;
}
