// Pick a task's state from the project's state catalog. The face is the
// shared status chip; the menu lists every state, in board order, each
// with the glyph of the bucket it belongs to.

import { ChevronDown } from "lucide-react";

import type { TaskState, TaskStatus } from "../../lib/api";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { WorkspaceStageIcon } from "../ui/workspace-preview-card";
import { TASK_STATUS_LABEL } from "./taskColumns";
import { stageForGroup, TaskStateChip } from "./taskGlyphs";

export function TaskStatePicker({
  states,
  value,
  status,
  onChange,
}: {
  states: TaskState[];
  value: string | null;
  /** The task's status, which names it when its state isn't in the catalog. */
  status: TaskStatus;
  onChange: (stateId: string) => void;
}) {
  const current = states.find((s) => s.id === value) ?? null;
  const ordered = [...states].sort((a, b) => a.position - b.position);
  const name = current?.name ?? TASK_STATUS_LABEL[status];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="xs" aria-label={`State: ${name}. Change it`}>
          <TaskStateChip state={current} status={status} />
          <ChevronDown aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuRadioGroup value={value ?? ""} onValueChange={onChange}>
          {ordered.map((s) => (
            <DropdownMenuRadioItem key={s.id} value={s.id}>
              <WorkspaceStageIcon stage={stageForGroup(s.group)} />
              {s.name}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
