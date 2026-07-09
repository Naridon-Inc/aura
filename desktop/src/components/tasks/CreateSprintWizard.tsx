// CreateSprintWizard — the full-screen flow for planning a sprint,
// modelled on CreateTaskWizard so every creation flow on the board shares
// the same FullscreenOverlay + WizardStepTabs shell. Replaces the old
// `autoCreateSprint` one-click button (which minted a nameless default
// fortnight with no chance to set a goal, window, or scope).
//
// Two steps, per the BEAD-I lifecycle (doc 23 §3b "Plan a sprint"):
//   1. Details — name, duration (1-/2-week presets auto-fill the window
//      from the start date, or Custom for a hand-set due date), goal,
//      and the active toggle.
//   2. Scope — multi-select backlog tasks to pull in, with a live
//      "N items · P pts" tally so the planner sees the load as they pick.
//
// Submit shape is the real `SprintInput` the `sprints_create` command
// takes ({ id, name, start, end, goal, active }) plus the chosen scope
// task ids. Post-BEAD-I `sprints_create` is a thin shim over the unified
// Cycle store, so the slug `id` becomes the cycle id and `Task.cycle_id`
// binds the scoped tasks to the sprint (the caller assigns them).

import { useEffect, useMemo, useState, type KeyboardEvent } from "react";

import { FullscreenOverlay } from "../FullscreenOverlay";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Field } from "../ui/field";
import { Input } from "../ui/input";
import { SegmentedControl } from "../ui/segmented";
import { Textarea } from "../ui/textarea";
import { Switch } from "../ui/switch";
import { WizardStepTabs, useWizard, type WizardStepMeta } from "../ui/wizard";
import type { Sprint, SprintInput, Task } from "../../lib/api";

type Props = {
  onCancel: () => void;
  onSubmit: (input: SprintInput, scopeTaskIds: string[]) => Promise<void>;
  /** Backlog candidates the planner can pull into the sprint — tasks not
   *  already bound to a sprint and not epics. The caller filters; the
   *  wizard just renders + tallies them. */
  backlog?: Task[];
  /** Optional prefilled defaults (name / start / end) so the empty-state
   *  "2-week sprint" CTA can keep its auto-fortnight as a starting point. */
  initial?: Partial<SprintInput>;
};

const STEPS: WizardStepMeta[] = [
  { id: "details", label: "Details" },
  { id: "scope", label: "Scope" },
];

type Preset = "1w" | "2w" | "custom";

const PRESET_OPTS: { value: Preset; label: string }[] = [
  { value: "1w", label: "1 week" },
  { value: "2w", label: "2 weeks" },
  { value: "custom", label: "Custom" },
];

function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function addDays(d: Date, n: number): Date {
  const next = new Date(d.getTime());
  next.setDate(next.getDate() + n);
  return next;
}

/** Inclusive end date `len` days long from `start` (a 7-day sprint ends on
 *  start+6). Returns "" when start isn't a parseable date. */
function endForLength(start: string, len: number): string {
  const t = Date.parse(`${start}T00:00:00`);
  if (Number.isNaN(t)) return "";
  return ymd(addDays(new Date(t), len - 1));
}

// Derive a stable slug from the sprint name (a-z0-9 + dashes). Falls back
// to a date-stamped slug when the name has no usable characters so the
// backend always gets a non-empty key.
function slugify(name: string, fallbackDate: string): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || `sprint-${fallbackDate.replace(/-/g, "")}`;
}

