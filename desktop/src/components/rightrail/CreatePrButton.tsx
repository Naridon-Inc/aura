// Create-PR action for the review-rail header (ADE v2). GitHub-Desktop-style
// primary action that adapts to branch state:
//   • an existing PR        → open it, OR ask Aura to re-review the new
//                             commits and update the PR (title/body/review)
//   • a branch to publish   → publish it, then hand PR authoring to Aura
//   • an already-pushed one  → hand PR authoring to Aura
//
// The "update" path answers the common case: you kept working on a branch that
// already has a PR. The diff auto-tracks the branch head on push, so this is
// about the prose + review keeping up — Aura re-reviews and rewrites the PR
// via `gh pr edit` rather than you opening GitHub to hand-edit it.
// Instead of dumping the user on GitHub's blank compare page, the create path
// asks Aura to REVIEW the branch first (semantic diff + blast radius + any
// issues via `aura pr-review`), write a proper title + description, and open
// the PR — so the message reflects what actually changed and why, and real
// problems surface before the PR does.
//
// Rendered as a COMPACT OUTLINE button (not a filled accent pill) so it reads
// as a calm rail action rather than a shouting CTA — the rail is a review
// surface, not a landing page.

import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type AheadBehind, type PrSummary } from "../../lib/api";
import { createPrPrompt, openPr, updatePrPrompt } from "../../lib/worktreeActions";
import { routeCreatePr, type ActiveAgentSession } from "./createPrRouting";
import { Tooltip, TooltipTrigger, TooltipContent } from "../ui/tooltip";

// Branches you never open a PR *from* — a PR needs a feature branch as its
// head. On these the button stays disabled (there's nothing to propose).
const DEFAULT_BRANCHES = new Set(["main", "master", "develop", "trunk"]);

export function CreatePrButton({
  repoRoot,
  activeAgentSession,
}: {
  repoRoot: string;
  /** When a live agent session exists for this repo, the PR-creation prompt
   *  is injected into it; otherwise it goes to the ambient Aura session. */
  activeAgentSession?: ActiveAgentSession | null;
}) {
  const [ab, setAb] = useState<AheadBehind | null>(null);
  const [origin, setOrigin] = useState<string>("");
  const [prs, setPrs] = useState<PrSummary[]>([]);
  const [pushing, setPushing] = useState(false);
  const [tick, setTick] = useState(0);

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
          api.gitAheadBehind(repoRoot),
          api.gitRemoteOrigin(repoRoot).catch(() => ""),
          api.prList(repoRoot).catch(() => [] as PrSummary[]),
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
    // Pushing the branch is a mechanical step of opening the PR (`ensurePushed`
    // handles it), not a separate decision the user makes, so we don't surface
    // the git term "Publish" in the button. The transient "Opening PR…" state
    // covers the push when it happens.
    if (!branch || DEFAULT_BRANCHES.has(branch))
      return { label: "Create PR", disabled: true };
    return { label: "Create PR", disabled: false };
  }, [branch]);

  // Publish the branch first if it has no upstream, so a `gh pr create` has a
  // ref and a semantic review sees the pushed state. A no-op fast path when the
  // branch is already published. Shared by the create + update flows.
  const ensurePushed = useCallback(async () => {
    if (ab && !ab.has_upstream) {
      await api.gitPush(repoRoot, true);
      setTick((t) => t + 1);
    }
  }, [ab, repoRoot]);

  const runCreate = useCallback(async () => {
    if (!branch) return;
    setPushing(true);
    try {
      await ensurePushed();
      // Hand the actual PR authoring to the agent the user is working with:
      // review the branch, write a proper title + description, flag issues,
      // and open the PR. Routes into the active/ambient session for THIS repo
      // (never a fresh throwaway), so the user watches it happen.
      await routeCreatePr(repoRoot, createPrPrompt(branch, ""), activeAgentSession);
    } catch {
      /* surfaced via the disabled state / no-op; the rail's own error
         reporting owns louder failures */
    } finally {
      setPushing(false);
    }
  }, [branch, ensurePushed, repoRoot, activeAgentSession]);

  const runUpdate = useCallback(async () => {
    if (!branch || !existingPr) return;
    setPushing(true);
    try {
      // Sync the branch head, then ask Aura to re-review the new commits and
      // rewrite the PR (title/body/review) via `gh pr edit`. Same routing as
      // create so it lands in the session the user is watching.
      await ensurePushed();
      await routeCreatePr(
        repoRoot,
        updatePrPrompt(branch, existingPr.number),
        activeAgentSession,
      );
    } catch {
      /* see runCreate */
    } finally {
      setPushing(false);
    }
  }, [branch, existingPr, ensurePushed, repoRoot, activeAgentSession]);

  const btnClass =
    "h-[22px] px-2 rounded-md border border-line text-text-2 text-[11px] font-medium inline-flex items-center gap-1.5 transition-colors hover:bg-bg-2 hover:text-text-1 hover:border-line disabled:opacity-40 disabled:cursor-default disabled:hover:bg-transparent";

  // A PR already exists for this branch → offer BOTH re-review-and-update
  // (the common "I kept working" case) and a plain open-in-browser.
  if (existingPr) {
    return (
      <div className="inline-flex items-center gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => void runUpdate()}
              disabled={pushing}
              className={btnClass}
            >
              <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden>
                <path
                  d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2v3h-3"
                  stroke="currentColor"
                  strokeWidth="1.3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              {pushing ? "Updating…" : "Update PR"}
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            Ask Aura to re-review the new commits and update PR #
            {existingPr.number}
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => void openPr(origin, existingPr.number)}
              disabled={pushing}
              aria-label={`Open pull request #${existingPr.number} on GitHub`}
              className="h-[22px] w-[22px] rounded-md border border-line text-text-3 inline-flex items-center justify-center transition-colors hover:bg-bg-2 hover:text-text-1 disabled:opacity-40 disabled:cursor-default disabled:hover:bg-transparent"
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
          onClick={() => void runCreate()}
          disabled={createAction.disabled || pushing}
          className={btnClass}
        >
          {/* Horizontal git-fork — one node splitting into two. Deliberately
              not a vertical trunk. */}
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
          {pushing ? "Opening PR…" : createAction.label}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        Ask Aura to review the changes and open a pull request
      </TooltipContent>
    </Tooltip>
  );
}
