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

import { refreshSessions } from "./sessionsCache";
import type { ClaudeSession } from "./api";

function stripTrailingSlash(p: string): string {
  return p.replace(/\/+$/, "");
}

/** Mirror Claude Code's `~/.claude/projects` dir encoding: every character that
 *  isn't ASCII-alphanumeric collapses to a single `-`, one-for-one (NOT run-
 *  collapsed, so `/.aura` → `--aura`). Verified against live dirs:
 *  `/Users/muhammed/.aura/worktrees/…/zagreb`
 *  → `-Users-muhammed--aura-worktrees-…-zagreb`, and
 *  `/Users/muhammed/Documents/New Git` → `-Users-muhammed-Documents-New-Git`.
 *  Kept byte-identical to the Rust `encode_path` in cmd_claude_sessions.rs. */
function encodeProjectDir(p: string): string {
  const trimmed = stripTrailingSlash(p) || p;
  return trimmed.replace(/[^A-Za-z0-9]/g, "-");
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
    list = await refreshSessions(repoRoot);
  } catch {
    return [];
  }
  return list.filter((s) => isOwnWorktreeSession(s, repoRoot));
}

/** A conversation to resume and the directory it has to be resumed FROM. */
export type ResumeTarget = { sessionId: string; cwd: string };

/** Where `claude --resume <id>` must be launched for that id to resolve.
 *
 *  Claude finds a session by looking under `~/.claude/projects/<encoded-cwd>/`
 *  for `<id>.jsonl` — the launch cwd, never the git repo. Launch it anywhere
 *  else and there is no error: you get a brand-new blank REPL, and the CLI's
 *  own `/resume` picker (keyed the same way) doesn't list the conversation
 *  either. That is the whole "the agent was working in a worktree and came
 *  back empty" bug — 65 of the 71 sessions in one real project were authored
 *  under a worktree's project dir, so resuming them from the project root
 *  could only ever have found the other 6.
 *
 *  The backend already resolves this per session (`ClaudeSession.cwd`, picked
 *  in `scan_session` against the transcript's own on-disk dir). We re-check it
 *  here rather than trust it blind, because the lister deliberately REWRITES
 *  `cwd` to the query root for orphaned sessions whose worktree is gone — and
 *  for those the workspace root really is the best available place to land. */
export function resumeCwdOf(
  session: Pick<ClaudeSession, "cwd" | "file_path">,
  repoRoot: string,
): string {
  const cwd = session.cwd?.trim();
  if (!cwd) return repoRoot;
  const dir = projectDirOf(session.file_path);
  // No `file_path` to check against (shouldn't happen — the lister always sets
  // it): take the recorded cwd, which is still closer than the workspace root.
  if (!dir) return cwd;
  return encodeProjectDir(cwd) === dir ? cwd : repoRoot;
}

/** Which conversation a tab should resume, and where to spawn it.
 *
 *  One place, because the mount-resume path, the "Start agent" overlay and the
 *  Manager's "Resume recent" row each used to answer it themselves and only
 *  one of the three got the cwd right.
 *
 *  `bound` is the id this tab is pinned to (its own durable binding, or the
 *  per-repo channel pin). A pinned id is honoured only if it belongs to THIS
 *  worktree — see {@link isOwnWorktreeSession} for why a sibling's session must
 *  never be adopted. `allowNewest` lets a tab with no pin at all fall back to
 *  this worktree's newest real conversation; the "Start all" path deliberately
 *  does not, so unpinned tabs start fresh instead of cloning one thread.
 *
 *  `null` means "start fresh" — always a valid answer, never an error. */
export async function resolveResumeTarget(
  repoRoot: string,
  bound: string | null | undefined,
  opts?: { allowNewest?: boolean },
): Promise<ResumeTarget | null> {
  const own = await ownWorktreeSessions(repoRoot);
  if (bound) {
    const hit = own.find((s) => s.session_id === bound);
    return hit
      ? { sessionId: hit.session_id, cwd: resumeCwdOf(hit, repoRoot) }
      : null;
  }
  if (!opts?.allowNewest) return null;
  // Skip single-greeting leftovers — reopening one reads as "my history is
  // gone" just as loudly as starting fresh, without the honesty.
  const newest = own.find((s) => s.turn_count >= 2) ?? own[0];
  return newest
    ? { sessionId: newest.session_id, cwd: resumeCwdOf(newest, repoRoot) }
    : null;
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
