// A task's detail, laid out as one reading column beside a narrow column of
// properties. The column's pieces are the shared task-details ones — a
// header holding the subject and "Edit task", a muted status line, small
// section headings, and dependency rows that open the task they name.

import type { ReactNode } from "react";
import { ChevronRight, X } from "lucide-react";

import { Button } from "./button";

import "./tasks-detail.css";

export function TaskDetailLayout({
  main,
  aside,
  asideLabel,
}: {
  main: ReactNode;
  aside?: ReactNode;
  asideLabel: string;
}) {
  return (
    <div className="ui-tasks-detail">
      <div className="ui-tasks-detail-scroll">
        <article className="ui-task-details ui-tasks-detail-main">{main}</article>
      </div>
      {aside && (
        <aside className="ui-tasks-detail-aside" aria-label={asideLabel}>
          {aside}
        </aside>
      )}
    </div>
  );
}

/** The subject line and its trailing action ("Edit task"). */
export function TaskDetailHeader({
  children,
  action,
}: {
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <header>
      {children}
      {action}
    </header>
  );
}

/** The muted "status · owner" line under the subject. Parts are joined
 *  with a middle dot; empty parts drop out. */
export function TaskDetailMeta({ parts }: { parts: ReactNode[] }) {
  const shown = parts.filter((p) => p != null && p !== false && p !== "");
  return (
    <small className="ui-tasks-detail-meta">
      {shown.map((p, i) => (
        <span key={i}>
          {i > 0 && <span aria-hidden> · </span>}
          {p}
        </span>
      ))}
    </small>
  );
}

export function TaskDetailSection({
  title,
  count,
  action,
  children,
}: {
  /** Omitted when the content names itself. */
  title?: string;
  count?: number;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="ui-tasks-detail-section" aria-label={title}>
      {title && (
        <div className="ui-tasks-detail-section-head">
          <h4>
            {title}
            {count != null && count > 0 && <span className="ui-tasks-detail-count">{count}</span>}
          </h4>
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

export interface TaskDependencyItem {
  id: string;
  label: string;
  /** Leading glyph, e.g. the task's status. */
  icon?: ReactNode;
  /** Short trailing text, e.g. AURA-12. */
  hint?: string;
  /** A second, quieter line under the name — why the two are linked. */
  detail?: ReactNode;
}

/** Rows that each open the task they name. With `onRemove`, each row also
 *  carries a button that takes it off the list. */
export function TaskDependencyLinks({
  items,
  onOpen,
  onRemove,
  removeLabel = "Remove",
  disabled,
}: {
  items: TaskDependencyItem[];
  onOpen: (id: string) => void;
  onRemove?: (id: string) => void;
  removeLabel?: string;
  disabled?: boolean;
}) {
  return (
    <div className="ui-tasks-dependency-list">
      {items.map((item) => {
        const link = (
          <button
            type="button"
            className="ui-task-dependency"
            key={item.id}
            onClick={() => onOpen(item.id)}
          >
            {item.detail ? (
              <span className="ui-tasks-dependency-text">
                <span className="ui-tasks-dependency-label">
                  {item.icon}
                  <span>{item.label}</span>
                </span>
                <small className="ui-tasks-dependency-detail">{item.detail}</small>
              </span>
            ) : (
              <span className="ui-tasks-dependency-label">
                {item.icon}
                <span>{item.label}</span>
              </span>
            )}
            <span className="ui-tasks-dependency-end">
              {item.hint && <span className="ui-tasks-dependency-hint">{item.hint}</span>}
              <ChevronRight size={14} />
            </span>
          </button>
        );
        if (!onRemove) return link;
        return (
          <div className="ui-tasks-dependency-row" key={item.id}>
            {link}
            <Button
              variant="ghost"
              size="iconXs"
              aria-label={`${removeLabel}: ${item.label}`}
              title={removeLabel}
              disabled={disabled}
              onClick={() => onRemove(item.id)}
            >
              <X aria-hidden />
            </Button>
          </div>
        );
      })}
    </div>
  );
}

/** A quiet sentence standing in for an empty section. */
export function TaskDetailNote({ children }: { children: ReactNode }) {
  return <p className="ui-tasks-detail-note">{children}</p>;
}
