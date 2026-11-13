// One moment in the Time machine: its entry on the timeline, and the report
// you read when you travel to it — how far back, when, who, the why, and what
// changed (trace/TimeMachineFiles), with the bring-back result above the files
// it acts on.

import { useMemo } from "react";
import { Lock } from "lucide-react";
import type { ClaudeSession, SnapshotEntry } from "../../lib/api";
import { relativeAgeFromDelta } from "../../lib/relativeTime";
import {
  provenanceLabel,
  provenanceNote,
  provenanceTag,
  sessionDisplayTitle,
  titleProvenance,
  type SessionDisplayRow,
} from "../../lib/sessionMeta";
import { AgentBadge } from "../agent/AgentBadge";
import { TraceMark } from "../ui/trace-list";
import { TraceLine, TraceReport, TraceSection } from "../ui/trace-report";
import { TraceTimelineEntry } from "../ui/trace-timeline";
import { BringBackResult, useBringBack } from "../workpanes/useBringBack";
import { lookupSymbols, TimeMachineFile, useMomentSymbols } from "./TimeMachineFiles";

function relTime(secsAgo: number): string {
  // One ladder for the whole app — see lib/relativeTime.
  return relativeAgeFromDelta(secsAgo);
}

function fullWhen(ts: number): string {
  return new Date(ts * 1000).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// ── one moment on the timeline ─────────────────────────────────────────────

export function MomentEntry({
  display,
  sessions,
  nowSecs,
  selected,
  onSelect,
}: {
  display: SessionDisplayRow;
  sessions: ClaudeSession[];
  nowSecs: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const { row } = display;
  const title = sessionDisplayTitle(row, sessions);
  // Nobody wrote a reason for this moment — the title is Aura's model reading
  // the diff. On a timeline you scan, that's the one thing about it worth a word.
  const provTag = provenanceTag(titleProvenance(row, sessions));
  return (
    <TraceTimelineEntry
      title={title}
      active={selected}
      onSelect={onSelect}
      detail={
        <>
          <span>{relTime(nowSecs - row.timestamp)}</span>
          {row.signed_block_id && (
            <span title="Genuine record. Sealed" aria-label="Sealed">
              <Lock aria-hidden />
            </span>
          )}
          <span aria-hidden>·</span>
          <AgentBadge agentId={row.agent_id} />
          {provTag ? (
            <>
              <span aria-hidden>·</span>
              <span>{provTag}</span>
            </>
          ) : null}
          <span aria-hidden>·</span>
          <span>
            {display.files} {display.files === 1 ? "file" : "files"}
          </span>
        </>
      }
    />
  );
}

// ── the moment you are on ────────────────────────────────────────────────

export function MomentDetail({
  repoRoot,
  display,
  sessions,
  snapshots,
  nowSecs,
  stepsBack,
  prefillId,
  prefillFile,
}: {
  repoRoot: string;
  display: SessionDisplayRow;
  sessions: ClaudeSession[];
  snapshots: SnapshotEntry[];
  nowSecs: number;
  stepsBack: number;
  prefillId: string;
  prefillFile: string;
}) {
  const { row } = display;
  const files = useMemo(() => row.changeset?.files ?? [], [row]);
  const title = sessionDisplayTitle(row, sessions);
  const provenance = titleProvenance(row, sessions);
  const provNote = provenanceNote(provenance);
  const { symbolsByPath, resolving } = useMomentSymbols(repoRoot, files);
  const {
    state: bringBack,
    run: runBringBack,
    confirm: confirmBringBack,
    undo: undoBringBack,
    reset: resetBringBack,
    busySymbol,
  } = useBringBack(repoRoot);

  return (
    <TraceReport>
      <header className="ui-tm-moment-head">
        <span className="ui-tm-moment-step">
          {stepsBack === 0 ? "Most recent moment" : `${stepsBack} ${stepsBack === 1 ? "moment" : "moments"} back`}
        </span>
        <h2 className="ui-tm-moment-when">
          {relTime(nowSecs - row.timestamp)}
          <small>{fullWhen(row.timestamp)}</small>
        </h2>
        <div className="ui-tm-moment-marks">
          <AgentBadge agentId={row.agent_id} />
          {row.signed_block_id && (
            <TraceMark tone="good" title="A sealed, genuine record of this change">
              <Lock aria-hidden />
              Sealed
            </TraceMark>
          )}
        </div>
      </header>

      {/* "Why this happened" is the strongest claim any label in this app
          makes, so it is only said over a stated reason. See lib/sessionMeta. */}
      <TraceSection title={provenanceLabel(provenance, "Why this happened")}>
        <p className="ui-trace-report-prose">{title}</p>
        {provNote ? <TraceLine tone="note">{provNote}</TraceLine> : null}
      </TraceSection>

      {/* Landed here from a symbol right-click. */}
      {prefillId && prefillFile && (
        <TraceLine>
          Looking for <code className="ui-tm-code">{prefillId}</code>. Find it under{" "}
          <code className="ui-tm-code">{prefillFile.split("/").pop()}</code> below and press Bring
          this back.
        </TraceLine>
      )}

      {bringBack.kind !== "idle" && (
        <BringBackResult
          state={bringBack}
          onConfirm={confirmBringBack}
          onUndo={undoBringBack}
          onDismiss={resetBringBack}
        />
      )}

      <TraceSection
        title="What changed here"
        count={files.length}
        trailing={resolving ? <span className="ui-trace-report-note">Finding the pieces…</span> : null}
      >
        <div className="ui-tm-files">
          {files.map((f) => (
            <TimeMachineFile
              key={f.path}
              repoRoot={repoRoot}
              file={f}
              symbols={lookupSymbols(symbolsByPath, f.path)}
              snapshots={snapshots}
              busySymbol={busySymbol}
              onBringBack={runBringBack}
            />
          ))}
        </div>
      </TraceSection>
    </TraceReport>
  );
}
