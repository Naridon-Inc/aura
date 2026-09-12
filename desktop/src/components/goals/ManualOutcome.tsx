// Recording what happened when a person did the step Aura can't.
//
// Two surfaces ask for it — the goal card's verify plan and the list of what a
// run still owes — and they have to ask for the same thing in the same words,
// or the same handset test reads as two different obligations. So the control
// and the little state word live here, once.
//
// Recording is deliberate and it is always an outcome: "It worked" or "It
// didn't". There is no button that means "I looked at it", because a step
// somebody looked at and said nothing about is still a step nobody has
// answered.

import { useState } from "react";
import {
  recordManualOutcome,
  type ManualCheck,
  type ManualState,
} from "../../lib/manualChecks";
import { relativeAge } from "../../lib/relativeTime";
import { shortRevision } from "../../lib/sessionEvidence";
import { Button } from "../ui/button";

const STATE_WORD: Record<ManualState, string> = {
  awaiting: "Waiting on a person",
  passed: "A person tried it — it worked",
  failed: "A person tried it — it didn't",
};

const STATE_COLOR: Record<ManualState, string> = {
  awaiting: "var(--color-amber)",
  passed: "var(--color-accent-green)",
  failed: "var(--color-red)",
};

export function ManualStateChip({ state }: { state: ManualState }) {
  const color = STATE_COLOR[state];
  return (
    <span
      className="shrink-0 rounded px-1.5 py-px text-2xs"
      style={{
        color,
        background: `color-mix(in oklab, ${color} 12%, transparent)`,
        border: `0.5px solid color-mix(in oklab, ${color} 32%, transparent)`,
      }}
    >
      {STATE_WORD[state]}
    </span>
  );
}

/** What a recorded outcome is about: who said so, when, and which version they
 *  tried. Nothing is inferred — an unknown is simply left out. */
export function ManualOutcomeNote({ check }: { check: ManualCheck }) {
  if (check.state === "awaiting") return null;
  const parts: string[] = [];
  if (check.by) parts.push(check.by);
  if (check.at != null) parts.push(relativeAge(check.at));
  if (check.revision) parts.push(`on ${shortRevision(check.revision)}`);
  if (parts.length === 0 && !check.note) return null;
  return (
    <p className="mt-0.5 text-sm leading-snug text-text-4">
      {check.note ? `${check.note} · ` : ""}
      {parts.join(" · ")}
    </p>
  );
}

export function ManualOutcomeControl({
  repoRoot,
  check,
  /** The version being reviewed, recorded with the outcome so it ages like any
   *  other result. Null when the tester is on uncommitted work. */
  revision,
  /** Wording for the affordance when nothing has been recorded yet. */
  cta = "Record what happened",
}: {
  repoRoot: string;
  check: ManualCheck;
  revision: string | null;
  cta?: string;
}) {
  const [note, setNote] = useState("");
  const [open, setOpen] = useState(false);

  function record(state: "passed" | "failed") {
    recordManualOutcome(repoRoot, check, { state, note, revision });
    setNote("");
    setOpen(false);
  }

  if (!open) {
    return (
      <Button type="button" variant="subtle" size="xs" onClick={() => setOpen(true)}>
        {check.state === "awaiting" ? cta : "Record it again"}
      </Button>
    );
  }

  return (
    <>
      <input
        autoFocus
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="What happened?"
        className="min-w-0 flex-1 rounded border border-line-soft bg-bg-2 px-2 py-1 text-sm text-text-1 outline-none focus:border-line"
      />
      <Button type="button" variant="subtle" size="xs" onClick={() => record("passed")}>
        It worked
      </Button>
      <Button type="button" variant="subtle" size="xs" onClick={() => record("failed")}>
        It didn&apos;t
      </Button>
      <Button
        type="button"
        variant="subtle"
        size="xs"
        className="text-text-4"
        onClick={() => {
          setNote("");
          setOpen(false);
        }}
      >
        Cancel
      </Button>
    </>
  );
}
