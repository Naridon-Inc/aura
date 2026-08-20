// Create-PR action for the review-rail header (ADE v2). GitHub-Desktop-style
// primary action that adapts to branch state:
//   • an existing PR → open it, OR have Aura re-review the new commits and
//                      rewrite the PR (title/body/review)
//   • no PR yet      → have Aura open one
//
// The "update" path answers the common case: you kept working on a branch that
// already has a PR. The diff auto-tracks the branch head on push, so this is
// about the prose + review keeping up — Aura re-reviews and rewrites the PR
// via `gh pr edit` rather than you opening GitHub to hand-edit it.
//
// Clicking is the decision, and the whole job runs from there: Aura looks at
// the working tree and the branch diff, commits what belongs in the PR, runs
// the checks (`aura pr-review`, `aura prove`), writes the title + description,
// pushes, and opens the PR (see `createPrPrompt`). It runs as a BACKGROUND job
// in its own session — clicking this never splices instructions into the chat
// you're having, and never interrupts an agent that's mid-run for this repo.
// The button shows it working; a toast offers to open the transcript when it
// lands, and the PR appears in the rail on its own.
//
// Rendered as a COMPACT OUTLINE button (not a filled accent pill) so it reads
// as a calm rail action rather than a shouting CTA — the rail is a review
// surface, not a landing page.

import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type AheadBehind, type PrSummary } from "../../lib/api";
import { fetchAheadBehind } from "../../lib/gitStateCache";
import { fetchPrList } from "../../lib/prsCache";
import { startAuraJob, useAuraJobs } from "../../lib/auraJob";
import {
  createPrPrompt,
  openPr,
  updatePrJobId,
  updatePrPrompt,
  UPDATE_PR_HINT,
} from "../../lib/worktreeActions";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { Tooltip, TooltipTrigger, TooltipContent } from "../ui/tooltip";

// Branches you never open a PR *from* — a PR needs a feature branch as its
// head. On these the button stays disabled (there's nothing to propose).
const DEFAULT_BRANCHES = new Set(["main", "master", "develop", "trunk"]);

