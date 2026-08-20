// AuraWatch configuration. Mode (off/nudge/autonomous) is persisted
// per-user in localStorage and applied on workspace mount. The
// backend section is read-only detection — it shows what's reachable
// on the user's machine but never installs, pulls, or starts
// anything. If the active backend can't be reached at coalesce-time,
// AuraWatch falls back to canned-copy nudges.

import { useEffect, useState } from "react";
import {
  api,
  type BackendDetection,
  type InferenceBackendKind,
  type WatchMode,
  type WatchStatus,
} from "../../lib/api";
import { PaneIntro, Section } from "../settings/kit";
import { AgentIcon } from "../agent/AgentIcon";
import { ErrorNote, LoadingState } from "../ui/state";

// localStorage key for the user's explicit "which AI fills in reasons"
// pick. Value is the selector passed to aurawatchSetBackend:
// `agent:<kind>` for an installed coding-agent CLI, or a backend kind
// string. Absent → auto-detected precedence.
const PREF_KEY = "aura.aurawatch.backend";

const MODE_LABEL: Record<WatchMode, string> = {
  off: "Off",
  nudge: "Remind me (recommended)",
  autonomous: "Fill it in for me",
};

/** The mode this machine last chose, read without a round trip.
 *
 *  App reads exactly this key to decide whether to watch at all, defaulting
 *  to `nudge` — so it is already the answer, and asking the backend only
 *  confirms it. Seeding from it is what stops the Mode row rendering with
 *  nothing selected for the length of a Tauri call: three buttons, none of
 *  them marked, on the one screen whose question is "is Aura watching?". */
function storedMode(): WatchMode {
  const raw = localStorage.getItem("aura.aurawatch.mode");
  return raw === "off" || raw === "nudge" || raw === "autonomous"
    ? raw
    : "nudge";
}

