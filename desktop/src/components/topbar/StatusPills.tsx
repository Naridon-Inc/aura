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

import { useEffect, useState } from "react";
import { api } from "../../lib/api";

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
}: Props) {
  const [state, setState] = useState<State>({
    strict: false,
    captureOff: false,
  });

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
  const toneCls =
    tone === "ok"
      ? "border-line/60 text-text-2 hover:bg-bg-2"
      : tone === "warn"
        ? "border-amber-500/40 text-amber-300 hover:bg-amber-500/10"
        : tone === "info"
          ? "border-line/60 text-text-2 hover:bg-bg-2"
          : "border-line/40 text-text-3 hover:bg-bg-2";
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

function LockGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
      <rect x="3" y="7" width="10" height="7" rx="1.2" stroke="currentColor" />
      <path d="M5 7V5a3 3 0 016 0v2" stroke="currentColor" />
    </svg>
  );
}

function ShieldGlyph() {
  // Arctic-blue stroke marks it as a primary affordance (turn this on),
  // not a warning — capture being off isn't an error, it's an invite.
  return (
    <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
      <path
        d="M8 1.5l5 2v4c0 3.2-2.1 5.5-5 7-2.9-1.5-5-3.8-5-7v-4l5-2z"
        stroke="var(--color-accent, #4aa8ff)"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

