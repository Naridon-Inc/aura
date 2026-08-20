// ADE redesign (W5) — per-worktree diff + PR badges for the Build roster.
//
// The mockup's worktree rows carry the live "+207 −1  #816" badges that
// tell you, at a glance, how much each worktree has changed and whether
// it has an open PR. The data already exists in the app:
//
//   • `fetchWorktreeDiffs(paths)` — uncommitted +added / −removed for every
//     worktree, in ONE round-trip and shared with the other roster (each
//     worktree is a separate checkout, so this used to be one `invoke` per
//     row per roster: 98 cross-process hops a cycle on a 49-worktree
//     checkout, a quarter of all the IPC the idle app did — see
//     worktreeDiffCache.ts).
//   • `fetchPrList(root)`        — open PRs for the repo (SWR-cached, so it
//     survives a `gh` rate-limit by serving the last good list); match a
//     row by `head_ref === worktree.branch`.
//   • `cloudJobsForRepo(root)`   — unfinished cloud work for the repo, keyed by
//     the branch it was sent on. Once a box can drain your work, "who is
//     running this" is no longer answerable from this machine alone: a copy
//     can be idle on this disk and mid-turn on a runner. Matching by branch is
//     what turns that into a per-row fact instead of an account-level one.
//
// We fetch on mount + a slow interval so the roster stays current without
// hammering git/gh. Failures are swallowed per-item — a row simply shows
// no badge rather than blocking the others.

import { useEffect, useRef, useState } from "react";
import { api, type CloudPlacement } from "./api";
import { fetchPrList } from "./prsCache";
import { fetchWorktreeDiffs } from "./worktreeDiffCache";

export type WorktreeBadge = {
  added: number;
  removed: number;
  changedFiles: number;
  pr?: { number: number; state: string };
  /** Set when this copy's branch is being worked on by a machine that isn't
   *  this one. Absent the moment the job reaches a terminal state — a cloud
   *  mark that outlives the run stops meaning "right now". */
  cloud?: CloudPlacement;
};

type WorktreeGroup = {
  root: string;
  worktrees: { path: string; branch: string }[];
};

const REFRESH_MS = 30_000;

export function useWorktreeBadges(
  groups: WorktreeGroup[],
): Record<string, WorktreeBadge> {
  const [badges, setBadges] = useState<Record<string, WorktreeBadge>>({});

  // Stable dependency: the set of (root, path, branch) tuples. Re-runs
  // only when a worktree is added/removed or a branch changes, not on
  // every parent render.
  const key = groups
    .map((g) => `${g.root}|${g.worktrees.map((w) => `${w.path}:${w.branch}`).join(",")}`)
    .join(";;");

  const latest = useRef(key);
  latest.current = key;

  useEffect(() => {
    let cancelled = false;

    async function run() {
      // Diffs are local git and fast; PRs may hit the network (`gh`) and
      // can be slow. Run both concurrently and publish twice — diffs as
      // soon as they land, then again enriched with PR pills — so a slow
      // PR lookup never delays the diff badges.
      const diffPromise = (async () => {
        const next: Record<string, WorktreeBadge> = {};
        // One call for every worktree in every group. Paths that could not be
        // read (the usual cause is a worktree removed while the roster still
        // holds it) come back absent rather than zeroed, so they stay out of
        // `next` and the row shows no badge — a PR merge may still add one.
        const diffs = await fetchWorktreeDiffs(
          groups.flatMap((g) => g.worktrees.map((w) => w.path)),
        );
        for (const [path, d] of Object.entries(diffs)) {
          next[path] = {
            added: d.added,
            removed: d.removed,
            changedFiles: d.changed_files,
          };
        }
        // Publish the diffs immediately, but keep whatever PR pill / cloud mark
        // the row already had. Replacing outright made every row drop its
        // slower-arriving marks for the length of a `gh` call, so the pills
        // blinked once a cycle; the authoritative merge below corrects them.
        if (!cancelled && latest.current === key) {
          setBadges((prev) => {
            const carried: Record<string, WorktreeBadge> = {};
            for (const [path, b] of Object.entries(next)) {
              const was = prev[path];
              carried[path] = {
                ...b,
                ...(was?.pr ? { pr: was.pr } : null),
                ...(was?.cloud ? { cloud: was.cloud } : null),
              };
            }
            return carried;
          });
        }
        return next;
      })();

      const prPromise = (async () => {
        const prByRoot: Record<string, Record<string, { number: number; state: string }>> = {};
        await Promise.all(
          groups.map(async (g) => {
            try {
              const prs = await fetchPrList(g.root);
              const m: Record<string, { number: number; state: string }> = {};
              for (const p of prs) {
                if (p.head_ref && m[p.head_ref] === undefined) {
                  m[p.head_ref] = { number: p.number, state: p.state };
                }
              }
              prByRoot[g.root] = m;
            } catch {
              prByRoot[g.root] = {};
            }
          }),
        );
        return prByRoot;
      })();

      // Which branches of each repo are in flight on someone else's machine.
      // Same failure posture as the others: a repo we can't ask about simply
      // contributes no marks. The command already answers with an empty list
      // (not an error) for a repo with no GitHub remote or an account that
      // isn't signed in, so the common case costs one cheap call.
      const cloudPromise = (async () => {
        const byRoot: Record<string, Record<string, CloudPlacement>> = {};
        await Promise.all(
          groups.map(async (g) => {
            try {
              const placements = await api.cloudJobsForRepo(g.root);
              const m: Record<string, CloudPlacement> = {};
              for (const p of placements) {
                const b = p.branch.replace(/^refs\/heads\//, "");
                // First writer wins: if a branch somehow has two open jobs,
                // one mark is the honest summary — the jobs list has both.
                if (b && m[b] === undefined) m[b] = p;
              }
              byRoot[g.root] = m;
            } catch {
              byRoot[g.root] = {};
            }
          }),
        );
        return byRoot;
      })();

      const [diffs, prByRoot, cloudByRoot] = await Promise.all([
        diffPromise,
        prPromise,
        cloudPromise,
      ]);

      // Merge PR pills and cloud marks onto the diff badges (and add rows that
      // had no working-tree diff but do have one of the other two).
      const merged: Record<string, WorktreeBadge> = { ...diffs };
      for (const g of groups) {
        for (const w of g.worktrees) {
          const branchKey = w.branch.replace(/^refs\/heads\//, "");
          const pr =
            prByRoot[g.root]?.[w.branch] ?? prByRoot[g.root]?.[branchKey];
          const cloud = cloudByRoot[g.root]?.[branchKey];
          if (!pr && !cloud) continue;
          const base = merged[w.path] ?? {
            added: 0,
            removed: 0,
            changedFiles: 0,
          };
          merged[w.path] = {
            ...base,
            ...(pr ? { pr } : null),
            ...(cloud ? { cloud } : null),
          };
        }
      }

      // Drop stale results if the worktree set changed mid-flight.
      if (!cancelled && latest.current === key) setBadges(merged);
    }

    run();
    const id = setInterval(run, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return badges;
}
