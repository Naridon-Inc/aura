// What a live agent is offering in this folder right now: the slash
// commands it publishes, the modes it can work in, the plan it is working
// to. OpenCode and pi both announce all three while a turn runs; this is
// how that reaches the composer.
//
// Read on demand rather than streamed, because it is session state, not
// transcript — replaying a command list into the conversation history
// would be wrong, and caching it with the brain's static capabilities
// would be wrong too. The turn boundary is the only clock it needs: an
// agent publishes its commands when the session opens and revises its
// plan and mode as it works, so re-reading when a turn ends catches every
// change while never polling an idle app.

import { useCallback, useEffect, useRef, useState } from "react";

import { api, type AgentSurface } from "./api";

const EMPTY: AgentSurface = {
  commands: [],
  modes: [],
  current_mode: null,
  plan: [],
};

/** Whether this brain is one that *hosts* an agent process — the only
 *  kind with a session surface to read. Every other brain is an API key
 *  and a model id, and asking it would build a client to be told nothing. */
export function hostsLiveAgent(providerId: string | null | undefined): boolean {
  if (!providerId) return false;
  return providerId === "pi" || providerId.startsWith("acp:");
}

/** Display name for a live-agent provider id, for badging the commands it
 *  publishes. `acp:opencode` → "OpenCode". Falls back to the id's own stem
 *  capitalised, so an agent added to the Rust table before this map still
 *  gets a readable badge rather than a blank one. */
export function liveAgentLabel(
  providerId: string | null | undefined,
): string | null {
  if (!hostsLiveAgent(providerId) || !providerId) return null;
  const stem = providerId.startsWith("acp:")
    ? providerId.slice("acp:".length)
    : providerId;
  const known: Record<string, string> = {
    opencode: "OpenCode",
    pi: "Pi",
    gemini: "Gemini",
    codex: "Codex",
  };
  return known[stem] ?? stem.charAt(0).toUpperCase() + stem.slice(1);
}

export type UseAgentSurface = {
  surface: AgentSurface;
  /** True when the active brain is one that hosts an agent — i.e. when a
   *  mode switch here would be a real control on a real process rather
   *  than a sentence prepended to the prompt. */
  live: boolean;
  /** Ask the agent to switch mode. Resolves once the agent has accepted;
   *  rejects with the agent's own words if it hasn't. Starting the agent
   *  to answer is part of the job — picking plan mode before typing is
   *  exactly when it matters most. */
  setMode: (mode: string) => Promise<void>;
  /** Last mode switch that didn't take, or null. Worth showing: plan mode
   *  is a real edit-refusing control, so "we asked" and "it is in plan
   *  mode" must never read the same. */
  modeError: string | null;
  /** Re-read now. The hook already does this on turn-end; call it after
   *  something else that would change the surface. */
  refresh: () => void;
};

/**
 * Track the live agent's surface for `providerId` in `cwd`.
 *
 * `busy` is the parent's turn flag. The falling edge is the refresh
 * trigger — during a turn the agent is still revising, and after it
 * everything it announced has settled.
 */
export function useAgentSurface(
  providerId: string | null | undefined,
  cwd: string | null | undefined,
  busy: boolean,
): UseAgentSurface {
  const [surface, setSurface] = useState<AgentSurface>(EMPTY);
  const [modeError, setModeError] = useState<string | null>(null);
  const live = hostsLiveAgent(providerId);

  const read = useCallback(async () => {
    if (!live || !providerId || !cwd) {
      setSurface(EMPTY);
      return;
    }
    try {
      setSurface(await api.brainSessionSurface(providerId, cwd));
    } catch {
      // A brain that can't be built (missing key, uninstalled CLI) has no
      // surface — not an error worth a banner, just nothing to show.
      setSurface(EMPTY);
    }
  }, [live, providerId, cwd]);

  // Re-read when the brain or folder changes, and on every turn-end. The
  // ref is what distinguishes "a turn just finished" from "this component
  // rendered while idle", so an idle app makes no calls at all.
  const wasBusy = useRef(busy);
  useEffect(() => {
    const ended = wasBusy.current && !busy;
    wasBusy.current = busy;
    if (busy && !ended) return;
    void read();
  }, [busy, read]);

  const setMode = useCallback(
    async (mode: string) => {
      if (!live || !providerId || !cwd) return;
      try {
        await api.brainSetSessionMode(providerId, cwd, mode);
        setModeError(null);
        // Read back rather than assume: the agent may have opened a
        // session to answer this, and that session came with the mode
        // list this control should be showing.
        await read();
      } catch (e) {
        setModeError(String(e));
        throw e;
      }
    },
    [live, providerId, cwd, read],
  );

  return { surface, live, setMode, modeError, refresh: () => void read() };
}
