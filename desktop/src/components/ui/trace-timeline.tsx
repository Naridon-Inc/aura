// The library timeline, made into something you can travel along: every moment
// is a button, the one you are reading carries the filled marker, and the
// connector runs through the markers exactly as it does on a read-only
// timeline. Same marker, same type, same hairline — only the hover, the focus
// ring and the selection are added, because a timeline you pick from has to
// show which point you are on.

import { type ReactNode } from "react";
import { cn } from "../../lib/utils";
import "./trace-timeline.css";

export function TraceTimeline({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <ol
      className={cn("ui-timeline ui-trace-timeline", className)}
      data-orientation="vertical"
      data-position="after"
      aria-label={label}
    >
      {children}
    </ol>
  );
}

export function TraceTimelineEntry({
  title,
  detail,
  active,
  disabled,
  onSelect,
}: {
  title: ReactNode;
  detail?: ReactNode;
  active?: boolean;
  /** A moment that can be read but not picked: drawn in the timeline's
   *  incomplete tone, its button inert. */
  disabled?: boolean;
  /** Without it the moment is read-only: same marker, same spacing, no hover,
   *  for a point on the line that has nothing behind it to open. */
  onSelect?: () => void;
}) {
  const body = (
    <>
      <span className="ui-timeline-marker" aria-hidden />
      <div>
        <strong>{title}</strong>
        {detail && <div>{detail}</div>}
      </div>
    </>
  );
  return (
    <li data-tone={active ? "active" : disabled ? "incomplete" : "neutral"}>
      {onSelect ? (
        <button
          type="button"
          className="ui-trace-timeline-entry"
          aria-current={active || undefined}
          disabled={disabled}
          onClick={onSelect}
        >
          {body}
        </button>
      ) : (
        <div className="ui-trace-timeline-entry" data-static="">
          {body}
        </div>
      )}
    </li>
  );
}
