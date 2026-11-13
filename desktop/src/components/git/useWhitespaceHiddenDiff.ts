// The unified view's patch with whitespace changes hidden: git's own `-w` read
// of the same file. It is read only while that view shows with whitespace
// hidden, and again whenever the plain patch changes, since both describe the
// same edit. A read that fails leaves the plain patch on screen.

import { useEffect, useState } from "react";

import * as work from "../../lib/place/workApi";

/** git's `-w` patch for the file, or `null` while it isn't wanted or hasn't
 *  been read yet. */
export function useWhitespaceHiddenDiff(
  repoRoot: string,
  path: string,
  wanted: boolean,
  diff: string | null,
): string | null {
  const [read, setRead] = useState<{ key: string; patch: string } | null>(null);
  const key = `${repoRoot}\u0000${path}\u0000${diff ?? ""}`;

  useEffect(() => {
    if (!wanted || diff === null) return;
    let alive = true;
    work
      .gitDiff(repoRoot, path, undefined, true)
      .then((patch) => alive && setRead({ key, patch }))
      .catch(() => alive && setRead(null));
    return () => {
      alive = false;
    };
  }, [wanted, key, repoRoot, path, diff]);

  return wanted && read?.key === key ? read.patch : null;
}

/** Whether a patch has any hunk left to draw. `-w` prints nothing for a
 *  change that is only whitespace. */
export function hasHunks(patch: string): boolean {
  return /^@@ /m.test(patch);
}
