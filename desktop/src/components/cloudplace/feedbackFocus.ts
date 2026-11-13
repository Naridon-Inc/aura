// The thread a notification was about, waiting for its workspace to open.
// Tapping "Priya replied in HI" opens HI; HI then finds this, opens that
// turn's comments and brings them into view (or the Comments tab, for a
// comment on the workspace itself), and takes it so it happens once.

import { useSyncExternalStore } from "react";

export type FeedbackFocus = {
  workspaceId: string;
  /** The turn the thread is on; null for a comment on the workspace. */
  messageId: string | null;
  commentId: string | null;
  /** So asking for the same thread twice still moves to it. */
  seq: number;
};

let pending: FeedbackFocus | null = null;
let seq = 0;
const listeners = new Set<() => void>();

export function focusFeedback(workspaceId: string, messageId: string | null, commentId: string | null) {
  seq += 1;
  pending = { workspaceId, messageId, commentId, seq };
  for (const l of listeners) l();
}

/** The pending focus for this workspace, if any. */
export function useFeedbackFocus(workspaceId: string): FeedbackFocus | null {
  const now = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => pending,
  );
  return now && now.workspaceId === workspaceId ? now : null;
}

/** It has been acted on. */
export function takeFeedbackFocus(f: FeedbackFocus) {
  if (pending?.seq !== f.seq) return;
  pending = null;
  for (const l of listeners) l();
}

/** Bring a turn's comments (or one comment) into view, once it is drawn: a
 *  conversation still being read draws it a moment later. Gives up after a
 *  few seconds. With no turn, it looks for the comment alone (one on the
 *  workspace, in the Comments tab). */
export function scrollToFeedback(messageId: string | null, commentId: string | null, tries = 40) {
  const find = () => {
    const comment = commentId
      ? document.querySelector<HTMLElement>(`[data-comment-id="${CSS.escape(commentId)}"]`)
      : null;
    const bar = messageId
      ? document.querySelector<HTMLElement>(`[data-feedback-for="${CSS.escape(messageId)}"]`)
      : null;
    return comment ?? bar?.closest<HTMLElement>(".ui-cloud-turn, .ui-feedback-turn") ?? bar;
  };
  const step = (left: number) => {
    const el = find();
    if (!el) {
      if (left > 0) setTimeout(() => step(left - 1), 100);
      return;
    }
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    el.removeAttribute("data-feedback-flash");
    void el.offsetWidth;
    el.setAttribute("data-feedback-flash", "");
    setTimeout(() => el.removeAttribute("data-feedback-flash"), 1800);
  };
  requestAnimationFrame(() => step(tries));
}
