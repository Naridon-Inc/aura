//! Repo-root context for the chat-rendering modules.
//!
//! File references inside markdown and tool cards resolve relative paths
//! against the chat session's repo root. The provider lives in
//! `ManagerChatView`; the consumers (Markdown's `FileRef`, tool cards) read
//! it through this hook so they don't have to thread the root down by prop.

import * as React from "react";

/** Absolute repo root for the active chat session, or null when unknown. */
export const ChatRepoRootContext = React.createContext<string | null>(null);

/** Read the active chat session's repo root (null when none is set). */
export function useChatRepoRoot(): string | null {
  return React.useContext(ChatRepoRootContext);
}

/** Resolve a possibly-relative path against the session repo root. Mirrors
 *  the old in-file helper so `FileRef`/tool cards open the right absolute
 *  path regardless of whether the model emitted an absolute or relative one. */
export function resolveAgainstRepo(repoRoot: string | null, rel: string): string {
  if (!rel) return rel;
  if (rel.startsWith("/")) return rel;
  if (!repoRoot) return rel;
  const root = repoRoot.replace(/\/+$/, "");
  const clean = rel.replace(/^\.\//, "");
  return `${root}/${clean}`;
}
