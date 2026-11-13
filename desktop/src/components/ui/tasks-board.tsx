// Kanban building blocks for the task board: the same scroll, column, card
// and drop-target structure the workspace dashboard draws, shaped for tasks.
// Columns are generic (a status, a priority, an owner); the caller decides
// what a drop or a quick add means for each one.
//
// Cards move between columns with a pointer drag (see ./use-pointer-drag):
// the desktop app's web view never delivers an HTML5 `drop`, so a native
// drag picked a card up and never put it down. The board gives its columns
// and cards one drag scope; each column that takes a drop registers what a
// drop means there, and a card released over it runs that.

import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { ArrowUpRight, Plus } from "lucide-react";
import { Button } from "./button";
import { Input } from "./input";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "./context-menu";
import { dropTarget, startPointerDrag, usePointerDragState } from "./use-pointer-drag";
import "./tasks-board.css";

export type TaskOpenModifiers = { shiftKey: boolean; metaKey?: boolean; ctrlKey?: boolean };

/** The drag a board's cards and columns share: its scope, and what dropping
 *  a card on each column that takes one does. */
interface BoardDrag {
  scope: string;
  drops: Map<string, (taskId: string) => void>;
}

const BoardDragContext = createContext<BoardDrag | null>(null);

export function TaskBoard({ label, children }: { label: string; children: ReactNode }) {
  const scope = useId();
  const [drag] = useState<BoardDrag>(() => ({ scope, drops: new Map() }));
  return (
    <BoardDragContext.Provider value={drag}>
      <section className="ui-dashboard ui-tasks-board" aria-label={label}>
        <div className="ui-dashboard-scroll">
          <div className="ui-dashboard-board">{children}</div>
        </div>
      </section>
    </BoardDragContext.Provider>
  );
}

export function TaskBoardColumn({
  label,
  hint,
  count,
  icon,
  actions,
  onDrop,
  footer,
  empty,
  children,
}: {
  label: string;
  hint?: string;
  /** Null while the column has not been read yet: no number beats a wrong 0. */
  count: number | null;
  icon?: ReactNode;
  /** Small header buttons for the column, before its count. */
  actions?: ReactNode;
  /** Omit for a column a card cannot be moved into. */
  onDrop?: (taskId: string) => void;
  footer?: ReactNode;
  /** Shown in place of cards when the column holds none. */
  empty?: ReactNode;
  children?: ReactNode;
}) {
  const board = useContext(BoardDragContext);
  const key = useId();
  const latest = useRef(onDrop);
  latest.current = onDrop;
  const takes = !!board && !!onDrop;
  useEffect(() => {
    if (!board || !takes) return;
    board.drops.set(key, (taskId) => latest.current?.(taskId));
    return () => {
      board.drops.delete(key);
    };
  }, [board, key, takes]);
  const over = usePointerDragState<string>(board?.scope ?? "").over === key && takes;
  return (
    <section
      className="ui-dashboard-column"
      aria-label={`${label} tasks`}
      data-drag-over={over}
      {...(board && takes ? dropTarget(board.scope, key) : {})}
    >
      <header title={hint}>
        {icon}
        <h2>{label}</h2>
        {actions && <span className="ui-tasks-column-actions">{actions}</span>}
        {count != null && <span>{count}</span>}
      </header>
      <div className="ui-dashboard-column-content">
        {count === 0 && empty ? <p className="ui-tasks-column-empty">{empty}</p> : children}
        {footer}
      </div>
      {over && (
        <div className="ui-dashboard-drop">
          <span>Move to {label}</span>
        </div>
      )}
    </section>
  );
}

