// Pure model for the Workspaces page — every parallel copy (worktree) of every
// open repository, flattened into one list so the sidebar can stay a curated
// few. It never invents a datum: every diff/PR/agent/time is real, or omitted.
// `workspacesOverview` turns these copies into the page's rows.

import { humanizeCopyTitle } from "../../lib/workspaceLabel";
import type { WorktreeRef } from "../../lib/workspaceRef";
import type { CloudPlacement } from "../../lib/api";
import type { WorktreeBadge } from "../../lib/useWorktreeBadges";
import { relativeAgeFromDelta } from "../../lib/relativeTime";
import { shortDateFromSecs } from "../../lib/calendarDate";

// One agent parked on a copy — normalised across live tabs + the persisted
// per-repo roster upstream (the surface unions them). `attention` = the agent
// is waiting on the user (plain words: "needs you").
export type CopyAgent = {
  agentId: string;
  label: string;
  attention: boolean;
};

// A single worktree ("parallel copy"), flattened across every open project.
export type WorkspaceCopy = {
  // path is unique per checkout → the row key + open target.
  path: string;
  root: string; // owning project root
  projectName: string;
  projectEmoji?: string;
  projectLetter: string;
  projectAccent?: string;
  branch: string; // raw branch slug ("" when detached)
  title: string; // humanised, readable ("manifest signing prep")
  isMain: boolean;
  isActive: boolean;
  committedAt: number | null; // unix seconds of HEAD commit, or null
  createdAt: number | null; // unix seconds the copy was made, or null (main)
  added: number;
  removed: number;
  changedFiles: number;
  pr?: { number: number; state: string };
  agents: CopyAgent[];
  // Set when this copy's branch is in flight on a machine that isn't this one.
  // Every other field here describes this disk, which is why the fleet views
  // could show a copy as resting while a runner was mid-turn on it — the local
  // checkout genuinely is idle, and nothing else on the row disagrees.
  cloud?: CloudPlacement;
};

// The project shape the surface hands in — mirrors what App builds for the
// roster (id = root, plus display bits).
export type ProjectMeta = {
  id: string; // repo root
  name: string;
  emoji?: string;
  letter: string;
  accent?: string;
};

export type BuildCopiesInput = {
  projects: ProjectMeta[];
  worktreesByRoot: Record<string, WorktreeRef[]>;
  badgeByPath: Record<string, WorktreeBadge>;
  agentsByPath: Map<string, CopyAgent[]>;
  activePath: string;
};

// Flatten every project's worktrees into one copy list. A project with no
// sibling worktrees still yields its main checkout (a plain repo is one copy).
export function buildCopies(input: BuildCopiesInput): WorkspaceCopy[] {
  const { projects, worktreesByRoot, badgeByPath, agentsByPath, activePath } =
    input;
  const out: WorkspaceCopy[] = [];
  for (const proj of projects) {
    const raw = worktreesByRoot[proj.id] ?? [];
    const wts: WorktreeRef[] = raw.length
      ? raw
      : [
          {
            path: proj.id,
            branch: "",
            head: "",
            is_main: true,
            locked: false,
            head_committed_at: null,
            created_at: null,
          },
        ];
    for (const w of wts) {
      const badge = badgeByPath[w.path];
      const added = badge?.added ?? 0;
      const removed = badge?.removed ?? 0;
      const agents = agentsByPath.get(w.path) ?? [];
      const isActive = w.path === activePath;
      out.push({
        path: w.path,
        root: proj.id,
        projectName: proj.name,
        projectEmoji: proj.emoji,
        projectLetter: proj.letter,
        projectAccent: proj.accent,
        branch: w.branch,
        title: humanizeCopyTitle(w.branch, w.is_main, w.path),
        isMain: w.is_main,
        isActive,
        committedAt: w.head_committed_at ?? null,
        createdAt: w.created_at ?? null,
        added,
        removed,
        changedFiles: badge?.changedFiles ?? 0,
        pr: badge?.pr,
        agents,
        cloud: badge?.cloud,
      });
    }
  }
  return out;
}

// ── formatting helpers ────────────────────────────────────────────────────

// "just now" / "3h ago" / "2d ago" / "Apr 12" — plain, no clock jargon.
//
// Past a month it stops counting and names the day. "5w ago" is a distance you
// have to do arithmetic on; "Apr 12" is the thing you were actually asking.
export function relTime(committedAt: number | null, nowMs: number): string {
  if (committedAt == null) return "";
  const secs = Math.max(0, Math.floor(nowMs / 1000) - committedAt);
  if (secs >= 30 * 86400) return calendarDay(committedAt);
  // One ladder for the whole app — see lib/relativeTime.
  return relativeAgeFromDelta(secs);
}

// The far end of both ladders — see lib/calendarDate.
function calendarDay(unixSecs: number): string {
  return shortDateFromSecs(unixSecs);
}
