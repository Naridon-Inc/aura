import {
  useId,
  useRef,
  useState,
  type HTMLAttributes,
  type PointerEvent,
  type ReactNode,
} from "react";
import { ChevronDown, ChevronRight, Folder } from "lucide-react";
import { cn } from "../../lib/utils";
import { WorkspaceStatusIcon, type WorkspaceStatus } from "./workspace-status";
import { RevealMark, TitleReveal } from "./title-reveal";
export interface SidebarProps extends HTMLAttributes<HTMLElement> {
  side?: "left" | "right";
  width?: number;
  defaultWidth?: number;
  minWidth?: number;
  maxWidth?: number;
  resizable?: boolean;
  onWidthChange?: (width: number) => void;
}
export function Sidebar({
  className,
  side = "left",
  width,
  defaultWidth = 256,
  minWidth = 192,
  maxWidth = 480,
  resizable = false,
  onWidthChange,
  style,
  children,
  ...props
}: SidebarProps) {
  const [localWidth, setLocalWidth] = useState(defaultWidth);
  const drag = useRef<{ x: number; width: number } | null>(null);
  const id = useId();
  const actual = Math.min(maxWidth, Math.max(minWidth, width ?? localWidth));
  const update = (next: number) => {
    const bounded = Math.min(maxWidth, Math.max(minWidth, Math.round(next)));
    setLocalWidth(bounded);
    onWidthChange?.(bounded);
  };
  return (
    <aside
      id={id}
      className={cn("ui-sidebar", className)}
      data-side={side}
      style={{ width: actual, ...style }}
      {...props}
    >
      {children}
      {resizable && (
        <div
          className="ui-sidebar-resize"
          role="separator"
          tabIndex={0}
          aria-label={`Resize ${side} sidebar`}
          aria-orientation="vertical"
          aria-controls={props.id ?? id}
          aria-valuemin={minWidth}
          aria-valuemax={maxWidth}
          aria-valuenow={actual}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            event.currentTarget.focus();
            drag.current = { x: event.clientX, width: actual };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            if (drag.current)
              update(
                drag.current.width + (event.clientX - drag.current.x) * (side === "left" ? 1 : -1),
              );
          }}
          onPointerUp={(event) => {
            drag.current = null;
            if (event.currentTarget.hasPointerCapture(event.pointerId))
              event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onLostPointerCapture={() => {
            drag.current = null;
          }}
          onDoubleClick={() => update(defaultWidth)}
          onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            if (event.key === "Home") update(minWidth);
            else if (event.key === "End") update(maxWidth);
            else
              update(
                actual +
                  (event.key === "ArrowRight" ? 1 : -1) *
                    (side === "left" ? 1 : -1) *
                    (event.shiftKey ? 40 : 8),
              );
          }}
        />
      )}
    </aside>
  );
}
export function SidebarHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("ui-sidebar-header", className)} {...props} />;
}
export function SidebarContent({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("ui-sidebar-content", className)} {...props} />;
}
export function SidebarFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("ui-sidebar-footer", className)} {...props} />;
}
export function SidebarGroup({
  title,
  collapsed,
  onToggle,
  action,
  icon,
  count,
  kind = "section",
  children,
}: {
  title: string;
  collapsed?: boolean;
  onToggle?: () => void;
  action?: ReactNode;
  icon?: ReactNode;
  count?: number;
  kind?: "section" | "repository";
  children: ReactNode;
}) {
  const [internal, setInternal] = useState(false);
  const closed = collapsed ?? internal;
  return (
    <section className="ui-sidebar-group" data-kind={kind}>
      <div className="ui-sidebar-group-header">
        <button
          type="button"
          onClick={() => {
            setInternal(!closed);
            onToggle?.();
          }}
          aria-expanded={!closed}
        >
          {kind === "repository" && (
            <span className="ui-repository-icon">
              {icon ?? <Folder size={16} />}
              <span>{closed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}</span>
            </span>
          )}
          <span>{title}</span>
          {closed && count != null && <small>{count}</small>}
          {kind === "section" && (
            <ChevronDown size={12} className="ui-section-chevron" data-collapsed={closed} />
          )}
        </button>
        {action}
      </div>
      {!closed && children}
    </section>
  );
}
export interface SidebarItemProps {
  label: string;
  icon?: ReactNode;
  selected?: boolean;
  unread?: boolean;
  status?: WorkspaceStatus;
  trailing?: ReactNode;
  actions?: ReactNode;
  onClick?: () => void;
  /** A press on the item itself: where a drag to move the item starts. */
  onPointerDown?: (event: PointerEvent<HTMLButtonElement>) => void;
  indent?: boolean;
  /** What this row IS (a workspace's path or id). Given one, a new `label`
   *  for the same row arrives through the pixel reveal; without one the label
   *  just changes, since a reused slot is not a rename. */
  revealKey?: string;
  /** A word for which mark the row wears. Given with `revealKey`, a change of
   *  it builds the new mark in alongside the name. */
  markKey?: string;
}
export function SidebarItem({
  label,
  icon,
  selected,
  unread,
  status,
  trailing,
  actions,
  onClick,
  onPointerDown,
  indent,
  revealKey,
  markKey,
}: SidebarItemProps) {
  const mark = status ? <WorkspaceStatusIcon status={status} unread={unread} /> : icon;
  return (
    <div
      className="ui-sidebar-item"
      data-selected={selected || undefined}
      data-unread={unread || undefined}
      data-indent={indent || undefined}
      data-workspace={!!status || undefined}
    >
      <button
        type="button"
        className="ui-sidebar-item-target"
        onClick={onClick}
        onPointerDown={onPointerDown}
        aria-current={selected ? "page" : undefined}
      >
        {markKey !== undefined ? (
          <RevealMark revealKey={revealKey} markKey={markKey}>
            {mark}
          </RevealMark>
        ) : (
          mark
        )}
        <span className="ui-sidebar-item-label">
          <TitleReveal revealKey={revealKey} text={label} />
        </span>
        {trailing && <span className="ui-sidebar-item-trailing">{trailing}</span>}
      </button>
      {actions && <div className="ui-sidebar-item-actions">{actions}</div>}
    </div>
  );
}
export function DiffCount({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="ui-diff-count">
      <span>+{added}</span>
      <span>−{removed}</span>
    </span>
  );
}
