// SessionAlignment — the Alignment tab body of a session detail.
//
// It answers one question about this run's committed change: does the code
// match what was asked? Drawn as the same report column as the session's
// Summary and the change story — a verdict line, then quiet sections — so the
// detail reads as one document front to back:
//
//   • Overview  — how much changed, and whether any of it is worth a look
//   • Asked     — the closest recorded signal to the original ask
//   • Said      — what the agent logged as it worked (when present)
//   • Changed   — what actually changed, per piece, risk-first
//   • Recover   — putting one piece back, explained
//
// Data is the shared `aura intent-vs-actual show` report, loaded by the pane
// and passed in. The asked/said split, the pieces and the beats are the change
// story's own parts, so the two surfaces never disagree on the facts.

import { useMemo } from "react";
import type { ClaudeSession } from "../../lib/api";
import { changeCounts, changeSummary, safetyLine, type SafetyTone } from "@shared/changeSafety";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { TraceNote } from "../ui/trace-detail";
import { TraceLine, TraceReport, TraceVerdict, type TraceTone } from "../ui/trace-report";
import {
  AskedBeat,
  Beat,
  RecoverBeat,
  SaidBeat,
  deriveAskedSaid,
  type IntentReport,
} from "./IntentStory";
import { AlignmentChanged } from "./sessionAlignment/AlignmentChanged";
import "../ui/intent-story.css";

export function SessionAlignment({
  repoRoot,
  report,
  sessions,
  loading,
  error,
  onDismiss,
}: {
  repoRoot: string;
  report: IntentReport | null;
  sessions: ClaudeSession[];
  loading: boolean;
  error: string | null;
  /** Closes the fullscreen session overlay. Open / Bring this back route to
   *  the editor *behind* this overlay, so without dismissing it the click
   *  looks dead — we call this after firing the action so the result shows. */
  onDismiss?: () => void;
}) {
  if (loading) {
    return (
      <div className="ui-intent-story">
        <div className="ui-story-state" role="status">
          <AsciiSpinner />
          <span>Reading how this change lines up…</span>
        </div>
      </div>
    );
  }
  if (error) {
    return (
      <div className="ui-intent-story">
        <div className="ui-story-state" data-tone="error">
          <TraceLine tone="danger">Couldn’t read how this change lines up.</TraceLine>
          <code className="ui-story-error">{error}</code>
        </div>
      </div>
    );
  }
  if (!report) {
    return (
      <div className="ui-intent-story">
        <TraceNote title="Nothing to line up yet">
          This run has no committed change to compare with what was asked.
        </TraceNote>
      </div>
    );
  }

  const { asked, said } = deriveAskedSaid(report, sessions);

  return (
    <div className="ui-intent-story">
      <TraceReport>
        {/* Plain-language: what the AI changed, and is any of it worth a
            second look. No match score, no goal-linking. */}
        <ChangeOverview report={report} />
        <Beat label="Asked" hint="closest recorded signal">
          <AskedBeat asked={asked} />
        </Beat>
        {said.length > 0 && (
          <Beat label="Said" hint="what the agent logged">
            <SaidBeat said={said} />
          </Beat>
        )}
        <Beat label="What changed" hint="worth a look first">
          <AlignmentChanged report={report} onDismiss={onDismiss} />
        </Beat>
        <Beat label="Recover" hint="if something's wrong">
          <RecoverBeat repoRoot={repoRoot} report={report} />
        </Beat>
      </TraceReport>
    </div>
  );
}

// The lead line. Two facts, in plain words: *how much* the AI changed, and
// whether any of it is worth a second look. Both come from `changeSafety`,
// which also says how much of the run the scan actually covered.
//
// The signals (an unfinished bit, a possible hard-coded secret, a deletion)
// live on the report's structured `nodes`, and the CLI emits those only for
// symbols it could resolve back to a parsed AST node, dropping the list
// entirely when none resolved. This line once filtered that list for secrets
// and, finding none in a list that was never populated, told a non-engineer
// there were none. It now says what it checked.
function ChangeOverview({ report }: { report: IntentReport }) {
  const counts = useMemo(() => changeCounts(report), [report]);
  const line = useMemo(() => safetyLine(counts), [counts]);

  // The fold's tone as the verdict's glyph. A run nothing could be scanned in
  // is calm in words, but it never wears the settled check.
  const VERDICT_TONE: Record<SafetyTone, TraceTone> = {
    risk: "bad",
    attention: "warn",
    calm: "good",
  };
  const tone: TraceTone =
    line.kind === "none" || line.kind === "unscanned" ? "muted" : VERDICT_TONE[line.tone];

  return (
    <TraceVerdict tone={tone} title={changeSummary(counts)}>
      {line.kind !== "none" && (
        <span>{line.text}</span>
      )}
    </TraceVerdict>
  );
}
