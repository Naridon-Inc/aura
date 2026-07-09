// Per-session memory counters for the agent tab. Asks the backend for
// counts directly via `auraCountIntentsToday` + `auraCountSnapshotsToday`
// with a `sinceTs` of the session start — no JSONL/dir scan in JS, and
// the backend skips JSON parsing on rows that don't pass the cheap
// timestamp prefilter. Polls 20s when visible, pauses when hidden.

import { useEffect, useState } from "react";
import { api } from "./api";
import { useDocumentVisibility } from "./useDocumentVisibility";

const POLL_MS = 20_000;

export type SessionMemory = {
  intents: number;
  snapshots: number;
  loading: boolean;
};

export function useAuraSessionMemory(
  repoRoot: string | null,
  agentId: string | null,
  sessionStartedAt: number | null,
): SessionMemory {
  const [intents, setIntents] = useState(0);
  const [snapshots, setSnapshots] = useState(0);
  const [loading, setLoading] = useState(true);
  const visible = useDocumentVisibility();

  useEffect(() => {
    if (!repoRoot || !agentId || !sessionStartedAt) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    const startedSecs = Math.floor(sessionStartedAt / 1000);

    async function tick() {
      try {
        const [intentCount, snapCount] = await Promise.all([
          api.auraCountIntentsToday(repoRoot!, agentId!, startedSecs),
          api.auraCountSnapshotsToday(repoRoot!, startedSecs),
        ]);
        if (cancelled) return;
        setIntents(intentCount);
        setSnapshots(snapCount);
        setLoading(false);
      } catch {
        if (!cancelled) setLoading(false);
      }
    }

    tick();
    if (!visible) return () => {
      cancelled = true;
    };
    const id = window.setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [repoRoot, agentId, sessionStartedAt, visible]);

  return { intents, snapshots, loading };
}
