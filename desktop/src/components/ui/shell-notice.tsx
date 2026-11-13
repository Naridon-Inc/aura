import type { ReactNode } from "react";
import { X } from "lucide-react";
import { AsciiSpinner } from "./ascii-spinner";
import { Button } from "./button";
import "./shell-notice.css";

// App-level notices (an update, a project Aura can't track yet, an impact on
// code you depend on). They share the session banner's surface — muted fill,
// hairline border, 12px text — and stack at the foot of the sidebar, so the
// work column never shifts down to make room for news.
//
// The sidebar is narrow, so the sentence gets the full width and the buttons
// go on the line below it rather than squeezing the text into a sliver.

export type ShellNoticeTone = "neutral" | "ok" | "attention" | "error";

export type ShellNoticeAction = {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
};

export function ShellNotice({
  tone = "neutral",
  busy = false,
  children,
  action,
  secondary,
  detail,
  onDismiss,
  dismissLabel = "Dismiss notice",
  dismissDisabled = false,
}: {
  tone?: ShellNoticeTone;
  /** Work is in flight — the spinner takes the dot's place. */
  busy?: boolean;
  children: ReactNode;
  action?: ShellNoticeAction;
  secondary?: ShellNoticeAction;
  /** Shown under the actions when present — the full message, a command. */
  detail?: ReactNode;
  onDismiss?: () => void;
  dismissLabel?: string;
  dismissDisabled?: boolean;
}) {
  return (
    <div
      className="ui-session-banner ui-shell-notice"
      data-tone={tone}
      role={tone === "error" ? "alert" : "status"}
    >
      {busy ? (
        <AsciiSpinner className="ui-shell-notice-mark" />
      ) : tone !== "neutral" ? (
        <i className="ui-shell-notice-mark ui-shell-notice-dot" aria-hidden />
      ) : null}
      <span className="ui-shell-notice-text">{children}</span>
      {onDismiss && (
        <Button
          size="iconXs"
          variant="ghost"
          aria-label={dismissLabel}
          title={dismissLabel}
          onClick={onDismiss}
          disabled={dismissDisabled}
        >
          <X />
        </Button>
      )}
      {(action || secondary) && (
        <div className="ui-shell-notice-actions">
          {action && (
            <Button
              size="xs"
              variant="outline"
              onClick={action.onClick}
              disabled={action.disabled}
              title={action.title}
            >
              {action.label}
            </Button>
          )}
          {secondary && (
            <Button
              size="xs"
              variant="ghost"
              onClick={secondary.onClick}
              disabled={secondary.disabled}
              title={secondary.title}
            >
              {secondary.label}
            </Button>
          )}
        </div>
      )}
      {detail && <div className="ui-shell-notice-detail">{detail}</div>}
    </div>
  );
}

/** The stack the notices sit in, above the sidebar footer. Renders nothing
 *  of its own — an empty stack takes no space. */
export function ShellNoticeStack({ children }: { children: ReactNode }) {
  return <div className="ui-shell-notice-stack">{children}</div>;
}
