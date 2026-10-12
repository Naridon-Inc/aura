// An agent tab's pane: the chrome around a terminal, and the choice of which
// engine draws it.
//
// The pane itself is whatever the user's engine setting says — the native GPU
// canvas by default, xterm.js in the page when they've turned it off or when
// the GPU path can't come up on this machine. Everything else here is about
// the session rather than the pixels, and is the same either way: a restored
// tab whose process is gone offers to start it, a mid-session exit gets a
// Restart banner over the bottom edge, and a dropped file becomes input at the
// prompt.
//
// The engine is picked once per mount. Switching it in Settings takes effect
// for panes opened afterwards — swapping a live agent's renderer mid-stream
// would mean tearing down the surface the user is reading.

import { useCallback, useRef, useState } from "react";

import { Button } from "../ui/button";
import { AgentPausedPane } from "./AgentPausedPane";
import { AgentNativeCanvas } from "./AgentNativeCanvas";
import { AgentXtermCanvas } from "./AgentXtermCanvas";
import { acceptsAgentDrag, applyAgentDrop } from "./agentDrop";
import { useAgentPtyLifecycle } from "./useAgentPtyLifecycle";
import { isNativeTerminalEnabled } from "../../lib/nativeTerminalStore";

type Props = {
  sessionId: string;
  /** Which CLI this tab runs, its display name, and the checkout it runs in.
   *  Only the paused pane needs them — it reads the agent's own transcript to
   *  show what the conversation was about before offering to resume it. */
  agentId?: string;
  agentLabel?: string;
  repoRoot?: string;
  /** The agent's OWN session id this tab resumes (Claude's JSONL stem), not
   *  our PTY `sessionId`. */
  resumeSessionId?: string | null;
  /** Called when this view detects the PTY is gone — either dead at
   *  mount (post-restart / post-auto-update stale tab) or exited
   *  mid-session. The parent owns spawn, so it respawns with the same
   *  agent_id + repo_root and swaps tab.sessionId in place; this view
   *  remounts on the new id silently. No banner, no user friction. */
  onAutoRespawn?: () => void | Promise<void>;
  /** Restart this agent because the user asked — the "Restart" banner and
   *  the dormant pane's "Start". Separate from `onAutoRespawn` because that
   *  prop doubles as the *silent* relaunch policy: a detached window
   *  deliberately withholds it so a dead agent never comes back on its own,
   *  and that decision used to disable the explicit Restart button too.
   *  Falls back to `onAutoRespawn` when unset, which is what the in-app
   *  surface wants — there, one spawn serves both. */
  onRestart?: () => void | Promise<void>;
  /** Cold/click-to-start. When true and the PTY is dead at mount, the
   *  view shows a "Start agent" affordance instead of silently
   *  respawning — a workspace restore must not relaunch a Claude
   *  process the user didn't ask for. Ignored when the PTY is alive
   *  (the view attaches as normal). Starting clears it upstream
   *  (replaceAgent gives a fresh, non-dormant tab). */
  dormant?: boolean;
  /** Total paused agents in the workspace. When >1 the dormant overlay
   *  offers a "Start all (N)" affordance alongside the single Start. */
  dormantCount?: number;
  /** Resume every paused agent at once. Only wired by the parent when
   *  more than one dormant tab exists. */
  onStartAll?: () => void | Promise<void>;
};

export function AgentTerminalView({
  sessionId,
  agentId,
  agentLabel,
  repoRoot,
  resumeSessionId,
  dormant,
  dormantCount,
  onStartAll,
  onAutoRespawn,
  onRestart,
}: Props) {
  // What an explicit Start/Restart click runs. Only the automatic paths
  // inside the lifecycle hook read `onAutoRespawn` directly.
  const restart = onRestart ?? onAutoRespawn;
  const [starting, setStarting] = useState(false);
  const [startingAll, setStartingAll] = useState(false);
  // Read once: see the file header on why the engine doesn't change under a
  // live pane. A GPU surface that won't start downgrades this to xterm, and
  // stays downgraded for as long as the pane lives.
  const [native, setNative] = useState(isNativeTerminalEnabled);
  const sessionAtMount = useRef(sessionId);
  if (sessionAtMount.current !== sessionId) {
    // The tab was respawned onto a fresh PTY — a new pane, so re-ask the
    // setting rather than inheriting a downgrade the old session caused.
    sessionAtMount.current = sessionId;
    setNative(isNativeTerminalEnabled());
  }
  // Stable by construction: the canvas treats this as a lifetime input, and a
  // fresh closure per render used to make it re-open its GPU surface every
  // time this component re-rendered.
  const dropToXterm = useCallback(() => setNative(false), []);

  const { showStart, exited } = useAgentPtyLifecycle({
    sessionId,
    dormant,
    onAutoRespawn,
  });

  const onDragOver = (e: React.DragEvent) => {
    if (acceptsAgentDrag(e.dataTransfer)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    }
  };
  const onDrop = (e: React.DragEvent) => {
    if (!acceptsAgentDrag(e.dataTransfer)) return;
    e.preventDefault();
    applyAgentDrop(sessionId, e.dataTransfer);
  };

  const handleStart = async () => {
    if (!restart || starting || startingAll) return;
    setStarting(true);
    try {
      // Spawns a fresh PTY upstream; replaceAgent swaps tab.sessionId so
      // this view remounts live (dormant cleared) and the overlay drops.
      await restart();
    } catch {
      // Spawn failed — let the user retry rather than stranding the tab.
      setStarting(false);
    }
  };

  const handleStartAll = async () => {
    if (!onStartAll || starting || startingAll) return;
    setStartingAll(true);
    try {
      // Resumes every paused agent; this tab is one of them, so its
      // replaceAgent remounts the view live and the overlay drops.
      await onStartAll();
    } catch {
      setStartingAll(false);
    }
  };

  return (
    <div
      className="h-full w-full relative"
      data-os-drop="terminal"
      data-agent-session={sessionId}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      {native ? (
        <AgentNativeCanvas sessionId={sessionId} onUnavailable={dropToXterm} />
      ) : (
        <AgentXtermCanvas sessionId={sessionId} />
      )}
      {showStart && (
        <AgentPausedPane
          agentId={agentId}
          agentLabel={agentLabel}
          repoRoot={repoRoot}
          resumeSessionId={resumeSessionId}
          dormantCount={dormantCount}
          starting={starting}
          startingAll={startingAll}
          canStart={Boolean(restart)}
          onStart={handleStart}
          onStartAll={onStartAll ? handleStartAll : undefined}
        />
      )}
      {exited && !showStart && (
        <div className="absolute inset-x-0 bottom-0 z-10 flex items-center gap-3 border-t border-line-soft bg-bg-1/95 px-4 py-2.5 backdrop-blur-sm">
          <span
            className="h-2 w-2 shrink-0 rounded-full"
            style={{ background: "var(--color-text-4)" }}
            aria-hidden
          />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-text-2">Agent exited</div>
            <div className="truncate text-xs text-text-4">
              The session ended. Aura won't relaunch it automatically.
            </div>
          </div>
          <Button
            variant="accentSoft"
            size="sm"
            onClick={handleStart}
            disabled={starting || !restart}
          >
            {starting ? "Restarting…" : "Restart"}
          </Button>
        </div>
      )}
    </div>
  );
}
