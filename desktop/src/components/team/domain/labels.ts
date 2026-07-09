/** Team (chat) bounded context — conversation label + time formatting.
 *
 *  Pure presenters that turn a `Conversation` into the strings the rail,
 *  header, and composer show, plus the clock formatter. No React — these
 *  return plain strings the presentation layer drops into markup. Lifted
 *  verbatim from CommsPanel. */

import type { Conversation } from "./types";

export function prettyName(c: Conversation): string {
  if (c.kind === "channel" || c.kind === "system" || c.kind === "custom")
    return `# ${c.name}`;
  if (c.kind === "dm") return `@${c.name}`;
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
      return `Message @${c.name}`;
    case "project":
      return `Note for ${c.name}…`;
  }
}

export function hhmm(secs: number): string {
  const d = new Date(secs * 1000);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

// Trim a message body down to the human-readable gist for the conversation
// list preview: strip our `<aura:…>` sentinel tags, collapse fenced code
// blocks to a short marker, unwrap inline code, and squeeze whitespace.
export function previewBody(body: string | undefined): string {
  if (!body) return "";
  let s = body;
  s = s.replace(/<aura:[^>]*>[\s\S]*?<\/aura:[^>]*>/g, "📎 attachment");
  s = s.replace(/```[\s\S]*?```/g, "‹code›");
  s = s.replace(/`([^`]+)`/g, "$1");
  s = s.replace(/📎\s*/g, "📎 ");
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

// Relative timestamp for the conversation list: "now" / "5m" / "3h" /
// "Mon" / "May 12". Matches the Slack/iMessage feel without pulling in a
// date library.
export function railTime(secs: number): string {
  const now = Math.floor(Date.now() / 1000);
  const delta = Math.max(0, now - secs);
  if (delta < 60) return "now";
  if (delta < 3600) return `${Math.floor(delta / 60)}m`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h`;
  const d = new Date(secs * 1000);
  if (delta < 86400 * 7) {
    return d.toLocaleDateString(undefined, { weekday: "short" });
  }
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// Pinned/files/bookmarks timestamp: clock time for today, else "Mon D".
// Same `secs`-since-epoch contract as the other formatters here.
export function formatPinTime(ts: number): string {
  const d = new Date(ts * 1000);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}
