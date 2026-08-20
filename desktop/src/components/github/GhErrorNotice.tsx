// GhErrorNotice — the single, shared way to render a failed `gh` call. Takes
// the raw error, classifies it (classifyGhError), and shows a plain-language
// headline + next step instead of the raw "GraphQL: API rate limit already
// exceeded …" string. A rate-limit reads as a throttle, not a broken login;
// an auth failure points at `gh auth login`. Retryable modes get a Refresh.

import { classifyGhError } from "../../lib/ghError";

/** Render `code` spans (backtick-fenced) in monospace; the rest as text. */
function renderDetail(detail: string): React.ReactNode {
  const parts = detail.split(/`([^`]+)`/g);
  return parts.map((part, i) =>
    i % 2 === 1 ? (
      <span key={i} className="font-mono text-text-3">
        {part}
      </span>
    ) : (
      <span key={i}>{part}</span>
    ),
  );
}

export function GhErrorNotice({
  error,
  onRetry,
  align = "left",
}: {
  error: unknown;
  onRetry?: () => void;
  align?: "left" | "center";
}) {
  const info = classifyGhError(error);
  const body = (
    <div
      className={`text-sm leading-relaxed ${
        align === "center" ? "max-w-md text-center" : ""
      }`}
    >
      <div className="text-text-2 font-medium">{info.title}</div>
      <div className="text-text-4 mt-1">{renderDetail(info.detail)}</div>
      {onRetry && info.retryable && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-2 text-xs text-accent hover:underline"
        >
          Try again
        </button>
      )}
    </div>
  );

  if (align === "center") {
    return (
      <div className="flex-1 flex items-center justify-center px-6">{body}</div>
    );
  }
  return <div className="px-3 py-6">{body}</div>;
}
