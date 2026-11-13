// The pull request's Checks tab. Flattens GitHub's status rollup into one
// shared check-run row per check so the reviewer can see *which* run failed,
// open its logs, re-run the failed ones, and hand the failing set to Aura to fix without
// leaving the app or touching a CLI.
//
// Data seam: `api.prChecks(repoRoot, number)` → PrCheck[] where each row
// carries a plain `bucket` ("success" | "failure" | "pending") we group by,
// `raw` (GitHub's own word) for the hover, and `url` to the run's logs. No
// new gh call shape — the same rollup `pr_list` reads.

import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2, RefreshCw } from "lucide-react";
import type { PrCheck, VercelDeployment } from "../../lib/api";
import { prChecks, prVercelStatus } from "../../lib/prApi";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { Button } from "../ui/button";
import { DetailsCheckList, DetailsChecks } from "../ui/details-checks";
import { DetailsCaption } from "../ui/details-panel";
import { EmptyState, LoadingState } from "../ui/state";
import { GhErrorNotice } from "../github/GhErrorNotice";
import {
  BUCKET_LABEL,
  BUCKET_ORDER,
  PrCheckRow,
  PrDeployRow,
  bucketOf,
  type CheckBucket,
} from "./checks/PrCheckRows";
import { FailingChecksActions } from "./checks/FailingChecksActions";
import "../ui/pr-checks.css";

type Props = {
  repoRoot: string;
  prNumber: number;
};

export function PrChecksTab({ repoRoot, prNumber }: Props) {
  const [rows, setRows] = useState<PrCheck[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // Vercel deploy for this PR's head commit — null when Vercel isn't
  // configured or has no deploy for the commit yet. Loaded independently
  // of the GH checks so a missing/slow Vercel never blocks the list.
  const [deploy, setDeploy] = useState<VercelDeployment | null>(null);

  const load = useCallback(
    async (bg: boolean) => {
      if (bg) setRefreshing(true);
      else setLoading(true);
      try {
        const list = await prChecks(repoRoot, prNumber);
        setRows(list);
        setError(null);
      } catch (e) {
        setError(String(e));
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [repoRoot, prNumber],
  );

  const loadDeploy = useCallback(async () => {
    try {
      setDeploy(await prVercelStatus(repoRoot, prNumber));
    } catch {
      // Soft: an unconfigured or unreachable Vercel simply shows no chip.
      setDeploy(null);
    }
  }, [repoRoot, prNumber]);

  useEffect(() => {
    void load(false);
    void loadDeploy();
  }, [load, loadDeploy]);

  const grouped = useMemo(() => {
    const g: Record<CheckBucket, PrCheck[]> = { failure: [], pending: [], success: [] };
    for (const c of rows ?? []) g[bucketOf(c)].push(c);
    return g;
  }, [rows]);

  const failing = grouped.failure;

  if (loading && !rows) {
    return <LoadingState size="md" label="Reading the checks…" />;
  }

  if (error) {
    return <GhErrorNotice error={error} align="center" onRetry={() => void load(false)} />;
  }

  const total = rows?.length ?? 0;
  if (total === 0) {
    return (
      <div className="ui-pr-checks">
        {deploy && (
          <DetailsCheckList>
            <PrDeployRow deploy={deploy} />
          </DetailsCheckList>
        )}
        <EmptyState
          icon={CheckCircle2}
          title="No checks on this pull request"
          body="Nothing is configured to run against this branch on GitHub yet — no CI, no required status checks."
        />
      </div>
    );
  }

  const summary = BUCKET_ORDER.filter((b) => grouped[b].length > 0)
    .map((b) => `${grouped[b].length} ${BUCKET_LABEL[b].toLowerCase()}`)
    .join(" · ");

  return (
    <div className="ui-pr-checks">
      <div className="ui-pr-checks-bar">
        <span className="ui-pr-checks-summary">{summary}</span>
        <span className="ui-pr-checks-spacer" />
        <FailingChecksActions
          repoRoot={repoRoot}
          prNumber={prNumber}
          failing={failing}
          onRerun={() => void load(true)}
        />
        <Button
          variant="ghost"
          size="xs"
          onClick={() => {
            void load(true);
            void loadDeploy();
          }}
          disabled={refreshing}
          title="Read the checks from GitHub again"
        >
          {refreshing ? <AsciiSpinner size={10} /> : <RefreshCw aria-hidden />}
          Refresh
        </Button>
      </div>
      <DetailsChecks style={{ flex: 1 }}>
        {deploy && (
          <section>
            <DetailsCaption>Deployments</DetailsCaption>
            <DetailsCheckList>
              <PrDeployRow deploy={deploy} />
            </DetailsCheckList>
          </section>
        )}
        {BUCKET_ORDER.map((b) => {
          const items = grouped[b];
          if (items.length === 0) return null;
          return (
            <section key={b}>
              <DetailsCaption>
                {BUCKET_LABEL[b]} · {items.length}
              </DetailsCaption>
              <DetailsCheckList>
                {items.map((c, i) => (
                  <PrCheckRow key={`${c.name}-${i}`} check={c} />
                ))}
              </DetailsCheckList>
            </section>
          );
        })}
      </DetailsChecks>
    </div>
  );
}
