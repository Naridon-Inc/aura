// Every pull request in a repository, on the Dashboard. The Checks tab holds
// one workspace's own pull request; this is where all of them are: filter
// chips across the top (the awaiting-review / mine / … buckets) and the pull
// requests in the chosen one below. A row opens the pull request as a tab.
//
// One workspace is one branch, so each pull request either has a workspace
// on this computer (Go to workspace) or doesn't yet (Open as workspace, which
// starts the Create workspace dialog from that pull request).
//
// The header count and the default "Open" view are OPEN pull requests only;
// merged and closed ones stay reachable through their bucket chips, which see
// the full list. Data is shared through `prsCache`, so the sidebar, the
// Checks tab and this list never fetch twice and a change anywhere repaints
// all of them.

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowRight, GitBranchPlus, RefreshCw } from "lucide-react";

import { sentenceCase } from "@shared/textCase";
import { type PrSummary } from "../../lib/api";
import { useEditorStore } from "../../lib/editorStore";
import {
  fetchPrList,
  getPrListCached,
  invalidatePrList,
  subscribePrList,
} from "../../lib/prsCache";
import { GhErrorNotice } from "../github/GhErrorNotice";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { Button } from "../ui/button";
import { DetailsCaption } from "../ui/details-panel";
import { DetailsPullRow, type DetailsPullTone } from "../ui/details-pulls";
import { LoadingState } from "../ui/state";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group";
import {
  bucketize,
  BUCKET_LABEL,
  BUCKET_DOT,
  BUCKET_ORDER,
  type Bucket,
} from "../workpanes/InboxPane";
import { prWorkspaces } from "./pullRequestWorkspaces";
import "../ui/dashboard-pulls.css";

// "all" is the implicit default chip; the rest mirror the Inbox buckets.
type Filter = "all" | Bucket;

