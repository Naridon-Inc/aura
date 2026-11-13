// Aura Wrapped — a calm "year in review" built ENTIRELY from the local intent
// log, and written to Aura's honesty rule.
//
// HONESTY RULE (inherited from OverviewPane): every number here is derived only
// from real `api.auraIntentRecent` rows. There are NO tokens, NO cost, NO
// fabricated metrics — only what the intent log actually records: how many
// intents you logged, the +/− churn each carried, which agents you worked
// through, how your days clustered, and how much of it was cryptographically
// signed. When a year has no rows we show a quiet empty state, never fake ones.
//
// Cross-agent by construction: the breakdown groups by `agent_id`, so the
// native Aura brain and every CLI agent (Claude, Codex, Gemini, Cursor, Kimi,
// OpenCode) each appear as a first-class collaborator with its own logo.

import { useEffect, useMemo, useState } from "react";
import { type ClaudeSession, type IntentRow } from "../../lib/api";
import { fetchSessions } from "../../lib/sessionsCache";
import { fetchIntentRows } from "../../lib/intentCache";
import { FullscreenOverlay } from "../FullscreenOverlay";
import { ErrorState, LoadingState } from "../ui/state";
import { TraceLine, TraceReport } from "../ui/trace-report";
import {
  BigGrid,
  Collaborators,
  EmptyYear,
  Hero,
  MonthlyStrip,
  Provenance,
  Rhythm,
  WorkMix,
} from "../trace/wrapped/WrappedSections";
import { computeWrapped } from "../trace/wrapped/wrappedStats";
import "../trace/wrapped/wrapped.css";

export function TraceWrapped({
  repoRoot,
  onClose,
}: {
  repoRoot: string;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<IntentRow[]>([]);
  // Real Claude Code sessions — best-effort, used to fold a run's `[auto]`
  // stub spam into one entry per session before counting (see sessionMeta).
  const [claudeSessions, setClaudeSessions] = useState<ClaudeSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [year, setYear] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    Promise.all([
      // A generous ceiling so a full year of activity is covered — and it has
      // to be honoured, not just asked for. The backend used to cap every read
      // at 500 rows, so on any repo past 500 intents this pane silently
      // reviewed only the recent tail: the year picker below is built from
      // whatever years appear in these rows, so older years did not merely
      // read low, they were not offered at all.
      //
      // Shared with the Overview pane, which asks for the same rows and is
      // usually the surface this one was opened from.
      fetchIntentRows(repoRoot, 5000),
      fetchSessions(repoRoot).catch(() => [] as ClaudeSession[]),
    ])
      .then(([data, sessions]) => {
        if (!alive) return;
        setRows(Array.isArray(data) ? data : []);
        setClaudeSessions(Array.isArray(sessions) ? sessions : []);
        setLoading(false);
      })
      .catch((e) => {
        if (!alive) return;
        setError(String(e));
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [repoRoot]);

  // Years that actually have rows, newest first. Default selection = newest.
  const years = useMemo(() => {
    const set = new Set<number>();
    for (const r of rows) set.add(new Date(r.timestamp * 1000).getFullYear());
    return [...set].sort((a, b) => b - a);
  }, [rows]);

  useEffect(() => {
    if (year === null && years.length > 0) setYear(years[0]);
  }, [years, year]);

  const activeYear = year ?? years[0] ?? new Date().getFullYear();
  const stats = useMemo(
    () => computeWrapped(rows, claudeSessions, activeYear),
    [rows, claudeSessions, activeYear],
  );

  return (
    <FullscreenOverlay onClose={onClose}>
      <div className="ui-wrapped-body">
        <TraceReport>
          {loading && rows.length === 0 ? (
            // The shared loader, not bare text: this read takes seconds on a
            // full year, and a motionless line reads as a stall.
            <LoadingState label="Reading your year…" size="md" className="py-16" />
          ) : error ? (
            <ErrorState
              title="Couldn’t read your year"
              message={`Aura couldn’t open this repository’s history log. ${error}`}
              className="py-16"
            />
          ) : stats.total === 0 ? (
            <EmptyYear year={activeYear} years={years} onPick={setYear} />
          ) : (
            <>
              <Hero year={activeYear} years={years} onPick={setYear} stats={stats} />
              <BigGrid stats={stats} />
              <Collaborators stats={stats} />
              <Rhythm stats={stats} />
              <MonthlyStrip stats={stats} />
              {stats.types.length > 0 && <WorkMix stats={stats} />}
              <Provenance stats={stats} />
              <div className="ui-wrapped-foot">
                <TraceLine tone="note">
                  Built only from your local intent log. Nothing here left this machine.
                </TraceLine>
              </div>
            </>
          )}
        </TraceReport>
      </div>
    </FullscreenOverlay>
  );
}
