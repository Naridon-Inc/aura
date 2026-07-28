// Workspaces page — turning the raw control plane into rows a person can read.
//
// Pure functions only, no React and no IO, because every judgement call here is
// one that has to be right: which checkout is "active", how recently it moved,
// and whether two agents are genuinely about to collide or merely near each
// other. Those deserve tests, not a hook.

import type { PlaneContention, WorktreeCard, WorktreePlane } from "../../../lib/api";

/** A checkout with everything the row needs already resolved. */
export type WorkspaceRowData = {
  card: WorktreeCard;
  /** What to call it: the branch, falling back to the checkout name. */
  title: string;
  /** The checkout's own folder name — the sub-label, and how you message it. */
  token: string;
  /** Unix MILLIseconds of the most recent sign of life, from any source. */
  activityAt: number;
  /** Agents whose process is still running. */
  liveAgents: WorktreeCard["agents"];
  /** Symbols this checkout holds that ANOTHER checkout is holding too — the
   *  single fact no other tool can tell you, so it leads the row. */
  collisions: PlaneContention[];
};

/**
 * When this checkout last showed a sign of life.
 *
 * Three clocks disagree, and taking the wrong one buries active work at the
 * bottom of the list:
 *   • the HEAD commit — always present, but stale the moment you start editing;
 *   • awareness events — precise, but only exist where an agent ran;
 *   • an agent heartbeat — proves someone is there *right now*.
 * The latest of the three is the only one that answers "is anything happening
 * here", so that is what the buckets sort on.
 *
 * Returns milliseconds. Events are already ms; the git and sentinel clocks are
 * seconds, which is a factor-of-1000 trap worth naming: mixing them silently
 * sorts every commit into 1970.
 */
export function activityOf(card: WorktreeCard): number {
  let latest = card.last_commit_at ? card.last_commit_at * 1000 : 0;
  for (const e of card.events) {
    if (e.ts > latest) latest = e.ts;
  }
  for (const a of card.agents) {
    const beat = a.last_heartbeat * 1000;
    if (beat > latest) latest = beat;
  }
  return latest;
}

/** Symbols held here that are ALSO held from a different checkout. */
export function collisionsFor(
  card: WorktreeCard,
  contention: PlaneContention[],
): PlaneContention[] {
  return contention.filter(
    (c) => c.cross_worktree && c.holders.some((h) => h.worktree === card.token),
  );
}

export function toRows(plane: WorktreePlane): WorkspaceRowData[] {
  return plane.worktrees.map((card) => ({
    card,
    title: card.branch ?? card.name ?? "detached",
    token: card.token,
    activityAt: activityOf(card),
    liveAgents: card.agents.filter((a) => a.alive),
    collisions: collisionsFor(card, plane.contention),
  }));
}

/**
 * Is anything at all going on here?
 *
 * A repo accumulates checkouts — a dozen abandoned `worktree-agent-…` scratch
 * directories, old release branches — and listing them beside live work makes
 * the live work impossible to find. Quiet means: nobody is standing in it, it
 * has nothing uncommitted, it is not ahead of trunk, and nothing is waiting in
 * its inbox. Being *behind* trunk deliberately doesn't count: every stale
 * checkout is behind, and that alone is not activity.
 */
export function isQuiet(row: WorkspaceRowData): boolean {
  const c = row.card;
  return (
    row.liveAgents.length === 0 &&
    row.collisions.length === 0 &&
    c.dirty_files === 0 &&
    c.ahead === 0 &&
    c.inbox === 0 &&
    !c.is_here
  );
}

/** Case-insensitive match over the words a person would actually type: the
 *  branch, the checkout name, and the agent driving it. */
export function matchesQuery(row: WorkspaceRowData, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (row.title.toLowerCase().includes(q)) return true;
  if (row.token.toLowerCase().includes(q)) return true;
  if (row.card.path.toLowerCase().includes(q)) return true;
  return row.card.agents.some((a) => a.agent_id.toLowerCase().includes(q));
}

/** One dated group in the list, newest first, with its own count. */
export type Bucket = { key: string; label: string; rows: WorkspaceRowData[] };

const DAY_MS = 86_400_000;

/** How many midnights sit between `then` and `now` — 0 = today, 1 = yesterday.
 *  Counted on local calendar days, not elapsed hours, so 11pm and 1am read as
 *  different days the way a person means them. */
function daysAgo(then: number, now: number): number {
  const a = new Date(then);
  const b = new Date(now);
  a.setHours(0, 0, 0, 0);
  b.setHours(0, 0, 0, 0);
  return Math.round((b.getTime() - a.getTime()) / DAY_MS);
}

function bucketLabel(days: number): { key: string; label: string } {
  if (days <= 0) return { key: "d0", label: "Today" };
  if (days === 1) return { key: "d1", label: "Yesterday" };
  if (days < 7) return { key: `d${days}`, label: `${days} days ago` };
  const weeks = Math.floor(days / 7);
  if (weeks === 1) return { key: "w1", label: "1 week ago" };
  if (weeks < 5) return { key: `w${weeks}`, label: `${weeks} weeks ago` };
  const months = Math.floor(days / 30);
  if (months <= 1) return { key: "m1", label: "1 month ago" };
  if (months < 12) return { key: `m${months}`, label: `${months} months ago` };
  return { key: "old", label: "Over a year ago" };
}

/** Group rows by how long ago they last moved, newest bucket first. Rows with
 *  no timestamp at all land in their own trailing group rather than being
 *  dated to 1970 and claiming to be decades old. */
export function bucketByActivity(rows: WorkspaceRowData[], now: number): Bucket[] {
  const undated: WorkspaceRowData[] = [];
  const byKey = new Map<string, Bucket>();
  const order: string[] = [];

  for (const row of [...rows].sort((a, b) => b.activityAt - a.activityAt)) {
    if (!row.activityAt) {
      undated.push(row);
      continue;
    }
    const { key, label } = bucketLabel(daysAgo(row.activityAt, now));
    let bucket = byKey.get(key);
    if (!bucket) {
      bucket = { key, label, rows: [] };
      byKey.set(key, bucket);
      order.push(key);
    }
    bucket.rows.push(row);
  }

  const out = order.map((k) => byKey.get(k)!);
  if (undated.length) out.push({ key: "undated", label: "No history yet", rows: undated });
  return out;
}

/** "4h", "2d", "3w" — the right-hand age column. Deliberately one unit: this
 *  sits at the end of a dense row and only has to convey magnitude. */
export function shortAge(then: number, now: number): string {
  if (!then) return "";
  const secs = Math.max(0, Math.round((now - then) / 1000));
  if (secs < 60) return "now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days}d`;
  const weeks = Math.round(days / 7);
  if (weeks < 9) return `${weeks}w`;
  const months = Math.round(days / 30);
  if (months < 24) return `${months}mo`;
  return `${Math.round(days / 365)}y`;
}

/** 8_432 → "8.4k". Keeps a dense row readable without hiding the magnitude. */
export function compactCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
}
