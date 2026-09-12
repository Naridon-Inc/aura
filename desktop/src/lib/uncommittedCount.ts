// How many files in a project are changed but not committed — for a menu
// label that is built synchronously.
//
// A right-click menu is assembled on render, and `git status` is an IPC away.
// So the count is cached per project root: reading it returns whatever is
// known right now (or null) and, when the figure is stale, kicks off a refresh
// so the next render is right. Nothing here writes to git.

import { api } from "./api";

const TTL_MS = 5_000;

type Entry = { count: number; at: number; inflight: boolean };
const cache = new Map<string, Entry>();

/** Sync read. Null until the first refresh has answered. */
export function peekUncommittedCount(root: string | null | undefined): number | null {
  if (!root) return null;
  const hit = cache.get(root);
  const stale = !hit || Date.now() - hit.at > TTL_MS;
  if (stale && !hit?.inflight) void refreshUncommittedCount(root);
  return hit ? hit.count : null;
}

/** Ask git and remember the answer. Resolves to the count (or null when git
 *  couldn't answer). */
export async function refreshUncommittedCount(root: string): Promise<number | null> {
  const prev = cache.get(root);
  cache.set(root, { count: prev?.count ?? 0, at: prev?.at ?? 0, inflight: true });
  try {
    const entries = await api.gitStatusV2(root);
    const count = entries.length;
    cache.set(root, { count, at: Date.now(), inflight: false });
    return count;
  } catch {
    cache.set(root, { count: prev?.count ?? 0, at: Date.now(), inflight: false });
    return prev ? prev.count : null;
  }
}

/** The menu row's label: "Also reset files (3)", or without the figure while
 *  it is still being counted. */
export function resetFilesLabel(count: number | null): string {
  return count == null ? "Also reset files" : `Also reset files (${count})`;
}
