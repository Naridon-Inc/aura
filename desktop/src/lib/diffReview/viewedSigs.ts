// The changed-files list decides "viewed" the same way the diff pane does: it
// reads each marked file's patch through the call the pane uses and hashes it.
// Only files that carry a mark are read, so a list with nothing viewed costs
// no git at all.

import { getViewed, patchSig, viewedStateBySig } from "./viewedFiles";

export type ReadPatch = (workspace: string, path: string) => Promise<string>;

/** The patch hash of every marked file among `paths`. A file whose patch
 *  can't be read is left out, and so reads as not viewed. */
export async function readViewedSigs(
  workspace: string,
  paths: readonly string[],
  readPatch: ReadPatch,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const marked = paths.filter((p) => getViewed(workspace, p));
  await Promise.all(
    marked.map(async (p) => {
      try {
        out.set(p, patchSig(await readPatch(workspace, p)));
      } catch {
        /* unreadable — left out, so not viewed */
      }
    }),
  );
  return out;
}

/** The list's answer for one file, from the hashes `readViewedSigs` read. */
export function listedAsViewed(
  workspace: string,
  path: string,
  sigs: ReadonlyMap<string, string>,
): boolean {
  return viewedStateBySig(workspace, path, sigs.get(path)) === "viewed";
}

export function sameSigs(a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}
