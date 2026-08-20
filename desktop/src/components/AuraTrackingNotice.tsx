// Thin top-strip that makes "Aura is always running" visible without
// nagging. On repo focus it calls `aura_ensure_tracked`, which silently
// turns on capture + wires the agents for any git repo. This component only
// renders when there's something worth saying:
//
//   • non-git folder  → a one-click "Turn on Aura" (runs git init + enable
//     in-app — never a trip to the terminal);
//   • enable failed    → a retry, or — when a retry provably can't work —
//     the thing that can;
//   • just turned on   → a brief "now tracking" confirmation that
//     auto-dismisses. When the repo was already tracked, it renders
//     nothing — silence is the success state.
//
// Two inks, both earned: green on the confirmation because it reports state,
// amber on the action strip because it's asking the reader to do something.
// Nothing here is coloured just to be a category.
//
// ── The dead "Try again" ────────────────────────────────────────────────
// On a fresh Ubuntu box with a 0.7.2 `aura` in /usr/local/bin, this strip read
// "Still off after trying — Aura couldn't switch on for this project. It said:
// error: unr…" and pressing Try again changed nothing, forever. Three separate
// reasons, all fixed here and in `cmd_aura_track.rs`:
//
//   1. `aura enable` didn't exist until 0.19.x, so a 0.7.2 binary answers
//      `error: unrecognized subcommand 'enable'`. Retrying re-runs a
//      subcommand that binary has never heard of. The press is now the update
//      instead — the only action that can actually clear it.
//   2. The backend caches which `aura` to run for the life of the process. A
//      user who fixed their CLI still got the old one on every press. It now
//      re-probes after any failure.
//   3. Every press produced byte-identical text, which is indistinguishable
//      from a button that isn't wired. The line now counts the tries and the
//      full error is one click away instead of being clipped into nothing.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  AURA_CLI_INSTALL_COMMAND,
  type AuraCliCheck,
  type AuraTrackStatus,
} from "../lib/api";
import { isNeedsAuthError } from "./CliUpdateToast";
import { AsciiSpinner } from "./ui/ascii-spinner";

type Props = {
  repoRoot: string;
  /** Fired when this strip updated the `aura` helper, so the footer chip can
   *  stop describing a binary that no longer exists. Two surfaces, one fact. */
  onCliUpdated?: (check: AuraCliCheck) => void;
};

// How long the green "now tracking" confirmation stays before it fades.
const CONFIRM_MS = 6_000;

/** Everything one attempt at turning Aura on left behind. Kept as one value
 *  so a press can only ever replace the whole picture — a half-updated
 *  screen after a retry is what made the button look broken. */
export type TrackAttempt = {
  /** The last answer from the backend, or null before the first one. */
  status: AuraTrackStatus | null;
  /** What the last attempt said when the call itself threw. Kept separate
   *  from `status.detail` so a thrown error can't be mistaken for a reported
   *  one. */
  error: string | null;
  /** How many times the person has pressed. 0 is the automatic pass on open,
   *  which nobody asked for and which mustn't be reported as a failed try. */
  attempts: number;
  /** The helper update needs an administrator password — the folder it lives
   *  in is root-owned. Only ever set by a press that hit it. */
  needsPassword: boolean;
};

/** The calls a press makes. Injected rather than reached for, so the retry
 *  path can be tested without a Tauri host — this is the thing that was
 *  broken, so it has to be the thing that's pinned. */
export type TrackDeps = {
  ensureTracked: (repoRoot: string) => Promise<AuraTrackStatus>;
  gitInitAndTrack: (repoRoot: string) => Promise<AuraTrackStatus>;
  installCli: (interactive?: boolean) => Promise<AuraCliCheck>;
};

export const liveTrackDeps: TrackDeps = {
  ensureTracked: (root) => api.auraEnsureTracked(root),
  gitInitAndTrack: (root) => api.auraGitInitAndTrack(root),
  installCli: (interactive) => api.auraCliInstallBundled(interactive),
};

/** The state an unopened project starts in. */
export const idleAttempt: TrackAttempt = {
  status: null,
  error: null,
  attempts: 0,
  needsPassword: false,
};

/** One press of the strip's button.
 *
 *  Unconditional by construction: there is no "already tried" branch, no
 *  early return, nothing a previous failure can leave behind that stops the
 *  next press from making the same calls again. Whatever it returns replaces
 *  the whole attempt state, so a press always lands somewhere visible.
 *
 *  When the last answer named an out-of-date helper, the press replaces the
 *  helper first and then runs the same attempt — a retry alone cannot clear
 *  that, and a button that repeats an impossible action is a lie. */
