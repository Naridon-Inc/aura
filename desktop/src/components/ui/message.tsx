import { useState, type HTMLAttributes, type ReactNode } from "react";
import { ChevronRight, Check, CircleAlert, Copy } from "lucide-react";
import { cn } from "../../lib/utils";
import { AsciiSpinner } from "./ascii-spinner";
import { Button } from "./button";
export function Message({
  role,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement> & { role: "user" | "assistant" | "system" }) {
  return (
    <div
      className={cn("ui-message", className)}
      data-message-role={role}
      aria-label={
        role === "user"
          ? "Your message"
          : role === "assistant"
            ? "Assistant message"
            : "Status message"
      }
      {...props}
    />
  );
}
export function MessageBody({
  tone = "assistant",
  className,
  ...props
}: HTMLAttributes<HTMLDivElement> & { tone?: "assistant" | "user" | "other" | "queued" }) {
  return <div className={cn("ui-message-body", className)} data-tone={tone} {...props} />;
}
export function MessageActions({ text, children }: { text?: string; children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);
  return (
    <div className="ui-message-actions">
      {text != null && (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={copied ? "Copied" : "Copy message"}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(text);
              setCopied(true);
              setError(false);
            } catch {
              setError(true);
            }
          }}
        >
          {copied ? <Check /> : <Copy />}
        </Button>
      )}
      {children}
      {error && <span role="status">Copy unavailable</span>}
    </div>
  );
}
export function ToolCall({
  title,
  status = "done",
  children,
  defaultOpen = false,
}: {
  title: string;
  status?: "running" | "done" | "error";
  children?: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="ui-tool-call" data-status={status}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="ui-tool-trigger"
      >
        <ChevronRight size={14} className={open ? "ui-chevron-open" : ""} />
        {status === "running" ? (
          <AsciiSpinner />
        ) : status === "error" ? (
          <CircleAlert size={14} />
        ) : (
          <Check size={14} />
        )}
        <span>{title}</span>
      </button>
      {open && <div className="ui-tool-content">{children}</div>}
    </div>
  );
}
export function ThinkingMessage({
  children,
  duration,
}: {
  children?: ReactNode;
  duration?: string;
}) {
  return (
    <ToolCall
      title={duration ? `Thought for ${duration}` : "Thinking…"}
      status={duration ? "done" : "running"}
    >
      {children}
    </ToolCall>
  );
}
export function ChatStatus({
  state,
  children,
  action,
}: {
  state: "working" | "error" | "permission" | "compacted" | "empty";
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div
      className="ui-chat-status"
      data-state={state}
      role={state === "error" ? "alert" : "status"}
    >
      {state === "working" && <AsciiSpinner />}
      <div>{children}</div>
      {action}
    </div>
  );
}
