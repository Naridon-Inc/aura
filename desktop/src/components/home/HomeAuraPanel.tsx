// Aura beside Home — the conversation that manages every project, docked to
// the page that lists every project's workspaces.
//
// It is the same chat the workpane mounts (`ManagerSurface`, tab chrome off)
// rather than a second one: the transcript, the composer, the history menu
// and the tools are all that surface's. What this file adds is the frame a
// side panel needs — a slim header with "New chat" and a way to fold the
// panel away — and a host for the chat, so a conversation picked from its
// history replaces the panel's instead of opening a tab hidden behind Home.
//
// Rendered only when `AURA_MANAGER_ENABLED` is on; the caller asks
// lib/homeAuraPanel, which folds the flag in before the stored layout.

import { useEffect, useMemo, useRef } from "react";
import { PanelRightClose, PanelRightOpen, Plus } from "lucide-react";
import { Button } from "../ui/button";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { ManagerSurface } from "../manager/ManagerSurface";
import { ChatHostProvider, type ChatHost } from "../manager/chat/chatHost";
import "./home-aura-panel.css";

export const AURA_PANEL_SHORTCUT = "⌥⇧⌘A";

export type HomeAuraPanelProps = {
  /** The orchestrator session on show; null while one is being found. */
  sessionId: string | null;
  /** A session lookup is in flight. */
  resolving: boolean;
  /** There is a project to start a first conversation against. */
  hasAnchor: boolean;
  /** Bumped to put the cursor in the composer (each Aura door does). */
  focusNonce: number;
  onNewChat: () => void;
  onOpenSession: (sessionId: string) => void;
  onCollapse: () => void;
  /** First run with nothing open: get a folder so a conversation can start. */
  onOpenProject: () => void;
};

export function HomeAuraPanel({
  sessionId,
  resolving,
  hasAnchor,
  focusNonce,
  onNewChat,
  onOpenSession,
  onCollapse,
  onOpenProject,
}: HomeAuraPanelProps) {
  const rootRef = useRef<HTMLDivElement>(null);

  // Focus THIS panel's composer. The app-wide `aura:focus-composer` event
  // would focus every mounted composer, and the last one to run wins — which
  // need not be the one you just asked for. The chat may still be loading
  // when the door is pressed, so look for its input for up to a second.
  useEffect(() => {
    if (!focusNonce || !sessionId) return;
    let tries = 0;
    let frame = 0;
    const tick = () => {
      const input = rootRef.current?.querySelector<HTMLTextAreaElement>("textarea");
      if (input) {
        input.focus();
        return;
      }
      tries += 1;
      if (tries < 60) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [focusNonce, sessionId]);

  const host = useMemo<ChatHost>(
    () => ({ openSession: (sid) => onOpenSession(sid), scope: "aura" }),
    [onOpenSession],
  );

  return (
    <aside className="home-aura-panel" data-aura-panel="" aria-label="Aura">
      <div className="home-aura-panel__header">
        <span className="home-aura-panel__title">Aura</span>
        <span className="home-aura-panel__space" />
        <Button
          variant="ghost"
          size="xs"
          onClick={onNewChat}
          disabled={!hasAnchor && !sessionId}
          title="Start a new conversation with Aura"
        >
          <Plus />
          New chat
        </Button>
        <Button
          variant="ghost"
          size="iconXs"
          onClick={onCollapse}
          aria-label="Hide Aura"
          title={`Hide Aura (${AURA_PANEL_SHORTCUT})`}
        >
          <PanelRightClose />
        </Button>
      </div>
      <div ref={rootRef} className="home-aura-panel__body">
        {sessionId ? (
          <ChatHostProvider host={host}>
            <ManagerSurface key={sessionId} sessionId={sessionId} tabChrome={false} />
          </ChatHostProvider>
        ) : resolving || hasAnchor ? (
          <div className="home-aura-panel__empty">
            <AsciiSpinner className="text-sm leading-none" />
          </div>
        ) : (
          <div className="home-aura-panel__empty">
            <p>Aura works across every project you open. Open one to start the first conversation.</p>
            <Button size="sm" variant="outline" onClick={onOpenProject}>
              Open a project…
            </Button>
          </div>
        )}
      </div>
    </aside>
  );
}

/** The toolbar's Aura switch. Spells its name — an icon alone would leave you
 *  guessing what the panel is. */
export function AuraPanelToggle({ shown, onToggle }: { shown: boolean; onToggle: () => void }) {
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={onToggle}
      aria-pressed={shown}
      title={`${shown ? "Hide" : "Show"} Aura (${AURA_PANEL_SHORTCUT})`}
    >
      {shown ? <PanelRightClose /> : <PanelRightOpen />}
      Aura
    </Button>
  );
}
