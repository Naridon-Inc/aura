// What the Dashboard draws in place of the work when there is none to draw:
// a board with no tasks at all, a board whose filters hide every task, and a
// board that could not be read. Three different situations, so three
// different sentences — telling someone with thirty tasks and one stray
// filter that the board is empty makes them think they lost their work.

import { Plus, RefreshCw } from "lucide-react";

import { AsciiSpinner } from "../ui/ascii-spinner";
import { Button } from "../ui/button";
import { TaskEmptyState } from "../ui/tasks-list";
import type { CreateTaskInput } from "../../lib/api";

/** A quick start that pre-fills the create form, so a well-formed first task
 *  is two clicks away. Biased toward software work on purpose. */
export type TaskTemplate = {
  id: string;
  label: string;
  hint: string;
  preset: Partial<CreateTaskInput>;
};

export const TASK_TEMPLATES: TaskTemplate[] = [
  {
    id: "feature",
    label: "Feature",
    hint: "New user-facing capability",
    preset: { priority: "medium", labels: ["feature"] },
  },
  {
    id: "bug",
    label: "Bug",
    hint: "Something is broken",
    preset: { priority: "high", labels: ["bug"] },
  },
  {
    id: "spike",
    label: "Spike",
    hint: "Time-boxed investigation",
    preset: { priority: "medium", labels: ["spike"], estimate: 4 },
  },
  {
    id: "rfc",
    label: "RFC / Design",
    hint: "Write up before coding",
    preset: { priority: "medium", labels: ["rfc", "design"] },
  },
  {
    id: "tech-debt",
    label: "Tech debt",
    hint: "Cleanup / refactor",
    preset: { priority: "low", labels: ["tech-debt"] },
  },
  {
    id: "incident",
    label: "Incident",
    hint: "Post-incident follow-up",
    preset: { priority: "high", labels: ["incident", "postmortem"] },
  },
  {
    id: "agent-claude",
    label: "Send to Claude",
    hint: "Hand off to Claude Code",
    preset: { priority: "medium", agent_assignee: "claude", labels: ["agent"] },
  },
  {
    id: "epic",
    label: "New Epic",
    hint: "Groups related tasks together",
    preset: { priority: "medium", is_epic: true, labels: ["epic"] },
  },
];

/** No tasks anywhere in scope: the one primary move, and the templates as a
 *  quiet second route for anyone who wants a head start. */
export function TasksEmptyHero({
  onBlank,
  onPickTemplate,
}: {
  onBlank: () => void;
  onPickTemplate: (tpl: TaskTemplate) => void;
}) {
  return (
    <TaskEmptyState
      title="No tasks yet"
      body="This is the shared board. Everything you and your agents are working on lives here, in one place."
    >
      <Button size="sm" onClick={onBlank}>
        <Plus />
        New task
      </Button>
      <div className="ui-tasks-empty-more">
        <span>Or start from</span>
        {TASK_TEMPLATES.map((t) => (
          <Button
            key={t.id}
            size="xs"
            variant="link"
            title={t.hint}
            onClick={() => onPickTemplate(t)}
          >
            {t.label}
          </Button>
        ))}
      </div>
    </TaskEmptyState>
  );
}

/** There is work here; what is set is hiding all of it. */
export function TasksFilteredEmpty({ onClear }: { onClear: () => void }) {
  return (
    <TaskEmptyState
      title="Nothing matches those filters"
      body="There are tasks here. The filters you've set are hiding all of them."
    >
      <Button size="sm" variant="outline" onClick={onClear}>
        Clear filters
      </Button>
    </TaskEmptyState>
  );
}

/** Nothing on screen and a project that did not answer. Drawing "add your
 *  first task" here would tell someone their work is gone when it is only
 *  out of reach. */
export function TasksUnreadable({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <TaskEmptyState title="Couldn’t read the board" body={message}>
      <Button size="sm" variant="outline" onClick={onRetry}>
        <RefreshCw />
        Try again
      </Button>
    </TaskEmptyState>
  );
}

/** A cold open: nothing cached yet, the first read still running. */
export function TasksLoading() {
  return (
    <div className="ui-tasks-loading" role="status">
      <AsciiSpinner />
      Loading tasks…
    </div>
  );
}
