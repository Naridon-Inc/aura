// "How we'll check this" — the verify plan, with somewhere to put the answer.
//
// The plan is written when the goal is set: plain-language steps a person can
// follow, several of which Aura cannot run at all. It rendered as a list of
// small empty squares. They looked like checkboxes, took no click, held no
// state, and survived nothing: the run ended, the card went green on its
// structural verdict, and the step somebody still owed was a decoration under
// it.
//
// Each line is now a record. It is waiting on a person from the moment the plan
// names it, it leaves that state only when somebody says what happened, and the
// answer carries the version it was tried on — so a pass against last week's
// build ages exactly like a machine check against last week's build.

import { useMemo } from "react";
import {
  mergeManualChecks,
  useManualChecks,
  type ManualCheck,
} from "../../lib/manualChecks";
import { stalenessOf, type UnderReview } from "../../lib/evidence";
import { TraceItem, TraceItems, TraceLine } from "../ui/trace-report";
import { ManualOutcomeControl, ManualOutcomeNote, ManualStateChip } from "./ManualOutcome";

export function AcceptanceChecklist({
  repoRoot,
  /** The run these answers belong to. A goal card with no run — the workbench —
   *  records against the repo-wide "adhoc" key, the same fallback its verify
   *  already uses. */
  runKey,
  lines,
  /** The version being reviewed, for recording and for ageing what's recorded. */
  revision,
  underReview,
}: {
  repoRoot: string;
  runKey: string;
  lines: string[];
  revision: string | null;
  underReview?: UnderReview;
}) {
  const recorded = useManualChecks(repoRoot);
  const checks = useMemo(
    () => mergeManualChecks(recorded.filter((c) => c.runKey === runKey), runKey, lines),
    [recorded, runKey, lines],
  );

  if (checks.length === 0) return null;

  return (
    <section className="ui-goal-part">
      <h3 className="ui-goal-part-title">How we&apos;ll check this</h3>
      <TraceItems>
        {checks.map((check) => (
          <TraceItem
            key={check.id}
            tone={check.state === "passed" ? "good" : check.state === "failed" ? "bad" : "muted"}
            title={check.text}
            marks={<ManualStateChip state={check.state} />}
            actions={<ManualOutcomeControl repoRoot={repoRoot} check={check} revision={revision} />}
          >
            <ManualOutcomeNote check={check} />
            <StaleLine check={check} underReview={underReview} />
          </TraceItem>
        ))}
      </TraceItems>
    </section>
  );
}

/** An answer given about other code, said plainly. The same rule the evidence
 *  ledger uses — nothing about the goal still being open, or the task still
 *  being assigned, keeps a human answer current. */
function StaleLine({
  check,
  underReview,
}: {
  check: ManualCheck;
  underReview?: UnderReview;
}) {
  if (!underReview || check.state === "awaiting") return null;
  const staleness = stalenessOf({ revision: check.revision, at: check.at }, underReview);
  if (!staleness.stale) return null;
  return (
    <TraceLine tone="warn">{staleness.reason} Try it again on this version.</TraceLine>
  );
}
