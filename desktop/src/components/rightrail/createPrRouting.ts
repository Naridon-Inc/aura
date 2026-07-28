// Feature 3 — routing for the right-side "Create PR" action. Instead of
// dumping the user on GitHub's blank compare page (or spawning a fresh
// throwaway agent), clicking Create PR DISPATCHES the PR-creation prompt to
// the agent the user is already working with — exactly as if they'd typed
// "create a pull request for these changes" into the active session.
//
// Two reused seams, preferred in order:
//   1. A LIVE agent session for this repo → inject the prompt into its running
//      PTY via the App's existing `aura:hand-task-to-agent` inject path (the
//      one that focuses the tab + `agentPtySendPrompt`s into it).
//   2. No live agent → hand it to the project's ambient Aura session through
//      `sendToAmbientManager` (focusManager), which reuses the persisted
//      session or starts one, then focuses the rail on it.
// Either way the user watches the agent review + open the PR; nothing is faked.

import { sendToAmbientManager } from "../../lib/focusManager";

/** The active agent session to route into, when one is live for the repo.
 *  `agentId` / `label` mirror the running tab so the reopened tab keeps its
 *  identity; `sessionId` is what the inject path targets. */
export type ActiveAgentSession = {
  sessionId: string;
  agentId: string;
  label: string;
};

export async function routeCreatePr(
  repoRoot: string,
  prompt: string,
  active?: ActiveAgentSession | null,
): Promise<void> {
  if (active) {
    window.dispatchEvent(
      new CustomEvent("aura:hand-task-to-agent", {
        detail: {
          agent: active.agentId,
          label: active.label,
          prompt,
          cwd: repoRoot,
          sessionId: active.sessionId,
        },
      }),
    );
    return;
  }
  await sendToAmbientManager(repoRoot, prompt);
}
