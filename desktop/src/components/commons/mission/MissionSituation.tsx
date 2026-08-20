// MissionSituation — one line at the top of Mission Control that answers the
// question the page exists for: *is my crew running, and does it need me?*
//
// Mission Control used to answer that nowhere. What the crew was doing right
// now lived in the footer as twelve grey pixels reading "Nothing running",
// between a project chip and a cloud icon, nine hundred pixels from the board
// it described. Whether anything was stopped on a human lived in the "Needs
// you" lane — which collapses to a forty-pixel vertical strip when it is empty,
// so the most important lane on the board was also the smallest thing on the
// screen, and you had to read a sideways word to learn there was nothing to
// read. Everything that WAS big — Paused 2, Ready 24, Waiting 18 — was
// inventory: counts you can do nothing about, given the whole first screen.
//
// So this is the situation, in one sentence, above the work: who is stopped on
// you, what is running, what is ready to go. It is not a fourth partition of
// the tasks — it names only the three states you can act on, and it reads them
// off `deriveStage`, the same single partition the lanes and the list draw. The
// full eight-stage breakdown is the board's job, one glance below.
//
// It carries no Run button. Run lives in the footer with the cap it caps, and
// two primary controls for one verb, forty pixels apart, is the confusion this
// page already had elsewhere.

import type { JSX, ReactNode } from "react";

import type { MissionRun, MissionState } from "../../../lib/api";
import { AsciiSpinner } from "../../ui/ascii-spinner";
import {
  allRuns,
  deriveStage,
  elapsedLabel,
  waitingOnLabel,
  STAGE_TONE,
  type MissionStageId,
} from "./missionData";

/** A run's title as a quiet inline link — clicking opens its detail in the
 *  sidebar, the same as clicking its card. Truncates; never wraps the line. */
function RunLink({
  run,
  onOpen,
}: {
  run: MissionRun;
  onOpen: (run: MissionRun) => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={() => onOpen(run)}
      title={run.title}
      className="max-w-[22rem] truncate rounded px-1 -mx-1 text-left text-text-2 underline decoration-line-soft underline-offset-2 hover:bg-state-hover hover:text-text-1"
    >
      {run.title || "(untitled)"}
    </button>
  );
}

