// Compact status pills mounted in the right cluster of the TopBar
// (relocated to the footer's `trailing` slot in ADE). Each pill exposes
// a piece of project state that used to require opening a dedicated rail
// tile (strict mode, hub, active agents). They are self-polling — the
// host stays project-agnostic.
//
// NOTE: `branch` used to live here too, but the footer now owns a
// first-class BranchSwitcher (list/checkout/create), so the read-only
// branch Pill was removed to avoid showing the branch twice. `onOpenGit`
// is kept in Props (optional) for call-site compatibility but unused.
//
// Click handlers route the user to the appropriate next surface:
// strict → settings, hub → settings, agents → focus the chat (right
// rail).

import { useEffect, useMemo, useState } from "react";
import { api } from "../../lib/api";
import {
  isManagerTurnInFlight,
  useManagerSummaries,
  useManagerTurnsTick,
} from "../../lib/managerStore";
import { AsciiSpinner } from "../ui/ascii-spinner";

type Props = {
  repoRoot: string | null;
  onOpenGit?: () => void;
  onOpenSettings?: () => void;
  /** Strict is a first-class feature, not a generic setting — route it
   *  straight to the Security & Policy page (the strict-mode controls),
   *  never a random settings pane. Falls back to onOpenSettings. */
  onOpenStrict?: () => void;
  onFocusChat?: () => void;
  /** Deep-link to the Capture pane (Settings → Capture) so the user can
   *  turn on the no-MCP passive capture in one click. Falls back to
   *  onOpenSettings. */
  onOpenCapture?: () => void;
};

type State = {
  strict: boolean;
  /** True only when the current repo IS a git repo but Aura's capture
   *  hooks are NOT installed — i.e. the actionable "you haven't enabled
   *  the no-MCP capture yet" state. Anything else (non-git, already on)
   *  stays quiet. */
  captureOff: boolean;
};

export function StatusPills({
  repoRoot,
  onOpenSettings,
  onOpenStrict,
  onOpenCapture,
  onFocusChat,
}: Props) {
  const [state, setState] = useState<State>({
    strict: false,
    captureOff: false,
  });

  // "Aura is working" — the persistent chat activity signal. The manager
  // chat surface unmounts the moment you focus a Claude terminal, so its
  // in-view working spinner vanishes and it looks like the turn died. The
  // TopBar/footer is always mounted, so mirror the in-flight state here:
  // whenever a manager turn for THIS project is running, show a labeled
  // spinner pill that jumps straight back to the chat. Reads the same
  // module-level turn registry the chat tab uses (survives the unmount) and
  // re-renders immediately on arm/clear via the turns tick, not just the 5s
  // summary poll.
  const summaries = useManagerSummaries();
  const turnsTick = useManagerTurnsTick();
  const chatWorking = useMemo(() => {
    void turnsTick; // reactive dep: re-evaluate the instant a turn arms/clears
    const belongs = (r: string | null) =>
      repoRoot ? !!r && sameRoot(r, repoRoot) : !r;
    return summaries.some(
      (s) =>
        belongs(s.repo_root) &&
        (isManagerTurnInFlight(s.id) || s.status === "running"),
    );
  }, [summaries, repoRoot, turnsTick]);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      const next: State = {
        strict: false,
        captureOff: false,
      };
      try {
        const s = await api.settingsLoad();
        next.strict = s.strict_gatekeeper_mode;
      } catch {}
      if (repoRoot) {
        try {
          const cap = await api.captureStatus(repoRoot);
          next.captureOff = cap.is_git && !cap.enabled;
        } catch {}
      }
      if (!cancelled) setState(next);
    };
    poll();
    const id = window.setInterval(poll, 4000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [repoRoot]);

  return (
    <div className="flex items-center gap-1 text-text-3">
      {chatWorking && (
        // Live: an Aura chat turn is running in this project. Persists here
        // while you're off in a terminal (where the chat's own spinner is
        // unmounted); click to jump back to the conversation.
        <Pill
          tone="ok"
          title="Aura is working in this project — click to open the chat"
          onClick={onFocusChat}
        >
          <AsciiSpinner className="text-[11px]" />
          <span>Aura</span>
        </Pill>
      )}
      {state.captureOff && (
        // Adoption nudge: this git repo has no Aura capture hooks yet.
        // Click → Settings → Capture, where one button installs them
        // (no MCP server, no wizard). Hidden once capture is on, so it's
        // a one-time on-ramp, never persistent chrome.
        <Pill
          tone="info"
          title="Aura isn't recording changes in this project yet — click to turn it on"
          onClick={onOpenCapture ?? onOpenSettings}
        >
          <ShieldGlyph />
          <span>Capture off</span>
        </Pill>
      )}
      {state.strict && (
        <Pill
          tone="warn"
          title="Strict mode is on — open Security & Policy"
          onClick={onOpenStrict ?? onOpenSettings}
        >
          <LockGlyph />
          <span>Strict</span>
        </Pill>
      )}
    </div>
  );
}

function Pill({
  children,
  title,
  onClick,
  tone,
}: {
  children: React.ReactNode;
  title: string;
  onClick?: () => void;
  tone: "neutral" | "ok" | "warn" | "info";
}) {
  // Every pill is a neutral chip; the WORDS say what the state is. "warn"
  // used to be a raw amber-500/amber-300 pair — an off-token colour, and the
  // only thing shouting in an otherwise quiet strip. Strict mode being on is
  // a fact about the project, not an alarm, so it reads like the rest and
  // just inks a touch brighter.
  const toneCls =
    tone === "warn"
      ? "border-line text-text-1 hover:bg-bg-2"
      : tone === "neutral"
        ? "border-line/40 text-text-3 hover:bg-bg-2"
        : "border-line/60 text-text-2 hover:bg-bg-2";
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={`h-[20px] px-2 flex items-center gap-1.5 text-[11px] rounded-[6px] border bg-bg-1 transition-colors ${toneCls}`}
    >
      {children}
    </button>
  );
}

function sameRoot(a: string, b: string): boolean {
  const norm = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);
  return norm(a) === norm(b);
}

function LockGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
      <rect x="3" y="7" width="10" height="7" rx="1.2" stroke="currentColor" />
      <path d="M5 7V5a3 3 0 016 0v2" stroke="currentColor" />
    </svg>
  );
}

function ShieldGlyph() {
  // The product accent marks it as a primary affordance (turn this on), not a
  // warning — capture being off isn't an error, it's an invite. Straight off
  // the token, no hex fallback: a stale literal here outlives every retune of
  // the accent and quietly reintroduces a colour the palette dropped.
  return (
    <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
      <path
        d="M8 1.5l5 2v4c0 3.2-2.1 5.5-5 7-2.9-1.5-5-3.8-5-7v-4l5-2z"
        stroke="var(--color-accent)"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