export function AuraWatchPanel({ repoRoot }: { repoRoot: string }) {
  const [status, setStatus] = useState<WatchStatus | null>(null);
  const [mode, setModeState] = useState<WatchMode>(storedMode);
  const [detection, setDetection] = useState<BackendDetection | null>(null);
  /** Still probing. Distinct from "probed, found nothing": the list below is
   *  a claim about this machine, and for the first moment of this pane it was
   *  making that claim before anything had been looked at — no agent rows at
   *  all, every key a hollow circle, then Claude Code · active a beat later. */
  const [detecting, setDetecting] = useState(true);
  /** The probe itself failed. Was swallowed, which left the same screen as
   *  "nothing available" — an answer, and the wrong one. */
  const [detectError, setDetectError] = useState<string | null>(null);
  const [pref, setPref] = useState<string | null>(() =>
    localStorage.getItem(PREF_KEY),
  );
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    setBusy(true);
    setDetecting(true);
    setDetectError(null);
    const saved = localStorage.getItem(PREF_KEY);
    // Re-assert the persisted pick on the live session, then read back
    // status + detection. If no pick is saved we just read state.
    const prime = saved
      ? api.aurawatchSetBackend(repoRoot, saved).catch(() => null)
      : Promise.resolve(null);
    // Two independent reads. They were one `Promise.all` under one catch, so
    // a failed probe also threw away the mode — and the catch was empty, so
    // the pane just sat there looking loaded.
    void prime.then(() => {
      const s = api
        .aurawatchStatus(repoRoot)
        .then((r) => {
          if (alive && r) {
            setStatus(r);
            setModeState(r.mode);
          }
        })
        .catch(() => {});
      const d = api
        .aurawatchDetect()
        .then((r) => {
          if (alive) setDetection(r);
        })
        .catch((e) => {
          if (alive) setDetectError(String(e?.message ?? e));
        })
        .finally(() => {
          if (alive) setDetecting(false);
        });
      return Promise.all([s, d]).then(() => {
        if (alive) setBusy(false);
      });
    });
    return () => {
      alive = false;
    };
  }, [repoRoot, attempt]);

  // Pick which AI fills in reasons. Persist the selector and ask the
  // backend to re-resolve. Re-detect after so the "active" marker moves
  // (if the pick was unreachable the backend falls back to auto, and
  // detection reflects that honestly). Passing the same selector again
  // clears it back to auto.
  async function setBackend(selector: string) {
    const next = pref === selector ? null : selector;
    setBusy(true);
    try {
      const s = await api.aurawatchSetBackend(repoRoot, next);
      setStatus(s);
      setDetection(await api.aurawatchDetect());
      setPref(next);
      if (next) localStorage.setItem(PREF_KEY, next);
      else localStorage.removeItem(PREF_KEY);
    } catch {
      // Detection panel surfaces availability — silent here.
    } finally {
      setBusy(false);
    }
  }

  async function setMode(next: WatchMode) {
    // Shown before it is confirmed: this is a three-way switch, and a switch
    // that doesn't move under the finger reads as broken. The backend is the
    // authority and overwrites this the moment it answers.
    const previous = mode;
    setModeState(next);
    setBusy(true);
    try {
      const s = await api.aurawatchSetMode(repoRoot, next);
      setStatus(s);
      setModeState(s.mode);
      localStorage.setItem("aura.aurawatch.mode", next);
      // Let App resync its own auraWatchMode (footer chip + lifecycle
      // effect) now that Settings — not a dialog — owns this surface.
      window.dispatchEvent(
        new CustomEvent("aura:aurawatch-mode", { detail: { mode: next } }),
      );
    } catch {
      // Put the switch back rather than leave it showing a setting that was
      // never applied.
      setModeState(previous);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PaneIntro text="Every change should carry the reason behind it, the “why”. Aura watches quietly in the background and, when a change lands without one, it either reminds you or fills it in for you. It only reads what's already on your machine. It never installs or starts anything." />
      <Section title="Mode">
        <div className="py-3">
          <div className="flex flex-wrap items-center gap-1">
            {(Object.keys(MODE_LABEL) as WatchMode[]).map((m) => (
              <button
                key={m}
                type="button"
                disabled={busy}
                onClick={() => setMode(m)}
                className={`h-7 rounded-md px-2.5 text-sm transition-colors ${
                  mode === m
                    ? "bg-accent/12 text-text-1"
                    : "text-text-3 hover:bg-state-hover hover:text-text-1"
                }`}
              >
                {MODE_LABEL[m]}
              </button>
            ))}
          </div>
          <p className="mt-2 text-xs leading-relaxed text-text-4">
            <strong className="text-text-3">Off</strong>. Aura won't watch
            for missing reasons.{" "}
            <strong className="text-text-3">Remind me</strong>. When a change
            lands without a reason, a gentle card appears so you can add one.{" "}
            <strong className="text-text-3">Fill it in for me</strong>. Aura
            writes a best-guess reason for you, so nothing is ever left blank.
          </p>
        </div>
      </Section>

      <Section title="AI available to fill in reasons">
        <div className="py-3">
          {detecting ? (
            <LoadingState
              size="sm"
              label="Looking for what's already on this machine…"
              className="px-0 py-2"
            />
          ) : detectError ? (
            // Not the same screen as "nothing here can do it", which is what
            // an empty list says and what a swallowed failure used to show.
            <ErrorNote className="flex flex-wrap items-center gap-2">
              <span>Aura couldn’t check what’s on this machine.</span>
              <span className="font-mono text-xs opacity-80">
                {detectError}
              </span>
              <button
                type="button"
                className="ml-auto rounded px-2 py-0.5 text-xs underline decoration-red/50 underline-offset-2 hover:decoration-red"
                onClick={() => setAttempt((n) => n + 1)}
              >
                Try again
              </button>
            </ErrorNote>
          ) : (
          <div className="space-y-1.5">
            {/* Installed coding agents you already have — the easiest
                source: no key, no ollama, they're already signed in. */}
            {(detection?.agent_clis ?? []).map((a) => (
              <BackendRow
                key={`agent:${a.kind}`}
                label={a.label}
                hint="already installed. No setup"
                ok
                active={
                  detection?.active === "agent_cli" &&
                  detection?.active_agent_kind === a.kind
                }
                agentId={a.kind}
                onSelect={() => setBackend(`agent:${a.kind}`)}
                disabled={busy}
              />
            ))}
            <BackendRow
              label="Ollama"
              hint="local model on your machine"
              ok={!!detection?.ollama}
              active={detection?.active === "ollama"}
              onSelect={detection?.ollama ? () => setBackend("ollama") : undefined}
              disabled={busy}
            />
            <BackendRow
              label="Anthropic key"
              ok={!!detection?.anthropic}
              active={detection?.active === "anthropic"}
              onSelect={
                detection?.anthropic ? () => setBackend("anthropic") : undefined
              }
              disabled={busy}
            />
            <BackendRow
              label="OpenAI key"
              ok={!!detection?.openai}
              active={detection?.active === "openai"}
              onSelect={
                detection?.openai ? () => setBackend("openai") : undefined
              }
              disabled={busy}
            />
            <BackendRow
              label="Gemini key"
              ok={!!detection?.gemini}
              active={detection?.active === "gemini"}
              onSelect={
                detection?.gemini ? () => setBackend("gemini") : undefined
              }
              disabled={busy}
            />
            <BackendRow
              label="Mercury key"
              ok={!!detection?.mercury}
              active={detection?.active === "mercury"}
              onSelect={
                detection?.mercury ? () => setBackend("mercury") : undefined
              }
              disabled={busy}
            />
          </div>
          )}
          <p className="mt-2.5 text-xs leading-relaxed text-text-4">
            Aura can use a coding agent you already have installed — Claude
            Code, Gemini or Codex — to write the reason for you. No key, no
            extra setup: they're already signed in. You can also use a local
            model (Ollama) or an API key. Pick one above to make it the one Aura
            uses. Aura never installs or starts anything. It only runs what's
            already on your machine. With nothing available, reminders still
            work; only auto-fill needs an AI.
          </p>
        </div>
      </Section>

      <Section title="This session">
        <div className="grid grid-cols-3 gap-3 py-3">
          <Stat label="waiting" value={status?.pending ?? 0} empty="0" />
          <Stat label="reminders" value={status?.nudged_total ?? 0} empty="0" />
          <Stat label="auto-filled" value={status?.logged_total ?? 0} empty="0" />
        </div>
      </Section>
    </>
  );
}

