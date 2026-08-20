// PR approval bar — Stage 7D. Three actions on a PR: Approve, Request
// Changes, Merge. Each opens a small inline body editor (Approve's body
// is optional; Request Changes requires a body). Merge picks a strategy
// (squash/merge/rebase) + delete-branch toggle.
//
// All call into Tauri `pr_*` commands which proxy to `gh pr review` /
// `gh pr merge`. Uses the same auth `gh` already has.

import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { invalidatePrList } from "../../lib/prsCache";
import { invalidatePrDetail } from "../../lib/prDetailCache";
import { Button } from "../ui/button";

type Mode = "idle" | "approve" | "changes" | "merge";

/** Asks the approval bar to open its merge panel for a given PR. Lets a
 *  control elsewhere on the page start a merge without owning one. */
export const PR_MERGE_REQUEST_EVENT = "aura:pr:request-merge";

/** Fire {@link PR_MERGE_REQUEST_EVENT} for one PR. */
export function requestPrMerge(repoRoot: string, prNumber: number): void {
  window.dispatchEvent(
    new CustomEvent(PR_MERGE_REQUEST_EVENT, { detail: { repoRoot, prNumber } }),
  );
}

type Props = {
  repoRoot: string;
  prNumber: number;
  state: string;
  isDraft: boolean;
  reviewDecision: string | null;
  onMutated: () => void;
  /** Failing GitHub check count (from the PR's statusCheckRollup). When > 0
   *  the Merge panel gates the button behind an explicit "Merge anyway"
   *  override — Conductor's optional-checks-as-blocking parity. */
  failingChecks?: number;
  /** Still-running check count — informational note, does not block. */
  pendingChecks?: number;
};

