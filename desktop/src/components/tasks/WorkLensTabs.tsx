// The Dashboard's view tabs: List, Board, Graph.
//
// Drawn as the dashboard's tab list — every view spelled out, the selected one
// underlined — so the strip reads the same as every other surface's. Both
// surfaces behind the destination render THIS, not two copies of it: the
// board (List, Board) and the crew (Graph). The strip must not move or change
// shape when you switch between them.

import type { JSX } from "react";

import { TaskViewTabs } from "../ui/tasks-toolbar";
import { WORK_LENSES, type WorkLens } from "../../lib/workRoute";

export function WorkLensTabs({
  lens,
  onLens,
}: {
  lens: WorkLens;
  onLens: (next: WorkLens) => void;
}): JSX.Element {
  return (
    <TaskViewTabs<WorkLens>
      value={lens}
      onChange={onLens}
      label="Dashboard view"
      options={WORK_LENSES.map((opt) => {
        const Icon = opt.icon;
        return {
          value: opt.value,
          label: opt.label,
          icon: <Icon strokeWidth={1.5} aria-hidden />,
          hint: opt.hint,
        };
      })}
    />
  );
}