export function TaskBoardCard({
  label,
  taskId,
  selected,
  focused,
  draggable,
  menu,
  onOpen,
  onMove,
  children,
}: {
  label: string;
  taskId: string;
  selected?: boolean;
  focused?: boolean;
  /** Whether the card can be carried to another column of its board. */
  draggable?: boolean;
  /** Context-menu items; the card gets no menu without them. */
  menu?: ReactNode;
  onOpen: (modifiers: TaskOpenModifiers) => void;
  /** Alt+Left / Alt+Right moves the card one column. */
  onMove?: (direction: -1 | 1) => void;
  children: ReactNode;
}) {
  const board = useContext(BoardDragContext);
  const abandon = useRef<(() => void) | undefined>(undefined);
  useEffect(() => () => abandon.current?.(), []);
  const card = (
    <div
      className="ui-dashboard-card ui-tasks-card"
      role="button"
      tabIndex={0}
      aria-label={label}
      aria-pressed={selected || undefined}
      data-task-id={taskId}
      data-selected={selected || undefined}
      data-focused={focused || undefined}
      onPointerDown={
        draggable && board
          ? (event) => {
              abandon.current = startPointerDrag(event, {
                scope: board.scope,
                item: taskId,
                onDrop: (key) => board.drops.get(key)?.(taskId),
              });
            }
          : undefined
      }
      onClick={(event: MouseEvent) =>
        onOpen({ shiftKey: event.shiftKey, metaKey: event.metaKey, ctrlKey: event.ctrlKey })
      }
      onKeyDown={(event: KeyboardEvent) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter") {
          event.preventDefault();
          onOpen({ shiftKey: event.shiftKey, metaKey: event.metaKey, ctrlKey: event.ctrlKey });
        }
        if (onMove && event.altKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
          event.preventDefault();
          onMove(event.key === "ArrowRight" ? 1 : -1);
        }
      }}
    >
      {children}
    </div>
  );
  if (!menu) return card;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{card}</ContextMenuTrigger>
      <ContextMenuContent>{menu}</ContextMenuContent>
    </ContextMenu>
  );
}

export function TaskCardContent({
  handle,
  meta,
  stage,
  title,
  summary,
  footer,
  pr,
  time,
}: {
  handle?: ReactNode;
  /** Extra meta after the handle, before the status glyph. */
  meta?: ReactNode;
  stage?: ReactNode;
  title: ReactNode;
  summary?: string;
  footer?: ReactNode;
  pr?: { number: number; url: string; onOpen: () => void };
  time?: { label: string; title?: string };
}) {
  return (
    <div className="ui-workspace-card-content">
      <div className="ui-workspace-card-meta">
        <span>{handle}</span>
        {meta}
        {stage}
      </div>
      <strong className="ui-workspace-card-title">{title}</strong>
      {summary && <p className="ui-workspace-card-summary">{summary}</p>}
      <footer>
        {footer}
        {pr && (
          <button
            type="button"
            className="ui-workspace-card-pr"
            title={pr.url}
            onClick={(event) => {
              event.stopPropagation();
              pr.onOpen();
            }}
          >
            #{pr.number}
            <ArrowUpRight size={10} />
          </button>
        )}
        {time && <time title={time.title}>{time.label}</time>}
      </footer>
    </div>
  );
}

/** One small fact on a card footer or a list row: an icon and a short value. */
export function TaskFact({
  icon,
  tone,
  title,
  children,
}: {
  icon?: ReactNode;
  tone?: "alert";
  title?: string;
  children: ReactNode;
}) {
  return (
    <span className="ui-tasks-fact" data-tone={tone} title={title}>
      {icon}
      {children}
    </span>
  );
}

export function TaskQuickAdd({
  label = "New task",
  placeholder = "Title. Enter to add",
  onCreate,
}: {
  label?: string;
  placeholder?: string;
  onCreate: (title: string) => Promise<void> | void;
}) {
  const [open, setOpen] = useState(false),
    [title, setTitle] = useState(""),
    [busy, setBusy] = useState(false);
  async function commit() {
    const value = title.trim();
    if (!value) return;
    setBusy(true);
    try {
      await onCreate(value);
      setTitle("");
    } finally {
      setBusy(false);
    }
  }
  if (!open)
    return (
      <Button size="xs" variant="ghost" className="ui-tasks-quick-add" onClick={() => setOpen(true)}>
        <Plus />
        {label}
      </Button>
    );
  return (
    <Input
      autoFocus
      size="small"
      value={title}
      disabled={busy}
      placeholder={placeholder}
      aria-label={label}
      onChange={(event) => setTitle(event.target.value)}
      onBlur={() => {
        if (!title.trim()) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          void commit();
        } else if (event.key === "Escape") {
          event.preventDefault();
          setTitle("");
          setOpen(false);
        }
      }}
    />
  );
}
