// Cloud — the desktop face of your always-on machine. This is the whole
// "keep coding on your Mac → hand a job off → pull the result back" loop, with
// no terminal anywhere: you write what you want done, press Send, and a machine
// that keeps running while your Mac sleeps picks it up. When it's finished you
// press Bring results back and the work lands in your queue, tied to the commit
// (and the proof) that delivered it.
//
// Everything here rides two real engine verbs, wrapped as Tauri commands so the
// customer never types a command:
//   • Send  → `loopCloudSend`  (mints a job on the shared cloud board a runner
//              drains, scoped to this repo)
//   • Bring → `loopCloudSync`  (pulls finished cloud work home + reports finished
//              local work up; returns how many moved each way + plain notes)
// Sign-in is the same cloud account the top-right avatar manages — we only read
// it here (`cloudAuthStatus`); we never ask for a second login.

import { useCallback, useEffect, useState } from "react";
import {
  Cloud,
  CloudOff,
  DownloadCloud,
  Send,
  CircleCheck,
  CircleAlert,
} from "lucide-react";
import { AsciiSpinner } from "../../ui/ascii-spinner";

import { api } from "../../../lib/api";
import type { CloudAuthStatus, CloudSyncResult } from "../../../lib/api";
import { trackFeature } from "../../../lib/track";
import { Button } from "../../ui/button";
import { Textarea } from "../../ui/textarea";
import { Input } from "../../ui/input";
import { SegmentedControl } from "../../ui/segmented";
import { AgentBit, relativeTime } from "./crewShared";
import { ConnectMachineWizard } from "./ConnectMachineWizard";

// The agents you can hand cloud work to. Kept to the three most common so the
// picker stays a glance, not a menu; the value is the bare provider id the
// backend namespaces as `a2a:<agent>`.
type CloudAgent = "claude" | "codex" | "gemini";
const AGENT_OPTIONS: Array<{ value: CloudAgent; label: string }> = [
  { value: "claude", label: "Claude" },
  { value: "codex", label: "Codex" },
  { value: "gemini", label: "Gemini" },
];

// One job this panel handed to the cloud in this session. We keep our own list
// (rather than inventing a "cloud tasks" feed we can't truthfully populate)
// because the cloud task id + status come straight back from `loopCloudSend` —
// so every row here is a real thing we really sent.
type SentJob = {
  id: string;
  status: string;
  text: string;
  agent: CloudAgent;
  at: number;
};

