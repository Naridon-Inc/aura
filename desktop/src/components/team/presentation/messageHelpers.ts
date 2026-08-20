/** Team (chat) presentation — message text/time helpers + the unique-authors hook.
 *
 *  Moved verbatim out of the CommsPanel monolith; logic unchanged.
 *  Imports are filled in after extraction. */

import { useMemo } from "react";
import { hhmm, norm, type Msg } from "../domain";
import { relativeAgeFromDelta } from "../../../lib/relativeTime";
import { longDate, shortDate } from "../../../lib/calendarDate";

// ── system-message heuristics + tiny utilities ───────────────────────

const SYSTEM_VERBS = /^(joined|left|set the channel topic|set the channel description|added|removed|renamed|archived|unarchived|invited)\b/i;

export function isSystemNotice(m: Msg): boolean {
  // Plain JSONL rows never opt-in via `kind === "system"`. We treat an
  // agent-tagged row whose body opens with a known "system verb" as a
  // membership / topic / description event for now. Cheap + tolerant —
  // a false positive just renders the message as a one-line gray note
  // instead of a bubble, no harm done.
  if (!m.is_agent) return false;
  return SYSTEM_VERBS.test(m.body.trim());
}

// Returns the lone URL if the body is mostly a single link on its own
// line (or a short body with a trailing URL). Returns null otherwise so
// no card is rendered for body-with-multiple-links cases.
export function pickSoloLink(body: string): string | null {
  if (!body) return null;
  const urls = body.match(/https?:\/\/[^\s<>"']+/g);
  if (!urls || urls.length !== 1) return null;
  const url = urls[0];
  const rest = body.replace(url, "").trim();
  // Render the card iff the URL stands alone OR the surrounding text
  // is short (< 80 chars) so we don't clutter long-form messages.
  if (rest.length > 80) return null;
  return url;
}

// Dedup-by-handle helper for reply-author avatars in the chip.
export function useUniqueAuthors(replies: Msg[]): string[] {
  return useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const r of replies) {
      if (seen.has(r.sender)) continue;
      seen.add(r.sender);
      out.push(r.sender);
    }
    return out;
  }, [replies]);
}

/** The shape of a roster entry these two helpers need — structural, so any
 *  member type with a handle and a name satisfies it. */
export type NamedMember = { handle: string; name?: string | null };

/** The roster row a message's sender belongs to, matched on a normalized
 *  handle so casing and decoration can't miss it. */
export function findMember<T extends NamedMember>(
  members: readonly T[],
  sender: string,
): T | undefined {
  return members.find((m) => norm(m.handle) === norm(sender));
}

/**
 * What to call a message's sender on screen.
 *
 * The roster's name first; then, for our own messages, the name this device
 * goes by; the raw handle only as a last resort. That fallback is a git login
 * — the message stream was signing every message I'd sent in my own DM
 * `ashiqwayanad007`. This lived inside the message bubble, so every other list
 * that renders a sender (Recap, Threads, Sent) still printed the login.
 */
export function senderLabel(
  sender: string,
  member: NamedMember | undefined,
  opts?: { fromMe?: boolean; myDisplay?: string | null },
): string {
  return (
    member?.name?.trim() ||
    (opts?.fromMe ? opts.myDisplay?.trim() || "" : "") ||
    sender
  );
}

// "31m ago" / "Today at 14:43" / "May 12 at 14:43" — keeps the chip
// compact while staying useful for older threads.
export function relativeTime(secs: number): string {
  const now = Math.floor(Date.now() / 1000);
  const delta = Math.max(0, now - secs);
  // Under an hour it's a distance; past that the chip switches to the clock,
  // which is what you actually scan a thread by.
  // One ladder for the whole app — see lib/relativeTime.
  if (delta < 3600) return relativeAgeFromDelta(delta);
  const d = new Date(secs * 1000);
  if (delta < 86400 && sameLocalDay(now, secs)) {
    return `Today at ${hhmm(secs)}`;
  }
  if (delta < 86400 * 2) return `Yesterday at ${hhmm(secs)}`;
  if (delta < 86400 * 7) {
    return `${d.toLocaleDateString(undefined, { weekday: "short" })} ${hhmm(secs)}`;
  }
  return `${shortDate(d.getTime())} ${hhmm(secs)}`;
}

export function sameLocalDay(a: number, b: number): boolean {
  const da = new Date(a * 1000);
  const db = new Date(b * 1000);
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}

// "Today" / "Yesterday" / "Monday May 12" / "May 12 2024" for older.
export function humanDateLabel(secs: number): string {
  const now = Math.floor(Date.now() / 1000);
  const d = new Date(secs * 1000);
  if (sameLocalDay(now, secs)) return "Today";
  if (sameLocalDay(now - 86400, secs)) return "Yesterday";
  // Long month throughout, and the year only when it isn't this year —
  // both now the app's rule rather than this file's. The within-the-week
  // branch adds the weekday, which is what you scan a divider for.
  const ms = d.getTime();
  if (now - secs < 86400 * 7) return longDate(ms, { weekday: "long" });
  return longDate(ms);
}
