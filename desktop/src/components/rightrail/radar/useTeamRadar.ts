// Team Radar state for the Source Control panel. Polls the `aura_radar`
// Tauri command (which drives the `aura radar` CLI) for the ambient
// awareness feed plus the reasoned collisions scored against my own
// in-flight work. The CLI owns all the scoring and noise-damping; this hook
// only ferries the result and owns the "show ripples" toggle.
//
// One hook so the panel stays a thin host. Polling pauses when the window is
// hidden (same cadence discipline as useLiveSync), and every read degrades
// to an empty view rather than throwing — a repo with no awareness events,
// or an older bundled CLI, simply shows nothing.

import { useCallback, useEffect, useState } from "react";
import { api, type RadarCollision, type RadarEvent } from "../../../lib/api";
import { useDocumentVisibility } from "../../../lib/useDocumentVisibility";
import { peekCache, writeCache } from "../../../lib/resourceCache";

const POLL_MS = 6000;

// The ambient feed + scored collisions are cached per (repo, ripple tier) so
// re-entering any surface that mounts this hook — the Commons lounge presence /
// ship log, the Source Control radar band — paints the last-known feed on the
// first frame instead of cold-loading to empty while `aura radar` re-shells
// underneath. Process-lifetime (resourceCache), the same store the roster and
// session caches use: dropped on relaunch, the right lifetime for a live feed.
type RadarSnapshot = { events: RadarEvent[]; conflicts: RadarCollision[] };

function radarCacheKey(repoRoot: string, showRipples: boolean): string {
  return `radar:${repoRoot}:${showRipples ? "ripples" : "core"}`;
}

// A quiet repo returns the same feed poll after poll, so committing the fresh
// arrays unconditionally handed every consumer a new identity every 6s for no
// change at all. Event ids are stable and collisions are keyed by the event
// they were scored from, so identity + severity is enough to tell a real
// change from a re-read.
function sameEvents(prev: RadarEvent[], next: RadarEvent[]): boolean {
  if (prev.length !== next.length) return false;
  return next.every((e, i) => e.id === prev[i].id && e.verified === prev[i].verified);
}

function sameCollisions(prev: RadarCollision[], next: RadarCollision[]): boolean {
  if (prev.length !== next.length) return false;
  return next.every(
    (c, i) => c.event_id === prev[i].event_id && c.severity === prev[i].severity,
  );
}

export type TeamRadar = {
  /** Ambient feed — everyone's recent awareness events (already capped + sorted). */
  events: RadarEvent[];
  /** Reasoned collisions against my own work (the alert layer). */
  conflicts: RadarCollision[];
  /** Whether the weak callgraph-ripple (Possible) tier is included. */
  showRipples: boolean;
  setShowRipples: (v: boolean) => void;
  error: string | null;
  refresh: () => Promise<void>;
};

export function useTeamRadar(repoRoot: string, enabled: boolean): TeamRadar {
  // Seed from the cached snapshot for this repo's core (non-ripple) tier —
  // showRipples starts false — so the feed paints instantly on remount; the
  // effect below revalidates.
  const [events, setEvents] = useState<RadarEvent[]>(
    () => peekCache<RadarSnapshot>(radarCacheKey(repoRoot, false))?.events ?? [],
  );
  const [conflicts, setConflicts] = useState<RadarCollision[]>(
    () => peekCache<RadarSnapshot>(radarCacheKey(repoRoot, false))?.conflicts ?? [],
  );
  const [showRipples, setShowRipples] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const visible = useDocumentVisibility();

  const refresh = useCallback(async () => {
    if (!enabled || !repoRoot) return;
    // Stale-while-revalidate: paint the last-known feed for this (repo, ripple
    // tier) first — so a remount or repo/toggle switch is instant — then fetch.
    const key = radarCacheKey(repoRoot, showRipples);
    const cached = peekCache<RadarSnapshot>(key);
    if (cached) {
      setEvents((prev) => (sameEvents(prev, cached.events) ? prev : cached.events));
      setConflicts((prev) =>
        sameCollisions(prev, cached.conflicts) ? prev : cached.conflicts,
      );
    }
    try {
      const view = await api.auraRadar(repoRoot, showRipples);
      const snap: RadarSnapshot = {
        events: view.events ?? [],
        conflicts: view.conflicts ?? [],
      };
      writeCache(key, snap);
      setEvents((prev) => (sameEvents(prev, snap.events) ? prev : snap.events));
      setConflicts((prev) =>
        sameCollisions(prev, snap.conflicts) ? prev : snap.conflicts,
      );
      setError(null);
    } catch (e) {
      // A failed revalidation keeps the cached feed on screen, never blanks it.
      setError(String(e));
    }
  }, [enabled, repoRoot, showRipples]);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
    if (!visible) return;
    const id = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(id);
  }, [enabled, visible, refresh]);

  return {
    events,
    conflicts,
    showRipples,
    setShowRipples,
    error,
    refresh,
  };
}
