// MissionBoard — the board view of Mission Control, rendered through the app's
// shared board design system (`components/board`). It wears exactly the chrome
// the Tasks board wears — same column width, header anatomy, card radius and
// hover lift — because a Crew run and a task are the same *kind* of object to
// the reader, and a second reinvented look would say otherwise.
//
// The honest differences are data-driven, not stylistic: the columns are
// workflow STAGES (Needs you · Paused · Ready · Waiting · Building · Reviewing
// · Done · Couldn't finish) instead of task statuses, and the cards aren't
// drag-to-restage — a run's
// stage is derived from its real state, so you can't drag a working agent into
// "Done". The shared column simply isn't given a drop handler here.
//
// Audience: non-engineers. A column is a plain stage of work ("Building", not
// "working"); an empty lane says, in plain words, what would land there
// (STAGE_HINT) rather than showing a fake card. No "lease / node / DAG" ever.

import type { JSX, ReactNode } from "react";
import { FolderGit2, GitCommitHorizontal } from "lucide-react";

import type { MissionRun, MissionState } from "../../../lib/api";
import {
  BoardCard,
  BoardCardMeta,
  BoardCardMetaRow,
  BoardCardTitle,
  BoardColumn,
  BoardEmptyHint,
  BoardFrame,
  StateGlyph,
} from "../../board";
import { AgentBit, agentsWorthNaming } from "../crew/crewShared";
import { MissionRetryButton } from "./MissionRetryButton";
import {
  allRuns,
  groupByStage,
  deriveStage,
  shortRef,
  shortCommit,
  endedAgoLabel,
  elapsedLabel,
  harnessLabel,
  proofPill,
  waitingOnLabel,
  proofWorthShowing,
  stageHint,
  STAGE_LABEL,
  STAGE_TONE,
  STAGE_GLYPH_GROUP,
  type MissionStageId,
} from "./missionData";

/** The one quiet status sub-line under a card's title. It is the calm, plain-
 *  language read of where a run is — never a loud chip that clips, never a raw
 *  verdict enum. Crucially it stays SILENT when there's nothing honest to say:
 *  a finished run whose proof was never checked shows no "Not checked" badge —
 *  the commit + "2m ago" in the footer already say it landed. Returns null when
 *  the title + footer carry the whole story. */
function StatusLine({
  run,
  now,
  stage,
  showProof,
}: {
  run: MissionRun;
  now: number;
  stage: MissionStageId;
  showProof: boolean;
}): JSX.Element | null {
  if (stage === "building") {
    const e = elapsedLabel(run.startedAtMs, now);
    return (
      <span
        className="inline-flex items-center gap-1.5 text-xs font-medium"
        style={{ color: "var(--color-amber)" }}
      >
        <span
          className="h-1.5 w-1.5 flex-shrink-0 rounded-full"
          style={{ background: "var(--color-amber)" }}
          aria-hidden
        />
        An agent is on it{e ? ` · ${e}` : ""}
      </span>
    );
  }
  if (stage === "needsYou") {
    // Says the thing plainly, in amber, because this card is the reason the
    // work stopped. `waitingOn` carries which kind of answer it is after.
    const w = waitingOnLabel(run.waitingOn);
    return (
      <span className="text-xs font-medium" style={{ color: "var(--color-amber)" }}>
        {w ? `Stopped · ${w}` : "Stopped. Waiting on you"}
      </span>
    );
  }
  if (stage === "reviewing") {
    return (
      <span className="text-xs font-medium" style={{ color: "var(--color-amber)" }}>
        {run.prNumber != null
          ? `Ready to review · PR #${run.prNumber}`
          : "Ready to review"}
      </span>
    );
  }
  if (stage === "done") {
    // Where this finished run stands — "Proven · 3/3 checks", "Almost · 2/3",
    // or plainly "Not checked".
    //
    // The unchecked case used to be silent here, on the reasoning that a grey
    // badge repeated on every Done card is noise. True when nothing was ever
    // checked — and false, badly, the moment anything was: a proven landing and
    // an unexamined one drew the identical card, so the lane offered no way to
    // tell them apart, which is the only thing the lane is for. The board
    // decides now (`proofWorthShowing`) and the all-unchecked case is stated
    // once, on the column header, by `stageHint`.
    if (!showProof) return null;
    const p = proofPill(run.proof);
    return (
      <span
        className="text-xs font-medium"
        style={{
          color:
            p.tone === "green"
              ? "var(--color-accent-green)"
              : p.tone === "amber"
                ? "var(--color-amber)"
                : "var(--color-text-4)",
        }}
      >
        {p.label}
      </span>
    );
  }
  // triage / planning — what it's waiting on, in full plain words (it may wrap
  // to a second line; it is NOT clipped into a chip).
  //
  // A ready run has nothing to wait on, so it gets no sub-line at all. This
  // used to fall back to "Queued — next in line", which printed on all 26
  // Triage cards at once: true of one of them, and a line the column header
  // ("Triage" · "Queued and ready — an agent will pick these up next") had
  // already said. The card is denser without it and nothing is lost.
  const w = waitingOnLabel(run.waitingOn);
  if (!w) return null;
  return (
    <span className="line-clamp-2 text-xs leading-snug text-text-4">{w}</span>
  );
}

