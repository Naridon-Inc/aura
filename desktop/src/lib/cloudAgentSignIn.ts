// Signing an agent in for cloud workspaces from this computer.
//
// The desktop runs the agent's own sign-in — Claude Code's setup token,
// Codex's ChatGPT sign-in — the member finishes it in their browser, and the
// result is saved for their cloud workspaces. Nothing secret comes back
// here: only where the sign-in is, a link to open, a one-time code to enter,
// and who it signed in as.

import { invoke } from "@tauri-apps/api/core";

import type { Harness } from "./cloudAgentCredentials";

export type SignInAgent = Extract<Harness, "claude" | "codex">;

export type SignInPhase = "starting" | "browser" | "device_code" | "saving" | "connected" | "failed" | "cancelled";

export type SignInStatus = {
  phase: SignInPhase;
  /** The sign-in page on the agent's own site, once the CLI prints it. */
  url: string | null;
  /** The one-time code to enter at `url` (Codex's device sign-in). */
  code: string | null;
  /** Claude Code is asking for the code its sign-in page shows: `required`
   *  when it can't go on without it, `optional` when the browser may hand
   *  it back on its own. */
  codePrompt: "optional" | "required" | null;
  /** Who it signed in as, when the sign-in says. */
  account: string | null;
  error: string | null;
  /** The agent's CLI is not on this computer. */
  missingCli: boolean;
  /** The org's computer the sign-in runs on, when it runs there and not
   *  here — a member connecting from the web console. Absent in the app. */
  computer?: string | null;
};

export type SignInStarted = { id: string; status: SignInStatus };

export const agentSignInApi = {
  start: (agent: SignInAgent, workspaceId?: string | null) =>
    invoke<SignInStarted>("cloud_agent_signin_start", { agent, workspaceId: workspaceId ?? null }),
  status: (id: string) => invoke<SignInStatus>("cloud_agent_signin_status", { id }),
  code: (id: string, code: string) => invoke<void>("cloud_agent_signin_code", { id, code }),
  cancel: (id: string) => invoke<void>("cloud_agent_signin_cancel", { id }),
};

/** The agents this computer can sign in for the cloud. */
export function canSignIn(h: Harness): h is SignInAgent {
  return h === "claude" || h === "codex";
}

/** Still going: the member has something to do, or the save is landing. */
export function signInRunning(phase: SignInPhase): boolean {
  return phase === "starting" || phase === "browser" || phase === "device_code" || phase === "saving";
}

/** The one line that says where a sign-in is. */
export function signInLine(s: SignInStatus): string {
  switch (s.phase) {
    case "starting":
      return s.computer ? `Starting the sign-in on ${s.computer}…` : "Opening the sign-in page…";
    case "browser":
      return s.computer ? "Sign in on the Claude page, then paste the code it shows you." : "Finish signing in in your browser…";
    case "device_code":
      return "Enter this code on the sign-in page";
    case "saving":
      return "Saving your sign-in…";
    case "connected":
      return s.account ? `Connected as ${s.account}` : "Connected";
    case "failed":
      return s.error || "Sign-in didn’t finish. Try again.";
    case "cancelled":
      return "Sign-in stopped.";
  }
}

/** A pasted code as the CLI takes it: one word, nothing around it. Null
 *  when there is nothing to send. */
export function pastedCode(raw: string): string | null {
  const code = raw.trim();
  return code && !/\s/.test(code) ? code : null;
}