export function MissionSituation({
  state,
  now,
  loading,
  onOpen,
}: {
  state: MissionState;
  now: number;
  /** The queue is being re-read. Shown as the app's one loader rather than a
   *  stale sentence, so a refresh never reads as "nothing is happening". */
  loading?: boolean;
  onOpen: (run: MissionRun) => void;
}): JSX.Element | null {
  // One pass, one partition — the same `deriveStage` the lanes and the list
  // group by, so this line can never disagree with the board under it.
  const buckets = new Map<MissionStageId, MissionRun[]>();
  for (const run of allRuns(state)) {
    const stage = deriveStage(run);
    const bucket = buckets.get(stage);
    if (bucket) bucket.push(run);
    else buckets.set(stage, [run]);
  }
  const at = (stage: MissionStageId): MissionRun[] => buckets.get(stage) ?? [];
  const needsYou = at("needsYou");
  const building = at("building");
  const reviewing = at("reviewing");
  const ready = at("triage");
  const waiting = at("planning");
  const failed = at("failed");

  // Nothing at all on the board — the surface shows its own empty state and
  // this line would only repeat it.
  if (buckets.size === 0) return null;

  let tone = "var(--color-text-4)";
  let mark: ReactNode = null;
  let lead: ReactNode = null;

  if (needsYou.length > 0) {
    // The only case that gets colour. Something started, stopped, and will not
    // move again until a person acts — nothing else on this page is like that.
    tone = STAGE_TONE.needsYou;
    mark = (
      <span
        className="h-1.5 w-1.5 shrink-0 rounded-full"
        style={{ background: tone }}
        aria-hidden
      />
    );
    const first = needsYou[0];
    const asked = waitingOnLabel(first.waitingOn);
    lead = (
      <>
        <span className="font-medium" style={{ color: tone }}>
          {needsYou.length === 1
            ? "1 task is stopped, waiting on you"
            : `${needsYou.length} tasks are stopped, waiting on you`}
        </span>
        <span className="text-text-5" aria-hidden>
          ·
        </span>
        <RunLink run={first} onOpen={onOpen} />
        {asked ? <span className="truncate text-text-4">({asked})</span> : null}
        {needsYou.length > 1 ? (
          <span className="shrink-0 text-text-4">
            +{needsYou.length - 1} more
          </span>
        ) : null}
      </>
    );
  } else if (building.length > 0) {
    // Agents are on it. The lead names them, because "3 working" tells you the
    // crew is alive and nothing else — which three is what you came to see.
    tone = STAGE_TONE.building;
    // The app's one loader, already amber — the same tone Building wears.
    mark = <AsciiSpinner className="text-xs" />;
    const first = building[0];
    const spent = elapsedLabel(first.startedAtMs, now);
    lead = (
      <>
        <span className="font-medium" style={{ color: tone }}>
          {building.length === 1
            ? "1 agent working"
            : `${building.length} agents working`}
        </span>
        <span className="text-text-5" aria-hidden>
          ·
        </span>
        <RunLink run={first} onOpen={onOpen} />
        {spent ? <span className="shrink-0 text-text-4">{spent}</span> : null}
        {building.length > 1 ? (
          <span className="shrink-0 text-text-4">
            +{building.length - 1} more
          </span>
        ) : null}
      </>
    );
  } else if (ready.length > 0) {
    // Idle with a backlog. The line states it and stops — Run crew is a filled
    // accent button in the bar below with the cap it caps beside it, and a
    // second copy of the app's primary verb up here, or a sentence explaining
    // where the first one lives, would both be worse than the button.
    lead = (
      <>
        <span className="font-medium text-text-2">Nobody working</span>
        <span className="text-text-5" aria-hidden>
          ·
        </span>
        <span className="text-text-4">
          {ready.length === 1 ? "1 task is" : `${ready.length} tasks are`} ready
          to start.
        </span>
      </>
    );
  } else {
    // Idle with nothing armed. Say what is actually left, so "nobody working"
    // never reads as "you are done" when eighteen tasks are simply waiting.
    const rest: string[] = [];
    if (waiting.length > 0) {
      rest.push(
        `${waiting.length} ${waiting.length === 1 ? "task is" : "tasks are"} waiting on earlier work`,
      );
    }
    const parked = at("paused");
    if (parked.length > 0) rest.push(`${parked.length} paused`);
    lead = (
      <>
        <span className="font-medium text-text-2">Nobody working</span>
        {rest.length > 0 ? (
          <>
            <span className="text-text-5" aria-hidden>
              ·
            </span>
            <span className="truncate text-text-4">{rest.join(", ")}.</span>
          </>
        ) : (
          <span className="text-text-4">. Nothing left to start.</span>
        )}
      </>
    );
  }

  // The tail carries the OTHER two things a person is on the hook for, when
  // they aren't already the lead: work that finished and wants a look, and work
  // that gave up. Both are quiet counts — the lanes hold the detail.
  const tail: ReactNode[] = [];
  if (reviewing.length > 0) {
    tail.push(
      <span key="review" className="shrink-0" style={{ color: STAGE_TONE.reviewing }}>
        {reviewing.length} ready for your look
      </span>,
    );
  }
  if (failed.length > 0) {
    tail.push(
      <span key="failed" className="shrink-0" style={{ color: STAGE_TONE.failed }}>
        {failed.length} couldn&rsquo;t finish
      </span>,
    );
  }

  return (
    <div
      className="flex shrink-0 items-center gap-2 border-b border-line-soft px-6 py-2 text-sm"
      style={
        needsYou.length > 0
          ? { background: `color-mix(in srgb, ${tone} 7%, transparent)` }
          : undefined
      }
    >
      {loading ? <AsciiSpinner className="text-xs" /> : mark}
      <div className="flex min-w-0 flex-1 items-center gap-1.5 truncate">
        {lead}
      </div>
      {tail.length > 0 ? (
        <div className="flex shrink-0 items-center gap-2.5 text-xs">{tail}</div>
      ) : null}
    </div>
  );
}