function BackendRow({
  label,
  hint,
  ok,
  active,
  agentId,
  onSelect,
  disabled,
}: {
  label: string;
  hint?: string;
  ok: boolean;
  active: boolean;
  agentId?: string;
  onSelect?: () => void;
  disabled?: boolean;
}) {
  // Selectable when reachable AND a handler is wired. A reachable row
  // is a button (click to make it active); an unavailable row is inert.
  const selectable = ok && !!onSelect;
  const inner = (
    <>
      {agentId ? (
        <AgentIcon agentId={agentId} label={label} size={15} />
      ) : (
        <span className={ok ? "text-accent-green" : "text-text-5"}>
          {ok ? "✓" : "○"}
        </span>
      )}
      <span className={ok ? "text-text-2" : "text-text-4"}>{label}</span>
      {hint && ok && (
        <span className="text-2xs text-text-5">· {hint}</span>
      )}
      {active && (
        <span className="ml-auto text-2xs text-accent">
          active
        </span>
      )}
    </>
  );
  if (!selectable) {
    return (
      <div className="flex items-center gap-2 text-sm px-2 py-1">
        {inner}
      </div>
    );
  }
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onSelect}
      className={`flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm transition-colors ${
        active ? "bg-accent/12" : "hover:bg-state-hover"
      }`}
    >
      {inner}
    </button>
  );
}

function Stat({
  label,
  value,
  empty,
}: {
  label: string;
  value: number;
  empty: string;
}) {
  return (
    <div className="flex flex-col items-start">
      <span className="text-text-1 text-lg font-mono">
        {value === 0 ? empty : value}
      </span>
      <span className="text-text-4 text-2xs">
        {label}
      </span>
    </div>
  );
}

export function backendChipLabel(kind: InferenceBackendKind | null): string {
  switch (kind) {
    case "ollama":
      return "ollama";
    case "agent_cli":
      return "coding agent";
    case "anthropic":
      return "anthropic";
    case "openai":
      return "openai";
    case "gemini":
      return "gemini";
    case "mercury":
      return "mercury";
    case "generic":
    case null:
    default:
      return "no backend";
  }
}