export function CloudRunnerPanel({ repoRoot }: { repoRoot: string }) {
  const [auth, setAuth] = useState<CloudAuthStatus | null>(null);
  const [authLoading, setAuthLoading] = useState(true);

  const [text, setText] = useState("");
  const [agent, setAgent] = useState<CloudAgent>("claude");
  const [acceptance, setAcceptance] = useState("");
  const [sending, setSending] = useState(false);

  const [syncing, setSyncing] = useState(false);
  const [lastSync, setLastSync] = useState<CloudSyncResult | null>(null);

  const [sent, setSent] = useState<SentJob[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The "bring your own box and turn it into the always-on machine" flow.
  const [showConnect, setShowConnect] = useState(false);

  const refreshAuth = useCallback(async () => {
    setAuthLoading(true);
    try {
      setAuth(await api.cloudAuthStatus());
    } catch {
      // Treat an unreadable status as signed-out — the panel then shows the
      // gentle sign-in prompt rather than a scary error.
      setAuth(null);
    } finally {
      setAuthLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshAuth();
  }, [refreshAuth]);

  const connected = !!auth?.connected;

  const onSend = useCallback(async () => {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    setError(null);
    setNote(null);
    try {
      const res = await api.loopCloudSend(
        repoRoot,
        body,
        agent,
        acceptance.trim() || undefined,
      );
      setSent((prev) => [
        { id: res.id, status: res.status, text: body, agent, at: Date.now() },
        ...prev,
      ]);
      setText("");
      setAcceptance("");
      setNote("Sent. Your always-on machine will pick it up shortly.");
      trackFeature("cloud_send");
    } catch (e) {
      setError(String(e));
    } finally {
      setSending(false);
    }
  }, [text, agent, acceptance, repoRoot, sending]);

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
          ? "Nothing new to bring back yet — check again once it's finished."
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
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-5 px-8 py-6">
        {/* Intro — one plain line; no jargon. */}
        <header className="flex items-start gap-3">
          <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-[8px] bg-accent-soft text-accent">
            <Cloud size={18} />
          </span>
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold text-text-1">
              Your always-on machine
            </h2>
            <p className="mt-0.5 text-[12.5px] leading-snug text-text-4">
              Hand off a job and keep working — a machine that stays awake picks
              it up, and you bring the finished work back with one click.
            </p>
          </div>
        </header>

        {/* Sign-in gate. We don't run a second login here — the top-right
            avatar owns cloud sign-in — we just say so and keep Send/Bring
            disabled until you're connected. */}
        {authLoading ? (
          <div className="flex items-center gap-2 rounded-[8px] border border-line-soft bg-bg-1 px-4 py-3 text-[12.5px] text-text-4">
            <AsciiSpinner />
            Checking your cloud sign-in…
          </div>
        ) : !connected ? (
          <div className="flex items-start gap-3 rounded-[8px] border border-line-soft bg-bg-1 px-4 py-3.5">
            <CloudOff size={17} className="mt-0.5 shrink-0 text-text-4" />
            <div className="min-w-0 text-[12.5px] leading-snug text-text-3">
              <span className="font-medium text-text-2">
                Sign in to use your always-on machine.
              </span>{" "}
              Use the account menu in the top-right corner to connect, then come
              back here.
              <div className="mt-2">
                <Button
                  variant="subtle"
                  size="sm"
                  onClick={() => void refreshAuth()}
                >
                  I&apos;ve signed in — check again
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-[12px] text-text-4">
              <CircleCheck size={14} className="text-accent-green" />
              Connected as{" "}
              <span className="font-medium text-text-2">
                {auth?.user || auth?.org_slug || "your cloud account"}
              </span>
            </div>
            <Button
              variant="subtle"
              size="sm"
              onClick={() => setShowConnect(true)}
            >
              <Cloud size={13} />
              Connect a machine
            </Button>
          </div>
        )}

        {showConnect && (
          <ConnectMachineWizard
            repoRoot={repoRoot}
            onClose={() => setShowConnect(false)}
          />
        )}

        {/* Send composer. */}
        <section className="flex flex-col gap-3 rounded-[8px] border border-line-soft bg-bg-1 p-4">
          <div className="flex items-center justify-between">
            <h3 className="text-[13px] font-semibold text-text-2">
              Send a job to the cloud
            </h3>
            <SegmentedControl<CloudAgent>
              value={agent}
              onChange={setAgent}
              options={AGENT_OPTIONS}
              ariaLabel="Which agent should work on it"
            />
          </div>
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={!connected || sending}
            placeholder="What should it work on? e.g. “Add rate-limit retries to the billing client and cover it with a test.”"
            className="min-h-[92px] text-[13px]"
          />
          <Input
            value={acceptance}
            onChange={(e) => setAcceptance(e.target.value)}
            disabled={!connected || sending}
            placeholder="How you'll know it's done — optional (e.g. “tests pass, retries capped at 5”)"
            className="text-[12.5px]"
          />
          <div className="flex items-center justify-between">
            <span className="text-[11.5px] text-text-4">
              It runs on the cloud machine and lands back in your queue.
            </span>
            <Button
              variant="accentSoft"
              size="sm"
              onClick={() => void onSend()}
              disabled={!connected || sending || !text.trim()}
            >
              {sending ? (
                <AsciiSpinner className="text-[13px]" />
              ) : (
                <Send size={14} />
              )}
              Send to cloud
            </Button>
          </div>
        </section>

        {/* Bring results back. */}
        <section className="flex items-center justify-between gap-3 rounded-[8px] border border-line-soft bg-bg-1 p-4">
          <div className="min-w-0">
            <h3 className="text-[13px] font-semibold text-text-2">
              Bring results back
            </h3>
            <p className="mt-0.5 text-[12px] leading-snug text-text-4">
              Pull anything the cloud machine has finished into your queue —
              each result keeps the commit and proof that delivered it.
            </p>
          </div>
          <Button
            variant="subtle"
            size="sm"
            onClick={() => void onSync()}
            disabled={!connected || syncing}
            className="shrink-0"
          >
            {syncing ? (
              <AsciiSpinner className="text-[13px]" />
            ) : (
              <DownloadCloud size={14} />
            )}
            Bring results back
          </Button>
        </section>

        {/* Feedback line — the last send/sync outcome or an error. */}
        {error ? (
          <div className="flex items-start gap-2 rounded-[8px] border border-red/40 bg-red/5 px-3.5 py-2.5 text-[12px] leading-snug text-red">
            <CircleAlert size={14} className="mt-0.5 shrink-0" />
            {error}
          </div>
        ) : note ? (
          <div className="flex items-start gap-2 rounded-[8px] border border-line-soft bg-bg-1 px-3.5 py-2.5 text-[12px] leading-snug text-text-3">
            <CircleCheck size={14} className="mt-0.5 shrink-0 text-accent-green" />
            {note}
          </div>
        ) : null}

        {/* What came back on the last sync — the plain notes the engine
            returned, shown only when there's something to say. */}
        {lastSync && lastSync.notes.length > 0 ? (
          <section className="flex flex-col gap-2">
            <h4 className="text-[11.5px] font-medium uppercase tracking-wide text-text-4">
              Last sync
            </h4>
            <ul className="flex flex-col gap-1.5">
              {lastSync.notes.map((n, i) => (
                <li
                  key={i}
                  className="rounded-[6px] border border-line-soft bg-bg-1 px-3 py-2 text-[12px] text-text-3"
                >
                  {n}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {/* Jobs sent this session. */}
        {sent.length > 0 ? (
          <section className="flex flex-col gap-2">
            <h4 className="text-[11.5px] font-medium uppercase tracking-wide text-text-4">
              Sent to the cloud
            </h4>
            <ul className="flex flex-col gap-1.5">
              {sent.map((job) => (
                <li
                  key={job.id}
                  className="flex items-start gap-3 rounded-[8px] border border-line-soft bg-bg-1 px-3.5 py-2.5"
                >
                  <AgentBit agentKind={job.agent} size={22} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[12.5px] text-text-2">
                      {job.text}
                    </p>
                    <p className="mt-0.5 text-[11px] text-text-4">
                      {statusLabel(job.status)} · sent {relativeTime(job.at)}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
            <p className="text-[11px] text-text-4">
              Press <span className="font-medium">Bring results back</span> to
              pull finished work into your queue.
            </p>
          </section>
        ) : null}
      </div>
    </div>
  );
}

/** Plain-language label for a cloud task's lifecycle — never the raw enum. */
function statusLabel(status: string): string {
  switch (status) {
    case "submitted":
      return "Waiting for the machine";
    case "working":
    case "in_progress":
      return "Being worked on";
    case "completed":
    case "done":
      return "Finished";
    case "failed":
      return "Hit a problem";
    default:
      return status || "Sent";
  }
}
