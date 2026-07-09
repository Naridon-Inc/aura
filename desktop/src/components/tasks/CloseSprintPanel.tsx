// CloseSprintPanel — the deliberate "Complete sprint" flow (doc 23 §3d).
// A single-step FullscreenOverlay summary card: what shipped vs what's
// carried, the velocity figure that gets frozen on the cycle, and a
// destination for the unfinished items (→ a planned sprint, or → backlog
// which is the default). Mirrors CreateSprintWizard's overlay shell so the
// two sprint flows feel like one surface; no title, per the wizard rule —
// the heading inside carries the context.
//
// The panel is pure presentation + choice: it computes nothing itself.
// SprintView hands it the already-derived done/total/velocity figures and
// the carry-candidate sprints, and `onConfirm(target)` performs the moves
// (assign → next / unassign → backlog) and the `tasksCycleClose` write.

import { useMemo, useState } from "react";

import { FullscreenOverlay } from "../FullscreenOverlay";
import { Button } from "../ui/button";
import { Field } from "../ui/field";
import { Select } from "../ui/select";
import type { Sprint } from "../../lib/api";

/** Sentinel destination = send unfinished items back to the backlog
 *  (clear their cycle pointer). Any other value is a target sprint id. */
export const CARRY_TO_BACKLOG = "__backlog__";

type Props = {
  sprint: Sprint;
  /** Delivered work — count of done items and Σ done points. */
  doneCount: number;
  donePoints: number;
  /** Total scope — count of all items and Σ all points. */
  totalCount: number;
  totalPoints: number;
  /** When false the sprint had no estimates, so we talk in item counts
   *  and the velocity is a done-count rather than a point sum. */
  usePoints: boolean;
  /** Unfinished items that need a home when the sprint closes. */
  carriedCount: number;
  /** Planned sprints the unfinished items can roll into (excludes this
   *  sprint and any completed ones). Empty ⇒ backlog is the only option. */
  carryTargets: Sprint[];
  onCancel: () => void;
  /** `target` is a sprint id, or `CARRY_TO_BACKLOG` for the backlog. */
  onConfirm: (target: string) => Promise<void>;
};

export function CloseSprintPanel({
  sprint,
  doneCount,
  donePoints,
  totalCount,
  totalPoints,
  usePoints,
  carriedCount,
  carryTargets,
  onCancel,
  onConfirm,
}: Props) {
  const [target, setTarget] = useState<string>(CARRY_TO_BACKLOG);
  const [submitting, setSubmitting] = useState(false);

  const velocity = usePoints ? donePoints : doneCount;
  const unit = usePoints ? "pts" : totalCount === 1 ? "task" : "tasks";

  const carryOpts = useMemo(
    () => [
      { value: CARRY_TO_BACKLOG, label: "Backlog (default)" },
      ...carryTargets.map((s) => ({ value: s.id, label: s.name })),
    ],
    [carryTargets],
  );

  async function confirm() {
    if (submitting) return;
    setSubmitting(true);
    try {
      await onConfirm(target);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <FullscreenOverlay
      onClose={onCancel}
      contentClassName="overflow-y-auto"
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant="accentSoft"
            size="sm"
            disabled={submitting}
            onClick={confirm}
          >
            {submitting ? "Completing…" : "Complete sprint"}
          </Button>
        </>
      }
    >
      <div className="flex w-full flex-col items-center px-6 py-8 sm:py-10">
        <div className="flex w-full max-w-[560px] flex-col gap-6">
          <div className="flex flex-col gap-1.5">
            <h1 className="text-[18px] font-medium leading-7 text-text-1">
              Complete {sprint.name}
            </h1>
            <p className="text-[13px] leading-5 text-text-3">
              {sprint.start} → {sprint.end}. Closing records this sprint's
              velocity and moves anything unfinished out of the way.
            </p>
          </div>

          {/* Outcome tiles — delivered, carried, velocity. */}
          <div className="grid grid-cols-3 gap-3">
            <StatTile
              label="Delivered"
              value={`${doneCount}/${totalCount}`}
              sub={
                usePoints ? `${donePoints}/${totalPoints} pts` : "items done"
              }
              tone="emerald"
            />
            <StatTile
              label="Carried over"
              value={String(carriedCount)}
              sub={carriedCount === 1 ? "unfinished" : "unfinished"}
              tone={carriedCount > 0 ? "amber" : "muted"}
            />
            <StatTile
              label="Velocity"
              value={String(velocity)}
              sub={`${unit} shipped`}
              tone="accent"
            />
          </div>

          {/* Carryover destination. Only matters when something's left. */}
          {carriedCount > 0 ? (
            <Field
              label={`Move ${carriedCount} unfinished item${
                carriedCount === 1 ? "" : "s"
              } to`}
              htmlFor="csp-carry"
              description="They keep their status — only their sprint changes. Backlog is the safe default."
            >
              <Select
                id="csp-carry"
                value={target}
                onChange={setTarget}
                options={carryOpts}
                aria-label="Carryover destination"
              />
            </Field>
          ) : (
            <div className="rounded-lg border border-dashed border-line-soft px-4 py-6 text-center text-[12.5px] text-text-5">
              Everything in this sprint is done — nothing to carry over. Clean
              finish.
            </div>
          )}
        </div>
      </div>
    </FullscreenOverlay>
  );
}

function StatTile({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub: string;
  tone: "emerald" | "amber" | "accent" | "muted";
}) {
  const valueTone =
    tone === "emerald"
      ? "text-emerald-400"
      : tone === "amber"
        ? "text-amber-400"
        : tone === "accent"
          ? "text-accent"
          : "text-text-3";
  return (
    <div className="rounded-lg bg-bg-content p-3 border border-line-soft">
      <div className="text-[10.5px] uppercase tracking-wider text-text-5">
        {label}
      </div>
      <div className={`mt-1 text-[20px] font-medium tabular-nums ${valueTone}`}>
        {value}
      </div>
      <div className="mt-0.5 text-[11px] text-text-5">{sub}</div>
    </div>
  );
}
