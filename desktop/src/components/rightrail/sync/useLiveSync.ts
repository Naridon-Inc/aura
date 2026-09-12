// Live sync state for the Source Control panel. Owns the Go Live toggle
// round-trip plus the polled view of an active session: who's connected
// (sentinel agents), what's flowing in (cross-branch impacts), and which
// nodes diverged (the M1 ConflictedNode store at .aura/conflicts.jsonl).
//
// One hook so ChangesPanel stays a thin host — it renders what this
// returns and never talks to the live/collab API directly. Polling pauses
// when the window is hidden (same cadence discipline as CommitInput).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  type ConflictedNode,
  type ImpactAlert,
} from "../../../lib/api";
import { useDocumentVisibility } from "../../../lib/useDocumentVisibility";
import { fetchAstConflicts, fetchImpacts } from "../../../lib/ambientCache";
import { usePanelActive } from "../../../lib/panelActive";

const POLL_MS = 4000;
// An agent whose heartbeat is older than this reads as "away" — shown
// dimmed rather than dropped, so a peer who steps away doesn't flicker
// out of the list.
const PEER_STALE_SECS = 90;

export type LivePeer = {
  sessionId: string;
  agentId: string;
  lastHeartbeat: number;
  /** Heartbeat older than PEER_STALE_SECS — render dimmed. */
  stale: boolean;
  /** Cloud peers carry the branch they're on — shown in the tooltip. */
  branch?: string;
  /** Where this row came from: a teammate's machine (cloud heartbeat) or
   *  an MCP agent on this machine (local sentinel claim). */
  source: "cloud" | "local";
};

/** A peer as read. `stale` is deliberately not stored: it's a statement
 *  about *now*, so it's computed at merge time against the clock rather
 *  than frozen at whatever moment the read happened to land. */
type PeerRead = Omit<LivePeer, "stale">;

export type LiveSync = {
  /** A live session is running for this repo. */
  live: boolean;
  /** A start/stop round-trip is in flight — disables the toggle. */
  busy: boolean;
  /** Unix seconds the session started, or null when stopped. */
  startedAt: number | null;
  peers: LivePeer[];
  /** Why no teammates can show up (not signed in / no GitHub remote /
   *  cloud unreachable) — rendered instead of an eternal "waiting…". */
  presenceHint: string | null;
  /** Unresolved inbound changes from teammates (cross-branch impacts).
   *  `null` while we haven't managed to read them — an empty list is the
   *  answer "nothing is coming in", and the section hides itself on it, so
   *  it may not stand in for a read that failed. */
  incoming: ImpactAlert[] | null;
  /** Open (unresolved) semantic conflicts — same node edited two ways.
   *  `null` when unread, for the same reason, and it matters more here: a
   *  hidden Conflicts section reads as "nobody has touched your work". */
  conflicts: ConflictedNode[] | null;
  error: string | null;
  goLive: () => Promise<void>;
  stopLive: () => Promise<void>;
  refresh: () => Promise<void>;
};

// ─── Cheap identity checks ───────────────────────────────────────────────
// Compare the fields the rows actually render, never the whole payload. A
// peer's heartbeat ticks every poll by design, so it is deliberately NOT part
// of identity — only who's here, where they are, and whether they've gone
// stale, which is all the list draws.

function samePeers(a: LivePeer[], b: LivePeer[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (
      a[i].sessionId !== b[i].sessionId ||
      a[i].agentId !== b[i].agentId ||
      a[i].stale !== b[i].stale ||
      a[i].branch !== b[i].branch ||
      a[i].source !== b[i].source
    ) {
      return false;
    }
  }
  return true;
}

function sameImpacts(a: ImpactAlert[], b: ImpactAlert[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id || a[i].resolved !== b[i].resolved) return false;
  }
  return true;
}

function sameConflicts(a: ConflictedNode[], b: ConflictedNode[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id || a[i].resolved_at !== b[i].resolved_at) {
      return false;
    }
  }
  return true;
}

/** setState that keeps the previous array when the contents match, so an
 *  unchanged poll costs no re-render downstream. A `null` current is always
 *  replaced: unread and empty are different answers here, and moving from one
 *  to the other is a real change. */
function keepIfSame<T>(
  set: (fn: (cur: T[] | null) => T[] | null) => void,
  next: T[],
  eq: (a: T[], b: T[]) => boolean,
): void {
  set((cur) => (cur !== null && eq(cur, next) ? cur : next));
}

