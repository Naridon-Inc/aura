// MissionRunRow — one run as a row in Mission Control's list layout.
//
// Rendered through the app's shared list primitive (`BoardListRow`), so a run
// in the list is built from exactly the parts a task in the Tasks list is built
// from: leading identity (state glyph + mono handle), the title as the flexible
// middle, then right-aligned property chips. A run and a task are the same
// *kind* of object to a reader, and a second row anatomy would say otherwise.
//
// The stage glyph comes from `STAGE_GLYPH_GROUP` — the same map the board's
// column headers read — so a run in the "Building" group and a card in the
// "Building" lane wear the identical shape.
//
// Audience: non-engineers. The trailing chip is always plain — "12m" while an
// agent works, "Proven · 3/3 checks" when it lands, "Needs review" — never a
// raw verdict enum or a lease id. And it is silent whenever the group header
// above the row has already said the same thing.

import type { JSX, ReactNode } from "react";
import { GitCommitHorizontal } from "lucide-react";

import type { MissionRun } from "../../../lib/api";
import { BoardListRow, StateGlyph } from "../../board";
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
  STAGE_GLYPH_GROUP,
} from "./missionData";

/** The trailing status chip for a run — one plain pill that says what matters
 *  for the stage it's in. Pure: it only reads the run + `now`. */
export function runChip(
  run: MissionRun,
  now: number,
  showProof: boolean,
): ReactNode | null {
  const stage = deriveStage(run);
  if (stage === "building") {
    const e = elapsedLabel(run.startedAtMs, now);
    return (
      <StatusChip tone="amber" dense dot>
        {e || "working"}
      </StatusChip>
    );
  }
  if (stage === "needsYou") {
    // Amber, not the neutral the other queued rows wear: this is the one row
    // in the list that will still be sitting here tomorrow if it's ignored.
    // `waitingOn` says which kind of answer it wants.
    const w = waitingOnLabel(run.waitingOn);
    return (
      <StatusChip tone="amber" dense>
        {w || "waiting on you"}
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
    // "Not checked" on every finished row, when not one of them was checked, is
    // the group header's sentence copied down the list. The list decides — see
    // `proofWorthShowing`; the header carries that case via `stageHint`.
    if (!showProof) return null;
    const p = proofPill(run.proof);
    return (
      <StatusChip tone={p.tone} dense dot={p.tone === "green"}>
        {p.label}
      </StatusChip>
    );
  }
  // Ready / Waiting / Paused / Couldn't finish — say only what the group header
  // above doesn't. A blocked row names what it is waiting for, which varies; the
  // rest have nothing to add and stay silent. This used to fall back to
  // "Queued", printing it on all twenty-six rows of the Ready group at once —
  // the same line the group header had already said, in the same eyeful. (The
  // board card carried the identical fallback and lost it in 0259e4c68; the
  // list kept it.)
  const w = waitingOnLabel(run.waitingOn);
  if (!w || stage !== "planning") return null;
  return (
    <StatusChip tone="neutral" dense>
      {w}
    </StatusChip>
  );
}

/** The quiet audit bits a finished run carries: its commit and how long ago it
 *  landed. Rendered as chips rather than a wrapped second line — the list
 *  layout's whole job is density, and a row that wraps destroys it. Empty for a
 *  run that hasn't finished, because there is nothing honest to show yet. */
function auditChips(run: MissionRun, now: number): ReactNode[] {
  const stage = deriveStage(run);
  if (stage !== "done" && stage !== "reviewing" && stage !== "failed") {
    return [];
  }
  const out: ReactNode[] = [];
  const sha = shortCommit(run.commit);
  if (sha) {
    out.push(
      <span
        key="sha"
        className="inline-flex items-center gap-1 font-mono text-xs text-text-5"
        title={run.commit ?? undefined}
      >
        <GitCommitHorizontal className="h-3 w-3" strokeWidth={1.5} aria-hidden />
        {sha}
      </span>,
    );
  }
  const ago = endedAgoLabel(run.endedAtMs, now);
  if (ago) {
    out.push(
      <span key="ago" className="text-xs text-text-5">
        {ago}
      </span>,
    );
  }
  return out;
}

export function MissionRunRow(props: {
  run: MissionRun;
  now: number;
  selected?: boolean;
  /** Drop the commit / "2m ago" audit chips, for callers too tight to carry
   *  them. The handle and the status chip always stay. */
  compact?: boolean;
  /** Stamp the agent's logo on the row. The parent decides, because only it can
   *  see whether the agents on this board differ — see `agentsWorthNaming`. */
  showAgent?: boolean;
  /** Say where a finished run stands on proof. The parent decides, because only
   *  it can see whether the finished runs in this list differ on it — see
   *  `proofWorthShowing`. */
  showProof?: boolean;
  onSelect?: (run: MissionRun) => void;
  /** Optional far-right action (Steer / Retry) the parent owns. Revealed on row
   *  hover, like every other secondary affordance in the list layout. */
  trailing?: ReactNode;
}): JSX.Element {
  const { run, now, selected, compact, showAgent, showProof, onSelect, trailing } =
    props;
  const stage = deriveStage(run);

  const chips: ReactNode[] = compact ? [] : auditChips(run, now);
  if (run.agent && showAgent) {
    chips.push(
      <span key="agent" className="inline-flex items-center">
        <AgentBit agentKind={run.agent} size={14} />
      </span>,
    );
  }
  const status = runChip(run, now, !!showProof);
  if (status) chips.push(<span key="status">{status}</span>);

  return (
    <BoardListRow
      selected={selected}
      onSelect={() => onSelect?.(run)}
      tooltip={run.title}
      dataAttrs={{ "data-run-id": run.id }}
      leading={
        <>
          <StateGlyph
            group={STAGE_GLYPH_GROUP[stage]}
            color={STAGE_TONE[stage]}
            size={12}
          />
          <span className="w-20 flex-shrink-0 truncate font-mono text-xs tabular-nums text-text-3">
            {shortRef(run)}
          </span>
        </>
      }
      title={run.title || "(untitled)"}
      trailing={chips}
      hoverActions={trailing}
    />
  );
}
