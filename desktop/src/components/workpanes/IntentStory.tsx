// IntentStory — the change story, shared by the change story page
// (IntentInspector), the History detail (CommitDetailPane) and, through its
// helpers, the session Alignment tab.
//
// It narrates one commit top to bottom as a run of beats:
//
//   Asked    — the closest recorded signal to the original ask. Only ever
//              something somebody stated: a Claude session's own opening
//              prompt, or a logged intent. Never a line Aura inferred from
//              the diff, which would put the change's own description
//              where its origin belongs.
//   Said     — what the AI logged as it worked (typed intents), plus any
//              line Aura wrote afterwards, marked as such
//   Did      — what actually changed, one item per piece (the heart)
//   Lines up — does the code match the ask? (the verdict, as a conclusion)
//   Recover  — save points and per-piece bring-back, if something's wrong
//
// Drawn as a report column — the session Summary's sections, items and
// verdict — so a change reads like the run it came from. The data rules live
// in `intentStory/intentReport` (pure) and `intentStory/useIntentReport`
// (loading); they are re-exported here so every caller imports one module.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { api, type ClaudeSession } from "../../lib/api";
import { basisCanBeChecked } from "../../lib/intentBasis";
import { percentOf } from "../../lib/percent";
import { StoryMarkdown } from "../story/StoryMarkdown";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { Code } from "../ui/code";
import { Progress } from "../ui/progress";
import { TraceNote } from "../ui/trace-detail";
import { TraceMark } from "../ui/trace-list";
import { TraceLine, TraceReport, TraceSection, TraceVerdict } from "../ui/trace-report";
import {
  bannerTone,
  deriveAskedSaid,
  formatAbsolute,
  formatRelative,
  reportBasis,
  verdictGlyph,
  type AskedNode,
  type IntentReport,
  type StatedIntent,
} from "./intentStory/intentReport";
import { DidBeat, StoryByline, TypeMark, VerdictIcon, markTone } from "./intentStory/StoryParts";
import "../ui/intent-story.css";

export {
  bannerTone,
  deriveAskedSaid,
  deriveNodes,
  formatAbsolute,
  formatRelative,
  mergeIntentReports,
  reportBasis,
  verdictGlyph,
  type AskedNode,
  type IntentReport,
  type NodeRef,
  type StatedIntent,
  type VerdictTone,
} from "./intentStory/intentReport";
export { useIntentReport, useSessionIntentReport } from "./intentStory/useIntentReport";

export function IntentStory({
  repoRoot,
  report,
  sessions,
  loading,
  error,
  showHeader = true,
}: {
  repoRoot: string;
  report: IntentReport | null;
  sessions: ClaudeSession[];
  loading: boolean;
  error: string | null;
  /** Show the commit title and verdict at the top. The standalone page wants
   *  it; a surface whose own header already carries the title leads straight
   *  into the beats. */
  showHeader?: boolean;
}) {
  if (loading) {
    return (
      <div className="ui-intent-story">
        <div className="ui-story-state" role="status">
          <AsciiSpinner />
          <span>Reading this change…</span>
        </div>
      </div>
    );
  }
  if (error) {
    return (
      <div className="ui-intent-story">
        <div className="ui-story-state" data-tone="error">
          <TraceLine tone="danger">Couldn’t read this change.</TraceLine>
          <code className="ui-story-error">{error}</code>
        </div>
      </div>
    );
  }
  if (!report) {
    return (
      <div className="ui-intent-story">
        <TraceNote title="No change picked">
          Pick a change from the timeline to read its story.
        </TraceNote>
      </div>
    );
  }

  // Prefer the user's actual prompt as "Asked", every genuine logged intent as
  // "Said" — one shared rule (also used by the session Alignment tab).
  const { asked, said } = deriveAskedSaid(report, sessions);

  return (
    <div className="ui-intent-story">
      <TraceReport>
        {showHeader && <StoryHeader report={report} />}
        <Beat label="Asked" hint="closest recorded signal">
          <AskedBeat asked={asked} />
        </Beat>
        {said.length > 0 && (
          <Beat label="Said" hint="what the AI logged as it worked">
            <SaidBeat said={said} />
          </Beat>
        )}
        <Beat label="Did" hint="what actually changed">
          <DidBeat report={report} />
        </Beat>
        <Beat label="Lines up?" hint="does the code match the ask">
          <VerdictBeat report={report} />
        </Beat>
        <Beat label="Recover" hint="if something's wrong">
          <RecoverBeat repoRoot={repoRoot} report={report} />
        </Beat>
      </TraceReport>
    </div>
  );
}

/** The commit's subject, where it came from, and the verdict as a mark. */
export function StoryHeader({ report }: { report: IntentReport }) {
  const tone = bannerTone(report);
  return (
    <header className="ui-story-head">
      <div>
        <h1>{report.commit_message?.split("\n")[0] || "(no message)"}</h1>
        <p>
          <code>{report.commit_short}</code>
          <span aria-hidden>·</span>
          <span>{report.author}</span>
          <span aria-hidden>·</span>
          <span>{formatAbsolute(report.commit_time)}</span>
        </p>
      </div>
      <TraceMark tone={markTone(tone.tone)} title={tone.msg}>
        <VerdictIcon glyph={verdictGlyph(report)} />
        {tone.label}
      </TraceMark>
    </header>
  );
}

