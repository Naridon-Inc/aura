// Change reasons: whether Aura watches for changes that land without a
// reason, which AI may write one, and what it has done this session.
//
// The mode is per-user, kept in localStorage and applied by App when a
// workspace mounts. The AI list is read-only detection: it shows what is
// reachable on this machine and never installs, pulls or starts anything.
// If the chosen AI can't be reached when a reason is due, Aura falls back
// to a plain reminder.

import { useEffect, useState } from "react";
import { api, type BackendDetection, type WatchMode, type WatchStatus } from "../../../lib/api";
import { Alert, AlertDescription, AlertTitle } from "../../ui/alert";
import { AsciiSpinner } from "../../ui/ascii-spinner";
import { Button } from "../../ui/button";
import { Select } from "../../ui/select";
import { SettingsFacts, SettingsGroup, SettingsIntro } from "../../ui/settings-blocks";
import { SettingsRow, SettingsSection } from "../../ui/settings-row";
import { BackendRows } from "./ChangeReasonsBackends";

// localStorage key for the user's explicit "which AI fills in reasons"
// pick. Value is the selector passed to aurawatchSetBackend:
// `agent:<kind>` for an installed coding-agent CLI, or a backend kind
// string. Absent → auto-detected precedence.
const PREF_KEY = "aura.aurawatch.backend";

const MODE_OPTIONS: { value: WatchMode; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "nudge", label: "Remind me" },
  { value: "autonomous", label: "Fill it in for me" },
];

const MODE_HELP: Record<WatchMode, string> = {
  off: "Aura won't watch for missing reasons.",
  nudge: "When a change lands without a reason, a gentle card appears so you can add one. Recommended.",
  autonomous: "Aura writes a best-guess reason for you, so nothing is ever left blank.",
};

/** The mode this machine last chose, read without a round trip.
 *
 *  App reads exactly this key to decide whether to watch at all, defaulting
 *  to `nudge`, so it is already the answer and asking the backend only
 *  confirms it. Seeding from it stops the mode row rendering with nothing
 *  chosen for the length of a Tauri call, on the one screen whose question
 *  is "is Aura watching?". */
function storedMode(): WatchMode {
  const raw = localStorage.getItem("aura.aurawatch.mode");
  return raw === "off" || raw === "nudge" || raw === "autonomous"
    ? raw
    : "nudge";
}

export function ChangeReasonsPage({ repoRoot }: { repoRoot: string }) {
  const [status, setStatus] = useState<WatchStatus | null>(null);
  const [mode, setModeState] = useState<WatchMode>(storedMode);
  const [detection, setDetection] = useState<BackendDetection | null>(null);
  /** Still probing. Distinct from "probed, found nothing": the list is a
   *  claim about this machine and must not be made before anything has
   *  been looked at. */
  const [detecting, setDetecting] = useState(true);
  /** The probe itself failed, which is not the same answer as "nothing
   *  available" and must not be drawn as one. */
  const [detectError, setDetectError] = useState<string | null>(null);
  const [pref, setPref] = useState<string | null>(() => localStorage.getItem(PREF_KEY));
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    setBusy(true);
    setDetecting(true);
    setDetectError(null);
    const saved = localStorage.getItem(PREF_KEY);
    // Re-assert the persisted pick on the live session, then read back
    // status and detection. With no saved pick we only read state.
    const prime = saved
      ? api.aurawatchSetBackend(repoRoot, saved).catch(() => null)
      : Promise.resolve(null);
    // Two independent reads, each with its own failure: a dead probe must
    // not also cost the mode.
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
  // backend to re-resolve, then re-detect so the in-use marker moves (an
  // unreachable pick falls back to automatic, and detection says so).
  // Passing the current pick again clears it back to automatic.
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
      // The rows below already show what is reachable.
    } finally {
      setBusy(false);
    }
  }

  async function setMode(next: WatchMode) {
    // Shown before it is confirmed: a switch that doesn't move under the
    // finger reads as broken. The backend is the authority and overwrites
    // this the moment it answers.
    const previous = mode;
    setModeState(next);
    setBusy(true);
    try {
      const s = await api.aurawatchSetMode(repoRoot, next);
      setStatus(s);
      setModeState(s.mode);
      localStorage.setItem("aura.aurawatch.mode", next);
      // Let App resync its own mode (footer chip and watch lifecycle).
      window.dispatchEvent(
        new CustomEvent("aura:aurawatch-mode", { detail: { mode: next } }),
      );
    } catch {
      // Put the switch back rather than show a setting that never applied.
      setModeState(previous);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <SettingsIntro>
        Every change should carry the reason behind it, the “why”. Aura watches quietly in the
        background and, when a change lands without one, it either reminds you or fills it in for
        you. It only reads what's already on your machine. It never installs or starts anything.
      </SettingsIntro>
      <SettingsGroup>
        <SettingsRow
          title="Mode"
          description={MODE_HELP[mode]}
          htmlFor="setting-change-reasons-mode"
          control={
            <Select
              id="setting-change-reasons-mode"
              aria-label="Mode"
              value={mode}
              onChange={(v) => setMode(v as WatchMode)}
              options={MODE_OPTIONS}
              disabled={busy}
            />
          }
        />
      </SettingsGroup>

      <SettingsSection
        title="AI available to fill in reasons"
        description="Aura can use a coding agent you already have installed — Claude Code, Gemini or Codex — to write the reason for you. No key, no extra setup: they're already signed in. You can also use a local model (Ollama) or an API key. Pick one to make it the one Aura uses. With nothing available, reminders still work; only auto-fill needs an AI."
      >
        {detecting ? (
          <p className="ui-settings-status" role="status">
            <AsciiSpinner />
            Looking for what's already on this machine…
          </p>
        ) : detectError ? (
          <Alert variant="destructive">
            <AlertTitle>Aura couldn’t check what’s on this machine.</AlertTitle>
            <AlertDescription>
              <code>{detectError}</code>
            </AlertDescription>
            <Button size="sm" variant="outline" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </Button>
          </Alert>
        ) : (
          <BackendRows detection={detection} pref={pref} busy={busy} onSelect={setBackend} />
        )}
      </SettingsSection>

      <SettingsSection title="This session">
        <SettingsFacts
          rows={[
            { key: "pending", label: "Waiting for a reason", value: status?.pending ?? 0, mono: true },
            { key: "nudged", label: "Reminders shown", value: status?.nudged_total ?? 0, mono: true },
            { key: "logged", label: "Filled in by Aura", value: status?.logged_total ?? 0, mono: true },
          ]}
        />
      </SettingsSection>
    </>
  );
}
