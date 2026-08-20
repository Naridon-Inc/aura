// TeamAgentUsage — the "By coding agent" cut of the Trace Overview.
//
// Where TeamOverview slices usage per-PERSON, this slices the SAME usage
// per-AGENT: it folds every member's `by_model` rows up by canonical provider
// (Claude / Gemini / Codex / Cursor / local) so you can see, project-wide, how
// many tokens each coding agent burned and what it cost — each row fronted by
// the agent's real brand logo.
//
// HONESTY RULE (inherited from OverviewPane): nothing is fabricated. When the
// team is on Aura Cloud (org scope) we aggregate the authoritative per-member
// billing; otherwise we fall back to this install's LOCAL usage report. Either
// way the scope note says exactly whose numbers these are, and a provider with
// zero tokens AND zero cost is dropped rather than shown as a hollow row.

import { useMemo } from "react";
import type { BillingMemberRow, UsageModel } from "../../lib/api";
import { AgentIcon } from "../agent/AgentIcon";
import {
  providerAccent,
  providerForModel,
  providerLabel,
} from "./usageProviders";
import { compactNumber } from "../../lib/compactNumber";
import { formatCost } from "../../lib/money";

/** One coding agent's folded usage across the team (or this install). */
type AgentUsage = {
  providerId: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  total: number;
};

/** Fold raw model rows up by canonical provider id. Shared by the cloud
 *  (per-member `by_model`) and local (`byModel`) paths so both produce the
 *  same per-agent shape. */
function foldByAgent(
  rows: { raw: string; tokensIn: number; tokensOut: number; costUsd: number }[],
): AgentUsage[] {
  const map = new Map<string, AgentUsage>();
  for (const r of rows) {
    const id = providerForModel(r.raw);
    const cur =
      map.get(id) ??
      { providerId: id, tokensIn: 0, tokensOut: 0, costUsd: 0, total: 0 };
    cur.tokensIn += r.tokensIn;
    cur.tokensOut += r.tokensOut;
    cur.costUsd += r.costUsd;
    cur.total += r.tokensIn + r.tokensOut;
    map.set(id, cur);
  }
  return [...map.values()]
    .filter((a) => a.total > 0 || a.costUsd > 0)
    .sort((a, b) => {
      if (b.total !== a.total) return b.total - a.total;
      return b.costUsd - a.costUsd;
    });
}

export function TeamAgentUsage({
  billing,
  cloudAvailable,
  localByModel,
  scopeNote,
}: {
  /** Team-wide per-member billing — only trustworthy at org scope. */
  billing: BillingMemberRow[];
  cloudAvailable: boolean;
  /** This install's local usage models — the fallback when cloud is absent. */
  localByModel: UsageModel[] | null;
  /** Whose numbers these are, e.g. "Aura Cloud · team" / "Local · this install". */
  scopeNote: string;
}) {
  const agents = useMemo(() => {
    if (cloudAvailable && billing.length > 0) {
      const rows: {
        raw: string;
        tokensIn: number;
        tokensOut: number;
        costUsd: number;
      }[] = [];
      for (const m of billing) {
        for (const r of m.by_model) {
          rows.push({
            raw: r.provider || r.model,
            tokensIn: r.tokens_in,
            tokensOut: r.tokens_out,
            costUsd: r.cost_usd,
          });
        }
      }
      return foldByAgent(rows);
    }
    if (localByModel && localByModel.length > 0) {
      return foldByAgent(
        localByModel.map((m) => ({
          raw: m.model,
          tokensIn: m.inputTokens,
          tokensOut: m.outputTokens,
          costUsd: m.costUsd,
        })),
      );
    }
    return [];
  }, [billing, cloudAvailable, localByModel]);

  const grand = useMemo(
    () => agents.reduce((sum, a) => sum + a.total, 0),
    [agents],
  );

  if (agents.length === 0) return null;

  return (
    <div className="rounded-lg border border-line-soft bg-bg-1 p-2.5">
      <div className="mb-2.5 flex items-baseline justify-between">
        <span className="section-label">
          By coding agent
        </span>
        <span className="text-xs text-text-4">{scopeNote}</span>
      </div>
      <div className="flex flex-col gap-2.5">
        {agents.map((a) => {
          const pct = grand > 0 ? (a.total / grand) * 100 : 0;
          return (
            <div key={a.providerId} className="flex items-center gap-2.5">
              <span
                className="shrink-0 rounded-full p-0.5"
                style={{ background: "var(--color-bg-content)" }}
              >
                <AgentIcon agentId={a.providerId} size={18} />
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-base text-text-2">
                    {providerLabel(a.providerId)}
                  </span>
                  <span className="shrink-0 font-mono text-xs text-text-3">
                    {compactNumber(a.total)}
                    <span className="text-text-4"> · {formatCost(a.costUsd)}</span>
                  </span>
                </div>
                <span className="flex h-1.5 w-full overflow-hidden rounded-full bg-bg-2">
                  <span
                    className="block h-full rounded-full"
                    style={{
                      width: `${Math.max(pct, 2)}%`,
                      background: providerAccent(a.providerId),
                      opacity: 0.85,
                    }}
                  />
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
