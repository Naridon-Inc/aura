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

const POLL_MS = 6000;

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
  const [events, setEvents] = useState<RadarEvent[]>([]);
  const [conflicts, setConflicts] = useState<RadarCollision[]>([]);
  const [showRipples, setShowRipples] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const visible = useDocumentVisibility();

  const refresh = useCallback(async () => {
    if (!enabled || !repoRoot) return;
    try {
      const view = await api.auraRadar(repoRoot, showRipples);
      setEvents(view.events ?? []);
      setConflicts(view.conflicts ?? []);
      setError(null);
    } catch (e) {
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