export function CreatePrButton({ repoRoot }: { repoRoot: string }) {
  const [ab, setAb] = useState<AheadBehind | null>(null);
  const [origin, setOrigin] = useState<string>("");
  const [prs, setPrs] = useState<PrSummary[]>([]);
  const [tick, setTick] = useState(0);
  const job = useAuraJobs(repoRoot);

  // Poll branch + PR state on mount, whenever the repo changes, after our own
  // push (tick), on any git mutation broadcast (`aura:git-changed`, fired by
  // the commit/push/pull surfaces), and when the window regains focus (a push
  // may have happened in a terminal). No interval — `pr_list` hits the GitHub
  // API, so we refresh on real signals only.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const [a, o, list] = await Promise.all([
          fetchAheadBehind(repoRoot),
          api.gitRemoteOrigin(repoRoot).catch(() => ""),
          fetchPrList(repoRoot).catch(() => [] as PrSummary[]),
        ]);
        if (!alive) return;
        setAb(a);
        setOrigin(o || "");
        setPrs(list);
      } catch {
        /* transient — the button falls back to its default label */
      }
    })();
    return () => {
      alive = false;
    };
  }, [repoRoot, tick]);

  useEffect(() => {
    const bump = () => setTick((t) => t + 1);
    window.addEventListener("aura:git-changed", bump);
    window.addEventListener("focus", bump);
    return () => {
      window.removeEventListener("aura:git-changed", bump);
      window.removeEventListener("focus", bump);
    };
  }, []);

  const branch = ab?.branch ?? null;
  const existingPr = useMemo(
    () => (branch ? (prs.find((p) => p.head_ref === branch) ?? null) : null),
    [prs, branch],
  );

  const createAction = useMemo(() => {
    // A PR needs a feature branch as its head — disable on the base branches
    // (and before the branch is known), never merely because it's "0 ahead".
    // A published branch level with its base is still PR-able (the diff is vs
    // the merge target, not the upstream), so don't grey it out.
    //
    // The label is always "Create PR" — even when the branch has no upstream.
    // Pushing the branch is a mechanical step of opening the PR (the job does
    // it), not a separate decision the user makes, so we don't surface the git
    // term "Publish" in the button. The "Opening PR…" state covers it.
    if (!branch || DEFAULT_BRANCHES.has(branch))
      return { label: "Create PR", disabled: true };
    return { label: "Create PR", disabled: false };
  }, [branch]);

  // Both flows hand the WHOLE job to a background Aura session — including the
  // push. There's no separate "publish the branch first" step here any more:
  // pushing is one line of the job Aura runs, not a decision the user makes,
  // and doing it inline made the button block on the network before the real
  // work had even started.
  const creating = job("create-pr")?.status === "running";
  const updating = existingPr
    ? job(updatePrJobId(existingPr.number))?.status === "running"
    : false;

  const runCreate = useCallback(() => {
    if (!branch) return;
    startAuraJob({
      repoRoot,
      id: "create-pr",
      title: "Open the pull request",
      text: createPrPrompt(branch, ""),
    });
  }, [branch, repoRoot]);

  const runUpdate = useCallback(() => {
    if (!branch || !existingPr) return;
    startAuraJob({
      repoRoot,
      id: updatePrJobId(existingPr.number),
      title: `Update pull request #${existingPr.number}`,
      text: updatePrPrompt(branch, existingPr.number),
    });
  }, [branch, existingPr, repoRoot]);

  const btnClass =
    "h-[22px] px-2 rounded-md border border-line text-text-2 text-xs font-medium inline-flex items-center gap-1.5 transition-colors hover:bg-state-hover hover:text-text-1 hover:border-line disabled:opacity-40 disabled:cursor-default disabled:hover:bg-transparent";

  // A PR already exists for this branch → offer BOTH re-review-and-update
  // (the common "I kept working" case) and a plain open-in-browser.
  if (existingPr) {
    return (
      <div className="inline-flex items-center gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={runUpdate}
              disabled={updating}
              className={btnClass}
            >
              {updating ? (
                <AsciiSpinner className="text-2xs" />
              ) : (
                <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden>
                  <path
                    d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2v3h-3"
                    stroke="currentColor"
                    strokeWidth="1.3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              )}
              {updating ? "Updating…" : "Update PR"}
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{UPDATE_PR_HINT}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => void openPr(origin, existingPr.number)}
              aria-label={`Open pull request #${existingPr.number} on GitHub`}
              className="h-[22px] w-[22px] rounded-md border border-line text-text-3 inline-flex items-center justify-center transition-colors hover:bg-state-hover hover:text-text-1 disabled:opacity-40 disabled:cursor-default disabled:hover:bg-transparent"
            >
              <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden>
                <path
                  d="M6 3H3.5A1.5 1.5 0 0 0 2 4.5v8A1.5 1.5 0 0 0 3.5 14h8a1.5 1.5 0 0 0 1.5-1.5V10M9.5 2.5H13.5V6.5M13 3 7.5 8.5"
                  stroke="currentColor"
                  strokeWidth="1.3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            Open #{existingPr.number} on GitHub
          </TooltipContent>
        </Tooltip>
      </div>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={runCreate}
          disabled={createAction.disabled || creating}
          className={btnClass}
        >
          {creating ? (
            <AsciiSpinner className="text-2xs" />
          ) : (
            /* Horizontal git-fork — one node splitting into two. Deliberately
               not a vertical trunk. */
            <svg
              width="11"
              height="11"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <circle cx="4" cy="8" r="1.5" />
              <circle cx="12" cy="4" r="1.5" />
              <circle cx="12" cy="12" r="1.5" />
              <path d="M5.5 8h2.5" />
              <path d="M8 8C9.5 8 9.5 4 10.5 4" />
              <path d="M8 8C9.5 8 9.5 12 10.5 12" />
            </svg>
          )}
          {creating ? "Opening PR…" : createAction.label}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        Aura checks the changes, runs the checks, and opens the pull request. 
        in the background, without touching your chat
      </TooltipContent>
    </Tooltip>
  );
}
