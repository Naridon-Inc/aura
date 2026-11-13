// One goal as a moment on Trace's timeline: the task, in the words it was
// written in, and one muted line saying whether the code shows it done, when
// that was last looked at, and where it sits on the board.

import { relativeAgeFromDelta } from "../../../lib/relativeTime";
import { VERDICT } from "../../../lib/goalVerdict";
import { taskStatusLabel, type TaskGoal } from "../../../lib/taskGoals";
import { AsciiSpinner } from "../../ui/ascii-spinner";
import { TraceMark } from "../../ui/trace-list";
import { TraceTimelineEntry } from "../../ui/trace-timeline";
import { VERDICT_MARK } from "../../goals/verdictTone";
import { MomentFacts } from "./SessionMoment";
import { claimsDoneButNot } from "./goalStoryText";
import type { GoalVerdict } from "../../../lib/goalStore";

/** The verdict as its mark, with the tally once there is one. */
export function VerdictMark({ verdict, ok, total }: { verdict: GoalVerdict; ok: number; total: number }) {
  const v = VERDICT[verdict];
  const tally = verdict !== "unknown" && total > 0 ? ` · ${ok}/${total}` : "";
  return (
    <TraceMark tone={VERDICT_MARK[verdict]} title={v.hint}>
      {v.label}
      {tally}
    </TraceMark>
  );
}

/** "checked 3d ago", with the full date on hover. */
export function CheckedWhen({ at, now = Date.now() }: { at: number | null; now?: number }) {
  if (!at) return null;
  return (
    <time dateTime={new Date(at).toISOString()} title={new Date(at).toLocaleString()}>
      checked {relativeAgeFromDelta(Math.max(0, (now - at) / 1000), { style: "prose" })}
    </time>
  );
}

/** Where the task sits on the board: its handle and status. */
export function boardFacts(goal: TaskGoal, verdict: GoalVerdict) {
  const doneButNot = claimsDoneButNot(goal.taskStatus, verdict);
  return [
    goal.taskSeq > 0 && `AURA-${goal.taskSeq}`,
    doneButNot ? (
      <TraceMark key="claim" tone="warn" title="The board says done, but the code doesn't fully back that up yet.">
        marked done, not proven
      </TraceMark>
    ) : (
      taskStatusLabel(goal.taskStatus)
    ),
  ];
}

export function GoalMoment({
  goal,
  busy,
  errored,
  active,
  onOpen,
}: {
  goal: TaskGoal;
  busy: boolean;
  errored: boolean;
  active: boolean;
  onOpen: () => void;
}) {
  const verdict = busy ? null : errored ? (
    <TraceMark tone="danger" title="The checker couldn't run. Check your setup and try again.">
      Couldn&apos;t check
    </TraceMark>
  ) : (
    <VerdictMark verdict={goal.verdict} ok={goal.ok} total={goal.total} />
  );
  return (
    <TraceTimelineEntry
      title={goal.text}
      active={active}
      onSelect={onOpen}
      detail={
        <MomentFacts
          facts={[
            busy ? (
              <>
                <AsciiSpinner size={10} /> Checking…
              </>
            ) : (
              verdict
            ),
            !busy && goal.at ? <CheckedWhen at={goal.at} /> : null,
            ...boardFacts(goal, goal.verdict),
          ]}
        />
      }
    />
  );
}
