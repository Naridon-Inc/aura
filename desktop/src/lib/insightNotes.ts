// insightNotes — the reasons written down for a file's change, with their time
// in one unit.
//
// Every note the file-insight strip shows comes from the intent log (directly,
// or ranked through `aura ask`), and both carry epoch SECONDS. The age ladder
// they were drawn with takes MILLISECONDS, so a note written a minute ago read
// as "56y ago": 1.79e9 ms is three weeks into 1970. The unit is fixed here, where
// the rows enter, so the view only ever holds milliseconds and nothing
// downstream has to know or guess which unit a row was written in. A row with
// no usable time keeps `whenMs: null` and is drawn without an age.

import type { AskHit, IntentEntry } from "./api";
import { relativeAge } from "./relativeTime";

export type InsightNote = {
  id: string;
  /** Who wrote it, as a reader-facing name. */
  who: string;
  text: string;
  /** Epoch milliseconds, or null when the row has no usable time. */
  whenMs: number | null;
  /** Written by an edit hook rather than stated by a person or agent. */
  auto: boolean;
};

/** Epoch seconds → epoch milliseconds; null for a missing or unset stamp. */
export function secondsToMs(secs: number | null | undefined): number | null {
  return typeof secs === "number" && Number.isFinite(secs) && secs > 0 ? secs * 1000 : null;
}

function isAuto(agent: string): boolean {
  return /^hook(_auto)?$/i.test(agent.trim());
}

/** The name a note is signed with: the agent as written, a person's or tool's
 *  name kept, a bare lowercase id capitalised, the edit hook said plainly. */
export function signerName(agent: string): string {
  const a = agent.trim();
  if (!a) return "Unknown";
  if (isAuto(a)) return "Recorded on edit";
  return /^[a-z][\w-]*$/.test(a) ? a[0].toUpperCase() + a.slice(1) : a;
}

/** An intent-log row (its `timestamp` is epoch seconds). */
export function noteFromIntent(e: IntentEntry): InsightNote {
  return {
    id: e.id,
    who: signerName(e.agent),
    text: e.intent,
    whenMs: secondsToMs(e.timestamp),
    auto: isAuto(e.agent),
  };
}

/** A ranked `aura ask` hit (its `when` is epoch seconds). `id` is derived from
 *  the record rather than invented, so the same hit keeps the same key across
 *  refreshes and React does not remount the row. */
export function noteFromAskHit(hit: AskHit, relPath: string, index: number): InsightNote {
  return {
    id: `ask:${relPath}:${hit.when}:${index}`,
    who: signerName(hit.who),
    text: hit.what,
    whenMs: secondsToMs(hit.when),
    auto: isAuto(hit.who),
  };
}

/** Stated reasons first, edit-hook rows after; order otherwise kept (newest
 *  first, as the log returns them). */
export function rankNotes(notes: InsightNote[]): InsightNote[] {
  return [...notes.filter((n) => !n.auto), ...notes.filter((n) => n.auto)];
}

/** "2h ago", or "" when the note has no time — the caller omits the age. */
export function noteAge(n: InsightNote, now?: number): string {
  return n.whenMs === null ? "" : relativeAge(n.whenMs, now === undefined ? {} : { now });
}
