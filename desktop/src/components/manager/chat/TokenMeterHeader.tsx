//! Context-fill meter for the chat header.
//!
//! When a brain reports usage (`ChatChunk::Usage` → `BrainTokenUsage`), the
//! last turn's input+output token counts feed a slim meter that shows how full
//! the model's context window is. It's a calm, peripheral signal — a thin bar
//! plus a token count — that lets the user notice when a long conversation is
//! approaching the window limit (where the brain starts dropping early turns).
//!
//! The meter is hidden entirely until the first usage arrives, so providers
//! that don't report usage never show an empty widget. Tokens only.

import type { TokenUsage } from "./types";

// Default Anthropic Sonnet/Opus window. The picker can run 1M-context models
// but we keep a conservative default so the bar reads "early" rather than
// "full" when we don't know the exact window — a meter that cries wolf is
// worse than one that's a touch optimistic.
const DEFAULT_CONTEXT_WINDOW = 200_000;

/** Format a token count compactly: 1234 → "1.2k", 412000 → "412k". */
function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** A thin context-window fill meter. Renders nothing until `usage` is set.
 *  `contextWindow` defaults to a conservative 200k; pass the active model's
 *  real window (e.g. 1M for long-context rows) when known. */
export function TokenMeterHeader({
  usage,
  contextWindow = DEFAULT_CONTEXT_WINDOW,
}: {
  usage: TokenUsage | null;
  contextWindow?: number;
}) {
  if (!usage) return null;
  const total = usage.inputTokens + usage.outputTokens;
  const frac = Math.max(0, Math.min(1, total / contextWindow));
  const pct = Math.round(frac * 100);
  // Past ~80% the bar warms to amber, past ~92% to red — the model starts
  // truncating early turns near the ceiling.
  const fill =
    frac >= 0.92
      ? "var(--color-red)"
      : frac >= 0.8
        ? "var(--color-amber)"
        : "var(--color-accent)";

  return (
    <div
      className="flex items-center gap-2 select-none"
      title={`Context: ${total.toLocaleString()} / ${contextWindow.toLocaleString()} tokens (${pct}%)\nLast turn — in ${usage.inputTokens.toLocaleString()}, out ${usage.outputTokens.toLocaleString()}`}
    >
      <span
        className="shrink-0 text-right tabular-nums t-2xs"
        style={{
          fontFamily: "var(--font-mono)",
          color: "var(--color-text-3)",
          minWidth: "4ch",
        }}
      >
        {formatTokens(total)}
      </span>
      <span
        className="relative overflow-hidden rounded-full"
        style={{
          width: 56,
          height: 4,
          background: "var(--color-bg-2)",
          border: "1px solid var(--color-line-soft)",
        }}
        aria-hidden
      >
        <span
          className="absolute inset-y-0 left-0 rounded-full"
          style={{
            width: `${Math.max(frac * 100, total > 0 ? 3 : 0)}%`,
            background: fill,
            transition: "width var(--motion-fast), background var(--motion-fast)",
          }}
        />
      </span>
    </div>
  );
}
