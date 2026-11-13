// What the diff review leaves on the changed-files list: which files are
// marked as viewed and how many review comments each file holds. Both are
// kept on this device.
//
// "Viewed" is decided as the diff pane decides it, by the hash of the file's
// patch read through the same call. Marked files are read again when the
// list changes, after a commit or checkout, and on the list's own beat while
// the window is shown, so an edit that keeps the line counts the same still
// clears the mark here as it does in the pane.

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";

import type { ChangedFile } from "../../lib/useGitChanges";
import * as work from "../../lib/place/workApi";
import { watchAgentComments } from "../../lib/diffReview/agentComments";
import { listComments, shownOnDiff, subscribeComments } from "../../lib/diffReview/reviewComments";
import { subscribeViewed, viewedVersion } from "../../lib/diffReview/viewedFiles";
import { listedAsViewed, readViewedSigs, sameSigs } from "../../lib/diffReview/viewedSigs";

/** The same beat the changed-files list polls git on. */
export const VIEWED_RECHECK_MS = 4000;

const readPatch = (workspace: string, path: string) => work.gitDiff(workspace, path);

export function useChangeReviewMarks(
  repoRoot: string,
  paths: readonly string[],
): {
  isViewed: (file: ChangedFile) => boolean;
  commentCount: (path: string) => number;
} {
  const viewed = useSyncExternalStore(subscribeViewed, viewedVersion);
  const comments = useSyncExternalStore(subscribeComments, () => listComments(repoRoot));
  // An agent's comments count here as soon as they arrive, diff open or not.
  useEffect(() => watchAgentComments(repoRoot), [repoRoot]);
  const [sigs, setSigs] = useState<ReadonlyMap<string, string>>(() => new Map());
  // One string, so a new array holding the same files reads nothing again.
  const pathKey = paths.join("\n");

  useEffect(() => {
    let alive = true;
    const list = pathKey ? pathKey.split("\n") : [];
    const check = () => {
      if (typeof document !== "undefined" && document.hidden) return;
      void readViewedSigs(repoRoot, list, readPatch).then((next) => {
        if (alive) setSigs((prev) => (sameSigs(prev, next) ? prev : next));
      });
    };
    check();
    const timer = window.setInterval(check, VIEWED_RECHECK_MS);
    window.addEventListener("aura:git-changed", check);
    return () => {
      alive = false;
      window.clearInterval(timer);
      window.removeEventListener("aura:git-changed", check);
    };
  }, [repoRoot, pathKey, viewed]);

  const isViewed = useCallback(
    (file: ChangedFile) => listedAsViewed(repoRoot, file.path, sigs),
    // `viewed` changes whenever a mark does, so the list re-reads them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [repoRoot, sigs, viewed],
  );

  const counts = useMemo(() => {
    const out = new Map<string, number>();
    for (const c of comments) {
      if (c.state === "draft" || !shownOnDiff(c)) continue;
      out.set(c.filePath, (out.get(c.filePath) ?? 0) + 1);
    }
    return out;
  }, [comments]);
  const commentCount = useCallback((path: string) => counts.get(path) ?? 0, [counts]);

  return { isViewed, commentCount };
}
