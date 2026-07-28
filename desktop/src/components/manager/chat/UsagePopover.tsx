//! Rich usage popover for the composer — the Conductor-parity card that opens
//! from the slim context meter in the composer's bottom row.
//!
//! The collapsed trigger stays a calm, peripheral signal (a compact token count
//! + a thin arctic-blue context-fill bar). On hover it reveals two stacked,
//! bar-topped sections: a "Context" window gauge (from the live per-turn
//! `usage` prop) and a "<Provider> usage" section (rolling 5h/7d windows,
//! session cost, provider/model identity — pulled from the Claude statusline
//! snapshot via `useClaudeUsage`).
//!
//! The card is provider-aware by STRUCTURE and honest by construction: the
//! section is only as rich as the data actually is, and every row past the
//! always-real ones (Input/Output tokens) renders ONLY when its datum is
//! genuinely present — a missing window, cost, reset time, cache split,
//! reasoning count or identity field is omitted, never fabricated.

import { useRef, useState } from "react";

import { UsageContextSection } from "./UsageContextSection";
import {
  UsageProviderSection,
  type IdentityRow,
  type UsageWindow,
} from "./UsageProviderSection";
import { useClaudeUsage } from "./ClaudeUsageRing";
import { formatTokens, providerBrand, providerLabel } from "./usageAtoms";
import type { TokenUsage } from "./types";

/** Conservative Anthropic Sonnet/Opus window — the fallback the meter reads
 *  against when the active model's real window isn't known. A model spec, not
 *  per-session telemetry (see BACKEND GAPS). */
const DEFAULT_CONTEXT_WINDOW = 200_000;

/** Rate-limit datum for the usage section (legacy prop; the live windows now
 *  come straight from the Claude snapshot). */
export type UsageLimit = {
  label: string;
  pctLeft: number;
  resetsAt?: string | null;
};

/** Provider/account identity for the footer. Every field optional — a row shows
 *  only when its value is really present, so the block is ready for providers
 *  that expose plan/auth/account without ever inventing them. */
export type UsageAccount = {
  provider?: string | null;
  plan?: string | null;
  auth?: string | null;
  account?: string | null;
};

/** The rich usage popover. Trigger = compact meter; content = the breakdown
 *  card. Renders nothing when there is no usage to report. */
export function UsagePopover({
  usage,
  contextWindow = DEFAULT_CONTEXT_WINDOW,
  cachedInput,
  reasoningOutput,
  usageTitle,
  limit,
  account,
}: {
  usage: TokenUsage | null;
  contextWindow?: number;
  /** Cached-prompt tokens, when a brain reports them (omitted otherwise). */
  cachedInput?: number | null;
  /** Reasoning/thinking output tokens, when reported (omitted otherwise). */
  reasoningOutput?: number | null;
  /** Explicit header for the provider-usage section; else derived from the
   *  provider brand. */
  usageTitle?: string;
  /** Legacy fallback window when no live snapshot is available. */
  limit?: UsageLimit | null;
  account?: UsageAccount | null;
}) {
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<number | null>(null);
  // Live Claude subscription reading — enriches the provider section with the
  // real 5h/7d windows, session cost and model. Null off-subscription, so the
  // section simply shrinks to whatever identity we can honestly name.
  const snap = useClaudeUsage();

  if (!usage) return null;

  const input = usage.inputTokens;
  const output = usage.outputTokens;
  const total = input + output;
  const frac = Math.max(0, Math.min(1, total / contextWindow));

  const show = () => {
    if (closeTimer.current != null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    setOpen(true);
  };
  // Grace period so moving the pointer from trigger to card doesn't dismiss it.
  const hide = () => {
    if (closeTimer.current != null) window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setOpen(false), 120);
  };

  // ── Assemble the provider-usage section from real data only ──────────────
  const family = account?.provider ?? null;
  const title = usageTitle ?? (family ? `${providerBrand(family)} usage` : "Usage");

  const windows: UsageWindow[] = [];
  if (snap?.fresh && typeof snap.five_h_pct === "number") {
    windows.push({ label: "5h window", pctLeft: 100 - snap.five_h_pct });
  }
  if (snap?.fresh && typeof snap.seven_d_pct === "number") {
    windows.push({ label: "7d limit", pctLeft: 100 - snap.seven_d_pct });
  }
  // Fall back to the legacy prop only when the live snapshot carries nothing.
  if (windows.length === 0 && limit) {
    windows.push({ label: limit.label, pctLeft: limit.pctLeft });
  }
  const resetsAt = limit?.resetsAt ?? null; // No reset time in the snapshot.
  const sessionCost = typeof snap?.cost_usd === "number" ? snap.cost_usd : null;

  const identity: IdentityRow[] = [];
  if (family) identity.push({ label: "Provider", value: providerLabel(family) });
  if (snap?.model) identity.push({ label: "Model", value: snap.model });
  if (account?.plan) identity.push({ label: "Plan", value: account.plan });
  if (account?.auth) identity.push({ label: "Auth", value: account.auth });
  if (account?.account) identity.push({ label: "Account", value: account.account });

  return (
    <div className="relative" onMouseEnter={show} onMouseLeave={hide}>
      {/* Collapsed trigger — the calm peripheral meter. */}
      <button
        type="button"
        className="flex items-center gap-2 select-none cursor-default"
        aria-label="Token usage"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span
          className="tabular-nums text-[11px]"
          style={{ fontFamily: "var(--font-mono)", color: "var(--color-text-3)" }}
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
              background:
                frac >= 0.92
                  ? "var(--color-red)"
                  : frac >= 0.8
                    ? "var(--color-amber)"
                    : "var(--color-blue)",
              transition: "width var(--motion-fast), background var(--motion-fast)",
            }}
          />
        </span>
      </button>

      {open && (
        <div
          className="absolute right-0 bottom-full z-40 mb-2 w-[344px] rounded-2xl p-5 shadow-xl"
          style={{
            background: "var(--color-bg-2)",
            border: "1px solid var(--color-line-soft)",
          }}
          role="dialog"
          aria-label="Token usage breakdown"
        >
          <UsageContextSection
            input={input}
            output={output}
            contextWindow={contextWindow}
            cachedInput={cachedInput}
            reasoningOutput={reasoningOutput}
          />
          <UsageProviderSection
            title={title}
            windows={windows}
            resetsAt={resetsAt}
            sessionCost={sessionCost}
            identity={identity}
          />
        </div>
      )}
    </div>
  );
}
