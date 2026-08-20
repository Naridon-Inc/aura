// Feature 1 — the state-driven review header (Conductor's colored PR / branch
// lifecycle strip). Sits at the top of the right review panel and changes its
// background TINT + label + primary action by the live git/PR state:
//
//   conflicts → red     "Your changes clash with the team's" · Resolve
//   merged    → violet  "This work is in"                    · Continue + Archive
//   ready     → green   "Ready to go in"                     · Merge
//   behind    → amber   "Missing N updates from the team"    · Pull
//   ahead     → neutral "N updates the team can't see yet"   · Push
//   nopublish → neutral "Nobody else can see this yet"       · Publish
//   uncommit  → amber   "N changed files"                    · Commit and push
//   clean     → no tint "Up to date"                         · (none)
//
// Six of those eight used to be the git word for the condition — "Behind by
// 586 commits", "Unpublished branch" — on a bar this file's own comment calls
// the plain-language label. The exact git fact is on the hover now; see
// `branchStateDetail`.
//
// The lifecycle precedence + labels live in the pure `deriveReviewState`;
// this file only polls the facts, renders the tinted bar, and wires each
// button to the REUSED handlers (`api.gitPush/gitPull`, `api.prMerge`, the
// Resolve action which now hands conflict resolution to Aura's chat, the
// workspace-archive helper). When there's no PR yet it also hosts the
// Create-PR affordance.

import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type AheadBehind, type PrSummary } from "../../lib/api";
import { fetchAheadBehind, fetchDiffStats } from "../../lib/gitStateCache";
import {
  fetchPrList,
  getPrListCached,
  invalidatePrList,
  pickBranchPr,
  subscribePrList,
} from "../../lib/prsCache";
import { useDocumentVisibility } from "../../lib/useDocumentVisibility";
import { setWorkspaceArchived } from "../../lib/workspaceCustomization";
import { openExternal } from "../../lib/openExternal";
import { startAuraJob, useAuraJobs } from "../../lib/auraJob";
import { resolveConflictsPrompt } from "../../lib/worktreeActions";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { CreatePrButton } from "./CreatePrButton";
import {
  deriveReviewState,
  toneVar,
  type ReviewAction,
  type ReviewTone,
} from "./reviewState";

const POLL_MS = 6000;

type Props = {
  repoRoot: string;
  /** Live merge-conflict count (App already scans sentinel + git markers). */
  conflictsCount: number;
  /** Switch the right rail to its Changes tab (for "Commit and push" and the
   *  merged "Continue" step). */
  onGoToChanges?: () => void;
};