export async function pressTurnOn(
  deps: TrackDeps,
  repoRoot: string,
  prev: TrackAttempt,
  authorize = false,
): Promise<TrackAttempt & { cliCheck?: AuraCliCheck }> {
  const attempts = prev.attempts + 1;
  if (prev.status?.stale_cli) {
    try {
      const check = await deps.installCli(authorize);
      // Hand the fresh check back through the result so the caller can keep
      // the footer chip honest without a second round-trip.
      return {
        ...(await runAttempt(deps, repoRoot, prev, attempts)),
        cliCheck: check,
      };
    } catch (e) {
      if (isNeedsAuthError(e)) {
        return {
          status: prev.status,
          error:
            "Updating Aura's helper needs your computer's administrator password.",
          attempts,
          needsPassword: true,
        };
      }
      return {
        status: prev.status,
        error: plainError(e),
        attempts,
        needsPassword: false,
      };
    }
  }
  return runAttempt(deps, repoRoot, prev, attempts);
}

/** The attempt itself — git init first for a folder that isn't a repo yet,
 *  then the same idempotent enable the app runs on open. */
async function runAttempt(
  deps: TrackDeps,
  repoRoot: string,
  prev: TrackAttempt,
  attempts: number,
): Promise<TrackAttempt> {
  try {
    const status =
      prev.status && !prev.status.is_git
        ? await deps.gitInitAndTrack(repoRoot)
        : await deps.ensureTracked(repoRoot);
    return { status, error: null, attempts, needsPassword: false };
  } catch (e) {
    // The press must never vanish into nothing. Say what came back so the
    // next press is an informed one.
    return {
      status: prev.status,
      error: plainError(e),
      attempts,
      needsPassword: false,
    };
  }
}

/** What the strip says, given everything the last attempt left behind. */
export type NoticeCopy = {
  /** The single visible line. Clipped on screen, so it is written to put the
   *  fact and the fix in its opening words. */
  line: string;
  /** What the button says. Never "Try again" for a failure a retry can't fix. */
  cta: string;
  /** The unabridged diagnosis, revealed on demand. `null` when the visible
   *  line already is everything we know. */
  details: string | null;
  /** Offer the manual install command next to the details — the escape hatch
   *  for a machine where the in-app update can't write. */
  showInstallCommand: boolean;
};

export function noticeCopy(state: TrackAttempt): NoticeCopy {
  const { status, error, attempts, needsPassword } = state;
  const isGit = status?.is_git ?? true;
  const stale = status?.stale_cli ?? null;

  // A thrown error wins over a reported one (it's the more recent, more
  // specific news), and the generic line survives only as the last resort.
  const reason =
    error ??
    status?.detail ??
    (isGit
      ? "Aura couldn't start tracking this project."
      : "This folder isn't a Git repository yet. Aura tracks changes on top of Git.");

  // Name that the attempt happened, and count it. Silence after a press is
  // indistinguishable from a broken button — and so is text that never
  // changes no matter how many times you press.
  const line =
    attempts === 0
      ? reason
      : attempts === 1
        ? `Still off after trying. ${reason}`
        : `Still off after ${attempts} tries. ${reason}`;

  const cta = !isGit
    ? "Turn on Aura"
    : needsPassword
      ? "Enter password"
      : stale
        ? `Update to ${stale.expected}`
        : attempts > 0
          ? "Try again"
          : "Retry";

  const parts: string[] = [];
  if (stale) {
    parts.push(`The out-of-date copy is at ${stale.path}`);
  }
  const raw = status?.raw_detail?.trim();
  if (raw && raw !== reason) {
    parts.push(`Aura's helper said:\n${raw}`);
  }

  return {
    line,
    cta,
    details: parts.length > 0 ? parts.join("\n\n") : null,
    // A missing helper has no version to be stale, but the command that
    // installs one is exactly as useful there.
    showInstallCommand:
      stale !== null || (raw?.includes("couldn't start Aura") ?? false),
  };
}

