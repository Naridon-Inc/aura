// Whether the always-on queue is a real offer for this repository right now.
//
// Sign-in decides whether the queue is offered at all; it used to only gate
// the wording on a switch that was always there, which is how a repository
// with no cloud ended up with a Cloud control whose whole content was an
// apology. Runner liveness then says whether a task drains now or waits.

import { useEffect, useState } from "react";

import { api, missionState } from "../../lib/api";

export type CloudReadiness = {
  checking: boolean;
  /** Signed in to Aura cloud. */
  connected: boolean;
  org?: string | null;
  /** An always-on machine is draining work now; otherwise a task queues. */
  runnerOnline: boolean;
};

export function useCloudReadiness(open: boolean, repoRoot: string | null): CloudReadiness {
  const [state, setState] = useState<CloudReadiness>({
    checking: false,
    connected: false,
    runnerOnline: false,
  });
  // Bumped after a sign-in so the dialog flips from "Set up cloud" to "Send
  // to cloud" without being reopened.
  const [authTick, setAuthTick] = useState(0);
  useEffect(() => {
    const onAuthChanged = () => setAuthTick((n) => n + 1);
    window.addEventListener("aura:cloud-auth-changed", onAuthChanged);
    return () => window.removeEventListener("aura:cloud-auth-changed", onAuthChanged);
  }, []);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setState((c) => ({ ...c, checking: true }));
    void (async () => {
      let connected = false;
      let org: string | null | undefined;
      try {
        const status = await api.cloudAuthStatus();
        connected = status.connected;
        org = status.org_slug;
      } catch {
        /* offline / no cloud — not set up */
      }
      let runnerOnline = false;
      if (connected) {
        // The cloud registry hears every runner's heartbeat, including boxes
        // that leave no trace on this disk. The local mission read is the
        // fallback for a runner on this same Mac when the cloud is unreachable.
        try {
          runnerOnline = (await api.cloudRunners()).some((r) => r.online);
        } catch {
          /* unreachable — fall back to the local read */
        }
        if (!runnerOnline) {
          try {
            const mission = await missionState(repoRoot ? [repoRoot] : undefined);
            runnerOnline = mission.host.online;
          } catch {
            /* no runner known */
          }
        }
      }
      if (!cancelled) setState({ checking: false, connected, org, runnerOnline });
    })();
    return () => {
      cancelled = true;
    };
  }, [open, repoRoot, authTick]);

  return state;
}
