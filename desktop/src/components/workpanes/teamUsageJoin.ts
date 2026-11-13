// Who spent what: the git roster joined to the cloud's per-member billing and
// to the local git-shared per-developer usage rows, one entry per person. The
// Team section of Cost & usage draws these; the matching rules live here so
// the drawing stays a drawing.

import type { BillingMemberRow, TeamMember, UsageDeveloper } from "../../lib/api";
import { isAutomationIdentity } from "../../lib/agentIdentity";
import { providerForModel } from "./usageProviders";

/** A teammate joined from roster + (optional) billing. `billing` is null when
 *  this person has no cloud usage row this month (or cloud is unavailable). */
export type JoinedMember = {
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
export type LocalDevAgg = {
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
export function aggregateLocalDev(rows: UsageDeveloper[]): Map<string, LocalDevAgg> {
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
export function joinMembers(
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
