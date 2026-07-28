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
import type { GoalRun, GoalVerdict } from "../../lib/goalStore";

const VERDICT: Record<GoalVerdict, { label: string; color: string }> = {
  verified: { label: "Reached", color: "var(--color-accent-green)" },
  partial: { label: "Partly there", color: "var(--color-amber)" },
  not_wired: { label: "Not reached", color: "var(--color-red)" },
  unknown: { label: "Not checked", color: "var(--color-text-4)" },
};

function ago(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

const SHOWN = 6;

// One check on the thread: a verdict dot on a connecting rail, the plain result,
// and where it happened (session or commit) + who + when.
function ThreadRow({
  run,
  current,
  last,
}: {
  run: GoalRun;
  current: boolean;
  last: boolean;
}) {
  const v = VERDICT[run.verdict];
  const who = current ? "this session" : run.label ?? run.agentId ?? run.runKey.slice(0, 8);
  const onCommit = run.trigger === "build";
  return (
    <li className="flex gap-2.5">
      {/* Rail: dot + connector down to the next row. */}
      <div className="flex flex-col items-center">
        <span
          aria-hidden
          className="mt-[3px] h-2 w-2 shrink-0 rounded-full"
          style={{ background: v.color, boxShadow: current ? `0 0 0 3px color-mix(in oklab, ${v.color} 22%, transparent)` : undefined }}
        />
        {!last ? <span aria-hidden className="mt-0.5 w-px flex-1 bg-line-soft" /> : null}
      </div>
      <div className="min-w-0 flex-1 pb-2.5">
        <div className="flex items-center gap-2">
          <span className="text-[11.5px] font-medium" style={{ color: v.color }}>
            {v.label}
          </span>
          {run.total > 0 ? (
            <span className="text-[10px] text-text-4 tabular-nums">{run.ok}/{run.total} in place</span>
          ) : null}
          {onCommit ? (
            <span className="rounded-sm border border-line-soft px-1 py-px text-[9px] uppercase tracking-wide text-text-4">
              on commit
            </span>
          ) : null}
          <span className="ml-auto text-[10px] text-text-5">{ago(run.at)}</span>
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 text-[10.5px] text-text-4">
          <span className="min-w-0 truncate">{who}</span>
          {run.commit ? (
            <>
              <span aria-hidden className="text-text-5">·</span>
              <span className="font-mono text-text-5">{run.commit.slice(0, 7)}</span>
            </>
          ) : null}
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
    <section>
      <div className="mb-2 text-[10px] uppercase tracking-wider text-text-4">
        The feature&apos;s thread
        <span className="ml-1.5 normal-case tracking-normal text-text-5">
          {runs.length} check{runs.length === 1 ? "" : "s"}
          {commits > 0 ? ` across ${commits} commit${commits === 1 ? "" : "s"}` : ""}
        </span>
      </div>
      <ul className="flex flex-col">
        {shown.map((run, i) => (
          <ThreadRow
            key={`${run.runKey}:${i}`}
            run={run}
            current={run.runKey === currentRunKey}
            last={i === shown.length - 1 && hidden <= 0}
          />
        ))}
      </ul>
      {hidden > 0 ? (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="text-[10.5px] text-text-4 hover:text-text-2 transition-colors"
        >
          Show {hidden} earlier check{hidden === 1 ? "" : "s"}
        </button>
      ) : null}
    </section>
  );
}