export function CreateSprintWizard({
  onCancel,
  onSubmit,
  backlog,
  initial,
}: Props) {
  const wizard = useWizard(STEPS.length);

  // Default window: today → +13 days (an inclusive two-week fortnight),
  // matching the old autoCreateSprint default so the CTA's behaviour
  // carries over as prefilled values the user can still edit.
  const defaults = useMemo(() => {
    const today = new Date();
    return {
      start: ymd(today),
      end: ymd(addDays(today, 13)),
      name: `Sprint ${ymd(today)}`,
    };
  }, []);

  const [name, setName] = useState(initial?.name ?? defaults.name);
  const [start, setStart] = useState(initial?.start ?? defaults.start);
  // A prefilled end (from the empty-state CTA) starts in Custom so we
  // don't silently overwrite the caller's window; a fresh sprint defaults
  // to the familiar 2-week preset.
  const [preset, setPreset] = useState<Preset>(initial?.end ? "custom" : "2w");
  const [end, setEnd] = useState(initial?.end ?? defaults.end);
  const [goal, setGoal] = useState(initial?.goal ?? "");
  const [active, setActive] = useState<boolean>(initial?.active ?? true);
  const [scopeIds, setScopeIds] = useState<Set<string>>(() => new Set());
  const [submitting, setSubmitting] = useState(false);

  // Keep the window in sync with the preset: 1w/2w derive the end from the
  // start date; Custom leaves `end` under the date picker's control.
  useEffect(() => {
    if (preset === "custom") return;
    const len = preset === "1w" ? 7 : 14;
    const next = endForLength(start, len);
    if (next) setEnd(next);
  }, [preset, start]);

  const candidates = backlog ?? [];
  const nameValid = name.trim().length > 0;
  const datesValid = start.trim().length > 0 && end.trim().length > 0;
  const canSubmit = nameValid && datesValid;

  const scope = useMemo(() => {
    let points = 0;
    for (const t of candidates) {
      if (scopeIds.has(t.id) && typeof t.estimate === "number") {
        points += t.estimate;
      }
    }
    return { count: scopeIds.size, points };
  }, [candidates, scopeIds]);

  function toggleScope(id: string, on: boolean) {
    setScopeIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  async function submit() {
    const n = name.trim();
    if (!n || !datesValid || submitting) return;
    setSubmitting(true);
    try {
      await onSubmit(
        {
          id: slugify(n, start || defaults.start),
          name: n,
          start: start.trim(),
          end: end.trim(),
          goal: goal.trim() || undefined,
          active,
        },
        [...scopeIds],
      );
    } finally {
      setSubmitting(false);
    }
  }

  function onBodyKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  }

  const onScopeStep = wizard.index === 1;

  return (
    <FullscreenOverlay
      onClose={onCancel}
      tabs={
        <WizardStepTabs steps={STEPS} index={wizard.index} onJump={wizard.goTo} />
      }
      contentClassName="overflow-y-auto"
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          {onScopeStep ? (
            <>
              <Button variant="subtle" size="sm" onClick={wizard.back}>
                Back
              </Button>
              <Button
                variant="accentSoft"
                size="sm"
                disabled={!canSubmit || submitting}
                onClick={submit}
              >
                {submitting ? "Creating…" : "Create sprint"}
              </Button>
            </>
          ) : (
            <Button
              variant="accentSoft"
              size="sm"
              disabled={!canSubmit}
              onClick={wizard.next}
            >
              Next · Scope
            </Button>
          )}
        </>
      }
    >
      <div
        className="flex w-full flex-col items-center px-6 py-8 sm:py-10"
        onKeyDown={onBodyKeyDown}
      >
        <div className="flex w-full max-w-[720px] flex-col gap-6">
          {onScopeStep ? (
            <ScopeStep
              candidates={candidates}
              scopeIds={scopeIds}
              onToggle={toggleScope}
              onSelectAll={() =>
                setScopeIds(new Set(candidates.map((t) => t.id)))
              }
              onClear={() => setScopeIds(new Set())}
              count={scope.count}
              points={scope.points}
            />
          ) : (
            <>
              <h1 className="text-[18px] font-medium leading-7 text-text-1">
                New sprint
              </h1>

              <div className="flex flex-col gap-5">
                <Field label="Name" htmlFor="csw-name">
                  <Input
                    id="csw-name"
                    autoFocus
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Sprint 24 · Polish & ship"
                  />
                </Field>

                <Field
                  label="Duration"
                  htmlFor="csw-preset"
                  description="1- or 2-week presets fill the window from the start date; Custom sets your own due date."
                >
                  <SegmentedControl
                    value={preset}
                    onChange={setPreset}
                    options={PRESET_OPTS}
                    aria-label="Sprint duration"
                  />
                </Field>

                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <Field label="Start date" htmlFor="csw-start">
                    <Input
                      id="csw-start"
                      type="date"
                      value={start}
                      onChange={(e) => setStart(e.target.value)}
                    />
                  </Field>
                  <Field
                    label="Due date"
                    htmlFor="csw-end"
                    description={
                      preset === "custom" ? undefined : "Set by the preset"
                    }
                  >
                    <Input
                      id="csw-end"
                      type="date"
                      value={end}
                      disabled={preset !== "custom"}
                      onChange={(e) => setEnd(e.target.value)}
                    />
                  </Field>
                </div>

                <Field
                  label="Goal"
                  htmlFor="csw-goal"
                  optional
                  description="What you want to land this sprint. Shown atop the sprint board."
                >
                  <Textarea
                    id="csw-goal"
                    value={goal}
                    onChange={(e) => setGoal(e.target.value)}
                    rows={4}
                    placeholder="Ship v0.3.0: notes collab GA + the tasks redesign."
                  />
                </Field>

                <div className="flex items-center justify-between gap-3 rounded-lg bg-bg-content p-3 border border-line-soft">
                  <div className="min-w-0">
                    <div className="text-[13px] font-medium text-text-1">
                      Make this the active sprint
                    </div>
                    <div className="mt-0.5 text-[13px] leading-[20.8px] text-text-3">
                      Only one sprint is active at a time — the board opens to it.
                    </div>
                  </div>
                  <Switch
                    checked={active}
                    onCheckedChange={setActive}
                    aria-label="Make this the active sprint"
                  />
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </FullscreenOverlay>
  );
}

function ScopeStep({
  candidates,
  scopeIds,
  onToggle,
  onSelectAll,
  onClear,
  count,
  points,
}: {
  candidates: Task[];
  scopeIds: Set<string>;
  onToggle: (id: string, on: boolean) => void;
  onSelectAll: () => void;
  onClear: () => void;
  count: number;
  points: number;
}) {
  return (
    <>
      <div className="flex items-baseline justify-between gap-3">
        <h1 className="text-[18px] font-medium leading-7 text-text-1">
          Pull in scope
        </h1>
        <span className="text-[12px] text-text-4 tabular-nums">
          {count} item{count === 1 ? "" : "s"}
          {points > 0 ? ` · ${points} pts` : ""}
        </span>
      </div>

      {candidates.length === 0 ? (
        <div className="rounded-lg border border-dashed border-line-soft px-4 py-10 text-center text-[12.5px] text-text-5">
          Backlog is empty — nothing to pull in. You can add tasks to the
          sprint later from the board.
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2 text-[11.5px]">
            <Button
              variant="ghost"
              size="xs"
              onClick={onSelectAll}
              className="text-[11.5px] text-text-4 hover:text-text-1"
            >
              Select all
            </Button>
            <span className="text-text-6">·</span>
            <Button
              variant="ghost"
              size="xs"
              onClick={onClear}
              className="text-[11.5px] text-text-4 hover:text-text-1"
            >
              Clear
            </Button>
            <span className="ml-auto text-text-5">
              {candidates.length} in backlog
            </span>
          </div>
          <ul className="flex max-h-[42vh] flex-col gap-0.5 overflow-y-auto rounded-lg border border-line-soft bg-bg-content p-1.5">
            {candidates.map((t) => {
              const on = scopeIds.has(t.id);
              return (
                <li key={t.id}>
                  <label
                    className={`flex cursor-pointer items-center gap-2.5 rounded px-2 py-1.5 text-[12.5px] ${
                      on ? "bg-accent-soft" : "hover:bg-bg-2"
                    }`}
                  >
                    <Checkbox
                      checked={on}
                      onCheckedChange={(v) => onToggle(t.id, v === true)}
                      aria-label={`Add ${t.title || "task"} to sprint`}
                    />
                    <span
                      className={`min-w-0 flex-1 truncate ${
                        on ? "text-text-1" : "text-text-2"
                      }`}
                    >
                      {t.title || "(untitled)"}
                    </span>
                    {typeof t.estimate === "number" && t.estimate > 0 && (
                      <span className="shrink-0 text-[10.5px] text-text-5 tabular-nums">
                        {t.estimate} pts
                      </span>
                    )}
                  </label>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </>
  );
}

// Re-export the Sprint type for callers that import alongside the wizard.
export type { Sprint };