/** One beat of the story: a report section with its label and, beside it in
 *  the faint ink, what the beat is for. */
export function Beat({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <TraceSection title={label} count={hint}>
      {children}
    </TraceSection>
  );
}

export function AskedBeat({ asked }: { asked: AskedNode | null }) {
  if (!asked) {
    return (
      <TraceLine>
        No reason was recorded near this commit. The change has no stated origin to compare
        against.
      </TraceLine>
    );
  }
  return (
    <div className="ui-story-asked">
      <StoryByline agentId={asked.agentId} when={formatRelative(asked.timestamp)}>
        {asked.fromSession ? (
          <TraceMark title="The user's first message in the correlated Claude Code session">
            prompt
          </TraceMark>
        ) : asked.intentType ? (
          <TypeMark type={asked.intentType} />
        ) : null}
      </StoryByline>
      <StoryMarkdown>{asked.text}</StoryMarkdown>
    </div>
  );
}

export function SaidBeat({ said }: { said: StatedIntent[] }) {
  return (
    <ul className="ui-story-said">
      {said.map((s, i) => (
        <li key={i}>
          <StoryByline agentId={s.agent_id} when={formatRelative(s.timestamp)}>
            {s.intent_type && <TypeMark type={s.intent_type} />}
            {/* The beat is headed "what the AI logged as it worked". A
                brain_inferred line is not that: the agent logged nothing, and
                Aura wrote this afterwards by reading the diff. Without the
                marker it reads as the agent's own words, under its own badge. */}
            {s.source === "brain_inferred" && (
              <TraceMark title="Nobody wrote a reason for this change, so Aura read it afterwards and wrote this line. It describes what happened. It isn't what the agent said it would do.">
                Aura's summary
              </TraceMark>
            )}
          </StoryByline>
          <StoryMarkdown compact>{s.intent}</StoryMarkdown>
        </li>
      ))}
    </ul>
  );
}

export function VerdictBeat({ report }: { report: IntentReport }) {
  const tone = bannerTone(report);
  // Color rides on the glyph and the coverage meter only — never a fill.
  const glyph = verdictGlyph(report);
  const checkable = basisCanBeChecked(reportBasis(report));
  const pct = percentOf(report.alignment_score);
  const totalChanged =
    report.modified_nodes.length + report.added_nodes.length + report.deleted_nodes.length;
  const uncovered = report.mismatched_nodes;

  return (
    <div className="ui-story-verdict">
      <TraceVerdict tone={tone.tone} icon={<VerdictIcon glyph={glyph} />} title={tone.label}>
        {tone.msg}
      </TraceVerdict>
      <div className="ui-story-coverage">
        <span>
          {checkable
            ? `${report.aligned_nodes.length}/${Math.max(totalChanged, 1)} pieces covered · ${pct}%`
            : `${totalChanged} piece${totalChanged === 1 ? "" : "s"} changed`}
        </span>
        {/* The meter is a coverage reading. With nothing independent to cover,
            it would fill itself — so it only appears when it means something. */}
        {checkable && (
          <Progress value={pct} aria-label="Pieces covered" data-tone={tone.tone} />
        )}
      </div>
      {tone.note && <TraceLine tone="note">{tone.note}</TraceLine>}
      {checkable && uncovered.length > 0 && (
        <TraceLine>
          Not named in the task:{" "}
          <span className="ui-story-uncovered">{uncovered.slice(0, 6).join(", ")}</span>
          {uncovered.length > 6 && ` +${uncovered.length - 6} more`}
        </TraceLine>
      )}
    </div>
  );
}

export function RecoverBeat({ repoRoot, report }: { repoRoot: string; report: IntentReport }) {
  const [count, setCount] = useState<number | null>(null);
  const changed = useMemo(() => new Set(report.changed_files), [report.changed_files]);

  useEffect(() => {
    let cancelled = false;
    setCount(null);
    api
      .auraListSnapshotsV2(repoRoot, 200)
      .then((page) => {
        if (cancelled) return;
        setCount(page.entries.filter((e) => changed.has(e.file)).length);
      })
      .catch(() => {
        if (!cancelled) setCount(null);
      });
    return () => {
      cancelled = true;
    };
  }, [repoRoot, changed]);

  return (
    <div className="ui-story-recover">
      <TraceLine>
        Every <Code size="sm">Bring this back</Code> above restores one piece to the way it was,
        just that piece, nothing else, and never a clash. Aura saves a copy of every file before
        edits, so undoing is always safe.
      </TraceLine>
      {count !== null && count > 0 && (
        <TraceLine tone="note">
          {count} save point{count === 1 ? "" : "s"} cover the file
          {report.changed_files.length === 1 ? "" : "s"} this change touched.
        </TraceLine>
      )}
    </div>
  );
}
