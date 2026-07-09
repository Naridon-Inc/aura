// MissionBoard — the kanban / board view of Mission Control. It deliberately
// wears the SAME board chrome as the Tasks board (TasksBoard.tsx `BoardView` +
// `TaskCard`): identical column width, header ring + count, card radius, raised
// shadow and hover lift — so a Crew run on this board reads as the same kind of
// object as a task on the Tasks board, never a second, reinvented look. The
// only differences are honest, data-driven ones: the columns are workflow
// STAGES (Triage · Planning · Building · Reviewing · Done · Failed) instead of
// task statuses, and the cards aren't drag-to-restage (a run's stage is derived
// from its real state — you can't drag a working agent into "Done").
//
// Audience: non-engineers. A column is a plain stage of work ("Building", not
// "working"); an empty lane says, in plain words, what would land there
// (STAGE_HINT) rather than showing a fake card. No "lease / node / DAG" ever.

import type { JSX, ReactNode } from "react";
import { FolderGit2, GitCommitHorizontal } from "lucide-react";

import type { MissionRun, MissionState } from "../../../lib/api";
import { AgentBit } from "../crew/crewShared";
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
  STAGE_LABEL,
  STAGE_TONE,
  STAGE_HINT,
  type MissionStageId,
} from "./missionData";

/** The 12px stage ring that fronts each column header — the Mission counterpart
 *  of TasksBoard's `StateRing`, drawn at the exact same size/shape but tinted
 *  with the stage's tone: a dashed ring for the not-yet-started stages, a solid
 *  ring for the in-flight ones, and a filled dot once a stage is terminal. Pure
 *  styling; mirrors the Tasks board so the two surfaces share one ring grammar. */
function StageRing({ stage }: { stage: MissionStageId }): JSX.Element {
  const tone = STAGE_TONE[stage];
  // Dashed = nothing's happening here yet (triage / planning queue); solid =
  // in-flight (building / reviewing); filled = terminal (done / failed).
  const dashed = stage === "triage" || stage === "planning";
  const filled = stage === "done" || stage === "failed";
  return (
    <span
      className="box-border h-[12px] w-[12px] flex-shrink-0 rounded-full"
      style={{
        border: `1.5px ${dashed ? "dashed" : "solid"} ${tone}`,
        background: filled
          ? tone
          : stage === "building" || stage === "reviewing"
            ? `color-mix(in srgb, ${tone} 45%, transparent)`
            : "transparent",
      }}
      aria-hidden
    />
  );
}

/** One quiet footer meta item — same muted grammar as the Tasks board's
 *  `CardMeta` (10.5px, tabular-nums, text-text-3, optional leading icon) so the
 *  card footer reads as one calm cluster, not a grab-bag of chrome. */
function CardMeta({
  icon: Icon,
  children,
  title,
  mono = false,
}: {
  icon?: typeof GitCommitHorizontal;
  children: ReactNode;
  title?: string;
  mono?: boolean;
}): JSX.Element {
  return (
    <span
      className={`inline-flex items-center gap-1 whitespace-nowrap text-[10.5px] tabular-nums text-text-3 ${
        mono ? "font-mono" : ""
      }`}
      title={title}
    >
      {Icon && (
        <Icon className="h-3 w-3 flex-shrink-0" strokeWidth={1.5} aria-hidden />
      )}
      {children}
    </span>
  );
}

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
}: {
  run: MissionRun;
  now: number;
  stage: MissionStageId;
}): JSX.Element | null {
  if (stage === "building") {
    const e = elapsedLabel(run.startedAtMs, now);
    return (
      <span
        className="inline-flex items-center gap-1.5 text-[11px] font-medium"
        style={{ color: "#d99a2b" }}
      >
        <span
          className="h-1.5 w-1.5 flex-shrink-0 rounded-full"
          style={{ background: "#d99a2b" }}
          aria-hidden
        />
        An agent is on it{e ? ` · ${e}` : ""}
      </span>
    );
  }
  if (stage === "reviewing") {
    return (
      <span className="text-[11px] font-medium" style={{ color: "#d98a4f" }}>
        {run.prNumber != null
          ? `Ready to review · PR #${run.prNumber}`
          : "Ready to review"}
      </span>
    );
  }
  if (stage === "failed") {
    // Just the plain verdict — the actionable "Retry" sits right beside it on the
    // card now, so the old "— open to retry" tail (which pointed you at the
    // detail) is redundant.
    return (
      <span className="text-[11px] font-medium" style={{ color: "#d66a6a" }}>
        Couldn't finish
      </span>
    );
  }
  if (stage === "done") {
    // Proof only when it actually says something — verified ("Proven · 3/3")
    // or partial ("Almost · 2/3"). A neutral/unknown verdict ("Not checked",
    // "Not built yet") is NOT shown: the footer's commit already proves it
    // landed, and a grey "Not checked" badge on every Done card is just noise.
    const p = proofPill(run.proof);
    if (p.tone === "green" || p.tone === "amber") {
      return (
        <span
          className="text-[11px] font-medium"
          style={{ color: p.tone === "green" ? "#3fa66a" : "#d99a2b" }}
        >
          {p.label}
        </span>
      );
    }
    return null;
  }
  // triage / planning — what it's waiting on, in full plain words (it may wrap
  // to a second line; it is NOT clipped into a chip). Falls back to "Queued".
  const w = waitingOnLabel(run.waitingOn);
  return (
    <span className="line-clamp-2 text-[11px] leading-snug text-text-4">
      {w || "Queued — next in line"}
    </span>
  );
}

