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
import { isAutomationIdentity } from "../../lib/agentIdentity";
import { AgentIcon } from "../agent/AgentIcon";
import {
  initialsOf,
  providerForModel,
  relTimeFromTs,
} from "./usageProviders";
import { compactNumber } from "../../lib/compactNumber";
import { formatCost } from "../../lib/money";

/** A teammate joined from roster + (optional) billing. `billing` is null when
 *  this person has no cloud usage row this month (or cloud is unavailable). */
type JoinedMember = {
  key: string;
  name: string;
  handle: string;
  /** Git email, kept so two seats sharing a display name can be told apart.
   *  This repo genuinely has "Ashiq" twice under different addresses. */
  email: string;
  /** A machine, not a teammate — Aura's own agent, the checkpointer, a CI
   *  bot. Listed separately so a *cost* view never counts them as people. */
  automation: boolean;
  commits: number;
  lastSeen: number;
  admin: boolean;
  isUpstream: boolean;
  billing: BillingMemberRow | null;
  /** Canonical provider ids derived from this member's billing by_model. */
  providers: string[];
  tokensTotal: number;
  /** Local git-shared aggregate for this member (usage_by_dev) — the cloud
   *  fallback. null when this person has no local rows in the window. */
  local: LocalDevAgg | null;
};

/** Per-developer roll-up of the local `usage_by_dev` rows: one developer may
 *  have many (month, agent) rows; the team list wants one line per person. */
type LocalDevAgg = {
  developer: string;
  handle: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  /** Agent ids seen for this developer, insertion-ordered. */
  agents: string[];
};

/** Roll raw usage_by_dev rows up to one aggregate per developer email.
 *  Unattributed rows (developer === "") are dropped — they predate identity
 *  stamping and cannot be honestly assigned to a person. */
function aggregateLocalDev(rows: UsageDeveloper[]): Map<string, LocalDevAgg> {
  const out = new Map<string, LocalDevAgg>();
  for (const r of rows) {
    const dev = normKey(r.developer);
    if (!dev) continue;
    let agg = out.get(dev);
    if (!agg) {
      agg = {
        developer: dev,
        handle: r.handle || emailLocal(dev),
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
        agents: [],
      };
      out.set(dev, agg);
    }
    agg.tokensIn += r.inputTokens;
    agg.tokensOut += r.outputTokens;
    agg.costUsd += r.costUsd;
    if (r.agentId && !agg.agents.includes(r.agentId)) agg.agents.push(r.agentId);
  }
  return out;
}

/** Lowercase, '@'-stripped key for fuzzy matching a billing github_login to
 *  a roster handle/email. */
function normKey(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().replace(/^@+/, "").trim();
}

/** Local part of an email ("ada@x.com" → "ada") — a common way a github
 *  login lines up with a git email when handles differ. */
function emailLocal(email: string | null | undefined): string {
  const s = normKey(email);
  const at = s.indexOf("@");
  return at > 0 ? s.slice(0, at) : s;
}

/** Join roster members to billing rows + local usage_by_dev aggregates.
 *  Billing matches on github_login against the member's handle, email,
 *  email-local, or any alias email; local rows match on developer email
 *  (exact / alias / handle). Rows that don't match a roster seat are
 *  appended as usage-only members so spend is never silently dropped. */
