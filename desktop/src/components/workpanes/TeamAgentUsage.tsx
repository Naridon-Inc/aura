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
import { TraceSection } from "../ui/trace-report";
import {
  providerAccent,
  providerForModel,
  providerLabel,
} from "./usageProviders";
import { compactNumber } from "../../lib/compactNumber";
import { formatCost } from "../../lib/money";
import "../trace/usage.css";

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
    <TraceSection
      title="By coding agent"
      trailing={<span className="ui-usage-scope">{scopeNote}</span>}
    >
      <div className="ui-usage-rows">
        {agents.map((a) => {
          const pct = grand > 0 ? (a.total / grand) * 100 : 0;
          return (
            <div key={a.providerId} className="ui-usage-row ui-usage-agent">
              <AgentIcon agentId={a.providerId} size={14} />
              <span className="ui-usage-row-label">{providerLabel(a.providerId)}</span>
              <span className="ui-usage-meter" aria-hidden>
                <span
                  style={{
                    width: `${Math.max(pct, 2)}%`,
                    background: providerAccent(a.providerId),
                  }}
                />
              </span>
              <span className="ui-usage-num">{compactNumber(a.total)}</span>
              <span className="ui-usage-num" data-width="cost">
                {formatCost(a.costUsd)}
              </span>
            </div>
          );
        })}
      </div>
    </TraceSection>
  );
}
