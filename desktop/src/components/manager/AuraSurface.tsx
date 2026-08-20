// Aura — the command centre, as a window-owning surface rather than a tab.
//
// Aura reaches across every project: which agents are running, what's in
// flight on which branch, which PRs are waiting. Opening it as a tab inside a
// workspace framed all of that as if it belonged to whichever repo happened to
// be in front of you — the sample project's file tree down one side, its
// changed-file count down the other, its agent strip along the top. The
// conversation was global; everything around it said otherwise.
//
// So it opens the way Workspaces does: beside the sidebar, spanning the shell.
// As a PAGE, not a modal — Aura is a place you sit and work, and a dim backdrop
// with an "esc" chip framed it as an interruption you were expected to dismiss.
// Per the surface convention there is no title; the lit nav row and the content
// carry it. The chat itself is the same `ManagerSurface` the workpane mounts,
// with `tabChrome` off since the frame is supplied here.

import { FullscreenOverlay } from "../FullscreenOverlay";
import { ManagerSurface } from "./ManagerSurface";

export type AuraSurfaceProps = {
  /** The orchestrator session (see lib/orchestratorSession). */
  sessionId: string;
  onClose: () => void;
  /** Start a fresh Aura conversation and switch this surface onto it. */
  onNewThread?: () => void;
  /** Render in-flow in the content area (the default in the shell) rather than
   *  as a modal above it. The modal form is kept for popped-out windows. */
  asPage?: boolean;
};

export function AuraSurface({
  sessionId,
  onClose,
  onNewThread,
  asPage = false,
}: AuraSurfaceProps) {
  // `key` on the session id so switching threads remounts the chat cleanly
  // rather than replaying the previous one's stream state.
  const chat = (
    <div className="flex h-full min-h-0 flex-col">
      <ManagerSurface
        key={sessionId}
        sessionId={sessionId}
        onNewThread={onNewThread}
        tabChrome={false}
      />
    </div>
  );

  // No PageFrame here: the chat has neither lenses nor header actions, so a
  // frame would only add an empty bar above it. The page IS the conversation.
  if (asPage) {
    return (
      <div className="flex h-full min-h-0 flex-col overflow-hidden bg-bg-content">
        {chat}
      </div>
    );
  }

  return (
    <FullscreenOverlay onClose={onClose} contentClassName="p-0">
      {chat}
    </FullscreenOverlay>
  );
}