/** One run as a board card — the Mission counterpart of TasksBoard's `TaskCard`,
 *  built on the exact same container chrome (rounded-[6px], bg-bg-content, raised
 *  shadow, hover lift, accent ring when selected). The TITLE is the hero: full
 *  card width, two-line clamp, read first. Under it a single quiet status
 *  sub-line (`StatusLine`) says where the run is in plain words; then a muted
 *  footer of handle · agent · commit · "2m ago" — the fields a non-engineer
 *  scans without opening the run. No per-card stage glyph (the column header
 *  already names the stage) and no clipped status chip. Click opens it (in the
 *  Plan tab). Not draggable: a run's column is derived from its real state. */
function MissionBoardCard({
  run,
  now,
  selected,
  onSelect,
  onRetry,
  showProject = false,
}: {
  run: MissionRun;
  now: number;
  selected: boolean;
  onSelect: (run: MissionRun) => void;
  onRetry?: (runs: MissionRun[]) => void;
  /** In the all-projects board a card leads with which project it lives in —
   *  the Conductor "workspace across every project" read. Off for a single
   *  project's board (the tab already says which project). */
  showProject?: boolean;
}): JSX.Element {
  const stage = deriveStage(run);
  const status = StatusLine({ run, now, stage });

  // Footer cluster — handle first (the quiet identity), then only the fields
  // that actually exist on this run, so a queued card (no commit, no agent yet)
  // drops them cleanly rather than showing empty chrome. Never invents a value.
  const sha = shortCommit(run.commit);
  const ago = endedAgoLabel(run.endedAtMs, now);
  const metaItems: ReactNode[] = [
    <CardMeta key="ref" mono title="This run's handle">
      {shortRef(run)}
    </CardMeta>,
  ];
  if (run.agent) {
    metaItems.push(
      <span
        key="agent"
        className="inline-flex items-center gap-1 text-[10.5px] text-text-3"
        title={`Agent: ${harnessLabel(run.agent)}`}
      >
        <AgentBit agentKind={run.agent} size={13} />
        {harnessLabel(run.agent)}
      </span>,
    );
  }
  if (sha) {
    metaItems.push(
      <CardMeta key="sha" icon={GitCommitHorizontal} mono title={run.commit ?? undefined}>
        {sha}
      </CardMeta>,
    );
  }
  if (ago) {
    metaItems.push(<CardMeta key="ago">{ago}</CardMeta>);
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onMouseDown={(e) => {
        if (e.button !== 0) return;
        onSelect(run);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(run);
        }
      }}
      className={`flex cursor-pointer flex-col gap-1 rounded-[6px] border bg-bg-content px-2.5 py-2 text-left transition-all ${
        selected
          ? "border-accent bg-accent/[0.04] ring-2 ring-accent/60"
          : "border-line-soft hover:border-line"
      }`}
      style={{ boxShadow: "var(--shadow-raised-100)" }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLDivElement).style.boxShadow =
          "var(--shadow-raised-200)";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLDivElement).style.boxShadow =
          "var(--shadow-raised-100)";
      }}
      title={run.title}
    >
      {/* All-projects board only: which project this run lives in, led like the
          Conductor workspace handle — a quiet mono line above the title. */}
      {showProject && run.projectName ? (
        <div
          className="flex items-center gap-1 truncate font-mono text-[10.5px] text-text-3"
          title={`Project: ${run.projectName}`}
        >
          <FolderGit2 className="h-3 w-3 flex-shrink-0" strokeWidth={1.5} aria-hidden />
          <span className="truncate">{run.projectName}</span>
        </div>
      ) : null}

      {/* Title — the hero. Full width, 13px, two-line clamp. */}
      <div className="line-clamp-2 text-[13px] font-medium leading-snug text-text-1">
        {run.title || "(untitled)"}
      </div>

      {/* Quiet status sub-line — plain words, never a clipped chip. On a failed
          card the verdict shares its row with a direct "Retry" so a non-engineer
          re-queues the work in one click, without opening the run. */}
      {stage === "failed" ? (
        <div className="flex items-center justify-between gap-2">
          {status}
          <MissionRetryButton runs={[run]} onRetry={onRetry} label="Retry" />
        </div>
      ) : (
        status && <div>{status}</div>
      )}

      {/* Footer — one muted meta cluster (handle · agent · commit · when) */}
      {metaItems.length > 0 && (
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-text-3">
          {metaItems}
        </div>
      )}
    </div>
  );
}

