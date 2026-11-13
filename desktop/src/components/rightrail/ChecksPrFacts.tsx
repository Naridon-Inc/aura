// The workspace's pull request as a short list under its title: the branch
// and where it goes, who is reviewing it, what stands between it and a merge
// (with Merge itself once nothing does), and the stack it sits on when it
// sits on one. Before there is a pull request the branch row stands alone.

import type { ReactNode } from "react";
import { ArrowRight, ExternalLink, GitBranch, GitMerge, Users } from "lucide-react";

import type { PrSummary } from "../../lib/api";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { Button } from "../ui/button";

/** Branch → where it goes. `base` is left off where there's nowhere to go. */
export function BranchFact({ head, base }: { head: string; base: string | null }) {
  return (
    <>
      <dt>
        <GitBranch />
        Branch
      </dt>
      <dd>
        <code title={head}>{head}</code>
        {base && (
          <>
            <ArrowRight size={12} aria-label="into" />
            <code title={base}>{base}</code>
          </>
        )}
      </dd>
    </>
  );
}

/** The list itself, for the facts above and for the branch on its own. */
export function FactsList({ children }: { children: ReactNode }) {
  return <dl className="ui-pr-details ui-pr-details--rail">{children}</dl>;
}

export function ChecksPrFacts({
  pr,
  reviewers,
  merge,
  onRequestReview,
  stack = null,
}: {
  pr: PrSummary;
  /** `null` until the pull request's details are read. */
  reviewers: string | null;
  merge: {
    label: string;
    canMerge: boolean;
    merging: boolean;
    onMerge: () => void;
    /** Set while the pull request waits in a merge queue: open the queue. */
    onOpenQueue?: (() => void) | null;
  };
  /** Open the pull request where reviewers are picked. */
  onRequestReview: () => void;
  /** The Stack row; it draws nothing unless the pull request is stacked. */
  stack?: ReactNode;
}) {
  const open = pr.state.toLowerCase() === "open";
  return (
    <FactsList>
      <BranchFact head={pr.head_ref} base={pr.base_ref} />
      <dt>
        <Users />
        Review
      </dt>
      <dd>
        <span className="ui-pr-details-text">{reviewers ?? "…"}</span>
        {open && (
          <Button
            size="xs"
            variant="ghost"
            onClick={onRequestReview}
            title="Opens the pull request on GitHub, where reviewers are picked."
          >
            Request
          </Button>
        )}
      </dd>
      {open && (
        <>
          <dt>
            <GitMerge />
            Merge
          </dt>
          <dd>
            <span className="ui-pr-details-text">{merge.label}</span>
            {merge.canMerge ? (
              <Button size="xs" onClick={merge.onMerge} disabled={merge.merging}>
                {merge.merging && <AsciiSpinner />}
                {merge.merging ? "Merging…" : "Merge"}
              </Button>
            ) : (
              merge.onOpenQueue && (
                <Button size="xs" variant="ghost" onClick={merge.onOpenQueue} title="Opens the merge queue on GitHub.">
                  Queue
                  <ExternalLink />
                </Button>
              )
            )}
          </dd>
        </>
      )}
      {stack}
    </FactsList>
  );
}
