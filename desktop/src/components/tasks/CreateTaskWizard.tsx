// CreateTaskWizard — the from-scratch replacement for the old single-scroll
// CreateTaskModal, styled after Medusa's product-create FocusModal flow. A
// floating focus surface (FullscreenOverlay) split into three steps — Details
// / Assign / Plan — driven by the Medusa-style ProgressTabs (WizardStepTabs)
// and built entirely on the form primitives (Field, Input, Textarea, Select,
// Switch).
//
// Priority and Status are Selects (colour-dot options) rather than an inline
// segmented row — that's how Medusa surfaces product status, and it sidesteps
// the pill-overflow the segmented version hit. Quick-create still holds:
// ⌘/Ctrl-Enter submits from anywhere once Title is set. The submit payload is
// identical to the old modal's — no backend change.
//
// Edit mode (mode === "edit"): the same shell pre-fills the draft from an
// existing `Task` and, on submit, sends an `UpdateTaskInput` through
// `onSubmitEdit` (api.tasksUpdate) instead of creating. It also appends a
// fourth "Activity" step that hosts the rich relational/discussion surfaces
// the create flow has no use for — Description (live), Dependencies,
// Sub-issues, Relations, Activity, and Comments — folded in from the detail
// panel so opening a task in the wizard never drops functionality.

import { useMemo, useState, type KeyboardEvent } from "react";
import { ArrowRight } from "lucide-react";

import { cn } from "../../lib/utils";
import { FullscreenOverlay } from "../FullscreenOverlay";
import { AssigneePicker } from "../AssigneePicker";
import { Button } from "../ui/button";
import { Field } from "../ui/field";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Select, type SelectOption } from "../ui/select";
import { Switch } from "../ui/switch";
import { WizardStepTabs, useWizard, type WizardStepMeta } from "../ui/wizard";
import {
  ActivityCard,
  CommentsCard,
  DependenciesCard,
  RelationsCard,
} from "./TaskDetailSidePanel";
import { SubTasksPanel } from "./SubTasksPanel";
import type {
  CreateTaskInput,
  Sprint,
  Task,
  TaskPriority,
  TaskStatus,
  TeamMember,
  UpdateTaskInput,
} from "../../lib/api";

type Props = {
  members: TeamMember[];
  /** Existing tasks — source for the parent-epic picker (is_epic === true). */
  tasks: Task[];
  /** Sprints — source for the Sprint picker. */
  sprints: Sprint[];
  onCancel: () => void;
  onSubmit: (input: CreateTaskInput) => Promise<void>;
  defaultAssignee?: string;
  /** Optional preset from a template click (priority, labels, agent, is_epic…). */
  initial?: Partial<CreateTaskInput>;
  /** "create" (default) mints a new task; "edit" pre-fills from `editing`
   *  and submits an UpdateTaskInput via `onSubmitEdit`. */
  mode?: "create" | "edit";
  /** The task being edited. Required when `mode === "edit"`. */
  editing?: Task;
  /** Edit-mode submit — wired to api.tasksUpdate by the parent. */
  onSubmitEdit?: (input: UpdateTaskInput) => Promise<void>;
  /** Edit-mode Activity-step context. The relational/discussion cards
   *  read these directly; create mode never renders that step so they
   *  stay optional. */
  repoRoot?: string;
  currentHandle?: string | null;
  /** Push a partial update straight through (used by the Activity step's
   *  cards — e.g. bead mint). Same signature as the detail panel's onPatch. */
  onPatch?: (input: UpdateTaskInput) => Promise<void>;
  /** Create a child task under the edited task (Sub-issues card). */
  onCreateChild?: (parentId: string, title: string) => Promise<void>;
};

const CREATE_STEPS: WizardStepMeta[] = [
  { id: "details", label: "Details" },
  { id: "assign", label: "Assign", optional: true },
  { id: "plan", label: "Plan", optional: true },
];

// The dedicated "Sub-tasks" step. Inserted into the edit flow BEFORE
// "activity" only when the task already has children OR the wizard can
// add them (so a view-only context with no children never surfaces an
// empty tab). See `buildEditSteps`.
const SUBTASKS_STEP: WizardStepMeta = {
  id: "subtasks",
  label: "Sub-tasks",
  optional: true,
};
const ACTIVITY_STEP: WizardStepMeta = {
  id: "activity",
  label: "Activity",
  optional: true,
};

