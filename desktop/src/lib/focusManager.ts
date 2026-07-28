// Right-rail Manager is the single home for manager sessions. Workspace-tab
// "Aura Manager" entries are gone; instead, callers that want to bring a
// session to the user's attention persist it as the ambient session for
// the project and dispatch this event. App.tsx flips the right rail to
// "aura"; AuraRailPanel re-reads the persisted sid when the project root
// matches.

import { sendAmbientManagerTurn } from "./managerTurn";

export type FocusManagerDetail = {
  repoRoot: string;
  sessionId: string;
};

export const FOCUS_MANAGER_EVENT = "aura:focus-manager";

const ambientKey = (repoRoot: string) => `aura.ambient.${repoRoot}`;

export function focusAmbientManager(repoRoot: string, sessionId: string): void {
  try {
    localStorage.setItem(ambientKey(repoRoot), sessionId);
  } catch {
    /* localStorage quota — non-fatal */
  }
  window.dispatchEvent(
    new CustomEvent<FocusManagerDetail>(FOCUS_MANAGER_EVENT, {
      detail: { repoRoot, sessionId },
    }),
  );
}

/**
 * Send a message INTO the project's ambient Manager session, creating one when
 * none exists, then focus the rail on it. This is how non-chat surfaces (the
 * Checks bar's Review/Prove/Attest rows, PR copilot buttons, launch glue)
 * dispatch work to the brain.
 *
 * Delegates to `sendAmbientManagerTurn` — the SAME faithful path the in-app
 * composer and the floating HUD use. That was the fix for the reported bug: a
 * message written to the chat from Checks (not typed in the composer) showed no
 * working state and no streamed tool calls. The bare `manager_chat` this used
 * to call never armed the in-flight registry (so ManagerChatView's "adopt a
 * turn started outside this view" effect never lit "Working…") and never took
 * the native `brain_chat_turn` path (so tool_use cards never streamed into the
 * open chat). Routing through `sendAmbientManagerTurn` marks the turn in-flight,
 * stamps the elapsed timer, and dispatches on the correct native/legacy path —
 * so an injected turn now behaves exactly like a typed one. It also validates
 * the persisted ambient sid still belongs to this project and focuses the rail
 * internally. Returns the session id the message landed in.
 */
export async function sendToAmbientManager(repoRoot: string, text: string): Promise<string> {
  return sendAmbientManagerTurn(repoRoot, text);
}
