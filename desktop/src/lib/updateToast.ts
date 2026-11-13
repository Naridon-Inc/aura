// The decisions behind the update toast, kept free of React and Tauri so they
// can be tested on their own. `components/UpdateToast.tsx` does the talking to
// the updater; this file answers "should it show?", "is it snoozed?" and
// "what does it say?".
//
// "Later" snoozes one version, not updates in general: the same release stays
// quiet for a day, but a newer one (or the person asking "Check for Updates")
// shows straight away.
//
// "Restart when idle" is offered while something is working. Restarting ends
// every agent turn in flight and every job the app's own terminals are
// running, so instead of making someone watch for the moment it is safe, the
// toast waits for that moment and restarts then.

import { TURN_QUIET_MS } from "./agentTurnState";

/** The toast's id in the stack — one update surface, one copy. */
export const UPDATE_TOAST_ID = "update-ready";
/** The answer to a "Check for Updates" click, replaced in place as it goes
 *  from checking to the result. */
export const UPDATE_CHECK_TOAST_ID = "update-check";
/** Window event that asks for a forced check (anything other than the native
 *  menu, which sends its own Tauri event). */
export const UPDATE_CHECK_EVENT = "aura:check-for-updates";
/** Development builds only: shows the toast without a real release. */
export const UPDATE_PREVIEW_EVENT = "aura:dev-update-preview";

export const SNOOZE_KEY = "aura.updater.snoozed";
/** How long "Later" keeps one version quiet. */
export const SNOOZE_MS = 24 * 60 * 60 * 1000;

export type SnoozeStore = Pick<Storage, "getItem" | "setItem">;
type SnoozeRecord = { version: string; until: number };

function normalize(version: string): string {
  return version.trim().replace(/^v/i, "");
}

function readSnooze(storage: SnoozeStore | null): SnoozeRecord | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(SNOOZE_KEY);
    if (!raw) return null;
    const r = JSON.parse(raw) as Partial<SnoozeRecord>;
    if (typeof r.version === "string" && typeof r.until === "number") {
      return { version: r.version, until: r.until };
    }
  } catch {
    /* malformed or blocked storage reads as "not snoozed" */
  }
  return null;
}

/** "Later" on `version`: quiet until `now + ms`. Only one version is ever
 *  snoozed — snoozing a newer one replaces the older record. */
export function snoozeVersion(
  version: string,
  now: number,
  storage: SnoozeStore | null,
  ms: number = SNOOZE_MS,
): void {
  if (!storage) return;
  try {
    storage.setItem(
      SNOOZE_KEY,
      JSON.stringify({ version: normalize(version), until: now + ms } satisfies SnoozeRecord),
    );
  } catch {
    /* storage unavailable — the toast simply comes back next launch */
  }
}

/** True while `version` itself is snoozed. A different version never is. */
export function isSnoozed(version: string, now: number, storage: SnoozeStore | null): boolean {
  const rec = readSnooze(storage);
  return rec != null && rec.version === normalize(version) && now < rec.until;
}

/** Whether a check's result should raise the toast. Nothing to install →
 *  never. Otherwise yes, unless that version was put off with "Later" — and a
 *  check the person asked for overrides even that. */
export function shouldShowUpdateToast(args: {
  version: string | null | undefined;
  snoozed: boolean;
  manual: boolean;
}): boolean {
  if (!args.version) return false;
  return args.manual || !args.snoozed;
}

/** The one line under "Ready — restart to update": the release's own first line of
 *  notes (markdown marks stripped), or the version when it has none. */
export function releaseHeadline(version: string, notes: string | null | undefined): string {
  for (const raw of (notes ?? "").split(/\r?\n/)) {
    const line = raw
      .replace(/^\s*(#{1,6}\s+|[-*+]\s+|>\s*)/, "")
      .replace(/\*\*|__|`/g, "")
      .trim();
    if (line) return line;
  }
  return `Aura ${normalize(version)}`;
}

/** Where "See changes" goes: that release's page in the changelog. */
export function releaseNotesUrl(version: string): string {
  return `https://auravcs.com/changelog/${encodeURIComponent(normalize(version))}`;
}

/** Ask the update toast for a forced check — the More menu's "Check for
 *  Updates" uses this; the native menu sends `menu:check_for_updates`. */
export function requestUpdateCheck(): void {
  window.dispatchEvent(new CustomEvent(UPDATE_CHECK_EVENT));
}

// ---------------------------------------------------------------------------
// Restart when idle
// ---------------------------------------------------------------------------

/** A terminal that printed within this long is still running something. The
 *  window the turn tracker already uses to call an agent quiet: a session
 *  doing real work prints every couple of seconds, and an idle one prints
 *  nothing at all (`agentTurnState`). */
export const PTY_QUIET_MS = TURN_QUIET_MS;

/** How long everything has to stay idle before a pending restart fires.
 *
 *  An agent is idle for an instant between two steps of the same job: one
 *  turn ending and the queued next one starting, or a stream between tool
 *  calls. Restarting in that gap would end the job it was waiting for. Five
 *  seconds outlasts the gap and is still nothing to someone who chose to wait. */
export const IDLE_SETTLE_MS = 5000;

/** How many terminals are still running something, from each one's
 *  milliseconds since it last printed. `null` is a session this window has
 *  not been attached to long enough to know about: no sign of work, so it does
 *  not hold the restart. */
export function busyTerminals(
  idleMs: ReadonlyArray<number | null | undefined>,
  quietMs: number = PTY_QUIET_MS,
): number {
  let n = 0;
  for (const ms of idleMs) if (ms != null && ms < quietMs) n += 1;
  return n;
}

/** What the toast offers.
 *  * `offer` — nothing is working: See changes, Restart.
 *  * `offer-idle` — something is: See changes, Restart when idle, Restart.
 *  * `waiting` — the restart is set to happen once all is idle: Cancel,
 *    Restart now. */
export type UpdateOffer = "offer" | "offer-idle" | "waiting";

export function updateOffer(args: { busy: boolean; waiting: boolean }): UpdateOffer {
  if (args.waiting) return "waiting";
  return args.busy ? "offer-idle" : "offer";
}

/** A pending "Restart when idle": when everything last went idle, or null
 *  while something is still working. */
export type IdleWait = { idleSince: number | null };

export const IDLE_WAIT_START: IdleWait = { idleSince: null };

/** One look at the fleet while a restart waits. Any work resets the clock;
 *  idle starts it; idle that has held for `settleMs` fires the restart. */
export function stepIdleWait(
  wait: IdleWait,
  busy: boolean,
  now: number,
  settleMs: number = IDLE_SETTLE_MS,
): { wait: IdleWait; fire: boolean } {
  if (busy) return { wait: IDLE_WAIT_START, fire: false };
  const idleSince = wait.idleSince ?? now;
  return { wait: { idleSince }, fire: now - idleSince >= settleMs };
}
