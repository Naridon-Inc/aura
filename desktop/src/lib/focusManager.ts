// Right-rail Manager is the single home for manager sessions. Workspace-tab
// "Aura Manager" entries are gone; instead, callers that want to bring a
// session to the user's attention persist it as the ambient session for
// the project and dispatch this event. App.tsx flips the right rail to
// "aura"; AuraRailPanel re-reads the persisted sid when the project root
// matches.

import { api } from "./api";

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

/** Trailing-slash-tolerant root compare — same rule AuraRailPanel applies
 *  when validating a persisted ambient sid. */
function sameRoot(a: string, b: string): boolean {
  const norm = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);
  return norm(a) === norm(b);
}

/**
 * Parity W8 — send a message INTO the project's ambient Manager session,
 * creating one when none exists, then focus the rail on it. This is how
 * non-chat surfaces (PR copilot buttons, launch glue) dispatch work to the
 * brain without reimplementing AuraRailPanel's session bookkeeping.
 *
 * Reuses the persisted ambient sid only after validating it still belongs to
 * this project (`manager_status` → projects roster) — a stale or
 * cross-workspace sid falls through to a fresh `manager_chat_start`, never a
 * silent misroute. Returns the session id the message landed in.
 */
export async function sendToAmbientManager(repoRoot: string, text: string): Promise<string> {
  let sid: string | null = null;
  try {
    sid = localStorage.getItem(ambientKey(repoRoot));
  } catch {
    sid = null;
  }

  if (sid) {
    try {
      const session = await api.managerStatus(sid);
      const owns = session.projects.some((p) => sameRoot(p.root, repoRoot));
      if (!owns) sid = null;
    } catch {
      // Session gone (app restart pruned it, file deleted) — start fresh.
      sid = null;
    }
  }

  if (sid) {
    await api.managerChat(sid, text);
  } else {
    // manager_chat_start seeds the session with the prompt as its objective;
    // the follow-up manager_chat delivers it as the first user turn so the
    // brain actually runs on it (same two-step AuraRailPanel.startSession does).
    sid = await api.managerChatStart(repoRoot, text);
    void api.managerChat(sid, text);
  }

  focusAmbientManager(repoRoot, sid);
  return sid;
}
