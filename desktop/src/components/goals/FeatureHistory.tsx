// FeatureHistory — the feature's thread, one row per check. Each recorded run is
// a moment someone (or an auto-prove on a commit) measured how far this feature
// had got: which session or commit it was, who drove it, and Aura's verdict at
// that point. Read top-to-bottom it's the story of the feature coming together
// across every session and commit that touched it — the "how is this connected
// across sessions and commits" answer, in plain words a non-engineer can follow.
//
// It shows real recorded runs only; nothing is inferred. A commit-triggered
// check (the agent committed the work) is marked so the auto-proof reads apart
// from a hand check.

import { useState } from "react";
import type { GoalRun } from "../../lib/goalStore";
import { VERDICT } from "../../lib/goalVerdict";
import { Button } from "../ui/button";
import { TraceMark } from "../ui/trace-list";
import { VERDICT_TONE } from "./verdictTone";
import "./goals.css";
import { relativeAge } from "../../lib/relativeTime";

const SHOWN = 6;

// One check on the thread: a verdict dot on a connecting rail, the plain result,
// and where it happened (session or commit) + who + when.
function ThreadRow({ run, current }: { run: GoalRun; current: boolean }) {
  const v = VERDICT[run.verdict];
  const who = current ? "this session" : run.label ?? run.agentId ?? run.runKey.slice(0, 8);
  const onCommit = run.trigger === "build";
  return (
    // The library timeline: the filled marker is the session you are reading.
    <li data-tone={current ? "active" : "neutral"}>
      <span className="ui-timeline-marker" aria-hidden />
      <div>
        <strong>
          <span className="ui-goal-verdict" data-tone={VERDICT_TONE[run.verdict]}>
            {v.label}
          </span>
          {run.total > 0 ? (
            <span className="ui-goal-meta">
              {run.ok}/{run.total} in place
            </span>
          ) : null}
          {onCommit ? <TraceMark>on commit</TraceMark> : null}
          <span className="ui-goal-meta ui-goal-thread-when">{relativeAge(run.at)}</span>
        </strong>
        <div>
          <span className="ui-goal-thread-who">{who}</span>
          {run.commit ? <code className="ui-goal-meta"> · {run.commit.slice(0, 7)}</code> : null}
        </div>
      </div>
    </li>
  );
}

/** The feature's checks over time — newest first, collapsing to the most recent
 *  handful with a click to see the rest. Renders nothing when there are no runs
 *  (the card simply has no thread to show yet). */
export function FeatureHistory({
  runs,
  currentRunKey,
}: {
  runs: GoalRun[];
  currentRunKey?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  if (runs.length === 0) return null;
  const shown = expanded ? runs : runs.slice(0, SHOWN);
  const hidden = runs.length - shown.length;
  const commits = new Set(runs.filter((r) => r.commit).map((r) => r.commit)).size;
  return (
    <section className="ui-goal-part">
      <h3 className="ui-goal-part-title">
        The feature&apos;s thread
        <small>
          {runs.length} check{runs.length === 1 ? "" : "s"}
          {commits > 0 ? ` across ${commits} commit${commits === 1 ? "" : "s"}` : ""}
        </small>
      </h3>
      <ol className="ui-timeline ui-goal-thread" data-orientation="vertical" data-position="after">
        {shown.map((run, i) => (
          <ThreadRow key={`${run.runKey}:${i}`} run={run} current={run.runKey === currentRunKey} />
        ))}
      </ol>
      {hidden > 0 ? (
        <Button type="button" variant="ghost" size="sm" onClick={() => setExpanded(true)}>
          Show {hidden} earlier check{hidden === 1 ? "" : "s"}
        </Button>
      ) : null}
    </section>
  );
}
