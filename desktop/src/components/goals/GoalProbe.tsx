// GoalProbe — the shared unit for a single goal, reused wherever a goal is
// associated with an instance: the per-run card in a session Summary, the
// per-task card in a task detail, and a row in the Goals workbench. It reads
// verdict-first (Reached / Partly there / Not reached / Not checked), offers a
// (re-)verify that records the result against the calling run, surfaces the
// handful of missing links, and shows the goal's associations — the task it
// was assigned under and the runs that have proven it.
//
// Verifying never mutates code; it shells `aura prove` and writes a verdict
// into the shared GoalRecord, so the same result shows up in every place the
// goal is associated.

import { useState } from "react";
import { Button } from "../ui/button";
import { runProve, type Check } from "../../lib/prove";
import {
  recordRun,
  rollup,
  verdictFromProve,
  type GoalRecord,
  type GoalRun,
  type GoalVerdict,
} from "../../lib/goalStore";

const VERDICT: Record<
  GoalVerdict,
  { label: string; color: string }
> = {
  verified: { label: "Reached", color: "var(--color-accent-green)" },
  partial: { label: "Partly there", color: "var(--color-amber)" },
  not_wired: { label: "Not reached", color: "var(--color-red)" },
  unknown: { label: "Not checked", color: "var(--color-text-4)" },
};

function relAge(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return `${Math.floor(d / 30)}mo ago`;
}

