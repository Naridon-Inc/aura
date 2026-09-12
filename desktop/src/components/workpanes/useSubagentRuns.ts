// The desktop's half of reading a session's sub-agent runs.
//
// The durable copy of a run is the cloud's — `aura-cli/src/subagents.rs` says
// so and explains why: the local record is per-person and per-machine, and a
// second copy under `.aura/` would put two records in the tree that can
// disagree. So the app reads it back the same way the console does, over the
// one route named in `subagentRuns.ts`, with the bearer Rust already holds.
//
// It is deliberately silent about failure. Every currently-deployed server
// answers this route with a 404, a signed-out app has no bearer to send, and
// an offline one reaches nothing — and none of those three are worth a red
// card on a session detail. All of them mean the same thing to a reader,
// which is that we do not know, and `SubagentRuns` already has a word for
// that. The lane is simply not there.

import { useEffect, useState } from "react";

import { cloudOrigins } from "../../lib/cloudOrigin";
import { roomAuthHeaders } from "../../lib/roomAuth";
import {
  SUBAGENT_RUNS_MOUNT,
  UNKNOWN_RUNS,
  parseSubagentRuns,
  subagentRunsPath,
  type SubagentRuns,
} from "./subagentRuns";

/** Fetch one session's runs from the cloud this app is signed in to.
 *
 *  Throws on anything that is not a 2xx with a readable body — the caller
 *  turns every throw into "we don't know", so the distinctions are not worth
 *  carrying past here. */
async function fetchRuns(sessionId: string, signal: AbortSignal): Promise<SubagentRuns> {
  // Ask which cloud this app is on rather than writing a literal: an app
  // started against staging or a self-hosted server must not read a
  // production session's workers.
  const { http } = await cloudOrigins();
  const res = await fetch(`${http}${SUBAGENT_RUNS_MOUNT}${subagentRunsPath(sessionId)}`, {
    headers: await roomAuthHeaders(),
    signal,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return { known: true, runs: parseSubagentRuns(await res.json()) };
}

/**
 * What this app knows about `sessionId`'s sub-agents.
 *
 * Pass `null` to ask nothing — which is what the console does, because it has
 * already fetched the runs through its own client and hands them to the pane
 * as a prop. The hook still runs on every render (it must), it simply has no
 * session to ask about, and the browser never issues a request it has no
 * bearer for.
 */
export function useSubagentRuns(sessionId: string | null): SubagentRuns {
  const [state, setState] = useState<SubagentRuns>(UNKNOWN_RUNS);

  useEffect(() => {
    if (!sessionId) {
      setState(UNKNOWN_RUNS);
      return;
    }
    const ctl = new AbortController();
    // Back to not-knowing while the new session is in flight, so opening a
    // second session cannot show the first one's workers under it.
    setState(UNKNOWN_RUNS);
    fetchRuns(sessionId, ctl.signal)
      .then((next) => {
        if (!ctl.signal.aborted) setState(next);
      })
      .catch(() => {
        if (!ctl.signal.aborted) setState(UNKNOWN_RUNS);
      });
    return () => ctl.abort();
  }, [sessionId]);

  return state;
}
