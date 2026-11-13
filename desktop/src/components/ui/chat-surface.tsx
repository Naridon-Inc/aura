import type { HTMLAttributes, ReactNode, Ref } from "react";
import { ChevronRight, X } from "lucide-react";
import { cn } from "../../lib/utils";
import "./chat-surface.css";

/** The conversation's scrolling column: a full-height scroller whose content
 *  sits in one centred reading measure. The scroller is what callers hold a
 *  ref to (scroll anchoring, jump-to-turn); the measure is what every message,
 *  tool row and status line lines up against. */
export function ChatTranscript({
  ref,
  className,
  innerClassName,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  ref?: Ref<HTMLDivElement>;
  innerClassName?: string;
}) {
  return (
    <div ref={ref} className={cn("ui-chat-transcript", className)} {...props}>
      <div className={cn("ui-chat-transcript-inner", innerClassName)}>{children}</div>
    </div>
  );
}

/** The band under the conversation that holds the composer and anything
 *  docked onto it (a queued message, a waiting question, a running command).
 *  Every child takes the composer's measure so the stack reads as one column. */
export function ChatComposerArea({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("ui-chat-composer-area", className)} {...props} />;
}

/** A conversation with nothing in it yet. */
export function ChatEmpty({
  title,
  description,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="ui-chat-empty">
      <h1>{title}</h1>
      {description && <p>{description}</p>}
      {children}
    </div>
  );
}

/** One quiet line under the composer that reports what just happened. */
export function ChatNotice({ children, onDismiss }: { children: ReactNode; onDismiss?: () => void }) {
  return (
    <div role="status" className="ui-chat-notice">
      {children}
      {onDismiss && (
        <button type="button" onClick={onDismiss} aria-label="Dismiss notice">
          <X size={14} />
        </button>
      )}
    </div>
  );
}

/** A result the turn produced, linked from inside the answer: an icon, its
 *  name and a chevron that says it opens. */
export function ChatInlineArtifact({
  icon,
  children,
  detail,
  expanded,
  ...props
}: Omit<HTMLAttributes<HTMLButtonElement>, "children"> & {
  icon: ReactNode;
  children: ReactNode;
  detail?: ReactNode;
  expanded?: boolean;
}) {
  return (
    <button type="button" className="ui-chat-inline-artifact" aria-expanded={expanded} {...props}>
      {icon}
      <span>{children}</span>
      {detail}
      <ChevronRight size={12} className={expanded ? "ui-chevron-open" : undefined} />
    </button>
  );
}