export function GoalProbe({
  repoRoot,
  goal,
  runKey,
  runLabel,
  agentId,
  currentRunKey,
  onRemove,
  onEdit,
}: {
  repoRoot: string;
  goal: GoalRecord;
  /** When set, a verify records the run against this key (the session's run);
   *  otherwise it records a repo-wide `"adhoc"` check. */
  runKey?: string;
  runLabel?: string;
  agentId?: string;
  /** Highlight which run row is "this run" (the session being viewed). */
  currentRunKey?: string;
  onRemove?: () => void;
  onEdit?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [gaps, setGaps] = useState<Check[] | null>(null);
  const [showAllGaps, setShowAllGaps] = useState(false);

  const r = rollup(goal);
  const tone = VERDICT[r.verdict];

  async function verify() {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const result = await runProve(repoRoot, goal.text);
      const { verdict, ok, total } = verdictFromProve(result);
      setGaps(result.checks.filter((c) => !c.ok));
      const run: GoalRun = {
        runKey: runKey ?? "adhoc",
        label: runLabel ?? "Ad-hoc check",
        agentId,
        verdict,
        ok,
        total,
        at: Date.now(),
      };
      recordRun(repoRoot, goal.id, run);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const shownGaps = gaps ? (showAllGaps ? gaps : gaps.slice(0, 3)) : [];
  const restGaps = gaps ? gaps.length - shownGaps.length : 0;

  return (
    <div className="rounded-lg border border-line-soft bg-bg-1">
      {/* Verdict + goal text + actions. */}
      <div className="flex items-start gap-3 px-3.5 py-3">
        <span
          aria-hidden
          className="mt-[5px] h-2 w-2 shrink-0 rounded-full"
          style={{ background: tone.color }}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[12px] font-medium" style={{ color: tone.color }}>
              {tone.label}
            </span>
            {r.total > 0 ? (
              <span className="text-[10.5px] text-text-4 tabular-nums">
                {r.ok}/{r.total} in place
              </span>
            ) : null}
            {r.at != null ? (
              <span className="text-[10.5px] text-text-5">· checked {relAge(r.at)}</span>
            ) : null}
            <div className="ml-auto flex items-center gap-1">
              <Button
                type="button"
                variant="subtle"
                size="xs"
                onClick={() => void verify()}
                disabled={busy}
                className="text-text-3"
              >
                {busy ? "Checking…" : r.at != null ? "Re-verify" : "Verify"}
              </Button>
              {onEdit ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={onEdit}
                  title="Edit goal"
                  className="text-text-4"
                >
                  Edit
                </Button>
              ) : null}
              {onRemove ? (
                <button
                  type="button"
                  onClick={onRemove}
                  title="Remove goal"
                  className="rounded px-1.5 py-0.5 text-[11px] text-text-5 hover:bg-bg-2 hover:text-rose-300"
                >
                  ✕
                </button>
              ) : null}
            </div>
          </div>
          <p className="mt-1 text-[13px] leading-snug text-text-1">{goal.text}</p>
        </div>
      </div>

      {/* The plain-language verify plan — what to test, written when the goal
          was set (Manager brain on Build, or by hand). Distinct from the
          run-derived "What's missing" below: this is the intent of the check,
          that is the current result of running it. */}
      {goal.acceptance && goal.acceptance.length > 0 ? (
        <div className="border-t border-line-soft px-3.5 py-2.5">
          <div className="mb-1.5 text-[10px] uppercase tracking-wider text-text-4">
            How we&apos;ll check this
          </div>
          <ul className="flex flex-col gap-1">
            {goal.acceptance.map((c, i) => (
              <li
                key={i}
                className="flex items-start gap-2 text-[12px] text-text-2"
              >
                <span
                  aria-hidden
                  className="mt-[3px] h-[10px] w-[10px] shrink-0 rounded-[2px] border-[1.5px] border-text-4"
                />
                <span className="min-w-0">{c}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* Missing links — the handful that matters. */}
      {err ? (
        <div className="border-t border-line-soft px-3.5 py-2 font-mono text-[11px] text-red break-words">
          {err}
        </div>
      ) : shownGaps.length > 0 ? (
        <div className="border-t border-line-soft px-3.5 py-2.5">
          <div className="mb-1.5 text-[10px] uppercase tracking-wider text-text-4">
            What&apos;s missing
          </div>
          <ul className="flex flex-col gap-1">
            {shownGaps.map((c, i) => (
              <li key={i} className="flex items-start gap-2 text-[12px]" title={c.line}>
                <span className="mt-px shrink-0 text-[11px] text-red">✗</span>
                <span className="min-w-0 truncate">
                  {c.kind && c.identifier ? (
                    <>
                      <span className="text-text-4">{c.kind}</span>{" "}
                      <span className="font-mono text-text-1">{c.identifier}</span>
                    </>
                  ) : (
                    <span className="font-mono text-text-2">{c.line}</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
          {restGaps > 0 ? (
            <button
              type="button"
              onClick={() => setShowAllGaps(true)}
              className="mt-1.5 text-[11px] text-text-3 hover:text-text-1"
            >
              + {restGaps} more missing
            </button>
          ) : null}
        </div>
      ) : null}

      {/* Associations — the instances this goal is bound to. */}
      {(goal.taskId || goal.runs.length > 0) && (
        <div className="flex flex-wrap items-center gap-1.5 border-t border-line-soft px-3.5 py-2">
          {goal.taskSeq != null && goal.taskSeq > 0 ? (
            <span className="rounded border border-line-soft px-1.5 py-0.5 font-mono text-[10px] text-text-3">
              AURA-{goal.taskSeq}
            </span>
          ) : goal.taskId ? (
            <span className="rounded border border-line-soft px-1.5 py-0.5 text-[10px] text-text-3">
              linked task
            </span>
          ) : null}
          {goal.runs.slice(0, 4).map((run) => (
            <RunChip key={run.runKey} run={run} current={run.runKey === currentRunKey} />
          ))}
          {goal.runs.length > 4 ? (
            <span className="text-[10px] text-text-5">+{goal.runs.length - 4} runs</span>
          ) : null}
        </div>
      )}
    </div>
  );
}

function RunChip({ run, current }: { run: GoalRun; current: boolean }) {
  const color = VERDICT[run.verdict].color;
  return (
    <span
      className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] ${
        current ? "ring-1 ring-line text-text-2" : "text-text-4"
      }`}
      style={{ background: current ? "color-mix(in oklab, var(--color-accent) 8%, transparent)" : "transparent" }}
      title={`${run.label ?? run.runKey} — ${run.ok}/${run.total} in place`}
    >
      <span aria-hidden className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
      <span className="max-w-[120px] truncate">
        {current ? "this run" : run.label ?? run.runKey.slice(0, 8)}
      </span>
    </span>
  );
}
