// Worktree-scoping + burst-dedup for Claude Code session auto-resume.
//
// `claude_list_sessions` deliberately UNIONS every sibling git worktree and the
// parent checkout (cmd_claude_sessions.rs): a manual /resume picker should be
// able to surface a transcript no matter which checkout authored it. But
// AUTO-resume (the mount-resume effect + "Start all") must NOT inherit that
// union — if it does, a tab bound to worktree `granada` silently reopens the
// newest session on disk, which may have been authored in sibling worktree
// `zagreb` or the main repo. Observed live: granada's three tabs auto-resumed
// two `zagreb` sessions (the same one twice) + one main-repo session, and
// granada had no session of its own at all.
//
// So auto-resume is gated here on two invariants:
//   1. own-worktree only — a candidate session is eligible only if it was
//      launched from inside this exact `repoRoot`.
//   2. no in-flight duplicate — two tabs restoring in the same burst can
//      resolve the SAME candidate (both bound to it, or both falling back to
//      the same newest-on-disk file); running `claude --resume <id>` twice
//      points two PTYs at one conversation. The first to claim an id keeps it;
//      a sibling that lands on an in-flight id starts fresh instead.

import { api } from "./api";
import type { ClaudeSession } from "./api";

function stripTrailingSlash(p: string): string {
  return p.replace(/\/+$/, "");
}

/** Mirror Claude Code's `~/.claude/projects` dir encoding: every character that
 *  isn't ASCII-alphanumeric collapses to a single `-`, one-for-one (NOT run-
 *  collapsed, so `/.aura` → `--aura`). Verified against live dirs:
 *  `/Users/you/.aura/worktrees/…/zagreb`
 *  → `-Users-you--aura-worktrees-…-zagreb`, and
 *  `/Users/you/Documents/New Git` → `-Users-you-Documents-New-Git`.
 *  NB the Rust `encode_path` (cmd_claude_sessions.rs) only maps `/` and ` ` and
 *  so does NOT match on-disk for dotted paths — we can't reuse it here. */
function encodeProjectDir(p: string): string {
  return stripTrailingSlash(p).replace(/[^A-Za-z0-9]/g, "-");
}

/** The encoded project-dir a transcript physically lives in, pulled straight
 *  from its `file_path` (`~/.claude/projects/<encoded-root>/<id>.jsonl`). This
 *  is the ONE field the lister cannot rewrite — see {@link isOwnWorktreeSession}
 *  for why cwd can't be trusted. Returns null if the path isn't a projects
 *  transcript. */
function projectDirOf(filePath: string | undefined | null): string | null {
  if (!filePath) return null;
  const norm = filePath.replace(/\\/g, "/");
  const marker = "/.claude/projects/";
  const i = norm.indexOf(marker);
  if (i < 0) return null;
  const rest = norm.slice(i + marker.length);
  const slash = rest.indexOf("/");
  return slash <= 0 ? null : rest.slice(0, slash);
}

/** True when a Claude session was launched from inside `repoRoot` — this exact
 *  worktree or a subdir of it — and NOT a sibling worktree or the parent
 *  checkout.
 *
 *  The decision is made on the transcript's PHYSICAL project dir (`file_path`),
 *  never on `cwd`. `cwd` is unreliable for this: the lister REWRITES it to the
 *  query root for orphaned sessions — ones whose worktree was pruned/deleted
 *  but is still registered in `git worktree list` (cmd_claude_sessions.rs:120).
 *  Observed live: a deleted `…/New Git-aura-loop-t-560c36c1` worktree came back
 *  stamped with granada's cwd and auto-resumed into a granada tab. The encoded
 *  project-dir name can't be rewritten, so it's the ground truth. Falls back to
 *  cwd containment only when there's no `file_path` (shouldn't happen — the
 *  lister always sets it). */
export function isOwnWorktreeSession(
  session: Pick<ClaudeSession, "cwd" | "file_path">,
  repoRoot: string,
): boolean {
  const dir = projectDirOf(session.file_path);
  if (dir) {
    const enc = encodeProjectDir(repoRoot);
    // Same root, or a cwd inside it (the encoding puts a `-` separator right
    // after the root prefix). Mirrors the Rust same-or-descendant rule.
    return dir === enc || dir.startsWith(enc + "-");
  }
  const cwd = session.cwd;
  if (!cwd) return true;
  const c = stripTrailingSlash(cwd);
  const r = stripTrailingSlash(repoRoot);
  return c === r || c.startsWith(r + "/");
}

/** This worktree's OWN sessions, newest-first — the unioned
 *  `claude_list_sessions` filtered down to files launched from `repoRoot`.
 *  Returns `[]` (never throws) so callers can treat "no own sessions" and
 *  "lookup failed" identically: start fresh. */
export async function ownWorktreeSessions(
  repoRoot: string,
): Promise<ClaudeSession[]> {
  let list: ClaudeSession[];
  try {
    list = await api.claudeListSessions(repoRoot);
  } catch {
    return [];
  }
  return list.filter((s) => isOwnWorktreeSession(s, repoRoot));
}

// Session ids whose cold-resume is IN FLIGHT right now, keyed by repoRoot. Held
// across the `agent_pty_open` await so a sibling restoring in the same burst
// sees the claim and diverts to a fresh session. Cleared once the resume
// settles, so a genuinely-later re-resume of the same conversation still works.
const resumeInFlight = new Map<string, Set<string>>();

/** Claim `sessionId` for resume under `repoRoot`. Returns true if the caller
 *  won the claim (proceed to `--resume`), false if another tab already holds it
 *  (caller should start fresh). Always pair a winning claim with
 *  {@link releaseResume} in a `finally`. */
export function tryClaimResume(repoRoot: string, sessionId: string): boolean {
  let held = resumeInFlight.get(repoRoot);
  if (!held) {
    held = new Set();
    resumeInFlight.set(repoRoot, held);
  }
  if (held.has(sessionId)) return false;
  held.add(sessionId);
  return true;
}

/** Release a resume claim taken by {@link tryClaimResume}. Safe to call for an
 *  id that isn't held (no-op). */
export function releaseResume(repoRoot: string, sessionId: string): void {
  resumeInFlight.get(repoRoot)?.delete(sessionId);
}
