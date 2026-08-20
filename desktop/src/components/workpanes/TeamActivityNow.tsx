// TeamActivityNow — the live "Right now" summary at the top of the Trace
// Overview. It answers, at a glance, "what is everyone on this project doing
// this second?" by braiding three real signals, scoped to THIS repo:
//
//   1. Live agent claims  (api.sentinelAgents) — a coding agent whose
//      heartbeat is fresh (<60s) and the function/file it is editing now.
//   2. Teammate statuses  (roster activity_text / status_emoji) — a human's
//      manually-set status, shown when they've set one.
//   3. Recent intents     (the intent log rows the pane already loaded) — the
//      last thing an agent did in the past hour, for agents that aren't
//      currently heartbeating so the line still reads "12m ago · <intent>".
//
// HONESTY RULE (inherited from OverviewPane): every line is a real, observed
// signal. Stale heartbeats are dropped, not shown as "live". When there is
// genuinely nothing happening we either render a calm "All quiet" line (when
// there's a team to summarise) or nothing at all (solo) — never invented work.

import { useEffect, useMemo, useState } from "react";
import {
  api,
  type ClaudeSession,
  type IntentRow,
  type SentinelAgent,
  type TeamMember,
} from "../../lib/api";
import { useDocumentVisibility } from "../../lib/useDocumentVisibility";
import { peekCache, writeCache } from "../../lib/resourceCache";
import { sessionDisplayTitle } from "../../lib/sessionMeta";
import { AgentIcon } from "../agent/AgentIcon";
import { initialsOf, providerLabel, relTimeFromTs } from "./usageProviders";

const HEARTBEAT_WINDOW_S = 60;
const RECENT_WINDOW_S = 60 * 60; // an intent within the last hour still reads "now-ish"
const POLL_MS = 6000;
const MAX_VISIBLE = 6;
const DESKTOP_SESSION = "desktop";

/** Cache the live sentinel claims per repo so re-opening the Overview paints
 *  the last-known "Right now" line instantly instead of flashing "All quiet"
 *  until the first poll lands. Stale heartbeats are still dropped by the memo
 *  below, so a warm-but-old cache never shows anyone as falsely live. */
function agentsCacheKey(repoRoot: string): string {
  return `teamActivity:agents:${repoRoot}`;
}

/** One live activity line — an agent claim, a human status, or a recent intent. */
type Line = {
  key: string;
  kind: "agent" | "human";
  /** AgentIcon id when kind === "agent". */
  agentId: string;
  name: string;
  detail: string;
  /** Human status emoji (kind === "human"). */
  emoji?: string;
  /** Unix seconds of the signal — heartbeat, last_seen, or intent ts. */
  tsSecs: number;
  live: boolean;
};

/** Last path segment of a claim's file_path — "src/foo/bar.rs" → "bar.rs". */
function shortFile(path: string): string {
  const p = (path ?? "").replace(/[/\\]+$/, "");
  if (!p) return "";
  const parts = p.split(/[/\\]+/);
  return parts[parts.length - 1] || p;
}

/** Collapse an intent to one tidy line, truncated so a long backfill summary
 *  doesn't blow out the row. */
