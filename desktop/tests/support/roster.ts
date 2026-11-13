// The sidebar's workspace list is one entry file and the modules under
// components/nav/roster/ it is assembled from. A scan pinning what the list
// does reads all of them as one source, so moving a row or a menu into its own
// module can never make a pinned behaviour look absent, or hide a second copy
// of it from an occurs-exactly-N count.

import { readSrc, strippedSrcTree } from "./code";

/** WorkspaceRoster.tsx followed by every nav/roster module, comments removed. */
export async function readRosterSrc(): Promise<string> {
  const entry = await readSrc("components/WorkspaceRoster.tsx");
  const parts = await strippedSrcTree("components/nav/roster/*.{ts,tsx}");
  const modules = [...parts.keys()].sort().map((rel) => parts.get(rel) ?? "");
  // The entry must be the list itself, not a stray file of the same name, and
  // the folder must have been found at all: an empty glob would leave the
  // entry alone and quietly shrink every count.
  if (!entry.includes("export function WorkspaceRoster(") || modules.length === 0) {
    throw new Error("the workspace list's sources were not found");
  }
  return [entry, ...modules].join("\n");
}
