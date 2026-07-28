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

import { useEffect, useState } from "react";
import { Button } from "../ui/button";
import { runProveStructured, type ProveOutcome } from "../../lib/prove";
import {
  fetchProveOutcome,
  peekProveOutcome,
  writeProveOutcome,
} from "../../lib/proveCache";
import {
  doneClaim,
  reachedSummary,
  recordRun,
  rollup,
  verdictFromOutcome,
  type GoalRecord,
  type GoalRun,
  type GoalVerdict,
} from "../../lib/goalStore";
import { ProofBreakdown } from "./ProofBreakdown";
import { computeFeatureSignals } from "../../lib/featureSignals";
import { useFeatureDrift } from "../../lib/useFeatureDrift";
import { FeatureGates } from "./FeatureGates";
import { FeatureHistory } from "./FeatureHistory";
import { FeatureRoles } from "./FeatureRoles";

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
  atCommit,
  autoExplain = false,
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
  /** Anchor the proof to a specific commit — read the code as it was at that
   *  commit (or the nearest checkpoint around it), not the checked-out branch.
   *  Makes a session's goals prove against the code that session produced, even
   *  when it lives on a branch that isn't checked out (else a false 0%). */
  atCommit?: string;
  /** Lead with the proof: fill in the per-check breakdown on mount (read-only),
   *  so a "Reached 4/4" card opens already showing its individual checks. Used
   *  on the session Summary; off elsewhere (breakdown appears on Verify). */
  autoExplain?: boolean;
  onRemove?: () => void;
  onEdit?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Seed from the process-lifetime prove cache so re-opening a goal paints its
  // last-known breakdown on the first frame instead of re-shelling `aura prove`
  // and popping it in a beat late. The autoExplain effect revalidates.
  const [outcome, setOutcome] = useState<ProveOutcome | null>(() =>
    peekProveOutcome(repoRoot, goal.text, atCommit),
  );

  const r = rollup(goal);
  const tone = VERDICT[r.verdict];
  // Plain-words "why it's not there yet" + whether the agent oversold it. Pass
  // the live outcome so a "built but not wired" state doesn't misread as unbuilt.
  const reason = reachedSummary(goal, outcome);
  const claim = doneClaim(goal);
  // The whole-feature read: three honest gates + a "is it finished" headline,
  // computed from the same proof this card holds and the goal's run history.
  const signals = computeFeatureSignals(goal, outcome);
  // Upgrade Drift from the proof-regression heuristic to the real intent-vs-
  // actual signal across this goal's commits (async; null until it lands, then
  // it swaps in over the heuristic gate — never a blank).
  const driftReal = useFeatureDrift(repoRoot, goal.runs);

  async function verify() {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const result = await runProveStructured(repoRoot, goal.text, atCommit);
      const { verdict, ok, total } = verdictFromOutcome(result);
      setOutcome(result);
      // Feed the freshly-proved outcome into the cache so other mounts of this
      // goal (and a later re-open) paint it instantly.
      writeProveOutcome(repoRoot, goal.text, result, atCommit);
      const run: GoalRun = {
        runKey: runKey ?? "adhoc",
        label: runLabel ?? "Ad-hoc check",
        agentId,
        verdict,
        ok,
        total,
        at: Date.now(),
        // The commit the proof was anchored to (if any), so the run history
        // records which snapshot this verdict is about.
        commit: atCommit ?? null,
      };
      recordRun(repoRoot, goal.id, run);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  // On proof-first surfaces (the session Summary), show the per-check breakdown
  // as soon as the card mounts so the aggregate arrives already opened into its
  // individual checks. Stale-while-revalidate: paint the cached breakdown
  // instantly, then re-check quietly in the background and replace only when the
  // fresh outcome lands — never blanking a breakdown we already have. Read-only:
  // it never records a run, so the verdict + "checked …" timestamp don't churn.
  useEffect(() => {
    if (!autoExplain) return;
    let cancelled = false;
    // Instant paint from the cache (covers a re-open where local state was lost
    // but the outcome is still warm from an earlier mount).
    const cached = peekProveOutcome(repoRoot, goal.text, atCommit);
    if (cached && !cancelled) setOutcome(cached);
    // Revalidate underneath. De-duped across sibling probes for the same goal.
    void fetchProveOutcome(repoRoot, goal.text, atCommit)
      .then((result) => {
        if (!cancelled) setOutcome(result);
      })
      .catch(() => {
        /* leave the cached/aggregate view; Verify still offers a manual retry */
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoExplain, goal.text, repoRoot, atCommit]);

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
                  className="rounded px-1.5 py-0.5 text-[11px] text-text-5 hover:bg-bg-2 hover:text-red"
                >
                  ✕
                </button>
              ) : null}
            </div>
          </div>
          <p className="mt-1 text-[13px] leading-snug text-text-1">{goal.text}</p>
          {/* Why it's not there yet, and whether the agent called it done when
              the code says otherwise — both in plain words, real signals only. */}
          <ClaimBand reason={reason} claim={claim} />
        </div>
      </div>

      {/* The feature at a glance — Confidence / Risk / Drift + the overall
          "is it finished" line. Shown once there's real proof to weigh; an
          unchecked goal has no signal and the verdict above already says so. */}
      {signals.rated ? (
        <div className="border-t border-line-soft px-3.5 py-3">
          <FeatureGates signals={signals} driftOverride={driftReal} />
        </div>
      ) : null}

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

      {/* The proof, broken open — how it was checked, what's in place, what's
          still missing, and (on demand) the code behind each check. Filled by a
          Verify, or auto-filled on the Summary. This is the "what does 4/4 in
          place actually mean" answer, in the user's own words. */}
      {err ? (
        <div className="border-t border-line-soft px-3.5 py-2 font-mono text-[11px] text-red break-words">
          {err}
        </div>
      ) : outcome && outcome.checks.length > 0 ? (
        <div className="border-t border-line-soft px-3.5 py-3">
          <ProofBreakdown outcome={outcome} />
        </div>
      ) : null}

      {/* Associations — the task this goal sits under. The run-by-run thread is
          the history rail below. */}
      {goal.taskId ? (
        <div className="flex flex-wrap items-center gap-1.5 border-t border-line-soft px-3.5 py-2">
          {goal.taskSeq != null && goal.taskSeq > 0 ? (
            <span className="rounded border border-line-soft px-1.5 py-0.5 font-mono text-[10px] text-text-3">
              AURA-{goal.taskSeq}
            </span>
          ) : (
            <span className="rounded border border-line-soft px-1.5 py-0.5 text-[10px] text-text-3">
              linked task
            </span>
          )}
        </div>
      ) : null}

      {/* The feature's thread — every check across its sessions & commits, so
          the whole arc of the feature coming together is readable at once. */}
      {goal.runs.length > 0 ? (
        <div className="border-t border-line-soft px-3.5 py-3">
          <FeatureHistory runs={goal.runs} currentRunKey={currentRunKey} />
        </div>
      ) : null}

      {/* Who worked it + the feature's shape — shown only once this goal spread
          across parties, sessions, or commits (a single ad-hoc check has nothing
          worth a panel; the thread above already carries it). */}
      <FeatureRoles runs={goal.runs} className="border-t border-line-soft px-3.5 py-3" />
    </div>
  );
}