/** Compose the edit-mode step list. The subtasks step is conditional:
 *  it appears (before Activity) when `showSubtasks` is true. Create
 *  mode never includes it. */
function buildEditSteps(showSubtasks: boolean): WizardStepMeta[] {
  return [
    ...CREATE_STEPS,
    ...(showSubtasks ? [SUBTASKS_STEP] : []),
    ACTIVITY_STEP,
  ];
}

// Per-step heading text, keyed by step id so it stays correct no matter
// which conditional steps are present.
const STEP_HEADINGS: Record<string, string> = {
  details: "Details",
  assign: "Assign",
  plan: "Plan",
  subtasks: "Sub-tasks",
  activity: "Activity",
};
const CREATE_HEADINGS = ["New task", "Assign", "Plan"];

function Dot({ className }: { className?: string }) {
  return (
    <span
      className={cn("h-2 w-2 shrink-0 rounded-full", className)}
      aria-hidden
    />
  );
}

// Every dot in these three menus sits directly beside its own label, so hue
// was repeating a word the reader can already see. They now step down the
// neutral ramp — which keeps the ordering legible in the priority list — and
// only the two entries that genuinely ask for the reader keep a colour:
// Urgent (red) and In progress (accent, the one live state).
const PRIORITY_OPTS: SelectOption[] = [
  { value: "urgent", label: "Urgent", icon: <Dot className="bg-red" /> },
  { value: "high", label: "High", icon: <Dot className="bg-text-2" /> },
  { value: "medium", label: "Medium", icon: <Dot className="bg-text-3" /> },
  { value: "low", label: "Low", icon: <Dot className="bg-text-4" /> },
  { value: "none", label: "None", icon: <Dot className="bg-text-5" /> },
];

const STATUS_OPTS: SelectOption[] = [
  { value: "backlog", label: "Backlog", icon: <Dot className="bg-text-5" /> },
  { value: "in_progress", label: "In progress", icon: <Dot className="bg-accent" /> },
  { value: "in_review", label: "In review", icon: <Dot className="bg-text-3" /> },
  { value: "done", label: "Done", icon: <Dot className="bg-text-2" /> },
];

const AGENT_OPTS: SelectOption[] = [
  { value: "", label: "— none —" },
  { value: "claude", label: "Claude", icon: <Dot className="bg-text-3" /> },
  { value: "gemini", label: "Gemini", icon: <Dot className="bg-text-3" /> },
  { value: "codex", label: "Codex", icon: <Dot className="bg-text-3" /> },
  { value: "opencode", label: "Opencode", icon: <Dot className="bg-text-3" /> },
];

