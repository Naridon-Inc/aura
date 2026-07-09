// Recent-intent reader for the agent SessionInfoCard footer. Asks the
// backend for the latest N entries matching this agent_id directly via
// `auraReadIntentLogV2` — no full-file scan in JS. Polls slowly (15s by
// default) and pauses when the window is hidden.

import { useEffect, useState } from "react";
import { api, type IntentEntry } from "./api";
import { useDocumentVisibility } from "./useDocumentVisibility";

export function useRecentIntents(
  repoRoot: string,
  agentId: string,
  limit = 3,
  intervalMs = 15_000,
): { intents: IntentEntry[]; loading: boolean } {
  const [intents, setIntents] = useState<IntentEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const visible = useDocumentVisibility();

  useEffect(() => {
    let cancelled = false;
    async function tick() {
      try {
        const page = await api.auraReadIntentLogV2(
          repoRoot,
          limit,
          undefined,
          agentId || undefined,
        );
        if (cancelled) return;
        setIntents(page.entries);
        setLoading(false);
      } catch {
        if (!cancelled) setLoading(false);
      }
    }
    tick();
    if (!visible) return () => {
      cancelled = true;
    };
    const id = window.setInterval(tick, intervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [repoRoot, agentId, limit, intervalMs, visible]);

  return { intents, loading };
}

/** Open the History sidebar via custom DOM event. Decoupled from App
 *  state so the deeply-nested SessionInfoCard footer can summon the
 *  sidebar without prop-drilling. App.tsx listens for this and calls
 *  `setActiveSidebarTab("history")`. Mirrors `aura:open-resume`. */
export function dispatchOpenHistory() {
  window.dispatchEvent(new CustomEvent("aura:open-history"));
}
