// ADE redesign (W5) — per-worktree diff + PR badges for the Build roster.
//
// The mockup's worktree rows carry the live "+207 −1  #816" badges that
// tell you, at a glance, how much each worktree has changed and whether
// it has an open PR. The data already exists in the app:
//
//   • `api.gitDiffStats(path)`  — uncommitted +added / −removed for that
//     worktree's own working tree (each worktree is a separate checkout).
//   • `fetchPrList(root)`        — open PRs for the repo (SWR-cached, so it
//     survives a `gh` rate-limit by serving the last good list); match a
//     row by `head_ref === worktree.branch`.
//
// We fetch on mount + a slow interval so the roster stays current without
// hammering git/gh. Failures are swallowed per-item — a row simply shows
// no badge rather than blocking the others.

import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { fetchPrList } from "./prsCache";

export type WorktreeBadge = {
  added: number;
  removed: number;
  changedFiles: number;
  pr?: { number: number; state: string };
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
      const path2root: Record<string, string> = {};
      for (const g of groups)
        for (const w of g.worktrees) path2root[w.path] = g.root;

      const diffPromise = (async () => {
        const next: Record<string, WorktreeBadge> = {};
        await Promise.all(
          groups.flatMap((g) =>
            g.worktrees.map(async (w) => {
              try {
                const d = await api.gitDiffStats(w.path);
                next[w.path] = {
                  added: d.added,
                  removed: d.removed,
                  changedFiles: d.changed_files,
                };
              } catch {
                /* path gone — leave it out, PR merge may still add it */
              }
            }),
          ),
        );
        if (!cancelled && latest.current === key) setBadges(next);
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

      const [diffs, prByRoot] = await Promise.all([diffPromise, prPromise]);

      // Merge PR pills onto the diff badges (and add PR-only rows that had
      // no working-tree diff).
      const merged: Record<string, WorktreeBadge> = { ...diffs };
      for (const g of groups) {
        for (const w of g.worktrees) {
          const branchKey = w.branch.replace(/^refs\/heads\//, "");
          const pr =
            prByRoot[g.root]?.[w.branch] ?? prByRoot[g.root]?.[branchKey];
          if (!pr) continue;
          const base = merged[w.path] ?? {
            added: 0,
            removed: 0,
            changedFiles: 0,
          };
          merged[w.path] = { ...base, pr };
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
