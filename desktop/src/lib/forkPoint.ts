// Where "Fork chat" branches from when nobody picked a message.
//
// The per-message fork (More → Fork on a bubble) already exists and takes an
// index into `session.chat`. Forking from the tab menu or ⌘⌥↩ has no bubble
// in hand, so it forks at the latest settled reply — the last turn that is
// not the user's own words. A chat whose last turn is a user message that
// hasn't been answered yet forks just before it: the unanswered question is
// still in flight and cloning it would make the fork wait for a reply that
// only the original will get.

import type { ChatTurn } from "./api";

/** Index into `chat` of the latest settled (non-user) turn, or -1 when the
 *  conversation has no reply to branch from yet. */
export function latestSettledTurnIndex(chat: readonly ChatTurn[] | undefined): number {
  if (!chat || chat.length === 0) return -1;
  for (let i = chat.length - 1; i >= 0; i--) {
    if (chat[i]!.role !== "user") return i;
  }
  return -1;
}
