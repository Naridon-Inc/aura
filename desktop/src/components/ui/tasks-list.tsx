// Task list building blocks: collapsible sections with a status glyph, a
// count and an add action, holding the same 44px rows the workspace list
// uses. Rows are a focusable element rather than a <button> so a status
// menu or a link can sit inside one.

import { type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { ChevronDown, ChevronRight, Plus } from "lucide-react";
import { Button } from "./button";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "./context-menu";
import "./tasks-list.css";

export function TaskListGroup({
  label,
  hint,
  count,
  icon,
  open,
  onToggle,
  onAdd,
  children,
}: {
  label: string;
  hint?: string;
  count: number;
  icon?: ReactNode;
  open: boolean;
  onToggle: () => void;
  onAdd?: () => void;
  children?: ReactNode;
}) {
  return (
    <section className="ui-tasks-group" aria-label={`${label} tasks`}>
      <header className="ui-tasks-group-header" title={hint}>
        <button
          type="button"
          className="ui-tasks-group-toggle"
          aria-expanded={open}
          onClick={onToggle}
        >
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          {icon}
          <h2>{label}</h2>
          <span>{count}</span>
        </button>
        {onAdd && (
          <Button
            size="iconXs"
            variant="ghost"
            aria-label={`New task in ${label}`}
            title="New task"
            onClick={onAdd}
          >
            <Plus />
          </Button>
        )}
      </header>
      {open && <div role="list">{children}</div>}
    </section>
  );
}

export function TaskListItem({
  taskId,
  label,
  selected,
  leading,
  title,
  trailing,
  time,
  menu,
  onOpen,
}: {
  taskId: string;
  /** Accessible name — the untruncated title. */
  label: string;
  selected?: boolean;
  leading?: ReactNode;
  title: ReactNode;
  trailing?: ReactNode;
  time?: { label: string; title?: string };
  /** Context-menu items; the row gets no menu without them. */
  menu?: ReactNode;
  onOpen: (modifiers: { shiftKey: boolean; metaKey?: boolean; ctrlKey?: boolean }) => void;
}) {
  const row = (
    <div
      className="ui-home-row ui-tasks-row"
      role="button"
      tabIndex={0}
      aria-label={label}
      title={label}
      data-active={selected || undefined}
      data-task-id={taskId}
      onClick={(event: MouseEvent) =>
        onOpen({ shiftKey: event.shiftKey, metaKey: event.metaKey, ctrlKey: event.ctrlKey })
      }
      onKeyDown={(event: KeyboardEvent) => {
        if (event.target !== event.currentTarget || event.key !== "Enter") return;
        event.preventDefault();
        onOpen({ shiftKey: event.shiftKey, metaKey: event.metaKey, ctrlKey: event.ctrlKey });
      }}
    >
      {leading}
      <span className="ui-home-title">{title}</span>
      {trailing && <span className="ui-tasks-row-trailing">{trailing}</span>}
      {time && <time title={time.title}>{time.label}</time>}
    </div>
  );
  return (
    <div role="listitem">
      {menu ? (
        <ContextMenu>
          <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
          <ContextMenuContent>{menu}</ContextMenuContent>
        </ContextMenu>
      ) : (
        row
      )}
    </div>
  );
}

/** The short AURA-n handle at the start of a row or card. */
export function TaskHandle({ children }: { children: ReactNode }) {
  return <span className="ui-tasks-handle">{children}</span>;
}

/** What the work area says when there is nothing to draw: one plain heading,
 *  an optional line about why, and the next move. */
export function TaskEmptyState({
  title,
  body,
  children,
}: {
  title: string;
  body?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="ui-tasks-empty" role="status">
      <div className="ui-tasks-empty-copy">
        <p className="ui-tasks-empty-title">{title}</p>
        {body && <p>{body}</p>}
      </div>
      {children}
    </div>
  );
}
