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
// Sign-in is the same cloud account the sidebar's avatar manages — we only read
// it here (`cloudAuthStatus`); we never ask for a second login. We do offer the
// button, though: `aura:open-signin` is the app-wide way to raise the sign-in
// welcome, and this panel telling you to go and find a menu instead was a
// dead end from inside Settings, which covers the whole window.

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
import { CloudGlyph } from "../../ui/cloud-glyph";
import { ErrorNote } from "../../ui/state";

import { api } from "../../../lib/api";
import type {
  CloudAuthStatus,
  CloudRunner,
  CloudSyncResult,
} from "../../../lib/api";
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
  /** The runner's reason, once it reports one. A job that failed and said why
   *  is the single most useful row on this panel — it's usually one command
   *  away from fixed. */
  reason?: string | null;
};

/** Statuses a job can't move on from. Anything else is still worth re-reading. */
const TERMINAL = new Set(["completed", "done", "failed", "canceled", "rejected"]);

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

  // The machines themselves. `null` = we haven't managed to read the board yet,
  // which is NOT the same as an empty board — one means "we don't know", the
  // other means "you have none", and the panel says something different for
  // each. Nothing here is inferred from local files: a box in another
  // datacenter leaves no trace on this disk, so the cloud registry is the only
  // witness.
  const [runners, setRunners] = useState<CloudRunner[] | null>(null);
  // Why the last board read failed, when it did. `runners === null` alone
  // can't carry this: it means "haven't managed to read it", which the
  // panel drew as a spinner — so a board call that failed every time span
  // "Checking your board…" forever, on a machine that may well have one.
  const [boardError, setBoardError] = useState<string | null>(null);

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

  // Signing in happens elsewhere — the welcome surface App.tsx raises. It
  // broadcasts when it lands, so this panel comes to life on its own instead
  // of waiting for the user to press a "check again" button we'd otherwise
  // have to leave as the only way back.
  useEffect(() => {
    const onAuthChanged = () => void refreshAuth();
    window.addEventListener("aura:cloud-auth-changed", onAuthChanged);
    return () =>
      window.removeEventListener("aura:cloud-auth-changed", onAuthChanged);
  }, [refreshAuth]);

  const connected = !!auth?.connected;

  const refreshRunners = useCallback(async () => {
    try {
      setRunners(await api.cloudRunners());
      setBoardError(null);
    } catch (e) {
      // Leave the last known board up rather than blanking it on one failed
      // poll — a dropped request doesn't mean the machine went away. But
      // record why, because with no board yet there is nothing to leave up
      // and the panel would otherwise spin on this forever.
      setRunners((prev) => prev);
      setBoardError(String(e));
    }
  }, []);

  // Poll while signed in. A runner beats every 20s, so 15s here means the strip
  // is never showing something more than one missed beat out of date.
  useEffect(() => {
    if (!connected) return;
    let alive = true;
    void refreshRunners();
    const t = setInterval(() => {
      if (alive) void refreshRunners();
    }, 15_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [connected, refreshRunners]);

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

  const live = (runners ?? []).filter((r) => r.online);
  // Rows that never checked in are a registration that never came up — real,
  // but not a machine yet, and not worth a line each on the main surface.
  const seen = (runners ?? []).filter((r) => !r.online && r.last_heartbeat_at);
  const hasMachine = live.length > 0;

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
      setNote(
        hasMachine
          ? "Sent. Your always-on machine will pick it up shortly."
          : "Queued. Nothing is online to run it yet. It starts the moment a machine comes back.",
      );
      trackFeature("cloud_send");
    } catch (e) {
      setError(String(e));
    } finally {
      setSending(false);
    }
  }, [text, agent, acceptance, repoRoot, sending, hasMachine]);

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
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-5 px-8 py-6">
        {/* Intro — one plain line; no jargon. */}
        <header className="flex items-start gap-3">
          <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-[8px] bg-accent-soft text-accent">
            <Cloud size={18} />
          </span>
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-text-1">
              Your always-on machine
            </h2>
            <p className="mt-0.5 text-base leading-snug text-text-4">
              Hand off a job and keep working. A machine that stays awake picks
              it up, and you bring the finished work back with one click.
            </p>
          </div>
        </header>

        {/* Sign-in gate. We don't run a second login here — the welcome
            surface owns it — but we do raise it, and keep Send/Bring
            disabled until you're connected.

            This used to read "Use the account menu in the top-right corner
            to connect". The account menu is at the foot of the left
            sidebar, not the top right; and this panel's other home is
            Settings, which covers the whole window, so the menu it named
            wasn't reachable without closing the surface you were reading
            the instruction on. The only way forward was a button labelled
            "I've signed in" — for a sign-in the panel never offered. */}
        {authLoading ? (
          <div className="flex items-center gap-2 rounded-[8px] border border-line-soft bg-bg-1 px-4 py-3 text-base text-text-4">
            <AsciiSpinner />
            Checking your cloud sign-in…
          </div>
        ) : !connected ? (
          <div className="flex items-start gap-3 rounded-[8px] border border-line-soft bg-bg-1 px-4 py-3.5">
            <CloudOff size={17} className="mt-0.5 shrink-0 text-text-4" />
            <div className="min-w-0 text-base leading-snug text-text-3">
              <span className="font-medium text-text-2">
                Sign in to use your always-on machine.
              </span>{" "}
              It&apos;s your Aura account — the same one the app already uses.
              <div className="mt-2 flex items-center gap-2">
                <Button
                  variant="accentSoft"
                  size="sm"
                  onClick={() =>
                    window.dispatchEvent(new CustomEvent("aura:open-signin"))
                  }
                >
                  Sign in
                </Button>
                {/* Signing in from the app announces itself and this panel
                    updates on its own. `aura login` in a terminal doesn't —
                    so there's still a way to ask again by hand. */}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void refreshAuth()}
                >
                  Check again
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-sm text-text-4">
              <CircleCheck size={14} className="text-accent-green" />
              {/* When the backend confirms a session without a name, say so and
                  stop — "Connected as your cloud account" fills the slot where
                  a name goes with a phrase that isn't one, and reads as though
                  the account is literally called that. */}
              {auth?.user || auth?.org_slug ? (
                <>
                  Connected as{" "}
                  <span className="font-medium text-text-2">
                    {auth.user || auth.org_slug}
                  </span>
                </>
              ) : (
                "Connected."
              )}
            </div>
            <Button
              variant="subtle"
              size="sm"
              onClick={() => setShowConnect(true)}
            >
              <Cloud size={13} />
              {hasMachine ? "Connect another" : "Connect a machine"}
            </Button>
          </div>
        )}

        {/* The machines themselves. Signing in and owning a machine are two
            different facts, and the panel used to show only the first — so a
            board with nothing on it looked identical to one with a box running,
            and Send promised a pickup that could never come. */}
        {connected && (
          <section className="flex flex-col gap-2 border-t border-line-soft pt-4">
            <h3 className="text-xs font-medium text-text-4">Your machines</h3>
            {runners === null && boardError ? (
              // Never read it, and we know why. Saying "no machine is
              // online" here would be an answer; we don't have one.
              <ErrorNote className="text-sm">
                Aura couldn&apos;t reach your board, so it doesn&apos;t know
                what machines you have.{" "}
                <button
                  type="button"
                  onClick={() => void refreshRunners()}
                  className="underline underline-offset-2 hover:text-text-2"
                >
                  Try again
                </button>
              </ErrorNote>
            ) : runners === null ? (
              <div className="flex items-center gap-2 text-sm text-text-4">
                <AsciiSpinner />
                Checking your board…
              </div>
            ) : !hasMachine ? (
              <p className="text-sm leading-snug text-text-3">
                No machine is online.{" "}
                {seen.length > 0
                  ? `${seen.length === 1 ? "The one you connected" : `The ${seen.length} you connected`} ${seen.length === 1 ? "isn't" : "aren't"} reporting in right now. Jobs you send will wait until ${seen.length === 1 ? "it comes" : "one comes"} back.`
                  : "Connect one and it can keep working while this Mac sleeps."}
              </p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {live.map((r) => (
                  <li
                    key={r.id}
                    className="flex items-center gap-3 rounded-[8px] border border-line-soft bg-bg-1 px-3.5 py-2.5"
                  >
                    {/* The cloud mark, not a server box: this row is the one
                        place a machine is unambiguously *elsewhere*, and the
                        same glyph marks every other cloud-run thing in the
                        app so the association is learned once. */}
                    <CloudGlyph
                      size={16}
                      className="text-accent-green"
                      label="Cloud machine"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-base text-text-2">{r.name}</p>
                      {/* The detail line is deliberately the quietest text on
                          the row — except when it carries the one thing that
                          makes the rest of the row a lie. */}
                      <p
                        className={`mt-0.5 truncate text-xs ${
                          blockedNote(r) ? "text-red" : "text-text-4"
                        }`}
                      >
                        {machineLine(r)}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        {showConnect && (
          <ConnectMachineWizard
            repoRoot={repoRoot}
            onClose={() => setShowConnect(false)}
            // The wizard polls until the runner reports online. Without this
            // the panel kept rendering whatever status it read on mount, so
            // a machine you just connected still looked absent until the
            // drawer was reopened.
            onOnline={() => {
              void refreshAuth();
              void refreshRunners();
            }}
          />
        )}

        {/* Send composer. Two hairline-separated groups, not two bordered,
            filled boxes — the drawer is already a container, and boxing each
            group inside it draws three edges around one job. */}
        <section className="flex flex-col gap-3 border-t border-line-soft pt-4">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-medium text-text-4">
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
            placeholder="What should it work on?"
            className="min-h-[92px] text-base"
          />
          {/* The example used to ride in the placeholder. WebKit — which is
              what this app renders in — draws a textarea placeholder on one
              line and clips it, so the half that said what a good brief
              looks like was cut off mid-word and could never be read. It
              only fits as real text. Hidden once you start typing: by then
              it has done its job and it's just noise under your own words. */}
          {!text && (
            <p className="-mt-1 text-sm text-text-4">
              e.g. “Add rate-limit retries to the billing client and cover it
              with a test.”
            </p>
          )}
          <Input
            value={acceptance}
            onChange={(e) => setAcceptance(e.target.value)}
            disabled={!connected || sending}
            placeholder="How you'll know it's done. Optional (e.g. “tests pass, retries capped at 5”)"
            className="text-base"
          />
          <div className="flex items-center justify-between">
            <span className="text-sm text-text-4">
              {hasMachine
                ? `Runs on ${live[0].name} and lands back in your queue.`
                : "It waits on the board until a machine picks it up."}
            </span>
            <Button
              variant="accentSoft"
              size="sm"
              onClick={() => void onSend()}
              disabled={!connected || sending || !text.trim()}
            >
              {sending ? (
                <AsciiSpinner className="text-base" />
              ) : (
                <Send size={14} />
              )}
              Send to cloud
            </Button>
          </div>
        </section>

        {/* Bring results back. The heading used to be these same four words,
            three hundred pixels from the button that says them. */}
        <section className="flex items-center justify-between gap-3 border-t border-line-soft pt-4">
          <div className="min-w-0">
            <h3 className="text-xs font-medium text-text-4">
              Work the machine has finished
            </h3>
            <p className="mt-0.5 text-sm leading-snug text-text-3">
              Pull it into your queue. Each result keeps the commit and the
              proof that delivered it.
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
              <AsciiSpinner className="text-base" />
            ) : (
              <DownloadCloud size={14} />
            )}
            Bring results back
          </Button>
        </section>

        {/* Feedback line — the last send/sync outcome or an error. */}
        {error ? (
          <div className="flex items-start gap-2 rounded-[8px] border border-red/40 bg-red/5 px-3.5 py-2.5 text-sm leading-snug text-red">
            <CircleAlert size={14} className="mt-0.5 shrink-0" />
            {error}
          </div>
        ) : note ? (
          <div className="flex items-start gap-2 rounded-[8px] border border-line-soft bg-bg-1 px-3.5 py-2.5 text-sm leading-snug text-text-3">
            <CircleCheck size={14} className="mt-0.5 shrink-0 text-accent-green" />
            {note}
          </div>
        ) : null}

        {/* What came back on the last sync — the plain notes the engine
            returned, shown only when there's something to say. */}
        {lastSync && lastSync.notes.length > 0 ? (
          <section className="flex flex-col gap-2">
            <h4 className="text-xs font-medium text-text-4">
              Last sync
            </h4>
            <ul className="flex flex-col gap-1.5">
              {lastSync.notes.map((n, i) => (
                <li
                  key={i}
                  className="rounded-[6px] border border-line-soft bg-bg-1 px-3 py-2 text-sm text-text-3"
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
            <h4 className="text-xs font-medium text-text-4">
              Sent to the cloud
            </h4>
            <ul className="flex flex-col gap-1.5">
              {sent.map((job) => (
                <li
                  key={job.id}
                  className="flex items-start gap-3 rounded-[8px] border border-line-soft bg-bg-1 px-3.5 py-2.5"
                >
                  {/* A cloud agent is the same agent, somewhere else — so it
                      keeps its own icon and takes the cloud mark as a badge
                      rather than being replaced by one. It breathes while the
                      job is still in flight and settles once it lands. */}
                  <span className="relative shrink-0">
                    <AgentBit agentKind={job.agent} size={22} />
                    <CloudGlyph
                      size={12}
                      pulse={!TERMINAL.has(job.status)}
                      label="Running in the cloud"
                      className="absolute -bottom-1 -right-1.5 text-text-4"
                    />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-base text-text-2">
                      {job.text}
                    </p>
                    <p className="mt-0.5 text-xs text-text-4">
                      {statusLabel(job.status)} · sent {relativeTime(job.at)}
                    </p>
                    {/* The reason it failed, in the runner's words. This is
                        usually one command away from fixed ("Not logged in ·
                        Please run /login" means the box never signed the agent
                        in) — and before this it never left the box's journal. */}
                    {job.reason ? (
                      <p className="mt-1 flex items-start gap-1.5 text-xs leading-snug text-red">
                        <CircleAlert size={12} className="mt-0.5 shrink-0" />
                        {job.reason}
                      </p>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
            <p className="text-xs text-text-4">
              Press <span className="font-medium">Bring results back</span> to
              pull finished work into your queue.
            </p>
          </section>
        ) : null}
      </div>
    </div>
  );
}

/** The detail line under a machine's name: what it's doing, which agents it can
 *  run, and when it last spoke. Every part is dropped when the registry doesn't
 *  know it, so a box that has only just registered says less rather than
 *  padding the line with "unknown". */
function machineLine(r: CloudRunner): string {
  const bits: string[] = [blockedNote(r) ?? runnerStatusLabel(r.status)];
  if (r.agent_kinds.length > 0) bits.push(r.agent_kinds.map(agentLabel).join(", "));
  if (r.version) bits.push(`Aura ${r.version}`);
  const beat = r.last_heartbeat_at ? Date.parse(r.last_heartbeat_at) : NaN;
  if (Number.isFinite(beat)) bits.push(`seen ${relativeTime(beat)}`);
  return bits.join(" · ");
}

/** A machine that is up but can't sign its agent in.
 *
 *  This is the worst row the board can show, because every honest signal on it
 *  is green: the box registered, it heartbeats, it reports `idle`. It then
 *  fails every job it claims with "Not logged in", and that sentence lands on
 *  the task row where nobody connects it to the machine that caused it.
 *
 *  The runner checks before it claims anything and reports the reason on each
 *  beat (`runner_creds::auth_for`). There is no field for it — the registry
 *  stores status, task and version — so it rides in on `current_task` behind a
 *  lead phrase both sides agree on (`AUTH_NOTE_LEAD` in `runner.rs`). When it's
 *  there it isn't a detail about the status; it *is* the status. */
export function blockedNote(r: CloudRunner): string | null {
  const note = (r.current_task ?? "").trim();
  return note.startsWith("Needs sign-in") ? note : null;
}

/** `idle`/`busy` are the registry's words; nobody outside the code says them. */
function runnerStatusLabel(status: string): string {
  switch (status) {
    case "idle":
      return "Ready";
    case "busy":
    case "working":
      return "Working";
    case "offline":
      return "Offline";
    default:
      return status || "Ready";
  }
}

/** Provider id → the name the product uses for it. */
function agentLabel(kind: string): string {
  const known = AGENT_OPTIONS.find((o) => o.value === kind);
  return known ? known.label : kind;
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
