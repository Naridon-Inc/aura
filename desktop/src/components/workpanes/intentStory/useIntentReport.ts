// Loading the change story's report. One commit (`useIntentReport`), or every
// commit a run landed as, merged into one (`useSessionIntentReport`). Both go
// through `aura intent-vs-actual show <sha> --json` over the `api.auraCli`
// passthrough, so the standalone page, the Alignment tab and the History
// detail all load a report the same way.

import { useEffect, useMemo, useState } from "react";
import { api, type IntentChangesetFile } from "../../../lib/api";
import { mergeIntentReports, type IntentReport } from "./intentReport";

/** Load the per-commit alignment report for one sha. `sha === null` is the
 *  idle state — no fetch, no error — so a caller can gate the CLI call on a
 *  tab being active. Re-fetches whenever repoRoot or sha changes. */
export function useIntentReport(
  repoRoot: string,
  sha: string | null,
): { report: IntentReport | null; loading: boolean; error: string | null } {
  const [report, setReport] = useState<IntentReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!sha) {
      setReport(null);
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .auraCli(repoRoot, ["intent-vs-actual", "show", sha, "--json"])
      .then((r) => {
        if (cancelled) return;
        if (r.status !== 0) {
          setError(r.stderr.trim() || `aura exit ${r.status}`);
          setReport(null);
          setLoading(false);
          return;
        }
        try {
          setReport(JSON.parse(r.stdout) as IntentReport);
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        } finally {
          setLoading(false);
        }
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [repoRoot, sha]);

  return { report, loading, error };
}

/** Run-level alignment report: load `intent-vs-actual show` for every distinct
 *  commit in the run's changeset and merge them, so the Alignment tab judges
 *  the whole run (matching the Changes tab's file scope) instead of just the
 *  first commit. `active === false` is the idle gate (no fetch) so the CLI
 *  fan-out stays off the Summary-first open. Best-effort per commit — a commit
 *  whose report fails is skipped, and the tab only errors when *every* commit
 *  fails. Keys on the distinct-commit set, so it won't refire on unrelated
 *  re-renders even though `files` is a fresh array each time. */
export function useSessionIntentReport(
  repoRoot: string,
  files: IntentChangesetFile[],
  active: boolean,
): { report: IntentReport | null; loading: boolean; error: string | null } {
  const commitKey = useMemo(() => {
    const set = new Set<string>();
    for (const f of files) {
      const c = (f.commit ?? "").trim();
      if (c) set.add(c);
    }
    return [...set].sort().join(",");
  }, [files]);

  const [report, setReport] = useState<IntentReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!active || !repoRoot || !commitKey) {
      setReport(null);
      setLoading(false);
      setError(null);
      return;
    }
    const commits = commitKey.split(",");
    let cancelled = false;
    setLoading(true);
    setError(null);

    Promise.all(
      commits.map((sha) =>
        api
          .auraCli(repoRoot, ["intent-vs-actual", "show", sha, "--json"])
          .then((r) => {
            if (r.status !== 0) return null;
            try {
              return JSON.parse(r.stdout) as IntentReport;
            } catch {
              return null;
            }
          })
          .catch(() => null),
      ),
    ).then((results) => {
      if (cancelled) return;
      const live = results.filter((r): r is IntentReport => r !== null);
      if (live.length === 0) {
        setReport(null);
        setError(
          `Couldn't read changes for ${commits.length} commit${commits.length === 1 ? "" : "s"}.`,
        );
      } else {
        setReport(mergeIntentReports(live));
        setError(null);
      }
      setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [repoRoot, commitKey, active]);

  return { report, loading, error };
}
