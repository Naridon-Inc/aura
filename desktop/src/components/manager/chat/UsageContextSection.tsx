//! The "Context" section of the usage popover — how full the active model's
//! window is on this turn.
//!
//!   Context                              105.7k/258.4k
//!   ▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░░  (arctic-blue fill)
//!   Window used                                  40.9%
//!   ─────────────────────────────────────────────────
//!   Input                                        105.5k
//!   Output                                          168
//!
//! Every figure here is REAL, live per-turn accounting: `input`/`output` are the
//! tokens the brain reported for this turn (Rust `TokenUsage`). The window TOTAL
//! is the active model's published context size — a model spec, not per-session
//! telemetry — so the used/total pair and "Window used %" combine a measured
//! numerator with a known denominator. Rows the target layout shows but Aura has
//! no datum for (Cached input, Reasoning output) are simply not passed and so
//! never render — the section stays honest rather than padded.

import { Bar, contextFill, formatTokens, Rule, SectionHead, StatRow } from "./usageAtoms";

export function UsageContextSection({
  input,
  output,
  contextWindow,
  cachedInput,
  reasoningOutput,
}: {
  input: number;
  output: number;
  /** Active model's context window (its published size). */
  contextWindow: number;
  /** Cached-prompt tokens billed at the cache rate — render only when a brain
   *  actually reports it. Undefined/null → row omitted. */
  cachedInput?: number | null;
  /** Extended-thinking / reasoning output tokens — render only when reported. */
  reasoningOutput?: number | null;
}) {
  const total = input + output;
  const frac = Math.max(0, Math.min(1, total / contextWindow));
  const windowPct = frac * 100;

  return (
    <>
      <SectionHead
        title="Context"
        meta={`${formatTokens(total)}/${formatTokens(contextWindow)}`}
      />
      <div className="mt-2.5">
        <Bar frac={frac} fill={contextFill(frac)} />
      </div>
      <div className="mt-2.5">
        <StatRow label="Window used" value={`${windowPct.toFixed(1)}%`} strong />
      </div>

      <Rule />

      <div className="flex flex-col gap-1.5">
        <StatRow label="Input" value={formatTokens(input)} />
        {cachedInput != null && (
          <StatRow label="Cached input" value={formatTokens(cachedInput)} />
        )}
        <StatRow label="Output" value={formatTokens(output)} />
        {reasoningOutput != null && (
          <StatRow label="Reasoning output" value={formatTokens(reasoningOutput)} />
        )}
      </div>
    </>
  );
}
