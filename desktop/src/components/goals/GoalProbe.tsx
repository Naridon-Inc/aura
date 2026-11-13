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
import { TraceMark } from "../ui/trace-list";
import { TraceItem, TraceLine } from "../ui/trace-report";
import { VERDICT_MARK, VERDICT_TONE } from "./verdictTone";
import "./goals.css";
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
} from "../../lib/goalStore";
import { AcceptanceChecklist } from "./AcceptanceChecklist";
import { ProofBreakdown } from "./ProofBreakdown";
import { computeFeatureSignals } from "../../lib/featureSignals";
import { useFeatureDrift } from "../../lib/useFeatureDrift";
import { FeatureGates } from "./FeatureGates";
import { FeatureHistory } from "./FeatureHistory";
import { FeatureRoles } from "./FeatureRoles";
import { relativeAge } from "../../lib/relativeTime";
import { VERDICT } from "../../lib/goalVerdict";
import { stalenessOf, type UnderReview } from "../../lib/evidence";
import { shortRevision } from "../../lib/sessionEvidence";

export function GoalProbe({
  repoRoot,
  goal,
  runKey,
  runLabel,
  agentId,
  currentRunKey,
  atCommit,
  underReview,
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
  /** The version this surface is reviewing, when it is reviewing one. A session
   *  Summary is looking at one particular run's code and passes it; the Goals
   *  workbench is looking at the goal in general and passes nothing.
   *
   *  Given it, the card checks whether its latest verdict was actually measured
   *  against that code. It usually wasn't: `rollup` reports the newest run on
   *  the goal whatever version it ran on, so a check another session recorded
   *  an hour ago read here as "checked 1h ago" about code it never saw. */
  underReview?: UnderReview;
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
  // Which code the verdict above was actually measured against, and whether
  // that is the code being reviewed here. `rollup` takes the newest run on the
  // goal regardless of version, so this is the only thing standing between a
  // verdict and the wrong revision.
  const measured = goal.runs[0] ?? null;
  const measuredAt = (measured?.commit ?? "").trim() || null;
  const staleness =
    underReview && measured
      ? stalenessOf({ revision: measuredAt, at: measured.at }, underReview)
      : { stale: false, reason: "" };
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
    <div className="ui-goal">
      <TraceItem
        tone={VERDICT_TONE[r.verdict]}
        title={goal.text}
        marks={
          <>
            <TraceMark tone={VERDICT_MARK[r.verdict]} title={tone.hint}>
              {tone.label}
              {r.total > 0 ? ` · ${r.ok}/${r.total} in place` : ""}
            </TraceMark>
            {r.at != null ? <span className="ui-goal-meta">checked {relativeAge(r.at)}</span> : null}
            {measuredAt ? (
              <code className="ui-goal-meta" title="The version of the code this verdict was measured against">
                {shortRevision(measuredAt)}
              </code>
            ) : null}
            {staleness.stale ? (
              <TraceMark tone="warn" title={staleness.reason}>
                Out of date
              </TraceMark>
            ) : null}
          </>
        }
        actions={
          <>
            <Button type="button" variant="secondary" size="sm" onClick={() => void verify()} disabled={busy}>
              {busy ? "Checking…" : r.at != null ? "Re-verify" : "Verify"}
            </Button>
            {onEdit ? (
              <Button type="button" variant="ghost" size="sm" onClick={onEdit}>
                Edit
              </Button>
            ) : null}
            {onRemove ? (
              <Button type="button" variant="ghost" size="sm" onClick={onRemove}>
                Remove
              </Button>
            ) : null}
          </>
        }
      >
        {/* The verdict above describes the code it ran on, and that is not
            always the code on screen. Said in full rather than left to the
            mark, because "checked 1h ago" is the sentence people believe. */}
        {staleness.stale ? (
          <TraceLine tone="warn">{staleness.reason} Check it again to know where this stands.</TraceLine>
        ) : null}
        {/* Why it's not there yet, and whether the agent called it done when
            the code says otherwise — both in plain words, real signals only. */}
        <ClaimLines reason={reason} claim={claim} />
        {err ? <TraceLine tone="danger">{err}</TraceLine> : null}
        {/* The task this goal sits under. The run-by-run thread is below. */}
        {goal.taskId ? (
          <TraceLine tone="note">
            Under {goal.taskSeq != null && goal.taskSeq > 0 ? <code>AURA-{goal.taskSeq}</code> : "a linked task"}
          </TraceLine>
        ) : null}
      </TraceItem>

      <div className="ui-goal-parts">
        {/* The feature at a glance — Confidence / Risk / Drift + the overall
            "is it finished" line. Shown once there's real proof to weigh; an
            unchecked goal has no signal and the verdict above already says so. */}
        {signals.rated ? (
          <section className="ui-goal-part">
            <FeatureGates signals={signals} driftOverride={driftReal} headline={!reason} />
          </section>
        ) : null}

        {/* The plain-language verify plan — what to test, written when the goal
            was set. Distinct from the run-derived "What's missing" below: this
            is the intent of the check, that is the current result of running it. */}
        {goal.acceptance && goal.acceptance.length > 0 ? (
          <AcceptanceChecklist
            repoRoot={repoRoot}
            runKey={runKey ?? "adhoc"}
            lines={goal.acceptance}
            revision={atCommit ?? null}
            underReview={underReview}
          />
        ) : null}

        {/* The proof, broken open — how it was checked, what's in place, what's
            still missing, and (on demand) the code behind each check. Filled by
            a Verify, or auto-filled on the Summary. */}
        {!err && outcome && outcome.checks.length > 0 ? (
          <section className="ui-goal-part">
            <ProofBreakdown outcome={outcome} />
          </section>
        ) : null}

        {/* The feature's thread — every check across its sessions & commits.
            A single check is the verdict at the top already, so the thread
            starts at the second. */}
        {goal.runs.length > 1 ? <FeatureHistory runs={goal.runs} currentRunKey={currentRunKey} /> : null}

        {/* Who worked it + the feature's shape — only once this goal spread
            across parties, sessions, or commits. */}
        <FeatureRoles runs={goal.runs} />
      </div>
    </div>
  );
}

function ClaimLines({
  reason,
  claim,
}: {
  reason: string | null;
  claim: { text: string; tone: "gap" | "agree" | "context" } | null;
}) {
  if (!reason && !claim) return null;
  return (
    <>
      {claim ? (
        // A "done" the code doesn't back is the one claim that must not read
        // like the rest; agreement and context are said plainly.
        <TraceLine tone={claim.tone === "gap" ? "warn" : undefined}>
          <strong className="ui-goal-claim">{claim.text}</strong>
        </TraceLine>
      ) : null}
      {reason ? <TraceLine>{reason}</TraceLine> : null}
    </>
  );
}
