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
import { PaneHeader, Section } from "../settings/kit";
import { AgentIcon } from "../agent/AgentIcon";

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

export function AuraWatchPanel({ repoRoot }: { repoRoot: string }) {
  const [status, setStatus] = useState<WatchStatus | null>(null);
  const [detection, setDetection] = useState<BackendDetection | null>(null);
  const [pref, setPref] = useState<string | null>(() =>
    localStorage.getItem(PREF_KEY),
  );
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setBusy(true);
    const saved = localStorage.getItem(PREF_KEY);
    // Re-assert the persisted pick on the live session, then read back
    // status + detection. If no pick is saved we just read state.
    const prime = saved
      ? api.aurawatchSetBackend(repoRoot, saved).catch(() => null)
      : Promise.resolve(null);
    prime
      .then(() =>
        Promise.all([api.aurawatchStatus(repoRoot), api.aurawatchDetect()]),
      )
      .then(([s, d]) => {
        setStatus(s);
        setDetection(d);
      })
      .catch(() => {})
      .finally(() => setBusy(false));
  }, [repoRoot]);

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

  async function setMode(mode: WatchMode) {
    setBusy(true);
    try {
      const s = await api.aurawatchSetMode(repoRoot, mode);
      setStatus(s);
      localStorage.setItem("aura.aurawatch.mode", mode);
      // Let App resync its own auraWatchMode (footer chip + lifecycle
      // effect) now that Settings — not a dialog — owns this surface.
      window.dispatchEvent(
        new CustomEvent("aura:aurawatch-mode", { detail: { mode } }),
      );
    } catch {
      // Display surfaced via the detection panel — silent here.
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PaneHeader
        title="Change reasons"
        subtitle="Every change should carry the reason behind it — the “why”. Aura watches quietly in the background and, when a change lands without one, it either reminds you or fills it in for you. It only reads what's already on your machine — it never installs or starts anything."
      />
      <Section title="Mode">
        <div className="py-3">
          <div className="flex flex-wrap items-center gap-1">
            {(Object.keys(MODE_LABEL) as WatchMode[]).map((m) => (
              <button
                key={m}
                type="button"
                disabled={busy}
                onClick={() => setMode(m)}
                className={`h-7 rounded-md px-2.5 text-[11.5px] transition-colors ${
                  status?.mode === m
                    ? "bg-accent/12 text-text-1"
                    : "text-text-3 hover:bg-bg-2 hover:text-text-1"
                }`}
              >
                {MODE_LABEL[m]}
              </button>
            ))}
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-text-4">
            <strong className="text-text-3">Off</strong> — Aura won't watch
            for missing reasons.{" "}
            <strong className="text-text-3">Remind me</strong> — when a change
            lands without a reason, a gentle card appears so you can add one.{" "}
            <strong className="text-text-3">Fill it in for me</strong> — Aura
            writes a best-guess reason for you, so nothing is ever left blank.
          </p>
        </div>
      </Section>

      <Section title="AI available to fill in reasons">
        <div className="py-3">
          <div className="space-y-1.5">
            {/* Installed coding agents you already have — the easiest
                source: no key, no ollama, they're already signed in. */}
            {(detection?.agent_clis ?? []).map((a) => (
              <BackendRow
                key={`agent:${a.kind}`}
                label={a.label}
                hint="already installed — no setup"
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
          <p className="mt-2.5 text-[11px] leading-relaxed text-text-4">
            Aura can use a coding agent you already have installed — like Claude
            Code, Gemini, or Codex — to write the reason for you. No key, no
            extra setup: they're already signed in. You can also use a local
            model (Ollama) or an API key. Pick one above to make it the one Aura
            uses. Aura never installs or starts anything — it only runs what's
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
        <AgentIcon agentId={agentId} label={label} size={15} active={active} />
      ) : (
        <span className={ok ? "text-accent-green" : "text-text-5"}>
          {ok ? "✓" : "○"}
        </span>
      )}
      <span className={ok ? "text-text-2" : "text-text-4"}>{label}</span>
      {hint && ok && (
        <span className="text-[10px] text-text-5">· {hint}</span>
      )}
      {active && (
        <span className="ml-auto text-[10px] uppercase tracking-wider text-accent">
          active
        </span>
      )}
    </>
  );
  if (!selectable) {
    return (
      <div className="flex items-center gap-2 text-[11.5px] px-2 py-1">
        {inner}
      </div>
    );
  }
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onSelect}
      className={`flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[11.5px] transition-colors ${
        active ? "bg-accent/12" : "hover:bg-bg-2"
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
      <span className="text-text-1 text-[15px] font-mono">
        {value === 0 ? empty : value}
      </span>
      <span className="text-text-5 text-[10px] uppercase tracking-wider">
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
