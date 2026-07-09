// PR approval bar — Stage 7D. Three actions on a PR: Approve, Request
// Changes, Merge. Each opens a small inline body editor (Approve's body
// is optional; Request Changes requires a body). Merge picks a strategy
// (squash/merge/rebase) + delete-branch toggle.
//
// All call into Tauri `pr_*` commands which proxy to `gh pr review` /
// `gh pr merge`. Uses the same auth `gh` already has.

import { useState } from "react";
import { api } from "../../lib/api";
import { invalidatePrList } from "../../lib/prsCache";
import { invalidatePrDetail } from "../../lib/prDetailCache";
import { Button } from "../ui/button";

type Mode = "idle" | "approve" | "changes" | "merge";

type Props = {
  repoRoot: string;
  prNumber: number;
  state: string;
  isDraft: boolean;
  reviewDecision: string | null;
  onMutated: () => void;
};

export function PrApprovalBar({
  repoRoot,
  prNumber,
  state,
  isDraft,
  reviewDecision,
  onMutated,
}: Props) {
  const [mode, setMode] = useState<Mode>("idle");
  const [body, setBody] = useState("");
  const [strategy, setStrategy] = useState<"squash" | "merge" | "rebase">(
    "squash",
  );
  const [deleteBranch, setDeleteBranch] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    setMode("idle");
    setBody("");
    setError(null);
  };

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
        <span className="text-[12px] font-medium text-text-1">
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
          className="ml-auto w-5 h-5 text-text-4 hover:text-text-1 text-[14px]"
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
          <label className="flex items-center gap-1.5 text-[11px] text-text-3">
            <input
              type="checkbox"
              checked={deleteBranch}
              onChange={(e) => setDeleteBranch(e.target.checked)}
              className="w-3 h-3 accent-accent-violet"
            />
            Delete head branch after merge
          </label>
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
          className="w-full text-[12px] bg-bg-1 border border-line-soft rounded px-2 py-1.5 resize-y min-h-[80px] focus:outline-none focus:border-accent-blue"
        />
      )}
      {error && (
        <div className="mt-2 text-[11px] text-red font-mono whitespace-pre-wrap">
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
            (mode === "changes" && body.trim().length === 0)
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