// The goal-level honesty band: one plain line for *why* it's not there yet, and
// — when the agent committed this as done — whether the code actually agrees.
// The "agent said done, code says not yet" case is the one that matters most, so
// a claim gets a tone-tinted callout (amber = gap, teal = agree); a bare reason
// with no claim stays a quiet muted line.
function ClaimBand({
  reason,
  claim,
}: {
  reason: string | null;
  claim: { text: string; tone: "gap" | "agree" | "context" } | null;
}) {
  if (!reason && !claim) return null;
  if (!claim) {
    return <p className="mt-2 text-[11.5px] leading-snug text-text-3">{reason}</p>;
  }
  const accent =
    claim.tone === "gap"
      ? "var(--color-amber)"
      : claim.tone === "agree"
        ? "var(--color-accent-green)"
        : "var(--color-blue)";
  const icon = claim.tone === "gap" ? "⚠" : claim.tone === "agree" ? "✓" : "•";
  return (
    <div
      className="mt-2 flex items-start gap-2 rounded-md px-2.5 py-2"
      style={{
        background: `color-mix(in oklab, ${accent} 10%, transparent)`,
        border: `1px solid color-mix(in oklab, ${accent} 22%, transparent)`,
      }}
    >
      <span aria-hidden className="mt-px shrink-0 text-[12px]" style={{ color: accent }}>
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[12px] font-medium leading-snug" style={{ color: accent }}>
          {claim.text}
        </p>
        {reason ? (
          <p className="mt-0.5 text-[11.5px] leading-snug text-text-3">{reason}</p>
        ) : null}
      </div>
    </div>
  );
}

