// One shared read of "which agent sessions exist in this repo".
//
// Sixteen call sites asked `claude_list_sessions` independently: Overview,
// Wrapped, the team feed, the time machine, session detail, the intent
// inspector, git history, both manager surfaces, the resume dialog, the task
// launcher. Each one is a directory walk over `~/.claude/projects/<repo>/`
// parsing the head and tail of every JSONL transcript — and the panes are
// hidden with a CSS class rather than unmounted, so several of them were doing
// it at once, for the same repo, about the same files.
//
// Three of those sites had grown their own private cache (a module-level Map
// in SessionsPane, a `sessions:claude:` key in SessionDetailPane), which is the
// usual sign the shape belongs one level down. Now they share one, and a list
// read for Overview is already warm when you open Wrapped from it.
//
// What must NOT go through the freshness window: anything binding to a session
// that was just created. AgentSurface waits 500 ms for the CLI to write its
// first line and then looks for that file — an eight-second-old list simply
// does not contain it, and the agent would bind to the wrong transcript or
// none. Those callers use `refreshSessions`, which reads past the window and
// publishes the result so every other surface converges on it too.

import { api, type ClaudeSession } from "./api";
import { dropShared, peekShared, readShared, sharedReader } from "./sharedRead";

/** Under ManagerSurface's 12s poll and OverviewPane's 20s refresh gap, so the
 *  surfaces overlapping inside one cycle collapse to a single walk while the
 *  next cycle still does a real read. */
const FRESH_MS = 8_000;

const sessions = sharedReader(
  (repoRoot: string) => api.claudeListSessions(repoRoot),
  FRESH_MS,
);

/** The repo's agent sessions, shared with every other surface asking.
 *
 *  Rejects if the walk failed. An empty list is a real answer — "you have not
 *  run an agent here" — and handing it back for a failed read would tell the
 *  Sessions page you have no history when the truth is we could not look. Each
 *  caller keeps its own catch and decides what a failure means for itself. */
export function fetchSessions(repoRoot: string): Promise<ClaudeSession[]> {
  return readShared(sessions, repoRoot);
}

/** Read past the window and publish the result to everyone else.
 *
 *  For a caller that has just changed the set of sessions, or is resolving one
 *  that was created moments ago: a freshness window is a promise that nothing
 *  has changed, and here something has. Because the forced read lands in the
 *  shared cache, the other surfaces pick up the new session instead of holding
 *  a list from before it existed. */
export function refreshSessions(repoRoot: string): Promise<ClaudeSession[]> {
  return readShared(sessions, repoRoot, true);
}

/** What was last read, however old — for a surface that would otherwise paint
 *  a spinner over a list it already has. */
export function peekSessions(repoRoot: string): ClaudeSession[] | undefined {
  return peekShared(sessions, repoRoot);
}

/** Forget a repo's sessions (or every repo's), so the next read is real. */
export function invalidateSessions(repoRoot?: string): void {
  dropShared(sessions, repoRoot);
}
