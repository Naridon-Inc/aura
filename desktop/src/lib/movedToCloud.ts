// A local workspace whose work moved to the team's cloud computer.
//
// After "Move to cloud", the branch, its uncommitted edits (as a commit) and
// the conversation are on the cloud computer, which carries on from there.
// The folder on this laptop stays until the person archives it, so its row
// has to say the work isn't here any more, and where it went. That is all
// this keeps: per folder, the cloud workspace and the computer's name.
//
// It lives in this laptop's storage because it is about this laptop's folder;
// the cloud workspace itself already records who made it and from where.

import { useSyncExternalStore } from "react";

export type MovedToCloud = {
  workspaceId: string;
  /** The computer's name, as the team knows it. */
  machine: string;
  branch: string;
  /** Milliseconds since the epoch. */
  at: number;
};

type Store = Pick<Storage, "getItem" | "setItem">;

const KEY = "aura.movedToCloud.v1";
const EVENT = "aura:moved-to-cloud";
/** Old entries are dropped past this many, oldest first. */
const KEEP = 200;

const norm = (path: string) => path.trim().replace(/\/+$/, "");

function isMoved(v: unknown): v is MovedToCloud {
  const m = v as MovedToCloud | null;
  return (
    !!m &&
    typeof m.workspaceId === "string" &&
    !!m.workspaceId &&
    typeof m.machine === "string" &&
    typeof m.branch === "string" &&
    typeof m.at === "number"
  );
}

export function readMovedToCloud(store: Pick<Storage, "getItem">): Record<string, MovedToCloud> {
  let raw: string | null = null;
  try {
    raw = store.getItem(KEY);
  } catch {
    return {};
  }
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, MovedToCloud> = {};
    for (const [path, v] of Object.entries(parsed ?? {})) if (isMoved(v)) out[path] = v;
    return out;
  } catch {
    return {};
  }
}

function write(store: Store, all: Record<string, MovedToCloud>): void {
  const kept = Object.entries(all)
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, KEEP);
  try {
    store.setItem(KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    /* storage full or blocked: the row just won't say it moved */
  }
  try {
    if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
      window.dispatchEvent(new Event(EVENT));
    }
  } catch {
    /* no DOM to tell: rows re-read on their next render */
  }
}

export function movedToCloudOf(path: string, store: Pick<Storage, "getItem"> = localStorage): MovedToCloud | null {
  return readMovedToCloud(store)[norm(path)] ?? null;
}

export function rememberMovedToCloud(path: string, moved: MovedToCloud, store: Store = localStorage): void {
  const all = readMovedToCloud(store);
  all[norm(path)] = moved;
  write(store, all);
}

/** The folder is worked in here again (or the person said so). */
export function forgetMovedToCloud(path: string, store: Store = localStorage): void {
  const all = readMovedToCloud(store);
  if (!(norm(path) in all)) return;
  delete all[norm(path)];
  write(store, all);
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener(EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

let snapshot: { raw: string | null; value: Record<string, MovedToCloud> } = { raw: null, value: {} };

function current(): Record<string, MovedToCloud> {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    raw = null;
  }
  if (raw !== snapshot.raw) snapshot = { raw, value: readMovedToCloud(localStorage) };
  return snapshot.value;
}

/** Where this folder's work went, kept current as it changes. */
export function useMovedToCloud(path: string | null | undefined): MovedToCloud | null {
  const all = useSyncExternalStore(subscribe, current, current);
  return path ? (all[norm(path)] ?? null) : null;
}