export function AuraTrackingNotice({ repoRoot, onCliUpdated }: Props) {
  const [attempt, setAttempt] = useState<TrackAttempt>(idleAttempt);
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

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
    setAttempt(idleAttempt);
    setDismissed(false);
    setExpanded(false);
    clearConfirmTimer();

    api
      .auraEnsureTracked(repoRoot)
      .then((s) => {
        if (!alive || rootRef.current !== repoRoot) return;
        setAttempt({ ...idleAttempt, status: s });
        // Auto-fade the "now tracking" confirmation; leave the non-git /
        // failed notices up until the user acts on them.
        if (s.is_git && s.tracked && s.newly_enabled) {
          confirmTimer.current = window.setTimeout(() => {
            if (rootRef.current === repoRoot) setDismissed(true);
          }, CONFIRM_MS);
        }
      })
      .catch((e) => {
        // Best-effort on open — a hiccup mustn't wedge the workspace — but the
        // strip still has to appear, or the project silently isn't recorded
        // and nothing on screen ever says so.
        if (!alive || rootRef.current !== repoRoot) return;
        setAttempt({
          ...idleAttempt,
          error: plainError(e),
          status: {
            repo_root: repoRoot,
            is_git: true,
            tracked: false,
            newly_enabled: false,
            wired: false,
            detail: null,
            stale_cli: null,
            raw_detail: null,
          },
        });
      });

    return () => {
      alive = false;
      clearConfirmTimer();
    };
  }, [repoRoot]);

  const turnOn = useCallback(
    async (authorize = false) => {
      setBusy(true);
      try {
        const next = await pressTurnOn(
          liveTrackDeps,
          repoRoot,
          attempt,
          authorize,
        );
        if (rootRef.current !== repoRoot) return;
        if (next.cliCheck) onCliUpdated?.(next.cliCheck);
        setAttempt(next);
        if (next.status?.tracked) {
          clearConfirmTimer();
          confirmTimer.current = window.setTimeout(() => {
            if (rootRef.current === repoRoot) setDismissed(true);
          }, CONFIRM_MS);
        }
      } finally {
        setBusy(false);
      }
    },
    [attempt, repoRoot, onCliUpdated],
  );

  const status = attempt.status;
  if (!repoRoot || dismissed || !status) return null;

  // Already tracked and nothing new to announce → stay silent.
  if (status.is_git && status.tracked && !status.newly_enabled) return null;

  // ── Success confirmation (just turned on) ──────────────────────────────
  if (status.is_git && status.tracked && status.newly_enabled) {
    return (
      <div
        className="flex items-center gap-2 h-7 px-3 text-sm border-b"
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
        <span className="section-label">
          Aura on
        </span>
        <span className="text-text-2 truncate flex-1">
          Now tracking this project. Every AI edit gets a reason, and off-scope
          changes get flagged.
        </span>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          className="text-sm w-5 h-5 rounded hover:bg-state-hover transition-colors text-text-4 hover:text-text-1"
          title="Dismiss"
        >
          ✕
        </button>
      </div>
    );
  }

  // ── Action notice (non-git, or enable didn't stick) ────────────────────
  const { line, cta, details, showInstallCommand } = noticeCopy(attempt);

  function copyInstall() {
    navigator.clipboard
      ?.writeText(AURA_CLI_INSTALL_COMMAND)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  }

  return (
    <div
      className="border-b"
      style={{
        background: "color-mix(in oklab, var(--color-amber) 12%, transparent)",
        borderColor: "color-mix(in oklab, var(--color-amber) 34%, transparent)",
        color: "var(--color-amber)",
      }}
      role="status"
    >
      <div className="flex items-center gap-2 h-7 px-3 text-sm">
        <span
          className="inline-block w-1.5 h-1.5 rounded-full"
          style={{ background: "var(--color-amber)" }}
        />
        <span className="section-label">
          Aura off
        </span>
        {/* The strip is one line tall, so a long reason clips — the full text
            stays reachable on hover, and everything the tool actually said is
            behind Details rather than lost to the clip. */}
        <span className="text-text-2 truncate flex-1" title={line}>
          {line}
        </span>
        {details && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="text-xs px-1.5 py-0.5 rounded hover:bg-state-hover text-text-3"
            aria-expanded={expanded}
            title={expanded ? "Hide the full message" : "Show the full message"}
          >
            {expanded ? "Hide details" : "Details"}
          </button>
        )}
        <button
          type="button"
          onClick={() => void turnOn(attempt.needsPassword)}
          disabled={busy}
          className="flex items-center gap-1 text-xs px-2 py-0.5 rounded font-medium bg-accent text-bg-0 hover:opacity-90 disabled:opacity-50"
          title={
            !status.is_git
              ? "Set this folder up for Git and start tracking it with Aura"
              : attempt.needsPassword
                ? "Update Aura's helper — this asks for your password"
                : status.stale_cli
                  ? "Replace the out-of-date Aura helper on this computer, then switch tracking on"
                  : "Start tracking this project with Aura"
          }
        >
          {/* Inherits the button's ink — the spinner's usual amber would sit on
              the accent fill and disappear. */}
          {busy && <AsciiSpinner className="text-xs leading-none text-bg-0" />}
          {busy ? "Working…" : cta}
        </button>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          className="text-sm w-5 h-5 rounded hover:bg-state-hover transition-colors text-text-4 hover:text-text-1"
          title="Dismiss"
        >
          ✕
        </button>
      </div>
      {expanded && details && (
        <div className="px-3 pb-2 flex flex-col gap-1.5">
          <pre className="m-0 font-mono text-xs whitespace-pre-wrap break-words text-text-3 select-text">
            {details}
          </pre>
          {showInstallCommand && (
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-text-4">or install it yourself:</span>
              <code
                className="flex-1 font-mono text-xs px-1.5 py-1 rounded bg-bg-2 truncate text-text-3"
                title={AURA_CLI_INSTALL_COMMAND}
              >
                {AURA_CLI_INSTALL_COMMAND}
              </code>
              <button
                type="button"
                onClick={copyInstall}
                className="text-xs px-2 py-1 rounded hover:bg-state-hover text-text-3"
                title="Copy install command"
              >
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Flatten whatever a rejected call hands back — our own error string, an
 *  Error, or something stranger — into one readable line. Never returns an
 *  empty string: an empty message is exactly how a failure turns invisible and
 *  a button starts looking dead. */
function plainError(e: unknown): string {
  const raw = typeof e === "string" ? e : e instanceof Error ? e.message : "";
  const first = raw.split("\n")[0]?.trim() ?? "";
  return (
    first ||
    "Aura couldn't reach its own engine on this computer. Try again in a moment."
  );
}