export function CreateTaskWizard({
  members,
  tasks,
  sprints,
  onCancel,
  onSubmit,
  defaultAssignee,
  initial,
  mode = "create",
  editing,
  onSubmitEdit,
  repoRoot,
  currentHandle = null,
  onPatch,
  onCreateChild,
}: Props) {
  const isEdit = mode === "edit" && editing != null;

  // Surface the Sub-tasks step when the edited task already has children
  // (so a view context can still see them) OR when the wizard can add
  // them (an editable context with `repoRoot` + `onCreateChild` wired).
  // Create mode never shows it.
  const hasChildren = useMemo(
    () =>
      editing != null &&
      tasks.some(
        (t) => t.parent_id === editing.id || t.epic_id === editing.id,
      ),
    [tasks, editing],
  );
  const canEditSubtasks =
    isEdit && repoRoot != null && typeof onCreateChild === "function";
  const showSubtasks = isEdit && (hasChildren || canEditSubtasks);

  const steps = useMemo(
    () => (isEdit ? buildEditSteps(showSubtasks) : CREATE_STEPS),
    [isEdit, showSubtasks],
  );
  const wizard = useWizard(steps.length);
  const currentStepId = steps[wizard.index]?.id ?? "details";

  // Edit mode seeds every draft field from the live task; create mode
  // seeds from the optional template preset.
  const [title, setTitle] = useState(editing?.title ?? "");
  const [description, setDescription] = useState(editing?.description ?? "");
  const [priority, setPriority] = useState<TaskPriority>(
    editing?.priority ?? initial?.priority ?? "medium",
  );
  const [status, setStatus] = useState<TaskStatus>(
    editing?.status ?? initial?.status ?? "backlog",
  );
  const [assigneeIds, setAssigneeIds] = useState<string[]>(
    editing
      ? editing.assignee_ids ?? []
      : initial?.assignee_ids && initial.assignee_ids.length > 0
        ? initial.assignee_ids
        : defaultAssignee
          ? [defaultAssignee]
          : [],
  );
  const [agentAssignee, setAgentAssignee] = useState(
    editing?.agent_assignee ?? initial?.agent_assignee ?? "",
  );
  const [labels, setLabels] = useState(
    (editing?.labels ?? initial?.labels ?? []).join(", "),
  );
  const [startDate, setStartDate] = useState(
    editing?.start_date ?? initial?.start_date ?? "",
  );
  const [dueDate, setDueDate] = useState(
    editing?.due_date ?? initial?.due_date ?? "",
  );
  const [estimate, setEstimate] = useState(
    editing?.estimate != null
      ? String(editing.estimate)
      : initial?.estimate != null
        ? String(initial.estimate)
        : "",
  );
  // Sprint membership now rides the unified Cycle pointer (`cycle_id`);
  // "Sprint" is just the user-facing label. The option `value`s below are
  // cycle ids (the `sprints` prop is the legacy-shaped view over cycles).
  const [cycleId, setCycleId] = useState(
    editing?.cycle_id ?? initial?.cycle_id ?? "",
  );
  const [epicId, setEpicId] = useState(
    editing?.epic_id ?? editing?.parent_id ?? initial?.epic_id ?? "",
  );
  const [isEpic, setIsEpic] = useState<boolean>(
    editing?.is_epic ?? initial?.is_epic ?? false,
  );
  const [objective, setObjective] = useState(
    editing?.objective ?? initial?.objective ?? "",
  );
  const [submitting, setSubmitting] = useState(false);

  const titleValid = title.trim().length > 0;
  // Exclude the task being edited from its own parent-epic picker.
  const epics = useMemo(
    () => tasks.filter((t) => t.is_epic && t.id !== editing?.id),
    [tasks, editing?.id],
  );

  const sprintOpts = useMemo<SelectOption[]>(
    () => [
      { value: "", label: "No sprint" },
      ...sprints.map((s) => ({
        value: s.id,
        label: s.active ? `${s.name} · active` : s.name,
      })),
    ],
    [sprints],
  );
  const epicOpts = useMemo<SelectOption[]>(
    () => [
      { value: "", label: "— none —" },
      ...epics.map((e) => ({ value: e.id, label: e.title })),
    ],
    [epics],
  );

  async function submit() {
    const t = title.trim();
    if (!t || submitting) return;
    setSubmitting(true);
    try {
      const parsedLabels = labels
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (isEdit && editing && onSubmitEdit) {
        // Edit mode → UpdateTaskInput. Send `""` for cleared optional
        // string fields so the backend (which treats "" as null) clears
        // them, matching the detail panel's onPatch semantics — this is
        // why the user can blank out an agent / sprint / date here.
        await onSubmitEdit({
          id: editing.id,
          title: t,
          description: description.trim(),
          status,
          priority,
          assignee_ids: assigneeIds,
          agent_assignee: agentAssignee.trim(),
          labels: parsedLabels,
          due_date: dueDate.trim(),
          start_date: startDate.trim(),
          estimate: estimate.trim() ? Number(estimate) : undefined,
          epic_id: isEpic ? "" : epicId.trim(),
          objective: objective.trim(),
          cycle_id: cycleId.trim(),
          is_epic: isEpic,
        });
      } else {
        await onSubmit({
          title: t,
          description: description.trim(),
          status,
          priority,
          assignee_ids: assigneeIds,
          agent_assignee: agentAssignee.trim() || undefined,
          reporter: defaultAssignee || undefined,
          labels: parsedLabels,
          due_date: dueDate.trim() || undefined,
          start_date: startDate.trim() || undefined,
          estimate: estimate.trim() ? Number(estimate) : undefined,
          epic_id: epicId.trim() || undefined,
          objective: objective.trim() || undefined,
          cycle_id: cycleId.trim() || undefined,
          is_epic: isEpic,
        });
      }
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

  // Edit mode can submit at any time once Title is valid (the user may
  // only want to tweak one field); create mode keeps the Continue-then-
  // Create staging so required fields are seen before mint.
  const showSave = isEdit && titleValid;

  return (
    <FullscreenOverlay
      onClose={onCancel}
      tabs={
        <WizardStepTabs
          steps={steps}
          index={wizard.index}
          onJump={wizard.goTo}
          canJump={(i) => i === 0 || titleValid}
          isComplete={(i) => i < wizard.index}
        />
      }
      contentClassName="overflow-y-auto"
      actions={
        showSave ? (
          <Button
            variant="accentSoft"
            size="sm"
            disabled={submitting}
            onClick={submit}
          >
            {submitting ? "Saving…" : "Save"}
          </Button>
        ) : undefined
      }
      footer={
        <>
          {wizard.isFirst ? (
            <Button variant="secondary" size="sm" onClick={onCancel}>
              Cancel
            </Button>
          ) : (
            <Button variant="secondary" size="sm" onClick={wizard.back}>
              Back
            </Button>
          )}
          {wizard.isLast ? (
            <Button
              variant="accentSoft"
              size="sm"
              disabled={!titleValid || submitting}
              onClick={submit}
            >
              {submitting
                ? isEdit
                  ? "Saving…"
                  : "Creating…"
                : isEdit
                  ? "Save changes"
                  : "Create task"}
            </Button>
          ) : (
            <Button
              variant="accentSoft"
              size="sm"
              disabled={wizard.index === 0 && !titleValid}
              onClick={wizard.next}
            >
              Continue
              <ArrowRight className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
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
          <h1 className="text-[18px] font-medium leading-7 text-text-1">
            {isEdit
              ? STEP_HEADINGS[currentStepId] ?? currentStepId
              : CREATE_HEADINGS[wizard.index]}
          </h1>

          {currentStepId === "details" && (
            <div className="flex flex-col gap-5">
              <Field label="Title" htmlFor="ctw-title">
                <Input
                  id="ctw-title"
                  autoFocus
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="What needs to be done?"
                />
              </Field>
              <Field
                label="Description"
                htmlFor="ctw-desc"
                optional
                description="Markdown supported. Add detail, acceptance criteria, links."
              >
                <Textarea
                  id="ctw-desc"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={5}
                  placeholder="Add context, acceptance criteria, links…"
                />
              </Field>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="Priority" htmlFor="ctw-priority">
                  <Select
                    id="ctw-priority"
                    value={priority}
                    onChange={(v) => setPriority(v as TaskPriority)}
                    options={PRIORITY_OPTS}
                    aria-label="Priority"
                  />
                </Field>
                <Field label="Status" htmlFor="ctw-status">
                  <Select
                    id="ctw-status"
                    value={status}
                    onChange={(v) => setStatus(v as TaskStatus)}
                    options={STATUS_OPTS}
                    aria-label="Status"
                  />
                </Field>
              </div>
            </div>
          )}

          {currentStepId === "assign" && (
            <div className="flex flex-col gap-5">
              <Field
                label="Assignees"
                optional
                description="Who owns this. Leave empty for unassigned."
              >
                <AssigneePicker
                  values={assigneeIds}
                  onChangeMulti={setAssigneeIds}
                  members={members}
                  placeholder="Unassigned"
                />
              </Field>
              <Field
                label="Agent"
                htmlFor="ctw-agent"
                optional
                hint="Hand the task to an AI agent that can pick it up autonomously."
              >
                <Select
                  id="ctw-agent"
                  value={agentAssignee}
                  onChange={setAgentAssignee}
                  options={AGENT_OPTS}
                  aria-label="Agent assignee"
                />
              </Field>
              <Field
                label="Labels"
                htmlFor="ctw-labels"
                optional
                description="Comma-separated, e.g. bug, frontend, p0."
              >
                <Input
                  id="ctw-labels"
                  value={labels}
                  onChange={(e) => setLabels(e.target.value)}
                  placeholder="bug, frontend, p0"
                />
              </Field>
            </div>
          )}

          {currentStepId === "plan" && (
            <div className="flex flex-col gap-5">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="Start date" htmlFor="ctw-start" optional>
                  <Input
                    id="ctw-start"
                    type="date"
                    value={startDate}
                    onChange={(e) => setStartDate(e.target.value)}
                  />
                </Field>
                <Field label="Due date" htmlFor="ctw-due" optional>
                  <Input
                    id="ctw-due"
                    type="date"
                    value={dueDate}
                    onChange={(e) => setDueDate(e.target.value)}
                  />
                </Field>
              </div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field
                  label="Estimate"
                  htmlFor="ctw-estimate"
                  optional
                  hint="Hours or story points — whatever your team tracks."
                >
                  <Input
                    id="ctw-estimate"
                    type="number"
                    value={estimate}
                    onChange={(e) => setEstimate(e.target.value)}
                    placeholder="5"
                    suffix="pts"
                  />
                </Field>
                <Field label="Sprint" htmlFor="ctw-sprint" optional>
                  <Select
                    id="ctw-sprint"
                    value={cycleId}
                    onChange={setCycleId}
                    options={sprintOpts}
                    placeholder="No sprint"
                    aria-label="Sprint"
                  />
                </Field>
              </div>
              <Field
                label="Parent epic"
                htmlFor="ctw-epic"
                optional
                description={
                  isEpic ? "Disabled — this task is itself an epic." : undefined
                }
              >
                <Select
                  id="ctw-epic"
                  value={epicId}
                  onChange={setEpicId}
                  options={epicOpts}
                  disabled={isEpic}
                  placeholder="— none —"
                  aria-label="Parent epic"
                />
              </Field>

              <div className="flex items-center justify-between gap-3 rounded-lg bg-bg-content p-3 border border-line-soft">
                <div className="min-w-0">
                  <div className="text-[13px] font-medium text-text-1">
                    This is an epic
                  </div>
                  <div className="mt-0.5 text-[13px] leading-[20.8px] text-text-3">
                    Epics group child tasks and can't have a parent.
                  </div>
                </div>
                <Switch
                  checked={isEpic}
                  onCheckedChange={(v) => {
                    setIsEpic(v);
                    if (v) setEpicId("");
                  }}
                  aria-label="This is an epic"
                />
              </div>

              <Field
                label="Objective / OKR"
                htmlFor="ctw-objective"
                optional
                hint="Link this task to a quarterly objective or key result."
              >
                <Input
                  id="ctw-objective"
                  value={objective}
                  onChange={(e) => setObjective(e.target.value)}
                  placeholder="Q3-O1 KR2: ship v0.3.0"
                />
              </Field>
            </div>
          )}

          {isEdit &&
            editing &&
            repoRoot != null &&
            currentStepId === "subtasks" && (
              <div className="flex flex-col gap-5">
                {/* The rich Jira-style Sub-tasks surface, on its own step
                    so it gets the full wizard width. Creates persist live
                    via `onCreateChild` (independent of the Save button). */}
                <SubTasksPanel
                  task={editing}
                  allTasks={tasks}
                  repoRoot={repoRoot}
                  onCreateChild={onCreateChild}
                  embedded
                />
              </div>
            )}

          {isEdit &&
            editing &&
            repoRoot != null &&
            currentStepId === "activity" && (
              <div className="flex flex-col gap-5">
                {/* Relational + discussion surfaces folded in from the
                    detail panel. They patch the task live via `onPatch`
                    (independent of the Save button), so dependencies,
                    comments etc. persist on their own. Sub-tasks now live
                    on their own dedicated step. */}
                <DependenciesCard task={editing} allTasks={tasks} />
                <RelationsCard
                  task={editing}
                  allTasks={tasks}
                  repoRoot={repoRoot}
                />
                {onPatch && (
                  <ActivityCard
                    task={editing}
                    repoRoot={repoRoot}
                    onPatch={onPatch}
                  />
                )}
                <CommentsCard
                  task={editing}
                  repoRoot={repoRoot}
                  currentHandle={currentHandle}
                  members={members}
                />
              </div>
            )}
        </div>
      </div>
    </FullscreenOverlay>
  );
}
