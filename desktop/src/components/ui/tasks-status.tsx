// Task status, drawn with the workspace lifecycle glyphs: a badge that names
// a status, and a menu that changes it. Statuses are supplied by the caller
// so a board with its own named states shows those names.

import { type ReactNode } from "react";
import { WorkspaceStageIcon, type WorkspaceStage } from "./workspace-preview-card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./dropdown-menu";
import "./tasks-status.css";

export interface TaskStatusOption {
  id: string;
  label: string;
  stage: WorkspaceStage;
}

export function TaskStatusBadge({
  stage,
  label,
  color,
}: {
  stage: WorkspaceStage;
  label: string;
  /** A named state's own colour, applied to the glyph only. */
  color?: string;
}) {
  return (
    <span className="ui-tasks-status" title={label}>
      <span className="ui-tasks-status-glyph" style={color ? { color } : undefined}>
        <WorkspaceStageIcon stage={stage} />
      </span>
      <span className="ui-tasks-status-label">{label}</span>
    </span>
  );
}

export function TaskStatusMenu({
  value,
  options,
  onChange,
  label,
  children,
}: {
  value: string;
  options: TaskStatusOption[];
  onChange: (id: string) => void;
  /** Accessible name of the trigger, e.g. "Status: In progress". */
  label: string;
  /** The trigger's face — a glyph or a badge. */
  children: ReactNode;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="ui-tasks-status-trigger"
          aria-label={label}
          title="Change status"
          onClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          {children}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {options.map((option) => (
          <DropdownMenuItem
            key={option.id}
            disabled={option.id === value}
            onSelect={() => onChange(option.id)}
          >
            <WorkspaceStageIcon stage={option.stage} />
            {option.label}
            {option.id === value && <span className="ui-menu-shortcut">✓</span>}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Priority as three rising bars, lit up to the level: 0 none … 3 high, and
 *  4 urgent lights all three in red. Drawn bare, at the size of the status
 *  glyph beside it, so a row reads as two glyphs rather than a glyph and a
 *  chip. */
export function TaskPriorityGlyph({ level, label }: { level: 0 | 1 | 2 | 3 | 4; label: string }) {
  return (
    <span
      className="ui-tasks-priority"
      data-urgent={level === 4 || undefined}
      title={`Priority: ${label}`}
      aria-label={`${label} priority`}
      role="img"
    >
      <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden>
        {[1, 2, 3].map((bar) => (
          <rect
            key={bar}
            x={2 + (bar - 1) * 4}
            y={12 - bar * 3}
            width="2.5"
            height={bar * 3}
            rx="0.75"
            data-on={level >= bar || undefined}
          />
        ))}
      </svg>
    </span>
  );
}
