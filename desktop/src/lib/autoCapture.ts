// Auto-on recording.
//
// A fresh git repo opens with Aura's capture hooks not yet installed, so by
// default Aura records nothing until the user happens to find the "Capture
// off" pill. That quietly breaks the core promise — see and undo every change
// — for exactly the people (vibecoders) who need it most. So the first time a
// real project opens we turn recording on for them, then say so plainly via
// the `aura:recording-on` notice. No wizard, no MCP server, no decision to
// make up front.
//
// It respects intent: if the user has explicitly turned recording off for a
// repo (Settings → Capture writes the opt-out marker below), the auto path
// never re-enables it on a later reopen.

import { api } from "./api";

const optOutKey = (root: string) => `aura.capture.optout.${root}`;

/** Mark or clear the per-repo opt-out the auto-enable path honors. The
 *  Settings capture toggle calls this so a manual "off" stays off across
 *  reopens, and flipping it back on clears the marker. */
export function setCaptureOptOut(root: string, optedOut: boolean): void {
  try {
    if (optedOut) localStorage.setItem(optOutKey(root), "1");
    else localStorage.removeItem(optOutKey(root));
  } catch {
    /* private mode — best effort */
  }
}

/** Turn recording on the first time a real project opens — unless it's already
 *  on, isn't a git repo, or the user turned it off here before. Best-effort and
 *  silent on failure; the "Capture off" pill remains the fallback on-ramp. On
 *  success it dispatches `aura:recording-on` so the heads-up notice can show. */
export async function autoEnableCapture(
  root: string,
  projectName: string,
  isManagedWorktree: boolean,
): Promise<void> {
  try {
    // Agent worktrees share their parent's hooks — don't act on them.
    if (isManagedWorktree) return;
    try {
      if (localStorage.getItem(optOutKey(root)) === "1") return;
    } catch {
      /* ignore storage read errors */
    }
    const cap = await api.captureStatus(root);
    if (!cap.is_git || cap.enabled) return; // nothing to do
    const res = await api.captureEnable(root);
    if (res.status !== 0) return; // CLI refused — stay quiet, pill still nudges
    window.dispatchEvent(
      new CustomEvent("aura:recording-on", { detail: { project: projectName } }),
    );
  } catch {
    /* capture probe/enable is best-effort */
  }
}
