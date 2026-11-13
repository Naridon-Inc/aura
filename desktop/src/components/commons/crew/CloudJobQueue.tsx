// Hand a job to the always-on machine and bring the finished work back — the
// "keep coding on your Mac → hand a job off → pull the result back" loop, with
// no terminal anywhere: you write what you want done, press Send, and a machine
// that keeps running while your Mac sleeps picks it up. When it's finished you
// press Bring results back and the work lands in your queue, tied to the commit
// (and the proof) that delivered it.
//
// Two real engine verbs, wrapped as Tauri commands so nobody types one:
// Send is `loopCloudSend` (see CloudSendJob); Bring is `loopCloudSync`, which
// pulls finished cloud work home, reports finished local work up, and returns
// how many moved each way with plain notes.
//
// It lives with the Crew, whose board those jobs land on. Settings › Cloud
// computer shows the machines and how to connect one, and no queue: a job is
// work, not a setting, and a queue in Settings read as something the computer
// needed fed before it would do anything.

import { useCallback, useEffect, useState } from "react";
import { CircleCheck, DownloadCloud } from "lucide-react";

import { api } from "../../../lib/api";
import type { CloudSyncResult } from "../../../lib/api";
import { trackFeature } from "../../../lib/track";
import { AsciiSpinner } from "../../ui/ascii-spinner";
import { Button } from "../../ui/button";
import { SettingsError, SettingsGroup } from "../../ui/settings-blocks";
import { SettingsRow } from "../../ui/settings-row";
import { CloudLastSync, CloudSentJobs } from "./CloudRunnerResults";
import { CloudSendJob } from "./CloudSendJob";
import { TERMINAL, type SentJob } from "./cloudRunnerLabels";

export function CloudJobQueue({
  repoRoot,
  connected,
  runsOn,
}: {
  repoRoot: string;
  connected: boolean;
  /** The machine that will pick a job up, or null when none is online. */
  runsOn: string | null;
}) {
  const [syncing, setSyncing] = useState(false);
  const [lastSync, setLastSync] = useState<CloudSyncResult | null>(null);
  const [sent, setSent] = useState<SentJob[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Follow the jobs we sent until they settle. `loopCloudSend` hands back the
  // status at mint time and nothing else ever moves it, so a job that ran and
  // failed sat here reading "Waiting for the machine" indefinitely.
  // The ids still worth asking about, as a stable string so the poll below
  // restarts when the SET changes and not merely when React hands us a new
  // array — the effect writes back into `sent`, and depending on the array
  // itself would make every write re-arm the timer.
  const pendingIds = sent
    .filter((j) => !TERMINAL.has(j.status))
    .map((j) => j.id)
    .join(",");

  useEffect(() => {
    if (!connected || !pendingIds) return;
    const ids = pendingIds.split(",");
    let alive = true;
    const tick = async () => {
      try {
        const states = await api.cloudJobStates(ids);
        if (!alive || states.length === 0) return;
        const byId = new Map(states.map((s) => [s.id, s]));
        setSent((prev) => {
          let changed = false;
          const next = prev.map((j) => {
            const s = byId.get(j.id);
            if (!s) return j;
            if (s.status === j.status && (s.error_message ?? null) === (j.reason ?? null)) {
              return j;
            }
            changed = true;
            return { ...j, status: s.status, reason: s.error_message };
          });
          // Returning `prev` unchanged is what keeps this from re-rendering —
          // and re-arming itself — on every poll that found nothing new.
          return changed ? next : prev;
        });
      } catch {
        /* transient — the next tick tries again */
      }
    };
    void tick();
    const t = setInterval(() => void tick(), 10_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [connected, pendingIds]);

  // The composer owns its own draft; this owns the list it lands in and the
  // one feedback line Send and Bring share.
  const onFeedback = useCallback((n: string | null, e: string | null) => {
    setNote(n);
    setError(e);
  }, []);
  const onSent = useCallback((job: SentJob) => setSent((prev) => [job, ...prev]), []);

  const onSync = useCallback(async () => {
    if (syncing) return;
    setSyncing(true);
    setError(null);
    setNote(null);
    try {
      const res = await api.loopCloudSync(repoRoot, false, false);
      setLastSync(res);
      setNote(
        res.pulled + res.pushed === 0
          ? "Nothing new to bring back yet. Check again once it's finished."
          : `Brought back ${res.pulled} · reported up ${res.pushed}. New results are in your queue.`,
      );
      trackFeature("cloud_sync");
    } catch (e) {
      setError(String(e));
    } finally {
      setSyncing(false);
    }
  }, [repoRoot, syncing]);

  return (
    <>
      <CloudSendJob
        repoRoot={repoRoot}
        connected={connected}
        runsOn={runsOn}
        onFeedback={onFeedback}
        onSent={onSent}
      />

      {/* Bring results back. The heading used to be these same four words,
          three hundred pixels from the button that says them. */}
      <SettingsGroup>
        <SettingsRow
          title="Work the machine has finished"
          description="Pull it into your queue. Each result keeps the commit and the proof that delivered it."
          control={
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void onSync()}
              disabled={!connected || syncing}
            >
              {syncing ? <AsciiSpinner size={10} /> : <DownloadCloud />}
              Bring results back
            </Button>
          }
        />

        {/* Feedback line — the last send/sync outcome or an error. */}
        {error ? (
          <SettingsError>{error}</SettingsError>
        ) : note ? (
          <p className="ui-settings-status ui-cloud-runner-note" role="status">
            <CircleCheck size={13} className="ui-cloud-runner-ok" />
            {note}
          </p>
        ) : null}
      </SettingsGroup>

      {lastSync && <CloudLastSync notes={lastSync.notes} />}
      <CloudSentJobs jobs={sent} />
    </>
  );
}
