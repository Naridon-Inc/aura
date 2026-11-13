// Settings → Agents → registry agents: the list and what can be done to it.
//
// One action per agent at a time; the row holds a loader while it runs.
// Installing an agent whose maker publishes no checksum, and removing one,
// both ask first.

import { useCallback, useEffect, useState } from "react";

import { askConfirm } from "../../ui/ask";
import {
  acpAgentsApi,
  staleVersion,
  withRow,
  type AcpAgentRow,
  type AcpListedSession,
} from "../../../lib/acpAgents";
import { toast } from "../../../lib/toast";

export type AcpAction = "install" | "uninstall" | "forget";

export type AcpAgents = {
  rows: AcpAgentRow[] | null;
  error: string | null;
  refreshing: boolean;
  /** What is running for each agent id. */
  busy: Record<string, AcpAction>;
  refresh: () => Promise<void>;
  install: (row: AcpAgentRow) => Promise<void>;
  uninstall: (row: AcpAgentRow) => Promise<void>;
  forgetSignIn: (row: AcpAgentRow) => Promise<void>;
};

export function useAcpAgents(): AcpAgents {
  const [rows, setRows] = useState<AcpAgentRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState<Record<string, AcpAction>>({});

  const load = useCallback(async (refresh: boolean) => {
    setRefreshing(true);
    try {
      setRows(await acpAgentsApi.list(refresh));
      setError(null);
    } catch (e) {
      setError(`Aura couldn’t read the agent registry: ${String(e)}`);
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  const run = useCallback(async (row: AcpAgentRow, action: AcpAction, work: () => Promise<void>) => {
    setBusy((b) => ({ ...b, [row.id]: action }));
    try {
      await work();
    } finally {
      setBusy(({ [row.id]: _, ...rest }) => rest);
    }
  }, []);

  const install = useCallback(
    async (row: AcpAgentRow) => {
      if (row.unverified) {
        const ok = await askConfirm({
          title: `Install ${row.name} without a checksum?`,
          body: `${row.name}’s maker publishes no checksum for this download, so Aura can’t check that it is the file they released. Install it only if you trust where it comes from.`,
          confirmLabel: "Install",
          tone: "danger",
        });
        if (!ok) return;
      }
      const updating = staleVersion(row) !== null;
      await run(row, "install", async () => {
        try {
          const next = await acpAgentsApi.install(row.id, row.unverified);
          setRows((all) => withRow(all ?? [], next));
          toast.success(updating ? `${row.name} updated` : `${row.name} installed`, `Version ${next.version}.`);
        } catch (e) {
          toast.danger(updating ? `Couldn’t update ${row.name}` : `Couldn’t install ${row.name}`, String(e));
        }
      });
    },
    [run],
  );

  const uninstall = useCallback(
    async (row: AcpAgentRow) => {
      const ok = await askConfirm({
        title: `Uninstall ${row.name}?`,
        body: `Aura removes the copy it installed. Your chats with ${row.name} stay where ${row.name} keeps them, and you can install it again any time.`,
        confirmLabel: "Uninstall",
        tone: "danger",
      });
      if (!ok) return;
      await run(row, "uninstall", async () => {
        try {
          await acpAgentsApi.uninstall(row.id);
          await load(false);
        } catch (e) {
          toast.danger(`Couldn’t uninstall ${row.name}`, String(e));
        }
      });
    },
    [load, run],
  );

  const forgetSignIn = useCallback(
    async (row: AcpAgentRow) => {
      await run(row, "forget", async () => {
        try {
          await acpAgentsApi.forgetSignIn(row.id);
          setRows((all) => (all ?? []).map((r) => (r.id === row.id ? { ...r, signed_in_with: null } : r)));
        } catch (e) {
          toast.danger(`Couldn’t forget ${row.name}’s sign-in`, String(e));
        }
      });
    },
    [run],
  );

  return { rows, error, refreshing, busy, refresh: () => load(true), install, uninstall, forgetSignIn };
}

export type AcpSessions = {
  sessions: AcpListedSession[] | null;
  loading: boolean;
  error: string | null;
  look: () => Promise<void>;
};

/** An agent's own saved chats for a project. Asking starts the agent, so
 *  it waits for the person to ask. */
export function useAcpSessions(id: string, repoRoot: string): AcpSessions {
  const [sessions, setSessions] = useState<AcpListedSession[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSessions(null);
    setError(null);
  }, [id, repoRoot]);

  const look = useCallback(async () => {
    if (!repoRoot) return;
    setLoading(true);
    try {
      setSessions(await acpAgentsApi.sessions(id, repoRoot));
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [id, repoRoot]);

  return { sessions, loading, error, look };
}
