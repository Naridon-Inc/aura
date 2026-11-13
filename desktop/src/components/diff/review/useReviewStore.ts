// The review stores as React reads them: one file's comments (agents' among
// them), whether a comment has an edit open, the chat a diff hands comments
// to, and whether a comment is waiting in that chat's composer.

import { useEffect, useSyncExternalStore } from "react";

import {
  composerAttachmentKey,
  subscribeComposerAttachments,
} from "../../../lib/composerAttachments";
import { watchAgentComments } from "../../../lib/diffReview/agentComments";
import { commentChatTarget, commentFileName } from "../../../lib/diffReview/commentChat";
import {
  getDraft,
  listComments,
  subscribeComments,
  subscribeDrafts,
  type ReviewComment,
} from "../../../lib/diffReview/reviewComments";

/** One file's comments. While it is open, agents' comments on the checkout
 *  are picked up as they arrive. */
export function useFileComments(workspace: string, path: string): ReviewComment[] {
  useEffect(() => watchAgentComments(workspace), [workspace]);
  return useSyncExternalStore(subscribeComments, () => listComments(workspace, path));
}

/** The text being written in a comment's editor, if one is open for it. */
export function useDraftBody(id: string): string | undefined {
  return useSyncExternalStore(subscribeDrafts, () => getDraft(id)?.body);
}

export function useCommentChatTarget(): string | null {
  return useSyncExternalStore(subscribeComposerAttachments, commentChatTarget);
}

export function useInComposer(c: ReviewComment): { target: string | null; inComposer: boolean } {
  const target = useCommentChatTarget();
  const key = useSyncExternalStore(subscribeComposerAttachments, () =>
    target ? composerAttachmentKey(target) : "",
  );
  return { target, inComposer: !!target && key.split("\n").includes(commentFileName(c)) };
}