function joinMembers(
  roster: TeamMember[],
  billing: BillingMemberRow[],
  localDev: Map<string, LocalDevAgg>,
): JoinedMember[] {
  const used = new Set<number>();
  const usedLocal = new Set<string>();

  const matchLocal = (m: TeamMember): LocalDevAgg | null => {
    const candidates = [normKey(m.email), ...(m.also_emails ?? []).map(normKey)];
    for (const c of candidates) {
      if (c && localDev.has(c) && !usedLocal.has(c)) {
        usedLocal.add(c);
        return localDev.get(c) ?? null;
      }
    }
    // Last resort: handle vs the row's handle (email local-part).
    const h = normKey(m.handle);
    if (h) {
      for (const [key, agg] of localDev) {
        if (!usedLocal.has(key) && agg.handle === h) {
          usedLocal.add(key);
          return agg;
        }
      }
    }
    return null;
  };

  const matchBilling = (m: TeamMember): BillingMemberRow | null => {
    const candidates = new Set<string>();
    candidates.add(normKey(m.handle));
    candidates.add(normKey(m.email));
    candidates.add(emailLocal(m.email));
    for (const a of m.also_emails ?? []) {
      candidates.add(normKey(a));
      candidates.add(emailLocal(a));
    }
    candidates.delete("");
    for (let i = 0; i < billing.length; i++) {
      if (used.has(i)) continue;
      const b = billing[i];
      const login = normKey(b.github_login);
      const disp = normKey(b.display_name);
      if (candidates.has(login) || (login && candidates.has(emailLocal(login)))) {
        used.add(i);
        return b;
      }
      if (disp && candidates.has(disp)) {
        used.add(i);
        return b;
      }
    }
    return null;
  };

  const providersOf = (b: BillingMemberRow | null): string[] => {
    if (!b) return [];
    const seen: string[] = [];
    for (const row of b.by_model) {
      const p = providerForModel(row.provider || row.model);
      if (!seen.includes(p)) seen.push(p);
    }
    return seen;
  };

  const joined: JoinedMember[] = roster.map((m) => {
    const b = matchBilling(m);
    const l = matchLocal(m);
    return {
      key: m.email || m.handle,
      name: m.name || m.handle || m.email,
      handle: m.handle || emailLocal(m.email),
      email: normKey(m.email),
      automation: isAutomationIdentity(m.name, m.email),
      commits: m.commits,
      lastSeen: m.last_seen,
      admin: m.admin,
      isUpstream: m.source === "ancestor",
      billing: b,
      // Provider logos: billing's by_model when present, else the agent ids
      // the local aggregate saw for this developer.
      providers: b ? providersOf(b) : (l?.agents ?? []),
      tokensTotal: b
        ? b.tokens_in + b.tokens_out
        : l
          ? l.tokensIn + l.tokensOut
          : 0,
      local: l,
    };
  });

  // Billing rows with no roster seat (e.g. a teammate who hasn't committed to
  // this repo yet but is on the org plan) — keep them, clearly marked.
  for (let i = 0; i < billing.length; i++) {
    if (used.has(i)) continue;
    const b = billing[i];
    joined.push({
      key: `billing:${b.developer_id}`,
      name: b.display_name || b.github_login || b.developer_id,
      handle: normKey(b.github_login),
      email: "",
      // A billing seat is somebody the org pays for — never a bot.
      automation: false,
      commits: 0,
      lastSeen: 0,
      admin: false,
      isUpstream: false,
      billing: b,
      providers: providersOf(b),
      tokensTotal: b.tokens_in + b.tokens_out,
      local: null,
    });
  }

  // Local rows with no roster seat — a teammate whose usage synced over git
  // before their first commit landed here. Same never-drop rule.
  for (const [key, agg] of localDev) {
    if (usedLocal.has(key)) continue;
    joined.push({
      key: `local:${key}`,
      name: agg.handle || key,
      handle: agg.handle,
      email: key,
      automation: isAutomationIdentity(agg.handle, key),
      commits: 0,
      lastSeen: 0,
      admin: false,
      isUpstream: false,
      billing: null,
      providers: agg.agents,
      tokensTotal: agg.tokensIn + agg.tokensOut,
      local: agg,
    });
  }

  return joined;
}