function oneLine(s: string, max = 84): string {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1).trimEnd()}…`;
}

export function TeamActivityNow({
  repoRoot,
  roster,
  rows,
  sessions = [],
  hasTeam,
}: {
  repoRoot: string;
  roster: TeamMember[];
  /** Recent intent rows already loaded by the pane (newest-first-ish). */
  rows: IntentRow[];
  /** Claude sessions — lets a recent `[auto]` stub line show the agent's real
   *  prompt instead of the "[auto] … backfill pending" placeholder. */
  sessions?: ClaudeSession[];
  /** True when there's a team to summarise (roster >1 or cloud org) — drives
   *  whether we show a calm "All quiet" line vs render nothing when idle. */
  hasTeam: boolean;
}) {
  const [agents, setAgents] = useState<SentinelAgent[]>(
    () => peekCache<SentinelAgent[]>(agentsCacheKey(repoRoot)) ?? [],
  );
  const [nowS, setNowS] = useState(() => Math.floor(Date.now() / 1000));
  const visible = useDocumentVisibility();

  // Poll the per-repo sentinel claims. Mirrors usePresence's cadence + gating
  // but keeps the whole agent record (not just gutter markers) so we can show
  // who's editing what. The same tick advances our clock so relative times
  // and the heartbeat gate stay fresh between renders.
  useEffect(() => {
    if (!repoRoot) {
      setAgents([]);
      return;
    }
    let cancelled = false;
    // Stale-while-revalidate: seed already painted the cached claims; refresh
    // and write through, but a failed poll keeps the last-known claims rather
    // than blanking the line.
    const key = agentsCacheKey(repoRoot);
    const cached = peekCache<SentinelAgent[]>(key);
    if (cached) setAgents(cached);
    async function tick() {
      try {
        const list = await api.sentinelAgents(repoRoot);
        if (!cancelled) {
          writeCache(key, list);
          setAgents(list);
        }
      } catch {
        // Keep the last-known claims on a transient poll failure; only blank
        // when nothing was ever cached (a genuine cold, empty state).
        if (!cancelled && !peekCache<SentinelAgent[]>(key)) setAgents([]);
      }
      if (!cancelled) setNowS(Math.floor(Date.now() / 1000));
    }
    void tick();
    if (!visible) return;
    const id = window.setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [repoRoot, visible]);

  const lines = useMemo<Line[]>(() => {
    // 1. Live agents — freshest claim per agent, heartbeat-gated.
    const liveByAgent = new Map<string, Line>();
    for (const a of agents) {
      if (a.session_id === DESKTOP_SESSION) continue;
      if (nowS - a.last_heartbeat > HEARTBEAT_WINDOW_S) continue;
      const k = (a.agent_id || a.session_id).toLowerCase();
      const claim = [...a.claims].sort((x, y) => y.claimed_at - x.claimed_at)[0];
      const detail = claim
        ? `editing ${claim.function_name || "code"}${
            claim.file_path ? ` in ${shortFile(claim.file_path)}` : ""
          }`
        : "working";
      const prev = liveByAgent.get(k);
      if (!prev || a.last_heartbeat > prev.tsSecs) {
        liveByAgent.set(k, {
          key: `live:${k}`,
          kind: "agent",
          agentId: a.agent_id || "agent",
          name: providerLabel(a.agent_id || "agent"),
          detail,
          tsSecs: a.last_heartbeat,
          live: true,
        });
      }
    }

    // 2. Human statuses — teammates who set an activity/emoji.
    const humanLines: Line[] = [];
    for (const m of roster) {
      const text = (m.activity_text ?? "").trim();
      const emoji = (m.status_emoji ?? "").trim();
      if (!text && !emoji) continue;
      humanLines.push({
        key: `hum:${m.handle || m.email}`,
        kind: "human",
        agentId: "",
        name: m.name || m.handle || m.email,
        detail: text || "set a status",
        emoji: emoji || undefined,
        tsSecs: m.last_seen,
        live: m.last_seen > 0 && nowS - m.last_seen <= HEARTBEAT_WINDOW_S,
      });
    }

    // 3. Recent intents — last action per agent NOT already live, within 1h.
    const recentByAgent = new Map<string, Line>();
    for (const r of rows) {
      if (nowS - r.timestamp > RECENT_WINDOW_S) continue;
      const k = ((r.agent_id ?? "").toLowerCase() || "unknown").trim();
      if (liveByAgent.has(k)) continue;
      const prev = recentByAgent.get(k);
      if (!prev || r.timestamp > prev.tsSecs) {
        // Relabel a guard `[auto]` stub with the agent's real prompt — the same
        // human title the Sessions list shows — so "Right now" never reads
        // "[auto] … backfill pending".
        recentByAgent.set(k, {
          key: `recent:${k}`,
          kind: "agent",
          agentId: r.agent_id || "agent",
          name: providerLabel(r.agent_id || "agent"),
          detail: oneLine(sessionDisplayTitle(r, sessions)),
          tsSecs: r.timestamp,
          live: false,
        });
      }
    }

    return [
      ...liveByAgent.values(),
      ...recentByAgent.values(),
      ...humanLines,
    ].sort((a, b) => {
      if (a.live !== b.live) return a.live ? -1 : 1;
      return b.tsSecs - a.tsSecs;
    });
  }, [agents, roster, rows, sessions, nowS]);

  const liveCount = useMemo(() => lines.filter((l) => l.live).length, [lines]);

  // Nothing to say: stay silent for solo idle; show a calm note for a team.
  if (lines.length === 0 && !hasTeam) return null;

  const visibleLines = lines.slice(0, MAX_VISIBLE);
  const overflow = lines.length - visibleLines.length;

  return (
    <div className="mx-auto max-w-[760px] px-4 pt-4">
      {/* Not a card. This is the page's opening line — who is working right
          now — and it used to be drawn as a bordered, filled box identical to
          the four stat boxes below it, which said the two were the same kind
          of thing. They aren't: this is a sentence, those are figures. A
          heading and its lines need no walls. */}
      <div>
        <div className="mb-2 flex items-baseline justify-between">
          <span className="section-label">
            Right now
          </span>
          {liveCount > 0 ? (
            <span className="flex items-center gap-1.5 text-xs text-text-4">
              <span
                className="inline-block h-1.5 w-1.5 rounded-full"
                style={{ background: "var(--color-accent-green)" }}
              />
              {liveCount} active
            </span>
          ) : null}
        </div>

        {lines.length === 0 ? (
          // The card is already headed "Right now" — it used to close with
          // "…no active sessions right now", so a 40px-tall card said its own
          // scope twice and spent its one sentence on the half the reader
          // already had. What's worth saying instead is what it means: nothing
          // is running, so nothing is changing under you.
          <div className="py-1.5 text-sm text-text-4">
            All quiet. Nothing is running, so nothing is changing under you.
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {visibleLines.map((l) => (
              <div key={l.key} className="flex items-center gap-2.5">
                {l.kind === "agent" ? (
                  <span
                    className="shrink-0 rounded-full p-0.5"
                    style={{ background: "var(--color-bg-content)" }}
                  >
                    <AgentIcon agentId={l.agentId} size={18} />
                  </span>
                ) : (
                  <span className="relative shrink-0">
                    <span
                      className="flex h-[22px] w-[22px] items-center justify-center rounded-full text-2xs font-semibold text-text-2"
                      style={{ background: "var(--color-bg-2)" }}
                      aria-hidden="true"
                    >
                      {initialsOf(l.name)}
                    </span>
                    {l.emoji ? (
                      <span
                        className="absolute -bottom-1 -right-1 flex h-3.5 w-3.5 items-center justify-center rounded-full border border-bg-1 bg-bg-1"
                        style={{ fontSize: 9, lineHeight: 1 }}
                        aria-hidden
                      >
                        {l.emoji}
                      </span>
                    ) : null}
                  </span>
                )}

                <div className="flex min-w-0 flex-1 items-baseline gap-1.5">
                  <span className="shrink-0 text-base font-medium text-text-1">
                    {l.name}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm text-text-3">
                    {l.detail}
                  </span>
                </div>

                <span className="shrink-0 text-xs text-text-4">
                  {l.live ? (
                    <span className="flex items-center gap-1">
                      <span
                        className="inline-block h-1.5 w-1.5 rounded-full"
                        style={{ background: "var(--color-accent-green)" }}
                      />
                      now
                    </span>
                  ) : (
                    relTimeFromTs(l.tsSecs, nowS)
                  )}
                </span>
              </div>
            ))}
            {overflow > 0 ? (
              <span className="text-xs text-text-4">+{overflow} more</span>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