export function PrApprovalBar({
  repoRoot,
  prNumber,
  state,
  isDraft,
  reviewDecision,
  onMutated,
  failingChecks = 0,
  pendingChecks = 0,
}: Props) {
  const [mode, setMode] = useState<Mode>("idle");
  const [body, setBody] = useState("");
  const [strategy, setStrategy] = useState<"squash" | "merge" | "rebase">(
    "squash",
  );
  const [deleteBranch, setDeleteBranch] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Explicit acknowledgement to merge over red/failing checks. Reset every
  // time the panel closes so the gate re-arms for the next merge attempt.
  const [overrideChecks, setOverrideChecks] = useState(false);

  const close = () => {
    setMode("idle");
    setBody("");
    setError(null);
    setOverrideChecks(false);
  };

  const mergeBlocked = failingChecks > 0 && !overrideChecks;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (mode === "approve") {
        await api.prApprove(repoRoot, prNumber, body || undefined);
      } else if (mode === "changes") {
        await api.prRequestChanges(repoRoot, prNumber, body);
      } else if (mode === "merge") {
        await api.prMerge(repoRoot, prNumber, strategy, deleteBranch);
      }
      // Mutations changed PR state — propagate to every cached list so
      // Inbox / sidebar / overview refresh from the same source. Also
      // hot-bust the per-PR detail cache so reopening reflects the new
      // state instead of the pre-mutation snapshot.
      void invalidatePrList(repoRoot);
      void invalidatePrDetail(repoRoot, prNumber);
      close();
      onMutated();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const open = state.toLowerCase() === "open" && !isDraft;
  const approved = reviewDecision === "APPROVED";

  // The right rail's "Merge PR" card asks to merge from the other side of
  // the page. It routes here rather than calling `api.prMerge` itself, so
  // there is one merge in the app — one strategy picker, one delete-branch
  // choice, one failing-checks gate — instead of a second implementation
  // that can drift from this one.
  useEffect(() => {
    function onRequest(e: Event) {
      const d = (e as CustomEvent<{ repoRoot: string; prNumber: number }>).detail;
      if (!d || d.repoRoot !== repoRoot || d.prNumber !== prNumber) return;
      if (!open) return;
      setMode("merge");
    }
    window.addEventListener(PR_MERGE_REQUEST_EVENT, onRequest);
    return () => window.removeEventListener(PR_MERGE_REQUEST_EVENT, onRequest);
  }, [repoRoot, prNumber, open]);

  if (mode === "idle") {
    return (
      <div className="flex items-center gap-1.5">
        <Button
          variant="accentSoft"
          size="xs"
          disabled={!open}
          onClick={() => setMode("approve")}
          title={approved ? "Already approved" : "Approve this PR"}
        >
          {approved ? "✓ Approved" : "Approve"}
        </Button>
        <Button
          variant="destructive"
          size="xs"
          disabled={!open}
          onClick={() => setMode("changes")}
        >
          Request changes
        </Button>
        <Button
          variant="default"
          size="xs"
          disabled={!open}
          onClick={() => setMode("merge")}
        >
          Merge
        </Button>
      </div>
    );
  }

  return (
    <div className="absolute top-11 right-4 z-10 w-[360px] bg-bg-content border border-line rounded shadow-sm p-3">
      <div className="flex items-center mb-2">
        <span className="text-sm font-medium text-text-1">
          {mode === "approve"
            ? "Approve PR"
            : mode === "changes"
              ? "Request changes"
              : "Merge PR"}
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={close}
          className="ml-auto w-5 h-5 text-text-4 hover:text-text-1 text-md"
        >
          ×
        </Button>
      </div>
      {mode === "merge" ? (
        <div className="space-y-2">
          <div className="flex items-center gap-1.5">
            {(["squash", "merge", "rebase"] as const).map((s) => (
              <Button
                key={s}
                variant={strategy === s ? "secondary" : "subtle"}
                size="xs"
                onClick={() => setStrategy(s)}
                className="flex-1 capitalize"
              >
                {s}
              </Button>
            ))}
          </div>
          <label className="flex items-center gap-1.5 text-xs text-text-3">
            <input
              type="checkbox"
              checked={deleteBranch}
              onChange={(e) => setDeleteBranch(e.target.checked)}
              className="w-3 h-3" style={{ accentColor: "var(--color-accent)" }}
            />
            Delete head branch after merge
          </label>
          {failingChecks > 0 && (
            <div className="rounded border border-red/30 bg-red/[0.06] px-2.5 py-2 space-y-1.5">
              <div className="text-sm text-red">
                {failingChecks} check{failingChecks === 1 ? " is" : "s are"} failing
                on this PR.
              </div>
              <label className="flex items-center gap-1.5 text-xs text-text-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={overrideChecks}
                  onChange={(e) => setOverrideChecks(e.target.checked)}
                  className="w-3 h-3 accent-red-500"
                />
                Merge anyway
              </label>
            </div>
          )}
          {failingChecks === 0 && pendingChecks > 0 && (
            <div className="text-xs text-amber">
              {pendingChecks} check{pendingChecks === 1 ? " is" : "s are"} still
              running.
            </div>
          )}
        </div>
      ) : (
        <textarea
          autoFocus
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={
            mode === "changes"
              ? "What needs to change? (required)"
              : "Optional approval message"
          }
          className="w-full text-sm bg-bg-1 border border-line-soft rounded px-2 py-1.5 resize-y min-h-[80px] focus:outline-none focus:border-accent-blue"
        />
      )}
      {error && (
        <div className="mt-2 text-xs text-red font-mono whitespace-pre-wrap">
          {error}
        </div>
      )}
      <div className="flex items-center gap-1.5 mt-2">
        <Button
          variant={
            mode === "approve"
              ? "accentSoft"
              : mode === "changes"
                ? "destructive"
                : "default"
          }
          size="xs"
          onClick={submit}
          disabled={
            busy ||
            (mode === "changes" && body.trim().length === 0) ||
            (mode === "merge" && mergeBlocked)
          }
        >
          {busy
            ? "…"
            : mode === "approve"
              ? "Approve"
              : mode === "changes"
                ? "Request changes"
                : `Merge (${strategy})`}
        </Button>
        <Button variant="ghost" size="xs" onClick={close}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
