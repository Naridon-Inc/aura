// Connecting your own GitHub from wherever it is asked for, without leaving
// for Settings: start a ticket, open GitHub's sign-in, and ask the server
// every two seconds (and whenever the window comes back into view) what
// GitHub said. The token stays on the server; this only learns the outcome.

import { useCallback, useEffect, useRef, useState } from "react";

import {
  myTicketProblem,
  myTicketSettled,
  readMyGithubTicket,
  startMyGithubConnect,
  type MyGithubStart,
} from "../../lib/cloudMyGithub";
import { openExternal } from "../../lib/openExternal";

const ASK_EVERY_MS = 2000;

/** The button's words for where connecting is. */
export function myGithubConnectLabel(starting: boolean, waiting: boolean): string {
  if (starting) return "Opening GitHub…";
  if (waiting) return "Open GitHub again";
  return "Connect your GitHub";
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function useMyGithubConnect(onConnected: (login: string | null) => void) {
  const [waiting, setWaiting] = useState<MyGithubStart | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const done = useRef(onConnected);
  done.current = onConnected;

  useEffect(() => {
    if (!waiting) return;
    let stopped = false;
    const ask = () =>
      readMyGithubTicket(waiting.ticket)
        .then((t) => {
          if (stopped || !myTicketSettled(t.status)) return;
          setWaiting(null);
          const problem = myTicketProblem(t);
          if (problem) return setError(problem);
          done.current(t.login ?? null);
        })
        .catch((e: unknown) => !stopped && setError(messageOf(e)));
    const timer = window.setInterval(ask, ASK_EVERY_MS);
    const back = () => document.visibilityState === "visible" && void ask();
    document.addEventListener("visibilitychange", back);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", back);
    };
  }, [waiting]);

  const connect = useCallback(() => {
    if (starting) return;
    // Already waiting: the GitHub tab was closed or lost; open it again.
    if (waiting) return void openExternal(waiting.authorize_url);
    setError(null);
    setStarting(true);
    startMyGithubConnect()
      .then((start) => {
        setWaiting(start);
        return openExternal(start.authorize_url);
      })
      .catch((e: unknown) => {
        setWaiting(null);
        setError(messageOf(e));
      })
      .finally(() => setStarting(false));
  }, [starting, waiting]);

  return {
    connect,
    error,
    label: myGithubConnectLabel(starting, !!waiting),
  };
}