/** One stage column — the Tasks board column shell verbatim: fixed 280px width,
 *  a header row (ring + label + count on the right), then a vertically-scrolling
 *  card stack. An empty column keeps its place and shows the stage's plain hint,
 *  so the board always reads as a stable, predictable pipeline. */
function StageColumn({
  stage,
  runs,
  now,
  selectedId,
  onSelect,
  onRetry,
  showProject = false,
}: {
  stage: MissionStageId;
  runs: MissionRun[];
  now: number;
  selectedId: string | null;
  onSelect: (run: MissionRun) => void;
  onRetry?: (runs: MissionRun[]) => void;
  showProject?: boolean;
}): JSX.Element {
  return (
    <div className="flex w-[280px] flex-shrink-0 flex-col rounded-[8px] border-[0.5px] border-line-soft bg-bg-2/50">
      <div className="flex items-center gap-2 border-b-[0.5px] border-line-soft px-3 py-2.5">
        <span className="inline-flex items-center gap-1.5 text-[13px] font-medium text-text-1">
          <StageRing stage={stage} />
          {STAGE_LABEL[stage]}
        </span>
        <span className="ml-auto inline-flex items-center gap-2">
          {/* One click re-queues every failed run in this column. */}
          {stage === "failed" && runs.length > 0 && (
            <MissionRetryButton runs={runs} onRetry={onRetry} label="Retry all" />
          )}
          <span className="text-[11px] tabular-nums text-text-3">
            {runs.length}
          </span>
        </span>
      </div>
      <div className="flex-1 space-y-2 overflow-y-auto p-2">
        {runs.length === 0 ? (
          <p className="px-1 py-3 text-[11px] leading-snug text-text-5">
            {STAGE_HINT[stage]}
          </p>
        ) : (
          runs.map((run) => (
            <MissionBoardCard
              key={run.id}
              run={run}
              now={now}
              selected={run.id === selectedId}
              onSelect={onSelect}
              onRetry={onRetry}
              showProject={showProject}
            />
          ))
        )}
      </div>
    </div>
  );
}

/** The board: every stage as a column, left→right in workflow order, on the same
 *  horizontally-scrolling frame the Tasks board uses. Columns come from
 *  `groupByStage(allRuns(state), true)` — `keepEmpty = true` so the whole
 *  pipeline always shows. */
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
  const { state, now, selectedId, onSelect, onRetry, showProject = false } =
    props;
  const columns = groupByStage(allRuns(state), true);

  return (
    <div className="h-full w-full overflow-x-auto overflow-y-hidden">
      <div className="flex h-full min-w-full gap-2 p-3">
        {columns.map((col) => (
          <StageColumn
            key={col.stage}
            stage={col.stage}
            runs={col.runs}
            now={now}
            selectedId={selectedId}
            onSelect={onSelect}
            onRetry={onRetry}
            showProject={showProject}
          />
        ))}
      </div>
    </div>
  );
}
