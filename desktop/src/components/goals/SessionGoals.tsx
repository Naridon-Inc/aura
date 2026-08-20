// SessionGoals — the goals a run is aligned with, on the session Summary.
//
// A goal here is "did *this run* reach this requirement?" Setting one proves
// it against the repo immediately and records the verdict under this run's key,
// so the same goal then shows the run in its associations everywhere (the
// task it's linked to, the Goals workbench). Goals already aligned with this
// run (proven from it before) list with their current verdict and a re-verify.
//
// The run key is the most durable identifier the row carries: its signed block,
// else its Claude session id, else agent:timestamp — so re-proving the same run
// updates the same verdict instead of piling duplicates.

import { useEffect, useRef, useState } from "react";
import { Button } from "../ui/button";
import type { IntentRow } from "../../lib/api";
import { GOALS_V2 } from "../../lib/featureFlags";
import { splitIntent } from "../workpanes/IntentProse";
import { runProve } from "../../lib/prove";
import {
  recordRun,
  upsertGoalByText,
  useGoalsForRun,
  verdictFromProve,
  type GoalRun,
} from "../../lib/goalStore";
import { GoalProbe } from "./GoalProbe";
import { GoalComposer } from "./GoalComposer";

/** The durable key for a run, used to attribute goal verdicts to it. */
export function runKeyForIntent(row: IntentRow): string {
  return row.signed_block_id || row.claude_session_id || `${row.agent_id}:${row.timestamp}`;
}

/** The commit this session's code lives on — the first file in its changeset
 *  that carries a commit sha (back-filled from git history at load). Proving is
 *  anchored here so a session's goals check against the code THAT session
 *  produced, even when it's on a branch that isn't checked out. `undefined` when
 *  the row has no bound changeset (nothing committed to anchor to) → the prove
 *  falls back to the working tree, its previous behaviour. */
export function sessionCommit(row: IntentRow): string | undefined {
  return row.changeset?.files.find((f) => f.commit)?.commit ?? undefined;
}