export function PullRequestList({
  repoRoot,
  repositoryName,
  worktrees,
  onOpenedPr,
  onGoToWorkspace,
  onOpenAsWorkspace,
}: {
  repoRoot: string;
  /** Said in the caption, so the list says whose pull requests these are. */
  repositoryName?: string;
  /** The repository's checkouts, to tell which pull requests have one. */
  worktrees: { path: string; branch: string }[];
  /** Called once a row has opened its pull request as a tab, so a page
   *  drawn over the editor can step aside for it. */
  onOpenedPr?: () => void;
  onGoToWorkspace?: (path: string) => void;
  onOpenAsWorkspace?: (pr: PrSummary) => void;
}) {
  const editor = useEditorStore();
  const cached = getPrListCached(repoRoot);
  const [prs, setPrs] = useState<PrSummary[]>(cached ?? []);
  const [loading, setLoading] = useState(cached == null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");

  const refresh = useCallback(
    async (force = false) => {
      if (getPrListCached(repoRoot) == null) setLoading(true);
      setError(null);
      try {
        const list = await (force ? invalidatePrList(repoRoot) : fetchPrList(repoRoot));
        setPrs(list);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [repoRoot],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => subscribePrList(repoRoot, (list) => setPrs(list)), [repoRoot]);

  // OPEN PRs drive the count + the default list; merged/closed history is
  // excluded so the number matches what's actually listed and actionable.
  const openPrs = useMemo(() => prs.filter((p) => p.state.toLowerCase() === "open"), [prs]);
  // Buckets still see the full list so the Merged chip keeps working.
  const buckets = useMemo(() => bucketize(prs), [prs]);
  // Only chips that have pull requests in them.
  const activeChips = useMemo(() => BUCKET_ORDER.filter((b) => buckets[b].length > 0), [buckets]);
  const homes = useMemo(() => prWorkspaces(prs, worktrees), [prs, worktrees]);

  const rows =
    filter === "all"
      ? [...openPrs].sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))
      : buckets[filter];

  const selected = editor.selectedPr?.repoRoot === repoRoot ? editor.selectedPr.number : null;
  const openPr = (p: PrSummary) => {
    editor.openPrDetail(repoRoot, p.number, p.title);
    onOpenedPr?.();
  };

  // Go to the pull request's workspace, or make it one. A merged or closed
  // pull request has nothing left to work on, so it is only offered the way
  // back to a workspace that still exists.
  const actionFor = (p: PrSummary) => {
    const home = homes.get(p.number);
    if (home) {
      return onGoToWorkspace ? (
        <Button size="xs" variant="ghost" onClick={() => onGoToWorkspace(home)} title={home}>
          Go to workspace
          <ArrowRight />
        </Button>
      ) : undefined;
    }
    if (!onOpenAsWorkspace || p.state.toLowerCase() !== "open") return undefined;
    return (
      <Button
        size="xs"
        variant="ghost"
        onClick={() => onOpenAsWorkspace(p)}
        title="Start a workspace from this pull request"
      >
        <GitBranchPlus />
        Open as workspace
      </Button>
    );
  };

  return (
    <div className="ui-dashboard-pulls">
      <div className="ui-details-group-caption">
        <DetailsCaption>
          {repositoryName ? `Pull requests in ${repositoryName}` : "Pull requests"} · {openPrs.length}
        </DetailsCaption>
        <Button
          size="iconXs"
          variant="ghost"
          aria-label="Refresh pull requests"
          title="Refresh"
          disabled={loading}
          onClick={() => void refresh(true)}
        >
          {loading ? <AsciiSpinner /> : <RefreshCw />}
        </Button>
      </div>

      {/* "Open", not "All": it counts open PRs. These are named views over
          one list; the first is the open ones. */}
      {activeChips.length > 0 && (
        <ToggleGroup
          type="single"
          size="sm"
          aria-label="Filter pull requests"
          className="ui-details-pull-filters"
          value={filter}
          onValueChange={(v) => v && setFilter(v as Filter)}
        >
          <ToggleGroupItem value="all">
            Open <small>{openPrs.length}</small>
          </ToggleGroupItem>
          {activeChips.map((b) => (
            <ToggleGroupItem key={b} value={b}>
              <i className={BUCKET_DOT[b]} aria-hidden />
              {BUCKET_LABEL[b]} <small>{buckets[b].length}</small>
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      )}

      <div className="ui-dashboard-pulls-list">
        {loading && prs.length === 0 ? (
          <LoadingState label="Looking for pull requests…" />
        ) : error ? (
          <GhErrorNotice error={error} onRetry={() => void refresh(true)} />
        ) : rows.length === 0 ? (
          <DetailsCaption>
            {filter === "all" ? "No open pull requests." : `Nothing in “${BUCKET_LABEL[filter]}”.`}
          </DetailsCaption>
        ) : (
          rows.map((p) => (
            <DetailsPullRow
              key={p.number}
              number={p.number}
              title={p.title}
              author={p.author}
              branch={p.head_ref}
              risk={riskTone(p.aura_risk_score)}
              decision={
                p.review_decision
                  ? { label: humanDecision(p.review_decision), tone: decisionTone(p.review_decision) }
                  : undefined
              }
              checks={checksOf(p.checks_state)}
              added={p.additions}
              removed={p.deletions}
              selected={p.number === selected}
              onSelect={() => openPr(p)}
              action={actionFor(p)}
            />
          ))
        )}
      </div>
    </div>
  );
}

// Colour only where it means "this needs you": a risky change is red, a
// slightly risky one amber, and "nothing to flag" stays quiet rather than
// painting a green dot on every row.
function riskTone(score: number | null): DetailsPullTone {
  if (score === null) return "quiet";
  return score > 60 ? "bad" : score > 0 ? "waiting" : "quiet";
}

function decisionTone(d: string): DetailsPullTone {
  return d === "APPROVED" ? "good" : d === "CHANGES_REQUESTED" ? "bad" : "quiet";
}

function checksOf(state: string | null): { label: string; tone: DetailsPullTone } | undefined {
  if (!state) return undefined;
  if (state === "success") return { label: "Checks passed", tone: "good" };
  if (state === "failure") return { label: "Checks failed", tone: "bad" };
  return { label: "Checks still running", tone: "waiting" };
}

/** `CHANGES_REQUESTED` → "Changes requested". Sentence case, like every other
 *  status word in the app — see lib/textCase. */
function humanDecision(d: string): string {
  return sentenceCase(d.toLowerCase().replace(/_/g, " "));
}
