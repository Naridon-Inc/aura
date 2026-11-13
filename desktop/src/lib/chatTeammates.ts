// The teammates a chat's `@` list offers, by chat session.
//
// A cloud workspace whose chat runs on one of the org's machines is shown in
// the same chat view local work uses, and that view's composer only knows
// files, tasks and the terminal. The workspace knows who is on the team, so
// it hands their rows in here under the chat's session id and the composer
// lists them first: picking one puts their GitHub login in, which is what
// makes a message theirs and not the agent's.

import { useSyncExternalStore } from "react";

import type { ComposerSuggestion } from "../components/ui/composerSuggestions";

const NONE: readonly ComposerSuggestion[] = [];

let bySession = new Map<string, readonly ComposerSuggestion[]>();
const subs = new Set<() => void>();

function same(a: readonly ComposerSuggestion[], b: readonly ComposerSuggestion[]): boolean {
  return (
    a.length === b.length &&
    a.every((x, i) => x.id === b[i]!.id && x.label === b[i]!.label && x.detail === b[i]!.detail && x.insertText === b[i]!.insertText)
  );
}

/** The rows the chat behind `sessionId` offers after an `@`. An empty list
 *  takes them away. Telling it the same rows again changes nothing. */
export function setChatTeammates(sessionId: string, rows: readonly ComposerSuggestion[]): void {
  const had = bySession.get(sessionId) ?? NONE;
  if (same(had, rows)) return;
  const next = new Map(bySession);
  if (rows.length) next.set(sessionId, rows);
  else next.delete(sessionId);
  bySession = next;
  for (const l of subs) l();
}

/** The rows a chat offers now. */
export function chatTeammates(sessionId: string | null | undefined): readonly ComposerSuggestion[] {
  return (sessionId && bySession.get(sessionId)) || NONE;
}

function subscribe(l: () => void) {
  subs.add(l);
  return () => {
    subs.delete(l);
  };
}

/** The rows a chat offers, kept current. */
export function useChatTeammates(sessionId: string | null | undefined): readonly ComposerSuggestion[] {
  return useSyncExternalStore(
    subscribe,
    () => chatTeammates(sessionId),
    () => chatTeammates(sessionId),
  );
}