export function ReviewStateHeader({
  repoRoot,
  conflictsCount,
  onGoToChanges,
}: Props) {
  // `null` until a read lands. It used to be seeded with `{0, 0, false}`,
  // which is a valid AheadBehind meaning "published nowhere" — so the bar's
  // very first frame read "Nobody else can see this yet" and offered Publish,
  // about a branch nothing had looked at. The `catch` below then kept that
  // fabrication as the "last-known state" for the whole session.
  const [ab, setAb] = useState<AheadBehind | null>(null);
  const [changedCount, setChangedCount] = useState(0);
  const [prs, setPrs] = useState<PrSummary[]>(() => getPrListCached(repoRoot) ?? []);
  const [busy, setBusy] = useState(false);
  const job = useAuraJobs(repoRoot);
  const [tick, setTick] = useState(0);
  const visible = useDocumentVisibility();

  // Poll branch ahead/behind + uncommitted count (uncommitted-vs-HEAD, so the
  // "Uncommitted changes" state never misfires on a worktree's since-base
  // diff). Same cadence + wake signals the commit surface uses.
  useEffect(() => {
    if (!repoRoot) return;
    let cancelled = false;
    async function poll() {
      try {
        const [a, d] = await Promise.all([
          fetchAheadBehind(repoRoot),
          fetchDiffStats(repoRoot).catch(() => null),
        ]);
        if (cancelled) return;
        setAb(a);
        if (d) setChangedCount(d.changed_files);
      } catch {
        // Transient — the bar keeps its last-known state, and when there is
        // no last-known state it keeps `null`, which draws "Couldn't check
        // where this stands". It must NOT fall back to a zeroed AheadBehind:
        // that reads as a published-nowhere branch and is what this whole
        // change is about.
      }
    }
    void poll();
    if (!visible) return () => {
      cancelled = true;
    };
    const id = window.setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [repoRoot, visible, tick]);

  // PR list — SWR cache, shared with the PRs rail (no double-fetch).
  useEffect(() => {
    let alive = true;
    void fetchPrList(repoRoot)
      .then((list) => {
        if (alive) setPrs(list);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [repoRoot, tick]);
  useEffect(() => subscribePrList(repoRoot, setPrs), [repoRoot]);

  // Re-poll on any git mutation elsewhere (commit/push/pull/sync fire this),
  // and when the window regains focus (a push may have happened in a terminal).
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
  // `pickBranchPr` prefers the OPEN pull request for this branch — see its doc:
  // the cache holds `--state all`, so a bare `.find` could land on a superseded
  // closed PR and tint the whole bar by its state.
  const pr = useMemo(() => pickBranchPr(prs, branch), [prs, branch]);

  const state = useMemo(
    () =>
      deriveReviewState({
        known: ab !== null,
        ahead: ab?.ahead ?? 0,
        behind: ab?.behind ?? 0,
        hasUpstream: ab?.has_upstream ?? false,
        changedCount,
        conflictsCount,
        pr: pr
          ? { number: pr.number, state: pr.state, reviewDecision: pr.review_decision }
          : null,
        // `api.prMerge` exists, so Merge is a real capability here.
        canMerge: true,
      }),
    [ab, changedCount, conflictsCount, pr],
  );

  const afterMutation = useCallback(() => {
    setTick((t) => t + 1);
    window.dispatchEvent(new CustomEvent("aura:git-changed"));
  }, []);

  // A background job keeps the button in its busy state for as long as the work
  // actually runs — the local `busy` flag only covers the inline git calls.
  const isActionRunning = useCallback(
    (action: ReviewAction) => job(action.id)?.status === "running",
    [job],
  );

  const runAction = useCallback(
    async (action: ReviewAction) => {
      switch (action.id) {
        case "resolve":
          // Hand the conflict resolution to Aura (it drives the real conflict
          // tools) instead of popping a separate ConflictsDialog. As a
          // BACKGROUND job — same id the Checks rail uses, so the two surfaces
          // show one run — rather than splicing the prompt into whatever
          // conversation the user is currently having.
          startAuraJob({
            repoRoot,
            id: "resolve",
            title: "Resolve the conflicts",
            text: resolveConflictsPrompt(),
          });
          return;
        case "archive":
          setWorkspaceArchived(repoRoot, true);
          return;
        case "continue":
          // Focus the working surface to start the next step; if there's no
          // Changes target wired, fall back to opening the (merged) PR.
          if (onGoToChanges) {
            onGoToChanges();
            window.dispatchEvent(new CustomEvent("aura:focus-changes"));
          } else if (pr) {
            await openExternal(pr.url);
          }
          return;
        case "commit_push":
          // No commit message here — hand the user to the Changes/commit
          // surface rather than committing blind.
          onGoToChanges?.();
          window.dispatchEvent(new CustomEvent("aura:focus-changes"));
          return;
      }
      // Async git / PR actions.
      setBusy(true);
      try {
        switch (action.id) {
          case "pull":
            await api.gitPull(repoRoot);
            break;
          case "push":
            await api.gitPush(repoRoot, false);
            break;
          case "publish":
            await api.gitPush(repoRoot, true);
            break;
          case "merge":
            if (pr) {
              await api.prMerge(repoRoot, pr.number, "squash", false);
              await invalidatePrList(repoRoot).catch(() => {});
            }
            break;
        }
        afterMutation();
      } catch (e) {
        console.error(`[review-header] ${action.id} failed:`, e);
      } finally {
        setBusy(false);
      }
    },
    [repoRoot, pr, onGoToChanges, afterMutation],
  );

  const color = toneVar(state.tone);
  const tint = tintFor(state.tone);

  return (
    <div
      className="flex items-center gap-2 w-full h-full px-2 min-w-0 overflow-hidden"
      style={{ background: tint }}
    >
      {/* PR pill — opens the PR in the real browser. */}
      {pr && (
        <button
          type="button"
          onClick={() => void openExternal(pr.url)}
          title={`Open pull request #${pr.number}`}
          className="shrink-0 inline-flex items-center gap-1 h-[20px] px-1.5 rounded border border-line-soft text-xs tabular-nums text-text-2 hover:text-text-1 hover:bg-state-hover transition-colors"
        >
          <span>#{pr.number}</span>
          <ExternalGlyph />
        </button>
      )}

      {/* State dot + plain-language label, with the precise git fact on the
          hover. The label used to BE the git fact — "Behind by 586 commits"
          on a bar whose own type calls this "plain-language (non-engineer
          audience)". See `branchStateLabel`. */}
      <span
        className="flex items-center gap-1.5 min-w-0 flex-1"
        title={state.detail}
      >
        {color && (
          <span
            className="w-1.5 h-1.5 rounded-full shrink-0"
            style={{ background: `var(${color})` }}
            aria-hidden
          />
        )}
        <span
          className="text-xs font-medium truncate"
          style={color ? { color: `var(${color})` } : undefined}
        >
          {state.label}
        </span>
      </span>

      <div className="flex items-center gap-1.5 shrink-0">
        {/* Exactly ONE action per state — never "Commit and push" sitting next
            to a greyed "Create PR". With a PR the lifecycle buttons (merge /
            pull / push / continue + archive) own the action. Without a PR, a
            clean or unpublished feature branch offers the single Create-PR
            affordance (which publishes first when needed); every other no-PR
            state has a blocking git step to finish first (resolve / pull /
            push / commit), so that primary shows alone. */}
        {!pr && (state.id === "clean" || state.id === "unpublished") ? (
          <CreatePrButton repoRoot={repoRoot} />
        ) : (
          <>
            {state.secondary && (
              <ActionButton
                action={state.secondary}
                tone="neutral"
                busy={busy || isActionRunning(state.secondary)}
                onClick={() => void runAction(state.secondary!)}
              />
            )}
            {state.primary && (
              <ActionButton
                action={state.primary}
                tone={state.tone}
                busy={busy || isActionRunning(state.primary)}
                onClick={() => void runAction(state.primary!)}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}

function tintFor(tone: ReviewTone): string {
  const v = toneVar(tone);
  if (v) return `color-mix(in srgb, var(${v}) 11%, transparent)`;
  if (tone === "neutral") return "var(--color-bg-2)";
  return "transparent";
}

function ActionButton({
  action,
  tone,
  busy,
  onClick,
}: {
  action: ReviewAction;
  tone: ReviewTone;
  busy: boolean;
  onClick: () => void;
}) {
  const v = toneVar(tone);
  // Coloured states carry the state colour in the button (matching the label);
  // neutral / none states use a calm neutral outline.
  const style = v
    ? {
        color: `var(${v})`,
        borderColor: `color-mix(in srgb, var(${v}) 40%, transparent)`,
      }
    : undefined;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      style={style}
      className={`h-[22px] px-2 rounded-md border text-xs font-medium inline-flex items-center gap-1.5 transition-colors hover:bg-state-hover disabled:opacity-50 disabled:cursor-default ${
        v ? "" : "border-line text-text-2 hover:text-text-1"
      }`}
    >
      {busy && <AsciiSpinner className="text-2xs" />}
      <span>{action.label}</span>
    </button>
  );
}

function ExternalGlyph() {
  return (
    <svg width="9" height="9" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M6 3h7v7M13 3 7 9M11 9.5V13H3V5h3.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
