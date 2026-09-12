// "Still open" — what a finished run owes, and the button that settles it.
//
// The agent stops, the session goes grey, and the page fills with green: a
// seal, a verdict, a list of files. Everything the run left behind — a check
// that failed, a check nobody ran, the handset test its own plan asked a person
// to do — lived somewhere else or nowhere. The end of a process read as the end
// of the work.
//
// So this sits above the evidence ledger and says what is left, each item with
// what it needs and the one existing action that would settle it. Two rules it
// must not break: an item leaves only when its evidence changes or a person
// records an outcome, and an action that fails says so and leaves the item
// exactly where it was. Nothing here closes optimistically.
//
// The list is derived in lib/outstanding; this file runs the actions.

import { useMemo, useState } from "react";
import { runChecksNow } from "../../lib/checksEvidence";
import { mergeManualChecks, useManualChecks, type ManualCheck } from "../../lib/manualChecks";
import { ManualOutcomeControl } from "../goals/ManualOutcome";
import { outstandingItems, outstandingLead, type OutstandingItem } from "../../lib/outstanding";
import {
  actionTarget,
  type ActionKind,
  type ReviewScope,
  type WorkingTarget,
} from "../../lib/reviewScope";
import { useWorkingTarget } from "../../lib/useWorkingTarget";
import { proveRunGoals } from "../../lib/proveRun";
import { useGoalsForRun } from "../../lib/goalStore";
import { useRunEvidence } from "../../lib/useRunEvidence";
import { Button } from "../ui/button";

