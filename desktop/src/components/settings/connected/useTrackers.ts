// The connect / cancel / disconnect plumbing shared by every tracker card.
//
// Lifted whole out of the old IntegrationsTab so the pane above it can be
// about *what is connected* and the cards below it about *one tracker each*.
// Nothing here renders; that is the point.
//
// Configuration values (client_id, client_secret, callback) live in
// `~/.aura/integrations.toml` outside the repo — Aura never asks anyone to
// paste them into a textbox. These calls only ever act on what is already
// configured there.

import { useCallback, useEffect, useMemo, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import {
  integrationsApi,
  type ConnectionStatus,
} from "../../../lib/integrationsApi";
import { upsertStatus } from "./trackerParts";

export type TrackerKind = "jira" | "linear";

/** An error, and which card raised it. The pane used to keep one string and
 *  print it in a banner below every card — so pressing Connect on Jira put
 *  its failure ~470px further down the page, past Linear and Beads, off
 *  screen entirely once a connected Jira card expands. Tagging the error
 *  with its owner lets each card print its own, beside the button. */
export type ScopedError = { kind: TrackerKind; msg: string };

// Atlassian rejects exact-match redirects with port wildcards; the loopback
// port comes from `~/.aura/integrations.toml` and the Rust side fails fast if
// it's already in use. This text appears inline whenever a connect attempt
// errors with "bind …" so the user has a one-shot pointer to the fix.
const PORT_BIND_HINT =
  "Another process is using the loopback port. Edit `redirect_uri` " +
  "in ~/.aura/integrations.toml AND in the Atlassian developer console " +
  "(Authorization tab), then retry.";

export type Trackers = {
  statuses: ConnectionStatus[];
  jira: ConnectionStatus | null;
  linear: ConnectionStatus | null;
  loading: boolean;
  /** We never found out what is connected. Distinct from "nothing is" —
   *  that's an answer, and this is the absence of one. */
  loadError: string | null;
  busyKind: TrackerKind | null;
  error: ScopedError | null;
  /** The authorize URL, for when the system browser didn't pop up. */
  fallbackUrl: string | null;
  refresh: () => Promise<void>;
  connect: (kind: TrackerKind) => Promise<void>;
  cancel: (kind: TrackerKind) => Promise<void>;
  disconnect: (kind: TrackerKind) => Promise<void>;
  setError: (kind: TrackerKind, msg: string | null) => void;
  applyStatus: (next: ConnectionStatus) => void;
};

export function useTrackers(): Trackers {
  const [statuses, setStatuses] = useState<ConnectionStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyKind, setBusyKind] = useState<TrackerKind | null>(null);
  const [error, setErrorState] = useState<ScopedError | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [fallbackUrl, setFallbackUrl] = useState<string | null>(null);

  const setError = useCallback(
    (kind: TrackerKind, msg: string | null) =>
      setErrorState(msg === null ? null : { kind, msg }),
    [],
  );

  const applyStatus = useCallback(
    (next: ConnectionStatus) => setStatuses((prev) => upsertStatus(prev, next)),
    [],
  );

  const refresh = useCallback(async () => {
    setErrorState(null);
    setLoadError(null);
    try {
      setStatuses(await integrationsApi.list());
    } catch (e) {
      setStatuses([]);
      setLoadError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Surface the authorize URL the Rust side emits, so the user can click it
  // manually if the system browser didn't pop up. Both trackers emit their
  // own event; either one fills the same slot, because only one flow is ever
  // open at a time. Cleared once the flow resolves or is cancelled.
  useEffect(() => {
    const stops: UnlistenFn[] = [];
    for (const ev of [
      "aura:integrations:jira:auth_url",
      "aura:integrations:linear:auth_url",
    ]) {
      void listen<string>(ev, (e) => setFallbackUrl(e.payload)).then((u) =>
        stops.push(u),
      );
    }
    return () => {
      for (const s of stops) s();
    };
  }, []);

  const connect = useCallback(
    async (kind: TrackerKind) => {
      setBusyKind(kind);
      setError(kind, null);
      try {
        const next =
          kind === "jira"
            ? await integrationsApi.jiraConnect()
            : await integrationsApi.linearConnect();
        setStatuses((prev) => upsertStatus(prev, next));
        setFallbackUrl(null);
      } catch (e) {
        const msg = String(e);
        if (msg.includes("connect cancelled")) {
          // Pressing Cancel rejects the pending connect — that's the
          // mechanism working, not a failure. It used to print "OAuth flow:
          // connect cancelled" in red, telling the user their own click had
          // gone wrong.
          setError(kind, null);
        } else if (msg.includes("bind 127.0.0.1")) {
          setError(kind, `${msg}\n\n${PORT_BIND_HINT}`);
        } else {
          setError(kind, msg);
        }
      } finally {
        setBusyKind(null);
      }
    },
    [setError],
  );

  const disconnect = useCallback(
    async (kind: TrackerKind) => {
      setBusyKind(kind);
      setError(kind, null);
      try {
        if (kind === "jira") await integrationsApi.jiraDisconnect();
        else await integrationsApi.linearDisconnect();
        await refresh();
      } catch (e) {
        setError(kind, String(e));
      } finally {
        setBusyKind(null);
      }
    },
    [refresh, setError],
  );

  // Cancel fires the cancel signal Rust-side; the pending connect promise then
  // rejects with "connect cancelled" and that catch clears `busyKind`. Nothing
  // is awaited here so the button stays clickable even if Rust takes a tick.
  const cancel = useCallback(
    async (kind: TrackerKind) => {
      setError(kind, null);
      try {
        if (kind === "jira") await integrationsApi.jiraCancel();
        else await integrationsApi.linearCancel();
        setFallbackUrl(null);
      } catch (e) {
        setError(kind, String(e));
      }
    },
    [setError],
  );

  const jira = useMemo(
    () => statuses.find((s) => s.kind === "jira") ?? null,
    [statuses],
  );
  const linear = useMemo(
    () => statuses.find((s) => s.kind === "linear") ?? null,
    [statuses],
  );

  return {
    statuses,
    jira,
    linear,
    loading,
    loadError,
    busyKind,
    error,
    fallbackUrl,
    refresh,
    connect,
    cancel,
    disconnect,
    setError,
    applyStatus,
  };
}
