// Trace's lists: one 44px full-width row per run, the same row Home draws for
// a workspace, with the same hover preview. A session, a teammate's change and
// a moment in the time machine are all "a thing that happened, by someone, to
// some files, some time ago", which is exactly what a Home row already says —
// status, title, line changes, where, when — so they wear that row rather than
// a card of their own.

import { type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { DiffCount } from "./sidebar";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "./hover-card";
import { cn } from "../../lib/utils";
import "./trace-list.css";

export function TraceList({
  label,
  id,
  children,
  className,
}: {
  label: string;
  id?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div id={id} className={cn("ui-home-list ui-trace-list", className)} role="list" aria-label={label}>
      {children}
    </div>
  );
}

/** A day (or any other run of rows) under one sticky caption. The caption is
 *  also the fold, so a long history can be closed a day at a time. */
export function TraceGroup({
  label,
  count,
  collapsed,
  onToggle,
  actions,
  children,
}: {
  label: ReactNode;
  count?: ReactNode;
  collapsed?: boolean;
  onToggle?: () => void;
  /** Controls for the whole group, beside the caption rather than inside it:
   *  the caption is the fold, and a button can't hold another button. */
  actions?: ReactNode;
  children: ReactNode;
}) {
  const Chevron = collapsed ? ChevronRight : ChevronDown;
  const caption = (
    <button
      type="button"
      className="ui-trace-group-header"
      aria-expanded={onToggle ? !collapsed : undefined}
      onClick={onToggle}
      disabled={!onToggle}
    >
      {onToggle && <Chevron size={14} />}
      <span>{label}</span>
      {count != null && <span className="ui-trace-group-count">{count}</span>}
    </button>
  );
  return (
    <div role="presentation" className="ui-trace-group">
      {actions ? (
        <div className="ui-trace-group-bar">
          {caption}
          <div className="ui-trace-group-actions">{actions}</div>
        </div>
      ) : (
        caption
      )}
      {!collapsed && children}
    </div>
  );
}

export interface TracePreview {
  /** First line: where it happened, its line changes, its marks. */
  meta: ReactNode;
  title: ReactNode;
  summary?: ReactNode;
  footer?: ReactNode;
}

/** The preview a row opens on hover — Home's workspace preview card, filled
 *  with whatever the row is a record of. */
export function TraceHover({
  preview,
  side = "bottom",
  children,
}: {
  preview?: TracePreview | null;
  side?: "bottom" | "right";
  children: ReactNode;
}) {
  if (!preview) return <>{children}</>;
  return (
    <HoverCard openDelay={450} closeDelay={150}>
      <HoverCardTrigger asChild>{children}</HoverCardTrigger>
      <HoverCardContent
        side={side}
        align="start"
        sideOffset={side === "bottom" ? 6 : 10}
        collisionPadding={12}
        className="ui-workspace-hover"
      >
        <div className="ui-workspace-card-content">
          <div className="ui-workspace-card-meta ui-trace-preview-meta">{preview.meta}</div>
          <strong className="ui-workspace-card-title">{preview.title}</strong>
          {preview.summary && (
            <p className="ui-workspace-card-summary ui-trace-preview-summary">{preview.summary}</p>
          )}
          {preview.footer && <footer>{preview.footer}</footer>}
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}

export function TraceRow({
  status,
  icon,
  title,
  marks,
  added,
  removed,
  where,
  whereTitle,
  time,
  timeTitle,
  active,
  index,
  preview,
  tone,
  onOpen,
  onFocus,
}: {
  /** 14px status glyph at the row's left edge. */
  status?: ReactNode;
  /** Who did it: the agent's mark. */
  icon?: ReactNode;
  title: ReactNode;
  /** Small marks after the title (sealed, blocked, the kind of change). */
  marks?: ReactNode;
  added?: number | null;
  removed?: number | null;
  /** The fixed-width column Home uses for the repository: here, the branch or
   *  person the row belongs to. */
  where?: ReactNode;
  whereTitle?: string;
  time?: string;
  timeTitle?: string;
  active?: boolean;
  index?: number;
  preview?: TracePreview | null;
  /** `attention` draws the title in the danger colour (a blocked change). */
  tone?: "attention";
  onOpen?: () => void;
  onFocus?: () => void;
}) {
  return (
    <div role="listitem">
      <TraceHover preview={preview}>
        <button
          type="button"
          data-index={index}
          className="ui-home-row ui-trace-row"
          data-active={active || undefined}
          data-tone={tone}
          onFocus={onFocus}
          onClick={onOpen}
        >
          {status && <span className="ui-trace-row-status">{status}</span>}
          {icon && <span className="ui-trace-row-icon">{icon}</span>}
          <span className="ui-home-title">{title}</span>
          {marks && <span className="ui-trace-row-marks">{marks}</span>}
          {added != null && (added > 0 || (removed ?? 0) > 0) && (
            <DiffCount added={added} removed={removed ?? 0} />
          )}
          <span className="ui-home-project" title={whereTitle}>
            {where}
          </span>
          {time != null && <time title={timeTitle}>{time}</time>}
        </button>
      </TraceHover>
    </div>
  );
}

/** A quiet word-mark after a row title — the kind of change, "chat", "sealed".
 *  A tone is for a mark that changes what the reader does next: `danger` for a
 *  blocked or failed record, `good` for a verified one, `warn` for a change
 *  that lands on the reader's own work. */
export function TraceMark({
  children,
  tone,
  title,
}: {
  children: ReactNode;
  tone?: "danger" | "good" | "warn";
  title?: string;
}) {
  return (
    <span className="ui-trace-mark" data-tone={tone} title={title}>
      {children}
    </span>
  );
}
