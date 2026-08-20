// Crew · Add to queue — the single door onto the queue. One header button opens
// this full-screen wizard; the first thing you pick is HOW you want to hand
// work over:
//
//   • Plan a goal — describe an outcome in plain language and your crew's brain
//     breaks it into 3–8 connected tasks, drawing what runs in parallel and
//     what has to wait. (`loop_plan_goal` → real nodes + edges on the graph.)
//   • Add a task — drop one concrete job straight into the queue, with how
//     urgent it is and what it waits on.
//     (`tasksCreate` → `loopSyncBoard`, exactly as a board task would land.)
//
// You only ever hand the crew WORK here — never an agent. When you Run the crew
// it puts one of its agents on each ready task on its own, so there's no
// "who works it" step to fill in; that's the whole point of a crew.
//
// Both paths are the SAME primitives the rest of the surface uses — no bespoke
// backend, no mock plan. The wizard just gives the two doors one calm, stepped
// home (FullscreenOverlay + the Medusa-style ProgressTabs) instead of two
// cramped popovers fighting for the top-right corner.

import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { ArrowRight, Check, GitMerge, Sparkles, Users } from "lucide-react";

import { api } from "../../../lib/api";
import type {
  LoopAttachTarget,
  LoopTask,
  PlanGoalResult,
  TaskPriority,
} from "../../../lib/api";
import { FullscreenOverlay } from "../../FullscreenOverlay";
import { AsciiSpinner } from "../../ui/ascii-spinner";
import { Button } from "../../ui/button";
import { Field } from "../../ui/field";
import { Input } from "../../ui/input";
import { Textarea } from "../../ui/textarea";
import { Select, type SelectOption } from "../../ui/select";
import { SegmentedControl } from "../../ui/segmented";
import { WizardStepTabs, useWizard, type WizardStepMeta } from "../../ui/wizard";

type Mode = "goal" | "task";

function Dot({ className }: { className?: string }) {
  return <span className={`h-2 w-2 shrink-0 rounded-full ${className ?? ""}`} aria-hidden />;
}

// Same ramp as the task wizard's priority menu so the two read as one system:
// the label names the level, the ramp orders it, only Urgent takes a colour.
const PRIORITY_OPTS: SelectOption[] = [
  { value: "urgent", label: "Urgent", icon: <Dot className="bg-red" /> },
  { value: "high", label: "High", icon: <Dot className="bg-text-2" /> },
  { value: "medium", label: "Medium", icon: <Dot className="bg-text-3" /> },
  { value: "low", label: "Low", icon: <Dot className="bg-text-4" /> },
];

// Steps are named for what you DO in them, not for the mode. The mode is
// already on screen — the segmented control sets it and its own label says
// "Plan a goal" / "Add a task" — so a first step called "Goal" or "Task" was
// that same word again, forty pixels up.
const GOAL_STEPS: WizardStepMeta[] = [
  { id: "goal", label: "Describe" },
  { id: "review", label: "Review" },
];
const TASK_STEPS: WizardStepMeta[] = [
  { id: "task", label: "Describe" },
  { id: "details", label: "Details" },
];

