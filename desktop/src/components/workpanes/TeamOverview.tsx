// TeamOverview — the "Team" section of the redesigned Trace Overview.
//
// It joins the git-derived roster (`api.teamLoad`) with the cloud billing
// per-member usage (`api.cloudBillingUsageByMember`) so each teammate gets a
// single row: avatar/monogram, the provider logos they actually used, their
// commit count + last-active, and their token spend (in/out stacked) + cost.
//
// GRACEFUL DEGRADATION is the whole point of this file:
//   • No team (roster has only you)        → render the single member, calm.
//   • No cloud auth / scope "self" / throw  → fall back to the LOCAL per-dev
//     aggregate (`.aura/usage_by_dev.jsonl`, git-shared — each teammate's
//     `aura usage` runs refresh their own rows and git syncs the file), so
//     per-dev token numbers still render. The scope line says "shared via
//     git" so we never pass local numbers off as cloud billing.
//   • Neither cloud nor local rows → roster WITHOUT token numbers + a quiet
//     "Sign in to Aura Cloud" line.
//   • Member has roster entry but no usage row → show commits/last-active,
//     omit the (absent) token numbers rather than printing zeros as truth.
// Nothing here throws to the parent; the parent owns loading/error framing.

import { useMemo } from "react";
import type { BillingMemberRow, TeamMember, UsageDeveloper } from "../../lib/api";
import { AgentIcon } from "../agent/AgentIcon";
import { Button } from "../ui/button";
import { TraceMark } from "../ui/trace-list";
import { TraceLine, TraceSection } from "../ui/trace-report";
import { initialsOf, relTimeFromTs } from "./usageProviders";
import { aggregateLocalDev, joinMembers, type JoinedMember } from "./teamUsageJoin";
import { compactNumber } from "../../lib/compactNumber";
import { formatCost } from "../../lib/money";
import "../trace/usage.css";

/** The in/out token mini-bar for a teammate — two stacked segments scaled to
 *  the team-wide max so rows are comparable. In is the darker ink, out the
 *  lighter one. */
function TokenBar({
  tokensIn,
  tokensOut,
  teamMax,
}: {
  tokensIn: number;
  tokensOut: number;
  teamMax: number;
}) {
  const total = tokensIn + tokensOut;
  const widthPct = teamMax > 0 ? Math.max((total / teamMax) * 100, 3) : 0;
  const inPct = total > 0 ? (tokensIn / total) * 100 : 0;
  return (
    <span
      className="ui-usage-tokenbar"
      title={`${compactNumber(tokensIn)} in · ${compactNumber(tokensOut)} out`}
    >
      <span data-part="in" style={{ width: `${(widthPct * inPct) / 100}%` }} />
      <span data-part="out" style={{ width: `${(widthPct * (100 - inPct)) / 100}%` }} />
    </span>
  );
}

/** One person (or one machine) in the team list. Extracted so the Automation
 *  group renders identically to the Team group without a second copy of the
 *  markup drifting away from it. */
function MemberRow({
  m,
  qualifier,
  teamMaxTokens,
  nowSecs,
  usageKnown,
}: {
  m: JoinedMember;
  /** Rendered after the name when two seats share a display name — this repo
   *  has "Ashiq" under two git emails, and two identical rows in a spend list
   *  is a puzzle, not a fact. Empty string = the name stands alone. */
  qualifier: string;
  teamMaxTokens: number;
  nowSecs: number;
  /** We have per-dev numbers from somewhere, so a member with none is a real
   *  "no usage" rather than us simply not knowing. */
  usageKnown: boolean;
}) {
  // Token spend — billing row when present, else the local git-shared
  // aggregate. Never zeros-as-truth.
  const spend = m.billing
    ? { tin: m.billing.tokens_in, tout: m.billing.tokens_out, cost: m.billing.cost_usd }
    : m.local
      ? { tin: m.local.tokensIn, tout: m.local.tokensOut, cost: m.local.costUsd }
      : null;
  return (
    <div className="ui-usage-row ui-usage-member">
      <span className="ui-usage-avatar" aria-hidden="true">
        {initialsOf(m.name)}
      </span>

      <div className="ui-usage-member-main">
        <div className="ui-usage-member-name">
          <span>{m.name}</span>
          {qualifier ? <small>{qualifier}</small> : null}
          {m.admin ? <TraceMark>admin</TraceMark> : null}
          {m.isUpstream ? <TraceMark>upstream</TraceMark> : null}
        </div>
        <div className="ui-usage-member-meta">
          {m.commits > 0 ? (
            <span>
              {m.commits} {m.commits === 1 ? "commit" : "commits"}
            </span>
          ) : (
            <span>{m.billing ? "on the org plan, no commits here" : "no commits here yet"}</span>
          )}
          {m.lastSeen > 0 ? (
            <>
              <span aria-hidden>·</span>
              <span>active {relTimeFromTs(m.lastSeen, nowSecs)}</span>
            </>
          ) : null}
        </div>
      </div>

      {/* Provider logos used (only when billing tells us truthfully) */}
      {m.providers.length > 0 ? (
        <div className="ui-usage-providers">
          {m.providers.slice(0, 4).map((p) => (
            <span key={p} title={p}>
              <AgentIcon agentId={p} size={14} />
            </span>
          ))}
        </div>
      ) : null}

      {spend ? (
        <>
          <TokenBar tokensIn={spend.tin} tokensOut={spend.tout} teamMax={teamMaxTokens} />
          <div className="ui-usage-figure">
            <span>{compactNumber(m.tokensTotal)}</span>
            <small>{formatCost(spend.cost)}</small>
          </div>
        </>
      ) : usageKnown ? (
        <span className="ui-usage-none">no usage</span>
      ) : null}
    </div>
  );
}