/** One run as a board card. The TITLE is the hero; under it a single quiet
 *  status sub-line says where the run is in plain words; then the shared meta
 *  row of handle · agent · commit · "2m ago" — the fields a non-engineer scans
 *  without opening the run. No per-card stage glyph (the column header already
 *  names the stage) and no clipped status chip. */
function MissionBoardCard({
  run,
  now,
  selected,
  onSelect,
  onRetry,
  showAgent,
  showProof,
  showProject = false,
}: {
  run: MissionRun;
  now: number;
  selected: boolean;
  onSelect: (run: MissionRun) => void;
  onRetry?: (runs: MissionRun[]) => void;
  /** Name the agent in the meta row. The board decides, because only it can see
   *  whether the agents on it differ — see `agentsWorthNaming`. */
  showAgent?: boolean;
  /** Draw where a finished run stands on proof. The board decides, because only
   *  it can see whether its finished runs differ — see `proofWorthShowing`. */
  showProof: boolean;
  /** In the all-projects board a card leads with which project it lives in —
   *  the Conductor "workspace across every project" read. Off for a single
   *  project's board (the tab already says which project). */
  showProject?: boolean;
}): JSX.Element {
  const stage = deriveStage(run);
  const status = StatusLine({ run, now, stage, showProof });

  // Footer cluster — handle first (the quiet identity), then only the fields
  // that actually exist on this run, so a queued card (no commit, no agent yet)
  // drops them cleanly rather than showing empty chrome. Never invents a value.
  const sha = shortCommit(run.commit);
  const ago = endedAgoLabel(run.endedAtMs, now);
  const metaItems: ReactNode[] = [
    <BoardCardMeta key="ref" mono title="This run's handle">
      {shortRef(run)}
    </BoardCardMeta>,
  ];
  if (run.agent && showAgent) {
    metaItems.push(
      <BoardCardMeta key="agent" title={`Agent: ${harnessLabel(run.agent)}`}>
        <AgentBit agentKind={run.agent} size={11} />
        {harnessLabel(run.agent)}
      </BoardCardMeta>,
    );
  }
  if (sha) {
    metaItems.push(
      <BoardCardMeta
        key="sha"
        icon={GitCommitHorizontal}
        mono
        title={run.commit ?? undefined}
      >
        {sha}
      </BoardCardMeta>,
    );
  }
  if (ago) {
    metaItems.push(<BoardCardMeta key="ago">{ago}</BoardCardMeta>);
  }

  return (
    <BoardCard
      selected={selected}
      onOpen={() => onSelect(run)}
      title={run.title}
    >
      {/* All-projects board only: which project this run lives in, led like the
          Conductor workspace handle — a quiet mono line above the title. */}
      {showProject && run.projectName ? (
        <div
          className="flex items-center gap-1 truncate font-mono text-xs text-text-3"
          title={`Project: ${run.projectName}`}
        >
          <FolderGit2 className="h-3 w-3 flex-shrink-0" strokeWidth={1.5} aria-hidden />
          <span className="truncate">{run.projectName}</span>
        </div>
      ) : null}

      <BoardCardTitle className="font-medium">
        {run.title || "(untitled)"}
      </BoardCardTitle>

      {/* Quiet status sub-line — plain words, never a clipped chip. On a failed
          card the verdict shares its row with a direct "Retry" so a non-engineer
          re-queues the work in one click, without opening the run. */}
      {stage === "failed" ? (
        // The lane is called "Couldn't finish"; the card said it again. What
        // the card owes the reader here is the way out, not the verdict.
        <div className="flex items-center justify-end">
          <MissionRetryButton runs={[run]} onRetry={onRetry} label="Try again" />
        </div>
      ) : (
        status && <div>{status}</div>
      )}

      <BoardCardMetaRow>{metaItems}</BoardCardMetaRow>
    </BoardCard>
  );
}