export function SessionOutstanding({
  repoRoot,
  runKey,
  runLabel,
  agentId,
  signed,
  scope,
  codeChangedAt,
  fileCount,
  alignment,
  onOpenMatch,
}: {
  repoRoot: string;
  runKey: string;
  /** What was asked here — the label a re-check records under. */
  runLabel: string;
  agentId?: string;
  signed: boolean;
  /** What this page is about: the project, the branch and folder the run
   *  happened in, and the version of the code it produced. Distinct from where
   *  the reader is standing, which is what the actions below will touch. */
  scope: ReviewScope;
  codeChangedAt: number | null;
  fileCount: number;
  alignment: { available: boolean; unsupportedReason: string };
  /** Open the tab that compares what was asked with what changed. */
  onOpenMatch?: () => void;
}) {
  const revision = scope.revision;
  // Where the buttons here would land, as opposed to what the page is about.
  const working = useWorkingTarget(repoRoot);
  const { items: evidence, planLines, checks } = useRunEvidence({
    repoRoot,
    runKey,
    signed,
    revision,
    codeChangedAt,
    fileCount,
    alignment,
  });

  // The plan's steps joined with whatever people have recorded against them.
  // A line the plan names is outstanding from that moment — not from the moment
  // somebody first touches it.
  const recorded = useManualChecks(repoRoot);
  const manual = useMemo(
    () => mergeManualChecks(recorded.filter((c) => c.runKey === runKey), runKey, planLines),
    [recorded, runKey, planLines],
  );

  const goals = useGoalsForRun(repoRoot, runKey);
  const [proving, setProving] = useState(false);
  const [proveError, setProveError] = useState("");

  const items = useMemo(
    () =>
      outstandingItems({
        evidence,
        manual,
        review: { revision, changedAt: codeChangedAt },
      }),
    [evidence, manual, revision, codeChangedAt],
  );

  async function recheckGoals() {
    if (proving) return;
    setProving(true);
    setProveError("");
    const result = await proveRunGoals(repoRoot, goals, {
      runKey,
      runLabel,
      agentId,
      atCommit: revision ?? undefined,
    });
    setProveError(result.error);
    setProving(false);
  }

  return (
    <section>
      <div className="mb-2.5">
        <h2 className="section-label">Still open</h2>
      </div>
      <p className="mb-2.5 text-base leading-snug text-text-3">{outstandingLead(items)}</p>

      {items.length > 0 ? (
        <div className="overflow-hidden rounded-lg border border-line-soft bg-bg-1">
          {items.map((item) => (
            <OutstandingRow
              key={item.id}
              item={item}
              manual={manual.find((c) => `manual:${c.id}` === item.id) ?? null}
              repoRoot={repoRoot}
              revision={revision}
              scope={scope}
              working={working}
              busy={
                item.action.kind === "run_checks"
                  ? checks.running
                  : item.action.kind === "check_goal"
                    ? proving
                    : false
              }
              failure={
                item.action.kind === "run_checks"
                  ? checks.error
                  : item.action.kind === "check_goal"
                    ? proveError
                    : ""
              }
              onRunChecks={() => void runChecksNow(repoRoot)}
              onCheckGoal={() => void recheckGoals()}
              onOpenMatch={onOpenMatch}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}

/** Which "what this would touch" line an item's action needs, if any. A step
 *  for a person touches nothing on this machine, so it gets none. */
function targetKind(item: OutstandingItem): ActionKind | null {
  if (item.action.kind === "run_checks") return "checks";
  if (item.action.kind === "check_goal") return "goal";
  if (item.action.kind === "open_match") return "match";
  return null;
}

const TONE_COLOR = {
  bad: "var(--color-red)",
  warn: "var(--color-amber)",
  muted: "var(--color-text-4)",
} as const;

function OutstandingRow({
  item,
  manual,
  repoRoot,
  revision,
  scope,
  working,
  busy,
  failure,
  onRunChecks,
  onCheckGoal,
  onOpenMatch,
}: {
  item: OutstandingItem;
  /** The record behind a human step, when this row is one. */
  manual: ManualCheck | null;
  repoRoot: string;
  revision: string | null;
  /** What this page is about. */
  scope: ReviewScope;
  /** Where the button below would actually land. */
  working: WorkingTarget;
  busy: boolean;
  /** Why the last attempt at this row's action didn't produce a result. */
  failure: string;
  onRunChecks: () => void;
  onCheckGoal: () => void;
  onOpenMatch?: () => void;
}) {
  return (
    <div className="border-b border-line-soft px-3.5 py-3 last:border-b-0">
      <div className="flex flex-wrap items-start gap-x-2 gap-y-1">
        <span
          aria-hidden
          className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full"
          style={{ background: TONE_COLOR[item.tone] }}
        />
        <span className="min-w-0 flex-1 text-base leading-snug text-text-1">{item.title}</span>
        {item.awaitingHuman ? (
          <span
            className="shrink-0 rounded px-1.5 py-px text-2xs"
            style={{
              color: "var(--color-amber)",
              background: "color-mix(in oklab, var(--color-amber) 12%, transparent)",
            }}
            title="Aura can't do this one — it needs a person, and it stays here until someone says what happened."
          >
            Needs a person
          </span>
        ) : null}
      </div>

      <p className="mt-1 pl-3.5 text-base leading-snug text-text-3">{item.need}</p>

      {failure ? (
        <p className="mt-1 pl-3.5 text-sm leading-snug" style={{ color: "var(--color-red)" }}>
          {failure}
        </p>
      ) : null}

      <div className="mt-1.5 flex flex-wrap items-center gap-2 pl-3.5">
        {item.action.kind === "run_checks" ? (
          <Button type="button" variant="subtle" size="xs" onClick={onRunChecks} disabled={busy}>
            {busy ? "Running…" : "Run them now"}
          </Button>
        ) : null}

        {item.action.kind === "check_goal" ? (
          <Button type="button" variant="subtle" size="xs" onClick={onCheckGoal} disabled={busy}>
            {busy ? "Checking…" : "Check it again"}
          </Button>
        ) : null}

        {item.action.kind === "open_match" && onOpenMatch ? (
          <Button type="button" variant="subtle" size="xs" onClick={onOpenMatch}>
            Compare them
          </Button>
        ) : null}

        {item.action.kind === "record_manual" && manual ? (
          <ManualOutcomeControl repoRoot={repoRoot} check={manual} revision={revision} />
        ) : null}
      </div>

      {/* What the button above would touch. The checks run on the checkout,
          which beside a run from another branch is a different thing from what
          this page is about — and the reader has to be told that before they
          press it, not after they've read the result as this run's. */}
      {targetKind(item) ? (
        <p className="mt-1 pl-3.5 text-sm leading-snug text-text-4">
          {actionTarget(targetKind(item)!, scope, working)}
        </p>
      ) : null}
    </div>
  );
}
