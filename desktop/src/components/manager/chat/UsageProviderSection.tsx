//! The "<Provider> usage" section of the popover — the subscription/rate-limit
//! plane for the active provider, plus a small identity block.
//!
//!   Claude usage
//!   5h window                                  61% left
//!   ▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░  (status-toned fill)
//!   7d limit                                   47% left
//!   ▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░
//!   Session                                      $19.79
//!   ─────────────────────────────────────────────────
//!   Provider                                  Anthropic
//!   Model                              claude-opus-4-8
//!
//! Provider-aware by STRUCTURE: the title, the windows and the identity rows are
//! all fed from whatever the active provider's snapshot actually exposes. Today
//! only the Claude statusline reports live windows, so those render for Claude
//! and simply don't for a provider with no snapshot — the section shrinks to
//! whatever identity we can honestly name. Nothing here is estimated: a window,
//! a cost, a reset time or an identity row appears only when its datum is real.

import { Bar, budgetFill, Rule, SectionHead, StatRow } from "./usageAtoms";
import { formatCost } from "../../../lib/money";
import { percentOf } from "../../../lib/percent";

/** One rolling subscription window (5-hour / weekly). `pctLeft` is 0–100. */
export type UsageWindow = {
  /** Row label in plain language, e.g. "5h window" / "7d limit". */
  label: string;
  /** Percent of the window still available (0–100) → "N% left". */
  pctLeft: number;
};

/** A named identity row (Provider / Model / Plan / Auth / Account). Rendered
 *  only when `value` is a real, present string. */
export type IdentityRow = { label: string; value: string };

export function UsageProviderSection({
  title,
  windows,
  resetsAt,
  sessionCost,
  identity,
}: {
  /** Section header, e.g. "Claude usage" — derived from the active provider. */
  title: string;
  /** Live rolling windows to show (5h and/or 7d). Empty → no window rows. */
  windows: UsageWindow[];
  /** Human reset time, only when the provider actually reports one. */
  resetsAt?: string | null;
  /** Running session cost in USD, only when reported. */
  sessionCost?: number | null;
  /** Identity rows we can honestly name for this provider. */
  identity: IdentityRow[];
}) {
  const hasUsage = windows.length > 0 || sessionCost != null;
  if (!hasUsage && identity.length === 0) return null;

  return (
    <>
      {hasUsage && (
        <>
          <Rule />
          <SectionHead title={title} />
          <div className="mt-2.5 flex flex-col gap-2.5">
            {windows.map((w) => {
              const usedPct = 100 - w.pctLeft;
              return (
                <div key={w.label} className="flex flex-col gap-1.5">
                  <StatRow
                    label={w.label}
                    value={`${percentOf(w.pctLeft / 100)}% left`}
                    strong
                  />
                  <Bar frac={usedPct / 100} fill={budgetFill(usedPct)} />
                </div>
              );
            })}
          </div>
          {resetsAt && (
            <div className="mt-2.5 text-base text-text-3">Resets {resetsAt}</div>
          )}
          {sessionCost != null && (
            <div className="mt-2.5">
              <StatRow label="Session" value={formatCost(sessionCost)} />
            </div>
          )}
        </>
      )}

      {identity.length > 0 && (
        <>
          <Rule />
          <div className="flex flex-col gap-1.5">
            {identity.map((r) => (
              <StatRow key={r.label} label={r.label} value={r.value} />
            ))}
          </div>
        </>
      )}
    </>
  );
}
