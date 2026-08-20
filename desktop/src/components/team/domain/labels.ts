/** Team (chat) bounded context — conversation label + time formatting.
 *
 *  Pure presenters that turn a `Conversation` into the strings the rail,
 *  header, and composer show, plus the clock formatter. No React — these
 *  return plain strings the presentation layer drops into markup. Lifted
 *  verbatim from CommsPanel. */

import type { Conversation } from "./types";
import { relativeAgeFromDelta } from "../../../lib/relativeTime";
import { plainLine } from "../../../lib/plainPreview";
import { shortDate } from "../../../lib/calendarDate";
import { clockTime, clockTimeFromSecs } from "../../../lib/clockTime";

export function prettyName(c: Conversation): string {
  if (c.kind === "channel" || c.kind === "system" || c.kind === "custom")
    return `# ${c.name}`;
  // No `@` on a DM any more: `name` is the person's name, and "@Ashiq" reads
  // as a login that doesn't exist. The handle still appears wherever it is the
  // useful thing — the rail hint, the DM header's own `@…` line, search.
  if (c.kind === "dm") return c.name;
  return c.name;
}

export function railLabel(c: Conversation): string {
  if (c.kind === "project") return c.name;
  if (c.kind === "dm") return c.name;
  return c.name;
}

export function composerHint(c: Conversation): string {
  switch (c.kind) {
    case "channel":
    case "custom":
      return `Message #${c.name}`;
    case "system":
      return `Note in #${c.name}…`;
    case "dm":
      // "Message Ashiq", not "Message @Ashiq" — same reason as prettyName: the
      // label is a name now, and `@` in front of one reads as a broken handle.
      return `Message ${c.name}`;
    case "project":
      return `Note for ${c.name}…`;
  }
}

// The team's name for the app's clock — see lib/clockTime. This used to
// pad the hours by hand and print "14:05", while formatPinTime two
// functions below called toLocaleTimeString and printed "2:05 PM". Same
// channel, same fact, two clocks.
export const hhmm = (secs: number): string => clockTimeFromSecs(secs);

// A message body trimmed to the human-readable gist for a one-line preview.
//
// This knew about our sentinel tags and about fenced code, and nothing else —
// so a reply written as a bulleted list previewed as "- ship it - then tag it",
// a heading kept its hashes, and a link showed its URL where the sentence
// should have been. The app's flattener knows all of that; the sentinel
// knowledge moved there, and this is now the team's name for it.
export const previewBody = (body: string | undefined): string =>
  plainLine(body ?? "");

/** Did a person type this, or did a machine post it?
 *
 *  Chat channels carry two kinds of traffic: what people write, and the
 *  envelopes the sync layers post to each other — notes/pages sync, roster
 *  upserts, and anything added later. Those arrive as a bare JSON object and
 *  are meant to be consumed, not read; a list that shows them prints
 *  `{"v":1,"op":"upsert","scope":"team",…}` under someone's name as if they
 *  had typed it.
 *
 *  Rather than enumerate producers — the list would go stale the first time
 *  someone adds one — this asks the only question that matters: is the whole
 *  body a JSON object? Prose that merely mentions JSON, or a fenced code
 *  block, still starts with a word or a backtick, so it reads as human. */
export function isHumanBody(body: string | undefined): boolean {
  const s = (body ?? "").trim();
  if (!s) return false;
  if (!s.startsWith("{") || !s.endsWith("}")) return true;
  try {
    const parsed: unknown = JSON.parse(s);
    return !parsed || typeof parsed !== "object" || Array.isArray(parsed);
  } catch {
    // Not valid JSON — a person writing braces, not a machine envelope.
    return true;
  }
}

// Relative timestamp for the conversation list: "now" / "5m" / "3h" /
// "Mon" / "May 12". Matches the Slack/iMessage feel without pulling in a
// date library.
export function railTime(secs: number): string {
  const now = Math.floor(Date.now() / 1000);
  const delta = Math.max(0, now - secs);
  // One ladder for the whole app — see lib/relativeTime.
  if (delta < 86400) return relativeAgeFromDelta(delta, { style: "compact" });
  const d = new Date(secs * 1000);
  if (delta < 86400 * 7) {
    return d.toLocaleDateString(undefined, { weekday: "short" });
  }
  return shortDate(d.getTime());
}

// Pinned/files/bookmarks timestamp: clock time for today, else "Mon D".
// Same `secs`-since-epoch contract as the other formatters here.
export function formatPinTime(ts: number): string {
  const d = new Date(ts * 1000);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return clockTime(d.getTime());
  }
  return shortDate(d.getTime());
}