/** The in/out token mini-bar for a teammate — two stacked segments scaled to
 *  the team-wide max so rows are comparable. Calm at 0.85 / 0.5 opacity. */
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
    <span className="flex h-1.5 w-24 overflow-hidden rounded-full bg-bg-2">
      <span
        className="block h-full"
        style={{
          width: `${(widthPct * inPct) / 100}%`,
          background: "var(--color-accent)",
          opacity: 0.85,
        }}
      />
      <span
        className="block h-full"
        style={{
          width: `${(widthPct * (100 - inPct)) / 100}%`,
          background: "var(--color-accent)",
          opacity: 0.45,
        }}
      />
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
  return (
    <div className="flex items-center gap-2.5 rounded-lg border border-line-soft bg-bg-1 px-3 py-2">
      {/* Avatar monogram */}
      <span
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold text-text-2"
        style={{ background: "var(--color-bg-2)" }}
        aria-hidden="true"
      >
        {initialsOf(m.name)}
      </span>

      {/* Identity + meta */}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-base font-medium text-text-1">
            {m.name}
          </span>
          {qualifier ? (
            <span className="truncate text-xs text-text-4">{qualifier}</span>
          ) : null}
          {m.admin ? (
            <span className="meta-tag">
              admin
            </span>
          ) : null}
          {m.isUpstream ? (
            <span className="meta-tag">
              upstream
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-2 text-xs text-text-4">
          {m.commits > 0 ? (
            <span>
              {m.commits} {m.commits === 1 ? "commit" : "commits"}
            </span>
          ) : (
            <span>cloud only</span>
          )}
          {m.lastSeen > 0 ? (
            <>
              <span className="text-text-4">·</span>
              <span>active {relTimeFromTs(m.lastSeen, nowSecs)}</span>
            </>
          ) : null}
        </div>
      </div>

      {/* Provider logos used (only when billing tells us truthfully) */}
      {m.providers.length > 0 ? (
        <div className="flex shrink-0 items-center -space-x-1">
          {m.providers.slice(0, 4).map((p) => (
            <span
              key={p}
              className="rounded-full p-0.5"
              style={{ background: "var(--color-bg-content)" }}
              title={p}
            >
              <AgentIcon agentId={p} size={15} />
            </span>
          ))}
        </div>
      ) : null}

      {/* Token spend — billing row when present, else the local
          git-shared aggregate. Never zeros-as-truth. */}
      {m.billing ? (
        <div className="flex shrink-0 items-center gap-2">
          <TokenBar
            tokensIn={m.billing.tokens_in}
            tokensOut={m.billing.tokens_out}
            teamMax={teamMaxTokens}
          />
          <div className="flex w-16 flex-col items-end leading-tight">
            <span className="font-mono text-sm text-text-2">
              {compactNumber(m.tokensTotal)}
            </span>
            <span className="font-mono text-2xs text-text-4">
              {formatCost(m.billing.cost_usd)}
            </span>
          </div>
        </div>
      ) : m.local ? (
        <div className="flex shrink-0 items-center gap-2">
          <TokenBar
            tokensIn={m.local.tokensIn}
            tokensOut={m.local.tokensOut}
            teamMax={teamMaxTokens}
          />
          <div className="flex w-16 flex-col items-end leading-tight">
            <span className="font-mono text-sm text-text-2">
              {compactNumber(m.tokensTotal)}
            </span>
            <span className="font-mono text-2xs text-text-4">
              {formatCost(m.local.costUsd)}
            </span>
          </div>
        </div>
      ) : usageKnown ? (
        <span className="shrink-0 text-xs text-text-4">no usage</span>
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
      <section className="flex flex-col gap-2">
        <h3 className="section-label">Team</h3>
        <div className="rounded-lg border border-line-soft bg-bg-1 px-3 py-3 text-center text-sm text-text-4">
          No teammates yet. As collaborators commit to this repo, they appear
          here.
        </div>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <h3 className="section-label">
          Team
          <span className="ml-1.5 font-normal text-text-4">
            · {people.length}
          </span>
        </h3>
        {cloudAvailable ? null : localAvailable ? (
          <span
            className="text-xs text-text-4"
            title="Per-developer numbers come from .aura/usage_by_dev.jsonl. Each teammate's own aura usage runs keep their rows fresh, and git syncs the file across clones."
          >
            Local aggregate · shared via git
          </span>
        ) : onSignInHint ? (
          <button
            type="button"
            onClick={onSignInHint}
            className="text-xs text-text-4 hover:text-text-2"
          >
            Sign in to Aura Cloud for team usage
          </button>
        ) : (
          <span className="text-xs text-text-4">
            Sign in to Aura Cloud for team usage
          </span>
        )}
      </div>

      <div className="flex flex-col gap-2">
        {people.length > 0 ? (
          people.map((m) => (
            <MemberRow
              key={m.key}
              m={m}
              qualifier={qualifierFor(m)}
              teamMaxTokens={teamMaxTokens}
              nowSecs={nowSecs}
              usageKnown={cloudAvailable || localAvailable}
            />
          ))
        ) : (
          <div className="rounded-lg border border-line-soft bg-bg-1 px-3 py-3 text-center text-sm text-text-4">
            Only Aura has committed here so far. Teammates appear as they push
            their first commit.
          </div>
        )}
      </div>

      {/* Aura's own agent and the checkpointer commit under their own git
          identities. They belong on the page — those commits are real — but
          they are not colleagues, and in a spend view listing them beside
          people implies somebody is paying them a salary. */}
      {machines.length > 0 ? (
        <div className="mt-3 flex flex-col gap-2">
          <div className="flex items-baseline gap-2">
            <h3 className="section-label">
              Automation
            </h3>
            <span className="text-xs text-text-4">
              commits made by Aura, not by a person
            </span>
          </div>
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
      ) : null}
    </section>
  );
}