export function TeamOverview({
  roster,
  billing,
  cloudAvailable,
  localDev = [],
  nowSecs,
  onSignInHint,
}: {
  roster: TeamMember[];
  billing: BillingMemberRow[];
  /** True only when cloud billing returned org-scope data we can trust for
   *  per-dev numbers. False → local usage_by_dev fallback, then roster-only
   *  mode + quiet sign-in hint. */
  cloudAvailable: boolean;
  /** Local per-dev usage rows (already windowed by the parent's report
   *  period). Used as the per-dev numbers when cloud isn't available. */
  localDev?: UsageDeveloper[];
  nowSecs: number;
  /** Optional quiet affordance; if absent the hint is plain text. */
  onSignInHint?: () => void;
}) {
  const localAgg = useMemo(() => aggregateLocalDev(localDev), [localDev]);

  const members = useMemo(
    () => joinMembers(roster, billing, localAgg),
    [roster, billing, localAgg],
  );

  // Local numbers count as "we have per-dev usage" for sorting + hint copy.
  const localAvailable = !cloudAvailable && localAgg.size > 0;

  const sorted = useMemo(() => {
    // Sort by spend when we have per-dev numbers, else by recency of activity.
    const copy = [...members];
    if (cloudAvailable || localAvailable) {
      copy.sort((a, b) => {
        if (b.tokensTotal !== a.tokensTotal) return b.tokensTotal - a.tokensTotal;
        return b.lastSeen - a.lastSeen;
      });
    } else {
      copy.sort((a, b) => {
        if (b.lastSeen !== a.lastSeen) return b.lastSeen - a.lastSeen;
        return b.commits - a.commits;
      });
    }
    return copy;
  }, [members, cloudAvailable, localAvailable]);

  const teamMaxTokens = useMemo(
    () => sorted.reduce((m, x) => Math.max(m, x.tokensTotal), 0),
    [sorted],
  );

  // Machines out of the people list. They still render — dropping them would
  // lose commits the repo really contains — but under their own heading, so
  // "Team · 4" counts colleagues and Aura's own agent stops sitting at the top
  // of a spend list as if it were the most expensive person on the project.
  const people = useMemo(() => sorted.filter((m) => !m.automation), [sorted]);
  const machines = useMemo(() => sorted.filter((m) => m.automation), [sorted]);

  // Display names that appear on more than one seat. Two rows both reading
  // "Ashiq" (different git emails, 3022 commits vs 1) is unreadable; these get
  // their email printed beside the name. We don't merge them — deciding two
  // git identities are one person isn't this view's call to make.
  const ambiguous = useMemo(() => {
    const counts = new Map<string, number>();
    for (const m of people) {
      const k = m.name.trim().toLowerCase();
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    return new Set(
      [...counts.entries()].filter(([, n]) => n > 1).map(([k]) => k),
    );
  }, [people]);

  const qualifierFor = (m: JoinedMember): string =>
    ambiguous.has(m.name.trim().toLowerCase()) ? m.email || m.handle : "";

  if (sorted.length === 0) {
    return (
      <TraceSection title="Team">
        <TraceLine tone="note">
          No teammates yet. As collaborators commit to this repo, they appear here.
        </TraceLine>
      </TraceSection>
    );
  }

  const scope = cloudAvailable ? null : localAvailable ? (
    <span
      className="ui-usage-scope"
      title="Per-developer numbers come from .aura/usage_by_dev.jsonl. Each teammate's own aura usage runs keep their rows fresh, and git syncs the file across clones."
    >
      Local aggregate · shared via git
    </span>
  ) : onSignInHint ? (
    <Button type="button" variant="ghost" size="xs" onClick={onSignInHint}>
      Sign in to Aura Cloud for team usage
    </Button>
  ) : (
    <span className="ui-usage-scope">Sign in to Aura Cloud for team usage</span>
  );

  return (
    <>
      <TraceSection title="Team" count={people.length} trailing={scope}>
        {people.length > 0 ? (
          <div className="ui-usage-rows">
            {people.map((m) => (
              <MemberRow
                key={m.key}
                m={m}
                qualifier={qualifierFor(m)}
                teamMaxTokens={teamMaxTokens}
                nowSecs={nowSecs}
                usageKnown={cloudAvailable || localAvailable}
              />
            ))}
          </div>
        ) : (
          <TraceLine tone="note">
            Only Aura has committed here so far. Teammates appear as they push their first commit.
          </TraceLine>
        )}
      </TraceSection>

      {/* Aura's own agent and the checkpointer commit under their own git
          identities. They belong on the page — those commits are real — but
          they are not colleagues, and in a spend view listing them beside
          people implies somebody is paying them a salary. */}
      {machines.length > 0 ? (
        <TraceSection
          title="Automation"
          trailing={<span className="ui-usage-scope">commits made by Aura, not by a person</span>}
        >
          <div className="ui-usage-rows">
            {machines.map((m) => (
              <MemberRow
                key={m.key}
                m={m}
                qualifier=""
                teamMaxTokens={teamMaxTokens}
                nowSecs={nowSecs}
                usageKnown={false}
              />
            ))}
          </div>
        </TraceSection>
      ) : null}
    </>
  );
}
