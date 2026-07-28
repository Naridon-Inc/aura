// Thin top-strip that makes "Aura is always running" visible without
// nagging. On repo focus it calls `aura_ensure_tracked`, which silently
// turns on capture + wires the agents for any git repo. This component only
// renders when there's something worth saying:
//
//   • non-git folder  → a one-click "Turn on Aura" (runs git init + enable
//     in-app — never a trip to the terminal);
//   • enable failed    → a retry;
//   • just turned on   → a brief "now tracking" confirmation that
//     auto-dismisses. When the repo was already tracked, it renders
//     nothing — silence is the success state.
//
// Two inks, both earned: green on the confirmation because it reports state,
// amber on the action strip because it's asking the reader to do something.
// Nothing here is coloured just to be a category.
//
// Mounted next to UnattributedChangesBanner so the whole "is this repo
// under Aura?" story lives in one strip of the body slot.

import { useCallback, useEffect, useRef, useState } from "react";
import { api, type AuraTrackStatus } from "../lib/api";
import { AsciiSpinner } from "./ui/ascii-spinner";

type Props = {
  repoRoot: string;
};

// How long the green "now tracking" confirmation stays before it fades.
const CONFIRM_MS = 6_000;

export function AuraTrackingNotice({ repoRoot }: Props) {
  const [status, setStatus] = useState<AuraTrackStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  const rootRef = useRef(repoRoot);
  rootRef.current = repoRoot;
  const confirmTimer = useRef<number | null>(null);

  const clearConfirmTimer = () => {
    if (confirmTimer.current != null) {
      window.clearTimeout(confirmTimer.current);
      confirmTimer.current = null;
    }
  };

  // Ensure-tracked on every repo focus. Idempotent on the backend, so
  // re-running as the user hops workspaces is cheap and safe.
  useEffect(() => {
    if (!repoRoot) return;
    let alive = true;
    setStatus(null);
    setDismissed(false);
    clearConfirmTimer();

    api
      .auraEnsureTracked(repoRoot)
      .then((s) => {
        if (!alive || rootRef.current !== repoRoot) return;
        setStatus(s);
        // Auto-fade the "now tracking" confirmation; leave the non-git /
        // failed notices up until the user acts on them.
        if (s.is_git && s.tracked && s.newly_enabled) {
          confirmTimer.current = window.setTimeout(() => {
            if (rootRef.current === repoRoot) setDismissed(true);
          }, CONFIRM_MS);
        }
      })
      .catch(() => {
        /* ensure is best-effort — a hiccup shouldn't wedge the workspace */
      });

    return () => {
      alive = false;
      clearConfirmTimer();
    };
  }, [repoRoot]);

  const turnOn = useCallback(async () => {
    if (!status) return;
    setBusy(true);
    try {
      const next = status.is_git
        ? await api.auraEnsureTracked(repoRoot) // retry enable
        : await api.auraGitInitAndTrack(repoRoot); // git init + enable
      if (rootRef.current === repoRoot) {
        setStatus(next);
        if (next.tracked) {
          clearConfirmTimer();
          confirmTimer.current = window.setTimeout(() => {
            if (rootRef.current === repoRoot) setDismissed(true);
          }, CONFIRM_MS);
        }
      }
    } catch {
      /* leave the notice up so the user can retry */
    } finally {
      setBusy(false);
    }
  }, [status, repoRoot]);

  if (!repoRoot || dismissed || !status) return null;

  // Already tracked and nothing new to announce → stay silent.
  if (status.is_git && status.tracked && !status.newly_enabled) return null;

  // ── Success confirmation (just turned on) ──────────────────────────────
  if (status.is_git && status.tracked && status.newly_enabled) {
    return (
      <div
        className="flex items-center gap-2 h-7 px-3 text-[11.5px] border-b"
        style={{
          background: "color-mix(in oklab, var(--color-green) 12%, transparent)",
          borderColor: "color-mix(in oklab, var(--color-green) 34%, transparent)",
          color: "var(--color-green)",
        }}
        role="status"
      >
        <span
          className="inline-block w-1.5 h-1.5 rounded-full"
          style={{ background: "var(--color-green)" }}
        />
        <span className="font-medium uppercase tracking-wide text-[10px]">
          Aura on
        </span>
        <span className="text-text-2 truncate flex-1">
          Now tracking this project — every AI edit gets a reason, and off-scope
          changes get flagged.
        </span>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          className="text-[12px] w-5 h-5 rounded hover:bg-bg-2 transition-colors text-text-4 hover:text-text-1"
          title="Dismiss"
        >
          ✕
        </button>
      </div>
    );
  }

  // ── Action notice (non-git, or enable didn't stick) ────────────────────
  const label = status.is_git
    ? "Aura couldn't start tracking this repo."
    : status.detail ||
      "This folder isn't a Git repository yet. Aura tracks changes on top of Git.";
  const cta = status.is_git ? "Retry" : "Turn on Aura";

  return (
    <div
      className="flex items-center gap-2 h-7 px-3 text-[11.5px] border-b"
      style={{
        background: "color-mix(in oklab, var(--color-amber) 12%, transparent)",
        borderColor: "color-mix(in oklab, var(--color-amber) 34%, transparent)",
        color: "var(--color-amber)",
      }}
      role="status"
    >
      <span
        className="inline-block w-1.5 h-1.5 rounded-full"
        style={{ background: "var(--color-amber)" }}
      />
      <span className="font-medium uppercase tracking-wide text-[10px]">
        Aura off
      </span>
      <span className="text-text-2 truncate flex-1">{label}</span>
      <button
        type="button"
        onClick={turnOn}
        disabled={busy}
        className="flex items-center gap-1 text-[10.5px] px-2 py-0.5 rounded font-medium bg-accent text-bg-0 hover:opacity-90 disabled:opacity-50"
        title={
          status.is_git
            ? "Start tracking this project with Aura"
            : "Set this folder up for Git and start tracking it with Aura"
        }
      >
        {/* Inherits the button's ink — the spinner's usual amber would sit on
            the accent fill and disappear. */}
        {busy && <AsciiSpinner className="text-[10.5px] leading-none text-bg-0" />}
        {busy ? "Working…" : cta}
      </button>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        className="text-[12px] w-5 h-5 rounded hover:bg-bg-2 transition-colors text-text-4 hover:text-text-1"
        title="Dismiss"
      >
        ✕
      </button>
    </div>
  );
}
