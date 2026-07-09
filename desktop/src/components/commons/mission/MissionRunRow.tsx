// MissionRunRow — the single Activity/Board row, modelled on the Warp Oz
// "Activity" list: [stage glyph] [muted handle] [title] … [harness] [status
// chip]. One row component is reused by the Activity list (full width) and the
// Board cards (compact), so a run looks the same wherever you meet it. Selecting
// a row opens its detail/session panel.
//
// Audience: non-engineers. The right-hand chip is always plain — "12m" while an
// agent works, "Proven · 3/3 checks" when it lands, "Needs review", "Couldn't
// finish" — never a raw verdict enum or a lease id.

import type { JSX, ReactNode } from "react";
import {
  CircleDashed,
  Compass,
  Code2,
  GitPullRequestArrow,
  CheckCircle2,
  XCircle,
  GitCommitHorizontal,
} from "lucide-react";

import type { MissionRun } from "../../../lib/api";
import { StatusChip } from "../../ui/statusChip";
import { AgentBit } from "../crew/crewShared";
import {
  deriveStage,
  shortRef,
  proofPill,
  elapsedLabel,
  endedAgoLabel,
  shortCommit,
  waitingOnLabel,
  STAGE_TONE,
  type MissionStageId,
} from "./missionData";

/** The lucide glyph that fronts each stage — matches the Oz Activity rows
 *  (dotted circle for triage, compass for planning, code for building, a
 *  pull-request mark for reviewing). */
export const STAGE_GLYPH: Record<
  MissionStageId,
  (p: { size: number; color: string }) => JSX.Element
> = {
  triage: ({ size, color }) => <CircleDashed size={size} color={color} />,
  planning: ({ size, color }) => <Compass size={size} color={color} />,
  building: ({ size, color }) => <Code2 size={size} color={color} />,
  reviewing: ({ size, color }) => (
    <GitPullRequestArrow size={size} color={color} />
  ),
  done: ({ size, color }) => <CheckCircle2 size={size} color={color} />,
  failed: ({ size, color }) => <XCircle size={size} color={color} />,
};

/** The trailing status chip for a run — one plain pill that says what matters
 *  for the stage it's in. Pure: it only reads the run + `now`. */
export function runChip(run: MissionRun, now: number): ReactNode {
  const stage = deriveStage(run);
  if (stage === "building") {
    const e = elapsedLabel(run.startedAtMs, now);
    return (
      <StatusChip tone="amber" dense dot>
        {e || "working"}
      </StatusChip>
    );
  }
  if (stage === "failed") {
    return (
      <StatusChip tone="red" dense>
        Couldn't finish
      </StatusChip>
    );
  }
  if (stage === "reviewing") {
    const p = run.proof ? proofPill(run.proof) : null;
    const label =
      run.prNumber != null
        ? `PR #${run.prNumber}`
        : p && p.tone === "amber"
          ? p.label
          : "Needs review";
    return (
      <StatusChip tone="amber" dense>
        {label}
      </StatusChip>
    );
  }
  if (stage === "done") {
    const p = proofPill(run.proof);
    return (
      <StatusChip tone={p.tone} dense dot={p.tone === "green"}>
        {p.label}
      </StatusChip>
    );
  }
  // triage / planning — a calm muted hint, never a colored alarm
  const w = waitingOnLabel(run.waitingOn);
  return (
    <StatusChip tone="neutral" dense>
      {w || "Queued"}
    </StatusChip>
  );
}

/** A tiny secondary line under the title for finished runs — the commit + how
 *  long ago — so the audit trail reads at a glance without opening the run. */
function subline(run: MissionRun, now: number): ReactNode {
  const stage = deriveStage(run);
  if (stage !== "done" && stage !== "reviewing" && stage !== "failed") {
    return null;
  }
  const sha = shortCommit(run.commit);
  const ago = endedAgoLabel(run.endedAtMs, now);
  const bits: ReactNode[] = [];
  if (sha) {
    bits.push(
      <span
        key="sha"
        className="inline-flex items-center gap-1 font-mono text-[10.5px] text-text-5"
      >
        <GitCommitHorizontal size={11} />
        {sha}
      </span>,
    );
  }
  if (ago) {
    bits.push(
      <span key="ago" className="text-[10.5px] text-text-5">
        {ago}
      </span>,
    );
  }
  if (bits.length === 0) return null;
  return <div className="mt-0.5 flex items-center gap-2">{bits}</div>;
}

export function MissionRunRow(props: {
  run: MissionRun;
  now: number;
  selected?: boolean;
  /** Hide the secondary commit/ago line (the Board cards stay one-line). */
  compact?: boolean;
  onSelect?: (run: MissionRun) => void;
  /** Optional far-right action (Steer / Retry) the parent owns. */
  trailing?: ReactNode;
}): JSX.Element {
  const { run, now, selected, compact, onSelect, trailing } = props;
  const stage = deriveStage(run);
  const tone = STAGE_TONE[stage];
  const Glyph = STAGE_GLYPH[stage];

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onSelect?.(run)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect?.(run);
        }
      }}
      className={[
        "group flex items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left transition-colors",
        "cursor-pointer outline-none focus-visible:ring-1 focus-visible:ring-accent",
        selected
          ? "border-transparent bg-bg-2"
          : "border-transparent hover:bg-bg-2/60",
      ].join(" ")}
      style={
        selected
          ? { boxShadow: "inset 2px 0 0 0 var(--color-accent)" }
          : undefined
      }
      title={run.title}
    >
      <span className="grid h-5 w-5 shrink-0 place-items-center">
        <Glyph size={15} color={tone} />
      </span>

      <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-text-5">
        {shortRef(run)}
      </span>

      <div className="min-w-0 flex-1">
        <div className="truncate text-[12.5px] leading-tight text-text-2">
          {run.title}
        </div>
        {!compact && subline(run, now)}
      </div>

      <AgentBit agentKind={run.agent} size={16} />

      <span className="shrink-0">{runChip(run, now)}</span>

      {trailing && (
        <span
          className="shrink-0"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          {trailing}
        </span>
      )}
    </div>
  );
}