export function SessionGoals({
  repoRoot,
  row,
  hasChanges = false,
  atCommit: atCommitProp,
}: {
  repoRoot: string;
  row: IntentRow;
  /** Did this run actually change code (its changeset has ≥1 file)? When true,
   *  the run's own ask is minted as a micro-goal and proved automatically on
   *  open — no manual "check" click. A run that changed nothing (a question, a
   *  read-only session) is never auto-proved; it keeps the manual affordance. */
  hasChanges?: boolean;
  /** The session's own commit to anchor proofs to (the caller derives it from
   *  the merged changeset, which also covers native-chat rows that borrow a
   *  fetched changeset). Falls back to this row's own changeset when omitted. */
  atCommit?: string;
}) {
  const runKey = runKeyForIntent(row);
  const runLabel = splitIntent(row.intent).headline || row.intent;
  const goals = useGoalsForRun(repoRoot, runKey);
  const [busy, setBusy] = useState(false);
  // Anchor every prove on this surface to the session's own commit, so a session
  // whose code is on another branch reads its true verdict instead of a false 0%
  // measured against the checked-out tree.
  const atCommit = atCommitProp ?? sessionCommit(row);

  // Adding a goal to a run *is* proving it against the run: create-or-find the
  // record, run the check, and stamp the verdict under this run's key. The
  // result associates the goal with the run even when the check finds gaps —
  // the GoalProbe then re-verifies on demand.
  async function addForRun(text: string) {
    if (busy) return;
    setBusy(true);
    try {
      const goal = upsertGoalByText(repoRoot, text);
      let run: GoalRun;
      try {
        const result = await runProve(repoRoot, text, atCommit);
        const { verdict, ok, total } = verdictFromProve(result);
        run = { runKey, label: runLabel, agentId: row.agent_id, verdict, ok, total, at: Date.now(), commit: atCommit ?? null };
      } catch {
        // Keep the association even if proving errored; an "unknown" run keeps
        // the goal visible on this run and re-verifiable.
        run = { runKey, label: runLabel, agentId: row.agent_id, verdict: "unknown", ok: 0, total: 0, at: Date.now(), commit: atCommit ?? null };
      }
      recordRun(repoRoot, goal.id, run);
    } finally {
      setBusy(false);
    }
  }

  // The run's own prompt, and whether it's already being tracked as a goal here
  // — shared by the auto-prove effect and the render below.
  const hasAsk = runLabel.trim().length > 0;
  const askTracked = goals.some(
    (g) => g.text.trim().toLowerCase() === runLabel.trim().toLowerCase(),
  );

  // Auto-prove the run's own ask the first time we open a session that actually
  // changed code — so a finished build arrives already checked (verdict shown),
  // instead of waiting behind a manual "check" button. Idempotent: proving
  // records the run, which marks the ask tracked (persisted to localStorage),
  // so re-opening never re-proves; `autoAttempted` guards the in-flight window
  // before the store updates. A run that changed nothing (a question, a
  // read-only session) is never auto-proved — it keeps the manual affordance.
  const autoAttempted = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!GOALS_V2 || !hasChanges) return;
    if (!hasAsk || askTracked || busy) return;
    if (autoAttempted.current.has(runKey)) return;
    autoAttempted.current.add(runKey);
    void addForRun(runLabel);
    // addForRun is stable for this run (closes over runKey/runLabel/repoRoot,
    // all in deps); the ref guard makes re-runs no-ops regardless.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasChanges, hasAsk, askTracked, busy, runKey, runLabel]);

  const probes =
    goals.length > 0 ? (
      <div className="mb-2.5 flex flex-col gap-2">
        {goals.map((g) => (
          <GoalProbe
            key={g.id}
            repoRoot={repoRoot}
            goal={g}
            runKey={runKey}
            runLabel={runLabel}
            agentId={row.agent_id}
            currentRunKey={runKey}
            atCommit={atCommit}
            autoExplain
          />
        ))}
      </div>
    ) : null;

  // GOALS_V2: read-first. Lead with *what you asked here* (the run's own
  // prompt) and a one-click "was this built?" — instead of asking the user to
  // invent a goal for an already-finished session. The manual composer stays,
  // demoted to "track another goal".
  if (GOALS_V2) {
    return (
      <section>
        <h2 className="section-label mb-2.5">
          What you asked here
        </h2>

        {hasAsk && !askTracked ? (
          <div className="mb-2.5 rounded-md border border-line-soft bg-bg-1/40 px-3 py-2.5">
            <div className="text-base leading-snug text-text-1">{runLabel}</div>
            <div className="mt-2 flex items-center gap-2">
              {hasChanges ? (
                // This run changed code → Aura proves the ask on its own; the
                // verdict replaces this line as soon as the check finishes. No
                // button to remember to click.
                <span className="text-xs text-text-3">
                  Checking whether the AI built this…
                </span>
              ) : (
                <>
                  <Button
                    type="button"
                    variant="subtle"
                    size="sm"
                    onClick={() => void addForRun(runLabel)}
                    disabled={busy}
                  >
                    {busy ? "Checking…" : "Check whether the AI built this"}
                  </Button>
                  <span className="text-xs text-text-4">
                    proves it against the code, right now
                  </span>
                </>
              )}
            </div>
          </div>
        ) : !hasAsk && goals.length === 0 ? (
          <p className="mb-2.5 text-base leading-relaxed text-text-4">
            This run didn&apos;t record what it was asked to do. Add what it was meant to
            achieve and Aura checks whether the AI actually built it.
          </p>
        ) : null}

        {probes}

        <GoalComposer
          prefill={askTracked ? "" : runLabel}
          placeholder="What else should this run achieve?"
          cta="Track another goal"
          busy={busy}
          onSubmit={(t) => void addForRun(t)}
        />
      </section>
    );
  }

  return (
    <section>
      <div className="mb-2.5 flex items-baseline justify-between gap-3">
        <h2 className="section-label">Goals</h2>
        {goals.length > 0 ? (
          <span className="text-xs text-text-4">
            {goals.length} aligned with this run
          </span>
        ) : null}
      </div>

      {probes ?? (
        <p className="mb-2.5 text-base leading-relaxed text-text-4">
          No goals on this run yet. Describe what it was meant to do and Aura checks,
          right now, whether the AI actually built it.
        </p>
      )}

      <GoalComposer
        prefill={runLabel}
        placeholder="What should this run achieve?"
        cta="Set a goal for this run"
        busy={busy}
        onSubmit={(t) => void addForRun(t)}
      />
    </section>
  );
}
