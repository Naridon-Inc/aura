// Live sync state for the Source Control panel. Owns the Go Live toggle
// round-trip plus the polled view of an active session: who's connected
// (sentinel agents), what's flowing in (cross-branch impacts), and which
// nodes diverged (the M1 ConflictedNode store at .aura/conflicts.jsonl).
//
// One hook so ChangesPanel stays a thin host — it renders what this
// returns and never talks to the live/collab API directly. Polling pauses
// when the window is hidden (same cadence discipline as CommitInput).

import { useCallback, useEffect, useState } from "react";
import {
  api,
  type ConflictedNode,
  type ImpactAlert,
} from "../../../lib/api";
import { useDocumentVisibility } from "../../../lib/useDocumentVisibility";

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
  /** Unresolved inbound changes from teammates (cross-branch impacts). */
  incoming: ImpactAlert[];
  /** Open (unresolved) semantic conflicts — same node edited two ways. */
  conflicts: ConflictedNode[];
  error: string | null;
  goLive: () => Promise<void>;
  stopLive: () => Promise<void>;
  refresh: () => Promise<void>;
};

export function useLiveSync(repoRoot: string, enabled: boolean): LiveSync {
  const [live, setLive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [peers, setPeers] = useState<LivePeer[]>([]);
  const [presenceHint, setPresenceHint] = useState<string | null>(null);
  const [incoming, setIncoming] = useState<ImpactAlert[]>([]);
  const [conflicts, setConflicts] = useState<ConflictedNode[]>([]);
  const [error, setError] = useState<string | null>(null);
  const visible = useDocumentVisibility();

  const refresh = useCallback(async () => {
    if (!enabled || !repoRoot) return;
    try {
      const status = await api.auraLiveStatus(repoRoot);
      setLive(status.running);
      setStartedAt(status.started_at);
      if (!status.running) {
        setPeers([]);
        setPresenceHint(null);
        setIncoming([]);
        setConflicts([]);
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
      // Each source degrades to empty independently — a failing impacts
      // read shouldn't blank out the peer list.
      const [agents, presence, impacts, confs] = await Promise.all([
        api.sentinelAgents(repoRoot).catch(() => []),
        api
          .auraLivePeers(repoRoot)
          .catch((e) => ({
            available: false,
            reason: String(e),
            peers: [],
          })),
        api.auraReadImpacts(repoRoot).catch(() => []),
        api.auraConflictsList(repoRoot).catch(() => []),
      ]);
      const nowSec = Date.now() / 1000;
      // Teammates on other machines come from cloud presence (the live
      // daemon's heartbeats); MCP agents on this machine come from local
      // sentinel claims. Own session is filtered — "peers" means others.
      const cloudPeers: LivePeer[] = presence.peers
        .filter((p) => !p.is_self)
        .map((p) => {
          const hb = Date.parse(p.last_seen) / 1000;
          const lastHeartbeat = Number.isFinite(hb) ? hb : 0;
          return {
            sessionId: `cloud:${p.username}`,
            agentId: p.username,
            lastHeartbeat,
            stale: nowSec - lastHeartbeat > PEER_STALE_SECS,
            branch: p.branch || undefined,
            source: "cloud" as const,
          };
        });
      const localPeers: LivePeer[] = agents.map((a) => ({
        sessionId: a.session_id,
        agentId: a.agent_id,
        lastHeartbeat: a.last_heartbeat,
        stale: nowSec - a.last_heartbeat > PEER_STALE_SECS,
        source: "local" as const,
      }));
      setPeers([...cloudPeers, ...localPeers]);
      setPresenceHint(presence.available ? null : presence.reason);
      setIncoming(impacts.filter((i) => !i.resolved));
      setConflicts(confs.filter((c) => c.resolved_at == null));
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, [enabled, repoRoot]);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
    if (!visible) return;
    const id = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(id);
  }, [enabled, visible, refresh]);

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