export function CrewComposeWizard({
  repoRoot,
  queue,
  crew,
  onClose,
  onAdded,
  onPlanned,
  inline = false,
}: {
  repoRoot: string;
  /** Current queue — source for the "waits on" picker (board-task ids). */
  queue: LoopTask[];
  /** The crew this surface is narrowed to, if any — stamped onto a task added
   *  here so it lands under that crew rather than the loose pile. `null` (or
   *  "main") means no crew is selected and the task is filed crew-less. */
  crew?: string | null;
  onClose: () => void;
  /** A single task was minted + synced into the queue. */
  onAdded: () => void | Promise<void>;
  /** A goal was decomposed into a connected build. */
  onPlanned: (result: PlanGoalResult) => void | Promise<void>;
  /** Render the wizard docked in-flow (a right-side board sheet) instead of a
   *  window-owning fullscreen popover — the queue stays visible behind it.
   *  Flips FullscreenOverlay to `embedded` and tightens the body for the
   *  narrower panel. Default false keeps every other caller fullscreen. */
  inline?: boolean;
}) {
  const [mode, setMode] = useState<Mode>("goal");
  const steps = mode === "goal" ? GOAL_STEPS : TASK_STEPS;
  const wizard = useWizard(2);
  const stepId = steps[wizard.index]?.id ?? steps[0].id;

  // Plan-a-goal draft.
  const [goal, setGoal] = useState("");
  // Single-task draft.
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<TaskPriority>("medium");
  const [waitsOn, setWaitsOn] = useState<Set<string>>(new Set());
  // Attach-to-existing-flow: "" = start its own island; otherwise the goal name
  // the new task joins (it runs after that goal's tail and shares its label).
  const [attachGoal, setAttachGoal] = useState("");
  const [attachTargets, setAttachTargets] = useState<LoopAttachTarget[]>([]);

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Existing goals a new task could hang off — loaded once so the Details step
  // can offer "attach to a flow" instead of always starting a disconnected one.
  useEffect(() => {
    let live = true;
    api
      .loopAttachTargets(repoRoot)
      .then((t) => {
        if (live) setAttachTargets(t);
      })
      .catch(() => {
        /* no goals yet, or read blip — the picker just won't show. */
      });
    return () => {
      live = false;
    };
  }, [repoRoot]);

  // Only board-backed tasks can be named as a dependency (deps are board ids,
  // which loopSyncBoard wires back into graph edges).
  const dependable = useMemo(() => queue.filter((t) => !!t.board_task_id), [queue]);

  // "Attach to a flow" options — only goals whose tail is board-wireable show,
  // so picking one genuinely orders the new task after it. Leads with "new flow".
  const attachOpts = useMemo<SelectOption[]>(
    () => [
      { value: "", label: "Start a new flow" },
      ...attachTargets
        .filter((t) => t.tails.some((x) => !!x.board_id))
        .map((t) => ({
          value: t.goal,
          label: `${t.goal} · ${t.size} step${t.size === 1 ? "" : "s"}`,
        })),
    ],
    [attachTargets],
  );

  // Step 1 is reachable once the primary input for the chosen mode is filled.
  const primaryValid = mode === "goal" ? goal.trim().length > 0 : title.trim().length > 0;

  const switchMode = (m: Mode) => {
    if (m === mode) return;
    setMode(m);
    setErr(null);
    wizard.goTo(0);
  };

  const planGoal = async () => {
    const g = goal.trim();
    if (!g || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const result = await api.loopPlanGoal(repoRoot, g);
      await onPlanned(result);
    } catch (e) {
      setErr(String(e).replace(/^Error:\s*/, ""));
      setBusy(false);
    }
  };

  const addTask = async () => {
    const t = title.trim();
    if (!t || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await api.tasksCreate(repoRoot, {
        title: t,
        description: description.trim() || undefined,
        priority,
        // No manual "who works it" — the crew puts one of its agents on this
        // task when you Run it. Letting Aura route is the whole point of a crew.
        dependencies: waitsOn.size > 0 ? [...waitsOn] : undefined,
        // Attaching to a flow tags the card `goal:<name>` — the projection
        // carries labels through as tags, so the new node lands inside that
        // goal's group on the canvas (and its tail deps wire the order).
        labels: attachGoal ? [`goal:${attachGoal}`] : undefined,
        // Stamp the crew this surface is narrowed to, so a task added here
        // lands under that crew instead of the loose pile. "main" / null is
        // the default crew and is left unset.
        crew_id: crew && crew !== "main" ? crew : undefined,
      });
      // Project it onto the graph so it shows as a ready node immediately.
      await api.loopSyncBoard(repoRoot);
      await onAdded();
    } catch (e) {
      setErr(`Couldn't add that task: ${String(e)}`);
      setBusy(false);
    }
  };

  // Pick a flow to attach to: remember the goal (for the label) and pre-check
  // its tail steps in "Waits on" so the new task runs after them. Choosing
  // "Start a new flow" clears the goal but leaves any manual picks alone.
  const chooseAttach = (goalName: string) => {
    setAttachGoal(goalName);
    if (!goalName) return;
    const target = attachTargets.find((t) => t.goal === goalName);
    if (!target) return;
    const tailBoardIds = target.tails
      .map((x) => x.board_id)
      .filter((b): b is string => !!b);
    if (tailBoardIds.length === 0) return;
    setWaitsOn((prev) => {
      const next = new Set(prev);
      for (const b of tailBoardIds) next.add(b);
      return next;
    });
  };

  // ⌘/Ctrl-Enter advances or commits, depending on where you are.
  const onBodyKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Enter" || !(e.metaKey || e.ctrlKey)) return;
    e.preventDefault();
    if (wizard.isFirst) {
      if (primaryValid) wizard.next();
    } else if (mode === "goal") {
      void planGoal();
    } else {
      void addTask();
    }
  };

  const toggleWait = (boardId: string) =>
    setWaitsOn((prev) => {
      const next = new Set(prev);
      if (next.has(boardId)) next.delete(boardId);
      else next.add(boardId);
      return next;
    });

  return (
    <FullscreenOverlay
      onClose={busy ? () => {} : onClose}
      embedded={inline}
      tabs={
        <WizardStepTabs
          steps={steps}
          index={wizard.index}
          onJump={wizard.goTo}
          canJump={(i) => i === 0 || primaryValid}
          isComplete={(i) => i < wizard.index}
        />
      }
      contentClassName="overflow-y-auto"
      footer={
        <>
          {wizard.isFirst ? (
            <Button variant="secondary" size="sm" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
          ) : (
            <Button variant="secondary" size="sm" onClick={wizard.back} disabled={busy}>
              Back
            </Button>
          )}
          {wizard.isFirst ? (
            <Button
              variant="accentSoft"
              size="sm"
              onClick={wizard.next}
              disabled={!primaryValid}
            >
              Continue
              <ArrowRight className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
            </Button>
          ) : mode === "goal" ? (
            <Button
              variant="accentSoft"
              size="sm"
              onClick={() => void planGoal()}
              disabled={busy || !goal.trim()}
              className="gap-1.5"
            >
              {busy ? <AsciiSpinner className="text-base" /> : <Sparkles size={14} />}
              {busy ? "Planning…" : "Plan it"}
            </Button>
          ) : (
            <Button
              variant="accentSoft"
              size="sm"
              onClick={() => void addTask()}
              disabled={busy || !title.trim()}
              className="gap-1.5"
            >
              {busy ? <AsciiSpinner className="text-base" /> : null}
              {busy ? "Adding…" : "Add to queue"}
            </Button>
          )}
        </>
      }
    >
      <div
        className={
          inline
            ? "flex w-full flex-col px-5 py-6"
            : "flex w-full flex-col items-center px-6 py-12 sm:py-16"
        }
        onKeyDown={onBodyKeyDown}
      >
        <div
          className={
            inline
              ? "flex w-full flex-col gap-6"
              : "flex w-full max-w-[640px] flex-col gap-6"
          }
        >
          {/* Mode is chosen on step 1 only — once you're past it you've
              committed to a path, so the toggle would just be noise. */}
          {wizard.isFirst ? (
            <div className="flex flex-col gap-3">
              <SegmentedControl<Mode>
                value={mode}
                onChange={switchMode}
                ariaLabel="What kind of work"
                options={[
                  { value: "goal", label: "Plan a goal" },
                  { value: "task", label: "Add a task" },
                ]}
              />
              <p className="text-sm leading-relaxed text-text-4">
                {mode === "goal"
                  ? "Describe an outcome. Your crew breaks it into connected tasks and draws the order. What runs side by side, and what has to wait."
                  : "Drop one concrete job straight into the queue."}
              </p>
            </div>
          ) : null}

          {stepId === "goal" && (
            /* No help text under this one: the line above the field already
               says an outcome in plain language is what goes here. */
            <Field label="What do you want built?" htmlFor="crew-goal">
              <Textarea
                id="crew-goal"
                autoFocus
                rows={4}
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
                placeholder="e.g. Let people sign in with Google and stay signed in"
              />
            </Field>
          )}

          {stepId === "review" && (
            <div className="flex flex-col gap-4">
              <div className="min-w-0">
                <div className="text-xs font-medium text-text-4">Goal</div>
                <p className="mt-1 whitespace-pre-wrap text-md font-medium leading-snug text-text-1">
                  {goal.trim()}
                </p>
              </div>
              {/* What's NEW at this point — the step before already explained
                  that the crew works out the order, so this doesn't. */}
              <p className="text-base leading-relaxed text-text-3">
                Aura reads this and writes the tasks it takes, usually three to
                eight, in the order they have to happen. They land on the board
                behind this, ready to <strong className="text-text-2">Run</strong>.
              </p>
              <p className="text-sm leading-relaxed text-text-5">
                This uses the brain you picked in Settings ▸ Brain &amp; models.
                If you haven’t picked one, nothing is written. It’ll tell you.
              </p>
            </div>
          )}

          {stepId === "task" && (
            <div className="flex flex-col gap-6">
              <Field label="What should the crew do?" htmlFor="crew-title">
                <Input
                  id="crew-title"
                  autoFocus
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="e.g. Add a dark-mode toggle to Settings"
                />
              </Field>
              <Field
                label="Detail"
                htmlFor="crew-desc"
                optional
                description="Acceptance criteria, links, anything the agent should know."
              >
                <Textarea
                  id="crew-desc"
                  rows={4}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Add context, acceptance criteria, links…"
                />
              </Field>
            </div>
          )}

          {stepId === "details" && (
            <div className="flex flex-col gap-6">
              <Field label="Priority" htmlFor="crew-priority">
                <Select
                  id="crew-priority"
                  value={priority}
                  onChange={(v) => setPriority(v as TaskPriority)}
                  options={PRIORITY_OPTS}
                  aria-label="Priority"
                />
              </Field>

              {/* No "who works it" picker — the crew puts one of its own agents
                  on this task when you Run it. Say so plainly so it doesn't read
                  like a missing setting. */}
              <p className="flex items-center gap-2 text-sm leading-relaxed text-text-4">
                <Users size={14} className="shrink-0 text-accent" />
                Your crew runs an agent on this automatically when you hit Run. 
                you don't pick who.
              </p>

              {attachOpts.length > 1 ? (
                <Field
                  label="Attach to a flow"
                  htmlFor="crew-attach"
                  optional
                  hint="Hang this off a goal already on the board so it joins that flow, or start its own."
                >
                  <Select
                    id="crew-attach"
                    value={attachGoal}
                    onChange={chooseAttach}
                    options={attachOpts}
                    aria-label="Attach to a flow"
                  />
                  {attachGoal ? (
                    <p className="mt-1.5 flex items-center gap-1.5 text-sm text-text-4">
                      <GitMerge size={12} className="text-accent" />
                      Runs after “{attachGoal}”. Its last steps are checked below.
                    </p>
                  ) : null}
                </Field>
              ) : null}

              {dependable.length > 0 ? (
                <Field
                  label="Waits on"
                  optional
                  description="It won't start until everything you pick here is done."
                >
                  <div className="max-h-44 space-y-0.5 overflow-y-auto rounded-lg border border-line-soft bg-bg-1/40 p-1">
                    {dependable.map((t) => {
                      const id = t.board_task_id!;
                      const checked = waitsOn.has(id);
                      return (
                        <button
                          key={t.id}
                          type="button"
                          onClick={() => toggleWait(id)}
                          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-base text-text-2 transition-colors hover:bg-state-hover"
                        >
                          <span
                            className="grid h-4 w-4 shrink-0 place-items-center rounded border"
                            style={{
                              borderColor: checked
                                ? "var(--color-accent)"
                                : "var(--color-text-4)",
                              background: checked ? "var(--color-accent)" : "transparent",
                            }}
                          >
                            {checked ? (
                              <Check size={11} className="text-white" strokeWidth={3} />
                            ) : null}
                          </span>
                          <span className="truncate" title={t.title}>
                            {t.title}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </Field>
              ) : null}
            </div>
          )}

          {err ? (
            <p className="rounded-md border border-line-soft bg-bg-1/60 px-3 py-2 text-sm leading-relaxed text-red">
              {err}
            </p>
          ) : null}
        </div>
      </div>
    </FullscreenOverlay>
  );
}
