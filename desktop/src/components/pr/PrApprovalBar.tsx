// The pull request's review footer: Approve, Request changes, Merge.
// Approve is ONE click — it submits straight away, since an approval with no
// note is by far the common case. "Approve with a note" sits in the menu
// beside it and opens the written review. Request changes always needs a
// note. Merge opens the one merge dialog: method, delete-branch, and the
// failing-checks gate.
//
// All call into Tauri `pr_*` commands which proxy to `gh pr review` /
// `gh pr merge`, with the auth `gh` already has.

import { useEffect, useState } from "react";
import { Check, ChevronDown, GitMerge } from "lucide-react";
import { prApprove, prMerge, prRequestChanges } from "../../lib/prApi";
import { invalidatePrDetail } from "../../lib/prDetailCache";
import { invalidatePrList } from "../../lib/prsCache";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { useAfterMenuClose } from "../ui/after-menu-close";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { PrMergeDialog, type MergeMethod } from "./approval/PrMergeDialog";
import { PrReviewDialog, type ReviewKind } from "./approval/PrReviewDialog";
import "../ui/pr-review.css";

/** Asks the review footer to open its merge dialog for a given PR. Lets a
 *  control elsewhere on the page start a merge without owning one. */
export const PR_MERGE_REQUEST_EVENT = "aura:pr:request-merge";

/** Fire {@link PR_MERGE_REQUEST_EVENT} for one PR. */
export function requestPrMerge(repoRoot: string, prNumber: number): void {
  window.dispatchEvent(
    new CustomEvent(PR_MERGE_REQUEST_EVENT, { detail: { repoRoot, prNumber } }),
  );
}

type Open = ReviewKind | "merge" | null;

type Props = {
  repoRoot: string;
  prNumber: number;
  state: string;
  isDraft: boolean;
  reviewDecision: string | null;
  /** The branch a merge lands on, said in the merge dialog. */
  baseRef?: string | null;
  onMutated: () => void;
  /** Failing check count (from the PR's statusCheckRollup). When > 0 the
   *  merge dialog holds its button behind an explicit "Merge anyway", so an
   *  optional check can still block a merge. */
  failingChecks?: number;
  /** Still-running check count — said in the merge dialog, does not block. */
  pendingChecks?: number;
};

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function PrApprovalBar({
  repoRoot,
  prNumber,
  state,
  isDraft,
  reviewDecision,
  baseRef = null,
  onMutated,
  failingChecks = 0,
  pendingChecks = 0,
}: Props) {
  const [opened, setOpened] = useState<Open>(null);
  const [busy, setBusy] = useState(false);
  // A failure from a dialog shows in that dialog; a failure from the
  // one-click Approve shows beside the buttons, where the click happened.
  const [error, setError] = useState<string | null>(null);
  const [approveError, setApproveError] = useState<string | null>(null);

  const open = state.toLowerCase() === "open" && !isDraft;
  const approved = reviewDecision === "APPROVED";

  const show = (next: Open) => {
    setError(null);
    setOpened(next);
  };
  // "Approve with a note…" opens its dialog once the menu has closed.
  const afterClose = useAfterMenuClose();

  // Every review and merge changes the PR, so every cached copy of it —
  // the list, the detail, the page — is refreshed from the same place.
  const settle = () => {
    void invalidatePrList(repoRoot);
    void invalidatePrDetail(repoRoot, prNumber);
    onMutated();
  };

  const run = async (act: () => Promise<unknown>, onError: (m: string) => void) => {
    if (busy) return false;
    setBusy(true);
    try {
      await act();
      settle();
      return true;
    } catch (e) {
      onError(message(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const approveNow = () => {
    setApproveError(null);
    void run(() => prApprove(repoRoot, prNumber, undefined), setApproveError);
  };

  const sendReview = async (body: string) => {
    setError(null);
    const kind = opened;
    const ok = await run(
      () =>
        kind === "changes"
          ? prRequestChanges(repoRoot, prNumber, body)
          : prApprove(repoRoot, prNumber, body || undefined),
      setError,
    );
    if (ok) setOpened(null);
  };

  const merge = async (method: MergeMethod, deleteBranch: boolean) => {
    setError(null);
    const ok = await run(() => prMerge(repoRoot, prNumber, method, deleteBranch), setError);
    if (ok) setOpened(null);
  };

  // A merge asked for from elsewhere on the page routes here rather than
  // calling `prMerge` itself, so there is one merge in the app — one method
  // picker, one delete-branch choice, one failing-checks gate.
  useEffect(() => {
    function onRequest(e: Event) {
      const d = (e as CustomEvent<{ repoRoot: string; prNumber: number }>).detail;
      if (!d || d.repoRoot !== repoRoot || d.prNumber !== prNumber) return;
      if (!open) return;
      setError(null);
      setOpened("merge");
    }
    window.addEventListener(PR_MERGE_REQUEST_EVENT, onRequest);
    return () => window.removeEventListener(PR_MERGE_REQUEST_EVENT, onRequest);
  }, [repoRoot, prNumber, open]);

  const approving = busy && opened === null;

  return (
    <div className="ui-pr-review-actions">
      {approveError && (
        <span role="alert" title={approveError}>
          Couldn&apos;t approve: {approveError}
        </span>
      )}
      <div className="ui-git-action-group">
        <Button
          variant="outline"
          size="sm"
          disabled={!open || busy}
          onClick={approveNow}
          title={
            approved
              ? "Already approved. Approve again to refresh your review."
              : "Approve this pull request now, with no note"
          }
        >
          {approving ? <AsciiSpinner size={10} /> : <Check />}
          {approving ? "Approving…" : approved ? "Approved" : "Approve"}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="iconSm"
              disabled={!open || busy}
              aria-label="More ways to approve"
              title="More ways to approve"
            >
              <ChevronDown />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" onCloseAutoFocus={afterClose.onCloseAutoFocus}>
            <DropdownMenuItem onSelect={afterClose.later(() => show("approve"))}>
              Approve with a note…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <Button variant="outline" size="sm" disabled={!open || busy} onClick={() => show("changes")}>
        Request changes
      </Button>
      <Button size="sm" disabled={!open || busy} onClick={() => show("merge")}>
        <GitMerge />
        Merge
      </Button>

      <PrReviewDialog
        kind={opened === "approve" || opened === "changes" ? opened : null}
        prNumber={prNumber}
        busy={busy}
        error={error}
        onCancel={() => setOpened(null)}
        onSubmit={(body) => void sendReview(body)}
      />
      <PrMergeDialog
        open={opened === "merge"}
        prNumber={prNumber}
        baseRef={baseRef}
        failingChecks={failingChecks}
        pendingChecks={pendingChecks}
        busy={busy}
        error={error}
        onCancel={() => setOpened(null)}
        onMerge={(method, deleteBranch) => void merge(method, deleteBranch)}
      />
    </div>
  );
}
