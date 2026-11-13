import { useState, type ReactNode } from "react";
import { AlertCircle, ChevronRight, RefreshCw, X } from "lucide-react";
import { AsciiSpinner } from "./ascii-spinner";
import { Button } from "./button";
import { Badge } from "./badge";
export type ChatFailureKind =
  | "generic"
  | "reconnecting"
  | "interrupted"
  | "authentication"
  | "expired-login"
  | "context-full"
  | "usage-limit"
  | "workspace-limit"
  | "ineligible"
  | "overloaded"
  | "setup-required"
  | "image-too-large"
  | "unparseable";
const FAILURE_COPY: Record<
  ChatFailureKind,
  { title: string; description: string; retry: boolean }
> = {
  generic: {
    title: "Something went wrong",
    description: "The response could not be completed.",
    retry: true,
  },
  reconnecting: {
    title: "Reconnecting…",
    description: "Waiting for the connection to return.",
    retry: false,
  },
  interrupted: { title: "Interrupted by user", description: "", retry: true },
  authentication: {
    title: "Sign in required",
    description: "Sign in to your agent provider to continue.",
    retry: false,
  },
  "expired-login": {
    title: "Your login has expired",
    description: "Reconnect your account to continue this chat.",
    retry: false,
  },
  "context-full": {
    title: "Context window exhausted",
    description: "Compact this conversation or start a new chat with a summary.",
    retry: false,
  },
  "usage-limit": {
    title: "Session usage limit reached",
    description: "You can continue after your usage limit resets.",
    retry: false,
  },
  "workspace-limit": {
    title: "Workspace usage limit reached",
    description: "This workspace has reached its available usage.",
    retry: false,
  },
  ineligible: {
    title: "Model unavailable",
    description: "This account is not eligible to use the selected model.",
    retry: false,
  },
  overloaded: {
    title: "Provider overloaded",
    description: "The provider is temporarily unable to handle this request.",
    retry: true,
  },
  "setup-required": {
    title: "Agent setup required",
    description: "Finish configuring your agent in Settings.",
    retry: false,
  },
  "image-too-large": {
    title: "Image too large",
    description: "Edit the previous message and attach a smaller image.",
    retry: false,
  },
  unparseable: {
    title: "Could not display this message",
    description: "The message contains an unsupported response format.",
    retry: true,
  },
};
export function ChatRecovery({
  kind,
  provider,
  detail,
  resetAt,
  retryAttempt,
  onRetry,
  action,
}: {
  kind: ChatFailureKind;
  provider?: string;
  detail?: ReactNode;
  resetAt?: string;
  retryAttempt?: number;
  onRetry?: () => void;
  action?: { label: string; onClick: () => void };
}) {
  const copy = FAILURE_COPY[kind];
  return (
    <div
      className="ui-chat-recovery"
      data-kind={kind}
      role={kind === "reconnecting" ? "status" : "alert"}
    >
      <div className="ui-recovery-heading">
        {kind === "reconnecting" ? (
          <AsciiSpinner />
        ) : (
          kind !== "interrupted" && <AlertCircle size={14} />
        )}
        <Badge
          variant={
            kind === "interrupted"
              ? "outline"
              : kind === "reconnecting"
                ? "secondary"
                : "destructive"
          }
        >
          {provider ? `${provider} · ` : ""}
          {copy.title}
        </Badge>
      </div>
      {(detail || copy.description) && <p>{detail ?? copy.description}</p>}
      {resetAt && <small>Resets {resetAt}</small>}
      {retryAttempt != null && <small>Retrying · attempt {retryAttempt}</small>}
      <div className="ui-pattern-actions">
        {copy.retry && onRetry && (
          <Button size="xs" variant="outline" onClick={onRetry}>
            <RefreshCw />
            Retry
          </Button>
        )}
        {action && (
          <Button size="xs" variant="outline" onClick={action.onClick}>
            {action.label}
          </Button>
        )}
      </div>
    </div>
  );
}
export function SessionBanner({
  state,
  children,
  action,
  onDismiss,
}: {
  state: "archived" | "read-only" | "restarting" | "shutdown";
  children?: ReactNode;
  action?: { label: string; onClick: () => void };
  onDismiss?: () => void;
}) {
  const labels = {
    archived: "This chat is archived.",
    "read-only": "This chat is read-only.",
    restarting: "Restarting the workspace…",
    shutdown: "This cloud workspace is shut down.",
  };
  return (
    <div className="ui-session-banner" role="status">
      {state === "restarting" && <AsciiSpinner />}
      <span>{children ?? labels[state]}</span>
      {action && (
        <Button size="xs" variant="outline" onClick={action.onClick}>
          {action.label}
        </Button>
      )}
      {onDismiss && (
        <Button size="iconXs" variant="ghost" aria-label="Dismiss notice" onClick={onDismiss}>
          <X />
        </Button>
      )}
    </div>
  );
}
export function HistoryGap({
  loading,
  error,
  onLoad,
}: {
  loading?: boolean;
  error?: boolean;
  onLoad: () => void;
}) {
  return (
    <div className="ui-history-gap">
      {loading ? (
        <>
          <AsciiSpinner />
          Loading earlier messages…
        </>
      ) : (
        <Button size="xs" variant="ghost" onClick={onLoad}>
          {error ? "Retry loading earlier messages" : "Load earlier messages"}
        </Button>
      )}
    </div>
  );
}
export function CompactionSummary({
  working,
  children,
}: {
  working?: boolean;
  children?: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="ui-compaction-summary">
      {working ? (
        <span role="status">
          <AsciiSpinner />
          Compacting conversation…
        </span>
      ) : (
        <>
          <button onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>
            <ChevronRight size={14} className={expanded ? "ui-chevron-open" : ""} />
            Conversation compacted
          </button>
          {expanded && <div>{children}</div>}
        </>
      )}
    </div>
  );
}
export function ModelFallback({ from, to, reason }: { from: string; to: string; reason?: string }) {
  return (
    <p className="ui-model-fallback" role="status">
      Switched from <strong>{from}</strong> to <strong>{to}</strong>
      {reason ? ` · ${reason}` : ""}
    </p>
  );
}
