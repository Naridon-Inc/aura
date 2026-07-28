// prFeature — join a PR to the feature it delivers. A PR is a branch's worth of
// commits; a feature is the goals those commits were proving. The bridge is the
// commit each goal run recorded (GoalRun.commit): the goals whose runs landed on
// this PR's commits ARE this PR's feature. That lets a PR answer "is the thing
// this branch set out to build actually finished?" — the last hop of a feature
// thread that already spans sessions and commits.
//
// The PR's commit set is computed client-side from the commit graph (the
// base..head range) using the ref labels the graph already carries — no new
// backend. When a branch tip isn't present locally (a PR whose branch wasn't
// fetched), it returns null so the caller shows nothing rather than a wrong
// scope. Pure; no I/O.

import type { GraphCommit, GraphRef } from "./api";
import type { GoalRecord } from "./goalStore";

function refMatchesBranch(refs: GraphRef[], branch: string): boolean {
  return refs.some(
    (r) => r.name === branch || r.name === `origin/${branch}` || r.name.endsWith(`/${branch}`),
  );
}

/** Resolve a branch name to a commit sha in the graph — a local head/branch ref
 *  wins over a remote one, so a stale remote doesn't shadow the checked-out tip. */
function resolveTip(graph: GraphCommit[], branch: string): string | null {
  const local = graph.find((c) =>
    c.refs.some(
      (r) =>
        (r.kind === "local" || r.kind === "head") &&
        (r.name === branch || r.name.endsWith(`/${branch}`)),
    ),
  );
  if (local) return local.sha;
  const any = graph.find((c) => refMatchesBranch(c.refs, branch));
  return any ? any.sha : null;
}

/** Every commit reachable from `tip` by walking parent edges (inclusive). Stops
 *  at the edge of the graph window — a parent beyond the fetched limit simply
 *  isn't traversed. */
function ancestors(graph: GraphCommit[], tip: string): Set<string> {
  const parentsBySha = new Map(graph.map((c) => [c.sha, c.parents]));
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length) {
    const sha = stack.pop() as string;
    if (seen.has(sha)) continue;
    seen.add(sha);
    for (const p of parentsBySha.get(sha) ?? []) {
      if (!seen.has(p)) stack.push(p);
    }
  }
  return seen;
}

/** The commits that belong to a PR — reachable from head but not from base
 *  (`git log base..head`). Returns null when either branch tip isn't present in
 *  the graph locally, so the caller can decline rather than mis-scope. */
export function commitsInPr(
  graph: GraphCommit[],
  headRef: string,
  baseRef: string,
): Set<string> | null {
  const headTip = resolveTip(graph, headRef);
  const baseTip = resolveTip(graph, baseRef);
  if (!headTip || !baseTip) return null;
  const headAnc = ancestors(graph, headTip);
  const baseAnc = ancestors(graph, baseTip);
  const out = new Set<string>();
  for (const sha of headAnc) {
    if (!baseAnc.has(sha)) out.add(sha);
  }
  return out;
}

/** Goals whose recorded runs landed on any of the given commits — the feature
 *  goals a PR actually delivered. Matches on the 7-char short sha so a run's sha
 *  (which may be full or short) lines up with the graph's full sha. */
export function goalsForCommits(goals: GoalRecord[], commits: Set<string>): GoalRecord[] {
  if (commits.size === 0) return [];
  const shorts = new Set<string>();
  for (const c of commits) shorts.add(c.slice(0, 7));
  return goals.filter((g) =>
    g.runs.some((run) => !!run.commit && shorts.has(run.commit.slice(0, 7))),
  );
}
