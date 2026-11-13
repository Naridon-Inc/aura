// Every path in the project, for the name filter. Filtering walks the whole
// project, not just the folders you happen to have opened — the box has to
// mean it. Fetched the first time you type, thrown away when the tree is read
// again or the project changes. It is the same index the @-mention picker uses.

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../../lib/api";

export function useProjectIndex(root: string, wanted: boolean) {
  const [index, setIndex] = useState<string[] | null>(null);
  const [indexing, setIndexing] = useState(false);
  // A ref, not state: as a dependency it would re-run the effect the moment
  // it flipped and tear down the very request it guards.
  const inFlight = useRef(false);
  const rootRef = useRef(root);

  useEffect(() => {
    rootRef.current = root;
    inFlight.current = false;
    setIndex(null);
  }, [root]);

  useEffect(() => {
    if (!wanted || index !== null || inFlight.current) return;
    inFlight.current = true;
    setIndexing(true);
    const forRoot = root;
    api
      .fsFindFiles(forRoot)
      .then((paths) => {
        if (rootRef.current === forRoot) setIndex(paths);
      })
      .catch(() => {
        // No index (not a git repo, or git is unavailable): filter what is
        // already on screen rather than show nothing.
        if (rootRef.current === forRoot) setIndex([]);
      })
      .finally(() => {
        inFlight.current = false;
        setIndexing(false);
      });
  }, [wanted, root, index]);

  /** Paths may have moved — read the index again on the next filter. */
  const reset = useCallback(() => setIndex(null), []);

  return { index, indexing, reset };
}
