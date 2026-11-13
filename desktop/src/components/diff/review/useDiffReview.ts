// What a diff pane needs to carry review comments and the Viewed mark for one
// file of one workspace.

import { useCallback, useMemo, useSyncExternalStore } from "react";

import { addDraft, type CommentSide } from "../../../lib/diffReview/reviewComments";
import {
  markViewed,
  subscribeViewed,
  unmarkViewed,
  viewedState,
  viewedVersion,
} from "../../../lib/diffReview/viewedFiles";
import type { ReviewHost } from "./useMonacoReview";
import { useFileComments } from "./useReviewStore";

export function useDiffReview(workspace: string, path: string): ReviewHost {
  const comments = useFileComments(workspace, path);
  const onAdd = useCallback(
    (side: CommentSide, line: number, end: number | undefined, code: string) => {
      addDraft({
        workspace,
        filePath: path,
        lineNumber: line,
        endLineNumber: end,
        side,
        suggestionBaseCode: code,
      });
    },
    [workspace, path],
  );
  return useMemo(() => ({ comments, onAdd, repoRoot: workspace }), [comments, onAdd, workspace]);
}

/** Whether the file's change now on screen is the one marked as viewed, and
 *  the toggle. A change made after marking reads as not viewed. */
export function useViewed(workspace: string, path: string, patch: string) {
  useSyncExternalStore(subscribeViewed, viewedVersion);
  const viewed = viewedState(workspace, path, patch) === "viewed";
  const toggle = useCallback(() => {
    if (viewed) unmarkViewed(workspace, path);
    else markViewed(workspace, path, patch);
  }, [viewed, workspace, path, patch]);
  return { viewed, toggle };
}