export function useLiveSync(repoRoot: string, enabled: boolean): LiveSync {
  const [live, setLive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  // Kept apart so one source failing can't erase the other. Teammates come
  // from cloud presence, MCP agents on this machine from the local sentinel;
  // they used to be merged into one `peers` array that every tick rewrote
  // wholesale, so a failed sentinel read emptied the agents out of the list.
  const [cloudRead, setCloudRead] = useState<PeerRead[]>([]);
  const [localRead, setLocalRead] = useState<PeerRead[]>([]);
  // When the last poll attempt ran — the clock `stale` is measured against.
  // Bumped on every attempt, including ones whose reads failed, so a peer
  // doesn't sit there looking fresh forever just because we stopped being
  // able to ask about them.
  const [readAt, setReadAt] = useState(() => Date.now() / 1000);
  const [presenceHint, setPresenceHint] = useState<string | null>(null);
  const [incoming, setIncoming] = useState<ImpactAlert[] | null>(null);
  const [conflicts, setConflicts] = useState<ConflictedNode[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const visible = useDocumentVisibility();
  const panelActive = usePanelActive();

  // `readAt` moves on every poll by design, so this memo re-runs every tick
  // even when nobody moved — and handing back a fresh array re-rendered the
  // whole list for nothing. Keep the previous one when it still says the same
  // thing; `stale` is part of that comparison, so a peer going away still
  // lands.
  const peersRef = useRef<LivePeer[]>([]);
  const peers = useMemo<LivePeer[]>(() => {
    const next = [...cloudRead, ...localRead].map((p) => ({
      ...p,
      stale: readAt - p.lastHeartbeat > PEER_STALE_SECS,
    }));
    if (samePeers(peersRef.current, next)) return peersRef.current;
    peersRef.current = next;
    return next;
  }, [cloudRead, localRead, readAt]);

  const refresh = useCallback(async () => {
    if (!enabled || !repoRoot) return;
    try {
      const status = await api.auraLiveStatus(repoRoot);
      setLive(status.running);
      setStartedAt(status.started_at);
      if (!status.running) {
        // Nothing is running, so "none of any of it" is the true answer
        // here — not a stand-in for one we couldn't get.
        setCloudRead([]);
        setLocalRead([]);
        setPresenceHint(null);
        keepIfSame(setIncoming, [], sameImpacts);
        keepIfSame(setConflicts, [], sameConflicts);
        // The daemon died on its own (vs. an explicit stop) — surface its
        // stderr tail so the toggle flipping off is never a silent mystery.
        if (status.last_error) {
          setError(
            status.exit_code != null
              ? `Live sync stopped (exit ${status.exit_code}): ${status.last_error}`
              : `Live sync stopped: ${status.last_error}`,
          );
        }
        return;
      }
      // Only pull the heavier collab views once a session is actually up.
      // Each source fails independently — a failing impacts read shouldn't
      // blank out the peer list. Independently, though, means *each one
      // keeps what it had*: resolving a failure to `[]` published "there is
      // nothing here", which for Conflicts is the difference between a
      // section that says a teammate has diverged from your work and no
      // section at all. Presence is the exception and already honest — it
      // reports why it couldn't answer, and that reason gets rendered.
      const [agents, presence, impacts, confs] = await Promise.all([
        api.sentinelAgents(repoRoot).catch(() => null),
        api
          .auraLivePeers(repoRoot)
          .catch((e) => ({
            available: false,
            reason: String(e),
            peers: [],
          })),
        fetchImpacts(repoRoot).catch(() => null),
        fetchAstConflicts(repoRoot).catch(() => null),
      ]);
      setReadAt(Date.now() / 1000);
      // Teammates on other machines come from cloud presence (the live
      // daemon's heartbeats); MCP agents on this machine come from local
      // sentinel claims. Own session is filtered — "peers" means others.
      setCloudRead(
        presence.peers
          .filter((p) => !p.is_self)
          .map((p) => {
            const hb = Date.parse(p.last_seen) / 1000;
            return {
              sessionId: `cloud:${p.username}`,
              agentId: p.username,
              lastHeartbeat: Number.isFinite(hb) ? hb : 0,
              branch: p.branch || undefined,
              source: "cloud" as const,
            };
          }),
      );
      if (agents)
        setLocalRead(
          agents.map((a) => ({
            sessionId: a.session_id,
            agentId: a.agent_id,
            lastHeartbeat: a.last_heartbeat,
            source: "local" as const,
          })),
        );
      setPresenceHint(presence.available ? null : presence.reason);
      if (impacts) keepIfSame(setIncoming, impacts.filter((i) => !i.resolved), sameImpacts);
      if (confs)
        keepIfSame(
          setConflicts,
          confs.filter((c) => c.resolved_at == null),
          sameConflicts,
        );
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, [enabled, repoRoot]);

  useEffect(() => {
    if (!enabled || !panelActive) return;
    void refresh();
    if (!visible) return;
    const id = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(id);
  }, [enabled, visible, panelActive, refresh]);

  const goLive = useCallback(async () => {
    if (!repoRoot) return;
    setBusy(true);
    try {
      // collab = true → `aura live start --collab` → whole-file CRDT is
      // the sole disk writer (M1). The desktop Go Live always means collab;
      // plain function-body live-sync stays a terminal-only mode.
      await api.auraLiveStart(repoRoot, true);
      setError(null);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [repoRoot, refresh]);

  const stopLive = useCallback(async () => {
    if (!repoRoot) return;
    setBusy(true);
    try {
      await api.auraLiveStop(repoRoot);
      setError(null);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [repoRoot, refresh]);

  return {
    live,
    busy,
    startedAt,
    peers,
    presenceHint,
    incoming,
    conflicts,
    error,
    goLive,
    stopLive,
    refresh,
  };
}
