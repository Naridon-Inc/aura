// Connecting a GitHub account or organization to the org, as one hook for
// Settings → Organization and the setup steps. A round trip through GitHub:
// install the app on the account (GitHub's page picks which repositories),
// sign in to GitHub so the server learns which accounts you may connect, then
// connect one.
//
// Fewer clicks than it used to take:
//  * the server is asked the whole time GitHub is open, so when GitHub signs
//    you in as part of installing, the list arrives without pressing Continue;
//  * when exactly one account can be connected, it is, without asking;
//  * a reload, or coming back from GitHub in a fresh tab, picks up where it
//    was until the ticket runs out, instead of starting again.

import { useCallback, useEffect, useRef, useState } from "react";

import {
  candidateState,
  connectGithub,
  readConnectTicket,
  startConnectGithub,
  ticketSettled,
  type ConnectCandidate,
  type ConnectStart,
  type ConnectTicket,
} from "../../../lib/cloudGithub";
import { messageOf } from "../../../lib/cloudOrgs";

const ASK_EVERY_MS = 2000;
const KEY = "aura.connect-github";
/** How long a ticket lasts when the server doesn't say. */
const DEFAULT_MINUTES = 10;

export type ConnectPhase =
  | { at: "idle" }
  | { at: "starting" }
  | { at: "installing"; start: ConnectStart }
  | { at: "signing_in"; start: ConnectStart }
  | { at: "answered"; start: ConnectStart; ticket: ConnectTicket };

type Saved = { at: "installing" | "signing_in"; start: ConnectStart; until: number };

/** When a ticket that started now runs out. */
export function ticketUntil(start: ConnectStart, now: number): number {
  return now + (start.expires_in_minutes ?? DEFAULT_MINUTES) * 60_000;
}

/** What to keep across a reload: a trip to GitHub still in flight. An answer
 *  is kept as the trip, since asking the ticket again brings it back. */
export function phaseToKeep(phase: ConnectPhase, until: number): Saved | null {
  if (phase.at === "installing" || phase.at === "signing_in") return { at: phase.at, start: phase.start, until };
  if (phase.at === "answered" && phase.ticket.status === "answered")
    return { at: "signing_in", start: phase.start, until };
  return null;
}

/** The kept trip, if there is one and its ticket hasn't run out. */
export function keptPhase(raw: string | null, now: number): Saved | null {
  if (!raw) return null;
  try {
    const kept = JSON.parse(raw) as Partial<Saved>;
    if (kept.at !== "installing" && kept.at !== "signing_in") return null;
    if (typeof kept.until !== "number" || kept.until <= now) return null;
    if (!kept.start || typeof kept.start.ticket !== "string" || typeof kept.start.authorize_url !== "string") return null;
    return kept as Saved;
  } catch {
    return null;
  }
}

/** The account to connect without asking: the only one that can be. */
export function onlyConnectable(ticket: ConnectTicket): ConnectCandidate | null {
  if (ticket.status !== "answered") return null;
  const open = ticket.candidates.filter((c) => candidateState(c).connectable);
  return open.length === 1 ? open[0] : null;
}

function readKept(): string | null {
  try {
    return window.sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

function writeKept(kept: Saved | null) {
  try {
    if (kept) window.sessionStorage.setItem(KEY, JSON.stringify(kept));
    else window.sessionStorage.removeItem(KEY);
  } catch {
    // A private window keeps nothing; the trip still works in this page.
  }
}

async function open(url: string) {
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(url);
}

export function useConnectGithub(onConnected: (note: string) => void) {
  const kept = useRef<Saved | null>(typeof window === "undefined" ? null : keptPhase(readKept(), Date.now()));
  const until = useRef(kept.current?.until ?? 0);
  const [phase, setPhaseNow] = useState<ConnectPhase>(() =>
    kept.current ? { at: kept.current.at, start: kept.current.start } : { at: "idle" },
  );
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<number | null>(null);
  const tried = useRef<string | null>(null);
  const done = useRef(onConnected);
  done.current = onConnected;

  const setPhase = useCallback((next: ConnectPhase) => {
    setPhaseNow(next);
    writeKept(phaseToKeep(next, until.current));
  }, []);

  // While GitHub is open, ask the server what GitHub said — installing too,
  // since GitHub can sign you in as part of installing.
  const asking = phase.at === "signing_in" || phase.at === "installing" ? phase.start : null;
  useEffect(() => {
    if (!asking) return;
    let stopped = false;
    const ask = () =>
      readConnectTicket(asking.ticket)
        .then((ticket) => {
          if (!stopped && ticketSettled(ticket.status)) setPhase({ at: "answered", start: asking, ticket });
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
  }, [asking, setPhase]);

  const begin = useCallback(() => {
    setError(null);
    tried.current = null;
    setPhase({ at: "starting" });
    startConnectGithub()
      .then((start) => {
        until.current = ticketUntil(start, Date.now());
        if (start.install_url) {
          setPhase({ at: "installing", start });
          return open(start.install_url);
        }
        setPhase({ at: "signing_in", start });
        return open(start.authorize_url);
      })
      .catch((e: unknown) => {
        setError(messageOf(e));
        setPhase({ at: "idle" });
      });
  }, [setPhase]);

  const signIn = useCallback(
    (start: ConnectStart) => {
      setError(null);
      setPhase({ at: "signing_in", start });
      open(start.authorize_url).catch((e: unknown) => setError(messageOf(e)));
    },
    [setPhase],
  );

  const reopen = useCallback((url: string) => {
    open(url).catch((e: unknown) => setError(messageOf(e)));
  }, []);

  const connect = useCallback(
    (start: ConnectStart, installationId: number) => {
      setError(null);
      setConnecting(installationId);
      connectGithub(start.ticket, installationId)
        .then((result) => {
          const added = result.repos_imported === 1 ? "1 project" : `${result.repos_imported} projects`;
          setPhase({ at: "idle" });
          done.current(
            result.import_error
              ? `Connected ${result.account_login}. Its projects will appear once GitHub lists them.`
              : `Connected ${result.account_login} · ${added} added.`,
          );
        })
        .catch((e: unknown) => setError(messageOf(e)))
        .finally(() => setConnecting(null));
    },
    [setPhase],
  );

  // One account you can connect: connect it.
  useEffect(() => {
    if (phase.at !== "answered" || connecting !== null || tried.current === phase.start.ticket) return;
    const one = onlyConnectable(phase.ticket);
    if (!one) return;
    tried.current = phase.start.ticket;
    connect(phase.start, one.id);
  }, [phase, connecting, connect]);

  const cancel = useCallback(() => {
    setError(null);
    setPhase({ at: "idle" });
  }, [setPhase]);

  return { phase, error, connecting, begin, signIn, reopen, connect, cancel };
}
