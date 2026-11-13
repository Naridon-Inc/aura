// The Run controls at the right end of the terminal panel's header. While the
// project runs: one Stop button. Otherwise a split button — the left half
// starts the run command, the right half lists everything that can run here
// (the run command and the repository's named scripts) with a way to add one
// or to open the scripts settings.

import { ChevronDown, Play, Settings, Plus, Square } from "lucide-react";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { Kbd } from "../ui/kbd";

export type RunTask = { id: string; label: string; command: string };

export type RunControlsState = { kind: "running" } | { kind: "idle"; main: RunTask | null };

/** What the controls show for a run that is live or not, given what can run. */
export function runControlsState(running: boolean, tasks: RunTask[]): RunControlsState {
  if (running) return { kind: "running" };
  return { kind: "idle", main: tasks[0] ?? null };
}

export function RunControls({
  state,
  tasks,
  shortcut,
  onRun,
  onStop,
  onAddAction,
  onConfigure,
}: {
  state: RunControlsState;
  tasks: RunTask[];
  /** The key that starts the main task, shown on its button. */
  shortcut?: string;
  onRun: (task: RunTask) => void;
  onStop: () => void;
  onAddAction: () => void;
  onConfigure: () => void;
}) {
  if (state.kind === "running") {
    return (
      <div className="ui-run-controls">
        <Button size="xs" variant="outline" onClick={onStop}>
          <Square />
          <span className="ui-run-label">Stop</span>
        </Button>
      </div>
    );
  }
  const main = state.main;
  if (!main) {
    return (
      <div className="ui-run-controls">
        <Button size="xs" variant="outline" onClick={onAddAction}>
          Add action
        </Button>
      </div>
    );
  }
  return (
    <div className="ui-run-controls">
      <Button
        size="xs"
        variant="outline"
        className="ui-run-main"
        title={main.command}
        onClick={() => onRun(main)}
      >
        <Play />
        <span className="ui-run-label">{main.label}</span>
        {shortcut && <Kbd>{shortcut}</Kbd>}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" className="ui-run-more" aria-label="Select task">
            <ChevronDown />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {tasks.map((task) => (
            <DropdownMenuItem key={task.id} title={task.command} onSelect={() => onRun(task)}>
              <Play />
              {task.label}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onAddAction}>
            <Plus />
            Add action
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onConfigure}>
            <Settings />
            Configure
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
