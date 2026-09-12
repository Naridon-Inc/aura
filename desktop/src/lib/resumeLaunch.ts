// One guarded way to start an agent from a past run.
//
// AURA-1366. Two surfaces launch a resumed agent — the session detail's Resume
// button and the launcher's "Pick up where you left off" rows — and each held
// its own guard. The detail's was a `busy` flag in its own component state; the
// launcher had none at all. Neither could see the other, so the same
// conversation opened from both meant two live agents on one thread, and a
// double-press on a slow spawn meant two from one surface. Nothing told the
// user: the second tab looks exactly like the first.
//
// The claim in agentSessionScope already solves this for auto-resume, and it is
// held across the spawn await for exactly this reason. This wraps it around the
// manual paths too, and adds the other half: when the spawn throws, the caller
// gets a sentence saying nothing was opened. An action that failed must never
// be reported in words that sound like it worked, and until this existed the
// detail pane printed the raw error next to a button that still said "Resuming…".

import { api, type PermissionMode } from "./api";
import { releaseResume, tryClaimResume } from "./agentSessionScope";

export type ResumeStart =
  | { ok: true; handleId: string }
  | {
      ok: false;
      /** `already_starting` — someone (maybe this user, twice) is opening this
       *  same thing right now. `failed` — the spawn itself threw. */
      reason: "already_starting" | "failed";
      /** What to show a person. Says plainly that nothing was opened. */
      message: string;
      /** The underlying error, for the hover title. Empty for a duplicate. */
      detail: string;
    };

export type ResumeLaunch = {
  /** The workspace the claim is scoped to — the page's own root, so two tabs
   *  looking at the same workspace see each other's in-flight launch. */
  repoRoot: string;
  /** Where the agent is actually spawned. May be a sibling worktree. */
  cwd: string;
  /** The conversation to reopen, or null to start a new one. */
  sessionId: string | null;
  /** Which agent. Defaults to Claude, the only one Aura reopens. */
  agentId?: string;
  cols?: number;
  rows?: number;
  permissionMode?: PermissionMode;
};

export function claimKeyFor(input: Pick<ResumeLaunch, "sessionId" | "cwd">): string {
  // A fresh start has no conversation id to claim, and two of those in the same
  // folder are just as much a duplicate as two of the same conversation.
  return input.sessionId ?? `new:${input.cwd.replace(/\/+$/, "")}`;
}

export async function startResume(input: ResumeLaunch): Promise<ResumeStart> {
  const key = claimKeyFor(input);
  if (!tryClaimResume(input.repoRoot, key)) {
    return {
      ok: false,
      reason: "already_starting",
      message: "Aura is already opening this. Give it a moment — it arrives as a new tab.",
      detail: "",
    };
  }
  try {
    const handle = await api.agentPtyOpen(
      input.agentId ?? "claude",
      input.cwd,
      input.cols ?? 80,
      input.rows ?? 24,
      input.sessionId ?? undefined,
      true,
      undefined,
      input.permissionMode === "default" ? undefined : input.permissionMode,
    );
    return { ok: true, handleId: handle.id };
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      reason: "failed",
      message: "Aura couldn't start the agent. Nothing was opened.",
      detail,
    };
  } finally {
    // Released once the spawn settles, so a deliberate second run later still
    // works. The window this closes is the burst, not the day.
    releaseResume(input.repoRoot, key);
  }
}