/** The board: every stage as a column, left→right in workflow order. Columns
 *  come from `groupByStage(allRuns(state), true)` — `keepEmpty = true` so the
 *  whole pipeline always shows, even the lanes standing empty. */
export function MissionBoard(props: {
  state: MissionState;
  now: number;
  selectedId: string | null;
  onSelect: (run: MissionRun) => void;
  /** Re-arm failed runs back into the ready set — powers each failed card's
   *  "Retry" and the Failed column's "Retry all". Omit to hide both. */
  onRetry?: (runs: MissionRun[]) => void;
  /** All-projects board: each card leads with which project it lives in. Off
   *  for a single project's board (the tab already says which). */
  showProject?: boolean;
}): JSX.Element {
  const { state, now, selectedId, onSelect, onRetry, showProject = false } = props;

  // Every stage renders — but the ones holding work render FIRST.
  //
  // Empty lanes collapse to a forty-pixel strip with the stage name set
  // sideways, which is a fine way to say "this stage exists and is empty" and a
  // terrible way to open a board. In stage order the two lanes most often empty
  // — "Needs you" and "Building" — are also the two that lead, so the everyday
  // case put eighty pixels of rotated text reading `0` where the first card
  // should be, and you scrolled past nothing to reach something. Sorting the
  // empties to the tail keeps the whole pipeline on screen while giving the
  // front of the board to lanes that have something in them; a stage that fills
  // up (a run stops and needs you) jumps to the front on its own, which is
  // exactly when you want it there.
  const runs = allRuns(state);
  const columns = groupByStage(runs, true);
  // Only name the agent when the agents differ — otherwise every card on the
  // board wears the identical logo and none of them is told apart by it.
  const showAgent = agentsWorthNaming(runs.map((r) => r.agent));
  // Same rule for proof: only worth drawing on every card once the finished
  // runs actually differ on it. All unchecked and the header says it once.
  const showProof = proofWorthShowing(runs);
  const ordered = [
    ...columns.filter((c) => c.runs.length > 0),
    ...columns.filter((c) => c.runs.length === 0),
  ];

  return (
    <BoardFrame>
      {ordered.map((col) => (
        <BoardColumn
          key={col.stage}
          title={STAGE_LABEL[col.stage]}
          titleHint={stageHint(col.stage, col.runs)}
          count={col.runs.length}
          collapsible
          // Every stage renders — a pipeline that hides its empty stages stops
          // being a pipeline. But at full width the eight of them run to twice
          // the pane, so an empty stage keeps its place as a strip rather than
          // 300px of nothing. See `ordered` above for where those strips sit.
          collapseWhenEmpty
          glyph={
            <StateGlyph
              group={STAGE_GLYPH_GROUP[col.stage]}
              color={STAGE_TONE[col.stage]}
              size={12}
            />
          }
          actions={
            // One click re-queues every failed run in this column.
            col.stage === "failed" && col.runs.length > 0 ? (
              <MissionRetryButton
                runs={col.runs}
                onRetry={onRetry}
                label="Retry all"
              />
            ) : undefined
          }
          emptyHint={
            <BoardEmptyHint>{stageHint(col.stage, col.runs)}</BoardEmptyHint>
          }
        >
          {col.runs.map((run) => (
            <MissionBoardCard
              key={run.id}
              run={run}
              now={now}
              selected={run.id === selectedId}
              onSelect={onSelect}
              onRetry={onRetry}
              showAgent={showAgent}
              showProof={showProof}
              showProject={showProject}
            />
          ))}
        </BoardColumn>
      ))}
    </BoardFrame>
  );
}
